# Statusline

An optional segment for Claude Code's status bar: Claude and GLM 5-hour usage,
OpenRouter credits, DeepSeek balance, Qwen presence, and a bold-red
`proxy down` when the proxy is unreachable. It reads only local cache files,
so a render never waits on the network.

## Enable it

`/cc-proxy:setup` offers to write this; by hand, merge into
`~/.claude/settings.json` (top level, not under `env`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/cache/betmoar/cc-proxy/<version>/scripts/statusline.js"
  }
}
```

The path is version-pinned because the statusline runs outside plugin
context. A stale pin still renders; it does not affect which proxy runs. With
the [cc-status](https://github.com/betmoar/cc-status-plugin) composer active,
the segment is discovered through `.claude-plugin/statusline.json` and needs no
wiring.

## What it shows

```
cc 5h:2% | glm 5h:14% | or:$$$ | ds:$$ | qw:on
```

| Segment | Shown when | Meaning |
| --- | --- | --- |
| `cc 5h:NN%` | always | Claude 5-hour usage, from the data Claude Code passes in. Green, yellow, red by load |
| `glm 5h:NN%` | `GLM_API_KEY` | Z.ai 5-hour coding quota. At 100% the number becomes a red reset countdown, `⏱3h11m` |
| `or:$$$` | `OPENROUTER_API_KEY` | Credits remaining as `$` per digit: `$1–9` is `$`, `$10–99` is `$$`, `$100–999` is `$$$`, `$1000+` is `$$$$`. An empty balance is `$0`; an unavailable one is `--` |
| `ds:$$` | `DEEPSEEK_API_KEY` | Balance remaining, same `$` scale. USD only; another currency renders `--` |
| `qw:on` | `DASHSCOPE_API_KEY` | Presence marker only. QwenCloud exposes no quota API to an API key, so no number is fabricated |
| `proxy down` | the port is closed | Bold red |

Two qualifiers can follow a gauge:

- `!` means the number is the last good one because the 60 s cache expired and
  the fresh value is not in yet. **A brief `!` is normal.** It appears on the
  render that finds the cache expired and clears once the background refresh
  lands, about two redraws once a minute. `glm` clears last; it is the slowest
  endpoint.
- `?` after `glm` means the local clock disagrees with the vendor's by more
  than a minute, so the reset countdown is off by that much.
  `/cc-proxy:status` names the offset.

## How a refresh works

- Every render reads cache files under `~/.claude/cc-proxy/`. A value past its
  60 s TTL is served immediately, marked `!`, and refreshed by a **detached**
  child process. One expiry costs one round of API calls no matter how often
  the bar redraws; a single-flight lock (`refresh.lock`) stops concurrent
  renders from each spawning a refresher.
- A refresh that **fails** leaves the last good cache file alone and writes a
  `<cache>.failed` marker. The gauge keeps its `!` and no new refresh is
  attempted for 15 s, so a revoked key or a vendor outage costs one request
  per 15 s, not one per render.
- The statusline loads `~/.env` (and a repo `.env` in a checkout) itself,
  because Claude Code spawns it with only settings.json's `env`.

## A gauge stuck on the stale mark

Only worth chasing if it stays for many seconds. The refresher runs detached
with its output discarded, so run it in the foreground to see the error:

```bash
# how old are the caches, really?
for f in glm_quota openrouter_credits deepseek_balance; do
  node -e "const j=require('$HOME/.claude/cc-proxy/'+'$f'+'_cache.json');
    console.log('$f', Math.round((Date.now()-j._ts)/1000)+'s old')"
done

# a lock older than 10 s is reclaimed automatically; one that keeps reappearing
# means refreshes are starting and dying
ls -l ~/.claude/cc-proxy/refresh.lock ~/.claude/cc-proxy/*.failed

# run one refresh in the foreground. Pick the NEWEST plugin version explicitly:
# a bare glob hands node the oldest cached copy.
R=$(ls -d ~/.claude/plugins/cache/betmoar/cc-proxy/*/scripts/statusline.js | sort -V | tail -1)
CC_PROXY_STATUSLINE_REFRESH=1 CLAUDE_PLUGIN_DATA=~/.claude/cc-proxy node "$R"
```

That command prints **nothing** on success; it is the refresher, not the
renderer. A non-zero exit or a printed error is the real fault, usually an
expired API key or an endpoint that stopped answering. Deleting
`~/.claude/cc-proxy/*_cache.json` and `*.failed` is safe: the gauges are
omitted until the next refresh fills them.
