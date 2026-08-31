// @ts-check
import http from "node:http";
import https from "node:https";
import { pickAgent, upstreamTimeoutMs } from "./agents.js";
import { RATE_LIMIT_RETRY_AFTER_SECONDS, isRateLimitError } from "./fallback.js";
import { buildUpstreamHeaders } from "./providers.js";

// A rate-limit error body is tiny JSON; cap buffering so a mislabeled large 429
// can't be held in memory. Past the cap we give up inspecting and pipe through.
const RATE_LIMIT_PEEK_LIMIT = 64 * 1024;

/**
 * A provider is configured in a way the forwarding path cannot use (today: a
 * baseUrl that is not a parseable URL). Distinct from an upstream I/O failure
 * because the fix is the user's config, not a retry — and because it must be
 * caught before it escapes into the dispatcher, where a throw is fatal to the
 * whole process rather than to one request.
 */
export class UpstreamConfigError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "UpstreamConfigError";
	}
}

/**
 * Upstream headers with `x-request-id` removed, so the proxy's own correlation
 * id survives to the client.
 *
 * `writeHead(status, headers)` REPLACES anything a prior `setHeader()` put on
 * the response, so a backend that emits its own `x-request-id` (OpenAI-shaped
 * servers commonly do) silently overwrites ours — measured on both the buffered
 * and streaming paths: the log line said `{proxy-client-id}` while the client
 * received `VENDOR-OWN-ID`, which is precisely the correlation the id exists to
 * provide, broken with no error anywhere.
 *
 * The vendor's id is not lost information: `forwardBuffered()` already harvests
 * a vendor `request_id` from error bodies onto its own log line. What must not
 * happen is the two silently swapping places on the wire.
 *
 * @param {Record<string, any>} headers
 * @returns {Record<string, any>}
 */
export function withoutRequestId(headers) {
	if (!headers || !("x-request-id" in headers)) return headers;
	const { "x-request-id": _vendorId, ...rest } = headers;
	return rest;
}

/**
 * Shared by both forward paths (streaming here, buffered in server.js) so body
 * inspection cannot drift between them.
 * @param {Buffer} buffer @returns {unknown}
 */
export function parseMaybeJson(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return null;
	}
}

/**
 * Error handler for an upstream request, shared by BOTH forward paths so the
 * error contract (502 before headers, teardown after) cannot drift between
 * them — the same duplication class that shipped the query-string bug twice.
 * @param {http.ServerResponse} clientRes
 * @returns {(err: Error) => void}
 */
export function onUpstreamError(clientRes) {
	return (err) => {
		// Client already gone (it aborted and we destroyed the upstream, which can
		// surface here as ECONNRESET) — nothing to report to anyone.
		if (clientRes.destroyed) return;
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		} else if (!clientRes.writableEnded) {
			// Headers already sent (mid-stream or mid-passthrough) — can't send a
			// 502. Destroy the client so a stalled/aborted upstream doesn't leak an
			// open downstream connection.
			clientRes.destroy();
		}
	};
}

/**
 * Build the request options for an upstream call. Shared by BOTH forward paths
 * (streaming here, buffered in server.js) so URL/option construction cannot
 * drift between them. The full inbound path including the query string is
 * preserved: Claude Code sends e.g. `/v1/messages?beta=true`, and dropping the
 * query would silently change API behavior (this was a real bug — both paths
 * had independently used `url.pathname` alone).
 *
 * `forceIdentityEncoding` is passed by the buffered path only (see
 * buildUpstreamHeaders) — response-body inspection cannot read gzip.
 *
 * @param {http.IncomingMessage} clientReq
 * @param {import("./providers.js").Provider} provider
 * @param {number} bodyLength
 * @param {boolean} [forceIdentityEncoding]
 * @returns {{ proto: typeof http | typeof https, options: http.RequestOptions }}
 */
export function upstreamRequestOptions(clientReq, provider, bodyLength, forceIdentityEncoding) {
	// A THROW HERE ENDS THE PROCESS, so it is converted into a typed error the
	// forward paths already know how to answer with a 502. `new URL()` throws on
	// any baseUrl without a scheme, and since 0.8.0 one baseUrl is free-form user
	// input (LMSTUDIO_BASE_URL) rather than a hardcoded literal. buildProviders()
	// refuses to register an invalid one, so this is the second line of defence —
	// but it is the load-bearing one for any future provider whose baseUrl comes
	// from config, because this function runs inside the request dispatcher and
	// that dispatcher has no try (measured: exit 1, no response, every concurrent
	// session dropped).
	let url;
	try {
		url = new URL(provider.baseUrl + clientReq.url);
	} catch {
		throw new UpstreamConfigError(
			`provider "${provider.id}" has an unusable base URL — check its *_BASE_URL setting`,
		);
	}
	const proto = url.protocol === "https:" ? https : http;
	return {
		proto,
		options: {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname + url.search,
			method: clientReq.method,
			// `url.host`, not `url.hostname`: host KEEPS a non-default port
			// (`127.0.0.1:1234`), hostname drops it. RFC 9112 §3.2 requires the port
			// in the Host header when it isn't the scheme default — the hardcoded
			// vendors all sit on 443 so the two are identical there, but
			// LMSTUDIO_BASE_URL's documented form is `http://host:1234`, and a
			// port-less Host misroutes any vhost/reverse-proxy front silently
			// (measured: the stub behind a port-carrying baseUrl received
			// `Host: 127.0.0.1`, no port). The socket options below keep hostname —
			// Node wants host and port as separate fields there.
			headers: buildUpstreamHeaders(
				provider,
				clientReq.headers,
				bodyLength,
				url.host,
				forceIdentityEncoding,
			),
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
	// An UpstreamConfigError here is a misconfigured baseUrl, not an I/O failure:
	// answer it like one bad request instead of letting the throw escape into the
	// dispatcher, which would end the process for every session.
	let proto;
	let options;
	try {
		({ proto, options } = upstreamRequestOptions(clientReq, provider, bodyBuffer.length));
	} catch (err) {
		onUpstreamError(clientRes)(/** @type {Error} */ (err));
		return;
	}

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
					clientRes.writeHead(status, withoutRequestId(upstreamRes.headers));
					for (const ch of chunks) clientRes.write(ch);
					upstreamRes.pipe(clientRes);
				}
			});
			// Same error contract as every other pre-headers upstream failure:
			// onUpstreamError sends a 502 while the head is unsent and tears down
			// after — a bare destroy() here answered an upstream death mid-429-body
			// with a socket reset the client's retry logic can't key on, while
			// forwardBuffered() answers the identical failure with a 502.
			upstreamRes.on("error", onUpstreamError(clientRes));
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
				clientRes.writeHead(status, withoutRequestId(headers));
				clientRes.end(bodyBuf);
			});
			return;
		}

		clientRes.writeHead(status, withoutRequestId(upstreamRes.headers));
		upstreamRes.on("error", () => clientRes.destroy());
		upstreamRes.pipe(clientRes);
	});

	// Inactivity timeout: a stalled upstream would otherwise pin a socket for the
	// life of the long-running proxy. Destroying with an error routes into the
	// handler below (502 if nothing was sent yet; otherwise the stream just ends).
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));

	upstream.on("error", onUpstreamError(clientRes));

	abortUpstreamOnClientClose(clientRes, upstream);
	upstream.write(bodyBuffer);
	upstream.end();
}
