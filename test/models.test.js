import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	coerceCreated,
	parseOpenRouterModels,
} from "../src/models.js";

describe("models.js pure helpers", () => {
	it("DEFAULT_CLAUDE_MODELS holds only reachable Claude ids (no haiku, no mythos)", () => {
		const ids = DEFAULT_CLAUDE_MODELS.map((m) => m.id);
		assert.deepEqual(ids, ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]);
		for (const m of DEFAULT_CLAUDE_MODELS) {
			assert.equal(m.type, "model");
			assert.equal(m.created_at, null);
			assert.ok(m.display_name.length > 0);
		}
	});

	it("DEFAULT_OPENROUTER_MODELS holds the 5 verified skin-compatible ids with curated names", () => {
		assert.deepEqual(DEFAULT_OPENROUTER_MODELS, [
			{
				type: "model",
				id: "deepseek/deepseek-v4-pro",
				display_name: "DeepSeek V4 Pro",
				created_at: null,
			},
			{
				type: "model",
				id: "deepseek/deepseek-v4-flash",
				display_name: "DeepSeek V4 Flash",
				created_at: null,
			},
			{ type: "model", id: "tencent/hy3", display_name: "Tencent Hy3", created_at: null },
			{
				type: "model",
				id: "moonshotai/kimi-k2.7-code",
				display_name: "Kimi K2.7 Code",
				created_at: null,
			},
			{ type: "model", id: "qwen/qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
		]);
	});

	it("parseOpenRouterModels splits, trims, drops empties; display_name is the id", () => {
		assert.deepEqual(parseOpenRouterModels("  a ,, b "), [
			{ type: "model", id: "a", display_name: "a", created_at: null },
			{ type: "model", id: "b", display_name: "b", created_at: null },
		]);
		assert.deepEqual(parseOpenRouterModels(""), []);
		assert.deepEqual(parseOpenRouterModels(undefined), []);
	});

	it("coerceCreated passes strings through, nulls everything else", () => {
		assert.equal(coerceCreated("2026-07-28T00:00:00Z"), "2026-07-28T00:00:00Z");
		assert.equal(coerceCreated(1700000000), null);
		assert.equal(coerceCreated(undefined), null);
		assert.equal(coerceCreated(null), null);
	});
});
