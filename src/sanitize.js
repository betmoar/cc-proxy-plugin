// @ts-check

/**
 * Strip thinking / redacted_thinking blocks from assistant messages in an
 * Anthropic Messages API request body. Thinking blocks carry a backend-
 * specific signature; if the session's routing switches backends mid-
 * conversation (Claude ↔ GLM), the new backend rejects history it did not
 * sign with "Invalid signature in thinking block". The current turn's
 * thinking is unaffected — it's produced fresh from the `thinking` request
 * option, not from history.
 *
 * @param {any} body
 * @returns {{ body: any, modified: boolean }}
 */
export function stripAssistantThinking(body) {
	if (!body || !Array.isArray(body.messages)) {
		return { body, modified: false };
	}
	let modified = false;
	const newMessages = body.messages.map((msg) => {
		if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
			const filtered = msg.content.filter(
				(b) => !b || (b.type !== "thinking" && b.type !== "redacted_thinking"),
			);
			if (filtered.length !== msg.content.length) {
				modified = true;
				return { ...msg, content: filtered };
			}
		}
		return msg;
	});
	if (!modified) return { body, modified: false };
	return { body: { ...body, messages: newMessages }, modified: true };
}

/**
 * The `server_tool_use` block names Anthropic's API accepts, per its error
 * contract: "Input should be 'web_search', 'web_fetch', 'code_execution',
 * 'bash_code_execution', 'text_editor_code_execution', 'tool_search_tool_regex',
 * 'tool_search_tool_bm25', 'advisor'". Measured 2026-09-14 against a live
 * request rejected with exactly that message.
 *
 * EXPORTED for `scripts/probe-vendors.mjs`, which builds its drift-guard
 * pattern from this set: the probe then fails the day Anthropic's enumeration
 * stops matching what we hardcoded, which is the only mechanism that can
 * notice a vendor extending a "closed" set.
 *
 * @type {Set<string>}
 */
export const ANTHROPIC_SERVER_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"code_execution",
	"bash_code_execution",
	"text_editor_code_execution",
	"tool_search_tool_regex",
	"tool_search_tool_bm25",
	"advisor",
]);

/**
 * Is a `server_tool_use` block one Anthropic's Messages API can accept?
 *
 * The GLM (Z.ai) Anthropic-compatible endpoint emits `server_tool_use` blocks
 * for ITS OWN built-in tools (`analyze_image` measured 2026-09-14, id shaped
 * `call_…` — OpenAI's convention, not Anthropic's `srvtoolu_…`). A session
 * that routes some turns to GLM and later switches to Claude then dies on the
 * whole conversation with 400 on two axes: the id pattern
 * (`^srvtoolu_[a-zA-Z0-9_]+$`) and, once the ids are renamed, the name
 * (closed set). Both rejections were measured end-to-end (2026-09-14, session
 * 71dbf659): the first as `server_tool_use.id: String should match pattern`,
 * the second as `server_tool_use.name: Input should be 'web_search', …`.
 * A rename is not enough — the NAME has no GLM→Anthropic mapping — so the
 * only faithful move is to drop the block, exactly like the thinking-strip
 * drops history the new backend cannot have produced.
 *
 * A recognized name is NOT sufficient on its own (a GLM id can ride a valid
 * name), and the id pattern is checked too — a block fails the trip if EITHER
 * is foreign, mirroring the two measured rejections.
 *
 * @param {any} block
 * @returns {boolean}
 */
function isForeignServerToolUse(block) {
	if (!block || typeof block !== "object") return false;
	if (typeof block.name !== "string" || !ANTHROPIC_SERVER_TOOLS.has(block.name)) return true;
	return typeof block.id !== "string" || !/^srvtoolu_[a-zA-Z0-9_]+$/.test(block.id);
}

