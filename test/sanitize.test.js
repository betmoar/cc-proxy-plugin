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

// The aliasing contract handleProxy() depends on (Copilot review, PR #18).
// stripAssistantThinking returns the CALLER'S OWN object when it changed
// nothing, so `stripped.body === body` in the common case. handleProxy applies
// the `<provider>:` selector strip right after, and used to assign into
// `stripped.body.model` — an in-place edit of the inbound body. Nothing read it
// afterwards, so nothing broke; the danger is quiet. `inboundModel` is captured
// before the rewrite, and if that capture ever moves below it the routing log
// starts printing the UPSTREAM id as the inbound one — the exact line
// scripts/status.js parses.
describe("identity of the returned body (what handleProxy relies on)", () => {
	it("returns the SAME object when nothing was stripped", () => {
		const body = { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] };
		const out = stripAssistantThinking(body);
		assert.equal(out.modified, false);
		assert.equal(out.body, body, "unmodified must alias, not copy — the caller must not mutate it");
	});

	it("returns a NEW object when it did strip", () => {
		const body = {
			model: "glm-5.2",
			messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }],
		};
		const out = stripAssistantThinking(body);
		assert.equal(out.modified, true);
		assert.notEqual(out.body, body, "a strip must not edit the caller's object either");
		assert.equal(body.messages[0].content.length, 1, "the original is left intact");
	});
});
