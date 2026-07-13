import { strict as assert } from "node:assert";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	LOG_MAX_BYTES,
	checkPort,
	ensureProxyRunning,
	pluginVersion,
	resolveProxyPath,
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

		// In the dev repo (and any marketplace cache) resolveProxyPath() always
		// finds the tree's own bin, so missing-path needs an explicit empty
		// proxyPath — the resolution-failure case itself is covered by the
		// resolveProxyPath suite ("returns undefined when neither exists").
		it("returns 'missing-path' when proxy is down and no proxy path resolves", async () => {
			const port = await freePort();
			const state = await ensureProxyRunning({ port, proxyPath: "" });
			assert.equal(state, "missing-path");
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

	// PROXY_PATH staleness fix: the hook must derive the proxy binary from its
	// own plugin tree (the cache dir it runs from IS the current version), so a
	// version-pinned PROXY_PATH left in settings.json by an old setup can no
	// longer pin users to a stale proxy forever.
	describe("resolveProxyPath", () => {
		const hooksDir = path.dirname(fileURLToPath(new URL("../hooks/x", import.meta.url)));
		const repoBin = path.resolve(hooksDir, "..", "bin", "cc-proxy.js");

		it("returns the plugin tree's own bin/cc-proxy.js", () => {
			assert.equal(resolveProxyPath({}), repoBin);
		});

		it("prefers the plugin tree's bin over a (stale) env PROXY_PATH", () => {
			assert.equal(resolveProxyPath({ PROXY_PATH: "/stale/0.0.1/bin/cc-proxy.js" }), repoBin);
		});

		it("falls back to env PROXY_PATH when the sibling bin is absent", () => {
			const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-nobin-"));
			try {
				const got = resolveProxyPath(
					{ PROXY_PATH: "/legacy/bin/cc-proxy.js" },
					path.join(empty, "hooks"),
				);
				assert.equal(got, "/legacy/bin/cc-proxy.js");
			} finally {
				fs.rmSync(empty, { recursive: true, force: true });
			}
		});

		it("returns undefined when neither exists", () => {
			const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-nobin-"));
			try {
				assert.equal(resolveProxyPath({}, path.join(empty, "hooks")), undefined);
			} finally {
				fs.rmSync(empty, { recursive: true, force: true });
			}
		});
	});

	describe("pluginVersion", () => {
		it("reads the plugin tree's package.json version", () => {
			const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
			assert.equal(pluginVersion(), pkg.version);
		});

		it("returns undefined when package.json is absent", () => {
			const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-nopkg-"));
			try {
				assert.equal(pluginVersion(path.join(empty, "hooks")), undefined);
			} finally {
				fs.rmSync(empty, { recursive: true, force: true });
			}
		});
	});

	// The other half of the staleness fix: an already-listening proxy is version
	// -probed via /_status; a mismatch gets a graceful POST /_shutdown and a
	// respawn from the (current) proxyPath. Anything that doesn't speak the
	// /_status contract is foreign — never killed.
	describe("ensureProxyRunning version handshake", () => {
		/** Stand-in "old proxy": answers /_status with `version`, closes on /_shutdown. */
		function startOldProxy(port, version) {
			return new Promise((resolve) => {
				const srv = http.createServer((req, res) => {
					if (req.url === "/_status" && req.method === "GET") {
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ port, version, providers: [] }));
						return;
					}
					if (req.url === "/_shutdown" && req.method === "POST") {
						res.writeHead(200, { "content-type": "application/json" });
						res.end("{}");
						srv.close();
						srv.closeIdleConnections();
						return;
					}
					res.writeHead(404).end();
				});
				srv.listen(port, "127.0.0.1", () => resolve(srv));
			});
		}

		function standinSpawnScript(port, flagFile) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-new-"));
			const script = path.join(dir, "proxy.mjs");
			fs.writeFileSync(
				script,
				`import net from "node:net";
import fs from "node:fs";
const s = net.createServer();
s.listen(${port}, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(flagFile)}, String(process.pid));
});
`,
			);
			return script;
		}

		it("restarts a proxy whose /_status version mismatches the plugin's", async () => {
			const port = await freePort();
			const old = await startOldProxy(port, "0.0.0-stale");
			const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-flag-")), "pid");
			const script = standinSpawnScript(port, flag);
			try {
				const state = await ensureProxyRunning({
					port,
					proxyPath: script,
					readyTimeoutMs: 5000,
				});
				assert.equal(state, "restarted");
				for (let i = 0; i < 50 && !fs.existsSync(flag); i++) {
					await new Promise((r) => setTimeout(r, 50));
				}
				assert.ok(fs.existsSync(flag), "replacement proxy should have spawned on the port");
			} finally {
				old.close();
				try {
					process.kill(Number(fs.readFileSync(flag, "utf8")));
				} catch {}
				fs.rmSync(path.dirname(script), { recursive: true, force: true });
				fs.rmSync(path.dirname(flag), { recursive: true, force: true });
			}
		});

		it("leaves a same-version proxy alone", async () => {
			const port = await freePort();
			const old = await startOldProxy(port, pluginVersion());
			try {
				const state = await ensureProxyRunning({ port, proxyPath: "/unused" });
				assert.equal(state, "already-up");
			} finally {
				old.close();
			}
		});

		it("leaves a foreign (non-/_status) listener alone", async () => {
			const port = await freePort();
			const srv = await listenOn(port); // bare TCP, never answers HTTP
			try {
				const state = await ensureProxyRunning({ port, proxyPath: "/unused" });
				assert.equal(state, "already-up");
			} finally {
				srv.close();
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

		// The env guard runs at import, so vary it in a child process. A negative
		// PROXY_LOG_MAX_BYTES would disable rotation (size <= cap always true), so
		// it must fall back to the 5 MB default, not pass through.
		it("falls back to the default cap for a negative PROXY_LOG_MAX_BYTES", async () => {
			const { execFileSync } = await import("node:child_process");
			const mod = new URL("../hooks/proxy-lifecycle.js", import.meta.url).pathname;
			const out = execFileSync(
				process.execPath,
				["-e", `import(${JSON.stringify(mod)}).then((m) => console.log(m.LOG_MAX_BYTES))`],
				{ env: { ...process.env, PROXY_LOG_MAX_BYTES: "-1" }, encoding: "utf8" },
			);
			assert.equal(Number(out.trim()), 5 * 1024 * 1024);
		});
	});
});
