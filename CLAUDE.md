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
- **Response inspection requires identity encoding, and now enforces it.**
  `forwardBuffered()` passes `forceIdentityEncoding` to
  `upstreamRequestOptions()` → `buildUpstreamHeaders()`, which *overwrites* the
  client's `accept-encoding` with `identity` — a deliberate invariant-1 header
  exception, like the hop-by-hop drop. Without it a gzipped body fails
  `JSON.parse` and both the 200-overflow→400 conversion and the 1302
  `Retry-After` injection silently degrade to passthrough. Never pass the flag
  on the streaming path: SSE is a pure pipe and must keep the client's
  negotiated encoding. → `test/server.test.js` "buffered path forces
  accept-encoding: identity…", "…streaming path leaves accept-encoding
  untouched".
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
  Entries carry a non-standard **`context_window`** (integer tokens) when the id
  is in `CONTEXT_WINDOW`; uncurated ids OMIT it rather than send `null`
  (`"context_window" in entry` is the check). Two traps when touching it: (a)
  attach via `withContextWindow()`, which uses `Object.hasOwn` — a bare
  `CONTEXT_WINDOW[id]` lookup inherits from `Object.prototype`, and a vendor id
  of `__proto__`/`constructor` then ships `{}` or a function as the window
  (fixed 0.5.1, locked by `test/models.test.js`); (b) the response shape is
  documented in README + OPERATIONS + ARCHITECTURE and no test enforces that —
  a new wire field must be added to all three by hand.

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

## Reversed decisions

- **`context_window` is now published on `GET /v1/models` (0.5.1), reversing
  the 0.4.3-era call that it was deliberately display-layer-only.** The
  curated integer table lived in `scripts/list-models.js` as `CONTEXT_WINDOW`
  (human strings like `"128K"`), with a header comment stating "the Anthropic
  format has no context_window field ... deliberately the display layer's
  concern (not the proxy's)". That held until a second consumer needed the
  number: the `cc-reload` Claude Code plugin budgets a session's context usage
  against its model's window, and was hard-coding its own model-id table —
  the exact "same curated data in two places" drift this repo's own
  `test/couplings.test.js` exists to catch, just one repo removed. The table
  is now `CONTEXT_WINDOW` in `src/models.js` (integer tokens, not display
  strings), attached to discovery entries via `withContextWindow()` in
  `collectModels()`. ids with no curated window (OpenRouter-prefixed ids,
  `claude-*`) OMIT the field — never `null` — so a consumer can tell "unknown"
  from "known" with `"context_window" in entry`. `scripts/list-models.js`
  keeps its `CONTEXT_WINDOW` export but it is now a pure format-derivation
  (`formatContextWindow()`) of the `src/models.js` table, locked against
  redrift by `test/couplings.test.js` and `test/list-models.test.js`. If you
  are tempted to reverse this again (move it back to display-only), first
  check whether `cc-reload` (or any other consumer) still reads it — direction
  matters here too, same as `MODEL_TIERS`/cc-operator: cc-proxy **publishes**
  curated model facts, downstream plugins **consume**.

## Backlog (prioritized, with context)

1. **Thinking-strip vs Claude thinking+tool-use** (`src/sanitize.js`) — thinking
   blocks are stripped from history on *every* route, including Claude→Claude.
   The Anthropic API has historically required the preceding assistant turn's
   thinking block during tool-use loops; empirically this works today via the
   OAuth/Claude Code flow. **If the Claude route starts returning 400 "must
   start with a thinking block"**: gate the strip to non-`claude` providers and
   accept that a GLM→Claude mid-session switch then fails (the signatures are
   indistinguishable without state, and state is out — invariant 2).
2. ~~**Content-encoding blind spot**~~ — DONE (0.5.1). The buffered path forces
   `accept-encoding: identity` upstream; see the Traps bullet. Numbering kept so
   older notes referencing "backlog item N" still resolve.
3. ~~**Dedup quota fetchers**~~ — DONE (0.5.1). Endpoints, the fetch timeout, and
   response shaping (GLM quota, OpenRouter credits, DeepSeek balance) live in
   `scripts/quota.js`; both consumers import it. What stayed at the call sites is
   what genuinely differs: the statusline's 60s disk cache + stale fallback (one
   `cachedFetch()` wrapper for all three gauges) and the CLI's fail-now error
   handling. `quota.js` must never read `process.env` at module level — imports
   hoist above the consumers' `loadEnv()`. Both locked by `test/couplings.test.js`.
