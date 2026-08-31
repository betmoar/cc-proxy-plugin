#!/usr/bin/env node
// @ts-check
/**
 * bench-grades — fetch model CAPABILITY from benchlm.ai and PRICE from
 * OpenRouter, join them on a normalized model name, and write the result to
 * ~/.claude/cc-proxy/grades.json.
 *
 * Two rules this file exists to enforce, both decided before it was written:
 *
 * 1. **grade = the model's position within ITS OWN VENDOR**, never a global
 *    score threshold. "Flagship" is a claim a vendor cannot lie about with the
 *    competition watching, so it is a usable signal; a global cutoff (say >=75)
 *    would demote `glm-5.2` (63.0) and `deepseek-v4-pro` (60.0) even though
 *    each is its vendor's top model.
 * 2. **Price NEVER lowers a grade.** Cheap is not weak — price says something
 *    about the seller (plan capacity, cost base), not the weights. Price ships
 *    as its own field.
 *
 * An id benchlm does not cover gets NO grade rather than a default, matching
 * the `context_window` rule in src/models.js: omit beats a confident lie. Our
 * own probe latency never contributes here (see bench-speed.js) — n is small
 * and the tasks are self-authored, so it cannot carry a published grade.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.js";

loadEnv();

const BENCHLM_URL = "https://benchlm.ai/api/data/leaderboard?limit=400";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 10000;
export const OUT_DIR = path.join(os.homedir(), ".claude", "cc-proxy");
export const OUT_PATH = path.join(OUT_DIR, "grades.json");

/** benchlm's licence asks for attribution wherever the scores are shown. */
export const ATTRIBUTION = "Capability scores: benchlm.ai";

/**
 * Write `data` to `filePath` atomically: write to a sibling temp file, then
 * `renameSync` over the target. A rename within one directory is a single
 * filesystem operation, so a reader (src/models.js loadRefreshedGrades(), at
 * proxy boot) always sees either the complete old file or the complete new
 * one — never a partial write left by a kill (SIGKILL, OOM, disk full)
 * mid-write. Exported so the atomicity itself is testable without a live
 * fetch.
 * @param {string} dir
 * @param {string} filePath
 * @param {string} data
 */
export function writeGradesFile(dir, filePath, data) {
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, data);
	fs.renameSync(tmpPath, filePath);
}

/**
 * Fold a model name or id to a comparison key: lowercase, and every separator
 * dropped. "DeepSeek V4 Pro", "deepseek-v4-pro" and "deepseek/deepseek-v4-pro"
 * all fold to "deepseekv4pro".
 *
 * The vendor prefix is stripped from slash ids FIRST, so an OpenRouter id joins
 * the same row as its bare form — they are the same weights and must not get
 * different grades. A `<provider>:` lens is stripped for the same reason and by
 * the same rule `vendorOf()` already applies: `qwen:deepseek-v4-pro` is the
 * plan's copy of one DeepSeek model, so it must fold onto the bare row rather
 * than claim a rung of its own (leaving it unstripped pushed the real second
 * model down a grade — `deepseek-v4-flash` fell from Strong to Specialist).
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
	const tail = String(s).includes("/") ? String(s).split("/").pop() : String(s);
	return (
		String(tail)
			.replace(/^[a-z]+:/, "")
			// A DATED build folds onto its bare sibling: `deepseek-v4-flash-0731` is
			// a snapshot of `deepseek-v4-flash`, which is exactly how src/models.js
			// grades it ("graded as its bare sibling ... which it is a dated snapshot
			// of"). Left unfolded it ranked as a THIRD distinct DeepSeek model and
			// came out Specialist, contradicting the curated Strong this table is
			// meant to refresh.
			//
			// SCOPED TO `deepseek-`, exactly like providers.js DATED_ID and for a
			// neighbouring reason: this key also indexes the benchlm score and
			// OpenRouter price maps, so an unscoped `-\d{4}$` would fold every dated
			// vendor id (`…-sonnet-20240620`) onto its base and hand it another
			// model's price.
			.replace(/^(deepseek-.*)-\d{4}(\d{4})?$/i, "$1")
			.toLowerCase()
			.replace(/[\s._/-]/g, "")
	);
}

/**
 * Which vendor owns an id, from its spelling. The route table answers "who
 * SERVES this"; grading asks "whose MODEL is this", and a resold id keeps its
 * maker's identity — `qwen:deepseek-v4-pro` is still a DeepSeek model.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
export function vendorOf(id) {
	const tail = String(id).includes("/") ? String(id).split("/").pop() : String(id);
	const bare = String(tail).replace(/^[a-z]+:/, "");
	if (/^glm-/.test(bare)) return "Z.ai";
	if (/^deepseek-/.test(bare)) return "DeepSeek";
	if (/^qwen/.test(bare)) return "Alibaba";
	if (/^claude-/.test(bare)) return "Anthropic";
	if (String(id).startsWith("moonshotai/")) return "Moonshot";
	if (String(id).startsWith("tencent/")) return "Tencent";
	// Google ships TWO lines under one namespace, and they must not be ranked
	// against each other: `gemma-4` reads as version [4] and would outrank
	// `gemini-3.7-flash` ([3,7]), taking Flagship off the hosted line with an
	// open-weights model. `versionKey` compares numbers, so the only place to
	// stop that is here — a separate vendor bucket per line, which is what these
	// names are. Everything else Google publishes (lyria, embeddings) gets no
	// vendor and so no grade, matching the "omit beats a confident lie" rule.
	if (/^gemini/.test(bare)) return "Google";
	if (/^gemma/.test(bare)) return "Google Gemma";
	return undefined;
}

/**
 * Sort key for an id WITHIN its vendor: the version numbers in the id, most
 * significant first. `glm-5.2` → [5,2]; `qwen3.8-max` → [3,8]; `deepseek-v4-pro`
 * → [4]. Higher sorts first.
 *
 * @param {string} id
 * @returns {number[]}
 */
