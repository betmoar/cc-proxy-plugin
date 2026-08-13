#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import {
	fetchDeepSeekBalance,
	fetchGlmQuota,
	fetchOpenRouterCredits,
	formatDuration,
} from "./quota.js";

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

// Nothing on the RENDER path may touch the network. The bar is re-rendered
// every ~300ms and the cc-status composer kills any renderer that takes longer
// than CC_STATUS_TIMEOUT (default 2s, whole process group) — a killed renderer
// contributes NOTHING, so the segment vanishes for that frame. Measured before
// this was fixed: a cold render took 1478–2216ms (5/15 samples over the 2s
// kill), because the three gauges were fetched one after another.
//
// So an expired cache is served STALE and refreshed by a DETACHED child. Three
// measurements shaped this and each would break if changed:
//
//  1. The segment must be written BEFORE the refresh is triggered. Output is a
//     single stdout.write, so a kill any earlier yields zero bytes.
//  2. The refresher MUST be `detached` + `unref()`. The composer kills the
//     process GROUP (`kill -TERM -- -$pid`), which reaps ordinary children —
//     a non-detached refresher dies with the segment and the cache never fills.
//  3. It must be a separate PROCESS, not a floating promise: node stays alive
//     while a promise is pending, so an in-process refresh re-creates exactly
//     the slow render this replaces.
//
// REFRESH_LOCK_STALE_MS bounds the single-flight lock. Without the lock, all
// renders during the ~2s refresh window see the same expired cache and each
// spawns its own refresher — the stampede this fixes, moved one level down.
// Measured before the lock: six renders 300ms apart across ONE expiry all
// fetched (2241/1599/1584/1146/721/600ms) = ~6 rounds of API calls where 1 was
// intended. The lock is a file whose mtime is checked, never a pid: a refresher
// killed between spawn and completion leaves the file behind, and an mtime
// older than this window is treated as abandoned rather than wedging the gauge
// forever. It is deliberately longer than a healthy refresh (~2s) and far
// shorter than the 60s TTL.
const REFRESH_LOCK_STALE_MS = 10_000;

// Set on the detached child. It makes the child do the fetches and exit without
// rendering anything — same file, no second script to keep in sync.
const REFRESH_ENV = "CC_PROXY_STATUSLINE_REFRESH";

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

// Duration formatting is shared with scripts/status.js via quota.js so the two
// tools cannot drift on how they spell the same countdown (backlog item 10).
const formatResetTime = (epochSec) => formatDuration(epochSec * 1000 - Date.now());

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

/**
 * Read a gauge's cache file. Returns the parsed object, or null when the file
 * is missing/corrupt. Freshness is the CALLER's decision — the render path
 * serves any cache it finds, while the refresher re-checks the age to avoid
 * fetching what a concurrent refresher just wrote.
 */
function readCache(cachePath) {
	if (!cachePath) return null;
	try {
		return JSON.parse(fs.readFileSync(cachePath, "utf8"));
	} catch {
		return null;
	}
}

const isFresh = (cached) => cached && Date.now() - cached._ts < CACHE_TTL_MS;

/**
 * RENDER PATH — never fetches, never blocks. Returns the cached value whatever
 * its age (marked `_stale` past the TTL so the bar shows "!"), or null when
 * there is no key and no cache at all, which omits the section.
 *
 * A stale-marked value is the honest reading: the number IS old, and the "!"
 * already means exactly that for the fetch-failure case this now shares. The
 * refresh it triggers lands in the cache for the NEXT render ~300ms later.
 */
function cachedOnly(cacheDir, cacheFile, apiKey) {
	if (!apiKey) return null;
	const cached = readCache(cacheDir ? path.join(cacheDir, cacheFile) : null);
	if (!cached) return null;
	if (!isFresh(cached)) cached._stale = true;
	return cached;
}

