import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { attribute } from "../scripts/list-models.js";
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

	it("falls back to the default backend for unmatched ids", () => {
		assert.equal(
			attribute("some-future-model", buildProviders({ DASHSCOPE_API_KEY: "q" }, "qwen")),
			"qwen",
		);
		assert.equal(attribute("some-future-model", buildProviders({}, "claude")), "claude");
	});
});
