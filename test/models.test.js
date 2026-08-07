import { strict as assert } from "node:assert";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import {
	CONTEXT_WINDOW,
	DEEPSEEK_PRICING,
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
	coerceCreated,
	collectModels,
	parseOpenRouterModels,
	withContextWindow,
} from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { resolve as resolve2 } from "../src/router.js";
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

	it("DEFAULT_QWEN_MODELS is the offline fallback for the live plan catalog", () => {
		// No longer the primary source: fetchQwenModels() pulls
		// /compatible-mode/v1/models live (the Anthropic-skin path 404s, which is
		// why this was hand-curated for so long). This list is what discovery falls
		// back to when that fetch fails, so it mirrors the 2026-08-06 live response.
		assert.deepEqual(
			DEFAULT_QWEN_MODELS.map((m) => m.id),
			[
				"qwen3.8-max",
				"qwen3.7-max",
				"qwen3.7-plus",
				"qwen3.6-flash",
				// Not qwen-branded: DeepSeek builds and a GLM the plan also serves.
				// Discovery publishes these under the `qwen:` lens because the plan
				// does not own those namespaces — listing them here says only "the
				// plan serves this", which is exactly what a catalog is for.
				"deepseek-v4-flash-0731",
				"deepseek-v4-pro",
				"glm-5.2",
				// qwen3.8-max-preview is deliberately ABSENT: a pure alias onto
				// qwen3.8-max (same weights, production billing), so publishing it
				// would be a second name for a model already listed. Still callable.
			],
		);
		assert.equal(
			DEFAULT_QWEN_MODELS.some((m) => m.id === "qwen3.8-max-preview"),
			false,
			"an alias must not be published as its own model",
		);
		for (const m of DEFAULT_QWEN_MODELS) {
			assert.equal(m.type, "model");
			assert.equal(m.created_at, null);
			assert.ok(m.display_name.length > 0);
		}
		// The invariant is that every advertised id is REACHABLE on the plan — via
		// the `qwen:` lens, which is what discovery publishes for the foreign ones.
		// NOT that the bare id routes there: `glm-5.2` bare goes to Z.ai (a native
		// plan outranks a resold one) and `deepseek-v4-pro` bare goes to the plan
		// (prepaid beats DeepSeek's metered credits). Both are correct, and both
		// are the ROUTER's business, not the catalog's — which is exactly why the
		// lens exists.
		const providers = buildProviders(
			{ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" },
			"claude",
		);
		for (const m of DEFAULT_QWEN_MODELS) {
			const r = resolve2(`qwen:${m.id}`, { providers });
			assert.equal(r.provider.id, "qwen", `qwen:${m.id} must reach the plan`);
			assert.equal(r.upstreamModel, m.id, "the lens must be stripped before forwarding");
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

	it("coerceCreated passes strings through and converts unix timestamps", () => {
		assert.equal(coerceCreated("2026-07-28T00:00:00Z"), "2026-07-28T00:00:00Z");
		// Unix SECONDS (what OpenRouter sends) — converted, not dropped. Dropping
		// nulled the date on 372 of 396 published entries, which is why the page
		// could not sort by newest. Magnitude picks the unit: <1e12 is seconds.
		assert.equal(coerceCreated(1700000000), "2023-11-14T22:13:20.000Z");
		// Unix MILLISECONDS pass through as ms rather than being multiplied into
		// the year 55000.
		assert.equal(coerceCreated(1700000000000), "2023-11-14T22:13:20.000Z");
		// Junk still nulls rather than emitting "Invalid Date".
		assert.equal(coerceCreated(undefined), null);
		assert.equal(coerceCreated(null), null);
		assert.equal(coerceCreated(0), null);
		assert.equal(coerceCreated(-5), null);
		assert.equal(coerceCreated(Number.NaN), null);
		assert.equal(coerceCreated(Number.POSITIVE_INFINITY), null);
		assert.equal(coerceCreated(1e18), null, "out-of-range ms must not emit Invalid Date");
		// The string branch is VALIDATED, not trusted (Copilot review, PR #18):
		// the field promises ISO-8601, so a vendor sending prose must not put it
		// on the wire.
		assert.equal(coerceCreated("junk"), null, "an unparseable string must null");
		assert.equal(coerceCreated("n/a"), null);
		assert.equal(coerceCreated(""), null);
		// A parseable string passes through VERBATIM — no round-trip through
		// Date, which would rewrite the vendor's offset and drop precision.
		assert.equal(coerceCreated("2026-07-28T12:34:56.789+02:00"), "2026-07-28T12:34:56.789+02:00");
	});

	it("CONTEXT_WINDOW holds integer token counts, never display strings", () => {
		assert.equal(CONTEXT_WINDOW["glm-4.5"], 128000);
		assert.equal(CONTEXT_WINDOW["glm-5.2"], 1000000);
		assert.equal(CONTEXT_WINDOW["deepseek-v4-pro"], 1000000);
		assert.equal(CONTEXT_WINDOW["qwen3.7-max"], 1000000);
		for (const v of Object.values(CONTEXT_WINDOW)) {
			assert.equal(
				typeof v,
				"number",
				"CONTEXT_WINDOW values must be integers, not '128K'-style strings",
			);
			assert.ok(Number.isInteger(v) && v > 0);
		}
	});

	it("withContextWindow attaches context_window for a covered id", () => {
		const entry = { type: "model", id: "glm-4.5", display_name: "GLM-4.5", created_at: null };
		assert.deepEqual(withContextWindow(entry), { ...entry, context_window: 128000 });
	});

	it("withContextWindow omits context_window (never null) for an uncovered id", () => {
		const entry = {
			type: "model",
			id: "deepseek/deepseek-v4-pro",
			display_name: "DeepSeek V4 Pro",
			created_at: null,
		};
		const out = withContextWindow(entry);
		assert.deepEqual(out, entry);
		assert.ok(!("context_window" in out), "uncovered id must omit the field, not emit null");
	});

	// GUARDRAIL: CONTEXT_WINDOW is an object literal, so a bare
	// `CONTEXT_WINDOW[id]` lookup inherits from Object.prototype. Model ids come
	// from live vendor catalogs (GLM/DeepSeek `/models`) and coerceEntry only
	// rejects a falsy id, so the key space is theirs. Pre-fix, an id of
	// `__proto__` shipped `"context_window": {}` on the wire, and
	// `constructor`/`toString` attached a FUNCTION — dropped by JSON.stringify
	// but present in the object collectModels() hands back in-process. A
	// consumer following the documented contract (`"context_window" in entry`
	// → a token count) then budgets against an object.
	it("withContextWindow omits for prototype-inherited ids (__proto__, constructor, toString)", () => {
		for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
			const entry = { type: "model", id, display_name: "hostile", created_at: null };
			const out = withContextWindow(entry);
			assert.ok(
				!("context_window" in out),
				`${id}: prototype member leaked as a context_window (${JSON.stringify(out.context_window)})`,
			);
			assert.deepEqual(out, entry);
		}
	});

	it("withContextWindow omits for the curated claude-* ids too", () => {
		for (const m of DEFAULT_CLAUDE_MODELS) {
			assert.ok(!("context_window" in withContextWindow(m)), `${m.id} must omit context_window`);
		}
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
		openRouterBaseUrl,
		qwenBaseUrl,
		openRouterModelsExplicit = true,
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
	// OpenRouter's leg fetches a LIVE catalog in production. Tests must never
	// reach the network, so the default here is the explicit-set path (static
	// list, no fetch). Pass openRouterModelsExplicit:false + openRouterBaseUrl to
	// exercise the fetch against a local stub.
	const or = providers.find((p) => p.id === "openrouter");
	if (or && openRouterBaseUrl) or.baseUrl = openRouterBaseUrl;
	// Qwen fetches from the compatible-mode path, derived by stripping the
	// /apps/anthropic suffix — so point the provider at `${stub}/apps/anthropic`
	// and fetchQwenModels() GETs ${stub}/compatible-mode/v1/models.
	const qw = providers.find((p) => p.id === "qwen");
	if (qw && qwenBaseUrl) qw.baseUrl = `${qwenBaseUrl}/apps/anthropic`;
	return {
		providers,
		claudeModels: claudeModels ?? DEFAULT_CLAUDE_MODELS,
		qwenModels: qwenModels ?? DEFAULT_QWEN_MODELS,
		openRouterModels: openRouterModels ?? DEFAULT_OPENROUTER_MODELS,
		openRouterModelsExplicit,
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

	it("GLM entry coercion: drops no-id, converts numeric created, defaults display_name", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: [{}, { id: "x", created: 1700000000 }, { id: "" }] }),
		}));
		const config = wireConfig(glm.baseUrl);
		const { data } = await collectModels(config);
		// Published as `glm:x`, not `x`: the id is not in glm's namespace, so the
		// lens is what says which backend serves it. (A vendor's real ids are
		// `glm-*` and render bare — this stub id is deliberately foreign.)
		const glmEntries = data.filter((m) => m.id === "glm:x");
		assert.equal(glmEntries.length, 1);
		assert.deepEqual(glmEntries[0], {
			type: "model",
			id: "glm:x",
			display_name: "x",
			// Unix seconds from the backend, converted to ISO — see coerceCreated.
			created_at: "2023-11-14T22:13:20.000Z",
			// Route metadata, attached to every entry: which backend won it, what
			// that route costs (tier 2 = plan), and how strong the model is. An
			// uncurated id grades Specialist by default — a shape, not a rung.
			provider: "glm",
			tier: 2,
			grade: "Specialist",
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

	it("same id from two backends: each publishes under its own lens, none dropped", async () => {
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
		// Namespace ownership makes a same-id clash impossible rather than resolving
		// it: `dupe` belongs to neither vendor, so each backend publishes it under
		// its own lens and both stay reachable. (Before this rule the second leg's
		// entry was silently dropped, which lost a route the user could reach.)
		assert.deepEqual(
			data.filter((m) => m.id.endsWith("dupe")).map((m) => [m.id, m.provider]),
			[
				["glm:dupe", "glm"],
				["claude:dupe", "claude"],
			],
		);
		assert.equal(data.find((m) => m.id === "glm:dupe").display_name, "GLM Dupe");
		// The bare spelling is nobody's: it would claim an ownership no backend has.
		assert.equal(
			data.some((m) => m.id === "dupe"),
			false,
		);
	});

	it("collectModels attaches context_window to a covered id, omits it for an uncovered one", async () => {
		glm = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: GLM_MODELS_BODY, // glm-5, glm-5.2 — both covered
		}));
		const config = wireConfig(glm.baseUrl, { orKey: "or-test" }); // openrouter: uncovered
		const { data } = await collectModels(config);
		const glm5 = data.find((m) => m.id === "glm-5");
		assert.equal(glm5.context_window, 200000);
		const glm52 = data.find((m) => m.id === "glm-5.2");
		assert.equal(glm52.context_window, 1000000);
		const orEntry = data.find((m) => m.id === "deepseek/deepseek-v4-pro");
		assert.ok(orEntry, "openrouter entry should be present");
		assert.ok(!("context_window" in orEntry), "uncovered openrouter id must omit context_window");
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

	it("wire entries carry integer context_window for covered ids, omit it for uncovered ones", async () => {
		await up({ configOpts: { orKey: "or-test" } });
		const res = await getReq(proxy.port, "/v1/models");
		const body = JSON.parse(res.body);
		const glm5 = body.data.find((m) => m.id === "glm-5");
		assert.equal(glm5.context_window, 200000);
		const claudeEntry = body.data.find((m) => m.id === "claude-fable-5");
		assert.ok(!("context_window" in claudeEntry), "claude-* ids must omit context_window");
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

describe("live catalog legs (qwen + openrouter)", () => {
	let stub;
	afterEach(async () => {
		await close(stub?.server);
		stub = undefined;
	});

	it("qwen fetches the COMPATIBLE-MODE path, not the anthropic skin", async () => {
		// The skin path 404s ("Not support") while /compatible-mode/v1/models 200s
		// with 11 ids. Probing only the skin is what produced years of hand
		// curation and a stale "Qwen exposes no /models endpoint" comment.
		stub = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: [{ id: "qwen3.8-max" }, { id: "glm-5.2" }] }),
		}));
		const config = wireConfig("http://127.0.0.1:1", { qwenKey: "q", qwenBaseUrl: stub.baseUrl });
		const { data } = await collectModels(config);
		assert.equal(stub.calls[0].url, "/compatible-mode/v1/models");
		assert.equal(stub.calls[0].headers.authorization, "Bearer q");
		const ids = data.filter((m) => m.provider === "qwen").map((m) => m.id);
		// glm-5.2 is foreign to the plan's namespace → published under the lens.
		assert.deepEqual(ids, ["qwen3.8-max", "qwen:glm-5.2"]);
	});

	it("qwen flags multimodal ids as not chat-usable rather than hiding them", async () => {
		// They resolve on /v1/messages and then fail on BODY SHAPE, so dropping
		// them would misreport the plan while listing them silently is a trap.
		stub = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				data: [
					{ id: "qwen3.8-max" },
					{ id: "wan2.7-image" },
					{ id: "qwen-audio-3.0-tts-plus" },
					{ id: "qwen-audio-3.0-realtime-plus" },
				],
			}),
		}));
		const config = wireConfig("http://127.0.0.1:1", { qwenKey: "q", qwenBaseUrl: stub.baseUrl });
		const { data } = await collectModels(config);
		const flag = (id) => data.find((m) => m.id === id)?.usable;
		assert.equal(flag("qwen3.8-max"), undefined, "a usable model carries no flag");
		assert.equal(flag("qwen:wan2.7-image"), false);
		assert.equal(flag("qwen-audio-3.0-tts-plus"), false);
		assert.equal(flag("qwen-audio-3.0-realtime-plus"), false);
	});

	it("qwen falls back to the static list when the fetch fails", async () => {
		// A flaky network must degrade to the previous behaviour, not an empty leg.
		const config = wireConfig("http://127.0.0.1:1", {
			qwenKey: "q",
			qwenBaseUrl: "http://127.0.0.1:1",
			modelsTimeoutMs: 300,
		});
		const { data, _errors } = await collectModels(config);
		assert.ok(
			data.some((m) => m.id === "qwen3.8-max"),
			"static fallback supplies the plan's models",
		);
		// The qwen leg still DELIVERED, so it must not report an error — a fallback
		// is a successful degradation, not a failure. (The glm leg does error here:
		// this config points it at a dead port too, which is incidental.)
		assert.equal(
			_errors.some((e) => e.provider === "qwen"),
			false,
			"a fallback is not an error — the leg still delivered",
		);
	});

	it("openrouter takes the vendor's context_length and drops anthropic/* copies", async () => {
		// context_length is the aggregator's OWN per-deployment number, which is
		// exactly what CONTEXT_WINDOW refuses to guess for a vendor/model id.
		// anthropic/* is dropped, not flagged: it would bill per token for what the
		// session's OAuth plan already covers, and would sit in /model looking like
		// the obvious pick (invariants 3 and 4 keep Claude traffic on the Claude route).
		stub = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				data: [
					{ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", context_length: 1048576 },
					{ id: "anthropic/claude-opus-5", name: "Anthropic: Opus 5", context_length: 200000 },
					{ id: "google/gemini-3.6-flash:batch", name: "Batch", context_length: 100 },
					{ id: "vendor/bad-window", name: "Bad", context_length: "lots" },
				],
			}),
		}));
		const config = wireConfig("http://127.0.0.1:1", {
			orKey: "o",
			openRouterModelsExplicit: false,
			openRouterBaseUrl: stub.baseUrl,
		});
		const { data } = await collectModels(config);
		const or = data.filter((m) => m.provider === "openrouter");
		assert.equal(or.find((m) => m.id === "moonshotai/kimi-k3").context_window, 1048576);
		assert.equal(or.find((m) => m.id === "moonshotai/kimi-k3").display_name, "MoonshotAI: Kimi K3");
		assert.equal(
			or.some((m) => m.id.startsWith("anthropic/")),
			false,
			"a reseller's Claude copy must never be advertised",
		);
		assert.equal(or.find((m) => m.id === "google/gemini-3.6-flash:batch").usable, false);
		assert.ok(
			!("context_window" in or.find((m) => m.id === "vendor/bad-window")),
			"a malformed window must be omitted, never published as a string or NaN",
		);
	});

	it("an explicit OPENROUTER_MODELS set suppresses the live fetch entirely", async () => {
		// The user named a specific set; the vendor's full catalog is not wanted.
		stub = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: [{ id: "should/never-appear" }] }),
		}));
		const config = wireConfig("http://127.0.0.1:1", {
			orKey: "o",
			openRouterBaseUrl: stub.baseUrl,
			openRouterModels: [
				{ type: "model", id: "only/this", display_name: "only", created_at: null },
			],
		});
		const { data } = await collectModels(config);
		assert.equal(stub.calls.length, 0, "no fetch when the set is explicit");
		assert.deepEqual(
			data.filter((m) => m.provider === "openrouter").map((m) => m.id),
			["only/this"],
		);
	});
});
