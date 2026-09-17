# Model discovery

`GET /v1/models` on the proxy returns every model reachable through it, in
Anthropic's list format plus a few extra fields. It is a **publishing
contract**: other plugins read it, so fields are added deliberately and never
silently changed. The rationale for each field is in
[ARCHITECTURE](ARCHITECTURE.md#model-discovery-v1models).

```bash
curl -s http://127.0.0.1:4000/v1/models | jq '.data[] | {id, provider, tier, grade, context_window}'
```

## Fields

| Field | Present | Meaning |
| --- | --- | --- |
| `id` | always | The id to send as `model`. Bare in the owning backend's namespace; `<provider>:<id>` when a backend serves a foreign id (`qwen:deepseek-v4-pro`) |
| `provider` | always | Which backend serves this entry |
| `tier` | always | What the route **costs**: `1` Anthropic/OAuth, `2` prepaid plan, `3` metered credits, `4` reseller |
| `grade` | only when assessed | What the model **can do**: `Flagship`, `Strong`, or `Specialist` (narrow, not weak). Absent means nobody assessed it |
| `context_window` | only when known | Integer tokens (`1000000`, never `"1M"`). Curated for bare GLM, DeepSeek and Qwen ids; live OpenRouter entries carry the aggregator's own `context_length`. Absent on `claude-*`, and on OpenRouter ids that came from the static fallback or an `OPENROUTER_MODELS` pin |
| `usable` | only when `false` | The entry cannot complete a `/v1/messages` turn (multimodal body shape, `:batch` variants, `~latest` aliases). It may still work elsewhere: the plan's image models are flagged and served by the media tunnel below |
| `_errors` | only when a leg failed | Non-standard: `[{ provider, message }]` per live fetch that failed. The response is still `200` |

Test presence with `"grade" in entry` and `"context_window" in entry`. Neither
key is ever `null`. `tier` and `grade` are independent axes: a resold flagship
is tier 4 and Flagship.

## Where the list comes from

| Leg | Source | On failure |
| --- | --- | --- |
| GLM, DeepSeek | live catalog fetch | named in `_errors`; the leg publishes nothing |
| Qwen, OpenRouter | live catalog fetch | falls back to a curated list, silently |
| Claude | curated static list | n/a |
| LM Studio | never listed; its ids are per-machine | n/a |

Every live leg is bounded by a 3 s timeout and an 8 MB body cap. A vendor row
whose `id` is not a string is dropped, not fatal. OpenRouter's `anthropic/*`
ids are dropped on purpose: a resold Claude route bills what the session's
OAuth plan already covers. Set `OPENROUTER_MODELS` to pin that leg and skip the
fetch.

Which spelling appears **bare** is decided by namespace ownership, not by
routing: each backend lists its own ids bare and every foreign id it serves
under the `<provider>:` lens. `deepseek-v4-pro` is bare under DeepSeek and
`qwen:deepseek-v4-pro` under the plan, whichever of the two the bare id
resolves to.

## One entry per model: `?dedup=identity`

An id names a route as well as a model, so one model appears under several
ids: `deepseek-v4-pro`, `qwen:deepseek-v4-pro` and `deepseek/deepseek-v4-pro`
are one model on three routes. Picking "one model per `provider`" therefore
picks the same model twice.

`GET /v1/models?dedup=identity` collapses those to one entry each, keeping the
lowest `tier`. A `usable` entry always beats an unusable one. The identity is
the id after its **first** separator: `qwen:deepseek-v4-pro` becomes
`deepseek-v4-pro`, `z-ai/glm-5.3` becomes `glm-5.3`. An OpenRouter variant
suffix stays attached, so `google/gemini-3.7-flash:batch` is its own identity.

Opt-in: with no parameter the response is unchanged. Any other `dedup=` value
is a `400`, never a quietly un-deduped list.

## Claude Code's own discovery flag

`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` makes Claude Code fetch
`/v1/models` at startup. Measured against CC 2.1.250 (2026-08-28): it keeps
only ids matching `claude` or `anthropic`, requires `ANTHROPIC_AUTH_TOKEN` (which
demotes the claude.ai OAuth login), and ignores every other backend. For
third-party models the generated `/model` picker rows are the channel; see
[CONFIGURATION](CONFIGURATION.md#the-model-picker-and-context-windows).

## `/v1/models/<id>`

Forwarded to the backend the id routes to, not synthesized.

## The media tunnel

The Qwen Token Plan includes `wan2.7-image` and `wan2.7-image-pro`. They cannot
serve a `/model` turn (the Anthropic skin rejects their body shape, which is why
they carry `usable: false`), but they answer on DashScope's own media path, and
the proxy forwards it:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/services/aigc/multimodal-generation/generation \
  -H 'content-type: application/json' \
  -d '{"model":"wan2.7-image",
       "input":{"messages":[{"role":"user","content":[{"text":"a red cube on white"}]}]},
       "parameters":{"size":"1024*1024"}}'
```

- A **tunnel, not a translation**: the body goes byte for byte, the response is
  the vendor's own, and the proxy adds only the credential. It is the one
  path-routed request in the proxy.
- Requires `DASHSCOPE_API_KEY`; without it the path answers `503` rather than
  falling through to another backend.
- `x-dashscope-sse: enable` streams; DashScope selects streaming with a request
  header, not a body field.
- The image comes back as a **signed URL with an `Expires`**, not inline
  base64. Fetch it before that passes.
- The plan's audio ids (`qwen-audio-3.0-tts-plus`, `-realtime-plus`) have **no
  working route**: measured 2026-08-25, every HTTP path rejects them and the
  WebSocket task fails inside the vendor's engine.
