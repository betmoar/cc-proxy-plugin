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

	it("omits DeepSeek unless DEEPSEEK_API_KEY is set", () => {
		assert.equal(
			buildProviders({}).some((p) => p.id === "deepseek"),
			false,
		);
	});

	it("registers DeepSeek (apiKey, no quirks) when its key is set", () => {
		const providers = buildProviders({ DEEPSEEK_API_KEY: "ds-key" });
		const ds = providers.find((p) => p.id === "deepseek");
		assert.ok(ds, "deepseek provider present");
		assert.equal(ds.auth, "apiKey");
		assert.equal(ds.apiKey, "ds-key");
		assert.equal(ds.baseUrl, "https://api.deepseek.com/anthropic");
		assert.equal(ds.quirks, undefined);
		// claude stays last / default.
		assert.equal(providers[providers.length - 1].id, "claude");
	});

	// COLLISION-LOCK: DeepSeek's bare ids (no slash) must never match OpenRouter's
	// slash-namespaced space. OpenRouter already advertises `deepseek/deepseek-v4-pro`;
	// the bare `deepseek-v4-pro` belongs to the native DeepSeek provider. The two
	// match() predicates are disjoint by construction — this pins it.
	it("DeepSeek matches bare deepseek- ids, never slash-namespaced ones", () => {
		const ds = buildProviders({ DEEPSEEK_API_KEY: "k" }).find((p) => p.id === "deepseek");
		assert.equal(ds.match("deepseek-v4-pro"), true);
		assert.equal(ds.match("deepseek-v4-flash"), true);
		assert.equal(ds.match("deepseek/deepseek-v4-pro"), false, "slash id belongs to OpenRouter");
		assert.equal(ds.match("glm-5.2"), false);
		assert.equal(ds.match("claude-opus-4-6"), false);
		assert.equal(ds.match(undefined), false);
	});

	it("DeepSeek sits before claude and after openrouter in registry order", () => {
		const ids = buildProviders({
			OPENROUTER_API_KEY: "or",
			DEEPSEEK_API_KEY: "ds",
		}).map((p) => p.id);
		assert.deepEqual(ids, ["glm", "openrouter", "deepseek", "claude"]);
	});

	it("omits Qwen unless DASHSCOPE_API_KEY is set", () => {
		assert.equal(
			buildProviders({}).some((p) => p.id === "qwen"),
			false,
		);
	});

	it("registers Qwen (bearer, no quirks) when its key is set", () => {
		const providers = buildProviders({ DASHSCOPE_API_KEY: "qwen-key" });
		const qwen = providers.find((p) => p.id === "qwen");
		assert.ok(qwen, "qwen provider present");
		assert.equal(qwen.auth, "bearer");
		assert.equal(qwen.apiKey, "qwen-key");
		assert.equal(
			qwen.baseUrl,
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
		);
		assert.equal(qwen.quirks, undefined);
		// claude stays last / default.
		assert.equal(providers[providers.length - 1].id, "claude");
	});

	// COLLISION-LOCK: Qwen's bare ids start with `qwen` (no dash after — ids are
	// `qwen3.7-max`, not `qwen-3.7-max`), so the prefix match is `qwen`. That is
	// disjoint from glm-, deepseek-, claude-, and OpenRouter's vendor/model slash
	// ids. A QwenCloud subscription advertises glm-5.2 and deepseek-v4-* too, but
	// those bare ids stay routed to their native backends by this disjoint match.
	it("Qwen matches ids starting with `qwen` (no dash), never other prefixes or slash ids", () => {
		const qwen = buildProviders({ DASHSCOPE_API_KEY: "k" }).find((p) => p.id === "qwen");
		assert.equal(qwen.match("qwen3.7-max"), true);
		assert.equal(qwen.match("qwen3.6-flash"), true);
		assert.equal(qwen.match("qwen3.8-max"), true);
		assert.equal(qwen.match("glm-5.2"), false);
		assert.equal(qwen.match("deepseek-v4-pro"), false);
		assert.equal(qwen.match("claude-opus-4-6"), false);
		assert.equal(qwen.match("qwen/qwen3.7-max"), false, "slash id belongs to OpenRouter");
		assert.equal(qwen.match(undefined), false);
	});

	it("Qwen sits before claude and after deepseek in registry order", () => {
		const ids = buildProviders({
			OPENROUTER_API_KEY: "or",
			DEEPSEEK_API_KEY: "ds",
			DASHSCOPE_API_KEY: "qwen",
		}).map((p) => p.id);
		assert.deepEqual(ids, ["glm", "openrouter", "deepseek", "qwen", "claude"]);
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

	// INVARIANT (credential isolation): the user's Anthropic credentials —
	// Authorization (OAuth) and x-api-key (ANTHROPIC_API_KEY auth) — must never
	// reach a third-party backend.
	it("apiKey drops an inbound x-api-key (replaced by the provider's own)", () => {
		const h = applyAuth(
			{ authorization: "Bearer oauth", "x-api-key": "users-anthropic-key" },
			{ auth: "apiKey", apiKey: "glm-key" },
		);
		assert.equal(h["x-api-key"], "glm-key");
		assert.equal(h.authorization, undefined);
	});

	it("bearer drops an inbound x-api-key (must not leak to OpenRouter)", () => {
		const h = applyAuth(
			{ authorization: "Bearer oauth", "x-api-key": "users-anthropic-key" },
			{ auth: "bearer", apiKey: "or-key" },
		);
		assert.equal(h["x-api-key"], undefined);
		assert.equal(h.authorization, "Bearer or-key");
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

	// INVARIANT (transparent pipe, hop-by-hop exception): the proxy always sends
	// a fully-buffered body with an exact content-length, so inbound hop-by-hop
	// headers — above all Transfer-Encoding — must never reach the upstream.
	// Forwarding transfer-encoding alongside content-length trips upstream
	// request-smuggling protections (bare 400 before any handler runs).
	it("drops inbound hop-by-hop headers (transfer-encoding et al.)", () => {
		const h = buildUpstreamHeaders(
			{ auth: "oauth" },
			{
				"transfer-encoding": "chunked",
				connection: "keep-alive",
				"keep-alive": "timeout=5",
				te: "trailers",
				trailer: "x-checksum",
				upgrade: "h2c",
				"proxy-authorization": "Basic xxx",
				"proxy-authenticate": "Basic",
				"content-type": "application/json",
			},
			42,
			"api.anthropic.com",
		);
		for (const dropped of [
			"transfer-encoding",
			"connection",
			"keep-alive",
			"te",
			"trailer",
			"upgrade",
			"proxy-authorization",
			"proxy-authenticate",
		]) {
			assert.equal(h[dropped], undefined, `${dropped} must not be forwarded`);
		}
		assert.equal(h["content-type"], "application/json", "end-to-end headers survive");
		assert.equal(h["content-length"], "42");
	});
});
