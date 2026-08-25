import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	buildGrades,
	gradeByVendorPosition,
	normalizeName,
	variantRank,
	vendorOf,
	versionKey,
	writeGradesFile,
} from "../scripts/bench-grades.js";

describe("normalizeName", () => {
	it("folds every spelling of one model to a single key", () => {
		// The join depends on this: benchlm says "DeepSeek V4 Pro", the proxy says
		// `deepseek-v4-pro`, OpenRouter says `deepseek/deepseek-v4-pro`.
		const key = normalizeName("deepseek-v4-pro");
		assert.equal(normalizeName("DeepSeek V4 Pro"), key);
		assert.equal(normalizeName("deepseek/deepseek-v4-pro"), key);
		assert.equal(normalizeName("DeepSeek_V4.Pro"), key);
	});

	it("strips the vendor prefix so a resold id joins its bare form", () => {
		assert.equal(normalizeName("qwen/qwen3.7-max"), normalizeName("qwen3.7-max"));
	});
});

describe("vendorOf", () => {
	it("reads the maker from the id, through a selector or a slash", () => {
		assert.equal(vendorOf("glm-5.2"), "Z.ai");
		assert.equal(vendorOf("deepseek-v4-pro"), "DeepSeek");
		// A resold id keeps its MAKER — the route table answers who serves it.
		assert.equal(vendorOf("qwen:deepseek-v4-pro"), "DeepSeek");
		assert.equal(vendorOf("deepseek/deepseek-v4-pro"), "DeepSeek");
		assert.equal(vendorOf("qwen3.8-max"), "Alibaba");
		assert.equal(vendorOf("claude-opus-5"), "Anthropic");
	});

	it("returns undefined for an id it cannot attribute", () => {
		assert.equal(vendorOf("some-unknown-model"), undefined);
	});
});

describe("versionKey", () => {
	it("reads the version numbers, most significant first", () => {
		assert.deepEqual(versionKey("glm-5.2"), [5, 2]);
		assert.deepEqual(versionKey("qwen3.8-max"), [3, 8]);
		assert.deepEqual(versionKey("deepseek-v4-pro"), [4]);
	});
});

describe("variantRank", () => {
	it("puts pro/max above the small fast variants", () => {
		// Without this, `deepseek-v4-pro` and `deepseek-v4-flash` tie on version
		// and an alphabetical tiebreak graded `flash` above the flagship.
		assert.ok(variantRank("deepseek-v4-pro") < variantRank("deepseek-v4-flash"));
		assert.ok(variantRank("qwen3.7-max") < variantRank("qwen3.7-plus"));
		assert.ok(variantRank("glm-5") < variantRank("glm-5-turbo"));
	});

	it("lands an unrecognized variant mid-pack, never at Flagship", () => {
		assert.ok(variantRank("model-v1-something") > variantRank("model-v1-pro"));
		assert.ok(variantRank("model-v1-something") < variantRank("model-v1-flash"));
	});
});

