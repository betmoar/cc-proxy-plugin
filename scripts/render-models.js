#!/usr/bin/env node
// Renders cc-proxy's reachable models as a self-contained HTML infographic
// (the "one glance → wow" view), driving the same /v1/models + /_status + router
// as list-models.js so ids, providers, and registered legs can never drift.
//
// Usage:  node scripts/render-models.js > docs/models.html
// (Optionally screenshot docs/models.html with a browser to produce a PNG — the
// HTML is the committed artifact; a PNG is a build output, not source.)
//
// Same posture as list-models.js: loadEnv() before any process.env read, fetch
// the proxy over loopback. Attribution uses the REAL router (attribute()) — no
// predicate restated here. Providers are filtered to the set / _status reports
// registered (registeredProviders()).
//
// NOTHING is curated here any more. The intelligence tier now lives in
// src/models.js as MODEL_GRADES and is published on /v1/models as `grade`;
// this layer keeps its vocabulary but reads through gradeOf(), the SAME
// function the endpoint calls. Re-exporting the raw MODEL_GRADES table was not
// enough: gradeOf() also applies the `bench grades` refresh from
// ~/.claude/cc-proxy/grades.json, so a table read went stale the moment an
// operator refreshed and the page then disagreed with /v1/models about the same
// model. That followed CONTEXT_WINDOW's move in 0.5.1, for the same reason: a
// second consumer (cc-operator, dispatching by model strength) needed it
// programmatically, and the alternative was the same curated table in two
// repos. A model nobody has assessed has NO grade — the endpoint omits the
// field and this page renders it as "ungraded" (0 of 4 dots), sorted last.
// The grades themselves still want evals (docs/BACKLOG.md item 9).
//
// Lookup keys are VENDOR ids. A `<provider>:` route alias is stripped before the
// lookup (tierFor) — it is the same model reached another way. Pinned by
// test/render-models.test.js so a silent drop (the opus-4-8 class of bug) is
// caught at the test gate.

import { loadEnv } from "../src/env.js";
import { MODEL_GRADES, gradeOf } from "../src/models.js";
import { buildProviders } from "../src/providers.js";
import { isDirectRun } from "./direct-run.js";
import {
	CONTEXT_WINDOW,
	DISPLAY,
	attribute,
	formatContextWindow,
	registeredProviders,
} from "./list-models.js";

// MUST stay directly under the imports — see list-models.js / CLAUDE.md.
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
const FETCH_TIMEOUT_MS = 3000;

/** Max rows drawn per provider card. OpenRouter alone publishes ~370 models, so
 * an uncapped page is thousands of lines of scroll in which the four small,
 * interesting cards are invisible. Cards under the cap are untouched — today
 * that is every leg except OpenRouter.
 *
 * `MODELS_HTML_LIMIT=0` renders everything (the old behavior). Deliberately NOT
 * in `.env.example` / the README env table: it is a knob for regenerating this
 * one artifact, not proxy configuration, and adding it there would oblige the
 * coupling test's three-file documentation contract. */
const ROW_LIMIT = (() => {
	const raw = process.env.MODELS_HTML_LIMIT;
	if (raw === undefined || raw === "") return 20;
	const n = Number(raw);
	// Junk falls back to the default rather than rendering 0 or NaN rows — a
	// typo'd env var must not silently empty the page.
	return Number.isInteger(n) && n >= 0 ? n : 20;
})();

/**
 * Intelligence tier per model id. NO LONGER CURATED HERE — the table moved to
 * `src/models.js` as MODEL_GRADES (2026-08-06) when a second consumer needed it
 * programmatically, exactly as CONTEXT_WINDOW moved in 0.5.1. This re-export
 * keeps the display layer's vocabulary while making drift impossible.
 *
 * READ-ONLY, and NOT the lookup path — tierFor() below goes through gradeOf(),
 * which also applies the `bench grades` refresh. This export exists for the
 * coverage assertions in test/render-models.test.js (every discovery id has a
 * built-in grade); using it to render would republish the pre-refresh table.
 *
 * Do not reintroduce a local copy: "the same curated data in two places" is the
 * failure `test/couplings.test.js` exists to catch.
 * @type {Record<string, "Flagship" | "Strong" | "Specialist">}
 */
export const MODEL_TIERS = MODEL_GRADES;

/** How an UNASSESSED model renders. Not a grade — `/v1/models` omits the field
 * for these ids (0.6.1 retired the `Specialist` default, which read as a verdict
 * on 299 of 320 models nobody had looked at). A row still has to sort and still
 * has to print something, so the absence gets an explicit name here rather than
 * inheriting a default the API no longer has. Lowercase deliberately: the three
 * real grades are proper nouns, this is a statement about our knowledge. */
export const UNGRADED = "ungraded";

/** The rank of a tier, for ordering rows Flagship → ungraded (last). */
const TIER_ORDER = { Flagship: 0, Strong: 1, Specialist: 2 };
const tierRank = (t) => TIER_ORDER[t] ?? 99;
// Strips a `<provider>:` route selector before the lookup: the grade table is
// keyed on VENDOR ids, and an alias is the same model reached another way — so
// `deepseek:deepseek-v4-pro` must grade Flagship like its bare form, not render
// as ungraded. (Not `/`: an OpenRouter `vendor/model` id is its own key,
// deliberately — see CONTEXT_WINDOW's "keyed on the EXACT id" note.)
//
// gradeOf() does NOT do this tail fallback — the API never needs it, because
// collectModels() grades on the bare `entry.id` BEFORE applying the lens, while
// this page only ever sees the published (already-prefixed) id. So the aliasing
// lives here, and it is two gradeOf() calls rather than one lookup with a
// fallback key. The prototype trap the old table lookup had to guard
// (`constructor` inheriting a function from Object.prototype) is gone with the
// table read: gradeOf() uses Object.hasOwn internally and returns undefined.
const tierFor = (id) => gradeOf(id) ?? gradeOf(id.slice(id.indexOf(":") + 1)) ?? UNGRADED;

