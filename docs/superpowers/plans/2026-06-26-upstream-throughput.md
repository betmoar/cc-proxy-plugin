# Upstream Throughput & Loopback Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single shared proxy process handle concurrent multi-session load with lower per-request latency, bounded socket usage, and no LAN credential exposure.

**Architecture:** The proxy is one stateless process all Claude Code sessions share on `:4000`. Three transport-layer changes, no behavior change to routing or overflow handling: (1) shared keep-alive HTTP/HTTPS agents so upstream calls reuse TLS connections instead of handshaking every time; (2) an upstream socket-inactivity timeout so a hung upstream can't leak a socket for the life of the long-running proxy; (3) bind the listener to loopback so the credential-injecting proxy isn't reachable from the LAN. Items 1 and 2 are wired into both forwarding paths (streaming pipe in `src/proxy.js`, buffered path in `src/server.js`) from one shared module.

**Tech Stack:** Node.js ≥22 (`node:http`, `node:https`, `node:net`), zero runtime dependencies, `// @ts-check` + JSDoc, `node --test` test runner, Biome lint/format.

## Global Constraints

- **Node `>=22.0.0`** — verified runtime is `v22.21.1`. Use only built-ins (`node:http`, `node:https`, `node:net`); **zero new runtime dependencies** (a load-bearing invariant in `docs/ARCHITECTURE.md` — no LiteLLM/undici/external HTTP client).
- **`// @ts-check` at the top of every `.js` source file**, JSDoc on exported functions. Match the existing style in `src/`.
- **No behavior change to routing, auth, overflow conversion, or thinking-strip.** These changes are transport/binding only. The five `ARCHITECTURE.md` invariants (transparent pipe, stateless, OAuth passthrough, `claude-haiku-*` pin, Anthropic-Messages-only) must still hold.
- **Tests use `node --test`** with `import { strict as assert } from "node:assert"` and the local `startBackend`/`startProxy`/`post` harness pattern already in `test/server.test.js`. No test framework dependency.
- **Lint/format with Biome**: every task ends green on `pnpm lint`.
- **Baseline before any change: 60 pass / 1 fail.** The one pre-existing failure is `test/statusline.test.js › "shows OpenRouter credits when key is set"` — it makes a live network call and reads real OpenRouter credits (`$11.49`) instead of the mocked value. It is unrelated to every file this plan touches. Because this plan **adds** tests, the pass count rises as you go; "no regressions" therefore means the *failure set never grows* — `# fail` stays `1` and the only `not ok` remains that statusline test (gated per task via `grep "not ok" | grep -v "shows OpenRouter credits"` returning no output), **not** a fixed pass total. Do not attempt to fix the statusline test here.

---

### Task 1: Shared keep-alive agents + upstream timeout module

**Files:**
- Create: `src/agents.js`
- Test: `test/agents.test.js`

**Interfaces:**
- Consumes: nothing (leaf module over `node:http`/`node:https`).
- Produces:
  - `httpAgent: http.Agent` and `httpsAgent: https.Agent` — shared keep-alive agents (`keepAlive: true`, `maxSockets: 128`, `maxFreeSockets: 16`).
  - `pickAgent(proto: typeof http | typeof https) => http.Agent | https.Agent` — returns `httpsAgent` when `proto === https`, else `httpAgent`.
  - `upstreamTimeoutMs() => number` — reads `PROXY_UPSTREAM_TIMEOUT_MS` at call time; returns it when it parses to a finite number `> 0`, else `120000`. (Read at call time, not module load, so tests and live config changes take effect without re-import.)

- [ ] **Step 1: Write the failing test**

Create `test/agents.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agents.test.js`
Expected: FAIL — `Cannot find module '.../src/agents.js'` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/agents.js`:

```js
// @ts-check
import http from "node:http";
import https from "node:https";

