---
name: status
description: Show cc-proxy router status — proxy liveness, configured providers, GLM/OpenRouter quota, and recent routing decisions.
argument-hint: (no arguments)
allowed-tools: Bash
disable-model-invocation: true
---

Run the cc-proxy diagnostic and show the user its output.

Execute:

```bash
# Resolve the plugin root. $CLAUDE_PLUGIN_ROOT is only injected in hook context,
# not into a slash-command's Bash, so fall back through the legacy PROXY_PATH
# pin, then the marketplace cache (newest version wins — the tree is always
# current), then the dev repo. Never rely on env alone.
root=""
try() { [ -n "$1" ] && [ -f "$1/scripts/status.js" ] && root="$1"; }
try "${CLAUDE_PLUGIN_ROOT:-}"
[ -z "$root" ] && [ -n "${PROXY_PATH:-}" ] && try "$(dirname "$(dirname "$PROXY_PATH")")"
if [ -z "$root" ]; then
  for d in $(ls -d "$HOME"/.claude/plugins/cache/*/cc-proxy/*/ 2>/dev/null | sort -V); do try "${d%/}"; done
fi
[ -z "$root" ] && try "$HOME/dev/cc-proxy-plugin"
[ -n "$root" ] || { echo 'cc-proxy: cannot locate plugin root; run /cc-proxy:setup or /resume'; exit 1; }
node "$root/scripts/status.js"
```

Present the script's stdout **verbatim** — it is already formatted. Do not summarize or reword it. If the script prints nothing or exits non-zero, tell the user the proxy may be down and point them at `/tmp/cc-proxy.log` and a fresh session (`/exit` + `/resume`) to re-trigger the SessionStart hook.
