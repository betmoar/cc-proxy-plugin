[P1] baseline: pnpm lint clean (70 files); pnpm test 607 total / 605 pass / 0 fail / 2 skipped; exit 0
[P1] entry-point traced: bin/cc-proxy.js -> loadEnv -> config.load -> createServer -> listen
[P1] entry-point traced: hooks/session-start.js -> ensureProxyRunning -> (checkPort|probeProxyVersion|requestShutdown|spawnProxy)
[P1] dispatcher traced: server.js createServer -> probes -> auth gate -> body -> /_shutdown | /v1/models | media | handleProxy -> resolve -> forward|forwardBuffered
[P1] read in full: src/{server,proxy,router,providers,config,env,sanitize,fallback,agents}.js hooks/{proxy-lifecycle,session-start}.js bin/cc-proxy.js README CONTRIBUTING docs/{ARCHITECTURE,OPERATIONS}.md CLAUDE.md skills/setup/SKILL.md commands/{status,models}.md
[P1] not yet read (delegated P2): src/{models,routes,model-picker}.js hooks/picker-staleness.js scripts/* test/* docs/BACKLOG.md body
[P1] delta noted: PROXY_READY_TIMEOUT_MS restart-path budget ~= 300+1000+1000+2T; exceeds hooks.json 10s from T~3900, doc says >=10000
[P1] delta noted: handleShutdown comment + OPERATIONS endpoint bullet say "no auth"; dispatcher gates /_shutdown under PROXY_AUTH_TOKEN (#45)
[P1] delta noted: README intro/diagram/ARCHITECTURE layout list 5 backends and omit routes.js/model-picker.js/agents.js/fallback.js
[P1] EXIT: load-bearing map (12 entries), implicit contracts (IC1-IC9), delta stated -> AUDIT_STATE.md written; cursor -> P2
[P2] F01 P1 high  src/server.js parseJsonOrEmpty/dispatch  POST body `null` -> TypeError in 'end' listener -> process exit 1 (repro: scratchpad/null-body.mjs)
[P2] F02 P2 high  hooks/session-start.js  PROXY_AUTH_TOKEN lives in ~/.env (SKILL.md) but hook never loads it -> /_shutdown 401 -> stale proxy never replaced (repro: scratchpad/stale-stub.mjs)
[P2] F03 P3 high  CLAUDE.md coupling row  restart-path budget 300+2*1000+2*T exceeds hooks.json 10s from T~3900, row said >=10000
[P2] F04 P3 high  src/server.js handleShutdown comment + docs/OPERATIONS.md:92  "/_shutdown carries no auth" predates #45
[P2] agent A (catalog/picker) reported F20-F25; F20-F23 re-run by me from its scratchpad scripts: all reproduce; F24 reproduced at 40MB (rss 62->290MB); F25 reproduced
[P2] agent B (statusline/scripts) reported F40-F48; F40-F46 re-run by me from its scratchpad scripts: all reproduce; F47/F48 are comment/prose (traced)
[P3] F01 fixed: parseJsonOrEmpty object guard + try/catch around dispatch; test server.test.js "dispatcher containment" x2
[P3] F02 fixed (hook side): loadHomeEnv() in proxy-lifecycle.js, requestShutdown(port, token), token from opts.env; tests proxy-lifecycle.test.js x3
[P3] F03 fixed: HANDSHAKE_TIMEOUT_MS + DEFAULT_READY_TIMEOUT_MS exported; couplings.test.js "the stale-proxy restart path fits inside the hooks.json timeout"
[P3] F04 fixed (code comment); OPERATIONS prose deferred to the docs restructure
[P3] F20 fixed: coerceEntry typeof guard + 2 comments; F25 fixed: openrouter null element; F24 fixed: readJsonCapped + CATALOG_BODY_LIMIT; tests models.test.js "one malformed vendor row never empties the catalogue" x3
[P3] F21/F22 fixed: writeSettings realpath + mode preserve; F23 fixed: run() stamps tree version; tests model-picker.test.js x4
[P3] gate: pnpm lint clean; pnpm test 619 total / 617 pass / 0 fail / 2 skipped (baseline 607/605/0/2)
[P2] agent C (release tooling/CI) reported F60-F75; F60 (v0.10.1 tag lacks glm-5.3-flash), F63 (last-wins flag) re-verified by me; F61/F62/F64/F65 traced
[P2] agent D (docs drift) reported F80-F101 (22 items, all CONFIRMED doc-line vs code-line); F83 upgraded from moderate to high after the plugin reference confirmed only the braced form is substituted
[P2] EXIT: four surfaces swept, no P0 found, every P1/P2 reproduced; not covered: live vendor behaviour (probe:vendors not run, spends quota), Windows, the live `claude` binary
[P3] F40 fixed: bench.md quoted heredoc; test/commands.test.js (9 tests) runs the body with `| cat`, `> file`, `'a`, `$(…)` spliced
[P3] F41 fixed: start-proxy.js loadHomeEnv(); test start-proxy.test.js token-gated stale stub
[P3] F42/F43/F46/F47 fixed: statusline.js contained render, Array.isArray guard, .failed backoff marker, writeCacheAtomic; tests statusline.test.js x2; couplings writer list + statusline.js
[P3] F44 fixed: status.js probeStatus() classifies foreign; formatStatusReport foreign branch; tests status.test.js x3
[P3] F45 fixed: quota.js openrouterCreditsUrl() seam + null on missing total; tests quota.test.js x2
[P3] F60 fixed: render-models.test.js locks CONTEXT_WINDOW ids and MODEL_GRADES grades against docs/models.html
[P3] F61 fixed: release-gate.test.js runs gate() against the checkout
[P3] F62 fixed: release.yml fetch-depth 0 + merge-base --is-ancestor on the tag commit
[P3] F63 fixed: disablesTagging last-wins + 2 doctests (count 61 -> 63); F64 documented in the version-guard header grid
[P3] F65 fixed: env.js throws without process.loadEnvFile; .npmrc engine-strict; test dotenv.test.js subprocess
[P3] F67/F68/F70/F75 fixed in couplings.test.js; F73 comment fixed
[P3] gate: pnpm lint clean; pnpm test 640 total / 638 pass / 0 fail / 2 skipped
[P4] docs written: docs/ROUTING.md, DISCOVERY.md, CONFIGURATION.md, STATUSLINE.md, TROUBLESHOOTING.md, RELEASING.md, MAINTAINING.md; README, OPERATIONS, ARCHITECTURE, CONTRIBUTING, CLAUDE.md rewritten; .env.example, SKILL.md, BACKLOG updated (17/18 struck, 21-24 added)
[P4] F80-F101 resolved in the rewrite: /_shutdown auth (F80), hook presents token (F81), picker rows not ANTHROPIC_CUSTOM_MODEL_OPTION (F82), ${CLAUDE_PLUGIN_ROOT} braces (F83), status quota list (F84), OpenRouter context_window (F85), older-not-mismatch (F86), OPENROUTER_MODELS live (F87), setup writes the keys it collects (F88), keyless GLM row (F89), PROXY_PATH legacy (F90), ready-timeout bound (F91), PROXY_PORT readers (F92), env tables complete both ways (F93), backlog 17/18 struck (F94), LM Studio everywhere (F95), layout tree regenerated (F96), 8 invariants + full priority table (F97), "nine" numerals dropped (F98), skill phrase (F99), proxy_alive.json row (F100), mediaBaseUrl in Provider blocks (F101)
[P4] guardrail written: test/docs.test.js (9 tests) — links/anchors, README map, 400-char line cap, invariant parity, layout completeness, Provider shape, backend table, /_shutdown row, skill phrases; ran green
[P4] guardrail written: couplings.test.js env lock re-pointed at docs/CONFIGURATION.md, both directions; models-field lock at DISCOVERY+ARCHITECTURE; anthropic/ scan covers every docs/*.md
[P4] CHANGELOG 0.10.2 written; pnpm version patch --no-git-tag-version -> 0.10.2 (guard allowed: flag present off main; plugin.json synced)
[P4] gate: pnpm lint clean (72 files); pnpm test 649 total / 647 pass / 0 fail / 2 skipped
[P4] EXIT: guardrails exist and ran green; playbooks (MAINTAINING, RELEASING), handoff (CLAUDE.md, ARCHITECTURE) and backlog on disk; cursor -> DONE
