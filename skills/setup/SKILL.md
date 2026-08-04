---
name: setup
description: One-time setup for the cc-proxy plugin. Writes API keys (GLM_API_KEY, optionally OPENROUTER_API_KEY) to ~/.env, and configures ANTHROPIC_BASE_URL and the glm-5.2[1m] custom model option in ~/.claude/settings.json so the SessionStart hook can auto-start the proxy and /model can route to GLM. Invoke via /cc-proxy:setup.
---

# cc-proxy setup

One-time configuration of `~/.claude/settings.json` so the proxy runs automatically on every Claude Code session.

The proxy binary needs **no configuration**: the SessionStart hook and `scripts/start-proxy.js` resolve `bin/cc-proxy.js` from their own plugin tree, which is always the currently-installed version. Do **not** write `PROXY_PATH` into settings.json — a version-pinned path there is exactly how users used to get stuck on stale proxies after plugin updates. If a `PROXY_PATH` already exists in settings.json `env`, **remove it** during step 3 (it is a legacy pin; the tree's own bin outranks it anyway).

## What to do

Follow these steps **exactly**. Do not skip any.

### 1. Locate the plugin tree (for the statusline path only)

Check these locations in order and use the first one that exists:

1. `~/.claude/plugins/cache/betmoar/cc-proxy/*/` (marketplace install — the normal case; glob the `*` version segment and take the newest if there is more than one)
2. `~/dev/cc-proxy-plugin/` (dev-repo fallback, if the user cloned source)

This concrete path is needed **only** for the optional statusline command in step 4 (which runs outside plugin context). It is *not* written as `PROXY_PATH`.

### 2. Collect provider API keys (written to `~/.env`)

API keys live in `~/.env` — the single source of truth the proxy reads at startup. Do **not** put keys in `~/.claude/settings.json` `env`; it keeps only non-secret plumbing (step 3).

Read `~/.env` first (create the file if absent). For each key, reuse a value already present rather than re-asking.

**Z.ai / GLM — required.** This is the model wired into the `/model` picker. If `GLM_API_KEY` is missing or empty in `~/.env`, **ask explicitly**:

> "Enter your Z.ai API key (https://z.ai → Dashboard → API Keys). It will be stored in ~/.env:"

**OpenRouter — optional.** Ask the user whether they also want OpenRouter routing. If yes and `OPENROUTER_API_KEY` is missing or empty in `~/.env`, ask:

> "Enter your OpenRouter API key (https://openrouter.ai/settings/keys). It will be stored in ~/.env:"

**DeepSeek — optional.** Ask the user whether they also want DeepSeek routing. If yes and `DEEPSEEK_API_KEY` is missing or empty in `~/.env`, ask:

> "Enter your DeepSeek API key (https://platform.deepseek.com/api_keys). It will be stored in ~/.env:"

**Qwen — optional.** Ask the user whether they also want Qwen (QwenCloud Token Plan) routing. If yes and `DASHSCOPE_API_KEY` is missing or empty in `~/.env`, ask:

> "Enter your QwenCloud Token Plan API key (ANTHROPIC_AUTH_TOKEN from the QwenCloud console). It will be stored in ~/.env:"

Write each collected key to `~/.env` as a `KEY=value` line, one per line (e.g. `GLM_API_KEY=<value>`). If `~/.env` already exists, **merge** — update only the key lines you collected and preserve every other line unchanged. If it does not exist, create it with just the key line(s).

The proxy only registers OpenRouter when `OPENROUTER_API_KEY` is set, and routes any model id containing a slash to it (e.g. `z-ai/glm-4.7`, `anthropic/claude-opus-4`). It only registers DeepSeek when `DEEPSEEK_API_KEY` is set, and routes any bare `deepseek-*` id to it (e.g. `deepseek-v4-pro`, `deepseek-v4-flash`). It only registers Qwen when `DASHSCOPE_API_KEY` is set, and routes any bare `qwen`-prefixed id to it (e.g. `qwen3.7-max`, `qwen3.6-flash`). **Tell the user this constraint:** Claude Code allows only **one** custom `/model` picker entry, and GLM uses it — so OpenRouter, DeepSeek, and Qwen models do **not** appear in the `/model` picker. They are reached only by (a) setting `DEFAULT_BACKEND=openrouter` (or `deepseek`, `qwen`) so unmatched requests fall through to it, or (b) a subagent/slash-command whose frontmatter pins the model id (which the proxy then routes verbatim).

**Migrate existing keys (one source of truth).** Read `~/.claude/settings.json`. If its `env` block contains `GLM_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `DASHSCOPE_API_KEY` (legacy setups), move them to `~/.env`: if `~/.env` already has the key, keep the `~/.env` value and just drop the settings.json copy; otherwise copy the value over then **remove** the key from settings.json `env`. After setup, keys must exist **only** in `~/.env`.

### 3. Update `~/.claude/settings.json` (plumbing only — no keys)

Read the current file, then merge the following into the `env` object (create `env` if missing). Preserve every other existing key unchanged, **except `PROXY_PATH`: delete it if present** (legacy version-pinned path; the hook resolves the binary from its own tree now). **Do not add `GLM_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `DASHSCOPE_API_KEY` here** — they go in `~/.env` (step 2).

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.2[1m]",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.2 (1M)",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.2 1M-context (routed via cc-proxy)"
  }
}
```

This registers `glm-5.2[1m]` in the `/model` picker (Claude Code allows exactly one custom model option). If `ANTHROPIC_CUSTOM_MODEL_OPTION` is already set to a different value, ask the user before overwriting it.

Write the file back with 2-space indentation, matching the existing formatting.

### 4. Optional: enable the statusline

Ask the user whether they want the quota/credits statusline. It shows Claude 5-hour usage, GLM coding quota, OpenRouter credits (when `OPENROUTER_API_KEY` is set), DeepSeek balance (when `DEEPSEEK_API_KEY` is set), Qwen presence (when `DASHSCOPE_API_KEY` is set), and a bold-red `proxy down` when the local proxy is unreachable.

If yes, merge this **top-level** key into `~/.claude/settings.json` (it is *not* under `env`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node <PROXY_DIR>/scripts/statusline.js"
  }
}
```

