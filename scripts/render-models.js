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
// The ONLY curated data is the intelligence tier (MODEL_TIERS): display-layer
// judgment, deliberately NOT in src/. Keys are the model ids as /v1/models
// returns them. Unknown ids fall back to "Specialist" so a future model still
// renders a tier. Pinned by test/render-models.test.js so a silent drop (the
// opus-4-8 class of bug) is caught at the test gate.
//
// CONTEXT_WINDOW used to sit beside it under the same rule; as of 0.5.1 it is
// in src/models.js and published on /v1/models, because a second consumer
// (cc-reload) needed the number. Do NOT read that reversal as precedent for
// moving MODEL_TIERS too — see CLAUDE.md backlog item 9: publishing a tier
// makes a curated opinion part of the API surface and wants evals first.

import { loadEnv } from "../src/env.js";
import { buildProviders } from "../src/providers.js";
import { CONTEXT_WINDOW, DISPLAY, attribute, registeredProviders } from "./list-models.js";

// MUST stay directly under the imports — see list-models.js / CLAUDE.md.
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
const FETCH_TIMEOUT_MS = 3000;

/** Intelligence tier per model id — display-layer judgment, curated here and
 * not in src/ (see the header note on the 0.5.1 CONTEXT_WINDOW reversal).
 * A model absent from this map renders the default "Specialist".
 * @type {Record<string, "Flagship" | "Strong" | "Specialist" | "Economy">}
 */
export const MODEL_TIERS = {
	// GLM
	"glm-5.2": "Flagship",
	"glm-5.1": "Strong",
	"glm-5": "Strong",
	"glm-5-turbo": "Specialist",
	"glm-4.7": "Economy",
	"glm-4.6": "Economy",
	"glm-4.5": "Economy",
	"glm-4.5-air": "Economy",
	// DeepSeek (native)
	"deepseek-v4-pro": "Flagship",
	"deepseek-v4-flash": "Strong",
	// OpenRouter (curated allowlist)
	"deepseek/deepseek-v4-pro": "Flagship",
	"deepseek/deepseek-v4-flash": "Strong",
	"tencent/hy3": "Specialist",
	"moonshotai/kimi-k2.7-code": "Specialist",
	"moonshotai/kimi-k3": "Specialist",
	"qwen/qwen3.7-max": "Strong",
	// Qwen (curated, DashScope)
	"qwen3.8-max": "Strong",
	"qwen3.8-max-preview": "Strong",
	"qwen3.7-max": "Strong",
	"qwen3.7-plus": "Specialist",
	"qwen3.6-flash": "Economy",
	// Plan-served DeepSeek build — graded as its bare sibling deepseek-v4-flash,
	// which it is a dated snapshot of. Capability, not cost: reaching it through
	// the plan is cheaper, but the tier grades the model (CLAUDE.md item 8/9).
	"deepseek-v4-flash-0731": "Strong",
	// Claude (curated, OAuth)
	"claude-fable-5": "Flagship",
	"claude-opus-5": "Flagship",
	"claude-sonnet-5": "Strong",
};

const DEFAULT_TIER = "Specialist";

/** The rank of a tier, for ordering rows Flagship → Economy. Unknown ranks below Economy. */
const TIER_ORDER = { Flagship: 0, Strong: 1, Specialist: 2, Economy: 3 };
const tierRank = (t) => TIER_ORDER[t] ?? 99;
const tierFor = (id) => MODEL_TIERS[id] ?? DEFAULT_TIER;

/** Which provider legs pull their list live vs. ship a curated static list. */
const LIVE_LEGS = new Set(["glm", "deepseek"]);

/** Third-party ids the Qwen Token Plan also serves, but which keep routing to
 * their NATIVE backend — the bare id can't say which account pays, so moving
 * them silently would change both the bill and the context (the plan's gateway
 * injects a preamble: +79 input tokens on `deepseek-v4-pro`). They are tagged
 * rather than re-homed, so the plan's true scope is visible without implying
 * cc-proxy will route there. All 200-verified against the plan host 2026-08-04;
 * re-probe before a release. `deepseek-v4-flash-0731` is absent here because it
 * is plan-ONLY and already routes to qwen (see providers.js DATED_ID). */
const QWEN_PLAN_ALSO = new Set(["deepseek-v4-pro", "glm-5.2"]);

// The number of dots a tier fills, of 4. Hue-independent ordinal encoding — a
// tier never relies on color alone (the dot fill carries it).
const DOTS = { Flagship: 4, Strong: 3, Specialist: 2, Economy: 1 };

/** Monospace glyph, identity colour, and the two ORTHOGONAL facts about how a
 * backend is reached. Neither is derivable from the other, and neither is a
 * capability claim (see CLAUDE.md backlog items 8 and 9):
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
	glm: { glyph: "G", color: "#eb6834", source: "native", billing: "plan" },
	deepseek: { glyph: "DS", color: "#1baf7a", source: "native", billing: "credits" },
	openrouter: { glyph: "OR", color: "#eda100", source: "reseller", billing: "credits" },
	qwen: { glyph: "Q", color: "#e87ba4", source: "plan", billing: "plan" },
	claude: { glyph: "C", color: "#2a78d6", source: "native", billing: "plan" },
};

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

/** Group discovery rows into per-provider cards, ordered Flagship→Economy within.
 * @param {ReturnType<typeof attribute>[] & any[]} rows
 * @param {Map<string, { models: any[], live: boolean }>} acc
 */
