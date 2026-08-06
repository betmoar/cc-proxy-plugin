import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CONTEXT_WINDOW } from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { PROVIDER_BILLING, ROUTES, rankRoutes, tierOf } from "../src/routes.js";

describe("routes", () => {
	describe("tierOf", () => {
		it("ranks plan capacity cheaper than metered credits", () => {
			// The whole cost model in one assertion: prepaid capacity is sunk, so
			// spending it is free at the margin.
			assert.ok(tierOf("qwen") < tierOf("deepseek"));
			assert.ok(tierOf("glm") < tierOf("deepseek"));
		});

		it("ranks the reseller last", () => {
			for (const id of ["claude", "glm", "qwen", "deepseek"]) {
				assert.ok(tierOf(id) < tierOf("openrouter"), `${id} must outrank openrouter`);
			}
		});

		it("lets a route override its provider's billing mode", () => {
			// Billing is a property of the (id, backend) PAIR. If DeepSeek ships a
			// plan, or a plan provider meters one model, that must be expressible
			// without reclassifying the whole backend.
			assert.equal(tierOf("deepseek"), 3);
			assert.equal(tierOf("deepseek", { provider: "deepseek", status: 200, billing: "plan" }), 2);
		});

		it("falls back to the credits tier for an unknown provider", () => {
			assert.equal(tierOf("nobody-knows"), 3);
		});
	});

	describe("rankRoutes", () => {
		it("returns the cheapest usable route first", () => {
			assert.equal(rankRoutes("deepseek-v4-pro")[0].provider, "qwen");
		});

		it("breaks a tier tie toward the native provider", () => {
			// glm-5.2 is 200 on Z.ai (native plan) and on the Qwen plan (resold) —
			// both tier 2. Swapping one prepaid pool for another buys nothing and
			// still pays the resold route's +6 injected tokens.
			const ranked = rankRoutes("glm-5.2");
			assert.equal(ranked[0].provider, "glm");
			assert.equal(ranked[1].provider, "qwen");
		});

		it("never returns a route the probe showed as unavailable", () => {
			// 403 on the plan, 400 for an id the origin has never heard of.
			for (const id of Object.keys(ROUTES)) {
				for (const r of rankRoutes(id)) {
					assert.equal(r.status, 200, `${id} → ${r.provider} must be a 200 route`);
				}
			}
			assert.deepEqual(
				rankRoutes("deepseek-v4-flash").map((r) => r.provider),
				["deepseek", "openrouter"],
				"the plan 403s this id, so it has no cheap route",
			);
			assert.deepEqual(
				rankRoutes("deepseek-v4-flash-0731").map((r) => r.provider),
				["qwen"],
				"plan-only id: DeepSeek native 400s it",
			);
		});

		it("returns empty for an id the table has never seen", () => {
			// NOT a failure mode. Vendor ids rename (deepseek-v4-flash is expected
			// to), and the router falls through to the match() predicates — a table
			// that could strand a model on rename would be worse than no table.
			assert.deepEqual(rankRoutes("some-future-model-v9"), []);
			assert.deepEqual(rankRoutes(undefined), []);
		});

		it("does not inherit from Object.prototype", () => {
			// A vendor id of __proto__/constructor would otherwise hand back a
			// non-array — the same trap withContextWindow() guards in models.js.
			assert.deepEqual(rankRoutes("__proto__"), []);
			assert.deepEqual(rankRoutes("constructor"), []);
			assert.deepEqual(rankRoutes("toString"), []);
		});
	});

	describe("table integrity", () => {
		const providerIds = new Set(
			buildProviders(
				{
					GLM_API_KEY: "g",
					OPENROUTER_API_KEY: "o",
					DEEPSEEK_API_KEY: "d",
					DASHSCOPE_API_KEY: "q",
				},
				"claude",
			).map((p) => p.id),
		);

		it("every route names a real provider", () => {
			for (const [id, routes] of Object.entries(ROUTES)) {
				for (const r of routes) {
					assert.ok(providerIds.has(r.provider), `${id} names unknown provider "${r.provider}"`);
				}
			}
		});

		it("every provider has a billing mode", () => {
			for (const id of providerIds) {
				assert.ok(PROVIDER_BILLING[id], `provider "${id}" has no billing mode`);
			}
		});

		it("lists no duplicate backend for one id", () => {
			for (const [id, routes] of Object.entries(ROUTES)) {
				const seen = routes.map((r) => r.provider);
				assert.equal(new Set(seen).size, seen.length, `${id} lists a backend twice`);
			}
		});

		it("stays in step with the curated context-window table", () => {
			// Both tables are curated per bare id. Drift means one of them was
			// updated for a new model and the other was not.
			for (const id of Object.keys(CONTEXT_WINDOW)) {
				assert.ok(Object.hasOwn(ROUTES, id), `${id} has a context window but no route`);
			}
		});
	});
});

