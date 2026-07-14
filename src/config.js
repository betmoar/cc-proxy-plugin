// @ts-check
import fs from "node:fs";
import {
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	parseOpenRouterModels,
} from "./models.js";
import { buildProviders } from "./providers.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host - interface the server binds to (loopback by default).
 * @property {Provider[]} providers - the routing registry (see providers.js).
 * @property {string} [version] - plugin version, reported on /_status so the
 *   SessionStart hook can detect (and replace) a stale running proxy.
 * @property {import("./models.js").ModelEntry[]} [claudeModels] - static Claude discovery list.
 * @property {import("./models.js").ModelEntry[]} [openRouterModels] - OpenRouter allowlist for discovery.
 * @property {number} [modelsTimeoutMs] - per-leg timeout for the /v1/models fan-out.
 */

/** @returns {string | undefined} */
function packageVersion() {
	try {
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

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
		version: packageVersion(),
		claudeModels: DEFAULT_CLAUDE_MODELS.filter((m) => m?.id),
		openRouterModels: (() => {
			const parsed = parseOpenRouterModels(process.env.OPENROUTER_MODELS);
			return (parsed.length ? parsed : DEFAULT_OPENROUTER_MODELS).filter((m) => m?.id);
		})(),
		modelsTimeoutMs: Number(overrides.modelsTimeoutMs || 3000),
	};
}
