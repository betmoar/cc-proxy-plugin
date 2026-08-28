import { strict as assert } from "node:assert";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { httpAgent } from "../src/agents.js";
import { buildProviders } from "../src/providers.js";
import { createServer } from "../src/server.js";

// End-to-end characterization of handleProxy's routing and overflow conversion.
// Real local HTTP backends stand in for api.z.ai and api.anthropic.com; the
// proxy reaches them over http because baseUrl is injected via config.
//
// Post-collapse contract: non-streaming GLM 200-overflow (stop_reason) is
// converted to a 400; everything else passes through. No replay, no FUP breaker.

/**
 * Start an HTTP server that records the request body it received and replies
 * with the supplied (status, headers, body). Resolves once listening.
 * @param {(req: http.IncomingMessage, recorded: { body: string }) => { status: number, headers: Record<string,string>, body: string }} handler
 */
function startBackend(handler) {
	const calls = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString();
			calls.push({ url: req.url, headers: req.headers, body });
			const { status, headers, body: out } = handler(req, { body });
			res.writeHead(status, headers);
			res.end(out);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
			resolve({ server, port, calls, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

function startProxy(config) {
	const server = createServer(config);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
			resolve({ server, port });
		});
	});
}

function close(...servers) {
	return Promise.all(
		servers.map((s) => new Promise((resolve) => (s ? s.close(resolve) : resolve(undefined)))),
	);
}

async function post(port, body, extraHeaders = {}, path = "/v1/messages") {
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
					authorization: "Bearer oauth-token",
					...extraHeaders,
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(payload);
		req.end();
	});
}

/** GET a path on the proxy and return { status, body }. */
function get(port, path) {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () =>
				resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString(),
				}),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

/** True while something accepts TCP connects on 127.0.0.1:port. */
function portOpen(port) {
	return new Promise((resolve) => {
		const sock = http
			.request({ hostname: "127.0.0.1", port, path: "/_status", method: "GET" }, (res) => {
				res.resume();
				resolve(true);
			})
			.on("error", () => resolve(false));
		sock.end();
	});
}

const OVERFLOW_200 = JSON.stringify({
	id: "msg_x",
	type: "message",
	role: "assistant",
	content: [],
	stop_reason: "model_context_window_exceeded",
	usage: { input_tokens: 0, output_tokens: 0 },
});

const NORMAL_200 = JSON.stringify({
	id: "msg_ok",
	type: "message",
	role: "assistant",
	content: [{ type: "text", text: "from-glm" }],
	stop_reason: "end_turn",
});

