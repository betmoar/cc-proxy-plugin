// @ts-check
import http from "node:http";
import https from "node:https";
import { pickAgent, upstreamTimeoutMs } from "./agents.js";
import { RATE_LIMIT_RETRY_AFTER_SECONDS, isRateLimitError } from "./fallback.js";
import { buildUpstreamHeaders } from "./providers.js";

// A rate-limit error body is tiny JSON; cap buffering so a mislabeled large 429
// can't be held in memory. Past the cap we give up inspecting and pipe through.
const RATE_LIMIT_PEEK_LIMIT = 64 * 1024;

/** @param {Buffer} buffer @returns {unknown} */
function parseMaybeJson(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return null;
	}
}

/**
 * Forward a request to a provider. Auth is applied per the provider's strategy
 * (OAuth passthrough for Claude, x-api-key / Bearer for others). Response is
 * piped back as-is, so SSE streams work transparently.
 *
 * @param {http.IncomingMessage} clientReq
 * @param {http.ServerResponse} clientRes
 * @param {import("./providers.js").Provider} provider
 * @param {Buffer} bodyBuffer
 */
export function forward(clientReq, clientRes, provider, bodyBuffer) {
	const url = new URL(provider.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;

	const headers = buildUpstreamHeaders(
		provider,
		clientReq.headers,
		bodyBuffer.length,
		url.hostname,
	);

	const options = {
		hostname: url.hostname,
		port: url.port || (url.protocol === "https:" ? 443 : 80),
		path: url.pathname,
		method: clientReq.method,
		headers,
		agent: pickAgent(proto),
		timeout: upstreamTimeoutMs(),
	};

	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;

		// A 429 is a small JSON error even on a stream:true request (the rate
		// limit short-circuits before any SSE). Buffer it (bounded) so a GLM 1302
		// can get a Retry-After injected. Everything else stays a pure pipe so
		// real SSE streams are untouched.
		if (status === 429) {
			const chunks = [];
			let total = 0;
			let piping = false;
			upstreamRes.on("data", (c) => {
				if (piping) return;
				chunks.push(c);
				total += c.length;
				if (total > RATE_LIMIT_PEEK_LIMIT) {
					// Too large to be the rate-limit body — give up inspecting, pipe through.
					piping = true;
					clientRes.writeHead(status, upstreamRes.headers);
					for (const ch of chunks) clientRes.write(ch);
					upstreamRes.pipe(clientRes);
				}
			});
			upstreamRes.on("error", () => clientRes.destroy());
			upstreamRes.on("end", () => {
				if (piping) return;
				const bodyBuf = Buffer.concat(chunks);
				let headers = upstreamRes.headers;
				if (isRateLimitError(parseMaybeJson(bodyBuf))) {
					headers = { ...headers, "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS) };
				}
				clientRes.writeHead(status, headers);
				clientRes.end(bodyBuf);
			});
			return;
		}

		clientRes.writeHead(status, upstreamRes.headers);
		upstreamRes.on("error", () => clientRes.destroy());
		upstreamRes.pipe(clientRes);
	});

	// Inactivity timeout: a stalled upstream would otherwise pin a socket for the
	// life of the long-running proxy. Destroying with an error routes into the
	// handler below (502 if nothing was sent yet; otherwise the stream just ends).
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));

	upstream.on("error", (err) => {
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		} else if (!clientRes.writableEnded) {
			// Headers already sent (mid-stream) — can't send a 502. Destroy the
			// client so a stalled/aborted upstream doesn't leak an open connection.
			clientRes.destroy();
		}
	});

	upstream.write(bodyBuffer);
	upstream.end();
}
