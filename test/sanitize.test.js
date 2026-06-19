import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { stripAssistantThinking } from "../src/sanitize.js";

describe("stripAssistantThinking", () => {
	it("removes thinking blocks from assistant messages", () => {
		const body = {
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "...", signature: "abc" },
						{ type: "text", text: "Hello!" },
					],
				},
			],
		};
		const { body: out, modified } = stripAssistantThinking(body);
		assert.equal(modified, true);
		assert.deepEqual(out.messages[1].content, [{ type: "text", text: "Hello!" }]);
		// Original untouched
		assert.equal(body.messages[1].content.length, 2);
	});

	it("also removes redacted_thinking blocks", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "xyz" },
						{ type: "text", text: "ok" },
					],
				},
			],
		};
		const { body: out, modified } = stripAssistantThinking(body);
		assert.equal(modified, true);
		assert.equal(out.messages[0].content.length, 1);
		assert.equal(out.messages[0].content[0].type, "text");
	});

	it("leaves user messages alone", () => {
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
		};
		const { modified } = stripAssistantThinking(body);
		assert.equal(modified, false);
	});

	it("leaves string-content messages alone", () => {
		const body = {
			messages: [{ role: "assistant", content: "plain text" }],
		};
		const { modified } = stripAssistantThinking(body);
		assert.equal(modified, false);
	});

	it("returns modified=false when there's nothing to strip", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "no thinking here" }],
				},
			],
		};
		const { body: out, modified } = stripAssistantThinking(body);
		assert.equal(modified, false);
		assert.equal(out, body);
	});

	it("handles body without messages field", () => {
		const { modified } = stripAssistantThinking({ model: "x" });
		assert.equal(modified, false);
	});

	it("handles null/undefined body", () => {
		assert.equal(stripAssistantThinking(null).modified, false);
		assert.equal(stripAssistantThinking(undefined).modified, false);
	});

	it("strips across multiple assistant messages", () => {
		const body = {
			messages: [
				{ role: "user", content: "1" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", signature: "s1" },
						{ type: "text", text: "a" },
					],
				},
				{ role: "user", content: "2" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", signature: "s2" },
						{ type: "text", text: "b" },
					],
				},
			],
		};
		const { body: out, modified } = stripAssistantThinking(body);
		assert.equal(modified, true);
		assert.equal(out.messages[1].content.length, 1);
		assert.equal(out.messages[3].content.length, 1);
	});

	it("preserves top-level `thinking` request option (not history)", () => {
		const body = {
			thinking: { type: "enabled", budget_tokens: 1000 },
			messages: [{ role: "user", content: "hi" }],
		};
		const { body: out, modified } = stripAssistantThinking(body);
		assert.equal(modified, false);
		assert.deepEqual(out.thinking, body.thinking);
	});
});
