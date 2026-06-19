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

### Context-overflow handling

The one case the proxy actively handles: a **non-streaming** GLM overflow returns `200` with empty content and `stop_reason=model_context_window_exceeded` — a plain pipe would forward that as a silent successful empty turn. The proxy detects that specific case and converts it to a `400` so it surfaces. Everything else passes through untouched: a native `400`/error already surfaces on its own, and a **streaming** overflow reaches Claude Code as its own context-limit message (synthesized from the SSE `stop_reason`).

There is no automatic replay and no circuit breaker. Recovery is the user's responsibility: switch model, `/clear`, or `/compact`. With `glm-5.2[1m]` (1M window) overflow is rare.

### Registering models in `/model`

Claude Code's picker rejects unknown ids unless injected via `ANTHROPIC_CUSTOM_MODEL_OPTION` (exactly one slot; validation skipped). `/cc-proxy:setup` registers `glm-5.2[1m]`.

### Statusline quota mapping

From Z.ai's official plugin: `TOKENS_LIMIT` = the 5-hour coding quota (what the statusline shows). OpenRouter exposes remaining credits at `/api/v1/credits`.

## Repository layout

```
cc-proxy-plugin/
├── bin/cc-proxy.js                 CLI entry point (loads .env, starts server)
├── src/
│   ├── config.js                   env loader → { port, providers }
│   ├── providers.js                provider registry + auth strategies
│   ├── router.js                   resolve() — stateless model→provider lookup
│   ├── proxy.js                    upstream forwarding (transparent pipe)
│   ├── server.js                   HTTP server, overflow conversion, /_status
│   └── sanitize.js                 strips thinking blocks from history
├── plugins/cc-proxy/               ← marketplace caches only this subtree
│   ├── .claude-plugin/plugin.json
│   ├── hooks/                      SessionStart proxy auto-start
│   ├── scripts/statusline.js       quota / credits / proxy-down indicator
│   └── skills/setup/SKILL.md       /cc-proxy:setup
├── .claude-plugin/marketplace.json
├── test/                           node --test suite
└── docs/                           ARCHITECTURE.md, OPERATIONS.md
```

The proxy entry (`bin/cc-proxy.js`) lives at the repo root, outside the cached plugin subtree, so it is referenced by absolute path via `PROXY_PATH`.

## Out of scope

- launchd / systemd service files — SessionStart auto-recovery covers the same ground without OS-specific setup.
- Plugin-skill path — superseded by the proxy.
- Full TypeScript — `// @ts-check` + JSDoc is enough.
- Request format translation — providers must speak Anthropic Messages.
