import { strict as assert } from "node:assert";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
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
		// NARROWED TWICE, both times because the premise moved:
		// (1) Qwen and OpenRouter became LIVE legs — their static lists are now
		//     offline FALLBACKS, so what renders is whatever the vendor returned,
		//     not these ids. Asserting on them tested the fallback, not the page.
		// (2) Cards are capped at ROW_LIMIT, so even a genuinely-served id can be
		//     legitimately absent when it ranks below the cut (this is how
		//     `tencent/hy3` started failing: real, reachable, just not top-20).
		// Claude is the only leg still truly static — no catalog endpoint — so it
		// is the only one whose curated ids MUST all appear. It is also small
		// enough to never be capped, which is what makes the assertion sound.
		const curated = DEFAULT_CLAUDE_MODELS.map((m) => m.id);
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

	it("an uncapped card renders its whole leg — the cap is the only thing that hides a row", () => {
		// Replaces the coverage the narrowed test above gave up. A card with no
		// "N of M" header is claiming completeness, so its drawn rows must equal
		// the count it prints. This still catches a silently-dropped model on
		// every small leg (GLM, DeepSeek, Qwen, Claude) without asserting that a
		// live vendor returned any particular id.
		for (const card of html.split("<section").slice(1)) {
			if (!/<h2>/.test(card) || /\d+ of \d+ models/.test(card)) continue;
			const claim = /· (\d+) models?</.exec(card);
			assert.ok(claim, "an uncapped card must print its model count");
			const drawn = [...card.matchAll(/<div class="mrow">/g)].length;
			assert.equal(
				drawn,
				Number(claim[1]),
				`${/<h2>([^<]+)</.exec(card)[1]} claims ${claim[1]} models but draws ${drawn}`,
			);
		}
	});

	it("its model count matches the rows it renders plus the ones it admits hiding", () => {
		// The hero counts every REACHABLE model; cards are capped at ROW_LIMIT, so
		// drawn rows alone no longer add up. What must still hold is that nothing
		// vanishes silently: hero == drawn + explicitly-declared hidden. A cap that
		// forgets to print its "N more" line breaks this, which is the point.
		const claimed = Number(/<span class="n">(\d+)<\/span><span class="k">models/.exec(html)[1]);
		const rendered = [...html.matchAll(/<div class="mrow">/g)].length;
		const hidden = [...html.matchAll(/<div class="more">(\d+) more/g)].reduce(
			(n, m) => n + Number(m[1]),
			0,
		);
		assert.equal(
			claimed,
			rendered + hidden,
			`the hero claims ${claimed} models but ${rendered} rows are drawn and only ${hidden} are declared hidden — regenerate with \`pnpm models:html\``,
		);
	});

	it("every capped card declares how many it hid", () => {
		// A truncated list that does not say so is a false claim about the backend's
		// scope. Pairs the "N of M models" header with the "N more" footer.
		const cards = html.split("<section").slice(1);
		for (const card of cards) {
			const of = /(\d+) of (\d+) models/.exec(card);
			if (!of) continue;
			const [shown, total] = [Number(of[1]), Number(of[2])];
			const drawn = [...card.matchAll(/<div class="mrow">/g)].length;
			assert.equal(drawn, shown, `card claims ${shown} shown but draws ${drawn}`);
			const more = /<div class="more">(\d+) more/.exec(card);
			assert.ok(more, `a capped card must print its "N more" line`);
			assert.equal(Number(more[1]), total - shown, "hidden count must be total - shown");
		}
	});
});

