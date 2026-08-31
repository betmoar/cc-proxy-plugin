#!/usr/bin/env node
// Issue #41: `pnpm version patch|minor` tags BEFORE the squash, so a tag
// created on a feature branch lands on a commit the squash-merge discards —
// v<x.y.z> would point outside the released history. Caught by hand during
// 0.7.0, avoided by hand again in 0.8.1 (five releases disarmed by memory);
// this guard makes the trap refuse to spring.
//
// Wired BOTH as the `preversion` lifecycle script and as the first step of
// the `version` script: pnpm ≥10 does not run pre/post lifecycle scripts by
// default (enable-pre-post-scripts defaults false — measured 11.3.0: only
// the `version` script ran), so the copy inside `version` is the one that
// actually catches pnpm; preversion covers npm for free.
//
// The bump itself is legal anywhere — the flow bumps on the branch and tags
// on main after the squash — so the refusal fires only when the invocation
// would TAG while off main. Which clients can tag is measured 2026-08-31:
//
//   npm  honors the repo `.npmrc` (`git-tag-version=false`), so npm NEVER
//        tags here, flag or no flag. But its argv cannot prove it is npm:
//        inside the `version` script the parent is a bare `sh -c …`.
//   pnpm IGNORES `.npmrc` for `version` (measured: tagged anyway) and its
//        `--no-git-tag-version` flag is likewise invisible in argv from the
//        script's seat.
//
// The one signal both managers export in every lifecycle script is
// `npm_config_user_agent` ("npm/10.9.3 …" vs "pnpm/11.3.0 …"). Decision:
//
//   on main                      → allow (tagging on main is the point)
//   client is npm                → allow (the repo .npmrc disarms its tag)
//   user agent carries a flag or
//   the invoking argv does       → allow (an explicit no-tag request)
//   otherwise                    → REFUSE
//
// Fail-safe: an unknown client needs --no-git-tag-version.

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * @param {{branch: string, client: string, command: string}} p
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function guard({ branch, client, command }) {
	if (branch === "main") return { ok: true };
	// npm: tagging is already governed by the repo .npmrc (git-tag-version=false).
	if (/^npm\//.test(client)) return { ok: true };
	if (/--no-git-tag-version/.test(command)) return { ok: true };

	return {
		ok: false,
		reason: [
			`refusing to version on branch "${branch}" — this invocation would create`,
			"  the v<x.y.z> tag HERE, on a commit the squash-merge to main discards",
			"  (issue #41). Run instead:",
			"    npm version patch|minor   (the repo .npmrc already blocks its tag)",
			"    pnpm version patch|minor --no-git-tag-version",
			"  then create the tag on main AFTER the squash.",
		].join("\n"),
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
	const { ok, reason } = guard({
		branch,
		client: process.env.npm_config_user_agent ?? "",
		command: invokingCommandLine(),
	});
	if (!ok) {
		process.stderr.write(`version-guard: ${reason}\n`);
		process.exit(1);
	}
}
