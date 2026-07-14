// @ts-check

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
