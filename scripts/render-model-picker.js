#!/usr/bin/env node
// @ts-check
// Write cc-proxy's generated `modelPicker` rows into ~/.claude/settings.json,
// so Claude Code budgets each routed model against its REAL context window
// instead of the 200K it assumes for every id its catalog does not describe
// (issue #62). The rules and the measurement live in src/model-picker.js; this
// file is the I/O around them.
//
// Usage:
//   node scripts/render-model-picker.js            # write (creates a .bak first)
//   node scripts/render-model-picker.js --dry-run  # print the merged JSON, write nothing
//   node scripts/render-model-picker.js --print    # print just the rows, write nothing
//
// /cc-proxy:setup calls this instead of writing the block itself: `modelPicker`
// has no cross-source merging, so clobbering a user's hand-written rows is
// silent and unrecoverable, and that logic must sit where `pnpm test` reaches
// it rather than in markdown a model re-interprets each run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.js";
import {
	SUPERSEDED_ENV_KEYS,
	buildRows,
	dropSupersededEnv,
	mergePicker,
} from "../src/model-picker.js";
import { isDirectRun } from "./direct-run.js";

// MUST stay directly under the imports — the row set is gated on which provider
// keys are registered, and those live in ~/.env. Without this the script sees
// no keys and generates an EMPTY picker, which would delete the user's rows.
loadEnv();

/** @returns {string} */
export function settingsPath() {
	return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * Read and parse settings.json.
 *
 * A MISSING file is `{}` — a fresh machine has no settings yet and should get
 * a picker like anyone else. A file that exists but does not parse THROWS: it
 * holds the user's ANTHROPIC_BASE_URL, permissions and hooks, and overwriting
 * it with `{}` because of a stray comma would take all of that with it. The
 * caller turns that into a message telling the user to fix the JSON.
 *
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readSettings(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return {};
		throw err;
	}
	// An empty or whitespace-only file is not corruption — some tooling creates
	// the path before writing it — so treat it as absent rather than refusing.
	if (raw.trim() === "") return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("settings.json does not contain a JSON object");
	}
	return parsed;
}

/**
 * Write settings.json ATOMICALLY, keeping a one-generation backup.
 *
 * Same tmp-then-rename shape as bench-grades.js writeGradesFile(), and for a
 * strictly bigger reason: a plain `writeFileSync` opens with `'w'`, which
 * TRUNCATES before writing, so a kill in that window (Ctrl-C, OOM, power loss)
 * leaves ~/.claude/settings.json zero-length or half-written — taking the user's
 * ANTHROPIC_BASE_URL, permissions and hooks with it. A rename within one
 * directory is a single filesystem operation, so every reader sees either the
 * complete old file or the complete new one. Load-bearing map #7 ranks
 * corrupting this file as the worst outcome in this tree; grades.json, which
 * matters far less, already had the stronger guarantee.
 *
 * The backup is the rollback this script's own docs promise. It is written
 * BEFORE the new content and only when the file already existed, so a first run
 * on a fresh machine leaves no stray .bak.
 *
 * The tmp file is a SIBLING (same directory), not in os.tmpdir(): rename is only
 * atomic within a filesystem, and ~ and /tmp are routinely different mounts —
 * across them rename() throws EXDEV, or a fallback copy reintroduces the very
 * torn write this exists to prevent. It carries the pid so two concurrent runs
 * cannot write each other's temp file.
 *
 * Two-space indent + trailing newline matches what Claude Code itself writes,
 * so a user's diff shows only the rows that changed.
 *
 * @param {string} file
 * @param {Record<string, unknown>} settings
 */
export function writeSettings(file, settings) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/**
 * Does this settings object still carry a global context pin?
 *
 * Reported, never removed: with per-row windows in place the pin only affects
 * ids that have NO row — typos, subagent pins, OpenRouter slash-ids — where a
 * 1M value is the dangerous guess and CC's 200K default is the safe one.
 * Whether that matters depends on the user's other tooling, so it is theirs to
 * decide. `behavesAs` on every generated row also makes the pin inert for the
 * ids that DO have rows (measured — see src/model-picker.js).
 *
 * @param {Record<string, unknown>} settings
 * @returns {string | undefined} the pin's value, when set
 */
