---
name: bench
description: Refresh model grades (capability + price, from benchlm.ai and OpenRouter) or measure route latency through the proxy. Nothing runs automatically — this is the manual refresh.
argument-hint: grades | speed | speed --report
allowed-tools: Bash
disable-model-invocation: true
---

Run the cc-proxy bench and show the user its output.

`$1` selects the sub-command: `grades` (default), `speed`, or `speed --report`.

Execute:

```bash
# Resolve the plugin root. $CLAUDE_PLUGIN_ROOT is only injected in hook context,
# not into a slash-command's Bash, so fall back through the legacy PROXY_PATH
# pin, then the marketplace cache (newest version wins), then the dev repo.
# Same resolution as /cc-proxy:models — see that file for the two portability
# traps this form avoids (template substitution, and zsh word-splitting).
root=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  if [ -f "$c/scripts/bench-grades.js" ]; then root="$c"; break; fi
done <<EOF
${CLAUDE_PLUGIN_ROOT:-}
$([ -n "${PROXY_PATH:-}" ] && dirname "$(dirname "$PROXY_PATH")")
$(ls -d "$HOME"/.claude/plugins/cache/*/cc-proxy/*/ 2>/dev/null | sort -V -r | sed 's:/*$::')
$PWD
EOF
[ -n "$root" ] || { echo 'cc-proxy: cannot locate plugin root; run /cc-proxy:setup or /resume'; exit 1; }

# Trap 3 (this command's own): a slash-command body has NO real positional
# parameters. Claude Code substitutes the argument tokens TEXTUALLY before any
# shell runs, and it substitutes only $ARGUMENTS and $1 — $2 and $3 are left as
# the literal characters "$2"/"$3" for the shell to expand against an EMPTY
# argv, i.e. to nothing.
#
# Two bugs came from not knowing that, both verified against the real harness:
#   1. `shift; "$@"` forwarded nothing, silently dropping `--report` and turning
#      a read-only report into a full billed measurement run.
#   2. Reading `$1` then `$2`/`$3` was worse: for `speed --report` the harness
#      set $1 to `--report` (the LAST token, not the first), so `case "$1"`
#      matched no branch and fell through to the grades default — the wrong
#      sub-command entirely.
#
# So parse $ARGUMENTS — the whole argument string, the only token that carries
# every word. It is spliced in as SOURCE TEXT, not expanded as a variable, so a
# bare `set -- $ARGUMENTS` hands the user's words to the parser as syntax:
# measured, `speed --report | cat` ran `set --` in a subshell and fell through
# to `grades` (a billed network run plus a grades.json rewrite, from a
# read-only report), `speed > x` created/truncated x, `speed 'a` was a syntax
# error, and `$(…)` executed. A QUOTED heredoc is the one place the shell
# never parses its contents, so the spliced text becomes data in `$args`, and
# only THEN is it word-split into a real argv. (Only a line that is exactly
# the terminator could end it early, which a one-line slash argument cannot
# contain.) Locked by test/commands.test.js, which runs this block with each
# of those arguments spliced in.
#
# The heredoc is read by `read`, NOT by `args=$(cat <<'Q' … )`: a heredoc
# nested inside command substitution is mis-parsed by bash 3.2, which is
# /bin/bash on every macOS. Measured there — `speed 'glm-5.2` died with
# "unexpected EOF while looking for matching `''" and exit 2, while bash 5
# (what CI runs) accepted it, so the suite was green on the one platform the
# defect could not reach. `read` returns 1 at EOF without its NUL delimiter,
# which is the normal case here, hence `|| true`.
args=""
IFS= read -r -d '' args <<'CC_PROXY_ARGS' || true
$ARGUMENTS
CC_PROXY_ARGS
# `set -f` first, because unquoted word-splitting also GLOBS: measured in a
# directory holding two files, `bench speed *` split to three words
# (`speed aaa.txt bbb.txt`) instead of two. Splitting is what we want; pathname
# expansion is not, and the argv it builds is passed straight to a script.
#
# Split through a COMMAND SUBSTITUTION, not `set -- $args`: a slash command
# runs under the user's login shell, which on macOS is ZSH (the same trap
# commands/models.md documents), and zsh does not word-split an unquoted
# parameter. Measured: with args="speed --report", `set -- $args` gives bash
# two words and zsh ONE, so `$1` was the whole string, `case` matched no
# branch, and `/cc-proxy:bench speed` was dead for every macOS user. zsh DOES
# split an unquoted command substitution, so this form gives two words in
# bash, zsh and dash alike. The trailing newline `read` leaves on $args is
# absorbed by that same splitting.
set -f
set -- $(printf '%s' "$args")
set +f
sub="${1:-grades}"
shift 2>/dev/null || true
case "$sub" in
  speed) node "$root/scripts/bench-speed.js" "$@" ;;
  grades) node "$root/scripts/bench-grades.js" ;;
  *)
    echo "cc-proxy: unknown sub-command '$sub' — expected 'grades', 'speed', or 'speed --report'" >&2
    exit 1 ;;
esac
```

Present the script's stdout **verbatim** — it is already formatted, and its
footer states what each field means. Do not summarize, re-rank, or reword it.

Two things to keep straight if the user asks about the output:

- **`grade` and `score` are different axes.** `grade` is the model's position in
  its OWN vendor's line-up, read from the vendor's version numbering — that part
  needs no benchmark. `score` is benchlm's cross-vendor number, and a trailing
  `~` marks it as benchlm's *estimate* rather than a measurement (new models are
  usually estimated, which is exactly when the number deserves less trust).
  Never read one field off the other, and never let price lower a grade.
- **`speed` measures the ROUTE, not the model.** It never feeds `grade`. One
  ping is noise; `speed --report` gives median and p95 over the series, which is
  what makes route drift visible. A `⚠ spans >1 proxy build` warning means the
  proxy binary changed mid-series and those numbers are not comparable.

`grades` needs network (benchlm.ai + OpenRouter) and writes
`~/.claude/cc-proxy/grades.json`; on any failure it says so and writes nothing —
a stale file is useful, a silently-empty one is a lie. `speed` needs the proxy
running and appends to `~/.claude/cc-proxy/speed.jsonl` one row per route,
**FAIL rows included** (a route that stopped answering is the finding); it
writes nothing only when the proxy itself is down.
