#!/usr/bin/env node
// Renders the proxy's /v1/models discovery list for humans. Same posture as
// status.js: loadEnv() before any process.env read (port plumbing may live only
// in ~/.env), fetch the proxy over loopback, print plain text.
//
// Attribution (the "which provider does this route to?" column) is DERIVED, not
// trusted: ids are matched against the registered providers' match() predicates
// — first match wins, mirroring the router — falling back to the default
// backend. The predicates here deliberately restate src/providers.js; if one
// changes there, change it here (locked by test/list-models.test.js).
//
// DECISION: one flat column with a provider suffix, no --json. The raw shape is
// one `curl localhost:4000/v1/models` away; this script is the human view.

import { loadEnv } from "../src/env.js";

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
 * Mirror the router: which provider does this model id route to, given the
 * registered provider ids and the default backend? Same disjoint predicates as
 * src/providers.js, restated against the /_status provider list.
 * @param {string} id
 * @param {string[]} providers registered provider ids from /_status
 * @param {string} [defaultBackend]
 * @returns {string} provider id
 */
export function attribute(id, providers, defaultBackend) {
	if (id.startsWith("claude-haiku")) return "claude"; // pinned, internal ops
	if (providers.includes("glm") && id.startsWith("glm-")) return "glm";
	if (providers.includes("deepseek") && id.startsWith("deepseek-")) return "deepseek";
	if (providers.includes("qwen") && id.startsWith("qwen") && !id.includes("/")) return "qwen";
	if (providers.includes("openrouter") && id.includes("/")) return "openrouter";
	return defaultBackend || "claude";
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

	const providers = Array.isArray(status.providers) ? status.providers : [];
	const defaultBackend = status.defaultBackend || "claude";
	const rows = (models.data || []).map((m) => {
		const pid = attribute(m.id, providers, defaultBackend);
		return [m.id, DISPLAY[pid] || pid];
	});

	const width = Math.max(4, ...rows.map(([id]) => id.length));
	process.stdout.write(
		`models: ${rows.length} reachable via cc-proxy (default backend: ${defaultBackend})\n\n`,
	);
	for (const [id, name] of rows) {
		process.stdout.write(`  ${id.padEnd(width)}  ${name}\n`);
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