describe("discovery ↔ routing coherence", () => {
	// Both of these shipped broken in the first implementation pass and were
	// caught only by rendering against a live proxy. They are offline-testable,
	// so they are tested offline now.
	it("no static catalog restates a route it does not own", async () => {
		// The winner is DERIVED from ROUTES by collectModels(), never re-stated in a
		// leg's catalog. An earlier pass did the opposite — it added deepseek-v4-pro
		// to DEFAULT_QWEN_MODELS so the plan (its cheapest route) had something to
		// publish. That put the same curated fact in two places, which is the drift
		// this repo's coupling tests exist to prevent: the route table could then
		// award the id elsewhere while the catalog still claimed it.
		//
		// So a catalog lists only ids that backend ADVERTISES — its own vendor's, or
		// (like deepseek-v4-flash-0731) an id that exists nowhere else.
		const { DEFAULT_QWEN_MODELS, DEFAULT_CLAUDE_MODELS, DEFAULT_OPENROUTER_MODELS } = await import(
			"../src/models.js"
		);
		const catalogs = {
			qwen: DEFAULT_QWEN_MODELS.map((m) => m.id),
			claude: DEFAULT_CLAUDE_MODELS.map((m) => m.id),
			openrouter: DEFAULT_OPENROUTER_MODELS.map((m) => m.id),
		};
		for (const [provider, ids] of Object.entries(catalogs)) {
			for (const id of ids) {
				const routes = ROUTES[id];
				// An id only ONE backend serves cannot be a restatement — nobody else
				// could have supplied it (deepseek-v4-flash-0731 is the live case:
				// plan-only, so the plan's catalog is the only possible source).
				if (!routes || routes.filter((r) => r.status === 200).length < 2) continue;
				// Multi-backend id in a catalog that is not its vendor's = restatement.
				// Checking vendor rather than winner is the point: when the lister IS
				// the current winner the two questions look identical, and that is
				// exactly the case that must still fail — the winner is derived, so
				// listing it duplicates the route table instead of reflecting it.
				assert.ok(
					id.startsWith(provider),
					`${provider}'s catalog lists ${id}, a model it does not own and that ${routes.length} backends serve — remove it and let collectModels() derive the winner from ROUTES`,
				);
			}
		}
	});

	it("every id that a static catalog publishes has a route or a predicate", () => {
		// The looser half of the same coherence check, deliberately warning-shaped:
		// an id absent from ROUTES must still route via the match() predicates, or
		// a vendor rename would strand it.
		const providers = buildProviders(
			{ GLM_API_KEY: "g", OPENROUTER_API_KEY: "o", DEEPSEEK_API_KEY: "d", DASHSCOPE_API_KEY: "q" },
			"claude",
		);
		for (const id of Object.keys(ROUTES)) {
			const routed = rankRoutes(id).length > 0 || providers.some((p) => p.match(id));
			assert.ok(routed, `${id} is in the table but nothing would route it`);
		}
	});
});
