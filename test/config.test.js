import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOG_PATH } from "../hooks/proxy-lifecycle.js";
import { load } from "../src/config.js";
import { DEFAULT_CLAUDE_MODELS, DEFAULT_OPENROUTER_MODELS } from "../src/models.js";

describe("config load", () => {
	afterEach(() => {
		process.env.PROXY_HOST = "";
		process.env.PROXY_PORT = "";
	});

	it("defaults host to loopback", () => {
		process.env.PROXY_HOST = "";
		assert.equal(load().host, "127.0.0.1");
	});

	it("honors PROXY_HOST when set", () => {
		process.env.PROXY_HOST = "0.0.0.0";
		assert.equal(load().host, "0.0.0.0");
	});

	it("an explicit host override wins over env", () => {
		process.env.PROXY_HOST = "0.0.0.0";
		assert.equal(load({ host: "127.0.0.1" }).host, "127.0.0.1");
	});

	it("still returns port and providers", () => {
		process.env.PROXY_HOST = "";
		const cfg = load();
		assert.equal(typeof cfg.port, "number");
		assert.ok(Array.isArray(cfg.providers));
	});
});

describe("config models fields", () => {
	it("load() carries default claude + openrouter model lists and a 3000ms timeout", () => {
		const cfg = load();
		assert.deepEqual(cfg.claudeModels, DEFAULT_CLAUDE_MODELS);
		assert.deepEqual(cfg.openRouterModels, DEFAULT_OPENROUTER_MODELS);
		assert.equal(cfg.modelsTimeoutMs, 3000);
	});

	it("OPENROUTER_MODELS env overrides the openrouter allowlist wholesale", () => {
		const prev = process.env.OPENROUTER_MODELS;
		process.env.OPENROUTER_MODELS = "foo/bar, baz/qux";
		try {
			const cfg = load();
			assert.deepEqual(
				cfg.openRouterModels.map((m) => m.id),
				["foo/bar", "baz/qux"],
			);
		} finally {
			if (prev === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_MODELS");
			else process.env.OPENROUTER_MODELS = prev;
		}
	});
});

// The done-when for backlog item 5: the log and statusline-cache defaults must
// live under $HOME, not /tmp. /tmp is world-writable and its sticky bit only
// blocks deletion — another local user can pre-create the log as a symlink our
// O_APPEND follows, or plant a *_cache.json the statusline renders as this
// user's quota. Asserting the *shape* (homedir prefix, no /tmp) rather than the
// exact string keeps this from being a change-detector for the filename.
describe("predictable file defaults", () => {
	const home = os.homedir();

	it("the proxy log default lives under $HOME, not /tmp", () => {
		assert.ok(
			DEFAULT_LOG_PATH.startsWith(`${home}${path.sep}`),
			`DEFAULT_LOG_PATH must live under $HOME, got ${DEFAULT_LOG_PATH}`,
		);
		assert.ok(
			!DEFAULT_LOG_PATH.startsWith("/tmp"),
			`DEFAULT_LOG_PATH is in /tmp: ${DEFAULT_LOG_PATH}`,
		);
	});

	it("status.js reads back the same $HOME log default the hook writes to", () => {
		const src = fs.readFileSync(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/status.js"),
			"utf8",
		);
		assert.ok(
			!/PROXY_LOG \|\| "\/tmp/.test(src),
			"scripts/status.js still falls back to a /tmp log path",
		);
		assert.match(src, /os\.homedir\(\)/, "scripts/status.js log default must be homedir-based");
	});

	it("the statusline cache dir falls back under $HOME, not /tmp", () => {
		const src = fs.readFileSync(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/statusline.js"),
			"utf8",
		);
		const m = /CLAUDE_PLUGIN_DATA \|\|\s*([^;]+);/.exec(src);
		assert.ok(m, "could not locate the statusline cacheDir fallback — update this test");
		assert.ok(
			!m[1].includes("/tmp"),
			`statusline cacheDir still falls back to /tmp: ${m[1].trim()}`,
		);
		assert.match(m[1], /os\.homedir\(\)/, "statusline cacheDir fallback must be homedir-based");
	});
});
