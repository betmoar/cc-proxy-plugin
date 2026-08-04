#!/usr/bin/env node
// Renders the proxy's /v1/models discovery list for humans. Same posture as
// status.js: loadEnv() before any process.env read (port plumbing may live only
// in ~/.env), fetch the proxy over loopback, print plain text.
//
// Attribution uses the REAL router — buildProviders(process.env) + resolve() —
// so "which provider does this route to?" can never drift from what the proxy
// actually does. No predicates are restated here. Providers are filtered to the
// set the running proxy reports as registered (/ _status is the live truth) and
// claude is always present, so resolve()'s default-backend fallback stays valid.
//
// DeepSeek rows also show the curated out-price (DEEPSEEK_PRICING) — the only
// static data DeepSeek exposes (no pricing API); it's surfaced here so the
// export has a real consumer instead of guarding dead data.
//
// DECISION: one flat column with a provider suffix, no --json. The raw shape is
// one `curl localhost:4000/v1/models` away; this script is the human view.

import { loadEnv } from "../src/env.js";
import { DEEPSEEK_PRICING } from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { resolve } from "../src/router.js";

// MUST stay directly under the imports: PROXY_PORT is evaluated at load time,
// and a loadEnv() call below it would silently ignore a port set only in ~/.env
// (the exact bug that bit statusline.js — see CLAUDE.md's loadEnv coupling).
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
const FETCH_TIMEOUT_MS = 3000;

const DISPLAY = {
	glm: "GLM",
	deepseek: "DeepSeek",
	openrouter: "OpenRouter",
	qwen: "Qwen",
	claude: "Claude",
};

/**
 * Route a model id through the real router. `providers` must be the array
 * buildProviders() returned (isDefault flags set), so resolve()'s haiku pin,
 * disjoint match()es, and default-backend fallback all apply unchanged.
 * @param {string} id
 * @param {import("../src/providers.js").Provider[]} providers
 * @returns {string} provider id
 */
export function attribute(id, providers) {
	return resolve(id, { providers }).id;
}

async function fetchJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function main() {
	let status;
	try {
		status = await fetchJson(`http://127.0.0.1:${PORT}/_status`);
	} catch {
		process.stderr.write(
			`cc-proxy: proxy down on port ${PORT} — run /exit + /resume to re-trigger the SessionStart hook, or check /tmp/cc-proxy.log\n`,
		);
		process.exit(1);
	}

	let models;
	try {
		models = await fetchJson(`http://127.0.0.1:${PORT}/v1/models`);
	} catch (err) {
		process.stderr.write(`cc-proxy: /v1/models failed (${err.message})\n`);
		process.exit(1);
	}

	const defaultBackend = status.defaultBackend || "claude";
	const registered = (status.providers || []).includes("claude")
		? status.providers
		: [...(status.providers || []), "claude"];

	// The live router, restricted to what / _status says is actually on. claude is
	// always registered, so resolve() can always fall back to the default backend.
	const providers = buildProviders(process.env, defaultBackend).filter((p) =>
		registered.includes(p.id),
	);

	const rows = (models.data || []).map((m) => {
		const pid = attribute(m.id, providers);
		const name = DISPLAY[pid] || pid;
		const price =
			pid === "deepseek" && DEEPSEEK_PRICING[m.id]
				? `$${DEEPSEEK_PRICING[m.id].out.toFixed(2)}/M out`
				: "";
		return { id: m.id, name, price };
	});

	const idw = Math.max(4, ...rows.map((r) => r.id.length));
	const nmw = Math.max(4, ...rows.map((r) => r.name.length));
	process.stdout.write(
		`models: ${rows.length} reachable via cc-proxy (default backend: ${defaultBackend})\n\n`,
	);
	for (const r of rows) {
		const line = `  ${r.id.padEnd(idw)}  ${r.name.padEnd(nmw)}`;
		process.stdout.write(r.price ? `${line}  ${r.price}\n` : `${line}\n`);
	}
	for (const e of models._errors || []) {
		process.stdout.write(
			`\n! ${e.provider}: ${e.message} — that provider's live models are absent\n`,
		);
	}
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		process.stderr.write(`cc-proxy: unexpected error: ${err.message}\n`);
		process.exit(1);
	});
}
