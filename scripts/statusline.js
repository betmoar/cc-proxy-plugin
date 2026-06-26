#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
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

async function loadGlmQuota(cacheDir) {
	const apiKey = process.env.GLM_API_KEY;
	if (!apiKey) return null;

	const cachePath = cacheDir ? path.join(cacheDir, "glm_quota_cache.json") : null;

	// Try cache first
	if (cachePath) {
		try {
			const raw = fs.readFileSync(cachePath, "utf8");
			const cached = JSON.parse(raw);
			if (Date.now() - cached._ts < CACHE_TTL_MS) return cached;
		} catch {
			// No cache or invalid — proceed to API call
		}
	}

	// Fetch from API
	// The quota endpoint accepts Authorization, x-api-key, and Bearer formats.
	try {
		const res = await fetch(QUOTA_URL, { headers: { Authorization: apiKey } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const result = { ...json.data, _ts: Date.now() };

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
				const raw = fs.readFileSync(cachePath, "utf8");
				const stale = JSON.parse(raw);
				stale._stale = true;
				return stale;
			} catch {
				return null;
			}
		}
		return null;
	}
}

// OpenRouter credits (opt-in via OPENROUTER_API_KEY). Same 60s cache + stale
// fallback as the GLM quota. Remaining = total_credits - total_usage.
async function loadOpenRouterCredits(cacheDir) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return null;

	const cachePath = cacheDir ? path.join(cacheDir, "openrouter_credits_cache.json") : null;
	if (cachePath) {
		try {
			const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
			if (Date.now() - cached._ts < CACHE_TTL_MS) return cached;
		} catch {
			// miss → fetch
		}
	}

	try {
		const res = await fetch(OPENROUTER_CREDITS_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(800),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const total = Number(json?.data?.total_credits) || 0;
		const used = Number(json?.data?.total_usage) || 0;
		const result = {
			remaining: total - used,
			usedPct: total > 0 ? Math.round((used / total) * 100) : 0,
			_ts: Date.now(),
		};
		if (cachePath) {
			try {
				fs.mkdirSync(path.dirname(cachePath), { recursive: true });
				fs.writeFileSync(cachePath, JSON.stringify(result));
			} catch {
				// non-fatal
			}
		}
		return result;
	} catch {
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
	// CLAUDE_PLUGIN_DATA is only set in plugin hook context, not in statusLine.
	// Fall back to /tmp for cache when run from settings.json statusLine command.
	const cacheDir = process.env.CLAUDE_PLUGIN_DATA || "/tmp";

	// Proxy liveness probe (cached 1s). The indicator is appended at the tail
	// so the primary quota signals read first; bold-red differentiates it
	// from the non-bold RED used by quota gauges at ≥85%.
	const proxyAlive = await checkProxyAlive(PROXY_PORT, cacheDir);

	// Claude section: 5h usage + reset time
	const rl = input.rate_limits;
	if (rl?.five_hour) {
		const pct = Math.round(rl.five_hour.used_percentage);
		const c = colorize(pct);
		const reset = formatResetTime(rl.five_hour.resets_at);
		parts.push(`claude 5h:${c}${pct}%${RESET} ~${reset}`);
	} else {
		parts.push("claude 5h:--");
	}

	// GLM section
	const glm = await loadGlmQuota(cacheDir);
	if (glm) {
		const stale = glm._stale ? "!" : "";
		const level = glm.level || "?";

		// TOKENS_LIMIT = 5-hour coding quota (confirmed via zai-org/zai-coding-plugins)
		const tokLim = glm.limits?.find((l) => l.type === "TOKENS_LIMIT");
		if (tokLim) {
			const pct = tokLim.percentage;
			const c = colorize(pct);
			// nextResetTime is epoch ms; formatResetTime takes seconds.
			const reset = tokLim.nextResetTime ? ` ~${formatResetTime(tokLim.nextResetTime / 1000)}` : "";
			parts.push(`glm[${level}] 5h:${c}${pct}%${stale}${RESET}${reset}`);
		} else {
			parts.push(`glm[${level}] --`);
		}
	}

	// OpenRouter section (only when OPENROUTER_API_KEY is set)
	const or = await loadOpenRouterCredits(cacheDir);
	if (or) {
		const stale = or._stale ? "!" : "";
		const c = colorize(or.usedPct);
		parts.push(`or:${c}$${or.remaining.toFixed(2)}${stale}${RESET}`);
	}

	if (!proxyAlive) {
		parts.push(`${RED_BOLD}proxy down${RESET}`);
	}

	process.stdout.write(parts.join(" | "));
});
