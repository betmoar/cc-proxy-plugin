#!/usr/bin/env node
// Issue #41: `pnpm version patch|minor` tags BEFORE the squash, so a tag
// created on a feature branch lands on a commit the squash-merge discards —
// v<x.y.z> would point outside the released history. Caught by hand during
// 0.7.0, avoided by hand again in 0.8.1 (five releases disarmed by memory);
// this guard makes the trap refuse to spring.
//
// Wired BOTH as the `preversion` lifecycle script and as the first step of
// the `version` script. Both fire under both managers (measured 2026-08-31 on
// the pinned pnpm@11.3.0 AND on 11.24.0: preversion, version and postversion
// all ran), so the second copy is redundant insurance, not a workaround —
// pnpm's own pre/post behaviour has flip-flopped across releases, and either
// copy alone is sufficient. An earlier version of this comment claimed pnpm
// skips `preversion` by default; that was measured false on the very version
// it cited. Do not delete either copy on the strength of a remembered default.
//
// The bump itself is legal anywhere — the flow bumps on the branch and tags
// on main after the squash — so the refusal fires only when the invocation
// would TAG while off main. Full grid, measured 2026-08-31 (npm 10.9.3,
// pnpm 11.3.0), repo `.npmrc` = `git-tag-version=false`, off main:
//
//   spelling                       npm       pnpm
//   (none)                         no tag    TAGS
//   --git-tag-version              TAGS      TAGS
//   --git-tag-version=false        no tag    no tag
//   --no-git-tag-version           no tag    no tag
//   --no-git-tag-version=true      no tag    no tag
//   --no-git-tag-version=false     TAGS      TAGS   ← reads like a no-tag flag
//
// Two consequences, each a hole the first cut had:
//   * `.npmrc` is NOT a seatbelt for npm — a CLI flag or an
//     `npm_config_git_tag_version=true` env var overrides the file (both
//     measured tagging). "npm is safe because .npmrc says so" is false.
//   * a substring test for `--no-git-tag-version` ALLOWS the `=false`
//     spelling, which tags. The flag must be matched with its value.
//
// Signals available from a lifecycle script's seat:
//   npm  exports `npm_config_git_tag_version` — "true" in exactly the rows
//        that tag, "" in exactly the rows that do not (6/6). Its argv is
//        useless: the parent is a bare `sh -c …`.
//   pnpm exports NOTHING for this setting (undefined in every row) and
//        ignores the repo `.npmrc` for `version` entirely, but its full
//        command line IS visible a couple of ancestors up.
//
// So each manager is judged on the signal it actually emits:
//
//   on main                        → allow (tagging on main is the point)
//   npm, env says tagging is off   → allow (the flag/npmrc combination is safe)
//   argv carries a real no-tag flag→ allow (an explicit no-tag request)
//   otherwise                      → REFUSE
//
// Fail-safe: an unknown client needs --no-git-tag-version.

import { execSync } from "node:child_process";
import { isDirectRun } from "./direct-run.js";

function sh(cmd) {
	return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// pnpm hides its own argv from the script's parent chain, so the flag must be
// readable from the INVOKING command line: walk up past sh wrappers to the
// first ancestor that mentions a package manager.
function invokingCommandLine() {
	try {
		let ppid = process.ppid;
		for (let i = 0; i < 4 && ppid; i++) {
			const cmd = sh(`ps -p ${ppid} -o command=`);
			if (/npm|pnpm|yarn|bun/.test(cmd)) return cmd;
			ppid = Number.parseInt(sh(`ps -p ${ppid} -o ppid=`), 10);
		}
	} catch {}
	return "";
}

// One boolean setting, four spellings, and the `=false` pair is why a substring
// test is not enough: `--no-git-tag-version=false` READS like a no-tag request
// and TAGS, while `--git-tag-version=false` reads like the opposite and does
// not (both measured on npm and pnpm). Resolve the flag to the value it
// actually sets, then answer whether tagging ends up OFF.
// @doctest disablesTagging("pnpm version patch --no-git-tag-version") -> true
// @doctest disablesTagging("pnpm version patch --no-git-tag-version=true") -> true
// @doctest disablesTagging("pnpm version patch --no-git-tag-version=false") -> false
// @doctest disablesTagging("pnpm version patch --git-tag-version=false") -> true
// @doctest disablesTagging("pnpm version patch --git-tag-version") -> false
// @doctest disablesTagging("pnpm version patch") -> false
export function disablesTagging(command) {
	const m = /--(no-)?git-tag-version(?:=(\S*))?/.exec(command ?? "");
	if (!m) return false;
	const negated = Boolean(m[1]);
	// A bare flag means true; an explicit value speaks for itself.
	const value = m[2] === undefined ? true : !/^(false|0)$/i.test(m[2]);
	// `--no-X=true` sets X off; `--no-X=false` sets X on.
	return negated ? value : !value;
}

/**
 * @param {{branch: string, client: string, command: string, tagEnv?: string}} p
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function guard({ branch, client, command, tagEnv }) {
	if (branch === "main") return { ok: true };
	// npm is the only client that reports this setting, and it reports it
	// exactly: "true" in every measured row that tagged. `.npmrc` alone proves
	// nothing — a flag or an env var overrides the file.
	if (/^npm\//.test(client) && tagEnv !== "true") return { ok: true };
	if (disablesTagging(command)) return { ok: true };

	return {
		ok: false,
		reason: [
			`refusing to version on branch "${branch}" — this invocation would create`,
			"  the v<x.y.z> tag HERE, on a commit the squash-merge to main discards",
			"  (issue #41). Run instead:",
			"    pnpm version patch|minor --no-git-tag-version",
			"    npm version patch|minor   (with no --git-tag-version override)",
			"  then create the tag on main AFTER the squash.",
		].join("\n"),
	};
}

// The decoded comparison this used to spell inline handles a space/%/# and
// Windows, but NOT a symlink: Node resolves the main module's import.meta.url to
// the REALPATH while argv[1] keeps the shell's spelling. Measured 2026-09-02
// through a symlinked checkout — `node <link>/scripts/version-guard.js` exited 0
// with the guard NEVER RUNNING, where the direct invocation exits 1. A guard
// that disarms itself on the machines most likely to have a symlinked checkout
// is worse than no guard, because the release procedure trusts it.
if (isDirectRun(import.meta.url)) {
	// `--show-current` prints EMPTY on a detached HEAD (not the literal "HEAD"
	// that `rev-parse --abbrev-ref` would give), so both the detached case and
	// the throw below land on "" — non-main, guarded. Fail-closed either way;
	// what differs is only what we can tell the user, hence `branchErr`.
	let branchErr = "";
	const branch = (() => {
		try {
			return sh("git branch --show-current");
		} catch (err) {
			branchErr = err instanceof Error ? err.message.split("\n")[0] : String(err);
			return ""; // no usable git answer — treat as non-main, guarded
		}
	})();
	const { ok, reason } = guard({
		branch,
		client: process.env.npm_config_user_agent ?? "",
		command: invokingCommandLine(),
		tagEnv: process.env.npm_config_git_tag_version,
	});
	if (!ok) {
		// Without this line a broken git (missing binary, unreadable .git) is
		// indistinguishable from a legitimate feature branch: both refuse with
		// branch "". `sh()` discards stderr, so err.message is all there is.
		const why = branchErr ? `\n  (could not read the branch: ${branchErr})` : "";
		process.stderr.write(`version-guard: ${reason}${why}\n`);
		process.exit(1);
	}
}
