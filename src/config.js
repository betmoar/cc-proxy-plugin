// @ts-check
import { buildProviders } from "./providers.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host - interface the server binds to (loopback by default).
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
		// Loopback by default: the proxy injects API keys and forwards OAuth, so it
		// must not be reachable from the LAN. PROXY_HOST is an explicit opt-out.
		host: overrides.host || process.env.PROXY_HOST || "127.0.0.1",
		providers: buildProviders(process.env, defaultId),
	};
}
