import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { stripAssistantThinking, stripForeignServerToolUse } from "../src/sanitize.js";

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

	// PROMPT CACHING DEPENDS ON THIS, and nothing said so until 0.8.0.
	//
	// Every backend prices a cache read at a fraction of input (0.1x on Anthropic,
	// DeepSeek and Qwen; ~0.2x on Z.ai), and all of them key the cache on the
	// exact prefix bytes the BACKEND receives. The proxy rewrites those bytes —
	// the strip removes thinking blocks the client sent — so caching only survives
	// because the rewrite is a pure function of the input: same history in, same
	// bytes out, same cache key every turn.
	//
	// Measured 2026-08-29 through the live proxy (Z.ai): a repeat turn whose
	// prefix contained a stripped thinking block still read 4416 tokens from
	// cache. Make this depend on anything request-varying — a timestamp, a
	// counter, iteration order over a Set — and every turn becomes a cache MISS:
	// no error, no failing test, roughly 4x the token bill. Invariant 2 forbids
	// that state for other reasons; this is the second, quieter reason.
	it("the strip is deterministic — identical input yields byte-identical output", () => {
		const build = () => ({
			model: "glm-5.2",
			system: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "q1" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning", signature: "sig-1" },
						{ type: "text", text: "a1" },
						{ type: "redacted_thinking", data: "opaque" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "q2" }] },
			],
		});
		const first = JSON.stringify(stripAssistantThinking(build()).body);
		for (let i = 0; i < 5; i++) {
			assert.equal(
				JSON.stringify(stripAssistantThinking(build()).body),
				first,
				"a varying result would silently turn every cached turn into a full-price miss",
			);
		}
	});

	// The other half of the caching contract: the strip filters whole blocks and
	// must never rewrite the ones it keeps, or a `cache_control` breakpoint the
	// client placed would be lost — and on Qwen, where caching is explicit-only,
	// losing the marker means no caching at all rather than a stale key.
	it("preserves cache_control breakpoints on the blocks it keeps", () => {
		const body = {
			system: [{ type: "text", text: "big", cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }],
				},
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t", signature: "s" },
						{ type: "text", text: "a", cache_control: { type: "ephemeral" } },
					],
				},
			],
		};
		const out = stripAssistantThinking(body);
		assert.equal(out.modified, true);
		assert.deepEqual(out.body.system[0].cache_control, { type: "ephemeral" });
		assert.deepEqual(out.body.messages[0].content[0].cache_control, { type: "ephemeral" });
		assert.deepEqual(
			out.body.messages[1].content,
			[{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
			"the surviving block keeps its breakpoint verbatim",
		);
	});
});