// Shared, explicitly-bounded agents for all upstream calls. Node >=19 already
// defaults globalAgent to keepAlive:true, so connection reuse is NOT what this
// buys — the real value is a BOUNDED pool: maxSockets caps concurrent upstream
// connections (globalAgent's default is Infinity) so heavy parallel subagent
// fan-out can't exhaust file descriptors, and owning the agent means the proxy
// doesn't depend on a runtime default that could change. maxFreeSockets bounds
// the idle pool. (The genuinely-new throughput behavior in this plan is the
// per-request inactivity timeout below, which globalAgent does not provide.)
const KEEP_ALIVE = { keepAlive: true, maxSockets: 128, maxFreeSockets: 16 };

export const httpAgent = new http.Agent(KEEP_ALIVE);
export const httpsAgent = new https.Agent(KEEP_ALIVE);

/**
 * Select the shared agent matching a request's protocol module. Callers compute
 * `proto = url.protocol === "https:" ? https : http`; module identity is stable
 * (Node caches module instances), so identity comparison is safe.
 * @param {typeof http | typeof https} proto
 * @returns {http.Agent}
 */
export function pickAgent(proto) {
	return proto === https ? httpsAgent : httpAgent;
}

/**
 * Socket-inactivity timeout (ms) for upstream requests. Generous by default: a
 * cold, large-context (1M) LLM call can take tens of seconds to first byte, and
 * this is an inactivity timeout (it resets as bytes flow), so streaming token
 * gaps are fine. Read at call time so an env change takes effect without
 * re-import. PROXY_UPSTREAM_TIMEOUT_MS overrides; non-numeric / non-positive
 * values fall back to the default.
 * @returns {number}
 */
