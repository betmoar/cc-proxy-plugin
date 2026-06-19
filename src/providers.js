// @ts-check

/**
 * @typedef {"oauth" | "apiKey" | "bearer"} AuthStrategy
 *   - oauth:  passthrough the inbound Authorization header (Claude Pro/Max).
 *   - apiKey: drop Authorization, set `x-api-key: <apiKey>` (Z.ai Anthropic endpoint).
 *   - bearer: drop Authorization, set `Authorization: Bearer <apiKey>` (OpenRouter).
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {AuthStrategy} auth
 * @property {(model: string | undefined) => boolean} match
 * @property {boolean} [isDefault]
 */

/**
 * Build the provider registry from the environment. Order matters: `resolve()`
 * picks the first non-default provider whose `match()` returns true, falling
 * back to the default provider. Adding a backend (e.g. OpenRouter) is one entry
 * here — no changes to the router or server.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [defaultId] - which provider id is the fallback/default tier.
 * @returns {Provider[]}
 */
export function buildProviders(env = process.env, defaultId = env.DEFAULT_BACKEND || "claude") {
	/** @type {Provider[]} */
	const providers = [
		{
			id: "glm",
			baseUrl: "https://api.z.ai/api/anthropic",
			apiKey: env.GLM_API_KEY || "",
			auth: "apiKey",
			match: (m) => typeof m === "string" && m.startsWith("glm-"),
		},
	];

	// OpenRouter speaks the Anthropic "Skin" at /api/v1/messages with Bearer
	// auth. Opt-in: only registered when a key is present. Its model ids are
	// vendor-namespaced (e.g. `anthropic/claude-opus-4`, `z-ai/glm-4.7`), so a
	// slash distinguishes them from the bare glm-*/claude- ids above. No quirks:
	// OpenRouter has no Z.ai-style 1313 flag or 200-stop_reason overflow signal.
	if (env.OPENROUTER_API_KEY) {
		providers.push({
			id: "openrouter",
			baseUrl: "https://openrouter.ai/api",
			apiKey: env.OPENROUTER_API_KEY,
			auth: "bearer",
			match: (m) => typeof m === "string" && m.includes("/"),
		});
	}

	providers.push({
		id: "claude",
		baseUrl: "https://api.anthropic.com",
		apiKey: "",
		auth: "oauth",
		match: (m) => typeof m === "string" && m.startsWith("claude-"),
	});

	for (const p of providers) p.isDefault = p.id === defaultId;
	return providers;
}

/**
 * @param {{ providers: Provider[] }} config
 * @returns {Provider}
 */
export function defaultProvider(config) {
	return (
		config.providers.find((p) => p.isDefault) ||
		config.providers.find((p) => p.id === "claude") ||
		config.providers[config.providers.length - 1]
	);
}

/**
 * @param {{ providers: Provider[] }} config
 * @param {string} id
 * @returns {Provider | undefined}
 */
export function providerById(config, id) {
	return config.providers.find((p) => p.id === id);
}

/**
 * Apply a provider's auth strategy to a copy of the inbound headers.
 * @param {Record<string, any>} sourceHeaders
 * @param {Provider} provider
 * @returns {Record<string, any>}
 */
export function applyAuth(sourceHeaders, provider) {
	if (provider.auth === "oauth") return { ...sourceHeaders };
	const { authorization: _drop, ...rest } = sourceHeaders;
	if (provider.auth === "bearer") {
		return { ...rest, authorization: `Bearer ${provider.apiKey}` };
	}
	return { ...rest, "x-api-key": provider.apiKey };
}

/**
 * Build the outbound header set for an upstream request: auth applied, host
 * rewritten, anthropic-version defaulted, content-length set.
 * @param {Provider} provider
 * @param {Record<string, any>} sourceHeaders
 * @param {number} bodyLength
 * @param {string} hostname
 * @returns {Record<string, any>}
 */
export function buildUpstreamHeaders(provider, sourceHeaders, bodyLength, hostname) {
	const headers = applyAuth(sourceHeaders, provider);
	headers.host = hostname;
	headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
	headers["content-length"] = String(bodyLength);
	return headers;
}
