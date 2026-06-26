# cc-proxy

A Claude Code plugin + local proxy that lets you use **GLM (Z.ai)**, **OpenRouter**, and **Claude** side-by-side in one session. Switch backends with `/model` — no restart. Zero runtime dependencies.

The proxy sits at `http://localhost:4000`, routes each request by its model name, applies the right auth per backend, and forwards to the upstream API. It stays a transparent pipe — every Claude Code tool, subagent, and prompt-cache works unchanged.

## How routing works

```
Claude Code → cc-proxy (:4000) → GLM | OpenRouter | Claude

  glm-*              → GLM         (x-api-key)
  vendor/model       → OpenRouter  (Bearer, opt-in)
  claude-*           → Claude      (OAuth passthrough)
  claude-haiku-*     → Claude      (internal ops, always)
  unknown            → default backend (claude)
```

- **Context overflow.** A non-streaming GLM overflow is returned as a `400` the user sees; a streaming overflow surfaces as Claude Code's own context-limit message (synthesized from the SSE `stop_reason`). The proxy does not retry or reroute — manage context at the session level: switch model, `/clear`, or `/compact`.
- **Thinking blocks stripped** from history so backends don't reject each other's signatures when you switch mid-session.

## Install

```bash
claude plugin marketplace add betmoar/ccp-market
claude plugin install cc-proxy@betmoar
```

## Setup

Inside Claude Code:

```
/cc-proxy:setup
```

It merges these into `~/.claude/settings.json` `env` and registers `glm-5.2[1m]` in the `/model` picker:

| Key | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` | Route API calls through the proxy |
| `GLM_API_KEY` | Your Z.ai key (forwarded as `x-api-key`) |
| `PROXY_PATH` | Absolute path to `bin/cc-proxy.js` (SessionStart hook spawns it) |

**After setup, `/exit` + `/resume` each running session** — Claude Code re-applies `ANTHROPIC_BASE_URL` immediately, so open sessions get `ECONNREFUSED` until the SessionStart hook starts the proxy.

## Usage

Switch backends with `/model`:

- `/model glm-5.2[1m]` — GLM, 1M context (also `glm-5-turbo`, `glm-4.7`)
- `/model opus` / `/model sonnet` — Claude
- An OpenRouter id like `anthropic/claude-opus-4` or `z-ai/glm-4.7` — OpenRouter (set `OPENROUTER_API_KEY` first)

Routing decisions land in `/tmp/cc-proxy.log` (`PROXY_DEBUG=1` for per-request detail).

## Commands & agents

The plugin ships slash commands and subagents that reach proxy backends **without changing your session model**.

**Commands:**

- `/cc-proxy:status` — proxy liveness, configured providers + default backend, GLM/OpenRouter quota, and recent routing decisions. Reads the proxy's `/_status` endpoint and tails `/tmp/cc-proxy.log`; works whether the proxy is up or down.
- `/cc-proxy:ask <prompt>` — a one-shot question answered by **GLM-5.2 (1M context)** for that turn only; your session model resumes on the next prompt. The clean way to ask the cheap, large-context model mid-session without `/model` switching.

**Agents** (all pinned to `glm-5.2[1m]`, read-only — invoke explicitly to offload work to GLM):

- `glm-bulk-reader` — ingest a large body of code/text using GLM's 1M context; returns a structured digest with `path:line` citations.
- `glm-review-code` / `glm-review-plan` / `glm-review-spec` / `glm-review-implementation` — cheap, **wide first-pass** review; a stronger model renders the final verdict.
- `glm-brainstorm` — divergent idea generation (breadth, not judgment).

A subagent's `model:` field is sent through the proxy verbatim, so each runs on GLM regardless of your session model. These are framed as first-pass / offload helpers — **confirm their output before acting**, since GLM is the cheaper, weaker model for judgment tasks. This is also how OpenRouter models (which have no `/model` picker slot) are reached: a subagent or command pinned to a `vendor/model` id.

## Model assignment

- **Primary model** — set `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` to `glm-5.2[1m]` in settings.json `env`. These drive the main conversational turns.
- **Handoff / subagent model** — use `glm-4.7` explicitly via `/model` or a subagent's own `model` field.
- **Do NOT set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a `glm-*` id.** Claude Code uses the haiku tier for internal ops (titles, summaries, quick tool calls). If you redirect it to a GLM id those requests arrive as `model:"glm-4.7"`, miss the `claude-haiku-*` pin, route to GLM, and burn GLM quota on overhead. Keep the haiku tier on Claude.

## Adding a provider

Routing is a data-driven registry in [`src/providers.js`](src/providers.js): each backend is one entry with a `match(model)` predicate, a base URL, and an auth strategy (`oauth` / `apiKey` / `bearer`). Adding a backend is one entry — no router changes. Providers must speak the Anthropic Messages API (or a compatible "skin"); there is no format-translation layer. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Local dev

```bash
cp .env.example .env   # set GLM_API_KEY (and OPENROUTER_API_KEY if used)
pnpm install
pnpm proxy             # standalone on PROXY_PORT (default 4000)
pnpm test && pnpm lint
```

`bin/cc-proxy.js` loads `.env` from the repo root (Node 22 `process.loadEnvFile`); vars already in the environment win, so the plugin flow (settings.json `env`) is unaffected. `.env` is gitignored.

## Statusline (optional)

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/cache/betmoar/cc-proxy/<version>/scripts/statusline.js"
  }
}
```

