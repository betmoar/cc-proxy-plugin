import { strict as assert } from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	LOG_MAX_BYTES,
	checkPort,
	ensureProxyRunning,
	rotateLogIfLarge,
	waitReady,
} from "../hooks/proxy-lifecycle.js";

// Pick a high random port so this test doesn't collide with a real proxy.
function listenOn(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(port, "127.0.0.1", () => resolve(srv));
	});
}

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

describe("proxy-lifecycle", () => {
	describe("checkPort", () => {
		let server;
		let openPort;
		let closedPort;

		before(async () => {
			openPort = await freePort();
			server = await listenOn(openPort);
			// A port we can be reasonably sure is unbound right now.
			closedPort = await freePort();
		});

		after(() => {
			server?.close();
		});

		it("returns true for an open port", async () => {
			assert.equal(await checkPort(openPort), true);
		});

		it("returns false for a closed port", async () => {
			assert.equal(await checkPort(closedPort), false);
		});
	});

	describe("waitReady", () => {
		it("times out and returns false when no one listens", async () => {
			const port = await freePort();
			const start = Date.now();
			const ok = await waitReady(port, Date.now() + 250);
			const elapsed = Date.now() - start;
			assert.equal(ok, false);
			// Should roughly honor the deadline (tolerate scheduler jitter).
			assert.ok(elapsed >= 200 && elapsed < 1500, `elapsed=${elapsed}ms`);
		});

		it("returns true once the port opens mid-wait", async () => {
			const port = await freePort();
			const p = waitReady(port, Date.now() + 1500);
			// Give waitReady a chance to poll at least once.
			await new Promise((r) => setTimeout(r, 150));
			const srv = await listenOn(port);
			try {
				assert.equal(await p, true);
			} finally {
				srv.close();
			}
		});
	});

	describe("ensureProxyRunning", () => {
		it("returns 'already-up' when the port is already listening", async () => {
			const port = await freePort();
			const srv = await listenOn(port);
			try {
				const state = await ensureProxyRunning({ port });
				assert.equal(state, "already-up");
			} finally {
				srv.close();
			}
		});

		it("returns 'missing-path' when proxy is down and PROXY_PATH is unset", async () => {
			const port = await freePort();
			const saved = process.env.PROXY_PATH;
			process.env.PROXY_PATH = "";
			try {
				const state = await ensureProxyRunning({ port });
				assert.equal(state, "missing-path");
			} finally {
				if (saved === undefined) process.env.PROXY_PATH = undefined;
				else process.env.PROXY_PATH = saved;
			}
		});

		// /cc-proxy:setup spawns the proxy before SessionStart has injected
		// settings.json's env into the process, so it passes an explicit env
		// (GLM_API_KEY especially). The spawned child must receive it.
		it("forwards opts.env to the spawned proxy", async () => {
			const port = await freePort();
			const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-env-")), "env.txt");
			// Minimal proxy stand-in: listen on the port (so waitReady passes),
			// then write the sentinel + its own PID to disk for cleanup.
			const script = path.join(
				fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-standin-")),
				"proxy.mjs",
			);
			fs.writeFileSync(
				script,
				`import net from "node:net";
import fs from "node:fs";
const s = net.createServer();
s.listen(${port}, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(out)}, process.env.CC_PROXY_SENTINEL + ":" + process.pid);
});
`,
			);
			try {
				const state = await ensureProxyRunning({
					port,
					proxyPath: script,
					readyTimeoutMs: 4000,
					env: { ...process.env, CC_PROXY_SENTINEL: "forwarded" },
				});
				assert.equal(state, "started");
				// Give the detached child a tick to flush the file after listen().
				for (let i = 0; i < 50 && !fs.existsSync(out); i++) {
					await new Promise((r) => setTimeout(r, 50));
				}
				const [sentinel, pid] = fs.readFileSync(out, "utf8").split(":");
				assert.equal(sentinel, "forwarded");
				try {
					process.kill(Number(pid));
				} catch {
					// child already gone — fine
				}
			} finally {
				fs.rmSync(path.dirname(script), { recursive: true, force: true });
				fs.rmSync(path.dirname(out), { recursive: true, force: true });
			}
		});
	});

	describe("rotateLogIfLarge", () => {
		let dir;
		before(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-log-"));
		});
		after(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it("no-op when the log does not exist", () => {
			const logPath = path.join(dir, "absent.log");
			rotateLogIfLarge(logPath, 10);
			assert.equal(fs.existsSync(logPath), false);
			assert.equal(fs.existsSync(`${logPath}.1`), false);
		});

		it("no-op when the log is under the cap", () => {
			const logPath = path.join(dir, "small.log");
			fs.writeFileSync(logPath, "tiny");
			rotateLogIfLarge(logPath, 1024);
			assert.equal(fs.existsSync(`${logPath}.1`), false);
			assert.equal(fs.readFileSync(logPath, "utf8"), "tiny");
		});

		it("rotates to .1 when the log exceeds the cap", () => {
			const logPath = path.join(dir, "big.log");
			fs.writeFileSync(logPath, "x".repeat(2048));
			rotateLogIfLarge(logPath, 1024);
			// Original moved aside; live log no longer present (spawn reopens it).
			assert.equal(fs.existsSync(`${logPath}.1`), true);
			assert.equal(fs.readFileSync(`${logPath}.1`, "utf8").length, 2048);
			assert.equal(fs.existsSync(logPath), false);
		});

		it("overwrites a prior .1 on the next rotation (single generation)", () => {
			const logPath = path.join(dir, "gen.log");
			fs.writeFileSync(`${logPath}.1`, "OLD");
			fs.writeFileSync(logPath, "y".repeat(2048));
			rotateLogIfLarge(logPath, 1024);
			assert.equal(fs.readFileSync(`${logPath}.1`, "utf8").length, 2048);
		});

		it("exports a sane default cap (>=1MB)", () => {
			assert.ok(LOG_MAX_BYTES >= 1024 * 1024, `cap ${LOG_MAX_BYTES}`);
		});
	});
});
