import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	applyAuth,
	buildProviders,
	buildUpstreamHeaders,
	defaultProvider,
	providerById,
} from "../src/providers.js";

describe("buildProviders", () => {
	it("returns glm + claude, claude default by default", () => {
		const providers = buildProviders({});
		assert.deepEqual(
			providers.map((p) => p.id),
			["glm", "claude"],
		);
		assert.equal(defaultProvider({ providers }).id, "claude");
	});

	it("DEFAULT_BACKEND / defaultId selects the default provider", () => {
		const providers = buildProviders({}, "glm");
		assert.equal(defaultProvider({ providers }).id, "glm");
		assert.equal(providers.find((p) => p.id === "glm").isDefault, true);
	});

	it("glm carries apiKey auth and no quirks", () => {
		const glm = providerById({ providers: buildProviders({ GLM_API_KEY: "k" }) }, "glm");
		assert.equal(glm.apiKey, "k");
		assert.equal(glm.auth, "apiKey");
		assert.equal(glm.quirks, undefined);
	});

	it("claude is OAuth passthrough with no key", () => {
		const claude = providerById({ providers: buildProviders({}) }, "claude");
		assert.equal(claude.auth, "oauth");
		assert.equal(claude.apiKey, "");
		assert.equal(claude.quirks, undefined);
	});

	it("omits OpenRouter unless OPENROUTER_API_KEY is set", () => {
		assert.equal(
			buildProviders({}).some((p) => p.id === "openrouter"),
			false,
		);
	});

	it("registers OpenRouter (bearer, no quirks) when its key is set", () => {
		const providers = buildProviders({ OPENROUTER_API_KEY: "or-key" });
		const or = providers.find((p) => p.id === "openrouter");
		assert.ok(or, "openrouter provider present");
		assert.equal(or.auth, "bearer");
		assert.equal(or.apiKey, "or-key");
		assert.equal(or.baseUrl, "https://openrouter.ai/api");
		assert.equal(or.quirks, undefined);
		// claude stays last / default.
		assert.equal(providers[providers.length - 1].id, "claude");
	});

	it("OpenRouter matches slash-namespaced model ids only", () => {
		const or = buildProviders({ OPENROUTER_API_KEY: "k" }).find((p) => p.id === "openrouter");
		assert.equal(or.match("anthropic/claude-opus-4"), true);
		assert.equal(or.match("z-ai/glm-4.7"), true);
		assert.equal(or.match("glm-5.2"), false);
		assert.equal(or.match("claude-opus-4-6"), false);
		assert.equal(or.match(undefined), false);
	});

	it("match predicates key off the model prefix", () => {
		const providers = buildProviders({});
		const glm = providers.find((p) => p.id === "glm");
		const claude = providers.find((p) => p.id === "claude");
		assert.equal(glm.match("glm-5.2"), true);
		assert.equal(glm.match("glm-5.2[1m]"), true);
		assert.equal(glm.match("claude-opus-4-6"), false);
		assert.equal(glm.match(undefined), false);
		assert.equal(claude.match("claude-haiku-4-6"), true);
		assert.equal(claude.match("glm-5.2"), false);
	});
});

describe("applyAuth", () => {
	it("oauth passes the inbound Authorization header through untouched", () => {
		const h = applyAuth({ authorization: "Bearer oauth", "x-keep": "1" }, { auth: "oauth" });
		assert.equal(h.authorization, "Bearer oauth");
		assert.equal(h["x-keep"], "1");
	});

	it("apiKey drops Authorization and sets x-api-key", () => {
		const h = applyAuth({ authorization: "Bearer oauth" }, { auth: "apiKey", apiKey: "k" });
		assert.equal(h.authorization, undefined);
		assert.equal(h["x-api-key"], "k");
	});

	it("bearer drops the inbound Authorization and sets a Bearer token", () => {
		const h = applyAuth({ authorization: "Bearer oauth" }, { auth: "bearer", apiKey: "or-key" });
		assert.equal(h.authorization, "Bearer or-key");
		assert.equal(h["x-api-key"], undefined);
	});

	it("does not mutate the source headers", () => {
		const src = { authorization: "Bearer oauth" };
		applyAuth(src, { auth: "apiKey", apiKey: "k" });
		assert.equal(src.authorization, "Bearer oauth");
		assert.equal(src["x-api-key"], undefined);
	});
});

describe("buildUpstreamHeaders", () => {
	it("applies auth and sets host / anthropic-version / content-length", () => {
		const h = buildUpstreamHeaders(
			{ auth: "apiKey", apiKey: "k" },
			{ authorization: "drop", "content-type": "application/json" },
			42,
			"api.z.ai",
		);
		assert.equal(h["x-api-key"], "k");
		assert.equal(h.authorization, undefined);
		assert.equal(h.host, "api.z.ai");
		assert.equal(h["anthropic-version"], "2023-06-01");
		assert.equal(h["content-length"], "42");
		assert.equal(h["content-type"], "application/json");
	});

	it("preserves an explicit anthropic-version", () => {
		const h = buildUpstreamHeaders(
			{ auth: "oauth" },
			{ "anthropic-version": "2099-01-01" },
			1,
			"api.anthropic.com",
		);
		assert.equal(h["anthropic-version"], "2099-01-01");
	});
});
