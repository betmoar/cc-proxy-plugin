// @ts-check
import { PROVIDER_IDS, defaultProvider, providerById } from "./providers.js";
import { rankRoutes } from "./routes.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {import("./config.js").Config} Config
 */

/**
 * Split a `<provider>:<model>` selector — cc-proxy's LOCAL LENS for naming one
 * route when a model is reachable through several.
 *
 * COLON ONLY, deliberately. `/` belongs to OpenRouter's `includes("/")`
 * predicate and keeps meaning OpenRouter forever. A slash selector was
 * considered and dropped because it buys nothing: the bare id already resolves
 * to the native backend when one is registered, otherwise the cheapest route
 * serving it — and the slash form already resolves to the most expensive one
 * (`qwen3.7-max` → qwen plan, `qwen/qwen3.7-max` → OpenRouter).
 * Its one unique job — naming a plan-resold id under a foreign vendor name —
 * is served identically by `qwen:deepseek-v4-pro`, without touching the
 * aggregator's namespace and without breaking the collision-lock tests.
 *
 * The tail KEEPS any slash it carries, so `openrouter:tencent/hy3` yields
 * `tencent/hy3` — the id the aggregator actually expects.
 *
 * Only REGISTERED provider ids are selectors. An unknown prefix is not an
 * error; it simply isn't a selector, and the whole string falls through to the
 * predicates — which is what keeps a future vendor id containing a colon safe.
 *
 * @param {string | undefined} model
 * @param {Config} [_config] Unused since the strip moved off registration onto
 *   PROVIDER_IDS (see below). Kept so the signature stays stable for callers
 *   and tests that already pass a config.
 * @returns {{ providerId: string | null, model: string | undefined }}
 */
export function parseModelSelector(model, _config) {
	if (typeof model !== "string") return { providerId: null, model };
	const colon = model.indexOf(":");
	if (colon <= 0) return { providerId: null, model };
	const head = model.slice(0, colon);
	const tail = model.slice(colon + 1);
	if (!tail) return { providerId: null, model };
	// KNOWN, not REGISTERED. The lens is cc-proxy's own spelling, so it must be
	// stripped whenever it names a provider this proxy can spell — even one
	// holding no key today. Testing `config.providers` instead leaked the raw
	// string upstream the moment GLM became opt-in (issue #20): with no GLM key
	// `glm:glm-5.2` went unrecognized, the tail was never stripped, and the
	// literal lens reached Anthropic as a model id. `resolve()` then routes the
	// stripped tail exactly as a bare id, which is the documented fallback.
	return PROVIDER_IDS.has(head) ? { providerId: head, model: tail } : { providerId: null, model };
}

/**
 * Drop a trailing `[...]` VARIANT SUFFIX from a model id for ROUTING PURPOSES.
 *
 * Claude Code spells a long-context variant `glm-5.2[1m]` — the form
 * `ANTHROPIC_CUSTOM_MODEL_OPTION` registers and `/model` shows. Today CC strips
 * it before the wire (24070 routing lines in this machine's proxy log, 0
 * carrying a suffix), so nothing here is reachable through CC. This is a
 * hardening guard against that internal drifting, not a live defect — issue #34.
 *
 * Three routing lookups are EXACT-MATCH and every one of them is defeated by a
 * suffix, silently sending a shared id to the wrong backend:
 *   - `ROUTES` (routes.js) — `Object.hasOwn` on the raw id → `rankRoutes` = []
 *   - `QWEN_PLAN_RESELLS` (providers.js) — `Set.has` on the raw id
 *   - `DATED_ID` (providers.js) — anchored `$`, so `…-0731[1m]` fails the test
 * The exposure is a SHARED id whose only non-native route is the Qwen plan: with
 * no GLM key, `glm-5.2[1m]` has no route-table entry and no predicate claims it,
 * so it falls to Claude — a plan-only user's headline model silently changes
 * backend with no error.
 *
 * Stripped ONCE here rather than at the three sites, because a per-site patch
 * fixes the two the issue named and leaves DATED_ID broken. `resolve()` then
 * routes on the stripped id and forwards the RAW one: the suffix is Claude
 * Code's spelling, and today Z.ai accepts it, so rewriting `upstreamModel` would
 * change what the vendor receives — a bigger change than the bug being fixed.
 *
 * WELL-FORMED ONLY, and never to empty. A single bracket pair holding no
 * brackets is CC's shape; `glm-5.2[`, `glm-5.2[a[b]` and a bare `[1m]` are not,
 * and route raw exactly as they do today rather than being coerced into an id.
 *
 * @param {string} model
 * @returns {string} the id without its variant suffix, or unchanged
 */
export function stripVariantSuffix(model) {
	const m = /^(.+)\[[^[\]]*\]$/.exec(model);
	return m ? m[1] : model;
}

/**
 * Resolve which provider to route a request to, and which model id to send it
 * under:
 *   0. strip a `<provider>:` selector       → the lens never leaves the proxy
 *   0b. strip a trailing `[1m]`-style suffix → ROUTING ONLY; upstream gets it back
 *   1. claude-haiku-*                       → Claude (internal ops, pinned)
 *   2. explicit selector, if registered     → that provider
 *   3. ranked probed route (src/routes.js)  → native provider first, then
 *                                              cheapest tier, among REGISTERED
 *                                              providers only
 *   4. first matching predicate             → glm-* → GLM, vendor/model → OpenRouter
 *   5. no match                             → default backend
 *
 * STEP 1 TESTS THE STRIPPED TAIL AND OUTRANKS THE SELECTOR. Pinning on the raw
 * string would let `glm:claude-haiku-…` skip the pin, and the body rewrite
 * would then send the BARE haiku id to a third party — Claude Code's internal
 * ops (titles, summaries) billed against paid quota. That is invariant 4, not a
 * preference, so a haiku tail discards any selector rather than honoring it.
 *
 * @param {string | undefined} model
 * @param {Config} config
 * @returns {{ provider: Provider, upstreamModel: string | undefined }}
 */
export function resolve(model, config) {
	const { providerId, model: tail } = parseModelSelector(model, config);

	// Every routing decision below reads `routeId`; every return sends `tail`.
	// That split is the whole fix for issue #34 — see stripVariantSuffix().
	const routeId = typeof tail === "string" ? stripVariantSuffix(tail) : tail;

	if (typeof routeId === "string" && routeId.startsWith("claude-haiku-")) {
		return {
			provider: providerById(config, "claude") || defaultProvider(config),
			upstreamModel: tail,
		};
	}

	const selected = providerId ? providerById(config, providerId) : undefined;
	if (selected) return { provider: selected, upstreamModel: tail };

	// An unregistered selector already fell through above; from here the tail is
	// routed exactly as a bare id would be.
	for (const route of rankRoutes(routeId)) {
		const p = providerById(config, route.provider);
		if (p) return { provider: p, upstreamModel: tail };
	}

	const matched = config.providers.find((p) => !p.isDefault && p.match(routeId));
	return { provider: matched || defaultProvider(config), upstreamModel: tail };
}

/**
 * Provider-only convenience for callers that never forward a request (the
 * listing tools, tests), so their call sites don't destructure a field they
 * would immediately discard.
 *
 * @param {string | undefined} model
 * @param {Config} config
 * @returns {Provider}
 */
export function resolveProvider(model, config) {
	return resolve(model, config).provider;
}
