---
name: setup
description: One-time setup for the cc-proxy plugin. Configures ANTHROPIC_BASE_URL, GLM_API_KEY, PROXY_PATH, and the glm-5.2[1m] custom model option in ~/.claude/settings.json so the SessionStart hook can auto-start the proxy and /model can route to GLM. Invoke via /cc-proxy:setup.
---

# cc-proxy setup

One-time configuration of `~/.claude/settings.json` so the proxy runs automatically on every Claude Code session.

## What to do

Follow these steps **exactly**. Do not skip any.

### 1. Determine `PROXY_PATH`

Check these locations in order and use the first one that exists. The plugin is the whole repo, so `bin/cc-proxy.js` ships inside the versioned cache dir:

1. `~/.claude/plugins/cache/betmoar/cc-proxy/*/bin/cc-proxy.js` (marketplace install — the normal case; glob the `*` version segment and take the newest if there is more than one)
2. `~/dev/cc-proxy-plugin/bin/cc-proxy.js` (dev-repo fallback, if the user cloned source)

Resolve the glob to a concrete absolute path before writing it. If neither exists, ask the user where `cc-proxy.js` is located and use that absolute path.

### 2. Collect provider API keys

Read `~/.claude/settings.json`. For each provider, reuse an existing non-empty value if present, otherwise ask.

**Z.ai / GLM — required.** This is the model wired into the `/model` picker. If `env.GLM_API_KEY` is missing, ask:

> "Enter your Z.ai API key (https://z.ai → Dashboard → API Keys):"

**OpenRouter — optional.** Ask the user whether they also want OpenRouter routing. If yes and `env.OPENROUTER_API_KEY` is missing, ask:

> "Enter your OpenRouter API key (https://openrouter.ai/settings/keys):"

The proxy only registers OpenRouter when `OPENROUTER_API_KEY` is set, and routes any model id containing a slash to it (e.g. `z-ai/glm-4.7`, `anthropic/claude-opus-4`). **Tell the user this constraint:** Claude Code allows only **one** custom `/model` picker entry, and GLM uses it — so OpenRouter models do **not** appear in the `/model` picker. They are reached only by (a) setting `DEFAULT_BACKEND=openrouter` so unmatched requests fall through to it, or (b) a subagent/slash-command whose frontmatter pins a `vendor/model` id (which the proxy then routes verbatim).

### 3. Update `~/.claude/settings.json`

Read the current file, then merge the following into the `env` object (create `env` if missing). Preserve every other existing key unchanged.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "GLM_API_KEY": "<from step 2>",
    "OPENROUTER_API_KEY": "<from step 2, only if the user provided one>",
    "PROXY_PATH": "<from step 1>",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.2[1m]",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.2 (1M)",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.2 1M-context (routed via cc-proxy)"
  }
}
```

This registers `glm-5.2[1m]` in the `/model` picker (Claude Code allows exactly one custom model option). If `ANTHROPIC_CUSTOM_MODEL_OPTION` is already set to a different value, ask the user before overwriting it.

Write the file back with 2-space indentation, matching the existing formatting.

### 4. Optional: enable the statusline

Ask the user whether they want the quota/credits statusline. It shows Claude 5-hour usage, GLM coding quota, OpenRouter credits (when `OPENROUTER_API_KEY` is set), and a bold-red `proxy down` when the local proxy is unreachable.

If yes, merge this **top-level** key into `~/.claude/settings.json` (it is *not* under `env`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node <PROXY_DIR>/scripts/statusline.js"
  }
}
```

Derive `<PROXY_DIR>` from the `PROXY_PATH` chosen in step 1 by stripping the trailing `/bin/cc-proxy.js` (e.g. `~/.claude/plugins/cache/betmoar/cc-proxy/<version>`). The statusline command runs outside plugin context, so `${CLAUDE_PLUGIN_ROOT}` is unavailable — an absolute path is required here. If the user already has a `statusLine` configured, show them the command and let them decide rather than overwriting it.

### 5. Start the proxy now

Spawn the proxy so it is already up when `ANTHROPIC_BASE_URL` takes effect, eliminating the first-run `ECONNREFUSED`. Run, verbatim:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/start-proxy.js"
```

`scripts/start-proxy.js` reuses the SessionStart hook's `ensureProxyRunning()`: it TCP-probes `PROXY_PORT` first (idempotent — a no-op if the proxy is already up), then spawns `bin/cc-proxy.js` detached + `unref`'d so it survives this turn. It reads the `env` block you just wrote to `~/.claude/settings.json` and passes it to the spawn, because the proxy reads config from env (not settings.json) and nothing has injected those vars into this process yet on a first-run setup.

Interpret the script's stdout/stderr:

- `cc-proxy already up` or `cc-proxy started` → success. Proceed to step 6.
- `PROXY_PATH is unset` → step 1 failed to resolve a path. Re-run `/cc-proxy:setup`; do not tell the user to start it by hand.
- `did not become reachable in time` → spawn fired but readiness timed out. Treat as a fallback: keep `/exit` + `/resume` as the path to recovery (step 6 covers this). Show the user the `/tmp/cc-proxy.log` tail if they ask.

### 6. Inform the user

Tell the user, verbatim:

> Setup complete. The proxy is running (step 5 started it). Claude Code re-applies `ANTHROPIC_BASE_URL` to running sessions immediately, so any open `claude` may still fail until it re-reads env — `/exit` and `/resume` any open session if you hit an error.
>
> To confirm, check `/tmp/cc-proxy.log` after your next prompt — you should see routing lines like `claude-sonnet-4-6 -> claude` or `glm-5.2 -> glm`.

## Important constraints

- **Do not** overwrite unrelated keys in `settings.json`. Use a merge strategy, not a full rewrite from template.
- **Do not** commit the user's API key anywhere. It stays only in `~/.claude/settings.json`.
- **Do not** start the proxy by hand with `node bin/cc-proxy.js` or similar — use `scripts/start-proxy.js` (step 5), which is idempotent and passes settings.json's env to the spawn. Raw starts risk duplicate proxies on the port or a spawn missing `GLM_API_KEY`.
- If `~/.claude/settings.json` does not exist, create it with just the `env` block above (and valid JSON structure).
