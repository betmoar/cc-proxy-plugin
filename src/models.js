// @ts-check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDER_IDS, providerById } from "./providers.js";
import { tierOf } from "./routes.js";

/**
 * @typedef {{ type: "model", id: string, display_name: string, created_at: string | null, context_window?: number, provider?: string, tier?: number, grade?: string, usable?: boolean }} ModelEntry
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
 * plan-served flagship is tier 2 and Flagship. Publishing them as one field
 * would make one of those a lie.
 *
 * THREE VALUES, AND ONLY THREE: `Flagship` | `Strong` | `Specialist`. An id
 * absent from this table (and from the refresh) has NO grade — the field is
 * OMITTED on the wire, never `null` and never a placeholder string. That is the
 * same rule CONTEXT_WINDOW follows, and for the same reason: a consumer must be
 * able to tell "never assessed" from "assessed", which `"grade" in entry`
 * answers and a default value destroys.
 *
 * `Economy` was RETIRED in 0.6.1 and must not come back: it is a COST class
 * ("cheap and fast") sitting on a CAPABILITY axis, which is precisely the
 * conflation the tier/grade split exists to prevent — `deepseek-v4-flash`
 * measured equal to `glm-5.2` on implementation work. The five ids that carried
 * it are now `Specialist`, which is where `scripts/bench-grades.js` already put
 * them: that script emits only Flagship/Strong/Specialist, so any operator who
 * has run `/cc-proxy:bench grades` has had an Economy-free table for a while.
 * `Specialist` means NARROW — the residual ASSESSED bucket, not "unknown".
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
 * @type {Record<string, "Flagship" | "Strong" | "Specialist">}
 */
export const MODEL_GRADES = {
	// GLM. Grade is the model's position within its OWN vendor, so a new
	// flagship demotes the previous one — glm-5.3 shipped 2026-08-14 and
	// glm-5.2 moves to Strong, which is what it now is relative to Z.ai's line.
	//
	// Deliberately NOT derived from the fact that Z.ai currently serves glm-5.3
	// for glm-5.2/5.1/5 alike (measured the same day). That aliasing is a
	// serving decision the vendor can reverse without notice, and the Qwen plan
	// still serves real glm-5.2 weights, so collapsing these ids to one grade
	// would publish a claim that is false for plan users and volatile for
	// everyone else. Position is stable; what is behind an alias this week is
	// not. See scripts/probe-vendors.mjs for the standing measurement.
	"glm-5.3": "Flagship",
	"glm-5.2": "Strong",
	"glm-5.1": "Strong",
	"glm-5": "Strong",
	"glm-5-turbo": "Specialist",
	// Were `Economy` until 0.6.1 retired that value — see the header. Each is a
	// superseded generation still in service, which is a NARROW remit, not a
	// cheapness claim.
	"glm-4.7": "Specialist",
	"glm-4.6": "Specialist",
	"glm-4.5": "Specialist",
	"glm-4.5-air": "Specialist",
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
	// Google Gemini, reachable ONLY through OpenRouter — Google publishes no
	// Anthropic Messages endpoint (probed 2026-08-23: /v1/messages,
	// /v1beta/messages, /v1beta/anthropic/v1/messages and /anthropic/v1/messages
	// all 404 with a valid key that returns 200 on :generateContent the same
	// minute), so there is no native leg and never will be under invariant 5.
	// The slash spellings are therefore the WHOLE Google line as far as this
	// table is concerned, unlike deepseek/qwen where a bare sibling shares the
	// rung.
	//
	// A FLASH model takes Flagship here, which reads wrong and is not. Grade is
	// position within the vendor's own line and Google's numbering puts 3.7 above
	// 3.1, so the newest release wins the rung — the same rule that demoted
	// glm-5.2 under glm-5.3. benchlm corroborates rather than contradicts: on the
	// 2026-08-23 leaderboard every Gemini Pro row sits BELOW the flash line
	// (`Gemini 3.6 Flash` rank 9 / 75.21 supported, `Gemini 3 Pro` rank 24 /
	// 67.17, `Gemini 3.1 Pro` rank 96 / 55.96). Google's Pro tier is a price and
	// context class, not the top of its capability line.
	//
	// `google/gemma-*` is deliberately ABSENT and must stay absent: gemma is a
	// separate open-weights LINE whose version numbers do not compare with
	// gemini's, and `gemma-4` ([4]) would outrank `gemini-3.7-flash` ([3,7]) and
	// steal Flagship. vendorOf() in scripts/bench-grades.js enforces the split.
	"google/gemini-3.7-flash": "Flagship",
	"google/gemini-3.6-flash": "Strong",
	"google/gemini-3.5-flash": "Specialist",
	"google/gemini-3.5-flash-lite": "Specialist",
	"google/gemini-3.1-pro-preview": "Specialist",
	"google/gemini-3.1-flash-lite": "Specialist",
	// Qwen (curated, DashScope)
	"qwen3.8-max": "Strong",
	"qwen3.7-max": "Strong",
	"qwen3.7-plus": "Specialist",
	"qwen3.6-flash": "Specialist",
	// Plan-served DeepSeek build — graded as its bare sibling deepseek-v4-flash,
	// which it is a dated snapshot of. Capability, not cost: reaching it through
	// the plan is cheaper, but that is the tier's business, not the grade's.
	"deepseek-v4-flash-0731": "Strong",
	// Claude (curated, OAuth)
	"claude-fable-5": "Flagship",
	"claude-opus-5": "Flagship",
	"claude-sonnet-5": "Strong",
};

