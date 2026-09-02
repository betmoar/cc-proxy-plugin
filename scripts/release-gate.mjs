#!/usr/bin/env node
// Release gate: a v<x.y.z> tag must match plugin.json, package.json, and
// CHANGELOG.md before a GitHub release is cut.
//
// Run by .github/workflows/release.yml on tag push; also runnable locally
// before pushing a tag:
//
//     node scripts/release-gate.mjs v0.3.3 [--root DIR] [--notes-out FILE]
//
// The coupling this enforces (see CLAUDE.md's release row):
//
//     tag v<x.y.z> == plugin.json "version" == package.json "version"
//                  == newest CHANGELOG heading
//
// `test/version-sync.test.js` already pins plugin.json == package.json on every
// PR; this gate re-checks that at release time and adds the tag and the
// CHANGELOG-heading half. With --notes-out, the tag version's CHANGELOG section
// is written to FILE for use as the GitHub release body — so release notes are
// the changelog, not a hand-written duplicate.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "./direct-run.js";

const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
// Newest-first list of semver headings, e.g. "## [0.3.3] — 2026-07-09".
const CHANGELOG_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\]/gm;

// Return the CHANGELOG body between '## [version]' and the next '## [' heading
// or the trailing '[' link-reference block (whichever comes first).
export function extractSection(changelogText, version) {
	const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = new RegExp(`^## \\[${esc}\\][^\\n]*\\n`, "m").exec(changelogText);
	if (!start) return "";
	const rest = changelogText.slice(start.index + start[0].length);
	const stop = /^## \[|^\[/m.exec(rest);
	return (stop ? rest.slice(0, stop.index) : rest).trim();
}

function readJsonVersion(path) {
	return JSON.parse(readFileSync(path, "utf8")).version;
}

// Return { problems: string[], notes: string }. Empty problems ⇒ tag may ship.
export function gate(root, tag) {
	const problems = [];
	let notes = "";

	const m = TAG_RE.exec(tag);
	if (!m) {
		problems.push(`tag ${JSON.stringify(tag)} is not v<x.y.z> — retag, e.g. v0.3.3`);
		return { problems, notes };
	}
	const ver = m[1];

	let pluginVer = null;
	try {
		pluginVer = readJsonVersion(join(root, ".claude-plugin", "plugin.json"));
	} catch (e) {
		problems.push(`plugin.json unreadable: ${e.message}`);
	}
	if (pluginVer != null && pluginVer !== ver) {
		problems.push(
			`tag ${tag} does not match plugin.json version ${JSON.stringify(pluginVer)} — bump package.json and run \`pnpm sync-version\` (or fix the tag)`,
		);
	}

	let pkgVer = null;
	try {
		pkgVer = readJsonVersion(join(root, "package.json"));
	} catch (e) {
		problems.push(`package.json unreadable: ${e.message}`);
	}
	if (pkgVer != null && pkgVer !== ver) {
		problems.push(
			`tag ${tag} does not match package.json version ${JSON.stringify(pkgVer)} — plugin.json and package.json versions must move together`,
		);
	}

	let text;
	try {
		text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	} catch {
		problems.push("CHANGELOG.md: missing");
		return { problems, notes };
	}
	const headings = [...text.matchAll(CHANGELOG_HEADING_RE)].map((x) => x[1]);
	const newest = headings.length ? headings[0] : null;
	if (newest !== ver) {
		problems.push(
			`newest CHANGELOG heading is '[${newest}]' but the tag is ${tag} — the '## [${ver}]' entry must be the first '## [' heading in CHANGELOG.md`,
		);
	} else {
		notes = extractSection(text, ver);
		if (!notes) {
			problems.push(
				`CHANGELOG section for [${ver}] is empty — write the release notes there; they become the GitHub release body`,
			);
		}
	}

	return { problems, notes };
}

function main(argv) {
	const args = argv.slice(2);
	let tag = null;
	let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let notesOut = null;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--root") root = args[++i];
		else if (a === "--notes-out") notesOut = args[++i];
		else if (!tag) tag = a;
		else {
			process.stderr.write(`unexpected argument: ${a}\n`);
			return 2;
		}
	}
	if (!tag) {
		process.stderr.write("usage: release-gate.mjs v<x.y.z> [--root DIR] [--notes-out FILE]\n");
		return 2;
	}

	const { problems, notes } = gate(root, tag);
	for (const p of problems) process.stderr.write(`FAIL: ${p}\n`);
	if (problems.length) {
		process.stderr.write(`\nrelease gate: ${problems.length} problem(s); not shipping.\n`);
		return 1;
	}
	if (notesOut) writeFileSync(notesOut, `${notes}\n`, "utf8");
	process.stdout.write(
		`release gate OK: ${tag} == plugin.json == package.json == newest CHANGELOG heading\n`,
	);
	return 0;
}

// Only run the CLI when invoked directly, not when imported by tests. The
// decoded comparison this used to spell inline survived a space/%/# and Windows
// but NOT a symlink (import.meta.url is the main module's REALPATH; argv[1] is
// the shell's spelling) — measured 2026-09-02: through a symlinked checkout this
// exited 0 having never run, where the direct invocation exits 2.
if (isDirectRun(import.meta.url)) {
	process.exit(main(process.argv));
}
