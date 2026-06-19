// @ts-check
import { buildProviders } from "./providers.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {object} Config
 * @property {number} port
 * @property {Provider[]} providers - the routing registry (see providers.js).
 */

/**
 * Load config from env vars. Claude auth is OAuth passthrough so no Claude key
 * is loaded; the provider registry carries each backend's auth strategy.
 *
 * @param {object} [overrides]
 * @returns {Config}
 */
export function load(overrides = {}) {
	const defaultId = overrides.defaultBackend || process.env.DEFAULT_BACKEND || "claude";
	return {
		port: Number(overrides.port || process.env.PROXY_PORT || 4000),
		providers: buildProviders(process.env, defaultId),
	};
}
