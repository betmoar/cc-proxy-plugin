# Architecture

Design and rationale for cc-proxy. For runtime facts and debugging, see [`OPERATIONS.md`](OPERATIONS.md).

## Goal

Use GLM (Z.ai), DeepSeek, OpenRouter, Qwen, LM Studio, and Claude in one Claude Code session, switching with `/model` and no restart. Code-heavy turns can run on GLM (cheaper per token); conversational turns stay on Claude. Quotas visible at a glance.

A local HTTP proxy sits between Claude Code and the upstream APIs. Claude Code points `ANTHROPIC_BASE_URL` at it; the proxy routes each request by model name and forwards. **Every provider becomes a native Claude Code model** — every CC tool, subagent, and prompt-cache works unchanged.

## Invariants

These hold by design; changing them is a breaking decision.

1. **The proxy is a transparent pipe.** It rewrites auth/headers and forwards bytes — no prompt classification, no request rewriting. Claude Code owns all orchestration (prompting, sub-agents, tools).
2. **The proxy is stateless.** No circuit-breaker state, no replay logic, no on-disk persistence. Overflow handling surfaces errors to the caller; recovery is the user's job.
3. **OAuth passthrough for Claude.** Claude-routed requests reuse the inbound `Authorization` header unchanged. Never set `ANTHROPIC_API_KEY` (it would shadow the OAuth flow).
4. **Internal `claude-haiku-*` always routes to Claude** so CC's title/summary plumbing never burns a paid third-party quota.
5. **Anthropic Messages only.** Every provider speaks the Anthropic Messages API (or a compatible "skin"). There is deliberately no OpenAI↔Anthropic translation layer.

## Provider registry

Routing is data-driven ([`src/providers.js`](../src/providers.js)). A provider:

```js
Provider = {
  id,                       // "glm" | "openrouter" | "claude"
  baseUrl,                  // proxy appends the inbound path (/v1/messages)
  apiKey,                   // from env; "" for OAuth passthrough
  auth,                     // "oauth" | "apiKey" | "bearer"
  match: (model) => bool,   // which model ids route here
  isDefault?,               // chosen by DEFAULT_BACKEND
}
```

`resolve(model, config)` picks the first non-default provider whose `match()` wins, else the default. Adding a backend is one entry — no router or server changes. **LM Studio is the one selector-only provider**: its served ids are the user's own loaded models, whose names are arbitrary and churn with every load/unload, so `match()` refuses everything and `lmstudio:<id>` is the only way in by shape — the selector is the disambiguation, and no bare id can be stolen from the glm/qwen/OpenRouter predicates. (`DEFAULT_BACKEND=lmstudio` additionally makes it the unmatched-id fallback — an explicit user choice, like `=openrouter`.)

### Routing priority

| Rank | Rule | Target |
| --- | --- | --- |
| 1 | `claude-haiku-*` | Claude (pinned, internal ops) |
| 2 | first `match()` (e.g. `glm-*`, `deepseek-*`, bare `qwen*`, `vendor/model`) | that provider |
| 3 | no match | default backend (`claude`) |

### Auth strategies

