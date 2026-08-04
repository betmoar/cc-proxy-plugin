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

	// DeepSeek speaks an Anthropic-compatible "skin" at /anthropic with x-api-key auth
	// (same as GLM). Opt-in: only registered when a key is present. Its model ids are bare
	// (`deepseek-v4-pro`, `deepseek-v4-flash`) — no slash — so the deepseek- prefix is
	// disjoint from OpenRouter's vendor/model ids (e.g. `deepseek/deepseek-v4-pro`). No
	// quirks: DeepSeek has no Z.ai-style 1313 flag or 200-stop_reason overflow signal.
	if (env.DEEPSEEK_API_KEY) {
		providers.push({
			id: "deepseek",
			baseUrl: "https://api.deepseek.com/anthropic",
			apiKey: env.DEEPSEEK_API_KEY,
			auth: "apiKey",
			match: (m) => typeof m === "string" && m.startsWith("deepseek-"),
		});
	}

	// Qwen (QwenCloud / Aliyun Model Studio) speaks an Anthropic-compatible "skin"
	// at /apps/anthropic with Bearer auth (the docs' ANTHROPIC_AUTH_TOKEN →
	// Authorization: Bearer). Opt-in: only registered when a key is present. Its model
	// ids are bare and start with `qwen` (e.g. `qwen3.7-max`, `qwen3.6-flash`) — note
	// there is no dash after `qwen`. The `!includes("/")` keeps the predicate disjoint
	// from OpenRouter's slash-namespaced space: `qwen/qwen3.7-max` (if OpenRouter
	// advertised it) belongs to OpenRouter, not Qwen, mirroring how DeepSeek's
	// `deepseek-` trailing dash naturally excludes `deepseek/...`.
	//
	// The base URL is PLAN-SPECIFIC and deliberately not the one in QwenCloud's
	// public docs. Those document `https://dashscope-intl.aliyuncs.com/apps/anthropic`;
	// a Token Plan key is bound to the per-plan MaaS host shown in the account
	// dashboard, and the documented host rejects it outright ("invalid api-key",
	// 403 — verified live 2026-08-04 against all of qwen3.7-max/3.6-plus/3.7-plus).
	// Every QwenCloud plan is host-bound and there is no universal endpoint:
	// Coding Plan lives on `coding-intl.dashscope.aliyuncs.com/apps/anthropic`
	// (`sk-sp-` keys), general/pay-as-you-go on `dashscope-intl.aliyuncs.com`.
	// Do NOT "correct" this to the documented URL — worse than a 403, QwenCloud's
	// own FAQ warns that a general key on a general host silently bills
	// pay-as-you-go *on top of* the plan rather than erroring. Note also: the path must end at
	// `/apps/anthropic` with no trailing `/v1` — clients auto-append, and the extra
	// segment yields `/v1/v1/messages` → 404.
	//
	// No quirks: Qwen has no Z.ai-style 1313 flag or 200-stop_reason overflow signal.
	if (env.DASHSCOPE_API_KEY) {
		providers.push({
			id: "qwen",
			baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
			apiKey: env.DASHSCOPE_API_KEY,
			auth: "bearer",
			match: (m) => typeof m === "string" && m.startsWith("qwen") && !m.includes("/"),
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
	// Drop BOTH inbound credential headers, not just authorization: when Claude
	// Code authenticates with ANTHROPIC_API_KEY it sends `x-api-key`, and
	// forwarding it to a third-party backend (the bearer path doesn't overwrite
	// it) would leak the user's Anthropic key off-platform.
	const { authorization: _drop, "x-api-key": _dropKey, ...rest } = sourceHeaders;
	if (provider.auth === "bearer") {
		return { ...rest, authorization: `Bearer ${provider.apiKey}` };
	}
	return { ...rest, "x-api-key": provider.apiKey };
}

// Hop-by-hop headers (RFC 9110 §7.6.1) describe the inbound connection, not the
// request, and must not be forwarded. The critical one is transfer-encoding: the
// proxy always sends a fully-buffered body with an exact content-length, so an
// inbound `Transfer-Encoding: chunked` forwarded alongside it trips upstream
// request-smuggling protections (bare 400 before the request reaches a handler).
const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

/**
 * Build the outbound header set for an upstream request: auth applied,
 * hop-by-hop headers dropped, host rewritten, anthropic-version defaulted,
 * content-length set.
 * @param {Provider} provider
 * @param {Record<string, any>} sourceHeaders
 * @param {number} bodyLength
 * @param {string} hostname
 * @returns {Record<string, any>}
 */
export function buildUpstreamHeaders(provider, sourceHeaders, bodyLength, hostname) {
	const headers = applyAuth(sourceHeaders, provider);
	for (const h of HOP_BY_HOP_HEADERS) delete headers[h];
	headers.host = hostname;
	headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
	headers["content-length"] = String(bodyLength);
	return headers;
}
