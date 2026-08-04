// @ts-check

import { providerById } from "./providers.js";

/**
 * @typedef {{ type: "model", id: string, display_name: string, created_at: string | null }} ModelEntry
 */

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
 * the endpoint, not by reading the docs, before each release touching Qwen compat. */
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
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * DeepSeek exposes no pricing API (the /pricing page is HTML-only), so per-1M-token
 * prices are curated here against the documented table and updated per release.
 * The models themselves stay live-fetched (fetchDeepSeekModels); this is the only
 * static data. Note: DeepSeek charges 2× during peak hours (9–12, 14–18 UTC+8) —
 * documented here for reference, not modeled (the proxy has no clock and shouldn't).
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
			data.push(entry);
		}
	}
	return { data, _errors };
}
