# Changelog

All notable changes to cc-proxy are recorded here. Versions follow [semver](https://semver.org/); `package.json` is the single source of truth and propagates to `.claude-plugin/plugin.json` via `scripts/sync-version.mjs`.

## [0.5.1] — 2026-08-04

### Added
- **`context_window` on `GET /v1/models` entries.** Every discovery entry for a curated id (GLM, DeepSeek native, Qwen) now carries `context_window` as an integer token count (e.g. `128000`, `1000000`) on the wire. ids with no curated window — the OpenRouter-prefixed ids (`deepseek/*`, `qwen/*`, `moonshotai/*`, `tencent/*`) and the `claude-*` ids — OMIT the field entirely; it is never emitted as `null`, so a consumer distinguishes "unknown" from "known" with `"context_window" in entry`. This is a **reversal** of the 0.4.3-era decision (recorded in `scripts/list-models.js`'s header) that context-window data was deliberately the display layer's concern, not the proxy's. Reason: a second consumer (the `cc-reload` Claude Code plugin, which budgets a session's context usage against its model's window) now needs the number programmatically, and hard-coding a duplicate model-id table in every consumer is exactly the drift failure mode this repo's own `test/couplings.test.js` exists to catch — so the curated table was promoted from the display script into `src/models.js` as the single source, and `scripts/list-models.js` now only formats it for humans (`128000` → `"128K"`). Rendered `/cc-proxy:models` output is unchanged (byte-identical) for every currently-covered id.

### Fixed
- **Content-encoding blind spot on the buffered path.** The non-streaming path `JSON.parse`s the upstream response body to convert a GLM 200-overflow into a 400 and to inject `Retry-After` on a 1302 429; both silently degraded to plain passthrough if a backend ever gzipped those bodies (the parse just fails). `forwardBuffered()` now pins `accept-encoding: identity` upstream — a deliberate invariant-1 header exception, like the existing hop-by-hop drop, and it overrides whatever the client asked for. The streaming path is untouched: SSE stays a pure pipe and keeps the client's negotiated encoding. Locked by three `test/server.test.js` cases (buffered forces identity, inbound `gzip` does not survive on the buffered path, streaming path unchanged).
- **Prototype-inherited model ids leaked a garbage `context_window`.** `withContextWindow()` looked the id up with `CONTEXT_WINDOW[entry.id]` on an object literal, so ids that name an `Object.prototype` member resolved to the inherited value instead of missing: a vendor id of `__proto__` shipped `"context_window": {}` on the wire, and `constructor`/`toString` attached a *function* (dropped by `JSON.stringify`, but present in the object `collectModels()` returns in-process). A consumer following the documented contract — `"context_window" in entry` means a token count — would then budget against an object. Model ids come from the live GLM/DeepSeek catalogs and `coerceEntry()` only rejects a falsy id, so the key space belongs to the vendor. Now uses `Object.hasOwn`; locked by `test/models.test.js` "withContextWindow omits for prototype-inherited ids".
- **`checkPort()` (`hooks/proxy-lifecycle.js`) had no socket timeout.** The lifecycle TCP probe is polled by `waitReady`/`waitGone` inside the SessionStart hook, which hooks.json kills at 10s; a connect that is DROPped rather than REJECTed (loopback behind a deny-by-drop firewall) never fires `error`, so the first poll sat until the OS connect timeout (~75s) and the hook died with no proxy and no message. Now bounded at 300ms, mirroring `probePort` in `scripts/statusline.js`, with the timer cleared on both the connect and error paths so no live handle keeps the hook's event loop alive. Locked by two `test/proxy-lifecycle.test.js` cases (bounded resolve against an unrouted RFC 5737 address, and no timer leak on either terminal path).
- **`formatContextWindow()` could render a fractional display string.** It divided without rounding, so the moment a curated value is corrected to a true power of two (`"glm-4.5": 131072` — which is what the vendor's "128K" means) the `/cc-proxy:models` column would read `"131.072K"`. Now rounds. The guard assertion was also widened from `/^\d+K$|^1M$/` to `/^\d+[KM]$/`, which rejected any legitimate future 2M model — the property being asserted is "no decimal point", not "nothing larger than 1M".

### Changed
- **Curated `CONTEXT_WINDOW` moved from `scripts/list-models.js` to `src/models.js`** as an integer-token table (`CONTEXT_WINDOW`, plus `withContextWindow()` applied in `collectModels()`). `scripts/list-models.js` re-exports a display-string `CONTEXT_WINDOW` (id → `"128K"`/`"1M"`) derived from the promoted table via `formatContextWindow()`, so the two can no longer independently drift — locked by `test/couplings.test.js` and `test/list-models.test.js`. Source provenance (docs.z.ai for GLM, api-docs.deepseek.com for DeepSeek, Alibaba Model Studio for Qwen, all dated 2026-08-04) and the "re-verify before each release" instruction moved with the table.

## [0.5.0] — 2026-08-04

### Added
- **Qwen provider (Anthropic skin, Token Plan).** QwenCloud's Anthropic-compatible endpoint (`token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`, Singapore region) is now a routed backend: bare `qwen`-prefixed model ids (e.g. `qwen3.7-max`, `qwen3.6-flash`, `qwen3.8-max`) route to Qwen with `Authorization: Bearer` auth. Opt-in via `DASHSCOPE_API_KEY` in `~/.env` (QwenCloud/DashScope's canonical key name). The `qwen` prefix match excludes slash ids (`!includes("/")`), keeping it disjoint from `glm-`, `deepseek-`, `claude-`, and OpenRouter's slash-namespaced space — a QwenCloud subscription also advertises `glm-5.2` and `deepseek-v4-*`, but those bare ids keep routing to their native backends by this disjoint match (locked by `test/router.test.js` + `test/providers.test.js`). No format translation; invariants hold. Per CONTRIBUTING, it's one gated entry in `buildProviders` — no router/server change. The base URL is plan-specific (live-verified against the account's own dashboard endpoint); the `dashscope-intl` host in the public docs rejects a Token Plan key outright — both facts are pinned in a source comment.
- **Static model discovery for Qwen.** `GET /v1/models` now includes a curated Qwen list (Qwen exposes no `/models` endpoint — it 404s, so the list is static like Claude/OpenRouter) merging in registry order with the existing best-effort fan-out. A failed leg still surfaces in `_errors` and never blocks the `200`. The five ids (`qwen3.8-max`, `qwen3.8-max-preview`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`) were live-verified HTTP 200 against the Token Plan host 2026-08-04; the list is curated empirically, not from QwenCloud's published table (which 403s/400s some listed models for a Token Plan key).
- **`qw:on` statusline segment.** A Qwen presence marker, opt-in via `DASHSCOPE_API_KEY` — deliberately not a gauge: QwenCloud exposes no quota API reachable with an API key (the console's remaining-percentage figure is authenticated by a browser login session), so the marker carries no number rather than fabricating a tier. Final bar order: `cc` → `glm` → `or` → `ds` → `qw` → `proxy down`.
- **`/cc-proxy:models` command.** Lists every model reachable through the proxy with the provider each one routes to, in a flat column. Reads the proxy's `GET /v1/models` and attributes each id through the real router (`buildProviders()` + `resolve()`) — the same logic the proxy uses, so it can't drift from actual routing; a failed live-fetch leg is flagged from `_errors`. Raw JSON remains one `curl http://127.0.0.1:4000/v1/models` away.
- **`GET /_ping` liveness probe.** A minimal `200` with an empty body — the fastest possible "is the proxy process up" check (no JSON serialization, no config read). For richer info use `GET /_status`; `/_ping` is the hot-path up/down check (`curl -sf -o /dev/null …/_ping`). No `content-type` (an empty body must not claim to be JSON), and query-string tolerant like `/_status`, so a cache-busting `?t=…` is never forwarded upstream. Loopback-bound, no auth — same posture as `/_status`.
- **`moonshotai/kimi-k3` in the OpenRouter discovery list.** Kimi K3 (Moonshot AI's 2.8T flagship) joins the curated OpenRouter allowlist for `GET /v1/models`; it routes to OpenRouter via the slash-namespaced match like the existing entries. Advertised on OpenRouter but not yet live-verified against the Anthropic skin — flagged in the source comment to verify on the next release.
- **DeepSeek provider (Anthropic skin).** DeepSeek's Anthropic-compatible endpoint (`api.deepseek.com/anthropic`) is now a routed backend: bare `deepseek-*` model ids (e.g. `deepseek-v4-pro`, `deepseek-v4-flash`) route to DeepSeek with `x-api-key` auth, the same strategy GLM uses. Opt-in via `DEEPSEEK_API_KEY` in `~/.env`. The `deepseek-` prefix is disjoint from OpenRouter's slash-namespaced `deepseek/deepseek-v4-pro` — the two never collide (locked by `test/router.test.js` + `test/providers.test.js`). No format translation; invariants hold. Per CONTRIBUTING, it's one gated entry in `buildProviders` — no router/server change.
- **Live model discovery for DeepSeek.** `GET /v1/models` now fetches DeepSeek's catalog live (`GET /models`, OpenAI shape) alongside GLM, merging in registry order with the existing best-effort fan-out (a failed leg surfaces in `_errors`, never blocks the `200`). A curated `DEEPSEEK_PRICING` table (the only static data — DeepSeek exposes no pricing API) is exported for downstream use.
- **`ds:` statusline segment.** A DeepSeek balance gauge, opt-in via `DEEPSEEK_API_KEY`, mirroring the OpenRouter/`$`-tier convention. Reads `GET /user/balance` (Bearer), 60s-cached with stale fallback. `/user/balance` is per-currency and the gauge is denominated in dollars, so **only a `USD` row drives it** — a CNY-only account renders `--` (unknown) rather than a confidently wrong dollar tier, and the reported `currency` is kept in the cache file to explain that `--`. Locked by `test/statusline.test.js` "renders ds:-- for a CNY-only balance…".

### Changed
- **Statusline `api:` → `or:`.** The OpenRouter credits gauge is renamed from the generic `api:` to `or:` — it was always OpenRouter-only, and the name became misleading now that a second provider gauge exists. Final bar order: `cc` → `glm` → `or` → `ds` → `qw` → `proxy down`.
- **Claude discovery list: `claude-opus-4-8` → `claude-opus-5`.** `GET /v1/models` now advertises Opus 5 instead of the retired Opus 4.8, matching the other Claude ids already on current-gen.

### Fixed
- **`package.json` description advertised only "Z.ai and OpenRouter"** — two providers out of date. It now matches `plugin.json` and the marketplace entry; all three are locked together by `test/couplings.test.js`, since nothing at runtime reads all three and drift is invisible until a user reads the stale one.
- **`docs/models.html` shipped 23 of 24 models.** The artifact is rendered against a live proxy, and the proxy in use predated `qwen3.8-max-preview` — the version handshake only replaces a *version*-mismatched proxy, so same-version code changes go unnoticed. Regenerated (`pnpm models:html`, a new script) and pinned: `test/render-models.test.js` asserts every curated id appears in the committed HTML and that the hero's model count equals the rows drawn.
- **Unpaired ANSI `RESET` in the `ds:` statusline segment.** The DeepSeek gauge emitted a `RESET` escape with no preceding color escape (unlike `or:`, whose gauge is colorized). Harmless on most terminals but wrong by construction; the bare `RESET` is removed.

### Removed
- **`/cc-proxy:ask`.** The one-shot GLM-5.2 question command is retired — it saw no use, and `/model`-pinned subagents cover its slot better.

## [0.4.3] — 2026-07-14

### Added
- **`GET /v1/models` discovery endpoint.** Returns a merged, best-effort list of reachable models in the Anthropic models format. GLM's catalog is fetched live (z.ai already speaks the Anthropic shape); Claude and OpenRouter come from curated static lists that advertise only generally-reachable models (the Glasswing-gated `claude-mythos-5` and the region-blocked `x-ai/grok-4.5` are deliberately omitted, the internal `claude-haiku-*` pin is excluded). A failed live leg is named in a non-standard `_errors` array and the response is still `200` (best-effort, stateless — no cache, no retry). Bounded by a per-leg timeout; inbound credentials never reach the GLM upstream. New `OPENROUTER_MODELS` env var overrides the OpenRouter allowlist (discovery only; does not affect routing). Locked by `test/models.test.js`.

## [0.4.2] — 2026-07-13

### Fixed
- **`/cc-proxy:status` plugin-root resolution, rebuilt for the two shells it actually runs in.** The command resolved its plugin root from `$CLAUDE_PLUGIN_ROOT`, but that var is injected only in **hook** context — not into a slash-command's Bash — and the `PROXY_PATH` fallback stopped being written to settings.json in 0.4.0, so with both unset the command printed `cc-proxy: cannot locate plugin root` even with the proxy healthy. Fixing it surfaced two portability traps that earlier attempts (0.4.1) tripped over, each masked by testing in the wrong environment:
  1. **A slash-command body is a template.** Claude Code substitutes `$1`..`$9` (positional args) into the body *before* the shell runs. 0.4.1's `try() { … "$1" … }` helper had every `$1` blanked to the empty string, making it a permanent no-op — the command failed *unconditionally*. Missed because the verifying test ran the block through a plain `bash -c`, which does not reproduce the harness's pre-substitution.
  2. **The command runs under the user's login shell — zsh on macOS, not bash.** zsh does not word-split an unquoted `$var`, so a `for c in $candidates` loop iterates once over the whole newline-joined blob and never matches. Missed because that fix, too, was tested via explicit `bash -c` instead of the real zsh.

  Final form uses **no positional parameters, no helper function, and a newline-fed `while IFS= read -r` loop** (which splits identically in bash and zsh) over the candidate list: explicit `CLAUDE_PLUGIN_ROOT` → legacy `PROXY_PATH` pin → marketplace cache glob (`~/.claude/plugins/cache/*/cc-proxy/*/`, newest via `sort -V -r`, matching `resolveProxyPath()`'s "own tree is current" philosophy) → dev repo, falling back to guidance + exit 1. Verified by executing the actual command body under **both zsh and bash**: resolves the installed tree and runs `status.js` exit 0; env-preferred, `PROXY_PATH`-fallback, and hard-fail paths pass in each shell.

### Added
- **`/cc-proxy:status` now shows the running proxy's version.** The `proxy: UP` line reads `proxy: UP on port 4000 (v0.4.2)`, sourced from the `version` field `/_status` already reports (added in 0.4.0 for the update handshake). Makes a stale proxy — one still serving an old version after a plugin update, before the next session restarts it — visible at a glance. A proxy too old to report a version renders the clean `UP on port <n>` line with no suffix. Locked by `test/status.test.js` (version rendered; suffix omitted when absent).

## [0.4.1] — 2026-07-13

### Fixed
- **`/cc-proxy:status` no longer misreports the plugin as unlocatable.** The command's Bash resolved the plugin root as `${CLAUDE_PLUGIN_ROOT:-$(dirname $(dirname $PROXY_PATH))}`, but `CLAUDE_PLUGIN_ROOT` is injected only in **hook** context — not into a slash-command's Bash — and `PROXY_PATH` stopped being written to settings.json in 0.4.0. With both unset, the fallback resolved to garbage and the command printed `cc-proxy: cannot locate plugin root` on every invocation, even with the proxy healthy (the SessionStart hook, which *does* get `CLAUDE_PLUGIN_ROOT`, kept the proxy running the whole time — so the failure was cosmetic but total). `commands/status.md` now uses a layered resolver: explicit `CLAUDE_PLUGIN_ROOT` → legacy `PROXY_PATH` pin → marketplace cache glob (`~/.claude/plugins/cache/*/cc-proxy/*/`, newest version wins via `sort -V`, matching the "own tree is current" resolution philosophy of `resolveProxyPath()`) → dev repo, falling back to the same guidance + exit 1 only when nothing is found. Verified under the failing condition (`env -u CLAUDE_PLUGIN_ROOT -u PROXY_PATH`): resolves the installed tree and runs `status.js` exit 0; the env-preferred, `PROXY_PATH`-fallback, and hard-fail paths all pass.

## [0.4.0] — 2026-07-13

### Fixed
- **Plugin updates now actually reach the running proxy.** Two compounding pins kept users on stale proxies forever: `/cc-proxy:setup` wrote a **version-pinned** `PROXY_PATH` (`…/cache/betmoar/cc-proxy/<version>/bin/cc-proxy.js`) into settings.json, and the SessionStart hook's port probe treated *any* listener as "already up" — so after `claude plugin update`, the new cache dir sat unused while the old detached process kept serving. Fix, in three parts:
  1. **Self-resolved binary.** `resolveProxyPath()` (`hooks/proxy-lifecycle.js`) spawns `bin/cc-proxy.js` from the hook's **own plugin tree** — by construction the installed version. A settings.json/env `PROXY_PATH` is demoted to a legacy fallback for trees without a `bin/`, and `/cc-proxy:setup` no longer writes it (and deletes an existing one).
  2. **Version handshake.** `/_status` now reports the proxy's `version`; `ensureProxyRunning()` compares it against the plugin tree's `package.json` and gracefully replaces a mismatched proxy (new state: `restarted`). A listener that doesn't speak the `/_status` contract is foreign and is never touched; if the stale proxy won't vacate the port, it is left alone (one stale proxy beats two proxies racing one port).
  3. **`POST /_shutdown`.** New loopback endpoint for that replacement: closes the listener, drains in-flight responses, severs idle keep-alive sockets, exits when the event loop empties. GET gets a `405` so a stray browser hit can't kill the proxy.

  Locked by `test/proxy-lifecycle.test.js` (resolveProxyPath precedence, version handshake: restart / same-version / foreign), `test/start-proxy.test.js` ("ignores a stale settings.json PROXY_PATH…"), and `test/server.test.js` (`/_status` version, `/_shutdown` POST/GET). Existing installs converge on next plugin update + new session: the updated hook resolves its own bin and replaces the old proxy; the stale `PROXY_PATH` left in settings.json is inert (and removed by the next `/cc-proxy:setup`).

## [0.3.5] — 2026-07-10

### Fixed
- **Inbound hop-by-hop headers are now stripped before forwarding.** `buildUpstreamHeaders` copied every inbound header (via `applyAuth`) and then set `content-length`, but never deleted `transfer-encoding`. The proxy always sends a fully-buffered body with an exact `content-length`, so forwarding an inbound `Transfer-Encoding: chunked` alongside it tripped upstream request-smuggling protections (RFC 9110 §7.6.1) — a bare `400` before the request reached any handler. Any client sending a chunked-body request failed with a misattributed upstream error (latent today: Claude Code sends `Content-Length`). All hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) are now dropped in `src/providers.js`. Locked by `test/providers.test.js` "drops inbound hop-by-hop headers" and `test/server.test.js` "chunked inbound body…" (buffered + streaming paths).
- **Statusline liveness probe honors `PROXY_PORT` from `~/.env`.** `scripts/statusline.js` evaluated its module-level `PROXY_PORT` const *before* the `loadEnv()` call lower in the file, so a port configured only in `~/.env` (a path `.env.example` documents) was silently ignored — the probe watched port 4000 while the proxy ran elsewhere, showing a false "proxy down" (or hiding a real one). `loadEnv()` now runs immediately after the imports, before any `process.env` read. Locked by `test/statusline.test.js` "liveness probe honors PROXY_PORT from ~/.env".

### Changed
- **Upstream error handling deduplicated across forward paths.** `onUpstreamError` and `parseMaybeJson` are now exported once from `src/proxy.js` and consumed by `src/server.js`, replacing two hand-copied blocks. The 502-before-headers / teardown-after-headers contract can no longer drift between the streaming and buffered paths — the same duplication class that shipped the query-string bug twice. Both 502 paths remain locked by the existing e2e timeout tests.
- **`docs/OPERATIONS.md` env table completed.** Added the four documented-elsewhere-but-missing knobs: `PROXY_HOST`, `PROXY_UPSTREAM_TIMEOUT_MS`, `DEFAULT_BACKEND`, `PROXY_LOG_MAX_BYTES`. Now enforced by a new coupling test asserting every `.env.example` key is documented in both `README.md` and `docs/OPERATIONS.md`.
- **Cross-file couplings are now test-locked** (`test/couplings.test.js`): the `PROXY_PORT` default (4000) is asserted identical across `src/config.js`, `hooks/proxy-lifecycle.js`, `scripts/status.js`, `scripts/statusline.js`; the `hooks.json` 10 s kill is asserted to exceed the lifecycle ready-poll default with headroom; and the env-doc coupling above. These were documented-only couplings that a future edit could silently break.

## [0.3.4] — 2026-07-09

### Fixed
- **`~/.env` is now the single source of truth for API keys, and the proxy loads it.** `bin/cc-proxy.js` loaded only the repo-root `.env` (never `~/.env`), so an install where `GLM_API_KEY` lived in `~/.env` exited 1 with `GLM_API_KEY is not set.` — the proxy refused to start. Keys are now loaded from `~/.env` (canonical for installs) plus the repo `.env` (dev/inline) by a shared `src/env.js` `loadEnv()` called from the proxy, `scripts/status.js`, and `scripts/statusline.js` (the latter already read `~/.env`; the other two didn't). Precedence: `process.env` (settings.json `env`) > repo `.env` > `~/.env`. Locked by `test/dotenv.test.js`. Backwards-compatible: existing setups with keys in settings.json `env` keep working until a `/cc-proxy:setup` re-run migrates them out.

### Changed
- **`/cc-proxy:setup` writes keys to `~/.env`, not settings.json `env`.** `skills/setup/SKILL.md` now writes `GLM_API_KEY`/`OPENROUTER_API_KEY` to `~/.env` (prompting for GLM, asking for OpenRouter) and migrates any legacy keys out of settings.json `env`, leaving only non-secret plumbing there. Boundary is architectural: plumbing (`PROXY_PATH`/`PROXY_PORT`/`PROXY_LOG`) must stay in settings.json `env` because the `SessionStart` hook reads it before the proxy process starts; keys can move because the proxy loads `~/.env` itself.

## [0.3.3] — 2026-07-09

### Added
- **Standalone-install marketplace** (`.claude-plugin/marketplace.json`). The plugin can now be installed straight from this repo with `claude plugin marketplace add betmoar/cc-proxy-plugin && claude plugin install cc-proxy@cc-proxy-plugin`, as a fallback to the central `betmoar/ccp-market`. Locked by `test/marketplace.test.js` (name + `source: ./` must match `plugin.json`).
- **Release workflow** (`.github/workflows/release.yml`) + gate (`scripts/release-gate.mjs`). Pushing a `v<x.y.z>` tag re-runs lint + tests and publishes a GitHub release whose body is that version's CHANGELOG section — but only if `tag == plugin.json == package.json == newest CHANGELOG heading`. The gate is runnable locally (`node scripts/release-gate.mjs v0.3.3`) and locked by `test/release-gate.test.js`.

### Changed
- **Quota/credits fetch timeout raised 800 ms → 2000 ms** and unified. Both the GLM-quota and OpenRouter-credits fetchers in `scripts/statusline.js` now share one `QUOTA_FETCH_TIMEOUT_MS` constant (was two inline `800`s that dropped both providers into stale cache on slow networks); `scripts/status.js` moved `1500 → 2000` to match, so every provider on both surfaces times out identically.
- **Routing log now records the request path.** The per-request line is `[<iso>] <model> -> <provider> <path>` (was `<model> -> <provider>`), so the `unknown -> …` entries — requests that arrive with no `model` field, typically `/v1/messages/count_tokens` — become diagnosable. `scripts/status.js` `parseRoutingLines()` keeps whole lines, so the extra field is safe. (`src/server.js`)

## [0.3.2] — 2026-07-07

### Added
- **Statusline reads `~/.env`.** The statusline is spawned as its own subprocess and inherits only `settings.json`'s `env` block — not the proxy's dotenv — so the `glm`/`api:` gauges went blank whenever `GLM_API_KEY`/`OPENROUTER_API_KEY` lived outside settings.json. It now loads `~/.env` (Node `process.loadEnvFile`) at startup; existing env vars still win, and it's a no-op when `~/.env` is absent. (`scripts/statusline.js`)

## [0.3.1] — 2026-07-05

### Fixed
- **Query strings now reach the upstream.** Both forward paths dropped the `?query` portion of the inbound URL (`/v1/messages?beta=true` arrived upstream as `/v1/messages`), silently changing API behavior. Upstream request options are now built by a single shared `upstreamRequestOptions()` in `src/proxy.js`, so the streaming and buffered paths can no longer drift apart (the bug had shipped identically in both copies).
- **Client aborts propagate upstream.** Cancelling a turn (Esc, closing a session) mid-response previously left the upstream request running to completion — billing tokens into a dead connection. The proxy now destroys the upstream request when the client goes away before the response finishes, on both paths.
- **Inbound `x-api-key` no longer leaks to third-party backends.** When Claude Code authenticates with `ANTHROPIC_API_KEY` it sends `x-api-key`; the bearer (OpenRouter) path forwarded it upstream. Both non-OAuth auth strategies now drop it alongside `Authorization`.
- **Request-stream error guard.** A client that resets the connection mid-upload emits `error` on the request stream; it now has a handler, removing the one place an unhandled (process-fatal by contract) `error` event could reach the shared long-running proxy.
- **Statusline GLM quota fetch gained an 800 ms timeout** (matching the OpenRouter fetch) so a hanging quota endpoint fails fast into the stale-cache path instead of stalling every render.
- **`bin/cc-proxy.js` fails loud and clean**: an invalid `PROXY_PORT` and `EADDRINUSE` (two SessionStart hooks racing past the TCP probe) now print a one-line diagnostic instead of an uncaught stack trace in the log.

### Added
- CI (`.github/workflows/ci.yml`): `pnpm lint` + `pnpm test` on push/PR.
- `CLAUDE.md` — maintainer handoff: invariants (each tied to the test that locks it), load-bearing map, touch-X-update-Y couplings, safe-change checklists, prioritized backlog.
- `test/version-sync.test.js` — locks `.claude-plugin/plugin.json` version to `package.json` (the plugin cache key; drift means users silently never update).
- `pnpm check` — lint + tests as one gate.

## [0.3.0] — 2026-06-28

### Removed
- **GLM offload subagents removed.** The `glm-bulk-reader`, `glm-review-code`, `glm-review-plan`, `glm-review-spec`, `glm-review-implementation`, and `glm-brainstorm` agents moved to a dedicated plugin: [`betmoar/cc-agents-plugin`](https://github.com/betmoar/cc-agents-plugin). cc-proxy now ships only the router (`/cc-proxy:status`, `/cc-proxy:ask`, the proxy server, and the statusline segment).

## [0.2.2] — 2026-06-27

### Changed
- **Compact composed-bar statusline.** Reworked `scripts/statusline.js` for use as a [cc-status](https://github.com/betmoar/cc-status-plugin) segment alongside other plugins. New format: `cc 5h:2% | glm 5h:14% | api:$$$`.
  - Renamed labels `claude`→`cc`, dropped the `glm[tier]` label.
  - Dropped the normal-mode `~reset` suffix; the reset countdown (`⏱3h11m`, red) now appears **only** when a quota is exhausted (≥100%), replacing the percentage — gated on the raw value so `99.6%` does not round up and false-trigger.
  - OpenRouter `or:$N.NN` → `api:` with `$`-tiers by digit count (`$1–9`=`$` … `$1000+`=`$$$$`, unbounded). Empty balance shows `$0`.
  - A shared `renderQuota()` helper now backs both the `cc` and `glm` segments.

### Fixed
- Non-finite numeric inputs (stale/corrupt cache, upstream schema drift) now render a `--` placeholder instead of `NaN%` or a misleading `$$$` tier — in both `renderQuota()` (usage %) and the `api:` credit renderer.
- Numeric-string epoch values (`resets_at`, `nextResetTime`) are coerced before the finiteness check, so the exhaustion countdown fires correctly regardless of JSON shape.

## [0.2.1] — 2026-06-26
- GLM `1302` rate-limit responses mapped to HTTP `429` with an injected `Retry-After: 30` header (stateless, both streaming and non-streaming paths).
- Proxy log rotation (`PROXY_LOG_MAX_BYTES`, default 5 MB, single `.1` generation).
- Setup self-start and a 5-hour reset countdown in `/cc-proxy:status`.

## [0.2.0] — 2026-06-26
- Throughput hardening: bounded keep-alive agents, upstream inactivity timeout, loopback bind (`PROXY_HOST` defaults to `127.0.0.1`).

## [0.1.1] — 2026-06-19
- `/cc-proxy:status` and `/cc-proxy:ask` commands, GLM offload subagents, plugin promoted to repo root.

## [0.1.0] — 2026-06-19
- Initial release: stateless multi-provider router for Claude Code (GLM, OpenRouter, Claude via `/model`).
