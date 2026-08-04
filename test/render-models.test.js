import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONTEXT_WINDOW } from "../scripts/list-models.js";
import { MODEL_TIERS, conduitSvg, groupByProvider } from "../scripts/render-models.js";
import {
	DEEPSEEK_PRICING,
	DEFAULT_CLAUDE_MODELS,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
} from "../src/models.js";

// MODEL_TIERS is the display layer's only curated data (like CONTEXT_WINDOW).
// This pins its coverage so a model that appears in discovery but has no tier —
// the silent-drop class of bug that shipped opus-4-8 — is caught at the gate.
// The expected id set is DERIVED from the discovery sources of truth where one
// exists (DEEPSEEK_PRICING keys, DEFAULT_QWEN_MODELS ids, DEFAULT_CLAUDE_MODELS
// ids, DEFAULT_OPENROUTER_MODELS ids), so adding a model there auto-fails if
// MODEL_TIERS misses it. GLM is live-fetched (no static catalog), so its ids are
// pinned explicitly — the one non-derivable set, same as CONTEXT_WINDOW.
describe("render-models MODEL_TIERS", () => {
	it("covers every glm/deepseek/qwen/claude/openrouter discovery id", () => {
		const derived = [
			...Object.keys(DEEPSEEK_PRICING), // deepseek native
			...DEFAULT_QWEN_MODELS.map((m) => m.id), // qwen native
			...DEFAULT_CLAUDE_MODELS.map((m) => m.id), // claude
			...DEFAULT_OPENROUTER_MODELS.map((m) => m.id), // openrouter allowlist
		];
		// GLM discovery ids, pinned (no static GLM catalog — fetched live).
		const glmIds = [
			"glm-4.5",
			"glm-4.5-air",
			"glm-4.6",
			"glm-4.7",
			"glm-5",
			"glm-5-turbo",
			"glm-5.1",
			"glm-5.2",
		];
		for (const id of [...derived, ...glmIds]) {
			assert.ok(MODEL_TIERS[id], `MODEL_TIERS missing ${id}`);
		}
	});

	it("every tier value is one of the four known labels", () => {
		const known = new Set(["Flagship", "Strong", "Specialist", "Economy"]);
		for (const v of Object.values(MODEL_TIERS)) {
			assert.ok(known.has(v), `unknown tier value: ${v}`);
		}
	});

	it("every CONTEXT_WINDOW id also has a tier (they must stay in step)", () => {
		// CONTEXT_WINDOW is the live+curated discovery id set rendered by
		// list-models.js; the infographic's tier map must cover at least that.
		for (const id of Object.keys(CONTEXT_WINDOW)) {
			assert.ok(MODEL_TIERS[id], `MODEL_TIERS missing CONTEXT_WINDOW id ${id}`);
		}
	});
});

