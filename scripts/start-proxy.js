#!/usr/bin/env node
// @ts-check
// Spawn the cc-proxy detached and idempotent, for /cc-proxy:setup to call at
// the end of a setup turn so the proxy is up before ANTHROPIC_BASE_URL takes
// effect. Reuses the SessionStart hook's ensureProxyRunning() (TCP-probe first
// → detached spawn → wait for readiness).
//
// The proxy reads config from process.env, augmented at startup by ~/.env
// (and repo .env in dev) — see src/env.js. API keys live in ~/.env now, not
// settings.json's `env`. The settings.json `env` block still carries the
// *plumbing* the hook needs (PROXY_PORT/PROXY_LOG; PROXY_PATH only as a legacy
// pin the setup skill removes), and on a first-run setup nothing has injected
// it into *this* process yet — so we read it ourselves and merge it over
// process.env to derive ensureProxyRunning's own opts (wrong port or
// missing-path otherwise). The child then loads its own ~/.env for keys.
// Already-up is a no-op; missing-path/unreachable print guidance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, loadHomeEnv, resolveProxyPath } from "../hooks/proxy-lifecycle.js";

/** @returns {Record<string, string>} */
function settingsEnv() {
	const file = path.join(os.homedir(), ".claude", "settings.json");
	try {
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		const env = json?.env;
		if (!env || typeof env !== "object" || Array.isArray(env)) return {};
		// spawn() requires string env values; coerce so a number/boolean/null in a
		// hand-edited settings.json can't throw. Drop null/undefined entirely.
		const out = {};
		for (const [k, v] of Object.entries(env)) {
			if (v != null) out[k] = String(v);
		}
		return out;
	} catch {
		return {};
	}
}

async function main() {
	// ~/.env first: PROXY_AUTH_TOKEN lives there (the setup skill writes it
	// there), and the stale-proxy handshake inside ensureProxyRunning must
	// present it or an older token-gated proxy answers 401 and is never
	// replaced — this script then printed "already up — no action" while the
	// stale binary kept serving (measured). Never overrides process.env.
	loadHomeEnv();
	const env = { ...process.env, ...settingsEnv() };

	// ensureProxyRunning reads port/logPath/readyTimeout from process.env by
	// default — but on a first-run setup those live ONLY in settings.json, not
	// yet in this process. Derive them from the merged env and pass explicitly,
	// or the spawn targets the wrong port even though the child env is correct.
	// The proxy binary itself comes from resolveProxyPath(): this script's own
	// plugin tree first (always the current version), settings.json PROXY_PATH
	// only as a legacy fallback — a version-pinned PROXY_PATH from an old setup
	// must not pin users to a stale proxy.
	const port = Number(env.PROXY_PORT) || undefined;
	const readyTimeoutMs = Number(env.PROXY_READY_TIMEOUT_MS);
	const state = await ensureProxyRunning({
		env,
		proxyPath: resolveProxyPath(env),
		port,
		logPath: env.PROXY_LOG,
		readyTimeoutMs:
			Number.isFinite(readyTimeoutMs) && readyTimeoutMs > 0 ? readyTimeoutMs : undefined,
	});

	if (state === "already-up") {
		process.stdout.write("cc-proxy already up — no action.\n");
		return;
	}
	if (state === "started") {
		process.stdout.write("cc-proxy started.\n");
		return;
	}
	if (state === "restarted") {
		process.stdout.write("cc-proxy restarted (stale version replaced).\n");
		return;
	}
	if (state === "missing-path") {
		process.stderr.write(
			"cc-proxy not started: PROXY_PATH is unset and this plugin tree has no bin/cc-proxy.js. Reinstall the plugin (claude plugin update cc-proxy@betmoar), or /exit and /resume this session so the SessionStart hook retries.\n",
		);
		process.exitCode = 1;
		return;
	}
	// unreachable — spawn fired but the port never answered within the deadline.
	// Fall back to the /exit + /resume path: the next SessionStart will retry.
	process.stderr.write(
		"cc-proxy spawned but did not become reachable in time. /exit and /resume this session so the SessionStart hook retries; check ~/.claude/cc-proxy/cc-proxy.log.\n",
	);
	process.exitCode = 1;
}

main().catch((err) => {
	process.stderr.write(`cc-proxy start error: ${err.message}\n`);
	process.exit(1);
});
