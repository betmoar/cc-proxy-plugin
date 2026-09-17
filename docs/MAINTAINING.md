# Maintaining cc-proxy

The long form behind [CLAUDE.md](../CLAUDE.md): the decision procedures, the
traps with the measurements that found them, and the reason behind each row of
the couplings table. CLAUDE.md carries the rules; this page carries the
evidence. Read a section here before reversing anything CLAUDE.md says.

## Decision procedures

### Adding a provider

Follow [CONTRIBUTING](../CONTRIBUTING.md#add-a-provider-in-one-file) step by
step: one gated entry in `buildProviders()`, a disjoint `match()`, the id in
`PROVIDER_IDS`, `claude` last, tests in `providers.test.js` and
`router.test.js`. Never a router or server change.

### Changing the forwarding path

1. Build upstream options only through `upstreamRequestOptions()`. A second
   copy shipped the query-string bug twice.
2. Holding response bytes in memory needs a size cap and a passthrough escape
   hatch (`NON_STREAM_BUFFER_LIMIT`, `RATE_LIMIT_PEEK_LIMIT`,
   `CATALOG_BODY_LIMIT` are the three that exist).
3. Cross-request state? Stop. That is invariant 2.
4. End-to-end test in `server.test.js` against a local stub, covering **both**
   the streaming and the buffered path. They are separate code.

### Adding a handler to the dispatcher

Wrap its whole body in a `try`. The request's `end` listener and every `async`
handler dispatched without `await` run with no caller above them, so a throw
is an uncaught exception and Node ends the process for every session on the
machine. No `uncaughtException` handler exists, deliberately; containment sits
at each dispatch point so the log names the request. `handleModels` and the
`dispatch()` wrapper are the worked examples; a body of `null` was the case
that found the second.

### Adding a curated model

Five places move together: `CONTEXT_WINDOW` (window), `ROUTES` (a probed
status per backend, 200 or not), `MODEL_GRADES` (only if someone assessed it),
`docs/models.html` (regenerate, see [RELEASING](RELEASING.md)), and the
user's `/model` picker (they re-run setup; the SessionStart notice tells them).
`couplings.test.js` pins the `CONTEXT_WINDOW` count as a tripwire and
`render-models.test.js` fails when the page lacks the id or shows a different
grade.

### Adding a field to `/v1/models`

It is a publishing contract. Type it in the `ModelEntry` typedef, omit it
rather than send `null` when unknown, and describe it in
[DISCOVERY](DISCOVERY.md) and [ARCHITECTURE](ARCHITECTURE.md).
`couplings.test.js` reads the typedef and requires the field name in both.
Never read a consumer's file back to decide anything: cc-proxy publishes,
downstream plugins consume, and the arrow points one way.

### Adding an environment variable

`.env.example`, the table in [CONFIGURATION](CONFIGURATION.md), and the code
that reads it. `couplings.test.js` checks the first two agree in both
directions. Read it inside a function or after `loadEnv()`; a module-level
read in a shared module captures the environment before `~/.env` is merged.

### Writing a file under `~/.claude`

Stage a sibling `.tmp-<pid>` and `renameSync` over the target: `writeFileSync`
opens with `'w'`, so a kill mid-write truncates the user's file. Resolve a
symlink first and write through it (a dotfiles-managed settings.json is a
link). Preserve the target's mode. `couplings.test.js` denies the direct-write
spelling in every writer; `model-picker.test.js` pins the inode, which is the
only observable separating rename from truncate.

### Adding a script entry point

Guard `main()` with `isDirectRun(import.meta.url)` from `scripts/direct-run.js`,
never a raw `import.meta.url` comparison. Call `loadEnv()` directly under the
imports, before any `process.env` read. Both are locked by `couplings.test.js`.

### Writing a comment that claims behaviour

Which lock you need depends on the claim:

- "this input yields that output": a `@doctest fn(<json>) -> <json>` line,
  executed by `test/doc-examples.test.js`.
- "this vendor does X": a case in `scripts/probe-vendors.mjs`, re-runnable on
  demand.
- "the contract is X": a lock in `couplings.test.js` that pins the code side
  and denies phrasings only true under the old contract.

Never cite `file.js:NNN`; line numbers rot on the next edit above them. Name
the symbol.

## Traps

### A comment that states behaviour rots like untested code, but louder

The #34 fix reversed its own contract mid-review (the `[1m]` suffix went from
"preserved upstream" to "stripped upstream" once both vendors were measured
rejecting it) and left three comments asserting the old one: a JSDoc, a test
block comment, and `resolve()`'s numbered step list. Every one was caught by a
reviewer, none by a test, the last only after approval. That is why the three
lock mechanisms above exist.

