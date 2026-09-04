// @ts-check
import fs from "node:fs";
import {
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
	parseOpenRouterModels,
} from "./models.js";
import { buildProviders } from "./providers.js";

/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host - interface the server binds to (loopback by default).
 * @property {string} [authToken] - PROXY_AUTH_TOKEN; when set, every request
 *   except GET /_ping and /_status must present it (issue #45). Unset means no
 *   auth — the loopback bind (invariant 7) is then the only access control.
 * @property {Provider[]} providers - the routing registry (see providers.js).
 * @property {string} [version] - plugin version, reported on /_status so the
 *   SessionStart hook can detect (and replace) a stale running proxy.
 * @property {import("./models.js").ModelEntry[]} [claudeModels] - static Claude discovery list.
 * @property {import("./models.js").ModelEntry[]} [qwenModels] - static Qwen discovery list (Qwen has no /models endpoint).
 * @property {import("./models.js").ModelEntry[]} [openRouterModels] - offline fallback for the live OpenRouter fetch, or the explicit set when OPENROUTER_MODELS is configured.
 * @property {boolean} [openRouterModelsExplicit] - true when OPENROUTER_MODELS named a set, which suppresses the live fetch.
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
		// Issue #45: optional bearer/api-key gate for the PROXY_HOST=0.0.0.0
		// opt-out. Unset keeps every existing install byte-identical.
		authToken: overrides.authToken || process.env.PROXY_AUTH_TOKEN || undefined,
		providers: buildProviders(process.env, defaultId),
		version: packageVersion(),
		claudeModels: DEFAULT_CLAUDE_MODELS.filter((m) => m?.id),
		qwenModels: DEFAULT_QWEN_MODELS.filter((m) => m?.id),
		// OpenRouter's catalog is fetched LIVE (~400 ids, public endpoint, no auth).
		// This list is the offline fallback for that fetch — or, when
		// OPENROUTER_MODELS is set, the explicit set the user asked for, in which
		// case the fetch is skipped rather than merged. Hence the separate flag: the
		// entries alone cannot say whether they are a preference or a fallback.
		openRouterModelsExplicit: parseOpenRouterModels(process.env.OPENROUTER_MODELS).length > 0,
		openRouterModels: (() => {
			const parsed = parseOpenRouterModels(process.env.OPENROUTER_MODELS);
			return (parsed.length ? parsed : DEFAULT_OPENROUTER_MODELS).filter((m) => m?.id);
		})(),
		modelsTimeoutMs: Number(overrides.modelsTimeoutMs || 3000),
	};
}
