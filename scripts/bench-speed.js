#!/usr/bin/env node
// @ts-check
/**
 * bench-speed — measure ROUTE HEALTH through the running proxy: how long a
 * minimal turn takes per model id, and whether the route answers at all.
 *
 * This is NOT a capability benchmark and must never feed `grade` (see
 * bench-grades.js). n is small and the task is trivial; what it measures is the
 * route, not the weights. What it CAN see that no external benchmark can:
 *
 *   - **route drift** — a route that sat at 3s for weeks and now sits at 20s
 *     means the vendor changed something;
 *   - **silent model swaps** — the same trivial task over time, same id;
 *   - **a route that has simply stopped answering.**
 *
 * APPEND-ONLY, one JSON line per measurement. A single ping is noise: latency
 * during one short moment can be the network. Judge the SERIES (`--report`
 * prints median and p95 over the last N), never a single row.
 *
 * Every row records `proxy_pid` and `proxy_version`. That is not bookkeeping:
 * issue #24 showed the binary on the port can be swapped underneath a running
 * measurement, and a latency series that silently spans two different builds is
 * worse than no series. A row whose pid differs from its neighbours is a row to
 * distrust.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.js";
import { isDirectRun } from "./direct-run.js";

loadEnv();

export const OUT_DIR = path.join(os.homedir(), ".claude", "cc-proxy");
export const OUT_PATH = path.join(OUT_DIR, "speed.jsonl");
const PORT = Number(process.env.PROXY_PORT || 4000);
const TIMEOUT_MS = 120000;

/**
 * Which PID owns the proxy port, and what version it reports. Both are recorded
 * with every measurement so a series can be checked for a mid-run binary swap
 * (#24) rather than silently averaging across two builds.
 *
 * @param {number} port
 * @returns {Promise<{pid: number|null, version: string|null}>}
 */
