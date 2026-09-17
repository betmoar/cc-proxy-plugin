# Contributing

## Dev setup

Node 22 or newer (`process.loadEnvFile` is required; `.npmrc` is
engine-strict) and pnpm via corepack (`package.json` pins the version).

```bash
pnpm install
cp .env.example .env   # dev: set the keys you hold
pnpm proxy             # run the proxy standalone on PROXY_PORT (default 4000)
pnpm check             # lint + test; CI runs exactly this
pnpm probe:vendors     # manual: re-measure what source comments claim vendors do
pnpm models:html       # regenerate docs/models.html (needs a running proxy)
pnpm models:picker     # write the /model picker rows into ~/.claude/settings.json
```

- `pnpm test` runs `node --test`; the suite spins real local HTTP backends. If
  you change forwarding and no test fails, you have not tested it.
- `pnpm probe:vendors` spends real quota against real keys and is never in
  `pnpm check`. It exits 1 when a vendor stops behaving the way a source
  comment says it does, and prints a catalog drift report.
- `pnpm models:html` rebuilds the committed model page. CI cannot rebuild it
  and the suite reads the committed file, so regenerate it whenever routing, a
  catalog, a grade or the renderer changes; see
  [docs/RELEASING.md](docs/RELEASING.md#regenerating-docsmodelshtml).
- `pnpm models:picker` writes **your** `~/.claude/settings.json`. `--dry-run`
  prints the merged file, `--print` just the rows.
- To load a checkout as a plugin without the marketplace: `claude --plugin-dir .`.

Keys for the installed plugin live in `~/.env`; the repo `.env` is the dev
convenience. Both are gitignored.

## Add a provider in one file

The proxy routes by a data-driven registry in `src/providers.js`. A backend is
one entry in `buildProviders`; no router or server changes.

```js
Provider = {
  id,            // "glm" | "openrouter" | ...
  baseUrl,       // the proxy appends the inbound path, e.g. /v1/messages
  apiKey,        // from env; "" for OAuth passthrough
  auth,          // "oauth" | "apiKey" | "bearer"
  match,         // (model) => bool: which bare ids route here
  isDefault,     // optional, set by DEFAULT_BACKEND
  mediaBaseUrl,  // optional: host root for a media path outside the skin
}
```

1. **Push an entry** in `buildProviders`. Gate it on its key
   (`if (env.MYPROVIDER_API_KEY)`) so it stays opt-in. Keep `claude` last; it
   is the OAuth-passthrough default.
2. **Add the id to `PROVIDER_IDS`** in the same file. That set is what
   `parseModelSelector()` strips a `<provider>:` lens for, and it is
   deliberately not derived from the registry: the strip must work with no key
   registered (issue #20). Forgetting this has no local symptom; the lens leaks
   upstream as part of the model id. Locked by `test/couplings.test.js`.
3. **Pick an auth strategy.** `oauth`, `apiKey` or `bearer`; new schemes go in
   `applyAuth`.
4. **Write `match`.** Prefer a predicate disjoint from the others. An overlap
   is allowed only when `ROUTES` disambiguates it (`deepseek` and `qwen` both
   claim `deepseek-v4-pro`, and `rankRoutes()` decides before any predicate);
   without a `ROUTES` entry, registry order wins silently.
5. **Anthropic Messages only.** No format translation; a provider must speak
   the Anthropic Messages API or a compatible skin (invariant 5).
6. **Probe every id you claim and record it in `ROUTES`** (`src/routes.js`):
   one entry per (id, backend) pair with the status the host returned and a
   cost tier (`1` OAuth, `2` prepaid plan, `3` metered credits, `4` reseller).
   Probe, never read a vendor page; both QwenCloud's public list and the plan
   page omit ids the gateway serves.
7. **Decide what your catalog lists, and grade the models.** A catalog says
   what your backend serves, foreign ids included; what publishes bare is
   decided by namespace ownership. Add a `MODEL_GRADES` entry per assessed model
   (`Flagship`, `Strong`, `Specialist`) or discovery publishes no `grade`.
   Add a `CONTEXT_WINDOW` entry so the model gets a `/model` picker row.
8. **Add tests** in `test/providers.test.js` (registry shape, auth, `match`),
   `test/router.test.js` (routing) and `test/routes.test.js` (the coherence
   locks pick up new entries automatically). Live integration tests gate on
   the key (`{ skip: !process.env.MYPROVIDER_API_KEY }`).
9. **Optional: a statusline gauge.** Add it to the `GAUGES` table in
   `scripts/statusline.js` with a fetcher in `scripts/quota.js`.
10. **Regenerate `docs/models.html`** and add the key to `.env.example` and
    [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Conventions

- Zero runtime dependencies: Node stdlib only.
- The proxy is a **transparent pipe**: never add prompt classification or
  request rewriting beyond auth and headers. Claude Code owns orchestration.
- Match the existing style; `pnpm lint` (biome) is the arbiter. JSON is
  2-space, JS is tabs.
- A comment that claims behaviour gets a lock: a `@doctest` line for an
  input-to-output claim, a `probe-vendors` case for a vendor claim, a
  `couplings.test.js` lock for a contract. Never cite `file.js:NNN`.
- Files under `~/.claude` are written by staging a `.tmp-<pid>` sibling and
  renaming it over the target, through any symlink, preserving the mode.

Merging and releasing: [docs/RELEASING.md](docs/RELEASING.md). The traps and
the reasoning behind the rules: [docs/MAINTAINING.md](docs/MAINTAINING.md).