/**
 * The complete set of grades that may reach the wire. There is no default and
 * no "unknown" member: an unassessed id omits the field entirely (see gradeOf).
 *
 * Also the VALIDATOR for the refreshed table below. `grades.json` is written by
 * a command that can be interrupted mid-write and lives in a directory the user
 * edits by hand, so an arbitrary string there is not a grade — probed on a live
 * proxy 2026-08-12, a hand-edited file published `"grade":"SuperDuperMax"` and
 * `"grade":"   "` straight onto `/v1/models`, i.e. straight into cc-operator's
 * dispatch input. Membership here is the only way in.
 * @type {ReadonlySet<string>}
 */
export const GRADES = new Set(["Flagship", "Strong", "Specialist"]);

/**
 * Grades refreshed by `/cc-proxy:bench grades`, loaded ONCE at startup.
 *
 * This is config, not state — the same posture as `~/.env`: a file a human
 * writes with a manual command, read when the process boots, never on a request
 * path. Invariant 2 forbids state carried BETWEEN requests; it does not forbid
 * reading configuration at startup. A running proxy's answers stay identical
 * for its whole lifetime, which is the property that invariant protects.
 *
 * Without this the refresh command was a dead end: `bench grades` wrote
 * `~/.claude/cc-proxy/grades.json` and NOTHING read it, so `/v1/models` kept
 * publishing the built-in table while the command showed the operator a
 * different one — measured 2026-08-12, they disagreed on 13 of 24 ids
 * (`qwen3.8-max` Strong vs Flagship, `claude-sonnet-5` Strong vs Specialist, …).
 * That is the "same curated data in two places" drift `test/couplings.test.js`
 * exists to catch, inside one repo, with cc-operator dispatching on the stale
 * half.
 *
 * Bad JSON, a missing file, or an unreadable one all fall back to the built-in
 * table in silence: discovery must keep answering. A malformed entry is skipped
 * individually rather than voiding the whole file — including one whose grade
 * is not a member of GRADES, which is the difference between a stale answer and
 * a fabricated one on a published field.
 *
 * @returns {Record<string, string>}
 */
function loadRefreshedGrades() {
	try {
		const file = path.join(os.homedir(), ".claude", "cc-proxy", "grades.json");
		// Only a REGULAR file. `readFileSync` on a FIFO/socket/device BLOCKS
		// waiting for a writer instead of throwing, which the try/catch below
		// cannot stop — a stopped throw does not stop a block. That turns
		// module load (this runs at import time) into a boot hang, and
		// proxy-lifecycle.js's SessionStart hook never sees the proxy come up:
		// every session gets ECONNREFUSED. statSync a non-regular path throws
		// too (ENOENT-shaped for a missing path, or just informs us to skip),
		// which the existing catch already handles.
		if (!fs.statSync(file).isFile()) return {};
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		const models = parsed?.models;
		if (!models || typeof models !== "object") return {};
		/** @type {Record<string, string>} */
		const out = {};
		for (const [id, entry] of Object.entries(models)) {
			// Membership, not truthiness. A non-empty string used to be enough, which
			// let a hand-edited file put `"SuperDuperMax"` and `"   "` on the wire —
			// and would let a retired `"Economy"` back in from an old file.
			const grade = /** @type {any} */ (entry)?.grade;
			if (typeof grade === "string" && GRADES.has(grade)) out[id] = grade;
		}
		return out;
	} catch {
		return {};
	}
}

const REFRESHED_GRADES = loadRefreshedGrades();

