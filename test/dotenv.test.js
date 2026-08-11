import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Reproduces the reported bug: `node bin/cc-proxy.js` exited 1 with
// "GLM_API_KEY is not set." when the key lived only in ~/.env, because bin
// loaded the repo-root .env and not ~/.env. The proxy now loads ~/.env too.
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cc-proxy.js");

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

// The proxy loads the repo-root .env (dev convenience) in addition to ~/.env.
// On a dev machine that .env may carry GLM_API_KEY, which would satisfy the key
// gate even with a clean HOME — making the "absent everywhere" test flaky. Skip
// that test then; CI has no repo .env so it runs there.
function repoEnvHasGlmKey() {
	const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
	try {
		return /^GLM_API_KEY=\s*\S/m.test(fs.readFileSync(file, "utf8"));
	} catch {
		return false;
	}
}

// Track every spawned proxy so after() can SIGKILL any stragglers. The proxy is
// a server; SIGTERM can race the http server's close, and a survivor keeps the
// port bound and stalls the suite teardown.
const children = [];

/**
 * Spawn the proxy (a long-running server) and resolve once it logs the listening
 * line, or reject with { code, stdout, stderr } if it exits first. Registers the
 * child for guaranteed teardown regardless of outcome.
 * @param {Record<string,string>} childEnv
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function startProxy(childEnv) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN], { env: childEnv });
		children.push(child);
		let stdout = "";
		let stderr = "";
		let settled = false;
		child.stdout.on("data", (d) => {
			stdout += d.toString();
			if (!settled && /cc-proxy listening on/.test(stdout)) {
				settled = true;
				resolve({ stdout, stderr });
			}
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("exit", (code) => {
			// Reaching here before the listening line means startup failed.
			if (!settled) {
				settled = true;
				reject(Object.assign(new Error(`proxy exited ${code}`), { code, stdout, stderr }));
			}
		});
	});
}

describe("bin/cc-proxy.js loads ~/.env", () => {
	let home;
	before(() => {
		// Isolated HOME so we control ~/.env and don't read the dev machine's real one.
		home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-env-"));
	});
	after(() => {
		// SIGKILL any proxy that survived its test (the http server can outlive
		// SIGTERM), then drop the temp HOME.
		for (const child of children) {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("starts when GLM_API_KEY is present only in ~/.env", async () => {
		const port = await freePort();
		fs.writeFileSync(path.join(home, ".env"), `GLM_API_KEY=from-home-dotenv\nPROXY_PORT=${port}\n`);

		// Critical: GLM_API_KEY is NOT in process.env — only in the isolated ~/.env.
		// (A dev repo-root .env, if one exists, also satisfies the check; the point
		// of this test is that NO key in process.env still starts the proxy.)
		const childEnv = { PATH: process.env.PATH, HOME: home, PROXY_PORT: String(port) };
		const { stdout } = await startProxy(childEnv);

		// Passed the GLM_API_KEY gate and bound the port — the exact failure mode
		// that was exiting 1 before the fix. (Reap via after()'s SIGKILL.)
		assert.match(
			stdout,
			new RegExp(`cc-proxy listening on http://127.0.0.1:${port}`),
			`Expected proxy to start from ~/.env, got: ${stdout}`,
		);
	});

	// Issue #20: GLM is opt-in like every other third-party backend. A zero-key
	// install is a VALID install (Claude/OAuth needs no key) — the old exit-1
	// guard is gone. Startup must still succeed and must still say something
	// loud enough that a user who MEANT to configure GLM notices it's missing.
	it(
		"starts with a claude-only notice when GLM_API_KEY is absent everywhere",
		{ skip: repoEnvHasGlmKey() },
		async () => {
			// The positive test above wrote <home>/.env with a key; remove it so this
			// case genuinely has no key in ~/.env or process.env.
			fs.rmSync(path.join(home, ".env"), { force: true });
			const port = await freePort();
			// No ~/.env, no key in process.env. Must still start (exit code never
			// reached — startProxy resolves on the listening line), and must print
			// a notice naming the active backends.
			const childEnv = { PATH: process.env.PATH, HOME: home, PROXY_PORT: String(port) };
			const { stdout, stderr } = await startProxy(childEnv);
			assert.match(
				stdout,
				new RegExp(`cc-proxy listening on http://127.0.0.1:${port}`),
				`Expected proxy to start with no third-party keys, got: ${stdout}`,
			);
			assert.match(stderr, /active backends: claude only \(no third-party keys found\)/);
		},
	);
});
