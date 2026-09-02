// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is the module at `metaUrl` the process's entry point?
 *
 * The scripts under scripts/ are BOTH commands (`node scripts/status.js`, via
 * commands/*.md) and modules (the suite imports their pure helpers), so each
 * runs `main()` only behind this guard. Five of them spelled it as a strict
 * equality between `import.meta.url` and the string `"file://" + process.argv[1]`,
 * which compares a URL to a raw filesystem path. The two agree only when the
 * path contains no URL-special character, crosses no symlink, and starts with
 * `/`. Measured 2026-09-02: from a directory named `with space`, status.js and
 * list-models.js printed NOTHING and exited 0 — `file:///…/with space/…` on one
 * side, `file:///…/with%20space/…` on the other. A symlinked tree fails the same
 * way (Node resolves the main module's `import.meta.url` to the REALPATH;
 * `argv[1]` keeps the shell's spelling), and on Windows `file://C:\…` can never
 * equal `file:///C:/…`, so every operator command there was a silent no-op.
 * commands/status.md then tells the user "the proxy may be down".
 *
 * Silent is the point: a false negative here has no symptom but empty stdout.
 * So the comparison is done on the filesystem's terms — both sides decoded to
 * paths and realpath'd — and every failure mode (no argv, unreadable path,
 * malformed URL) is `false`, never a throw: a guard that throws at import time
 * would take the importing TEST down with it.
 *
 * Three sibling scripts (probe-vendors.mjs, release-gate.mjs, version-guard.js)
 * already used a decoded comparison, which is how the class was found: the fix
 * had been applied to three of eight sites. `test/couplings.test.js` now
 * forbids the raw spelling anywhere under scripts/, hooks/, bin/ and src/.
 *
 * @param {string} metaUrl  the caller's `import.meta.url`
 * @param {string | undefined} [argv1]  defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isDirectRun(metaUrl, argv1 = process.argv[1]) {
	if (!argv1) return false;
	let self;
	try {
		self = fileURLToPath(metaUrl);
	} catch {
		return false;
	}
	const entry = path.resolve(argv1);
	if (entry === self) return true;
	// Symlink on either side: compare what the two names actually denote.
	try {
		return fs.realpathSync(entry) === fs.realpathSync(self);
	} catch {
		return false;
	}
}
