// @ts-check
import http from "node:http";
import {
	RATE_LIMIT_RETRY_AFTER_SECONDS,
	isContextLimitByStopReason,
	isRateLimitError,
} from "./fallback.js";
import { collectModels } from "./models.js";
import { defaultProvider } from "./providers.js";
import {
	abortUpstreamOnClientClose,
	forward,
	onUpstreamError,
	parseMaybeJson,
	upstreamRequestOptions,
} from "./proxy.js";
import { resolve, routingIdOf } from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

function debug(...args) {
	if (process.env.PROXY_DEBUG) console.log(...args);
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function writeBufferedResponse(clientRes, status, headers, bodyBuffer) {
	clientRes.writeHead(status, headers);
	clientRes.end(bodyBuffer);
}

function handleStatus(res, config) {
	sendJson(res, 200, {
		port: config.port,
		version: config.version,
		defaultBackend: defaultProvider(config).id,
		providers: config.providers.map((p) => p.id),
	});
}

// Minimal liveness probe: a bare 200 with an empty body, the fastest possible
// "is the proxy process up" check (no JSON serialization, no config read). For
// anything richer (version, providers) use /_status. Like /_status it carries no
// auth — safe because the proxy is loopback-bound by default (invariant 7).
// Deliberately no content-type: the body is empty, and advertising
// application/json would make a client's res.json() throw a parse error.
function handlePing(res) {
	res.writeHead(200);
	res.end();
}

// Graceful self-shutdown, used by the SessionStart hook to replace a stale
// (version-mismatched) proxy. Loopback-only by construction in the default
// config (invariant 7); like /_status it carries no auth because anyone who
// can reach the port can already spend the injected keys. In-flight responses
// finish (close() waits for active sockets); only idle keep-alive connections
// are severed. process.exit is NOT called — the process ends when the last
// socket drains and the event loop empties.
function handleShutdown(server, res) {
	console.log("[shutdown] /_shutdown received — closing listener, draining in-flight requests");
	sendJson(res, 200, { ok: true });
	server.close();
	server.closeIdleConnections();
}

// GET /v1/models — synthesized discovery list (not forwarded). Best-effort:
// collectModels never rejects except the test seam; the .catch keeps a throw from
// killing the shared proxy process (one request must not take the process down).
async function handleModels(res, config) {
	let result;
	try {
		result = await collectModels(config);
	} catch (err) {
		// Log the real bug rather than returning a generic 200 with an empty list
		// and no trace — collectModels only throws via the test seam, so a hit here
		// is a genuine regression worth surfacing in the proxy log.
		console.error(`[models] collectModels threw: ${err?.message || err}`);
		result = { data: [], _errors: [{ provider: "proxy", message: "internal error" }] };
	}
	const { data, _errors } = result;
	const payload = {
		data,
		has_more: false,
		first_id: data.length ? data[0].id : null,
		last_id: data.length ? data[data.length - 1].id : null,
	};
	if (_errors.length) payload._errors = _errors;
	// One summary line (not the routing-log format — status.js's parseRoutingLines
	// keys on `[<iso>] <model> -> <provider> <path>`, which this does not match).
	console.log(`[models] ${data.length} models, ${_errors.length} errors`);
	sendJson(res, 200, payload);
}

// Cap on buffering a non-streaming response. The overflow signal is tiny (an
// empty 200), so a body past this is a real large completion: flush what's
// buffered and pipe the rest through uninspected rather than hold it all in
// memory.
const NON_STREAM_BUFFER_LIMIT = 1024 * 1024;

// Non-streaming path. Buffer the response so a GLM context-overflow (200 +
// empty content + stop_reason) can be converted into a real error instead of a
// silent empty turn. Larger-than-cap and everything else pass through unchanged.
function forwardBuffered(clientReq, clientRes, provider, outboundBuffer, inboundModel) {
	// `true` = force accept-encoding: identity upstream. The inspections below
	// JSON.parse the raw response bytes; a gzipped body would fail to parse and
	// both the overflow→400 conversion and the 1302 Retry-After injection would
	// silently stop working. Buffered path only — the streaming path stays a pipe.
	const { proto, options } = upstreamRequestOptions(
		clientReq,
		provider,
		outboundBuffer.length,
		true,
	);
	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;
		const chunks = [];
		let total = 0;
		let passthrough = false;

		upstreamRes.on("data", (c) => {
			if (passthrough) return;
			chunks.push(c);
			total += c.length;
			if (total > NON_STREAM_BUFFER_LIMIT) {
				// Too large to buffer/inspect — commit to passthrough: flush the
				// buffered prefix, then pipe the remaining bytes through.
				passthrough = true;
				clientRes.writeHead(status, upstreamRes.headers);
				for (const ch of chunks) clientRes.write(ch);
				upstreamRes.pipe(clientRes);
			}
		});
		upstreamRes.on("error", () => {
			if (clientRes.headersSent) clientRes.destroy();
			else sendJson(clientRes, 502, { error: { message: "upstream read error" } });
		});
		upstreamRes.on("end", () => {
			if (passthrough) return;
			const bodyBuf = Buffer.concat(chunks);
			if (status === 200 && isContextLimitByStopReason(parseMaybeJson(bodyBuf))) {
				console.log(`[ctx-overflow] ${inboundModel} 200 -> 400 (context window exceeded)`);
				sendJson(clientRes, 400, {
					type: "error",
					error: {
						type: "invalid_request_error",
						message: `${inboundModel}: context window exceeded`,
					},
				});
				return;
			}
			// GLM 1302 rate limit (429): inject Retry-After so Claude Code's client
			// backs off instead of surfacing a hard error. Stateless — the proxy
			// does not wait or replay. Body and status pass through unchanged.
			if (status === 429 && isRateLimitError(parseMaybeJson(bodyBuf))) {
				// Only inject when the upstream omitted it (current GLM behavior).
				// Preserve any real Retry-After GLM might send in the future rather
				// than clobbering it with our fixed default. (Node lowercases keys.)
				const retryAfter =
					upstreamRes.headers["retry-after"] || String(RATE_LIMIT_RETRY_AFTER_SECONDS);
				console.log(`[rate-limit] ${inboundModel} 429 1302 -> Retry-After: ${retryAfter}`);
				const headers = { ...upstreamRes.headers, "retry-after": retryAfter };
				writeBufferedResponse(clientRes, status, headers, bodyBuf);
				return;
			}
			writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
		});
	});
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
	upstream.on("error", onUpstreamError(clientRes));
	abortUpstreamOnClientClose(clientRes, upstream);
	upstream.write(outboundBuffer);
	upstream.end();
}