export function upstreamTimeoutMs() {
	const v = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 120000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/agents.test.js`
Expected: PASS — all subtests green.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors (Biome may reformat; if it reports fixable issues run `pnpm lint:fix` then re-run `pnpm lint`).

- [ ] **Step 6: Commit**

```bash
git add src/agents.js test/agents.test.js
git commit -m "feat: shared keep-alive upstream agents + timeout helper"
```

---

### Task 2: Wire agents + timeout into the streaming path (`src/proxy.js`)

**Files:**
- Modify: `src/proxy.js:16-50` (the `forward` function)
- Test: `test/server.test.js` (add a streaming-path shared-agent test AND a streaming-path inactivity-timeout test to the existing e2e suite — `forward` is exercised through `createServer`)

**Interfaces:**
- Consumes: `pickAgent`, `upstreamTimeoutMs` from `src/agents.js` (Task 1).
- Produces: no new exports. `forward`'s signature is unchanged; it now attaches a shared agent and an inactivity timeout to the upstream request.

- [ ] **Step 1: Write the failing tests**

Add **both** of these tests inside the `describe("server end-to-end routing", ...)` block in `test/server.test.js`, after the existing `"streaming glm passes straight through"` test. The first proves the streaming path routes through OUR explicit shared agent (not Node's globalAgent). The second proves the streaming path's inactivity timeout: a `stream: true` request to a black-hole upstream that never responds is surfaced as a prompt 502, not left hanging with a pinned socket. (The streaming path lives in `src/proxy.js`, separate code from the buffered path in `src/server.js` — it needs its own timeout test or a miswired/omitted timeout there ships silently.)

**Why not a connection-count test:** Node ≥19 defaults `http.globalAgent` to `keepAlive: true`, so asserting "two requests reuse one upstream connection" passes *with or without* our `agent: pickAgent(proto)` wiring — a non-discriminating test that gives no regression signal. Instead, assert on the **imported `httpAgent` singleton**: after a streaming request through the proxy, our agent holds exactly one free socket. Remove the `agent:` wiring and traffic falls to globalAgent, leaving our agent empty — the test fails. That is a true discriminator (verified: 20/20 deterministic on Node 22). Two requirements make it reliable: (a) add `import { httpAgent } from "../src/agents.js";` to the test file's imports; (b) call `httpAgent.destroy()` at the start of the test to clear sockets pooled by earlier tests — `httpAgent` is a process-wide singleton and `afterEach` does not reset it, so without this a leftover free socket pollutes the count.

The timeout test carries an explicit per-test `{ timeout: 5000 }` so that in Step 2 — run before the timeout is wired — it fails by hitting that ceiling instead of hanging the whole suite forever against the silent upstream.

```js
	it("streaming path routes through the shared keep-alive agent", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		}));
		httpAgent.destroy(); // clear sockets pooled by earlier tests (shared singleton)
		await post(proxy.port, {
			model: "glm-5.2",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		await new Promise((r) => setImmediate(r)); // let the socket return to the pool
		const free = Object.values(httpAgent.freeSockets).reduce((n, a) => n + a.length, 0);
		assert.equal(free, 1, "upstream socket landed in our shared agent, not Node's globalAgent");
	});

	it("streaming upstream that never responds is timed out as a 502", { timeout: 5000 }, async () => {
		const saved = process.env.PROXY_UPSTREAM_TIMEOUT_MS;
		process.env.PROXY_UPSTREAM_TIMEOUT_MS = "200";
		// Black-hole upstream: accepts the request, never responds.
		const silent = http.createServer(() => {});
		await new Promise((r) => silent.listen(0, "127.0.0.1", r));
		const silentPort = /** @type {any} */ (silent.address()).port;
		try {
			claude = await startBackend(() => ({
				status: 200,
				headers: { "content-type": "application/json" },
				body: NORMAL_200,
			}));
			const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
			providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${silentPort}`;
			providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
			proxy = await startProxy({ port: 0, providers });

			const start = Date.now();
			const res = await post(proxy.port, {
				model: "glm-5.2",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});
			const elapsed = Date.now() - start;
			assert.equal(res.status, 502);
			assert.ok(elapsed < 2000, `timed out promptly, elapsed=${elapsed}ms`);
		} finally {
			await close(silent);
			if (saved === undefined) process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
			else process.env.PROXY_UPSTREAM_TIMEOUT_MS = saved;
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: BOTH new tests FAIL — the shared-agent test asserts `free === 1` but our agent is empty (the streaming path still uses globalAgent, so `httpAgent.freeSockets` has nothing), giving `0 !== 1`; the streaming-timeout test hits its `{ timeout: 5000 }` ceiling and fails (no upstream timeout wired, so the request to the silent upstream never returns). The other server tests still pass.

Also confirm the new test-file import is present (add it if your harness doesn't have it yet): at the top of `test/server.test.js`, alongside the existing imports, `import { httpAgent } from "../src/agents.js";`.

- [ ] **Step 3: Write minimal implementation**

In `src/proxy.js`, add the import below the existing `node:https` import:

```js
import { pickAgent, upstreamTimeoutMs } from "./agents.js";
```

Then change the `options` object and the `upstream` request handling in `forward`. Replace the existing block (the `const options = {...}` through `upstream.write(...)`) with:

```js
	const options = {
		hostname: url.hostname,
		port: url.port || (url.protocol === "https:" ? 443 : 80),
		path: url.pathname,
		method: clientReq.method,
		headers,
		agent: pickAgent(proto),
		timeout: upstreamTimeoutMs(),
	};

	const upstream = proto.request(options, (upstreamRes) => {
		clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
		upstreamRes.on("error", () => clientRes.destroy());
		upstreamRes.pipe(clientRes);
	});

	// Inactivity timeout: a stalled upstream would otherwise pin a socket for the
	// life of the long-running proxy. Destroying with an error routes into the
	// handler below (502 if nothing was sent yet; otherwise the stream just ends).
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));

	upstream.on("error", (err) => {
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		}
	});

	upstream.write(bodyBuffer);
	upstream.end();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS — the shared-agent test now sees `free === 1` (the upstream socket landed in our `httpAgent`); the streaming-timeout test returns `502` in well under 2s (and well under its 5s ceiling); all previously-passing server tests stay green.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proxy.js test/server.test.js