// The two derivations that produce geometry and order rather than text. Both
// shipped visibly wrong and neither is catchable by reading the diff — the
// diagram overlapped "OpenRouter" with "Qwen", and the GLM card listed glm-5
// above glm-5.1. A screenshot found them; these assertions keep them found.
describe("render-models derivations", () => {
	it("orders models by tier, then by version descending within a tier", () => {
		const rows = [
			{ id: "glm-5", provider: "glm" },
			{ id: "glm-5.2", provider: "glm" },
			{ id: "glm-5.1", provider: "glm" },
			{ id: "glm-4.5", provider: "glm" },
			{ id: "glm-4.7", provider: "glm" },
		];
		const ids = groupByProvider(rows)
			.get("glm")
			.models.map((m) => m.id);
		// glm-5.2 Flagship, then the two Strong (5.1 before 5 — numeric collation,
		// not lexicographic, which would invert them), then Economy newest-first.
		assert.deepEqual(ids, ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.5"]);
	});

	it("draws one diagram leg per provider, with no overlapping labels", () => {
		const ids = ["glm", "deepseek", "openrouter", "qwen", "claude"];
		const svg = conduitSvg(ids);
		// Every provider is drawn, and nothing else is.
		const labels = [...svg.matchAll(/class="clabel"[^>]*>([^<]+)</g)].map((m) => m[1]);
		const legNames = labels.filter((l) => l !== "request");
		assert.deepEqual(legNames.sort(), ["Claude", "DeepSeek", "GLM", "OpenRouter", "Qwen"].sort());

		// No two labels may overlap — as BOXES, not just as same-baseline pairs.
		// The collision that shipped ("OpenRouter" over "Qwen") was between labels
		// 8px apart vertically, which a same-y comparison waves through; at a
		// ~12px line box they still visually collided. Width is approximated at
		// the same ~5.7px/char the layout uses.
		const LINE_H = 12;
		const box = (l) => ({
			x1: l.x - (l.name.length * 5.7) / 2,
			x2: l.x + (l.name.length * 5.7) / 2,
			y1: l.y - LINE_H,
			y2: l.y,
			name: l.name,
		});
		const placed = [...svg.matchAll(/<text x="(\d+)" y="(\d+)" class="clabel"[^>]*>([^<]+)</g)]
			.map((m) => box({ x: +m[1], y: +m[2], name: m[3] }))
			.filter((l) => l.name !== "request");
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const a = placed[i];
				const b = placed[j];
				const overlaps = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
				assert.ok(!overlaps, `labels overlap: ${a.name} and ${b.name}`);
			}
		}

		// The viewBox must contain every label box, or the edge one is clipped.
		const width = Number(/viewBox="0 0 (\d+) 200"/.exec(svg)[1]);
		for (const l of placed) {
			assert.ok(l.x2 <= width, `${l.name} overflows the viewBox (${l.x2} > ${width})`);
			assert.ok(l.x1 >= 0, `${l.name} is clipped at the left edge (${l.x1})`);
		}
	});

	it("escapes model ids rather than interpolating catalog text raw", () => {
		// Ids come from a live upstream catalog; a stray angle bracket must not
		// become markup.
		const rows = [{ id: '<img src=x onerror="boom">', provider: "glm" }];
		const models = groupByProvider(rows).get("glm").models;
		assert.equal(models[0].id, '<img src=x onerror="boom">', "grouping keeps the raw id");
		// The escaping itself is exercised through conduitSvg, which shares esc().
		const svg = conduitSvg(["<script>"]);
		assert.ok(!svg.includes("<script>"), "provider name must be escaped into the SVG");
		assert.ok(svg.includes("&lt;script&gt;"), `expected escaped name, got: ${svg}`);
	});
});

// The committed artifact (docs/models.html) is generated against a LIVE proxy,
// so CI cannot regenerate it — which is exactly how it went stale: the running
// proxy predated qwen3.8-max-preview, so the artifact shipped 23 models when
// the catalog held 24. The version handshake can't catch that (same version,
// changed code). This pins the artifact to the static catalog instead: every
// curated id must appear in the committed HTML, so adding a model to src/
// without running `pnpm models:html` fails the gate.
describe("docs/models.html artifact", () => {
	const html = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/models.html"),
		"utf8",
	);

	it("contains every curated (non-live) discovery id", () => {
		// Only the static lists — GLM and DeepSeek are fetched live, so their
		// rows legitimately depend on what the vendor returned at render time.
		const curated = [
			...DEFAULT_QWEN_MODELS.map((m) => m.id),
			...DEFAULT_CLAUDE_MODELS.map((m) => m.id),
			...DEFAULT_OPENROUTER_MODELS.map((m) => m.id),
		];
		for (const id of curated) {
			// The renderer inserts <wbr> after the namespace slash; match the
			// rendered form rather than the raw id.
			const rendered = id.replace("/", "/<wbr>");
			assert.ok(
				html.includes(`>${rendered}<`),
				`docs/models.html is missing ${id} — regenerate with \`pnpm models:html\``,
			);
		}
	});

	it("its model count matches the rows it actually renders", () => {
		const claimed = Number(/<span class="n">(\d+)<\/span><span class="k">models/.exec(html)[1]);
		const rendered = [...html.matchAll(/<div class="mrow">/g)].length;
		assert.equal(
			claimed,
			rendered,
			`the hero claims ${claimed} models but ${rendered} rows are drawn — regenerate with \`pnpm models:html\``,
		);
	});
});
