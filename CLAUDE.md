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
   rewriting, no retry/replay. One deliberate header exception: hop-by-hop
   headers (RFC 9110 §7.6.1 — above all `transfer-encoding`) are dropped,
   because the proxy always sends a buffered body with an exact
   `content-length`, and forwarding CL+TE together trips upstream
   request-smuggling rejection (bare 400). → `test/server.test.js` "query
   string is preserved…", "passes through…", "chunked inbound body…";
   `test/providers.test.js` "drops inbound hop-by-hop headers…"
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
- **Plugin description** is carried by three manifests (`package.json`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` entry). Change
  one → all three. Nothing at runtime reads all three, so drift is invisible
  until a user reads the stale one (package.json advertised "Z.ai and
  OpenRouter" two providers after DeepSeek and Qwen shipped). → locked by
  `test/couplings.test.js`.
- **`docs/models.html` is a generated artifact**, rendered against a *live*
  proxy (`pnpm models:html`). Two traps: (a) CI can't regenerate it, so it can
  only be pinned to the static catalog — `test/render-models.test.js` asserts
  every curated id appears and that the hero's count matches the rows drawn;
  (b) the running proxy may be older than your working tree — the version
  handshake replaces a *version*-mismatched proxy, so same-version code changes
  need a manual `POST /_shutdown` + restart before rendering, or the artifact
  silently captures the old catalog (this is how it shipped 23 of 24 models).
  After adding a model: restart the proxy, then `pnpm models:html`.
- **`upstreamRequestOptions()`** in `src/proxy.js` is the single place upstream
  request options are built, shared by the streaming and buffered paths. Do not
  reintroduce a second copy in `server.js` — that duplication is how the
  query-string bug shipped twice.
- **`PROXY_PORT` default (4000)** is read independently in `src/config.js`,
  `hooks/proxy-lifecycle.js`, `scripts/statusline.js`, `scripts/status.js`.
  Change the default in all four or in none. → locked by `test/couplings.test.js`.
- **`PROXY_READY_TIMEOUT_MS` vs `hooks/hooks.json` `timeout: 10`** (seconds):
  the hook is killed at 10 s, so a ready-timeout ≥ 10000 ms silently never
  completes. Raise both together. → locked by `test/couplings.test.js`.
- **`.env.example` ↔ README env table ↔ `docs/OPERATIONS.md`**: new env vars go
  in all three. → locked by `test/couplings.test.js`.
- **Scripts must call `loadEnv()` before any module-level `process.env` read.**
  `scripts/statusline.js` once computed its `PROXY_PORT` const above the
  `loadEnv()` call, so a port configured only in `~/.env` was silently ignored
  by the liveness probe (fixed; locked by `test/statusline.test.js` "liveness
  probe honors PROXY_PORT from ~/.env"). When adding a script, put `loadEnv()`
  directly under the imports.
- **Keys vs plumbing split.** API keys (`GLM_API_KEY`, `OPENROUTER_API_KEY`)
  live in `~/.env`; non-secret plumbing (`PROXY_PORT`, `PROXY_LOG`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_MODEL_OPTION*`) lives in settings.json
  `env`. Both are loaded by the shared `src/env.js` (`loadEnv()`): repo `.env`
  first (dev/inline), then `~/.env`, with `process.env` always winning. All key
  consumers (`bin/cc-proxy.js`, `scripts/status.js`, `scripts/statusline.js`)
  call `loadEnv()` — don't add a fourth inline `process.loadEnvFile`; that's how
  the proxy shipped without `~/.env` support (the bug behind v0.3.4).
- **Proxy binary is self-resolved; version handshake replaces stale proxies.**
  `resolveProxyPath()` (`hooks/proxy-lifecycle.js`) uses the plugin tree's own
  `bin/cc-proxy.js`; env `PROXY_PATH` is only a legacy fallback for trees
  without a bin. `/_status` carries the proxy's `version` (from
  `package.json` via `src/config.js`), and `ensureProxyRunning()` replaces a
  version-mismatched proxy via POST `/_shutdown` + respawn. Never make setup
  write `PROXY_PATH` again — a version-pinned path in settings.json is how
  users silently stopped receiving proxy updates (the running process outlives
  the plugin cache update). Foreign listeners (no `/_status` contract) are
  never killed. → `test/proxy-lifecycle.test.js` "version handshake",
  `test/start-proxy.test.js` "ignores a stale settings.json PROXY_PATH…",
  `test/server.test.js` "/_shutdown".

