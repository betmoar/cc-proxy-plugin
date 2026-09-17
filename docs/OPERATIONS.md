# Operations

Runtime facts: where the plugin lives, how the proxy starts and gets replaced,
what each endpoint does, what Claude Code does with the proxy, and what lands
on disk. Design rationale is in [ARCHITECTURE](ARCHITECTURE.md), knobs in
[CONFIGURATION](CONFIGURATION.md), symptoms in
[TROUBLESHOOTING](TROUBLESHOOTING.md).

## Where the plugin lives

| Path | Contents | Updated by |
| --- | --- | --- |
| `~/.claude/plugins/marketplaces/betmoar/` | marketplace clone (`betmoar/ccp-market`) | `claude plugin marketplace update betmoar` |
| `~/.claude/plugins/cache/betmoar/cc-proxy/<version>/` | the whole `cc-proxy-plugin` repo | `claude plugin update cc-proxy@betmoar` |

The plugin **is** the repo root, so the cache holds `src/`, `bin/`, hooks,
scripts, skills and commands. Hooks import siblings inside the cache, and the
hook resolves `bin/cc-proxy.js` from its own tree, so it always spawns the
version it shipped with. **The cache key is the `version` in
`.claude-plugin/plugin.json`**: a new cache directory appears only when that
string changes, which is why every release bumps it.

## The proxy's lifecycle

**SessionStart.** `hooks/session-start.js` runs `ensureProxyRunning()` from
`hooks/proxy-lifecycle.js`:

1. Load `~/.env` (never overriding the process environment).
2. TCP-probe `PROXY_PORT`, 300 ms per attempt.
3. Nothing listening: spawn `bin/cc-proxy.js` **detached** with stdio redirected
   to `PROXY_LOG` (rotated to `.1` first if over `PROXY_LOG_MAX_BYTES`), then
   poll readiness for up to `PROXY_READY_TIMEOUT_MS`.