/** Curated context window for a published id, or undefined.
 *
 * Same aliasing as tierFor, and for the same reason: CONTEXT_WINDOW is keyed by
 * the BARE vendor id, but this page sees the published one, which may carry a
 * `<provider>:` lens. Without the fallback `qwen:glm-5.2` rendered a blank
 * window beside a bare `glm-5.2` showing 1M — the same model, two answers.
 * Object.hasOwn on both reads: ids come from live catalogs, so `constructor`
 * would otherwise inherit a function off Object.prototype. */
const windowFor = (id, published) => {
	// The PUBLISHED integer wins when the API sent one. `provider` above already
	// learned this lesson ("use the published field, not a re-derivation"): the
	// curated table covers the ids this repo curates, while OpenRouter's ~300
	// carry a real `context_length` that only the API knows. Re-deriving from the
	// table alone rendered all 20 OpenRouter rows blank while /v1/models had the
	// number in hand.
	// >= 1000, not > 0: formatContextWindow rounds to the nearest K, so anything
	// under 500 renders "0K" and 500-999 renders "1K". "0K" reads as "no context"
	// — worse than the blank this fix exists to remove. A sub-1K window is not a
	// real model anyway, so it falls through to the curated table and then to no
	// column at all, which states the truth: we have nothing useful to show.
	if (typeof published === "number" && published >= 1000) return formatContextWindow(published);
	if (Object.hasOwn(CONTEXT_WINDOW, id)) return CONTEXT_WINDOW[id];
	const bare = id.slice(id.indexOf(":") + 1);
	return Object.hasOwn(CONTEXT_WINDOW, bare) ? CONTEXT_WINDOW[bare] : undefined;
};

/** Which provider legs pull their list live vs. ship a curated static list.
 * As of 2026-08-06 only Claude is static: it has no discoverable catalog
 * endpoint (OAuth, and invariant 4 deliberately hides claude-haiku-*). Qwen
 * joined the live set once the compatible-mode path was found — the Anthropic
 * skin 404s a models route, which is why it looked static for so long. */
const LIVE_LEGS = new Set(["glm", "deepseek", "openrouter", "qwen"]);

/** Third-party ids the Qwen Token Plan also serves, but which keep routing to
 * their NATIVE backend — the bare id can't say which account pays, so moving
 * them silently would change both the bill and the context (the plan's gateway
 * injects a preamble: +6 input tokens on `glm-5.2`). Tagged rather than
 * re-homed, so the plan's true scope is visible without implying cc-proxy will
 * route there. 200-verified against the plan host 2026-08-04; re-probe before a
 * release.
 *
 * Both ids the plan resells qualify, and for the SAME reason — each keeps its
 * native route while the plan also serves it. `glm-5.2` routes to Z.ai (a
 * native plan outranks a resold one) and `deepseek-v4-pro` routes to DeepSeek
 * since issue #19 (0.6.1, native-first ranking). Excluding the DeepSeek id
 * would under-report the plan's scope on the Qwen card — exactly what the tag
 * exists to prevent. `deepseek-v4-flash-0731` is NOT here: it is plan-ONLY (no
 * native route exists), so the plan is its one true home and it renders on the
 * Qwen card bare, with nothing to cross-reference. */
const QWEN_PLAN_ALSO = new Set(["glm-5.2", "deepseek-v4-pro"]);

// The number of dots a tier fills, of 4. Hue-independent ordinal encoding — a
// tier never relies on color alone (the dot fill carries it). An unassessed row
// fills NONE: an empty scale reads as "no reading taken", which is the claim,
// whereas one filled dot would read as "measured, and weak".
const DOTS = { Flagship: 4, Strong: 3, Specialist: 2, [UNGRADED]: 0 };

/** Monospace glyph, identity colour, and the two ORTHOGONAL facts about how a
 * backend is reached. Neither is derivable from the other, and neither is a
 * capability claim (see docs/BACKLOG.md items 8 and 9):
 *
 *   `source` — distance from the weights. `native` = the model's own provider;
 *     `plan` = a contracted capacity deal reselling it (the vendor provisions
 *     the route, evidenced by ids that exist nowhere else); `reseller` = an
 *     aggregator buying at market.
 *   `billing` — `plan` (prepaid capacity, already sunk) vs `credits` (metered,
 *     real money per call).
 *
 * The pairing is deliberately NOT one-to-one, and that is the whole point:
 * DeepSeek is native-but-credits while Qwen is plan-but-plan, so DeepSeek's own
 * endpoint is the EXPENSIVE way to reach deepseek-v4-pro. Verified against each
 * provider's quota/balance endpoint 2026-08-04 (Z.ai reports level=pro;
 * DeepSeek reports a topped-up USD balance). */
