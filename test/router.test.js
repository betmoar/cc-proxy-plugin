import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildProviders } from "../src/providers.js";
// `resolve` here is the provider-only wrapper — it keeps the ~50 pre-existing
// `.id` assertions readable. `resolve2` is the full result, used wherever a test
// needs to see the stripped upstream id.
import { resolveProvider as resolve, resolve as resolve2 } from "../src/router.js";

const config = { port: 4000, providers: buildProviders({ GLM_API_KEY: "glm-test" }, "claude") };

describe("router", () => {
	it("routes glm-* models to GLM", () => {
		assert.equal(resolve("glm-5.2", config).id, "glm");
	});

	// Issue #20: GLM is opt-in. With no GLM_API_KEY, the glm entry never gets
	// registered, so a glm- id falls through to the default backend (claude)
	// instead of a dead/unregistered "glm" entry.
	it("falls through glm-* to the default backend when GLM_API_KEY is unset", () => {
		const noGlm = { port: 4000, providers: buildProviders({}, "claude") };
		assert.equal(resolve("glm-5.2", noGlm).id, "claude");
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

		// "Plan before credits" shipped in 0.5.1 (DeepSeek native bills metered
		// credits, the plan is prepaid, so the bare id went to the plan) and was
		// REVERSED for deepseek-v4-pro in 0.6.1 (issue #19): the plan gateway's
		// +79-token preamble makes the routes non-interchangeable, so native now
		// wins the bare id whenever it is registered. glm-5.2 was never affected
		// either way: Z.ai is itself a plan (GLM Pro), and a native plan outranks
		// a resold one — swapping prepaid pools saves nothing and costs +6
		// injected tokens.
		it("routes bare ids native even when the plan is configured (issue #19)", () => {
			const withPlan = {
				port: 4000,
				providers: buildProviders(
					{ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" },
					"claude",
				),
			};
			// REVERSED: deepseek-v4-pro used to hop to the qwen plan ("plan before
			// credits"). It now stays native because the plan gateway injects a
			// +79-token preamble. The plan route is still reachable via qwen: (see
			// the lens block); only the DEFAULT changed.
			assert.equal(resolve("deepseek-v4-pro", withPlan).id, "deepseek");
			assert.equal(resolve("glm-5.2", withPlan).id, "glm", "a native plan outranks a resold plan");
			// deepseek-v4-flash is NOT resold — the plan 403s it — so it stays
			// native or the user loses a model they can otherwise reach.
			assert.equal(resolve("deepseek-v4-flash", withPlan).id, "deepseek");
			// Everything else is untouched.
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

		// A plan-holder WITHOUT a native DeepSeek key must still reach
		// deepseek-v4-pro through the plan — the native-first DEFAULT only applies
		// when native is actually registered. This is the case the first issue-#19
		// fix broke (review REFUTED): it excluded the qwen route from rankRoutes
		// unconditionally, so a plan-only user fell through to the default backend
		// (or worse, to a metered reseller) and lost the model entirely.
		it("falls back to the plan for a plan-holder with no native DeepSeek key", () => {
			const planOnly = {
				port: 4000,
				providers: buildProviders({ DASHSCOPE_API_KEY: "q", GLM_API_KEY: "g" }, "claude"),
			};
			assert.equal(
				resolve("deepseek-v4-pro", planOnly).id,
				"qwen",
				"native not registered → plan wins",
			);
			// Even with the reseller present, the prepaid plan outranks metered
			// OpenRouter credits once native is out of the picture.
			const planAndReseller = {
				port: 4000,
				providers: buildProviders(
					{ DASHSCOPE_API_KEY: "q", OPENROUTER_API_KEY: "o", GLM_API_KEY: "g" },
					"claude",
				),
			};
			assert.equal(
				resolve("deepseek-v4-pro", planAndReseller).id,
				"qwen",
				"plan (tier 2) beats reseller (tier 4) when native is absent",
			);
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

	describe("provider selector (<provider>:<model>) — the local lens", () => {
		const all = {
			port: 4000,
			providers: buildProviders(
				{
					GLM_API_KEY: "g",
					OPENROUTER_API_KEY: "o",
					DEEPSEEK_API_KEY: "d",
					DASHSCOPE_API_KEY: "q",
				},
				"claude",
			),
		};

		it("routes to the named provider and strips the prefix from the upstream id", () => {
			// The plan host has never heard of "qwen:deepseek-v4-pro" — the prefix is
			// OUR name for the route, so it must not survive the proxy. Without the
			// strip the upstream 400s ("Model not exist"), which is exactly what a
			// live probe of the un-stripped id returned on 2026-08-06.
			const r = resolve2("qwen:deepseek-v4-pro", all);
			assert.equal(r.provider.id, "qwen");
			assert.equal(r.upstreamModel, "deepseek-v4-pro");
		});

		it("reaches the plan route that the native default would otherwise hide", () => {
			// REVERSED (issue #19): the bare id now defaults to native DeepSeek, so
			// the LENS's job is to reach the PLAN (qwen:) that the default would
			// otherwise hide. The two are not interchangeable — the plan gateway
			// injects ~+79 input tokens — which is why the default is native: the
			// bare id is what /model sets, and a user who tuned a prompt against
			// native must not be silently rerouted to the preamble-augmented plan.
			assert.equal(resolve("deepseek-v4-pro", all).id, "deepseek", "default is the native route");
			const r = resolve2("qwen:deepseek-v4-pro", all);
			assert.equal(r.provider.id, "qwen");
			assert.equal(r.upstreamModel, "deepseek-v4-pro");
		});

		it("honors a selector that bare-id luck used to send to the default", () => {
			// Before the explicit parse, "glm:glm-5.2" matched no predicate (the glm
			// one wants a leading "glm-") and silently fell through to Claude.
			assert.equal(resolve2("glm:glm-5.2", all).provider.id, "glm");
			assert.equal(resolve2("glm:glm-5.2", all).upstreamModel, "glm-5.2");
		});

		it("keeps a slash-bearing tail intact for the aggregator", () => {
			const r = resolve2("openrouter:tencent/hy3", all);
			assert.equal(r.provider.id, "openrouter");
			assert.equal(r.upstreamModel, "tencent/hy3", "OpenRouter needs its vendor/model id");
		});

		it("a claude-haiku-* TAIL ignores the selector (invariant 4 outranks the lens)", () => {
			// The pin must test the STRIPPED id. Pinning on the raw string lets
			// "glm:claude-haiku-…" skip it, and the body rewrite would then send the
			// BARE haiku id to a third party — Claude Code's internal ops billed
			// against paid quota, which is the exact thing invariant 4 prevents.
			for (const id of [
				"glm:claude-haiku-4-5-20251001",
				"qwen:claude-haiku-4-5-20251001",
				"deepseek:claude-haiku-4-6",
				"openrouter:claude-haiku-4-6",
			]) {
				const r = resolve2(id, all);
				assert.equal(r.provider.id, "claude", `${id} must stay on Claude`);
				assert.equal(r.upstreamModel, id.slice(id.indexOf(":") + 1));
			}
		});

		it("an unregistered prefix is not a selector — it falls through, never errors", () => {
			// Keeps a future vendor id that happens to contain a colon safe.
			assert.equal(resolve("bogus:glm-5.2", all).id, "claude", "unknown prefix → no selector");
			assert.equal(resolve2("bogus:glm-5.2", all).upstreamModel, "bogus:glm-5.2");
		});

		it("a selector for a provider that is not configured falls through", () => {
			// qwen key absent → the qwen leg never registers, so the selector cannot
			// resolve. It must degrade to normal routing, not fail.
			const noQwen = { port: 4000, providers: buildProviders({ GLM_API_KEY: "g" }, "claude") };
			assert.equal(resolve("qwen:deepseek-v4-pro", noQwen).id, "claude");
		});

		it("leaves a bare id's upstream model untouched", () => {
			// No selector → byte-for-byte body preserved (invariant 1); the rewrite
			// in server.js is gated on upstreamModel !== body.model.
			assert.equal(resolve2("glm-5.2", all).upstreamModel, "glm-5.2");
			assert.equal(resolve2(undefined, all).upstreamModel, undefined);
		});

		it("does not treat a slash as a selector — OpenRouter keeps its namespace", () => {
			// The colon-only decision. These are the collision-locks above, restated
			// from the lens's side: adding ':' must not have changed '/' at all.
			assert.equal(resolve("qwen/qwen3.7-max", all).id, "openrouter");
			assert.equal(resolve("deepseek/deepseek-v4-pro", all).id, "openrouter");
		});
	});

	describe("native-first, then cheapest-route ranking (ROUTES table)", () => {
		const all = {
			port: 4000,
			providers: buildProviders(
				{
					GLM_API_KEY: "g",
					OPENROUTER_API_KEY: "o",
					DEEPSEEK_API_KEY: "d",
					DASHSCOPE_API_KEY: "q",
				},
				"claude",
			),
		};

		it("prefers the native route for a plan-resold id (issue #19)", () => {
			// "plan before credits" was the default for deepseek-v4-pro until the
			// +79-token plan preamble made the routes non-interchangeable. The bare
			// id now routes native WHEN NATIVE IS REGISTERED. The plan route still
			// wins for a plan-holder without a DeepSeek key (tested above) and is
			// always reachable via the qwen: selector (see the lens block).
			assert.equal(resolve("deepseek-v4-pro", all).id, "deepseek");
		});

		it("prefers a NATIVE plan over a resold plan", () => {
			// glm-5.2 serves 200 on both Z.ai and the Qwen plan, both tier 2. Moving
			// it would swap one prepaid pool for another and still pay the resold
			// route's +6 injected tokens.
			assert.equal(resolve("glm-5.2", all).id, "glm");
		});

		it("never returns a route the probe showed as unavailable", () => {
			// The plan 403s deepseek-v4-flash, so it must go native even though the
			// plan would otherwise be the cheaper tier.
			assert.equal(resolve("deepseek-v4-flash", all).id, "deepseek");
		});

		it("skips ranked routes whose provider is not registered", () => {
			const noPlan = {
				port: 4000,
				providers: buildProviders({ GLM_API_KEY: "g", DEEPSEEK_API_KEY: "d" }, "claude"),
			};
			assert.equal(resolve("deepseek-v4-pro", noPlan).id, "deepseek");
		});

		it("stays native-first even without a ROUTES entry (predicate layer, issue #19 regression)", async () => {
			// rankRoutes() is not the only layer that can pick a provider for
			// `deepseek-v4-pro` — if ROUTES ever loses the entry (a probe expiring,
			// a table edit), resolve() falls through to the predicate layer
			// (config.providers.find). That layer must independently agree with
			// native-first, or ROUTES becomes a single point of failure for the
			// #19 fix. Reproduced by deleting the entry in memory rather than
			// mocking the module, so this exercises the real ROUTES object.
			const { ROUTES } = await import("../src/routes.js");
			const saved = ROUTES["deepseek-v4-pro"];
			// biome-ignore lint/performance/noDelete: rankRoutes() gates on Object.hasOwn, so `= undefined` would not reproduce a missing entry.
			delete ROUTES["deepseek-v4-pro"];
			try {
				const allKeys = {
					port: 4000,
					providers: buildProviders(
						{ GLM_API_KEY: "g", DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" },
						"claude",
					),
				};
				assert.equal(
					resolve("deepseek-v4-pro", allKeys).id,
					"deepseek",
					"a DeepSeek key must still win the bare id with no ROUTES entry",
				);

				const planOnly = {
					port: 4000,
					providers: buildProviders({ GLM_API_KEY: "g", DASHSCOPE_API_KEY: "q" }, "claude"),
				};
				assert.equal(
					resolve("deepseek-v4-pro", planOnly).id,
					"qwen",
					"a plan-only user (no DeepSeek key) must still fall back to qwen",
				);
			} finally {
				ROUTES["deepseek-v4-pro"] = saved;
			}
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
