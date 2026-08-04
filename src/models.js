// @ts-check

import { providerById } from "./providers.js";

/**
 * @typedef {{ type: "model", id: string, display_name: string, created_at: string | null, context_window?: number }} ModelEntry
 */

/**
 * Curated context windows (integer token counts), keyed by the bare discovery
 * id. This is the SOURCE OF TRUTH for `context_window` on the wire — promoted
 * here from scripts/list-models.js (2026-08-04) because a second consumer
 * (the cc-reload plugin, which budgets a session against a model's context
 * window) needed it programmatically. Duplicating a curated id->window table
 * in every consumer is the failure mode this promotion exists to kill: before
 * this, cc-reload hard-coded its own model-id table and cc-proxy's table
 * (below) could silently drift from it. See CHANGELOG "Changed" for the
 * reversal record — the original `scripts/list-models.js` header explicitly
 * called this a display-layer-only decision; that decision is reversed here.
 *
 * On the wire this is an INTEGER token count (128000, not "128K"). The human
 * string ("128K"/"1M") stays a rendering concern — scripts/list-models.js
 * derives it from this table via formatContextWindow() so the two can never
 * drift again.
 *
 * ids with NO entry here (OpenRouter-prefixed ids: deepseek/*, qwen/*,
 * moonshotai/*, tencent/*, and the claude-* ids) OMIT `context_window`
 * entirely on discovery entries — never `null`. A consumer distinguishes
 * "unknown" from "known" with `"context_window" in entry`, not a null check.
 * Do not invent a window for an id absent here.
 *
 * Keyed on the EXACT id, deliberately — `deepseek/deepseek-v4-pro` does not
 * inherit the 1M curated for its bare `deepseek-v4-pro`. An aggregator is a
 * different deployment of the same weights and may serve a truncated window
 * or a different default; asserting the native number for a route we have not
 * measured would publish a confident guess, and the whole point of this field
 * is that a consumer can trust what is present. Omission is the honest
 * answer until someone verifies the aggregator's window per id. (Absent, of
 * course, means the consumer needs its own fallback — that cost is accepted.)
 *
 * Sources (2026-08-04), re-verify before each release touching the model:
 *   GLM:      docs.z.ai/guides/llm/glm-*.md  (4.5=128K; 4.6/4.7/5/5-Turbo/5.1=200K; 5.2=1M)
 *   DeepSeek: api-docs.deepseek.com/quick_start/pricing (1M)
 *   Qwen:     Alibaba Model Studio (1M, incl. 3.8-max-preview)
 * GLM/DeepSeek are pinned to the docs verbatim; the Qwen numbers come from a
 * vendor summary (all Qwen 3.x models share a 1M window) — re-verify any of
 * these before a release touching the model, exactly like DEEPSEEK_PRICING.
 */
export const CONTEXT_WINDOW = {
	// GLM (docs.z.ai/guides/llm/glm-*)
	"glm-4.5": 128000,
	"glm-4.5-air": 128000,
	"glm-4.6": 200000,
	"glm-4.7": 200000,
	"glm-5": 200000,
	"glm-5-turbo": 200000,
	"glm-5.1": 200000,
	"glm-5.2": 1000000,
	// DeepSeek (api-docs.deepseek.com/quick_start/pricing)
	"deepseek-v4-pro": 1000000,
	"deepseek-v4-flash": 1000000,
	// Qwen (Alibaba Cloud Model Studio)
	"qwen3.8-max": 1000000,
	"qwen3.8-max-preview": 1000000,
	"qwen3.7-max": 1000000,
	"qwen3.7-plus": 1000000,
	"qwen3.6-flash": 1000000,
	// Plan-served DeepSeek build; same 1M window as the bare deepseek-v4-* it is
	// a dated snapshot of (api-docs.deepseek.com/quick_start/pricing).
	"deepseek-v4-flash-0731": 1000000,
};

