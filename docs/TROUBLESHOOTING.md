# Troubleshooting

Symptom first, then the cause and the fix. The debugging checklist at the end
is the order to look in when nothing here matches.

## Requests fail right after setup

`ECONNREFUSED` in a session that was already open when `/cc-proxy:setup` ran.
Claude Code re-applies `ANTHROPIC_BASE_URL` to open sessions immediately, and
that session retargeted before the proxy came up. `/exit` and `/resume` it; the
SessionStart hook makes sure the proxy is running. If a **new** session also
fails, the hook injects one line of context saying the proxy did not start,
and `~/.claude/cc-proxy/cc-proxy.log` has the reason.

## `localhost` refuses, `127.0.0.1` works

The proxy binds `127.0.0.1`. On an IPv6-first host `localhost` resolves to
`::1` first; Node's fallback usually copes, but new setups write
`http://127.0.0.1:4000` so nothing depends on it. Change an old `localhost`
config to the numeric form.

## `400 model: String should have at most 256 characters`

A `"model": "glm-..."` default in settings.json while the proxy is not running:
Claude Code hits Anthropic directly and its retry path corrupts the model
string. Start the proxy, or pick the model with `/model` instead.

## Port 4000 is in use

Set `PROXY_PORT` in `~/.env` and `ANTHROPIC_BASE_URL` to match. Two SessionStart
hooks racing each other is harmless: the loser logs `EADDRINUSE` and exits.

## `/cc-proxy:status` says the port answers but not as cc-proxy

Something else holds `PROXY_PORT`. The hook treats a foreign listener as
"already up" and will not start a proxy over it. `lsof -nP -iTCP:4000
-sTCP:LISTEN` names the process; free the port or move the proxy.

## A plugin update did not take effect

The proxy process outlives updates. The hook replaces an **older** proxy through
`POST /_shutdown` and leaves a same-or-newer one alone; check the version with
`curl -s http://127.0.0.1:4000/_status`. In auth mode the hook needs
`PROXY_AUTH_TOKEN` in `~/.env` to present it; versions before 0.10.2 could not,
and left the old proxy running. `/exit` and `/resume` retries the handshake;
killing the process by PID (`lsof -ti:4000`) is the manual route.

## `proxy down` in the statusline

The port is closed. `lsof -ti:4000` and the proxy log say whether it died or
never started. A new session restarts it. A gauge stuck on `!` is a different
problem: see [STATUSLINE](STATUSLINE.md#a-gauge-stuck-on-the-stale-mark).

## A model id lands on the wrong backend

Read the routing line for that request in the proxy log; `(routed as …)` shows
the normalised id when a selector or `[1m]` suffix was stripped. Then check
[ROUTING](ROUTING.md#resolution-order): a shared id goes native first, a
`<provider>:` prefix overrides, and an id nothing claims goes to
`DEFAULT_BACKEND`. `pnpm probe:vendors` re-measures whether the vendors still
serve what `src/routes.js` says they do.

## The log went quiet

`rm` and `touch` on a log a live process holds open leaves it writing to the
deleted inode. Truncate in place instead: `truncate -s 0
~/.claude/cc-proxy/cc-proxy.log`. Compare `stat` on the file with the fd in
`lsof -p <pid>` to confirm.

## Pointing one session at a different proxy

An inline prefix does **not** work; settings.json `env` wins over the process
environment, and the run looks like a success while hitting the old proxy:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:4400 claude -p "say ok"     # IGNORED
claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4400"}}' -p "say ok"   # works
```

Measured 2026-08-14 against two logging listeners (issue #25): the inline form
left the new port with zero requests. For any A/B between two proxy builds,
read the **target listener's log**, never the client's stdout.

## Debugging checklist

1. **Which plugin version is active?** `cat ~/.claude/plugins/installed_plugins.json`.
2. **Is the proxy up, and which version?** `curl -s http://127.0.0.1:4000/_status`.
3. **What did the router decide?** The `[<iso>] {<id>} <model> -> <provider> <path>` lines in `~/.claude/cc-proxy/cc-proxy.log`; `{<id>}` matches the `x-request-id` the client received.
4. **Did a vendor reject it?** A `[vendor-request-id] {<id>} <vendor id>` line follows the routing line on the buffered path.
5. **Is the log the one being written?** `stat` the file against `lsof -p <pid>`.
