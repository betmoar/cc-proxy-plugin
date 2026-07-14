import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
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
			if (prev === undefined) process.env.OPENROUTER_MODELS = undefined;
			else process.env.OPENROUTER_MODELS = prev;
		}
	});
});