### Plumbing and `~/.env`

Since 0.10.2 the SessionStart hook and `scripts/start-proxy.js` load `~/.env`
themselves (never overriding the process environment), so `PROXY_*` knobs may
live there. What must stay in settings.json `env` is what **Claude Code**
reads: `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` in auth mode. Before
0.10.2 the hook did not load `~/.env`, and in auth mode it could not present
`PROXY_AUTH_TOKEN` to `/_shutdown`, so a stale proxy was never replaced.

### Setup order

`ANTHROPIC_BASE_URL` retargets already-open sessions instantly, so
`/cc-proxy:setup` starts the proxy itself and reads settings.json's `env`
explicitly. Do not simplify it into a plain spawn.

### An inline `ANTHROPIC_BASE_URL=… claude` prefix is silently ignored

settings.json's `env` block overrides the process environment, and the run
looks like a success while hitting the old proxy. Use `claude --settings
'{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<port>"}}'`. Measured
2026-08-14 against two logging listeners (issue #25): the inline variant
printed `ok` with zero requests on the new port and four routing lines on the
old one. Any A/B between two proxy builds must read the target listener's log.

### Never `rm && touch` the proxy log

A live process keeps writing to the deleted inode. `truncate -s 0`.

### 429 is the one buffering exception on the streaming path

Extending it to other statuses breaks SSE. It is gated on GLM `1302` exactly;
the sibling `1113` (insufficient balance) is a `429` but not retryable, and a
hint there recreates an infinite cooldown loop.

### Response inspection requires identity encoding

`forwardBuffered()` forces `accept-encoding: identity`; without it a gzipped
body fails `JSON.parse` and overflow and rate-limit handling degrade to
passthrough, silently. Never on the streaming path.

### A slash command has no positional parameters

Claude Code substitutes `$ARGUMENTS` and `$1` **textually** before any shell
runs. `$2` and `$3` expand to nothing, and `$1` may be the last token
(`bench speed --report` gives `$1` = `--report`). Worse, the substitution is
source text: `set -- $ARGUMENTS` handed a `|`, a `>` or a `$(…)` in the
argument to the parser as syntax (measured: `speed --report | cat` fell through
to a billed `grades` run). `commands/bench.md` reads the argument through a
quoted heredoc so it becomes data, and `test/commands.test.js` runs the body
with those arguments spliced in.

### A session snapshots command bodies at startup

Even under `--plugin-dir .`, editing a command and re-running it tests the old
body. Verify which body you have (md5 the expansion, or probe with a signature
only the new version has), then `/exit` and relaunch. For anything billed, pick
an observable that separates the paths first: `bench speed --report` is
read-only, a live run appends.

### The statusline render path must never touch the network

cc-status kills a renderer at `CC_STATUS_TIMEOUT` (default 2 s) and a killed
renderer emits zero bytes, so the segment vanishes. Measured: serial fetches
made a cold render 1478–2216 ms, 5 of 15 over the kill. An expired cache is
served and refreshed by a **detached** child; `detached:true` is load-bearing
because the composer kills the whole process group. The single-flight
`refresh.lock` is the other half (without it, five fetch rounds per expiry).
A failing refresh writes a `.failed` marker and backs off 15 s; without that,
a revoked key spawned a refresher on every render.

### A lock's stale reclaim is check-then-act, and `rename()` does not fix that

`rename` is atomic about the path, not the file, so a racer arriving after the
winner relocked renames the winner's fresh lock away (measured: 5 double-grants
in 60 rounds × 12 processes). Checking the moved file's inode is the same trap
one platform over: ext4 and overlayfs recycle a freed inode for the next
create, so the check is inode **and** mtime. An unserialized reclaim still
double-grants with three contenders, so reclaimers serialize on a claim file
and restore via `link()`, which refuses to overwrite. The header of
`scripts/refresh-lock.js` carries the full defect ladder. The broken variants
are green in ~92% of racing runs, so a statistical race test proves nothing;
the lock lives in its own module to give the tests seams that force each
interleaving.

