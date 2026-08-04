// Provider quota/credit/balance fetchers, shared by scripts/status.js (one-shot
// CLI) and scripts/statusline.js (rendered every ~300ms, disk-cached).
//
// Why this file exists: both consumers used to carry their own copy of the same
// endpoint URLs, timeout, and response-shaping. They drifted once already — the
// statusline's fetches grew an AbortSignal timeout while status.js's did not
// (fixed 0.3.1) — so the endpoints now live in exactly one place.
//
// Why scripts/ and not src/: src/ is the proxy runtime, loaded on every
// forwarded request; these are diagnostics and belong nowhere near it. The
// hooks/-must-not-import-src/ rule does not apply (neither consumer is a hook),
// so the only live constraint is keeping the runtime lean.
//
// What deliberately did NOT move here: caching and rendering. The statusline
// wraps every call in a 60s disk cache with a stale-on-failure fallback; the CLI
// is one-shot and wants the failure surfaced immediately. These functions
// therefore THROW on any failure (non-2xx included) and hold no state — each
// call site owns its own error policy.
//
// No module-level process.env reads. This module is imported by scripts that
// call loadEnv() in their body, and an import is hoisted above that call — a
// const computed here would capture process.env BEFORE ~/.env is loaded, which
// is exactly the bug that made the statusline ignore a ~/.env PROXY_PORT. Keys
// are passed in by the caller; DEEPSEEK_BALANCE_URL is read at call time.

export const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const DEEPSEEK_BALANCE_URL_DEFAULT = "https://api.deepseek.com/user/balance";

// Shared fetch timeout. 800ms was too tight and dropped both providers into
// stale cache on slow networks; 2000ms still fails fast enough that a hanging
// endpoint doesn't stall the statusline's ~300ms render loop.
export const QUOTA_FETCH_TIMEOUT_MS = 2000;

/**
 * Overridable so tests can point the balance fetch at a local stub and exercise
 * the real per-currency selection. Read lazily (see header) and deliberately NOT
 * in .env.example / the README env table — it is a test seam, not a user knob.
 * @returns {string}
 */
export function deepseekBalanceUrl() {
	return process.env.DEEPSEEK_BALANCE_URL || DEEPSEEK_BALANCE_URL_DEFAULT;
}

async function fetchJson(url, headers) {
	const res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/**
 * GLM 5h coding quota. Returns the raw `data` object (`{ level, limits: [...] }`)
 * rather than a picked shape: the two call sites read different fields off it,
 * and the statusline persists the whole thing to its cache file.
 * The endpoint accepts Authorization, x-api-key, and Bearer formats.
 * @param {string} apiKey
 * @returns {Promise<object>} throws on network/HTTP failure
 */
export async function fetchGlmQuota(apiKey) {
	const json = await fetchJson(QUOTA_URL, { Authorization: apiKey });
	return json.data || {};
}

/**
 * OpenRouter credits. Remaining = total_credits - total_usage.
 * @param {string} apiKey
 * @returns {Promise<{ remaining: number, usedPct: number }>} throws on failure
 */
export async function fetchOpenRouterCredits(apiKey) {
	const json = await fetchJson(OPENROUTER_CREDITS_URL, {
		Authorization: `Bearer ${apiKey}`,
	});
	const total = Number(json?.data?.total_credits) || 0;
	const used = Number(json?.data?.total_usage) || 0;
	return { remaining: total - used, usedPct: total > 0 ? Math.round((used / total) * 100) : 0 };
}

/**
 * DeepSeek balance. The /user/balance response is per-currency and the gauge is
 * denominated in dollars, so ONLY a USD row may drive it. This used to fall back
 * to balance_infos[0], which rendered a CNY-only account's ¥50 as `$$` — a
 * confidently wrong number, worse than none. Non-USD leaves `remaining` null,
 * which renders `--`. `currency` is diagnostic only (nothing reads it at render
 * time): it survives in the cache file so a user staring at a bare `--` can see
 * which currency the account actually reports.
 * @param {string} apiKey
 * @returns {Promise<{ remaining: number|null, currency: string|null }>} throws on failure
 */
export async function fetchDeepSeekBalance(apiKey) {
	const json = await fetchJson(deepseekBalanceUrl(), {
		Authorization: `Bearer ${apiKey}`,
	});
	const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
	const usd = infos.find((b) => b?.currency === "USD") || null;
	return {
		remaining: usd ? Number(usd.total_balance) : null,
		currency: (usd || infos[0])?.currency || null,
	};
}
