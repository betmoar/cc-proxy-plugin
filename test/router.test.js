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