`<PROXY_DIR>` is the plugin tree located in step 1 (e.g. `~/.claude/plugins/cache/betmoar/cc-proxy/<version>`). The statusline command runs outside plugin context, so `${CLAUDE_PLUGIN_ROOT}` is unavailable — an absolute path is required here, and it *is* version-pinned (a statusline pointing at an older cache dir still renders; it does not affect which proxy runs). If the user already has a `statusLine` configured, show them the command and let them decide rather than overwriting it.

### 5. Start the proxy now

Spawn the proxy so it is already up when `ANTHROPIC_BASE_URL` takes effect, eliminating the first-run `ECONNREFUSED`. Run, verbatim:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/start-proxy.js"
```

`scripts/start-proxy.js` reuses the SessionStart hook's `ensureProxyRunning()`: it probes `PROXY_PORT` first (idempotent — a same-version proxy is left running; a stale-version one is gracefully replaced), then spawns its own tree's `bin/cc-proxy.js` detached + `unref`'d so it survives this turn. It reads the `env` block you just wrote to `~/.claude/settings.json` and passes it to the spawn, because the proxy reads config from env (not settings.json) and nothing has injected those vars into this process yet on a first-run setup.

Interpret the script's stdout/stderr:

- `cc-proxy already up`, `cc-proxy started`, or `cc-proxy restarted` → success. Proceed to step 6.
- `PROXY_PATH is unset` → the plugin tree has no `bin/cc-proxy.js` (hand-rolled install) and no legacy `PROXY_PATH` exists. Ask the user where `cc-proxy.js` is and put that absolute path in settings.json `env` as `PROXY_PATH` — the one case where it is still legitimate.
- `did not become reachable in time` → spawn fired but readiness timed out. Treat as a fallback: keep `/exit` + `/resume` as the path to recovery (step 6 covers this). Show the user the `/tmp/cc-proxy.log` tail if they ask.

### 6. Inform the user

Tell the user, verbatim:

> Setup complete. The proxy is running (step 5 started it). Claude Code re-applies `ANTHROPIC_BASE_URL` to running sessions immediately, so any open `claude` may still fail until it re-reads env — `/exit` and `/resume` any open session if you hit an error.
>
> To confirm, check `/tmp/cc-proxy.log` after your next prompt — you should see routing lines like `claude-sonnet-4-6 -> claude` or `glm-5.2 -> glm`.

## Important constraints

- **Do not** overwrite unrelated keys in `settings.json` or unrelated lines in `~/.env`. Use a merge strategy for both, not a full rewrite from template.
- **Do not** commit the user's API key anywhere. API keys stay only in `~/.env` (it is gitignored). They must **not** appear in `~/.claude/settings.json`.
- **Do not** start the proxy by hand with `node bin/cc-proxy.js` or similar — use `scripts/start-proxy.js` (step 5), which is idempotent and passes settings.json's plumbing env to the spawn. Raw starts risk duplicate proxies on the port.
- If `~/.claude/settings.json` does not exist, create it with just the `env` block above (and valid JSON structure).