// The two axes the card header publishes. They are ORTHOGONAL — cost is not a
// capability grade and provenance is not billing — and the whole reason to draw
// both is that they disagree: DeepSeek is native-but-credits, so its own
// endpoint is the expensive way to reach deepseek-v4-pro. A future edit that
// collapses them into one field would quietly publish a wrong claim.
describe("render-models route/billing axes", () => {
	const html = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/models.html"),
		"utf8",
	);

	it("every provider card carries both a source and a billing chip", () => {
		const cards = [...html.matchAll(/<section class="card"[\s\S]*?<\/section>/g)].map((m) => m[0]);
		assert.ok(cards.length >= 5, `expected 5 provider cards, got ${cards.length}`);
		for (const card of cards) {
			const name = /<h2>([^<]*)<\/h2>/.exec(card)?.[1] ?? "?";
			assert.match(card, /class="axis src-(native|plan|reseller)"/, `${name}: no source chip`);
			assert.match(card, /class="axis bill-(plan|credits)"/, `${name}: no billing chip`);
		}
	});

	it("the two axes are not collapsed — at least one provider disagrees on them", () => {
		// DeepSeek: source=native, billing=credits. If every card paired
		// native↔plan and reseller↔credits, one field would be derivable from the
		// other and drawing both would be noise. This asserts the tension is real.
		const i = html.indexOf("<h2>DeepSeek</h2>");
		assert.ok(i > 0, "DeepSeek card missing");
		const card = html.slice(html.lastIndexOf("<section", i), html.indexOf("</section>", i));
		assert.match(card, /class="axis src-native"/, "DeepSeek must be sourced native");
		assert.match(card, /class="axis bill-credits"/, "DeepSeek must be billed on credits");
	});

	it("marks exactly one CARD as the default backend", () => {
		// Scoped to <section class="card">: the footer notation key renders the same
		// chip to define it, so a whole-document count is 2 by design. resolve()
		// has exactly one fallback, and two marked cards would misstate where an
		// unrouted id goes.
		const cards = [...html.matchAll(/<section class="card"[\s\S]*?<\/section>/g)].map((m) => m[0]);
		const marked = cards.filter((c) => c.includes('class="tag dflt"'));
		assert.equal(
			marked.length,
			1,
			`expected exactly one default-backend card, got ${marked.length}`,
		);
	});

	it("places each model on the card that OWNS its id, aliases on the reseller", () => {
		// REVERSED: this used to assert bare `deepseek-v4-pro` renders on the QWEN
		// card, because the renderer re-derived the provider through the router,
		// which resolves a bare id to its CHEAPEST route. That put the bare id and
		// its own `qwen:` alias side by side on one card while DeepSeek's card lost
		// the model it owns. Display follows NAMESPACE OWNERSHIP; routing follows
		// cost; the renderer now reads the published `provider` field instead of
		// recomputing one. Routing itself is unchanged and tested in router.test.js.
		const cardFor = (h2) => {
			const i = html.indexOf(`<h2>${h2}</h2>`);
			assert.ok(i > 0, `${h2} card missing`);
			return html.slice(html.lastIndexOf("<section", i), html.indexOf("</section>", i));
		};
		const qwen = cardFor("Qwen");
		assert.ok(
			cardFor("DeepSeek").includes(">deepseek-v4-pro<"),
			"deepseek-v4-pro is DeepSeek's id — it renders bare on DeepSeek's card",
		);
		assert.ok(
			!qwen.includes(">deepseek-v4-pro<"),
			"the bare id must NOT also appear on Qwen — that was the duplicate row",
		);
		assert.ok(
			qwen.includes("deepseek-v4-pro<") && /qwen:deepseek-v4-pro/.test(qwen),
			"the plan advertises it under the qwen: lens",
		);
		const glm = cardFor("GLM");
		assert.ok(glm.includes(">glm-5.2<"), "glm-5.2 renders bare on the GLM card");
		assert.ok(
			!qwen.includes(">glm-5.2<"),
			"bare glm-5.2 must not appear on Qwen; the plan's copy is qwen:glm-5.2",
		);
	});

	it("orders cards by route quality, not registry order", () => {
		// native+plan -> plan -> native+credits -> reseller. Registry order exists
		// for predicate precedence (OpenRouter before the bare-prefix legs), an
		// implementation detail; a reader wants cheapest-and-closest first.
		const order = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
		assert.equal(order.at(-1), "OpenRouter", "the reseller must sort last");
		assert.ok(
			order.indexOf("Qwen") < order.indexOf("DeepSeek"),
			`plan-sourced Qwen must precede credit-billed DeepSeek, got: ${order.join(" -> ")}`,
		);
	});
});

describe("route aliases keep their model's grade", () => {
	// docs/models.html is generated against a LIVE proxy and cannot be rebuilt in
	// CI, so a rendering bug is invisible until someone regenerates by hand. This
	// one shipped exactly that way: `deepseek:deepseek-v4-pro` rendered
	// "Specialist" (2 of 4 dots) because the grade table is keyed on vendor ids
	// and the renderer looked up the PUBLISHED id. The API was already correct —
	// collectModels() grades on entry.id — so only the infographic lied.
	it("strips a <provider>: selector before the grade lookup", () => {
		const [card] = groupByProvider([
			{ id: "deepseek:deepseek-v4-pro", provider: "deepseek" },
		]).values();
		assert.equal(card.models[0].tier, "Flagship", "an alias is the same model, so the same grade");
	});

	it("does NOT strip a slash — an aggregator id is its own key", () => {
		// Deliberate asymmetry, matching CONTEXT_WINDOW's "keyed on the EXACT id":
		// vendor/model is a distinct deployment, not an alias of the bare id.
		assert.equal(MODEL_TIERS["deepseek/deepseek-v4-pro"], "Flagship", "curated separately");
		const [card] = groupByProvider([{ id: "vendor/never-seen", provider: "openrouter" }]).values();
		assert.equal(card.models[0].tier, "Specialist", "unknown slash id falls to the default");
	});
});

