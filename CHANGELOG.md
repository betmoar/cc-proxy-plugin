# Changelog

All notable changes to cc-proxy are recorded here. Versions follow [semver](https://semver.org/); `package.json` is the single source of truth and propagates to `.claude-plugin/plugin.json` via `scripts/sync-version.mjs`.

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
