// @ts-check

/**
 * WHICH BACKENDS SERVE WHICH MODEL, and what each one costs to reach.
 *
 * A model id is not a backend. `deepseek-v4-pro` is served by three of them at
 * three different prices; `glm-5.2` by two. Before this table the choice was a
 * hardcoded two-entry Set (`QWEN_PLAN_RESELLS`) consulted by three separate
 * `match()` predicates — correct, but unqueryable and unextendable.
 *
 * The table is COMPLETE, not curated: non-200 probes are recorded rather than
 * omitted, so a route that is known-unavailable is documented and re-probing is
 * a diff instead of a rediscovery. Probed 2026-08-04 (see CLAUDE.md backlog
 * item 8 for the raw matrix).
 *
 * It is also NOT authoritative. An id absent here falls through to the provider
 * `match()` predicates and still routes — never a hard failure. That matters
 * because vendor ids rename (`deepseek-v4-flash` is expected to), and a table
 * that could strand a model on rename would be worse than no table.
 */

/**
 * @typedef {object} Route
 * @property {string} provider - provider id, must exist in the registry
 * @property {number} status - what the live probe returned (200 = usable)
 * @property {"plan" | "credits"} [billing] - overrides the provider default
 */

/**
 * How each backend bills, which is the axis the cost rank is built on. This is
 * a SEPARATE axis from distance-to-the-weights: the Qwen plan is a contracted
 * first-party arrangement (it mints ids DeepSeek has never heard of), so it is
 * near the weights AND cheap, while DeepSeek's own endpoint is near the weights
 * and expensive. Do not read one off the other.
 *
 * Verified against each provider's own quota/balance endpoint (2026-08-04):
 * Z.ai `/quota/limit` → level=pro; Qwen → prepaid, no balance endpoint at all;
 * Claude → OAuth, no meter; DeepSeek `/user/balance` → topped-up USD;
 * OpenRouter `/credits` → remaining USD.
 */
/** @type {Record<string, string>} */
export const PROVIDER_BILLING = {
	claude: "oauth-plan",
	glm: "plan",
	qwen: "plan",
	deepseek: "credits",
	openrouter: "reseller",
};

/**
 * Cost rank. Lower is cheaper to reach. Sunk plan capacity beats marginal spend.
 * @type {Record<string, number>}
 */
const BILLING_TIER = {
	"oauth-plan": 1,
	plan: 2,
	credits: 3,
	reseller: 4,
};

const DEFAULT_TIER = 3;

/**
 * Tier of an (id, backend) PAIR — never of a provider alone. A route may carry
 * its own `billing` so a plan-tier provider that later exposes a credit-billed
 * API is expressible without reclassifying the whole backend.
 *
 * @param {string} providerId
 * @param {Route} [route]
 * @returns {number} 1..4
 */
export function tierOf(providerId, route) {
	const billing = route?.billing || PROVIDER_BILLING[providerId];
	return BILLING_TIER[billing] ?? DEFAULT_TIER;
}

/**
 * The probed matrix. Single-backend ids are listed too — the point is to see
 * the pattern, including where a model has exactly one way in.
 *
 * @type {Record<string, Route[]>}
 */
