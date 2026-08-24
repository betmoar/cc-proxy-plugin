import { strict as assert } from "node:assert";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
	CONTEXT_WINDOW,
	DEEPSEEK_PRICING,
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
	coerceCreated,
	collectModels,
	dedupByIdentity,
	identityOf,
	parseOpenRouterModels,
	withContextWindow,
} from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { resolve as resolve2 } from "../src/router.js";
import { createServer } from "../src/server.js";

const execFile = promisify(execFileCb);

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
		// plan outranks a resold one) and, since issue #19, `deepseek-v4-pro` bare
		// goes to native DeepSeek when a DeepSeek key is registered (as it is
		// below) — the plan is only the bare id's fallback when no native key
		// exists. Both are correct, and both are the ROUTER's business, not the
		// catalog's — which is exactly why the lens exists.
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

describe("identityOf / dedupByIdentity (issue #39)", () => {
	// The trap the issue's own first draft fell into. Splitting on the LAST
	// separator merges every `:batch` variant into one identity named "batch",
	// spanning seven vendors — 48 ids on the live catalogue. Assert the two
	// separators are NOT interchangeable.
	it("splits on the FIRST separator, so an OpenRouter variant stays attached", () => {
		assert.equal(identityOf("google/gemini-3.7-flash:batch"), "gemini-3.7-flash:batch");
		assert.equal(identityOf("z-ai/glm-5.2:batch"), "glm-5.2:batch");
		assert.notEqual(
			identityOf("google/gemini-3.7-flash:batch"),
			identityOf("z-ai/glm-5.2:batch"),
			"two vendors' :batch variants must not collapse into one identity",
		);
		// The SLASH half of the same claim, and it needs an id carrying two of them
		// — with only single-slash ids in the suite, indexOf and lastIndexOf agree
		// and a regression to last-separator splitting passes unnoticed (measured:
		// swapping to lastIndexOf left every other test in this file green).
		assert.equal(identityOf("vendor/family/model-1"), "family/model-1");
	});

	it("strips a known provider lens but leaves an unknown prefix whole", () => {
		assert.equal(identityOf("qwen:deepseek-v4-pro"), "deepseek-v4-pro");
		// A future vendor id containing a colon must survive intact — same guard
		// parseModelSelector uses.
		assert.equal(identityOf("bogus:thing"), "bogus:thing");
	});

	it("collapses the three deepseek-v4-pro spellings onto the LOWEST tier", () => {
		const data = [
			{ id: "deepseek-v4-pro", tier: 3 },
			{ id: "qwen:deepseek-v4-pro", tier: 2 },
			{ id: "deepseek/deepseek-v4-pro", tier: 4 },
			{ id: "glm-5.3", tier: 2 },
		];
		const out = dedupByIdentity(data);
		assert.deepEqual(
			out.map((m) => m.id),
			["qwen:deepseek-v4-pro", "glm-5.3"],
		);
	});

	it("prefers a usable entry over a cheaper unusable one", () => {
		// Cost must not outrank reachability: a `usable: false` entry cannot
		// complete a turn, so it is no substitute however cheap its route is.
		const out = dedupByIdentity([
			{ id: "qwen:thing", tier: 2, usable: false },
			{ id: "thing", tier: 4 },
		]);
		assert.deepEqual(
			out.map((m) => m.id),
			["thing"],
		);
	});

	it("an entry with no tier does not win by virtue of the missing field", () => {
		const out = dedupByIdentity([
			{ id: "vendor/thing" },
			{ id: "thing", tier: 3 },
			{ id: "other", tier: 1 },
		]);
		assert.deepEqual(
			out.map((m) => m.id),
			["thing", "other"],
		);
	});

	it("at equal tier the FIRST entry wins (the documented tie-break)", () => {
		// `beats()` uses a strict `<` so a tie leaves the incumbent in place. With
		// every other case in this block using distinct tiers, relaxing that to
		// `<=` — which silently reverses the rule to last-seen — passed all 62
		// tests in this file (measured). Two entries at the same tier is the only
		// shape that separates the two.
		const out = dedupByIdentity([
			{ id: "glm-5.2", tier: 2 },
			{ id: "qwen:glm-5.2", tier: 2 },
		]);
		assert.deepEqual(
			out.map((m) => m.id),
			["glm-5.2"],
			"a tie must not hand the rung to the later entry",
		);
	});

	it("winners keep the original array order (provider grouping survives)", () => {
		const out = dedupByIdentity([
			{ id: "glm-5.3", tier: 2 },
			{ id: "deepseek-v4-pro", tier: 3 },
			{ id: "z-ai/glm-5.3", tier: 4 },
			{ id: "claude-opus-5", tier: 1 },
		]);
		assert.deepEqual(
			out.map((m) => m.id),
			["glm-5.3", "deepseek-v4-pro", "claude-opus-5"],
		);
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
	// The media tunnel is the SAME host at its root — rebase it the same way, so a
	// test asserts the real concatenation (stub root + inbound path) rather than a
	// hand-built URL. Deliberately not `${qwenBaseUrl}/apps/anthropic`: the missing
	// suffix is precisely what the tunnel exists for.
	if (qw && qwenBaseUrl) qw.mediaBaseUrl = qwenBaseUrl;
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

	// This id ("x") is in neither MODEL_GRADES nor (given the throwaway HOME) the
	// refresh, so it must carry NO `grade` key at all — the 0.6.1 contract that
	// replaced the `Specialist` default. A hostile ~/.claude/cc-proxy/grades.json
	// naming `x` would add one (src/models.js loads that file ONCE at module
	// import), which is what the isolation below is for. Run in a
	// SUBPROCESS with a throwaway HOME — an in-process env.HOME swap can't
	// isolate this, the module cache already pinned whatever the first import
	// read. Same pattern as test/grades-refresh.test.js:18-45.
	it("GLM entry coercion: drops no-id, converts numeric created, defaults display_name", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-models-"));
		try {
			const script = new URL("./fixtures/glm-entry-coercion-subprocess.mjs", import.meta.url)
				.pathname;
			const { stdout } = await execFile(process.execPath, [script], {
				env: { ...process.env, HOME: home },
			});
			const { data, gradeKeys } = JSON.parse(stdout);
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
				// Route metadata, attached to every entry: which backend won it and
				// what that route costs (tier 2 = plan). NO `grade` — nobody has
				// assessed this id, and deepEqual is what pins the absence: an added
				// default, an "Ungraded" placeholder, or `grade: null` all fail here.
				provider: "glm",
				tier: 2,
			});
			// The absence is asserted from `gradeKeys`, NOT from the parsed entry.
			// JSON drops a key whose value is undefined, so `{grade: undefined}` and
			// no `grade` at all arrive here byte-identical — `!("grade" in parsed)`
			// tests what JSON.stringify did, not what withGrade() did. Measured
			// 2026-08-12: removing the omission guard (`return {...entry, grade}`)
			// left the entire suite green. `gradeKeys` is computed in the subprocess
			// that still holds the real objects, so it survives the wire.
			assert.ok(
				!gradeKeys.includes("glm:x"),
				"an unassessed id must omit grade — not carry it as undefined, which JSON hides",
			);
			assert.ok(!("grade" in glmEntries[0]), "and it must be absent on the wire too");
			assert.notEqual(glmEntries[0].grade, null, "and must never publish null");
			assert.ok(!data.some((m) => m.id === ""));
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
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

/** POST a body to the proxy, resolving { status, headers, body }. */
function postReq(port, path, body, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const payload = Buffer.from(body);
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": payload.length,
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
		req.end(payload);
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
		const config = wireConfig(glm.baseUrl, {
			// Point every live leg at the one stub. Without this a test passing
			// qwenKey would send the qwen leg at the REAL plan host — no test may
			// touch the network. The stub answers per path, so each leg can still
			// return its own catalog.
			qwenBaseUrl: glm.baseUrl,
			...opts.configOpts,
			claudeBaseUrl: claude.baseUrl,
		});
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

	it("?dedup=identity collapses duplicate ids; no parameter changes nothing", async () => {
		// glm + deepseek + qwen all registered and all pointed at one stub, which
		// answers per PATH so each leg publishes its own catalog — each fetcher uses
		// a different one (`/v1/models` glm, `/models` deepseek,
		// `/compatible-mode/v1/models` qwen). Only deepseek and the plan serve
		// deepseek-v4-pro, so it appears bare (native, tier 3) and as
		// `qwen:deepseek-v4-pro` (plan, tier 2) — the collision from issue #39.
		// `claudeModels: []` so the QWEN leg is last, and its last id is a loser
		// (`qwen:glm-5.2` ties glm-5.2 on tier and loses the tie to the earlier
		// entry). That is what makes `last_id` DISCRIMINATING below: with claude's
		// static list present, the final entry is a claude id that dedup never
		// touches, so a pre-dedup `last_id` reads identically and the assertion
		// proves nothing.
		const catalog = (ids) =>
			JSON.stringify({ data: ids.map((id) => ({ id, display_name: id, type: "model" })) });
		await up({
			glmHandler: (req) => {
				const ids = req.url.includes("compatible-mode")
					? ["qwen3.8-max", "deepseek-v4-pro", "glm-5.2"]
					: req.url.startsWith("/v1/models")
						? ["glm-5.3", "glm-5.2"]
						: ["deepseek-v4-pro"];
				return { status: 200, headers: { "content-type": "application/json" }, body: catalog(ids) };
			},
			configOpts: { dsKey: "ds-test", qwenKey: "qw-test", claudeModels: [] },
		});
		const plain = JSON.parse((await getReq(proxy.port, "/v1/models")).body);
		const deduped = JSON.parse((await getReq(proxy.port, "/v1/models?dedup=identity")).body);

		const ids = (b) => b.data.map((m) => m.id);
		const dsSpellings = ids(plain).filter((id) => identityOf(id) === "deepseek-v4-pro");
		assert.ok(dsSpellings.length > 1, `expected a collision to dedup, saw ${dsSpellings}`);
		assert.deepEqual(
			ids(deduped).filter((id) => identityOf(id) === "deepseek-v4-pro"),
			["qwen:deepseek-v4-pro"],
			"the tier-2 plan route must be the survivor",
		);
		assert.ok(deduped.data.length < plain.data.length);
		// The envelope is recomputed over the FILTERED list, not carried over —
		// asserted against LITERAL ids, not against deduped.data's own ends. The
		// self-referential form (`deduped.first_id === deduped.data[0].id`) is
		// tautological: computing the envelope from the PRE-dedup array leaves it
		// green, because both sides move together. Measured — that mutation passed
		// all 62 tests in this file.
		//
		// `last_id` is the discriminating half, and only because the fixture was
		// built for it: the plain list ENDS on `qwen:glm-5.2`, which dedup drops,
		// so reading the envelope off the pre-dedup array yields that id instead of
		// `qwen3.8-max`. `first_id` cannot discriminate at all — first-seen wins its
		// group, so the head entry survives every dedup by construction — and it is
		// pinned only to catch a wholesale reordering.
		assert.equal(deduped.first_id, "glm-5.3");
		assert.equal(deduped.last_id, "qwen:deepseek-v4-pro");
		assert.notEqual(
			deduped.last_id,
			plain.last_id,
			"the fixture must keep the two envelopes different, or this proves nothing",
		);
		assert.deepEqual(
			ids(deduped),
			["glm-5.3", "glm-5.2", "qwen3.8-max", "qwen:deepseek-v4-pro"],
			"the full deduped list, so a change to WHICH entry survives shows up here",
		);
		// Opt-in: the default response is untouched.
		assert.deepEqual(ids(JSON.parse((await getReq(proxy.port, "/v1/models")).body)), ids(plain));
	});

	it("a throw inside the handler is 500 and the proxy stays up (containment)", async () => {
		// handleModels is dispatched WITHOUT await and without a .catch, so a throw
		// anywhere in it is an unhandled rejection — which Node terminates the
		// process for, taking every session on the machine with it. Measured before
		// the outer try existed: exit code 1, no response written, and the comment
		// above the function credited a `.catch` that never existed.
		//
		// The poison goes on the ENTRY, not into dedupByIdentity, so this stays a
		// black-box test of the handler's containment: identityOf reads `.id`, and a
		// getter that throws is the cheapest stand-in for the careless future edit
		// the guard exists for.
		const config = await up();
		// The poison has to survive INTO the payload, so a throwing getter is no
		// good: collectModels copies every entry into a fresh object (push() spreads
		// it), so a getter fires during collection — inside the inner try — and
		// yields a 200 with `_errors`, which is the collection contract rather than
		// the containment under test here. Measured: 5 reads during collection, 0
		// afterwards.
		//
		// A BigInt does survive the copy, and JSON.stringify refuses to serialize
		// one ("Do not know how to serialize a BigInt"), so the throw lands in
		// sendJson — genuinely downstream of every inner catch, which is the shape
		// that used to take the process down.
		config.claudeModels = [
			{
				type: "model",
				id: "claude-boom",
				display_name: "boom",
				created_at: null,
				context_window: 1n,
			},
		];
		const res = await getReq(proxy.port, "/v1/models?dedup=identity");
		assert.equal(res.status, 500, "a handler throw must answer, not hang or crash");
		assert.match(JSON.parse(res.body).error.message, /internal error/);
		// The assertion that matters: the shared listener is still serving.
		const status = await getReq(proxy.port, "/_status");
		assert.equal(status.status, 200, "one bad request must not take the proxy down");
	});

	it("an unrecognized dedup value is 400, never a silent full list", async () => {
		await up();
		for (const bad of ["identiy", "Identity", "IDENTITY", ""]) {
			// Wrong CASE is rejected like any other wrong value, and pinning that here
			// is what keeps the two halves of the decision from drifting apart: with a
			// separate `=== "identity"` on the dedup branch, relaxing only the gate
			// would let `Identity` through to a 200 carrying the FULL list — the exact
			// silent-wrong-answer this 400 exists to prevent.
			const res = await getReq(proxy.port, `/v1/models?dedup=${bad}`);
			assert.equal(res.status, 400, `dedup=${bad || "<empty>"} must 400`);
			assert.match(JSON.parse(res.body).error.message, /identity/);
		}
		// An unrelated parameter still matches and returns the normal list.
		const ok = await getReq(proxy.port, "/v1/models?t=123");
		assert.equal(ok.status, 200);
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

describe("media generation tunnel (issue #40)", () => {
	const PATH = "/api/v1/services/aigc/multimodal-generation/generation";
	const IMAGE_BODY = JSON.stringify({
		model: "wan2.7-image",
		input: { messages: [{ role: "user", content: [{ text: "a red cube on white" }] }] },
		parameters: { size: "1024*1024" },
	});

	let qwen;
	let claude;
	let proxy;
	afterEach(async () => {
		await close(proxy?.server, qwen?.server, claude?.server);
		qwen = claude = proxy = undefined;
	});

	// `noKey` rather than `qwenKey: undefined` — the destructuring default would
	// silently reinstate the key and the 503 test would pass against a live tunnel.
	async function up({ noKey = false } = {}) {
		const qwenKey = noKey ? undefined : "qw-test";
		qwen = await startBackend(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				output: { choices: [{ message: { content: [{ type: "image" }] } }] },
			}),
		}));
		// Stands in for api.anthropic.com. Its call count is the assertion that the
		// tunnel never falls through to the default backend.
		claude = await startBackend(() => ({ status: 200, headers: {}, body: "{}" }));
		const config = wireConfig("http://127.0.0.1:1", {
			qwenKey,
			qwenBaseUrl: qwen.baseUrl,
			claudeBaseUrl: claude.baseUrl,
		});
		proxy = await startProxy(config);
	}

	it("reaches the plan host at the BARE path — no /apps/anthropic prefix", async () => {
		// The whole reason mediaBaseUrl exists. upstreamRequestOptions concatenates
		// baseUrl + req.url with no rewriting, so routing this through the skin's
		// baseUrl would produce /apps/anthropic/api/v1/... and 404 at the vendor.
		await up();
		const res = await postReq(proxy.port, PATH, IMAGE_BODY);
		assert.equal(res.status, 200);
		assert.equal(qwen.calls.length, 1);
		assert.equal(qwen.calls[0].url, PATH);
		assert.equal(claude.calls.length, 0, "must never fall through to the default backend");
	});

	it("forwards the body byte-for-byte (a tunnel, not a translation)", async () => {
		await up();
		await postReq(proxy.port, PATH, IMAGE_BODY);
		assert.equal(qwen.calls[0].body, IMAGE_BODY);
	});

	it("drops inbound credentials and injects the plan key (invariant 3)", async () => {
		await up();
		await postReq(proxy.port, PATH, IMAGE_BODY, {
			authorization: "Bearer leak",
			"x-api-key": "leak",
		});
		const h = qwen.calls[0].headers;
		assert.equal(h.authorization, "Bearer qw-test");
		assert.equal(h["x-api-key"], undefined);
	});

	it("preserves the query string", async () => {
		await up();
		await postReq(proxy.port, `${PATH}?foo=bar`, IMAGE_BODY);
		assert.equal(qwen.calls[0].url, `${PATH}?foo=bar`);
	});

	it("without DASHSCOPE_API_KEY it is 503, never a silent default-backend route", async () => {
		await up({ noKey: true });
		const res = await postReq(proxy.port, PATH, IMAGE_BODY);
		assert.equal(res.status, 503);
		assert.match(JSON.parse(res.body).error.message, /DASHSCOPE_API_KEY/);
		assert.equal(claude.calls.length, 0);
	});

	it("GET on the media path is 405", async () => {
		await up();
		const res = await reqOn(proxy.port, PATH, "GET");
		assert.equal(res.status, 405);
		assert.equal(qwen.calls.length, 0);
	});

	it("x-dashscope-sse: enable takes the streaming path, not the buffering one", async () => {
		await up();
		await postReq(proxy.port, PATH, IMAGE_BODY, { "x-dashscope-sse": "enable" });
		// The observable difference between the two paths: forwardBuffered forces
		// accept-encoding: identity so it can JSON.parse the response, the streaming
		// pipe does not.
		assert.equal(qwen.calls[0].headers["accept-encoding"], undefined);
		assert.equal(qwen.calls[0].url, PATH);
	});

	it("the SSE header value is matched case-insensitively", async () => {
		// The code lowercases the value deliberately — a header VALUE has no
		// case guarantee — but with only a lowercase `enable` under test, dropping
		// the .toLowerCase() left the suite green (measured). `Enable` on the
		// buffering path would be a silently broken stream, so pin it.
		await up();
		await postReq(proxy.port, PATH, IMAGE_BODY, { "x-dashscope-sse": "Enable" });
		assert.equal(
			qwen.calls[0].headers["accept-encoding"],
			undefined,
			"a capitalised value must still select the streaming path",
		);
	});

	it("the buffered path forces identity encoding (the two paths really differ)", async () => {
		await up();
		await postReq(proxy.port, PATH, IMAGE_BODY);
		assert.equal(qwen.calls[0].headers["accept-encoding"], "identity");
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