## Traps for the unwary

- **Plumbing can't move to `~/.env`.** The `SessionStart` hook reads
  `PROXY_PORT`/`PROXY_LOG` from `process.env` (settings.json injection)
  *before* the proxy process exists to load `~/.env`. So those stay in
  settings.json `env`; only keys (loaded by the proxy itself) go in `~/.env`.
- **Setup order matters.** The moment `ANTHROPIC_BASE_URL` lands in
  settings.json, *already-open* sessions retarget immediately. That's why
  `/cc-proxy:setup` starts the proxy itself (`scripts/start-proxy.js`) and why
  that script reads settings.json's `env` block explicitly — on first run the
  plumbing exists nowhere else. Don't "simplify" this into a plain spawn.
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
- **`/v1/models` is synthesized, not forwarded.** It's intercepted before
  `handleProxy` (like `/_status`/`/_shutdown`) but matches via parsed pathname
  (query-string tolerant), and `/v1/models/<id>` deliberately falls through to
  forwarding. GLM is the only live leg; Claude/OpenRouter are static config
  (`src/models.js`). `modelsTimeoutMs` is config-only (no env var — keep it out
  of `.env.example` or the coupling test will demand doc entries). The
  `[models]` summary log line is not parsed by `status.js`.

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
4. **`checkPort` socket timeout** (`hooks/proxy-lifecycle.js`) — the lifecycle
   TCP probe has no timer, unlike `probePort` in `scripts/statusline.js` (300 ms).
   A firewall that DROPs (not rejects) loopback traffic would hang the
   SessionStart hook until its 10 s kill. Fix: mirror probePort's
   `setTimeout(→destroy→resolve false)` pattern, ~4 lines. Deferred because no
   CI test can simulate a black-holed loopback connect — apply it alongside the
   next lifecycle change and lean on the existing open/closed-port tests.
   Done-when: checkPort carries a bounded timer and lifecycle tests stay green.
5. **Predictable `/tmp` defaults** — `PROXY_LOG=/tmp/cc-proxy.log` (append
   follows symlinks) and the statusline's `/tmp/*.json` cache fallback are
   pre-createable by other local users on a multi-user machine (garbage gauges;
   log lines appended through a planted symlink — no key material either way).
   Fix at the next minor: default both under `~/.claude/cc-proxy/`, updating
   the documented default in README/.env.example/OPERATIONS plus the hardcoded
   fallbacks in `hooks/proxy-lifecycle.js` and `scripts/status.js` together
   (env-doc coupling test will catch the doc half). Done-when: defaults live
   under $HOME and a config test asserts it.
6. **Agent-queue wall-clock deadline** — documented out of scope in
   `docs/ARCHITECTURE.md` (last section); only matters past ~128 concurrently
   stalled upstream calls to one origin.
