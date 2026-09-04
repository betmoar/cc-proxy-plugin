# cc-proxy — maintainer handoff

A local HTTP proxy that lets Claude Code use GLM (Z.ai), OpenRouter, DeepSeek,
Qwen, LM Studio (self-hosted, `lmstudio:`-selector-only), and Claude in one
session. Claude Code points `ANTHROPIC_BASE_URL` at it;
the proxy routes each request **by model name** and forwards. That's the whole
product. Resist making it more than that.

Read next: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design + why),
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) (runtime facts, debugging),
[`docs/BACKLOG.md`](docs/BACKLOG.md) (open work + why past decisions went the
way they did — probe matrices, measurements, refuted alternatives),
[`CONTRIBUTING.md`](CONTRIBUTING.md) (add-a-provider procedure).

## Gates

`pnpm check` (= `pnpm lint && pnpm test`) before any commit; CI runs the same.
The suite spins **real local HTTP backends** — if you change forwarding and no
test fails, you haven't tested it; add one.

`pnpm probe:vendors` is the MANUAL gate for claims about someone else's server.
It is never in `pnpm check` (real keys, real quota) and exits 1 when a vendor
stops behaving the way a source comment says it does. Run it when you touch
routing/forwarding, or when a probe date in a comment looks old.

## Invariants (breaking one is a design decision, not a refactor)

Each is locked by tests; the test names tell you what you broke.

