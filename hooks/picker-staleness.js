// @ts-check
// Notice, once per plugin update, when the user's generated `modelPicker` rows
// no longer match what this version of the plugin would generate (issue #62).
//
// WHY THIS EXISTS. The rows in ~/.claude/settings.json are a SNAPSHOT taken by
// /cc-proxy:setup. `CONTEXT_WINDOW` changing — a new model, a corrected window,
// an id crossing the 1M line and gaining its `[1m]` suffix — makes that
// snapshot wrong, and there is no other channel that would ever tell the user:
// the picker keeps rendering, the stale window keeps being enforced, and
// nothing errors. Without this notice the whole feature silently applies only
// to whoever ran setup most recently.
//
// WHY A NOTICE AND NOT A WRITE. settings.json is shared global state that the
// user's editor, /config and every other plugin's setup also touch; a
// background hook doing read-modify-write on it every session races all of
// them, and load-bearing map #7 ranks corrupting that file as the worst outcome
// in this tree. The mutation stays in the script the user invokes.
//
// CHANNEL. `hookSpecificOutput.additionalContext` — measured (#55) as the ONLY
// SessionStart channel that reaches anyone: plain stdout/stderr land in the
// debug log only, and exit 2 does not block a SessionStart.
//
// This module reads its own tree's data and the user's settings. It does NOT
// import src/ — the hooks/ -> src/ boundary is deliberate (a hook must start
// even from a tree whose src/ is mid-update), so the id list is read from the
// generated rows' own shape rather than from CONTEXT_WINDOW.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the last-notified version is remembered. Sits beside the proxy's other
 * runtime state (log, quota caches, grades) — nothing here belongs in the repo
 * or in settings.json. */
export const STAMP_PATH = path.join(os.homedir(), ".claude", "cc-proxy", "picker-stamp.json");

/**
 * Read the version this hook last emitted a picker notice for.
 * Any unreadable/malformed stamp reads as "never" — the cost of a false
 * "never" is one extra notice; the cost of a throw is the whole hook.
 *
 * @param {string} [file]
 * @returns {string | undefined}
 */