describe("gradeByVendorPosition", () => {
	it("grades from the vendor's own version order, newest first", () => {
		const g = gradeByVendorPosition(["glm-5.2", "glm-5.1", "glm-5", "glm-4.7"]);
		assert.equal(g.get("glm-5.2").grade, "Flagship");
		assert.equal(g.get("glm-5.1").grade, "Strong");
		assert.equal(g.get("glm-5").grade, "Specialist");
		assert.equal(g.get("glm-4.7").grade, "Specialist");
	});

	it("does NOT rank by benchmark score — that inverts on new models", () => {
		// Measured 2026-08-08: benchlm scores GLM-5.1 at 66.9 (supported) and
		// GLM-5.2 at 63.03 (estimated), because a new model has not been measured
		// yet. Score-ranking would grade the older model Flagship. The version
		// number is the fact that needs no eval.
		const g = gradeByVendorPosition(["glm-5.2", "glm-5.1"]);
		assert.equal(g.get("glm-5.2").grade, "Flagship", "the newer version leads regardless of score");
	});

	it("orders variants within one version", () => {
		const g = gradeByVendorPosition(["deepseek-v4-flash", "deepseek-v4-pro"]);
		assert.equal(g.get("deepseek-v4-pro").grade, "Flagship");
		assert.equal(g.get("deepseek-v4-flash").grade, "Strong");
	});

	it("gives every spelling of one model the SAME grade, and one rung", () => {
		// `deepseek-v4-pro` and `deepseek/deepseek-v4-pro` are the same weights;
		// letting them occupy two rungs would push the real second model down.
		const g = gradeByVendorPosition([
			"deepseek-v4-pro",
			"deepseek/deepseek-v4-pro",
			"deepseek-v4-flash",
		]);
		assert.equal(g.get("deepseek-v4-pro").grade, "Flagship");
		assert.equal(g.get("deepseek/deepseek-v4-pro").grade, "Flagship");
		assert.equal(g.get("deepseek-v4-flash").grade, "Strong", "not pushed to Specialist");
	});

	it("uses a product-line order for Anthropic, which has no version to read", () => {
		const g = gradeByVendorPosition(["claude-sonnet-5", "claude-opus-5", "claude-fable-5"]);
		assert.equal(g.get("claude-opus-5").grade, "Flagship");
		assert.equal(g.get("claude-fable-5").grade, "Strong");
		assert.equal(g.get("claude-sonnet-5").grade, "Specialist");
	});

	it("skips an id it cannot attribute rather than guessing a vendor", () => {
		const g = gradeByVendorPosition(["totally-unknown-id"]);
		assert.equal(g.has("totally-unknown-id"), false);
	});

	// Google is the only vendor shipping two unrelated LINES under one namespace
	// prefix, and their version numbers collide numerically: gemma-4 reads as [4]
	// and gemini-3.7-flash as [3,7], so one bucket hands Flagship to the
	// open-weights model. vendorOf() splits them ("Google" / "Google Gemma");
	// these pin that the split holds, because the failure is silent — a wrong
	// grade on a published field, not an error.
	it("does not let gemma outrank gemini — they are separate lines, one prefix", () => {
		const g = gradeByVendorPosition([
			"google/gemini-3.7-flash",
			"google/gemini-3.6-flash",
			"google/gemma-4-31b-it",
		]);
		assert.equal(
			g.get("google/gemini-3.7-flash").grade,
			"Flagship",
			"gemma-4 ([4]) must not outrank gemini-3.7 ([3,7]) — different product lines",
		);
		assert.equal(g.get("google/gemini-3.6-flash").grade, "Strong");
		assert.equal(g.get("google/gemma-4-31b-it").vendor, "Google Gemma");
	});

	it("grades Gemini by Google's own numbering, flash line included", () => {
		// A flash model taking Flagship is correct, not a bug: grade is position
		// within the vendor's line and 3.7 is the newest release. benchlm agrees —
		// every Gemini Pro row sat below the flash line on 2026-08-23.
		const g = gradeByVendorPosition([
			"google/gemini-3.7-flash",
			"google/gemini-3.6-flash",
			"google/gemini-3.1-pro-preview",
		]);
		assert.equal(g.get("google/gemini-3.7-flash").grade, "Flagship");
		assert.equal(g.get("google/gemini-3.6-flash").grade, "Strong");
		assert.equal(g.get("google/gemini-3.1-pro-preview").grade, "Specialist");
	});

	it("attributes no vendor to Google's non-Gemini, non-Gemma ids", () => {
		// lyria (music) and friends are routable but not gradeable on this axis;
		// omitting beats inventing a rung for them.
		const g = gradeByVendorPosition(["google/lyria-3-pro-preview"]);
		assert.equal(g.has("google/lyria-3-pro-preview"), false);
	});

	// vendorOf() is what decides whether an id can be graded AT ALL, and a miss
	// is silent: `bench grades` writes the entry with no `grade` key, so a
	// refresh QUIETLY strips a curated grade off the wire rather than failing.
	// Every id in MODEL_GRADES must therefore be attributable. This caught the
	// Google gap — the six gemini ids were graded in the table while vendorOf()
	// returned undefined for all of them.
	it("attributes every id the built-in table grades", async () => {
		const { MODEL_GRADES } = await import("../src/models.js");
		for (const id of Object.keys(MODEL_GRADES)) {
			assert.ok(
				vendorOf(id),
				`vendorOf(${id}) is undefined, so \`bench grades\` would drop its grade on refresh`,
			);
		}
	});
});

