# Configuration

Every knob the proxy, the hook and the statusline read, where each one lives,
and the two mechanisms that need more than a variable: the off-loopback auth
token and the `/model` picker rows. `/cc-proxy:setup` writes all of this for
you; this page is the reference for what it wrote and why.

## Where a setting lives

| File | Holds | Read by |
| --- | --- | --- |
| `~/.env` | API keys, and any `PROXY_*` knob | the proxy at startup, the SessionStart hook, setup, every `scripts/*` command |
| `~/.claude/settings.json` → `env` | `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` in auth mode | Claude Code itself, which also passes them to the hook and the proxy it spawns |
| repo `.env` | a dev checkout's copy of `~/.env` | the same readers, when run from the checkout |

Precedence is process environment (which is where settings.json `env` lands)
over repo `.env` over `~/.env`; a loader never overwrites a value already set.
Rule of thumb: anything **Claude Code** must see goes in settings.json,
anything only the **proxy** reads goes in `~/.env`. Keys never go in
settings.json.

## Variables

| Variable | Default | Effect |
| --- | --- | --- |
| `GLM_API_KEY` | unset | Registers GLM (Z.ai). Bare `glm-*` ids route there via `x-api-key` |
| `OPENROUTER_API_KEY` | unset | Registers OpenRouter. Any `vendor/model` id routes there via Bearer |
| `DEEPSEEK_API_KEY` | unset | Registers DeepSeek. Bare `deepseek-*` ids route there via `x-api-key` |
| `DASHSCOPE_API_KEY` | unset | Registers the Qwen Token Plan. Bare `qwen*` ids, dated DeepSeek builds and plan resells route there via Bearer |
| `LMSTUDIO_BASE_URL` | unset | Registers LM Studio at that URL. The `http://` scheme is required; a scheme-less value is refused at startup. Reach it as `lmstudio:<id>` only |
| `LMSTUDIO_API_KEY` | `lmstudio` (dummy) | Bearer token for an LM Studio server with authentication on |
| `DEFAULT_BACKEND` | `claude` | Backend for an id nothing claims. Must be registered, or the proxy warns at startup and uses `claude` |
| `OPENROUTER_MODELS` | unset (fetch live) | Comma-separated ids to advertise on `/v1/models` instead of fetching OpenRouter's catalog. Discovery only |
| `PROXY_PORT` | `4000` | Listen port. Every tool that probes the proxy reads the same default |
| `PROXY_HOST` | `127.0.0.1` | Bind interface. Loopback on purpose: the proxy injects keys. `0.0.0.0` is the explicit opt-out; pair it with the token below |
| `PROXY_AUTH_TOKEN` | unset | Bearer or `x-api-key` token required on every request except `GET /_ping` and `GET /_status`. See [auth mode](#auth-mode-for-off-loopback-binds) |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `120000` | Socket-inactivity timeout on upstream calls. Resets as bytes flow; raise it for 1M-context cold calls |
| `PROXY_READY_TIMEOUT_MS` | `3000` | How long the SessionStart hook waits for the proxy to accept connections. The stale-proxy restart path spends it twice inside the hook's 10 s budget, so keep it under ~3900 |
| `PROXY_LOG` | `~/.claude/cc-proxy/cc-proxy.log` | Proxy stdout and stderr. The hook creates the directory. A literal `~` is not expanded |
| `PROXY_LOG_MAX_BYTES` | `5242880` | The hook rotates the log to `<log>.1` past this size before spawning |
| `PROXY_DEBUG` | unset | `1` logs a `metadata` and `system` summary per request |
| `PROXY_PATH` | unset | Legacy: an explicit `bin/cc-proxy.js` path for a tree without one. The plugin tree's own binary always wins; setup removes this key |

Claude Code side, in settings.json `env`:

| Variable | Set by setup | Effect |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Sends every API call through the proxy. Re-applied to already-open sessions immediately |
| `ANTHROPIC_AUTH_TOKEN` | only in auth mode | The proxy token, as Claude Code presents it |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` | no | Route the main turns to a third-party id; see [ROUTING](ROUTING.md#model-assignment-in-claude-code) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | no | **Leave on Claude.** A third-party id here burns quota on internal ops |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | no | A global window pin. Ignored for every id that has a picker row; see below |

## Auth mode for off-loopback binds

The proxy injects API keys and forwards your OAuth session, so a
`PROXY_HOST=0.0.0.0` bind is exposed spend unless every request must prove
itself. Set `PROXY_AUTH_TOKEN` to any long random string in `~/.env` and add the
same value as `ANTHROPIC_AUTH_TOKEN` to settings.json `env` so Claude Code
presents it.

- Everything except `GET /_ping` and `GET /_status` then requires
  `Authorization: Bearer <token>` or `x-api-key: <token>`; a mismatch is a bare
  `401` written before the body is read. The compare is constant-time.
- `POST /_shutdown` is gated too. The SessionStart hook and `/cc-proxy:setup`
  read the token from `~/.env` and present it, so a stale proxy is still
  replaced after a plugin update.
- **Claude Code has one credential slot.** With it holding the proxy token,
  `claude-*` requests reach Anthropic without your OAuth token. Auth mode is
  for third-party routing, not for Claude.

## The `/model` picker and context windows

Claude Code assumes a **200K** context window for every model id its built-in
catalog does not describe, which is every id this proxy routes, and
auto-compacts there regardless of what the backend serves. `modelPicker` rows
in settings.json are the channel that corrects it, and `/cc-proxy:setup` writes
them by running `pnpm models:picker` (`scripts/render-model-picker.js`).

Measured 2026-09-07 against CC 2.1.263 (schema read from the binary's own
validator). The two levers are orthogonal:

| Lever | Window | Catalog warning |
| --- | --- | --- |
| `[1m]` in the row's `model` | **1M** (else 200K) | unchanged |
| `behavesAs` on the row | unchanged | **suppressed** |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | applies only while CC calls the id unknown | unchanged |

The trap: `behavesAs` makes the id known, which is exactly what disables the
global pin. `[1m]` is the only window channel that survives `behavesAs`, and the
two compose: `model: "glm-5.3[1m]"` plus `behavesAs: "claude-sonnet-5"` gives 1M
with no warning. Every generated row uses that one `behavesAs` target; five
were probed and behaved identically.

What the generator guarantees:

- One row per curated id whose backend is registered, suffixed `[1m]` where the
  window is 1M or more. OpenRouter and LM Studio ids get no rows.
- It **merges**: Claude Code does no cross-source merging for `modelPicker`, so
  the generator keeps your own rows in place and replaces only the ones it
  wrote before. A `.bak` is written first, the write is atomic, a symlinked
  settings.json is written through, and the file's mode is preserved.
- It removes `ANTHROPIC_CUSTOM_MODEL_OPTION*`. Claude Code dedupes the picker by
  id and that env wins, so leaving it replaces a generated row with a bare one.
- `replaceBuiltInOptions` stays `false`, which keeps Claude's built-in rows.
- It refuses to write when no backend key is registered, or when settings.json
  does not parse.
- The rows are a snapshot. When the curated windows change, the SessionStart
  hook says so once per plugin version; re-run `/cc-proxy:setup`.

Known limitation: a window **below** 200K is inexpressible. `glm-4.5` and
`glm-4.5-air` (128K) are budgeted at 200K; the vendor truncates first.
