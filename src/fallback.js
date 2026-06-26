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

// Z.ai returns HTTP 429 with this error code when the request rate limit is hit.
// It already arrives as a 429, but carries no Retry-After header, so Claude Code
// surfaces it as a hard error instead of backing off. The proxy injects a
// Retry-After so the client's own retry handles the wait — staying stateless
// (no in-proxy replay). Gated strictly on 1302 so the sibling 1113 (insufficient
// balance), also a 429, is NOT given a misleading retry hint.
export const RATE_LIMIT_ERROR_CODE = "1302";
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * True when a parsed error body is GLM's 1302 request-rate-limit error.
 * Accepts the code as a string or number (`"1302"` or `1302`).
 * @param {unknown} parsedBody
 * @returns {boolean}
 */
export function isRateLimitError(parsedBody) {
	if (!parsedBody || typeof parsedBody !== "object") return false;
	const err = /** @type {Record<string, any>} */ (parsedBody).error;
	if (!err || typeof err !== "object") return false;
	return String(err.code) === RATE_LIMIT_ERROR_CODE;
}
