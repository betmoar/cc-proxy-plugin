import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../scripts/start-proxy.js",
);

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

function run(env) {
	return new Promise((resolve) => {
		execFile("node", [SCRIPT], { env }, (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

describe("start-proxy.js", () => {
	let home;
	before(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-home-"));
		fs.mkdirSync(path.join(home, ".claude"));
	});
	after(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	// The whole point of the script: on a first-run setup PROXY_PATH/PROXY_PORT
	// live ONLY in settings.json, not in the process env. The script must source
	// them from settings.json and spawn the right binary on the right port —
	// otherwise it returns missing-path / targets the wrong port.
	it("sources PROXY_PATH and PROXY_PORT from settings.json when absent from env", async () => {
		const port = await freePort();
		const flag = path.join(home, "spawned.txt");
		// Stand-in proxy: bind the port (so readiness passes) and record that it ran.
		const proxyBin = path.join(home, "standin-proxy.mjs");
		fs.writeFileSync(
			proxyBin,
			`import net from "node:net";
import fs from "node:fs";
const s = net.createServer();
s.listen(${port}, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(flag)}, String(process.pid));
});
`,
		);
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({
				env: { PROXY_PATH: proxyBin, PROXY_PORT: String(port), GLM_API_KEY: "k" },
			}),
		);

		// Critical: PROXY_PATH/PROXY_PORT are NOT in this env — only HOME points
		// at the settings.json that carries them.
		const childEnv = { PATH: process.env.PATH, HOME: home };
		const { stdout } = await run(childEnv);

		assert.match(stdout, /cc-proxy started/, `Expected started, got: ${stdout}`);
		for (let i = 0; i < 50 && !fs.existsSync(flag); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(fs.existsSync(flag), "stand-in proxy should have spawned on the settings.json port");
		try {
			process.kill(Number(fs.readFileSync(flag, "utf8")));
		} catch {
			// already gone
		}
	});

	it("reports missing-path when settings.json has no PROXY_PATH", async () => {
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { GLM_API_KEY: "k" } }),
		);
		const port = await freePort();
		const { code, stderr } = await run({
			PATH: process.env.PATH,
			HOME: home,
			PROXY_PORT: String(port),
		});
		assert.equal(code, 1);
		assert.match(stderr, /PROXY_PATH is unset/, `Expected missing-path message, got: ${stderr}`);
	});
});
