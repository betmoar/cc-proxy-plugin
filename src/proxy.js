// @ts-check
import http from "node:http";
import https from "node:https";
import { buildUpstreamHeaders } from "./providers.js";

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
	};

	const upstream = proto.request(options, (upstreamRes) => {
		clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
		upstreamRes.on("error", () => clientRes.destroy());
		upstreamRes.pipe(clientRes);
	});

	upstream.on("error", (err) => {
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		}
	});

	upstream.write(bodyBuffer);
	upstream.end();
}
