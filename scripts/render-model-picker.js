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
 * Write settings.json, keeping a one-generation backup.
 *
 * The backup is the rollback this script's own docs promise. It is written
 * BEFORE the new content and only when the file already existed, so a first run
 * on a fresh machine leaves no stray .bak.
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
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
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

async function main() {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes("--dry-run");
	const printOnly = argv.includes("--print");

	const rows = buildRows();
	if (printOnly) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return;
	}

	if (rows.length === 0) {
		// No provider key is set, so every row would name a model that cannot
		// route (issue #30, sixteen times over). Refuse rather than write an empty
		// picker — and say which file to fix, since the usual cause is keys that
		// never made it into ~/.env.
		process.stderr.write(
			"cc-proxy: no provider keys are registered, so there are no models to publish. Add a key to ~/.env (GLM_API_KEY, DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, …) or re-run /cc-proxy:setup.\n",
		);
		process.exitCode = 1;
		return;
	}

	const file = settingsPath();
	/** @type {Record<string, unknown>} */
	let settings;
	try {
		settings = readSettings(file);
	} catch (err) {
		process.stderr.write(
			`cc-proxy: ${file} could not be read as JSON (${/** @type {Error} */ (err).message}). Fix it by hand and re-run; nothing was written.\n`,
		);
		process.exitCode = 1;
		return;
	}

	const pin = contextPin(settings);
	const dropped = dropSupersededEnv(settings);
	const merged = mergePicker(dropped.settings, rows);

	if (dryRun) {
		process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
		return;
	}

	writeSettings(file, merged);

	process.stdout.write(`cc-proxy: wrote ${rows.length} modelPicker rows to ${file}\n`);
	if (dropped.removed.length > 0) {
		process.stdout.write(
			`cc-proxy: removed superseded env ${dropped.removed.join(", ")} — the generated rows include that model, and both would render.\n`,
		);
	}
	if (pin !== undefined) {
		process.stdout.write(
			`cc-proxy: NOTE — env.CLAUDE_CODE_MAX_CONTEXT_TOKENS is still set (${pin}). It no longer affects any model with a row above; it now only applies to ids with NO row (typos, pinned subagent models, OpenRouter slash-ids), where a large value over-budgets them. Left in place — remove it by hand if you no longer want it.\n`,
		);
	}
}

if (isDirectRun(import.meta.url)) {
	main().catch((err) => {
		process.stderr.write(`cc-proxy: unexpected error: ${err.message}\n`);
		process.exit(1);
	});
}

export { SUPERSEDED_ENV_KEYS };