describe("server end-to-end routing", () => {
	let glm;
	let claude;
	let proxy;

	afterEach(async () => {
		await close(proxy?.server, glm?.server, claude?.server);
		glm = claude = proxy = undefined;
	});

	async function wire(glmHandler, defaultId = "claude") {
		glm = await startBackend(glmHandler);
		claude = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, defaultId);
		// Point the registry's providers at the local stub backends.
		providers.find((p) => p.id === "glm").baseUrl = glm.baseUrl;
		providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
		proxy = await startProxy({ port: 0, providers });
	}

	it("streaming glm passes straight through (pure pipe)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.match(res.body, /content_block_delta/);
		assert.equal(claude.calls.length, 0);
	});

	it("streaming 1302 rate limit gets a Retry-After header (429 JSON, not SSE)", async () => {
		// A rate limit on a stream:true request comes back as a small JSON 429,
		// never an SSE stream. The proxy must still inject Retry-After.
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: { code: "1302", message: "Rate limit reached" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429);
		assert.equal(res.headers["retry-after"], "30", "Retry-After injected on streaming path");
		assert.match(res.body, /1302/);
		assert.equal(claude.calls.length, 0);
	});

	it("streaming 1302 preserves an upstream Retry-After instead of clobbering it", async () => {
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "90" },
			body: JSON.stringify({ error: { code: "1302", message: "Rate limit reached" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429);
		assert.equal(
			res.headers["retry-after"],
			"90",
			"upstream Retry-After preserved on streaming path",
		);
	});

	it("streaming 1313 (non-1302 429) passes through with no Retry-After", async () => {
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: { code: 1313, message: "FUP" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429);
		assert.equal(res.headers["retry-after"], undefined);
		assert.match(res.body, /1313/);
		assert.equal(claude.calls.length, 0);
	});

	it("non-stream glm 200 overflow is converted to a 400 error", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: OVERFLOW_200,
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 400);
		assert.match(res.body, /context window exceeded/);
		assert.equal(claude.calls.length, 0, "no replay");
	});

	it("non-stream non-200 (e.g. 1313) passes through unchanged, no Retry-After", async () => {
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: { code: 1313, message: "FUP" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429);
		assert.match(res.body, /1313/);
		assert.equal(res.headers["retry-after"], undefined, "1313 must not get a retry hint");
		assert.equal(claude.calls.length, 0);
	});

	it("non-stream 1302 rate limit gets a Retry-After header, body + status preserved", async () => {
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: { code: "1302", message: "Rate limit reached" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429, "status stays 429");
		assert.equal(res.headers["retry-after"], "30", "Retry-After injected");
		assert.match(res.body, /1302/, "original error body preserved");
		assert.equal(claude.calls.length, 0, "no replay");
	});

	it("non-stream 1302 preserves an upstream Retry-After instead of clobbering it", async () => {
		// If GLM ever starts sending its own Retry-After on a 1302, keep it —
		// our fixed default must not mask a more accurate provider value.
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "120" },
			body: JSON.stringify({ error: { code: "1302", message: "Rate limit reached" } }),
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 429);
		assert.equal(res.headers["retry-after"], "120", "upstream Retry-After preserved, not 30");
	});

	it("non-stream normal glm response passes through", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.match(res.body, /from-glm/);
		assert.equal(claude.calls.length, 0);
	});

	it("non-stream response over the buffer cap passes through (not converted)", async () => {
		const big = "x".repeat(1024 * 1024 + 50_000);
		const bigBody = JSON.stringify({
			id: "msg_big",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: big }],
			stop_reason: "end_turn",
		});
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: bigBody,
		}));
		const res = await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.ok(res.body.length > 1024 * 1024, "full large body delivered, not truncated");
		assert.equal(claude.calls.length, 0);
	});

	it("streaming path routes through the shared keep-alive agent", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		httpAgent.destroy(); // clear sockets pooled by earlier tests (shared singleton)
		await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		await new Promise((r) => setImmediate(r)); // let the socket return to the pool
		const free = Object.values(httpAgent.freeSockets).reduce((n, a) => n + a.length, 0);
		assert.equal(free, 1, "upstream socket landed in our shared agent, not Node's globalAgent");
	});

	it(
		"streaming upstream that never responds is timed out as a 502",
		{ timeout: 5000 },
		async () => {
			const saved = process.env.PROXY_UPSTREAM_TIMEOUT_MS;
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "200";
			// Black-hole upstream: accepts the request, never responds.
			const silent = http.createServer(() => {});
			await new Promise((r) => silent.listen(0, "127.0.0.1", r));
			const silentPort = /** @type {any} */ (silent.address()).port;
			try {
				claude = await startBackend(() => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: NORMAL_200,
				}));
				const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
				providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${silentPort}`;
				providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
				proxy = await startProxy({ port: 0, providers });

				const start = Date.now();
				const res = await post(proxy.port, {
					model: "glm-5.2",
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				});
				const elapsed = Date.now() - start;
				assert.equal(res.status, 502);
				assert.ok(elapsed < 2000, `timed out promptly, elapsed=${elapsed}ms`);
			} finally {
				await close(silent);
				if (saved === undefined) process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
				else process.env.PROXY_UPSTREAM_TIMEOUT_MS = saved;
			}
		},
	);

	it("buffered path routes through the shared keep-alive agent", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		httpAgent.destroy(); // clear sockets pooled by earlier tests (shared singleton)
		await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		await new Promise((r) => setImmediate(r)); // let the socket return to the pool
		const free = Object.values(httpAgent.freeSockets).reduce((n, a) => n + a.length, 0);
		assert.equal(free, 1, "upstream socket landed in our shared agent, not Node's globalAgent");
	});

	it(
		"non-stream upstream that never responds is timed out as a 502",
		{ timeout: 5000 },
		async () => {
			const saved = process.env.PROXY_UPSTREAM_TIMEOUT_MS;
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "200";
			// Black-hole upstream: accepts the request, never responds.
			const silent = http.createServer(() => {});
			await new Promise((r) => silent.listen(0, "127.0.0.1", r));
			const silentPort = /** @type {any} */ (silent.address()).port;
			try {
				claude = await startBackend(() => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: NORMAL_200,
				}));
				const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
				providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${silentPort}`;
				providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
				proxy = await startProxy({ port: 0, providers });

				const start = Date.now();
				const res = await post(proxy.port, {
					model: "glm-5.2",
					stream: false,
					messages: [{ role: "user", content: "hi" }],
				});
				const elapsed = Date.now() - start;
				assert.equal(res.status, 502);
				assert.ok(elapsed < 2000, `timed out promptly, elapsed=${elapsed}ms`);
			} finally {
				await close(silent);
				if (saved === undefined) process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
				else process.env.PROXY_UPSTREAM_TIMEOUT_MS = saved;
			}
		},
	);

	it(
		"streaming upstream that stalls mid-response destroys the client (no leak)",
		{ timeout: 5000 },
		async () => {
			const saved = process.env.PROXY_UPSTREAM_TIMEOUT_MS;
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "200";
			// Upstream sends headers + a first SSE chunk, then stalls (never ends).
			// The inactivity timeout fires after headers are already sent to the
			// client, so the proxy cannot send a 502 — it must destroy the client
			// connection instead of leaving it hanging.
			const stalling = http.createServer((req, res) => {
				req.on("data", () => {});
				req.on("end", () => {
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
					// then stall: never res.end()
				});
			});
			await new Promise((r) => stalling.listen(0, "127.0.0.1", r));
			const stallPort = /** @type {any} */ (stalling.address()).port;
			try {
				claude = await startBackend(() => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: NORMAL_200,
				}));
				const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
				providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${stallPort}`;
				providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
				proxy = await startProxy({ port: 0, providers });

				const start = Date.now();
				const outcome = await new Promise((resolve, reject) => {
					const payload = JSON.stringify({
						model: "glm-5.2",
						stream: true,
						messages: [{ role: "user", content: "hi" }],
					});
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: proxy.port,
							path: "/v1/messages",
							method: "POST",
							headers: {
								"content-type": "application/json",
								"content-length": Buffer.byteLength(payload),
								authorization: "Bearer x",
							},
							timeout: 4000,
						},
						(res) => {
							res.on("data", () => {});
							res.on("end", () => resolve("end"));
							res.on("aborted", () => resolve("aborted"));
							res.on("error", () => resolve("error"));
						},
					);
					req.on("error", () => resolve("req-error"));
					req.on("timeout", () => {
						req.destroy();
						reject(new Error("client hung — connection leaked"));
					});
					req.write(payload);
					req.end();
				});
				const elapsed = Date.now() - start;
				// The client connection is terminated (aborted/error), not left open.
				assert.ok(
					outcome === "aborted" || outcome === "error" || outcome === "req-error",
					`client connection terminated, got: ${outcome}`,
				);
				assert.ok(elapsed < 3000, `terminated promptly, elapsed=${elapsed}ms`);
			} finally {
				await close(stalling);
				if (saved === undefined) process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
				else process.env.PROXY_UPSTREAM_TIMEOUT_MS = saved;
			}
		},
	);

	// INVARIANT (transparent pipe): the full inbound path INCLUDING the query
	// string reaches the upstream. Claude Code sends e.g. /v1/messages?beta=true;
	// dropping the query silently changes API behavior.
	it("query string is preserved on the buffered path", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		await post(
			proxy.port,
			{ model: "glm-5.2", stream: false, messages: [] },
			{},
			"/v1/messages?beta=true",
		);
		assert.equal(glm.calls[0].url, "/v1/messages?beta=true");
	});

	it("query string is preserved on the streaming path", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		await post(
			proxy.port,
			{ model: "glm-5.2", stream: true, messages: [] },
			{},
			"/v1/messages?beta=true",
		);
		assert.equal(glm.calls[0].url, "/v1/messages?beta=true");
	});

	it(
		"client abort mid-stream aborts the upstream request (no quota leak) and the proxy survives",
		{ timeout: 5000 },
		async () => {
			// Upstream streams SSE ticks forever; record when its response is torn
			// down. Without abort propagation it would keep generating (billing
			// tokens) until the upstream inactivity timeout — or forever.
			let upstreamTornDown;
			const tornDown = new Promise((r) => {
				upstreamTornDown = r;
			});
			const streaming = http.createServer((req, res) => {
				req.on("data", () => {});
				req.on("end", () => {
					res.writeHead(200, { "content-type": "text/event-stream" });
					const iv = setInterval(() => res.write("data: {}\n\n"), 50);
					res.on("close", () => {
						clearInterval(iv);
						upstreamTornDown();
					});
				});
			});
			await new Promise((r) => streaming.listen(0, "127.0.0.1", r));
			const streamPort = /** @type {any} */ (streaming.address()).port;
			try {
				claude = await startBackend(() => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: NORMAL_200,
				}));
				const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
				providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${streamPort}`;
				providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
				proxy = await startProxy({ port: 0, providers });

				// Start a streaming request, then destroy the client connection after
				// the first chunk arrives.
				await new Promise((resolve, reject) => {
					const payload = JSON.stringify({ model: "glm-5.2", stream: true, messages: [] });
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: proxy.port,
							path: "/v1/messages",
							method: "POST",
							headers: {
								"content-type": "application/json",
								"content-length": Buffer.byteLength(payload),
							},
						},
						(res) => {
							res.once("data", () => req.destroy());
							res.on("error", () => {});
						},
					);
					req.on("error", () => {});
					req.on("close", resolve);
					req.setTimeout(3000, () => reject(new Error("client never got a first chunk")));
					req.write(payload);
					req.end();
				});

				await tornDown; // hangs (→ test timeout) if the upstream leak regresses

				// The shared proxy process must still be serving after the abort.
				const after = await post(proxy.port, {
					model: "claude-opus-4-6",
					stream: false,
					messages: [],
				});
				assert.equal(after.status, 200, "proxy still functional after client abort");
			} finally {
				await close(streaming);
			}
		},
	);

	// INVARIANT (transparent pipe, hop-by-hop exception): a client that sends its
	// body chunked must still reach the upstream as a content-length request with
	// no transfer-encoding header — the proxy buffers the full body, and CL+TE
	// together are rejected by upstreams as request smuggling (bare 400).
	async function postChunked(port, body, stream) {
		const payload = JSON.stringify({ ...body, stream });
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port,
					path: "/v1/messages",
					method: "POST",
					// no content-length; explicit chunked framing
					headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () =>
						resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
					);
				},
			);
			req.on("error", reject);
			req.write(payload.slice(0, 25));
			req.write(payload.slice(25));
			req.end();
		});
	}

	it("chunked inbound body reaches the upstream with content-length, no transfer-encoding (buffered path)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const res = await postChunked(proxy.port, { model: "glm-5.2", messages: [] }, false);
		assert.equal(res.status, 200);
		const call = glm.calls[0];
		assert.equal(call.headers["transfer-encoding"], undefined, "TE must not be forwarded");
		assert.equal(call.headers["content-length"], String(call.body.length), "CL set to real length");
		assert.match(call.body, /"model":"glm-5\.2"/, "full body delivered");
	});

	it("chunked inbound body reaches the upstream with content-length, no transfer-encoding (streaming path)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		const res = await postChunked(proxy.port, { model: "glm-5.2", messages: [] }, true);
		assert.equal(res.status, 200);
		const call = glm.calls[0];
		assert.equal(call.headers["transfer-encoding"], undefined, "TE must not be forwarded");
		assert.equal(call.headers["content-length"], String(call.body.length), "CL set to real length");
		assert.match(call.body, /"model":"glm-5\.2"/, "full body delivered");
	});

	// INVARIANT (transparent pipe, accept-encoding exception): the buffered path
	// JSON.parses the response body to convert a GLM 200-overflow into a 400 and to
	// inject Retry-After on a 1302. A gzipped body would fail to parse and both
	// normalizations would silently degrade to passthrough — so the buffered path
	// pins accept-encoding: identity upstream. The streaming path must NOT: SSE is
	// a pure pipe and keeps whatever the client negotiated.
	it("buffered path forces accept-encoding: identity upstream (body inspection can't read gzip)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const res = await post(proxy.port, { model: "glm-5.2", stream: false, messages: [] });
		assert.equal(res.status, 200);
		assert.equal(glm.calls[0].headers["accept-encoding"], "identity");
	});

	it("buffered path overrides an inbound accept-encoding: gzip (it must not survive upstream)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const res = await post(
			proxy.port,
			{ model: "glm-5.2", stream: false, messages: [] },
			{ "accept-encoding": "gzip, deflate, br" },
		);
		assert.equal(res.status, 200);
		assert.equal(
			glm.calls[0].headers["accept-encoding"],
			"identity",
			"client's gzip preference must not reach the upstream on the buffered path",
		);
	});

	it("streaming path leaves accept-encoding untouched (pure pipe, no identity forcing)", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		const res = await post(
			proxy.port,
			{ model: "glm-5.2", stream: true, messages: [] },
			{ "accept-encoding": "gzip, deflate, br" },
		);
		assert.equal(res.status, 200);
		assert.equal(glm.calls[0].headers["accept-encoding"], "gzip, deflate, br");
	});

	it("claude request uses OAuth passthrough (Authorization kept, no x-api-key)", async () => {
		await wire(
			() => ({ status: 200, headers: { "content-type": "application/json" }, body: NORMAL_200 }),
			"claude",
		);
		await post(proxy.port, {
			model: "claude-opus-4-6",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		// claude-opus-4-6 routes to the claude provider; wire() points it at the claude stub.
		assert.equal(claude.calls.length, 1, "claude stub received the request");
		const headers = claude.calls[0].headers;
		assert.equal(headers.authorization, "Bearer oauth-token", "OAuth header passed through");
		assert.equal(headers["x-api-key"], undefined, "no x-api-key set");
	});

	it("routing log line records the model, provider and request path", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		try {
			await post(
				proxy.port,
				{ model: "glm-5.2", stream: false, messages: [] },
				{},
				"/v1/messages?beta=true",
			);
		} finally {
			console.log = orig;
		}
		const route = logged.find((l) => / -> /.test(l));
		assert.ok(route, "a routing line was logged");
		assert.match(route, /\] \{[0-9a-f]+\} glm-5\.2 -> glm \/v1\/messages\?beta=true$/);
	});

	// Issue #34 follow-up. The routing DECISION is made on a normalized id, but
	// the log reports what the CLIENT sent — so when a `[1m]` suffix or a
	// `<provider>:` lens is present, the line alone cannot explain why the id
	// landed where it did. The annotation is gated on an actual difference, and
	// BOTH halves matter: it must appear when normalization happened (or the log
	// is unexplainable) and must NOT appear otherwise (the bare-id line above is
	// anchored with `$`, and scripts/status.js parses these lines).
	it("routing log annotates the normalized id, and only when it differs", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		try {
			await post(
				proxy.port,
				{ model: "glm-5.2[1m]", stream: false, messages: [] },
				{},
				"/v1/messages",
			);
		} finally {
			console.log = orig;
		}
		const route = logged.find((l) => / -> /.test(l));
		assert.ok(route, "a routing line was logged");
		assert.match(
			route,
			/\] \{[0-9a-f]+\} glm-5\.2\[1m\] -> glm \(routed as glm-5\.2\) \/v1\/messages$/,
			"the raw id is reported, the normalized id explains the decision",
		);

		// The bytes the BACKEND actually received — the project's rule is that a
		// forwarding change with no failing test is untested, and every other
		// suffix assertion is unit-level against resolve(). Measured 2026-08-14:
		// Z.ai 400s on `glm-5.2[1m]` ([1214][modelCode: does not exist]) and the
		// Qwen plan 400s the same way, so sending the suffix upstream would route
		// correctly and fail at the vendor. This is the assertion that catches a
		// regression to forwarding it.
		assert.equal(
			JSON.parse(glm.calls[0].body).model,
			"glm-5.2",
			"upstream must receive the bare id — no vendor accepts CC's [1m] spelling",
		);
	});

	// The version handshake that fixes PROXY_PATH staleness: the SessionStart
	// hook compares /_status.version against its own plugin tree and restarts a
	// mismatched proxy via /_shutdown. Without version in /_status a stale proxy
	// is indistinguishable from a current one.
	it("GET /_status reports the proxy version from config", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const res = await get(proxy.port, "/_status");
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).version, "9.9.9");
	});

	// Minimal liveness probe — the fastest possible "is the proxy up" check. A bare
	// 200 with an empty body, no config read or serialization. Cheaper than /_status
	// (which still happens to be fast, but this is the designated hot-path probe).
	it("GET /_ping returns a bare 200 with an empty body (fast liveness)", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const res = await get(proxy.port, "/_ping");
		assert.equal(res.status, 200);
		assert.equal(res.body, "", "/_ping must have an empty body");
		// An empty body must not claim to be JSON — a client's res.json() would throw.
		assert.equal(res.headers["content-type"], undefined);
		// Intercepted, not forwarded: the upstream stub was never hit.
		assert.equal(glm.calls.length, 0, "/_ping must not be forwarded upstream");
	});

	// A cache-busting query string is the natural way to write a probe; matching on
	// the raw url would forward it upstream (burning quota on a liveness check).
	it("GET /_ping and /_status tolerate a query string, still not forwarded", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const ping = await get(proxy.port, "/_ping?t=123");
		assert.equal(ping.status, 200);
		assert.equal(ping.body, "");
		const status = await get(proxy.port, "/_status?t=123");
		assert.equal(status.status, 200);
		assert.equal(JSON.parse(status.body).version, "9.9.9");
		assert.equal(glm.calls.length, 0, "probes must not be forwarded upstream");
	});

	// The probes answer before any body is buffered, so a client that sends a body
	// and never ends the request still gets an immediate response. Gating the reply
	// on 'end' would hang the hot-path liveness check and let a slow uploader pin
	// memory in the shared proxy process.
	it("GET /_ping answers without waiting for the request body", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const status = await new Promise((resolve, reject) => {
			const req = http.request(
				{ hostname: "127.0.0.1", port: proxy.port, path: "/_ping", method: "GET" },
				(res) => {
					res.resume();
					resolve(res.statusCode);
				},
			);
			req.on("error", reject);
			// A body, deliberately never ended: the response must arrive anyway.
			req.write("x".repeat(1024));
		});
		assert.equal(status, 200);
		assert.equal(glm.calls.length, 0);
	});

	it("POST /_shutdown responds 200 and the server stops accepting connections", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const res = await post(proxy.port, {}, {}, "/_shutdown");
		assert.equal(res.status, 200);
		let open = true;
		for (let i = 0; i < 40 && open; i++) {
			open = await portOpen(proxy.port);
			if (open) await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(open, false, "listener should be released after /_shutdown");
		proxy = undefined; // already closed; afterEach close() would hang on it
	});

	it("GET /_shutdown is rejected with 405 and the server keeps serving", async () => {
		glm = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
		proxy = await startProxy({ port: 0, providers, version: "9.9.9" });
		const res = await get(proxy.port, "/_shutdown");
		assert.equal(res.status, 405);
		assert.equal(await portOpen(proxy.port), true, "server must survive a GET /_shutdown");
	});

	it("routing log line falls back to 'unknown' model but still records the path", async () => {
		// count_tokens and similar calls arrive with no `model` field; the path
		// is what makes those `unknown -> …` entries diagnosable.
		await wire(
			() => ({ status: 200, headers: { "content-type": "application/json" }, body: NORMAL_200 }),
			"claude",
		);
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		try {
			await post(proxy.port, { messages: [] }, {}, "/v1/messages/count_tokens");
		} finally {
			console.log = orig;
		}
		const route = logged.find((l) => / -> /.test(l));
		assert.ok(route, "a routing line was logged");
		assert.match(route, /\] \{[0-9a-f]+\} unknown -> claude \/v1\/messages\/count_tokens$/);
	});
});

