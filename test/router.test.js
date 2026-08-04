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

		// The Qwen Token Plan serves DeepSeek builds under its OWN dated spelling.
		// `deepseek-v4-flash-0731` 200s there and 400s at DeepSeek native ("The
		// supported API model names are deepseek-v4-pro or deepseek-v4-flash"), so
		// before 0.5.1 the deepseek- prefix claimed it and the user got a hard
		// failure on a model their plan entitles them to.
		it("routes a dated deepseek build to qwen — DeepSeek native does not know it", () => {
			const both = {
				port: 4000,
				providers: buildProviders({ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d" }, "claude"),
			};
			assert.equal(resolve("deepseek-v4-flash-0731", both).id, "qwen");
			// deepseek-v4-flash stays native — the plan 403s it, so claiming it would
			// turn a reachable model into a hard failure. (deepseek-v4-pro DOES move
			// to the plan; that is the separate "plan before credits" rule below.)
			assert.equal(resolve("deepseek-v4-flash", both).id, "deepseek");
		});

		// GUARDRAIL (invariant 3 — credential isolation). A dated-id predicate
		// written as a bare /-\d{4}$/ also matches Anthropic's own pinned ids, which
		// are dated: claude-sonnet-4-5-20250929 would route to qwen, sending the
		// user's OAuth credentials toward a third-party backend. Nearly shipped;
		// the DATED_ID pattern is anchored to `deepseek-` for exactly this reason.
		it("dated claude-* ids stay on Claude, never on a third-party backend", () => {
			const all = {
				port: 4000,
				providers: buildProviders(
					{ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" },
					"claude",
				),
			};
			for (const id of [
				"claude-sonnet-4-5-20250929",
				"claude-opus-4-1-20250805",
				"claude-haiku-4-5-20251001",
			]) {
				assert.equal(resolve(id, all).id, "claude", `${id} must stay on Claude`);
			}
			// Same trap, other vendors: a dated id that is not DeepSeek's is not the
			// plan's to claim.
			assert.equal(resolve("glm-4-plus-0520", all).id, "glm");
			assert.equal(resolve("kimi-k2-0711", all).id, "claude"); // unknown → default
		});

		// "Plan before credits" (0.5.1). The plan resells deepseek-v4-pro and
		// glm-5.2, and plan capacity is prepaid while the native routes bill
		// metered credits — so with the plan configured, the bare ids go there.
		it("routes plan-resold bare ids to qwen when the plan is configured", () => {
			const withPlan = {
				port: 4000,
				providers: buildProviders(
					{ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" },
					"claude",
				),
			};
			assert.equal(resolve("deepseek-v4-pro", withPlan).id, "qwen");
			assert.equal(resolve("glm-5.2", withPlan).id, "qwen");
			// deepseek-v4-flash is NOT resold — the plan 403s it — so it must stay
			// native or the user loses a model they can otherwise reach.
			assert.equal(resolve("deepseek-v4-flash", withPlan).id, "deepseek");
			// Everything else is untouched: only the two named ids move.
			assert.equal(resolve("glm-5.1", withPlan).id, "glm");
			assert.equal(resolve("glm-4.5", withPlan).id, "glm");
		});

		// The other half of the same rule: a user WITHOUT the plan must see the
		// original native routing. The plan leg only registers with the key, and
		// the glm/deepseek predicates only yield when it is present — otherwise
		// these ids would resolve to a backend that is not in the registry.
		it("leaves bare ids native when no plan key is configured", () => {
			const noPlan = {
				port: 4000,
				providers: buildProviders({ DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" }, "claude"),
			};
			assert.equal(resolve("deepseek-v4-pro", noPlan).id, "deepseek");
			assert.equal(resolve("glm-5.2", noPlan).id, "glm");
			assert.equal(resolve("deepseek-v4-flash", noPlan).id, "deepseek");
		});

		it("does not route slash-namespaced qwen/* to qwen (collision-lock)", () => {
			// qwen/qwen3.7-max has a slash → matches no prefix provider, falls to the
			// default (claude here). OpenRouter owns the slash space, not Qwen.
			assert.equal(resolve("qwen/qwen3.7-max", withQwen).id, "claude");
		});

		it("Qwen claims ONLY the ids it resells, never the rest of a vendor's line", () => {
			// This used to assert every bare glm-/deepseek- id stayed native. 0.5.1
			// narrowed that: the two ids the plan actually resells move (prepaid
			// beats metered), and everything else is untouched. The invariant that
			// survives — and matters — is that the plan cannot swallow a whole
			// prefix, which would be a QWEN default hijack.
			const all = {
				port: 4000,
				providers: buildProviders(
					{ GLM_API_KEY: "g", DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" },
					"claude",
				),
			};
			assert.equal(resolve("glm-5.1", all).id, "glm");
			assert.equal(resolve("glm-4.7", all).id, "glm");
			assert.equal(resolve("glm-5-turbo", all).id, "glm");
			assert.equal(resolve("deepseek-v4-flash", all).id, "deepseek");
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