/**
 * REFRESHER PATH (detached child only) — the blocking fetch that used to sit on
 * the render path. Writes the cache and returns nothing anyone waits on.
 *
 * Re-checks freshness first: between this child's spawn and its start, another
 * refresher may already have written. On failure the file is left ALONE rather
 * than cleared, so the next render serves the last good value marked stale
 * instead of losing the gauge entirely.
 */
async function refreshOne(cacheDir, cacheFile, apiKey, fetcher) {
	if (!apiKey || !cacheDir) return;
	const cachePath = path.join(cacheDir, cacheFile);
	if (isFresh(readCache(cachePath))) return;
	try {
		const result = { ...(await fetcher(apiKey)), _ts: Date.now() };
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(result));
	} catch {
		// Network/HTTP failure, or an unwritable cache dir. Leave the previous
		// file in place: the render path marks it `_stale` and shows "!".
	}
}

// The three gauges, in render order. One table drives both paths: the render
// reads each `file`, the refresher fetches each `fetcher`. A gauge added to one
// path and forgotten in the other is the drift this table exists to prevent.
// `key` is read at CALL time, never at module load — loadEnv() populates
// process.env in this file's body, and a module-level capture would read it
// empty (the same hoisting trap documented in quota.js).
const GAUGES = [
	{ file: "glm_quota_cache.json", env: "GLM_API_KEY", fetcher: fetchGlmQuota },
	{
		file: "openrouter_credits_cache.json",
		env: "OPENROUTER_API_KEY",
		fetcher: fetchOpenRouterCredits,
	},
	{ file: "deepseek_balance_cache.json", env: "DEEPSEEK_API_KEY", fetcher: fetchDeepSeekBalance },
];

// GLM 5h coding quota (`glm`). The cached object is the endpoint's raw `data`
// ({ level, limits: [...] }), so the render below reads `limits` off it.
const loadGlmQuota = (cacheDir) =>
	cachedOnly(cacheDir, "glm_quota_cache.json", process.env.GLM_API_KEY);

// OpenRouter credits (`or:`, opt-in via OPENROUTER_API_KEY).
const loadOpenRouterCredits = (cacheDir) =>
	cachedOnly(cacheDir, "openrouter_credits_cache.json", process.env.OPENROUTER_API_KEY);

// DeepSeek balance (`ds:`, opt-in via DEEPSEEK_API_KEY). Unlike OpenRouter
// (which reports credits used/remaining), DeepSeek reports a single
// total_balance, so the gauge carries no used-percentage. A non-USD account
// yields remaining: null → `--`; see fetchDeepSeekBalance for why.
const loadDeepSeekBalance = (cacheDir) =>
	cachedOnly(cacheDir, "deepseek_balance_cache.json", process.env.DEEPSEEK_API_KEY);

/**
 * True when at least one gauge with a key is missing or past its TTL. Cheap:
 * three stat+read of tiny files, no network. Deliberately checks EVERY gauge
 * rather than short-circuiting — the answer feeds a single spawn that refreshes
 * all of them together.
 */
function needsRefresh(cacheDir) {
	if (!cacheDir) return false;
	return GAUGES.some((g) => process.env[g.env] && !isFresh(readCache(path.join(cacheDir, g.file))));
}

/**
 * Single-flight guard. Takes the lock by creating the file exclusively (`wx`),
 * which is atomic — two renders racing here cannot both win. Returns false when
 * someone else holds it.
 *
 * A lock left behind by a killed refresher is reclaimed once its mtime is older
 * than REFRESH_LOCK_STALE_MS. That check is on the FILE's mtime, not a pid: the
 * composer kills the process group, so a pid recorded here would be a pid that
 * no longer exists and checking liveness would be a second race.
 */