Shows Claude 5h quota, GLM coding quota, and OpenRouter credits (`or:$N.NN`, when `OPENROUTER_API_KEY` is set). `proxy down` in bold red when the local proxy is unreachable.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | — | Set by setup to `http://127.0.0.1:4000` |
| `GLM_API_KEY` | — | Z.ai API key |
| `OPENROUTER_API_KEY` | — | Enable OpenRouter (slash-namespaced models) |
| `PROXY_PATH` | — | Absolute path to `bin/cc-proxy.js` (SessionStart hook) |
| `PROXY_PORT` | `4000` | Proxy listen port |
| `PROXY_HOST` | `127.0.0.1` | Interface the proxy binds to (loopback by default) |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream socket-inactivity timeout; raise for 1M-context cold calls |
| `DEFAULT_BACKEND` | `claude` | Backend when no model prefix matches |
| `PROXY_READY_TIMEOUT_MS` | `3000` | Hook readiness-poll ceiling after spawn |
| `PROXY_LOG` | `/tmp/cc-proxy.log` | Proxy stdout/stderr file |
| `PROXY_DEBUG` | — | `1` logs per-request metadata |

## Troubleshooting

- **`localhost` vs the loopback bind** — the proxy binds `127.0.0.1` by default. On an IPv6-first host `localhost` resolves to `::1` before `127.0.0.1`; Node ≥20's happy-eyeballs normally falls back to `127.0.0.1` so `ANTHROPIC_BASE_URL=http://localhost:4000` still works, but new setups write `http://127.0.0.1:4000` directly to avoid depending on that fallback. If you do hit `ECONNREFUSED` to `:4000` on an older `localhost` config, switch it to `http://127.0.0.1:4000`, or set `PROXY_HOST=0.0.0.0` to bind all interfaces.
- **API errors after setup** — proxy not up yet. `/exit` + `/resume` to trigger the SessionStart hook.
- **`400 model: String should have at most 256 characters`** — a `"model": "glm-..."` default in settings.json with the proxy not running. Pick the model with `/model` instead, or start the proxy.
- **Port 4000 in use** — set `PROXY_PORT` in `env`.
- **`proxy down` in statusline** — check `lsof -ti:4000` and `/tmp/cc-proxy.log`.
- **See routing** — `PROXY_DEBUG=1`.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design and rationale.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — runtime facts, debugging, the plugin cache.

## Limitations

- macOS/Linux verified; Windows untested.
- GLM via Z.ai's Coding Plan endpoint (`https://api.z.ai/api/anthropic`); the Standard `api/paas/v4` API is not supported.
- Relies on a few Claude Code internals (`[1m]` suffix, internal `claude-haiku-*`) that aren't public API and may drift across releases.
