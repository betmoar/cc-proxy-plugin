#!/usr/bin/env node
// @ts-check
import { pickerNotice } from "./picker-staleness.js";
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

/**
 * Emit the hook's one JSON payload. At most ONE additionalContext field exists
 * per hook result, so when both a proxy failure and a picker notice apply they
 * share the line — a proxy that will not start is the more urgent of the two
 * and goes first.
 *
 * @param {string[]} lines
 */
function emit(lines) {
	const text = lines.filter(Boolean).join(" ");
	if (!text) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
		}),
	);
}

/**
 * The picker-staleness line (issue #62), or "" when there is nothing to say.
 *
 * Wrapped: this check reads two JSON files and writes a stamp, and an
 * unhandled throw here would take out the proxy-start notice that shares the
 * payload. Every helper in picker-staleness.js already swallows its own I/O
 * errors; this is the belt for a defect in the logic between them.
 *
 * @returns {string}
 */
function pickerLine() {
	try {
		return pickerNotice() ?? "";
	} catch (err) {
		// Written, not discarded. The sibling .catch() below still emits a
		// "crashed" line; a bare `catch {}` here would make a defect in this path
		// invisible to EVERY channel, which is this repo's own "a script that
		// prints nothing may never have run" trap one level down. stderr is
		// debug-log-only for a SessionStart hook (measured, #55), so this costs
		// the user nothing and leaves a maintainer something to grep.
		//
		// No specific reachable throw is known — every helper in
		// picker-staleness.js self-catches its I/O. This is the belt for a defect
		// in the logic BETWEEN them, which is exactly the class no test predicts.
		process.stderr.write(
			`cc-proxy: picker-staleness check failed: ${/** @type {Error} */ (err).message}\n`,
		);
		return "";
	}
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
		const failed = state === "missing-path" || state === "unreachable";
		emit([failed ? noticeFor(state) : "", pickerLine()]);
	})
	.catch(() => {
		// ensureProxyRunning resolves every documented path; a rejection here is
		// a bug in it (or an undocumented throw). The pre-#55 shape swallowed
		// this silently — now it gets the same one line, with a state that says
		// "crashed" rather than a name from the enum.
		emit([noticeFor("crashed"), pickerLine()]);
	})
	.finally(() => process.exit(0));
