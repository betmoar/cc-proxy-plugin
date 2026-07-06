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
 * Build the request options for an upstream call. Shared by BOTH forward paths
 * (streaming here, buffered in server.js) so URL/option construction cannot
 * drift between them. The full inbound path including the query string is
 * preserved: Claude Code sends e.g. `/v1/messages?beta=true`, and dropping the
 * query would silently change API behavior (this was a real bug — both paths
 * had independently used `url.pathname` alone).
 *
 * @param {http.IncomingMessage} clientReq
 * @param {import("./providers.js").Provider} provider
 * @param {number} bodyLength
 * @returns {{ proto: typeof http | typeof https, options: http.RequestOptions }}
 */
export function upstreamRequestOptions(clientReq, provider, bodyLength) {
	const url = new URL(provider.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;
	return {
		proto,
		options: {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname + url.search,
			method: clientReq.method,
			headers: buildUpstreamHeaders(provider, clientReq.headers, bodyLength, url.hostname),
			agent: pickAgent(proto),
			timeout: upstreamTimeoutMs(),
		},
	};
}

/**
 * Abort the upstream request when the client goes away before the response
 * finished (user hit Esc, session closed, connection reset). Without this the
 * upstream keeps generating tokens into a dead connection — burning provider
 * quota for output nobody will receive. `close` fires on every response
 * teardown; `writableFinished` distinguishes a completed response from an
 * aborted one.
 *
 * @param {http.ServerResponse} clientRes
 * @param {http.ClientRequest} upstream
 */
export function abortUpstreamOnClientClose(clientRes, upstream) {
	clientRes.on("close", () => {
		if (!clientRes.writableFinished) upstream.destroy();
	});
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
	const { proto, options } = upstreamRequestOptions(clientReq, provider, bodyBuffer.length);

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
				// Only inject Retry-After when the upstream omitted it, so a real
				// value GLM might send in the future isn't clobbered. (Node
				// lowercases header keys, so this check is canonical.)
				if (isRateLimitError(parseMaybeJson(bodyBuf)) && !headers["retry-after"]) {
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
		// Client already gone (it aborted and we destroyed the upstream, which can
		// surface here as ECONNRESET) — nothing to report to anyone.
		if (clientRes.destroyed) return;
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		} else if (!clientRes.writableEnded) {
			// Headers already sent (mid-stream) — can't send a 502. Destroy the
			// client so a stalled/aborted upstream doesn't leak an open connection.
			clientRes.destroy();
		}
	});

	abortUpstreamOnClientClose(clientRes, upstream);
	upstream.write(bodyBuffer);
	upstream.end();
}
