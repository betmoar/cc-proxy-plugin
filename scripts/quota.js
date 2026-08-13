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

/**
 * Human duration for a millisecond span: `2h15m`, `45m`, `now`.
 *
 * Shared because both tools render the SAME fact and used to disagree about it
 * (backlog item 10): the statusline showed a relative countdown while the CLI
 * showed an absolute UTC stamp, which made a reader in any other zone do the
 * arithmetic. Timezone-independent by construction — it is a difference of two
 * epoch values, never a wall-clock reading.
 *
 * Negative and sub-minute spans both collapse to "now": a quota window that has
 * already rolled over and one about to are the same actionable fact.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "now";
	const hours = Math.floor(ms / 3_600_000);
	const mins = Math.floor((ms % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h${mins > 0 ? `${mins}m` : ""}` : `${mins}m`;
}

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

/**
 * Clock-skew threshold (backlog item 11). Every reset countdown assumes the
 * local clock agrees with the vendor's; when it doesn't, the gauge is wrong by
 * exactly that offset and nothing says so.
 *
 * The reference clock is free: both quota endpoints already return a `Date`
 * header on the calls these fetchers ALREADY make (verified 2026-08-04 —
 * api.z.ai and openrouter.ai both send one). So this costs no extra request.
 *
 * The threshold stays deliberately loose. Request latency inflates apparent
 * skew by up to the round-trip time, and the GLM endpoint's p50 is ~1.1s with a
 * measured max near 1.9s — a 5s threshold would false-positive on any slow
 * network. 60s is far outside RTT while still catching a clock wrong enough to
 * mislead a 5-hour countdown.
 *
 * This belongs here and NOT in src/: these are diagnostic calls the statusline
 * makes on its own. Doing it on the proxy's forwarding path would mean
 * inspecting responses to accumulate state, which is invariant 2.
 */
export const CLOCK_SKEW_THRESHOLD_MS = 60_000;

/**
 * Signed skew in ms between the local clock and a response's `Date` header:
 * positive = local clock is AHEAD of the server. Returns null when the header
 * is absent or unparseable, which is "unknown", never 0 — a false "clocks
 * agree" is exactly the reassurance this is meant to withhold.
 * @param {Headers} headers
 * @returns {number|null}
 */
export function clockSkewMs(headers) {
	const raw = headers?.get?.("date");
	if (!raw) return null;
	const serverMs = Date.parse(raw);
	if (!Number.isFinite(serverMs)) return null;
	return Date.now() - serverMs;
}

// Returns the parsed body plus the skew observed on that same response, so a
// caller can attach it without a second request. The skew rides ALONGSIDE the
// body rather than being merged into it: these bodies are vendor payloads, and
// a synthetic key added here could collide with a real field later.
async function fetchJsonWithSkew(url, headers) {
	const res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return { json: await res.json(), skewMs: clockSkewMs(res.headers) };
}

async function fetchJson(url, headers) {
	return (await fetchJsonWithSkew(url, headers)).json;
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
	const { json, skewMs } = await fetchJsonWithSkew(QUOTA_URL, { Authorization: apiKey });
	const data = json.data || {};
	// Only attach when the skew is big enough to mislead the countdown. Below
	// the threshold the key is absent, so `_skewMs in data` distinguishes "clock
	// checked and fine" from "never measured" — the same omit-don't-invent rule
	// the /v1/models contract follows.
	if (skewMs !== null && Math.abs(skewMs) > CLOCK_SKEW_THRESHOLD_MS) data._skewMs = skewMs;
	return data;
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