/**
 * Attach `context_window` to a discovery entry when the id has a curated
 * window (CONTEXT_WINDOW); otherwise return the entry unchanged (field
 * omitted, never emitted as null). Applied uniformly in collectModels() so
 * live-fetched (GLM/DeepSeek) and static (Claude/Qwen/OpenRouter) entries
 * alike get the field without hand-editing every curated list literal.
 * @param {ModelEntry} entry
 * @returns {ModelEntry}
 */
export function withContextWindow(entry) {
	// Object.hasOwn, NOT `CONTEXT_WINDOW[id] !== undefined`: the table is an
	// object literal, so a plain lookup walks Object.prototype. A vendor id of
	// `__proto__`/`constructor`/`toString` would then resolve to an inherited
	// member and ship `"context_window": {}` (or a function, which
	// JSON.stringify silently drops — leaving the key absent on the wire but
	// present in the object collectModels() returns in-process). Ids come from
	// live GLM/DeepSeek catalogs and coerceEntry only checks `!e.id`, so the
	// key space is the vendor's, not ours.
	if (!Object.hasOwn(CONTEXT_WINDOW, entry.id)) return entry;
	return { ...entry, context_window: CONTEXT_WINDOW[entry.id] };
}

/** Reachable Claude ids advertised on discovery. Not public-API-stable — re-confirm
 * before each release touching Claude compat. claude-haiku-* omitted (internal ops
 * pin); claude-mythos-5 omitted (Project Glasswing-gated — unreachable by default). */
export const DEFAULT_CLAUDE_MODELS = [
	{ type: "model", id: "claude-fable-5", display_name: "Claude Fable 5", created_at: null },
	{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: null },
	{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: null },
];

/** Qwen (QwenCloud Token Plan) ids as Anthropic-skin compatible. Static — Qwen
 * exposes no /v1/models route (the docs say to ignore it; it 404s), so these are
 * curated like the Claude list. ids are bare (`qwen3.7-max`), matching the `qwen`
 * prefix the provider's match() keys on.
 *
 * `qwen3.8-max-preview` is Token-Plan-exclusive and the cheapest way to reach the
 * 3.8 tier: `qwen3.8-max` is 50% off 22:00–08:00 UTC+8, and the preview stacks a
 * promotional rate on top of that night discount.
 *
 * Curated EMPIRICALLY, not from the docs: all five returned HTTP 200 against the
 * Token Plan host on 2026-08-04. QwenCloud's published model table is aspirational
 * for a Token Plan key — `qwen3.7-flash` and `qwen3-coder-next` are listed there but
 * 400 (InvalidParameter), and `qwen3.6-plus` 403s (AccessDenied, "not eligible").
 * Conversely `qwen3.7-plus` is live but absent from that table. Re-verify by calling
 * the endpoint, not by reading the docs, before each release touching Qwen compat.
 *
 * The five `qwen*` ids match the account's own plan page exactly (confirmed
 * 2026-08-04), so that curation is right. `deepseek-v4-flash-0731` is here
 * because the plan SERVES it while both vendor tables omit it: it is absent
 * from the plan page AND unknown to DeepSeek native (400). It routes to qwen
 * via the DATED_ID rule in providers.js — a dated build is a plan-only
 * spelling. Bare `deepseek-v4-pro` and `glm-5.2` are also plan-served but are
 * deliberately NOT listed here: they are advertised by their native providers,
 * and listing them under Qwen would put the same id in the catalog twice with
 * no way to say which one a caller means (backlog item 8). */
