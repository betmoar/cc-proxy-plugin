import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { report, summarize } from "../scripts/bench-speed.js";

describe("summarize", () => {
	it("reports median and p95, because a median hides the stall", () => {
		// The interesting case for route health is the tail: nine fast turns and
		// one 90s stall have a healthy median and a damning p95.
		const s = summarize([100, 100, 100, 100, 100, 100, 100, 100, 100, 90000]);
		assert.equal(s.median, 100);
		assert.equal(s.max, 90000);
		assert.ok(s.p95 >= 100);
	});

	it("returns null for an empty series rather than 0", () => {
		// 0ms would read as an instant route; absence must stay absence.
		assert.equal(summarize([]), null);
		assert.equal(summarize([Number.NaN]), null);
	});

	it("ignores non-finite samples", () => {
		const s = summarize([10, Number.NaN, 20, Number.POSITIVE_INFINITY]);
		assert.equal(s.n, 2);
	});
});

describe("report", () => {
	const row = (o) =>
		`${JSON.stringify({ ts: "2026-01-01T00:00:00Z", proxy_pid: 1, proxy_version: "0.6.1", ...o })}\n`;

	it("groups by id and separates ok from fail", () => {
		const text =
			row({ id: "glm-5.2", ms: 100, ok: true }) +
			row({ id: "glm-5.2", ms: 300, ok: true }) +
			row({ id: "glm-5.2", ms: 50, ok: false }) +
			row({ id: "deepseek-v4-pro", ms: 200, ok: true });
		const r = report(text);
		assert.equal(r.get("glm-5.2").ok, 2);
		assert.equal(r.get("glm-5.2").fail, 1);
		// A failed turn's duration is meaningless — it must not enter the stats.
		assert.equal(r.get("glm-5.2").stats.n, 2);
		assert.equal(r.get("deepseek-v4-pro").ok, 1);
	});

	it("flags a window that spans more than one proxy build", () => {
		// Issue #24: the binary on the port can be swapped underneath a series.
		// Averaging across two builds is worse than having no series at all.
		const text =
			row({ id: "glm-5.2", ms: 100, ok: true, proxy_pid: 1, proxy_version: "0.6.0" }) +
			row({ id: "glm-5.2", ms: 100, ok: true, proxy_pid: 2, proxy_version: "0.6.1" });
		assert.equal(report(text).get("glm-5.2").builds.length, 2);
	});

	it("reports a single build when the series is clean", () => {
		const text =
			row({ id: "glm-5.2", ms: 100, ok: true }) + row({ id: "glm-5.2", ms: 120, ok: true });
		assert.equal(report(text).get("glm-5.2").builds.length, 1);
	});

	it("keeps only the most recent N per id", () => {
		const text = Array.from({ length: 30 }, (_, i) => row({ id: "x", ms: i, ok: true })).join("");
		assert.equal(report(text, 5).get("x").stats.n, 5);
	});

	it("survives a truncated final line", () => {
		// A run killed mid-write leaves a partial row; it must not poison the
		// whole report.
		const text = `${row({ id: "glm-5.2", ms: 100, ok: true })}{"id":"glm-5.2","ms":`;
		assert.equal(report(text).get("glm-5.2").ok, 1);
	});

	it("returns an empty map for empty input", () => {
		assert.equal(report("").size, 0);
	});
});