export function groupByProvider(rows) {
	/** @type {Map<string, { live: boolean, models: Array<{ id: string, dup?: boolean, plan?: boolean, tier: string }> }>} */
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
		acc.get(r.provider).models.push({ id: r.id, dup, plan, tier: tierFor(r.id) });
	}
	// Tier first, then id DESCENDING within a tier — newer/higher version numbers
	// on top, which is the order a reader scanning for "the good one" expects.
	// A plain localeCompare would put glm-5 above glm-5.1; numeric collation
	// orders the version segments as numbers.
	const byId = new Intl.Collator("en", { numeric: true }).compare;
	for (const p of acc.values()) {
		p.models.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || byId(b.id, a.id));
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
			const win = CONTEXT_WINDOW[m.id];
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
	return `<section class="card" style="--c:${meta.color}">
  <div class="prow"><span class="mono">${esc(meta.glyph)}</span><h2>${esc(name)}</h2>${dflt}${tag}</div>
  <p class="leg"><span class="axis src-${src}" data-axis="src">${src}</span><span class="axis bill-${bill}" data-axis="bill">${bill}</span>${group.live ? "live list" : "curated list"} · ${group.models.length} model${group.models.length === 1 ? "" : "s"}</p>
  <div class="models">${rows}</div>
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
				`<path d="M${l.x} ${SPINE_Y} V${l.node + (l.node < SPINE_Y ? 8 : -8)}" stroke="var(--rail)"/>` +
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
          <path d="M44 ${SPINE_Y} H104" stroke="var(--rail)" stroke-width="2" stroke-linecap="round" fill="none"/>
          <circle cx="44" cy="${SPINE_Y}" r="5" fill="none" stroke="var(--ink-2)" stroke-width="1.6"/>
          <text x="44" y="32" class="cnode" fill="var(--ink-2)" text-anchor="middle">Claude Code</text>
          <text x="44" y="52" class="clabel" fill="var(--muted)" text-anchor="middle">request</text>
          <rect x="104" y="56" width="118" height="36" rx="9" fill="var(--surface-2)" stroke="#3987e5" stroke-width="1.5"/>
          <text x="163" y="79" class="cnode" fill="var(--ink)" text-anchor="middle" font-weight="650">cc-proxy</text>
          <path d="M222 ${SPINE_Y} H${spineEnd}" stroke="var(--rail)" stroke-width="2" stroke-linecap="round" fill="none"/>
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
	const cards = [...groups].map(providerCard).join("\n");
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
  .brand .bname { font-family:var(--mono); font-weight:600; font-size:15px; color:var(--ink); letter-spacing:-0.01em; }
  .brand .bname b { color:#3987e5; font-weight:600; }
  .brand .btag { font-family:var(--mono); font-size:10.5px; color:var(--muted); letter-spacing:.14em; text-transform:uppercase; }
  .topbar .ver { font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.08em; }
  .hero { display:grid; grid-template-columns:1.05fr 1fr; gap:40px; align-items:center; margin-bottom:44px; }
  .hero-eyebrow { font-family:var(--mono); font-size:11px; color:#3987e5; letter-spacing:.18em; text-transform:uppercase; margin:0 0 16px; }
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
        <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="3.5" cy="9" r="2.4" fill="none" stroke="var(--rail)" stroke-width="1.6"/><circle cx="14.5" cy="4.5" r="2.4" fill="#eb6834"/><circle cx="14.5" cy="13.5" r="2.4" fill="#3987e5"/><path d="M5.6 9 H12 M12 5 L14 5 M12 13 L14 13" stroke="var(--rail)" stroke-width="1.6" stroke-linecap="round"/></svg>
      </span><span><span class="bname">cc<b>-proxy</b></span><br><span class="btag">model router</span></span></div>
      <span class="ver">reachable · ${providers} providers</span>
    </div>

    <section class="hero">
      <div>
        <p class="hero-eyebrow">Claude Code · local routing layer</p>
        <h1>One proxy.<br>Every model.<span class="rule"> Routed by name.</span></h1>
        <p class="lede">cc-proxy sits in front of Claude Code and dispatches each call to the model it deserves — ${esc(lede)}, in a single session. Nothing leaves the machine but the upstream call itself. The route is <code>model name</code>.</p>
        <ul class="stats">
          <li><span class="dot" style="background:#3987e5"></span><span class="n">${providers}</span><span class="k">provider${providers === 1 ? "" : "s"}</span></li>
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
      ${["Flagship", "Strong", "Specialist", "Economy"].map((t) => `<span class="tk">${tierDots(t)}</span>`).join("")}
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

	const rows = (models.data || [])
		.filter((m) => providerSet.has(attribute(m.id, providers)))
		.map((m) => ({ id: m.id, provider: attribute(m.id, providers) }));

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
if (import.meta.url === `file://${process.argv[1]}`) {
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