/**
 * Refreshed grade first, built-in table second, UNDEFINED last.
 *
 * There is deliberately no default. Measured 2026-08-07 against the live proxy:
 * of 320 usable entries, 299 shipped `Specialist` — a value a consumer could
 * not distinguish from "never assessed", so the field read as a verdict on 299
 * models nobody had looked at. Returning undefined (and omitting the key, see
 * withGrade) is the same rule `context_window` already follows, and it is a
 * BREAKING change for a consumer reading the field unconditionally. Affordable
 * because `grade` has no consumer in this repo and cc-operator reads
 * `/v1/models` for membership only. → docs/BACKLOG.md item 9.
 *
 * Callers must tolerate undefined: `claude-haiku-*` is unlisted by invariant 4,
 * and any of ~320 live-catalog ids may simply never have been assessed.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
export function gradeOf(id) {
	if (Object.hasOwn(REFRESHED_GRADES, id)) return REFRESHED_GRADES[id];
	return Object.hasOwn(MODEL_GRADES, id) ? MODEL_GRADES[id] : undefined;
}

/**
 * Attach `grade` to a discovery entry when the id has one; otherwise return the
 * entry unchanged — field OMITTED, never `null`, never a placeholder. Exactly
 * withContextWindow()'s contract, deliberately: `"grade" in entry` is how a
 * consumer tells assessed from unassessed, and `{...e, grade: undefined}` would
 * break that for anything reading the in-process object (JSON.stringify drops
 * the key, but `"grade" in entry` is then true before serialization).
 * @param {ModelEntry} entry
 * @param {string} lookupId the BARE vendor id, which is what the table is keyed on
 * @returns {ModelEntry}
 */
