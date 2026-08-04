import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Locks the cross-file couplings documented in CLAUDE.md ("Couplings — if you
// touch X, you must also update Y") that no behavioral test can catch: the
// files involved never import each other, so a drifted copy fails silently at
// runtime (wrong port probed, hook killed mid-poll, undocumented env knob).
// Each test names its coupling; a failure message tells you every file to fix.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

describe("cross-file couplings", () => {
	// COUPLING: the PROXY_PORT default is read independently in four files
	// (deliberately — the hook must not import src/). Change it in all four or
	// in none; a split default means the proxy binds one port while the hook
	// and statusline probe another ("proxy down" forever, duplicate spawns).
	it("PROXY_PORT default (4000) is identical in all four readers", () => {
		const files = [
			"src/config.js",
			"hooks/proxy-lifecycle.js",
			"scripts/status.js",
			"scripts/statusline.js",
		];
		const defaults = files.map((f) => {
			const m = /process\.env\.PROXY_PORT \|\| (\d+)/.exec(read(f));
			assert.ok(m, `${f}: could not locate the PROXY_PORT default — update this coupling test`);
			return { file: f, value: m[1] };
		});
		const distinct = new Set(defaults.map((d) => d.value));
		assert.equal(
			distinct.size,
			1,
			`PROXY_PORT defaults diverged: ${defaults.map((d) => `${d.file}=${d.value}`).join(", ")}`,
		);
	});

	// COUPLING: hooks.json kills the SessionStart hook at `timeout` seconds; the
	// readiness poll inside it defaults to PROXY_READY_TIMEOUT_MS. A ready
	// timeout at or past the hook kill silently never completes — raise both
	// together, keeping at least 1s of spawn/probe headroom.
	it("hook timeout exceeds the default readiness poll with headroom", () => {
		const hooks = JSON.parse(read("hooks/hooks.json"));
		const hookTimeoutMs = hooks.hooks.SessionStart[0].hooks[0].timeout * 1000;
		const m = /envTimeout > 0 \? envTimeout : (\d+)/.exec(read("hooks/proxy-lifecycle.js"));
		assert.ok(
			m,
			"could not locate the ready-timeout default in proxy-lifecycle.js — update this test",
		);
		const readyDefaultMs = Number(m[1]);
		assert.ok(
			readyDefaultMs + 1000 <= hookTimeoutMs,
			`PROXY_READY_TIMEOUT_MS default (${readyDefaultMs}ms) needs ≥1000ms headroom under the ` +
				`hooks.json timeout (${hookTimeoutMs}ms) — raise both together`,
		);
	});

	// COUPLING: the plugin description is carried by three manifests — package.json
	// (npm/tooling), plugin.json (the Claude Code plugin pane), and
	// marketplace.json's entry (the install listing). Nothing at runtime reads all
	// three, so a drifted copy is invisible until a user reads the stale one:
	// package.json still advertised "Z.ai and OpenRouter" two providers after
	// DeepSeek and Qwen shipped.
	it("plugin description is identical in package.json, plugin.json, and marketplace.json", () => {
		const pkg = JSON.parse(read("package.json")).description;
		const plugin = JSON.parse(read(".claude-plugin/plugin.json")).description;
		const market = JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].description;
		assert.equal(plugin, pkg, "plugin.json description drifted from package.json");
		assert.equal(market, pkg, "marketplace.json entry description drifted from package.json");
	});

	// COUPLING: scripts/list-models.js's display CONTEXT_WINDOW must be
	// DERIVED from src/models.js's CONTEXT_WINDOW (the wire source of truth
	// for GET /v1/models' context_window field), never a second
	// hand-maintained literal. This is the exact "same data in two files"
	// drift class this test file exists to catch — before the 0.5.1
	// promotion, list-models.js declared its own curated { id: "128K" } map
	// that could silently disagree with the number now shipped on the wire.
	it("scripts/list-models.js imports its context-window source from src/models.js instead of restating it", () => {
		const src = read("scripts/list-models.js");
		assert.ok(
			/import\s*\{[^}]*CONTEXT_WINDOW as CONTEXT_WINDOW_TOKENS[^}]*\}\s*from\s*"\.\.\/src\/models\.js"/.test(
				src,
			),
			"list-models.js must import CONTEXT_WINDOW from src/models.js (aliased), not restate it",
		);
		// Re-declaration is caught semantically (key set + every value) by
		// test/list-models.test.js "display CONTEXT_WINDOW is derived
		// byte-for-byte…"; a hand-written table diverges there the moment it
		// differs at all. This half only pins the DERIVATION SITE, so the
		// export stays a mapping over the imported table rather than a literal
		// that happens to agree today. A text probe for a literal's opening
		// comment was near-inert — it only fired on `{\n // GLM`.
		assert.ok(
			/export const CONTEXT_WINDOW\s*=\s*Object\.fromEntries\(\s*\n?\s*Object\.entries\(CONTEXT_WINDOW_TOKENS\)/.test(
				src,
			),
			"list-models.js's CONTEXT_WINDOW must stay a derivation over the imported table, not a hand-written literal",
		);
	});

	// COUPLING: every env var offered in .env.example must be documented in the
	// README env table and in docs/OPERATIONS.md (new knobs go in all three).
	it("every .env.example key is documented in README.md and docs/OPERATIONS.md", () => {
		const keys = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
		assert.ok(keys.length >= 5, `expected .env.example to define keys, parsed: ${keys.join(", ")}`);
		const readme = read("README.md");
		const ops = read("docs/OPERATIONS.md");
		for (const key of keys) {
			assert.ok(readme.includes(key), `${key} is in .env.example but missing from README.md`);
			assert.ok(ops.includes(key), `${key} is in .env.example but missing from docs/OPERATIONS.md`);
		}
	});
});
