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
root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "${PROXY_PATH:-}")")}"
[ -f "$root/scripts/status.js" ] || { echo 'cc-proxy: cannot locate plugin root; run /cc-proxy:setup or /resume'; exit 1; }
node "$root/scripts/status.js"
```

Present the script's stdout **verbatim** — it is already formatted. Do not summarize or reword it. If the script prints nothing or exits non-zero, tell the user the proxy may be down and point them at `/tmp/cc-proxy.log` and a fresh session (`/exit` + `/resume`) to re-trigger the SessionStart hook.
