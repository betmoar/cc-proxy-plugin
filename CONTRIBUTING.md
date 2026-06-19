# Contributing

## Dev setup

```bash
pnpm install
cp .env.example .env   # set GLM_API_KEY (and OPENROUTER_API_KEY if used)
pnpm proxy             # run the proxy standalone on PROXY_PORT (default 4000)
```

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
2. **Pick an auth strategy.** `oauth` passes the inbound `Authorization` through
   (Claude Pro/Max); `apiKey` sets `x-api-key`; `bearer` sets
   `Authorization: Bearer`. New schemes go in `applyAuth`.
3. **Write `match`.** Keep it disjoint from the other providers — GLM matches
   `glm-*`, OpenRouter matches slash-namespaced `vendor/model` ids.
4. **Anthropic-Messages only.** This proxy does no format translation; a
   provider must speak the Anthropic Messages API (or its compatible "skin").
   That is a deliberate constraint — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Invariants).
5. **Add tests** in `test/providers.test.js` (registry shape, auth, `match`) and
   `test/router.test.js` (routing). Live integration tests gate on the key being
   present (`{ skip: !process.env.MYPROVIDER_API_KEY }`).
6. **Optional: statusline.** Add a quota/credits fetch in
   `plugins/cc-proxy/scripts/statusline.js`, opt-in on the key, cached like the
   existing GLM/OpenRouter sections.

## Conventions

- Zero runtime dependencies — Node stdlib only (`http`, `net`, `fetch`).
- The proxy is a **transparent pipe**: never add prompt classification or
  request rewriting beyond auth/headers. Claude Code owns orchestration.
- Match the existing style; `pnpm lint` (biome) is the arbiter. JSON stays
  2-space; JS uses tabs.
- See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design rationale and
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for runtime facts.
