import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CONTEXT_WINDOW } from "../scripts/list-models.js";
import { MODEL_TIERS } from "../scripts/render-models.js";
import {
	DEEPSEEK_PRICING,
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
} from "../src/models.js";

// MODEL_TIERS is the display layer's only curated data (like CONTEXT_WINDOW).
// This pins its coverage so a model that appears in discovery but has no tier —
// the silent-drop class of bug that shipped opus-4-8 — is caught at the gate.
// The expected id set is DERIVED from the discovery sources of truth where one
// exists (DEEPSEEK_PRICING keys, DEFAULT_QWEN_MODELS ids, DEFAULT_CLAUDE_MODELS
// ids, DEFAULT_OPENROUTER_MODELS ids), so adding a model there auto-fails if
// MODEL_TIERS misses it. GLM is live-fetched (no static catalog), so its ids are
// pinned explicitly — the one non-derivable set, same as CONTEXT_WINDOW.
describe("render-models MODEL_TIERS", () => {
	it("covers every glm/deepseek/qwen/claude/openrouter discovery id", () => {
		const derived = [
			...Object.keys(DEEPSEEK_PRICING), // deepseek native
			...DEFAULT_QWEN_MODELS.map((m) => m.id), // qwen native
			...DEFAULT_CLAUDE_MODELS.map((m) => m.id), // claude
			...DEFAULT_OPENROUTER_MODELS.map((m) => m.id), // openrouter allowlist
		];
		// GLM discovery ids, pinned (no static GLM catalog — fetched live).
		const glmIds = [
			"glm-4.5",
			"glm-4.5-air",
			"glm-4.6",
			"glm-4.7",
			"glm-5",
			"glm-5-turbo",
			"glm-5.1",
			"glm-5.2",
		];
		for (const id of [...derived, ...glmIds]) {
			assert.ok(MODEL_TIERS[id], `MODEL_TIERS missing ${id}`);
		}
	});

	it("every tier value is one of the four known labels", () => {
		const known = new Set(["Flagship", "Strong", "Specialist", "Economy"]);
		for (const v of Object.values(MODEL_TIERS)) {
			assert.ok(known.has(v), `unknown tier value: ${v}`);
		}
	});

	it("every CONTEXT_WINDOW id also has a tier (they must stay in step)", () => {
		// CONTEXT_WINDOW is the live+curated discovery id set rendered by
		// list-models.js; the infographic's tier map must cover at least that.
		for (const id of Object.keys(CONTEXT_WINDOW)) {
			assert.ok(MODEL_TIERS[id], `MODEL_TIERS missing CONTEXT_WINDOW id ${id}`);
		}
	});
});