const PROVIDER_META = {
	glm: { glyph: "G", color: "#c0c0c0", source: "native", billing: "plan" },
	deepseek: { glyph: "DS", color: "#4d6bfe", source: "native", billing: "credits" },
	openrouter: { glyph: "OR", color: "#c8ff00", source: "reseller", billing: "credits" },
	qwen: { glyph: "Q", color: "#653aff", source: "plan", billing: "plan" },
	claude: { glyph: "C", color: "#c96442", source: "native", billing: "plan" },
};

/** Rank a provider by route quality for display order: native → plan → credits
 * → reseller. This collapses the two axes into ONE ordering, which is legitimate
 * for sorting (a reader scans top-down) but would be wrong as a published field
 * — source and billing genuinely disagree, and flattening them is what the
 * card chips exist to prevent. Native-and-plan (GLM, Claude) outranks
 * native-and-credits (DeepSeek) because it costs nothing at the margin;
 * plan-sourced (Qwen) sits between them — prepaid, but one step from the
 * weights. Reseller is last: metered AND furthest. */
function routeRank(pid) {
	const { source = "native", billing = "credits" } = PROVIDER_META[pid] || {};
	if (source === "reseller") return 3;
	if (source === "native") return billing === "plan" ? 0 : 2;
	return 1; // plan-sourced
}

const tierDots = (tier) =>
	`<span class="tdots">${[1, 2, 3, 4]
		.map((n) => `<i${n <= DOTS[tier] ? ' class="on"' : ""}></i>`)
		.join("")}</span><span class="tname">${tier}</span>`;

/** Escape for an HTML text node / quoted attribute. Model ids come from a live
 * upstream catalog and `_errors[].message` from whatever a failing backend
 * returned — neither is ours, so neither is interpolated raw. */
const esc = (s) =>
	String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

async function fetchJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Group discovery rows into per-provider cards, ordered Flagship→ungraded within.
 * @param {ReturnType<typeof attribute>[] & any[]} rows
 * @param {Map<string, { models: any[], live: boolean }>} acc
 */
export function groupByProvider(rows) {
	/** `context_window` is OPTIONAL and absent-not-undefined, mirroring the wire
	 * contract it is carried from: a row has the key only when the API published
	 * one. @type {Map<string, { live: boolean, total?: number, isDefault?: boolean, models: Array<{ id: string, dup?: boolean, plan?: boolean, tier: string, created?: string | null, context_window?: number }> }>} */
	const acc = new Map();
	// Native ids (non-openrouter) — an OpenRouter row whose bare form is reachable
	// natively gets an "also native" tag (it's the same model, two ways).
	const nativeIds = new Set(rows.filter((r) => r.provider !== "openrouter").map((r) => r.id));
	for (const r of rows) {
		if (!acc.has(r.provider)) {
			acc.set(r.provider, { live: LIVE_LEGS.has(r.provider), models: [] });
		}
		const dup = r.provider === "openrouter" && nativeIds.has(r.id.split("/").pop());
		// A model this row routes NATIVELY but the Qwen plan also serves. Without
		// the tag the plan's real scope is invisible: `deepseek-v4-pro` and
		// `glm-5.2` render only under DeepSeek/GLM, so the Qwen card looks like 6
		// models when the entitlement is 8.
		const plan = r.provider !== "qwen" && QWEN_PLAN_ALSO.has(r.id);
		acc.get(r.provider).models.push({
			id: r.id,
			dup,
			plan,
			tier: tierFor(r.id),
			created: r.created_at || null,
			// Carried through, not re-derived downstream: this rebuild is where a
			// published `context_window` would otherwise be dropped, leaving the row
			// renderer with only the curated table — which is how all 20 OpenRouter
			// rows shipped blank. Omitted when absent, so the key stays the test.
			...("context_window" in r ? { context_window: r.context_window } : {}),
		});
	}
	// Grade first, then NEWEST within a grade, then id descending as the final
	// tie-break. Grade leads deliberately: sorting by date alone lets a fresh
	// superseded model push a Flagship off a capped card, and the reader scanning
	// for "the good one" wants capability first. Date only orders WITHIN a grade,
	// where every candidate is equally strong and recency is the useful signal.
	//
	// A missing date sorts last in its grade rather than first — most curated
	// entries carry created_at: null, and treating "unknown" as "brand new" would
	// hand them the top of every card.
	const byId = new Intl.Collator("en", { numeric: true }).compare;
	const byDate = (a, b) => {
		if (a.created === b.created) return 0;
		if (!a.created) return 1;
		if (!b.created) return -1;
		return a.created < b.created ? 1 : -1;
	};
	for (const p of acc.values()) {
		p.models.sort(
			(a, b) => tierRank(a.tier) - tierRank(b.tier) || byDate(a, b) || byId(b.id, a.id),
		);
		// Cap AFTER sorting, so what survives is the strongest-and-newest slice
		// rather than an arbitrary prefix. `total` is kept so the card can say how
		// many it is hiding — a truncated list that does not admit it is a lie.
		p.total = p.models.length;
		if (ROW_LIMIT > 0 && p.models.length > ROW_LIMIT) p.models = p.models.slice(0, ROW_LIMIT);
	}
	return acc;
}

