# Routing

How a request's `model` picks a backend, how to name one route when a model has
several, and the two spellings the proxy strips before forwarding. The design
rationale is in [ARCHITECTURE](ARCHITECTURE.md#route-selection); what each
backend serves is in [DISCOVERY](DISCOVERY.md).

## The backends

| Backend | Selected by | Auth sent upstream | Registered when |
| --- | --- | --- | --- |
| GLM (Z.ai) | bare `glm-*` | `x-api-key` | `GLM_API_KEY` is set |
| DeepSeek | bare `deepseek-*` without a date suffix | `x-api-key` | `DEEPSEEK_API_KEY` is set |
| Qwen (Token Plan) | bare `qwen*`, dated DeepSeek builds (`deepseek-v4-flash-0731`), plan resells (`deepseek-v4-pro`) | `Authorization: Bearer` | `DASHSCOPE_API_KEY` is set |
| OpenRouter | any `vendor/model` id | `Authorization: Bearer` | `OPENROUTER_API_KEY` is set |
| LM Studio | `lmstudio:<id>` selector only | `Authorization: Bearer` | `LMSTUDIO_BASE_URL` is set |
| Claude | `claude-*`, and every id nothing else claims | the inbound OAuth header, unchanged | always |

A backend with no key is not registered, so its ids fall through to the next
rule. With zero keys the proxy still starts and routes everything to Claude.

## Resolution order

`resolve()` in `src/router.js` runs these steps in order. The first hit wins.

| # | Rule | Goes to |
| --- | --- | --- |
| 0 | Strip a `<provider>:` selector and a trailing `[…]` suffix | the normalised id is what every step below reads |
| 1 | The id starts with `claude-haiku-` | Claude, always. Claude Code's internal ops never burn paid quota |
| 2 | The selector names a registered provider | that provider |
| 3 | The id has probed routes in `src/routes.js` | the native provider first, then the cheapest tier, among registered providers only |
| 4 | The first provider whose `match()` accepts the id | that provider |
| 5 | Nothing matched | `DEFAULT_BACKEND` (`claude` unless configured) |

The haiku pin tests the stripped id and outranks the selector, so
`glm:claude-haiku-…` still goes to Claude.

## Naming a route explicitly

The same model is often reachable on several backends at different prices. A
`<provider>:` prefix picks one. The proxy strips it before forwarding, so the
backend only ever sees its own id.

```
/model deepseek-v4-pro              # native DeepSeek when DEEPSEEK_API_KEY is set, else the Qwen plan
/model deepseek:deepseek-v4-pro     # DeepSeek's own endpoint, explicit
/model qwen:deepseek-v4-pro         # the Qwen plan's copy, explicit
/model deepseek/deepseek-v4-pro     # via OpenRouter, a real OpenRouter id, unchanged
/model lmstudio:openai/gpt-oss-20b  # your LM Studio server, the only way in
```

Colon only. A slash belongs to OpenRouter's namespace and keeps meaning
OpenRouter. An unknown prefix such as `bogus:thing` is not a selector; the whole
string routes by the table above.

**Native wins over a cheaper resold route on purpose.** A plan gateway injects a
preamble, measured at +79 input tokens on `deepseek-v4-pro` through the Qwen
plan, so the native and resold routes are not interchangeable. The bare id is
what `/model` sets, so it prefers the weights it names. Without a native key the
bare id falls back to the plan.

## The `[1m]` suffix

Claude Code spells a long-context variant `glm-5.2[1m]`. Both Z.ai and the Qwen
plan reject that spelling with a `400` (probed 2026-08-14, re-measured by
`pnpm probe:vendors`), so the proxy strips a well-formed trailing `[…]` pair for
routing and from the forwarded body. Only the last pair goes, and never to an
empty id: `glm-5.2[1m]` becomes `glm-5.2`, while `[1m]` and `glm-5.2[` are left
alone. The exact cases are executed `@doctest` lines on `stripVariantSuffix()`.

## Model assignment in Claude Code

- **Primary model.** Set `ANTHROPIC_DEFAULT_OPUS_MODEL` and
  `ANTHROPIC_DEFAULT_SONNET_MODEL` to a routed id such as `glm-5.2[1m]` in
  settings.json `env`.
- **Subagents.** Pin a model in the subagent's own `model` field, or switch
  with `/model`.
- **Never point `ANTHROPIC_DEFAULT_HAIKU_MODEL` at a third-party id.** Claude
  Code uses the haiku tier for titles, summaries and quick tool calls. Redirected,
  those requests arrive as `model:"glm-4.7"`, miss the haiku pin, and burn GLM
  quota on overhead.

## What the proxy changes in a request

Bodies are forwarded byte for byte, with three exceptions:

1. `thinking` and `redacted_thinking` blocks are removed from assistant
   history, so a backend switch mid-session does not fail on another backend's
   signatures. The strip is deterministic, which is why prompt caching survives
   it (see [OPERATIONS](OPERATIONS.md#prompt-caching)).
2. The `<provider>:` selector is removed from `model`.
3. The `[…]` variant suffix is removed from `model`.

Headers: auth is replaced per backend, hop-by-hop headers are dropped, and the
upstream's own `x-request-id` is replaced by the proxy's correlation id.

## What the proxy changes in a response

- A **non-streaming GLM context overflow** (a `200` with empty content and
  `stop_reason: model_context_window_exceeded`) becomes a `400` so it is
  visible instead of an empty turn. A streaming overflow already surfaces as
  Claude Code's own context-limit message. Recovery is yours: `/model`,
  `/clear`, or `/compact`.
- A **GLM `1302` rate limit** (HTTP `429` with no `Retry-After`) gets
  `Retry-After: 30` injected so Claude Code backs off by itself. Only code
  `1302`: the sibling `1113` (insufficient balance) and every other `429` pass
  through untouched, because a retry hint on a non-retryable error loops forever.

## Reading the routing log

Every request writes one line to `~/.claude/cc-proxy/cc-proxy.log`:

```
[2026-09-08T10:00:00.000Z] {3f9a1c2e} glm:glm-5.2[1m] -> glm (routed as glm-5.2) /v1/messages?beta=true
```

- `{3f9a1c2e}` is the correlation id, echoed to the client as `x-request-id`.
- `(routed as …)` appears only when a strip changed the id.
- `unknown -> claude /v1/messages/count_tokens` is a request with no `model`
  field, usually a non-Messages call.

`PROXY_DEBUG=1` adds a `metadata` and `system` summary per request.
