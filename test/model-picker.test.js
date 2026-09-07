import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	BEHAVES_AS,
	buildRows,
	dropSupersededEnv,
	formatWindow,
	isGeneratedRow,
	labelFor,
	mergePicker,
	reachableIds,
} from "../src/model-picker.js";
import { CONTEXT_WINDOW } from "../src/models.js";

// Issue #62. Claude Code assumes a 200K window for any id its catalog does not
// describe; these rows are the only channel cc-proxy has to correct that. The
// measurement behind every assertion here (CC 2.1.263, 2026-09-07) is in
// src/model-picker.js's header — the short version: `[1m]` on the row's model
// sets the window, `behavesAs` suppresses the catalog warning, and `behavesAs`
// DISABLES CLAUDE_CODE_MAX_CONTEXT_TOKENS, so the suffix is the only window
// channel that survives on a row that also carries behavesAs.

const ALL_KEYS = {
	GLM_API_KEY: "g",
	OPENROUTER_API_KEY: "o",
	DEEPSEEK_API_KEY: "d",
	DASHSCOPE_API_KEY: "q",
	LMSTUDIO_BASE_URL: "http://x:1234",
};

describe("modelPicker row generation (issue #62)", () => {
	// THE WHOLE POINT. A curated window of 1M or more is unreachable unless the
	// row's model carries the suffix — CC caps an unsuffixed unknown id at 200K
	// regardless of anything else on the row. Drop the suffix and nine models
	// silently lose 800K of context each.
	it("suffixes exactly the ids whose curated window is 1M or more", () => {
		const rows = buildRows(ALL_KEYS);
		for (const row of rows) {
			const bare = row.model.replace(/\[1m\]$/, "");
			const window = CONTEXT_WINDOW[bare];
			assert.ok(window, `row ${row.model} names an id with no curated window`);
			assert.equal(
				row.model.endsWith("[1m]"),
				window >= 1000000,
				`${bare} has a ${window}-token window: ${window >= 1000000 ? "it needs" : "it must not carry"} the [1m] suffix, else CC ${window >= 1000000 ? "caps it at 200K" : "over-budgets it at 1M"}`,
			);
		}
		// Guard against the assertion above passing vacuously on an empty set.
		assert.equal(rows.filter((r) => r.model.endsWith("[1m]")).length, 10);
		assert.equal(rows.length, 17);
	});

	// behavesAs is what makes CC stop calling the id unknown, which is what
	// suppresses the catalog warning. A row without it renders in the picker and
	// still warns every session — measured: a row alone suppresses nothing.
	it("every row carries behavesAs, or the catalog warning survives the row", () => {
		for (const row of buildRows(ALL_KEYS)) {
			assert.equal(row.behavesAs, BEHAVES_AS, `${row.model} is missing behavesAs`);
		}
	});

	// A suffix on the behavesAs TARGET does nothing (measured: 200K). If someone
	// "fixes" BEHAVES_AS by suffixing it, the constant would look like it carries
	// the window and would not.
	it("BEHAVES_AS names a bare claude id, never a suffixed one", () => {
		assert.match(BEHAVES_AS, /^claude-[a-z0-9.-]+$/);
		assert.ok(!BEHAVES_AS.includes("["), "a [1m] on the behavesAs target is inert (measured)");
	});

	// Issue #30, sixteen times over: a row for a backend with no key names a
	// model that resolves to the default backend instead of routing.
	it("publishes only ids a registered provider can serve", () => {
		assert.deepEqual(buildRows({}), []);
		const glmOnly = reachableIds({ GLM_API_KEY: "g" });
		assert.ok(glmOnly.every((id) => id.startsWith("glm-")));
		assert.equal(glmOnly.length, 10);
		// Qwen alone reaches its own ids AND the two foreign ones the plan serves.
		const qwenOnly = reachableIds({ DASHSCOPE_API_KEY: "q" });
		assert.ok(qwenOnly.includes("deepseek-v4-flash-0731"), "the plan serves this dated build");
		assert.ok(qwenOnly.includes("glm-5.2"), "the plan serves glm-5.2 (ROUTES says 200)");
		assert.ok(!qwenOnly.includes("glm-5.3"), "the plan 400s glm-5.3 — no route, no row");
	});

	// The label is what the user picks from; it must match how the same model is
	// spelled by /v1/models and docs/models.html, or the picker looks like a
	// different catalog. Derivation alone got this wrong for the dated build.
	it("prefers the catalog's own display_name over the derived spelling", () => {
		assert.equal(labelFor("deepseek-v4-flash-0731"), "DeepSeek V4 Flash (0731)");
		assert.equal(labelFor("qwen3.8-max"), "Qwen3.8 Max");
		// Derived: GLM's live-catalog ids have no static entry to read.
		assert.equal(labelFor("glm-4.5-air"), "GLM-4.5 Air");
		assert.equal(labelFor("glm-5-turbo"), "GLM-5 Turbo");
	});

	it("marks the 1M rows in the label and the window in the description", () => {
		const rows = buildRows(ALL_KEYS);
		const oneM = rows.find((r) => r.model === "glm-5.3[1m]");
		assert.equal(oneM.label, "GLM-5.3 (1M)");
		assert.match(oneM.description, /^1M context/);
		const small = rows.find((r) => r.model === "glm-4.5");
		assert.equal(small.label, "GLM-4.5");
		assert.match(small.description, /^128K context/);
	});

	// formatWindow duplicates list-models.js formatContextWindow() to keep this
	// module free of that file's import-time loadEnv() + proxy fetch. Locked
	// against the original so the two spellings cannot drift.
	it("formatWindow agrees with list-models.js formatContextWindow", async () => {
		const { formatContextWindow } = await import("../scripts/list-models.js");
		for (const tokens of Object.values(CONTEXT_WINDOW)) {
			assert.equal(formatWindow(tokens), formatContextWindow(tokens));
		}
	});
});

