// @ts-check
import http from "node:http";
import {
	RATE_LIMIT_RETRY_AFTER_SECONDS,
	isContextLimitByStopReason,
	isRateLimitError,
} from "./fallback.js";
import { defaultProvider } from "./providers.js";
import {
	abortUpstreamOnClientClose,
	forward,
	onUpstreamError,
	parseMaybeJson,
	upstreamRequestOptions,
} from "./proxy.js";
import { resolve } from "./router.js";
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

// Cap on buffering a non-streaming response. The overflow signal is tiny (an
// empty 200), so a body past this is a real large completion: flush what's
// buffered and pipe the rest through uninspected rather than hold it all in
// memory.
const NON_STREAM_BUFFER_LIMIT = 1024 * 1024;

// Non-streaming path. Buffer the response so a GLM context-overflow (200 +
// empty content + stop_reason) can be converted into a real error instead of a
// silent empty turn. Larger-than-cap and everything else pass through unchanged.
function forwardBuffered(clientReq, clientRes, provider, outboundBuffer, inboundModel) {
	const { proto, options } = upstreamRequestOptions(clientReq, provider, outboundBuffer.length);
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
	const provider = resolve(body.model, config);
	const inboundModel = body.model || "unknown";

	const stripped = stripAssistantThinking(body);
	if (stripped.modified) debug("  stripped thinking blocks from assistant history");
	const outboundBuffer = stripped.modified
		? Buffer.from(JSON.stringify(stripped.body))
		: bodyBuffer;

	console.log(`[${new Date().toISOString()}] ${inboundModel} -> ${provider.id} ${req.url}`);
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
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const bodyBuffer = Buffer.concat(chunks);
			if (req.url === "/_status" && req.method === "GET") {
				handleStatus(res, config);
				return;
			}
			if (req.url === "/_shutdown") {
				// POST only: a stray GET (browser, curl without -X, link prefetch)
				// must never take the proxy down.
				if (req.method === "POST") handleShutdown(server, res);
				else sendJson(res, 405, { error: { message: "POST required" } });
				return;
			}
			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config);
		});
	});
	return server;
}
