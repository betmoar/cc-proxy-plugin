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
				defaultBackend: "claude",
				providers: ["glm", "openrouter", "claude"],
			},
			glm: { level: "pro", pct: 37, resetMs: Date.UTC(2026, 5, 26, 12, 0) },
			openrouter: { remaining: 4.2, usedPct: 16 },
			routing: ["[t] glm-5.2[1m] -> glm"],
		});
		assert.match(out, /proxy:\s+UP on port 4000/);
		assert.match(out, /providers:\s+glm, openrouter, claude/);
		assert.match(out, /glm\[pro\]:\s+37% used/);
		assert.match(out, /resets 2026-06-26T12:00:00Z/);
		assert.match(out, /openrouter:\s+\$4\.20 remaining/);
		assert.match(out, /glm-5\.2\[1m\] -> glm/);
	});

	it("marks stale provider data", () => {
		const out = formatStatusReport({
			status: { up: true, port: 4000, defaultBackend: "claude", providers: ["glm"] },
			glm: { stale: true },
		});
		assert.match(out, /\(stale\)/);
	});
});