describe("stripForeignServerToolUse", () => {
	const glmHistory = {
		messages: [
			{ role: "user", content: "look at this image" },
			{
				role: "assistant",
				content: [
					{
						type: "server_tool_use",
						id: "call_d88edcb2ba6d4d789afd7a0e",
						name: "analyze_image",
						input: {},
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_d88edcb2ba6d4d789afd7a0e",
						content: [{ type: "text", text: "MCP error 400" }],
					},
				],
			},
		],
	};

	it("strips a GLM-emitted server_tool_use (call_ id) and its paired tool_result", () => {
		const { body: out, modified, stripped } = stripForeignServerToolUse(glmHistory);
		assert.equal(modified, true);
		assert.equal(stripped, 2);
		for (const msg of out.messages) {
			for (const block of msg.content ?? []) {
				assert.notEqual(block.type, "server_tool_use");
				assert.notEqual(block.type, "tool_result");
			}
		}
		// Original untouched
		assert.equal(glmHistory.messages[1].content.length, 1);
	});

	it("keeps an Anthropic-shaped server_tool_use (srvtoolu_ id)", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_1a09XkCDmad3v3CD2BC2CCDE",
							name: "web_search",
							input: { query: "x" },
						},
					],
				},
			],
		};
		const { body: out, modified, stripped } = stripForeignServerToolUse(body);
		assert.equal(modified, false);
		assert.equal(stripped, 0);
		assert.equal(out, body);
	});

	it("strips a valid name carrying a foreign id (the id pattern is the rejection axis)", () => {
		// The trailing user turn is load-bearing: without it this history empties
		// completely, and the all-emptied bail-out below returns the body
		// unmodified — so the assertion would be measuring THAT path, not the id
		// axis it is named for.
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "call_f61ff72df53a4ceebb9d73a5",
							name: "web_search",
							input: {},
						},
					],
				},
				{ role: "user", content: "and now?" },
			],
		};
		const { modified, stripped } = stripForeignServerToolUse(body);
		assert.equal(modified, true);
		assert.equal(stripped, 1);
	});

	it("keeps a block with a valid id under a name we have never seen (id-only, issue #67)", () => {
		// THE DECISION, pinned. ANTHROPIC_SERVER_TOOLS is a dated snapshot of a
		// list Anthropic extends; the id shape is a format they would have to
		// break their own API to change. Rejecting on the name too — the first
		// cut did — means the day they ship a ninth server tool, this proxy
		// silently deletes Claude's own tool calls out of Claude-bound history,
		// with no error anywhere. Id-only lets an unknown-but-well-formed block
		// through to draw Anthropic's own 400, which arrives as a bug report
		// naming its own cause. Re-add the name axis and this test fails.
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_01ABC",
							name: "a_tool_anthropic_ships_next_year",
							input: {},
						},
					],
				},
			],
		};
		const { body: out, modified } = stripForeignServerToolUse(body);
		assert.equal(modified, false, "an unknown NAME is not grounds to strip — only a foreign id is");
		assert.equal(out, body, "unmodified bodies must be returned by reference");
	});

	it("strips on the id axis alone — a foreign id drops even under a known name", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "srvtoolu_abc", name: "web_search", input: {} },
						{ type: "server_tool_use", id: "call_xyz", name: "analyze_image", input: {} },
						{ type: "text", text: "kept" },
					],
				},
			],
		};
		const { body: out, modified, stripped } = stripForeignServerToolUse(body);
		assert.equal(modified, true);
		assert.equal(stripped, 1);
		assert.deepEqual(
			out.messages[0].content.map((b) => b.type),
			["server_tool_use", "text"],
		);
		assert.equal(out.messages[0].content[0].id, "srvtoolu_abc");
	});

	it("bails out rather than forward an EMPTY messages array", () => {
		// The message-drop trades one 400 for another if it is carried to its end:
		// a transcript whose every message is a foreign block or its result empties
		// the array, and `messages: []` is itself rejected ("Input cannot be
		// empty", measured against Z.ai's Anthropic skin 2026-09-17). Forwarding
		// the ORIGINAL history is strictly better — the vendor's own 400 carries
		// the vendor's own message, instead of one the proxy manufactured.
		const body = {
			model: "claude-opus-5",
			messages: [
				{
					role: "assistant",
					content: [{ type: "server_tool_use", id: "call_a", name: "analyze_image", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "web_search_tool_result", tool_use_id: "call_a", content: [] }],
				},
			],
		};
		const { body: out, modified, dropped } = stripForeignServerToolUse(body);
		assert.equal(modified, false, "an all-emptied strip must report no modification");
		assert.equal(dropped, 0);
		assert.equal(out, body, "the ORIGINAL body is handed back, by reference");
		assert.equal(out.messages.length, 2, "nothing was removed");
	});

	it("drops messages[0] when the strip empties it", () => {
		// An earlier version of the comment above this function claimed messages[0]
		// "can never be emptied". That reasoned about paired RESULTS — which do
		// need a server_tool_use before them — and forgot that a LONE foreign
		// block needs no predecessor at all.
		const body = {
			messages: [
				{ role: "assistant", content: [{ type: "server_tool_use", id: "call_a", name: "x" }] },
				{ role: "user", content: "hi" },
			],
		};
		const { body: out, modified, dropped } = stripForeignServerToolUse(body);
		assert.equal(modified, true);
		assert.equal(dropped, 1);
		assert.deepEqual(
			out.messages.map((m) => m.role),
			["user"],
			"the emptied first message is dropped, the rest survive",
		);
	});

	it("leaves a result whose tool_use_id matches NOTHING in the history", () => {
		// An orphan-to-nothing is not this function's business: it did not create
		// it, and removing it would be a rewrite no measurement asked for. Only
		// results paired to a block THIS pass removed are swept.
		const body = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "server_tool_use", id: "call_a", name: "analyze_image" }],
				},
				{ role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "call_never" }] },
			],
		};
		const { body: out, modified } = stripForeignServerToolUse(body);
		assert.equal(modified, true, "the foreign block itself is still stripped");
		assert.deepEqual(
			out.messages.map((m) => (Array.isArray(m.content) ? m.content[0].tool_use_id : null)),
			["call_never"],
			"the unmatched result survives untouched",
		);
	});

	it("leaves a string-content message byte-identical", () => {
		// Inherited safety (the per-message `Array.isArray(msg.content)` guard),
		// asserted here for THIS feature: a refactor merging the two loop bodies
		// could regress it with nothing else noticing.
		const body = {
			messages: [
				{ role: "user", content: "a plain text turn" },
				{ role: "assistant", content: [{ type: "server_tool_use", id: "call_a", name: "x" }] },
				{ role: "user", content: "another" },
			],
		};
		const { body: out } = stripForeignServerToolUse(body);
		assert.equal(out.messages[0].content, "a plain text turn");
		assert.equal(out.messages[1].content, "another");
	});

	it("returns the SAME object when nothing was stripped (the aliasing contract server.js leans on)", () => {
		const body = { messages: [{ role: "user", content: "hi" }] };
		const { body: out, modified } = stripForeignServerToolUse(body);
		assert.equal(modified, false);
		assert.equal(out, body);
	});

	it("handles body without messages / null / undefined", () => {
		assert.equal(stripForeignServerToolUse({ model: "x" }).modified, false);
		assert.equal(stripForeignServerToolUse(null).modified, false);
		assert.equal(stripForeignServerToolUse(undefined).modified, false);
	});

	it("DROPS a message the strip empties — `content: []` is its own 400", () => {
		// The issue #67 transcript shape: the foreign block and its result each
		// sit alone in a message, so filtering blocks alone leaves two husks and
		// the request 400s again on a different field. The bug survived a
		// block-level assertion ("no server_tool_use reached upstream") because
		// that is true of the husk too — the observable that separates them is
		// the MESSAGE COUNT.
		const { body: out, modified, stripped, dropped } = stripForeignServerToolUse(glmHistory);
		assert.equal(modified, true);
		assert.equal(stripped, 2);
		assert.equal(dropped, 2);
		assert.deepEqual(
			out.messages.map((m) => m.role),
			["user"],
		);
		for (const msg of out.messages) {
			assert.notEqual(
				Array.isArray(msg.content) && msg.content.length,
				0,
				"an emptied message must not be forwarded",
			);
		}
	});

	it("keeps a message the strip only thins, husking nothing", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} },
						{ type: "text", text: "kept" },
					],
				},
			],
		};
		const { body: out, dropped } = stripForeignServerToolUse(body);
		assert.equal(dropped, 0);
		assert.equal(out.messages.length, 1);
		assert.deepEqual(
			out.messages[0].content.map((b) => b.type),
			["text"],
		);
	});

	it("leaves an ALREADY-empty message exactly as it arrived", () => {
		// The drop is scoped to what this function removed. An empty message the
		// client sent is the client's business — widening to "delete every empty
		// message" would make the strip edit history it never touched, which is
		// the mid-turn rewriting invariant 2 declines.
		const body = {
			messages: [
				{ role: "assistant", content: [] },
				{
					role: "assistant",
					content: [{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} }],
				},
			],
		};
		const { body: out, dropped } = stripForeignServerToolUse(body);
		assert.equal(dropped, 1);
		assert.equal(out.messages.length, 1);
		assert.deepEqual(out.messages[0].content, []);
	});

	it("pairs a result by ID, not by the block type spelling", () => {
		// A SERVER tool's result is not spelled `tool_result`: Anthropic's own
		// family is web_search_tool_result / web_fetch_tool_result /
		// bash_code_execution_tool_result, and the next vendor picks its own
		// spelling. Keying the sweep on `type === "tool_result"` leaves every
		// other spelling behind as the orphan the sweep exists to prevent.
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} },
						{ type: "web_search_tool_result", tool_use_id: "call_x", content: [] },
						{ type: "text", text: "kept" },
					],
				},
			],
		};
		const { body: out, stripped } = stripForeignServerToolUse(body);
		assert.equal(stripped, 2);
		assert.deepEqual(
			out.messages[0].content.map((b) => b.type),
			["text"],
		);
	});

	it("leaves a result whose tool_use_id belongs to a KEPT block", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "srvtoolu_ok", name: "web_search", input: {} },
						{ type: "web_search_tool_result", tool_use_id: "srvtoolu_ok", content: [] },
						{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} },
					],
				},
			],
		};
		const { body: out, stripped } = stripForeignServerToolUse(body);
		assert.equal(stripped, 1);
		assert.deepEqual(
			out.messages[0].content.map((b) => b.type),
			["server_tool_use", "web_search_tool_result"],
		);
	});

	it("strips a foreign block that carries NO id — the early return is not the id set", () => {
		// `isForeignServerToolUse` calls a missing/non-string id foreign, but such a
		// block adds nothing to `foreignIds`. Keying the early return on the SET
		// forwarded it verbatim to Claude: the rejection the sanitizer exists to
		// prevent, reached through the shortcut meant to skip work. Two different
		// questions — "is there anything to strip" vs "which results are orphaned".
		const body = {
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", name: "analyze_image", input: {} },
						{ type: "text", text: "kept" },
					],
				},
			],
		};
		const { body: out, modified, stripped } = stripForeignServerToolUse(body);
		assert.equal(modified, true);
		assert.equal(stripped, 1);
		assert.deepEqual(
			out.messages[1].content.map((b) => b.type),
			["text"],
		);
	});

	it("collects foreign ids from any role, matching the pass that removes them", () => {
		// The removal pass strips a foreign server_tool_use wherever it sits, so a
		// collection pass restricted to `assistant` left the paired result behind
		// as the orphan this function exists to remove.
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} },
						{ type: "text", text: "kept" },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_x", content: "r" },
						{ type: "text", text: "kept too" },
					],
				},
			],
		};
		const { body: out, stripped } = stripForeignServerToolUse(body);
		assert.equal(stripped, 2, "the block AND its result must go");
		assert.deepEqual(
			out.messages.flatMap((m) => m.content.map((b) => b.type)),
			["text", "text"],
		);
	});

	it("leaves plain tool_use blocks alone (call_ ids are legal there)", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_whatever", name: "Read", input: {} }],
				},
			],
		};
		const { body: out, modified } = stripForeignServerToolUse(body);
		assert.equal(modified, false);
		assert.equal(out, body);
	});
});
