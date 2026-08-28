# cc-proxy — backlog and decision register

The long-form companion to [`CLAUDE.md`](../CLAUDE.md). CLAUDE.md carries the
rules you need loaded in every session; this file carries the evidence behind
them — probe matrices, measurements, refuted alternatives, and the open
questions nobody has answered yet. Read it when CLAUDE.md points you here, or
before reversing a decision.

**Write down what you do NOT know, not only what you decided.** Every entry
earns its length the same way: the unknown is stated as plainly as the
conclusion. A backlog of decisions reads as settled and invites the next reader
to build on sand; a backlog that names its open questions tells them where the
ground is soft. Three shapes worth spelling out every time:

- **Unverified assumptions** — what was probed and when, versus what was
  inferred. `ROUTES` (item 12) is a set of statuses from one afternoon; that
  sentence is why nobody trusts it blindly.
- **What a fix did NOT cover.** Item 15 exists because a test PASSED against the
  defect it was meant to catch — deleting it and saying so is worth more than
  leaving a green assertion that guards nothing.
- **What would kill an idea**, listed hardest-first, before it is built. Item 9's
  leaderboard direction listed four; building it hit them in order, and the
  third ("their axis is not our axis") is what forced `grade` off benchmark
  scores onto vendor version ordering. If the blocking question is unanswerable,
  that is the finding.

The same rule applies to a session report: state what only the human can verify
from where they sit, and mark anything unverified as such rather than rounding
it to done. **An unknown that outlives the session belongs in a GitHub issue
labeled `question`, not in a chat reply** — the register is the part that
survives.

Item numbers are stable and never reused — DONE items keep their slot so older
notes referencing "backlog item N" still resolve.

