#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.js";
import { fetchDeepSeekBalance, fetchGlmQuota, fetchOpenRouterCredits } from "./quota.js";

// Load API keys + config from ~/.env (+ repo .env in dev) so the GLM/OpenRouter
// quota fetches below work. The statusline is spawned by Claude Code with only
// settings.json's env, not the proxy's dotenv — without this, a key that lives
// only in ~/.env never reaches the quota gauges. process.env still wins.
// MUST run before any module-level process.env read: PROXY_PORT below is
// evaluated at load time, and calling loadEnv() after it silently ignored a
// port configured in ~/.env (the liveness probe then watched the wrong port).
loadEnv();

// Endpoint URLs, the fetch timeout, and the response shaping live in
// ./quota.js — shared with scripts/status.js so the two copies can't drift
// again (they did once: this file grew a fetch timeout and status.js didn't,
// fixed 0.3.1). What stays here is what the CLI must NOT inherit: the 60s disk
// cache with a stale-on-failure fallback, which only makes sense for a bar
// re-rendered every ~300ms.
const CACHE_TTL_MS = 60_000;
const PROXY_PORT = Number(process.env.PROXY_PORT || 4000);
const PROXY_PROBE_TIMEOUT_MS = 300;

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RED_BOLD = "\x1b[1;31m";
const RESET = "\x1b[0m";