4. Something listening: `GET /_status`. A cc-proxy reporting an **older**
   version than this tree (or none) is asked to stop with `POST /_shutdown`,
   presenting `PROXY_AUTH_TOKEN` when one is set, and the current version is
   spawned once the port is free. A same-or-newer proxy is left alone (issue
   #24: a dev tree deliberately ahead of the installed plugin). Anything that
   does not answer with cc-proxy's `/_status` shape is foreign and never
   touched. An old proxy that will not vacate the port is left alone too; one
   stale proxy beats two racing for one port.

The hook always exits 0. When the proxy did not come up it emits one line of
session context (the only SessionStart channel measured to reach the model,
issue #55), and the same payload carries the picker-staleness notice when the
generated `/model` rows are behind this version. The whole thing must finish
inside the 10 s `hooks.json` timeout; see the `PROXY_READY_TIMEOUT_MS` row in
CONFIGURATION for the budget.

**Setup.** `/cc-proxy:setup` ends by running `scripts/start-proxy.js`, the
same function with an explicit environment merged from settings.json, because
on a first run nothing has injected the plumbing into the process yet.

**Between sessions.** The proxy is detached and survives the hook. If it dies
mid-session, the statusline shows `proxy down` until a new session (`/exit`,
`/resume`) re-triggers the hook. Two hooks racing to spawn is harmless: the
loser sees `EADDRINUSE` and exits.

## Endpoints

| Method and path | Does | Auth mode |
| --- | --- | --- |
| `GET /_ping` | Bare `200`, empty body, no config read. The fastest liveness check | open |
| `GET /_status` | `{ port, version, defaultBackend, providers }`. `version` is what the stale-proxy handshake compares | open |
| `POST /_shutdown` | Graceful stop: the listener closes, in-flight responses finish, the process exits when the loop drains. `GET` is `405` | requires `PROXY_AUTH_TOKEN` |
| `GET /v1/models` | The synthesized discovery list; `?dedup=identity` collapses duplicates. Other methods `405`. See [DISCOVERY](DISCOVERY.md) | requires the token |
| `POST /api/v1/services/aigc/multimodal-generation/generation` | The Qwen plan's image tunnel; `503` without `DASHSCOPE_API_KEY`. `GET` is `405` | requires the token |
| everything else | Routed on `body.model` and forwarded, `/v1/models/<id>` included | requires the token |

Every response carries an `x-request-id` (the client's, if it sent a clean
one, else a minted 8-hex-char id) that matches the `{id}` on the routing line.
The upstream's own `x-request-id` never replaces it.

Forwarding specifics that matter operationally:

- SSE streams are a straight `pipe()` with back-pressure; nothing is parsed.
- A `429` is the one status the streaming path buffers (capped at 64 KiB) to
  inject `Retry-After` on GLM `1302`.
- Non-streaming responses are buffered up to 1 MiB with `accept-encoding:
  identity` forced, so the GLM overflow signal can be read. Larger bodies flush
  and pass through uninspected.
- A client that disconnects mid-stream aborts the upstream request, so a
  cancelled turn does not keep billing.
- The upstream socket-inactivity timeout is `PROXY_UPSTREAM_TIMEOUT_MS`; the
  agent pool is bounded at 128 sockets per origin.

## Claude Code request internals

- **`ANTHROPIC_BASE_URL` re-applies to running sessions immediately.** The
  moment setup writes it, every open session retargets, which is why setup
  starts the proxy before it returns.
- **A `"model": "glm-..."` default without the proxy up** makes Claude Code hit
  Anthropic directly; its retry path then corrupts the model string past 256
  characters.
- **The haiku tier** (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) drives titles and
  summaries. Leave it on Claude; the proxy pins `claude-haiku-*` there anyway.
- **`ANTHROPIC_CUSTOM_MODEL_OPTION`** is one slot and superseded by
  `modelPicker` rows; setup removes it because Claude Code dedupes by id and
  the env wins, replacing a generated row with a bare one. The picker rows,
  the `[1m]` and `behavesAs` levers and their measurement are in
  [CONFIGURATION](CONFIGURATION.md#the-model-picker-and-context-windows).
- **Gateway model discovery** (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`)
  keeps only `claude`/`anthropic` ids and costs OAuth precedence; see
  [DISCOVERY](DISCOVERY.md#claude-codes-own-discovery-flag).

## Prompt caching

**Caching survives the proxy, and that is a measurement.** Measured 2026-08-29
through the running proxy against Z.ai: a cold turn billed `input_tokens=2816,
cache_read=0`; the identical prefix billed `input_tokens=64` with **2752 read
from cache**. The worst case, a `thinking` block deep inside the cacheable
prefix, measured cold `4426/read=0` and repeat `10/read=4416`.

It works because `stripAssistantThinking()` is **deterministic**: the same
inbound history always produces the same stripped bytes, so the backend sees a
byte-identical prefix every turn. If the strip ever depended on
request-varying state, caching would break silently and the bill would roughly
quadruple. Locked by `test/sanitize.test.js` "the strip is deterministic".
`cache_control` markers pass through untouched.

What each backend does, from OpenRouter's prompt-caching guide (multipliers
relative to the model's base input price):

| Backend | Activation | Write cost | Read cost | TTL |
| --- | --- | --- | --- | --- |
| Claude (Anthropic) | `cache_control` breakpoint, or top-level | 1.25× (5 min) / 2× (1 h) | **0.1×** | 5 min default, `"ttl":"1h"` opt-in |
| GLM (Z.ai) | automatic | free (vendor calls it limited-time) | ~0.2× | vendor-defined |
| DeepSeek | automatic | full input price | **0.1×** | vendor-defined |
| Qwen (Alibaba) | **explicit `cache_control` required** | 1.25× | **0.1×** | 5 min |
| OpenRouter (`vendor/model`) | depends on the upstream vendor | varies | varies | varies |
| LM Studio | n/a, local inference | — | — | — |

Three consequences:

- Anthropic's minimum cacheable prefix is model-dependent: 1,024 tokens for
  Sonnet 4/4.5/4.6 and Opus 4/4.1, **4,096** for Opus 4.5–4.8 and Haiku 4.5.
  Under the threshold nothing is cached, silently.
- Anthropic allows at most four `cache_control` breakpoints; Claude Code
  manages its own and the proxy adds none.
- **Switching backends mid-session throws away the cache.** Each backend caches
  independently, so a `/model` hop re-pays the full prefix. Pick a primary per
  session and switch deliberately.

## State on disk

Everything under `~/.claude/cc-proxy/` is written by the hook or an explicit
command, never on a request path. The proxy itself is stateless.

| File | Written by | Notes |
| --- | --- | --- |
| `cc-proxy.log` | the hook (spawn stdio) | routing lines; rotated to `.1` past `PROXY_LOG_MAX_BYTES` |
| `grades.json` | `/cc-proxy:bench grades` | model capability and price. **Read by the proxy at startup** and published as `grade`; an entry with an unknown grade is skipped. Restart the proxy for a refresh to show |
| `speed.jsonl` | `/cc-proxy:bench speed` | append-only route timings, one JSON object per line; each row records the proxy PID and version so a series spanning a binary swap is flagged |
| `*_cache.json` | statusline | 60 s quota and credit caches. Past the TTL the value is still served (marked `!`) and refreshed in the background |
| `*_cache.json.failed` | statusline | the last refresh of that gauge failed; no retry for 15 s. Safe to delete |
| `proxy_alive.json` | statusline | 1 s cache of the liveness probe |
| `refresh.lock` | statusline | single-flight guard for the background refresh; a lock older than 10 s is reclaimed. Safe to delete |
| `picker-stamp.json` | the hook and `render-model-picker.js` | the plugin version the `/model` rows are current for, so the staleness notice fires once per update. Delete it to see the notice again |
| `*.tmp-<pid>` | any writer above | a write in progress; every file here is staged and renamed into place |

Nothing here is required: delete any of it and the proxy still starts and
routes. `grades.json` is the one file the proxy reads, at startup only, which
is why it is config rather than state.

## Vendor documentation

Re-check these when a catalog looks wrong, before editing any curated table
(`CONTEXT_WINDOW`, `DEEPSEEK_PRICING`, `MODEL_GRADES`, `src/routes.js`):

| Backend | Docs | Notes |
| --- | --- | --- |
| Z.ai (GLM) | <https://docs.z.ai/devpack/overview> | coding-plan overview; per-model pages under `docs.z.ai/guides/llm/` carry context windows |
| DeepSeek | <https://api-docs.deepseek.com> | pricing and context windows; **no** pricing API, so `DEEPSEEK_PRICING` is transcribed by hand |
| Qwen Token Plan | <https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview> | plan tiers and included models; the plan resells GLM and DeepSeek ids too |
| LM Studio | <https://lmstudio.ai/docs/developer/anthropic-compat> | the one documented Anthropic endpoint, `/v1/messages` |

**The vendor pages are incomplete.** Both QwenCloud's public model list and the
account's own plan page omit ids the gateway serves (`glm-5.2`,
`deepseek-v4-flash-0731` both answer 200). Probe the live endpoint; `pnpm
probe:vendors` does, and prints a catalog drift report. Treat the docs as
context, not as the catalog.
