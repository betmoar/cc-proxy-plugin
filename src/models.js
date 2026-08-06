// @ts-check

import { providerById } from "./providers.js";
import { rankRoutes, tierOf } from "./routes.js";

/**
 * @typedef {{ type: "model", id: string, display_name: string, created_at: string | null, context_window?: number, provider?: string, tier?: number, grade?: string }} ModelEntry
 */

/**
 * CAPABILITY grade per model id — how strong the model is. Promoted here from
 * `scripts/render-models.js` (2026-08-06) for the same reason CONTEXT_WINDOW
 * was: a second consumer needed it programmatically. cc-operator dispatches
 * work by model strength and was otherwise left guessing whenever an id it had
 * never seen appeared in the catalog.
 *
 * DELIBERATELY A DIFFERENT AXIS FROM `tier`. `tier` is what a route COSTS
 * (1 oauth-plan … 4 reseller); `grade` is what the model can DO. They are not
 * correlated and must never be read off one another: `deepseek/deepseek-v4-pro`
 * is tier 4 (expensive, resold) and Flagship (same weights as native), while a
 * cheap fast model can be tier 2 and Economy. Publishing them as one field
 * would make one of those a lie.
 *
 * Grade attaches to the MODEL; tier attaches to the (id, backend) pair. That is
 * why the dated plan build below grades as its bare sibling.
 *
 * Consumers own their own role mapping (JUDGMENT/IMPLEMENT/MECHANICAL/RECON is
 * cc-operator's vocabulary, not ours) — this repo publishes capability, never
 * roles, or it starts encoding another tool's policy. Note also that a bound id
 * need not appear in discovery at all: `claude-haiku-*` is pinned by invariant
 * 4 and deliberately unlisted, so a lookup must tolerate a miss.
 *
 * @type {Record<string, "Flagship" | "Strong" | "Specialist" | "Economy">}
 */
export const MODEL_GRADES = {
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
	// the plan is cheaper, but that is the tier's business, not the grade's.
	"deepseek-v4-flash-0731": "Strong",
	// Claude (curated, OAuth)
	"claude-fable-5": "Flagship",
	"claude-opus-5": "Flagship",
	"claude-sonnet-5": "Strong",
};

/** Grade of a model id; unknown ids are Specialist (a shape, not a rung). */
export const DEFAULT_GRADE = "Specialist";

/**
 * @param {string} id
 * @returns {string}
 */
export function gradeOf(id) {
	return Object.hasOwn(MODEL_GRADES, id) ? MODEL_GRADES[id] : DEFAULT_GRADE;
}

/**
 * Curated context windows (integer token counts), keyed by the bare discovery
 * id. This is the SOURCE OF TRUTH for `context_window` on the wire — promoted
 * here from scripts/list-models.js (2026-08-04) because a second consumer
 * (the cc-reload plugin, which budgets a session against a model's context
 * window) needed it programmatically. Duplicating a curated id->window table
 * in every consumer is the failure mode this promotion exists to kill: before
 * this, cc-reload hard-coded its own model-id table and cc-proxy's table
 * (below) could silently drift from it. See CHANGELOG "Changed" for the
 * reversal record — the original `scripts/list-models.js` header explicitly
 * called this a display-layer-only decision; that decision is reversed here.
 *
 * On the wire this is an INTEGER token count (128000, not "128K"). The human
 * string ("128K"/"1M") stays a rendering concern — scripts/list-models.js
 * derives it from this table via formatContextWindow() so the two can never
 * drift again.
 *
 * ids with NO entry here (OpenRouter-prefixed ids: deepseek/*, qwen/*,
 * moonshotai/*, tencent/*, and the claude-* ids) OMIT `context_window`
 * entirely on discovery entries — never `null`. A consumer distinguishes
 * "unknown" from "known" with `"context_window" in entry`, not a null check.
 * Do not invent a window for an id absent here.
 *
 * Keyed on the EXACT id, deliberately — `deepseek/deepseek-v4-pro` does not
 * inherit the 1M curated for its bare `deepseek-v4-pro`. An aggregator is a
 * different deployment of the same weights and may serve a truncated window
 * or a different default; asserting the native number for a route we have not
 * measured would publish a confident guess, and the whole point of this field
 * is that a consumer can trust what is present. Omission is the honest
 * answer until someone verifies the aggregator's window per id. (Absent, of
 * course, means the consumer needs its own fallback — that cost is accepted.)
 *
 * Sources (2026-08-04), re-verify before each release touching the model:
 *   GLM:      docs.z.ai/guides/llm/glm-*.md  (4.5=128K; 4.6/4.7/5/5-Turbo/5.1=200K; 5.2=1M)
 *   DeepSeek: api-docs.deepseek.com/quick_start/pricing (1M)
 *   Qwen:     Alibaba Model Studio (1M, incl. 3.8-max-preview)
 * GLM/DeepSeek are pinned to the docs verbatim; the Qwen numbers come from a
 * vendor summary (all Qwen 3.x models share a 1M window) — re-verify any of
 * these before a release touching the model, exactly like DEEPSEEK_PRICING.
 */
