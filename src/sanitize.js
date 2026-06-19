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