describe("provider selector strip (the local lens must never leak upstream)", () => {
	let qwen;
	let claude;
	let proxy;

	afterEach(async () => {
		await close(qwen?.server, claude?.server, proxy?.server);
		qwen = claude = proxy = undefined;
	});

	async function wire(qwenHandler) {
		qwen = await startBackend(qwenHandler);
		claude = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const providers = buildProviders({ GLM_API_KEY: "g", DASHSCOPE_API_KEY: "q" }, "claude");
		providers.find((p) => p.id === "qwen").baseUrl = qwen.baseUrl;
		providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
		// GLM registers here (the key is set to make the qwen/glm predicates
		// realistic) but has NO stub, so any test in this block that routes a
		// glm- id would issue a REAL request to api.z.ai — observed once as a
		// bare 401, which reads like a proxy bug rather than a wiring mistake.
		// Point it at a closed port so the failure is instant and unambiguous.
		providers.find((p) => p.id === "glm").baseUrl = "http://127.0.0.1:1";
		proxy = await startProxy({ port: 0, providers });
	}

	const okJson = () => ({
		status: 200,
		headers: { "content-type": "application/json" },
		body: NORMAL_200,
	});

	it("buffered path: upstream receives the BARE id, not the prefixed one", async () => {
		// Live-probed 2026-08-06: sending "qwen:deepseek-v4-pro" un-stripped returns
		// 400 "Model not exist" — the plan host has never heard of our prefix.
		await wire(okJson);
		const res = await post(proxy.port, {
			model: "qwen:deepseek-v4-pro",
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.equal(qwen.calls.length, 1, "routed to the selected provider");
		assert.equal(JSON.parse(qwen.calls[0].body).model, "deepseek-v4-pro");
		assert.equal(claude.calls.length, 0);
	});

	it("streaming path: upstream receives the BARE id too", async () => {
		// Separate code from the buffered path, and it never parses the body — the
		// rewrite has to happen before the stream/non-stream branch or SSE leaks.
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_start\ndata: {"type":"message_start"}\n\n',
		}));
		const res = await post(proxy.port, {
			model: "qwen:deepseek-v4-pro",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(qwen.calls[0].body).model, "deepseek-v4-pro");
	});

	// 0.6.3 made the variant-suffix strip a body rewrite (both vendors 400 on
	// the suffixed spelling), so the rewrite now fires on inputs where it never
	// used to. The streaming path is SEPARATE code that never parses the body,
	// and the qwen: selector test above exercises the LENS strip, not this one —
	// same branch, different producer of the rewrite.
	it("streaming path: a [1m] suffix is stripped from the body too", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_start\ndata: {"type":"message_start"}\n\n',
		}));
		const res = await post(proxy.port, {
			model: "deepseek-v4-pro[1m]",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.equal(
			JSON.parse(qwen.calls[0].body).model,
			"deepseek-v4-pro",
			"the vendor must receive the bare id on the streaming path as well",
		);
	});

	// A rewritten body is SHORTER than the inbound one (stripping `[1m]` drops 4
	// bytes), so a content-length copied from the inbound request would over-
	// declare the payload. Node would then wait for bytes that never arrive and
	// the request would hang rather than fail cleanly. The local stubs are
	// permissive enough to accept a wrong header, so assert the header itself
	// rather than trusting that the request succeeded.
	it("content-length matches the REWRITTEN body, not the inbound one", async () => {
		await wire(okJson);
		const inbound = { model: "deepseek-v4-pro[1m]", messages: [{ role: "user", content: "hi" }] };
		const inboundLength = Buffer.byteLength(JSON.stringify(inbound));
		await post(proxy.port, inbound);

		const sent = qwen.calls[0];
		const declared = Number(sent.headers["content-length"]);
		assert.equal(
			declared,
			Buffer.byteLength(sent.body),
			"declared content-length must equal the bytes actually sent",
		);
		assert.equal(
			declared,
			inboundLength - "[1m]".length,
			"the rewritten body is exactly 4 bytes shorter than what the client sent",
		);
		assert.equal(sent.headers["transfer-encoding"], undefined, "no chunked alongside a length");
	});

	it("a non-prefixed body is forwarded byte-for-byte (invariant 1 intact)", async () => {
		// The rewrite is gated on upstreamModel !== body.model, so an untouched
		// request must still reuse the original buffer verbatim — key order and
		// whitespace included. Under the stub setup (GLM + DASHSCOPE, no
		// DEEPSEEK_API_KEY), the bare id routes to the qwen plan (native not
		// registered → plan fallback, issue #19), which is what makes this a
		// real forwarding path rather than a default-backend fallthrough.
		await wire(okJson);
		const payload = { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] };
		await post(proxy.port, payload);
		assert.equal(qwen.calls[0].body, JSON.stringify(payload));
	});

	it("logs the inbound (prefixed) id, so the lens is visible in the audit trail", async () => {
		await wire(okJson);
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		try {
			await post(proxy.port, {
				model: "qwen:deepseek-v4-pro",
				messages: [{ role: "user", content: "hi" }],
			});
		} finally {
			console.log = orig;
		}
		const route = logged.find((l) => / -> /.test(l));
		assert.match(route, /qwen:deepseek-v4-pro -> qwen/);
	});

	it("a haiku tail goes to Claude with the bare id, never to the selected backend", async () => {
		// Invariant 4 under the lens: the pin outranks the selector, AND the strip
		// still applies so Claude receives an id it recognizes.
		await wire(okJson);
		const res = await post(proxy.port, {
			model: "qwen:claude-haiku-4-5-20251001",
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.equal(qwen.calls.length, 0, "haiku must not reach a third-party backend");
		assert.equal(claude.calls.length, 1);
		assert.equal(JSON.parse(claude.calls[0].body).model, "claude-haiku-4-5-20251001");
	});
});

