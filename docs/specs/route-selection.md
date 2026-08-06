# Spec: provider-namespaced model ids + cheapest-route selection

**Target repo:** `cc-proxy-plugin`. Touches `src/router.js`, `src/providers.js`,
`src/models.js`, plus a new `src/routes.js`.

**Status:** SHIPPED 2026-08-07 on `feat/route-selection`. Written 2026-08-06 as a
design. Route matrix probed 2026-08-04 (see CLAUDE.md backlog item 8 for the raw
probe output).

**Read this as the design record, not as current behavior.** Where the
implementation departed from the design the section says so inline (see
"discovery" below — the biggest departure by far). For what the code does today,
`CLAUDE.md` and the tests are authoritative; this file explains *why* the shape
is what it is.

---

## Problem

A model id is routed today by **prefix guessing**: `glm-` → Z.ai, `deepseek-` →
DeepSeek, `includes("/")` → OpenRouter (`src/providers.js:84-207`). Two failures.

**1. No way to name a route.** The same model is reachable on several backends at
several prices, and multi-backend is the normal case, not an exception:

| id | backends serving it (200) | backends refusing it |
|---|---|---|
| `deepseek-v4-pro` | qwen plan, deepseek native, openrouter | — |
| `glm-5.2` | glm native, qwen plan | — |
| `deepseek-v4-flash` | deepseek native, openrouter | qwen plan (403) |
| `deepseek-v4-flash-0731` | qwen plan | deepseek native (400, id unknown) |

`QWEN_PLAN_RESELLS` — a two-entry hardcoded `Set` at `src/providers.js:72` — picks
one silently, and **no spelling reaches the others**. That matters because the
routes are not behaviourally identical: the plan gateway injects a per-model
preamble (+79 input tokens on `deepseek-v4-pro`, +6 on `glm-5.2`, same 9-word body,
reproducible). A prompt tuned against native DeepSeek currently has no way home.

**2. No cost model.** "Plan capacity is sunk cost, credits are real money" lives in
prose and in that one `Set`. It cannot be queried, tested, or published.

## Non-goals

- **No live route index.** No cross-request state, no on-disk cache — invariant 2
  stands. The table is static.
- **No live OpenRouter catalog** (deferred). OpenRouter stays the static
  `DEFAULT_OPENROUTER_MODELS` list: it is the lowest tier and the SHTF fallback, so
  freshness there buys the least.
- **No automatic failover.** "Use the plan when Z.ai's quota is spent" needs
  cross-request state. An explicit selector the user picks is stateless; failover is
  not.
- **No role vocabulary.** This publishes a *cost* tier and a *capability* grade.
  Mapping those to job roles is cc-operator's business (CLAUDE.md backlog item 9).

## Locked decisions

### The prefix is a local lens

`qwen/deepseek-v4-pro` is **cc-proxy's own name for a route**. It exists only inside
our namespace. No backend ever sees it: `src/router.js` is the only module that
interprets the prefix, and everything upstream of the router receives the bare
vendor id.

Two consequences worth stating plainly:

- The prefix can never cause an upstream 400 — it is stripped before the request
  leaves.
- We own the spelling, so it is free to change without vendor coordination.

### Colon is the ONLY separator; `/` keeps meaning OpenRouter

`<provider>:<model>`, and nothing else. `/` is left entirely to OpenRouter's
existing `includes("/")` predicate, forever.

Probed 2026-08-06 — Claude Code's `/model` picker accepts a colon id and it
reaches the proxy:

```
[2026-08-06T15:32:53.838Z] qwen:qwen3.7-max -> qwen /v1/messages?beta=true
```

(The upstream 400 that followed is the lens leaking — nothing strips the prefix
yet. That is the half this spec adds.)

**Why a `/` selector was dropped rather than carried as a second spelling:** the
bare id already resolves to the cheapest route and the slash form already
resolves to the most expensive one. Verified against the live registry:

| spelling | route | tier |
|---|---|---|
| `qwen3.7-max` | qwen plan | 2 |
| `qwen/qwen3.7-max` | openrouter | 4 |
| `deepseek-v4-pro` | qwen plan | 2 |

So a `/` selector buys nothing in either direction. Its one unique job was
naming a plan-resold id under a foreign vendor name (`qwen/deepseek-v4-pro`), and
`qwen:deepseek-v4-pro` does that identically — without touching OpenRouter's
namespace, without consulting any catalog, and without breaking a single existing
test.

Consequently `test/router.test.js:65,77,179` (the `deepseek/*` and `qwen/*`
collision-locks) stay green **as written**. There is no breaking change here.

