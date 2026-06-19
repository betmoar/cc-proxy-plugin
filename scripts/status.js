#!/usr/bin/env node
// On-demand diagnostic for the cc-proxy router. Hits the proxy's /_status
// endpoint for authoritative routing config, layers on provider quota/credits,
// and tails recent routing decisions from the proxy log. Pure-IO `main()` at
// the bottom; the formatting/parsing helpers above are exported for testing.

import fs from "node:fs";

const PORT = Number(process.env.PROXY_PORT || 4000);
const LOG_PATH = process.env.PROXY_LOG || "/tmp/cc-proxy.log";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const FETCH_TIMEOUT_MS = 1500;

/**
 * Pull the most recent routing decisions out of the proxy log. The proxy logs
 * one line per request as `[<iso>] <model> -> <providerId>`; we keep those.
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
 * @param {{ up: boolean, port?: number, defaultBackend?: string, providers?: string[] }} data.status
 * @param {{ level?: string, pct?: number, stale?: boolean } | null} [data.glm]
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

	lines.push(`proxy:        UP on port ${status.port}`);
	lines.push(`default:      ${status.defaultBackend}`);
	lines.push(`providers:    ${(status.providers || []).join(", ")}`);

	if (glm) {
		const stale = glm.stale ? " (stale)" : "";
		const pct = typeof glm.pct === "number" ? `${glm.pct}% used` : "n/a";
		lines.push(`glm[${glm.level || "?"}]:     ${pct} of 5h coding quota${stale}`);
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
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function probeStatus() {
	try {
		const json = await fetchJson(`http://127.0.0.1:${PORT}/_status`);
		return {
			up: true,
			port: json.port,
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
		const json = await fetchJson(QUOTA_URL, { Authorization: process.env.GLM_API_KEY });
		const data = json.data || {};
		const tok = (data.limits || []).find((l) => l.type === "TOKENS_LIMIT");
		return { level: data.level, pct: tok ? tok.percentage : undefined };
	} catch {
		return { level: undefined, pct: undefined, stale: true };
	}
}

async function loadOpenRouter() {
	if (!process.env.OPENROUTER_API_KEY) return null;
	try {
		const json = await fetchJson(OPENROUTER_CREDITS_URL, {
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		});
		const total = Number(json?.data?.total_credits) || 0;
		const used = Number(json?.data?.total_usage) || 0;
		return { remaining: total - used, usedPct: total > 0 ? Math.round((used / total) * 100) : 0 };
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