function takeRefreshLock(cacheDir) {
	const lockPath = path.join(cacheDir, "refresh.lock");
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		// Exists (or unwritable). Reclaim only if abandoned.
		try {
			const age = Date.now() - fs.statSync(lockPath).mtimeMs;
			if (age < REFRESH_LOCK_STALE_MS) return false;
			fs.writeFileSync(lockPath, String(process.pid));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Spawn the detached refresher. Fire-and-forget by construction: `detached`
 * gives it its own process group so the composer's group-kill misses it,
 * `unref()` lets this process exit without waiting, and stdio is discarded so
 * no inherited pipe can hold the composer's capture open (the exact hazard its
 * `_run_bounded` comment warns about).
 */
function spawnRefresher(cacheDir) {
	try {
		spawn(process.execPath, [fileURLToPath(import.meta.url)], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, [REFRESH_ENV]: "1", CLAUDE_PLUGIN_DATA: cacheDir },
		}).unref();
	} catch {
		// Spawn failure is non-fatal: the bar keeps serving the stale value.
	}
}

// REFRESH MODE — the detached child. It renders nothing and reads no stdin
// (there is none: stdio is "ignore"), so this must return BEFORE the stdin
// handlers below are attached, or the child would wait forever on an "end"
// event that never fires.
//
// All three gauges run CONCURRENTLY here. They are independent, and serial was
// what made the old render path slow: GLM alone is p50 ~1.1s (max observed
// 1.9s), so summing the three gave 1.5–2.2s while the max is ~1.9s. Off the
// render path this no longer risks the segment, but it still halves the window
// in which another render sees a miss.
//
// The lock is released in `finally` — including on throw. Signals are NOT
// handled: a killed refresher leaves the lock behind on purpose, and the mtime
// reclaim in takeRefreshLock() is what recovers it. A signal handler here would
// be a second recovery path for a case the first already covers.
if (process.env[REFRESH_ENV]) {
	const cacheDir = process.env.CLAUDE_PLUGIN_DATA;
	if (cacheDir) {
		try {
			await Promise.all(
				GAUGES.map((g) => refreshOne(cacheDir, g.file, process.env[g.env], g.fetcher)),
			);
		} finally {
			try {
				fs.unlinkSync(path.join(cacheDir, "refresh.lock"));
			} catch {
				// Already gone (reclaimed as stale by another render) — fine.
			}
		}
	}
	process.exit(0);
}

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
	const glm = loadGlmQuota(cacheDir);
	if (glm) {
		const stale = glm._stale ? "!" : "";

		// TOKENS_LIMIT = 5-hour coding quota (confirmed via zai-org/zai-coding-plugins)
		const tokLim = glm.limits?.find((l) => l.type === "TOKENS_LIMIT");
		if (tokLim) {
			// nextResetTime is epoch ms; renderQuota takes seconds. Coerce so a
			// string/garbage value is non-finite and yields no countdown.
			const resetSec = Number(tokLim.nextResetTime) / 1000;
			// Backlog item 11: `?` marks a countdown computed against a local clock
			// that disagrees with the vendor's by more than a minute — the reset
			// time is then wrong by exactly that offset and would otherwise look
			// perfectly plausible. It rides in the same slot as the staleness "!"
			// because both qualify the number rather than replace it.
			const skewed = Number.isFinite(glm._skewMs) ? "?" : "";
			parts.push(renderQuota("glm", tokLim.percentage, resetSec, `${stale}${skewed}`));
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
	const or = loadOpenRouterCredits(cacheDir);
	if (or) {
		const stale = or._stale ? "!" : "";
		const c = colorize(or.usedPct);
		parts.push(`or:${c}${dollarTier(or.remaining)}${stale}${RESET}`);
	}

	// DeepSeek section (`ds:`, only when DEEPSEEK_API_KEY is set)
	const ds = loadDeepSeekBalance(cacheDir);
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

	// The segment goes out FIRST. Everything below is best-effort background
	// work, and a kill after this point costs a refresh, not the bar (measured:
	// killed mid-run, the already-written bytes still reach the composer).
	process.stdout.write(parts.join(" | "));

	// Trigger the background refresh only when something is actually expired,
	// and only if no other render is already doing it. Both checks are local
	// file reads — no network, and nothing here is awaited.
	if (needsRefresh(cacheDir) && takeRefreshLock(cacheDir)) {
		spawnRefresher(cacheDir);
	}
});