7. **Windows** — untested end to end (detached spawn, log paths).
8. **Explicit provider-prefix ids (`<provider>:<model>`)** — a way to say "this
   model, *that* backend" when one model is reachable through several. Motive is
   billing, not availability: the Qwen Token Plan is prepaid capacity, so a model
   reached through it is already paid for, while the same model natively is
   metered credits. Live-probed 2026-08-04 against the Token Plan host with
   `DASHSCOPE_API_KEY` (re-verify before building — this vendor's catalog moves):

   | id | qwen token-plan | native |
   |---|---|---|
   | `deepseek-v4-flash-0731` | 200 | 400 — id unknown to DeepSeek |
   | `deepseek-v4-flash` | 403 AccessDenied | 200 |
   | `deepseek-v4-pro` | 200 | 200 — **same id, different bill** |
   | `glm-5.2` | 200 | 200 — **same id, different bill** |
   | `glm-5.1`, `glm-5` | 403 | 200 |

   So the plan resells exactly one GLM (5.2) and two DeepSeek models. Only
   `deepseek-v4-flash-0731` is unambiguous — the dated suffix exists nowhere else,
   so it could be routed to Qwen today by making the `deepseek` predicate exclude
   dated ids and the `qwen` one claim them; disjointness is preserved, and it is
   the cheap 80% of this item. The other two ids are the actual problem: nothing
   in the string says which account pays.

   **The trap for any prefix scheme**: OpenRouter matches on `includes("/")` and
   sits *before* qwen in the registry, so `qwen/deepseek-v4-pro` routes to
   OpenRouter, not Qwen. A slash-namespaced scheme therefore cannot be added
   without rewriting OpenRouter's predicate to an allowlist (it currently claims
   the entire slash namespace by design — that is what makes it the aggregator).
   A different separator (`qwen:deepseek-v4-pro`) sidesteps it but must survive
   Claude Code's `/model` picker and `ANTHROPIC_CUSTOM_MODEL_OPTION`, neither of
   which is public API.

   Not a fallback mechanism: "use the plan when the Z.ai quota is spent" needs
   cross-request state (invariant 2). An explicit alias the user selects is
   stateless; automatic failover is not.
9. **Publish a capability tier per model in `GET /v1/models`**, so cc-operator
   stops guessing when a model it has never seen appears in the catalog.
   Direction matters and only one direction is allowed: cc-proxy **publishes**,
   cc-operator **consumes**. cc-operator already depends on this proxy one way
   (`ops-tiers.sh --check` reads `/v1/models`), because routing is the layer
   underneath it. Reading `tiers.env` back would invert that and make neither
   plugin installable alone. A tier field on the discovery response respects the
   arrow; a tiers.env read does not.

   **The judgment already exists**: `MODEL_TIERS` in `scripts/render-models.js`
   (Flagship / Strong / Specialist / Economy, unknown ids default Specialist).
   Shipping it means moving that map from `scripts/` into `src/models.js` — a
   real decision, because today the header of that file says the tier is
   deliberately display-layer judgment, NOT src/. Moving it makes a curated
   opinion part of the API surface: every new model then needs a tier before
   discovery is correct, and a wrong one silently mis-tiers a dispatch. The
   existing `test/render-models.test.js` coverage assertion (every curated
   discovery id has a tier) becomes load-bearing rather than cosmetic.

   **The two tier vocabularies are not the same axis** — this is the part to
   think through before building. cc-proxy's are *capability grades* (how strong
   is this model); cc-operator's are *roles* (JUDGMENT / IMPLEMENT / MECHANICAL
   / RECON — what job is it for). They do not map 1:1: Specialist is a shape,
   not a rung, and a cheap-but-fast model is a good MECHANICAL pick precisely
   because it is *not* Flagship. So publish the capability grade and let
   cc-operator own the role mapping; do not publish role names from here, or
   this repo starts encoding another plugin's policy.

   Trap for the consumer side: a bound id need NOT appear in `/v1/models`.
   `claude-haiku-4-5-20251001` (the RECON default) is deliberately absent —
   invariant 4 pins haiku to Claude and discovery advertises only three Claude
   ids — so a tier lookup must tolerate a miss rather than dropping the row.

   **Grades need evals before they are published.** Today `MODEL_TIERS` is one
   person's read of vendor marketing; that is fine for an infographic and not
   fine for a field another tool dispatches on. Whatever harness is built, two
   properties matter more than the score itself: (a) it must be **re-runnable
   per model**, because the catalog changes under us — the whole reason this
   item exists is new ids arriving — so a one-off spreadsheet rots immediately;
   (b) it must record *when* and *against which id spelling*, since a dated
   alias (`deepseek-v4-flash-0731`) and its bare form can be different weights
   on different hosts (see item 8). Cheap first cut: rank within a provider
   only (vendors are internally consistent — `glm-5.2` > `glm-5.1` > `glm-4.x`
   needs no eval), and reserve measurement for CROSS-provider placement, which
   is the only part actually in doubt. Note the eval itself is billed: GLM and
   Qwen are plan capacity (effectively free to re-run), DeepSeek and OpenRouter
   are metered — so a full-matrix sweep has a real cost that a
   rank-within-provider approach mostly avoids.
