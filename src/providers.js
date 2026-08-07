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
 * A DATED DEEPSEEK build: `deepseek-…-MMDD` / `-YYYYMMDD`. These are the Qwen
 * Token Plan's own spellings for DeepSeek models it resells
 * (`deepseek-v4-flash-0731`), and they exist ONLY there — DeepSeek native 400s
 * them ("The supported API model names are deepseek-v4-pro or
 * deepseek-v4-flash"). A reseller cannot mint an id the origin has never heard
 * of, which is what marks the plan as provisioned capacity, not a broker.
 *
 * SCOPED TO `deepseek-` ON PURPOSE. A bare `/-\d{4}$/` looks tempting and is a
 * credential-leak bug: Anthropic's own ids are dated (`claude-sonnet-4-5-
 * 20250929`), so an unscoped pattern hands the qwen predicate every pinned
 * Claude id — routing the user's OAuth credentials at a third-party backend and
 * breaking invariant 3. It also swallowed `kimi-k2-0711`. Caught by
 * test/router.test.js "dated claude-* ids stay on Claude"; keep the anchor.
 *
 * Deliberately narrow in the other direction too: this is the ONE unambiguous
 * cross-vendor routing signal available today. Bare shared ids
 * (`deepseek-v4-pro`, `glm-5.2`) are served by two backends and need the
 * explicit-prefix scheme instead (CLAUDE.md backlog item 8).
 */
const DATED_ID = /^deepseek-.*-\d{4}(\d{4})?$/;

/**
 * Bare third-party ids the Qwen Token Plan serves that are ALSO reachable on
 * their own vendor's backend, AND whose native route bills metered credits.
 * Plan capacity is prepaid, so spending it is free at the margin — "plan before
 * credits". These route to qwen when `DASHSCOPE_API_KEY` is set.
 *
 * A NATIVE PLAN OUTRANKS A RESOLD PLAN, which is why `glm-5.2` is not here.
 * Z.ai is a GLM Pro plan (`/quota/limit` reports `level=pro`), so routing it to
 * the Qwen plan would swap one prepaid pool for another — no saving — while
 * still paying the resold route's costs: +6 injected tokens, and a deployment
 * one step further from the weights. The rule is plan-before-CREDITS, not
 * plan-before-everything; it only fires where the native route actually meters.
 * DeepSeek native is credits (`/user/balance` shows a topped-up USD figure), so
 * `deepseek-v4-pro` qualifies and `glm-5.2` does not.
 *
 * This is a DELIBERATE break from "a bare id means its own vendor". Two things
 * make it safe: the plan leg only registers when the key is present (a user
 * without the plan is unaffected), and every id here is 200-verified on the
 * plan host. Two things make it visible rather than silent: `/cc-proxy:status`
 * logs the resolved provider per request, and docs/models.html renders the
 * model under Qwen.
 *
 * NOT free of consequence: the plan's gateway injects a preamble, measured at
 * +79 input tokens on `deepseek-v4-pro` and +6 on `glm-5.2` for an identical
 * body (2026-08-04). Same weights, different context — a prompt tuned on the
 * native route can behave differently here. Reaching the native route
 * explicitly needs the prefix scheme (CLAUDE.md backlog item 8).
 *
 * Re-probe before a release: an id that 403s on the plan must come OUT of this
 * set or it becomes a hard failure on a model the user could otherwise reach.
 * `deepseek-v4-flash` is absent for exactly that reason (403 AccessDenied).
 */
// REVERSED for `deepseek-v4-pro` (issue #19): this set is now EMPTY. The bare
// id routes to its native DeepSeek backend, not the Qwen plan. The plan still
// SERVES it and `qwen:deepseek-v4-pro` still works via the selector lens, but
// the default no longer spends plan capacity to avoid metered credits, because
// the plan gateway injects a +79-token preamble that makes the routes
// behaviourally non-interchangeable and the bare id is the one /model sets.
//
// The set is kept (as an empty Set) rather than deleted because the predicate
// machinery below (planResells → deepseek/qwen match()) is still the structure
// for any FUTURE plan-resold id; emptying it is the reversal, removing it would
// also rip out the mechanism. The docstring above describing the policy is
// retained as the record of the reversed decision.
const QWEN_PLAN_RESELLS = new Set(/** @type {string[]} */ ([]));

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
	// "Plan before credits": when the Qwen Token Plan is configured it claims the
	// bare ids it resells (QWEN_PLAN_RESELLS), so prepaid capacity is spent before
	// metered credits. Computed once here and consulted by the glm/deepseek
	// predicates below — WITHOUT the key those predicates are unchanged, so a user
	// who holds no plan sees the original native routing.
	const planResells = env.DASHSCOPE_API_KEY ? (m) => QWEN_PLAN_RESELLS.has(m) : () => false;

	/** @type {Provider[]} */
	const providers = [
		{
			id: "glm",
			baseUrl: "https://api.z.ai/api/anthropic",
			apiKey: env.GLM_API_KEY || "",
			auth: "apiKey",
			// All glm- ids stay here: Z.ai is itself a plan (GLM Pro), and a native
			// plan outranks a resold one — see QWEN_PLAN_RESELLS. planResells() is
			// still consulted so the rule holds if a future GLM id ever becomes
			// credit-billed.
			match: (m) => typeof m === "string" && m.startsWith("glm-") && !planResells(m),
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
			// Bare `deepseek-*` EXCEPT dated ids (`-YYYYMMDD`/`-MMDD` suffix). A dated
			// build is a Qwen-plan-only spelling — `deepseek-v4-flash-0731` 200s there
			// and 400s here ("The supported API model names are deepseek-v4-pro or
			// deepseek-v4-flash"), so claiming it would route a reachable model to a
			// backend that has never heard of it. The two predicates stay disjoint:
			// dated → qwen, bare → deepseek. Verified 2026-08-04; see CLAUDE.md item 8.
			// …and yields the bare ids the plan resells (deepseek-v4-pro) when the
			// plan leg is registered. deepseek-v4-flash is NOT in that set — the
			// plan 403s it — so it keeps routing here.
			match: (m) =>
				typeof m === "string" && m.startsWith("deepseek-") && !DATED_ID.test(m) && !planResells(m),
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
			// Three disjoint claims, no slash ids (those are OpenRouter's):
			//   1. `qwen*` — the plan's own models.
			//   2. DATED third-party builds (`deepseek-v4-flash-0731`) — plan-only
			//      spellings; the origin vendor 400s them, so there is no ambiguity.
			//   3. QWEN_PLAN_RESELLS — bare ids the plan serves whose NATIVE route
			//      bills metered credits ("plan before credits"). Currently just
			//      `deepseek-v4-pro`. `glm-5.2` is served by the plan too but is
			//      NOT here: Z.ai is itself a plan, and a native plan outranks a
			//      resold one.
			// Case 3 is the one that trades a known cost for a saving: the plan's
			// gateway injects a preamble (+79 input tokens on deepseek-v4-pro), so
			// the routes are not interchangeable, and there is currently no spelling
			// that reaches the native one. → CLAUDE.md backlog item 8.
			match: (m) =>
				typeof m === "string" &&
				!m.includes("/") &&
				(m.startsWith("qwen") || DATED_ID.test(m) || QWEN_PLAN_RESELLS.has(m)),
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
 *
 * INVARIANT 1 EXCEPTION (deliberate, like the hop-by-hop drop above):
 * `forceIdentityEncoding` overwrites the client's `accept-encoding` with
 * `identity`. It is set ONLY by the buffered/non-streaming path, which parses
 * the response body to convert a GLM 200-overflow into a 400 and to inject
 * Retry-After on a 1302 429. Those inspections do `JSON.parse` on raw bytes:
 * if a backend ever gzipped them, the parse would fail and both normalizations
 * would silently degrade to passthrough (safe, but broken). The streaming path
 * never passes this — SSE is a pure pipe and must keep negotiating whatever the
 * client asked for.
 *
 * @param {Provider} provider
 * @param {Record<string, any>} sourceHeaders
 * @param {number} bodyLength
 * @param {string} hostname
 * @param {boolean} [forceIdentityEncoding]
 * @returns {Record<string, any>}
 */
export function buildUpstreamHeaders(
	provider,
	sourceHeaders,
	bodyLength,
	hostname,
	forceIdentityEncoding = false,
) {
	const headers = applyAuth(sourceHeaders, provider);
	for (const h of HOP_BY_HOP_HEADERS) delete headers[h];
	headers.host = hostname;
	// Overwrite rather than delete: an absent accept-encoding lets some servers
	// compress by default, and Node's http client would not add one either.
	if (forceIdentityEncoding) headers["accept-encoding"] = "identity";
	headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
	headers["content-length"] = String(bodyLength);
	return headers;
}
