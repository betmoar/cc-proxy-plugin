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
	{ type: "model", id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: null },
	{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: null },
];

/** OpenRouter ids verified 2026-07-14 as Anthropic-skin compatible (HTTP 200 + message
 * shape at POST /v1/messages). x-ai/grok-4.5 excluded: region-blocked, not incompatible. */
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
 * Assemble the merged discovery list. Best-effort: a failed live leg contributes
 * an _errors entry, never rejects (except the modelsForceThrow test seam).
 * @param {import("./config.js").Config & { claudeModels: ModelEntry[], openRouterModels: ModelEntry[], modelsTimeoutMs: number, modelsForceThrow?: boolean }} config
 * @returns {Promise<{ data: ModelEntry[], _errors: Array<{ provider: string, message: string }> }>}
 */
export async function collectModels(config) {
	if (config.modelsForceThrow) throw new Error("forced throw (test seam)");

	const glm = providerById(config, "glm");
	const openrouter = providerById(config, "openrouter");

	// Assemble leg thunks in registry order: glm, openrouter, claude.
	/** @type {Array<() => Promise<{ provider: string, entries?: ModelEntry[], error?: string }>>} */
	const legs = [];
	if (glm?.apiKey) {
		legs.push(async () => ({
			provider: "glm",
			...(await fetchGlmModels(glm, config.modelsTimeoutMs)),
		}));
	}
	if (openrouter) {
		legs.push(async () => ({ provider: "openrouter", entries: config.openRouterModels }));
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
