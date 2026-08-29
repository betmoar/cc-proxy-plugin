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
- **Gateway model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`)** — measured against CC 2.1.250 (2026-08-28, full gate logic decoded from the CC bundle; see issue #44 for the raw evidence). With the flag set, CC fetches `GET {base}/v1/models?limit=1000` at startup and feeds the `/model` picker from it — **but only ids matching `/claude|anthropic/i`**: GLM/Qwen/DeepSeek/LM Studio ids are filtered out, and zero matches aborts discovery entirely. Enabling it also **requires `ANTHROPIC_AUTH_TOKEN`** (discovery skips with "no credential" otherwise), and that token demotes the claude.ai OAuth login (connectors disabled). Net: the picker gains at most the OpenRouter `~anthropic/*` and curated `claude-*` ids it mostly already has, at the cost of OAuth precedence. cc-proxy's side needs zero changes — the publishing contract already satisfies CC's `{data:[{id, display_name?}]}` validation. Documented opt-in, not a setup default.

## Model assignment

- **Primary model** — set `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` to `glm-5.2[1m]` in settings.json `env`.
- **Handoff / subagent model** — use `glm-4.7` explicitly via `/model` or a subagent's own `model` field.
- **Do NOT set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a `glm-*` id.** The haiku tier drives internal ops (titles, summaries, quick tool calls). Redirecting it to a GLM id causes those requests to arrive as `model:"glm-4.7"`, miss the `claude-haiku-*` pin, route to GLM, and burn GLM quota on overhead. Keep the haiku tier on Claude.

## Hooks

`SessionStart` runs `hooks/session-start.js`, which calls `ensureProxyRunning()` from the shared `proxy-lifecycle.js`: TCP-probe `PROXY_PORT`; if dead, spawn the proxy detached (stdio → `PROXY_LOG`) and poll readiness up to `PROXY_READY_TIMEOUT_MS` (3s). If something is listening, its `/_status` version is compared to the plugin tree's; a stale cc-proxy is replaced via `/_shutdown` + respawn (see "Stale-proxy replacement" above). The binary comes from `resolveProxyPath()` — the tree's own `bin/cc-proxy.js`, with env `PROXY_PATH` as legacy fallback; skipped cleanly when neither resolves.

The proxy is spawned **detached** (`spawn + unref`), so it survives the hook exiting. If it dies mid-session, recovery needs a new session (`/exit` + `/resume`) to re-trigger SessionStart; the statusline shows `proxy down` until then.

`/cc-proxy:setup` runs `scripts/start-proxy.js`, which calls the same `ensureProxyRunning()` so the proxy is up the moment setup finishes. The one difference from the hook: it passes an explicit `env` (merged from settings.json over `process.env`), because on a first-run setup nothing has injected the plumbing vars into the process yet. The spawned child then loads `~/.env` itself for `GLM_API_KEY`/`OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`/`DASHSCOPE_API_KEY`. `spawnProxy()` takes an optional `env` arg for this; it defaults to `process.env`, leaving the SessionStart path unchanged.

## Proxy infrastructure

- **Auth:** Claude route preserves `Authorization` (OAuth); GLM + DeepSeek set `x-api-key`; OpenRouter + Qwen + LM Studio set `Authorization: Bearer`.
- **LM Studio** (`LMSTUDIO_BASE_URL`, e.g. `http://192.168.1.50:1234` — the scheme is REQUIRED; a scheme-less value like `192.168.1.50:1234`, which is how LM Studio's own UI displays the address, is refused at startup with a `[lmstudio]` error on stderr and the backend simply is not registered, rather than failing at request time) speaks an Anthropic-compatible skin at `/v1/messages` — its only documented Anthropic endpoint, so baseUrl passthrough needs no rewriting. **Selector-only**: served ids are the user's own loaded models, whose names are arbitrary and churn with every load/unload (a live server held bare `glm-4.7-flash-…`, bare `qwen3.5-9b-…` and slash `openai/gpt-oss-20b` ids side by side, 2026-08-28), so `match()` refuses everything and `lmstudio:<id>` is the only way in. Gated on the base URL rather than a key because server auth is often off; `LMSTUDIO_API_KEY` is optional and sent as a Bearer token (LM Studio accepts `x-api-key` too; its docs' own example uses the dummy token `lmstudio`). Probed live 2026-08-28: Messages 200, `tools` → `tool_use` blocks (undocumented but working — this is the make-or-break fact for CC sessions), SSE framing standard, inbound assistant `thinking` blocks tolerated. Re-measurable via `pnpm probe:vendors` when `LMSTUDIO_BASE_URL` is set. LM Studio publishes no discovery leg in `/v1/models` — a per-machine catalog has no place in the repo's curated publishing contract.
- **SSE streaming** is straight `pipe()` passthrough with back-pressure (no parsing).
- **`/_ping`** (GET) returns a bare `200` with an empty body — the fastest possible up/down check (no config read, no serialization). Answer before any request body is buffered; query-string tolerant like `/_status`. No `content-type` (empty body).
- **`/_status`** (GET) returns `{ port, version, defaultBackend, providers }`. `version` is what the stale-proxy handshake compares against the plugin tree.
- **`/_shutdown`** (POST only; GET gets a 405) gracefully stops the proxy: listener closes, in-flight responses finish, process exits when the event loop drains. Used by the SessionStart hook to replace a stale version. Loopback-bound like everything else; carries no auth because anyone who can reach the port can already spend the injected keys.
### Vendor documentation

The authoritative pages for each backend's models, pricing, quotas, and API
shape. Re-check these when a catalog looks wrong, before editing any curated
table (`CONTEXT_WINDOW`, `DEEPSEEK_PRICING`, `MODEL_GRADES`, `src/routes.js`):

| backend | docs | notes |
|---|---|---|
| Z.ai (GLM) | <https://docs.z.ai/devpack/overview> | coding-plan overview; per-model pages under `docs.z.ai/guides/llm/` carry context windows |
| DeepSeek | <https://api-docs.deepseek.com> | pricing + context windows; **no** pricing API, so `DEEPSEEK_PRICING` is transcribed by hand |
| Qwen Token Plan | <https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview> | plan tiers and included models; the plan resells GLM and DeepSeek ids too |

Caveat learned the hard way: **the vendor pages are incomplete.** Both
QwenCloud's public model list and the account's own plan page omit ids the
gateway actually serves (`glm-5.2`, `deepseek-v4-flash-0731` both 200). Probe
the live endpoint; treat the docs as context, not as the catalog.

- **`/v1/models`** (GET; other methods 405) returns a merged, best-effort Anthropic-format model list — GLM + DeepSeek + Qwen + OpenRouter live (each with a curated offline fallback), Claude static. Each live leg is bounded by a ~3 s timeout (`modelsTimeoutMs`, not env-configurable); a failed leg is named in a non-standard `_errors` array and the response is still `200`. Synthesized, not forwarded; `/v1/models/<id>` still forwards. Entries also carry a non-standard `context_window` (integer tokens, e.g. `1000000`) when the id has a curated window; ids without one **omit** the field rather than sending `null` — check with `"context_window" in entry`. Every entry additionally carries `provider` and `tier` (route cost: `1` OAuth/Anthropic, `2` prepaid plan, `3` metered credits, `4` reseller), plus `grade` (model capability: exactly one of `Flagship`, `Strong`, `Specialist`) **when the model has been assessed** — an unassessed id **omits** `grade`, the same way it omits an unknown `context_window`, so check with `"grade" in entry` and never expect a value (most of the ~320 discovered ids have none). Since 0.6.1: unassessed ids used to ship a `Specialist` default, and `Economy` — a cost class on a capability axis — was retired. Cost and capability are independent — do not derive one from the other. Spelling follows **namespace ownership, not cost**: a backend publishes ids in its own namespace bare and every foreign id it serves under the `<provider>:<id>` lens, so `deepseek-v4-pro` is bare on DeepSeek and `qwen:deepseek-v4-pro` on the plan that also serves it. Routing is separate — the bare id resolves to the NATIVE route when one is registered, otherwise the cheapest route serving it, which need not be the owning vendor. Entries this proxy cannot actually use (multimodal ids wanting another request schema, `:batch` variants, `~latest` aliases) carry `usable: false`; the field is absent when the entry is usable, so test `entry.usable !== false`. That flag means "cannot complete a TURN", never "unreachable" — the plan's image ids are flagged and still work through the media tunnel below.
- **`/v1/models?dedup=identity`** returns one entry per MODEL rather than per id, keeping the lowest `tier` (a `usable` entry always beats an unusable one, whatever its tier). The identity is the id after its FIRST separator — `qwen:deepseek-v4-pro` → `deepseek-v4-pro`, `z-ai/glm-5.3` → `glm-5.3` — and an OpenRouter variant suffix stays attached, so `google/gemini-3.7-flash:batch` is its own identity. **Splitting on the LAST separator is the trap** and it is not hypothetical: over a live 415-id catalogue, 66 ids carry both separators and last-separator splitting merges 50 of them into one identity called `batch` spanning seven vendors. `dedup` is the only query parameter this endpoint reads; it is opt-in (no parameter → the response is unchanged) and an unrecognized value is a `400`, never a quietly un-deduped list. Motivation: the natural "one model per `provider`" panel picks the same model twice, silently (issue #39).
- **`POST /api/v1/services/aigc/multimodal-generation/generation`** is a passthrough tunnel to the Qwen plan host for its image models (`wan2.7-image`, `wan2.7-image-pro`) — the only path-routed request in the proxy, because every other route reads `body.model` and these ids match no provider predicate (issue #40). Byte-for-byte body, vendor's own response, no schema knowledge in the proxy; all it adds is the credential. Requires `DASHSCOPE_API_KEY` — with none it answers `503` rather than falling through to the default backend on the user's OAuth credentials. `GET` is `405`. `x-dashscope-sse: enable` selects the streaming path (DashScope streams via a request header, not a body field). The response carries a **signed OSS URL with an `Expires`**, not inline base64. It reaches the plan host at its ROOT — `mediaBaseUrl` in `providers.js` exists because `upstreamRequestOptions()` concatenates `baseUrl + req.url` with no rewriting, so the skin's `/apps/anthropic` baseUrl would produce `/apps/anthropic/api/v1/…` and 404. The plan's audio ids have **no working route**: measured 2026-08-25, every HTTP path 400s (`url error`) and the WebSocket task reaches `task-failed` with `[cosyvoice:]Engine error [411]` for every voice, format and language tried. Both facts are re-measurable via `pnpm probe:vendors`.
- **Orphan log inode trap:** `rm -f $PROXY_LOG && touch $PROXY_LOG` while the proxy runs leaves it writing to the deleted inode — output "disappears". Truncate in place (`truncate -s 0`) or restart the proxy; never `rm && touch` a file a live process holds open.

## Prompt caching

**Caching survives the proxy, and that is a measurement, not a hope.** Measured 2026-08-29 through the running proxy against Z.ai: a cold turn billed `input_tokens=2816, cache_read=0`; the identical prefix billed `input_tokens=64` with **2752 read from cache**. The worst case was measured too — a `thinking` block sitting *deep inside* the cacheable prefix, where the strip mutates bytes before the breakpoint: cold `4426/read=0`, repeat `10/read=4416`.

**Why the thinking-strip does not break caching.** `stripAssistantThinking()` is *deterministic*: the same inbound history always produces the same stripped bytes, so the cache key is stable across turns even though it differs from what the client sent. Caching keys on the prefix the BACKEND receives, and the proxy sends that backend a byte-identical prefix every time. This is the property the "transparent pipe … prompt-cache works unchanged" claim actually rests on — if anyone ever makes the strip depend on request-varying state (a timestamp, a counter, anything from invariant 2's forbidden list), caching breaks silently and the bill roughly quadruples with no error anywhere. Locked by `test/sanitize.test.js` "the strip is deterministic — identical input yields byte-identical output".

`cache_control` markers pass through untouched (verified: `system[].cache_control` and per-block breakpoints both survive the strip), because the strip filters whole blocks and never rewrites the ones it keeps.

**What each backend does** — from [OpenRouter's prompt-caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching), which documents the vendor behaviour behind the ids this proxy routes to. Multipliers are relative to that model's base input price:

| Backend | Activation | Write cost | Read cost | TTL |
|---|---|---|---|---|
| Claude (Anthropic) | `cache_control` breakpoint, or top-level | 1.25× (5 min) / 2× (1 h) | **0.1×** | 5 min default, `"ttl":"1h"` opt-in |
| GLM (Z.ai) | automatic | free (vendor calls it limited-time) | ~0.2× | vendor-defined |
| DeepSeek | automatic | full input price | **0.1×** | vendor-defined |
| Qwen (Alibaba) | **explicit `cache_control` required** | 1.25× | **0.1×** | 5 min |
| OpenRouter (`vendor/model`) | depends on the upstream vendor | varies | varies | varies |
| LM Studio | n/a — local inference, no billing | — | — | — |

Three consequences worth knowing:

- **Anthropic's minimum cacheable prefix is model-dependent**: 1,024 tokens for Sonnet 4/4.5/4.6 and Opus 4/4.1, but **4,096** for Opus 4.5–4.8 and Haiku 4.5. A prefix under the threshold is silently not cached — no error, just full price.
- **Anthropic allows at most four `cache_control` breakpoints.** Claude Code manages its own; the proxy neither adds nor removes any.
- **Switching backends mid-session throws away the cache.** Each backend caches independently, so a `/model` hop from GLM to Claude re-pays the full prefix at the new backend's write price. That is the single biggest avoidable token cost in normal use — pick a primary per session and switch deliberately, not reflexively. (This is also why the model-router skill's triage runs *before* work starts rather than per-turn.)

## State on disk (`~/.claude/cc-proxy/`)

The proxy itself is stateless (invariant 2). Everything here is written by the
hook or by an explicitly-invoked command — never on a request path.

| File | Written by | Notes |
| --- | --- | --- |
| `cc-proxy.log` | SessionStart hook (spawn stdio) | routing lines; rotated to `.1` past `PROXY_LOG_MAX_BYTES` |
| `grades.json` | `/cc-proxy:bench grades` | model capability + price. **Read by the proxy at startup** and published as `grade` on `/v1/models`; absent or malformed = the built-in `MODEL_GRADES` applies. An entry whose grade is not one of `Flagship`/`Strong`/`Specialist` is skipped individually (this file is hand-editable and feeds a published field). Restart the proxy for a refresh to take effect |
| `speed.jsonl` | `/cc-proxy:bench speed` | append-only route timings, one JSON object per line |
| `*_cache.json` | statusline | 60 s quota/credit caches + the 1 s proxy-liveness probe. Past the TTL the value is still SERVED (marked `!`) and refreshed in the background — the render path never makes a network call |
| `refresh.lock` | statusline | single-flight guard for that background refresh. Held for one refresh (~2 s); a lock older than 10 s is treated as abandoned and reclaimed. Safe to delete |

Nothing here is required: delete any of it and the proxy still starts and
routes. `grades.json` and `speed.jsonl` are written only when you run the
command. `grades.json` is the one file the proxy READS — at startup only, which
is why it is config rather than state (invariant 2 forbids state carried
between requests; a boot-time config read is the `~/.env` posture). A refresh
therefore needs a proxy restart to reach `GET /v1/models`.

**`bench speed` records `proxy_pid` and `proxy_version` per row on purpose.** A
series that spans a proxy restart is measuring two different binaries; without
those fields the medians silently blend. That is issue #24's failure mode in
measurement form — the reason the fields exist.

## Context-overflow handling

A **non-streaming** GLM overflow comes back as `200` with empty content and `stop_reason=model_context_window_exceeded` — which a plain pipe would forward as a silent successful empty turn. The proxy detects that one case and converts it to a `400` the user sees immediately. Everything else passes through unchanged: a native `400`/error already surfaces, and a **streaming** overflow reaches Claude Code as its own context-limit message (synthesized from the SSE `stop_reason`).

There is no automatic replay. Recovery: switch model with `/model`, `/clear`, or `/compact`. With `glm-5.2[1m]` (1M window) overflow is rare.

## Environment variables

**Every backend key is optional, GLM included** (issue #20). `buildProviders()`
registers a third-party backend only when its key is present, so an absent key
means that backend is simply not available — never a startup failure. Claude is
OAuth and needs no key, so a proxy with zero keys starts fine and routes
everything there. At startup the proxy prints one stderr line naming the active
backends; when GLM is the only one missing it says so, because an unset
`GLM_API_KEY` is more often a typo than a choice.

| Variable | Effect |
| --- | --- |
| `PROXY_HOST` | Interface the proxy binds to (default `127.0.0.1`; loopback on purpose — the proxy injects keys) |
| `PROXY_UPSTREAM_TIMEOUT_MS` | Upstream socket-inactivity timeout (default 120000); raise for 1M-context cold calls |
| `DEFAULT_BACKEND` | Backend when no model prefix matches (default `claude`) |
| `PROXY_DEBUG=1` | Log `metadata` + `system` summary per request |
| `PROXY_LOG` | Proxy stdout/stderr file (default `~/.claude/cc-proxy/cc-proxy.log`; the SessionStart hook creates the directory) |
| `PROXY_LOG_MAX_BYTES` | Rotate the log to `<log>.1` past this size on next spawn (default 5242880) |
| `PROXY_READY_TIMEOUT_MS` | SessionStart readiness-poll ceiling (default 3000) |
| `OPENROUTER_MODELS` | Comma-separated OpenRouter ids advertised by `GET /v1/models`. Unset, the leg is fetched live (curated fallback on failure); setting it pins the list and skips the fetch. Discovery only; does not affect routing |

## Debugging checklist

1. **Which version is active?** `cat ~/.claude/plugins/installed_plugins.json` — confirm `installPath` and `version`.
2. **Is the proxy up?** `lsof -ti:4000` and `curl -s http://localhost:4000/_status`.
3. **Orphan log inode?** `stat $PROXY_LOG` vs `lsof -p <pid>` — compare inodes.
4. **What did the router decide?** `[<iso>] {<reqId>} <model> -> <provider> <path>` lines (the `{<reqId>}` is the correlation id echoed to the client as `x-request-id`) in `~/.claude/cc-proxy/cc-proxy.log`.
   The trailing path disambiguates `unknown -> …` entries (a request that arrived
   with no `model` field — usually a non-Messages call like `/v1/messages/count_tokens`).

When clearing logs: `truncate -s 0 ~/.claude/cc-proxy/cc-proxy.log`. Never `rm && touch`.

### Pointing a session at a different proxy (issue #25)

An inline prefix **does not work** — settings.json's `env` block wins over the process environment:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:4400 claude -p "say ok"     # IGNORED, hits the old proxy
claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4400"}}' -p "say ok"   # works
```

The inline form fails **silently**: the turn succeeds, the answer looks right, and the request went to whichever proxy settings.json names. Measured 2026-08-14 against two bare logging listeners — the inline variant left :4400 with zero requests while the :4000 proxy log gained 4 routing lines; `--settings` logged `POST /v1/messages?beta=true model=claude-opus-5` on :4401 and 0 on :4000. The shell is not eating the variable (`node -p process.env.ANTHROPIC_BASE_URL` and `bash -c` both print it), so this is precedence.

Consequence for any A/B between two proxy builds: **read the target listener's log**, never the client's stdout, which reports success either way. A `curl` straight at the port under test avoids the question entirely, which is how issue #19 was ultimately confirmed.

## Dev loop

`pnpm proxy` runs the proxy standalone (loads repo `.env` then `~/.env`); `node --watch bin/cc-proxy.js` auto-restarts on edits. Hook/skill edits in the dev repo take effect on the next prompt only if the cache points at your repo — for marketplace installs, bump `plugin.json` version and re-run `claude plugin update`. Gates: `pnpm test`, `pnpm lint`. `pnpm probe:vendors` is a separate MANUAL check (real keys, real quota, never in CI): it re-measures the vendor behaviour that source comments assert — the class of claim the hermetic suite cannot reach. Its exit codes are deliberately four-way, so "verified nothing" can never be mistaken for "all verified": **0** everything ran and matched · **1** a vendor disagrees with a source comment (the signal it exists for) · **2** inconclusive, something was unreachable · **3** no keys, so no claim was checked. Anything wiring this into automation should treat 2 and 3 as UNVERIFIED rather than as either pass or fail.
