# cc-proxy — maintainer handoff

A local HTTP proxy that lets Claude Code use GLM (Z.ai), OpenRouter, and Claude
in one session. Claude Code points `ANTHROPIC_BASE_URL` at it; the proxy routes
each request **by model name** and forwards. That's the whole product. Resist
making it more than that.

Read next: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design + why),
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) (runtime facts, debugging),
[`CONTRIBUTING.md`](CONTRIBUTING.md) (add-a-provider procedure).

## Gates

`pnpm check` (= `pnpm lint && pnpm test`) must pass before any commit. CI runs
the same on push/PR. The test suite spins **real local HTTP backends** — if you
change forwarding behavior and no test fails, you haven't tested it; add one.

## Invariants (breaking one is a design decision, not a refactor)

Each is locked by tests; the test names tell you what you broke.

1. **Transparent pipe.** The proxy rewrites auth/headers only. Full inbound
   path *including the query string* reaches the upstream; bodies are forwarded
   byte-for-byte (except the thinking-strip, below). No prompt inspection, no
   rewriting, no retry/replay. → `test/server.test.js` "query string is
   preserved…", "passes through…"
2. **Stateless.** No circuit breakers, no on-disk state, no in-proxy waiting.
   Rate limits are handled by *injecting* `Retry-After` and letting the client
   back off. → "…1302 rate limit gets a Retry-After header", "1313 … no
   Retry-After"
3. **Credential isolation.** Inbound `Authorization` and `x-api-key` (the
   user's Anthropic credentials) never reach a third-party backend; the Claude
   route passes them through untouched (OAuth). Never set `ANTHROPIC_API_KEY`
   in settings templates — it shadows OAuth. → `test/providers.test.js`
   "…drops an inbound x-api-key…", `test/server.test.js` "OAuth passthrough"
4. **`claude-haiku-*` pins to Claude** so Claude Code's internal ops (titles,
   summaries) never burn paid third-party quota. → `test/router.test.js`
5. **Anthropic Messages only.** Every provider speaks the Anthropic API or a
   compatible skin. There is deliberately no OpenAI↔Anthropic translation
   layer; a provider that needs one doesn't belong here.
6. **Client abort propagates upstream.** When the client connection dies before
   the response finishes, the upstream request is destroyed — otherwise a
   cancelled turn keeps billing tokens into a dead socket. → "client abort
   mid-stream aborts the upstream request"
7. **Loopback bind by default.** The proxy injects API keys; a LAN-reachable
   bind lets any host spend your quota. `PROXY_HOST` is the explicit opt-out.
   → `test/config.test.js`

## Load-bearing map (ranked by blast radius)

| # | Thing | If broken |
|---|---|---|
| 1 | `src/proxy.js` `upstreamRequestOptions()` + `forward()` | every request in every session |
| 2 | `src/providers.js` `applyAuth()` / `buildUpstreamHeaders()` | credential leak, or auth failure everywhere |
| 3 | `hooks/proxy-lifecycle.js` `ensureProxyRunning()` | proxy never starts → all sessions `ECONNREFUSED` |
| 4 | `src/server.js` `forwardBuffered()` | GLM overflow becomes silent empty turns again |
| 5 | `src/router.js` `resolve()` | wrong backend / haiku traffic burns GLM quota |
| 6 | `.claude-plugin/plugin.json` `version` | users silently never receive updates (cache key) |
| 7 | `skills/setup/SKILL.md` | corrupts the user's `~/.claude/settings.json` |
| 8 | `src/sanitize.js` | mid-session backend switch 400s ("Invalid signature in thinking block") |

## Couplings — if you touch X, you must also update Y

- **Routing log format** `[<iso>] <model> -> <provider> <path>` (`src/server.js`) is
  **parsed** by `scripts/status.js` `parseRoutingLines()`. Change one → both + tests.
- **Version**: bump only via `pnpm version <patch|minor>` (runs
  `sync-version.mjs`, keeps `plugin.json` in step). Hand-editing one file fails
  `test/version-sync.test.js`. Users only get new code when the version changes.
- **Release coupling**: a `v<x.y.z>` tag must equal `plugin.json` == `package.json`
  == newest `## [x.y.z]` heading in `CHANGELOG.md`, and that CHANGELOG section
  must be non-empty (it becomes the GitHub release body). Enforced by
  `scripts/release-gate.mjs` (run locally: `node scripts/release-gate.mjs v<x.y.z>`),
  fired on tag push by `.github/workflows/release.yml`, locked by
  `test/release-gate.test.js`. So: write the CHANGELOG entry **before** tagging.
- **Marketplace manifest** `.claude-plugin/marketplace.json` advertises the plugin
  at `source: ./` for standalone install (`cc-proxy@cc-proxy-plugin`). Its entry
  `name` and `source` must match `plugin.json`; `test/marketplace.test.js` locks
  it. (It carries no version — the central `betmoar/ccp-market` is the primary
  channel; this is the fallback.)
