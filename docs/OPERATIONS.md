# Operations

Runtime facts, known traps, and debugging. For design rationale, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Plugin system

### Where the plugin lives

| Path | Contents | Updates via |
| --- | --- | --- |
| `~/.claude/plugins/marketplaces/betmoar/` | marketplace clone (`betmoar/ccp-market`) | `claude plugin marketplace update betmoar` |
| `~/.claude/plugins/cache/betmoar/cc-proxy/<version>/` | full plugin tree (the whole `cc-proxy-plugin` repo) | `claude plugin update cc-proxy@betmoar` |

**The plugin is the repo root**, so the cache holds the whole tree — `src/`, `bin/`, hooks, scripts, skills, commands, and agents. Hooks import siblings inside the cache (`./proxy-lifecycle.js`); the proxy entry point (`bin/cc-proxy.js`) is still referenced by absolute path via `PROXY_PATH` because the statusline runs outside plugin context, where `${CLAUDE_PLUGIN_ROOT}` is unavailable.

**Cache key = `plugin.json` version.** A new cache dir is created only when the `version` string changes. Bump it to force end users to pick up new hook/skill content.

`${CLAUDE_PLUGIN_ROOT}` (injected when a hook runs) points to the cache path — use it in `hooks.json`.

## Claude Code request internals

- **`ANTHROPIC_BASE_URL` re-applies to running sessions immediately.** The moment `/cc-proxy:setup` writes settings.json, every open session retargets to the proxy and returns `ECONNREFUSED` until it's up. `/exit` + `/resume` triggers SessionStart, which spawns it.
- **`ANTHROPIC_CUSTOM_MODEL_OPTION`** — exactly one slot; the id passes verbatim into `model` with validation skipped.
- **`"model": "glm-..."` default without `ANTHROPIC_BASE_URL`** makes CC hit `api.anthropic.com` directly; its retry path then corrupts the model string to >256 chars (`400 String should have at most 256 characters`). Pick the model with `/model`, or keep the proxy running.
- **`ANTHROPIC_DEFAULT_HAIKU_MODEL`** sets the id for internal ops (titles/summaries); leaving it on Claude keeps that traffic off paid quotas.

## Model assignment

- **Primary model** — set `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` to `glm-5.2[1m]` in settings.json `env`.
- **Handoff / subagent model** — use `glm-4.7` explicitly via `/model` or a subagent's own `model` field.
- **Do NOT set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a `glm-*` id.** The haiku tier drives internal ops (titles, summaries, quick tool calls). Redirecting it to a GLM id causes those requests to arrive as `model:"glm-4.7"`, miss the `claude-haiku-*` pin, route to GLM, and burn GLM quota on overhead. Keep the haiku tier on Claude.

## Hooks

`SessionStart` runs `hooks/session-start.js`, which calls `ensureProxyRunning()` from the shared `proxy-lifecycle.js`: TCP-probe `PROXY_PORT`; if dead, spawn the proxy detached (stdio → `PROXY_LOG`) and poll readiness up to `PROXY_READY_TIMEOUT_MS` (3s). Skipped cleanly if `PROXY_PATH` is unset.

The proxy is spawned **detached** (`spawn + unref`), so it survives the hook exiting. If it dies mid-session, recovery needs a new session (`/exit` + `/resume`) to re-trigger SessionStart; the statusline shows `proxy down` until then.

## Proxy infrastructure

- **Auth:** Claude route preserves `Authorization` (OAuth); GLM sets `x-api-key`; OpenRouter sets `Authorization: Bearer`.
- **SSE streaming** is straight `pipe()` passthrough with back-pressure (no parsing).
- **`/_status`** (GET) returns `{ port, defaultBackend, providers }`.
- **Orphan log inode trap:** `rm -f $PROXY_LOG && touch $PROXY_LOG` while the proxy runs leaves it writing to the deleted inode — output "disappears". Truncate in place (`truncate -s 0`) or restart the proxy; never `rm && touch` a file a live process holds open.

## Context-overflow handling

A **non-streaming** GLM overflow comes back as `200` with empty content and `stop_reason=model_context_window_exceeded` — which a plain pipe would forward as a silent successful empty turn. The proxy detects that one case and converts it to a `400` the user sees immediately. Everything else passes through unchanged: a native `400`/error already surfaces, and a **streaming** overflow reaches Claude Code as its own context-limit message (synthesized from the SSE `stop_reason`).

There is no automatic replay. Recovery: switch model with `/model`, `/clear`, or `/compact`. With `glm-5.2[1m]` (1M window) overflow is rare.

## Debug environment variables

| Variable | Effect |
| --- | --- |
| `PROXY_DEBUG=1` | Log `metadata` + `system` summary per request |
| `PROXY_LOG` | Proxy stdout/stderr file (default `/tmp/cc-proxy.log`) |
| `PROXY_READY_TIMEOUT_MS` | SessionStart readiness-poll ceiling (default 3000) |

## Debugging checklist

1. **Which version is active?** `cat ~/.claude/plugins/installed_plugins.json` — confirm `installPath` and `version`.
2. **Is the proxy up?** `lsof -ti:4000` and `curl -s http://localhost:4000/_status`.
3. **Orphan log inode?** `stat $PROXY_LOG` vs `lsof -p <pid>` — compare inodes.
4. **What did the router decide?** `<model> -> <provider>` lines in `/tmp/cc-proxy.log`.

When clearing logs: `truncate -s 0 /tmp/cc-proxy.log`. Never `rm && touch`.

## Dev loop

`pnpm proxy` runs the proxy standalone (loads `.env`); `node --watch bin/cc-proxy.js` auto-restarts on edits. Hook/skill edits in the dev repo take effect on the next prompt only if the cache points at your repo — for marketplace installs, bump `plugin.json` version and re-run `claude plugin update`. Gates: `pnpm test`, `pnpm lint`.
