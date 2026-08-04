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
#
# Two portability traps this form avoids, both of which bit earlier versions:
#   1. A slash-command body is a TEMPLATE: Claude Code substitutes positional
#      args (dollar-one through dollar-nine) into it BEFORE the shell runs — so a
#      helper referencing them is blanked to a no-op. This block uses NONE.
#   2. The command runs under the user's login shell, which on macOS is ZSH,
#      NOT bash. zsh does not word-split an unquoted parameter, so `for c in
#      $list` iterates once over the whole blob. A newline-fed `while IFS= read
#      -r` splits identically in bash and zsh.
root=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  if [ -f "$c/scripts/status.js" ]; then root="$c"; break; fi
done <<EOF
${CLAUDE_PLUGIN_ROOT:-}
$([ -n "${PROXY_PATH:-}" ] && dirname "$(dirname "$PROXY_PATH")")
$(ls -d "$HOME"/.claude/plugins/cache/*/cc-proxy/*/ 2>/dev/null | sort -V -r | sed 's:/*$::')
$PWD
EOF
[ -n "$root" ] || { echo 'cc-proxy: cannot locate plugin root; run /cc-proxy:setup or /resume'; exit 1; }
node "$root/scripts/status.js"
```

Present the script's stdout **verbatim** — it is already formatted. Do not summarize or reword it. If the script prints nothing or exits non-zero, tell the user the proxy may be down and point them at `~/.claude/cc-proxy/cc-proxy.log` and a fresh session (`/exit` + `/resume`) to re-trigger the SessionStart hook.
