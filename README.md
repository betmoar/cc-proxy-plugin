<p align="center">
  <img src="docs/assets/cc-proxy-hero.svg" alt="cc-proxy — one proxy to rule them all." width="100%">
</p>

# cc-proxy

A Claude Code plugin with a local proxy that lets one session use **GLM
(Z.ai)**, **DeepSeek**, **Qwen**, **OpenRouter**, **LM Studio** and **Claude**
side by side. Switch with `/model`, no restart. Zero runtime dependencies.

Claude Code points `ANTHROPIC_BASE_URL` at `http://127.0.0.1:4000`. The proxy
routes each request by its model name, applies that backend's auth, and
forwards it unchanged, so every tool, subagent and prompt cache keeps working.

## What routes where

| You pick | It goes to | Needs |
| --- | --- | --- |
| `glm-5.3[1m]`, any `glm-*` | GLM (Z.ai) | `GLM_API_KEY` |
| `deepseek-v4-pro`, any `deepseek-*` | DeepSeek | `DEEPSEEK_API_KEY` |
| `qwen3.7-max`, any `qwen*` | Qwen Token Plan | `DASHSCOPE_API_KEY` |
| `deepseek/deepseek-v4-pro`, any `vendor/model` | OpenRouter | `OPENROUTER_API_KEY` |
| `lmstudio:<model-id>` | your LM Studio server | `LMSTUDIO_BASE_URL` |
| `opus`, `sonnet`, any `claude-*`, anything else | Claude, on your own login | nothing |

Every key is optional. A model served by several backends takes the native
one first; a `<provider>:` prefix such as `qwen:deepseek-v4-pro` names another.
The full rules, the `[1m]` suffix and the haiku pin are in
[docs/ROUTING.md](docs/ROUTING.md).

## Install

Needs Node 22 or newer on your `PATH`.

```bash
claude plugin marketplace add betmoar/ccp-market
claude plugin install cc-proxy@betmoar
```

Or straight from this repo, which carries its own marketplace manifest:

```bash
claude plugin marketplace add betmoar/cc-proxy-plugin
claude plugin install cc-proxy@cc-proxy-plugin
```

## Setup

```
/cc-proxy:setup
```

It asks for the keys you want (all optional), then:

- writes them to `~/.env`, the one file the proxy reads keys from;
- sets `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` `env`;
- publishes one `/model` picker row per routable model, each carrying its real
  context window (Claude Code otherwise assumes 200K for every id it does not
  know);
- starts the proxy, so a fresh session connects without `ECONNREFUSED`.

After that the SessionStart hook keeps the proxy running and replaces an
older one after a plugin update. Everything it writes is described in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Use it

```
/model glm-5.3[1m]              # GLM, 1M context
/model deepseek-v4-pro          # DeepSeek
/model qwen3.7-max              # Qwen plan
/model lmstudio:openai/gpt-oss-20b
/model opus                     # back to Claude
```

Routing decisions land in `~/.claude/cc-proxy/cc-proxy.log`, one line per
request. `curl http://127.0.0.1:4000/v1/models` lists everything reachable;
that list is a published contract other plugins consume, documented in
[docs/DISCOVERY.md](docs/DISCOVERY.md).

## Commands

| Command | Does |
| --- | --- |
| `/cc-proxy:setup` | Keys, settings, picker rows, and starts the proxy |
| `/cc-proxy:status` | Proxy liveness and version, configured backends, GLM and OpenRouter quota, recent routing lines |
| `/cc-proxy:models` | Every reachable model with the backend it routes to |
| `/cc-proxy:bench grades` | Refresh model grades from benchlm.ai and OpenRouter into `~/.claude/cc-proxy/grades.json`. Manual by design |
| `/cc-proxy:bench speed` | Time one turn per route; `--report` gives median and p95 over the series |

The GLM offload subagents moved to
[betmoar/cc-agents-plugin](https://github.com/betmoar/cc-agents-plugin).

## Statusline (optional)

```
cc 5h:2% | glm 5h:14% | or:$$$ | ds:$$ | qw:on
```

Claude and GLM 5-hour usage, OpenRouter credits, DeepSeek balance, and
`proxy down` when the port is closed. It never waits on the network. Setup
offers to enable it; the format, the `!` and `?` marks, and what to do when a
gauge sticks are in [docs/STATUSLINE.md](docs/STATUSLINE.md).

## Docs

| Read | For |
| --- | --- |
| [docs/ROUTING.md](docs/ROUTING.md) | Which backend an id goes to, `<provider>:` prefixes, what the proxy changes in a request |
| [docs/DISCOVERY.md](docs/DISCOVERY.md) | The `/v1/models` contract, `?dedup=identity`, the image-generation tunnel |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable, auth mode for off-loopback binds, the `/model` picker rows |
| [docs/STATUSLINE.md](docs/STATUSLINE.md) | The status bar segment |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | How the plugin is installed and updated, the proxy's lifecycle and endpoints, prompt caching, files on disk |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, invariants and the reasons behind them |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local development, gates, adding a provider |
| [docs/RELEASING.md](docs/RELEASING.md) | Merging and cutting a release |
| [docs/MAINTAINING.md](docs/MAINTAINING.md) | Traps, decision procedures, the why behind every coupling |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Open work, closed items with their evidence, reversed decisions |
| [CHANGELOG.md](CHANGELOG.md) | What changed, by version |

## Limitations

- macOS and Linux verified; Windows untested.
- GLM via Z.ai's Coding Plan endpoint (`https://api.z.ai/api/anthropic`); the
  Standard `api/paas/v4` API is not supported.
- Relies on a few Claude Code internals (`[1m]` suffix, `claude-haiku-*` ids,
  the `modelPicker` schema) that are not public API and may drift.
- No format translation: every backend must speak the Anthropic Messages API.
