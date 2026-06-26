import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { load } from "../src/config.js";

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