function providerCard([pid, group]) {
	const meta = PROVIDER_META[pid] || { glyph: pid.slice(0, 2).toUpperCase(), color: "#888" };
	const name = DISPLAY[pid] || pid;
	const tag = group.live ? `<span class="tag live">live</span>` : `<span class="tag">key ✓</span>`;
	const rows = group.models
		.map((m) => {
			// The context window, when we know it — the same curated map the text
			// table renders, so the two views can't disagree about a model.
			// Object.hasOwn for the same reason as tierFor above: m.id comes from a
			// live catalog, and a bare lookup of `constructor` returns a function.
			// And the same `<provider>:` fallback tierFor uses: the map is keyed by
			// the BARE vendor id, so `qwen:glm-5.2` must fall back to `glm-5.2` or
			// the lensed row renders blank next to an identical bare row that does
			// not (measured: 3 such rows shipped in docs/models.html).
			const win = windowFor(m.id, m.context_window);
			// A zero-width break opportunity after the namespace slash, so a long
			// OpenRouter id wraps on the boundary a reader recognizes.
			const id = esc(m.id).replace("/", "/<wbr>");
			// One provenance note per row, never two: "also native" (an aggregator
			// row whose bare id is reachable direct) or "also on plan" (a native row
			// the Qwen plan resells). They cannot both apply — dup is openrouter-only
			// and plan excludes qwen.
			const note = m.dup
				? `<span class="dup">also native</span>`
				: m.plan
					? `<span class="dup">also on plan</span>`
					: "";
			return `<div class="mrow"><span class="mname">${id}</span>${note}<span class="tier">${win ? `<span class="win">${esc(win)}</span>` : ""}${tierDots(m.tier)}</span></div>`;
		})
		.join("");
	// `default` marks the backend an unrouted id falls back to — the single most
	// consequential routing fact on the page, and previously only in the footer.
	const dflt = group.isDefault ? `<span class="tag dflt">default</span>` : "";
	const src = meta.source || "native";
	const bill = meta.billing || "credits";
	// A capped card states BOTH numbers. "20 models" on a leg serving 372 would
	// be a false claim about the backend's scope, and the hidden ones are exactly
	// what a reader would go looking for.
	const total = group.total ?? group.models.length;
	const shown = group.models.length;
	const capped = total > shown;
	const count = capped ? `${shown} of ${total} models` : `${total} model${total === 1 ? "" : "s"}`;
	const more = capped
		? `<div class="more">${total - shown} more — strongest and newest shown · <code>MODELS_HTML_LIMIT=0 pnpm models:html</code> for all</div>`
		: "";
	return `<section class="card" style="--c:${meta.color}">
  <div class="prow"><span class="mono">${esc(meta.glyph)}</span><h2>${esc(name)}</h2>${dflt}${tag}</div>
  <p class="leg"><span class="axis src-${src}" data-axis="src">${src}</span><span class="axis bill-${bill}" data-axis="bill">${bill}</span>${group.live ? "live list" : "curated list"} · ${count}</p>
  <div class="models">${rows}</div>${more}
</section>`;
}

/** The routing diagram's fan-out, built from the providers actually present.
 * Every leg is a real registered backend — the SVG never draws a provider the
 * reader can't reach. Legs alternate above/below the spine, ordered outward
 * from the proxy so the labels never collide.
 * @param {string[]} ids provider ids, in registry order
 */
export function conduitSvg(ids) {
	const SPINE_Y = 74;
	const X0 = 258;
	// Spacing is set by the widest label, not by taste: legs on the SAME side of
	// the spine must not collide, and at 9.5px monospace a label is ~5.7px per
	// character. Alternating sides then interleaves at half that pitch, which is
	// what makes the fan read as a fan rather than a picket fence. An earlier
	// fixed 44px step overlapped "OpenRouter" with "Qwen".
	const widest = Math.max(...ids.map((id) => (DISPLAY[id] || id).length), 6);
	const step = Math.max(70, Math.round(widest * 5.7) + 14);
	let up = 0;
	let down = 0;
	const legs = ids.map((id, i) => {
		const meta = PROVIDER_META[id] || { color: "#888" };
		const isUp = i % 2 === 1;
		// Half-step offset on the up side so the two rows interleave.
		const x = isUp ? X0 + up++ * step + Math.round(step / 2) : X0 + down++ * step;
		const node = isUp ? SPINE_Y - 36 : SPINE_Y + 38;
		const labelY = isUp ? node - 14 : node + 20;
		return { x, node, labelY, color: meta.color, name: DISPLAY[id] || id };
	});
	const spineEnd = Math.max(X0, ...legs.map((l) => l.x));
	// Widest label overhanging the last node sets the right edge — otherwise a
	// long provider name is clipped by the viewBox.
	const overhang = Math.max(...legs.map((l) => l.x + (l.name.length * 5.7) / 2), spineEnd);
	const paths = legs
		.map(
			(l) =>
				`<path d="M${l.x} ${SPINE_Y} V${l.node + (l.node < SPINE_Y ? 8 : -8)}" stroke="#5fa8a8"/>` +
				`<circle cx="${l.x}" cy="${l.node}" r="7" fill="var(--surface-2)" stroke="${l.color}"/>`,
		)
		.join("");
	const labels = legs
		.map(
			(l) =>
				`<text x="${l.x}" y="${l.labelY}" class="clabel" fill="var(--ink-2)" text-anchor="middle">${esc(l.name)}</text>`,
		)
		.join("");
	return `<svg viewBox="0 0 ${Math.round(overhang) + 16} 200" role="img">
          <path d="M44 ${SPINE_Y} H104" stroke="#5fa8a8" stroke-width="2" stroke-linecap="round" fill="none"/>
          <circle cx="44" cy="${SPINE_Y}" r="5" fill="none" stroke="#c96442" stroke-width="1.6"/>
          <text x="44" y="32" class="cnode" fill="var(--ink-2)" text-anchor="middle">Claude Code</text>
          <text x="44" y="52" class="clabel" fill="var(--muted)" text-anchor="middle">request</text>
          <rect x="104" y="56" width="118" height="36" rx="9" fill="var(--surface-2)" stroke="#5fa8a8" stroke-width="1.5"/>
          <text x="163" y="79" class="cnode" fill="#c96442" text-anchor="middle" font-weight="650">cc<tspan fill="var(--ink)">-proxy</tspan></text>
          <path d="M222 ${SPINE_Y} H${spineEnd}" stroke="#5fa8a8" stroke-width="2" stroke-linecap="round" fill="none"/>
          <g stroke-width="1.6" stroke-linecap="round" fill="none">${paths}</g>
          ${labels}
        </svg>`;
}