## Open work and closed items

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
8. ~~**Explicit provider-prefix ids (`<provider>:<model>`)**~~ — **DONE
   (feat/route-selection).** Shipped as a COLON-ONLY selector (`src/router.js`
   `parseModelSelector`), with the cost rank in `src/routes.js` (`ROUTES`,
   `rankRoutes`, `tierOf`). Spec: `docs/specs/route-selection.md`. Keep reading
   the item — the probe matrix and the billing/tier vocabulary below are still
   the reference, and item 9 builds on them.

   **The `/` trap dissolved rather than being solved.** The worry was that
   OpenRouter's `includes("/")` claims the whole slash namespace, so
   `qwen/deepseek-v4-pro` could never mean the plan. True — and irrelevant, once
   probed: the BARE id already routes to the native backend when one is
   registered (otherwise the cheapest route) and the slash form already routes
   to the most expensive one (`qwen3.7-max` → plan,
   `qwen/qwen3.7-max` → OpenRouter). A slash selector therefore buys nothing in
   either direction, so `/` was left to OpenRouter untouched and the collision-
   lock tests (`test/router.test.js:65,77,179`) never needed changing.
   `:` was live-verified through Claude Code's `/model` picker on 2026-08-06 —
   it reaches the proxy intact.

   **What the lens cost, and where the danger was.** The selector must be
   stripped before forwarding (a backend 400s on our local spelling), and that
   strip is what nearly broke invariant 4: the haiku pin tested the RAW model
   id, so `glm:claude-haiku-…` skipped the pin AND arrived upstream as the bare
   haiku id — internal ops billed to a third party. The pin now tests the
   STRIPPED TAIL and discards any selector. Caught by an adversarial review, not
   by the original design; both the unit and end-to-end guards were
   mutation-tested against a reintroduction of the defect.

   Original scoping notes follow. Motive is
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

   **REVERSED 0.6.1 (issue #19) for `deepseek-v4-pro` — NATIVE wins over the
   plan WHEN NATIVE IS REGISTERED.** The "plan before credits" policy below
   shipped in 0.5.1 and is overturned for this one id: the plan gateway injects
   a +79-token preamble, so the plan and native routes are NOT interchangeable,
   and the bare id is the one `/model` sets — defaulting it to the plan silently
   rerouted users who had tuned prompts against native weights. The fix is a
   STRENGTHENING of `rankRoutes` (src/routes.js): the NATIVE provider now sorts
   ABOVE tier, not just as a tier tiebreak. So for `deepseek-v4-pro` (native
   deepseek tier 3 vs plan qwen tier 2) native wins; for every other multi-route
   id nothing changes (`glm-5.2` already resolved native via the tiebreak). The
   plan route is NOT removed — a plan-holder WITHOUT a native DeepSeek key still
   lands on it (the native route isn't registered, so `resolve` skips to the
   next-ranked qwen route), and `qwen:` always reaches it. `QWEN_PLAN_RESELLS`
   stays populated: the predicate is the capability/last-resort router, and
   claiming the id is the honest "the plan serves this" statement — preference
   (native-first) lives in rankRoutes, not the predicate. A first attempt used
   a `default: false` route flag to exclude the plan from the auto-pick; review
   REFUTED it because a plan-only user then lost the model entirely (the flag
   was unconditional; native-first is registration-aware). Everything below —
   the probe matrix, the tier vocabulary, the cost rank — remains the reference;
   only the native-vs-tier precedence for one id changed.

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
   this item exists, and it is still true as a COST fact. **It is no longer
   what the bare id resolves to.** 0.6.1 (issue #19) made `rankRoutes` sort the
   native provider ahead of tier for this id specifically, because the plan
   gateway injects a +79-token preamble (see below) — predictability (the id
   you tune a prompt against stays the id you get) outweighed the sunk-cost
   saving. A DeepSeek-key holder now pays the expensive route by default;
   `qwen:deepseek-v4-pro` still reaches the cheap one explicitly.
   `deepseek-v4-flash`, though, is credits-only: the plan
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

   **WIRED AND REFRESHABLE (0.6.1); the grades themselves still are not.**
   The map moved from `scripts/render-models.js` to `src/models.js` as
   `MODEL_GRADES` (+ `gradeOf`), and every `/v1/models` entry carries **`grade`**
   (capability) alongside **`tier`** (cost, 1–4 from `src/routes.js`) — for an
   ASSESSED model only. That was the reversal this paragraph warned about: a
   curated opinion is now API surface.

   `render-models.js` no longer re-exports the table as its lookup path either.
   `MODEL_TIERS = MODEL_GRADES` read the BUILT-IN table, so a `bench grades`
   refresh moved the endpoint and left `docs/models.html` behind — the same
   "curated data in two places" drift the file's own docstring forbids,
   reintroduced by the very line meant to prevent it. Re-exporting a table is
   not the same as sharing a lookup: the table is one input to `gradeOf()`, and
   the refresh is the other. The renderer now calls `gradeOf()`, keeping only
   its `<provider>:` tail fallback (which `gradeOf()` deliberately lacks —
   `collectModels()` grades on the bare `entry.id` before the lens goes on).

   **The refresh loop was a DEAD END until 0.6.1 and this is worth remembering.**
   `/cc-proxy:bench grades` wrote `~/.claude/cc-proxy/grades.json` and *nothing
   read it* — `gradeOf()` returned the built-in table regardless. So the command
   showed the operator one set of grades while discovery published another, and
   measured on 2026-08-12 they disagreed on **13 of 24 ids** (`qwen3.8-max`
   Strong vs Flagship, `glm-4.7` Economy vs Specialist — Economy being a value
   the same release then retired, `claude-sonnet-5` Strong vs Specialist, …).
   cc-operator dispatches on the published field, so it was
   dispatching on the stale half. The lesson generalizes: a refresh command that
   writes a file nobody reads looks exactly like a working feature — the
   observable that catches it is "does a consumer's answer CHANGE after the
   refresh", not "did the command succeed".
   `gradeOf()` now reads `grades.json` at STARTUP, falling back to the built-in
   table per-id. That is config, not state — the `~/.env` posture: written by a
   human command, read once at boot, never on a request path. Invariant 2
   forbids state carried BETWEEN requests, and a running proxy's answers still
   never change for its lifetime. Locked by `test/grades-refresh.test.js`
   (mutation-verified), including the fallbacks that keep discovery answering
   when the file is missing, truncated mid-write, or hand-edited to junk, and
   the `constructor` prototype trap this repo has now hit three times.

   The refresh is also VALIDATED as of 0.6.1, per entry. It used to accept any
   non-empty string, and a live proxy was made to publish `"grade":"SuperDuperMax"`
   and `"grade":"   "` on `/v1/models` from a hand-edited file — straight into
   cc-operator's dispatch input. Anything outside the allowed set is skipped and
   the id falls back to its built-in grade; skipping the ENTRY rather than the
   file is the house style, because one bad row must not void a refresh of 300
   good ones. Note the second thing this buys: a stale `grades.json` written
   before the retirement below cannot smuggle `Economy` back onto the wire.

   **DECIDED 2026-08-12 — the field now means what it says.** Both halves of the
   question this item held open are answered, and both are breaking changes to a
   published contract, affordable only because `grade` has no consumer yet
   (cc-operator reads `/v1/models` for membership only).

   (a) **An unassessed id OMITS `grade`.** `DEFAULT_GRADE` is deleted; `gradeOf()`
   returns `undefined` and `withGrade()` leaves the key off — never `null`, never
   an `"Ungraded"` placeholder, exactly the rule `context_window` follows, so a
   consumer writes `"grade" in entry`. The measurement that forced it, taken
   2026-08-07 against the live proxy: of 320 usable entries **299 were
   `Specialist`** (7 Flagship, 9 Strong, 5 Economy) — a field claiming to have
   assessed 320 models when it had assessed 21. The scale is why the default had
   to go rather than be filled in: grading ~320 live-catalog ids by hand is not
   going to happen, so the honest scope is "the ids someone actually assessed",
   and the eval harness below stays a prerequisite for widening it.

   (b) **`Economy` is retired.** It was a COST class ("cheap and fast") on a
   CAPABILITY axis, which is the exact conflation the tier/grade split exists to
   prevent — and the evidence was already in hand: `deepseek-v4-flash` measured
   equal to `glm-5.2` on implementation work. It was also de-facto gone already,
   since `scripts/bench-grades.js` emits only Flagship/Strong/Specialist, so any
   operator who had run `bench grades` held an Economy-free table. The five ids
   that carried it (`glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`,
   `qwen3.6-flash`) are `Specialist` — superseded generations still in service,
   which is a narrow remit. The allowed set is now exactly
   `Flagship | Strong | Specialist`, exported as `GRADES` and enforced on the
   refresh path, with `Specialist` keeping its meaning: NARROW, the residual
   ASSESSED bucket. "Unknown" is no longer a value; it is an absence.

   The renderer needs a word for that absence anyway — a row still has to sort
   and print something — so `render-models.js` names it `UNGRADED` ("ungraded",
   lowercase, 0 of 4 dots, sorting below every grade). It is deliberately NOT in
   `GRADES` and never reaches the wire. An empty scale reads as "no reading
   taken"; one filled dot would have read as "measured, and weak".

   TWO FIELDS, TWO AXES, NEVER READ ONE OFF THE OTHER: `deepseek/deepseek-v4-pro`
   is tier 4 (expensive, resold) and Flagship (same weights as native); the plan
   serves that same Flagship at tier 2. Collapsing them would make one a lie —
   and letting a cost word onto the capability axis is how `Economy` got there.

   **What remains open is the part that actually needed evals** — the grades are
   still one person's read of vendor marketing, now published where another tool
   dispatches on them. Everything under "Grades need evals" below still stands.

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
10. ~~**Reset-time display is inconsistent between the two tools**~~ — DONE
    (fix/statusline-stampede). `formatDuration()` moved into `scripts/quota.js`
    and both tools call it; the CLI now renders `(resets in 2h15m, <UTC>)`,
    keeping the absolute stamp because that report gets pasted into issues.
    Locked by `test/quota.test.js` ("is the single spelling shared by..."),
    which also fails if the statusline regrows its own arithmetic. Original
    note kept below for the reasoning.

    ORIGINAL:
    `scripts/status.js` renders the GLM quota reset as an absolute UTC stamp
    (`resets 2026-08-04T20:43:41Z`) while `scripts/statusline.js` renders a
    relative countdown (`⏱2h15m`, via `formatResetTime`). Same fact, two
    formats — and the absolute one makes a reader in a non-UTC zone do the
    arithmetic. Neither is *wrong*: `status.js` uses `toISOString()` (epoch →
    UTC, unambiguous by construction) and the statusline subtracts two epoch
    values (a pure duration, timezone-independent). So this is a formatting
    change only — render `(resets in 2h15m)` in the CLI too, from the same
    `resetMs` it already has. Do not "fix" it as a timezone bug; there isn't one.
11. ~~**No clock-drift check on the quota gauges.**~~ — DONE
    (fix/statusline-stampede). `clockSkewMs()` reads the `Date` header off the
    response the fetcher ALREADY makes; past `CLOCK_SKEW_THRESHOLD_MS` (60s)
    `fetchGlmQuota` attaches `_skewMs`. The statusline marks the gauge `?`, and
    `/cc-proxy:status` names the offset and direction. Both constraints from the
    original note were honoured: it lives in `scripts/quota.js`, never `src/`
    (invariant 2), and the threshold stayed loose because RTT inflates apparent
    skew. Absent `_skewMs` means "checked and fine", never 0. Original below.

    ORIGINAL: Every countdown assumes the
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
12. **`ROUTES` is hand-probed and silently rots.** Every entry in
    `src/routes.js` is a status a host returned on one day. Nothing offline can
    tell you it still holds, and the two failure modes differ sharply:
    - an id that starts **403-ing** on a plan degrades safely — `rankRoutes()`
      skips it and the predicate fallback in `providers.js` still routes the
      request, just to a costlier backend and without saying so;
    - an id that is **renamed or withdrawn** drops out of discovery entirely,
      and because a catalog now mirrors a live response, the offline fallback
      keeps advertising it until someone notices.
    Re-probe before each release (`POST /v1/messages`, 1 token, per cell). The
    matrix in item 8 is the reference shape. There is no test that can catch
    this — that is the point of writing it down.
13. **`docs/models.html` regressions are invisible to CI, and one already got
    through.** The artifact is generated against a LIVE proxy, so the gate can
    only ever compare a committed file to the static catalog. An adversarial
    review proved the consequence on 2026-08-07: reintroducing the renderer's
    provider-attribution defect left **all 17 artifact tests green**, because
    they read the committed HTML rather than running the renderer.
    Partly closed — `test/render-models.test.js` now drives
    `scripts/render-models.js` as a subprocess against a stub `/_status` +
    `/v1/models` (mutation-verified: the defect fails with "DeepSeek card
    missing"). What remains open is everything only a real backend can produce:
    a vendor renaming an id, a leg timing out, a catalog shape change. Those
    still surface only when a human regenerates and looks.
14. ~~**`coerceCreated()` does not validate its string branch**~~ — **DONE**
    (Copilot review on PR #18 raised it independently the same day, which is a
    fair signal it was not worth deferring). Unparseable strings now null;
    parseable ones pass through VERBATIM rather than round-tripping through
    `Date`, which would silently rewrite a vendor's offset (`+02:00` → `Z`) and
    drop sub-second precision on a value that is already valid.
15. **`handleProxy()` is not exported, so its body handling cannot be unit
    tested.** Surfaced by the same review: it used to write
    `stripped.body.model = upstreamModel`, an in-place edit of the inbound body
    (`stripAssistantThinking` returns the caller's own object when it strips
    nothing). Fixed by building an outbound object — but the fix is **not
    directly locked**, and the reason is worth keeping: every observable is
    identical under the defect, because `inboundModel` is captured before the
    rewrite. An end-to-end test asserting the log line and the upstream body
    PASSES against the in-place write (verified by mutation, then deleted rather
    than left in place looking like a guard).
    What is locked is the contract underneath: `test/sanitize.test.js` "returns
    the SAME object when nothing was stripped" (mutation-verified — returning a
    copy fails 2 tests). Exporting `handleProxy` for a direct test is the real
    fix; weigh that against widening the module's surface.

16. **Gateway model discovery** (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`)
    — CC ≥2.1.129 populates the native `/model` picker from the gateway's
    `/v1/models` when this env var is set (opt-in since v2.1.129; see
    anthropics/claude-code#56492). cc-proxy already publishes that endpoint as
    its downstream publishing contract, so adoption is documentation-first:
    set the flag in `/cc-proxy:setup`'s env block and the one-custom-slot
    constraint dissolves — every curated id becomes pickable. Three things
    must be MEASURED before wiring it in, not assumed: CC's tolerance of our
    non-standard fields (`provider`/`tier`/`grade`, `created_at: null`,
    `_errors`); the ~320-id OpenRouter flood into the picker (throttle =
    existing `OPENROUTER_MODELS`, recommend pinning the graded six by
    default); and whether CC reads `context_window` from a discovered model
    or needs `CLAUDE_CODE_AUTO_COMPACT_WINDOW` separately for 1M GLM to
    compact correctly. → issue #44.

17. **Optional proxy auth for the off-loopback escape hatch.** `PROXY_HOST`
    is the documented opt-out of the loopback bind (invariant 7), and that
    opt-out currently exposes the credential-injecting proxy to the LAN with
    zero auth. Proposal: `PROXY_AUTH_TOKEN`, unset = unchanged behavior;
    set = Bearer/`x-api-key` required on `/v1/*` (401 before body parse),
    required on `/_shutdown`, still open on `/_ping`+`/_status` (liveness,
    no secrets). Stateless per-request check, so invariants 2 and 3 are
    untouched. Found by recon of free-claude-code, which requires a
    constant-time bearer check for exactly this reason. → issue #45.

18. **Request-ID correlation.** The routing log answers "where did this go"
    but not "which line was my request" — and with one shared proxy process
    across sessions, it usually is being asked by someone whose line is
    interleaved with four others. One short opaque id per request, echoed as
    `x-request-id` and stamped on the routing line (plus the vendor's own
    `request_id` when an error body carries one). Deliberately a two-file
    change: the log template is LOCKED by `test/couplings.test.js`
    ("stays parseable by scripts/status.js"), so `parseRoutingLines()` moves
    in the same commit or the lock fails — that is the lock working.
    → issue #46.

19. **Kimi/Moonshot as a next provider.** FCC's 50-provider table lists two
    Moonshot legs — `kimi/` (metered API) and `kimi_code/` (subscription,
    terms scoped to personal interactive coding agents) — and Moonshot
    advertises an Anthropic-compatible endpoint. If it speaks real Messages
    (probe, never read the page), it slots in like DeepSeek did: one gated
    entry, `PROVIDER_IDS`, three test suites, no router/server changes.
    Expect the Qwen trap: plan keys bound to plan-specific hosts, and the
    two plans likely resell overlapping ids at different tiers — the
    `QWEN_PLAN_RESELLS` / "plan before credits" question applies.
    → issue #47.

20. **FCC features reviewed and declined** — the recon that produced #44–#47
    also surveyed free-claude-code's feature set: auto-fallback mid-turn
    (invariant 2 + silent second-provider billing), local short-circuit
    "optimizations" (invariant 1; the haiku pin already covers the value),
    OpenAI Responses/Codex/Cline surfaces (invariant 5 — ~40% of FCC's
    codebase), `web_search`/`web_fetch` emulation (fails 1's letter, 5's
    spirit), preserving thinking blocks across backends (blocked by
    statelessness, same wall as item 1), Admin UI / messaging bridges /
    voice (different product). Each declined on a named invariant; the full
    table with reasons lives in issue #48 so nobody re-litigates them.
    Meta-lesson worth keeping: FCC is high-quality engineering with the
    opposite product thesis — "resist making it more than that" is this
    repo's first sentence for a reason.

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