export const CONTEXT_WINDOW = {
	// GLM (docs.z.ai/guides/llm/glm-*)
	"glm-4.5": 128000,
	"glm-4.5-air": 128000,
	"glm-4.6": 200000,
	"glm-4.7": 200000,
	"glm-5": 200000,
	"glm-5-turbo": 200000,
	"glm-5.1": 200000,
	"glm-5.2": 1000000,
	// DeepSeek (api-docs.deepseek.com/quick_start/pricing)
	"deepseek-v4-pro": 1000000,
	"deepseek-v4-flash": 1000000,
	// Qwen (Alibaba Cloud Model Studio)
	"qwen3.8-max": 1000000,
	"qwen3.8-max-preview": 1000000,
	"qwen3.7-max": 1000000,
	"qwen3.7-plus": 1000000,
	"qwen3.6-flash": 1000000,
	// Plan-served DeepSeek build; same 1M window as the bare deepseek-v4-* it is
	// a dated snapshot of (api-docs.deepseek.com/quick_start/pricing).
	"deepseek-v4-flash-0731": 1000000,
};

/**
 * Attach `context_window` to a discovery entry when the id has a curated
 * window (CONTEXT_WINDOW); otherwise return the entry unchanged (field
 * omitted, never emitted as null). Applied uniformly in collectModels() so
 * live-fetched (GLM/DeepSeek) and static (Claude/Qwen/OpenRouter) entries
 * alike get the field without hand-editing every curated list literal.
 * @param {ModelEntry} entry
 * @returns {ModelEntry}
 */
export function withContextWindow(entry) {
	// Object.hasOwn, NOT `CONTEXT_WINDOW[id] !== undefined`: the table is an
	// object literal, so a plain lookup walks Object.prototype. A vendor id of
	// `__proto__`/`constructor`/`toString` would then resolve to an inherited
	// member and ship `"context_window": {}` (or a function, which
	// JSON.stringify silently drops — leaving the key absent on the wire but
	// present in the object collectModels() returns in-process). Ids come from
	// live GLM/DeepSeek catalogs and coerceEntry only checks `!e.id`, so the
	// key space is the vendor's, not ours.
	if (!Object.hasOwn(CONTEXT_WINDOW, entry.id)) return entry;
	return { ...entry, context_window: CONTEXT_WINDOW[entry.id] };
}

/** Reachable Claude ids advertised on discovery. Not public-API-stable — re-confirm
 * before each release touching Claude compat. claude-haiku-* omitted (internal ops
 * pin); claude-mythos-5 omitted (Project Glasswing-gated — unreachable by default). */
export const DEFAULT_CLAUDE_MODELS = [
	{ type: "model", id: "claude-fable-5", display_name: "Claude Fable 5", created_at: null },
	{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: null },
	{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: null },
];

