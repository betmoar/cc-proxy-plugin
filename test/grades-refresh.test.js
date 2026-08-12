import { strict as assert } from "node:assert";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// `/cc-proxy:bench grades` writes ~/.claude/cc-proxy/grades.json, and gradeOf()
// reads it at STARTUP so a refresh actually reaches `GET /v1/models`. Before
// 0.6.1 nothing read that file: discovery kept publishing the built-in table
// while the command showed the operator a different one (measured 2026-08-12:
// they disagreed on 13 of 24 ids). cc-operator dispatches on the published
// field, so the refresh was a dead end.
//
// The load happens once at module import, so each case runs in a SUBPROCESS
// with its own HOME — the module cache would otherwise pin whatever the first
// test wrote. That also keeps the suite off the developer's real grades.json.
describe("grade refresh (bench grades -> gradeOf)", () => {
	const tmpHomes = [];

	/** A throwaway HOME with the given grades.json content (or none). */
	function homeWith(content) {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-grades-"));
		tmpHomes.push(home);
		if (content !== undefined) {
			const dir = path.join(home, ".claude", "cc-proxy");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "grades.json"), content);
		}
		return home;
	}

	/** gradeOf(id) as evaluated in a fresh process rooted at `home`. */
	async function gradeIn(home, id) {
		const url = new URL("../src/models.js", import.meta.url).href;
		const { stdout } = await execFile(
			process.execPath,
			[
				"-e",
				`import(${JSON.stringify(url)}).then(m => process.stdout.write(m.gradeOf(${JSON.stringify(id)})))`,
			],
			{ env: { ...process.env, HOME: home } },
		);
		return stdout.trim();
	}

	after(() => {
		for (const h of tmpHomes) fs.rmSync(h, { recursive: true, force: true });
	});

	it("a refreshed grade overrides the built-in table", async () => {
		// glm-4.7 is Economy in MODEL_GRADES; the refresh says Specialist.
		const home = homeWith(
			JSON.stringify({ models: { "glm-4.7": { grade: "Specialist", vendor: "Z.ai" } } }),
		);
		assert.equal(await gradeIn(home, "glm-4.7"), "Specialist");
	});

	it("an id absent from the refresh still gets its built-in grade", async () => {
		const home = homeWith(JSON.stringify({ models: { "glm-4.7": { grade: "Specialist" } } }));
		assert.equal(await gradeIn(home, "glm-5.2"), "Flagship", "built-in survives a partial refresh");
	});

	it("no grades.json at all falls back to the built-in table", async () => {
		assert.equal(await gradeIn(homeWith(undefined), "glm-5.2"), "Flagship");
	});

	// Discovery must keep answering whatever state the file is in: it is written
	// by a command that can be interrupted mid-write, and it lives in a directory
	// the user can edit by hand.
	it("malformed JSON falls back silently rather than throwing", async () => {
		assert.equal(await gradeIn(homeWith("{ not json"), "glm-5.2"), "Flagship");
	});

	it("a valid file with a junk shape falls back", async () => {
		assert.equal(
			await gradeIn(homeWith(JSON.stringify({ models: "nope" })), "glm-5.2"),
			"Flagship",
		);
	});

	it("a single malformed entry is skipped, not the whole file", async () => {
		const home = homeWith(
			JSON.stringify({
				models: { "glm-5.2": { grade: 42 }, "glm-4.7": { grade: "Flagship" } },
			}),
		);
		assert.equal(await gradeIn(home, "glm-5.2"), "Flagship", "junk grade -> built-in");
		assert.equal(await gradeIn(home, "glm-4.7"), "Flagship", "good entry still applied");
	});

	// The prototype trap that already bit CONTEXT_WINDOW (0.5.1) and the renderer
	// (0.6.1): ids come from a live catalog, and this file is user-writable.
	it("an id named constructor cannot inherit from Object.prototype", async () => {
		const home = homeWith(JSON.stringify({ models: { "glm-5.2": { grade: "Strong" } } }));
		const grade = await gradeIn(home, "constructor");
		assert.equal(grade, "Specialist", `expected the default, got: ${grade}`);
	});
});
