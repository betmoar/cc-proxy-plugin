import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CONTEXT_WINDOW, attribute, registeredProviders } from "../scripts/list-models.js";
import { DEEPSEEK_PRICING, DEFAULT_QWEN_MODELS } from "../src/models.js";
import { buildProviders } from "../src/providers.js";

// The command's attribution IS the router: attribute() routes through
// resolve()/buildProviders(). These cases pin the observable contract the
// command renders — every provider registered (ALL), then provider-subsets to
// prove gating (a provider that isn't registered can't claim its ids). If a
// match() legitimately changes in src/providers.js, these expectations update
// to the new router behavior, not to a hand-copied restatement.
describe("list-models attribute()", () => {
	const ALL = buildProviders(
		{
			GLM_API_KEY: "g",
			DEEPSEEK_API_KEY: "d",
			OPENROUTER_API_KEY: "o",
			DASHSCOPE_API_KEY: "q",
		},
		"claude",
	);

	it("routes static and bare claude ids to Claude (default backend)", () => {
		assert.equal(attribute("claude-fable-5", ALL), "claude");
		assert.equal(attribute("claude-opus-5", ALL), "claude");
	});

	it("pins claude-haiku-* to Claude even with everything else registered", () => {
		const glmDefault = buildProviders({ DASHSCOPE_API_KEY: "q" }, "glm");
		assert.equal(attribute("claude-haiku-4-5", glmDefault), "claude");
	});

	it("routes glm-* to GLM (glm is always registered — the primary backend)", () => {
		// glm is the one provider buildProviders() always pushes (with an empty
		// key when unset), so glm-* ids always attribute to GLM. /v1/models only
		// lists glm models when the key is set, so this can't show a model that
		// isn't reachable.
		assert.equal(attribute("glm-5.2", buildProviders({ GLM_API_KEY: "g" }, "claude")), "glm");
		assert.equal(attribute("glm-5.2", buildProviders({}, "claude")), "glm");
	});

	it("routes bare deepseek-* to DeepSeek; deepseek/... to OpenRouter", () => {
		assert.equal(
			attribute("deepseek-v4-pro", buildProviders({ DEEPSEEK_API_KEY: "d" }, "claude")),
			"deepseek",
		);
		assert.equal(attribute("deepseek/deepseek-v4-pro", ALL), "openrouter");
	});

	it("routes bare qwen ids to Qwen; qwen/... slash ids to OpenRouter", () => {
		// The !includes("/") exclusion is the routing invariant, exercised through
		// the real router: a slash-shaped id belongs to OpenRouter, not Qwen.
		assert.equal(
			attribute("qwen3.7-max", buildProviders({ DASHSCOPE_API_KEY: "q" }, "claude")),
			"qwen",
		);
		assert.equal(
			attribute("qwen3.8-max-preview", buildProviders({ DASHSCOPE_API_KEY: "q" }, "claude")),
			"qwen",
		);
		assert.equal(attribute("qwen/qwen3.7-max", ALL), "openrouter");
		assert.equal(attribute("qwen3.7-max", buildProviders({}, "claude")), "claude");
	});

	it("routes any slash id to OpenRouter when registered", () => {
		assert.equal(attribute("anthropic/claude-opus-4", ALL), "openrouter");
		assert.equal(attribute("z-ai/glm-4.7", ALL), "openrouter");
	});

	// Curated, like DEEPSEEK_PRICING: values were verified against vendor docs
	// 2026-08-04 (see list-models.js header). This pins the KEYS only — a dropped
	// or mistyped model id (one the curated list forgets to cover) is caught even
	// though the value itself is informational.
	//
	// The deepseek + qwen expected ids are DERIVED from their discovery source of
	// truth (DEEPSEEK_PRICING keys, DEFAULT_QWEN_MODELS ids), so adding a model
	// there auto-fails if CONTEXT_WINDOW misses it. GLM is live-fetched (no static
	// catalog), so its ids are pinned explicitly — the one non-derivable set.
	it("CONTEXT_WINDOW covers every bare glm/deepseek/qwen discovery id", () => {
		const derived = [...Object.keys(DEEPSEEK_PRICING), ...DEFAULT_QWEN_MODELS.map((m) => m.id)];
		// GLM discovery ids, pinned (no static GLM catalog — fetched live at runtime).
		const glmIds = [
			"glm-4.5",
			"glm-4.5-air",
			"glm-4.6",
			"glm-4.7",
			"glm-5",
			"glm-5-turbo",
			"glm-5.1",
			"glm-5.2",
		];
		for (const id of [...derived, ...glmIds]) {
			assert.ok(CONTEXT_WINDOW[id], `CONTEXT_WINDOW missing ${id}`);
		}
		// And every context value is a known token string, never a guess.
		for (const v of Object.values(CONTEXT_WINDOW)) {
			assert.match(v, /^\d+K$|^1M$/, `suspicious context value: ${v}`);
		}
	});

	it("falls back to the default backend for unmatched ids", () => {
		assert.equal(
			attribute("some-future-model", buildProviders({ DASHSCOPE_API_KEY: "q" }, "qwen")),
			"qwen",
		);
		assert.equal(attribute("some-future-model", buildProviders({}, "claude")), "claude");
	});

	// The registered-providers filter decides what /_status actually routes to.
	// The claude fallback is load-bearing: resolve()'s default-backend fallback
	// must always have claude available even when /_status omits it.
	describe("registeredProviders()", () => {
		const all = buildProviders({ DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" }, "claude");

		it("drops providers /_status doesn't report", () => {
			const on = registeredProviders(all, ["glm", "claude"]).map((p) => p.id);
			assert.ok(on.includes("glm"));
			assert.ok(on.includes("claude"));
			assert.ok(!on.includes("deepseek"), "deepseek not in /_status, must be dropped");
			assert.ok(!on.includes("qwen"), "qwen not in /_status, must be dropped");
		});

		it("always keeps claude even when /_status omits it", () => {
			// /_status could omit claude when it's the implicit default; the filter
			// must still keep it so resolve()'s default-backend fallback works.
			const on = registeredProviders(all, ["glm", "deepseek", "qwen"]).map((p) => p.id);
			assert.ok(on.includes("claude"), "claude must be kept for default-backend fallback");
		});

		it("keeps every provider when /_status lists them all", () => {
			const on = registeredProviders(all, ["glm", "deepseek", "qwen", "claude"]).map((p) => p.id);
			assert.deepEqual(on.sort(), ["claude", "deepseek", "glm", "qwen"]);
		});

		it("handles a missing /_status providers array (treats it as only claude)", () => {
			const on = registeredProviders(all).map((p) => p.id);
			assert.deepEqual(on, ["claude"], "no providers array → only the default backend stays");
		});
	});
});