1. **Transparent pipe.** Auth/headers only. Full inbound path _including the
   query string_ reaches upstream; bodies forwarded byte-for-byte. THREE body
   exceptions (thinking-strip, `<provider>:` selector-strip, `[1m]` variant-
   suffix strip) and TWO header exceptions (hop-by-hop dropped — CL+TE together
   trips smuggling rejection; and the upstream's own `x-request-id` dropped from
   every forwarded response, 0.8.0 — `writeHead` REPLACES what `setHeader` put
   there, so a vendor that emits one took over the proxy's correlation id).
   The third body strip was added in 0.6.3 on a measurement,
   not a preference: both Z.ai and the Qwen plan 400 on a suffixed id, so
   forwarding CC's display spelling means routing correctly and then failing at
   the vendor. All three strips share one shape — a spelling the CLIENT uses
   that no BACKEND knows.
   → `server.test.js` "query string is preserved…", "provider selector strip…",
   "routing log annotates the normalized id…", "keeps the proxy's x-request-id
   when the upstream sets its own…" (and its two size-cap passthrough siblings —
   each `writeHead` is a separate chance to leak the vendor's id)
2. **Stateless.** No breakers, no on-disk state, no in-proxy waiting. Rate
   limits inject `Retry-After` and let the client back off. → "…1302 … gets a
   Retry-After", "1313 … no Retry-After"
3. **Credential isolation.** Inbound `Authorization`/`x-api-key` never reach a
   third party; the Claude route passes them through (OAuth). Never set
   `ANTHROPIC_API_KEY` in settings templates — it shadows OAuth.
   → `providers.test.js` "…drops an inbound x-api-key…"
4. **`claude-haiku-*` pins to Claude** so internal ops never burn paid quota.
   The pin tests the STRIPPED tail — pinning the raw id lets
   `glm:claude-haiku-…` skip it. → `router.test.js`
5. **Anthropic Messages only.** No OpenAI↔Anthropic translation layer, ever.
   The media tunnel (`POST /api/v1/services/aigc/multimodal-generation/generation`,
   0.7.0) is NOT an exception and must not become one: it forwards a
   DashScope-shaped body byte-for-byte to a DashScope endpoint and returns the
   vendor's own response. The proxy knows neither schema; it adds the credential.
   An `/v1/images/generations` in front of every backend that can draw — the
   version of this that WOULD argue with the invariant — was declined.
   → `models.test.js` "media generation tunnel (issue #40)"
6. **Client abort propagates upstream**, or a cancelled turn bills into a dead
   socket. → "client abort mid-stream aborts the upstream request"
7. **Loopback bind by default.** `PROXY_HOST` is the explicit opt-out.
   → `config.test.js`

## Load-bearing map (ranked by blast radius)

| #   | Thing                                                       | If broken                                                               |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `src/proxy.js` `upstreamRequestOptions()` + `forward()`     | every request in every session                                          |
| 2   | `src/providers.js` `applyAuth()` / `buildUpstreamHeaders()` | credential leak, or auth failure everywhere                             |
| 3   | `hooks/proxy-lifecycle.js` `ensureProxyRunning()`           | proxy never starts → all sessions `ECONNREFUSED`                        |
| 4   | `src/server.js` `forwardBuffered()`                         | GLM overflow becomes silent empty turns again                           |
| 5   | `src/router.js` `resolve()` + `parseModelSelector()`        | wrong backend / haiku burns paid quota                                  |
| 5b  | `src/routes.js` `rankRoutes()`                              | every shared id silently takes the expensive route                      |
| 6   | `.claude-plugin/plugin.json` `version`                      | users silently never receive updates (cache key)                        |
| 7   | `skills/setup/SKILL.md`                                     | corrupts the user's `~/.claude/settings.json`                           |
| 8   | `src/sanitize.js`                                           | mid-session backend switch 400s ("Invalid signature in thinking block") |

## Couplings — if you touch X, you must also update Y

`test/couplings.test.js` is the executable copy of this table — most rows fail
there if you forget. The ones marked ⚠ have no test and drift silently.

| Touch                                                       | Also update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routing log format (`server.js`)                            | `status.js` `parseRoutingLines()` — it parses the line. Locked by `couplings.test.js` as of 0.6.3; was ⚠ prose-only before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stripVariantSuffix` / `routingIdOf` (`router.js`)          | `routes.test.js` imports the first to lock strip∘rank composition; `server.js` calls the second for the log's `(routed as …)` annotation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| a version                                                   | `pnpm version` (or `npm version`) only; `plugin.json` is the plugin cache key. Off `main` pass `--no-git-tag-version` — `scripts/version-guard.js` refuses any invocation that would tag there (#41), for npm too: `.npmrc` is overridden by a `--git-tag-version` flag and ignored outright by pnpm. Tag on main AFTER the squash                                                                                                                                                                                                                                                                                                                                                                                                                               |
| a `v<x.y.z>` tag                                            | its CHANGELOG section, non-empty, BEFORE tagging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PROXY_PORT` default                                        | `config.js`, `proxy-lifecycle.js`, `statusline.js`, `status.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PROXY_READY_TIMEOUT_MS`                                    | `hooks/hooks.json` `timeout: 10` — ≥10000 ms never completes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `buildProviders()`                                          | `PROVIDER_IDS` + `CONTRIBUTING.md` 1b — else the raw lens leaks upstream. Also the `DEFAULT_BACKEND` comment in `.env.example` (locked by `couplings.test.js` as of 0.8.3 — it read the id list off `PROVIDER_IDS`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a `scripts/*.js` entry point                                | its `main()` guard is `isDirectRun(import.meta.url)` from `scripts/direct-run.js`, never a raw `import.meta.url` vs `file://` string compare — that spelling is false on a path with a space, through a symlink, and on every Windows path, and the script then exits 0 with EMPTY stdout (measured 0.8.3). `couplings.test.js` forbids the raw form AND requires the argument to be `import.meta.url` — a bare `isDirectRun()` compares `argv[1]` to itself, so it is true for every module and `main()` runs on import. A DECODED comparison is not enough either: it is still false through a symlinked checkout, which silently disarmed `version-guard.js` and `release-gate.mjs` (measured 0.8.3 — exit 0, guard never ran). Three locks, one per spelling |
| an `await res.json()` catch in a `src/models.js` live leg   | classify `AbortError` as `timeout` BEFORE returning `invalid response shape`, in all four legs. Only the glm and deepseek legs can be tested through `_errors` — openrouter and qwen swallow a leg error and substitute the static catalog, so an assertion there passes with the fix reverted. `couplings.test.js` covers those two structurally (0.8.3)                                                                                                                                                                                                                                                                                                                                                                                                        |
| a comment that cites `file.js:NNN`                          | rewrite it to the SYMBOL. Line numbers rot on the next edit above them and nothing can execute them; four of eight were already wrong when `couplings.test.js` started rejecting the pattern (0.8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| an OpenRouter example id in a doc                           | never `anthropic/…` — discovery drops those ids on purpose (invariants 3/4: a resold Claude route bills what OAuth covers). `couplings.test.js` scans README, `.env.example`, SKILL.md, OPERATIONS, ARCHITECTURE, CONTRIBUTING                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| a new env var                                               | `.env.example` + README table + `docs/OPERATIONS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| a human-facing `pnpm` script                                | README / CONTRIBUTING / OPERATIONS — a manual gate nobody knows about is not a gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a comment claiming an input→output                          | write it as `@doctest fn(<json>) -> <json>`; `doc-examples.test.js` runs it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| a comment claiming vendor behaviour                         | a case in `scripts/probe-vendors.mjs`, so it can be re-measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| the outbound-id contract (`upstreamModel`)                  | the prose describing it — `couplings.test.js` fails on either drifting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| the plugin description                                      | `package.json`, `plugin.json`, `marketplace.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| an upstream request option                                  | `upstreamRequestOptions()` only — a 2nd copy shipped the query-string bug twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a script's `process.env` read                               | `loadEnv()` directly under the imports, or `~/.env` is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `QWEN_PLAN_RESELLS` (`providers.js`)                        | `QWEN_PLAN_ALSO` (`render-models.js`) must cover it, or the Qwen card under-reports the plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| a statusline gauge                                          | the `GAUGES` table in `statusline.js` — the render path and the background refresher both read it; adding to one only means the gauge shows but never refreshes (or refreshes but never shows)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ⚠ `MODEL_GRADES`                                            | nothing — it is the only copy IN THE REPO, but `gradeOf()` overlays `~/.claude/cc-proxy/grades.json` on top of it, so a reader is not reading this table alone. `render-models.js` re-exports it for coverage assertions only — rendering goes through `gradeOf()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `identityOf` (`models.js`)                                  | its `@doctest` lines — and keep an example carrying TWO slashes, or `indexOf`→`lastIndexOf` passes the whole suite (measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a static catalog                                            | confirm the id has a `ROUTES` entry. Locked by `couplings.test.js` ("every bare static-catalog id…") as of 0.8.1; was ⚠ before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| the `/v1/models` wire shape                                 | README + OPERATIONS + ARCHITECTURE, by hand — including `?dedup=identity`. Field NAMES are locked by `couplings.test.js` (read from the ModelEntry typedef) as of 0.8.1; the prose describing their semantics still drifts silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a handler dispatched without `await`/`.catch` (`server.js`) | wrap its whole body in a `try` — an unhandled rejection TERMINATES the shared process, and no `uncaughtException` handler exists. `handleModels` is the worked example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ⚠ `mediaBaseUrl` (`providers.js`)                           | the media branch in `server.js` is its only reader; changing one alone silently routes at the skin, which 404s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Three questions, three places, never merged: a **catalog** says what a backend
serves, **`ROUTES`** who serves it cheapest, **`ownsId`** how it is spelled.
`grade` (capability) and `tier` (cost) are independent — tier 4 + Flagship is
normal. → [`docs/BACKLOG.md`](docs/BACKLOG.md)

**`GET /v1/models` is a PUBLISHING contract, and the arrow only points one
way.** cc-proxy publishes curated model facts; downstream plugins consume them.
`context_window` exists on the response so `cc-reload` can budget a session
against the real window instead of hard-coding its own id table; `grade` exists
so `cc-operator` can dispatch by model strength instead of guessing. Both moved
out of a display layer into `src/models.js` for exactly that reason, and both
are therefore **API surface, not a local opinion** — and both OMIT their field
rather than inventing a value: an id with no curated window has no
`context_window`, an id nobody assessed has no `grade`. `"grade" in entry` and
`"context_window" in entry` are the checks, so a consumer can tell "unknown"
from "known", and neither key is ever `null`. (Until 0.6.1 an unassessed id
shipped `Specialist`, which read as a verdict where it was an absence — 299 of 320. `Economy` was retired in the same change: a cost class has no business on
the capability axis.) Never read a consumer's file back to decide
anything here: that inverts the arrow and makes neither plugin installable
alone. Adding a field means updating the three docs that describe the shape —
`couplings.test.js` enforces the field NAMES appearing in all three (read from
the ModelEntry typedef, so a new field joins the lock when it is typed); the
prose explaining what a field means is still yours to keep true.

## Traps for the unwary

- **A comment that states behaviour rots like untested code, but louder.** The
  #34 fix reversed its own contract mid-review (the `[1m]` suffix went from
  "preserved upstream" to "stripped upstream" once both vendors were measured
  rejecting it) and left THREE comments asserting the old one — a JSDoc, a test
  block comment, and `resolve()`'s numbered step list. Every one was caught by a
  reviewer, none by a test, the last only after approval. Three mechanisms now
  exist, and which one you need depends on the claim:
  - _"this input yields that output"_ → a `@doctest` line, EXECUTED by
    `test/doc-examples.test.js`. Prose keeps the why; the falsifiable half moves.
  - _"this vendor does X"_ → a case in `scripts/probe-vendors.mjs`, re-runnable
    on demand. Untestable offline is not the same as unfalsifiable.
  - _"the contract is X"_ → a lock in `couplings.test.js` ("no comment still
    promises the pre-reversal upstream contract") pinning the code side and
    denying phrasings that only hold under the old contract.
- **Plumbing can't move to `~/.env`** — the SessionStart hook reads
  `PROXY_PORT`/`PROXY_LOG` before the proxy exists to load it. Keys in `~/.env`,
  plumbing in settings.json `env`.
- **Setup order matters.** `ANTHROPIC_BASE_URL` retargets _already-open_
  sessions instantly, so `/cc-proxy:setup` starts the proxy itself and reads
  settings.json's `env` explicitly. Don't "simplify" it into a plain spawn.
- **An inline `ANTHROPIC_BASE_URL=… claude` prefix is SILENTLY IGNORED** —
  settings.json's `env` block overrides the process environment, and the run
  looks like a success while hitting the OLD proxy. Use
  `claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<port>"}}'`,
  which does work. Measured 2026-08-14 against two bare logging listeners
  (issue #25): the inline variant printed `ok` with ZERO requests on :4400 and
  +4 routing lines on the :4000 proxy; `--settings` logged
  `POST /v1/messages?beta=true model=claude-opus-5` on :4401 with 0 on :4000.
  The variable is NOT being dropped by the shell — `node -p process.env…` and
  `bash -c` both see it — so this is precedence, not plumbing. Any A/B between
  two proxy builds must read the TARGET LISTENER's log, never the client's
  stdout, which reports success either way.
- **Never `rm && touch` the proxy log** while it runs (orphan inode);
  `truncate -s 0`.
- **429 is the ONE buffering exception on the streaming path.** Extending it to
  other statuses breaks SSE. And it is gated on GLM `1302` exactly — sibling
  `1113` (insufficient balance) is a 429 but NOT retryable; a hint there
  recreates an infinite cooldown loop.
- **Response inspection requires identity encoding.** `forwardBuffered()` forces
  it; without it a gzipped body fails `JSON.parse` and overflow/rate-limit
  handling degrades to passthrough, silently. Never on the streaming path.
- **A slash command has NO positional parameters.** Only `$ARGUMENTS` and `$1`
  are substituted, TEXTUALLY, before any shell runs — `$2`/`$3` expand to
  nothing, and `$1` may be the LAST token (`bench speed --report` → `$1` =
  `--report`). Use `set -- $ARGUMENTS`. Untestable offline: a shell test of the
  SOURCE passes while the SUBSTITUTED body fails. → `commands/bench.md`
- **A session SNAPSHOTS command bodies at startup**, even under `--plugin-dir .`
  — editing a command and re-running it tests the OLD body, and the expansion
  looks plausible either way. Verify which body you have (md5 the expansion vs
  the file, or probe with a signature only the new version has), then `/exit`
  and relaunch. For anything billed, pick an observable that separates the paths
  first: `bench speed --report` is read-only, a live run appends.
- **The statusline render path must never touch the network.** cc-status kills
  a renderer at `CC_STATUS_TIMEOUT` (default 2s) and a killed renderer emits
  ZERO bytes, so the segment vanishes from the bar entirely. Measured: serial
  fetches made a cold render 1478–2216ms, 5/15 over the kill. An expired cache
  is SERVED and refreshed by a DETACHED child — `detached:true` is load-bearing,
  because the composer kills the whole process GROUP and an ordinary child dies
  with it (probe: cache written YES detached / NO non-detached). The
  single-flight `refresh.lock` is the other half: without it every render in the
  ~2s window spawns its own refresher (measured 5 fetch rounds per expiry, vs 1).
- **A lock's stale reclaim is check-then-act, and `rename()` does not fix that.**
  `rename` is atomic about the PATH, not the FILE, so a racer that arrives after
  the winner relocked renames the winner's FRESH lock away and takes over —
  measured at 5 double-grants in 60 rounds × 12 processes. Verifying the moved
  file's **inode** looked like the fix and is the same trap one platform over:
  ext4/overlayfs RECYCLE a freed inode for the next create (measured on CI's
  image), so the check must be inode **and mtime** — rename preserves mtime and
  a relock is stamped now. And an UNSERIALIZED reclaim still double-grants with
  three contenders (the loser holds the winner's renamed-away lock while the
  path sits empty for a fast-path `wx`), so reclaimers serialize on a claim
  file and restore via `link()`, which refuses to overwrite
  (`scripts/refresh-lock.js` — its header carries the full defect ladder).
  The second trap is the test: the broken variants are green in ~92% of racing
  runs, so a statistical race test proves nothing and any CI sample passes it.
  The lock lives in its own module purely to give the tests seams that force
  each interleaving deterministically.
- **A test that kills a subprocess must kill it UNCONDITIONALLY.** A watchdog
  cancelled after `wait` returns never fires once the thing under test gets
  fast, so the test passes for the wrong reason — `detached:false` survived the
  first version of the group-kill test. Sleep past the fast path's exit, then
  kill outright. → `statusline.test.js` "refresh survives the composer's
  process-group kill"
- **CC internals may drift**: `[1m]` suffix, `claude-haiku-*` ids,
  `ANTHROPIC_CUSTOM_MODEL_OPTION` (one slot) are not public API — check these
  first when routing looks wrong after a CC update.
- **A script that prints nothing and exits 0 may never have run.** The operator
  scripts are both commands and importable modules, so `main()` sits behind a
  direct-run guard — and the guard is the first suspect when `/cc-proxy:status`
  or `/cc-proxy:models` is silent, BEFORE "the proxy is down". The old spelling
  compared `import.meta.url` to a raw `file://` + path string, which is false on
  any path with a space/`%`/`#`, through a symlink (the main module's URL is the
  realpath, `argv[1]` is not), and on Windows. DECODING the path fixes the first
  and third and NOT the symlink — the 0.8.3 audit fixed five scripts and left
  three "already-correct" decoded ones, two of which (`version-guard.js`,
  `release-gate.mjs`) were the release procedure's only automated refusals and
  exited 0 without running through a symlinked checkout. Use `isDirectRun()`,
  which realpaths both sides; the lifecycle
  probes had the sibling shape (settle only on `'end'`, so a mid-body cut hung
  the hook to its 10 s kill) — a process that goes quiet is a defect, not a hint.
- **`/v1/models` is synthesized**, but `/v1/models/<id>` is forwarded. Uncurated
  ids OMIT `context_window` rather than sending `null`; attach via
  `withContextWindow()` — a bare lookup inherits from `Object.prototype` and
  ships a function for an id named `constructor`. The wire shape is documented
  in three files with no test enforcing it.

## Decision procedures

**Adding a provider** → `CONTRIBUTING.md`, step by step. One gated entry in
`buildProviders()`, disjoint `match()`, id in `PROVIDER_IDS`, `claude` last,
tests in `providers.test.js` + `router.test.js`. Never a router/server change.

**Changing the forwarding path** →

1. Build options only via `upstreamRequestOptions()`.
2. Holds response bytes in memory? Needs a size cap + passthrough escape hatch
   (`NON_STREAM_BUFFER_LIMIT`, `RATE_LIMIT_PEEK_LIMIT`).
3. Adds cross-request state? Stop — invariant 2.
4. End-to-end test in `server.test.js` against a local stub, covering BOTH the
   streaming and buffered paths; they are separate code.

**Merging a PR** → `gh pr merge <n> --squash`, **never `--rebase`**. `main` is
one commit per PR, `<type>: <what> (#<n>)`;
`git log --merges 156a1f8..origin/main` must stay empty. `--rebase` replays
every commit (#21 landed as nine and needed a force-push to undo). The squash
body is where the WHY goes — per-commit messages are discarded. Two
consequences: squashed branches never appear in `git branch --merged` (use `-D`
once content is confirmed landed), and simultaneous squashes always conflict in
`CHANGELOG.md` — fold into ONE version section, Added → Changed → Fixed.

**Releasing** → CHANGELOG entry (before tagging — the gate reads it) →
`pnpm version patch|minor --no-git-tag-version` on the branch (the guard in
`scripts/version-guard.js` refuses the tag-form there; #41) → `pnpm check`,
push, squash-merge, THEN create `v<x.y.z>` on `main`. If routing, the catalog,
or the renderer changed, also regenerate `docs/models.html`: confirm the port
owner by PID (`lsof -nP -iTCP:4000 -sTCP:LISTEN -t` — `/_status` says what
ANSWERED, not what is bound), restart the proxy to match the merged tree, then
`pnpm models:html` and commit. CI cannot rebuild it and the suite reads the
committed file, so a stale artifact ships green and silent. `models:html` goes
through `scripts/render-html.mjs`, which runs the renderer against a temp HOME
holding only a symlink to `~/.env` — the renderer grades in-process through
`gradeOf()`, so a plain run publishes YOUR `grades.json` instead of the repo's
table (it shipped four wrong grades that way). Never "simplify" it back to
`node render-models.js >`, and never isolate the whole HOME: `loadEnv()` reads
`~/.env` from it, so a blanket override drops every key and the page collapses
to the Claude card alone (measured: 40 rows → 3).

## Backlog

Open work, closed items with their evidence, and reversed decisions live in
[`docs/BACKLOG.md`](docs/BACKLOG.md); item numbers are stable and never reused.
Worth knowing exist: **1** thinking-strip vs Claude tool-use loops (the fix to
apply _if_ it fires); **8** the `<provider>:` selector, the cross-host probe
matrix, and the measured +79-token plan preamble; **9** grades — the
`Specialist` default and `Economy` are gone as of 0.6.1 (an unassessed id now
omits `grade`); what remains open is where assessments come from at all;
**12** `ROUTES` is hand-probed and rots silently, and no test can catch it;
**16–20** the free-claude-code recon (2026-08-28): gateway model discovery,
optional proxy auth, request-id correlation, the Kimi provider candidate, and
the declined-features register with per-feature invariant reasons (#44–#48).