### The selector parse is explicit and runs FIRST

Today's colon handling is accidental and mostly wrong — the ids that work do so
by luck:

```
qwen:qwen3.7-max          -> qwen        (luck: startsWith("qwen"))
glm:glm-5.2               -> claude      (fallback — wrong)
deepseek:deepseek-v4-pro  -> claude      (fallback — wrong)
openrouter:tencent/hy3    -> openrouter  (luck: includes("/"))
```

`parseModelSelector(model, config)` matches `^(<registered provider id>):(.+)$`
and nothing else. No catalog lookup. The tail **keeps any slash it carries**, so
`openrouter:tencent/hy3` yields tail `tencent/hy3`. It runs strictly ahead of
every predicate, so nothing can resolve by coincidence.

### Provider == name prefix ⇒ no prefix rendered

`glm:glm-5.2` resolves, but canonicalizes to `glm-5.2`. A prefix is *rendered*
only on a **dedup hit** — a backend carrying a model whose id does not begin with
that backend's own name. Hence the target listing:

```
glm-5.2                       GLM
deepseek-v4-pro               DeepSeek
qwen3.8-max                   Qwen
qwen:deepseek-v4-pro          Qwen   <- dedup hit, prefix rendered
qwen:deepseek-v4-flash-0731   Qwen   <- dedup hit, prefix rendered
```

### Prefix-strip rewrites `body.model`

Second carve-out to invariant 1 (byte-for-byte bodies), alongside the
`src/sanitize.js` thinking-strip. Strictly: replace `model` with the tail, change
nothing else. Without it the lens leaks and the feature is inert.

### Ids rename; the table must survive it

`deepseek-v4-flash` is expected to be renamed upstream. Therefore an id **absent
from the table falls through to the existing `match()` predicates and still
routes** — never a hard failure. The coverage test asserts "every discovery id is
either in `ROUTES` or matched by a predicate", not "every id has a table entry".
Dated and renamed variants stay reachable through the `DATED_ID` predicate that
already exists (`src/providers.js:38`).

## Tier model

| tier | meaning | providers today |
|---|---|---|
| 1 | Anthropic, OAuth passthrough | `claude` |
| 2 | plan / prepaid capacity, native or contracted resale | `glm`, `qwen` |
| 3 | metered credits at the model's own provider | `deepseek` |
| 4 | reseller buying at market | `openrouter` |

Tier 3 is a **billing mode, not a provider identity**. A tier-2 provider that later
exposes a credit-billed API must be expressible as tier 3 for those ids — so the
rank function takes `(providerId, route)` and reads billing off the route entry,
defaulting to the provider's mode. Symmetrically, if DeepSeek ships a plan, it
becomes tier 2 by changing one entry.

Tier is a property of the **(id, backend) pair**, never of a provider: qwen is
tier 2 for `qwen3.8-max` *and* tier 2 for its resold `glm-5.2`, while openrouter is
tier 4 for everything.

## Design

### `src/routes.js` (new)

```js
export const PROVIDER_BILLING = {
  claude: "oauth-plan", glm: "plan", qwen: "plan",
  deepseek: "credits", openrouter: "reseller",
};

export function tierOf(providerId, route) {
  // route.billing ?? PROVIDER_BILLING[providerId] -> 1|2|3|4
}

// Complete, not curated. `status` is what the live probe returned (2026-08-04);
// non-200 rows are kept so a known-unavailable route is documented rather than
// silently absent, and so re-probing is a diff rather than a rediscovery.
export const ROUTES = {
  "deepseek-v4-pro":        [{ provider: "qwen",     status: 200 },
                             { provider: "deepseek", status: 200 }],
  "deepseek-v4-flash":      [{ provider: "qwen",     status: 403 },
                             { provider: "deepseek", status: 200 }],
  "deepseek-v4-flash-0731": [{ provider: "qwen",     status: 200 },
                             { provider: "deepseek", status: 400 }],
  "glm-5.2":                [{ provider: "glm",      status: 200 },
                             { provider: "qwen",     status: 200 }],
  "glm-5.1":                [{ provider: "glm",      status: 200 },
                             { provider: "qwen",     status: 403 }],
  "glm-5":                  [{ provider: "glm",      status: 200 },
                             { provider: "qwen",     status: 403 }],
  // glm-5-turbo, glm-4.7, glm-4.6, glm-4.5, glm-4.5-air -> glm only
  // qwen3.8-max, qwen3.8-max-preview, qwen3.7-max, qwen3.7-plus, qwen3.6-flash -> qwen only
  // claude-fable-5, claude-opus-5, claude-sonnet-5 -> claude only
};
```