- **oauth** — pass the inbound `Authorization` through (Claude Pro/Max).
- **apiKey** — drop `Authorization`, set `x-api-key` (GLM's Z.ai endpoint; DeepSeek's Anthropic skin).
- **bearer** — drop `Authorization`, set `Authorization: Bearer` (OpenRouter's, Qwen's, and LM Studio's Anthropic skins).

`applyAuth` / `buildUpstreamHeaders` centralize header construction.

## Design decisions

### Proxy, not a plugin skill

A skill that called the provider API directly could only hand it a text prompt — no `Read`/`Write`/`Bash`, no iteration, and a double context-collection pass per turn. The proxy makes the provider a first-class CC model instead, so every tool works and there is no per-turn overhead.

### Node.js, zero dependencies

`http`/`https`/`net`/`fetch` are built in and ship with the CC runtime. `// @ts-check` + JSDoc gives type safety without a build step. No LiteLLM — it had a credential-stealing PyPI supply-chain compromise (2026) plus open SSRF/RCE CVEs, and it's unnecessary here because every backend already speaks Anthropic Messages.

### Local, not hosted

Your own credentials, on your own machine. A hosted relay that shares credentials across users is a different (ToS-material) thing.

### Loopback binding

The proxy listens on `127.0.0.1` by default. It injects GLM/DeepSeek/OpenRouter/Qwen API keys
and forwards Claude OAuth, so a request that reaches it is authenticated as you;
an all-interfaces bind would let any host on the LAN spend your quota. `PROXY_HOST`
is an explicit opt-out for the rare deliberate off-host setup. The setup template
writes `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` (not `localhost`) so the client
target matches the bind exactly rather than relying on IPv6→IPv4 fallback.

### Context-overflow handling

The one case the proxy actively handles: a **non-streaming** GLM overflow returns `200` with empty content and `stop_reason=model_context_window_exceeded` — a plain pipe would forward that as a silent successful empty turn. The proxy detects that specific case and converts it to a `400` so it surfaces. Everything else passes through untouched: a native `400`/error already surfaces on its own, and a **streaming** overflow reaches Claude Code as its own context-limit message (synthesized from the SSE `stop_reason`).

There is no automatic replay and no circuit breaker. Recovery is the user's responsibility: switch model, `/clear`, or `/compact`. With `glm-5.2[1m]` (1M window) overflow is rare.

### Rate-limit handling

The second active normalization, same spirit as overflow: GLM's `1302` request-rate-limit response is HTTP `429` but carries **no** `Retry-After` header, so Claude Code surfaces it as a hard error instead of backing off. The proxy detects the `1302` body (on both forward paths) and injects `Retry-After: 30`, letting Claude Code's own client retry handle the wait. This keeps the [stateless invariant](#invariants) — no in-proxy sleep or replay, which would hold the client connection open and could collide with the client's own backoff. The detection is gated strictly on code `1302`: the sibling `1113` (insufficient balance) and every other `429` pass through untouched, so a non-retryable error never gets a misleading retry hint (avoiding the documented infinite-cooldown loop other clients hit by treating all `429`s alike). On the streaming path a `429` is a small JSON body (the limit short-circuits before any SSE), so the proxy buffers only `429` responses to inspect them — real SSE streams stay a pure pipe.

### Model discovery (`/v1/models`)

`GET /v1/models` synthesizes a merged model list rather than forwarding. It lives
outside the router because it aggregates across backends: GLM, DeepSeek, Qwen,
and OpenRouter are fetched live, while Claude is a curated static list. Each live
leg keeps a curated list as its offline fallback. Qwen's catalog is on the
OpenAI-compatible path (`/compatible-mode/v1/models`), not the Anthropic skin the
proxy forwards to (`/apps/anthropic/v1/models`, which 404s "Not support") — that
asymmetry is why this leg was static for so long. The discovery list advertises
only generally-reachable models (Glasswing-gated and region-blocked ids are
omitted); ids a backend serves that this proxy cannot use (multimodal, `:batch`,
`~latest` aliases) are published with `usable: false` rather than dropped, and
the field is absent when the entry is usable. Best-effort by design: a failed
live leg yields an `_errors` entry, not a failed response, keeping the endpoint
stateless (invariant 2) and the fan-out non-blocking.

Each entry carries a non-standard `context_window` when its id has a curated
window (`src/models.js` `CONTEXT_WINDOW`, attached uniformly by
`withContextWindow()`): an **integer token count**, never a display string.
ids with no curated window — the OpenRouter-prefixed `vendor/model` ids and
`claude-*` — omit the field rather than emit `null`, so "unknown" is
distinguishable from "known" via `"context_window" in entry`. This is a
published contract with a named downstream consumer (cc-reload budgets a
session against it), which is why the table lives in `src/` rather than in the
display layer — see [`docs/BACKLOG.md`](BACKLOG.md) "Reversed decisions".

Entries also carry `provider`, `tier` (cost, from `src/routes.js` `tierOf()`),
and — for an assessed model only — `grade` (capability, from `src/models.js`
`gradeOf()`: the built-in `MODEL_GRADES` table overlaid with the `bench grades`
refresh). Two fields because they are two axes: a resold model is expensive to
reach and just as capable as its native twin. Collapsing them would force one of
the two claims to be false, which is also why `Economy` was retired in 0.6.1 —
it was a cost word living on the capability axis.

`grade` follows `context_window`'s omission rule: three values (`Flagship`,
`Strong`, `Specialist`) and no fourth for "unknown", because an unassessed id
simply has no `grade` key. Most of the ~320 discovered ids are unassessed, and
a default made the field claim otherwise about every one of them.

**Identity is the third axis, and unlike the other two it needs no table.** An id
names a route as well as a model, so one model appears under several ids — 17
such groups on a live 415-id catalogue. `?dedup=identity` returns one entry per
model, lowest `tier` winning (`identityOf()` / `dedupByIdentity()` in
`src/models.js`, both pure). It adds no field and publishes no new fact: the
alternative was an `origin:` field, rejected because a published attribution is a
fact that can go stale, while `provider` and `tier` are things the proxy
observes. What made it worth centralizing at all is that the rule is easy to get
wrong — splitting on the LAST separator instead of the first merges every
OpenRouter `:batch` variant into one identity across seven vendors, which is
exactly the mistake a consumer re-deriving it would make.

## The media tunnel

`POST /api/v1/services/aigc/multimodal-generation/generation` is the one
**path-routed** request in the proxy. Everything else routes on `body.model`,
which is precisely why this needs its own branch: the plan's image ids
(`wan2.7-image`) match no provider predicate and would fall through to the
default backend. It is a tunnel, not a translation — byte-for-byte body, the
vendor's own response, no schema knowledge here — so invariant 5 is untouched;
all the proxy contributes is the credential it already holds. The qwen provider
carries a second base URL (`mediaBaseUrl`, the same host at its root) because
`upstreamRequestOptions()` concatenates `baseUrl + req.url` with no rewriting,
and there is deliberately no path-rewriting layer to add one.

## Route selection

A model id does not name a backend. `deepseek-v4-pro` is served by three of
them at three prices; `glm-5.2` by two. `src/routes.js` records the probed
matrix (`ROUTES` — complete, including the 403/400 rows, so a known-unavailable
route is documented rather than merely absent) and ranks the usable ones. The
sort is **native first, then cost**: the native provider wins outright over a
cheaper resold route (prepaid plan capacity is sunk, metered credits are
marginal spend, an aggregator is last), because a resold gateway may inject a
preamble that makes the routes behaviourally non-interchangeable, and the bare
id is the one `/model` sets. This is the issue-#19 rule; before it, native only
broke cost ties (which is still how `glm-5.2` stays on Z.ai). When the native
backend is not registered, `resolve()` skips it and falls to the next-ranked
route — so a plan-holder without a native DeepSeek key still reaches
`deepseek-v4-pro` through the plan.

The table is deliberately **not authoritative**: an id absent from it falls
through to the provider `match()` predicates and still routes. Vendor ids
rename, and a table that could strand a model on rename would be worse than no
table.

To name a route explicitly, `<provider>:<model>` — a **local lens**. Only
`src/router.js` interprets it; `handleProxy` rewrites `body.model` to the bare
id before forwarding, so no backend ever sees cc-proxy's spelling. Colon only:
`/` belongs to OpenRouter's `includes("/")` predicate. A slash selector was
considered and dropped because it buys nothing — the bare id already resolves to
the native route and the slash form already resolves to the reseller.

Two ordering constraints in `resolve()`, both load-bearing:

1. The selector is parsed **first**, so nothing resolves by coincidence (before
   the explicit parse, `qwen:qwen3.7-max` worked only because it happened to
   satisfy `startsWith("qwen")`, while `glm:glm-5.2` silently fell to the
   default backend).
2. The `claude-haiku-*` pin tests the **stripped tail** and outranks the
   selector. Pinning on the raw id would let `glm:claude-haiku-…` skip it, and
   the strip would then deliver the bare haiku id to a third party — invariant 4
   violated and paid quota burned.

### Registering models in `/model`

Claude Code's picker rejects unknown ids unless injected via `ANTHROPIC_CUSTOM_MODEL_OPTION` (exactly one slot; validation skipped). `/cc-proxy:setup` registers `glm-5.2[1m]`.

### Statusline quota mapping

From Z.ai's official plugin: `TOKENS_LIMIT` = the 5-hour coding quota (what the statusline shows). Its `nextResetTime` (epoch ms) drives the reset countdown — shown only once a quota is exhausted (`⏱3h11m`, replacing the percentage), and as an absolute UTC stamp in `/cc-proxy:status`. OpenRouter exposes remaining credits at `/api/v1/credits` and DeepSeek its balance at `/user/balance` (USD row preferred), both rendered as `$`-tiers by digit count (`or:$$$`, `ds:$$`) via the shared `dollarTier()` helper. The shared `renderQuota()` helper in `scripts/statusline.js` carries this logic and guards non-finite inputs (schema drift) with a `--` placeholder rather than `NaN%`.

## Repository layout

```
cc-proxy-plugin/                    ← the plugin IS the repo root; the marketplace caches the whole tree
├── .claude-plugin/plugin.json      plugin manifest (root, per Claude Code convention)
├── bin/cc-proxy.js                 CLI entry point (loads ~/.env + repo .env, starts server)
├── src/
│   ├── config.js                   env loader → { port, providers }
│   ├── env.js                      shared ~/.env + repo .env loader (no-overwrite)
│   ├── providers.js                provider registry + auth strategies
│   ├── router.js                   resolve() — stateless model→provider lookup
│   ├── proxy.js                    upstream forwarding (transparent pipe)
│   ├── server.js                   HTTP server, overflow conversion, /_status
│   ├── sanitize.js                 strips thinking blocks from history
│   └── models.js                   /v1/models discovery: fans out to GLM + DeepSeek + Qwen + OpenRouter (live, curated fallback) + Claude (static), merges best-effort
├── hooks/                          SessionStart proxy auto-start (proxy-lifecycle.js)
├── scripts/statusline.js           quota / credits / proxy-down indicator
├── scripts/status.js               /cc-proxy:status report builder
├── scripts/list-models.js          /cc-proxy:models renderer (/v1/models + attribution)
├── scripts/start-proxy.js          /cc-proxy:setup proxy starter (idempotent)
├── skills/setup/SKILL.md           /cc-proxy:setup
├── commands/                       /cc-proxy:status, /cc-proxy:models
├── test/                           node --test suite
└── docs/                           ARCHITECTURE.md, OPERATIONS.md
```

The marketplace manifest lives in a separate repo ([`betmoar/ccp-market`](https://github.com/betmoar/ccp-market)) and points at this repo by github source. Because the plugin is the repo root, `bin/cc-proxy.js` is inside the cached tree, and the SessionStart hook resolves it from its own location (`resolveProxyPath()`), so the spawned proxy is always the installed version — a `PROXY_PATH` in settings.json is only a legacy fallback. The one absolute version-pinned path that remains is the optional statusline command, which runs outside plugin context where `${CLAUDE_PLUGIN_ROOT}` is unavailable; it only renders gauges, so a stale pin there is cosmetic. Because the proxy process outlives updates, `/_status` reports the proxy's version and the hook gracefully replaces a mismatched one via POST `/_shutdown`.

## Out of scope

- launchd / systemd service files — SessionStart auto-recovery covers the same ground without OS-specific setup.
- Plugin-skill path — superseded by the proxy.
- Full TypeScript — `// @ts-check` + JSDoc is enough.
- Request format translation — providers must speak Anthropic Messages.
- End-to-end queue-wait deadline. The upstream timeout (`PROXY_UPSTREAM_TIMEOUT_MS`) is a *socket-inactivity* timeout: Node starts it only once a socket is assigned to the request. If more than `maxSockets` (128) upstream calls to a single origin are in flight at once, further requests queue inside the shared agent with no socket yet, so the inactivity timeout does not bound their wait — a fully saturated, all-stalled pool could hold a queued request open past the timeout. This needs ~128 simultaneously-stalled upstream calls to one origin from a single proxy process, far beyond a local single-user workload (a handful of sessions plus subagent fan-out); it is a concern only for a shared, high-QPS relay, which is explicitly out of scope (see "Local, not hosted"). The bounded `maxSockets` is still a net improvement over the previous unbounded default, and the pre-timeout behavior was worse (every stalled request hung forever). Closing the edge fully would require a wall-clock deadline started before `proto.request` that destroys the request even while agent-queued.
