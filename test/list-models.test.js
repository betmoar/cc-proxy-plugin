import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { attribute } from "../scripts/list-models.js";

// Attribution must mirror the router: same disjoint predicates as
// src/providers.js's match()s, restated against the /_status provider list.
// These cases lock the predicates here — change a match() there, change here,
// and update the expectations below.
describe("list-models attribute()", () => {
	const ALL = ["glm", "deepseek", "openrouter", "qwen", "claude"];

	it("routes static and bare claude ids to Claude (default backend)", () => {
		assert.equal(attribute("claude-fable-5", ALL, "claude"), "claude");
		assert.equal(attribute("claude-opus-5", ALL, "claude"), "claude");
	});

	it("pins claude-haiku-* to Claude even with everything else registered", () => {
		assert.equal(attribute("claude-haiku-4-5", ALL, "glm"), "claude");
	});

	it("routes glm-* to GLM only when GLM is registered", () => {
		assert.equal(attribute("glm-5.2", ALL, "claude"), "glm");
		assert.equal(attribute("glm-5.2", ["claude"], "claude"), "claude");
	});

	it("routes bare deepseek-* to DeepSeek; deepseek/... to OpenRouter", () => {
		assert.equal(attribute("deepseek-v4-pro", ALL, "claude"), "deepseek");
		assert.equal(attribute("deepseek/deepseek-v4-pro", ALL, "claude"), "openrouter");
	});

	it("routes bare qwen ids to Qwen; qwen/... slash ids to OpenRouter", () => {
		// The !includes("/") exclusion is the routing invariant, restated here:
		// a QwenCloud subscription's slash-shaped id belongs to OpenRouter.
		assert.equal(attribute("qwen3.7-max", ALL, "claude"), "qwen");
		assert.equal(attribute("qwen3.8-max-preview", ALL, "claude"), "qwen");
		assert.equal(attribute("qwen/qwen3.7-max", ALL, "claude"), "openrouter");
		assert.equal(attribute("qwen3.7-max", ["claude"], "claude"), "claude");
	});

	it("routes any slash id to OpenRouter when registered", () => {
		assert.equal(attribute("anthropic/claude-opus-4", ALL, "claude"), "openrouter");
		assert.equal(attribute("z-ai/glm-4.7", ALL, "claude"), "openrouter");
	});

	it("falls back to the default backend for unmatched ids", () => {
		assert.equal(attribute("some-future-model", ALL, "qwen"), "qwen");
		assert.equal(attribute("some-future-model", ALL, undefined), "claude");
	});
});
