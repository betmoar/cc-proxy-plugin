import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildProviders } from "../src/providers.js";
import { resolve } from "../src/router.js";

const config = { port: 4000, providers: buildProviders({ GLM_API_KEY: "glm-test" }, "claude") };

describe("router", () => {
	it("routes glm-* models to GLM", () => {
		assert.equal(resolve("glm-5.2", config).id, "glm");
	});

	it("routes claude-* models to Claude", () => {
		assert.equal(resolve("claude-opus-4-6", config).id, "claude");
	});

	it("routes claude-haiku-* to Claude always", () => {
		assert.equal(resolve("claude-haiku-4-6", config).id, "claude");
	});

	it("uses default backend when model is unknown", () => {
		assert.equal(resolve("unknown-model", config).id, "claude");
	});

	it("uses default backend when model is undefined", () => {
		assert.equal(resolve(undefined, config).id, "claude");
	});

	describe("OpenRouter (when configured)", () => {
		const withOr = {
			port: 4000,
			providers: buildProviders({ GLM_API_KEY: "g", OPENROUTER_API_KEY: "o" }, "claude"),
		};

		it("routes slash-namespaced ids to openrouter", () => {
			assert.equal(resolve("anthropic/claude-opus-4", withOr).id, "openrouter");
			assert.equal(resolve("z-ai/glm-4.7", withOr).id, "openrouter");
		});

		it("still routes bare glm-*/claude-* to their own providers", () => {
			assert.equal(resolve("glm-5.2", withOr).id, "glm");
			assert.equal(resolve("claude-opus-4-6", withOr).id, "claude");
		});

		it("slash ids fall to the default when openrouter is not configured", () => {
			assert.equal(resolve("anthropic/claude-opus-4", config).id, "claude");
		});
	});

	describe("DeepSeek (when configured)", () => {
		const withDs = {
			port: 4000,
			providers: buildProviders({ DEEPSEEK_API_KEY: "d" }, "claude"),
		};

		it("routes bare deepseek-* ids to deepseek", () => {
			assert.equal(resolve("deepseek-v4-pro", withDs).id, "deepseek");
			assert.equal(resolve("deepseek-v4-flash", withDs).id, "deepseek");
		});

		it("does not route slash-namespaced deepseek/* to deepseek (collision-lock)", () => {
			// deepseek/deepseek-v4-pro has a slash → matches no prefix provider,
			// falls to the default (claude here). The native DeepSeek provider only
			// owns the bare deepseek- ids.
			assert.equal(resolve("deepseek/deepseek-v4-pro", withDs).id, "claude");
		});

		it("bare deepseek-* still routes to deepseek when OpenRouter is also configured", () => {
			const both = {
				port: 4000,
				providers: buildProviders({ OPENROUTER_API_KEY: "o", DEEPSEEK_API_KEY: "d" }, "claude"),
			};
			// OpenRouter matches slash ids; DeepSeek matches deepseek-*. A bare id
			// has no slash, so it must reach deepseek, not openrouter.
			assert.equal(resolve("deepseek-v4-pro", both).id, "deepseek");
			// and the slash form still reaches openrouter, not deepseek.
			assert.equal(resolve("deepseek/deepseek-v4-pro", both).id, "openrouter");
		});

		it("deepseek not configured → bare deepseek-* falls to the default", () => {
			assert.equal(resolve("deepseek-v4-pro", config).id, "claude");
		});
	});

	describe("Qwen (when configured)", () => {
		const withQwen = {
			port: 4000,
			providers: buildProviders({ DASHSCOPE_API_KEY: "q" }, "claude"),
		};

		it("routes bare qwen ids (no dash after qwen) to qwen", () => {
			assert.equal(resolve("qwen3.7-max", withQwen).id, "qwen");
			assert.equal(resolve("qwen3.6-flash", withQwen).id, "qwen");
			assert.equal(resolve("qwen3.8-max", withQwen).id, "qwen");
		});

		it("does not route slash-namespaced qwen/* to qwen (collision-lock)", () => {
			// qwen/qwen3.7-max has a slash → matches no prefix provider, falls to the
			// default (claude here). OpenRouter owns the slash space, not Qwen.
			assert.equal(resolve("qwen/qwen3.7-max", withQwen).id, "claude");
		});

		it("bare glm-/deepseek-/claude-* still route to their own providers with Qwen configured", () => {
			// QwenCloud advertises glm-5.2 and deepseek-v4-* too, but those bare ids
			// must keep routing to their native backends (no QWEN default hijack).
			const all = {
				port: 4000,
				providers: buildProviders(
					{ GLM_API_KEY: "g", DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" },
					"claude",
				),
			};
			assert.equal(resolve("glm-5.2", all).id, "glm");
			assert.equal(resolve("deepseek-v4-pro", all).id, "deepseek");
			assert.equal(resolve("claude-opus-4-6", all).id, "claude");
			assert.equal(resolve("qwen3.7-max", all).id, "qwen");
		});

		it("qwen not configured → bare qwen ids fall to the default", () => {
			assert.equal(resolve("qwen3.7-max", config).id, "claude");
		});
	});

	describe("default backend = glm", () => {
		const glmDefault = { port: 4000, providers: buildProviders({ GLM_API_KEY: "x" }, "glm") };

		it("haiku stays pinned to Claude even when glm is the default", () => {
			assert.equal(resolve("claude-haiku-4-6", glmDefault).id, "claude");
		});

		it("unknown model falls to glm when glm is the default", () => {
			assert.equal(resolve("weird-model", glmDefault).id, "glm");
		});
	});
});