describe("settings merge (issue #62)", () => {
	// modelPicker has NO cross-source merging — the highest-precedence source
	// that defines it wins outright — so a naive write silently discards rows the
	// user wrote by hand, with no diagnostic anywhere.
	it("preserves foreign rows and their positions", () => {
		const before = {
			modelPicker: {
				options: [
					{ model: "my-gateway/claude-opus-5", label: "Work gateway" },
					{ model: "glm-5.3[1m]", label: "stale" },
					{ model: "some-other/model", label: "Also mine" },
				],
			},
		};
		const after = mergePicker(before, buildRows({ GLM_API_KEY: "g" }));
		const models = after.modelPicker.options.map((r) => r.model);
		assert.equal(models[0], "my-gateway/claude-opus-5", "a foreign row lost its position");
		assert.equal(models.at(-1), "some-other/model", "a foreign row lost its position");
		assert.equal(after.modelPicker.options[0].label, "Work gateway", "a foreign row was rewritten");
		// The generated rows land where the old generated row was — between the
		// two foreign ones — not appended after them.
		assert.ok(models.slice(1, -1).every((m) => m.startsWith("glm-")));
	});

	// The docstring said "at the end" and the code puts them FIRST — a comment
	// nothing could execute, in a repo whose first trap is that a comment
	// asserting behaviour rots louder than untested code. Front is the right
	// behaviour (the generated set leads the picker); the prose was what was
	// wrong, and this is what stops either side drifting again.
	it("puts fresh rows FIRST when the user has only foreign rows", () => {
		const before = {
			modelPicker: { options: [{ model: "my-gateway/a" }, { model: "my-gateway/b" }] },
		};
		const models = mergePicker(before, buildRows({ GLM_API_KEY: "g" })).modelPicker.options.map(
			(r) => r.model,
		);
		assert.ok(models[0].startsWith("glm-"), "the generated rows did not lead");
		assert.deepEqual(models.slice(-2), ["my-gateway/a", "my-gateway/b"], "a foreign row moved");
	});

	it("replaces a previously-generated row in place rather than duplicating it", () => {
		const rows = buildRows({ GLM_API_KEY: "g" });
		const once = mergePicker({}, rows);
		const twice = mergePicker(once, rows);
		assert.deepEqual(
			twice.modelPicker.options,
			once.modelPicker.options,
			"regeneration is not idempotent",
		);
	});

	// A window crossing the 1M line changes the row's SPELLING (glm-5.3 ->
	// glm-5.3[1m]). Matching only on the exact string would leave the old
	// spelling behind, so the picker would show the model twice with two
	// different windows.
	it("replaces a row whose suffix changed, leaving no duplicate", () => {
		const before = { modelPicker: { options: [{ model: "glm-5.3", label: "old, unsuffixed" }] } };
		const after = mergePicker(before, buildRows({ GLM_API_KEY: "g" }));
		const models = after.modelPicker.options.map((r) => r.model);
		assert.ok(!models.includes("glm-5.3"), "the pre-suffix spelling survived as a duplicate");
		// EXACT, not startsWith: `glm-5.3` is a prefix of `glm-5.3-flash`, so a
		// prefix count answers a different question and reads as a merge bug.
		assert.equal(models.filter((m) => m === "glm-5.3[1m]").length, 1);
	});

	// Row ORDER is a user-visible choice (it is the order of the /model picker),
	// so a respelled row must be replaced where it sat. Matching on the exact
	// string only would drop it to the bottom with the "new" rows every time a
	// window crossed 1M — the picker silently reshuffling on a plugin update.
	it("keeps a respelled row in the position the user put it", () => {
		const before = {
			modelPicker: {
				options: [
					{ model: "glm-4.6", label: "mine first" },
					{ model: "glm-5.3", label: "mine second" },
				],
			},
		};
		const after = mergePicker(before, buildRows({ GLM_API_KEY: "g" }));
		const models = after.modelPicker.options.map((r) => r.model);
		assert.deepEqual(models.slice(0, 2), ["glm-4.6", "glm-5.3[1m]"]);
	});

	// A user who removes a key must lose those rows: a generated row for an
	// unroutable model is issue #30 again, and preserving it as "foreign" would
	// make it permanent.
	it("drops a generated row whose provider is no longer registered", () => {
		const withQwen = mergePicker({}, buildRows({ GLM_API_KEY: "g", DASHSCOPE_API_KEY: "q" }));
		assert.ok(withQwen.modelPicker.options.some((r) => r.model.startsWith("qwen3.8")));
		const glmOnly = mergePicker(withQwen, buildRows({ GLM_API_KEY: "g" }));
		assert.ok(
			!glmOnly.modelPicker.options.some((r) => r.model.startsWith("qwen")),
			"a stale row for a de-registered provider was preserved",
		);
	});

	it("never mutates the settings object it was given", () => {
		const before = { modelPicker: { options: [{ model: "glm-5.3[1m]" }] }, env: { A: "1" } };
		const snapshot = JSON.parse(JSON.stringify(before));
		mergePicker(before, buildRows({ GLM_API_KEY: "g" }));
		assert.deepEqual(before, snapshot);
	});

	it("keeps a user's replaceBuiltInOptions:true and defaults it to false otherwise", () => {
		const kept = mergePicker(
			{ modelPicker: { replaceBuiltInOptions: true, options: [] } },
			buildRows({ GLM_API_KEY: "g" }),
		);
		assert.equal(kept.modelPicker.replaceBuiltInOptions, true);
		const fresh = mergePicker({}, buildRows({ GLM_API_KEY: "g" }));
		assert.equal(fresh.modelPicker.replaceBuiltInOptions, false);
	});

	// CC rejects an options-less modelPicker object ("must be an object with an
	// options array"), and an empty array suppresses nothing while looking
	// configured. Absent is the honest state.
	it("removes the key entirely rather than writing an empty picker", () => {
		const after = mergePicker({ modelPicker: { options: [{ model: "glm-5.3[1m]" }] } }, []);
		assert.ok(!("modelPicker" in after));
	});

	it("leaves settings without a picker alone when there is nothing to publish", () => {
		const after = mergePicker({ env: { A: "1" } }, []);
		assert.deepEqual(after, { env: { A: "1" } });
	});

	it("recognizes only curated ids as generated rows", () => {
		assert.equal(isGeneratedRow({ model: "glm-5.3[1m]" }), true);
		assert.equal(isGeneratedRow({ model: "glm-4.6" }), true);
		assert.equal(isGeneratedRow({ model: "my-gateway/claude-opus-5" }), false);
		assert.equal(isGeneratedRow({ model: "claude-opus-5" }), false);
		assert.equal(isGeneratedRow(null), false);
		assert.equal(isGeneratedRow({}), false);
		assert.equal(isGeneratedRow({ model: 5 }), false);
		// Same interior rule as router.js stripVariantSuffix: a malformed id must
		// not be rewritten into a real one and then claimed.
		assert.equal(isGeneratedRow({ model: "glm-5.3[a]b]" }), false);
	});
});

