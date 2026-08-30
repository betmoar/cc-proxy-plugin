// @ts-check
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
	RATE_LIMIT_RETRY_AFTER_SECONDS,
	isContextLimitByStopReason,
	isRateLimitError,
} from "./fallback.js";
import { collectModels, dedupByIdentity } from "./models.js";
import { defaultProvider, providerById } from "./providers.js";
import {
	abortUpstreamOnClientClose,
	forward,
	onUpstreamError,
	parseMaybeJson,
	upstreamRequestOptions,
	withoutRequestId,
} from "./proxy.js";
import { resolve, routingIdOf } from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

function debug(...args) {
	if (process.env.PROXY_DEBUG) console.log(...args);
}

// SERIALIZE FIRST, then write the head. Doing it in the other order commits the
// status line and headers before JSON.stringify has had a chance to throw (a
// BigInt or a circular reference in a payload assembled from vendor data will do
// it), which leaves the caller unable to send an error response — headersSent is
// already true — so the client sees a socket hang up instead of a status. With
// the body in hand first, a serialization failure is still a throw, but it is a
// throw the caller's error path can turn into a real 500.
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}

function writeBufferedResponse(clientRes, status, headers, bodyBuffer) {
	// withoutRequestId: writeHead REPLACES the x-request-id setHeader() put on
	// the response, so a backend emitting its own would silently take over the
	// correlation id (see proxy.js). Applied at every site that forwards
	// upstream headers, not just this one.
	clientRes.writeHead(status, withoutRequestId(headers));
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
// one request must never take the shared process down.
//
// THE WHOLE BODY IS INSIDE A try, and that is load-bearing rather than tidy.
// This is an `async` function dispatched WITHOUT `await` and without a `.catch`
// (see the call site), so a throw anywhere in it becomes an unhandled rejection
// — and Node's default disposition for that is to TERMINATE THE PROCESS, taking
// every session on the machine with it. Measured: a throw in this shape exits 1
// with no response written, and this repo installs no `uncaughtException` or
// `unhandledRejection` handler.
//
// The inner try around collectModels() stays, because it means something
// different: a failed COLLECTION degrades to a 200 with `_errors`, which is the
// endpoint's best-effort contract. The outer one is pure containment.
//
// (An earlier version of this comment credited a `.catch` at the call site that
// has never existed. It described the protection correctly and pointed at the
// wrong mechanism, which is the worse of the two failure modes — a reader
// checking the claim finds a plausible sentence and no code.)
//
// `dedup` is the ONE query parameter this endpoint reads, and it is opt-in: with
// no parameter the response is byte-identical to what it has always been.
// collectModels() keeps its `(config)` signature — the view is applied to its
// output rather than threaded into the builder, so the collector stays unaware
// of HTTP.
async function handleModels(res, config, dedup) {
	try {
		// An unrecognized value is a 400, not a silent full list. A consumer that
		// typos `?dedup=identiy` and receives all 415 entries gets a WRONG answer
		// that looks like a right one — the duplicate models it asked to collapse
		// are still there, and nothing says so. Case-sensitive, like the value of
		// any other query parameter: `?dedup=Identity` is a typo and gets the 400.
		//
		// ONE decision, reused below, rather than two `=== "identity"` comparisons.
		// With two, relaxing only the gate (say to a case-insensitive match) lets a
		// value through that the second comparison still rejects — and the request
		// then 200s with the FULL list, which is precisely the silent-wrong-answer
		// this endpoint refuses to give.
		const wantsDedup = dedup === "identity";
		if (dedup !== undefined && !wantsDedup) {
			sendJson(res, 400, {
				error: {
					message: `unsupported dedup=${dedup} (the only supported value is "identity")`,
				},
			});
			return;
		}
		let result;
		try {
			result = await collectModels(config);
		} catch (err) {
			// Log the real bug rather than returning a generic 200 with an empty list
			// and no trace — collectModels only throws via the test seam, so a hit
			// here is a genuine regression worth surfacing in the proxy log.
			console.error(`[models] collectModels threw: ${err?.message || err}`);
			result = { data: [], _errors: [{ provider: "proxy", message: "internal error" }] };
		}
		const { _errors } = result;
		const data = wantsDedup ? dedupByIdentity(result.data) : result.data;
		const payload = {
			data,
			has_more: false,
			first_id: data.length ? data[0].id : null,
			last_id: data.length ? data[data.length - 1].id : null,
		};
		if (_errors.length) payload._errors = _errors;
		// One summary line (not the routing-log format — status.js's
		// parseRoutingLines keys on `[<iso>] <model> -> <provider> <path>`, which
		// this does not match).
		const view = wantsDedup ? ` (deduped from ${result.data.length})` : "";
		console.log(`[models] ${data.length} models${view}, ${_errors.length} errors`);
		sendJson(res, 200, payload);
	} catch (err) {
		// Containment, per the header. Anything reaching here is a bug in THIS
		// function (dedupByIdentity on a malformed entry, a serialization failure),
		// so log it loudly — the proxy log is the only debugging surface — and
		// answer the one request rather than dropping the process.
		console.error(`[models] handler threw: ${err?.stack || err}`);
		if (!res.headersSent) sendJson(res, 500, { error: { message: "internal error" } });
		else res.destroy();
	}
}

/**
 * The DashScope-native media path, tunnelled to the Qwen plan host (issue #40).
 *
 * A TUNNEL, NOT A TRANSLATION. Invariant 5 bars an OpenAI↔Anthropic layer and
 * this adds none: the body is forwarded byte-for-byte, the response is whatever
 * the vendor sent, and the proxy knows nothing about either schema. All it
 * contributes is the credential — which is the point, since the plan key already
 * lives here and a caller with its own image client otherwise has to hold it too.
 *
 * PATH-ROUTED, uniquely. Every other request routes on `body.model`, and that is
 * exactly why this needs its own branch: `wan2.7-image` matches no provider
 * predicate (no slash, no `qwen` prefix, not dated, not a plan resell), so it
 * would fall through resolve() to the DEFAULT backend and be sent to Anthropic.
 * Nothing in the id says "plan"; only the path does.
 */
const MEDIA_GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

function handleMediaGeneration(req, res, bodyBuffer, config, reqId) {
	const qwen = providerById(config, "qwen");
	// No key, no tunnel — and say so. Falling through to handleProxy here would
	// route a plan-only path at the default backend on the user's OAuth
	// credentials, which is invariant 3 in the least visible way possible.
	if (!qwen?.mediaBaseUrl) {
		sendJson(res, 503, {
			error: { message: "media generation requires DASHSCOPE_API_KEY (qwen plan)" },
		});
		return;
	}
	// A derived provider, so upstreamRequestOptions() stays the single place that
	// builds an upstream request (a second copy shipped the query-string bug
	// twice). Only baseUrl differs: same host, same bearer auth, no
	// `/apps/anthropic` — see the mediaBaseUrl comment in providers.js.
	const tunnel = { ...qwen, baseUrl: qwen.mediaBaseUrl };
	console.log(`[${new Date().toISOString()}] {${reqId}} media -> ${tunnel.id} ${logSafe(req.url)}`);
	// DashScope streams this endpoint via a REQUEST header, not a body field, so
	// the usual `body.stream === true` check would miss it and send an SSE
	// response down the buffering path.
	if (String(req.headers["x-dashscope-sse"] || "").toLowerCase() === "enable") {
		forward(req, res, tunnel, bodyBuffer);
		return;
	}
	forwardBuffered(req, res, tunnel, bodyBuffer, "media", reqId);
}

// Cap on buffering a non-streaming response. The overflow signal is tiny (an
// empty 200), so a body past this is a real large completion: flush what's
// buffered and pipe the rest through uninspected rather than hold it all in
// memory.
const NON_STREAM_BUFFER_LIMIT = 1024 * 1024;

// Non-streaming path. Buffer the response so a GLM context-overflow (200 +
// empty content + stop_reason) can be converted into a real error instead of a
// silent empty turn. Larger-than-cap and everything else pass through unchanged.
function forwardBuffered(clientReq, clientRes, provider, outboundBuffer, inboundModel, reqId) {
	// `true` = force accept-encoding: identity upstream. The inspections below
	// JSON.parse the raw response bytes; a gzipped body would fail to parse and
	// both the overflow→400 conversion and the 1302 Retry-After injection would
	// silently stop working. Buffered path only — the streaming path stays a pipe.
	// Same containment as forward(): a bad baseUrl becomes a 502 for this one
	// request rather than a process-ending throw inside the dispatcher.
	let proto;
	let options;
	try {
		({ proto, options } = upstreamRequestOptions(clientReq, provider, outboundBuffer.length, true));
	} catch (err) {
		onUpstreamError(clientRes)(/** @type {Error} */ (err));
		return;
	}
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
				clientRes.writeHead(status, withoutRequestId(upstreamRes.headers));
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
			// A vendor-side rejection carries the vendor's own request id (OpenRouter
			// `gen-…`, Anthropic `req_…`). Landing it on a log line the user can find
			// — same line as the routing decision — is what makes a vendor error
			// traceable without reading raw bodies. Buffered path only: the streaming
			// path is a pipe by invariant 1 and never inspects bytes.
			const vendorId = status >= 400 ? vendorRequestIdOf(parseMaybeJson(bodyBuf)) : undefined;
			if (vendorId) console.log(`[vendor-request-id] {${reqId}} ${vendorId}`);
			if (status === 200 && isContextLimitByStopReason(parseMaybeJson(bodyBuf))) {
				console.log(`[ctx-overflow] ${logSafe(inboundModel)} 200 -> 400 (context window exceeded)`);
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
				console.log(
					`[rate-limit] ${logSafe(inboundModel)} 429 1302 -> Retry-After: ${logSafe(retryAfter)}`,
				);
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

function handleProxy(req, res, body, bodyBuffer, config, reqId) {
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
	console.log(
		`[${new Date().toISOString()}] {${reqId}} ${logSafe(inboundModel)} -> ${provider.id}${via} ${logSafe(req.url)}`,
	);
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
	forwardBuffered(req, res, provider, outboundBuffer, inboundModel, reqId);
}

/**
 * The `dedup` query value, or undefined when absent.
 *
 * URLSearchParams on the query slice only, NOT `new URL(req.url)`: a malformed
 * request target throws there, inside the shared long-running process, and the
 * rest of this dispatcher deliberately avoids it for the same reason.
 * @param {string} url
 * @returns {string | undefined}
 */
function dedupParam(url) {
	const q = url.indexOf("?");
	if (q < 0) return undefined;
	const v = new URLSearchParams(url.slice(q + 1)).get("dedup");
	return v === null ? undefined : v;
}

function parseJsonOrEmpty(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return {};
	}
}

/**
 * One short opaque correlation id per request, stamped on the routing-log line
 * and echoed to the client as `x-request-id`. The routing log answers "where
 * did this model go" but not "which of these interleaved lines was MY request"
 * — and the proxy is normally shared across several live sessions, so the
 * question comes up constantly. Also harvested from error responses: when an
 * upstream body carries a vendor `request_id`, it lands on the same log line,
 * so correlating a vendor-side rejection with our routing decision stops being
 * manual archaeology.
 *
 * NOT a tracing system: no spans, no persistence, no config. 8 hex chars (32
 * bits) is a deliberate readability/uniqueness trade, and the honest number is
 * NOT "negligible": a full 5 MB log window holds ~69k routing lines at ~76
 * bytes each, which by the birthday bound is ~42% odds that SOME pair of lines
 * in the window shares a tag. That is acceptable, but for a specific reason
 * worth stating — a collision merges two log tags, it never misroutes a
 * request — and because the id's job is to disambiguate the handful of
 * interleaved lines a reader is looking at right now, not to be globally
 * unique. Widen the id if that ever stops being true. (The earlier version of
 * this comment asserted "negligible" without computing it.)
 *
 * INBOUND IDS ARE SANITIZED, not just length-capped, and that is log-forging
 * defense, not tidiness. The id is interpolated into a log line that
 * scripts/status.js parseRoutingLines() filters on `starts with "[" and
 * contains " -> "`; an id carrying `] ` + a fake `[ts] x -> y` shape would
 * otherwise let any client able to set one header invent routing history in
 * /cc-proxy:status output (measured: `} fake-line [2026-01-01T00:00:00Z] evil
 * -> pwned` landed as a plausible extra route). Only `[A-Za-z0-9._-]` survive
 * — anything else (and the whole header, if a newline somehow made it past
 * Node's header parser) falls back to a minted id. Still truncated to 64.
 *
 * MINTED IDS ARE ALWAYS EXACTLY 8 CHARS, via randomBytes rather than
 * `Math.random().toString(16)`: that older form returns fewer than 8
 * characters when the float's hex expansion is short — provably the empty
 * string when Math.random() lands exactly on 0 (its output grid is multiples
 * of 2^-53; also any value under 1/2^32 shortens the leading zeros away). A
 * regex `[0-9a-f]{8}` in tests plus the log contract should not rest on a
 * probabilistic length.
 *
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function requestIdOf(req) {
	const inbound = req.headers["x-request-id"]?.toString().slice(0, 64);
	if (inbound && /^[A-Za-z0-9._-]+$/.test(inbound)) return inbound;
	return randomBytes(4).toString("hex");
}

/**
 * A value safe to interpolate into a log line.
 *
 * THE MODEL ID IS ATTACKER-CONTROLLED JSON, and it reaches the routing-log line
 * that scripts/status.js parseRoutingLines() filters on `starts with "[" and
 * contains " -> "`. A `model` carrying a newline plus a fake
 * `[<iso>] {id} X -> Y /path` therefore injects a second line that the status
 * report keeps as genuine routing history — measured end-to-end, the forged
 * entry came back from parseRoutingLines() indistinguishable from a real one.
 *
 * This is the SAME defect class the id sanitizers guard (requestIdOf,
 * vendorRequestIdOf), and it predates them: `model` was already interpolated
 * before the correlation id existed. Hardening two of the three interpolation
 * sites is what left it reachable, which is the lesson worth keeping — fix a
 * class, then sweep every site in it.
 *
 * Escaping rather than allowlisting, deliberately: a model id is a display
 * value the operator needs to READ (`qwen:deepseek-v4-pro[1m]`, slashes, dots,
 * brackets all meaningful), so replacing the id with a placeholder would cost
 * the log its usefulness. Only the line-structural characters are neutralized.
 *
 * @doctest logSafe("glm-5.2") -> "glm-5.2"
 * @doctest logSafe("qwen:deepseek-v4-pro[1m]") -> "qwen:deepseek-v4-pro[1m]"
 * @doctest logSafe("a\nb") -> "a\\nb"
 * @doctest logSafe("a\rb") -> "a\\rb"
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function logSafe(value, max = 200) {
	return String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, max);
}

/**
 * The vendor's own request id, when an error body carries one. Two documented
 * shapes are covered: OpenRouter nests it under `error.request_id` (`gen-…`),
 * and Anthropic puts it TOP-LEVEL alongside `error` (`{"type":"error","error":
 * {…},"request_id":"req_…"}`, per docs.anthropic.com/en/api/errors). Unknown
 * shapes yield undefined and the log line simply omits the tag.
 *
 * An earlier version of this comment cited Anthropic as `request.id` — a
 * nested shape their API does not produce — and the lookup carried a matching
 * `b?.request?.id` fallback that no vendor was known to emit and no test
 * exercised. Both are gone: a speculative branch guarding a shape nobody has
 * seen is a claim, and this file's rule is that claims get evidence or get
 * deleted.
 *
 * SAME CHARSET RULE AS requestIdOf, and for the same measured reason: this
 * string is interpolated into a log line that scripts/status.js filters on
 * `starts with "[" and contains " -> "`, so a vendor-controlled value with
 * `" -> "` or an embedded newline (a compromised vendor, a MITM, or any host
 * LMSTUDIO_BASE_URL points at) would forge routing history in
 * /cc-proxy:status output. `gen-…`/`req_…` shapes are all `[A-Za-z0-9._-]`;
 * anything outside that is not worth logging.
 *
 * @param {unknown} body
 * @returns {string | undefined}
 */
export function vendorRequestIdOf(body) {
	const b = /** @type {any} */ (body);
	const v = b?.error?.request_id ?? b?.request_id ?? b?.error?.requestId;
	return typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v) ? v : undefined;
}

export function createServer(config) {
	const server = http.createServer((req, res) => {
		const reqId = requestIdOf(req);
		// Echo before any branch: every response the proxy emits — routed,
		// intercepted, or error — is correlatable to its log line. setHeader
		// (not writeHead-merge) so each handler keeps owning its own head.
		res.setHeader("x-request-id", reqId);
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
			// GET /v1/models — synthesized, exact path only. (/v1/models/<id>
			// retrieve falls through to forwarding.) The query string is parsed for
			// `dedup` and ignored otherwise, so an unrelated `?t=…` still matches.
			if (pathname === "/v1/models") {
				if (req.method === "GET") handleModels(res, config, dedupParam(req.url));
				else sendJson(res, 405, { error: { message: "GET required" } });
				return;
			}
			// POST <MEDIA_GENERATION_PATH> — the plan's image tunnel. Ahead of
			// handleProxy because routing is body-driven everywhere else and this
			// path's ids match no predicate; see handleMediaGeneration.
			if (pathname === MEDIA_GENERATION_PATH) {
				if (req.method === "POST") handleMediaGeneration(req, res, bodyBuffer, config, reqId);
				else sendJson(res, 405, { error: { message: "POST required" } });
				return;
			}
			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config, reqId);
		});
	});
	return server;
}
