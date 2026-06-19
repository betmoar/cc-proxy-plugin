import { strict as assert } from "node:assert";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import {
	checkPort,
	ensureProxyRunning,
	waitReady,
} from "../plugins/cc-proxy/hooks/proxy-lifecycle.js";

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
	});
});