// The gap an adversarial review proved on 2026-08-07: every test above reads
// the COMMITTED docs/models.html, so reintroducing the renderer's attribution
// defect left all 17 of them green. The panel had to drive render-models.js
// against a stub proxy to show the bug was real. These tests close that — they
// run the renderer as a subprocess against a fake /_status + /v1/models, so a
// regression fails the gate instead of waiting for someone to regenerate.
describe("render-models against a live-shaped proxy", () => {
	/** Serve the two endpoints the renderer fetches, then run it and return stdout. */
	async function render(modelsData, env = {}) {
		const server = http.createServer((req, res) => {
			const body = req.url.startsWith("/_status")
				? JSON.stringify({
						port: 0,
						version: "test",
						defaultBackend: "claude",
						providers: ["glm", "deepseek", "qwen", "claude"],
					})
				: JSON.stringify({ object: "list", data: modelsData });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(body);
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address();
		try {
			const script = path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"../scripts/render-models.js",
			);
			const { stdout } = await execFile(process.execPath, [script], {
				env: {
					...process.env,
					...env,
					PROXY_PORT: String(port),
					GLM_API_KEY: "g",
					DEEPSEEK_API_KEY: "d",
					DASHSCOPE_API_KEY: "q",
				},
				maxBuffer: 32 * 1024 * 1024,
			});
			return stdout;
		} finally {
			server.close();
		}
	}

	const cardFor = (html, h2) => {
		const i = html.indexOf(`<h2>${h2}</h2>`);
		assert.ok(i > 0, `${h2} card missing`);
		return html.slice(html.lastIndexOf("<section", i), html.indexOf("</section>", i));
	};

	// Discovery publishes BOTH spellings; the bare one is owned by DeepSeek while
	// the plan's copy carries the qwen: lens. Re-deriving the provider through
	// attribute()/rankRoutes (the defect this guards) is a MOVING TARGET across
	// router changes — pre-#19 it collapsed both onto Qwen (cheapest tier); this
	// stub still asserts the published `provider` field wins regardless of what
	// the router would derive, so the card is stable even if a future routing
	// change flips the derived answer back.
	const DUAL = [
		{ type: "model", id: "deepseek-v4-pro", display_name: "P", provider: "deepseek", tier: 3 },
		{ type: "model", id: "qwen:deepseek-v4-pro", display_name: "P", provider: "qwen", tier: 2 },
		{ type: "model", id: "qwen3.8-max", display_name: "M", provider: "qwen", tier: 2 },
	];

	it("files each row under the provider DISCOVERY published, not a re-derived route", async () => {
		const html = await render(DUAL);
		assert.ok(
			cardFor(html, "DeepSeek").includes(">deepseek-v4-pro<"),
			"the owning vendor must keep its bare id regardless of what re-deriving would pick",
		);
		const qwen = cardFor(html, "Qwen");
		assert.ok(qwen.includes("qwen:deepseek-v4-pro"), "the plan's copy renders under its lens");
		assert.ok(
			!qwen.includes(">deepseek-v4-pro<"),
			"the bare id must not ALSO appear on Qwen — that is the duplicate row",
		);
	});

	it("drops unusable entries and caps a card, declaring what it hid", async () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			type: "model",
			id: `glm-9.${i}`,
			display_name: `G${i}`,
			provider: "glm",
			tier: 2,
		}));
		const html = await render([
			...many,
			{ type: "model", id: "glm-x", display_name: "X", provider: "glm", usable: false },
		]);
		assert.ok(!html.includes(">glm-x<"), "an unusable entry is not selectable, so it is not shown");
		const glm = cardFor(html, "GLM");
		assert.match(glm, /20 of 25 models/, "a capped card states both numbers");
		assert.equal([...glm.matchAll(/<div class="mrow">/g)].length, 20);
		assert.match(glm, /<div class="more">5 more/, "and admits how many it hid");
	});

	it("MODELS_HTML_LIMIT=0 restores the uncapped list", async () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			type: "model",
			id: `glm-9.${i}`,
			display_name: `G${i}`,
			provider: "glm",
			tier: 2,
		}));
		const html = await render(many, { MODELS_HTML_LIMIT: "0" });
		assert.equal([...cardFor(html, "GLM").matchAll(/<div class="mrow">/g)].length, 25);
		assert.ok(!html.includes('class="more"'), "nothing hidden, so nothing to declare");
	});

	it("orders by grade first, then newest within a grade", async () => {
		// A fresh Economy model must not displace a Flagship on a capped card —
		// sorting on date alone was the tempting simplification.
		const html = await render([
			{
				type: "model",
				id: "glm-4.5",
				display_name: "old-economy",
				provider: "glm",
				created_at: "2020-01-01T00:00:00Z",
			},
			{
				type: "model",
				id: "glm-5.2",
				display_name: "flagship",
				provider: "glm",
				created_at: "2019-01-01T00:00:00Z",
			},
			{
				type: "model",
				id: "glm-4.6",
				display_name: "new-economy",
				provider: "glm",
				created_at: "2026-01-01T00:00:00Z",
			},
		]);
		const ids = [...cardFor(html, "GLM").matchAll(/<span class="mname">([^<]+)<\/span>/g)].map(
			(m) => m[1],
		);
		assert.equal(ids[0], "glm-5.2", "Flagship leads despite being the oldest");
		assert.deepEqual(ids.slice(1), ["glm-4.6", "glm-4.5"], "within Economy, newest first");
	});
});
