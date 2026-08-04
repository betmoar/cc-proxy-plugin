# Operations

Runtime facts, known traps, and debugging. For design rationale, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Plugin system

### Where the plugin lives

| Path | Contents | Updates via |
| --- | --- | --- |
| `~/.claude/plugins/marketplaces/betmoar/` | marketplace clone (`betmoar/ccp-market`) | `claude plugin marketplace update betmoar` |
| `~/.claude/plugins/cache/betmoar/cc-proxy/<version>/` | full plugin tree (the whole `cc-proxy-plugin` repo) | `claude plugin update cc-proxy@betmoar` |

**The plugin is the repo root**, so the cache holds the whole tree — `src/`, `bin/`, hooks, scripts, skills, and commands. Hooks import siblings inside the cache (`./proxy-lifecycle.js`), and the proxy entry point is resolved the same way: `resolveProxyPath()` in `hooks/proxy-lifecycle.js` uses its own tree's `bin/cc-proxy.js`, so the hook always spawns the version it shipped with. `PROXY_PATH` survives only as a legacy fallback for installs whose tree carries no `bin/`.

**Cache key = `plugin.json` version.** A new cache dir is created only when the `version` string changes. Bump it to force end users to pick up new hook/skill content.

**Stale-proxy replacement.** The proxy process outlives plugin updates (it's detached), so after an update an old version can still be serving the port. The SessionStart hook detects this: `/_status` reports the proxy's version, and `ensureProxyRunning()` compares it to the hook's own tree. On mismatch it POSTs `/_shutdown` (graceful: the listener closes, in-flight responses drain, idle keep-alive sockets are severed) and spawns the current version. A listener that doesn't speak the `/_status` contract is treated as foreign and never touched; if the old proxy doesn't vacate the port in time, it is likewise left alone — one stale proxy beats two proxies racing one port.

`${CLAUDE_PLUGIN_ROOT}` (injected when a hook runs) points to the cache path — use it in `hooks.json`.

## Claude Code request internals

- **`ANTHROPIC_BASE_URL` re-applies to running sessions immediately.** The moment `/cc-proxy:setup` writes settings.json, every open session retargets to the proxy. Setup's final step runs `scripts/start-proxy.js` to bring the proxy up before it returns, so a *fresh* session connects cleanly. An *already-open* session that retargeted in the gap before the proxy was up returns `ECONNREFUSED` until you `/exit` + `/resume` it (re-triggering SessionStart). `start-proxy.js` is idempotent — TCP-probes the port first, no-ops if already up — and reads settings.json's `env` block to feed the spawn's plumbing (the proxy reads `GLM_API_KEY` from `~/.env` at startup, while `PROXY_PATH`/`PROXY_PORT`/`PROXY_LOG` stay in settings.json `env` for the hook).
- **`ANTHROPIC_CUSTOM_MODEL_OPTION`** — exactly one slot; the id passes verbatim into `model` with validation skipped.
- **`"model": "glm-..."` default without `ANTHROPIC_BASE_URL`** makes CC hit `api.anthropic.com` directly; its retry path then corrupts the model string to >256 chars (`400 String should have at most 256 characters`). Pick the model with `/model`, or keep the proxy running.
- **`ANTHROPIC_DEFAULT_HAIKU_MODEL`** sets the id for internal ops (titles/summaries); leaving it on Claude keeps that traffic off paid quotas.

## Model assignment

- **Primary model** — set `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` to `glm-5.2[1m]` in settings.json `env`.
- **Handoff / subagent model** — use `glm-4.7` explicitly via `/model` or a subagent's own `model` field.
- **Do NOT set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a `glm-*` id.** The haiku tier drives internal ops (titles, summaries, quick tool calls). Redirecting it to a GLM id causes those requests to arrive as `model:"glm-4.7"`, miss the `claude-haiku-*` pin, route to GLM, and burn GLM quota on overhead. Keep the haiku tier on Claude.

## Hooks

`SessionStart` runs `hooks/session-start.js`, which calls `ensureProxyRunning()` from the shared `proxy-lifecycle.js`: TCP-probe `PROXY_PORT`; if dead, spawn the proxy detached (stdio → `PROXY_LOG`) and poll readiness up to `PROXY_READY_TIMEOUT_MS` (3s). If something is listening, its `/_status` version is compared to the plugin tree's; a stale cc-proxy is replaced via `/_shutdown` + respawn (see "Stale-proxy replacement" above). The binary comes from `resolveProxyPath()` — the tree's own `bin/cc-proxy.js`, with env `PROXY_PATH` as legacy fallback; skipped cleanly when neither resolves.

The proxy is spawned **detached** (`spawn + unref`), so it survives the hook exiting. If it dies mid-session, recovery needs a new session (`/exit` + `/resume`) to re-trigger SessionStart; the statusline shows `proxy down` until then.

`/cc-proxy:setup` runs `scripts/start-proxy.js`, which calls the same `ensureProxyRunning()` so the proxy is up the moment setup finishes. The one difference from the hook: it passes an explicit `env` (merged from settings.json over `process.env`), because on a first-run setup nothing has injected the plumbing vars into the process yet. The spawned child then loads `~/.env` itself for `GLM_API_KEY`/`OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`/`DASHSCOPE_API_KEY`. `spawnProxy()` takes an optional `env` arg for this; it defaults to `process.env`, leaving the SessionStart path unchanged.

## Proxy infrastructure

- **Auth:** Claude route preserves `Authorization` (OAuth); GLM + DeepSeek set `x-api-key`; OpenRouter + Qwen set `Authorization: Bearer`.
- **SSE streaming** is straight `pipe()` passthrough with back-pressure (no parsing).
- **`/_ping`** (GET) returns a bare `200` with an empty body — the fastest possible up/down check (no config read, no serialization). Answer before any request body is buffered; query-string tolerant like `/_status`. No `content-type` (empty body).
- **`/_status`** (GET) returns `{ port, version, defaultBackend, providers }`. `version` is what the stale-proxy handshake compares against the plugin tree.
- **`/_shutdown`** (POST only; GET gets a 405) gracefully stops the proxy: listener closes, in-flight responses finish, process exits when the event loop drains. Used by the SessionStart hook to replace a stale version. Loopback-bound like everything else; carries no auth because anyone who can reach the port can already spend the injected keys.
- **`/v1/models`** (GET; other methods 405) returns a merged, best-effort Anthropic-format model list — GLM + DeepSeek live, Claude + OpenRouter + Qwen static. Each live leg is bounded by a ~3 s timeout (`modelsTimeoutMs`, not env-configurable); a failed leg is named in a non-standard `_errors` array and the response is still `200`. Synthesized, not forwarded; `/v1/models/<id>` still forwards. Entries also carry a non-standard `context_window` (integer tokens, e.g. `1000000`) when the id has a curated window; ids without one **omit** the field rather than sending `null` — check with `"context_window" in entry`.
- **Orphan log inode trap:** `rm -f $PROXY_LOG && touch $PROXY_LOG` while the proxy runs leaves it writing to the deleted inode — output "disappears". Truncate in place (`truncate -s 0`) or restart the proxy; never `rm && touch` a file a live process holds open.

## Context-overflow handling

A **non-streaming** GLM overflow comes back as `200` with empty content and `stop_reason=model_context_window_exceeded` — which a plain pipe would forward as a silent successful empty turn. The proxy detects that one case and converts it to a `400` the user sees immediately. Everything else passes through unchanged: a native `400`/error already surfaces, and a **streaming** overflow reaches Claude Code as its own context-limit message (synthesized from the SSE `stop_reason`).

There is no automatic replay. Recovery: switch model with `/model`, `/clear`, or `/compact`. With `glm-5.2[1m]` (1M window) overflow is rare.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PROXY_HOST` | Interface the proxy binds to (default `127.0.0.1`; loopback on purpose — the proxy injects keys) |
| `PROXY_UPSTREAM_TIMEOUT_MS` | Upstream socket-inactivity timeout (default 120000); raise for 1M-context cold calls |
| `DEFAULT_BACKEND` | Backend when no model prefix matches (default `claude`) |
| `PROXY_DEBUG=1` | Log `metadata` + `system` summary per request |
| `PROXY_LOG` | Proxy stdout/stderr file (default `/tmp/cc-proxy.log`) |
| `PROXY_LOG_MAX_BYTES` | Rotate the log to `<log>.1` past this size on next spawn (default 5242880) |
| `PROXY_READY_TIMEOUT_MS` | SessionStart readiness-poll ceiling (default 3000) |
| `OPENROUTER_MODELS` | Comma-separated OpenRouter ids advertised by `GET /v1/models` (default: a curated verified set). Discovery only; does not affect routing |

## Debugging checklist

1. **Which version is active?** `cat ~/.claude/plugins/installed_plugins.json` — confirm `installPath` and `version`.
2. **Is the proxy up?** `lsof -ti:4000` and `curl -s http://localhost:4000/_status`.
3. **Orphan log inode?** `stat $PROXY_LOG` vs `lsof -p <pid>` — compare inodes.
4. **What did the router decide?** `<model> -> <provider> <path>` lines in `/tmp/cc-proxy.log`.
   The trailing path disambiguates `unknown -> …` entries (a request that arrived
   with no `model` field — usually a non-Messages call like `/v1/messages/count_tokens`).

When clearing logs: `truncate -s 0 /tmp/cc-proxy.log`. Never `rm && touch`.

## Dev loop

`pnpm proxy` runs the proxy standalone (loads repo `.env` then `~/.env`); `node --watch bin/cc-proxy.js` auto-restarts on edits. Hook/skill edits in the dev repo take effect on the next prompt only if the cache points at your repo — for marketplace installs, bump `plugin.json` version and re-run `claude plugin update`. Gates: `pnpm test`, `pnpm lint`.