git commit -m "feat: keep-alive + inactivity timeout on streaming forward path"
```

---

### Task 3: Wire agents + timeout into the buffered path (`src/server.js`)

**Files:**
- Modify: `src/server.js:40-58` (the `upstreamRequestOptions` helper) and `src/server.js:77-122` (`forwardBuffered`, to attach the timeout listener)
- Test: `test/server.test.js` (add a non-streaming shared-agent test and an upstream-timeout test)

**Interfaces:**
- Consumes: `pickAgent`, `upstreamTimeoutMs` from `src/agents.js` (Task 1).
- Produces: no new exports. `upstreamRequestOptions` now includes `agent` and `timeout` in its returned `options`; `forwardBuffered` destroys the upstream on inactivity timeout.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the `describe("server end-to-end routing", ...)` block in `test/server.test.js`. The first proves the buffered (non-streaming) path routes through OUR shared agent — same discriminating design and rationale as the streaming version in Task 2 (assert on the imported `httpAgent` singleton, `httpAgent.destroy()` first to clear cross-test pollution; a connection-count test would be non-discriminating because Node ≥19 globalAgent already pools). It assumes `import { httpAgent } from "../src/agents.js";` is already in the test file's imports from Task 2. The second proves the inactivity timeout converts a black-hole upstream into a 502 quickly; it builds its own silent upstream rather than using `wire()` (whose `startBackend` always sends a response), and carries an explicit `{ timeout: 5000 }` so the Step 2 pre-implementation run fails by hitting that ceiling rather than hanging the suite.

```js
	it("buffered path routes through the shared keep-alive agent", async () => {
		await wire(() => ({
			status: 200,
			headers: { "content-type": "application/json" },
			body: NORMAL_200,
		}));
		httpAgent.destroy(); // clear sockets pooled by earlier tests (shared singleton)
		await post(proxy.port, {
			model: "glm-5.2",
			stream: false,
			messages: [{ role: "user", content: "hi" }],
		});
		await new Promise((r) => setImmediate(r)); // let the socket return to the pool
		const free = Object.values(httpAgent.freeSockets).reduce((n, a) => n + a.length, 0);
		assert.equal(free, 1, "upstream socket landed in our shared agent, not Node's globalAgent");
	});

	it("non-stream upstream that never responds is timed out as a 502", { timeout: 5000 }, async () => {
		const saved = process.env.PROXY_UPSTREAM_TIMEOUT_MS;
		process.env.PROXY_UPSTREAM_TIMEOUT_MS = "200";
		// Black-hole upstream: accepts the request, never responds.
		const silent = http.createServer(() => {});
		await new Promise((r) => silent.listen(0, "127.0.0.1", r));
		const silentPort = /** @type {any} */ (silent.address()).port;
		try {
			claude = await startBackend(() => ({
				status: 200,
				headers: { "content-type": "application/json" },
				body: NORMAL_200,
			}));
			const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
			providers.find((p) => p.id === "glm").baseUrl = `http://127.0.0.1:${silentPort}`;
			providers.find((p) => p.id === "claude").baseUrl = claude.baseUrl;
			proxy = await startProxy({ port: 0, providers });

			const start = Date.now();
			const res = await post(proxy.port, {
				model: "glm-5.2",
				stream: false,
				messages: [{ role: "user", content: "hi" }],
			});
			const elapsed = Date.now() - start;
			assert.equal(res.status, 502);
			assert.ok(elapsed < 2000, `timed out promptly, elapsed=${elapsed}ms`);
		} finally {
			await close(silent);
			if (saved === undefined) process.env.PROXY_UPSTREAM_TIMEOUT_MS = "";
			else process.env.PROXY_UPSTREAM_TIMEOUT_MS = saved;
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: BOTH new tests FAIL — the shared-agent test asserts `free === 1` but the buffered path still uses globalAgent, so `httpAgent.freeSockets` is empty (`0 !== 1`); the timeout test hits its `{ timeout: 5000 }` ceiling and fails (no upstream timeout wired, so the request to the silent upstream never returns). Confirm both new tests fail for these reasons.

- [ ] **Step 3: Write minimal implementation**

In `src/server.js`, add the import after the existing local imports (below the `./sanitize.js` import):

```js
import { pickAgent, upstreamTimeoutMs } from "./agents.js";
```

Replace the `upstreamRequestOptions` function body's returned `options` to include `agent` and `timeout`:

```js
function upstreamRequestOptions(clientReq, provider, outboundBuffer) {
	const url = new URL(provider.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;
	return {
		proto,
		options: {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname,
			method: clientReq.method,
			headers: buildUpstreamHeaders(
				provider,
				clientReq.headers,
				outboundBuffer.length,
				url.hostname,
			),
			agent: pickAgent(proto),
			timeout: upstreamTimeoutMs(),
		},
	};
}
```

In `forwardBuffered`, add a `timeout` listener on `upstream` right before the existing `upstream.on("error", onUpstreamError(clientRes));` line:

```js
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
	upstream.on("error", onUpstreamError(clientRes));
```

(The existing `onUpstreamError(clientRes)` sends a 502 when headers haven't been sent — which is exactly the black-hole case, so the timeout-destroy surfaces as a 502.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS — shared-agent test sees `free === 1`; timeout test returns `502` in well under 2s; all previously-passing server tests stay green.

- [ ] **Step 5: Run the whole suite + lint**

Run: `node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`

Gate (name-based, not a hard total — see "Baseline integrity" below):
- The new tests from Tasks 1–3 are all present and passing: in `test/agents.test.js` (the `agents` suite) and the four new `test/server.test.js` cases — `streaming path routes through the shared keep-alive agent`, `streaming upstream that never responds is timed out as a 502`, `buffered path routes through the shared keep-alive agent`, and `non-stream upstream that never responds is timed out as a 502`.
- The `# fail` line shows exactly **1**, and the only failing test is `test/statusline.test.js › "shows OpenRouter credits when key is set"` (the pre-existing live-network test).

To confirm the failing test is the expected one (and nothing new joined it):

Run: `node --test test/*.test.js 2>&1 | grep "not ok" | grep -v "shows OpenRouter credits"`
Expected: **no output** (the OpenRouter-credits failure is the only `not ok`; any other line printed here is a regression you introduced — stop and fix it).

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: keep-alive + inactivity timeout on buffered forward path"
```

---

### Task 4: Bind the listener to loopback by default

**Files:**
- Modify: `src/config.js:18-24` (`load` — add `host` to the returned config)
- Modify: `bin/cc-proxy.js:35-41` (pass `config.host` to `server.listen`)
- Create: `test/config.test.js`
- Modify: `.env.example` (document `PROXY_HOST`)
- Modify: `README.md` (env-vars table + a troubleshooting line)
- Modify: `docs/ARCHITECTURE.md` (note loopback binding under Design decisions)
- Modify: `skills/setup/SKILL.md:44` (change the written `ANTHROPIC_BASE_URL` from `localhost` to `127.0.0.1` — see "Why", item 2)

**Interfaces:**
- Consumes: nothing new.
- Produces: `load()` now returns `{ port, host, providers }`. `host` defaults to `process.env.PROXY_HOST || "127.0.0.1"`; an explicit `overrides.host` wins. `bin/cc-proxy.js` listens on `config.host`.

**Why (two coupled changes):**
1. **The bind.** `bin/cc-proxy.js` currently calls `server.listen(config.port, ...)` with no host, so Node binds all interfaces. This proxy injects GLM/OpenRouter API keys and forwards Claude OAuth — on an all-interfaces bind, any host on the LAN that reaches `:4000` uses your credentials. Loopback-only closes that. `PROXY_HOST` stays as an explicit opt-out for anyone who deliberately wants a non-loopback bind.
2. **The client target.** `skills/setup/SKILL.md:44` writes `ANTHROPIC_BASE_URL=http://localhost:4000`. On IPv6-first hosts `localhost` resolves to `::1` before `127.0.0.1` (confirmed: `dns.lookup("localhost", {verbatim:true})` returns `::1` first on this machine). A `127.0.0.1`-only bind does NOT accept `::1`. Node ≥20's happy-eyeballs (`autoSelectFamily`) currently rescues this — it tries `::1`, gets an instant ECONNREFUSED, and falls back to `127.0.0.1`, so the connection still succeeds (verified on Node 22). But that rescue lives in the *client* HTTP stack (Claude Code's), which we don't control and shouldn't depend on. Aligning the written literal to `127.0.0.1` removes the dependency entirely. This is the headline path (`/cc-proxy:setup` → proxy up → CC connects), so it must not rest on an unowned fallback.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `load().host` is `undefined` (config does not return `host` yet).

- [ ] **Step 3: Write minimal implementation**

In `src/config.js`, update the `@typedef` and `load` to include `host`:

```js
/**
 * @typedef {import("./providers.js").Provider} Provider
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host - interface the server binds to (loopback by default).
 * @property {Provider[]} providers - the routing registry (see providers.js).
 */

/**
 * Load config from env vars. Claude auth is OAuth passthrough so no Claude key
 * is loaded; the provider registry carries each backend's auth strategy.
 *
 * @param {object} [overrides]
 * @returns {Config}
 */
export function load(overrides = {}) {
	const defaultId = overrides.defaultBackend || process.env.DEFAULT_BACKEND || "claude";
	return {
		port: Number(overrides.port || process.env.PROXY_PORT || 4000),
		// Loopback by default: the proxy injects API keys and forwards OAuth, so it
		// must not be reachable from the LAN. PROXY_HOST is an explicit opt-out.
		host: overrides.host || process.env.PROXY_HOST || "127.0.0.1",
		providers: buildProviders(process.env, defaultId),
	};
}
```

In `bin/cc-proxy.js`, pass the host to `listen` and log it. Replace the `server.listen` block:

```js
const server = createServer(config);
server.listen(config.port, config.host, () => {
	console.log(`cc-proxy listening on http://${config.host}:${config.port}`);
	for (const p of config.providers) {
		console.log(`  ${p.id.padEnd(6)} -> ${p.baseUrl}  [auth: ${p.auth}]`);
	}
	console.log(`  default: ${defaultProvider(config).id}`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS — all four subtests green.

- [ ] **Step 5: Update docs and the setup template**

In `skills/setup/SKILL.md`, change the `ANTHROPIC_BASE_URL` value in the settings.json merge block (currently line 44) from `http://localhost:4000` to `http://127.0.0.1:4000`:

```json
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
```

(This matches the loopback bind exactly and removes the dependency on client-side happy-eyeballs fallback — see "Why", item 2. Existing users who already ran setup keep `localhost`, which still works on Node ≥20; the README troubleshooting line below covers the rare host where it doesn't.)

In `.env.example`, under the `# --- Proxy ---` section, add below the `PROXY_PORT` line:

```
# Interface the proxy binds to. Loopback by default so the credential-injecting
# proxy isn't reachable from the LAN. Set to 0.0.0.0 only if you deliberately
# need off-host access.
PROXY_HOST=127.0.0.1
```

Also in `.env.example`, under the `# --- Proxy ---` section, add below the new `PROXY_HOST` line (documents the knob introduced in Task 1, which is otherwise undocumented):

```
# Socket-inactivity timeout (ms) for upstream requests. Resets as bytes flow, so
# streaming token gaps are fine; it bounds a fully-stalled upstream. Default
# 120000. Raise it if you drive very large (1M-context) cold GLM calls whose
# time-to-first-byte can exceed two minutes.
PROXY_UPSTREAM_TIMEOUT_MS=120000
```

In `README.md`, in the "Environment variables" table, add these two rows immediately after the `PROXY_PORT` row:

```
| `PROXY_HOST` | `127.0.0.1` | Interface the proxy binds to (loopback by default) |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream socket-inactivity timeout; raise for 1M-context cold calls |
```

In `README.md`, in the "Troubleshooting" section, add this bullet after the existing `proxy down` bullet:

```
- **`ECONNREFUSED` to `:4000` on an IPv6-first host** — `localhost` may resolve to `::1` first while the proxy binds `127.0.0.1`. New setups write `127.0.0.1` directly; if you have an older `ANTHROPIC_BASE_URL=http://localhost:4000`, change it to `http://127.0.0.1:4000`, or set `PROXY_HOST=0.0.0.0` to bind all interfaces.
```

In `docs/ARCHITECTURE.md`, under "## Design decisions", add a subsection after "### Local, not hosted":

```markdown
### Loopback binding

The proxy listens on `127.0.0.1` by default. It injects GLM/OpenRouter API keys
and forwards Claude OAuth, so a request that reaches it is authenticated as you;
an all-interfaces bind would let any host on the LAN spend your quota. `PROXY_HOST`
is an explicit opt-out for the rare deliberate off-host setup. The setup template
writes `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` (not `localhost`) so the client
target matches the bind exactly rather than relying on IPv6→IPv4 fallback.
```

- [ ] **Step 6: Run the whole suite + lint**

Run: `node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`

Gate (name-based, not a hard total):
- The four new `test/config.test.js` cases are present and passing: `defaults host to loopback`, `honors PROXY_HOST when set`, `an explicit host override wins over env`, `still returns port and providers`.
- The `# fail` line shows exactly **1**.

Run: `node --test test/*.test.js 2>&1 | grep "not ok" | grep -v "shows OpenRouter credits"`
Expected: **no output** — the only `not ok` is the pre-existing `test/statusline.test.js › "shows OpenRouter credits when key is set"`. Any other line is a regression you introduced; stop and fix it.

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.js bin/cc-proxy.js test/config.test.js .env.example README.md docs/ARCHITECTURE.md skills/setup/SKILL.md
git commit -m "feat: bind proxy to loopback by default (PROXY_HOST opt-out)"
```

---

## Self-Review

**Spec coverage** (the three Tier-1 items from the discussion):
1. Keep-alive agents → Task 1 (module) + Task 2 (streaming path) + Task 3 (buffered path). ✓ Both forwarding call sites covered.
2. Upstream socket timeout → Task 1 (`upstreamTimeoutMs`) + Task 2 + Task 3 (`'timeout'` → `destroy`). ✓ Both paths, with a fast black-hole test in Task 3.
3. Loopback bind → Task 4. ✓ With config test + docs.

**Type/name consistency:** `pickAgent` and `upstreamTimeoutMs` are defined in Task 1 and consumed verbatim in Tasks 2–3. `httpAgent`/`httpsAgent` names match across module and test. `config.host` defined in Task 4's `load()` and consumed in `bin/cc-proxy.js` Task 4. `startBackend`/`startProxy`/`post`/`close`/`wire`/`NORMAL_200`/`OVERFLOW_200` are existing helpers in `test/server.test.js` reused as-is.

**Placeholder scan:** No TBD/TODO/"handle errors"; every code step shows complete code. Each timeout test (Task 2 and Task 3) appears exactly once — no superseded drafts an implementer could paste by mistake.

**Baseline integrity:** Every "run the suite" step gates on two things — the new test *names* for that task are present and passing, and the `not ok` filter (`grep "not ok" | grep -v "shows OpenRouter credits"`) prints nothing, so the only failure stays the pre-existing live-network `statusline › "shows OpenRouter credits when key is set"` test. Deliberately **not** a hard pass-count total: the per-task test additions don't sum to a memorable round number (Task 1 adds ~6 agents subtests, Tasks 2–3 add four server tests, Task 4 adds four config tests), and a wrong total is worse than none — an implementer matching "62" could accept a silently-missing test as long as the statusline name still failed. The name-based gate catches a missing or newly-failing test directly. (This addresses the Codex adversarial-review findings: streaming timeout now has its own test in Task 2; counts replaced with name gates.)

**Out of scope (deliberately not in this plan):** HTTP/2 upstream multiplexing, head-scan-instead-of-full-JSON.parse, worker threads — all judged premature for an I/O-bound, ~dozen-concurrent workload in the prior discussion. The `maxSockets`/`maxFreeSockets`/timeout numbers are tunable constants, not new config surface beyond `PROXY_UPSTREAM_TIMEOUT_MS` and `PROXY_HOST`.

## Review-finding adjudication (GLM first-pass + Codex)

Each load-bearing finding was checked against the real code / Node 22 runtime, not accepted on the reviewer's reasoning. Verdicts:

- **B1 — localhost vs 127.0.0.1 (real, soft) → FIXED.** Confirmed `localhost` resolves `::1`-first on this host. But Node ≥20 happy-eyeballs falls back to `127.0.0.1`, so the connection *succeeds today* (reproduced on Node 22) — GLM's "silent ECONNREFUSED regression" overstated it. Still worth removing the dependency on an unowned client-side fallback: Task 4 now changes the `skills/setup/SKILL.md` template to write `127.0.0.1` and adds a README troubleshooting line for existing `localhost` users.
- **`PROXY_UPSTREAM_TIMEOUT_MS` undocumented (real) → FIXED.** Introduced in Task 1, now documented in `.env.example` + the README env table (Task 4 Step 5). This also covers GLM's **B2** (1M-context cold TTFB can exceed the 120s default): the docs call out raising the knob for 1M workloads. The default is deliberately generous and resets on any byte, so it does not threaten normal streaming.
- **S2 — dead first-draft test (real) → FIXED.** The Task 3 timeout test now appears once; the "ignore the first draft" scaffolding is gone.
- **S4 — passthrough post-headers timeout leak → FALSIFIED, no change.** GLM's mechanism claim ("`request.destroy(err)` emits `'error'` on the request, not `upstreamRes`") is wrong on Node 22. Reproduced the exact scenario (upstream sends >1MB to force passthrough, then stalls): destroying the request DOES propagate `'error'` to `upstreamRes`, the existing `server.js:98-101` handler fires `clientRes.destroy()`, and the client aborts cleanly at ~320ms. No half-open leak. No fix warranted.
- **S6 — keep-alive reuse flake → NOT REPRODUCED, no change.** Ran the exact assertion (2 sequential awaited requests, fresh agent per trial) ×200 on Node 22: 0 trials saw ≠1 connection. The microtask-deferred-freeSockets flake does not occur when `post()` awaits the full response `end` before the next request, which it does. No settle-yield added (it would be cargo-culting against a non-failure).
- **S1 — queued-request (129th socket) head-of-line timeout gap → DEFERRED.** Real in principle (`socket.setTimeout` applies only once a socket is assigned), but it bites only above `maxSockets: 128` concurrent in-flight upstream calls to one host — far beyond this workload's ~dozen. Noted, not fixed; revisit if `maxSockets` is ever lowered.
- **C1 (no `--host` CLI flag), C2 (`0.0.0.0` non-clickable log), C7 (`env=""` vs delete) — DECLINED.** Cosmetic / symmetry-only; no behavior impact. C4 (HTTPS-agent path untested) accepted as low-risk: the same `KEEP_ALIVE` literal builds both agents, so a miswire would fail the HTTP test too.

### Mid-execution finding (discovered during Task 2 review)

**Reuse tests were non-discriminating → redesigned (this revision).** During Task 2's review it surfaced (and was confirmed empirically on Node 22.21.1) that `http.globalAgent` defaults to `keepAlive: true` since Node 19. The original "two requests reuse one upstream connection" tests therefore passed *with or without* the `agent: pickAgent(proto)` wiring — they gave no regression signal. They are replaced (both paths) with a discriminating test that asserts on the imported `httpAgent` singleton: after a proxied request, our agent holds exactly one free socket (`httpAgent.destroy()` first to clear cross-test pollution from the shared singleton; verified 20/20 deterministic on both the streaming and buffered paths). This also corrected the plan's framing: keep-alive is **not** a latency win here (globalAgent already pools); the explicit agent's value is the bounded `maxSockets` and not depending on a runtime default, and the genuinely-new behavior is the timeout. Human decision (recorded): keep all four tasks; make the tests discriminating. Task 2 was already committed with the old test, so its test is amended via a fix step during execution rather than re-running the task.