export function readStamp(file = STAMP_PATH) {
	try {
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof json?.notifiedVersion === "string" ? json.notifiedVersion : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Remember that this version's notice has been shown. Failure is swallowed for
 * the same reason as above — an unwritable state dir must not break a session,
 * and the only consequence is the notice repeating next time.
 *
 * Written tmp-then-rename like every other file this plugin puts under
 * `~/.claude`. The stakes are lower than settings.json — a torn stamp reads as
 * "never notified" and costs one extra notice — but the rule is uniform on
 * purpose: the next person to copy a writer from this tree should copy a
 * correct one. `couplings.test.js` denies the direct-write spelling.
 *
 * @param {string} version
 * @param {string} [file]
 */
export function writeStamp(version, file = STAMP_PATH) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify({ notifiedVersion: version })}\n`);
		fs.renameSync(tmp, file);
	} catch {
		// no-op: see docstring
	}
}

/**
 * This user's settings.json, parsed, or undefined when it cannot be read.
 *
 * The path is built INSIDE the try, not in a default parameter: a default is
 * evaluated at call time, BEFORE the callee's try block, so a throwing
 * `os.homedir()` would escape a helper whose whole contract is that it never
 * throws. (`os.homedir()` does not throw on any environment measured here — it
 * falls back to the passwd entry with HOME unset, and returns "" for an empty
 * one. Kept anyway: the guard costs nothing, and a "never throws" helper whose
 * safety depends on an unmeasured platform detail is the wrong shape.)
 *
 * @param {string} [file]
 * @returns {Record<string, any> | undefined}
 */
function readSettingsJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file ?? settingsPath(), "utf8"));
	} catch {
		return undefined;
	}
}

/** @returns {string} the user's settings.json path */
function settingsPath() {
	return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * The user's current picker rows, or undefined when they have none.
 *
 * @param {string} [file]
 * @returns {unknown[] | undefined}
 */
export function readPickerRows(file) {
	const options = readSettingsJson(file)?.modelPicker?.options;
	return Array.isArray(options) ? options : undefined;
}

/**
 * Does the user still carry the one-slot custom-model env this feature
 * supersedes? That is the pre-#62 configuration, and it is the case worth a
 * notice even when the plugin version has not moved: such a user has ONE model
 * in their picker and the 200K assumption on every other id.
 *
 * @param {string} [file]
 * @returns {boolean}
 */
export function hasLegacyCustomModelOption(file) {
	const v = readSettingsJson(file)?.env?.ANTHROPIC_CUSTOM_MODEL_OPTION;
	return typeof v === "string" && v.trim() !== "";
}

/**
 * Is this row one cc-proxy generated? Keyed on the description suffix every
 * generated row carries — this module deliberately does not import src/ (a hook
 * must start from a tree whose src/ is mid-update), so the marker in the row's
 * own shape is what is available.
 *
 * WHY IT MATTERS. Without this, ANY modelPicker rows read as "cc-proxy rows
 * generated by an older version", so a user who curates their own picker and
 * has never run our script gets told to re-run a setup they never ran. The
 * whole gating principle here is that silence is correct for someone who did
 * not opt in.
 *
 * @param {unknown} row
 * @returns {boolean}
 */
export function isOurRow(row) {
	if (!row || typeof row !== "object") return false;
	const d = /** @type {{ description?: unknown }} */ (row).description;
	return typeof d === "string" && d.includes(GENERATED_MARKER);
}

/**
 * The tail every generated row's description carries. Coupled to
 * `buildRows()` in src/model-picker.js, which composes it; locked in
 * `couplings.test.js` because the two files never import each other.
 */
export const GENERATED_MARKER = "routed via cc-proxy";

/**
 * Decide whether this session should carry a picker notice, and which one.
 *
 * Three states, in priority order:
 *   "absent"  — no rows of OURS AND the legacy one-slot env is set: the user is
 *               on the pre-#62 config and every id but one is budgeted at 200K.
 *   "stale"   — rows of ours exist but the plugin version has moved since they
 *               were generated, so a window may have been corrected under them.
 *   null      — nothing to say (the common case; silence is correct).
 *
 * "OURS" is load-bearing, not decoration. Counting ANY modelPicker rows meant a
 * user who curates their own picker — a work gateway, a private endpoint — and
 * has never run our script was told their rows were "generated by an earlier
 * version" and should re-run a setup they never ran. Their own rows would also
 * suppress the "absent" notice that IS for them. Both directions are wrong for
 * the same reason: whether cc-proxy has anything to say depends on cc-proxy's
 * own rows, never on the picker being non-empty.
 *
 * A user with none of our rows and no legacy env has never run setup's picker
 * step at all — possibly deliberately — so they get nothing. Volunteering config
 * advice to someone who never asked is how a hook becomes noise the context pays
 * for every session.
 *
 * Pure: every input is a parameter, so the test does not need a fake HOME.
 *
 * @param {object} state
 * @param {string | undefined} state.version   this tree's plugin version
 * @param {string | undefined} state.notified  version the stamp remembers
 * @param {unknown[] | undefined} state.rows   the user's current picker rows
 * @param {boolean} state.legacyEnv            ANTHROPIC_CUSTOM_MODEL_OPTION set
 * @returns {"absent" | "stale" | null}
 */
export function pickerNoticeState({ version, notified, rows, legacyEnv }) {
	// An unknown own version means no reliable comparison — say nothing rather
	// than notify on every session forever.
	if (!version) return null;
	if (notified === version) return null;
	const ours = (rows ?? []).filter(isOurRow);
	if (ours.length === 0) return legacyEnv ? "absent" : null;
	return "stale";
}

/**
 * The context line for a notice state.
 *
 * @param {"absent" | "stale"} state
 * @param {string} version
 * @returns {string}
 */
export function noticeFor(state, version) {
	if (state === "absent") {
		return `cc-proxy ${version}: this session's settings still use ANTHROPIC_CUSTOM_MODEL_OPTION, which holds ONE model. Claude Code therefore assumes a 200K context window for every other model cc-proxy routes and auto-compacts there, even for the 1M ones. Tell the user they can run /cc-proxy:setup (or \`node <plugin>/scripts/render-model-picker.js\`) to publish a row per model with its real window.`;
	}
	return `cc-proxy ${version}: the modelPicker rows in the user's settings.json were generated by an earlier version, so a model's context window may have been corrected or a model added since. Tell the user they can re-run /cc-proxy:setup (or \`node <plugin>/scripts/render-model-picker.js\`) to refresh them. Harmless to ignore.`;
}

/**
 * The whole check, wired to the real filesystem. Returns the line to emit, or
 * undefined for silence. Stamps on the way out so a notice fires ONCE per
 * version — including the "absent" case, where a user who chooses not to act
 * would otherwise be told again every single session.
 *
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @param {string} [opts.settingsFile]
 * @param {string} [opts.stampFile]
 * @returns {string | undefined}
 */
export function pickerNotice(opts = {}) {
	const version = opts.version ?? treeVersion();
	const settingsFile = opts.settingsFile ?? path.join(os.homedir(), ".claude", "settings.json");
	const stampFile = opts.stampFile ?? STAMP_PATH;
	const state = pickerNoticeState({
		version,
		notified: readStamp(stampFile),
		rows: readPickerRows(settingsFile),
		legacyEnv: hasLegacyCustomModelOption(settingsFile),
	});
	if (state === null) return undefined;
	// `version` is a string here: pickerNoticeState returns null without one.
	writeStamp(/** @type {string} */ (version), stampFile);
	return noticeFor(state, /** @type {string} */ (version));
}

/**
 * This tree's plugin version. Duplicated from proxy-lifecycle's pluginVersion()
 * rather than imported so this module has no dependency on the lifecycle path —
 * the two are wired together only in session-start.js.
 *
 * @param {string} [hooksDir]
 * @returns {string | undefined}
 */
export function treeVersion(hooksDir = HOOKS_DIR) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(hooksDir, "..", "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}
