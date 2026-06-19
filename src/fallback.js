// @ts-check

// Z.ai signals context overflow on a non-streaming 200 with empty content and
// this top-level stop_reason. The proxy converts that into a real error so it
// surfaces instead of looking like a successful empty turn.
export const CONTEXT_EXCEEDED_STOP_REASON = "model_context_window_exceeded";

/**
 * @param {unknown} parsedBody
 * @returns {boolean}
 */
export function isContextLimitByStopReason(parsedBody) {
	if (!parsedBody || typeof parsedBody !== "object") return false;
	const body = /** @type {Record<string, any>} */ (parsedBody);
	if (body.stop_reason !== CONTEXT_EXCEEDED_STOP_REASON) return false;
	// The overflow signal carries no content. Require empty/absent content so a
	// non-empty 200 that happens to bear this stop_reason isn't misclassified
	// (we'd otherwise drop real assistant content by converting it to a 400).
	return !Array.isArray(body.content) || body.content.length === 0;
}