- **`upstreamRequestOptions()`** in `src/proxy.js` is the single place upstream
  request options are built, shared by the streaming and buffered paths. Do not
  reintroduce a second copy in `server.js` — that duplication is how the
  query-string bug shipped twice.
- **`PROXY_PORT` default (4000)** is read independently in `src/config.js`,
  `hooks/proxy-lifecycle.js`, `scripts/statusline.js`, `scripts/status.js`.
  Change the default in all four or in none.
- **`PROXY_READY_TIMEOUT_MS` vs `hooks/hooks.json` `timeout: 10`** (seconds):
  the hook is killed at 10 s, so a ready-timeout ≥ 10000 ms silently never
  completes. Raise both together.
- **`.env.example` ↔ README env table ↔ `docs/OPERATIONS.md`**: new env vars go
  in all three.

## Traps for the unwary

- **Setup order matters.** The moment `ANTHROPIC_BASE_URL` lands in
  settings.json, *already-open* sessions retarget immediately. That's why
  `/cc-proxy:setup` starts the proxy itself (`scripts/start-proxy.js`) and why
  that script reads settings.json's `env` block explicitly — on first run those
  vars exist nowhere else. Don't "simplify" this into a plain spawn.
- **Never `rm && touch` the proxy log** while the proxy runs (orphan inode —
  output vanishes). `truncate -s 0` instead.
- **The 429 buffering exception**: `stream:true` responses are a pure pipe
  *except* status 429, which is a small JSON body (the limit short-circuits
  before SSE) and gets buffered for `Retry-After` injection. Never extend
  buffering to other statuses on the streaming path — you'd break SSE.
- **`Retry-After` injection is gated on GLM code `1302` exactly.** Its sibling
  `1113` (insufficient balance) is also a 429 but is *not retryable*; giving it
  a retry hint recreates the infinite-cooldown loop other clients hit.
- **Response inspection assumes identity encoding.** If a backend ever gzips
  the non-streaming 200-overflow or 429 bodies, `JSON.parse` fails and detection
  silently degrades to passthrough (safe, but the normalization stops working).
  See backlog.
- **CC internals may drift**: the `[1m]` model suffix, internal `claude-haiku-*`
  ids, and `ANTHROPIC_CUSTOM_MODEL_OPTION` (exactly one slot) are not public
  API. When routing looks wrong after a Claude Code update, check these first.

## Decision procedures

**Adding a provider** → follow `CONTRIBUTING.md` step-by-step. Summary: one
gated entry in `buildProviders()`, disjoint `match()`, keep `claude` last,
tests in `providers.test.js` + `router.test.js`. Never a router/server change.

**Changing the forwarding path** →
1. Build options only via `upstreamRequestOptions()`.
2. Ask: does this hold response bytes in memory? If yes, it needs a size cap
   and a passthrough escape hatch (see `NON_STREAM_BUFFER_LIMIT`,
   `RATE_LIMIT_PEEK_LIMIT` for the pattern).
3. Ask: does this add state across requests? If yes, stop — invariant 2.
4. Add an end-to-end test in `server.test.js` with a local stub backend. Cover
   both the streaming and buffered paths; they are separate code.

**Releasing** →
1. `CHANGELOG.md` entry.
2. `pnpm version patch|minor` (never hand-edit versions).
3. `pnpm check`, push. The marketplace repo (`betmoar/ccp-market`) points at
   this repo; users pick it up via `claude plugin update cc-proxy@betmoar`.

## Backlog (prioritized, with context)

1. **Thinking-strip vs Claude thinking+tool-use** (`src/sanitize.js`) — thinking
   blocks are stripped from history on *every* route, including Claude→Claude.
   The Anthropic API has historically required the preceding assistant turn's
   thinking block during tool-use loops; empirically this works today via the
   OAuth/Claude Code flow. **If the Claude route starts returning 400 "must
   start with a thinking block"**: gate the strip to non-`claude` providers and
   accept that a GLM→Claude mid-session switch then fails (the signatures are
   indistinguishable without state, and state is out — invariant 2).
2. **Content-encoding blind spot** — force `accept-encoding: identity` on
   *non-streaming* upstream requests (one line in `buildUpstreamHeaders`,
   gated on the buffered path) so overflow/429 inspection can't be blinded by
   gzip. Cheap; do it if Z.ai ever starts compressing.
3. **Dedup quota fetchers** — `scripts/status.js` and `scripts/statusline.js`
   each carry a GLM-quota and OpenRouter-credits fetcher. They already drifted
   once (missing timeout, fixed 0.3.1). Extract a shared module both import.
4. **Agent-queue wall-clock deadline** — documented out of scope in
   `docs/ARCHITECTURE.md` (last section); only matters past ~128 concurrently
   stalled upstream calls to one origin.
5. **Windows** — untested end to end (detached spawn, log paths).
