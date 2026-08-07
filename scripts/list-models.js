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
// Context windows are curated per model. As of 0.5.1 the curated integer
// table (tokens, not display strings) lives in src/models.js as
// CONTEXT_WINDOW and is published on the wire as `context_window` on
// GET /v1/models. This REVERSES the decision this comment used to record
// through 0.5.0 — "the Anthropic format has no context_window field ...
// deliberately the display layer's concern (not the proxy's)". Reason: a
// second consumer (the cc-reload plugin, which budgets a session's context
// against its model's window) needed the number programmatically, and
// duplicating the curated table in every consumer is the failure mode this
// promotion exists to kill. See CHANGELOG 0.5.1 for the reversal record.
//
// This file now only FORMATS that integer into the human column string
// ("128K"/"1M") — it is derived, never a second source. `CONTEXT_WINDOW`
// below stays exported with the SAME shape (id -> display string) it always
// had, so this file's rendered output can't drift from src/models.js's
// numbers. Provenance/sources for the underlying numbers (2026-08-04,
// re-verify before each release touching the model) live on the doc comment
// of CONTEXT_WINDOW in src/models.js:
//   GLM:      docs.z.ai/guides/llm/glm-*.md  (4.5=128K; 4.6/4.7/5/5-Turbo/5.1=200K; 5.2=1M)
//   DeepSeek: api-docs.deepseek.com/quick_start/pricing (1M)
//   Qwen:     Alibaba Cloud Model Studio (1M, incl. 3.8-max-preview)
//
// DECISION: one flat column with a provider suffix, no --json. The raw shape is
// one `curl localhost:4000/v1/models` away; this script is the human view.

import { loadEnv } from "../src/env.js";
import { CONTEXT_WINDOW as CONTEXT_WINDOW_TOKENS, DEEPSEEK_PRICING } from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { resolveProvider } from "../src/router.js";

// MUST stay directly under the imports: PROXY_PORT is evaluated at load time,
// and a loadEnv() call below it would silently ignore a port set only in ~/.env
// (the exact bug that bit statusline.js — see CLAUDE.md's loadEnv coupling).
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
const FETCH_TIMEOUT_MS = 3000;

/** Format a curated integer token count into the human column string this
 * table has always rendered: "128K" below 1M, "1M" at/above it. Rendered
 * output for currently-covered models must stay byte-identical to pre-0.5.1
 * — that string is a documented contract of `/cc-proxy:models`.
 * @param {number} tokens
 * @returns {string}
 */
export function formatContextWindow(tokens) {
	// Rounded, not exact division: vendor windows are often powers of two, and
	// the vendor's own "128K" means 131072. Correcting the table to the true
	// integer would otherwise render "131.072K". Rounding keeps the column
	// reading the way the vendor writes it, which is what this string is for.
	return tokens >= 1000000 ? `${Math.round(tokens / 1000000)}M` : `${Math.round(tokens / 1000)}K`;
}

// Display-string context windows per reachable id, DERIVED from
// src/models.js's CONTEXT_WINDOW (the single source of truth for the wire
// integer) — never restated. ids without an entry render no window column.
export const CONTEXT_WINDOW = Object.fromEntries(
	Object.entries(CONTEXT_WINDOW_TOKENS).map(([id, tokens]) => [id, formatContextWindow(tokens)]),
);

/** Provider id → human name. Shared by the table (list-models) and the HTML
 * renderer (render-models) so a renamed provider can't drift between the two. */
export const DISPLAY = {
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
	return resolveProvider(id, { providers }).id;
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
				`cc-proxy: proxy down on port ${PORT} — run /exit + /resume to re-trigger the SessionStart hook, or check ~/.claude/cc-proxy/cc-proxy.log\n`,
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
		// `provider` is which backend PUBLISHED the row — discovery already knows,
		// because it built the row. attribute() answers a different question ("where
		// would /model send this id?"), and the two diverge exactly where it matters:
		// a bare id routes to its cheapest backend, so re-deriving here filed
		// deepseek-v4-pro under Qwen while DeepSeek's own card lost the model it
		// owns. Fall back to the router only for a proxy older than this field.
		const pid = m.provider || attribute(m.id, providers);
		const name = DISPLAY[pid] || pid;
		// A prefixed id (`qwen:deepseek-v4-pro`) is the same model reached another
		// way, and the curated window/price tables are keyed on the BARE id — so
		// look them up by the tail rather than blanking the column on every alias.
		const bare = m.id.slice(m.id.indexOf(":") + 1);
		const ctx = CONTEXT_WINDOW[bare] || "";
		const price =
			pid === "deepseek" && DEEPSEEK_PRICING[bare]
				? `$${DEEPSEEK_PRICING[bare].out.toFixed(2)}/M out`
				: "";
		// `usable: false` = reachable but not selectable from a Claude Code session
		// (image/audio models want another request schema; `:batch`/`~latest`/auto
		// are not chat models). Shown rather than hidden so the catalog stays a
		// true picture of the backend — but marked, so nobody picks one from /model
		// and gets an opaque body-shape error.
		return { id: m.id, name, pid, ctx, price, unusable: m.usable === false };
	});

	const idw = Math.max(4, ...rows.map((r) => r.id.length));
	const nmw = Math.max(4, ...rows.map((r) => r.name.length));
	const cw = Math.max(4, ...rows.map((r) => r.ctx.length));
	process.stdout.write(
		`models: ${rows.length} reachable via cc-proxy (default backend: ${defaultBackend})\n\n`,
	);
	// Group by backend, in the order the rows arrived (registry order: glm,
	// deepseek, openrouter, qwen, claude), with a blank line between groups. The
	// ordering is discovery's, not this script's — one place decides it.
	let group;
	for (const r of rows) {
		if (group !== undefined && r.pid !== group) process.stdout.write("\n");
		group = r.pid;
		// ctx column only when the id has a known window; price column only for
		// DeepSeek. Trailing fields are trimmed so short rows don't pad wastefully.
		const mark = r.unusable ? " ·" : "  ";
		const base = `${mark}${r.id.padEnd(idw)}  ${r.name.padEnd(nmw)}`;
		const withCtx = r.ctx ? `${base}  ${r.ctx.padEnd(cw)}` : base;
		const tail = r.unusable ? "  (not chat-usable)" : r.price ? `  ${r.price}` : "";
		process.stdout.write(`${withCtx}${tail}\n`);
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