export function versionKey(id) {
	const tail = String(id).includes("/") ? String(id).split("/").pop() : String(id);
	const m = String(tail).match(/(\d+(?:\.\d+)*)/);
	return m ? m[1].split(".").map(Number) : [0];
}

/**
 * Anthropic's line has no version ordering to read — `opus`/`sonnet`/`haiku`
 * are a product tier, not a sequence, and `fable` is its own thing. This is the
 * one place a human ordering is unavoidable; everywhere else the vendor's own
 * numbering does the work.
 */
const ANTHROPIC_LINE = ["opus", "fable", "sonnet", "haiku"];

/**
 * Variant rank WITHIN one version. Version numbers order releases but say
 * nothing about the line-up inside a release: `deepseek-v4-pro` and
 * `deepseek-v4-flash` are both v4, and left to an alphabetical tiebreak `flash`
 * won — grading the small fast model above the vendor's own flagship.
 *
 * Lower sorts first. Unlisted names sit between the two named groups, so a new
 * variant lands mid-pack rather than silently claiming Flagship.
 *
 * Note this is NOT the "flash is Economy" rule that was rejected (and whose
 * value 0.6.1 then retired outright): it decides ORDER within a vendor, and says
 * nothing about a model's absolute capability. `deepseek-v4-flash` still
 * measured equal to `glm-5.2` on implementation work.
 *
 * @param {string} id
 * @returns {number}
 */
export function variantRank(id) {
	const s = String(id).toLowerCase();
	if (/\b(pro|max|ultra|opus)\b|-pro|-max/.test(s)) return 0;
	if (/\b(plus)\b|-plus/.test(s)) return 1;
	if (/(flash|turbo|mini|air|lite|nano)/.test(s)) return 3;
	return 2;
}

/**
 * Assign a grade per vendor from the VENDOR'S OWN ORDERING, not from a
 * benchmark score. Highest version is Flagship, next Strong, rest Specialist.
 *
 * **Why not benchlm's score, which is what this script fetches?** Because
 * within a vendor the ordering needs no eval — `glm-5.2 > glm-5.1 > glm-4.x` is
 * a fact the version number already states — and using scores there actively
 * breaks. Measured 2026-08-08: benchlm marks NEW models `estimated` and mature
 * ones `supported`, so score-ranking inverts the result (`GLM-5.1` 66.9
 * supported beat `GLM-5.2` 63.03 estimated; `Qwen3.7 Max` 71.8 beat `Qwen3.8
 * Max` 60.96). Excluding estimates instead leaves the three most-used models
 * — `glm-5.2`, `qwen3.8-max`, `claude-sonnet-5` — with no grade at all. The
 * score reflects measurement maturity as much as capability, which makes it
 * wrong for the within-vendor question and right for the CROSS-vendor one.
 *
 * So benchlm's score still ships, as its own field, for comparing across
 * vendors — the part that genuinely needs measurement. It just no longer
 * decides the grade.
 *
 * Specialist means NARROW, not weak — it is the residual ASSESSED bucket ("no
 * assessment" is expressed by omitting `grade` entirely, never by a value).
 * Economy was never assigned from the name here, because a "flash"/"turbo" id is
 * a latency and cost class, not a capability rung (`deepseek-v4-flash` measured
 * equal to `glm-5.2` on implementation work) — and 0.6.1 retired the value from
 * `src/models.js` for exactly that reasoning, leaving the three grades this
 * function has always emitted as the whole allowed set.
 *
 * @param {string[]} ids
 * @returns {Map<string, {grade: string, vendor: string}>} keyed by id
 */