### A test that kills a subprocess must kill it unconditionally

A watchdog cancelled after `wait` returns never fires once the thing under test
gets fast, so the test passes for the wrong reason. Sleep past the fast path's
exit, then kill outright.

### Claude Code internals may drift

The `[1m]` suffix, `claude-haiku-*` ids, `ANTHROPIC_CUSTOM_MODEL_OPTION`, the
`modelPicker` row schema, `behavesAs`, and the gate that makes
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` apply only to unknown ids are not public API.
Check them first when routing or a context window looks wrong after a Claude
Code update. The picker three rest on one measurement (CC 2.1.263, 2026-09-07,
recipe in `src/model-picker.js`'s header) and `probe:vendors` cannot re-measure
them; re-run that recipe by hand.

### A script that prints nothing and exits 0 may never have run

The operator scripts are commands and importable modules, so `main()` sits
behind a direct-run guard, and the guard is the first suspect when
`/cc-proxy:status` or `/cc-proxy:models` is silent. A raw `import.meta.url`
versus `file://` string compare is false on a path with a space, through a
symlink, and on Windows; a decoded compare is still false through a symlink,
which silently disarmed `version-guard.js` and `release-gate.mjs` (measured
0.8.3: exit 0, guard never ran). `isDirectRun()` realpaths both sides.

### `/v1/models` is synthesized, `/v1/models/<id>` is forwarded

Uncurated ids omit `context_window` rather than sending `null`; attach it via
`withContextWindow()`, because a bare object lookup inherits from
`Object.prototype` and ships a function for an id named `constructor`.

### Hooks do not import `src/`

The test suites copy the three hook files alone into a fixture tree, and a
hook must start from a tree whose `src/` may be mid-update. Anything a hook
needs from `src/` is duplicated (`loadHomeEnv`, `treeVersion`) or joined by a
string (`GENERATED_MARKER`), and `couplings.test.js` locks the string.

### The hook's time budget

`hooks/hooks.json` kills the SessionStart hook at 10 s. The stale-proxy restart
path spends the ready timeout twice plus ~2.3 s of probes, so
`PROXY_READY_TIMEOUT_MS` past ~3900 can be killed mid-poll: the proxy still
comes up (spawned detached) but the hook's one context line is lost.
`couplings.test.js` computes the budget from the exported constants.

## Couplings, the long form

Each row of CLAUDE.md's table, with the failure it prevents.

- **Routing log format → `parseRoutingLines()`.** `scripts/status.js` parses
  the line by shape (`starts with "[" and contains " -> "`). The model id and
  request id are attacker-controlled and reach that line, so `logSafe()` and
  the id sanitizers exist to stop a client from forging routing history in
  `/cc-proxy:status` output (measured end to end).
- **`stripVariantSuffix` / `routingIdOf`.** `routes.test.js` imports the first
  to lock strip-then-rank composition; `server.js` calls the second for the
  `(routed as …)` annotation. Two copies of the normalisation would drift and
  the log would explain routing wrongly.
