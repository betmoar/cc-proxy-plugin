import { strict as assert } from "node:assert";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import {
	DEEPSEEK_PRICING,
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
	coerceCreated,
	collectModels,
	parseOpenRouterModels,
} from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { createServer } from "../src/server.js";

describe("models.js pure helpers", () => {
	it("DEFAULT_CLAUDE_MODELS holds only reachable Claude ids (no haiku, no mythos)", () => {
		const ids = DEFAULT_CLAUDE_MODELS.map((m) => m.id);
		assert.deepEqual(ids, ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);
		for (const m of DEFAULT_CLAUDE_MODELS) {
			assert.equal(m.type, "model");
			assert.equal(m.created_at, null);
			assert.ok(m.display_name.length > 0);
		}
	});

	it("DEFAULT_OPENROUTER_MODELS holds the 5 verified skin-compatible ids with curated names", () => {
		assert.deepEqual(DEFAULT_OPENROUTER_MODELS, [
			{
				type: "model",
				id: "deepseek/deepseek-v4-pro",
				display_name: "DeepSeek V4 Pro",
				created_at: null,
			},
			{
				type: "model",
				id: "deepseek/deepseek-v4-flash",
				display_name: "DeepSeek V4 Flash",
				created_at: null,
			},
			{ type: "model", id: "tencent/hy3", display_name: "Tencent Hy3", created_at: null },
			{
				type: "model",
				id: "moonshotai/kimi-k2.7-code",
				display_name: "Kimi K2.7 Code",
				created_at: null,
			},
			{ type: "model", id: "moonshotai/kimi-k3", display_name: "Kimi K3", created_at: null },
			{ type: "model", id: "qwen/qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
		]);
	});

	it("DEEPSEEK_PRICING holds the curated per-1M-token prices for both live models", () => {
		// Curated (no pricing API exists). Pins the two documented ids + their prices
		// so a silent edit or a dropped model is caught.
		assert.deepEqual(Object.keys(DEEPSEEK_PRICING).sort(), [
			"deepseek-v4-flash",
			"deepseek-v4-pro",
		]);
		assert.equal(DEEPSEEK_PRICING["deepseek-v4-pro"].out, 0.87);
		assert.equal(DEEPSEEK_PRICING["deepseek-v4-flash"].out, 0.28);
	});

	it("DEFAULT_QWEN_MODELS holds the curated bare-qwen ids with display names", () => {
		// Static (Qwen exposes no /models endpoint). Pins the live-verified ids so a
		// dropped model or a non-`qwen`-prefixed id (routing would miss it) is caught.
		assert.deepEqual(
			DEFAULT_QWEN_MODELS.map((m) => m.id),
			["qwen3.8-max", "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"],
		);
		for (const m of DEFAULT_QWEN_MODELS) {
			assert.equal(m.type, "model");
			assert.equal(m.created_at, null);
			assert.ok(m.display_name.length > 0);
			assert.ok(m.id.startsWith("qwen"), `${m.id} must start with qwen`);
		}
	});

	it("parseOpenRouterModels splits, trims, drops empties; display_name is the id", () => {
		assert.deepEqual(parseOpenRouterModels("  a ,, b "), [
			{ type: "model", id: "a", display_name: "a", created_at: null },
			{ type: "model", id: "b", display_name: "b", created_at: null },
		]);
		assert.deepEqual(parseOpenRouterModels(""), []);
		assert.deepEqual(parseOpenRouterModels(undefined), []);
	});

	it("coerceCreated passes strings through, nulls everything else", () => {
		assert.equal(coerceCreated("2026-07-28T00:00:00Z"), "2026-07-28T00:00:00Z");
		assert.equal(coerceCreated(1700000000), null);
		assert.equal(coerceCreated(undefined), null);
		assert.equal(coerceCreated(null), null);
	});
});

/** Start a stub HTTP backend; handler returns { status, headers, body }. */
function startBackend(handler) {
	const calls = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
			const result = handler(req);
			if (!result || typeof result.then !== "function") {
				// Synchronous: a { status, headers, body } object
				const { status, headers, body } = result;
				res.writeHead(status, headers);
				res.end(body);
			}
			// If handler returns a promise, don't await it (allows testing timeouts by never sending response).
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, port, calls, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

function close(...servers) {
	return Promise.all(servers.map((s) => new Promise((r) => (s ? s.close(r) : r()))));
}

const GLM_MODELS_BODY = JSON.stringify({
	data: [
		{ created_at: "2026-02-11T00:00:00Z", display_name: "GLM-5", id: "glm-5", type: "model" },
		{ created_at: "2026-06-01T00:00:00Z", display_name: "GLM-5.2", id: "glm-5.2", type: "model" },
	],
	firstId: "glm-5",
	hasMore: false,
	lastId: "glm-5.2",
});

/** Build a config whose glm (and optionally claude) provider points at a stub baseUrl.
 * `claudeBaseUrl` rebases the claude provider so a *forwarded* request (e.g. the
 * /v1/models/<id> retrieve path) hits a local stub instead of the real
 * api.anthropic.com — never let a test issue a real-network call. */
function wireConfig(
	glmBaseUrl,
	{
		glmKey = "glm-test",
		orKey,
		dsKey,
		qwenKey,
		openRouterModels,
		claudeModels,
		qwenModels,
		claudeBaseUrl,
		modelsTimeoutMs = 2000,
		modelsForceThrow,
	} = {},
) {
	const env = { GLM_API_KEY: glmKey };
	if (orKey) env.OPENROUTER_API_KEY = orKey;
	if (dsKey) env.DEEPSEEK_API_KEY = dsKey;
	if (qwenKey) env.DASHSCOPE_API_KEY = qwenKey;
	const providers = buildProviders(env, "claude");
	const glm = providers.find((p) => p.id === "glm");
	if (glm) glm.baseUrl = glmBaseUrl;
	// DeepSeek: point the provider baseUrl at the stub root (no /anthropic suffix), so
	// fetchDeepSeekModels' `.replace(/\/anthropic$/,"")` leaves the stub and GETs ${stub}/models.
	const deepseek = providers.find((p) => p.id === "deepseek");
	if (deepseek && dsKey) deepseek.baseUrl = glmBaseUrl;
	if (claudeBaseUrl) providers.find((p) => p.id === "claude").baseUrl = claudeBaseUrl;
	return {
		providers,
		claudeModels: claudeModels ?? DEFAULT_CLAUDE_MODELS,
		qwenModels: qwenModels ?? DEFAULT_QWEN_MODELS,
		openRouterModels: openRouterModels ?? DEFAULT_OPENROUTER_MODELS,
		modelsTimeoutMs,
		modelsForceThrow,
	};
}

describe("collectModels fan-out", () => {
	let glm;
	afterEach(async () => {
		await close(glm?.server);
		glm = undefined;
	});

	it("merges glm(live) + openrouter + claude in registry order, no _errors", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl, { orKey: "or-test" });
		const { data, _errors } = await collectModels(config);
		const ids = data.map((m) => m.id);
		// glm entries first, then openrouter allowlist, then claude static
		assert.equal(ids[0], "glm-5");
		assert.equal(ids[1], "glm-5.2");
		assert.ok(ids.includes("deepseek/deepseek-v4-pro"));
		assert.ok(ids.includes("claude-fable-5"));
		assert.equal(ids.indexOf("deepseek/deepseek-v4-pro") < ids.indexOf("claude-fable-5"), true);
		// pinned display_name comes from the curated map (not an in-thunk derivation)
		assert.equal(
			data.find((m) => m.id === "deepseek/deepseek-v4-pro").display_name,
			"DeepSeek V4 Pro",
		);
		// full count: 2 glm + 6 openrouter + 3 claude, no drops
		assert.equal(data.length, 11);
		assert.deepEqual(_errors, []);
	});

	it("GLM leg sends injected key + anthropic-version, never inbound auth", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl);
		await collectModels(config);
		const h = glm.calls[0].headers;
		assert.equal(h["x-api-key"], "glm-test");
		assert.equal(h["anthropic-version"], "2023-06-01");
		assert.equal(h.authorization, undefined);
		assert.match(glm.calls[0].url, /\/v1\/models$/);
	});

	it("GLM 502 → _errors HTTP 502, other legs survive", async () => {
		glm = await startBackend(() => ({ status: 502, headers: {}, body: "bad" }));
		const config = wireConfig(glm.baseUrl, { orKey: "or-test" });
		const { data, _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "glm", message: "HTTP 502" }]);
		assert.ok(data.some((m) => m.id === "claude-fable-5"));
		assert.ok(!data.some((m) => m.id.startsWith("glm-")));
	});

	it("GLM timeout → _errors timeout, fast (bounded by modelsTimeoutMs)", async () => {
		// Handler returns a never-resolving promise, so server never sends a response.
		glm = await startBackend(() => new Promise(() => {}));
		const config = wireConfig(glm.baseUrl, { modelsTimeoutMs: 50 });
		const t0 = Date.now();
		const { _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "glm", message: "timeout" }]);
		assert.ok(Date.now() - t0 < 1000, "should abort near modelsTimeoutMs, not hang");
	});

	it("GLM connection refused → _errors fetch failed", async () => {
		// point at a closed port: start then immediately close a backend
		const dead = await startBackend(() => ({ status: 200, headers: {}, body: "" }));
		const base = dead.baseUrl;
		await close(dead.server);
		const config = wireConfig(base, { modelsTimeoutMs: 500 });
		const { _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "glm", message: "fetch failed" }]);
	});

	it("GLM unparseable / no data → _errors invalid response shape", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: "{}",
		}));
		const config = wireConfig(glm.baseUrl);
		const { _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "glm", message: "invalid response shape" }]);
	});

	it("GLM entry coercion: drops no-id, nulls numeric created, defaults display_name", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: [{}, { id: "x", created: 1700000000 }, { id: "" }] }),
		}));
		const config = wireConfig(glm.baseUrl);
		const { data } = await collectModels(config);
		const glmEntries = data.filter((m) => m.id === "x");
		assert.equal(glmEntries.length, 1);
		assert.deepEqual(glmEntries[0], {
			type: "model",
			id: "x",
			display_name: "x",
			created_at: null,
		});
		assert.ok(!data.some((m) => m.id === ""));
	});

	it("GLM not configured (no key) → GLM absent, not an error", async () => {
		const config = wireConfig("http://127.0.0.1:59999", { glmKey: "" }); // never dialed (GLM leg skipped)
		const { data, _errors } = await collectModels(config);
		assert.ok(!data.some((m) => m.id.startsWith("glm-")));
		assert.ok(!_errors.some((e) => e.provider === "glm"));
		assert.ok(data.some((m) => m.id === "claude-fable-5"));
	});

	it("OpenRouter not configured → no openrouter entries even if list set", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl); // no orKey
		const { data } = await collectModels(config);
		assert.ok(!data.some((m) => m.id.includes("/")));
	});

	const DEEPSEEK_MODELS_BODY = JSON.stringify({
		object: "list",
		data: [
			{ id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
			{ id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
		],
	});

	// GUARDRAIL: in production the deepseek provider's baseUrl is the Anthropic skin
	// (`https://api.deepseek.com/anthropic`), but the /models endpoint is OpenAI-native
	// and sits on the api.deepseek.com ROOT (Bearer auth, not x-api-key).
	// fetchDeepSeekModels derives the root by stripping a trailing `/anthropic`. The other
	// DeepSeek tests point the provider at a bare stub root (no /anthropic suffix) so the
	// strip is a no-op there — meaning a regression to that regex or the baseUrl constant
	// (e.g. requesting /anthropic/models) would pass the whole suite while breaking the
	// live /models fetch. This test pins the production path: a /anthropic-suffixed
	// baseUrl must be stripped to the root before GET /models.
	it("DeepSeek /anthropic baseUrl is stripped to the root before GET /models", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: DEEPSEEK_MODELS_BODY,
		}));
		const config = wireConfig(`${glm.baseUrl}/anthropic`, {
			glmKey: "",
			dsKey: "ds-test",
		});
		await collectModels(config);
		// The fetch must hit "<root>/models" — if the /anthropic suffix survived, the
		// request URL would be "/anthropic/models" and the live endpoint would 404.
		assert.match(
			glm.calls[0].url,
			/^\/models$/,
			"fetchDeepSeekModels must strip a trailing /anthropic from the skin baseUrl before GET /models",
		);
	});

	it("DeepSeek leg: live /models (OpenAI shape) merges in registry order, no _errors", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: DEEPSEEK_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl, { glmKey: "", dsKey: "ds-test" });
		const { data, _errors } = await collectModels(config);
		const ids = data.map((m) => m.id);
		// deepseek entries appear before claude (registry order), display_name = id.
		assert.ok(ids.includes("deepseek-v4-pro"));
		assert.ok(ids.includes("deepseek-v4-flash"));
		assert.equal(data.find((m) => m.id === "deepseek-v4-pro").display_name, "deepseek-v4-pro");
		assert.equal(
			ids.indexOf("deepseek-v4-pro") < ids.indexOf("claude-fable-5"),
			true,
			"deepseek before claude",
		);
		assert.deepEqual(_errors, []);
	});

	it("DeepSeek leg sends Bearer key, never inbound auth or x-api-key", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: DEEPSEEK_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl, { glmKey: "", dsKey: "ds-test" });
		await collectModels(config);
		const h = glm.calls[0].headers;
		assert.equal(h.authorization, "Bearer ds-test");
		assert.equal(h["x-api-key"], undefined, "DeepSeek /models uses Bearer, not x-api-key");
		assert.match(glm.calls[0].url, /\/models$/);
	});

	it("DeepSeek not configured (no key) → no deepseek entries, not an error", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl); // no dsKey
		const { data, _errors } = await collectModels(config);
		assert.ok(!data.some((m) => m.id.startsWith("deepseek-")));
		assert.ok(!_errors.some((e) => e.provider === "deepseek"));
	});

	it("DeepSeek 502 → _errors HTTP 502, other legs survive", async () => {
		glm = await startBackend(() => ({ status: 502, headers: {}, body: "bad" }));
		const config = wireConfig(glm.baseUrl, { glmKey: "", dsKey: "ds-test" });
		const { data, _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "deepseek", message: "HTTP 502" }]);
		assert.ok(data.some((m) => m.id === "claude-fable-5"));
		assert.ok(!data.some((m) => m.id.startsWith("deepseek-")));
	});

	it("DeepSeek unparseable / no data → _errors invalid response shape", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: "{}",
		}));
		const config = wireConfig(glm.baseUrl, { glmKey: "", dsKey: "ds-test" });
		const { _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "deepseek", message: "invalid response shape" }]);
	});

	it("DeepSeek timeout → _errors timeout, fast (bounded by modelsTimeoutMs)", async () => {
		// Handler never resolves, so the abort timer is the only thing that can end this.
		glm = await startBackend(() => new Promise(() => {}));
		const config = wireConfig(glm.baseUrl, {
			glmKey: "",
			dsKey: "ds-test",
			modelsTimeoutMs: 50,
		});
		const t0 = Date.now();
		const { _errors } = await collectModels(config);
		assert.deepEqual(_errors, [{ provider: "deepseek", message: "timeout" }]);
		assert.ok(Date.now() - t0 < 1000, "should abort near modelsTimeoutMs, not hang");
	});

	it("Qwen leg: static curated list merges in registry order (no live fetch), no _errors", async () => {
		// No GLM backend is started — Qwen is static, so no live leg should dial out.
		// Point glm at a dead port to prove the qwen leg never depends on it.
		const config = wireConfig("http://127.0.0.1:59999", {
			glmKey: "",
			qwenKey: "qwen-test",
		});
		const { data, _errors } = await collectModels(config);
		const ids = data.map((m) => m.id);
		// qwen entries appear before claude (registry order), curated display_name.
		assert.ok(ids.includes("qwen3.7-max"));
		assert.ok(ids.includes("qwen3.6-flash"));
		assert.equal(data.find((m) => m.id === "qwen3.7-max").display_name, "Qwen3.7 Max");
		assert.equal(
			ids.indexOf("qwen3.7-max") < ids.indexOf("claude-fable-5"),
			true,
			"qwen before claude",
		);
		assert.deepEqual(_errors, []);
	});

	it("Qwen not configured (no key) → no qwen entries, not an error", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY,
		}));
		const config = wireConfig(glm.baseUrl); // no qwenKey
		const { data, _errors } = await collectModels(config);
		assert.ok(!data.some((m) => m.id.startsWith("qwen")));
		assert.ok(!_errors.some((e) => e.provider === "qwen"));
	});

	it("dedup: glm and claude both claim an id → first (glm) wins, single entry", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				data: [
					{
						id: "dupe",
						display_name: "GLM Dupe",
						type: "model",
						created_at: "2026-01-01T00:00:00Z",
					},
				],
			}),
		}));
		const config = wireConfig(glm.baseUrl, {
			claudeModels: [{ type: "model", id: "dupe", display_name: "Claude Dupe", created_at: null }],
		});
		const { data } = await collectModels(config);
		const dupes = data.filter((m) => m.id === "dupe");
		assert.equal(dupes.length, 1);
		assert.equal(dupes[0].display_name, "GLM Dupe");
	});

	it("modelsForceThrow makes collectModels reject (process-safety seam)", async () => {
		// unused high port; the throw fires before any fetch so it's never dialed
		const config = wireConfig("http://127.0.0.1:59999", { modelsForceThrow: true });
		await assert.rejects(() => collectModels(config), /forced throw/);
	});
});

