import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CONTEXT_EXCEEDED_STOP_REASON, isContextLimitByStopReason } from "../src/fallback.js";

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