describe("LM Studio provider (selector-only, base-URL gated)", () => {
	let lmstudio;
	let claude;
	let proxy;

	afterEach(async () => {
		await close(lmstudio?.server, claude?.server, proxy?.server);
		lmstudio = claude = proxy = undefined;
	});

	async function wire(lmHandler) {
		lmstudio = await startBackend(lmHandler);
		claude = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const providers = buildProviders({ LMSTUDIO_BASE_URL: lmstudio.baseUrl }, "claude");
		providers.find((p) => p.id === "lmstudio").baseUrl = lmstudio.baseUrl;
		providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
		proxy = await startProxy({ port: 0, providers });
	}

	it("buffered: lmstudio:<id> reaches the LM Studio stub with the bare id and bearer auth", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "msg_lm",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "from-lmstudio" }],
				stop_reason: "end_turn",
			}),
		}));
		const res = await post(proxy.port, {
			model: "lmstudio:openai/gpt-oss-20b",
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal(res.status, 200);
		assert.match(res.body, /from-lmstudio/);
		assert.equal(lmstudio.calls.length, 1);
		assert.equal(
			JSON.parse(lmstudio.calls[0].body).model,
			"openai/gpt-oss-20b",
			"the vendor receives its own id, not the lens",
		);
		assert.match(
			lmstudio.calls[0].headers.authorization,
			/^Bearer lmstudio$/,
			"the dummy token from LM Studio's own docs",
		);
		assert.equal(
			lmstudio.calls[0].headers["x-api-key"],
			undefined,
			"inbound x-api-key dropped — credential isolation",
		);
		assert.equal(claude.calls.length, 0);
	});

	it("streaming: SSE passes through untouched", async () => {
		// Separate code from the buffered path. LM Studio's Anthropic skin emits
		// standard message_start/content_block_delta/message_stop framing
		// (probed live 2026-08-28), so the pipe must not disturb it.
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"1"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		const res = await post(proxy.port, {
			model: "lmstudio:openai/gpt-oss-20b",
			stream: true,
			messages: [{ role: "user", content: "count to five" }],
		});
		assert.equal(res.status, 200);
		assert.match(res.body, /content_block_delta/);
		assert.match(res.body, /message_stop/);
		assert.equal(lmstudio.calls.length, 1);
		assert.equal(JSON.parse(lmstudio.calls[0].body).model, "openai/gpt-oss-20b");
	});
});