describe("superseded env (issue #62)", () => {
	// With replaceBuiltInOptions:false BOTH the one-slot env and the generated
	// rows render, so keeping it duplicates whichever model it names.
	it("drops the one-slot custom model option and reports it", () => {
		const { settings, removed } = dropSupersededEnv({
			env: {
				ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
				ANTHROPIC_CUSTOM_MODEL_OPTION: "glm-5.3[1m]",
				ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "GLM-5.3 (1M)",
				ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "x",
			},
		});
		assert.deepEqual(Object.keys(settings.env), ["ANTHROPIC_BASE_URL"]);
		assert.equal(removed.length, 3);
	});

	// The global pin is the user's call — it still governs ids with no row. A
	// silent strip would change how their subagent pins and typos are budgeted.
	it("never removes CLAUDE_CODE_MAX_CONTEXT_TOKENS", () => {
		const { settings } = dropSupersededEnv({
			env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576" },
		});
		assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
	});

	it("tolerates settings with no env block", () => {
		assert.deepEqual(dropSupersededEnv({}), { settings: {}, removed: [] });
		assert.deepEqual(dropSupersededEnv({ env: null }).removed, []);
	});
});

describe("render-model-picker.js I/O", () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-picker-"));

	// A settings.json that exists but does not parse must NEVER be overwritten:
	// it holds the user's base URL, permissions and hooks, and replacing it with
	// {} over a stray comma takes all of that with it.
	it("throws on unparseable settings rather than returning an empty object", async () => {
		const { readSettings } = await import("../scripts/render-model-picker.js");
		const dir = tmp();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, "{ not json");
		assert.throws(() => readSettings(file));
		// A JSON array is valid JSON and not a settings object.
		fs.writeFileSync(file, "[]");
		assert.throws(() => readSettings(file), /JSON object/);
	});

	it("treats a missing or empty settings file as {}", async () => {
		const { readSettings } = await import("../scripts/render-model-picker.js");
		const dir = tmp();
		assert.deepEqual(readSettings(path.join(dir, "nope.json")), {});
		const empty = path.join(dir, "empty.json");
		fs.writeFileSync(empty, "  \n");
		assert.deepEqual(readSettings(empty), {});
	});

	it("backs up an existing settings file before overwriting it", async () => {
		const { writeSettings } = await import("../scripts/render-model-picker.js");
		const dir = tmp();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, '{"env":{"KEEP":"1"}}');
		writeSettings(file, { env: { KEEP: "1" }, modelPicker: { options: [] } });
		assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), { env: { KEEP: "1" } });
		assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "trailing newline");
	});

	it("writes no .bak on a fresh machine", async () => {
		const { writeSettings } = await import("../scripts/render-model-picker.js");
		const dir = tmp();
		const file = path.join(dir, "sub", "settings.json");
		writeSettings(file, { modelPicker: { options: [] } });
		assert.ok(fs.existsSync(file));
		assert.ok(!fs.existsSync(`${file}.bak`));
	});

	it("reports a global context pin without touching it", async () => {
		const { contextPin } = await import("../scripts/render-model-picker.js");
		assert.equal(contextPin({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576" } }), "1048576");
		assert.equal(contextPin({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1048576 } }), "1048576");
		assert.equal(contextPin({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "" } }), undefined);
		assert.equal(contextPin({ env: {} }), undefined);
		assert.equal(contextPin({}), undefined);
	});

	// settings.json holds the user's base URL, permissions and hooks, and a plain
	// writeFileSync opens with 'w' — TRUNCATE — so a kill in that window leaves
	// the file zero-length or half-written. tmp + rename means every reader sees
	// either the complete old file or the complete new one.
	//
	// The INODE is the assertion because it is the one observable that separates
	// the two spellings: a truncating write reuses the target's inode, a rename
	// installs the temp file's. Asserting "no .tmp survives" would NOT — the
	// pre-fix spelling leaves no temp file either, and that version of this test
	// passed against a reverted writeSettings (measured).
	it("replaces settings.json by rename, never by truncating it in place", async () => {
		const { writeSettings } = await import("../scripts/render-model-picker.js");
		const dir = tmp();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ env: { A: "1" } }));
		const before = fs.statSync(file).ino;
		writeSettings(file, { env: { A: "2" } });
		assert.notEqual(
			fs.statSync(file).ino,
			before,
			"the target was written in place — a kill mid-write would leave it truncated",
		);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { A: "2" } });
		assert.deepEqual(
			fs.readdirSync(dir).filter((f) => f.includes(".tmp-")),
			[],
			"a temp file survived a successful write",
		);
	});

	// The temp file must be a SIBLING of the target: rename() is atomic only
	// WITHIN a filesystem, and $HOME and /tmp are routinely separate mounts,
	// where a cross-device rename throws EXDEV outright. Asserting it lands in a
	// directory this call had to create pins that the temp path is derived from
	// the target rather than from os.tmpdir().
	it("stages its temp file beside the target, not in the system tmpdir", async () => {
		const { writeSettings } = await import("../scripts/render-model-picker.js");
		const nested = path.join(tmp(), "deep", "settings.json");
		writeSettings(nested, { ok: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")), { ok: true });
	});
});