function handleProxy(req, res, body, bodyBuffer, config) {
	const { provider, upstreamModel } = resolve(body.model, config);
	const inboundModel = body.model || "unknown";

	const stripped = stripAssistantThinking(body);
	if (stripped.modified) debug("  stripped thinking blocks from assistant history");

	// The `<provider>:` selector is cc-proxy's LOCAL lens — no backend has ever
	// heard of it, so it is stripped here and the bare vendor id goes upstream.
	// This is the second deliberate exception to the byte-for-byte body rule
	// (invariant 1), alongside the thinking-strip above; it changes `model` and
	// nothing else. Decided here, before the stream/non-stream branch, because
	// the streaming path never parses the body itself.
	//
	// Build an OUTBOUND object rather than assigning into `stripped.body`:
	// stripAssistantThinking() returns the caller's own object when it changed
	// nothing (sanitize.js), so `stripped.body === body` in the common case and
	// an in-place write would edit the inbound body under everything that reads
	// it afterwards. Nothing does today — `inboundModel` is captured above and
	// the body is parsed fresh per request — but the failure it invites is
	// quiet: move that capture below this line and the routing log starts
	// reporting the UPSTREAM id as the inbound one, which is the line
	// scripts/status.js parses.
	//
	// NOT DIRECTLY TESTED, and worth knowing why: handleProxy is not exported,
	// and every observable — the log line, the upstream body — looks identical
	// under the in-place write, precisely BECAUSE inboundModel is captured
	// first. An end-to-end test asserting those passes against the defect
	// (verified). What IS locked is the aliasing contract this depends on:
	// test/sanitize.test.js "returns the SAME object when nothing was stripped".
	// Break that and these lines silently start copying instead of aliasing.
	const rewritten = typeof upstreamModel === "string" && upstreamModel !== body.model;
	const outboundBody = rewritten ? { ...stripped.body, model: upstreamModel } : stripped.body;
	const outboundBuffer =
		stripped.modified || rewritten ? Buffer.from(JSON.stringify(outboundBody)) : bodyBuffer;

	// The routing DECISION is made on a normalized id (a `<provider>:` lens and a
	// `[1m]`-style variant suffix are both stripped for lookup purposes), while
	// the line above reports the id the CLIENT sent. When those differ, the log
	// alone cannot explain why an id landed where it did — the reader has to
	// re-derive the normalization by hand. Annotate, but only when it actually
	// differs, so the common case stays the exact byte-shape it has always been.
	// `scripts/status.js` parseRoutingLines() keeps whole lines that contain
	// " -> " and start with "[", so a trailing annotation is safe there.
	const routedAs = routingIdOf(inboundModel);
	const via = routedAs === inboundModel ? "" : ` (routed as ${routedAs})`;
	console.log(`[${new Date().toISOString()}] ${inboundModel} -> ${provider.id}${via} ${req.url}`);
	debug(
		"  metadata:",
		JSON.stringify(body.metadata),
		"system:",
		Array.isArray(body.system) ? `array[${body.system.length}]` : typeof body.system,
	);

	// stream is checked strictly (=== true); a non-boolean truthy stream is treated as non-streaming.
	if (body?.stream === true) {
		forward(req, res, provider, outboundBuffer);
		return;
	}
	forwardBuffered(req, res, provider, outboundBuffer, inboundModel);
}

