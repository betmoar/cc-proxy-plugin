# Spec: provider-namespaced model ids + cheapest-route selection

**Target repo:** `cc-proxy-plugin`. Touches `src/router.js`, `src/providers.js`,
`src/models.js`, plus a new `src/routes.js`.

**Status:** design, implementation-ready. Written 2026-08-06. Route matrix probed
2026-08-04 (see CLAUDE.md backlog item 8 for the raw probe output).

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

### Both separators; canonical is `/`

`<provider>/<model>` and `<provider>:<model>` both parse, when the leading segment
is a **registered provider id**. `/` is canonical for display and is verified to
survive Claude Code's `/model` picker today; `:` is carried because neither the
picker nor `ANTHROPIC_CUSTOM_MODEL_OPTION` is public API and `/` could be mangled by
a future CC release.

### Provider == name prefix ⇒ no prefix rendered

`glm/glm-5.2` resolves, but canonicalizes to `glm-5.2`. A prefix is *rendered* only
on a **dedup hit** — a backend carrying a model whose id does not begin with that
backend's own name. Hence the target listing:

```
glm-5.2                       GLM
deepseek-v4-pro               DeepSeek
qwen3.8-max                   Qwen
qwen/deepseek-v4-pro          Qwen   <- dedup hit, prefix rendered
qwen/deepseek-v4-flash-0731   Qwen   <- dedup hit, prefix rendered
```

### OpenRouter catalog ids beat prefix parsing

`deepseek/deepseek-v4-pro` is a literal OpenRouter vendor id and keeps meaning
OpenRouter. The selector parser checks `config.openRouterModels` **first**;
`openrouter/<vendor>/<model>` is the explicit escape hatch. This is why OpenRouter's
`includes("/")` predicate can survive unchanged: the aggregator still owns the whole
slash namespace, and the lens sits in front of it.

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
- Add `parseModelSelector(model, config)` → `{ providerId | null, model }`.
  Order: (a) exact hit in `config.openRouterModels` → no selector;
  (b) `^(<registered provider id>)[/:](.+)$` → selector + tail; (c) no selector.

### `src/router.js`

```
1. claude-haiku-*                   -> claude                    (invariant 4, unchanged)
2. parseModelSelector -> providerId -> that provider if registered
3. ROUTES[model] -> rankRoutes      -> first candidate that is registered
4. first non-default p.match(model)                              (unchanged)
5. defaultProvider                                               (unchanged)
```

`resolve()` now returns `{ provider, upstreamModel }`; `upstreamModel` differs from
the input only when a selector was stripped. **This is a signature change** — every
call site must be updated: `src/server.js` (routing log + forward),
`scripts/list-models.js:94` `attribute()`. A missed call site silently routes on the
un-stripped id, so a thin `resolveProvider()` wrapper is acceptable if the diff gets
noisy.

### Body rewrite

In the place the body is already parsed for the thinking-strip: if
`upstreamModel !== body.model`, set it — nothing else. Applies on **both** the
streaming and buffered paths; they are separate code.

### `src/models.js` — discovery

- `collectModels()` emits one entry per **canonical** id (deduped across backends by
  `rankRoutes`), plus prefixed entries for the losing routes.
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
- **`test/router.test.js`** — `qwen/deepseek-v4-pro` → qwen with `upstreamModel`
  stripped; `qwen:deepseek-v4-pro` identical; `deepseek/deepseek-v4-pro` still →
  openrouter; `openrouter/qwen/qwen3.7-max` → openrouter unstripped; a selector
  naming an unregistered provider falls through rather than erroring. Every existing
  test must still pass — especially "dated `claude-*` ids stay on Claude".
- **`test/server.test.js`** — end-to-end against a local stub: a prefixed id arrives
  upstream carrying the **bare** `model`, on both the streaming and buffered paths;
  a non-prefixed body stays byte-identical.
- **`test/providers.test.js`** — removing `QWEN_PLAN_RESELLS` changes no bare-id
  route.

## Verification

```bash
pnpm check                                   # lint + suite, must be green
curl -sX POST localhost:4000/_shutdown       # then restart the proxy
curl -s localhost:4000/v1/models | jq '.data[] | {id,provider,tier,grade}'
node scripts/list-models.js                  # visual: matches the grouping above
pnpm models:html                             # only AFTER the restart
```

Live route check (bills real tokens, run once): `/model qwen/deepseek-v4-pro` then
`/model deepseek-v4-pro`. The first must report ~+79 input tokens against an
identical prompt — that gap is the proof the two routes are genuinely distinct and
that the lens is doing something.

## Risks

- **The table rots.** A plan id that starts 403-ing degrades to the predicate
  fallback (correct, possibly more expensive) rather than failing — acceptable — but
  a rename that the predicates *don't* catch drops the model out of discovery.
  Re-probe before each release; no offline test can catch this.
- **`:` may not survive the `/model` picker.** `/` is the fallback and works today.
- **`resolve()` signature change** touches every call site.