/** Qwen (QwenCloud Token Plan) ids as Anthropic-skin compatible. Static — Qwen
 * exposes no /v1/models route (the docs say to ignore it; it 404s), so these are
 * curated like the Claude list. ids are bare (`qwen3.7-max`), matching the `qwen`
 * prefix the provider's match() keys on.
 *
 * `qwen3.8-max-preview` is Token-Plan-exclusive and the cheapest way to reach the
 * 3.8 tier: `qwen3.8-max` is 50% off 22:00–08:00 UTC+8, and the preview stacks a
 * promotional rate on top of that night discount.
 *
 * Curated EMPIRICALLY, not from the docs: all five returned HTTP 200 against the
 * Token Plan host on 2026-08-04. QwenCloud's published model table is aspirational
 * for a Token Plan key — `qwen3.7-flash` and `qwen3-coder-next` are listed there but
 * 400 (InvalidParameter), and `qwen3.6-plus` 403s (AccessDenied, "not eligible").
 * Conversely `qwen3.7-plus` is live but absent from that table. Re-verify by calling
 * the endpoint, not by reading the docs, before each release touching Qwen compat.
 *
 * The five `qwen*` ids match the account's own plan page exactly (confirmed
 * 2026-08-04), so that curation is right. `deepseek-v4-flash-0731` is here
 * because the plan SERVES it while both vendor tables omit it: it is absent
 * from the plan page AND unknown to DeepSeek native (400). It routes to qwen
 * via the DATED_ID rule in providers.js — a dated build is a plan-only
 * spelling. Bare `deepseek-v4-pro` and `glm-5.2` are also plan-served but are
 * deliberately NOT listed here: they are advertised by their native providers,
 * and listing them under Qwen would put the same id in the catalog twice with
 * no way to say which one a caller means (backlog item 8). */
