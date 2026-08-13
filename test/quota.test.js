import { strict as assert } from "node:assert";
import fs from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CLOCK_SKEW_THRESHOLD_MS,
	clockSkewMs,
	fetchGlmQuota,
	formatDuration,
} from "../scripts/quota.js";

// A stub standing in for api.z.ai. `dateHeader` controls the `Date` response
// header the skew check reads: a string sets it, null suppresses it entirely
// (node sends one by default, so suppressing takes an explicit removeHeader).
async function glmStub({ dateHeader }) {
	const server = http.createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		if (dateHeader === null) res.removeHeader("Date");
		else if (dateHeader) res.setHeader("Date", dateHeader);
		res.end(
			JSON.stringify({
				data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", percentage: 40 }] },
			}),
		);
	});
	// sendDate:false is the only way to stop node stamping its own Date header.
	if (dateHeader === null) server.sendDate = false;
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		close: () => new Promise((r) => server.close(r)),
	};
}

describe("formatDuration", () => {
	it("renders hours and minutes, dropping a zero minute part", () => {
		assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), "2h15m");
		assert.equal(formatDuration(3 * 3_600_000), "3h");
		assert.equal(formatDuration(45 * 60_000), "45m");
	});

	it("collapses elapsed, zero and non-finite spans to 'now'", () => {
		// A window that already rolled over and one about to are the same
		// actionable fact; NaN must not reach the arithmetic and print "NaNh".
		assert.equal(formatDuration(-5000), "now");
		assert.equal(formatDuration(0), "now");
		assert.equal(formatDuration(Number.NaN), "now");
	});

	it("is the single spelling shared by the statusline and the CLI", () => {
		// Backlog item 10: the two tools rendered the same fact differently. This
		// locks that both read it from here — a second private copy would drift.
		const statusline = fs.readFileSync(
			fileURLToPath(new URL("../scripts/statusline.js", import.meta.url)),
			"utf8",
		);
		assert.match(statusline, /formatDuration/, "statusline must use the shared formatter");
		assert.doesNotMatch(
			statusline,
			/Math\.floor\(diffMs \/ 3_600_000\)/,
			"statusline must not carry its own duration arithmetic",
		);
	});
});

describe("clockSkewMs", () => {
	it("returns null for a missing or unparseable Date header", () => {
		// null is "unknown" and must never be confused with 0 ("clocks agree") —
		// a false reassurance is exactly what this check exists to withhold.
		assert.equal(clockSkewMs(new Headers()), null);
		assert.equal(clockSkewMs(new Headers({ date: "not-a-date" })), null);
		assert.equal(clockSkewMs(undefined), null);
	});

	it("is positive when the local clock is ahead of the server", () => {
		const serverTime = new Date(Date.now() - 120_000).toUTCString();
		const skew = clockSkewMs(new Headers({ date: serverTime }));
		assert.ok(skew > 60_000, `Expected a positive skew near 120s, got ${skew}`);
	});
});

describe("fetchGlmQuota clock-skew attachment", () => {
	it("attaches _skewMs only past the threshold", async () => {
		// Backlog item 11. The threshold is deliberately loose (60s) because
		// request latency inflates apparent skew by up to the round-trip time.
		const skewed = new Date(Date.now() - 10 * 60_000).toUTCString();
		const stub = await glmStub({ dateHeader: skewed });
		try {
			const res = await fetchGlmQuotaAt(stub.url, "key");
			assert.ok(
				Math.abs(res._skewMs) > CLOCK_SKEW_THRESHOLD_MS,
				`Expected a skew past the threshold, got ${res._skewMs}`,
			);
		} finally {
			await stub.close();
		}
	});

	it("omits _skewMs when the clocks agree", async () => {
		// Absent, never 0: `"_skewMs" in data` is what tells a reader the check
		// ran and found nothing, the same omit-don't-invent rule /v1/models uses.
		const stub = await glmStub({ dateHeader: new Date().toUTCString() });
		try {
			const res = await fetchGlmQuotaAt(stub.url, "key");
			assert.ok(!("_skewMs" in res), `Expected no _skewMs key, got ${JSON.stringify(res)}`);
		} finally {
			await stub.close();
		}
	});

	it("omits _skewMs when the server sends no Date header", async () => {
		const stub = await glmStub({ dateHeader: null });
		try {
			const res = await fetchGlmQuotaAt(stub.url, "key");
			assert.ok(!("_skewMs" in res), `Expected no _skewMs key, got ${JSON.stringify(res)}`);
		} finally {
			await stub.close();
		}
	});
});

// QUOTA_URL is a module constant (the endpoint is not a user knob), so the test
// re-implements the one line that would differ — pointing the same fetch at a
// stub — rather than adding a production seam that exists only for tests.
async function fetchGlmQuotaAt(url, apiKey) {
	const original = globalThis.fetch;
	globalThis.fetch = (target, init) =>
		original(typeof target === "string" && target.startsWith("https://") ? url : target, init);
	try {
		return await fetchGlmQuota(apiKey);
	} finally {
		globalThis.fetch = original;
	}
}
