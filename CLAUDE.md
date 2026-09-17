# cc-proxy — maintainer handoff

A local HTTP proxy that lets Claude Code use GLM (Z.ai), OpenRouter, DeepSeek,
Qwen, LM Studio (self-hosted, `lmstudio:` selector only) and Claude in one
session. Claude Code points `ANTHROPIC_BASE_URL` at it; the proxy routes each
request **by model name** and forwards. That is the whole product. Resist
making it more than that.

This file carries the rules. The evidence behind each rule (measurements,
histories, refuted alternatives) is in
[`docs/MAINTAINING.md`](docs/MAINTAINING.md); read the matching section there
before reversing anything here.

Read next: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design and why),
[`docs/ROUTING.md`](docs/ROUTING.md) / [`docs/DISCOVERY.md`](docs/DISCOVERY.md)
/ [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) (the user-facing contracts),
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) (runtime),
[`docs/RELEASING.md`](docs/RELEASING.md), [`docs/BACKLOG.md`](docs/BACKLOG.md)
(open work and why past decisions went the way they did),
[`CONTRIBUTING.md`](CONTRIBUTING.md) (add-a-provider procedure).

## Gates

- `pnpm check` (= `pnpm lint && pnpm test`) before any commit; CI runs the
  same. The suite spins **real local HTTP backends**: if you change forwarding
  and no test fails, you have not tested it. Add one.
- `pnpm probe:vendors` is the MANUAL gate for claims about someone else's
  server. Never in `pnpm check` (real keys, real quota). It exits 1 when a
  vendor stops behaving the way a source comment says. Run it when you touch
  routing or forwarding, or when a probe date in a comment looks old.
- Node 22 or newer. `.npmrc` is engine-strict because `process.loadEnvFile`
  is how `~/.env` is read.

## Invariants (breaking one is a design decision, not a refactor)

Each is locked by tests; the test names tell you what you broke.

