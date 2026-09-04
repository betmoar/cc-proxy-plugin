#!/usr/bin/env node
// @ts-check
import { DEFAULT_LOG_PATH, ensureProxyRunning } from "./proxy-lifecycle.js";

/**
 * One line of session context when the proxy did NOT come up (issue #55).
 *
 * CHANNEL IS A MEASUREMENT, NOT A GUESS (2026-09-04, CC 2.1.260, sentinel
 * hooks + nested `claude --settings` runs): every other channel is dead for
 * this purpose — plain stdout and stderr land in the DEBUG LOG ONLY (never
 * model context, never the UI, on exit 0 AND exit 2), and exit 2 does not
 * block a SessionStart (the session proceeded and answered normally; only
 * UserPromptSubmit exit 2 blocks). The one channel that reaches anyone is
 * JSON `hookSpecificOutput.additionalContext`, which is injected as session
 * context — verified by asking the model to quote a sentinel from its
 * context. So this line is how the failure stops being invisible: the model
 * sees it and can tell the user why their first prompt will fail, instead of
 * the user meeting a bare ECONNREFUSED with nothing on disk pointing at the
 * log.
 *
 * Exit 0 ALWAYS — the proxy is optional infrastructure and a hook must never
 * block the session (re-confirmed by the same measurement: even exit 2
 * doesn't, so nothing about the old shape was load-bearing).
 *
 * @param {string} state - the non-success state from ensureProxyRunning()
 * @returns {string} the additionalContext line
 */
function noticeFor(state) {
	return `cc-proxy: the proxy did not start (state: ${state}) — requests from this session will fail with ECONNREFUSED until it is running. Tell the user if they hit errors. Log: ${DEFAULT_LOG_PATH}`;
}

ensureProxyRunning()
	.then((state) => {
		// "already-up" (healthy), "started" and "restarted" (this hook did its
		// job) are success states — silence is correct for them; a healthy line
		// every session would be noise the context pays for. "missing-path"
		// (no bin/cc-proxy.js anywhere), "unreachable" (spawned but never
		// answered), "already-up" from the !gone fallback (a stale proxy that
		// refused to die) and any rejection are the failures worth one line.
		//
		// The !gone "already-up" case is indistinguishable from healthy by the
		// return value alone — a known blind spot, recorded in issue #55; the
		// version probe means the stale one is at least FUNCTIONAL while it
		// lives, so a user hitting it sees stale behavior, not errors.
		if (state === "missing-path" || state === "unreachable") {
			process.stdout.write(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: noticeFor(state),
					},
				}),
			);
		}
	})
	.catch(() => {
		// ensureProxyRunning resolves every documented path; a rejection here is
		// a bug in it (or an undocumented throw). The pre-#55 shape swallowed
		// this silently — now it gets the same one line, with a state that says
		// "crashed" rather than a name from the enum.
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: noticeFor("crashed"),
				},
			}),
		);
	})
	.finally(() => process.exit(0));