- **A version → `pnpm version` only.** `plugin.json` is the cache key; a
  version bumped in one file leaves users on the old tree. Off `main` pass
  `--no-git-tag-version`; the guard refuses the tagging form there (#41).
- **A tag → its CHANGELOG section, before tagging.** The release gate reads it,
  and since 0.10.2 the PR-time test does too.
- **`PROXY_PORT` default.** Read independently in `config.js`, the hook, the
  statusline, `status.js`, `list-models.js`, `bench-speed.js` and
  `render-models.js`, because the hook must not import `src/`. A split default
  means the proxy binds one port while the tools probe another. The test walks
  the tree so a new copy joins the lock the moment it is written.
- **`PROXY_READY_TIMEOUT_MS` → `hooks.json` timeout.** See the hook's time
  budget above.
- **`buildProviders()` → `PROVIDER_IDS`, CONTRIBUTING 1b, `.env.example`'s
  `DEFAULT_BACKEND` comment.** The selector strip must work with no key
  registered (#20), so the set is hand-written; forgetting an id leaks the raw
  lens upstream with no local symptom.
- **A script entry point → `isDirectRun(import.meta.url)`.** Three locks, one
  per broken spelling (raw compare, decoded compare, bare call).
- **An `await res.json()` catch in a `models.js` live leg → classify
  `AbortError` (and `BodyTooLargeError`) before `invalid response shape`.**
  Only the GLM and DeepSeek legs are observable through `_errors`; the other
  two are locked structurally.
- **A comment citing `file.js:NNN` → the symbol.** Four of eight were wrong
  when the lock started.
- **An OpenRouter example id in a doc → never `anthropic/…`.** Discovery drops
  those on purpose (invariants 3 and 4); a doc recommending what the code
  refuses is how reasoning gets "fixed" away.
- **A human-facing `pnpm` script → README, CONTRIBUTING, OPERATIONS or
  RELEASING.** A manual gate nobody knows about is not a gate. The lock
  matches `pnpm <name>`, not a bare substring.
- **The outbound-id contract (`upstreamModel`) → the prose describing it.**
  `couplings.test.js` fails on either drifting.
- **The plugin description → `package.json`, `plugin.json`,
  `marketplace.json`.** Nothing at runtime reads all three.
- **An upstream request option → `upstreamRequestOptions()` only.**
- **`QWEN_PLAN_RESELLS` → `QWEN_PLAN_ALSO`** in `render-models.js`, or the
  Qwen card under-reports the plan.
- **A statusline gauge → the `GAUGES` table.** The render path and the
  refresher both read it; adding to one only means a gauge that shows but never
  refreshes, or refreshes but never shows.
- **`MODEL_GRADES`.** The only copy in the repo, but `gradeOf()` overlays
  `~/.claude/cc-proxy/grades.json` on it, so a reader is never reading the
  table alone. Nothing locks it.
- **`identityOf` → its `@doctest` lines**, keeping an example with two
  slashes, or `indexOf` to `lastIndexOf` passes the whole suite (measured).
- **A static catalog id → a `ROUTES` entry.**
- **The `/v1/models` wire shape → DISCOVERY and ARCHITECTURE.** Field names
  are locked from the typedef; the prose describing their semantics is yours.
- **`mediaBaseUrl` → the media branch in `server.js`.** Its only reader;
  changing one alone routes at the skin, which 404s. Nothing locks it.
- **`CONTEXT_WINDOW` → every user's settings.json.** Adding a model edits a
  file outside this repo on the user's next setup; the count tripwire exists so
  that is deliberate.
- **`buildRows()` → `[1m]` and `behavesAs` together.** Drop either half and
  every 1M model loses 800K of window, or a catalog warning returns every
  session.

## Releases

Why the procedure in [RELEASING](RELEASING.md) is shaped the way it is:

- The tag is created on `main` after the squash because a squash discards the
  branch commits; a tag made on the branch points outside the released history
  (#41, caught by hand in 0.7.0 and 0.8.1 before the guard existed).
- `docs/models.html` is regenerated **before** the merge because v0.10.1 was
  tagged with the page one commit behind the catalog: the only artifact lock
  pinned Claude ids, and `glm-5.3-flash` was absent from the tagged page with a
  green suite. The page locks now read `CONTEXT_WINDOW` and `MODEL_GRADES`.
- The release gate runs at PR time as well as tag time because a bumped
  version with no CHANGELOG section used to fail one merge too late.
