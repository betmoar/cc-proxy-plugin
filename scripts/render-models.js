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
// The ONLY curated data is the intelligence tier (MODEL_TIERS) — like
// CONTEXT_WINDOW, it is the display layer's judgment, deliberately NOT in
// src/. Keys are the model ids as /v1/models returns them. Unknown ids fall back
// to "Specialist" so a future model still renders a tier. Pinned by
// test/render-models.test.js so a silent drop (the opus-4-8 class of bug) is
// caught at the test gate.

import { loadEnv } from "../src/env.js";
import { buildProviders } from "../src/providers.js";
import { CONTEXT_WINDOW, DISPLAY, attribute, registeredProviders } from "./list-models.js";

// MUST stay directly under the imports — see list-models.js / CLAUDE.md.
loadEnv();

const PORT = Number(process.env.PROXY_PORT || 4000);
const FETCH_TIMEOUT_MS = 3000;

/** Intelligence tier per model id — the display layer's judgment, curated like
 * CONTEXT_WINDOW. A model absent from this map renders the default "Specialist".
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

// The number of dots a tier fills, of 4. Hue-independent ordinal encoding — a
// tier never relies on color alone (the dot fill carries it).
const DOTS = { Flagship: 4, Strong: 3, Specialist: 2, Economy: 1 };

/** Monospace display name + dot glyph per provider (identity color slot). */
const PROVIDER_META = {
	glm: { glyph: "G", color: "#eb6834" },
	deepseek: { glyph: "DS", color: "#1baf7a" },
	openrouter: { glyph: "OR", color: "#eda100" },
	qwen: { glyph: "Q", color: "#e87ba4" },
	claude: { glyph: "C", color: "#2a78d6" },
};

const tierDots = (tier) =>
	`<span class="tdots">${[1, 2, 3, 4]
		.map((n) => `<i${n <= DOTS[tier] ? ' class="on"' : ""}></i>`)
		.join("")}</span><span class="tname">${tier}</span>`;

async function fetchJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Group discovery rows into per-provider cards, ordered Flagship→Economy within.
 * @param {ReturnType<typeof attribute>[] & any[]} rows
 * @param {Map<string, { models: any[], live: boolean }>} acc
 */
function groupByProvider(rows) {
	/** @type {Map<string, { live: boolean, models: Array<{ id: string, dup?: boolean, tier: string }> }>} */
	const acc = new Map();
	// Native ids (non-openrouter) — an OpenRouter row whose bare form is reachable
	// natively gets an "also native" tag (it's the same model, two ways).
	const nativeIds = new Set(rows.filter((r) => r.provider !== "openrouter").map((r) => r.id));
	for (const r of rows) {
		if (!acc.has(r.provider)) {
			acc.set(r.provider, { live: LIVE_LEGS.has(r.provider), models: [] });
		}
		const dup = r.provider === "openrouter" && nativeIds.has(r.id.split("/").pop());
		acc.get(r.provider).models.push({ id: r.id, dup, tier: tierFor(r.id) });
	}
	for (const p of acc.values()) p.models.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
	return acc;
}

function providerCard([pid, group]) {
	const meta = PROVIDER_META[pid] || { glyph: pid.slice(0, 2).toUpperCase(), color: "#888" };
	const name = DISPLAY[pid] || pid;
	const tag = group.live ? `<span class="tag live">live</span>` : `<span class="tag">key ✓</span>`;
	const rows = group.models
		.map(
			(m) =>
				`<div class="mrow"><span class="mname">${m.id}</span>${
					m.dup ? `<span class="dup">also native</span>` : ""
				}<span class="tier">${tierDots(m.tier)}</span></div>`,
		)
		.join("");
	return `<section class="card" style="--c:${meta.color}">
  <div class="prow"><span class="mono">${meta.glyph}</span><h2>${name}</h2>${tag}</div>
  <p class="leg">${group.live ? "native · live model list" : "curated list"} · ${group.models.length} model${group.models.length === 1 ? "" : "s"}</p>
  <div class="models">${rows}</div>
</section>`;
}

