# Audit state — betmoar/cc-proxy-plugin — 2026-09-17
Mode: AUTONOMOUS (unattended session; the designated branch was the commit authorization)
Phase cursor: DONE
Commit audited: 39d9738 (main at start); remediation on branch `claude/docs-restructure-audit-a9dyg5` as 0.10.2
Iteration budget: P2 swept until each surface yielded nothing above P3 (one pass per surface by a dedicated agent, every P1/P2 re-run by the lead)

## Verdict (one line)
healthy → healthier: a small, zero-dependency proxy with real-backend tests and named invariants. The audit found 3 P1s (one process-killing request, one catalog-emptying vendor row, one config-forking write), 15 P2s, and the docs were the real defect: 260 KB across 7 files with paragraphs as single lines, drifting from the code in 22 places.

## Baseline → delta
| | Before | After |
| --- | --- | --- |
| `pnpm lint` | clean, 70 files | clean, 72 files |
| `pnpm test` | 607 total / 605 pass / 0 fail / 2 skipped | 649 / 647 / 0 / 2 |
| CLAUDE.md | 44.8 KB, 314 lines, 32 lines > 300 chars | 13.2 KB, 196 lines, max line 188 |
| README.md | 26.4 KB, 355 lines, 29 lines > 200 chars | 5.6 KB, 129 lines, max line 154 |
| docs/OPERATIONS.md | 38.2 KB, max line 2135 chars | 10.9 KB, max line 216 |
| docs/*.md files | 3 (ARCHITECTURE, OPERATIONS, BACKLOG) | 10 (+ ROUTING, DISCOVERY, CONFIGURATION, STATUSLINE, TROUBLESHOOTING, RELEASING, MAINTAINING) |
| doc-vs-code drift items | 22 found (F80–F101) | 0 open; 8 now locked by `test/docs.test.js` |

## Findings ledger
Severity/confidence per `AUDIT_LOG.md`. Status: fixed = code + test on this branch; docs = corrected in the restructure; deferred = `docs/BACKLOG.md` item.

| ID | Sev | Where | What | Status |
| --- | --- | --- | --- | --- |
| F01 | P1 | src/server.js | JSON `null` body → TypeError in 'end' listener → process exit | fixed (invariant 8) |
| F02 | P2 | hooks/session-start.js | auth token in ~/.env never loaded by hook → stale proxy never replaced | fixed |
| F03 | P3 | CLAUDE.md | restart-path hook budget understated | fixed (computed lock) |
| F04 | P3 | server.js, OPERATIONS | "/_shutdown carries no auth" stale since #45 | fixed |
| F20 | P1 | src/models.js | non-string vendor id rejects the whole /v1/models fan-out | fixed |
| F21 | P1 | scripts/render-model-picker.js | rename over a symlinked settings.json forks the config | fixed |
| F22 | P2 | scripts/render-model-picker.js | 0600 widened to 0644 on every run | fixed |
| F23 | P2 | render-model-picker.js / picker-staleness.js | fresh setup always followed by a false "stale rows" notice | fixed |
| F24 | P2 | src/models.js | catalog legs buffer unbounded bodies (150 MB → +683 MB RSS) | fixed (8 MB cap) |
| F25 | P3 | src/models.js | null element drops OpenRouter live catalog to static six | fixed |
| F40 | P2 | commands/bench.md | `$ARGUMENTS` spliced as shell source (`\|`, `>`, `$(…)`) | fixed + commands.test.js |
| F41 | P2 | scripts/start-proxy.js | setup path never loads ~/.env → token-less shutdown | fixed |
| F42 | P2 | scripts/statusline.js | malformed GLM cache → exit 1, zero bytes, whole bar gone | fixed (contained render) |
| F43 | P2 | scripts/statusline.js | failing refresh re-spawns per render, no backoff | fixed (15 s marker) |
| F44 | P3 | scripts/status.js | foreign listener reported as DOWN with looping advice | fixed |
| F45 | P3 | scripts/quota.js | missing `total_credits` renders `$0` | fixed |
| F46 | P3 | scripts/statusline.js | cache files written without tmp+rename | fixed + lock |
| F47 | P3 | scripts/statusline.js | comment names a function that no longer exists | fixed |
| F48 | P3 | commands/bench.md | prose says speed writes nothing on failure | fixed |
| F60 | P1 | test/render-models.test.js | models.html staleness invisible; v0.10.1 shipped stale | fixed (two locks) |
| F61 | P2 | release.yml | CHANGELOG-before-tag enforced one merge too late | fixed (PR-time gate test) |
| F62 | P2 | release.yml | no check that the tag commit is on main | fixed |
| F63 | P2 | scripts/version-guard.js | first-flag parse; npm is last-wins | fixed + doctests |
| F64 | P2 | package.json | `--ignore-scripts` skips both guard copies | documented; CI backstop |
| F65 | P2 | src/env.js | old Node silently ignores ~/.env | fixed (throws) + engine-strict |
| F66 | P3 | test/probe-vendors.test.js | exit-code tests are source regexes | deferred → BACKLOG 21 |
| F67 | P3 | test/couplings.test.js | module-level env lock misses destructured/let | fixed |
| F68 | P3 | test/couplings.test.js | PROXY_PORT lock blind to other spellings | fixed (self-check) |
| F69 | P3 | test/couplings.test.js | direct-run lock checks argument, not presence | deferred → BACKLOG 22 |
| F70 | P3 | test/couplings.test.js | writer lock is a hand list | fixed (statusline added) |
| F71 | P3 | scripts/probe-vendors.mjs | skipped keyed cases exit 0 | deferred → BACKLOG 21 |
| F72 | P3 | scripts/probe-vendors.mjs | validator `process.exit` at import | deferred → BACKLOG 21 |
| F73 | P3 | .forgejo/workflows/gate.yml | comment inverts the GitHub arch | fixed |
| F74 | P3 | scripts/version-guard.js | trusts the branch name `main` | deferred → BACKLOG 23 |
| F75 | P3 | test/couplings.test.js | pnpm-script docs lock is a bare substring | fixed |
| F80–F101 | P2/P3 | docs | 22 drift items (see AUDIT_LOG) | docs; F83 also BACKLOG 24 |

## Load-bearing map (final)
See CLAUDE.md "Load-bearing map"; unchanged from P1 except `src/server.js dispatch()` promoted to #3 (a throw there ends the shared process) and `writeSettings()` added at #7 (it writes a file outside the repo).

## Guardrail catalog (Phase 4.1)
| Invariant / rule | Enforcement | Artifact |
| --- | --- | --- |
| one bad request never ends the process | end-to-end: `null` body + a throwing predicate | test/server.test.js "dispatcher containment" |
| hook presents the auth token from ~/.env | stub proxy gating /_shutdown; hook + setup paths | test/proxy-lifecycle.test.js, test/start-proxy.test.js |
| restart path fits the hook budget | computed from exported constants | test/couplings.test.js |
| one malformed vendor row never empties the catalogue | glm / openrouter stubs | test/models.test.js |
| catalog body cap | oversized stub body | test/models.test.js |
| settings.json written through symlinks, mode preserved, dangling refused | fixture links | test/model-picker.test.js |
| fresh rows are not reported stale | run() then pickerNotice() | test/model-picker.test.js |
| `$ARGUMENTS` is data | body executed with hostile arguments spliced | test/commands.test.js |
| statusline render is contained; refresh backs off | malformed cache; failing stub | test/statusline.test.js |
| foreign listener classified | HTML stub | test/status.test.js |
| OpenRouter unknown balance is null | stub bodies | test/quota.test.js |
| models.html carries every curated id and grade | page vs CONTEXT_WINDOW / MODEL_GRADES | test/render-models.test.js |
| release gate passes on the checkout | gate() against the real tree | test/release-gate.test.js |
| tag commit is on main | merge-base in the tag build | .github/workflows/release.yml |
| last-wins tag flag | doctests | scripts/version-guard.js |
| Node floor | subprocess with the API deleted; engine-strict | test/dotenv.test.js, .npmrc |
| docs: links, map, line length, invariant parity, layout, Provider shape, backend table, /_shutdown row, skill phrases | structural | test/docs.test.js |
| env vars documented both ways | CONFIGURATION table vs .env.example | test/couplings.test.js |

## Open decisions
- // DECISION: AUDIT files live in docs/audit/ because the plugin tree is the repo root and every file here is cached into users' plugin dirs; root clutter is user-visible.
- // DECISION: docs restructure moved content, never deleted it; where two copies existed (env tables in README and OPERATIONS) one canonical copy remains (CONFIGURATION) and the lock points at it.
- // DECISION: invariant 8 added ("one bad request never ends the process") because the fix class (dispatcher containment) is design-level for a process shared by every session.
- // DECISION: `${CLAUDE_PLUGIN_ROOT}` braces in SKILL.md applied on the strength of the plugin reference alone; recorded as BACKLOG 24 pending a live measurement.

## Residual risks (known, not fixed)
| Risk | Severity | Confidence | Why not fixed | Mitigation |
| --- | --- | --- | --- | --- |
| `PROXY_HOST=0.0.0.0` without a token buffers request bodies unbounded | P2 | high | documented opt-out; the token is the fix and setup insists on it | CONFIGURATION auth-mode section |
| `ROUTES` rots silently | P2 | high | no offline oracle exists | `pnpm probe:vendors` drift report; BACKLOG 12 |
| `MODEL_GRADES` and `mediaBaseUrl` have no lock | P3 | high | one reader each; a lock would be theatre | ⚠ rows in CLAUDE.md |
| Claude Code internals (`[1m]`, picker schema, `behavesAs`) drift | P2 | moderate | not measurable offline | CLAUDE.md trap; recipe in model-picker.js header |
| Windows untested | P2 | unknown | no runner | BACKLOG 7 |
| probe-vendors exit-code tests are regexes | P3 | high | refactor of main() out of scope for this pass | BACKLOG 21 |

## What's left
Nothing in scope. Backlog items 21–24 carry the deferred findings with done-when conditions.