export async function proxyIdentity(port) {
	/** @type {number|null} */
	let pid = null;
	try {
		// lsof is the only reliable answer: /_status tells you what ANSWERED, not
		// what is bound — during a swap those differ for a second or two.
		const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const first = out.trim().split("\n")[0];
		pid = first ? Number(first) : null;
	} catch {
		// lsof missing (or nothing listening) — a null pid is honest.
	}

	/** @type {string|null} */
	let version = null;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/_status`, {
			signal: AbortSignal.timeout(2000),
		});
		const json = await res.json();
		version = typeof json.version === "string" ? json.version : null;
	} catch {}

	return { pid, version };
}

/**
 * Is anything listening on the port? Cheap pre-flight so a whole run does not
 * append a column of connection errors when the proxy is simply down.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portOpen(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ port, host: "127.0.0.1" });
		const done = (/** @type {boolean} */ v) => {
			sock.destroy();
			resolve(v);
		};
		sock.setTimeout(300);
		sock.on("connect", () => done(true));
		sock.on("timeout", () => done(false));
		sock.on("error", () => done(false));
	});
}

/**
 * Time one minimal turn through the proxy.
 *
 * Deliberately `fetch` straight at the proxy rather than driving the `claude`
 * CLI: the CLI cannot be retargeted per invocation (its ANTHROPIC_BASE_URL comes
 * from settings.json — issue #25), so a CLI-driven bench may silently measure a
 * different proxy than the one it means to. Speaking HTTP directly removes the
 * question.
 *
 * @param {string} id
 * @param {number} port
 * @returns {Promise<{id: string, route: string|null, ms: number, ok: boolean, status: number|null, err?: string}>}
 */
export async function timeOne(id, port) {
	const started = Date.now();
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
			method: "POST",
			// PROXY_AUTH_TOKEN (#45): presented when configured so the bench works
			// against an auth-gated proxy. Never logged.
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...(process.env.PROXY_AUTH_TOKEN
					? { authorization: `Bearer ${process.env.PROXY_AUTH_TOKEN}` }
					: {}),
			},
			body: JSON.stringify({
				model: id,
				max_tokens: 4,
				messages: [{ role: "user", content: "ok" }],
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const ms = Date.now() - started;
		let route = null;
		try {
			const json = await res.json();
			// The proxy echoes the upstream's own model id; a mismatch with what we
			// asked for is itself a finding worth keeping.
			route = typeof json?.model === "string" ? json.model : null;
		} catch {}
		return { id, route, ms, ok: res.ok, status: res.status };
	} catch (e) {
		return {
			id,
			route: null,
			ms: Date.now() - started,
			ok: false,
			status: null,
			err: e instanceof Error ? e.name : String(e),
		};
	}
}

/**
 * Median and p95 of a numeric series. Both, because a median hides the stall
 * that a p95 exposes — and a stalled route is the interesting case here.
 *
 * @param {number[]} xs
 * @returns {{n: number, median: number, p95: number, min: number, max: number} | null}
 */
export function summarize(xs) {
	const s = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (s.length === 0) return null;
	const at = (/** @type {number} */ q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return { n: s.length, median: at(0.5), p95: at(0.95), min: s[0], max: s[s.length - 1] };
}

/**
 * Read the log back and summarize per id. Exported for tests.
 * @param {string} text  raw jsonl
 * @param {number} [last]  consider only the most recent N rows per id
 * @returns {Map<string, {ok: number, fail: number, stats: ReturnType<typeof summarize>, builds: string[]}>}
 */
export function report(text, last = 20) {
	/** @type {Map<string, any[]>} */
	const byId = new Map();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (!row?.id) continue;
			byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
		} catch {
			// A truncated final line (killed mid-write) must not poison the report.
		}
	}

	const out = new Map();
	for (const [id, rows] of byId) {
		const recent = rows.slice(-last);
		const okRows = recent.filter((r) => r.ok);
		out.set(id, {
			ok: okRows.length,
			fail: recent.length - okRows.length,
			stats: summarize(okRows.map((r) => r.ms)),
			// Distinct builds in the window — more than one means the series spans
			// a binary swap and the numbers are not comparable (#24).
			builds: [...new Set(recent.map((r) => `${r.proxy_version}#${r.proxy_pid}`))],
		});
	}
	return out;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--report")) {
		if (!fs.existsSync(OUT_PATH)) {
			console.log(`cc-proxy speed: no measurements yet (${OUT_PATH})`);
			return;
		}
		const rows = report(fs.readFileSync(OUT_PATH, "utf8"));
		console.log(`cc-proxy speed — last 20 per id, from ${OUT_PATH}\n`);
		console.log(
			`  ${"id".padEnd(28)} ${"n".padEnd(4)} ${"median".padEnd(9)} ${"p95".padEnd(9)} fail`,
		);
		for (const [id, r] of rows) {
			const s = r.stats;
			const warn = r.builds.length > 1 ? "  ⚠ spans >1 proxy build" : "";
			console.log(
				`  ${id.padEnd(28)} ${String(s?.n ?? 0).padEnd(4)} ${`${s?.median ?? "—"}ms`.padEnd(9)} ${`${s?.p95 ?? "—"}ms`.padEnd(9)} ${r.fail}${warn}`,
			);
		}
		console.log("\n  One ping is noise — judge the series. A rising median is route drift.");
		return;
	}

	if (!(await portOpen(PORT))) {
		console.error(`cc-proxy speed: nothing listening on :${PORT}. Start the proxy first.`);
		process.exit(1);
	}

	const { MODEL_GRADES } = await import("../src/models.js");
	const ids = args.filter((a) => !a.startsWith("--"));
	const targets =
		ids.length > 0
			? ids
			: Object.keys(MODEL_GRADES).filter(
					(i) =>
						// A slash id is the same weights via a reseller: timing it measures
						// OpenRouter's queue, not a route this proxy picks by default.
						!i.includes("/") &&
						// Claude is OAuth PASSTHROUGH — the proxy forwards the caller's
						// credentials and adds none. A direct HTTP call from a script has
						// none to forward, so `claude-*` answers 401 here regardless of
						// route health (verified 2026-08-08). Measuring it would append a
						// column of failures that say nothing about the route. Pass a
						// claude id explicitly if you have a token to test with.
						!i.startsWith("claude-"),
				);

	const identity = await proxyIdentity(PORT);
	console.log(
		`cc-proxy speed — proxy pid=${identity.pid ?? "?"} version=${identity.version ?? "?"} on :${PORT}`,
	);
	console.log(`  measuring ${targets.length} ids, one minimal turn each\n`);

	fs.mkdirSync(OUT_DIR, { recursive: true });
	for (const id of targets) {
		const r = await timeOne(id, PORT);
		// Re-read identity per row: a swap mid-run is exactly what #24 does, and a
		// series that silently spans two builds is worse than no series.
		const now = await proxyIdentity(PORT);
		const row = {
			ts: new Date().toISOString(),
			...r,
			proxy_pid: now.pid,
			proxy_version: now.version,
		};
		fs.appendFileSync(OUT_PATH, `${JSON.stringify(row)}\n`);
		const mark = r.ok ? "ok " : "FAIL";
		const detail = r.ok ? (r.route ?? "") : (r.err ?? `HTTP ${r.status}`);
		console.log(`  ${mark} ${id.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${detail}`);
	}

	console.log(`\n  appended to ${OUT_PATH}`);
	console.log("  Run with --report for median/p95 over the series.");
	console.log("  These are ROUTE measurements. They never feed `grade` — n is small");
	console.log("  and the task is trivial; capability comes from benchlm (bench-grades).");
}

if (isDirectRun(import.meta.url)) {
	main().catch((e) => {
		console.error(`cc-proxy bench-speed failed: ${e.message}`);
		process.exit(1);
	});
}