describe("request-id correlation (x-request-id + log stamp)", () => {
	let qwen;
	let claude;
	let proxy;

	afterEach(async () => {
		await close(qwen?.server, claude?.server, proxy?.server);
		qwen = claude = proxy = undefined;
	});

	async function wire(qwenHandler) {
		qwen = await startBackend(qwenHandler);
		claude = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const providers = buildProviders({ GLM_API_KEY: "g", DASHSCOPE_API_KEY: "q" }, "claude");
		providers.find((p) => p.id === "qwen").baseUrl = qwen.baseUrl;
		providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
		// GLM registers here but has NO stub — same trap the selector-strip suite
		// documents: a glm- id would leave for the REAL api.z.ai with a fake key
		// (observed as a 401 "token expired or incorrect", which reads like a
		// proxy bug). Point it at a closed port so the failure is instant.
		providers.find((p) => p.id === "glm").baseUrl = "http://127.0.0.1:1";
		proxy = await startProxy({ port: 0, providers });
	}

	it("echoes x-request-id and stamps the SAME id on the routing line", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		let res;
		try {
			res = await post(proxy.port, {
				model: "qwen:deepseek-v4-pro",
				messages: [{ role: "user", content: "hi" }],
			});
		} finally {
			console.log = orig;
		}
		const echoed = res.headers["x-request-id"];
		assert.ok(echoed, "every response carries x-request-id");
		assert.match(echoed, /^[0-9a-f]{8}$/);
		const route = logged.find((l) => / -> /.test(l));
		assert.ok(route.includes(`{${echoed}}`), `the routing line must carry the echoed id: ${route}`);
	});

	it("honors an inbound x-request-id instead of minting one (correlation survives a chain)", async () => {
		// A client (or an outer gateway) that already assigns an id gets it back —
		// that is the whole point of correlation. Truncated at 64 chars so a
		// hostile inbound header cannot bloat the log line.
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		const res = await post(
			proxy.port,
			{ model: "qwen:deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] },
			{ "x-request-id": "my-correlation-id-42" },
		);
		assert.equal(res.headers["x-request-id"], "my-correlation-id-42");
	});

	it("harvests the vendor request_id from a buffered error onto the log", async () => {
		await wire(() => ({
			status: 429,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				error: { code: 1313, message: "FUP", request_id: "gen-abc123" },
			}),
		}));
		const logged = [];
		const orig = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		try {
			await post(proxy.port, {
				model: "qwen:deepseek-v4-pro",
				messages: [{ role: "user", content: "hi" }],
			});
		} finally {
			console.log = orig;
		}
		const harvest = logged.find((l) => l.includes("[vendor-request-id]"));
		assert.ok(harvest, "the vendor id was not harvested");
		assert.match(harvest, /gen-abc123/);
	});
});
