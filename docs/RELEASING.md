# Merging and releasing

The procedure, the two guards that enforce it, and the holes the guards cannot
close. Long-form reasons live in [MAINTAINING](MAINTAINING.md#releases).

## Merging a PR

- `gh pr merge <n> --squash`, **never `--rebase`**. `main` is one commit per
  PR, titled `<type>: <what> (#<n>)`, and `git log --merges` on `main` stays
  empty. A rebase replays every commit (#21 landed as nine and needed a
  force-push to undo).
- The squash body is where the **why** goes; per-commit messages are discarded.
- Squashed branches never show in `git branch --merged`; delete with `-D` once
  the content is confirmed on `main`.
- Two PRs that both add a CHANGELOG section always conflict. Fold them into
  **one** version section, ordered Added, Changed, Fixed.

## Cutting a release

1. **CHANGELOG first.** Add the `## [x.y.z] — YYYY-MM-DD` section at the top,
   non-empty. `test/release-gate.test.js` runs the tag-time gate against the
   checkout, so a bumped `package.json` without its section fails `pnpm check`
   on the PR, not after the squash.
2. **Bump on the branch:** `pnpm version patch|minor --no-git-tag-version`.
   This runs `scripts/version-guard.js` (refuses any invocation that would tag
   off `main`) and `scripts/sync-version.mjs` (copies the version into
   `.claude-plugin/plugin.json`, the plugin cache key).
3. **Regenerate `docs/models.html` if routing, a catalog, a grade or the
   renderer changed**, and commit it in the same PR. `test/render-models.test.js`
   fails when a curated id or grade is missing from the page, so a stale page
   no longer ships green. The procedure is below.
4. `pnpm check`, push, squash-merge.
5. **Tag on `main` after the squash:** `git tag v<x.y.z> && git push origin
   v<x.y.z>`. The tag build (`.github/workflows/release.yml`) refuses a tag
   whose commit is not on `main`, checks tag == `plugin.json` == `package.json`
   == newest CHANGELOG heading, re-runs the full gate, and publishes a GitHub
   release whose body is that CHANGELOG section.

## Regenerating `docs/models.html`

The page is rendered against a **live** proxy, so CI cannot rebuild it and the
suite reads the committed file.

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN -t   # who owns the port; /_status says who ANSWERED, not who is bound
# restart the proxy so it runs the merged tree, then:
pnpm models:html
git add docs/models.html
```

`models:html` goes through `scripts/render-html.mjs`, which runs the renderer
against a temporary HOME holding only a symlink to `~/.env`. The renderer
grades through `gradeOf()`, which overlays `~/.claude/cc-proxy/grades.json` on
the repo table, so a plain run would publish **your** local grades (it shipped
four wrong grades that way). Never simplify it back to `node render-models.js >`,
and never isolate the whole HOME: `loadEnv()` reads `~/.env` from it, and a
blanket override drops every key so the page collapses to the Claude card
alone (measured: 40 rows became 3).

## The version guard

`scripts/version-guard.js` is wired as both the `preversion` and the `version`
lifecycle script and refuses any `pnpm version`/`npm version` invocation that
would create the tag while off `main`. The full measured grid of flag spellings
is in its header. Three shapes it cannot see, which is why the tag build has
its own on-`main` check:

- `git tag` by hand on a branch.
- `--ignore-scripts` (or `npm_config_ignore_scripts=true`): neither lifecycle
  script runs.
- A branch literally named `main` on a fork whose `main` is not upstream's.

The repo `.npmrc` sets `git-tag-version=false` and `engine-strict=true`. The
first removes npm's default-path foot-gun and nothing more (a flag overrides
it, and pnpm ignores it for `version`); the second refuses `pnpm install` on a
Node below 22, where `process.loadEnvFile` is missing and `~/.env` would be
ignored silently.

## CI

| Where | Runs on | Gate |
| --- | --- | --- |
| GitHub `.github/workflows/ci.yml` | pushes to `main`, every PR; x86_64 | `pnpm install --frozen-lockfile && pnpm lint && pnpm test` |
| GitHub `.github/workflows/release.yml` | `v*` tags | on-`main` check, release gate, the same lint and test, publish |
| Forgejo `.forgejo/workflows/gate.yml` | every push; native arm64 plus x86_64 under Rosetta | the same lint and test, twice |

`pnpm check` is the local equivalent. `pnpm probe:vendors` is deliberately
outside every gate: it spends real quota against real keys.
