import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// A slash-command body is a TEMPLATE: Claude Code splices `$ARGUMENTS` into it
// as source text before any shell runs (CLAUDE.md "A slash command has NO
// positional parameters"). Nothing in the suite executed those bodies, so the
// splice was tested only by hand — and `set -- $ARGUMENTS` was found to hand
// the user's words to the parser as syntax: `speed --report | cat` ran `set --`
// in a subshell and fell through to the billed `grades` run, `speed > x`
// truncated x, `$(…)` executed (measured). This file does what the harness
// does — textual replacement — and runs the result under bash against stub
// scripts, so the body is tested in the shape it actually executes in.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bashBlock(file) {
	const md = fs.readFileSync(path.join(root, "commands", file), "utf8");
	const m = /```bash\n([\s\S]*?)\n```/.exec(md);
	assert.ok(m, `${file} has no bash block`);
	return m[1];
}

/**
 * A fake plugin root holding stub bench scripts that record their argv. The
 * body's root resolution falls through CLAUDE_PLUGIN_ROOT (empty), PROXY_PATH
 * (unset), the marketplace cache (an empty HOME) and lands on $PWD — this dir.
 */
function fakeRoot() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cmd-"));
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.mkdirSync(path.join(dir, "home"));
	for (const name of ["bench-speed", "bench-grades"]) {
		fs.writeFileSync(
			path.join(dir, "scripts", `${name}.js`),
			`require("fs").appendFileSync(process.env.ARGV_OUT, JSON.stringify(["${name}", ...process.argv.slice(2)]) + "\\n");\n`,
		);
	}
	return dir;
}

// A slash command runs under the USER'S LOGIN SHELL, which on macOS is zsh —
// so testing the body under bash alone tests a shell most of these users never
// reach. Two defects hid in exactly that gap and were each green in bash:
// `set -- $args` splits to one word in zsh (killing every non-empty argument),
// and a heredoc inside `$(…)` is mis-parsed by bash 3.2, which is /bin/bash on
// every macOS while CI runs bash 5. Every case below therefore runs in both.
// `sh` is included because it is neither: a third parser, and the cheapest
// guard against a fix that leans on one shell's extension.
const SHELLS = ["bash", "zsh", "sh"];

/** Splice `args` where the harness splices `$ARGUMENTS`, run under `shell` in `dir`. */
function runSpliced(body, args, dir, shell = "bash") {
	const out = path.join(dir, "argv.jsonl");
	fs.rmSync(out, { force: true });
	const spliced = body.split("$ARGUMENTS").join(args);
	return new Promise((resolve) => {
		execFile(
			shell,
			["-c", spliced],
			{
				cwd: dir,
				env: {
					PATH: process.env.PATH,
					HOME: path.join(dir, "home"),
					ARGV_OUT: out,
					CLAUDE_PLUGIN_ROOT: "",
				},
			},
			(err, stdout, stderr) => {
				let calls = [];
				try {
					calls = fs
						.readFileSync(out, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l));
				} catch {}
				resolve({ code: err?.code ?? 0, stdout, stderr, calls });
			},
		);
	});
}

for (const shell of SHELLS) {
	describe(`commands/bench.md argument splice (${shell})`, () => {
		const body = bashBlock("bench.md");

		// The zsh defect: `set -- $args` left $1 as the WHOLE string, so `case`
		// matched no branch and the command died — for every non-empty argument,
		// on the shell macOS users actually run.
		it("routes `speed --report` to bench-speed with --report", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "speed --report", dir, shell);
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.calls, [["bench-speed", "--report"]]);
		});

		it("defaults to grades with no argument", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "", dir, shell);
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.calls, [["bench-grades"]]);
		});

		// The measured failure: a pipe in the argument ran `set --` in a subshell,
		// left $1 empty, and the default branch fired a billed grades run.
		it("a `|` in the argument is a word, not a pipeline — grades never runs", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "speed --report | cat", dir, shell);
			assert.deepEqual(r.calls, [["bench-speed", "--report", "|", "cat"]]);
		});

		it("a `>` in the argument is a word, not a redirection — no file is created", async () => {
			const dir = fakeRoot();
			const target = path.join(dir, "clobbered.txt");
			const r = await runSpliced(body, `speed > ${target}`, dir, shell);
			assert.equal(fs.existsSync(target), false, "the argument truncated a file");
			assert.deepEqual(r.calls, [["bench-speed", ">", target]]);
		});

		// bash 3.2 (/bin/bash on macOS) mis-parses a heredoc inside `$(…)` and
		// died here with "unexpected EOF"; bash 5, which CI runs, did not.
		it("an unbalanced quote is a word, not a syntax error", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "speed 'glm-5.2", dir, shell);
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.calls, [["bench-speed", "'glm-5.2"]]);
		});

		it("a `$(…)` in the argument is not executed", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "speed $(echo INJECTED)", dir, shell);
			assert.deepEqual(r.calls, [["bench-speed", "$(echo", "INJECTED)"]]);
		});

		// Splitting must not GLOB: the argv goes straight to a script.
		it("a `*` in the argument is not expanded against the cwd", async () => {
			const dir = fakeRoot();
			fs.writeFileSync(path.join(dir, "aaa.txt"), "");
			fs.writeFileSync(path.join(dir, "bbb.txt"), "");
			const r = await runSpliced(body, "speed *.txt", dir, shell);
			assert.deepEqual(r.calls, [["bench-speed", "*.txt"]]);
		});

		it("an unknown sub-command is refused", async () => {
			const dir = fakeRoot();
			const r = await runSpliced(body, "bogus", dir, shell);
			assert.equal(r.code, 1);
			assert.match(r.stderr, /unknown sub-command/);
			assert.deepEqual(r.calls, []);
		});
	});
}

describe("commands without arguments splice nothing", () => {
	// status.md and models.md take no arguments; a `$ARGUMENTS`/`$1` in their
	// bodies would be a splice point with nothing guarding it.
	for (const file of ["status.md", "models.md"]) {
		it(`${file} carries no $ARGUMENTS or $1-$9`, () => {
			const body = bashBlock(file);
			assert.doesNotMatch(body, /\$ARGUMENTS|\$[1-9]\b/);
		});
	}
});
