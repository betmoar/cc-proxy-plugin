import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildProviders } from "../src/providers.js";
// `resolve` here is the provider-only wrapper — it keeps the ~50 pre-existing
// `.id` assertions readable. `resolve2` is the full result, used wherever a test
// needs to see the stripped upstream id.
import {
	resolveProvider as resolve,
	resolve as resolve2,
	stripVariantSuffix,
} from "../src/router.js";

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
			// …and the LENS IS STILL STRIPPED. This half was untested, and once GLM
			// became opt-in (issue #20) the gap became a live leak: the strip used to
			// require the provider to be REGISTERED, so with no key the raw
			// `glm:glm-5.2` was forwarded to Anthropic as a literal model id.
			// server.js gates its body rewrite on `upstreamModel !== body.model`, so
			// an unstripped tail means the lens reaches a backend that has never
			// heard of it → opaque 400.
			assert.equal(
				resolve2("qwen:deepseek-v4-pro", noQwen).upstreamModel,
				"deepseek-v4-pro",
				"an unregistered provider's lens must still be stripped",
			);
		});

		it("strips a KNOWN provider's lens even when that provider holds no key", () => {
			// The regression issue #20 opened: `glm:` is documented in README,
			// CONTRIBUTING and ARCHITECTURE, and GLM is now opt-in, so this is the
			// common case for a user who never configured Z.ai — not an edge case.
			const noKeys = { port: 4000, providers: buildProviders({}, "claude") };
			const r = resolve2("glm:glm-5.2", noKeys);
			assert.equal(r.provider.id, "claude", "no glm leg → falls through to default");
			assert.equal(r.upstreamModel, "glm-5.2", "the lens must never reach an upstream");
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

	// Issue #34. Claude Code spells a long-context variant `glm-5.2[1m]`, the form
	// ANTHROPIC_CUSTOM_MODEL_OPTION registers. CC strips it before the wire today
	// (0 of 24070 routing lines carry one), so these lock a HARDENING guard, not a
	// live defect: the day CC stops stripping, a plan-only user's headline model
	// must not silently change backend.
	//
	// Every assertion checks BOTH halves — provider AND upstreamModel — because
	// the two answer different questions: WHERE the request went, and WHAT the
	// vendor was asked for. A fix can get either right while breaking the other.
	//
	// The upstream half is a MEASUREMENT, and it reversed mid-PR. The first cut
	// preserved the raw suffix on the belief that Z.ai accepted it; probed
	// 2026-08-14 with real keys, it does not — `glm-5.2[1m]` and `glm-5.3[1m]`
	// both draw `400 [1214][modelCode: does not exist]`, the same rejection a
	// wholly fake id gets, and the Qwen plan answers `InvalidParameter: Model
	// not exist.` So the suffix reaches no vendor: it is stripped on the way out
	// exactly as the `<provider>:` lens is.
	describe("variant suffix (issue #34)", () => {
		const planOnly = {
			port: 4000,
			providers: buildProviders({ DASHSCOPE_API_KEY: "q" }, "claude"),
		};

		// THE bug. With no GLM key, `glm-5.2` reaches qwen only through ROUTES —
		// an exact-match table — so the suffix stranded it on the default backend.
		it("routes a suffixed shared id through ROUTES, and sends the bare id upstream", () => {
			const bare = resolve2("glm-5.2", planOnly);
			assert.equal(bare.provider.id, "qwen");

			const suffixed = resolve2("glm-5.2[1m]", planOnly);
			assert.equal(suffixed.provider.id, "qwen", "the suffix must not defeat the ROUTES lookup");
			// Measured 2026-08-14: BOTH vendors 400 on the suffixed spelling
			// (Z.ai `[1214][modelCode: does not exist]`, the Qwen plan
			// `InvalidParameter: Model not exist.`), so forwarding it would route
			// correctly and then fail at the vendor anyway. It is Claude Code's
			// display spelling, stripped on the way out like the `<provider>:`
			// lens.
			assert.equal(
				suffixed.upstreamModel,
				"glm-5.2",
				"the suffix is CC's spelling — no vendor accepts it, so it does not go upstream",
			);
		});

		// glm-5.3 shipped 2026-08-14 and is in NO table — no ROUTES entry, no static
		// catalog — so it reaches GLM purely through the `startsWith("glm-")`
		// predicate. That makes it the honest test of the predicate path: the
		// suffix must not defeat it, and the bare id must reach the vendor.
		// Probed the same day against the live endpoint: `glm-5.3` -> 200,
		// `glm-5.3[1m]` -> 400 [1214][modelCode: does not exist], the identical
		// rejection glm-5.2 gives. The suffix is not a spelling Z.ai knows for
		// ANY model, new ones included — which is why the strip goes upstream.
		it("strips the suffix for an id that only the predicate claims (glm-5.3)", () => {
			const glm = { port: 4000, providers: buildProviders({ GLM_API_KEY: "g" }, "claude") };
			assert.equal(resolve2("glm-5.3", glm).provider.id, "glm");
			const suffixed = resolve2("glm-5.3[1m]", glm);
			assert.equal(
				suffixed.provider.id,
				"glm",
				"no ROUTES entry — the predicate must still claim it",
			);
			assert.equal(suffixed.upstreamModel, "glm-5.3", "the vendor 400s on the suffixed spelling");
		});

		it("routes a suffixed id to the same backend as its bare form, with keys present", () => {
			const glm = { port: 4000, providers: buildProviders({ GLM_API_KEY: "g" }, "claude") };
			assert.equal(resolve2("glm-5.2[1m]", glm).provider.id, "glm");
			assert.equal(resolve2("glm-5.2[1m]", glm).upstreamModel, "glm-5.2");

			const deep = {
				port: 4000,
				providers: buildProviders({ DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" }, "claude"),
			};
			assert.equal(resolve2("deepseek-v4-pro[1m]", deep).provider.id, "deepseek");
			assert.equal(resolve2("deepseek-v4-pro[1m]", deep).upstreamModel, "deepseek-v4-pro");
		});

		// The site issue #34 did NOT name: DATED_ID is anchored (`\d{4}$`), so a
		// suffix defeats the plan's claim on plan-only spellings too. A fix that
		// patched only ROUTES + QWEN_PLAN_RESELLS would leave this broken.
		it("keeps the plan's claim on a DATED id that carries a suffix", () => {
			assert.equal(resolve2("deepseek-v4-flash-0731", planOnly).provider.id, "qwen");
			assert.equal(
				resolve2("deepseek-v4-flash-0731[1m]", planOnly).provider.id,
				"qwen",
				"DATED_ID is anchored, so the suffix defeats it unless stripped",
			);
			assert.equal(
				resolve2("deepseek-v4-flash-0731[1m]", planOnly).upstreamModel,
				"deepseek-v4-flash-0731",
			);
		});

		// QWEN_PLAN_RESELLS, the third exact-match site. Reached only when no
		// native DeepSeek key is registered — rankRoutes' native-first sort (issue
		// #19) claims the id first otherwise.
		it("keeps the plan predicate's claim on a resold id that carries a suffix", async () => {
			const { ROUTES } = await import("../src/routes.js");
			const saved = ROUTES["deepseek-v4-pro"];
			// biome-ignore lint/performance/noDelete: rankRoutes() gates on Object.hasOwn, so `= undefined` would not reproduce a missing entry.
			delete ROUTES["deepseek-v4-pro"];
			try {
				assert.equal(
					resolve2("deepseek-v4-pro[1m]", planOnly).provider.id,
					"qwen",
					"QWEN_PLAN_RESELLS is a Set.has on the raw id",
				);
			} finally {
				ROUTES["deepseek-v4-pro"] = saved;
			}
		});

		// The registered-selector branch, which the haiku test above does NOT
		// reach: a haiku tail short-circuits before the selector is consulted, so
		// the ordinary path — selector honored, suffix stripped — had no coverage
		// even though the reversal changed what it returns (raw tail → routeId).
		// Both strips must compose: the lens is cc-proxy's spelling and the suffix
		// is Claude Code's, and no backend has heard of either.
		it("strips BOTH the selector and the suffix on the ordinary selector path", () => {
			const all = {
				port: 4000,
				providers: buildProviders({ DASHSCOPE_API_KEY: "q", DEEPSEEK_API_KEY: "d" }, "claude"),
			};
			const r = resolve2("qwen:deepseek-v4-pro[1m]", all);
			assert.equal(r.provider.id, "qwen", "the selector still names the backend");
			assert.equal(
				r.upstreamModel,
				"deepseek-v4-pro",
				"the vendor receives neither cc-proxy's lens nor CC's suffix",
			);
			// The selector must still WIN over the ranked route, suffix or not:
			// with a DeepSeek key registered, the bare id would go native.
			assert.equal(resolve2("deepseek-v4-pro[1m]", all).provider.id, "deepseek");
		});

		// Invariant 4 under a suffix. The pin already tests the STRIPPED tail of a
		// `<provider>:` lens; it must survive both strips composed, or
		// `glm:claude-haiku-…[1m]` bills CC's internal ops to a third party.
		it("pins a suffixed haiku id to Claude, selector or not", () => {
			const all = {
				port: 4000,
				providers: buildProviders({ GLM_API_KEY: "g", DASHSCOPE_API_KEY: "q" }, "claude"),
			};
			assert.equal(resolve2("claude-haiku-4-5-20251001[1m]", all).provider.id, "claude");
			assert.equal(resolve2("glm:claude-haiku-4-5-20251001[1m]", all).provider.id, "claude");
			assert.equal(
				resolve2("glm:claude-haiku-4-5-20251001[1m]", all).upstreamModel,
				"claude-haiku-4-5-20251001",
				"both the lens and the suffix are cc-proxy/CC spellings — neither leaves the proxy",
			);
		});

		// A bracket that is not a well-formed TRAILING pair never routes anywhere
		// new. Two distinct reasons, and the distinction is worth stating because
		// the strip is not an id validator:
		//   - `glm-5.2[`, `glm-5.2]`, `[1m]` — the regex does not fire at all
		//     (unclosed / no pair / no stem before it).
		//   - `glm-5.2[a[b]` — the regex DOES fire, on the well-formed tail `[b]`,
		//     yielding the stem `glm-5.2[a`. Only the pair's INTERIOR is required
		//     to be bracket-free, not the stem.
		// Either way the result is not a routable id, so both land on the default
		// backend. `glm-5.2[a[b]` is the one case where the strip DID fire, so it
		// is listed separately below rather than asserted as "unchanged".
		it("routes a malformed or stemless bracket to the default backend", () => {
			for (const id of ["glm-5.2[", "glm-5.2]", "[1m]", "[]"]) {
				const r = resolve2(id, planOnly);
				assert.equal(r.upstreamModel, id, `${id} matches no pair — nothing to strip`);
				assert.equal(r.provider.id, "claude", `${id} is not a routable id — default backend`);
			}
			// The strip fires on the trailing `[b]` and yields an unroutable stem.
			const nested = resolve2("glm-5.2[a[b]", planOnly);
			assert.equal(nested.upstreamModel, "glm-5.2[a");
			assert.equal(nested.provider.id, "claude");
		});

		// Pins the two behaviours above at the function itself, so a regex edit
		// that changed WHICH of them applies fails here even though resolve()
		// returns `claude` for both reasons.
		it("fires only on a well-formed trailing pair, and never strips to empty", () => {
			assert.equal(stripVariantSuffix("glm-5.2[1m]"), "glm-5.2");
			assert.equal(stripVariantSuffix("glm-5.2[]"), "glm-5.2");
			assert.equal(stripVariantSuffix("glm-5.2[a[b]"), "glm-5.2[a", "strips the tail pair only");
			assert.equal(stripVariantSuffix("glm-5.2[1m][2m]"), "glm-5.2[1m]", "one pair, not greedy");
			// THE shape that separates the strict interior `[^[\]]*` from a loose
			// `.*`, and the reason the strict form is the one that ships. With
			// `.*` the match takes the FIRST bracket and returns "glm-5.2" — a
			// real, routable id synthesized out of a malformed one, which would
			// send a mangled request to Z.ai instead of the default backend.
			// The loose form was committed by mistake once; this is what catches
			// it, because every other shape the two forms agree on.
			assert.equal(
				stripVariantSuffix("glm-5.2[a]b]"),
				"glm-5.2[a]b]",
				"a malformed id must never be coerced into a routable one",
			);
			// The leading `^` is load-bearing and was NOT covered: without it the
			// pattern matches at any offset, so `(.+)` starts wherever it must and
			// the function still returns a stem — silently accepting an id with
			// junk in front of it. Reported by the test-coverage lens on PR #36.
			assert.equal(
				stripVariantSuffix("\nglm-5.2[1m]"),
				"\nglm-5.2[1m]",
				"anchored: `.` cannot span the newline, so no match — the id is left alone",
			);
			// The trailing space is written as an escape so a formatter cannot
			// silently trim it — one did, turning this case into plain
			// "glm-5.2[1m]" and asserting the exact opposite of what it tests.
			for (const untouched of ["glm-5.2[", "glm-5.2]", "[1m]", "[]", "glm-5.2[1m]\u0020"]) {
				assert.equal(stripVariantSuffix(untouched), untouched, `${untouched} must not be stripped`);
			}
		});

		it("strips an EMPTY bracket pair, which is well-formed", () => {
			// `glm-5.2[]` has the shape; the stem is a real id, so it routes.
			assert.equal(resolve2("glm-5.2[]", planOnly).provider.id, "qwen");
			assert.equal(resolve2("glm-5.2[]", planOnly).upstreamModel, "glm-5.2");
		});
	});

	describe("LM Studio (selector-only)", () => {
		const withLm = {
			port: 4000,
			providers: buildProviders({ LMSTUDIO_BASE_URL: "http://localhost:1234" }, "claude"),
		};
		const crowded = {
			port: 4000,
			providers: buildProviders(
				{
					GLM_API_KEY: "g",
					OPENROUTER_API_KEY: "o",
					DEEPSEEK_API_KEY: "d",
					DASHSCOPE_API_KEY: "q",
					LMSTUDIO_BASE_URL: "http://localhost:1234",
				},
				"claude",
			),
		};

		it("routes lmstudio:<id> to lmstudio and strips the lens", () => {
			const r = resolve2("lmstudio:openai/gpt-oss-20b", withLm);
			assert.equal(r.provider.id, "lmstudio");
			assert.equal(r.upstreamModel, "openai/gpt-oss-20b", "the tail keeps its slashes");
		});

		// The id that motivated the provider: a TWO-slash GGUF path with a bare
		// sibling (`qwen3.6-27b-…`) loaded on the same server. The lens strip
		// splits on the FIRST colon only, so the tail survives whole; step 2 then
		// routes by the selector's provider id alone — it never looks at the id's
		// shape, so nothing in the id can defeat it.
		it("routes a two-slash GGUF id whose bare siblings collide with every predicate", () => {
			const id =
				"lmstudio:hauhaucs/qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp-gguf/qwen3.8-27b-uncensored-hauhaucs-aggressive-q4_k_p.gguf";
			const r = resolve2(id, crowded);
			assert.equal(r.provider.id, "lmstudio");
			assert.equal(
				r.upstreamModel,
				"hauhaucs/qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp-gguf/qwen3.8-27b-uncensored-hauhaucs-aggressive-q4_k_p.gguf",
			);
		});

		it("the lens is stripped even when no LM Studio host is configured (issue #20 rule)", () => {
			const noLm = { port: 4000, providers: buildProviders({ GLM_API_KEY: "g" }, "claude") };
			const r = resolve2("lmstudio:openai/gpt-oss-20b", noLm);
			assert.equal(r.provider.id, "claude", "no host → no leg → default backend");
			assert.equal(r.upstreamModel, "openai/gpt-oss-20b", "the lens must never reach an upstream");
		});

		it("bare ids NEVER route to lmstudio — the competing predicates keep their ids", () => {
			// The ids a live server actually held (measured 2026-08-28). Without the
			// selector they must land exactly where they did before lmstudio existed.
			assert.equal(resolve("glm-4.7-flash-uncensored-hauhaucs-aggressive", crowded).id, "glm");
			assert.equal(
				resolve("qwen3.6-27b-fable-fusion-711-uncensored-heretic-nm-dau-neo-max-mtp", crowded).id,
				"qwen",
			);
			assert.equal(resolve("openai/gpt-oss-20b", crowded).id, "openrouter");
			assert.equal(
				resolve("qwen3vl-8b-uncensored-hauhaucs-aggressive", withLm).id,
				"claude",
				"qwen key absent → falls past the qwen predicate",
			);
		});

		it("the selector outranks ROUTES and the predicates, like every lens", () => {
			// `lmstudio:deepseek-v4-pro` goes to LM Studio even though the bare id has
			// three ranked routes and a key registered — a selector names its backend,
			// it does not re-ask the routers.
			const r = resolve2("lmstudio:deepseek-v4-pro", crowded);
			assert.equal(r.provider.id, "lmstudio");
			assert.equal(r.upstreamModel, "deepseek-v4-pro");
		});

		it("invariant 4 outranks the lmstudio lens (haiku tail pinned to Claude)", () => {
			const r = resolve2("lmstudio:claude-haiku-4-5-20251001", withLm);
			assert.equal(r.provider.id, "claude");
			assert.equal(r.upstreamModel, "claude-haiku-4-5-20251001");
		});

		it("a suffixed selector strips BOTH spellings", () => {
			const r = resolve2(
				"lmstudio:gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2[1m]",
				withLm,
			);
			assert.equal(r.provider.id, "lmstudio");
			assert.equal(r.upstreamModel, "gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2");
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

describe("LM Studio as DEFAULT_BACKEND (the documented explicit exception)", () => {
	// The selector-only claim is about SHAPE routing: no predicate claims a bare
	// id for lmstudio. DEFAULT_BACKEND is a different mechanism — the user
	// explicitly pointing the fallback at their local box — and it must WORK,
	// not be refused. This pins both halves so the docs and the code stay in
	// step: bare ids DO fall through to lmstudio when it is the default, and
	// the haiku pin still outranks even that.
	const lmDefault = {
		port: 4000,
		providers: buildProviders({ LMSTUDIO_BASE_URL: "http://localhost:1234" }, "lmstudio"),
	};

	it("unmatched ids fall through to lmstudio when it is the explicit default", () => {
		assert.equal(resolve("totally-unknown-model", lmDefault).id, "lmstudio");
		assert.equal(resolve2("lmstudio:openai/gpt-oss-20b", lmDefault).provider.id, "lmstudio");
	});

	it("invariant 4 outranks even the lmstudio default (haiku stays on Claude)", () => {
		const r = resolve2("claude-haiku-4-5-20251001", lmDefault);
		assert.equal(r.provider.id, "claude");
		assert.equal(r.upstreamModel, "claude-haiku-4-5-20251001");
	});
});