// main() was unreachable from the suite until it became run(): every helper was
// tested in isolation and the ORCHESTRATION was not, so two mutations passed the
// whole suite — swapping `dropped.settings` for `settings` (the superseded env
// survives beside the new rows, and the model renders twice), and neutering the
// empty-rows refusal (a keyless user's picker is deleted outright, issue #30).
describe("render-model-picker run() (issue #62)", () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-run-"));
	const GLM = { GLM_API_KEY: "g" };

	/** run() with stdout/stderr captured. */
	async function invoke(opts) {
		const { run } = await import("../scripts/render-model-picker.js");
		let out = "";
		let err = "";
		const code = run({
			stdout: (s) => {
				out += s;
			},
			stderr: (s) => {
				err += s;
			},
			...opts,
		});
		return { code, out, err };
	}

	it("writes the rows, backs up, and reports the count", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } }),
		);
		const { code, out } = await invoke({ argv: [], file, env: GLM });
		assert.equal(code, 0);
		const written = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(written.modelPicker.options.length, 10, "the GLM rows did not land");
		assert.equal(
			written.env.ANTHROPIC_BASE_URL,
			"http://127.0.0.1:4000",
			"a foreign env key was lost",
		);
		assert.match(out, /wrote 10 modelPicker rows/);
	});

	// THE MUTATION THAT SURVIVED. With replaceBuiltInOptions:false the one-slot
	// env renders ALONGSIDE the rows, so leaving it shows the model twice.
	it("drops the superseded one-slot env from the file it writes", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: "glm-5.3[1m]", KEEP: "1" } }),
		);
		const { out } = await invoke({ argv: [], file, env: GLM });
		const written = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.ok(
			!("ANTHROPIC_CUSTOM_MODEL_OPTION" in written.env),
			"the superseded env survived next to the generated rows — the model now renders twice",
		);
		assert.equal(written.env.KEEP, "1", "an unrelated env key was dropped");
		assert.match(out, /removed superseded env/);
	});

	// THE OTHER MUTATION THAT SURVIVED. Refusing is the whole protection: a
	// merge with zero rows strips the modelPicker key, so a keyless run would
	// silently delete rows the user still wants.
	it("refuses and writes NOTHING when no provider key is registered", async () => {
		const file = path.join(tmp(), "settings.json");
		const before = JSON.stringify({ modelPicker: { options: [{ model: "glm-5.3[1m]" }] } });
		fs.writeFileSync(file, before);
		const { code, err } = await invoke({ argv: [], file, env: {} });
		assert.equal(code, 1, "a run with nothing to publish must not report success");
		assert.match(err, /no provider keys are registered/);
		assert.equal(fs.readFileSync(file, "utf8"), before, "the file was touched despite the refusal");
	});

	it("refuses and writes NOTHING when settings.json does not parse", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(file, "{ not json");
		const { code, err } = await invoke({ argv: [], file, env: GLM });
		assert.equal(code, 1);
		// "could not be read", not "as JSON": readSettings rethrows EACCES/EISDIR
		// too, and calling those a JSON problem sends the user to edit a fine file.
		assert.match(err, /could not be read \(/);
		assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "a malformed file was overwritten");
	});

	it("--dry-run prints the merged file and writes nothing", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(file, "{}");
		const { code, out } = await invoke({ argv: ["--dry-run"], file, env: GLM });
		assert.equal(code, 0);
		assert.equal(
			JSON.parse(out).modelPicker.options.length,
			10,
			"--dry-run did not print the merge",
		);
		assert.equal(fs.readFileSync(file, "utf8"), "{}", "--dry-run wrote the file");
	});

	// --print must not read settings at all: it is the flag a user reaches for
	// when their settings.json is the thing that is broken.
	it("--print prints only the rows, touching no file", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(file, "{ not json");
		const { code, out } = await invoke({ argv: ["--print"], file, env: GLM });
		assert.equal(code, 0);
		const rows = JSON.parse(out);
		assert.ok(Array.isArray(rows) && rows.length === 10);
		assert.ok(
			rows.every((r) => r.behavesAs),
			"a printed row is missing behavesAs",
		);
		assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
	});

	// Reported, never removed — it still governs every id with NO row.
	it("reports a surviving context pin and leaves it in the file", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576" } }));
		const { out } = await invoke({ argv: [], file, env: GLM });
		assert.match(out, /CLAUDE_CODE_MAX_CONTEXT_TOKENS is still set \(1048576\)/);
		const written = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(written.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576", "the pin was stripped");
	});

	it("says nothing about a pin that is not set", async () => {
		const file = path.join(tmp(), "settings.json");
		fs.writeFileSync(file, "{}");
		const { out } = await invoke({ argv: [], file, env: GLM });
		assert.doesNotMatch(out, /CLAUDE_CODE_MAX_CONTEXT_TOKENS/);
	});
});