/**
 * Strip history a Claude backend will reject, from an Anthropic Messages API
 * request body routed to Claude: `server_tool_use` blocks another backend
 * (GLM measured) produced, plus every block paired with them by `tool_use_id`
 * — an orphaned result is itself a 400. Same defect class and same remedy as
 * `stripAssistantThinking` above: history the destination backend did not
 * produce cannot be sent to it.
 *
 * Results are matched by id across ALL messages, not positionally, and by the
 * ID ALONE rather than by `type === "tool_result"`: CC's transcript pairs a
 * tool_result in one message with a server_tool_use in an EARLIER one,
 * Anthropic's own pairing rule is id-based, and a SERVER tool's result is not
 * spelled `tool_result` at all — the family is `web_search_tool_result`,
 * `web_fetch_tool_result`, `bash_code_execution_tool_result`, … each carrying
 * the same `tool_use_id`. Keying on the type would have left whichever
 * spelling the next vendor picks behind as the orphan.
 *
 * A message whose content array is EMPTIED by the strip is dropped, not
 * forwarded empty: `content: []` is its own 400 ("List should have at least 1
 * item after validation"), so a strip that leaves one has moved the rejection
 * rather than removed it — and the transcript in issue #67 does exactly that
 * (the foreign block and its result each sit alone in their message). Dropping
 * the message is safe because consecutive same-role messages are legal (the
 * API folds them into one turn), and `messages[0]` can never be emptied: a
 * paired result needs a server_tool_use BEFORE it, so the first message holds
 * neither. A message that arrived empty is left exactly as it arrived — this
 * function removes what it removed, and nothing else.
 *
 * DIRECTIONAL, deliberately: this runs only on requests resolved to the
 * `claude` provider. The same history is legal input to the GLM backend that
 * produced it (issue #48's invariant-2 review declined mid-turn rewriting, and
 * stripping GLM's own tool blocks from GLM's own context would be exactly
 * that). The caller owns the routing decision; this function never looks at
 * `model`.
 *
 * @param {any} body
 * @returns {{ body: any, modified: boolean, stripped: number, dropped: number }}
 */
export function stripForeignServerToolUse(body) {
	if (!body || !Array.isArray(body.messages)) {
		return { body, modified: false, stripped: 0, dropped: 0 };
	}
	/** @type {Set<string>} */
	const foreignIds = new Set();
	// `foundForeign` is NOT `foreignIds.size > 0`: a foreign block with a missing
	// or non-string id contributes nothing to the set, and keying the early
	// return on the set alone forwarded exactly such a block to Claude — the
	// rejection this function exists to prevent, reached by the shortcut meant
	// to skip work. The set answers "which results are orphaned", which is a
	// different question from "is there anything to strip".
	let foundForeign = false;
	// NO role predicate here, deliberately: the removal pass below strips a
	// foreign `server_tool_use` wherever it sits, so collecting ids from
	// assistant messages only left a block removed in some other role with its
	// result un-orphaned. The set can only ever hold ids of blocks the removal
	// pass is already dropping, so widening the collection cannot over-strip.
	for (const msg of body.messages) {
		if (!msg || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block && block.type === "server_tool_use" && isForeignServerToolUse(block)) {
				foundForeign = true;
				if (typeof block.id === "string") foreignIds.add(block.id);
			}
		}
	}
	if (!foundForeign) return { body, modified: false, stripped: 0, dropped: 0 };

	let modified = false;
	let stripped = 0;
	let dropped = 0;
	const newMessages = [];
	for (const msg of body.messages) {
		if (!msg || !Array.isArray(msg.content)) {
			newMessages.push(msg);
			continue;
		}
		const filtered = msg.content.filter((block) => {
			if (block && block.type === "server_tool_use" && isForeignServerToolUse(block)) {
				stripped++;
				return false;
			}
			if (block && typeof block.tool_use_id === "string" && foreignIds.has(block.tool_use_id)) {
				stripped++;
				return false;
			}
			return true;
		});
		if (filtered.length === msg.content.length) {
			newMessages.push(msg);
			continue;
		}
		modified = true;
		// Emptied by the strip → drop the message; forwarding `content: []` trades
		// one 400 for another (see the note above).
		if (filtered.length === 0) {
			dropped++;
			continue;
		}
		newMessages.push({ ...msg, content: filtered });
	}
	if (!modified) return { body, modified: false, stripped: 0, dropped: 0 };
	return { body: { ...body, messages: newMessages }, modified: true, stripped, dropped };
}
