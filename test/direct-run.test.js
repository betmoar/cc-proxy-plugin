import { strict as assert } from "node:assert";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isDirectRun } from "../scripts/direct-run.js";

const execFile = promisify(execFileCb);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Can this process create symlinks? On Windows that needs Developer Mode or an
// elevated shell (EPERM/EACCES otherwise), so the two symlink cases below SKIP
// there with the reason on record rather than failing a suite whose code is
// correct. Probed once, with a real symlink in a throwaway dir — never assumed
// from process.platform, which would also skip on a Windows box that can.
const symlinkSkip = (() => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-symlink-probe-"));
	try {
		fs.writeFileSync(path.join(d, "t"), "");
		fs.symlinkSync(path.join(d, "t"), path.join(d, "l"));
		return false;
	} catch (err) {
		return `cannot create symlinks here (${err?.code ?? err}) — Windows needs Developer Mode or an elevated shell`;
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
})();

// The guard every operator script sits behind: "run main() only when I am the
// entry point, not when a test imports me". Five scripts spelled it as
//   import.meta.url === `file://${process.argv[1]}`
// which compares a URL to a raw path. The two agree only on a path with no
// URL-special characters, no symlink, and a POSIX root — so a plugin tree under
// a directory named "with space" made /cc-proxy:status and /cc-proxy:models
// print NOTHING and exit 0 (measured), and on Windows (`file://C:\…` vs
// `file:///C:/…`) the comparison can never be true. A false negative here is
// the worst shape: a silent no-op that the slash command then misreports as
// "the proxy may be down".
describe("scripts/direct-run.js isDirectRun", () => {
	let dir;
	let target;
	before(() => {
		// The directory name carries the three characters that URL-encode: a
		// space, a percent sign, and a hash. Any one of them breaks the old spelling.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-direct run %1 #a-"));
		target = path.join(dir, "entry.mjs");
		fs.writeFileSync(target, "export {};\n");
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("is true when argv[1] names the module, even through URL-special characters", () => {
		assert.equal(isDirectRun(pathToFileURL(target).href, target), true);
		// The old spelling is false on exactly this input — the defect, stated.
		assert.notEqual(pathToFileURL(target).href, `file://${target}`);
	});

	it("is true when argv[1] reaches the module through a symlink", { skip: symlinkSkip }, () => {
		// Node resolves the MAIN module's import.meta.url to the realpath (unless
		// --preserve-symlinks-main), while argv[1] keeps the spelling the shell
		// used. A plugin tree reached via a symlinked HOME or checkout hits this.
		const link = path.join(dir, "link.mjs");
		fs.symlinkSync(target, link);
		assert.equal(isDirectRun(pathToFileURL(target).href, link), true);
	});

	it("is true for a relative argv[1] (node resolves it; so must we)", () => {
		const rel = path.relative(process.cwd(), target);
		assert.equal(isDirectRun(pathToFileURL(target).href, rel), true);
	});

	it("is false when another file is the entry point (the import case)", () => {
		const other = path.join(dir, "other.mjs");
		fs.writeFileSync(other, "export {};\n");
		assert.equal(isDirectRun(pathToFileURL(target).href, other), false);
	});

	it("is false with no argv[1] at all (REPL, -e, stdin) and never throws", () => {
		assert.equal(isDirectRun(pathToFileURL(target).href, undefined), false);
		assert.equal(isDirectRun(pathToFileURL(target).href, ""), false);
		assert.equal(isDirectRun(pathToFileURL(target).href, path.join(dir, "missing.mjs")), false);
		assert.equal(isDirectRun("not a url", target), false);
	});
});

// END TO END, against the real script: the repo reached through a symlink whose
// path contains a space, `scripts/status.js` invoked the way commands/status.md
// invokes it, with PROXY_PORT pointing at a port nothing listens on. The report
// must say DOWN. Against the pre-fix guard this printed nothing and exited 0.
describe("scripts/status.js runs its main() from a symlinked path containing a space", () => {
	it("prints the DOWN report instead of silently exiting", { skip: symlinkSkip }, async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-with space-"));
		try {
			const link = path.join(tmp, "repo");
			fs.symlinkSync(repo, link, "dir");
			const home = path.join(tmp, "home");
			fs.mkdirSync(home);
			const { stdout } = await execFile(
				process.execPath,
				[path.join(link, "scripts", "status.js")],
				{
					// A throwaway HOME so ~/.env cannot redirect the probe; port 1 is
					// privileged and unbound, so the /_status fetch is refused at once.
					env: { ...process.env, HOME: home, PROXY_PORT: "1", PROXY_LOG: path.join(home, "x.log") },
					timeout: 15000,
				},
			);
			assert.match(
				stdout,
				/proxy:\s+DOWN/,
				`status.js printed ${JSON.stringify(stdout)} — its direct-run guard did not recognise itself as the entry point`,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