export function withGrade(entry, lookupId) {
	const grade = gradeOf(lookupId);
	return grade === undefined ? entry : { ...entry, grade };
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
 * Sources (2026-08-04), re-verify before each release touching the model —
 * full vendor doc index in docs/OPERATIONS.md "Vendor documentation":
 *   GLM:      docs.z.ai/guides/llm/glm-*.md  (4.5=128K; 4.6/4.7/5/5-Turbo/5.1=200K; 5.2=1M)
 *             overview: https://docs.z.ai/devpack/overview
 *   DeepSeek: https://api-docs.deepseek.com  (quick_start/pricing → 1M)
 *   Qwen:     https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
 *             (1M. `qwen3.8-max-preview` is NOT published: it is a pure alias
 *             onto qwen3.8-max — same weights, production billing — so listing
 *             it would be a second name for a model already in the catalog.)
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
	// 1048576 exactly, per Z.ai's own /api/v1/models — the only one of its three
	// list endpoints that knows glm-5.3 exists.
	"glm-5.3": 1048576,
	// DeepSeek (api-docs.deepseek.com/quick_start/pricing)
	"deepseek-v4-pro": 1000000,
	"deepseek-v4-flash": 1000000,
	// Qwen (Alibaba Cloud Model Studio)
	"qwen3.8-max": 1000000,
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

/**
 * The MODEL IDENTITY behind a discovery id: strip the ROUTE, keep the model.
 *
 * Identity is the third axis, alongside `tier` (what a route costs) and `grade`
 * (what a model can do) — and unlike those two it needs no table, because it is
 * already recoverable from the id. Three spellings reach the same DeepSeek
 * weights (`deepseek-v4-pro`, `qwen:deepseek-v4-pro`, `deepseek/deepseek-v4-pro`)
 * and nothing in the payload said so, which let a consumer picking one model per
 * `provider` seat the SAME model twice and read the result as agreement
 * (issue #39).
 *
 * SPLIT ON THE FIRST SEPARATOR, NOT THE LAST. This is the whole subtlety, and
 * the issue's own first draft got it wrong. `/` and `:` are not interchangeable:
 * `/` marks OpenRouter's vendor namespace, `:` marks a cc-proxy provider lens —
 * but OpenRouter ALSO spells its structural variants with a trailing colon
 * (`google/gemini-3.7-flash:batch`, `:free`). Measured over a live 415-id
 * catalogue: 66 ids carry both separators. Last-separator splitting collapses
 * 50 of them into one identity called `batch`, spanning seven vendors. So the
 * variant stays ATTACHED — it names a different way to reach the model, and
 * two ids differing only in variant are not interchangeable seats.
 *
 * The `:` strip reuses PROVIDER_IDS (the same guard parseModelSelector uses in
 * router.js) rather than splitting on any colon, so an unknown `foo:bar` is left
 * whole — a future vendor id containing a colon must not be silently truncated.
 *
 * @doctest identityOf("qwen:deepseek-v4-pro") -> "deepseek-v4-pro"
 * @doctest identityOf("deepseek/deepseek-v4-pro") -> "deepseek-v4-pro"
 * @doctest identityOf("deepseek-v4-pro") -> "deepseek-v4-pro"
 * @doctest identityOf("google/gemini-3.7-flash:batch") -> "gemini-3.7-flash:batch"
 * @doctest identityOf("bogus:thing") -> "bogus:thing"
 * @doctest identityOf("z-ai/glm-5.3") -> "glm-5.3"
 * @doctest identityOf("vendor/family/model-1") -> "family/model-1"
 *
 * TAKES `unknown`, NOT `string`, and that is the honest signature rather than a
 * loosened one. The ids come from live vendor catalogues, and `coerceEntry()`
 * admits an entry on a TRUTHY `id` (`if (!e || !e.id) return null`) — so a
 * vendor sending `id: 123` reaches this function, and the guard below is
 * load-bearing rather than defensive dressing. Annotating the parameter
 * `string` made the guard's own branch narrow to `never`, which type-checks
 * clean while promising a `string` return this function cannot honour for a
 * non-string input: the id is returned unchanged, on purpose, because dropping
 * or stringifying it would invent an identity the catalogue never published.
 * `unknown` in / `unknown` out states exactly that, and makes the one caller
 * (dedupByIdentity's Map key) obviously correct — a Map keys on anything.
 *
 * @param {unknown} id
 * @returns {unknown} the identity when `id` is a string; `id` itself otherwise
 */
export function identityOf(id) {
	if (typeof id !== "string") return id;
	const slash = id.indexOf("/");
	if (slash > 0) return id.slice(slash + 1);
	const colon = id.indexOf(":");
	if (colon <= 0) return id;
	const head = id.slice(0, colon);
	const tail = id.slice(colon + 1);
	if (!tail || !PROVIDER_IDS.has(head)) return id;
	return tail;
}

/**
 * Collapse discovery entries to one per model identity — the `?dedup=identity`
 * view of `GET /v1/models`.
 *
 * PUBLISHES NO NEW FACT. `tier` and `usable` already ship on every entry and
 * `identityOf` reads the id; this applies the rule once, centrally, instead of
 * asking every consumer to re-derive it — which is the failure this exists to
 * prevent, since the re-derivation is exactly what went wrong in issue #39's
 * own first draft.
 *
 * The winner within a group, in order: usable beats `usable: false` (an entry
 * that cannot complete a turn is not a substitute for one that can), then the
 * LOWEST tier (same weights, cheaper route — `deepseek-v4-pro` is tier 3 native
 * while `qwen:deepseek-v4-pro` is tier 2 plan-served), then first-seen. An entry
 * with no `tier` sorts last rather than winning by virtue of a missing field.
 *
 * Winners keep the original array order, so the provider grouping consumers rely
 * on (see push() in collectModels) survives.
 *
 * @param {ModelEntry[]} data
 * @returns {ModelEntry[]}
 */
export function dedupByIdentity(data) {
	/** @type {Map<string, { entry: ModelEntry, at: number }>} */
	const best = new Map();
	data.forEach((entry, at) => {
		const key = identityOf(entry.id);
		const prior = best.get(key);
		if (!prior || beats(entry, prior.entry)) best.set(key, { entry, at });
	});
	return [...best.values()].sort((a, b) => a.at - b.at).map((w) => w.entry);
}

/**
 * Is `candidate` the better representative of an identity than `incumbent`?
 * Ties go to the incumbent, which is the earlier entry — hence first-seen.
 * @param {ModelEntry} candidate
 * @param {ModelEntry} incumbent
 * @returns {boolean}
 */
function beats(candidate, incumbent) {
	const usable = (e) => (e.usable === false ? 1 : 0);
	if (usable(candidate) !== usable(incumbent)) return usable(candidate) < usable(incumbent);
	// A missing tier must not win by comparing as undefined; sort it last.
	const tier = (e) => (typeof e.tier === "number" ? e.tier : Number.POSITIVE_INFINITY);
	return tier(candidate) < tier(incumbent);
}

/** Reachable Claude ids advertised on discovery. Not public-API-stable — re-confirm
 * before each release touching Claude compat. claude-haiku-* omitted (internal ops
 * pin); claude-mythos-5 omitted (Project Glasswing-gated — unreachable by default). */
export const DEFAULT_CLAUDE_MODELS = [
	{ type: "model", id: "claude-fable-5", display_name: "Claude Fable 5", created_at: null },
	{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: null },
	{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: null },
];

/** Qwen (QwenCloud Token Plan) ids. OFFLINE FALLBACK ONLY as of 2026-08-06 —
 * `fetchQwenModels()` pulls the live catalog and wins whenever it is reachable.
 *
 * THE "NO CATALOG ENDPOINT" CLAIM WAS WRONG, and cost this list years of hand
 * curation: the Anthropic-skin path (`/apps/anthropic/v1/models`) does 404
 * `"Not support"`, but the OpenAI-compatible path on the same host
 * (`/compatible-mode/v1/models`) returns 200 with 11 ids. Probing one path and
 * concluding "no endpoint exists" is the mistake to avoid repeating with the
 * next backend.
 *
 * ids are bare (`qwen3.7-max`), matching the `qwen` prefix the provider's
 * match() keys on; the plan also serves foreign ids (glm-5.2, deepseek-*) which
 * discovery publishes under the `qwen:` lens.
 *
 * `qwen3.8-max-preview` is NOT listed: it is an alias onto `qwen3.8-max` (same
 * weights, production billing), so it would be a second name for a model
 * already here. It stays callable — a user who types it still routes fine.
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
	// OFFLINE FALLBACK ONLY — used when the live fetch fails, so a flaky network
	// degrades to the previous behaviour instead of an empty leg. Mirrors what
	// `/compatible-mode/v1/models` returned on 2026-08-06; the live list wins
	// whenever it is reachable, so this does not need to be exhaustive.
	//
	// `qwen3.8-max-preview` is deliberately absent: it is a pure ALIAS onto
	// qwen3.8-max (same weights, production billing), so publishing it would be a
	// second name for a model already listed.
	//
	// Foreign ids (glm-5.2, deepseek-*) are here because the plan genuinely
	// serves them; discovery publishes those under the `qwen:` lens since this
	// backend does not own that namespace. `deepseek-v4-flash` is absent — 403.
	{ type: "model", id: "qwen3.8-max", display_name: "Qwen3.8 Max", created_at: null },
	{ type: "model", id: "qwen3.7-max", display_name: "Qwen3.7 Max", created_at: null },
	{ type: "model", id: "qwen3.7-plus", display_name: "Qwen3.7 Plus", created_at: null },
	{ type: "model", id: "qwen3.6-flash", display_name: "Qwen3.6 Flash", created_at: null },
	{
		type: "model",
		id: "deepseek-v4-flash-0731",
		display_name: "DeepSeek V4 Flash (0731)",
		created_at: null,
	},
	{ type: "model", id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro", created_at: null },
	{ type: "model", id: "glm-5.2", display_name: "GLM-5.2", created_at: null },
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
 *
 * A numeric (OpenAI-style Unix) timestamp is CONVERTED, not dropped. It used to
 * return null here, on the reasoning that a non-ISO value must never reach the
 * wire — correct, but converting honors that better than discarding does, and
 * discarding cost real information: OpenRouter sends `created` as unix seconds
 * for all ~400 of its models, so the old rule nulled the date on 372 of the 396
 * published entries and made "sort by newest" impossible for any consumer.
 *
 * Seconds vs milliseconds is decided by magnitude: a seconds-epoch past ~2001 is
 * >1e9, and the same number read as ms is 1970. Anything at or above 1e12 is
 * therefore already ms. Non-finite, negative, and out-of-range values still go
 * to null rather than emitting `Invalid Date`.
 * @param {unknown} v
 * @returns {string | null}
 */
export function coerceCreated(v) {
	// The string branch is validated, not trusted: the field promises ISO-8601,
	// and a vendor sending "n/a" or "unknown" would otherwise put that straight
	// on the wire. Parseable strings are passed through VERBATIM rather than
	// re-serialized — round-tripping through Date would silently rewrite a
	// vendor's offset ("+02:00" -> "Z") and drop sub-second precision, which is
	// a change we have no reason to make to a value that is already valid.
	if (typeof v === "string") return Number.isNaN(Date.parse(v)) ? null : v;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
	const ms = v >= 1e12 ? v : v * 1000;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
		} catch (err) {
			// The abort can land HERE — headers arrived, then the vendor stalled past
			// modelsTimeoutMs while the body was being read. Reported as a schema
			// problem, that sends the operator hunting for a vendor change when the
			// cause is latency (measured: a stub that sent `{"data":[` and stopped
			// came back "invalid response shape"). Classify before the outer catch
			// would have, since this catch shadows it.
			if (err?.name === "AbortError") return { error: "timeout" };
			// Not an abort, and not necessarily malformed JSON either: a vendor that
			// resets the socket after the headers (its own idle timeout firing before
			// ours) throws `TypeError: terminated` here, cause "other side closed"
			// (measured 2026-09-02). That is a CONNECTION failure wearing the schema
			// error's label — and this catch, unlike the outer one, logged nothing at
			// all, so the operator got "invalid response shape" with no trail to the
			// real cause. The public message stays pinned; the log carries the truth.
			console.error(
				`[models] glm body read failed: ${err?.message || err}${err?.cause?.message ? ` (${err.cause.message})` : ""}`,
			);
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
 * Ids the plan serves on the Messages endpoint but that a Claude Code session
 * cannot actually use: they resolve (so they are NOT "model not exist") and then
 * fail on BODY SHAPE — `"Input should be a valid list: input.messages.0"`,
 * `"url error"` — because they want an image/audio request schema. Invariant 5
 * keeps a translation layer out, so they stay unusable HERE, on `/v1/messages`.
 *
 * `usable: false` means "cannot complete a TURN", never "unreachable". Two of
 * these are reachable, on another path, and the flag must not be read as a
 * verdict on the model. Both halves measured 2026-08-25 against the Token Plan
 * host with a live key; the re-runnable form is `pnpm probe:vendors`.
 *
 * IMAGE — WORKS, via the tunnel (issue #40). `wan2.7-image` / `-pro` answer 200
 * on `POST /api/v1/services/aigc/multimodal-generation/generation` with the
 * DashScope-native body (`input.messages[].content` a list of typed parts,
 * `parameters.size`), returning a SIGNED OSS URL with an `Expires` — see the
 * `mediaBaseUrl` comment in providers.js. cc-proxy forwards that path untouched,
 * so a plan holder reaches these without paying for a metered alternative. They
 * stay `usable: false` regardless, because that is still true of `/v1/messages`
 * and putting them in `/model` would offer a turn that cannot complete.
 *
 * AUDIO — DOES NOT WORK, and that is now a measurement rather than an
 * assumption. `qwen-audio-3.0-tts-plus`: every HTTP candidate 400s with
 * `InvalidParameter: url error` (`/text2speech/speech-synthesis`,
 * `/speech-generation/generation`, `/services/audio/tts`, and
 * multimodal-generation with a TTS body); `/compatible-mode/v1/audio/speech`
 * 404s; `/compatible-mode/v1/chat/completions` with `modalities:["audio"]` 500s.
 * The one route that ACCEPTS the task is WebSocket `wss://…/api-ws/v1/inference`
 * — `task-started` arrives, so model and auth are valid, and then `task-failed`,
 * `[cosyvoice:]Engine error [411]`, for every voice (Cherry / Ethan /
 * longxiaochun), format (wav / mp3), and language tried. Vendor-side breakage,
 * not a shape we have yet to guess. It is also untunnellable here: the proxy has
 * no `upgrade` handler, so WebSocket is not a passthrough candidate.
 *
 * Published anyway, flagged: dropping them would make discovery lie about what
 * the plan includes, while listing them silently would hand `/model` four
 * options that cannot complete a turn. `usable: false` says both things at once.
 *
 * Matched by prefix, not by an id list, so a new `wan2.8-*` or audio build is
 * flagged without an edit — the modality is the vendor's naming convention, and
 * getting it wrong fails safe (a flagged text model is visible and reported; an
 * unflagged multimodal one is a trap).
 */
const UNUSABLE_MODALITY = [
	// Qwen plan: image / audio / realtime builds.
	/^wan\d/,
	/-audio-/,
	/-image/,
	/-tts/,
	/-realtime/,
	// OpenRouter structural variants — not chat models a session can select:
	//   `:batch`  async batch endpoint, not /v1/messages
	//   `~…`      a moving alias, not a pinned model
	//   `openrouter/auto*`  the router's own meta-model
	/:batch$/,
	/^~/,
	/^openrouter\/auto/,
];

/** @param {string} id */
function isUsableHere(id) {
	return !UNUSABLE_MODALITY.some((re) => re.test(id));
}

/**
 * Fetch the Qwen Token Plan's live catalog.
 *
 * The endpoint is on the OPENAI-COMPATIBLE path, not the Anthropic skin the
 * proxy forwards to: `/compatible-mode/v1/models` (200, 11 ids) while
 * `/apps/anthropic/v1/models` returns 404 `"Not support"`. That asymmetry is why
 * this list was hardcoded for so long — probing only the skin path says "no
 * catalog exists", which is what an earlier comment in this file claimed and
 * what a 2026-08-06 probe disproved.
 *
 * The plan host serves several vendors (glm-5.2, deepseek-v4-pro), so the
 * returned ids are NOT all qwen-branded; discovery publishes the foreign ones
 * under the `qwen:` lens (see ownsId in collectModels).
 *
 * @param {import("./providers.js").Provider} qwen
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchQwenModels(qwen, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// Swap the Anthropic-skin suffix for the compatible-mode one; the provider's
		// baseUrl is what the forwarding path uses and must not change.
		const root = qwen.baseUrl.replace(/\/apps\/anthropic$/, "");
		const res = await fetch(`${root}/compatible-mode/v1/models`, {
			headers: { authorization: `Bearer ${qwen.apiKey}` },
			signal: controller.signal,
		});
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch (err) {
			// The abort can land HERE — headers arrived, then the vendor stalled past
			// modelsTimeoutMs while the body was being read. Reported as a schema
			// problem, that sends the operator hunting for a vendor change when the
			// cause is latency (measured: a stub that sent `{"data":[` and stopped
			// came back "invalid response shape"). Classify before the outer catch
			// would have, since this catch shadows it.
			if (err?.name === "AbortError") return { error: "timeout" };
			// Not an abort, and not necessarily malformed JSON either: a vendor that
			// resets the socket after the headers (its own idle timeout firing before
			// ours) throws `TypeError: terminated` here, cause "other side closed"
			// (measured 2026-09-02). That is a CONNECTION failure wearing the schema
			// error's label — and this catch, unlike the outer one, logged nothing at
			// all, so the operator got "invalid response shape" with no trail to the
			// real cause. The public message stays pinned; the log carries the truth.
			console.error(
				`[models] qwen body read failed: ${err?.message || err}${err?.cause?.message ? ` (${err.cause.message})` : ""}`,
			);
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		const entries = body.data
			.map((e) => {
				const base = coerceEntry(e);
				if (!base) return null;
				return isUsableHere(base.id) ? base : { ...base, usable: false };
			})
			.filter(Boolean);
		return { entries };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		console.error(`[models] qwen fetch failed: ${err?.message || err}`);
		return { error: "fetch failed" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch OpenRouter's live catalog. PUBLIC — no auth — so this works even before
 * a key is configured; the leg is still gated on the provider being registered,
 * because an unregistered backend must not appear in discovery.
 *
 * Replaces a hand-curated six-id allowlist. The aggregator serves ~400 models
 * and hardcoding a fraction of them made the list wrong the day it was written;
 * `OPENROUTER_MODELS` remains as an explicit override, and DEFAULT_OPENROUTER_MODELS
 * remains as the offline fallback when this fetch fails.
 *
 * `context_length` is OpenRouter's own per-deployment number, which is exactly
 * what CONTEXT_WINDOW deliberately refuses to guess for a `vendor/model` id (an
 * aggregator may serve a truncated window). Taking it from the vendor here is
 * the measurement that comment asks for, so these entries carry a real
 * `context_window` while the curated table stays silent about them.
 *
 * @param {import("./providers.js").Provider} openrouter
 * @param {number} timeoutMs
 * @returns {Promise<{ entries?: ModelEntry[], error?: string }>}
 */
async function fetchOpenRouterModels(openrouter, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${openrouter.baseUrl}/v1/models`, { signal: controller.signal });
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		let body;
		try {
			body = await res.json();
		} catch (err) {
			// The abort can land HERE — headers arrived, then the vendor stalled past
			// modelsTimeoutMs while the body was being read. Reported as a schema
			// problem, that sends the operator hunting for a vendor change when the
			// cause is latency (measured: a stub that sent `{"data":[` and stopped
			// came back "invalid response shape"). Classify before the outer catch
			// would have, since this catch shadows it.
			if (err?.name === "AbortError") return { error: "timeout" };
			// Not an abort, and not necessarily malformed JSON either: a vendor that
			// resets the socket after the headers (its own idle timeout firing before
			// ours) throws `TypeError: terminated` here, cause "other side closed"
			// (measured 2026-09-02). That is a CONNECTION failure wearing the schema
			// error's label — and this catch, unlike the outer one, logged nothing at
			// all, so the operator got "invalid response shape" with no trail to the
			// real cause. The public message stays pinned; the log carries the truth.
			console.error(
				`[models] openrouter body read failed: ${err?.message || err}${err?.cause?.message ? ` (${err.cause.message})` : ""}`,
			);
			return { error: "invalid response shape" };
		}
		if (!body || !Array.isArray(body.data)) return { error: "invalid response shape" };
		const entries = body.data
			.map((e) => {
				const base = coerceEntry({ ...e, display_name: e.name });
				if (!base) return null;
				// Vendor-reported window wins over the curated table for these ids —
				// see the note above. Guard the type: a malformed value must omit the
				// field rather than publish a string or NaN.
				const withWindow =
					Number.isFinite(e.context_length) && e.context_length > 0
						? { ...base, context_window: Math.trunc(e.context_length) }
						: base;
				return isUsableHere(base.id) ? withWindow : { ...withWindow, usable: false };
			})
			// Anthropic's own models are dropped, not flagged: reaching Claude
			// through a reseller means paying per token for what the session's OAuth
			// plan already covers, and it would sit in `/model` looking like the
			// obvious pick. Invariants 3 and 4 exist to keep Claude traffic on the
			// Claude route; publishing an aggregator's copy invites the opposite.
			.filter((m) => m && !m.id.startsWith("anthropic/"));
		return { entries };
	} catch (err) {
		if (err && err.name === "AbortError") return { error: "timeout" };
		console.error(`[models] openrouter fetch failed: ${err?.message || err}`);
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
		} catch (err) {
			// The abort can land HERE — headers arrived, then the vendor stalled past
			// modelsTimeoutMs while the body was being read. Reported as a schema
			// problem, that sends the operator hunting for a vendor change when the
			// cause is latency (measured: a stub that sent `{"data":[` and stopped
			// came back "invalid response shape"). Classify before the outer catch
			// would have, since this catch shadows it.
			if (err?.name === "AbortError") return { error: "timeout" };
			// Not an abort, and not necessarily malformed JSON either: a vendor that
			// resets the socket after the headers (its own idle timeout firing before
			// ours) throws `TypeError: terminated` here, cause "other side closed"
			// (measured 2026-09-02). That is a CONNECTION failure wearing the schema
			// error's label — and this catch, unlike the outer one, logged nothing at
			// all, so the operator got "invalid response shape" with no trail to the
			// real cause. The public message stays pinned; the log carries the truth.
			console.error(
				`[models] deepseek body read failed: ${err?.message || err}${err?.cause?.message ? ` (${err.cause.message})` : ""}`,
			);
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
		legs.push(async () => {
			// An explicit OPENROUTER_MODELS override skips the fetch entirely — the
			// user asked for a specific set, so the vendor's full list is not wanted.
			// Otherwise fetch live and fall back to the static list on failure, so a
			// flaky network degrades to the old behaviour instead of an empty leg.
			if (config.openRouterModelsExplicit) {
				return { provider: "openrouter", entries: config.openRouterModels };
			}
			const live = await fetchOpenRouterModels(openrouter, config.modelsTimeoutMs);
			return live.entries
				? { provider: "openrouter", entries: live.entries }
				: { provider: "openrouter", entries: config.openRouterModels };
		});
	}
	// Qwen fetches live from the COMPATIBLE-MODE path (the Anthropic skin 404s a
	// models route), falling back to the static list. Emitted only when the
	// provider is registered (key set), like the Claude leg below.
	if (qwen) {
		legs.push(async () => {
			const live = await fetchQwenModels(qwen, config.modelsTimeoutMs);
			return live.entries
				? { provider: "qwen", entries: live.entries }
				: { provider: "qwen", entries: config.qwenModels };
		});
	}
	legs.push(async () => ({ provider: "claude", entries: config.claudeModels }));

	const settled = await Promise.allSettled(legs.map((leg) => leg()));

	/** @type {ModelEntry[]} */
	const data = [];
	const seen = new Set();
	const _errors = [];
	for (const s of settled) {
		// leg thunks never reject, but guard defensively.
		const r = s.status === "fulfilled" ? s.value : { provider: "unknown", error: "fetch failed" };
		if (r.error) {
			_errors.push({ provider: r.provider, message: r.error });
			continue;
		}
		for (const entry of r.entries || []) {
			// NAMESPACE OWNERSHIP decides the spelling — not who wins the route.
			// A backend lists its own vendor's models bare, and anything foreign it
			// also serves under the `<provider>:<id>` lens. So `deepseek-v4-pro`
			// stays bare on DeepSeek's card and appears as `qwen:deepseek-v4-pro`
			// on the plan's, whichever of the two is cheaper.
			//
			// Display and routing are deliberately SEPARATE questions. An earlier
			// pass let the cost ranking pick the bare spelling, which re-homed
			// DeepSeek's own model onto Qwen's card and left DeepSeek showing a
			// prefixed id for a model it owns — backwards, and it also prefixed
			// nothing for plan-only ids like `deepseek-v4-flash-0731` (no rival
			// route, so no "dedup hit" — yet it is still a foreign id on that card).
			// Ownership is a property of the id, needs no cost model, and answers
			// both cases the same way.
			//
			// `/model <bare id>` still routes via `rankRoutes` — native provider
			// first, then cheapest tier among registered providers; the prefix is
			// how you name a specific one. The two only look linked when the owner
			// also happens to win.
			push(
				entry,
				ownsId(r.provider, entry.id) ? entry.id : `${r.provider}:${entry.id}`,
				r.provider,
			);
		}
	}

	// No second pass. Under ownership every leg publishes the ids it actually
	// serves, bare or prefixed, so nothing can fall between two backends — which
	// is what the cost-ranked spelling made possible (each leg holding an id saw
	// itself as the loser and emitted only the alias, so the bare form vanished).
	return { data, _errors };

	/**
	 * Does this backend own the id's namespace? True when the id starts with the
	 * provider's own name, which is what makes a row bare rather than prefixed.
	 *
	 * `claude` is special-cased: Anthropic's ids are `claude-*`, so the plain
	 * prefix test happens to work — but state it, because the `openrouter` leg
	 * owns NO namespace of its own (its ids are `vendor/model`) and must fall
	 * through to the aggregator rule below rather than prefixing all 399 of them.
	 *
	 * @param {string} provider
	 * @param {string} id
	 * @returns {boolean}
	 */
	function ownsId(provider, id) {
		// An aggregator's ids are already vendor-namespaced (`deepseek/…`), which
		// IS the disambiguation — prefixing them again would read
		// `openrouter:deepseek/deepseek-v4-pro` for every row.
		if (id.includes("/")) return true;
		return id.startsWith(provider);
	}

	/**
	 * Append, or — when a provider's rows are no longer contiguous — slot in with
	 * that provider's other rows. Consumers group by provider (list-models.js
	 * prints a blank line whenever it changes), so a stray row would open a
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
		// Window and grade are looked up on the BARE id, then the (possibly
		// prefixed) id is applied — both curated tables are keyed by vendor id, and
		// an alias is the same model reached another way, so it has the same window
		// and the same grade. `grade` is ABSENT, not null, for an unassessed id.
		data.splice(at, 0, {
			...withGrade(withContextWindow(entry), entry.id),
			id,
			provider,
			tier: tierOf(provider),
		});
	}
}
