# cc-proxy — maintainer handoff

A local HTTP proxy that lets Claude Code use GLM (Z.ai), OpenRouter, DeepSeek,
Qwen, and Claude in one session. Claude Code points `ANTHROPIC_BASE_URL` at it;
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

## Invariants (breaking one is a design decision, not a refactor)

Each is locked by tests; the test names tell you what you broke.

1. **Transparent pipe.** Auth/headers only. Full inbound path *including the
   query string* reaches upstream; bodies forwarded byte-for-byte. Two body
   exceptions (thinking-strip, `<provider>:` selector-strip) and one header
   exception (hop-by-hop dropped — CL+TE together trips smuggling rejection).
   → `server.test.js` "query string is preserved…", "provider selector strip…"
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
6. **Client abort propagates upstream**, or a cancelled turn bills into a dead
   socket. → "client abort mid-stream aborts the upstream request"
7. **Loopback bind by default.** `PROXY_HOST` is the explicit opt-out.
   → `config.test.js`

## Load-bearing map (ranked by blast radius)

| # | Thing | If broken |
|---|---|---|
| 1 | `src/proxy.js` `upstreamRequestOptions()` + `forward()` | every request in every session |
| 2 | `src/providers.js` `applyAuth()` / `buildUpstreamHeaders()` | credential leak, or auth failure everywhere |
| 3 | `hooks/proxy-lifecycle.js` `ensureProxyRunning()` | proxy never starts → all sessions `ECONNREFUSED` |
| 4 | `src/server.js` `forwardBuffered()` | GLM overflow becomes silent empty turns again |
| 5 | `src/router.js` `resolve()` + `parseModelSelector()` | wrong backend / haiku burns paid quota |
| 5b | `src/routes.js` `rankRoutes()` | every shared id silently takes the expensive route |
| 6 | `.claude-plugin/plugin.json` `version` | users silently never receive updates (cache key) |
| 7 | `skills/setup/SKILL.md` | corrupts the user's `~/.claude/settings.json` |
| 8 | `src/sanitize.js` | mid-session backend switch 400s ("Invalid signature in thinking block") |

## Couplings — if you touch X, you must also update Y

`test/couplings.test.js` is the executable copy of this table — most rows fail
there if you forget. The ones marked ⚠ have no test and drift silently.

| Touch | Also update |
|---|---|
| routing log format (`server.js`) | `status.js` `parseRoutingLines()` — it parses the line |
| a version | `pnpm version` only; `plugin.json` is the plugin cache key |
| a `v<x.y.z>` tag | its CHANGELOG section, non-empty, BEFORE tagging |
| `PROXY_PORT` default | `config.js`, `proxy-lifecycle.js`, `statusline.js`, `status.js` |
| `PROXY_READY_TIMEOUT_MS` | `hooks/hooks.json` `timeout: 10` — ≥10000 ms never completes |
| `buildProviders()` | `PROVIDER_IDS` + `CONTRIBUTING.md` 1b — else the raw lens leaks upstream |
| a new env var | `.env.example` + README table + `docs/OPERATIONS.md` |
| the plugin description | `package.json`, `plugin.json`, `marketplace.json` |
| an upstream request option | `upstreamRequestOptions()` only — a 2nd copy shipped the query-string bug twice |
| a script's `process.env` read | `loadEnv()` directly under the imports, or `~/.env` is ignored |
| ⚠ `MODEL_GRADES` | nothing — it is the ONLY copy; `render-models.js` re-exports it |
| ⚠ a static catalog | confirm the id has a `ROUTES` entry |
| ⚠ the `/v1/models` wire shape | README + OPERATIONS + ARCHITECTURE, by hand |

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
are therefore **API surface, not a local opinion** — a new model with no entry
silently ships `Specialist`, and an id with no window OMITS the field rather
than sending `null` (`"context_window" in entry` is the check, so a consumer can
tell "unknown" from "known"). Never read a consumer's file back to decide
anything here: that inverts the arrow and makes neither plugin installable
alone. Adding a field means updating the three docs that describe the shape —
no test enforces that.

## Traps for the unwary

- **Plumbing can't move to `~/.env`** — the SessionStart hook reads
  `PROXY_PORT`/`PROXY_LOG` before the proxy exists to load it. Keys in `~/.env`,
  plumbing in settings.json `env`.
- **Setup order matters.** `ANTHROPIC_BASE_URL` retargets *already-open*
  sessions instantly, so `/cc-proxy:setup` starts the proxy itself and reads
  settings.json's `env` explicitly. Don't "simplify" it into a plain spawn.
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
- **CC internals may drift**: `[1m]` suffix, `claude-haiku-*` ids,
  `ANTHROPIC_CUSTOM_MODEL_OPTION` (one slot) are not public API — check these
  first when routing looks wrong after a CC update.
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
`pnpm version patch|minor` → `pnpm check`, push, tag. If routing, the catalog,
or the renderer changed, also regenerate `docs/models.html`: confirm the port
owner by PID (`lsof -nP -iTCP:4000 -sTCP:LISTEN -t` — `/_status` says what
ANSWERED, not what is bound), restart the proxy to match the merged tree, then
`pnpm models:html` and commit. CI cannot rebuild it and the suite reads the
committed file, so a stale artifact ships green and silent.

## Backlog

Open work, closed items with their evidence, and reversed decisions live in
[`docs/BACKLOG.md`](docs/BACKLOG.md); item numbers are stable and never reused.
Worth knowing exist: **1** thinking-strip vs Claude tool-use loops (the fix to
apply *if* it fires); **8** the `<provider>:` selector, the cross-host probe
matrix, and the measured +79-token plan preamble; **9** grades — 299 of 320
models carry the `Specialist` default, which reads as a claim and is an absence;
**12** `ROUTES` is hand-probed and rots silently, and no test can catch it.

## Operator

@OPERATOR.md — it is this session's operating charter.