/** GET a path on the proxy, resolving { status, headers, body } (+ optional inbound headers). */
function getReq(port, path, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: "127.0.0.1", port, path, method: "GET", headers: extraHeaders },
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
		req.end();
	});
}

function reqOn(port, path, method) {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode }));
		});
		req.on("error", reject);
		req.end();
	});
}

function startProxy(config) {
	const server = createServer(config);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});
}

describe("GET /v1/models endpoint", () => {
	let glm;
	let claude;
	let proxy;
	afterEach(async () => {
		await close(proxy?.server, glm?.server, claude?.server);
		glm = claude = proxy = undefined;
	});

	async function up(opts = {}) {
		glm = await startBackend(
			opts.glmHandler ??
				(() => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: GLM_MODELS_BODY,
				})),
		);
		// A claude stub stands in for api.anthropic.com so any *forwarded* request
		// (the /v1/models/<id> retrieve path routes to the default backend = claude)
		// stays local. Records its calls for the passthrough assertion.
		claude = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "m", type: "model" }),
		}));
		const config = wireConfig(glm.baseUrl, { ...opts.configOpts, claudeBaseUrl: claude.baseUrl });
		proxy = await startProxy(config);
		return config;
	}

	it("returns 200 JSON envelope with snake_case fields, rebuilt from data (not upstream envelope)", async () => {
		// upstream envelope deliberately LIES: its lastId="zzz-not-in-data" disagrees
		// with the actual data tail. The proxy must ignore the upstream envelope and
		// compute last_id from data — proving the envelope is rebuilt, not forwarded.
		await up({
			glmHandler: () => ({
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					data: [
						{
							id: "glm-5",
							display_name: "GLM-5",
							type: "model",
							created_at: "2026-02-11T00:00:00Z",
						},
					],
					firstId: "aaa-not-in-data",
					hasMore: true,
					lastId: "zzz-not-in-data",
				}),
			}),
			configOpts: { orKey: "or-test" },
		});
		const res = await getReq(proxy.port, "/v1/models");
		assert.equal(res.status, 200);
		assert.match(res.headers["content-type"], /application\/json/);
		const body = JSON.parse(res.body);
		assert.equal(body.has_more, false); // ours, not upstream's `true`
		assert.equal(body.first_id, body.data[0].id);
		assert.equal(body.last_id, body.data[body.data.length - 1].id);
		assert.equal(body.last_id, "claude-sonnet-5"); // last static claude id, NOT upstream's "zzz-not-in-data"
		assert.equal(body._errors, undefined); // absent on full success
		assert.ok(!("firstId" in body) && !("lastId" in body)); // upstream camelCase envelope discarded
	});

	it("does not leak inbound credentials to the GLM upstream", async () => {
		await up();
		await getReq(proxy.port, "/v1/models", { authorization: "Bearer leak", "x-api-key": "leak" });
		const h = glm.calls[0].headers;
		assert.equal(h["x-api-key"], "glm-test");
		assert.equal(h.authorization, undefined);
	});

	it("surfaces _errors on a failed leg but still 200", async () => {
		await up({ glmHandler: () => ({ status: 502, headers: {}, body: "x" }) });
		const res = await getReq(proxy.port, "/v1/models");
		assert.equal(res.status, 200);
		const body = JSON.parse(res.body);
		assert.deepEqual(body._errors, [{ provider: "glm", message: "HTTP 502" }]);
	});

	it("matches with a query string", async () => {
		await up();
		const res = await getReq(proxy.port, "/v1/models?foo=bar");
		assert.equal(res.status, 200);
		assert.ok(JSON.parse(res.body).data.length > 0);
	});

	it("non-GET on /v1/models is 405 (not forwarded) — POST, PUT, DELETE", async () => {
		await up();
		for (const method of ["POST", "PUT", "DELETE"]) {
			const res = await reqOn(proxy.port, "/v1/models", method);
			assert.equal(res.status, 405, `${method} should 405`);
		}
	});

	it("GET /v1/models/<id> is NOT intercepted (forwarded to default backend)", async () => {
		await up();
		// /v1/models/<id> has no exact-path match → falls through to handleProxy →
		// empty GET body → resolve(undefined) → default backend (claude stub). Assert
		// the claude stub actually received the forwarded request (proves passthrough,
		// not a synthesized envelope).
		const res = await getReq(proxy.port, "/v1/models/glm-5.2");
		assert.equal(claude.calls.length, 1);
		assert.match(claude.calls[0].url, /^\/v1\/models\/glm-5\.2/);
		assert.ok(
			!("has_more" in JSON.parse(res.body || "{}")),
			"retrieve path must not be synthesized",
		);
	});

	it("empty union: glm fails and static lists empty → empty data + null ids", async () => {
		await up({
			glmHandler: () => ({ status: 502, headers: {}, body: "x" }),
			configOpts: { claudeModels: [], openRouterModels: [] },
		});
		const res = await getReq(proxy.port, "/v1/models");
		const body = JSON.parse(res.body);
		assert.deepEqual(body.data, []);
		assert.equal(body.first_id, null);
		assert.equal(body.last_id, null);
		assert.deepEqual(body._errors, [{ provider: "glm", message: "HTTP 502" }]);
	});

	it("process-safety: a collectModels throw yields 200 + _errors, proxy stays up", async () => {
		await up({ configOpts: { modelsForceThrow: true } });
		const res = await getReq(proxy.port, "/v1/models");
		assert.equal(res.status, 200);
		const body = JSON.parse(res.body);
		assert.deepEqual(body._errors, [{ provider: "proxy", message: "internal error" }]);
		// proxy still serving:
		const status = await getReq(proxy.port, "/_status");
		assert.equal(status.status, 200);
	});
});