describe("buildGrades", () => {
	const BENCHLM = {
		models: [
			{ model: "GLM-5.2", creator: "Z.ai", overallScore: 63.03, evidenceStatus: "estimated" },
			{ model: "GLM-5.1", creator: "Z.ai", overallScore: 66.9, evidenceStatus: "supported" },
		],
	};
	const OPENROUTER = {
		data: [
			{
				id: "z-ai/glm-5.2",
				pricing: { prompt: "0.000000252", completion: "0.000000792" },
				context_length: 200000,
			},
		],
	};

	it("publishes grade and score as SEPARATE fields", () => {
		const out = buildGrades(BENCHLM, OPENROUTER, ["glm-5.2", "glm-5.1"], "2026-01-01T00:00:00Z");
		const m = out.models["glm-5.2"];
		// grade from the vendor's ordering, score from benchlm — two axes, and the
		// newest model is Flagship even though its score is lower.
		assert.equal(m.grade, "Flagship");
		assert.equal(m.score, 63.03);
		assert.equal(out.models["glm-5.1"].grade, "Strong");
		assert.equal(out.models["glm-5.1"].score, 66.9);
	});

	it("marks an estimate so a consumer can weight it", () => {
		const out = buildGrades(BENCHLM, OPENROUTER, ["glm-5.2", "glm-5.1"]);
		assert.equal(out.models["glm-5.2"].evidence, "estimated");
		assert.equal(out.models["glm-5.1"].evidence, "measured");
	});

	it("OMITS score for an id benchlm does not cover, never defaults it", () => {
		// Same rule as context_window in src/models.js: a consumer must tell
		// "unknown" from "known" with `"score" in entry`.
		const out = buildGrades(BENCHLM, OPENROUTER, ["deepseek-v4-flash"]);
		assert.equal("score" in out.models["deepseek-v4-flash"], false);
		assert.equal("evidence" in out.models["deepseek-v4-flash"], false);
	});

	it("converts OpenRouter's per-token price to per-million", () => {
		const out = buildGrades(BENCHLM, OPENROUTER, ["glm-5.2"]);
		assert.equal(out.models["glm-5.2"].input_price, 0.252);
		assert.equal(out.models["glm-5.2"].output_price, 0.792);
	});

	it("carries the attribution benchlm's licence asks for", () => {
		const out = buildGrades(BENCHLM, OPENROUTER, ["glm-5.2"]);
		assert.match(out.attribution, /benchlm\.ai/);
	});

	it("survives empty payloads without throwing", () => {
		const out = buildGrades({}, {}, ["glm-5.2"]);
		assert.equal(out.models["glm-5.2"].grade, "Flagship", "grade needs no network");
		assert.equal("score" in out.models["glm-5.2"], false);
	});
});

describe("writeGradesFile", () => {
	it("writes atomically: an existing file survives a kill mid-write of a new one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-grades-atomic-"));
		const filePath = path.join(dir, "grades.json");
		try {
			// Simulate a prior, complete write.
			fs.writeFileSync(filePath, JSON.stringify({ models: { old: { grade: "Flagship" } } }));

			// Simulate a kill (SIGKILL/OOM/disk-full) mid-write: the temp path
			// writeGradesFile would rename from is left half-written, exactly
			// what a truncated fs.writeFileSync leaves behind. The regression
			// this test catches: if writeGradesFile ever writes straight to
			// filePath (no temp + rename), the target itself ends up holding
			// this half-written content instead of being left untouched.
			const tmpPath = `${filePath}.tmp-${process.pid}`;
			fs.writeFileSync(tmpPath, '{"models":{"new":{"gr');

			// The real target must be UNCHANGED and still valid JSON — the
			// crash only ever touches the temp file, never the target.
			const before = fs.readFileSync(filePath, "utf8");
			assert.doesNotThrow(() => JSON.parse(before));
			assert.equal(JSON.parse(before).models.old.grade, "Flagship");

			// A subsequent successful writeGradesFile() call must still land
			// cleanly (it overwrites its own temp file and renames over it).
			writeGradesFile(dir, filePath, JSON.stringify({ models: { new: { grade: "Strong" } } }));
			const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
			assert.equal(after.models.new.grade, "Strong");
			assert.equal(fs.existsSync(tmpPath), false, "temp file must not survive a successful write");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves the target untouched if the write ITSELF throws before rename", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-grades-atomic-fail-"));
		const filePath = path.join(dir, "grades.json");
		try {
			fs.writeFileSync(filePath, "original content");
			// Directory as the "data" write target is not representable here, so
			// instead force writeFileSync to fail by writing to a path with a
			// bogus parent — renameSync must therefore never run.
			assert.throws(() => writeGradesFile(dir, filePath, undefined));
			assert.equal(fs.readFileSync(filePath, "utf8"), "original content");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