// --- The self-contained template. Color + ink tokens are the dataviz surfaces;
// provider identity uses the validated categorical palette. Dark by default. ---
function renderHtml({ providers, rows, defaultBackend, errors }) {
	const cards = [...groupByProvider(rows)].map(providerCard).join("\n");
	const errorLines = (errors || [])
		.map((e) => `<div class="warn">${e.provider}: ${e.message}</div>`)
		.join("");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-proxy · reachable models</title>
<style>
  :root { color-scheme: dark; }
  .viz { --surface-1:#1a1a19; --surface-2:#22221f; --page:#0d0d0d; --ink:#eef0f2;
    --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --rail:#383835;
    --hairline:rgba(255,255,255,0.10); --good:#0ca30c;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
    --sans:-apple-system,system-ui,"Segoe UI",sans-serif; }
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
  .models { margin-top:12px; border-top:1px solid var(--grid); }
  .mrow { display:flex; align-items:flex-start; gap:12px; padding:10px 0; border-bottom:1px solid var(--grid); }
  .mrow:last-child { border-bottom:none; }
  .mname { font-size:13px; line-height:1.35; color:var(--ink); font-family:var(--mono); word-break:break-word; min-width:0; }
  .dup { color:var(--muted); font-size:11px; font-style:italic; white-space:nowrap; align-self:center; margin-left:6px; }
  .tier { display:flex; align-items:center; gap:7px; margin-left:auto; margin-top:3px; flex:0 0 auto; }
  .tdots { display:flex; gap:3px; }
  .tdots i { width:7px; height:7px; border-radius:50%; background:transparent; border:1px solid var(--muted); }
  .tdots i.on { background:var(--c); border-color:var(--c); }
  .tname { font-size:10.5px; color:var(--muted); width:4.6em; }
  .legend { display:flex; flex-wrap:wrap; gap:18px; align-items:center; margin:26px 0 20px; padding:14px 18px; background:var(--surface-1); border:1px solid var(--hairline); border-radius:12px; }
  .legend .lk { font-family:var(--mono); font-size:10.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.1em; }
  .legend .tk { display:flex; align-items:center; gap:8px; color:var(--ink-2); font-size:12.5px; }
  .legend .tk .tdots i.on { background:var(--ink); border-color:var(--ink); }
  .warn { color:var(--muted); font-size:12px; padding:10px 14px; border:1px solid var(--hairline); border-radius:8px; margin:0 0 14px; }
  footer { margin-top:8px; padding-top:16px; border-top:1px solid var(--grid); color:var(--muted); font-size:12px; line-height:1.65; max-width:80ch; }
  footer b { color:var(--ink-2); font-weight:600; }
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
        <p class="lede">cc-proxy sits in front of Claude Code and dispatches each call to the model it deserves — GLM, DeepSeek, OpenRouter, Qwen, or Claude, in a single session. Your keys stay local. The route is <code>model name</code>.</p>
        <ul class="stats">
          <li><span class="dot" style="background:#3987e5"></span><span class="n">${providers}</span><span class="k">providers</span></li>
          <li><span class="n">${rows.length}</span><span class="k">models</span></li>
          <li><span class="n">2</span><span class="k">live legs</span></li>
          <li><span class="n">0</span><span class="k">keys on disk</span></li>
        </ul>
      </div>
      <div class="conduit" aria-label="Routing diagram: a request enters cc-proxy and is dispatched to one of the reachable providers">
        <svg viewBox="0 0 460 200" role="img">
          <path d="M44 74 H104" stroke="var(--rail)" stroke-width="2" stroke-linecap="round" fill="none"/>
          <circle cx="44" cy="74" r="5" fill="none" stroke="var(--ink-2)" stroke-width="1.6"/>
          <text x="44" y="32" class="cnode" fill="var(--ink-2)" text-anchor="middle">Claude Code</text>
          <text x="44" y="52" class="clabel" fill="var(--muted)" text-anchor="middle">request</text>
          <rect x="104" y="56" width="118" height="36" rx="9" fill="var(--surface-2)" stroke="#3987e5" stroke-width="1.5"/>
          <text x="163" y="79" class="cnode" fill="var(--ink)" text-anchor="middle" font-weight="650">cc-proxy</text>
          <path d="M222 74 H346" stroke="var(--rail)" stroke-width="2" stroke-linecap="round" fill="none"/>
          <g stroke-width="1.6" stroke-linecap="round" fill="none">
            <path d="M258 74 V120" stroke="var(--rail)"/><circle cx="258" cy="128" r="7" fill="var(--surface-2)" stroke="#eb6834"/>
            <path d="M302 74 V104" stroke="var(--rail)"/><circle cx="302" cy="112" r="7" fill="var(--surface-2)" stroke="#1baf7a"/>
            <path d="M346 74 V90" stroke="var(--rail)"/><circle cx="346" cy="98" r="7" fill="var(--surface-2)" stroke="#eda100"/>
            <path d="M258 74 V46" stroke="var(--rail)"/><circle cx="258" cy="38" r="7" fill="var(--surface-2)" stroke="#e87ba4"/>
            <path d="M302 74 V42" stroke="var(--rail)"/><circle cx="302" cy="34" r="7" fill="var(--surface-2)" stroke="#3987e5"/>
          </g>
          <text x="258" y="158" class="clabel" fill="var(--ink-2)" text-anchor="middle">GLM</text>
          <text x="302" y="140" class="clabel" fill="var(--ink-2)" text-anchor="middle">DS</text>
          <text x="346" y="124" class="clabel" fill="var(--ink-2)" text-anchor="middle">OR</text>
          <text x="258" y="20" class="clabel" fill="var(--ink-2)" text-anchor="middle">Qwen</text>
          <text x="302" y="16" class="clabel" fill="var(--ink-2)" text-anchor="middle">Claude</text>
          <g class="pulse"><circle cx="302" cy="52" r="5" fill="#3987e5"/><circle cx="302" cy="52" r="10" fill="#3987e5" opacity=".18"/></g>
        </svg>
      </div>
    </section>

    <div class="legend">
      <span class="lk">Intelligence tier</span>
      ${["Flagship", "Strong", "Specialist", "Economy"].map((t) => `<span class="tk">${tierDots(t)}</span>`).join("")}
    </div>
    ${errorLines}
    <div class="grid">
${cards}
    </div>

    <footer>
      <b>How to read this.</b> A request enters from Claude Code and cc-proxy dispatches it to the model the request names — one proxy, multiple backends. <b>Live</b> legs fetch their model list at discovery; <b>curated</b> legs are static lists the plugin ships. Tiers are a qualitative capability ranking, deliberately hue-independent. A model tagged <i>also native</i> is reachable two ways — direct and via the OpenRouter aggregate. <code>claude-haiku-*</code> is intentionally omitted: internal Claude Code ops pin to Claude and never burn third-party quota. Generated from the live <code>/v1/models</code> (default backend: ${defaultBackend}).
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
			providers: providerSet.size,
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