export const ROUTES = {
	// --- served by more than one backend: the reason this file exists ---
	// `deepseek-v4-pro` (issue #19): the NATIVE backend (deepseek) sorts FIRST
	// even though the Qwen plan is the cheaper tier (2 < 3), because rankRoutes
	// ranks NATIVE above tier. The plan gateway injects a +79-token preamble, so
	// the plan and native routes are behaviourally non-interchangeable, and the
	// bare id is the one /model sets — defaulting it to the plan silently
	// rerouted a user who had tuned a prompt against native weights. The plan
	// route stays 200 here (the catalog lists it, the probe is real, and it is
	// the route a plan-holder WITHOUT a native DeepSeek key lands on — see the
	// "native-first, then cheapest" sort in rankRoutes). glm-5.2 is unaffected:
	// it already resolved native via the tiebreak (both backends tier 2).
	"deepseek-v4-pro": [
		{ provider: "qwen", status: 200 },
		{ provider: "deepseek", status: 200 },
		{ provider: "openrouter", status: 200 },
	],
	// The plan 403s this one (AccessDenied), so it has no cheap route.
	"deepseek-v4-flash": [
		{ provider: "qwen", status: 403 },
		{ provider: "deepseek", status: 200 },
		{ provider: "openrouter", status: 200 },
	],
	// Plan-only id: DeepSeek native 400s it ("id unknown"). This asymmetry is
	// what establishes the plan as first-party rather than a reseller.
	"deepseek-v4-flash-0731": [
		{ provider: "qwen", status: 200 },
		{ provider: "deepseek", status: 400 },
	],
	// Two PLAN routes. Tie broken toward native (glm) — swapping one prepaid
	// pool for another buys nothing and costs +6 injected tokens.
	"glm-5.2": [
		{ provider: "glm", status: 200 },
		{ provider: "qwen", status: 200 },
	],
	"glm-5.1": [
		{ provider: "glm", status: 200 },
		{ provider: "qwen", status: 403 },
	],
	"glm-5": [
		{ provider: "glm", status: 200 },
		{ provider: "qwen", status: 403 },
	],

	// --- single-backend ids, recorded for completeness ---
	"glm-5-turbo": [{ provider: "glm", status: 200 }],
	"glm-4.7": [{ provider: "glm", status: 200 }],
	"glm-4.6": [{ provider: "glm", status: 200 }],
	"glm-4.5": [{ provider: "glm", status: 200 }],
	"glm-4.5-air": [{ provider: "glm", status: 200 }],

	"qwen3.8-max": [{ provider: "qwen", status: 200 }],
	"qwen3.8-max-preview": [{ provider: "qwen", status: 200 }],
	"qwen3.7-max": [{ provider: "qwen", status: 200 }],
	"qwen3.7-plus": [{ provider: "qwen", status: 200 }],
	"qwen3.6-flash": [{ provider: "qwen", status: 200 }],

	"claude-fable-5": [{ provider: "claude", status: 200 }],
	"claude-opus-5": [{ provider: "claude", status: 200 }],
	"claude-sonnet-5": [{ provider: "claude", status: 200 }],
};

/**
 * Usable backends for a model, in routing preference order.
 *
 * Sort key, in precedence: (1) NATIVE provider first, (2) then cheapest tier,
 * (3) then declaration order. The native override is the issue-#19 rule:
 * when a model is reachable through both its own vendor's backend AND a
 * resold one, the native route wins EVEN IF the resold route is the cheaper
 * tier, because a resold gateway may inject a preamble (`deepseek-v4-pro` on
 * the Qwen plan measures +79 input tokens) that makes the routes
 * behaviourally non-interchangeable — and the bare id is the one `/model`
 * sets, so a user who tuned against native weights must not be silently
 * rerouted. Behavioural predictability beats marginal cost.
 *
 * This is a deliberate STRENGTHENING of the pre-#19 rule, which only broke
 * tier TIES toward native. Promoting native above tier flips exactly one id
 * (`deepseek-v4-pro`: native deepseek tier 3 now beats plan qwen tier 2);
 * every other multi-route id already resolved native (`glm-5.2` tied at
 * tier 2 and the tiebreak won; `deepseek-v4-flash` and `glm-5.1/5` are native
 * by default since the plan 403s them). When NATIVE IS NOT REGISTERED (a
 * plan-holder without a DeepSeek key), `resolve()` skips the deepseek route
 * and falls to the next-ranked one — qwen — so the plan stays reachable.
 *
 * `Object.hasOwn` rather than a bare lookup: a vendor id of `__proto__` or
 * `constructor` would otherwise inherit from Object.prototype and hand back a
 * non-array (the same trap `withContextWindow` guards in src/models.js).
 *
 * @param {string | undefined} model
 * @returns {Route[]} empty when the id is not in the table
 */
export function rankRoutes(model) {
	if (typeof model !== "string" || !Object.hasOwn(ROUTES, model)) return [];
	return ROUTES[model]
		.filter((r) => r.status === 200)
		.map((r, i) => ({ route: r, i, native: model.startsWith(r.provider) }))
		.sort((a, b) => {
			if (a.native !== b.native) return a.native ? -1 : 1; // native wins outright (issue #19)
			const byTier = tierOf(a.route.provider, a.route) - tierOf(b.route.provider, b.route);
			if (byTier !== 0) return byTier;
			return a.i - b.i; // stable: declaration order
		})
		.map((x) => x.route);
}
