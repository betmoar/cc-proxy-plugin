import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

// A stand-in bin/cc-proxy.js: binds PROXY_PORT (so readiness passes) and
// records its pid + which file ran, for assertions and cleanup.
function standinBin(flagFile) {
	return `import net from "node:net";
import fs from "node:fs";
const s = net.createServer();
s.listen(Number(process.env.PROXY_PORT), "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(flagFile)}, String(process.pid));
});
`;
}

/**
 * Build a fake plugin tree (the shape of a marketplace cache dir): real copies
 * of scripts/start-proxy.js and hooks/proxy-lifecycle.js, plus an optional
 * stand-in bin/cc-proxy.js. This exercises the real resolution logic — the
 * tree's own bin must win — without ever spawning the actual proxy.
 */
function makeTree({ withBin, flagFile }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-tree-"));
	fs.mkdirSync(path.join(root, "scripts"));
	fs.mkdirSync(path.join(root, "hooks"));
	fs.copyFileSync(
		path.join(REPO, "scripts", "start-proxy.js"),
		path.join(root, "scripts", "start-proxy.js"),
	);
	fs.copyFileSync(
		path.join(REPO, "hooks", "proxy-lifecycle.js"),
		path.join(root, "hooks", "proxy-lifecycle.js"),
	);
	fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
	if (withBin) {
		fs.mkdirSync(path.join(root, "bin"));
		fs.writeFileSync(path.join(root, "bin", "cc-proxy.js"), standinBin(flagFile));
	}
	return root;
}

function run(tree, env) {
	return new Promise((resolve) => {
		execFile(
			"node",
			[path.join(tree, "scripts", "start-proxy.js")],
			{ env },
			(err, stdout, stderr) => {
				resolve({ code: err?.code ?? 0, stdout, stderr });
			},
		);
	});
}

async function waitFor(pred, tries = 50, gapMs = 50) {
	for (let i = 0; i < tries; i++) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, gapMs));
	}
	return pred();
}

function killPidFile(flag) {
	try {
		process.kill(Number(fs.readFileSync(flag, "utf8")));
	} catch {
		// already gone
	}
}

describe("start-proxy.js", () => {
	const cleanups = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()();
	});

	function tmpHome() {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-home-"));
		fs.mkdirSync(path.join(home, ".claude"));
		cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
		return home;
	}

	// PROXY_PORT still comes from settings.json on first-run setup (nothing has
	// injected it into the process env yet) — but the binary comes from the
	// plugin tree itself, not from settings.
	it("sources PROXY_PORT from settings.json and spawns the tree's own bin", async () => {
		const home = tmpHome();
		const port = await freePort();
		const flag = path.join(home, "spawned.txt");
		const tree = makeTree({ withBin: true, flagFile: flag });
		cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true }));
		cleanups.push(() => killPidFile(flag));
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { PROXY_PORT: String(port) } }),
		);

		const { stdout } = await run(tree, { PATH: process.env.PATH, HOME: home });

		assert.match(stdout, /cc-proxy started/, `Expected started, got: ${stdout}`);
		assert.ok(
			await waitFor(() => fs.existsSync(flag)),
			"tree's own bin should have spawned on the settings.json port",
		);
	});

	// The staleness fix itself: a version-pinned PROXY_PATH written to
	// settings.json by an old setup must NOT outrank the plugin tree's own bin —
	// that pin is how users silently never received proxy updates.
	it("ignores a stale settings.json PROXY_PATH when the tree has its own bin", async () => {
		const home = tmpHome();
		const port = await freePort();
		const flag = path.join(home, "current.txt");
		const staleFlag = path.join(home, "stale.txt");
		const staleBin = path.join(home, "stale-proxy.mjs");
		fs.writeFileSync(staleBin, standinBin(staleFlag));
		const tree = makeTree({ withBin: true, flagFile: flag });
		cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true }));
		cleanups.push(() => killPidFile(flag));
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { PROXY_PATH: staleBin, PROXY_PORT: String(port) } }),
		);

		const { stdout } = await run(tree, { PATH: process.env.PATH, HOME: home });

		assert.match(stdout, /cc-proxy started/, `Expected started, got: ${stdout}`);
		assert.ok(await waitFor(() => fs.existsSync(flag)), "tree bin should have run");
		assert.equal(fs.existsSync(staleFlag), false, "stale PROXY_PATH bin must not run");
	});

	// Legacy escape hatch: a tree without bin/ (e.g. a hand-rolled install)
	// still honors settings.json PROXY_PATH.
	it("falls back to settings.json PROXY_PATH when the tree has no bin", async () => {
		const home = tmpHome();
		const port = await freePort();
		const flag = path.join(home, "legacy.txt");
		const legacyBin = path.join(home, "legacy-proxy.mjs");
		fs.writeFileSync(legacyBin, standinBin(flag));
		const tree = makeTree({ withBin: false });
		cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true }));
		cleanups.push(() => killPidFile(flag));
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { PROXY_PATH: legacyBin, PROXY_PORT: String(port) } }),
		);

		const { stdout } = await run(tree, { PATH: process.env.PATH, HOME: home });

		assert.match(stdout, /cc-proxy started/, `Expected started, got: ${stdout}`);
		assert.ok(await waitFor(() => fs.existsSync(flag)), "legacy PROXY_PATH bin should have run");
	});

	it("reports missing-path when the tree has no bin and settings has no PROXY_PATH", async () => {
		const home = tmpHome();
		fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: {} }));
		const tree = makeTree({ withBin: false });
		cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true }));
		const port = await freePort();
		const { code, stderr } = await run(tree, {
			PATH: process.env.PATH,
			HOME: home,
			PROXY_PORT: String(port),
		});
		assert.equal(code, 1);
		assert.match(stderr, /PROXY_PATH/, `Expected missing-path message, got: ${stderr}`);
	});
});
