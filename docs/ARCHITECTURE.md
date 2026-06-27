# Architecture

Design and rationale for cc-proxy. For runtime facts and debugging, see [`OPERATIONS.md`](OPERATIONS.md).

## Goal

Use GLM (Z.ai), OpenRouter, and Claude in one Claude Code session, switching with `/model` and no restart. Code-heavy turns can run on GLM (cheaper per token); conversational turns stay on Claude. Both quotas visible at a glance.

A local HTTP proxy sits between Claude Code and the upstream APIs. Claude Code points `ANTHROPIC_BASE_URL` at it; the proxy routes each request by model name and forwards. **GLM and OpenRouter become native Claude Code models** — every CC tool, subagent, and prompt-cache works unchanged.

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

`resolve(model, config)` picks the first non-default provider whose `match()` wins, else the default. Adding a backend is one entry — no router or server changes.

### Routing priority

| Rank | Rule | Target |
| --- | --- | --- |
| 1 | `claude-haiku-*` | Claude (pinned, internal ops) |
| 2 | first `match()` (e.g. `glm-*`, `vendor/model`) | that provider |
| 3 | no match | default backend (`claude`) |

### Auth strategies

- **oauth** — pass the inbound `Authorization` through (Claude Pro/Max).
- **apiKey** — drop `Authorization`, set `x-api-key` (Z.ai's Anthropic endpoint).
- **bearer** — drop `Authorization`, set `Authorization: Bearer` (OpenRouter's Anthropic "skin").

`applyAuth` / `buildUpstreamHeaders` centralize header construction.

## Design decisions

### Proxy, not a plugin skill

A skill that called the provider API directly could only hand it a text prompt — no `Read`/`Write`/`Bash`, no iteration, and a double context-collection pass per turn. The proxy makes the provider a first-class CC model instead, so every tool works and there is no per-turn overhead.

### Node.js, zero dependencies

`http`/`https`/`net`/`fetch` are built in and ship with the CC runtime. `// @ts-check` + JSDoc gives type safety without a build step. No LiteLLM — it had a credential-stealing PyPI supply-chain compromise (2026) plus open SSRF/RCE CVEs, and it's unnecessary here because every backend already speaks Anthropic Messages.

### Local, not hosted

Your own credentials, on your own machine. A hosted relay that shares credentials across users is a different (ToS-material) thing.

### Loopback binding

The proxy listens on `127.0.0.1` by default. It injects GLM/OpenRouter API keys
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

### Registering models in `/model`

Claude Code's picker rejects unknown ids unless injected via `ANTHROPIC_CUSTOM_MODEL_OPTION` (exactly one slot; validation skipped). `/cc-proxy:setup` registers `glm-5.2[1m]`.

### Statusline quota mapping

From Z.ai's official plugin: `TOKENS_LIMIT` = the 5-hour coding quota (what the statusline shows). Its `nextResetTime` (epoch ms) drives the reset countdown — shown only once a quota is exhausted (`⏱3h11m`, replacing the percentage), and as an absolute UTC stamp in `/cc-proxy:status`. OpenRouter exposes remaining credits at `/api/v1/credits`, rendered as `$`-tiers by digit count (`api:$$$`). The shared `renderQuota()` helper in `scripts/statusline.js` carries this logic and guards non-finite inputs (schema drift) with a `--` placeholder rather than `NaN%`.

## Repository layout

```
cc-proxy-plugin/                    ← the plugin IS the repo root; the marketplace caches the whole tree
├── .claude-plugin/plugin.json      plugin manifest (root, per Claude Code convention)
├── bin/cc-proxy.js                 CLI entry point (loads .env, starts server)
├── src/
│   ├── config.js                   env loader → { port, providers }
│   ├── providers.js                provider registry + auth strategies
│   ├── router.js                   resolve() — stateless model→provider lookup
│   ├── proxy.js                    upstream forwarding (transparent pipe)
│   ├── server.js                   HTTP server, overflow conversion, /_status
│   └── sanitize.js                 strips thinking blocks from history
├── hooks/                          SessionStart proxy auto-start (proxy-lifecycle.js)
├── scripts/statusline.js           quota / credits / proxy-down indicator
├── scripts/status.js               /cc-proxy:status report builder
├── scripts/start-proxy.js          /cc-proxy:setup proxy starter (idempotent)
├── skills/setup/SKILL.md           /cc-proxy:setup
├── commands/                       /cc-proxy:status, /cc-proxy:ask
├── agents/                         glm-* offload subagents
├── test/                           node --test suite
└── docs/                           ARCHITECTURE.md, OPERATIONS.md
```

The marketplace manifest lives in a separate repo ([`betmoar/ccp-market`](https://github.com/betmoar/ccp-market)) and points at this repo by github source. Because the plugin is now the repo root, `bin/cc-proxy.js` is inside the cached tree, but it is still referenced by absolute path via `PROXY_PATH`: the SessionStart hook spawns the proxy detached, and the statusline runs outside plugin context where `${CLAUDE_PLUGIN_ROOT}` is unavailable.

## Out of scope

- launchd / systemd service files — SessionStart auto-recovery covers the same ground without OS-specific setup.
- Plugin-skill path — superseded by the proxy.
- Full TypeScript — `// @ts-check` + JSDoc is enough.
- Request format translation — providers must speak Anthropic Messages.
- End-to-end queue-wait deadline. The upstream timeout (`PROXY_UPSTREAM_TIMEOUT_MS`) is a *socket-inactivity* timeout: Node starts it only once a socket is assigned to the request. If more than `maxSockets` (128) upstream calls to a single origin are in flight at once, further requests queue inside the shared agent with no socket yet, so the inactivity timeout does not bound their wait — a fully saturated, all-stalled pool could hold a queued request open past the timeout. This needs ~128 simultaneously-stalled upstream calls to one origin from a single proxy process, far beyond a local single-user workload (a handful of sessions plus subagent fan-out); it is a concern only for a shared, high-QPS relay, which is explicitly out of scope (see "Local, not hosted"). The bounded `maxSockets` is still a net improvement over the previous unbounded default, and the pre-timeout behavior was worse (every stalled request hung forever). Closing the edge fully would require a wall-clock deadline started before `proto.request` that destroys the request even while agent-queued.
