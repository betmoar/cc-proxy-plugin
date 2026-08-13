# Contributing

## Dev setup

```bash
pnpm install
cp .env.example .env   # dev: set GLM_API_KEY (and OPENROUTER_API_KEY if used)
pnpm proxy             # run the proxy standalone on PROXY_PORT (default 4000)
```

For the installed plugin, API keys live in `~/.env` (not the repo `.env`, which is the dev/inline convenience). `/cc-proxy:setup` writes them there; the proxy loads `~/.env` plus any repo `.env` at startup.

Gates (both must pass):

```bash
pnpm test   # node --test
pnpm lint   # biome check .
```

## Add a provider in one file

The proxy routes by a data-driven registry in [`src/providers.js`](src/providers.js).
A backend is one entry in `buildProviders` — no router or server changes.

A `Provider` is:

```js
{
  id,                       // "glm" | "openrouter" | ...
  baseUrl,                  // proxy appends the inbound path (e.g. /v1/messages)
  apiKey,                   // from env; "" for OAuth passthrough
  auth,                     // "oauth" | "apiKey" | "bearer"
  match: (model) => bool,   // which model ids route here
  isDefault?,               // set by DEFAULT_BACKEND
}
```

Steps:

1. **Push an entry** in `buildProviders` (`src/providers.js`). Gate it on its
   key (`if (env.MYPROVIDER_API_KEY)`) so it stays opt-in. Keep `claude` last —
   it is the OAuth-passthrough default.
1b. **Add the id to `PROVIDER_IDS`** in the same file. That set is what
   `parseModelSelector()` strips a `<provider>:` lens for, and it is deliberately
   NOT derived from the registry: the strip must work even when the backend holds
   no key (issue #20), so a keyless `myprovider:some-model` still resolves
   instead of forwarding the literal lens string upstream. Forgetting this has no
   local symptom — the backend routes fine by predicate while its lens leaks
   upstream as part of the model id and 400s opaquely. Locked by
   `test/couplings.test.js` "PROVIDER_IDS covers every provider…".
2. **Pick an auth strategy.** `oauth` passes the inbound `Authorization` through
   (Claude Pro/Max); `apiKey` sets `x-api-key`; `bearer` sets
   `Authorization: Bearer`. New schemes go in `applyAuth`.
3. **Write `match`.** Prefer a predicate disjoint from the others — GLM matches
   `glm-*`, OpenRouter matches slash-namespaced `vendor/model` ids. Disjoint is
   no longer a *rule*: since #19 two predicates deliberately overlap
   (`deepseek.match("deepseek-v4-pro")` and `qwen.match(...)` are both true,
   because the Qwen plan really does resell that id), and `rankRoutes()` decides
   between them before any predicate is consulted. So an overlap is allowed
   **when `ROUTES` disambiguates it** — the predicate scan is the fallback for
   ids the route table does not list, and there registry order wins silently.
   If you overlap without a `ROUTES` entry, the earlier-registered provider
   takes the id and nothing says so.
4. **Anthropic-Messages only.** This proxy does no format translation; a
   provider must speak the Anthropic Messages API (or its compatible "skin").
   That is a deliberate constraint — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Invariants).
5. **Probe every id you claim, and record it in `ROUTES`** (`src/routes.js`).
   One entry per (id, backend) pair with the status the host actually returned
   and a cost tier: `1` OAuth/Anthropic, `2` prepaid plan, `3` metered credits,
   `4` reseller. `rankRoutes()` orders the `200` routes **native first, then by
   tier**, so the bare id resolves to the native backend when one is registered
   and otherwise to the cheapest one — a missing entry means your backend
   silently never wins one. (Native-over-tier is the issue-#19 rule: a resold
   route may inject a preamble, so the bare id prefers the weights it names.)
   **Probe, never read a vendor page** — both QwenCloud's public model list and
   the account's own plan page omit ids their gateway genuinely serves.
   A shared id is then also reachable explicitly as `<provider>:<id>`; the
   selector is stripped before forwarding, so the backend sees only its own id.
6. **Decide what your catalog lists, and grade the models.** A catalog says what
   your backend *serves* — foreign ids included if it really serves them (the
   Qwen plan serves `glm-5.2`), each needing a `200` `ROUTES` entry naming your
   backend. What is published *bare* is decided by namespace ownership, not by
   who wins the cost rank: ids outside your namespace publish as
   `<provider>:<id>`. Add a `MODEL_GRADES` entry per model in `src/models.js`
   (`Flagship`, `Strong`, or `Specialist` — those three, nothing else) or
   discovery publishes no `grade` at all for it, which is honest but useless to
   a consumer dispatching by strength. `grade` (capability) and `tier` (cost)
   are separate fields — never derive one from the other.
7. **Add tests** in `test/providers.test.js` (registry shape, auth, `match`),
   `test/router.test.js` (routing), and `test/routes.test.js` (the coherence
   locks pick up new catalog/ROUTES entries automatically). Live integration
   tests gate on the key being present
   (`{ skip: !process.env.MYPROVIDER_API_KEY }`).
8. **Optional: statusline.** Add a quota/credits fetch in
   `scripts/statusline.js`, opt-in on the key, cached like the
   existing GLM/OpenRouter sections.

## Conventions

- Zero runtime dependencies — Node stdlib only (`http`, `net`, `fetch`).
- The proxy is a **transparent pipe**: never add prompt classification or
  request rewriting beyond auth/headers. Claude Code owns orchestration.
- Match the existing style; `pnpm lint` (biome) is the arbiter. JSON stays
  2-space; JS uses tabs.
- See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design rationale and
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for runtime facts.
