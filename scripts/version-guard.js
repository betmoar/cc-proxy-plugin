#!/usr/bin/env node
// Issue #41: `pnpm version patch|minor` tags BEFORE the squash, so a tag
// created on a feature branch lands on a commit the squash-merge discards —
// v<x.y.z> would point outside the released history. Caught by hand during
// 0.7.0, avoided by hand again in 0.8.1 (five releases disarmed by memory);
// this guard makes the trap refuse to spring.
//
// Wired BOTH as the `preversion` lifecycle script and as the first step of
// the `version` script: pnpm ≥10 does not run pre/post lifecycle scripts by
// default (enable-pre-post-scripts defaults false — measured 11.3.0: only the
// `version` script ran), so the guard inside `version` is the one that
// actually catches pnpm; preversion covers npm for free. The bump itself is
// legal anywhere — the flow bumps on the branch and tags on main after the
// squash — so the refusal fires only when the invocation would TAG while off
// main. That differs per client, measured 2026-08-31:
//
//   npm  honors the repo `.npmrc` (`git-tag-version=false`, shipped here), so
//        an npm invocation never tags, flag or no flag. Its argv cannot be
//        inspected for the flag anyway — npm strips it from the parent's
//        command line ("npm version patch"), and it exports
//        npm_config_git_tag_version as "" in BOTH modes, so env is no signal.
//   pnpm IGNORES `.npmrc` for `version` (measured: tagged anyway) but leaves
//        the flag visible in its parent argv ("node …/pnpm version patch
//        --no-git-tag-version").
//
// So: main always passes; npm always passes (the .npmrc disarms it); anything
// else must carry --no-git-tag-version in the invoking command line. Fail-safe
// for unknown clients — they need the flag.

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sh(cmd) {
	return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// The preversion script's direct parent is the package manager itself; npm
// prunes its own flags there, pnpm does not.
function invokingCommandLine() {
	try {
		return sh(`ps -p ${process.ppid} -o command=`);
	} catch {
		return "";
	}
}

/**
 * @param {{branch: string, command: string}} p
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function guard({ branch, command }) {
	if (branch === "main") return { ok: true };
	// npm: tagging is already governed by the repo .npmrc (git-tag-version=false).
	if (/(^|\/|\b)npm(\s|$)/.test(command) && !/\bpnpm\b/.test(command)) return { ok: true };
	if (/--no-git-tag-version/.test(command)) return { ok: true };

	return {
		ok: false,
		reason:
			`refusing to version on branch "${branch}" — this invocation would create\n` +
			`  the v<x.y.z> tag HERE, on a commit the squash-merge to main discards\n` +
			`  (issue #41). Run instead:\n` +
			`    npm version patch|minor   (the repo .npmrc already blocks its tag)\n` +
			`    pnpm version patch|minor --no-git-tag-version\n` +
			`  then create the tag on main AFTER the squash.`,
	};
}

const isDirectRun =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
	const branch = (() => {
		try {
			return sh("git branch --show-current");
		} catch {
			return ""; // not a git checkout — treat as non-main, guarded
		}
	})();
	const { ok, reason } = guard({ branch, command: invokingCommandLine() });
	if (!ok) {
		process.stderr.write(`preversion: ${reason}\n`);
		process.exit(1);
	}
}