1. **Transparent pipe.** Auth and headers only. The full inbound path
   _including the query string_ reaches upstream; bodies forwarded byte for
   byte. Four body exceptions and two header exceptions (hop-by-hop dropped;
   the upstream's own `x-request-id` dropped, because `writeHead` replaces what
   `setHeader` put there). The first three body strips share one shape — a
   spelling the CLIENT uses that no BACKEND knows: thinking-strip,
   `<provider>:` selector strip, `[1m]` suffix strip. The fourth is the INVERSE
   shape — history a BACKEND produced that the destination backend rejects
   wholesale (GLM's own `server_tool_use` calls) — and is DIRECTIONAL for that
   reason: claude route only, since the same history is legal input to the
   backend that made it. It removes MESSAGES too, not just blocks, because
   `content: []` is its own 400. → `server.test.js` "query string is
   preserved…", "provider selector strip…", "routing log annotates the
   normalized id…", "keeps the proxy's x-request-id when the upstream sets its
   own…", "no message reaches upstream with an EMPTY content array"
2. **Stateless.** No breakers, no on-disk state, no in-proxy waiting. Rate
   limits inject `Retry-After` and let the client back off. → "…1302 … gets a
   Retry-After", "1313 … no Retry-After"
3. **Credential isolation.** Inbound `Authorization`/`x-api-key` never reach a
   third party; the Claude route passes them through (OAuth). Never set
   `ANTHROPIC_API_KEY` in a settings template; it shadows OAuth.
   → `providers.test.js` "…drops an inbound x-api-key…"
4. **`claude-haiku-*` pins to Claude.** The pin tests the STRIPPED tail;
   pinning the raw id lets `glm:claude-haiku-…` skip it. → `router.test.js`
5. **Anthropic Messages only.** No OpenAI-to-Anthropic translation, ever. The
   media tunnel forwards a DashScope body byte for byte and is not an
   exception. → `models.test.js` "media generation tunnel (issue #40)"
6. **Client abort propagates upstream**, or a cancelled turn bills into a dead
   socket. → "client abort mid-stream aborts the upstream request"
7. **Loopback bind by default.** `PROXY_HOST` is the explicit opt-out;
   `PROXY_AUTH_TOKEN` makes it safe. → `config.test.js`
8. **One bad request never ends the process.** No `uncaughtException` handler
   exists; every dispatch point contains its own throws (a JSON `null` body
   used to exit the process for every session). → `server.test.js`
   "dispatcher containment (a bad request never ends the process)"

## Load-bearing map (ranked by blast radius)

| # | Thing | If broken |
| --- | --- | --- |
| 1 | `src/proxy.js` `upstreamRequestOptions()` + `forward()` | every request in every session |
| 2 | `src/providers.js` `applyAuth()` / `buildUpstreamHeaders()` | credential leak, or auth failure everywhere |
| 3 | `src/server.js` `createServer()` / `dispatch()` | a throw ends the shared process |
| 4 | `hooks/proxy-lifecycle.js` `ensureProxyRunning()` | proxy never starts; every session `ECONNREFUSED` |
| 5 | `src/server.js` `forwardBuffered()` | GLM overflow becomes silent empty turns again |
| 6 | `src/router.js` `resolve()` + `parseModelSelector()` | wrong backend; haiku burns paid quota |
| 6b | `src/routes.js` `rankRoutes()` | every shared id silently takes the expensive route |
| 7 | `scripts/render-model-picker.js` `writeSettings()` | corrupts or forks the user's `~/.claude/settings.json` |
| 8 | `.claude-plugin/plugin.json` `version` | users silently never receive updates (cache key) |
| 9 | `src/models.js` `collectModels()` / `gradeOf()` | the `/v1/models` contract other plugins consume |
| 10 | `src/sanitize.js` | mid-session backend switch 400s; prompt caching breaks if non-deterministic |
| 11 | `scripts/statusline.js` + `scripts/refresh-lock.js` | the status bar blocks, vanishes, or spawns a refresher per render |

## Couplings: if you touch X, you must also update Y

`test/couplings.test.js` is the executable copy of this table. Rows marked ⚠
have no lock and drift silently. The reason behind each row is in
[`docs/MAINTAINING.md`](docs/MAINTAINING.md#couplings-the-long-form).

| Touch | Also update | Lock |
| --- | --- | --- |
| routing log format (`server.js`) | `status.js` `parseRoutingLines()` | couplings |
| `stripVariantSuffix` / `routingIdOf` (`router.js`) | `routes.test.js` composition lock; the `(routed as …)` annotation | routes.test.js |
| a version | `pnpm version patch\|minor --no-git-tag-version` on the branch, never by hand; tag on `main` after the squash | version-guard, release.yml |
| a `v<x.y.z>` tag | its CHANGELOG section, non-empty, in the bumping PR | release-gate.test.js |
| `PROXY_PORT` default | every file the couplings walk finds (`config.js`, the hook, `statusline.js`, `status.js`, `list-models.js`, `bench-speed.js`, `render-models.js`) | couplings |
| `PROXY_READY_TIMEOUT_MS` | `hooks/hooks.json` `timeout: 10`; the restart path spends it twice, so past ~3900 ms the hook is killed mid-poll | couplings |
| `buildProviders()` | `PROVIDER_IDS`, CONTRIBUTING step 2, `.env.example`'s `DEFAULT_BACKEND` comment | couplings |
| a `scripts/*.js` entry point | `isDirectRun(import.meta.url)` guard; `loadEnv()` directly under the imports | couplings |
| an `await` body read in a `models.js` live leg | classify `AbortError` and `BodyTooLargeError` before `invalid response shape`, in all four legs | couplings, models.test.js |
| a comment citing `file.js:NNN` | rewrite it to the symbol | couplings |
| an OpenRouter example id in a doc | never `anthropic/…` | couplings |
| a new env var | `.env.example` + the table in `docs/CONFIGURATION.md` | couplings (both directions) |
| a human-facing `pnpm` script | README, CONTRIBUTING, OPERATIONS or RELEASING, as `pnpm <name>` | couplings |
| a comment claiming an input→output | a `@doctest fn(<json>) -> <json>` line | doc-examples.test.js |
| a comment claiming vendor behaviour | a case in `scripts/probe-vendors.mjs` | manual |
| the outbound-id contract (`upstreamModel`) | the prose describing it | couplings |
| the plugin description | `package.json`, `plugin.json`, `marketplace.json` | couplings |
| an upstream request option | `upstreamRequestOptions()` only | server.test.js |
| `QWEN_PLAN_RESELLS` (`providers.js`) | `QWEN_PLAN_ALSO` (`render-models.js`) | couplings |
| a statusline gauge | the `GAUGES` table in `statusline.js` | statusline.test.js |
| ⚠ `MODEL_GRADES` | nothing in the repo, but `gradeOf()` overlays `~/.claude/cc-proxy/grades.json` | none |
| `identityOf` (`models.js`) | its `@doctest` lines, keeping one with TWO slashes | doc-examples.test.js |
| a static catalog id | a `ROUTES` entry | couplings |
| the `/v1/models` wire shape | `docs/DISCOVERY.md` + `docs/ARCHITECTURE.md` | couplings (field names), prose by hand |
| a handler in the dispatcher (`server.js`) | its whole body inside a `try` | server.test.js |
| ⚠ `mediaBaseUrl` (`providers.js`) | the media branch in `server.js`, its only reader | none |
| `CONTEXT_WINDOW` (`models.js`) | `ROUTES`, `MODEL_GRADES` if assessed, `docs/models.html`, and every user's picker on their next setup | couplings count tripwire, render-models.test.js |
| a writer of a file under `~/.claude` | `.tmp-<pid>` sibling + `renameSync`, through a symlink, mode preserved | couplings, model-picker.test.js |
| `buildRows()` (`model-picker.js`) | `[1m]` AND `behavesAs` together | model-picker.test.js |
| a hook's need for something in `src/` | duplicate it or join by a string; hooks never import `src/` | couplings (marker) |
| a doc file | README's docs map, links resolve, no line over 400 chars | docs.test.js |

Three questions, three places, never merged: a **catalog** says what a backend
serves, **`ROUTES`** who serves it cheapest, **`ownsId`** how it is spelled.
`grade` (capability) and `tier` (cost) are independent; tier 4 + Flagship is
normal.

**`GET /v1/models` is a publishing contract, and the arrow points one way.**
cc-proxy publishes curated model facts; downstream plugins (cc-reload,
cc-operator) consume them. A field is omitted, never `null`, when unknown, so
`"grade" in entry` and `"context_window" in entry` are the checks. Never read
a consumer's file back to decide anything here.

## Traps

One line each; the story and the measurement are in
[`docs/MAINTAINING.md`](docs/MAINTAINING.md#traps).

- **A comment that states behaviour rots like untested code, but louder.**
  Give every claim its lock: `@doctest`, a probe case, or a couplings lock.
- **Plumbing.** The hook and setup load `~/.env` (since 0.10.2), so `PROXY_*`
  may live there. `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` must stay in
  settings.json `env`; Claude Code reads those.
- **Setup order matters.** `ANTHROPIC_BASE_URL` retargets open sessions
  instantly; setup starts the proxy itself. Do not simplify it into a spawn.
- **An inline `ANTHROPIC_BASE_URL=… claude` prefix is SILENTLY IGNORED.** Use
  `claude --settings '{"env":{…}}'`, and read the target listener's log.
- **Never `rm && touch` the proxy log** while it runs. `truncate -s 0`.
- **429 is the ONE buffering exception on the streaming path**, gated on GLM
  `1302` exactly; `1113` must not get a retry hint.
- **Response inspection requires identity encoding**, buffered path only.
- **A slash command has NO positional parameters.** `$ARGUMENTS` is spliced
  as SOURCE; `commands/bench.md` reads it through a quoted heredoc.
- **A session SNAPSHOTS command bodies at startup.** Verify which body you
  have, then relaunch.
- **The statusline render path must never touch the network.** Detached
  refresher, single-flight lock, 15 s backoff after a failure.
- **A lock's stale reclaim is check-then-act**; inode AND mtime, reclaim
  serialized on a claim file, restore via `link()`.
- **A test that kills a subprocess must kill it unconditionally.**
- **Claude Code internals may drift**: `[1m]`, `claude-haiku-*`,
  `ANTHROPIC_CUSTOM_MODEL_OPTION`, the `modelPicker` schema, `behavesAs`, the
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` gate. Check these first after a CC update.
- **A script that prints nothing and exits 0 may never have run.** The
  direct-run guard is the first suspect.
- **`/v1/models` is synthesized, `/v1/models/<id>` is forwarded.** Attach
  windows via `withContextWindow()`, never a bare object lookup.
- **Hooks do not import `src/`.** The fixture trees copy three hook files.
- **The dispatcher has no safety net above it.** A throw in the request's
  `end` listener or an un-awaited handler ends the process; wrap the body.

## Decision procedures

- **Adding a provider** → `CONTRIBUTING.md`, step by step.
- **Changing the forwarding path** → build options only via
  `upstreamRequestOptions()`; bytes held in memory need a cap and a
  passthrough; cross-request state is invariant 2; test both paths
  end to end. → `docs/MAINTAINING.md`
- **Adding a curated model** → `CONTEXT_WINDOW`, `ROUTES`, `MODEL_GRADES`,
  `docs/models.html`, the count tripwire. → `docs/MAINTAINING.md`
- **Merging a PR** → `gh pr merge <n> --squash`, never `--rebase`.
  → `docs/RELEASING.md`
- **Releasing** → CHANGELOG, bump on the branch, regenerate `models.html`
  before the merge, tag on `main` after the squash. → `docs/RELEASING.md`

## Backlog

Open work, closed items with their evidence, and reversed decisions live in
[`docs/BACKLOG.md`](docs/BACKLOG.md); item numbers are stable and never reused.
Worth knowing exist: **1** thinking-strip vs Claude tool-use loops (the fix to
apply _if_ it fires); **8** the `<provider>:` selector and the measured
+79-token plan preamble; **9** where grades come from; **12** `ROUTES` rots
silently and no test can catch it; **16–20** the free-claude-code recon and the
declined-features register; **21–23** the 0.10.2 audit's deferred items (24
closed in 0.10.3).