4. ~~**`checkPort` socket timeout**~~ — DONE (0.5.1). The lifecycle TCP probe is
   bounded at 300ms, mirroring `probePort`. Numbering kept so older notes
   referencing "backlog item N" still resolve.
5. ~~**Predictable `/tmp` defaults**~~ — DONE (0.5.1). `PROXY_LOG` and the
   statusline cache dir now default under `~/.claude/cc-proxy/` instead of
   `/tmp`, where another local user could plant a symlink our O_APPEND follows,
   or a `*_cache.json` the statusline renders as this user's quota. The default
   is spelled twice (`DEFAULT_LOG_PATH` in `hooks/proxy-lifecycle.js`, read back
   by `scripts/status.js` — scripts/ doesn't import hooks/), locked by
   `test/couplings.test.js`. `spawnProxy()` now mkdir -p's the log directory and
   falls back to discarded stdio if the open still fails: it runs inside the
   SessionStart hook, so a throw there is ECONNREFUSED for the whole session.
   Existing users: the log silently moves; the old `/tmp/cc-proxy.log` is left
   in place and never read again.
6. **Agent-queue wall-clock deadline** — documented out of scope in
   `docs/ARCHITECTURE.md` (last section); only matters past ~128 concurrently
   stalled upstream calls to one origin.
7. **Windows** — untested end to end (detached spawn, log paths).
8. **Explicit provider-prefix ids (`<provider>:<model>`)** — a way to say "this
   model, *that* backend" when one model is reachable through several. Motive is
   billing, not availability: a model reached through a plan is already paid for
   (sunk capacity), while the same model on a credit-billed backend costs real
   money per call — see the billing table below, and note it does NOT track
   first-party-ness. Live-probed 2026-08-04 against the Token Plan host with
   `DASHSCOPE_API_KEY` (re-verify before building — this vendor's catalog moves):

   Full cross-host matrix, every cell probed (`POST /v1/messages`, 1 token):

   | id | qwen plan | deepseek native | z.ai native |
   |---|---|---|---|
   | `qwen3.8-max`, `qwen3.7-plus` (+3 more) | 200 | 400 | 400 |
   | `deepseek-v4-flash-0731` | 200 | **400 — id unknown to DeepSeek** | 400 |
   | `deepseek-v4-pro` | 200 | 200 — *same id, different bill* | 400 |
   | `deepseek-v4-flash` | 403 AccessDenied | 200 | 400 |
   | `glm-5.2` | 200 | 400 | 200 — *same id, different bill* |
   | `glm-5.1`, `glm-5` | 403 | 400 | 200 |

   **The vendor's own plan page is also incomplete** — it lists five Qwen text
   models (exactly the five in `DEFAULT_QWEN_MODELS`, so that curation is
   confirmed correct), plus `deepseek-v4-pro`, and omits both `glm-5.2` and
   `deepseek-v4-flash-0731`, which serve clean 200s. Two independent tables
   (QwenCloud's public model list AND the account's own plan page) each miss
   ids the gateway actually serves. Probe, never read.

   The plan page also lists multimodal ids (`wan2.7-image*`,
   `happyhorse-1.1-*v`, `qwen-audio-3.0-tts-plus`). These DO resolve on the
   Messages endpoint — they fail on body shape (`"Input should be a valid list:
   input.messages.0"`, `"url error"`), not with `Model not exist` — so they are
   routable but unusable here: they want a different request schema, and
   invariant 5 keeps translation out. (An earlier note claimed they were absent
   from the endpoint entirely; that was probing wrong ids — `qwen-image-3.0-pro`
   and `wan2.6-t2i` don't exist, `wan2.7-image` does.)

   So the plan resells exactly one GLM (5.2) and two DeepSeek models.

   **Partially DONE in 0.5.1 — "plan before credits" is the DEFAULT now.**
   `QWEN_PLAN_RESELLS` (`src/providers.js`) routes bare `deepseek-v4-pro` to the
   plan when `DASHSCOPE_API_KEY` is set, because prepaid capacity is free at the
   margin and DeepSeek native bills metered credits. **A native plan outranks a
   resold plan**, so `glm-5.2` stays on Z.ai (itself a GLM Pro plan) — switching
   would swap prepaid pools for +6 injected tokens and nothing gained. The rule
   is plan-before-CREDITS, not plan-before-everything.
   `deepseek-v4-flash-0731` routes there too (plan-only id, DATED_ID rule).
   `deepseek-v4-flash` stays native — the plan 403s it.

   What that leaves open, and why it still needs the prefix scheme:
   - **No way back to the native route.** The plan's gateway injects a preamble
     (+79 input tokens on `deepseek-v4-pro`), so the two routes are not
     behaviourally identical. A user who tuned a prompt against native DeepSeek
     now has no spelling that reaches it. This is the strongest single
     argument for the scheme and it is now a live gap, not a hypothetical.
   - **The set is hand-curated and rots.** An id that starts 403-ing on the plan
     becomes a hard failure on a model the user could otherwise reach. Re-probe
     before each release; there is no test that can catch this offline.
   - **It only helps holders of this one plan.** A second plan (another vendor,
     another account) would need its own set, and two plans reselling the same
     id would be ambiguous again — with no way to say which.

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

   **Provider tiers = distance from the weights** (the vocabulary the cost rank
   below is built on). Tier 1 = Anthropic (OAuth passthrough, the default
   backend, pinned by invariants 3 and 4 — a *structural* position, NOT a
   capability claim; capability is item 9 and needs evals). Tier 2 = the model's
   own provider or a **contracted plan** reselling it. Tier 3 = an aggregator
   buying at market (OpenRouter). The risks that matter for a distant route —
   truncated window, substituted weights, an unmeasured deployment — scale with
   that distance, not with who sends the bill.

   **A plan IS tier 2, not tier 3.** A prepaid plan is a contract with the
   vendor for capacity, so the route is provisioned rather than brokered.
   Established by `deepseek-v4-flash-0731`: that dated id exists ONLY on the
   Qwen Token Plan host and is unknown to DeepSeek natively (400) — a reseller
   cannot mint an id the origin has never heard of, so the plan is a first-party
   arrangement with the model provider, not a middleman. Which means Qwen's
   `glm-5.2` and `deepseek-v4-*` are tier 2 as well.
   This is what makes the tiering usable: without it, cost and provenance
   conflict (the plan routes are the cheap ones AND the resold ones, so "prefer
   plan" and "distrust resold" point opposite ways). Filing plans as tier 2
   removes the conflict — the two axes now agree everywhere, and only OpenRouter
   is tier 3.
   Measured caveat, worth knowing before trusting "same weights": identical
   prompts bill DIFFERENT input tokens across routes, reproducibly (2026-08-04,
   same 9-word body):

   | id | via plan | native | delta |
   |---|---|---|---|
   | `glm-5.2` | 22 | 16 (Z.ai) | +6 |
   | `deepseek-v4-pro` | 93 | 14 (DeepSeek) | **+79** |

   The plan's gateway augments the request, and by a per-model amount — +79 on
   DeepSeek is a substantial injected preamble, not header overhead. Same
   weights, NOT the same context: a prompt tuned on one route can behave
   differently on the other, and the cheaper route is not free of cost per
   token either (you pay the preamble out of plan capacity on every call).
   So tier 2 means "provisioned by the vendor", NOT "byte-identical" — this is
   the single strongest argument for making the route EXPLICIT rather than
   letting anything pick one silently.

   Tier is a property of the **(id, backend) pair**, never of a provider:
   Qwen is tier 2 for `qwen3.8-max` and tier 2-by-plan for `glm-5.2`, while
   OpenRouter is tier 3 for everything. It therefore cannot live as one field on
   a `providers.js` entry. It also cannot be the SELECTOR — `deepseek-v4-pro` is
   reachable at tier 2 through two different backends, so a tier does not
   uniquely name one. Compression is the point of a tier; uniqueness is the
   point of a selector. Keep the explicit prefix as the selector.

   **Cost rank (belongs here, NOT in item 9).** Billing is a SEPARATE axis from
   the tier above — do not read one off the other. Three distinct plans and two
   credit pools, verified against each provider's own quota/balance endpoint
   (2026-08-04):

   | backend | billing | evidence |
   |---|---|---|
   | Z.ai (GLM) | **plan** — GLM Pro | `/quota/limit` → `level=pro`, TIME_LIMIT + TOKENS_LIMIT |
   | Qwen Token Plan | **plan** — Individual | prepaid capacity, no balance endpoint at all |
   | Claude | **plan** — Max/Pro (OAuth) | no key, no meter; the session's own quota |
   | DeepSeek native | **credits** | `/user/balance` → `topped_up_balance: $19.56` |
   | OpenRouter | **credits** | `/credits` → remaining USD |

   So preference order is: any plan route (sunk cost — the capacity is already
   bought) → credits (marginal spend, real money per call), with OpenRouter last
   among credit routes because it is also tier 3.
   Note this makes DeepSeek's own native endpoint the EXPENSIVE way to reach
   `deepseek-v4-pro` and the plan route the cheap one — the opposite of the
   intuition that first-party is cheapest. That inversion is the entire reason
   this item exists. `deepseek-v4-flash`, though, is credits-only: the plan
   403s it (see the matrix above), so it has no cheap route.
   This is a **cost** ranking, not a knowledge ranking, and the two are
   deliberately not correlated — measuring capability-per-currency is out of
   scope. `deepseek/deepseek-v4-pro` via OpenRouter is the same weights as
   native, so it cannot carry a lower *capability* grade; publishing it as one
   would be a false claim on item 9's tier field. The rank attaches to the
   **(id, backend) pair**, which is why it lives in this item: item 9 grades a
   *model*, this grades a *route*.
   Corollary: a cost rank is inert without a way to express the choice. Ranking
   tells a consumer that `deepseek/deepseek-v4-pro` is the expensive path but
   offers no way to ask for the cheap one — so the rank and the prefix scheme
   ship together, or neither is actionable.
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
10. **Reset-time display is inconsistent between the two tools** (cosmetic).
    `scripts/status.js` renders the GLM quota reset as an absolute UTC stamp
    (`resets 2026-08-04T20:43:41Z`) while `scripts/statusline.js` renders a
    relative countdown (`⏱2h15m`, via `formatResetTime`). Same fact, two
    formats — and the absolute one makes a reader in a non-UTC zone do the
    arithmetic. Neither is *wrong*: `status.js` uses `toISOString()` (epoch →
    UTC, unambiguous by construction) and the statusline subtracts two epoch
    values (a pure duration, timezone-independent). So this is a formatting
    change only — render `(resets in 2h15m)` in the CLI too, from the same
    `resetMs` it already has. Do not "fix" it as a timezone bug; there isn't one.
11. **No clock-drift check on the quota gauges.** Every countdown assumes the
    local clock agrees with the vendor's. If the machine clock is off, the
    gauge is wrong by exactly that offset and nothing says so — the reset looks
    plausible and is silently late or early.
    Previously dismissed as unfixable without cross-request state. It is not:
    **cc-proxy plus the backend calls it already makes is the source of truth**,
    and both quota endpoints return a `Date` header (verified 2026-08-04 —
    `api.z.ai` and `openrouter.ai` both send one; local clock matched to the
    second). So the reference clock is free: read `res.headers.get("date")` in
    the fetchers that are ALREADY running, compare to `Date.now()`, and mark the
    gauge when the skew exceeds ~60s.
    Two constraints that keep it honest: (a) this belongs in `scripts/quota.js`,
    which makes its own diagnostic calls — doing it in `src/` would mean the
    *proxy* inspecting responses on the forwarding path, which is invariant 2;
    (b) the threshold must stay loose, because request latency inflates apparent
    skew by up to the round-trip time — 60s is safe, 5s would false-positive on
    a slow network. Pure insurance while the clock is correct, which is exactly
    when it is cheap to write.

## Operator

@OPERATOR.md — it is this session's operating charter.
