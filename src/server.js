// @ts-check
import http from "node:http";
import https from "node:https";
import { pickAgent, upstreamTimeoutMs } from "./agents.js";
import {
	RATE_LIMIT_RETRY_AFTER_SECONDS,
	isContextLimitByStopReason,
	isRateLimitError,
} from "./fallback.js";
import { buildUpstreamHeaders, defaultProvider } from "./providers.js";
import { forward } from "./proxy.js";
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
		defaultBackend: defaultProvider(config).id,
		providers: config.providers.map((p) => p.id),
	});
}

function parseMaybeJson(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return null;
	}
}

function upstreamRequestOptions(clientReq, provider, outboundBuffer) {
	const url = new URL(provider.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;
	return {
		proto,
		options: {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname,
			method: clientReq.method,
			headers: buildUpstreamHeaders(
				provider,
				clientReq.headers,
				outboundBuffer.length,
				url.hostname,
			),
			agent: pickAgent(proto),
			timeout: upstreamTimeoutMs(),
		},
	};
}

function onUpstreamError(clientRes) {
	return (err) => {
		if (!clientRes.headersSent) {
			sendJson(clientRes, 502, { error: { message: `Upstream error: ${err.message}` } });
		} else if (!clientRes.writableEnded) {
			// Headers already sent (e.g. a >1MB passthrough that then stalled) — can't
			// send a 502. Destroy the client so the aborted upstream doesn't leak an
			// open downstream connection.
			clientRes.destroy();
		}
	};
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
	const { proto, options } = upstreamRequestOptions(clientReq, provider, outboundBuffer);
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

	console.log(`[${new Date().toISOString()}] ${inboundModel} -> ${provider.id}`);
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
	return http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const bodyBuffer = Buffer.concat(chunks);
			if (req.url === "/_status" && req.method === "GET") {
				handleStatus(res, config);
				return;
			}
			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config);
		});
	});
}
