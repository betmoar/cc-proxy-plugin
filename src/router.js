// @ts-check
import { defaultProvider, providerById } from "./providers.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {import("./config.js").Config} Config
 */

/**
 * Resolve which provider to route a request to:
 *   claude-haiku-*  → Claude  (internal ops, pinned)
 *   first match     → that provider (glm-* → GLM, vendor/model → OpenRouter)
 *   no match        → default backend
 *
 * @param {string | undefined} model
 * @param {Config} config
 * @returns {Provider}
 */
export function resolve(model, config) {
	if (typeof model === "string" && model.startsWith("claude-haiku-")) {
		return providerById(config, "claude") || defaultProvider(config);
	}
	const matched = config.providers.find((p) => !p.isDefault && p.match(model));
	return matched || defaultProvider(config);
}
