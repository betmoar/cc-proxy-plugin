# Audit state — cc-proxy-plugin — 2026-09-02

- **Mode:** AUTONOMOUS (principal-architect-audit, run 2)
- **Phase cursor:** DONE (P1→P4 complete, self-verified)
- **Commit audited:** f28fa27 (`main` after PR #53 / v0.8.2); remediation on branch `claude/principal-audit-autonomous-wgn520`.
- **Iteration budget:** none set; Phase 2 ran to a dry pass.
- **Previous run:** 2026-08-31 @ a6f05ab (findings F01–F05, PR #50). This run's ids are F06–F10.

## Verdict (one line)

**Healthy.** Forwarding, routing, credential isolation and the lifecycle handshake match their measured comments and every named invariant has a green lock. This run's defects sit at the product's edges — operator scripts and hook probes — and share one shape: a process that goes quiet (empty stdout, a promise that never settles, a wrong error label) instead of failing. No architecture-root issue.

## Baseline → delta

- Baseline: `pnpm check` GREEN — 504 tests / 502 pass / 0 fail / 2 skipped (env-gated live-key tests), lint clean.
- Final (audit commits): `pnpm check` GREEN — 517 tests / 515 pass / 0 fail / 2 skipped. Delta +13 tests (6 `direct-run.test.js`, 2 `proxy-lifecycle.test.js`, 1 `models.test.js`, 4 `couplings.test.js`), 0 regressions.
- Final (PR #56 head 2810baa, after the maintainer's review-panel commits 89b22ac + 2810baa and the 0.8.3 release bump): `pnpm check` GREEN — **522 tests / 520 pass / 0 fail / 2 skipped**, lint clean. Evidence lines in AUDIT_LOG.md (P3/P4 and CORRECTION entries dated 2026-09-02).

## What this audit changed (all verified green; evidence in AUDIT_LOG.md)

| Finding | Fix | Lock |
|---|---|---|
| F06 (P2) five operator scripts' direct-run guard compared a URL to a raw path → silent exit 0 on a path with a space, through a symlink, or on Windows. **CORRECTED by the maintainer (2810baa):** the three scripts this audit called "already correct" (probe-vendors, release-gate, version-guard) decoded the path but did not realpath it, so both RELEASE GUARDS silently disarmed through a symlinked checkout — measured. All eight now use `isDirectRun()` | `scripts/direct-run.js` `isDirectRun()`; guard replaced in all eight scripts (five by the audit, three by 2810baa) | `direct-run.test.js` (5 unit + 1 e2e through a symlinked "with space" path, red before fix); `couplings.test.js` "no script spells the direct-run guard as a raw file:// comparison" |
| F07 (P2) `probeProxyVersion`/`requestShutdown` never settled on a mid-body cut → SessionStart hook hung to its 10 s kill, stale proxy kept | both settle on `'close'` | `proxy-lifecycle.test.js` "lifecycle probes settle when the response is cut mid-body" ×2 (red before fix) |
| F10 (P3) `/v1/models` legs labelled a mid-body abort "invalid response shape" | inner catches classify `AbortError` → `timeout` (4 legs); **89b22ac/2810baa added** a deepseek behavioural case, a couplings lock over all four legs, and a `[models] <provider> body read failed` log line for a socket RESET (`TypeError: terminated`, not AbortError — measured) | `models.test.js` "collectModels reports a stall AFTER the headers as a timeout" (red before fix) + the maintainer's deepseek case and leg lock |
| F08 (P3) eight `file.js:NNN` comment citations, four stale | all rewritten to symbols | `couplings.test.js` "no comment cites a source file by line number" (tripped on its own draft comment → detection proven) |
| F09 (P3) docs recommended `anthropic/claude-opus-4` as the OpenRouter example; `.env.example` listed 2/6 `DEFAULT_BACKEND` values | README:69, `.env.example`, SKILL.md rewritten | `couplings.test.js` "no reader-facing doc offers an anthropic/ id…" and "`.env.example`'s DEFAULT_BACKEND comment names every provider id" (both mutation-verified red, then restored) |

Context transfer: CLAUDE.md gained three couplings rows, an extension to the `buildProviders()` row, and one Traps bullet; CHANGELOG gained `[0.8.3] — unreleased`. Version deliberately NOT bumped (release decision; the tag gate enforces it).

## Registered on GitHub (unknowns that outlive this run)

- **#54** (question) — Windows: the F06 class is fixed by construction but unmeasured there; five remaining unknowns each with what confirms it (`ps` in version-guard fails closed for pnpm, `lsof` in bench-speed, detached spawn, log rotation, POSIX command bodies). Supersedes the one-line backlog item 7.
- **#55** (enhancement, question) — the SessionStart hook is silent on every failure state; the blocking unknown is how CC surfaces hook stdout/stderr on exit 0, with the measurement to run first.
- **#45 comment** — the inbound request body is buffered without a cap; only a hazard off-loopback, so it rides with the LAN-exposure issue and constrains the `PROXY_AUTH_TOKEN` design ("401 before buffering").

## Confirmed-sound this run (where NOT to spend successor effort)

All five `writeHead` sites pass `withoutRequestId`; `applyAuth` drops both inbound credential headers; `push()` grouping in `collectModels` (five shapes traced); `rankRoutes` native-first; `refresh-lock.js` ceremony (unchanged since PR #50 round 3); `version-guard.js` fail-closed on missing `ps`/git (but NOT symlink-safe as an entry point until 2810baa — see the F06 correction); `release-gate.mjs`; `render-html.mjs` HOME isolation; the 429/1302 gate; `spawnProxy` fd handling; the probe-vendors exit-code contract; bench-grades' atomic write.

## Open decisions

- `// DECISION:` COMMIT gate cleared for THIS branch + issue creation on the task statement's explicit words. Never main, never a tag, never a merge. Rollback: `git push origin --delete claude/principal-audit-autonomous-wgn520`; close #54/#55 as not_planned.
- `// DECISION:` `.operator/` charter tooling absent (unchanged); audit-skill evidence discipline applied.
- `// DECISION:` `pnpm probe:vendors` not run — no keys here and no vendor claim touched.
- `// DECISION:` docs/BACKLOG.md untouched (maintainer-curated numbering); #54 and #55 cite item numbers so the maintainer can annotate items 7 and the hook behaviour when they choose.
- `// DECISION:` (REVERSED by measurement, 2810baa) "three sibling scripts already use the correct decoded comparison" — decoded is not realpath'd; a symlinked checkout disarmed both release guards. The audit's own `isDirectRun` JSDoc named the symlink mechanism and the audit did not re-check it at the three sites it exempted. Recorded so the next reader does not repeat the exemption.
- `// DECISION:` F08's lock scans `.js`/`.mjs` only. CLAUDE.md and AUDIT_*.md legitimately carry `file:line` (they are evidence records, not code comments) and are out of scope by design.

## Residual risk register (prioritized)

1. **ROUTES / catalog rot** (backlog 12, issue #37) — unchanged; only `pnpm probe:vendors` re-measures.
2. **LAN exposure under `PROXY_HOST`** (issue #45, now also the uncapped body) — documented tradeoff, unfixed by design until auth lands.
3. **Windows** (#54) — one class fixed blind; five unknowns listed.
4. **Hook silence** (#55) — every start failure is invisible until ECONNREFUSED.
5. **Un-re-read this run:** `scripts/render-models.js` 1–679 (prior run swept it), README/OPERATIONS/ARCHITECTURE grepped not line-read, most test files. Logged as truncation in AUDIT_LOG.md.

## What's left

Nothing in-phase. Cursor DONE — a future run should pick a NEW surface (render-models.js body, a probe:vendors session with real keys, or the #54 Windows measurement), not redo this one.
