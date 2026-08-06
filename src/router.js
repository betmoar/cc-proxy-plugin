// @ts-check
import { defaultProvider, providerById } from "./providers.js";
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
 * to the cheapest route and the slash form already resolves to the most
 * expensive one (`qwen3.7-max` → qwen plan, `qwen/qwen3.7-max` → OpenRouter).
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
 * @param {Config} config
 * @returns {{ providerId: string | null, model: string | undefined }}
 */
export function parseModelSelector(model, config) {
	if (typeof model !== "string") return { providerId: null, model };
	const colon = model.indexOf(":");
	if (colon <= 0) return { providerId: null, model };
	const head = model.slice(0, colon);
	const tail = model.slice(colon + 1);
	if (!tail) return { providerId: null, model };
	const known = config.providers?.some((p) => p.id === head);
	return known ? { providerId: head, model: tail } : { providerId: null, model };
}

/**
 * Resolve which provider to route a request to, and which model id to send it
 * under:
 *   0. strip a `<provider>:` selector       → the lens never leaves the proxy
 *   1. claude-haiku-*                       → Claude (internal ops, pinned)
 *   2. explicit selector, if registered     → that provider
 *   3. cheapest probed route (src/routes.js)
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

	if (typeof tail === "string" && tail.startsWith("claude-haiku-")) {
		return {
			provider: providerById(config, "claude") || defaultProvider(config),
			upstreamModel: tail,
		};
	}

	const selected = providerId ? providerById(config, providerId) : undefined;
	if (selected) return { provider: selected, upstreamModel: tail };

	// An unregistered selector already fell through above; from here the tail is
	// routed exactly as a bare id would be.
	for (const route of rankRoutes(tail)) {
		const p = providerById(config, route.provider);
		if (p) return { provider: p, upstreamModel: tail };
	}

	const matched = config.providers.find((p) => !p.isDefault && p.match(tail));
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