`rankRoutes(id)` → candidates with `status === 200`, sorted by `tierOf`, stable.
**Ties break toward the native provider** — the one whose id prefixes the model id.
That reproduces today's "a native plan outranks a resold plan" call (`glm-5.2` stays
on Z.ai) without special-casing it.

### `src/providers.js`

- Delete `QWEN_PLAN_RESELLS` and the `planResells` closures threaded through three
  `match()` predicates. `ROUTES` subsumes them.
- Otherwise leave every predicate **unchanged** — they are the fallback for ids the
  table has never seen.
- Add `parseModelSelector(model, config)` → `{ providerId | null, model }`:
  match `^(<registered provider id>):(.+)$`, else no selector. No catalog lookup,
  no `/` case; the tail keeps any slash it has.

### `src/router.js`

```
0. parseModelSelector             -> { providerId, tail }
1. tail startsWith claude-haiku-  -> claude   ALWAYS, selector discarded
2. providerId, if registered      -> that provider
3. ROUTES[tail] -> rankRoutes     -> first candidate that is registered
4. first non-default p.match(tail)                              (unchanged predicate)
5. defaultProvider                                              (unchanged)
```

**Step 1 tests the stripped tail, not the raw input** — and it outranks the
selector. `src/router.js:20` currently pins on `startsWith("claude-haiku-")`
against the raw string, so a prefixed id would skip the pin entirely and the body
rewrite would then send the *bare* haiku id to a third party:

```
glm:claude-haiku-4-5-20251001  -> glm    *** haiku leaves Claude, quota burned ***
```

That is invariant 4, not a preference, so a `claude-haiku-*` tail discards any
selector rather than honoring it.

`resolve()` now returns `{ provider, upstreamModel }`; `upstreamModel` differs from
the input only when a selector was stripped. **This is a signature change** with
three call sites, not two:

- `src/server.js:178` — `handleProxy`, the live path.
- `scripts/list-models.js:95` — `resolve(id, { providers })`.
- `test/models.test.js:94`.

A missed call site silently routes on the un-stripped id, so a thin
`resolveProvider()` wrapper is acceptable if the diff gets noisy.

### Body rewrite

`handleProxy` already holds the parsed `body` **before** either path branches, so
one decision serves both. Note the streaming path does *not* parse the body
itself (`src/server.js:196-198` hands `outboundBuffer` straight to `forward()`),
and `outboundBuffer` reuses `bodyBuffer` byte-for-byte when nothing was stripped
(`:182-185`). Extend that same condition:

```js
const rewritten = upstreamModel !== body.model;
if (rewritten) stripped.body.model = upstreamModel;
const outboundBuffer = (stripped.modified || rewritten)
  ? Buffer.from(JSON.stringify(stripped.body))
  : bodyBuffer;
```

No second parse, and the byte-for-byte reuse survives untouched when neither a
lens nor a strip applied.

### `src/models.js` — discovery

- `collectModels()` emits one entry per **canonical** id (deduped across backends by
  `rankRoutes`), plus prefixed entries for the losing routes.
- **SUPERSEDED IN IMPLEMENTATION — three axes, not two.** This section originally
  said "the winner is derived, never restated": a catalog listed only its own
  vendor's ids, `collectModels()` derived the bare entry from whoever won the
  cost rank, and a foreign catalog entry was forbidden (locked by a test named
  "no static catalog restates a route it does not own", since deleted).
  That held while catalogs were hand-curated. It stopped holding when the Qwen
  and OpenRouter legs became LIVE fetches: a catalog is then a mirror of another
  host's response, and its offline fallback must match — foreign ids included,
  or the fallback publishes a different list than the live path.
  What shipped instead separates three questions that the original conflated:
  - a **catalog** says what a backend SERVES (foreign ids allowed; each needs a
    `200` `ROUTES` entry naming that backend, or it claims an unprobed route),
  - **`ROUTES`** says who serves it CHEAPEST — this is what the bare id resolves
    to,
  - **namespace ownership** (`ownsId`) decides the published SPELLING: own
    namespace bare, everything else under the `<provider>:` lens.
  So `deepseek-v4-pro` is published bare under DeepSeek and as
  `qwen:deepseek-v4-pro` under the plan, while the bare id ROUTES to the plan.
  Listing and routing disagree deliberately.
  → `test/routes.test.js` "a catalog may list a foreign id it serves — the lens
  keeps it unambiguous", plus "every id that a static catalog publishes has a
  route or a predicate". Both mutation-verified.