function parseJsonOrEmpty(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return {};
	}
}

export function createServer(config) {
	const server = http.createServer((req, res) => {
		const chunks = [];
		// A client that resets the connection mid-upload emits 'error' on the
		// request stream; without a listener that is an uncaught exception that
		// kills the shared long-running proxy process for every session.
		req.on("error", () => res.destroy());

		// Split on "?" rather than new URL(): matches the existing string-equality
		// interception style and avoids URL() throwing on a malformed request target
		// inside the shared long-running process. The read-only probes match on this
		// pathname so a cache-busting `?t=…` can't make them get forwarded upstream.
		const pathname = req.url.split("?")[0];

		// The GET probes answer before any body is buffered — they take no input, and
		// /_ping is the designated hot-path check, so it must not be gated on reading
		// a body first. req.resume() discards whatever a client sent anyway, so a
		// keep-alive socket isn't left with an unread body stalling the next request.
		if (req.method === "GET" && (pathname === "/_ping" || pathname === "/_status")) {
			req.resume();
			if (pathname === "/_ping") handlePing(res);
			else handleStatus(res, config);
			return;
		}

		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const bodyBuffer = Buffer.concat(chunks);
			// Exact match, deliberately unlike the probes above: shutdown is
			// destructive, so it stays as narrow as possible.
			if (req.url === "/_shutdown") {
				// POST only: a stray GET (browser, curl without -X, link prefetch)
				// must never take the proxy down.
				if (req.method === "POST") handleShutdown(server, res);
				else sendJson(res, 405, { error: { message: "POST required" } });
				return;
			}
			// GET /v1/models — synthesized, query-string tolerant, exact path only.
			// (/v1/models/<id> retrieve falls through to forwarding.)
			if (pathname === "/v1/models") {
				if (req.method === "GET") handleModels(res, config);
				else sendJson(res, 405, { error: { message: "GET required" } });
				return;
			}
			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config);
		});
	});
	return server;
}
