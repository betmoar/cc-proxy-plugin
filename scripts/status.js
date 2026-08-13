#!/usr/bin/env node
// On-demand diagnostic for the cc-proxy router. Hits the proxy's /_status
// endpoint for authoritative routing config, layers on provider quota/credits,
// and tails recent routing decisions from the proxy log. Pure-IO `main()` at
// the bottom; the formatting/parsing helpers above are exported for testing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.js";
import { fetchGlmQuota, fetchOpenRouterCredits, formatDuration } from "./quota.js";

// Load API keys from ~/.env (+ repo .env in dev) so the quota/credit fetches
// below work once keys move out of settings.json `env`. process.env still wins.
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
// COUPLING: must match DEFAULT_LOG_PATH in hooks/proxy-lifecycle.js — the hook
// picks where the proxy writes, this reads it back. A split default means the
// status report tails a file nobody writes ("no routing decisions yet", always).
// Not imported: scripts/ deliberately doesn't reach into hooks/. Locked by
// test/couplings.test.js.
const LOG_PATH =
	process.env.PROXY_LOG || path.join(os.homedir(), ".claude", "cc-proxy", "cc-proxy.log");
// Provider endpoints/timeout/shaping live in ./quota.js — shared with
// scripts/statusline.js so the two copies can't drift again (they did once: the
// statusline grew a fetch timeout and this file didn't, fixed 0.3.1). The
// /_status probe below stays local; it's this script's own proxy, not a vendor.
const STATUS_TIMEOUT_MS = 2000;

/**
 * Pull the most recent routing decisions out of the proxy log. The proxy logs
 * one line per request as `[<iso>] <model> -> <providerId> <path>`; we keep those.
 * @param {string} logText
 * @param {number} [limit]
 * @returns {string[]} most-recent-last
 */
export function parseRoutingLines(logText, limit = 8) {
	const lines = logText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => / -> /.test(l) && l.startsWith("["));
	return lines.slice(-limit);
}

/**
 * Render the assembled status into a plain-text report.
 * @param {object} data
 * @param {{ up: boolean, port?: number, version?: string, defaultBackend?: string, providers?: string[] }} data.status
 * @param {{ level?: string, pct?: number, resetMs?: number, skewMs?: number, stale?: boolean } | null} [data.glm]
 * @param {{ remaining?: number, usedPct?: number, stale?: boolean } | null} [data.openrouter]
 * @param {string[]} [data.routing]
 * @returns {string}
 */
export function formatStatusReport(data) {
	const { status, glm, openrouter, routing = [] } = data;
	const lines = [];

	if (!status.up) {
		lines.push("proxy:        DOWN (no response on /_status)");
		lines.push(`port:         ${PORT}`);
		lines.push("");
		lines.push("Start a new Claude Code session to re-trigger the SessionStart hook,");
		lines.push(`or inspect ${LOG_PATH}.`);
		return lines.join("\n");
	}

	const ver = status.version ? ` (v${status.version})` : "";
	lines.push(`proxy:        UP on port ${status.port}${ver}`);
	lines.push(`default:      ${status.defaultBackend}`);
	lines.push(`providers:    ${(status.providers || []).join(", ")}`);

	if (glm) {
		const stale = glm.stale ? " (stale)" : "";
		const pct = typeof glm.pct === "number" ? `${glm.pct}% used` : "n/a";
		// Backlog item 10: the absolute UTC stamp made a reader in any other zone
		// do the arithmetic, while the statusline showed a relative countdown for
		// the same fact. Both are now relative, from the same resetMs this already
		// had. Not a timezone bug — there was never one — purely a format change.
		// The UTC stamp is kept alongside it: this is a one-shot diagnostic report
		// that may be pasted into an issue, where an absolute time still helps.
		//
		// Number.isFinite, not typeof === "number": a NaN resetMs would pass the
		// looser check and throw a RangeError from Date#toISOString.
		const reset = Number.isFinite(glm.resetMs)
			? ` (resets in ${formatDuration(glm.resetMs - Date.now())}, ${new Date(glm.resetMs)
					.toISOString()
					.replace(/\.\d{3}Z$/, "Z")})`
			: "";
		// A clock disagreeing with the vendor's by more than a minute makes the
		// countdown above wrong by exactly that much (backlog item 11). The
		// statusline marks this with `?`; here there is room to name it.
		const skew = Number.isFinite(glm.skewMs)
			? `\n              WARNING: local clock is ${formatDuration(Math.abs(glm.skewMs))} ${
					glm.skewMs > 0 ? "ahead of" : "behind"
				} the vendor's — the reset time above is off by that much`
			: "";
		lines.push(`glm[${glm.level || "?"}]:     ${pct} of 5h coding quota${stale}${reset}${skew}`);
	}
	if (openrouter) {
		const stale = openrouter.stale ? " (stale)" : "";
		const rem =
			typeof openrouter.remaining === "number" ? `$${openrouter.remaining.toFixed(2)}` : "n/a";
		lines.push(`openrouter:   ${rem} remaining${stale}`);
	}

	lines.push("");
	if (routing.length) {
		lines.push("recent routing:");
		for (const r of routing) lines.push(`  ${r}`);
	} else {
		lines.push(`recent routing: none yet (no requests logged in ${LOG_PATH})`);
	}
	return lines.join("\n");
}

async function fetchJson(url, headers) {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function probeStatus() {
	try {
		const json = await fetchJson(`http://127.0.0.1:${PORT}/_status`);
		return {
			up: true,
			port: json.port,
			version: json.version,
			defaultBackend: json.defaultBackend,
			providers: json.providers,
		};
	} catch {
		return { up: false };
	}
}

async function loadGlm() {
	if (!process.env.GLM_API_KEY) return null;
	try {
		const data = await fetchGlmQuota(process.env.GLM_API_KEY);
		const tok = (data.limits || []).find((l) => l.type === "TOKENS_LIMIT");
		return {
			level: data.level,
			pct: tok ? tok.percentage : undefined,
			resetMs: tok ? tok.nextResetTime : undefined,
			// Present only when the fetcher measured a skew past its threshold —
			// absent means "checked and fine", not "unknown". See CLOCK_SKEW_THRESHOLD_MS.
			skewMs: data._skewMs,
		};
	} catch {
		return { level: undefined, pct: undefined, stale: true };
	}
}

async function loadOpenRouter() {
	if (!process.env.OPENROUTER_API_KEY) return null;
	try {
		return await fetchOpenRouterCredits(process.env.OPENROUTER_API_KEY);
	} catch {
		return { remaining: undefined, stale: true };
	}
}

function readRouting() {
	try {
		return parseRoutingLines(fs.readFileSync(LOG_PATH, "utf8"));
	} catch {
		return [];
	}
}

async function main() {
	const status = await probeStatus();
	if (!status.up) {
		process.stdout.write(`${formatStatusReport({ status })}\n`);
		return;
	}
	const [glm, openrouter] = await Promise.all([loadGlm(), loadOpenRouter()]);
	const routing = readRouting();
	process.stdout.write(`${formatStatusReport({ status, glm, openrouter, routing })}\n`);
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		process.stderr.write(`cc-proxy status error: ${err.message}\n`);
		process.exit(1);
	});
}