- Each entry gains `provider` (winning backend) and `tier` (integer 1–4).
- `MODEL_TIERS` moves from `scripts/render-models.js:42` into `src/models.js` and is
  published as **`grade`** — the capability axis, deliberately a separate field from
  the cost `tier`. `scripts/render-models.js` re-exports from `src/`. This makes a
  curated opinion part of the API surface: every new model needs a grade before
  discovery is fully correct, and unknown ids default to `Specialist` as today.
- `CONTEXT_WINDOW` and `withContextWindow` (`src/models.js:49,82`) are reused
  unchanged, keyed on the canonical bare id; prefixed entries inherit via the tail.

### `scripts/list-models.js`

Group by winning provider, blank line between groups, prefix only on dedup losers.
Reuses `formatContextWindow` (`:61`) and `DEEPSEEK_PRICING` (`src/models.js:263`).

## Coupling obligations

- `docs/ARCHITECTURE.md`: new "route selection" section.
- `CLAUDE.md`: invariant 1 amended with the prefix-strip carve-out; backlog item 8
  marked DONE; item 9 marked partial (grade published, evals still absent).
- `docs/models.html` is generated against a **live** proxy: `POST /_shutdown`,
  restart, *then* `pnpm models:html`. Skipping the restart silently captures the old
  catalog.
- README + `docs/OPERATIONS.md`: the `/v1/models` response shape gained `provider`,
  `tier`, `grade`. No test enforces this — three hand edits.

## Tests

- **`test/routes.test.js`** (new) — rank ordering (plan before credits; native plan
  before resold plan for `glm-5.2`); non-200 routes never returned; every `ROUTES`
  provider id is a real provider id; coverage check (every discovery id is in
  `ROUTES` *or* matched by a predicate).
- **`test/router.test.js`** — `qwen:deepseek-v4-pro` → qwen with `upstreamModel`
  stripped to the bare id; `glm:glm-5.2` → glm (selector honored where luck
  previously sent it to the default); `openrouter:tencent/hy3` → openrouter with
  the slash-bearing tail intact; `deepseek/deepseek-v4-pro` still → openrouter
  (slash untouched); a selector naming an unregistered provider falls through
  rather than erroring; **`glm:claude-haiku-4-5-20251001` → claude** (invariant 4
  outranks the lens). Every existing test must still pass — the slash
  collision-locks at `:65,:77,:179` unmodified, and "dated `claude-*` ids stay on
  Claude".
- **`test/server.test.js`** — end-to-end against a local stub: a prefixed id arrives
  upstream carrying the **bare** `model`, on both the streaming and buffered paths;
  a non-prefixed body stays byte-identical.
- **`test/providers.test.js`** — removing `QWEN_PLAN_RESELLS` changes no bare-id
  route.

## Verification

Baseline before any edit, measured 2026-08-06: **250 tests / 248 pass / 0 fail /
2 skipped**. Report the delta against exactly that.

```bash
pnpm check                                   # 0 fail; no previously-passing test regresses
curl -sX POST localhost:4000/_shutdown       # then restart the proxy
curl -s localhost:4000/v1/models | jq '.data[] | {id,provider,tier,grade}'
node scripts/list-models.js                  # visual: matches the grouping above
pnpm models:html                             # only AFTER the restart
```

Live checks (bill real tokens, run once each):

- `/model qwen:deepseek-v4-pro` must now **succeed** where it 400s today, and the
  proxy log must show `qwen:deepseek-v4-pro -> qwen` with the upstream body
  carrying bare `deepseek-v4-pro`.
- `/model glm:claude-haiku-4-5-20251001` must log `-> claude`.
- `/model qwen:deepseek-v4-pro` vs `/model deepseek-v4-pro` on an identical
  prompt: the plan route should report ~+79 input tokens. That gap is the proof
  the two routes are genuinely distinct and the lens is doing something.

## Risks

- **The table rots.** A plan id that starts 403-ing degrades to the predicate
  fallback (correct, possibly more expensive) rather than failing — acceptable — but
  a rename that the predicates *don't* catch drops the model out of discovery.
  Re-probe before each release; no offline test can catch this.
- **`resolve()` signature change** touches three call sites; a missed one silently
  routes on the un-stripped id.
- **A provider id that prefixes a real model id** would make the parse ambiguous.
  None does today (`glm`, `qwen`, `deepseek`, `openrouter`, `claude` vs ids that
  all continue with `-` or a digit), but the parse requires a literal `:` so the
  ambiguity cannot arise without a vendor shipping a colon in an id.
