# AUDIT_LOG.md — append-only

- 2026-08-31 P1: mode=AUTONOMOUS, target=/home/user/cc-proxy-plugin @ a6f05ab (branch claude/principal-audit-autonomous-fd05gq). No prior cursor.
- 2026-08-31 P1: OPERATOR.md charter tooling (.operator/) absent in checkout — logged as charter conflict; proceeding under audit skill evidence discipline.
- 2026-08-31 P1: read src/*.js (all 11), hooks/* (all), bin/cc-proxy.js, scripts/{status,statusline,quota,start-proxy,render-html,release-gate,sync-version,list-models}, skills/setup/SKILL.md, .github/workflows/*, plugin.json.
- 2026-08-31 P1: BASELINE `pnpm check` GREEN: lint clean; 469 tests / 467 pass / 0 fail / 2 skipped (env-gated live-key tests). capture_baseline.sh: "npm test present".
- 2026-08-31 P1: EXIT CRITERIA met (arch map, load-bearing map w/ blast radius, implicit contracts, delta) → AUDIT_STATE.md. Advancing to P2.
- 2026-08-31 P2: not yet read (to sweep): scripts/render-models.js, bench-grades.js, bench-speed.js, probe-vendors.mjs, commands/*.md, docs/*.md, test/couplings.test.js. Candidate probes queued: IC9 client-abort 'error' race; statusline lock reclaim race; coupling ⚠ rows.
- 2026-08-31 P2: probe IC9 (streaming client-abort race): 60 aborts across 2-31ms timing window against real createServer + slow SSE stub — zero unhandled errors/rejections. Streaming teardown CONFIRMED sound (scratchpad/abort-probe.mjs).
- 2026-08-31 P2: swept scripts/{render-models,bench-speed,bench-grades(head),probe-vendors(head),quota}.js, commands/*.md, .env.example, workflows, couplings.test.js. Wire-shape docs (README/OPERATIONS/ARCHITECTURE) verified in sync with ModelEntry fields. Media tunnel + GAUGES + lock single-flight have real test coverage.
- 2026-08-31 P2: findings follow (schema per finding-schema.md).

### [F01] Host header sent upstream drops a non-default port
- **Location:** src/providers.js:466 (`headers.host = hostname`), fed from src/proxy.js:131-137 (`upstreamRequestOptions` passes `url.hostname`)
- **Severity:** P2
- **Confidence:** high
- **Claim tag:** CONFIRMED — reproduced: proxy with LMSTUDIO_BASE_URL=http://127.0.0.1:36479 forwarded `lmstudio:` request; upstream received `Host: 127.0.0.1` (scratchpad/host-probe.mjs output: "DEFECT: port dropped from Host header")
- **Failure trigger:** any provider whose baseUrl carries a non-default port — today exactly LM Studio, whose documented setup form is `http://192.168.1.50:1234`. Every forwarded request sends `Host: 192.168.1.50` (RFC 9112 §3.2 requires host:port for non-default ports).
- **Blast radius:** silent. LM Studio itself currently tolerates it, but any name/port-based front (reverse proxy, vhost router, tunnel) misroutes or 421/400s, and the request looks fine at the cc-proxy log. Hardcoded vendors are unaffected (default ports; `url.host === url.hostname` there).
- **Evidence:** probe above; `new URL("http://127.0.0.1:36479").host` = "127.0.0.1:36479" vs `.hostname` = "127.0.0.1".
- **Fix:** pass `url.host` (not `url.hostname`) into buildUpstreamHeaders; existing test `h.host === "api.z.ai"` stays green because https default port renders no port in `url.host`.
- **Guardrail:** end-to-end test asserting the upstream-received Host header carries the port for a port-carrying baseUrl (server.test.js, both paths share upstreamRequestOptions so one suffices + a unit assert).

### [F02] statusline refresh-lock stale reclaim is check-then-write — two renders can both reclaim
- **Location:** scripts/statusline.js:271-275 (statSync mtime check, then plain writeFileSync)
- **Severity:** P3
- **Confidence:** moderate
- **Claim tag:** CONFIRMED (traced) — the reclaim branch takes no exclusive flag; two processes that both observe age >= REFRESH_LOCK_STALE_MS both return true. Race itself not reproduced (sub-ms window).
- **Failure trigger:** a refresher killed >10s ago left refresh.lock; two ~300ms renders race the reclaim within the same tick window.
- **Blast radius:** bounded and non-corrupting: two detached refreshers spawn, each re-checks cache freshness per gauge, so at worst one duplicate round of quota API calls. Fails silent but self-heals.
- **Evidence:** scripts/statusline.js lines 263-280 read in full; single-flight comment documents the wx path only.
- **Fix:** reclaim via `rmSync(lockPath, {force:true})` then retry the exclusive `wx` create once; losers return false.
- **Guardrail:** unit test: abandoned (backdated-mtime) lock present → exactly one of two sequential takeRefreshLock calls wins after reclaim (the second sees a FRESH lock and returns false).

### [F03] streaming 429-peek answers an upstream read error with a socket hang-up where the buffered path sends 502
- **Location:** src/proxy.js:207 (`upstreamRes.on("error", () => clientRes.destroy())`)
- **Severity:** P3
- **Confidence:** moderate
- **Claim tag:** CONFIRMED (traced) — before headersSent the destroy yields a client-visible connection reset; src/server.js:252-255 (forwardBuffered) handles the identical failure with a 502 JSON error when headers are unsent. Not reproduced against a live socket.
- **Failure trigger:** upstream returns 429 on a stream:true request, then the socket dies mid-error-body (vendor reset, timeout destroy).
- **Blast radius:** loud but wrong shape: the client sees ECONNRESET instead of a 502 explaining the upstream failed; retry/backoff logic keyed on status codes never sees one. Rare path (429 + mid-body death).
- **Evidence:** the two handlers read side-by-side; error contract divergence between the paths is the exact drift class onUpstreamError was extracted to prevent (its own docstring).
- **Fix:** mirror forwardBuffered: `if (clientRes.headersSent) clientRes.destroy(); else sendJson-like 502`.
- **Guardrail:** server.test.js case: stub 429 that destroys its socket mid-body on a stream:true request → client must receive HTTP 502, not a reset.
- 2026-08-31 P2: EXIT — dry pass reached; nothing above P3 remains. TRUNCATION LOGGED: bench-grades.js read to ~line 120, probe-vendors.mjs to ~line 80 (manual tools, own test files); docs/BACKLOG.md read structurally, not line-by-line.
- 2026-08-31 P3: F01+F03 tests written FIRST, both red against unfixed code (`not ok 1/2`, # fail 2) — defects reproduced at the test gate.
- 2026-08-31 P3: F01 fixed (src/proxy.js url.host; providers.js param host + JSDoc). F03 fixed (429 branch → onUpstreamError). F02 fixed (statusline reclaim → rmSync .stale / renameSync takeover / wx re-entry).
- 2026-08-31 P3: VERIFY — new tests green (`ok 1/2`, # pass 2); full `pnpm check` GREEN: 471 tests / 469 pass / 0 fail / 2 skipped (baseline 467 pass / 0 fail → +2, no regressions). Statusline reclaim/hold tests included and green.
- 2026-08-31 P3: EXIT — every finding fixed & verified or structurally argued (F02 race-test DECISION in AUDIT_STATE.md).
- 2026-08-31 P4: guardrails — couplings.test.js gains "every bare static-catalog id has a usable ROUTES entry" and "every published /v1/models field is named in README/OPERATIONS/ARCHITECTURE" (fields parsed from the ModelEntry typedef). Ran: 15 pass / 0 fail.
- 2026-08-31 P4: context transfer — CLAUDE.md couplings table updated (two ⚠ rows now name their locks); publishing-contract paragraph updated; CHANGELOG [0.8.1] unreleased section written (3 Fixed, 1 Changed).
- 2026-08-31 P4: FINAL GATE `pnpm check` (post-docs edits): 473 tests / 471 pass / 0 fail / 2 skipped, lint clean. AUDIT_STATE.md rewritten to cursor DONE with verdict, remediation table, residual-risk register, decisions.
- 2026-08-31 CI: first CI run on PR #50 head 32ecd82 failed — 1 test: start-proxy.test.js "falls back to settings.json PROXY_PATH when the tree has no bin" (3082ms ≈ full readiness timeout, empty stdout). Diff-unrelated; root-caused below.

### [F04] start-proxy tests race concurrent test files for the freePort() port — stand-in bin dies on EADDRINUSE
- **Location:** test/start-proxy.test.js:24 (standinBin, no 'error' handler) + :12 (freePort releases the port before the spawn uses it)
- **Severity:** P2
- **Confidence:** high
- **Claim tag:** CONFIRMED — reproduced deterministically (scratchpad/port-steal-probe.mjs): occupy the freed port before the spawn → stand-in exit 1, "listen EADDRINUSE", flag never written; matches CI's empty-stdout assertion failure and its ~3000ms duration (readiness poll exhausting).
- **Failure trigger:** node --test runs test FILES concurrently; another file's listen(0) is assigned the ephemeral port freePort() just released, in the gap before the spawned stand-in binds it.
- **Blast radius:** flaky CI red on an untouched test — erodes trust in the gate and burns re-run cycles; fails loud but misattributes (looks like a resolution bug).
- **Evidence:** probe output above; CI job 99362121103 log: "not ok 3 … Expected started, got: ''", duration_ms 3082.
- **Fix:** stand-in retries listen on EADDRINUSE (bounded, 50×100ms — the thief is an ephemeral test socket); per-run PROXY_READY_TIMEOUT_MS=8000 in the test harness env for headroom. Shipped defaults untouched.
- **Guardrail:** the retry IS the guardrail (a wrong-bin regression still never writes the right flag, so test semantics are preserved); validated 5 consecutive green runs + full suite green.
- 2026-08-31 CI: author pushed 9cc09d5 (release 0.8.1 prep, green) then 6698dc7 — a rework of the F02 fix into scripts/refresh-lock.js with an afterStat test seam + 3 deterministic tests, verifying the moved file by INODE. Its own race test failed on CI (ubuntu) and locally while passing the author's APFS measurement.

### [F05] refresh-lock inode verification false-matches on inode-recycling filesystems — double-grant returns on Linux
- **Location:** scripts/refresh-lock.js:76 (`statSync(claimed).ino !== seen.ino` as the sole identity check)
- **Severity:** P2
- **Confidence:** high
- **Claim tag:** CONFIRMED — probe on this machine (same image class as CI): rm then wx-create returned the IDENTICAL ino (1884209 → 1884209, "REUSED"); the author's own test "hands an abandoned lock to exactly ONE of two racing reclaimers" was red here and on CI (first=true) and is green on APFS where inode numbers are never reused.
- **Failure trigger:** loser judged the lock stale; winner relocks (rm frees inode, wx-create gets the SAME inode back on ext4/overlayfs); loser renames the fresh lock away, its ino comparison matches, loser also wins.
- **Blast radius:** the exact double-grant the rework set out to close, deterministic on Linux (the platform CI and most users run); silent duplicate refresher + quota fetches.
- **Evidence:** ino-reuse probe output; local test run red pre-fix (`not ok 1 … true !== false`), green post-fix; CI job 99377745487.
- **Fix:** identity = ino AND mtimeMs. rename preserves mtime; a takeover lock is a fresh write stamped now, while a judged-stale file's mtime is ≥10s old, so the pair can never coincide. CHANGELOG + code + test comments corrected (they asserted the inode-only contract).
- **Guardrail:** the author's deterministic seam test IS the guardrail — it fails the inode-only variant on any inode-recycling filesystem; comments now state the platform dependence so the APFS-only measurement cannot re-justify the weaker check.
- 2026-08-31 CI: VERIFY — lock suite 3/3 green; full `pnpm check` GREEN: 476 tests / 474 pass / 0 fail / 2 skipped, lint clean.
- 2026-08-31 REVIEW: Copilot review on PR #50, 5 comments. Verified each: (1) three-contender reclaim hole CONFIRMED by reading (loser holds winner's renamed-away lock, path empty, fast-path wx wins, restore clobbers) → reclaimers now SERIALIZE on refresh.lock.claim (exclusive wx + stale recovery), re-validate staleness under the claim, and restore via link() which atomically refuses an existing destination; flock declined (native dep, zero-dep repo); residue (hung-refresher unlink inside µs windows) documented in the module header. 3 new seam tests (afterRestat/afterRename hooks); the clobber test mutation-verified RED against a rename-back restore, green with link(). (2) CLAUDE.md trap bullet still asserted inode-only → corrected to ino+mtime + ceremony. (3) couplings typedef parser scope → deliberate (docs describe cc-proxy's OPTIONAL additions; required four are Anthropic's base shape) — comment now states it; replying on thread. (4)(5) AUDIT_STATE stale DECISION + totals → updated (decision marked SUPERSEDED by the author's seam; final figures 479/477/0).
- 2026-08-31 REVIEW: VERIFY — lock suite 6/6 green; full `pnpm check` GREEN: 479 tests / 477 pass / 0 fail / 2 skipped, lint clean.
- 2026-08-31 REVIEW-2: Copilot round 2, 2 comments, both valid. (1) The stale-CLAIM recovery (rm+recreate) was the same check-then-act race one level down — one racer could delete the other's fresh claim and both ran the ceremony. Fixed: ONE shared takeover ceremony (takeStale: judge-by-mtime → rename-to-pid-private → verify ino+mtime → link()-restore on mismatch) now serves both the lock and the claim; claim recovery goes through it. New deterministic test "hands an abandoned CLAIM to exactly ONE of two racing reclaimers" (claim.afterRestat seam) — 7 lock tests total; clobber test re-mutation-verified red under a rename-back restore. (2) CHANGELOG 0.8.1 lock paragraph described the superseded round-2 protocol — rewritten to the full defect ladder + shipped protocol + stated residue. Convergence note: if a further round re-flags the flock-free residue itself, stop pushing and raise once (it is stated as irreducible without a native dep).
- 2026-08-31 REVIEW-2: process slip logged: a `git checkout` used to restore the module after a mutation run resurrected the COMMITTED (older) version over the uncommitted rewrite — caught immediately by the test suite (claim test red), rewritten from context, all green. Destination check (charter SOLO rule) would have caught it pre-run.
- 2026-08-31 REVIEW-2: VERIFY — lock suite 7/7; full `pnpm check` GREEN: 480 tests / 478 pass / 0 fail / 2 skipped, lint clean.
