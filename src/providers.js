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
 * explicit-prefix scheme instead (docs/BACKLOG.md item 8).
 */
const DATED_ID = /^deepseek-.*-\d{4}(\d{4})?$/;

/**
 * Bare third-party ids the Qwen Token Plan serves that are ALSO reachable on
 * their own vendor's backend, AND whose native route bills metered credits.
 * Plan capacity is prepaid, so spending it is free at the margin — "plan before
 * credits". These MAY route to qwen when `DASHSCOPE_API_KEY` is set — but since
 * issue #19 (0.6.1) `deepseek-v4-pro` is native-first: a registered DeepSeek
 * key wins the bare id via `rankRoutes`, and this predicate only fires as the
 * fallback when no native route is registered. See the ISSUE #19 note below.
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
 * native route can behave differently here. The prefix scheme (docs/BACKLOG.md
 * item 8) shipped in 0.6.0: `deepseek:deepseek-v4-pro` always reaches
 * the native route explicitly, and — since issue #19 — so does the bare id
 * whenever a DeepSeek key is registered; `qwen:deepseek-v4-pro` reaches the
 * plan copy explicitly either way.
 *
 * Re-probe before a release: an id that 403s on the plan must come OUT of this
 * set or it becomes a hard failure on a model the user could otherwise reach.
 * `deepseek-v4-flash` is absent for exactly that reason (403 AccessDenied).
 */
// ISSUE #19: this set STILL CLAIMS `deepseek-v4-pro` for the qwen predicate —
// the plan genuinely serves it, and the predicate is the last-resort router
// (router.js step 4) that fires only when no ranked route is registered. The
// DEFAULT changed (the bare id now resolves native via rankRoutes' native-first
// sort), but the predicate's job is capability, not preference: it must keep
// claiming the id so a plan-holder WITHOUT a native DeepSeek key still routes
// to the plan rather than falling to the default backend. The two are layered:
// rankRoutes expresses "prefer native"; the predicate expresses "the plan can
// serve this"; they don't conflict because rankRoutes runs first and its
// native-first ordering already lands a plan-holder on qwen when deepseek is
// absent. See the QWEN_PLAN_RESELLS docstring above for the billing rationale.
const QWEN_PLAN_RESELLS = new Set(["deepseek-v4-pro"]);

/**
 * Every provider id this proxy knows how to spell, registered or not.
 *
 * `<provider>:` is cc-proxy's LOCAL lens — no backend has heard of it — so it
 * must be stripped from an outbound body whether or not that backend currently
 * holds a key. Gating the strip on REGISTRATION (which is what
 * `config.providers` describes) leaked the raw `glm:glm-5.2` upstream once GLM
 * became opt-in: with no GLM key the selector went unrecognized, the tail was
 * never stripped, and the literal lens string was forwarded to Anthropic. The
 * spelling is a static fact about this proxy; whether the backend is usable is
 * a separate question that `resolve()` answers by skipping unregistered routes.
 *
 * @type {ReadonlySet<string>}
 */
export const PROVIDER_IDS = new Set(["glm", "openrouter", "deepseek", "qwen", "claude"]);

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
	// bare ids it resells (QWEN_PLAN_RESELLS = {deepseek-v4-pro}), so prepaid
	// capacity is spent before metered credits.
	//
	// The set holds only ids the plan resells, so no glm-* id can ever be in it:
	// Z.ai is itself a plan (GLM Pro), and a native plan outranks a resold one —
	// which is why `glm-5.2` stays on Z.ai and is NOT claimed here. The glm
	// predicate still consults planResells so that rule is enforced by code
	// rather than by the set happening to be empty of glm ids.
	//
	// Since issue #19 (0.6.1) the deepseek predicate deliberately does NOT
	// consult it: rankRoutes now sorts the native provider above tier, so a
	// DeepSeek-key holder gets native and a plan-only holder still falls through
	// to qwen. See that predicate's comment.
	const planResells = env.DASHSCOPE_API_KEY ? (m) => QWEN_PLAN_RESELLS.has(m) : () => false;

	/** @type {Provider[]} */
	const providers = [];

	// GLM was the original single backend, but it's third-party like OpenRouter/
	// DeepSeek/Qwen below — opt-in: only registered when a key is present. Claude
	// (OAuth, no key) is the structural default, so a zero-key proxy is a working
	// proxy, not a degraded one. Issue #20.
	if (env.GLM_API_KEY) {
		providers.push({
			id: "glm",
			baseUrl: "https://api.z.ai/api/anthropic",
			apiKey: env.GLM_API_KEY,
			auth: "apiKey",
			// All glm- ids stay here: Z.ai is itself a plan (GLM Pro), and a native
			// plan outranks a resold one — see QWEN_PLAN_RESELLS. planResells() is
			// still consulted so the rule holds if a future GLM id ever becomes
			// credit-billed.
			match: (m) => typeof m === "string" && m.startsWith("glm-") && !planResells(m),
		});
	}

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
			// dated → qwen, bare → deepseek. Verified 2026-08-04; see docs/BACKLOG.md item 8.
			// NO `!planResells(m)` here — issue #19 (0.6.1) deliberately drops it.
			// Registry order (glm, openrouter, deepseek, qwen, claude) then makes
			// this predicate agree with rankRoutes' native-first sort: both this
			// predicate and qwen's below claim `deepseek-v4-pro`, `providers.find()`
			// hits this one first (native wins when a DeepSeek key exists), and a
			// plan-only user simply never gets this entry registered, so qwen's
			// claim below is what fires for them. Before #19 the `!planResells(m)`
			// guard made this predicate REFUSE a plan-resold id even when native was
			// registered, silently reversing #19's fix whenever the static ROUTES
			// table didn't also carry the id.
			match: (m) => typeof m === "string" && m.startsWith("deepseek-") && !DATED_ID.test(m),
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
			// the routes are not interchangeable. Since issue #19 (0.6.1) this
			// predicate is a FALLBACK, not the default: `deepseek:deepseek-v4-pro`
			// and — when a DeepSeek key is registered — the bare id both reach the
			// native route explicitly; this predicate only fires when no native
			// route is registered (or via the explicit `qwen:` selector).
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
