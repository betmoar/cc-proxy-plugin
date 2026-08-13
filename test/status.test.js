import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatStatusReport, parseRoutingLines } from "../scripts/status.js";

describe("status.js parseRoutingLines", () => {
	const log = [
		"server listening on 4000",
		"[2026-06-19T10:00:00.000Z] claude-sonnet-4-6 -> claude",
		"[2026-06-19T10:00:01.000Z] glm-5.2[1m] -> glm",
		"  metadata: {}",
		"[2026-06-19T10:00:02.000Z] z-ai/glm-4.7 -> openrouter",
	].join("\n");

	it("keeps only routing lines, most-recent-last", () => {
		const lines = parseRoutingLines(log);
		assert.equal(lines.length, 3);
		assert.match(lines[0], /claude-sonnet-4-6 -> claude/);
		assert.match(lines[2], /z-ai\/glm-4\.7 -> openrouter/);
	});

	it("respects the limit", () => {
		const lines = parseRoutingLines(log, 1);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /openrouter/);
	});

	it("returns empty for a log with no routing lines", () => {
		assert.deepEqual(parseRoutingLines("just some noise\nno arrows here"), []);
	});

	it("keeps routing lines that carry a trailing request path", () => {
		const withPath = [
			"[2026-07-09T08:00:00.000Z] glm-5.2 -> glm /v1/messages",
			"[2026-07-09T08:00:01.000Z] unknown -> claude /v1/messages/count_tokens",
		].join("\n");
		const lines = parseRoutingLines(withPath);
		assert.equal(lines.length, 2);
		assert.match(lines[0], /glm-5\.2 -> glm \/v1\/messages$/);
		assert.match(lines[1], /unknown -> claude \/v1\/messages\/count_tokens$/);
	});
});

describe("status.js formatStatusReport", () => {
	it("reports DOWN when the proxy is unreachable", () => {
		const out = formatStatusReport({ status: { up: false } });
		assert.match(out, /proxy:\s+DOWN/);
		assert.doesNotMatch(out, /providers:/);
	});

	it("reports UP with providers, quota, credits and routing", () => {
		const out = formatStatusReport({
			status: {
				up: true,
				port: 4000,
				version: "0.4.2",
				defaultBackend: "claude",
				providers: ["glm", "openrouter", "claude"],
			},
			// Relative to NOW, not a fixed date: the report renders a countdown
			// (backlog item 10), so a hard-coded past timestamp would always read
			// "resets in now" and assert nothing about the arithmetic.
			glm: { level: "pro", pct: 37, resetMs: Date.now() + 2 * 3_600_000 + 15 * 60_000 },
			openrouter: { remaining: 4.2, usedPct: 16 },
			routing: ["[t] glm-5.2[1m] -> glm"],
		});
		assert.match(out, /proxy:\s+UP on port 4000 \(v0\.4\.2\)/);
		assert.match(out, /providers:\s+glm, openrouter, claude/);
		assert.match(out, /glm\[pro\]:\s+37% used/);
		// Both forms: the relative countdown the statusline also shows, and the
		// absolute stamp kept for pasting into an issue.
		assert.match(out, /resets in 2h1[45]m/);
		assert.match(out, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
		assert.match(out, /openrouter:\s+\$4\.20 remaining/);
		assert.match(out, /glm-5\.2\[1m\] -> glm/);
	});

	it("omits the version suffix when the proxy reports no version", () => {
		// A pre-0.4.0 proxy (before /_status carried `version`) must still render
		// a clean UP line, not "port 4000 (vundefined)".
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
		});
		assert.match(out, /proxy:\s+UP on port 4000\n/);
		assert.doesNotMatch(out, /\(v/);
	});

	it("marks stale provider data", () => {
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
			glm: { stale: true },
		});
		assert.match(out, /\(stale\)/);
	});

	it("warns when the local clock disagrees with the vendor's", () => {
		// Backlog item 11. A skewed clock makes the countdown wrong by exactly the
		// offset while looking perfectly plausible — the failure mode is silent
		// confidence, so the report has to say it out loud.
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
			glm: {
				level: "pro",
				pct: 20,
				resetMs: Date.now() + 3_600_000,
				skewMs: 5 * 60_000, // local clock 5 minutes ahead
			},
		});
		assert.match(out, /WARNING: local clock is 5m ahead of the vendor's/);
	});

	it("says nothing about the clock when no skew was measured", () => {
		// Absent skewMs means "checked and within threshold", or "not measured" —
		// neither is a problem, and a warning either way would train the reader to
		// ignore the line that matters.
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
			glm: { level: "pro", pct: 20, resetMs: Date.now() + 3_600_000 },
		});
		assert.doesNotMatch(out, /WARNING: local clock/);
	});

	it("omits the reset stamp for a NaN resetMs without throwing", () => {
		// new Date(NaN).toISOString() throws RangeError; a corrupt upstream
		// nextResetTime must not crash /cc-proxy:status rendering.
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
			glm: { level: "pro", pct: 5, resetMs: Number.NaN },
		});
		assert.match(out, /glm\[pro\]:\s+5% used/);
		assert.doesNotMatch(out, /resets/);
	});
});