// --- The self-contained template. Color + ink tokens are the dataviz surfaces;
// provider identity uses the validated categorical palette. Dark by default. ---
function renderHtml({ rows, defaultBackend, errors, providerIds }) {
	const groups = groupByProvider(rows);
	// Mark the fallback backend on its own card. resolve() sends any id no
	// predicate claims here, so it is the one card whose scope is "everything
	// else" — worth showing beside the model list, not only in the footer.
	for (const [pid, g] of groups) g.isDefault = pid === defaultBackend;
	// Cards read in ROUTE-QUALITY order — native, plan, credits, reseller — not
	// registry order. The registry is ordered for predicate precedence (OpenRouter
	// must be tried before the bare-prefix legs), which is an implementation
	// detail a reader should not have to know. This ranks what they actually care
	// about: closest to the weights and cheapest first. See routeRank.
	const cards = [...groups]
		.sort(([a], [b]) => routeRank(a) - routeRank(b))
		.map(providerCard)
		.join("\n");
	// Every number below is derived — a provider added or a leg switched from
	// curated to live updates the hero without a hand edit here.
	const providers = providerIds.length;
	const liveCount = [...groups.values()].filter((g) => g.live).length;
	const names = providerIds.map((id) => DISPLAY[id] || id);
	const lede =
		names.length > 1
			? `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`
			: names[0] || "any backend";
	const errorLines = (errors || [])
		.map((e) => `<div class="warn">${esc(e.provider)}: ${esc(e.message)}</div>`)
		.join("");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-proxy · reachable models</title>
<style>
  /* The type + page tokens live on :root, NOT on .viz. body is .viz's ANCESTOR,
     so a --sans defined only on .viz is undefined where body reads it, and an
     undefined var() falls back to the property's initial value — serif. That is
     what rendered this whole page in Times. Theme/surface tokens stay scoped to
     .viz (the component owns its palette); only what body itself consumes is
     hoisted. */
  :root { color-scheme: dark; --page:#0d0d0d;
    --mono:"SF Mono",SFMono-Regular,Menlo,Consolas,"JetBrains Mono","Roboto Mono",ui-monospace,monospace;
    --sans:system-ui,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,"Segoe UI",Inter,-apple-system,sans-serif; }
  @media (prefers-color-scheme: light) { :root:where(:not([data-theme="dark"])) { --page:#f9f9f7; } }
  :root[data-theme="dark"] { --page:#0d0d0d; }
  .viz { --surface-1:#1a1a19; --surface-2:#22221f; --page:#0d0d0d; --ink:#eef0f2;
    --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --rail:#383835;
    --hairline:rgba(255,255,255,0.10); --good:#0ca30c;
    /* Order matters, and not for taste. A family an engine cannot resolve does
       NOT fall through to the next entry in some engines — it lands on the
       generic default, which is serif. Headless Chromium resolves neither
       -apple-system nor ui-monospace nor Inter, so a stack led by any of them
       renders the whole page in Times (it did). Both stacks now open with a
       family that resolves everywhere and keep the fancier faces as upgrades. */
    --mono:"SF Mono",SFMono-Regular,Menlo,Consolas,"JetBrains Mono","Roboto Mono",ui-monospace,monospace;
    --sans:system-ui,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,"Segoe UI",Inter,-apple-system,sans-serif; }
  @media (prefers-color-scheme: light) {
    :root:where(:not([data-theme="dark"])) .viz { color-scheme:light;
      --surface-1:#fcfcfb; --surface-2:#f2f1ec; --page:#f9f9f7; --ink:#0b0b0b;
      --ink-2:#52514e; --muted:#898781; --grid:#e1e0d9; --rail:#c3c2b7;
      --hairline:rgba(11,11,11,0.10); --good:#006300; }
  }
  :root[data-theme="dark"] .viz { color-scheme:dark;
    --surface-1:#1a1a19; --surface-2:#22221f; --page:#0d0d0d; --ink:#eef0f2;
    --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --rail:#383835;
    --hairline:rgba(255,255,255,0.10); --good:#0ca30c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); font-family:var(--sans); -webkit-font-smoothing:antialiased; }
  .viz { max-width:1160px; margin:0 auto; padding:0; background:var(--page); min-height:100vh; position:relative; overflow:hidden; }
  .viz::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.5;
    background-image:radial-gradient(var(--grid) 1px, transparent 1px); background-size:26px 26px;
    -webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 45%); mask-image:linear-gradient(180deg,#000 0%,transparent 45%); }
  .wrap { position:relative; padding:40px 44px 56px; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:46px; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brandmark { width:34px; height:34px; border-radius:9px; background:var(--surface-2); border:1px solid var(--hairline); display:grid; place-items:center; }
  .brand .bname { font-family:var(--mono); font-weight:600; font-size:15px; color:#c96442; letter-spacing:-0.01em; }
  .brand .bname b { color:var(--ink); font-weight:600; }
  .brand .btag { font-family:var(--mono); font-size:10.5px; color:var(--muted); letter-spacing:.14em; text-transform:uppercase; }
  .topbar .ver { font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.08em; }
  .hero { display:grid; grid-template-columns:1.05fr 1fr; gap:40px; align-items:center; margin-bottom:44px; }
  .hero-eyebrow { font-family:var(--mono); font-size:11px; color:#5fa8a8; letter-spacing:.18em; text-transform:uppercase; margin:0 0 16px; }
  .hero h1 { font-size:clamp(34px,4.4vw,52px); line-height:1.04; font-weight:720; letter-spacing:-0.022em; color:var(--ink); margin:0 0 18px; }
  .hero h1 .rule { color:var(--ink-2); font-weight:500; }
  .hero .lede { font-size:16px; line-height:1.6; color:var(--ink-2); max-width:46ch; margin:0 0 26px; }
  .stats { display:flex; flex-wrap:wrap; gap:10px; margin:0; padding:0; list-style:none; }
  .stats li { display:flex; align-items:baseline; gap:8px; background:var(--surface-2); border:1px solid var(--hairline); border-radius:999px; padding:8px 16px; }
  .stats .n { font-family:var(--mono); font-size:20px; font-weight:650; color:var(--ink); letter-spacing:-0.02em; }
  .stats .k { font-size:12px; color:var(--ink-2); }
  .stats .dot { width:8px; height:8px; border-radius:50%; align-self:center; }
  .conduit { background:var(--surface-1); border:1px solid var(--hairline); border-radius:18px; padding:18px; }
  .conduit svg { width:100%; height:auto; display:block; }
  .conduit .cnode { font-family:var(--mono); font-size:11px; }
  .conduit .clabel { font-family:var(--mono); font-size:9.5px; letter-spacing:.04em; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; margin-top:6px; }
  .card { background:var(--surface-1); border:1px solid var(--hairline); border-radius:14px; padding:18px 20px 6px; }
  .card .prow { display:flex; align-items:center; gap:12px; margin-bottom:2px; }
  .mono { width:30px; height:30px; border-radius:8px; display:grid; place-items:center; font-family:var(--mono); font-weight:700; font-size:13px; color:var(--surface-1); background:var(--c); }
  .card h2 { font-size:17px; font-weight:650; color:var(--ink); margin:0; letter-spacing:-0.01em; }
  .card .leg { font-size:12px; color:var(--muted); margin:2px 0 0; }
  .tag { margin-left:auto; font-size:10.5px; font-weight:600; color:var(--good); border:1px solid var(--hairline); padding:2px 9px; border-radius:999px; white-space:nowrap; }
  .tag.live { color:var(--ink-2); }
  /* The default chip sits before the live/key tag and takes the accent, because
     "where do unrouted ids go" outranks "how was this list fetched".
     margin-left:auto moves to it so the pair stays right-aligned as one group. */
  .tag.dflt { margin-left:auto; color:var(--ink); border-color:var(--c); }
  .tag.dflt + .tag { margin-left:6px; }
  /* Source and billing: two independent axes, so two visually distinct marks —
     source is a filled chip (provenance), billing an outlined one (cost). A
     reader must not read one off the other; they genuinely disagree (DeepSeek
     is native+credits, Qwen is plan+plan). */
  .axis { font-family:var(--mono); font-size:9.5px; letter-spacing:.04em; text-transform:uppercase;
    padding:1.5px 6px; border-radius:4px; margin-right:6px; white-space:nowrap; }
  /* Qwen is plan on BOTH axes, so the two chips would read as one repeated
     word. Each carries its axis name as a prefix — "src·plan" / "bill·plan" —
     which also removes the need to remember chip order. */
  .axis::before { content:attr(data-axis) "·"; opacity:.5; }
  .src-native, .src-plan { background:color-mix(in srgb, var(--c) 22%, transparent); color:var(--ink); }
  .src-reseller { background:transparent; color:var(--muted); border:1px dashed var(--rail); }
  .bill-plan { border:1px solid var(--good); color:var(--good); }
  .bill-credits { border:1px solid var(--rail); color:var(--muted); }
  .models { margin-top:12px; border-top:1px solid var(--grid); }
  .mrow { display:flex; align-items:flex-start; gap:12px; padding:10px 0; border-bottom:1px solid var(--grid); }
  .mrow:last-child { border-bottom:none; }
  /* Break long ids at the namespace slash (see the wbr in providerCard), not
     mid-token — deepseek/deepseek-v4-pro must not split as "deepsee|k-v4-pro". */
  .mname { font-size:13px; line-height:1.35; color:var(--ink); font-family:var(--mono); overflow-wrap:anywhere; word-break:normal; min-width:0; }
  .dup { color:var(--muted); font-size:11px; font-style:italic; white-space:nowrap; align-self:center; margin-left:6px; }
  /* The truncation notice. Muted and un-bordered so it reads as a footnote to
     the list rather than another model row. */
  .more { margin-top:10px; color:var(--muted); font-size:11.5px; line-height:1.6; }
  .more code { font-family:var(--mono); font-size:10.5px; color:var(--ink-2); }
  .tier { display:flex; align-items:center; gap:7px; margin-left:auto; margin-top:3px; flex:0 0 auto; }
  .win { font-family:var(--mono); font-size:10.5px; color:var(--muted); width:3em; text-align:right; }
  .tdots { display:flex; gap:3px; }
  .tdots i { width:7px; height:7px; border-radius:50%; background:transparent; border:1px solid var(--muted); }
  .tdots i.on { background:var(--c); border-color:var(--c); }
  .tname { font-size:10.5px; color:var(--muted); width:4.6em; }
  .legend { display:flex; flex-wrap:wrap; gap:18px; align-items:center; margin:26px 0 20px; padding:14px 18px; background:var(--surface-1); border:1px solid var(--hairline); border-radius:12px; }
  .legend .lk { font-family:var(--mono); font-size:10.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.1em; }
  /* Two independent keys share one legend row; without a rule between them
     "reseller … BILLING plan" reads as one continuous list. */
  .lsep { width:1px; align-self:stretch; background:var(--grid); margin:0 4px; }
  .legend .tk { display:flex; align-items:center; gap:8px; color:var(--ink-2); font-size:12.5px; }
  .legend .tk .tdots i.on { background:var(--ink); border-color:var(--ink); }
  .warn { color:var(--muted); font-size:12px; padding:10px 14px; border:1px solid var(--hairline); border-radius:8px; margin:0 0 14px; }
  /* A key, not an essay: each note sits beside the mark it defines, so the
     reader matches on the glyph they're looking at instead of hunting a
     paragraph for it. Two columns wide, collapsing to one on narrow. */
  footer { margin-top:30px; padding-top:20px; border-top:1px solid var(--grid); }
  .fkey { font-family:var(--mono); font-size:10.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.14em; margin:0 0 14px; }
  /* Two columns, each row full-width within its column — an auto-fit grid left
     a ragged hole when the count was odd. Five entries: 3 + 2. */
  footer dl { display:grid; grid-template-columns:1fr 1fr; column-gap:44px; margin:0 0 20px; }
  footer dl > div { display:flex; align-items:baseline; gap:14px; padding:9px 0; border-bottom:1px solid var(--grid); }
  footer dt { flex:0 0 92px; display:flex; align-items:center; justify-content:flex-start; }
  footer dd { margin:0; font-size:12.5px; line-height:1.5; color:var(--ink-2); }
  footer dt .tag { margin-left:0; }
  footer dt .win { width:auto; text-align:left; }
  footer dt .dup { margin-left:0; }
  footer dt .tname { display:none; }
  /* --c is set per provider card; the footer sits outside one, so its sample
     dots would render unfilled. Ink is the neutral stand-in, same as .legend. */
  footer dt .tdots i.on { background:var(--ink); border-color:var(--ink); }
  @media (max-width:760px) { footer dl { grid-template-columns:1fr; } }
  .fnote { color:var(--muted); font-size:12px; line-height:1.65; max-width:78ch; margin:0; }
  footer code { font-family:var(--mono); font-size:11.5px; color:var(--ink-2); }
  @media (max-width:900px) { .hero { grid-template-columns:1fr; gap:28px; } .wrap { padding:28px 20px 40px; } }
</style>
</head>
<body>
<div class="viz">
  <div class="wrap">
    <div class="topbar">
      <div class="brand"><span class="brandmark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="3.5" cy="9" r="2.4" fill="none" stroke="#c96442" stroke-width="1.6"/><circle cx="14.5" cy="4.5" r="2.4" fill="#c96442"/><circle cx="14.5" cy="13.5" r="2.4" fill="#5fa8a8"/><path d="M5.6 9 H12 M12 5 L14 5 M12 13 L14 13" stroke="#5fa8a8" stroke-width="1.6" stroke-linecap="round"/></svg>
      </span><span><span class="bname">cc<b>-proxy</b></span><br><span class="btag">model router</span></span></div>
      <span class="ver">reachable · ${providers} providers</span>
    </div>

    <section class="hero">
      <div>
        <p class="hero-eyebrow">Claude Code · local routing layer</p>
        <h1>One proxy.<br>Every model.<span class="rule"> Routed by name.</span></h1>
        <p class="lede">cc-proxy sits in front of Claude Code and dispatches each call to the model it deserves — ${esc(lede)}, in a single session. Nothing leaves the machine but the upstream call itself. The route is <code>model name</code>.</p>
        <ul class="stats">
          <li><span class="dot" style="background:#5fa8a8"></span><span class="n">${providers}</span><span class="k">provider${providers === 1 ? "" : "s"}</span></li>
          <li><span class="n">${rows.length}</span><span class="k">models</span></li>
          <li><span class="n">${liveCount}</span><span class="k">live leg${liveCount === 1 ? "" : "s"}</span></li>
          <li><span class="dot" style="background:var(--good)"></span><span class="k">loopback&nbsp;only</span></li>
        </ul>
      </div>
      <div class="conduit" aria-label="Routing diagram: a request enters cc-proxy and is dispatched to one of the reachable providers">
        ${conduitSvg(providerIds)}
      </div>
    </section>

    <div class="legend">
      <span class="lk">Intelligence tier</span>
      ${["Flagship", "Strong", "Specialist", UNGRADED].map((t) => `<span class="tk">${tierDots(t)}</span>`).join("")}
    </div>
    <div class="legend">
      <span class="lk">Route</span>
      <span class="tk"><span class="axis src-native" data-axis="src">native</span> the model's own provider</span>
      <span class="tk"><span class="axis src-plan" data-axis="src">plan</span> contracted capacity reselling it</span>
      <span class="tk"><span class="axis src-reseller" data-axis="src">reseller</span> aggregator buying at market</span>
      <span class="lsep"></span>
      <span class="lk">Billing</span>
      <span class="tk"><span class="axis bill-plan" data-axis="bill">plan</span> prepaid, already sunk</span>
      <span class="tk"><span class="axis bill-credits" data-axis="bill">credits</span> metered per call</span>
    </div>
    ${errorLines}
    <div class="grid">
${cards}
    </div>

    <footer>
      <p class="fkey">Notation</p>
      <dl>
        <div><dt><span class="tag live">live</span></dt><dd>Model list fetched from the provider at discovery.</dd></div>
        <div><dt><span class="tag">key ✓</span></dt><dd>Static list the plugin ships; the key is present and the leg is routable.</dd></div>
        <div><dt>${tierDots("Strong")}</dt><dd>Qualitative capability tier. Ordinal, hue-independent — the fill carries it, never the color.</dd></div>
        <div><dt>${tierDots(UNGRADED)}</dt><dd>Nobody has assessed this model. An empty scale is an absence, not a low score — <code>/v1/models</code> omits <code>grade</code> for these ids rather than guessing one.</dd></div>
        <div><dt><span class="win">200K</span></dt><dd>Context window, where the vendor documents one.</dd></div>
        <div><dt><span class="dup">also native</span></dt><dd>Reachable two ways — direct, and via the OpenRouter aggregate.</dd></div>
        <div><dt><span class="dup">also on plan</span></dt><dd>The Qwen plan serves this model too. It still routes to the provider shown — the bare id can't say which account pays, and the plan's gateway injects a preamble, so the two routes are not interchangeable.</dd></div>
        <div><dt><span class="tag dflt">default</span></dt><dd>Where an id no predicate claims is sent.</dd></div>
      </dl>
      <p class="fnote"><code>claude-haiku-*</code> is omitted by design: Claude Code's internal ops pin to Claude so they never burn third-party quota. Generated from the live <code>/v1/models</code> · default backend <code>${esc(defaultBackend)}</code>.</p>
    </footer>
  </div>
</div>
</body>
</html>
`;
}

async function main() {
	let status;
	try {
		status = await fetchJson(`http://127.0.0.1:${PORT}/_status`);
	} catch (err) {
		process.stderr.write(`cc-proxy: proxy down or bad /_status on port ${PORT} (${err.message})\n`);
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
	const providers = registeredProviders(
		buildProviders(process.env, defaultBackend),
		status.providers,
	);
	const providerSet = new Set(providers.map((p) => p.id));

	// The provider comes from the PUBLISHED `provider` field, not from re-deriving
	// it through the router. Those are different questions and they disagree: the
	// API publishes `deepseek-v4-pro` (provider deepseek, its owning namespace)
	// AND `qwen:deepseek-v4-pro` (provider qwen, the plan that also serves it),
	// while attribute() resolves BOTH through rankRoutes (native provider first,
	// then cheapest tier) — pre-issue-#19 that meant the bare id landed on the
	// Qwen card next to its own alias, and DeepSeek's card lost the model it
	// owns; post-#19 attribute() would put it back on DeepSeek for this id, but
	// still diverges from `provider` for any id where ownership and the ranked
	// route disagree. attribute() is kept only as a fallback for an entry from a
	// proxy too old to publish the field.
	//
	// Unusable entries (multimodal ids wanting another request schema, `:batch`
	// variants, `~latest` aliases) are dropped: this page is a menu of what you
	// can select, and they cannot be selected.
	const rows = (models.data || [])
		.filter((m) => m.usable !== false)
		.map((m) => ({
			id: m.id,
			provider: m.provider || attribute(m.id, providers),
			created_at: m.created_at ?? null,
			// Carried, not re-derived: OMITTED for an id with no curated window, so
			// `"context_window" in entry` stays the test all the way to the page.
			...("context_window" in m ? { context_window: m.context_window } : {}),
		}))
		.filter((r) => providerSet.has(r.provider));

	process.stdout.write(
		renderHtml({
			// Registry order, restricted to providers that actually have a
			// reachable model — an empty leg gets no card, so it gets no
			// diagram spur or lede mention either.
			providerIds: providers.map((p) => p.id).filter((id) => rows.some((r) => r.provider === id)),
			rows,
			defaultBackend,
			errors: models._errors || [],
		}),
	);
}

// Only run when invoked directly, not when imported by tests.
if (isDirectRun(import.meta.url)) {
	main().catch((err) => {
		process.stderr.write(`cc-proxy: unexpected error: ${err.message}\n`);
		process.exit(1);
	});
}

// A downstream consumer closing the pipe early → EPIPE, a normal CLI interaction.
process.stdout.on("error", (err) => {
	if (err && err.code === "EPIPE") process.exit(0);
	throw err;
});
