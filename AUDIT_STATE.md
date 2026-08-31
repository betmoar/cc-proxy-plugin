# Audit state — cc-proxy-plugin — 2026-08-31

- **Mode:** AUTONOMOUS (principal-architect-audit)
- **Phase cursor:** DONE (P1→P4 complete, self-verified)
- **Commit audited:** a6f05ab (branch `claude/principal-audit-autonomous-fd05gq`); remediation committed on the same branch.
- **Iteration budget:** none set; Phase 2 ran to a dry pass.

## Verdict (one line)

**Healthy — unusually so.** The load-bearing paths match their (measured, dated) comments, every named invariant has a locking test that runs green, and the three defects found were P2/P3, all fixed with tests in this pass. No architecture-root issues.

## Baseline → delta

- Baseline (before any change): `pnpm check` GREEN — lint clean; 469 tests / 467 pass / **0 fail** / 2 skipped (env-gated live-key tests).
- After remediation + new guardrails: `pnpm check` GREEN — 473 tests / 471 pass / **0 fail** / 2 skipped. Delta: +4 tests (2 fix locks in server.test.js, 2 coupling locks in couplings.test.js), 0 regressions.

## What this audit changed (all verified green; see AUDIT_LOG.md for evidence)

| Finding | Fix | Lock |
|---|---|---|
| F01 (P2) Host header dropped non-default port | `src/proxy.js` passes `url.host`; `providers.js` param renamed/doc'd | `server.test.js` "the Host header sent upstream carries a non-default port" (red before fix) |
| F02 (P3) statusline lock stale-reclaim raced (check-then-act overwrite) | `scripts/statusline.js` reclaim via atomic `rename()` + exclusive `wx` re-entry | existing reclaim/hold tests pin behavior; atomicity is structural (see DECISION below) |
| F03 (P3) streaming 429-peek answered upstream death with a reset, not 502 | `src/proxy.js` 429 branch routes through `onUpstreamError()` | `server.test.js` "streaming 429 whose upstream dies mid-body yields a 502…" (red before fix) |
| ⚠ coupling: static catalog ↔ ROUTES | — | `couplings.test.js` "every bare static-catalog id has a usable ROUTES entry" |
| ⚠ coupling: /v1/models wire shape ↔ 3 docs | — | `couplings.test.js` "every published /v1/models field is named in…" (fields read from the ModelEntry typedef) |

CLAUDE.md couplings table + publishing-contract paragraph updated; CHANGELOG gains a `[0.8.1] — unreleased` section.

## Confirmed-sound (checked, no finding — where NOT to spend successor effort)

- Streaming client-abort teardown: 60 timed mid-stream aborts against the real server, zero unhandled errors (scratchpad probe, logged P2 entry).
- Log-forging defenses (logSafe/requestIdOf/vendorRequestIdOf), credential isolation (applyAuth drops both inbound credential headers off-oauth), haiku pin on the stripped tail, selector/variant strips, dedupByIdentity, hooks lifecycle (stale-version replace, ordered compare), render-html isolation, release gate, slash-command bodies, wire-shape docs (in sync).

## Load-bearing map / implicit contracts

Unchanged from recon — CLAUDE.md's own ranked table was verified accurate against the code and remains the canonical copy (this audit deliberately does not duplicate it; see IC1–IC9 in AUDIT_LOG.md P1/P2 entries for the implicit-contract list and their dispositions).

## Open decisions

- `// DECISION:` F02 ships without a dedicated race test because any feasible timing-based test passes against the defect (the false-assurance class CLAUDE.md's watchdog trap documents); the reclaim's atomicity rests on rename() semantics, stated in the comment, with the existing reclaim/hold tests pinning observable behavior.
- `// DECISION:` docs/BACKLOG.md left untouched — its item numbering and evidence style are maintainer-curated; residual risks live here and in the PR body instead.
- `// DECISION:` `pnpm probe:vendors` not run — real keys/quota (manual gate by design); routing/forwarding changes here touch neither vendor claims nor routing decisions (Host header + error shape only).

## Residual risk register (prioritized)

1. **ROUTES rots silently** (BACKLOG item 12): hand-probed 2026-08-04/14; only `pnpm probe:vendors` re-measures. Run it before the next release touching routing.
2. **LAN exposure under `PROXY_HOST` opt-out**: unauthenticated `/_shutdown` + credential-injecting proxy reachable off-host. Documented tradeoff; optional auth is BACKLOG item 17.
3. **Remaining ⚠ rows**: `MODEL_GRADES` (gradeOf overlays user grades.json — documented) and `mediaBaseUrl` (one-sided edits; partially mitigated by models.test.js e2e).
4. **Un-line-audited tails**: `scripts/bench-grades.js` (from ~line 120) and `scripts/probe-vendors.mjs` (from ~line 80) were skimmed, not line-audited (logged truncation). Both are manual tools with their own test files.
5. **docs/models.html** is a committed artifact CI cannot rebuild — regenerate per the release procedure whenever routing/catalog/renderer changes.

## What's left

Nothing in-phase. Cursor DONE — a future run should pick a new surface (e.g., the bench-* tails, or a probe:vendors session with real keys), not redo this one.