export function contextPin(settings) {
	const env = settings.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
	const v = /** @type {Record<string, unknown>} */ (env).CLAUDE_CODE_MAX_CONTEXT_TOKENS;
	return v == null || v === "" ? undefined : String(v);
}

/**
 * The whole command. Every effect is a parameter so a test can drive it without
 * a fake HOME or a spawned process — this is the ONLY place the flags, the two
 * refusals, the env-drop wiring and the three report lines exist, and each was
 * measured to survive the suite while `main()` was unreachable: swapping
 * `dropped.settings` for `settings` leaves the superseded env beside the new
 * rows so the model renders twice, and neutering the empty-rows refusal deletes
 * a keyless user's picker outright (issue #30).
 *
 * Returns the process exit code rather than setting `process.exitCode`, so the
 * refusals are assertable.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]                  flags, without argv[0..1]
 * @param {string} [opts.file]                    settings.json to merge into
 * @param {(s: string) => void} [opts.stdout]
 * @param {(s: string) => void} [opts.stderr]
 * @param {NodeJS.ProcessEnv} [opts.env]          gates which rows are reachable
 * @returns {number} 0 on success, 1 on a refusal
 */
export function run(opts = {}) {
	const argv = opts.argv ?? process.argv.slice(2);
	const file = opts.file ?? settingsPath();
	const out = opts.stdout ?? ((s) => process.stdout.write(s));
	const err = opts.stderr ?? ((s) => process.stderr.write(s));
	const dryRun = argv.includes("--dry-run");
	const printOnly = argv.includes("--print");

	const rows = buildRows(opts.env);
	if (printOnly) {
		out(`${JSON.stringify(rows, null, 2)}\n`);
		return 0;
	}

	if (rows.length === 0) {
		// No provider key is set, so every row would name a model that cannot
		// route (issue #30, sixteen times over). Refuse rather than write an empty
		// picker — and say which file to fix, since the usual cause is keys that
		// never made it into ~/.env.
		err(
			"cc-proxy: no provider keys are registered, so there are no models to publish. Add a key to ~/.env (GLM_API_KEY, DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, …) or re-run /cc-proxy:setup.\n",
		);
		return 1;
	}

	/** @type {Record<string, unknown>} */
	let settings;
	try {
		settings = readSettings(file);
	} catch (e) {
		err(
			`cc-proxy: ${file} could not be read as JSON (${/** @type {Error} */ (e).message}). Fix it by hand and re-run; nothing was written.\n`,
		);
		return 1;
	}

	const pin = contextPin(settings);
	const dropped = dropSupersededEnv(settings);
	// dropped.settings, NEVER the original: with replaceBuiltInOptions:false the
	// one-slot ANTHROPIC_CUSTOM_MODEL_OPTION renders ALONGSIDE the generated rows,
	// so keeping it shows that model twice.
	const merged = mergePicker(dropped.settings, rows);

	if (dryRun) {
		out(`${JSON.stringify(merged, null, 2)}\n`);
		return 0;
	}

	writeSettings(file, merged);

	out(`cc-proxy: wrote ${rows.length} modelPicker rows to ${file}\n`);
	if (dropped.removed.length > 0) {
		out(
			`cc-proxy: removed superseded env ${dropped.removed.join(", ")} — the generated rows include that model, and both would render.\n`,
		);
	}
	if (pin !== undefined) {
		out(
			`cc-proxy: NOTE — env.CLAUDE_CODE_MAX_CONTEXT_TOKENS is still set (${pin}). It no longer affects any model with a row above; it now only applies to ids with NO row (typos, pinned subagent models, OpenRouter slash-ids), where a large value over-budgets them. Left in place — remove it by hand if you no longer want it.\n`,
		);
	}
	return 0;
}

if (isDirectRun(import.meta.url)) {
	try {
		process.exitCode = run();
	} catch (err) {
		process.stderr.write(`cc-proxy: unexpected error: ${/** @type {Error} */ (err).message}\n`);
		process.exitCode = 1;
	}
}

export { SUPERSEDED_ENV_KEYS };
