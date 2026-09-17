# Architecture

Design and the reasons behind it. For what the proxy does at runtime see
[OPERATIONS](OPERATIONS.md); for how an id picks a backend see
[ROUTING](ROUTING.md); for the traps and the evidence behind each rule see
[MAINTAINING](MAINTAINING.md).

## Goal

Use GLM (Z.ai), DeepSeek, Qwen, OpenRouter, LM Studio and Claude in one Claude
Code session, switching with `/model` and no restart. Code-heavy turns can run
on a cheaper backend; conversational turns stay on Claude. Quotas visible at a
glance.

A local HTTP proxy sits between Claude Code and the upstream APIs. Claude Code
points `ANTHROPIC_BASE_URL` at it; the proxy routes each request by model name
and forwards. **Every provider becomes a native Claude Code model**, so every
tool, subagent and prompt cache works unchanged. The cache claim rests on the
thinking-strip being deterministic, which is measured and locked; see
[OPERATIONS](OPERATIONS.md#prompt-caching).

## Invariants

These hold by design. Changing one is a breaking decision, not a refactor, and
each is locked by a named test (the list is in [CLAUDE.md](../CLAUDE.md)).

1. **Transparent pipe.** Auth and headers only. The full inbound path,
   query string included, reaches upstream; bodies are forwarded byte for byte
   except for three strips (thinking blocks, the `<provider>:` selector, the
   `[1m]` suffix) that share one shape: a spelling the client uses that no
   backend knows.
2. **Stateless.** No breakers, no on-disk state, no in-proxy waiting. A rate
   limit gets a `Retry-After` and the client backs off.
3. **Credential isolation.** An inbound `Authorization` or `x-api-key` never
   reaches a third party; the Claude route passes them through (OAuth).
   `ANTHROPIC_API_KEY` is never set in a settings template; it shadows OAuth.
4. **`claude-haiku-*` pins to Claude**, so Claude Code's internal ops never
   burn paid quota. The pin tests the stripped id, so a selector cannot skip it.
5. **Anthropic Messages only.** No OpenAI-to-Anthropic translation layer. The
   media tunnel forwards a DashScope body byte for byte to a DashScope endpoint
   and is not an exception.
6. **Client abort propagates upstream**, or a cancelled turn bills into a dead
   socket.
7. **Loopback bind by default.** `PROXY_HOST` is the explicit opt-out;
   `PROXY_AUTH_TOKEN` is what makes the opt-out safe.
8. **One bad request never ends the process.** The proxy is shared by every
   session on the machine, so every dispatch point contains its own throws; a
   request may fail, the process may not.

## Provider registry

Routing is data-driven (`src/providers.js`). A provider is:

```js
Provider = {
  id,            // "glm" | "openrouter" | "deepseek" | "qwen" | "lmstudio" | "claude"
  baseUrl,       // the proxy appends the inbound path, e.g. /v1/messages?beta=true
  apiKey,        // from env; "" for OAuth passthrough
  auth,          // "oauth" | "apiKey" | "bearer"
  match,         // (model) => bool: which bare ids route here
  isDefault,     // optional, set by DEFAULT_BACKEND
  mediaBaseUrl,  // optional: host root for a media path outside the skin (qwen only)
}
```

A backend is registered only when its key (or, for LM Studio, its base URL) is
present, so a zero-key proxy is a working proxy that routes to Claude. Adding a
backend is one entry plus its id in `PROVIDER_IDS`; no router or server change.
**LM Studio is the one selector-only provider**: its ids are the user's own
loaded models, whose names are arbitrary and churn, so `match()` refuses
everything and `lmstudio:<id>` is the only way in. `DEFAULT_BACKEND=lmstudio`
additionally makes it the unmatched-id fallback, an explicit user choice.

### Routing priority

| Rank | Rule | Target |
| --- | --- | --- |
| 0 | strip a `<provider>:` selector and a `[…]` suffix | the normalised id feeds every rule below |
| 1 | `claude-haiku-*` | Claude, pinned |
| 2 | a registered `<provider>:` selector | that provider |
| 3 | a ranked `ROUTES` entry | native provider first, then cheapest tier, registered only |
| 4 | first `match()` (`glm-*`, `deepseek-*`, bare `qwen*`, `vendor/model`) | that provider |
| 5 | no match | `DEFAULT_BACKEND` (`claude`) |

### Auth strategies

- **oauth**: pass the inbound `Authorization` through (Claude Pro/Max).
- **apiKey**: drop the inbound credentials, set `x-api-key` (Z.ai, DeepSeek).
- **bearer**: drop the inbound credentials, set `Authorization: Bearer`
  (OpenRouter, Qwen, LM Studio).

`applyAuth()` and `buildUpstreamHeaders()` are the only places headers are
built; hop-by-hop headers are dropped there (an inbound `Transfer-Encoding`
next to the proxy's `Content-Length` trips upstream smuggling rejection).

## Design decisions

### Proxy, not a plugin skill

A skill that called a provider API directly could only hand it a text prompt:
no `Read`, `Write` or `Bash`, no iteration, and a double context-collection
pass per turn. The proxy makes the provider a first-class Claude Code model
instead.

### Node.js, zero dependencies

`http`, `https`, `net` and `fetch` are built in and ship with the Claude Code
runtime. `// @ts-check` plus JSDoc gives type safety without a build step. No
LiteLLM: it had a credential-stealing supply-chain compromise (2026) plus open
SSRF and RCE CVEs, and it is unnecessary when every backend already speaks
Anthropic Messages.

### Local, not hosted

Your own credentials, on your own machine. A hosted relay that shares
credentials across users is a different, ToS-material product.

### Loopback binding

The proxy injects the GLM, DeepSeek, OpenRouter, Qwen and LM Studio
credentials and forwards Claude OAuth, so a request that reaches it is
authenticated as you; an all-interfaces bind would let any host on the LAN
spend your quota. `PROXY_HOST` is the deliberate opt-out and
`PROXY_AUTH_TOKEN` gates every non-probe request when it is set. The setup
template writes `http://127.0.0.1:4000`, not `localhost`, so the client target
matches the bind rather than relying on IPv6-to-IPv4 fallback.

### Context-overflow handling

The one case the proxy actively handles: a **non-streaming** GLM overflow
returns `200` with empty content and `stop_reason=model_context_window_exceeded`,
which a plain pipe would forward as a silent empty turn. The proxy converts
that case to a `400`. Everything else passes through: a native error already
surfaces, and a streaming overflow reaches Claude Code as its own
context-limit message. No replay, no breaker; recovery is the user's.

### Rate-limit handling

The second active normalisation, same spirit. GLM's `1302` is HTTP `429` with
no `Retry-After`, so Claude Code surfaced it as a hard error. The proxy injects
`Retry-After: 30` on both forward paths and lets the client's own retry wait,
which keeps invariant 2. Gated on code `1302` exactly: `1113` (insufficient
balance) is a `429` that must not get a retry hint, or the client loops. On
the streaming path a `429` is a small JSON body, so only `429` responses are
buffered there; real SSE stays a pure pipe.

### Model discovery (`/v1/models`)

Synthesized, not forwarded, because it aggregates across backends: GLM,
DeepSeek, Qwen and OpenRouter are fetched live, Claude is curated. Each live
leg is bounded by a timeout and a body cap; a failed leg is named in
`_errors` or falls back to a curated list, never a failed response, keeping
the endpoint stateless and the fan-out non-blocking. Ids a backend serves that
this proxy cannot use carry `usable: false` rather than being dropped.

Three fields ride on each entry, and they are three different questions:

- **`context_window`** answers "how big". Curated for bare GLM, DeepSeek and
  Qwen ids (`CONTEXT_WINDOW` in `src/models.js`, attached by
  `withContextWindow()`); live OpenRouter entries carry the aggregator's own
  `context_length`. Absent, never `null`, when unknown. It is a published
  contract with a named consumer (cc-reload budgets a session against it),
  which is why the table lives in `src/` rather than the display layer; see
  [BACKLOG](BACKLOG.md#reversed-decisions).
- **`tier`** answers "what the route costs" (`src/routes.js` `tierOf()`).
- **`grade`** answers "what the model can do" (`gradeOf()`: the built-in
  `MODEL_GRADES` overlaid with a `bench grades` refresh). Three values and no
  fourth for "unknown": an unassessed id has no key. `Economy` was retired in
  0.6.1 because it was a cost word on the capability axis.

Cost and capability are independent; a resold flagship is tier 4 and Flagship.

**Identity is the third axis, and it needs no table.** An id names a route as
well as a model, so one model appears under several ids (17 such groups on a
live 415-id catalogue). `?dedup=identity` returns one entry per model, lowest
tier winning (`identityOf()` and `dedupByIdentity()`, both pure). An `origin:`
field was rejected: a published attribution is a fact that can go stale, while
`provider` and `tier` are things the proxy observes. The rule is centralised
because it is easy to get wrong: splitting on the last separator instead of
the first merges every OpenRouter `:batch` variant into one identity across
seven vendors.

### The media tunnel

`POST /api/v1/services/aigc/multimodal-generation/generation` is the one
**path-routed** request. Everything else routes on `body.model`, and the plan's
image ids match no provider predicate, so they would fall through to the
default backend. It is a tunnel, not a translation: byte-for-byte body, the
vendor's own response, no schema knowledge. The qwen provider carries a second
base URL (`mediaBaseUrl`, the same host at its root) because
`upstreamRequestOptions()` concatenates `baseUrl + req.url` with no rewriting,
and there is deliberately no path-rewriting layer.

### Route selection

A model id does not name a backend: `deepseek-v4-pro` is served by three
backends at three prices. `src/routes.js` records the probed matrix (`ROUTES`,
complete, including the 403 and 400 rows so a known-unavailable route is
documented rather than absent) and `rankRoutes()` orders the usable ones
**native first, then by cost tier**. Native wins outright over a cheaper resold
route (the issue-#19 rule) because a resold gateway may inject a preamble
(measured +79 tokens) and the bare id is what `/model` sets. When the native
backend is not registered, `resolve()` falls to the next-ranked route.

The table is deliberately **not authoritative**: an id absent from it falls
through to the `match()` predicates and still routes. Vendor ids rename, and a
table that could strand a model on rename would be worse than no table.

The `<provider>:` selector is a **local lens** only `src/router.js` interprets;
`handleProxy` rewrites `body.model` to the bare id before forwarding. Colon
only: `/` belongs to OpenRouter's predicate. Two ordering constraints in
`resolve()` are load-bearing: the selector is parsed first (before it,
`qwen:qwen3.7-max` worked only by coincidence and `glm:glm-5.2` fell to the
default), and the haiku pin tests the stripped tail so `glm:claude-haiku-…`
cannot skip it.

### Registering models in `/model`

`/cc-proxy:setup` runs `scripts/render-model-picker.js`, which writes one
`modelPicker` row per curated id whose backend is registered, with the real
context window and a `behavesAs` that silences the catalog warning. The rules
and the measurement are in
[CONFIGURATION](CONFIGURATION.md#the-model-picker-and-context-windows).
`ANTHROPIC_CUSTOM_MODEL_OPTION` is the superseded one-slot mechanism; the
script removes it.

### Statusline quota mapping

From Z.ai's official plugin: `TOKENS_LIMIT` is the 5-hour coding quota. Its
`nextResetTime` (epoch ms) drives the reset countdown, shown only once a quota
is exhausted. OpenRouter exposes remaining credits at `/api/v1/credits` and
DeepSeek its balance at `/user/balance` (USD row only), both rendered as
`$`-tiers by digit count. `renderQuota()` guards non-finite input with `--`
rather than `NaN%`. The render path never touches the network; see
[STATUSLINE](STATUSLINE.md#how-a-refresh-works).

## Repository layout

```
cc-proxy-plugin/                     the plugin IS the repo root; the marketplace caches the whole tree
├── .claude-plugin/
│   ├── plugin.json                  plugin manifest; its version is the cache key
│   ├── marketplace.json             lets `claude plugin marketplace add` work on this repo alone
│   └── statusline.json              cc-status composer discovery
├── bin/cc-proxy.js                  CLI entry: loadEnv, config, createServer, listen
├── src/
│   ├── agents.js                    bounded keep-alive agents and the upstream inactivity timeout
│   ├── config.js                    env to Config: port, host, authToken, providers, catalogs
│   ├── env.js                       ~/.env and repo .env loader
│   ├── fallback.js                  the GLM overflow and 1302 detectors
│   ├── model-picker.js              /model picker rows: the [1m] and behavesAs rules
│   ├── models.js                    /v1/models: live legs, curated tables, grades, identity dedup
│   ├── providers.js                 provider registry, auth strategies, PROVIDER_IDS
│   ├── proxy.js                     upstreamRequestOptions() and forward(), the streaming path
│   ├── router.js                    resolve(), the selector and [1m] strips
│   ├── routes.js                    the hand-probed ROUTES matrix and rankRoutes()
│   ├── sanitize.js                  the deterministic thinking-strip
│   └── server.js                    dispatcher, buffered path, probes, auth gate, media tunnel
├── hooks/
│   ├── hooks.json                   SessionStart runs session-start.js with a 10 s timeout
│   ├── session-start.js             the hook entry: loadHomeEnv, ensureProxyRunning, one context line
│   ├── proxy-lifecycle.js           probe, spawn, stale replacement; imports nothing from src/
│   └── picker-staleness.js          the once-per-version picker notice
├── scripts/
│   ├── statusline.js                the status bar segment: render path plus detached refresher
│   ├── refresh-lock.js              single-flight lock with a serialized stale reclaim
│   ├── quota.js                     vendor quota and credit fetchers shared by statusline and status
│   ├── status.js                    /cc-proxy:status
│   ├── list-models.js               /cc-proxy:models
│   ├── bench-grades.js              /cc-proxy:bench grades, writes grades.json
│   ├── bench-speed.js               /cc-proxy:bench speed, appends speed.jsonl
│   ├── start-proxy.js               the proxy starter /cc-proxy:setup ends with
│   ├── render-model-picker.js       pnpm models:picker, writes the user's settings.json
│   ├── render-models.js             the models.html renderer
│   ├── render-html.mjs              pnpm models:html, runs the renderer in an isolated HOME
│   ├── probe-vendors.mjs            pnpm probe:vendors, manual, real keys
│   ├── direct-run.js                the isDirectRun() guard every script uses
│   ├── version-guard.js             refuses a tagging `version` off main
│   ├── sync-version.mjs             copies package.json's version into plugin.json
│   └── release-gate.mjs             tag equals plugin.json equals package.json equals CHANGELOG
├── skills/setup/SKILL.md            /cc-proxy:setup
├── commands/                        status.md, models.md, bench.md
├── test/                            node --test suite, plus fixtures/
└── docs/                            this directory; the map is in the README
```

The marketplace manifest also lives in a separate repo
([betmoar/ccp-market](https://github.com/betmoar/ccp-market)) pointing at this
one. Because the plugin is the repo root, `bin/cc-proxy.js` is inside the
cached tree and the hook resolves it from its own location, so the spawned
proxy is always the installed version; a `PROXY_PATH` in settings.json is a
legacy fallback. The one absolute version-pinned path that remains is the
optional statusline command, which runs outside plugin context; a stale pin
there is cosmetic. Because the proxy process outlives updates, `/_status`
reports its version and the hook replaces an **older** one through
`POST /_shutdown`.

## Out of scope

- launchd or systemd service files: SessionStart auto-recovery covers the same
  ground without OS-specific setup.
- The plugin-skill path: superseded by the proxy.
- Full TypeScript: `// @ts-check` plus JSDoc is enough.
- Request format translation: providers must speak Anthropic Messages.
- An end-to-end queue-wait deadline. `PROXY_UPSTREAM_TIMEOUT_MS` is a
  socket-inactivity timeout that starts once a socket is assigned. If more than
  `maxSockets` (128) upstream calls to one origin are in flight, further
  requests queue inside the agent with no socket, so the timeout does not bound
  their wait. That needs ~128 simultaneously stalled calls to one origin from
  one proxy, far beyond a single-user workload, and is a concern only for the
  shared high-QPS relay that is explicitly out of scope.
