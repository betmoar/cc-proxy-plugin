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
// Context windows are curated per model — the Anthropic format has no
// context_window field, and only OpenRouter serves one live, so this is
// deliberately the display layer's concern (not the proxy's). All values below
// were read from the vendors' own docs 2026-08-04:
//   GLM:     docs.z.ai/guides/llm/glm-*.md  (4.5=128K; 4.6/4.7/5/5-Turbo/5.1=200K; 5.2=1M)
//   DeepSeek: api-docs.deepseek.com/quick_start/pricing (1M)
//   Qwen:    Alibaba Cloud Model Studio (1M, incl. 3.8-max-preview)
// No number here is guessed; re-verify against the docs before a release
// touching these models, exactly like DEEPSEEK_PRICING.
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

// Curated context windows (tokens) per reachable id. All verified against the
// vendors' docs 2026-08-04 — see the header comment for sources. ids without an
// entry render no window column.
export const CONTEXT_WINDOW = {
	// GLM (docs.z.ai/guides/llm/glm-*)
	"glm-4.5": "128K",
	"glm-4.5-air": "128K",
	"glm-4.6": "200K",
	"glm-4.7": "200K",
	"glm-5": "200K",
	"glm-5-turbo": "200K",
	"glm-5.1": "200K",
	"glm-5.2": "1M",
	// DeepSeek (api-docs.deepseek.com/quick_start/pricing)
	"deepseek-v4-pro": "1M",
	"deepseek-v4-flash": "1M",
	// Qwen (Alibaba Cloud Model Studio)
	"qwen3.8-max": "1M",
	"qwen3.8-max-preview": "1M",
	"qwen3.7-max": "1M",
	"qwen3.7-plus": "1M",
	"qwen3.6-flash": "1M",
};

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

/**
 * Restrict the full provider list to the set / _status reports as actually
 * registered. claude is ALWAYS kept so resolve()'s default-backend fallback stays
 * valid — / _status omits it only when it's the implicit default and the flag is
 * absent, but it's always routable, so treating it as present is safe.
 * @param {import("../src/providers.js").Provider[]} providers
 * @param {string[]} [statusProviders]
 * @returns {import("../src/providers.js").Provider[]}
 */
export function registeredProviders(providers, statusProviders = []) {
	const on = statusProviders.includes("claude") ? statusProviders : [...statusProviders, "claude"];
	return providers.filter((p) => on.includes(p.id));
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
	} catch (err) {
		// Distinguish "proxy down" (connection refused — restart the session) from a
		// proxy that's up but returned a bad response (a code bug — the log won't show
		// a dead proxy). Conflating them sends an operator chasing a restart for a bug.
		const down =
			err instanceof TypeError || /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(err?.message || "");
		if (down) {
			process.stderr.write(
				`cc-proxy: proxy down on port ${PORT} — run /exit + /resume to re-trigger the SessionStart hook, or check /tmp/cc-proxy.log\n`,
			);
		} else {
			process.stderr.write(
				`cc-proxy: /_status returned a bad response on port ${PORT} (${err.message})\n`,
			);
		}
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
	// The live router, restricted to what / _status says is actually on. claude is
	// always kept so resolve() can always fall back to the default backend.
	const providers = registeredProviders(
		buildProviders(process.env, defaultBackend),
		status.providers,
	);

	const rows = (models.data || []).map((m) => {
		const pid = attribute(m.id, providers);
		const name = DISPLAY[pid] || pid;
		const ctx = CONTEXT_WINDOW[m.id] || "";
		const price =
			pid === "deepseek" && DEEPSEEK_PRICING[m.id]
				? `$${DEEPSEEK_PRICING[m.id].out.toFixed(2)}/M out`
				: "";
		return { id: m.id, name, ctx, price };
	});

	const idw = Math.max(4, ...rows.map((r) => r.id.length));
	const nmw = Math.max(4, ...rows.map((r) => r.name.length));
	const cw = Math.max(4, ...rows.map((r) => r.ctx.length));
	process.stdout.write(
		`models: ${rows.length} reachable via cc-proxy (default backend: ${defaultBackend})\n\n`,
	);
	for (const r of rows) {
		// ctx column only when the id has a known window; price column only for
		// DeepSeek. Trailing fields are trimmed so short rows don't pad wastefully.
		const base = `  ${r.id.padEnd(idw)}  ${r.name.padEnd(nmw)}`;
		const withCtx = r.ctx ? `${base}  ${r.ctx.padEnd(cw)}` : base;
		process.stdout.write(r.price ? `${withCtx}  ${r.price}\n` : `${withCtx}\n`);
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

// A downstream consumer closing the pipe early (e.g. `node list-models.js | head`)
// makes stdout emit EPIPE. That's a normal CLI interaction, not an error to crash
// on — swallow it and exit quietly instead of printing a stack trace.
process.stdout.on("error", (err) => {
	if (err && err.code === "EPIPE") process.exit(0);
	throw err;
});
