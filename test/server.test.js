import { strict as assert } from "node:assert";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
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

async function post(port, body, extraHeaders = {}) {
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/v1/messages",
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
					resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
				);
			},
		);
		req.on("error", reject);
		req.write(payload);
		req.end();
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

	it("non-stream non-200 (e.g. 1313) passes through unchanged", async () => {
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
		assert.equal(claude.calls.length, 0);
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

	it("streaming requests reuse one upstream connection (keep-alive)", async () => {
		const sseBody =
			'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: sseBody,
		}));
		const upstreamConns = [];
		glm.server.on("connection", (s) => upstreamConns.push(s));

		const body = { model: "glm-5.2", stream: true, messages: [{ role: "user", content: "hi" }] };
		const a = await post(proxy.port, body);
		const b = await post(proxy.port, body);

		assert.equal(a.status, 200);
		assert.equal(b.status, 200);
		assert.equal(upstreamConns.length, 1, "second request reused the pooled upstream socket");
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
});