export function gradeByVendorPosition(ids) {
	/** @type {Map<string, string[]>} */
	const byVendor = new Map();
	for (const id of ids) {
		const v = vendorOf(id);
		if (!v) continue;
		byVendor.set(v, [...(byVendor.get(v) ?? []), id]);
	}

	/** @type {Map<string, {grade: string, vendor: string}>} */
	const out = new Map();
	for (const [vendor, list] of byVendor) {
		const sorted = [...list].sort((a, b) => {
			if (vendor === "Anthropic") {
				const rank = (/** @type {string} */ id) => {
					const i = ANTHROPIC_LINE.findIndex((n) => id.includes(n));
					return i === -1 ? ANTHROPIC_LINE.length : i;
				};
				const d = rank(a) - rank(b);
				if (d !== 0) return d;
			}
			const x = versionKey(a);
			const y = versionKey(b);
			for (let i = 0; i < Math.max(x.length, y.length); i++) {
				const d = (y[i] ?? 0) - (x[i] ?? 0);
				if (d !== 0) return d;
			}
			// Same version → order by variant, not alphabetically.
			const v = variantRank(a) - variantRank(b);
			if (v !== 0) return v;
			return a.localeCompare(b);
		});

		// A model reachable under several spellings (`deepseek-v4-pro` and
		// `deepseek/deepseek-v4-pro`) is ONE model and must not occupy two rungs.
		// Rank by distinct model, then hand every spelling the same grade.
		/** @type {string[]} */
		const seen = [];
		for (const id of sorted) {
			const key = normalizeName(id);
			if (!seen.includes(key)) seen.push(key);
			const i = seen.indexOf(key);
			const grade = i === 0 ? "Flagship" : i === 1 ? "Strong" : "Specialist";
			out.set(id, { grade, vendor });
		}
	}
	return out;
}

/**
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<any>}
 */
async function fetchJson(url, headers = {}) {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return res.json();
}

/**
 * Build the grades table. Exported so a test can drive it without network by
 * passing both payloads in.
 *
 * @param {{models: Array<any>}} benchlm
 * @param {{data: Array<any>}} openrouter
 * @param {string[]} ids  ids to publish (the proxy's curated set)
 * @returns {{fetched_at: string, attribution: string, source: object, models: Record<string, object>}}
 */
export function buildGrades(benchlm, openrouter, ids, now = new Date().toISOString()) {
	// Grade from the vendor's own ordering (needs no eval); benchlm's score
	// rides along as a separate field for the cross-vendor question.
	const graded = gradeByVendorPosition(ids);

	/** @type {Map<string, {score: number, evidence: string}>} */
	const scored = new Map();
	for (const r of benchlm.models ?? []) {
		if (typeof r?.overallScore !== "number") continue;
		scored.set(normalizeName(r.model), {
			score: r.overallScore,
			evidence: r.evidenceStatus === "supported" ? "measured" : "estimated",
		});
	}

	/** @type {Map<string, {input: number|null, output: number|null}>} */
	const priced = new Map();
	for (const m of openrouter.data ?? []) {
		if (!m?.id) continue;
		const p = m.pricing ?? {};
		// OpenRouter prices per token as decimal strings; publish per MILLION
		// tokens to match how every vendor page quotes it.
		/** @param {unknown} v @returns {number|null} */
		const perM = (v) => {
			const n = Number(v);
			return Number.isFinite(n) ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
		};
		// OpenRouter's `context_length` is deliberately NOT carried: it would be
		// dead weight here — gradeOf()/loadRefreshedGrades() never read it, and
		// the /v1/models `context_window` field is curated in src/models.js, not
		// sourced from this fetch (audit note, issue #52).
		priced.set(normalizeName(m.id), {
			input: perM(p.prompt),
			output: perM(p.completion),
		});
	}

	/** @type {Record<string, object>} */
	const models = {};
	for (const id of ids) {
		const key = normalizeName(id);
		// gradeByVendorPosition keys by the RAW id (a vendor's ordering is read
		// from the id's own spelling); score and price key by normalized name.
		const g = graded.get(id);
		const p = priced.get(key);
		/** @type {Record<string, any>} */
		const entry = {};
		// OMIT rather than default — a consumer must be able to tell "ungraded"
		// from "graded Specialist" with `"grade" in entry`.
		if (g) {
			entry.grade = g.grade;
			entry.vendor = g.vendor;
		}
		// The benchmark score is a SEPARATE axis from the grade: grade says where
		// a model sits in its own vendor's line-up, score says how it compares
		// across vendors. `evidence` distinguishes a measurement from benchlm's
		// own estimate, so a consumer can weight it — a new model is usually
		// estimated, and that is exactly when the number deserves less trust.
		const s = scored.get(key);
		if (s) {
			entry.score = s.score;
			entry.evidence = s.evidence;
		}
		if (p && (p.input !== null || p.output !== null)) {
			entry.input_price = p.input;
			entry.output_price = p.output;
		}
		models[id] = entry;
	}

	return {
		fetched_at: now,
		attribution: ATTRIBUTION,
		source: { capability: BENCHLM_URL, price: OPENROUTER_URL },
		models,
	};
}