export const DEFAULT_QWEN_MODELS = [
	{ type: "model", id: "qwen3.8-max", display_name: "Qwen3.8 Max", created_at: null },
	{
		type: "model",
		id: "qwen3.8-max-preview",
		display_name: "Qwen3.8 Max Preview",
		created_at: null,
	},
	{ type: "model", id: "qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
	{ type: "model", id: "qwen3.7-plus", display_name: "Qwen3.7 Plus", created_at: null },
	{ type: "model", id: "qwen3.6-flash", display_name: "Qwen3.6 Flash", created_at: null },
	// Plan-only DeepSeek build (see the note above). Named for its origin vendor
	// so the id stays copy-pasteable into /model, which is what a caller types.
	{
		type: "model",
		id: "deepseek-v4-flash-0731",
		display_name: "DeepSeek V4 Flash (0731, Qwen plan)",
		created_at: null,
	},
	// NOT listed here: `deepseek-v4-pro`, which the plan also resells and wins on
	// cost. It is a DeepSeek id — this list is what Qwen ADVERTISES, and adding a
	// foreign vendor's model to it would restate a fact `src/routes.js` already
	// owns. collectModels() derives the winner from ROUTES instead, so a table
	// edit alone moves the id and there is nothing to keep in step by hand.
];

/** OpenRouter ids as Anthropic-skin compatible (HTTP 200 + message shape at POST
 * /v1/messages). All but kimi-k3 were live-verified 2026-07-14; kimi-k3 is advertised on
 * OpenRouter but not yet live-verified against the skin — added for discovery, verify on
 * next release. x-ai/grok-4.5 excluded: region-blocked, not incompatible. */
export const DEFAULT_OPENROUTER_MODELS = [
	{
		type: "model",
		id: "deepseek/deepseek-v4-pro",
		display_name: "DeepSeek V4 Pro",
		created_at: null,
	},
	{
		type: "model",
		id: "deepseek/deepseek-v4-flash",
		display_name: "DeepSeek V4 Flash",
		created_at: null,
	},
	{ type: "model", id: "tencent/hy3", display_name: "Tencent Hy3", created_at: null },
	{
		type: "model",
		id: "moonshotai/kimi-k2.7-code",
		display_name: "Kimi K2.7 Code",
		created_at: null,
	},
	{ type: "model", id: "moonshotai/kimi-k3", display_name: "Kimi K3", created_at: null },
	{ type: "model", id: "qwen/qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
];

/**
 * Parse OPENROUTER_MODELS: comma-separated ids, trimmed, empties dropped. Each id's
 * display_name is the id verbatim (env-supplied ids carry no curated name).
 * @param {string | undefined} str
 * @returns {ModelEntry[]}
 */
export function parseOpenRouterModels(str) {
	if (!str) return [];
	return str
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((id) => ({ type: "model", id, display_name: id, created_at: null }));
}

/**
 * Coerce an upstream created value to the Anthropic schema (ISO string or null).
 * A numeric (OpenAI-style Unix) timestamp is dropped to null rather than emitted
 * as a non-ISO value.
 * @param {unknown} v
 * @returns {string | null}
 */
export function coerceCreated(v) {
	return typeof v === "string" ? v : null;
}

/**
 * Coerce one upstream GLM entry to a ModelEntry, or null if it has no usable id.
 * @param {any} e
 * @returns {ModelEntry | null}
 */
function coerceEntry(e) {
	if (!e || !e.id) return null;
	return {
		type: e.type || "model",
		id: e.id,
		display_name: e.display_name || e.id,
		created_at: coerceCreated(e.created_at ?? e.created),
	};
}

/**
 * Fetch GLM's live model list. Resolves to { entries } on success or { error }
 * (a pinned message string) on any failure. Never throws.
 * @param {import("./providers.js").Provider} glm
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchGlmModels(glm, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${glm.baseUrl}/v1/models`, {
			headers: { "x-api-key": glm.apiKey, "anthropic-version": "2023-06-01" },
			signal: controller.signal,
		});
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch {
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		return { entries: body.data.map(coerceEntry).filter(Boolean) };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		// Log the real cause — see fetchDeepSeekModels for why the proxy log must
		// carry err.message even though the API response stays a pinned string.
		console.error(`[models] glm fetch failed: ${err?.message || err}`);
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * DeepSeek exposes no pricing API (the /pricing page is HTML-only), so per-1M-token
 * prices are curated here against the documented table and updated per release.
 * The models themselves stay live-fetched (fetchDeepSeekModels); this is the only
 * static data. Note: DeepSeek has ANNOUNCED (not yet live as of 2026-08-04) a 2×
 * peak-hour surcharge (9–12, 14–18 UTC+8) — not modeled here, and re-check before
 * it activates (the proxy has no clock and shouldn't model time-varying price).
 * @type {Record<string, { in: number, out: number, cached: number }>}
 */
export const DEEPSEEK_PRICING = {
	"deepseek-v4-pro": { in: 0.435, out: 0.87, cached: 0.003625 },
	"deepseek-v4-flash": { in: 0.14, out: 0.28, cached: 0.0028 },
};

/**
 * Fetch DeepSeek's live model list. Unlike the Messages skin (x-api-key at /anthropic),
 * the model-list endpoint is OpenAI-native: GET /models with Bearer auth, shape
 * { object:"list", data:[{id,object,owned_by}] }. Resolves to { entries } on success or
 * { error } on any failure. Never throws.
 * @param {import("./providers.js").Provider} deepseek
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchDeepSeekModels(deepseek, timeoutMs) {
	// /models is OpenAI-native — it sits on the api.deepseek.com root, not the /anthropic
	// base the forwarding path uses. Derive the root from the provider's skin baseUrl.
	const root = deepseek.baseUrl.replace(/\/anthropic$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${root}/models`, {
			headers: { Authorization: `Bearer ${deepseek.apiKey}` },
			signal: controller.signal,
		});
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch {
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		return { entries: body.data.map(coerceEntry).filter(Boolean) };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		// Log the real cause — the API response keeps a pinned string, but the
		// proxy log must say WHY (DNS/TLS/refused vs a code bug), or "glm missing
		// from /v1/models" becomes undebuggable. Never the stack (keys aren't in it,
		// but the URL/headers might be).
		console.error(`[models] deepseek fetch failed: ${err?.message || err}`);
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Assemble the merged discovery list. Best-effort: a failed live leg contributes
 * an _errors entry, never rejects (except the modelsForceThrow test seam).
 * @param {import("./config.js").Config & { claudeModels: ModelEntry[], openRouterModels: ModelEntry[], modelsTimeoutMs: number, modelsForceThrow?: boolean }} config
 * @returns {Promise<{ data: ModelEntry[], _errors: Array<{ provider: string, message: string }> }>}
 */
export async function collectModels(config) {
	if (config.modelsForceThrow) throw new Error("forced throw (test seam)");

	const glm = providerById(config, "glm");
	const deepseek = providerById(config, "deepseek");
	const openrouter = providerById(config, "openrouter");
	const qwen = providerById(config, "qwen");

	// Assemble leg thunks in registry order: glm, deepseek, openrouter, qwen, claude.
	/** @type {Array<() => Promise<{ provider: string, entries?: ModelEntry[], error?: string }>>} */
	const legs = [];
	if (glm?.apiKey) {
		legs.push(async () => ({
			provider: "glm",
			...(await fetchGlmModels(glm, config.modelsTimeoutMs)),
		}));
	}
	if (deepseek?.apiKey) {
		legs.push(async () => ({
			provider: "deepseek",
			...(await fetchDeepSeekModels(deepseek, config.modelsTimeoutMs)),
		}));
	}
	if (openrouter) {
		legs.push(async () => ({ provider: "openrouter", entries: config.openRouterModels }));
	}
	// Qwen has no live /models endpoint — static curated list, emitted only when the
	// provider is registered (key set), like the Claude leg below.
	if (qwen) {
		legs.push(async () => ({ provider: "qwen", entries: config.qwenModels }));
	}
	legs.push(async () => ({ provider: "claude", entries: config.claudeModels }));

	const settled = await Promise.allSettled(legs.map((leg) => leg()));

	/** @type {ModelEntry[]} */
	const data = [];
	const seen = new Set();
	const _errors = [];
	// Every bare id any leg returned, so a route whose winner does not advertise
	// the model can still be published from the entry its origin vendor supplied.
	/** @type {Map<string, ModelEntry>} */
	const byBareId = new Map();
	for (const s of settled) {
		// leg thunks never reject, but guard defensively.
		const r = s.status === "fulfilled" ? s.value : { provider: "unknown", error: "fetch failed" };
		if (r.error) {
			_errors.push({ provider: r.provider, message: r.error });
			continue;
		}
		for (const entry of r.entries || []) {
			// A model served by several backends appears once under its CHEAPEST
			// route as the bare id; the losing routes are published under the local
			// `<provider>:<id>` lens so they stay selectable. Which is which comes
			// from the probed table — an id absent from it has no dedup to do and
			// keeps the bare spelling on whichever leg emitted it.
			//
			// The WINNER is derived, never re-stated in a leg's catalog: a leg says
			// what it advertises, ROUTES says who serves what, and the bare id is
			// emitted by whichever backend wins — even if that backend's own list
			// does not mention it (see below). Restating a route in a catalog would
			// be the same curated fact in two places, i.e. drift waiting to happen.
			if (!byBareId.has(entry.id)) byBareId.set(entry.id, entry);
			const winner = winnerOf(entry.id, config);
			const loses = winner !== undefined && winner !== r.provider;
			push(entry, loses ? `${r.provider}:${entry.id}` : entry.id, r.provider);
		}
	}

	// Cross-vendor routes the winner does not advertise. `deepseek-v4-pro` is the
	// case: the Qwen plan resells it (cheapest route), but it is a DeepSeek id and
	// has no business in Qwen's own catalog — Qwen advertises qwen* models. So the
	// bare id arrives from the DeepSeek leg, is republished there as
	// `deepseek:deepseek-v4-pro` (the losing route), and the bare spelling is
	// emitted here, attributed to the winner. Without this the id would vanish
	// entirely: every leg that has it sees itself as the loser.
	//
	// Derived from ROUTES + what the legs actually returned, so a table edit alone
	// moves the id. Nothing to keep in step by hand.
	for (const [id, entry] of byBareId) {
		const winner = winnerOf(id, config);
		if (winner === undefined || seen.has(id)) continue;
		push(entry, id, winner);
	}

	return { data, _errors };

	/** Cheapest REGISTERED backend for an id, or undefined if the table is silent. */
	function winnerOf(id, cfg) {
		return rankRoutes(id).find((route) => providerById(cfg, route.provider))?.provider;
	}

	/**
	 * Append, or — for an entry derived after its leg already ran — slot in with
	 * that provider's other rows. Consumers group by provider (list-models.js
	 * prints a blank line whenever it changes), so a trailing row would open a
	 * second, one-model group for a backend already listed above.
	 * @param {ModelEntry} entry
	 * @param {string} id
	 * @param {string} provider
	 */
	function push(entry, id, provider) {
		if (seen.has(id)) return;
		seen.add(id);
		// Scan back to just after this provider's last row. If it has none yet
		// (a new group), the scan runs to 0 — so fall back to appending, which is
		// what the in-order leg loop wants.
		let at = data.length;
		while (at > 0 && data[at - 1].provider !== provider) at--;
		if (at === 0) at = data.length;
		data.splice(at, 0, {
			// Window is looked up on the BARE id, then the (possibly prefixed) id is
			// applied — the curated table is keyed by vendor id, and an alias is the
			// same model reached another way, so it has the same window.
			...withContextWindow(entry),
			id,
			provider,
			tier: tierOf(provider),
			grade: gradeOf(entry.id),
		});
	}
}
