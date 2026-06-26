import { strict as assert } from "node:assert";
import http from "node:http";
import https from "node:https";
import { afterEach, describe, it } from "node:test";
import { httpAgent, httpsAgent, pickAgent, upstreamTimeoutMs } from "../src/agents.js";

describe("agents", () => {
	it("exposes keep-alive agents with bounded sockets", () => {
		assert.equal(httpAgent.keepAlive, true);
		assert.equal(httpsAgent.keepAlive, true);
		assert.equal(httpAgent.maxSockets, 128);
		assert.equal(httpsAgent.maxSockets, 128);
		assert.equal(httpAgent.maxFreeSockets, 16);
		assert.equal(httpsAgent.maxFreeSockets, 16);
	});

	it("pickAgent selects by protocol module identity", () => {
		assert.equal(pickAgent(https), httpsAgent);
		assert.equal(pickAgent(http), httpAgent);
	});

	describe("upstreamTimeoutMs", () => {
		afterEach(() => {
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
		});

		it("defaults to 120000 when unset", () => {
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
			assert.equal(upstreamTimeoutMs(), 120000);
		});

		it("defaults to 120000 when non-numeric or non-positive", () => {
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "nope";
			assert.equal(upstreamTimeoutMs(), 120000);
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "0";
			assert.equal(upstreamTimeoutMs(), 120000);
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "-5";
			assert.equal(upstreamTimeoutMs(), 120000);
		});

		it("honors a positive override", () => {
			process.env.PROXY_UPSTREAM_TIMEOUT_MS = "250";
			assert.equal(upstreamTimeoutMs(), 250);
		});
	});
});