export const DEFAULT_QWEN_MODELS = [
	{ type: "model", id: "qwen3.8-max", display_name: "Qwen3.8 Max", created_at: null },
	{
		type: "model",
		id: "qwen3.8-max-preview",
		display_name: "Qwen3.8 Max Preview",
		created_at: null,
	},
	{ type: "model", id: "qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
	{ type: "model", id: "qwen3.7-plus", display_name: "Qwen3.7 Plus", created_at: null },
	{ type: "model", id: "qwen3.6-flash", display_name: "Qwen3.6 Flash", created_at: null },
	// Plan-only DeepSeek build (see the note above). Named for its origin vendor
	// so the id stays copy-pasteable into /model, which is what a caller types.
	{
		type: "model",
		id: "deepseek-v4-flash-0731",
		display_name: "DeepSeek V4 Flash (0731, Qwen plan)",
		created_at: null,
	},
];

/** OpenRouter ids as Anthropic-skin compatible (HTTP 200 + message shape at POST
 * /v1/messages). All but kimi-k3 were live-verified 2026-07-14; kimi-k3 is advertised on
 * OpenRouter but not yet live-verified against the skin — added for discovery, verify on
 * next release. x-ai/grok-4.5 excluded: region-blocked, not incompatible. */
export const DEFAULT_OPENROUTER_MODELS = [
	{
		type: "model",
		id: "deepseek/deepseek-v4-pro",
		display_name: "DeepSeek V4 Pro",
		created_at: null,
	},
	{
		type: "model",
		id: "deepseek/deepseek-v4-flash",
		display_name: "DeepSeek V4 Flash",
		created_at: null,
	},
	{ type: "model", id: "tencent/hy3", display_name: "Tencent Hy3", created_at: null },
	{
		type: "model",
		id: "moonshotai/kimi-k2.7-code",
		display_name: "Kimi K2.7 Code",
		created_at: null,
	},
	{ type: "model", id: "moonshotai/kimi-k3", display_name: "Kimi K3", created_at: null },
	{ type: "model", id: "qwen/qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
];

/**
 * Parse OPENROUTER_MODELS: comma-separated ids, trimmed, empties dropped. Each id's
 * display_name is the id verbatim (env-supplied ids carry no curated name).
 * @param {string | undefined} str
 * @returns {ModelEntry[]}
 */
export function parseOpenRouterModels(str) {
	if (!str) return [];
	return str
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((id) => ({ type: "model", id, display_name: id, created_at: null }));
}

/**
 * Coerce an upstream created value to the Anthropic schema (ISO string or null).
 * A numeric (OpenAI-style Unix) timestamp is dropped to null rather than emitted
 * as a non-ISO value.
 * @param {unknown} v
 * @returns {string | null}
 */
export function coerceCreated(v) {
	return typeof v === "string" ? v : null;
}

/**
 * Coerce one upstream GLM entry to a ModelEntry, or null if it has no usable id.
 * @param {any} e
 * @returns {ModelEntry | null}
 */
function coerceEntry(e) {
	if (!e || !e.id) return null;
	return {
		type: e.type || "model",
		id: e.id,
		display_name: e.display_name || e.id,
		created_at: coerceCreated(e.created_at ?? e.created),
	};
}

/**
 * Fetch GLM's live model list. Resolves to { entries } on success or { error }
 * (a pinned message string) on any failure. Never throws.
 * @param {import("./providers.js").Provider} glm
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchGlmModels(glm, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${glm.baseUrl}/v1/models`, {
			headers: { "x-api-key": glm.apiKey, "anthropic-version": "2023-06-01" },
			signal: controller.signal,
		});
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch {
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		return { entries: body.data.map(coerceEntry).filter(Boolean) };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		// Log the real cause — see fetchDeepSeekModels for why the proxy log must
		// carry err.message even though the API response stays a pinned string.
		console.error(`[models] glm fetch failed: ${err?.message || err}`);
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * DeepSeek exposes no pricing API (the /pricing page is HTML-only), so per-1M-token
 * prices are curated here against the documented table and updated per release.
 * The models themselves stay live-fetched (fetchDeepSeekModels); this is the only
 * static data. Note: DeepSeek has ANNOUNCED (not yet live as of 2026-08-04) a 2×
 * peak-hour surcharge (9–12, 14–18 UTC+8) — not modeled here, and re-check before
 * it activates (the proxy has no clock and shouldn't model time-varying price).
 * @type {Record<string, { in: number, out: number, cached: number }>}
 */
export const DEEPSEEK_PRICING = {
	"deepseek-v4-pro": { in: 0.435, out: 0.87, cached: 0.003625 },
	"deepseek-v4-flash": { in: 0.14, out: 0.28, cached: 0.0028 },
};

/**
 * Fetch DeepSeek's live model list. Unlike the Messages skin (x-api-key at /anthropic),
 * the model-list endpoint is OpenAI-native: GET /models with Bearer auth, shape
 * { object:"list", data:[{id,object,owned_by}] }. Resolves to { entries } on success or
 * { error } on any failure. Never throws.
 * @param {import("./providers.js").Provider} deepseek
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchDeepSeekModels(deepseek, timeoutMs) {
	// /models is OpenAI-native — it sits on the api.deepseek.com root, not the /anthropic
	// base the forwarding path uses. Derive the root from the provider's skin baseUrl.
	const root = deepseek.baseUrl.replace(/\/anthropic$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${root}/models`, {
			headers: { Authorization: `Bearer ${deepseek.apiKey}` },
			signal: controller.signal,
		});
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch {
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		return { entries: body.data.map(coerceEntry).filter(Boolean) };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		// Log the real cause — the API response keeps a pinned string, but the
		// proxy log must say WHY (DNS/TLS/refused vs a code bug), or "glm missing
		// from /v1/models" becomes undebuggable. Never the stack (keys aren't in it,
		// but the URL/headers might be).
		console.error(`[models] deepseek fetch failed: ${err?.message || err}`);
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Assemble the merged discovery list. Best-effort: a failed live leg contributes
 * an _errors entry, never rejects (except the modelsForceThrow test seam).
 * @param {import("./config.js").Config & { claudeModels: ModelEntry[], openRouterModels: ModelEntry[], modelsTimeoutMs: number, modelsForceThrow?: boolean }} config
 * @returns {Promise<{ data: ModelEntry[], _errors: Array<{ provider: string, message: string }> }>}
 */
export async function collectModels(config) {
	if (config.modelsForceThrow) throw new Error("forced throw (test seam)");

	const glm = providerById(config, "glm");
	const deepseek = providerById(config, "deepseek");
	const openrouter = providerById(config, "openrouter");
	const qwen = providerById(config, "qwen");

	// Assemble leg thunks in registry order: glm, deepseek, openrouter, qwen, claude.
	/** @type {Array<() => Promise<{ provider: string, entries?: ModelEntry[], error?: string }>>} */
	const legs = [];
	if (glm?.apiKey) {
		legs.push(async () => ({
			provider: "glm",
			...(await fetchGlmModels(glm, config.modelsTimeoutMs)),
		}));
	}
	if (deepseek?.apiKey) {
		legs.push(async () => ({
			provider: "deepseek",
			...(await fetchDeepSeekModels(deepseek, config.modelsTimeoutMs)),
		}));
	}
	if (openrouter) {
		legs.push(async () => ({ provider: "openrouter", entries: config.openRouterModels }));
	}
	// Qwen has no live /models endpoint — static curated list, emitted only when the
	// provider is registered (key set), like the Claude leg below.
	if (qwen) {
		legs.push(async () => ({ provider: "qwen", entries: config.qwenModels }));
	}
	legs.push(async () => ({ provider: "claude", entries: config.claudeModels }));

	const settled = await Promise.allSettled(legs.map((leg) => leg()));

	const data = [];
	const seen = new Set();
	const _errors = [];
	for (const s of settled) {
		// leg thunks never reject, but guard defensively.
		const r = s.status === "fulfilled" ? s.value : { provider: "unknown", error: "fetch failed" };
		if (r.error) {
			_errors.push({ provider: r.provider, message: r.error });
			continue;
		}
		for (const entry of r.entries || []) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			data.push(withContextWindow(entry));
		}
	}
	return { data, _errors };
}
