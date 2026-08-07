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
 * @property {boolean} [default=true] - false = probe RECORDED but never an
 *   auto-pick. A backend may genuinely SERVE a foreign id (so its catalog lists
 *   it, and the route is honestly probed) yet not be the route the bare id
 *   resolves to. Such a route is reachable only via the `<provider>:` selector,
 *   which bypasses rankRoutes. Recording it (rather than omitting) keeps the
 *   probe matrix complete and the catalog↔routing coherence check honest, while
 *   `default: false` stops rankRoutes from ever sorting it into the auto-pick.
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
	// REVERSED for `deepseek-v4-pro` (issue #19): the bare id now routes to the
	// NATIVE DeepSeek backend, not the Qwen plan. The plan still SERVES it — the
	// 200 probe is RECORDED so the catalog↔routing coherence check stays honest
	// and the probe matrix stays complete — but `default: false` stops rankRoutes
	// from ever sorting the qwen route into the auto-pick. It is reachable only
	// via the `qwen:` selector (which bypasses rankRoutes), and still appears on
	// Qwen's discovery card as a foreign id under the lens.
	//
	// Why the default flipped: the plan gateway injects a +79-token preamble, so
	// the two routes are behaviourally non-interchangeable, and the bare id is
	// the one /model sets — defaulting it to the plan silently reroutes a user
	// who tuned a prompt against native weights. glm-5.2 (below) is UNAFFECTED:
	// it ties at tier 2 on both backends and the native tiebreak wins, so its
	// bare id already means native. deepseek-v4-pro does NOT tie — its tiers
	// differ (plan 2 vs credits 3) — which is exactly why only it needed the
	// `default: false` flag.
	"deepseek-v4-pro": [
		{ provider: "qwen", status: 200, default: false },
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
 * Usable backends for a model, cheapest first.
 *
 * Ties break toward the NATIVE provider — the one whose id prefixes the model
 * id. That reproduces "a native plan outranks a resold plan" (`glm-5.2` stays
 * on Z.ai) as a consequence of the ordering rather than a special case.
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
	return (
		ROUTES[model]
			// `default: false` routes are probed-and-recorded but excluded from the
			// auto-pick — reachable only via the `<provider>:` selector. See the
			// deepseek-v4-pro qwen route (issue #19): the plan serves it, but the
			// bare id must resolve native, so it never sorts into the default ranking.
			.filter((r) => r.status === 200 && r.default !== false)
			.map((r, i) => ({ route: r, i, native: model.startsWith(r.provider) }))
			.sort((a, b) => {
				const byTier = tierOf(a.route.provider, a.route) - tierOf(b.route.provider, b.route);
				if (byTier !== 0) return byTier;
				if (a.native !== b.native) return a.native ? -1 : 1;
				return a.i - b.i; // stable: declaration order
			})
			.map((x) => x.route)
	);
}