function probePort(port) {
	return new Promise((resolve) => {
		const sock = net.createConnection(port, "127.0.0.1");
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, PROXY_PROBE_TIMEOUT_MS);
		sock.on("connect", () => {
			clearTimeout(timer);
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

// Claude Code refreshes statusline roughly every 300ms. Cache the TCP probe
// for a second so we're not burning a syscall per render.
const PROXY_PROBE_CACHE_TTL_MS = 1000;
async function checkProxyAlive(port, cacheDir) {
	if (!cacheDir) return probePort(port);
	const cachePath = path.join(cacheDir, "proxy_alive.json");
	try {
		const raw = fs.readFileSync(cachePath, "utf8");
		const cached = JSON.parse(raw);
		if (cached.port === port && Date.now() - cached._ts < PROXY_PROBE_CACHE_TTL_MS) {
			return cached.alive;
		}
	} catch {
		// miss → probe
	}
	const alive = await probePort(port);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify({ port, alive, _ts: Date.now() }));
	} catch {
		// non-fatal
	}
	return alive;
}

function colorize(pct) {
	if (pct >= 85) return RED;
	if (pct >= 60) return YELLOW;
	return GREEN;
}

function formatResetTime(epochSec) {
	const diffMs = epochSec * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const hours = Math.floor(diffMs / 3_600_000);
	const mins = Math.floor((diffMs % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h${mins > 0 ? `${mins}m` : ""}` : `${mins}m`;
}

const CLOCK = "⏱";

// Render a 5h quota segment. Normal: `label 5h:<color>NN%`. Once usage hits
// 100% (exhausted, waiting for the window to roll over), the percentage is
// replaced by a red reset countdown `label 5h:⏱<time>` so the only useful
// signal — when access returns — is what shows. `stale` is an optional "!" mark.
// `pct` is the raw (unrounded) usage: the countdown gates on the true value so
// 99.6 doesn't round up to 100 and false-trigger exhaustion, while the
// displayed percentage is rounded for compactness.
function renderQuota(label, pct, resetEpochSec, stale = "") {
	const usage = Number(pct);
	// Non-finite usage (upstream/schema drift) → placeholder, not "NaN%"
	// (colorize(NaN) would also fall through to GREEN, doubly misleading).
	if (!Number.isFinite(usage)) return `${label} 5h:--${stale}`;
	const resetSec = Number(resetEpochSec);
	const reset = Number.isFinite(resetSec) ? formatResetTime(resetSec) : null;
	if (usage >= 100 && reset) {
		return `${label} 5h:${RED}${CLOCK}${reset}${stale}${RESET}`;
	}
	return `${label} 5h:${colorize(usage)}${Math.round(usage)}%${stale}${RESET}`;
}

// One cache policy for all three gauges: 60s TTL on disk, and on any fetch
// failure fall back to the last good value marked `_stale` (rendered as "!").
// Returning null means "no key / nothing ever cached" — the section is omitted
// entirely rather than shown as unknown. This wrapper is deliberately NOT in
// ./quota.js: scripts/status.js is a one-shot CLI that must surface a failure
// now, not a minute-old number.
async function cachedFetch(cacheDir, cacheFile, apiKey, fetcher) {
	if (!apiKey) return null;
	const cachePath = cacheDir ? path.join(cacheDir, cacheFile) : null;

	if (cachePath) {
		try {
			const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
			if (Date.now() - cached._ts < CACHE_TTL_MS) return cached;
		} catch {
			// No cache or invalid — proceed to API call
		}
	}

	try {
		const result = { ...(await fetcher(apiKey)), _ts: Date.now() };
		if (cachePath) {
			try {
				fs.mkdirSync(path.dirname(cachePath), { recursive: true });
				fs.writeFileSync(cachePath, JSON.stringify(result));
			} catch {
				// Cache write failure is non-fatal
			}
		}
		return result;
	} catch {
		// API failure — try stale cache
		if (cachePath) {
			try {
				const stale = JSON.parse(fs.readFileSync(cachePath, "utf8"));
				stale._stale = true;
				return stale;
			} catch {
				return null;
			}
		}
		return null;
	}
}

// GLM 5h coding quota (`glm`). The cached object is the endpoint's raw `data`
// ({ level, limits: [...] }), so the render below reads `limits` off it.
const loadGlmQuota = (cacheDir) =>
	cachedFetch(cacheDir, "glm_quota_cache.json", process.env.GLM_API_KEY, fetchGlmQuota);

// OpenRouter credits (`or:`, opt-in via OPENROUTER_API_KEY).
const loadOpenRouterCredits = (cacheDir) =>
	cachedFetch(
		cacheDir,
		"openrouter_credits_cache.json",
		process.env.OPENROUTER_API_KEY,
		fetchOpenRouterCredits,
	);

// DeepSeek balance (`ds:`, opt-in via DEEPSEEK_API_KEY). Unlike OpenRouter
// (which reports credits used/remaining), DeepSeek reports a single
// total_balance, so the gauge carries no used-percentage. A non-USD account
// yields remaining: null → `--`; see fetchDeepSeekBalance for why.
const loadDeepSeekBalance = (cacheDir) =>
	cachedFetch(
		cacheDir,
		"deepseek_balance_cache.json",
		process.env.DEEPSEEK_API_KEY,
		fetchDeepSeekBalance,
	);

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
	let input = {};
	try {
		input = JSON.parse(Buffer.concat(chunks).toString());
	} catch {
		// Empty or invalid stdin — proceed with defaults
	}

	const parts = [];
	// CLAUDE_PLUGIN_DATA is only set in plugin hook context, not in statusLine, so
	// a fallback is needed when run from settings.json's statusLine command. It
	// used to be /tmp, where another local user can pre-create
	// glm_quota_cache.json et al and the reader would render their numbers as
	// this user's quota (garbage gauges, no key leak — we only ever read). $HOME
	// isn't shared. cachedFetch/checkProxyAlive mkdir -p before writing, so a
	// missing dir is a cache miss, not an error.
	const cacheDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "cc-proxy");

	// Proxy liveness probe (cached 1s). The indicator is appended at the tail
	// so the primary quota signals read first; bold-red differentiates it
	// from the non-bold RED used by quota gauges at ≥85%.
	const proxyAlive = await checkProxyAlive(PROXY_PORT, cacheDir);

	// Claude section (`cc`): 5h usage %, or a reset countdown once exhausted.
	const rl = input.rate_limits;
	if (rl?.five_hour) {
		parts.push(renderQuota("cc", Number(rl.five_hour.used_percentage), rl.five_hour.resets_at));
	} else {
		parts.push("cc 5h:--");
	}

	// GLM section
	const glm = await loadGlmQuota(cacheDir);
	if (glm) {
		const stale = glm._stale ? "!" : "";

		// TOKENS_LIMIT = 5-hour coding quota (confirmed via zai-org/zai-coding-plugins)
		const tokLim = glm.limits?.find((l) => l.type === "TOKENS_LIMIT");
		if (tokLim) {
			// nextResetTime is epoch ms; renderQuota takes seconds. Coerce so a
			// string/garbage value is non-finite and yields no countdown.
			const resetSec = Number(tokLim.nextResetTime) / 1000;
			parts.push(renderQuota("glm", tokLim.percentage, resetSec, stale));
		} else {
			parts.push("glm 5h:--");
		}
	}

	// One $ per digit of whole-dollar balance remaining: $1–9=$, $10–99=$$,
	// $100–999=$$$, $1000+=$$$$ (unbounded by design). An empty balance renders a
	// distinct `$0`; any non-empty balance — including a sub-$1 amount that floors
	// to 0 — shows at least one `$`. A non-finite balance (stale/corrupt cache,
	// schema drift) renders `--` rather than deriving a misleading tier from NaN
	// (String(NaN).length === 3 would yield "$$$"). Shared by the OpenRouter and
	// DeepSeek balance gauges.
	function dollarTier(remaining) {
		// null/undefined mean "no number", not zero — Number(null) === 0 would
		// otherwise render a false `$0`. This is the unknown-balance carrier
		// (DeepSeek's non-USD case) precisely because null survives the JSON
		// cache round-trip, which NaN does not (JSON.stringify(NaN) === "null").
		if (remaining === null || remaining === undefined) return "--";
		const r = Number(remaining);
		if (!Number.isFinite(r)) return "--";
		if (r <= 0) return "$0";
		return "$".repeat(Math.max(1, String(Math.floor(r)).length));
	}

	// OpenRouter section (`or:`, only when OPENROUTER_API_KEY is set)
	const or = await loadOpenRouterCredits(cacheDir);
	if (or) {
		const stale = or._stale ? "!" : "";
		const c = colorize(or.usedPct);
		parts.push(`or:${c}${dollarTier(or.remaining)}${stale}${RESET}`);
	}

	// DeepSeek section (`ds:`, only when DEEPSEEK_API_KEY is set)
	const ds = await loadDeepSeekBalance(cacheDir);
	if (ds) {
		const stale = ds._stale ? "!" : "";
		parts.push(`ds:${dollarTier(ds.remaining)}${stale}`);
	}

	// Qwen section (`qw:on`, only when DASHSCOPE_API_KEY is set). Deliberately a
	// presence marker, not a gauge: QwenCloud exposes no quota/balance API. The
	// Token Plan percentage + reset time you see in the console come from
	// cs-data.qwencloud.com, which authenticates on a browser login cookie plus a
	// rotating sec_token and answers `BailianGateway.Login.NotLogined` to an API
	// key (verified 2026-08-04, with the console's own verbatim request body).
	// The Anthropic skin returns no x-ratelimit-*/x-quota-* response headers
	// either — only Envoy timing. The sole programmatic signal is per-response
	// `usage`, and accumulating that would mean cross-request state (invariant 2).
	// So there is no number to render; anything tier-shaped here would be fiction.
	if (process.env.DASHSCOPE_API_KEY) {
		parts.push("qw:on");
	}

	if (!proxyAlive) {
		parts.push(`${RED_BOLD}proxy down${RESET}`);
	}

	process.stdout.write(parts.join(" | "));
});