async function main() {
	const { MODEL_GRADES } = await import("../src/models.js");
	const ids = Object.keys(MODEL_GRADES);

	// Fail loudly and write nothing on a bad fetch. A stale grades.json is
	// useful; a silently-empty one is a lie that outlives the outage.
	const [benchlm, openrouter] = await Promise.all([
		fetchJson(BENCHLM_URL),
		fetchJson(
			OPENROUTER_URL,
			process.env.OPENROUTER_API_KEY
				? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
				: {},
		),
	]);

	const out = buildGrades(benchlm, openrouter, ids);
	// bench-speed.js's `appendFileSync` (JSONL) is a different case — a torn
	// append only corrupts one LINE, and no reader depends on the whole file
	// parsing — and is left as-is.
	writeGradesFile(OUT_DIR, OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);

	const gradedCount = Object.values(out.models).filter((m) => "grade" in m).length;
	const scoredCount = Object.values(out.models).filter((m) => "score" in m).length;
	const rows = Object.entries(out.models)
		.map(([id, entry]) => {
			const m = /** @type {Record<string, any>} */ (entry);
			const g = "grade" in m ? m.grade : "—";
			const s = "score" in m ? `${m.score}${m.evidence === "estimated" ? "~" : " "}` : "—";
			const price = "input_price" in m ? `$${m.input_price}/$${m.output_price}` : "—";
			return `  ${id.padEnd(28)} ${String(g).padEnd(11)} ${String(s).padEnd(8)} ${price}`;
		})
		.join("\n");

	console.log(`cc-proxy grades → ${OUT_PATH}`);
	console.log(`  ${gradedCount}/${ids.length} graded, ${scoredCount}/${ids.length} scored\n`);
	console.log(`  ${"id".padEnd(28)} ${"grade".padEnd(11)} ${"score".padEnd(8)} $in/$out per Mtok`);
	console.log(rows);
	console.log(`\n  ${ATTRIBUTION}`);
	console.log("  grade  = position in the model's OWN vendor line-up (from its version).");
	console.log("  score  = cross-vendor capability; `~` marks benchlm's estimate, not a");
	console.log("           measurement — new models are usually estimated.");
	console.log("  Two axes: never read one off the other. Price never lowers a grade.");
	// The file is written; the RUNNING proxy has not read it. `REFRESHED_GRADES`
	// binds once at module import (src/models.js:162) — a boot-time config read,
	// not per-request state (invariant 2). Without this line the success table
	// above reads as "done" while /v1/models keeps publishing the pre-refresh
	// grades, which is the same stale-process trap `bench speed` records
	// proxy_pid/proxy_version to catch. docs/OPERATIONS.md:87 says so too, but
	// whoever just ran this command has no reason to be in that file.
	console.log("\n  Restart the proxy for this to reach GET /v1/models — it reads");
	console.log("  grades.json at startup only.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => {
		console.error(`cc-proxy bench-grades failed: ${e.message}`);
		console.error("Nothing was written — the previous grades.json (if any) is untouched.");
		process.exit(1);
	});
}
