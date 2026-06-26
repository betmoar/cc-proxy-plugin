import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	CONTEXT_EXCEEDED_STOP_REASON,
	RATE_LIMIT_ERROR_CODE,
	RATE_LIMIT_RETRY_AFTER_SECONDS,
	isContextLimitByStopReason,
	isRateLimitError,
} from "../src/fallback.js";

describe("isContextLimitByStopReason", () => {
	it("true when top-level stop_reason is the sentinel", () => {
		assert.equal(
			isContextLimitByStopReason({ content: [], stop_reason: CONTEXT_EXCEEDED_STOP_REASON }),
			true,
		);
	});
	it("false for normal stop_reasons", () => {
		for (const r of ["end_turn", "max_tokens", "tool_use", null]) {
			assert.equal(isContextLimitByStopReason({ stop_reason: r }), false);
		}
	});
	it("false when the sentinel carries non-empty content (don't drop real content)", () => {
		assert.equal(
			isContextLimitByStopReason({
				content: [{ type: "text", text: "hi" }],
				stop_reason: CONTEXT_EXCEEDED_STOP_REASON,
			}),
			false,
		);
	});
	it("false for non-objects", () => {
		assert.equal(isContextLimitByStopReason(null), false);
		assert.equal(isContextLimitByStopReason("x"), false);
		assert.equal(isContextLimitByStopReason(undefined), false);
	});
	it("exports the sentinel", () => {
		assert.equal(CONTEXT_EXCEEDED_STOP_REASON, "model_context_window_exceeded");
	});
});

describe("isRateLimitError", () => {
	it("true for GLM 1302 rate-limit body (string or number code)", () => {
		assert.equal(
			isRateLimitError({ error: { code: "1302", message: "Rate limit reached" } }),
			true,
		);
		assert.equal(isRateLimitError({ error: { code: 1302, message: "Rate limit reached" } }), true);
	});
	it("false for the sibling balance code 1113 (not a rate limit)", () => {
		assert.equal(
			isRateLimitError({ error: { code: "1113", message: "Insufficient balance" } }),
			false,
		);
	});
	it("false for other error codes and shapes", () => {
		assert.equal(isRateLimitError({ error: { code: "1313", message: "FUP" } }), false);
		assert.equal(isRateLimitError({ error: {} }), false);
		assert.equal(isRateLimitError({}), false);
		assert.equal(isRateLimitError(null), false);
		assert.equal(isRateLimitError("x"), false);
	});
	it("exports the code and retry-after constants", () => {
		assert.equal(RATE_LIMIT_ERROR_CODE, "1302");
		assert.equal(RATE_LIMIT_RETRY_AFTER_SECONDS, 30);
	});
});
