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

	/** gradeOf(id) as evaluated in a fresh process rooted at `home`.
	 * JSON round-trip, not a bare write: since 0.6.1 gradeOf() returns UNDEFINED
	 * for an unassessed id (there is no default), and `process.stdout.write(
	 * undefined)` throws — which would have turned every absence assertion into a
	 * subprocess crash indistinguishable from a real one. */
	async function gradeIn(home, id) {
		const url = new URL("../src/models.js", import.meta.url).href;
		const { stdout } = await execFile(
			process.execPath,
			[
				"-e",
				`import(${JSON.stringify(url)}).then(m => process.stdout.write(JSON.stringify(m.gradeOf(${JSON.stringify(id)})) ?? "undefined"))`,
			],
			{ env: { ...process.env, HOME: home } },
		);
		return JSON.parse(stdout.trim() === "undefined" ? "null" : stdout.trim());
	}

	after(() => {
		for (const h of tmpHomes) fs.rmSync(h, { recursive: true, force: true });
	});

	it("a refreshed grade overrides the built-in table", async () => {
		// glm-4.7 is Specialist in MODEL_GRADES; the refresh says Strong. The two
		// must DIFFER or the assertion passes on the fallback and proves nothing.
		const home = homeWith(
			JSON.stringify({ models: { "glm-4.7": { grade: "Strong", vendor: "Z.ai" } } }),
		);
		assert.equal(await gradeIn(home, "glm-4.7"), "Strong");
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

	// This file is written by an interruptible command and hand-editable, and its
	// contents land on a PUBLISHED field another plugin dispatches on. Before
	// 0.6.1 any non-empty string was accepted: a live proxy was made to publish
	// `"grade":"SuperDuperMax"` and `"grade":"   "` on /v1/models. Membership in
	// the allowed set is now the only way in — per ENTRY, so one bad row does not
	// void a refresh of 300 good ones.
	it("a grade outside the allowed set is skipped, not published", async () => {
		const home = homeWith(
			JSON.stringify({
				models: {
					"glm-5.2": { grade: "SuperDuperMax" },
					"glm-5.1": { grade: "   " },
					"glm-5": { grade: "" },
					// Retired in 0.6.1 — an OLD grades.json still carries it, and it must
					// not come back through the refresh door.
					"glm-4.7": { grade: "Economy" },
					// The one good row in a file full of bad ones.
					"glm-4.6": { grade: "Flagship" },
				},
			}),
		);
		assert.equal(await gradeIn(home, "glm-5.2"), "Flagship", "unknown bucket -> built-in");
		assert.equal(await gradeIn(home, "glm-5.1"), "Strong", "whitespace-only -> built-in");
		assert.equal(await gradeIn(home, "glm-5"), "Strong", "empty string -> built-in");
		assert.equal(await gradeIn(home, "glm-4.7"), "Specialist", "a retired value -> built-in");
		assert.equal(await gradeIn(home, "glm-4.6"), "Flagship", "the valid entry still applies");
	});

	// The 0.6.1 contract: no default. An id nobody assessed has NO grade, and
	// gradeOf() says so with undefined rather than a value a consumer would read
	// as a verdict. `/v1/models` then omits the key (see test/models.test.js).
	it("an id nobody has assessed gets no grade at all", async () => {
		const home = homeWith(JSON.stringify({ models: { "glm-5.2": { grade: "Strong" } } }));
		assert.equal(await gradeIn(home, "vendor/never-assessed"), null, "undefined, not a default");
	});

	// The prototype trap that already bit CONTEXT_WINDOW (0.5.1) and the renderer
	// (0.6.1): ids come from a live catalog, and this file is user-writable.
	it("an id named constructor cannot inherit from Object.prototype", async () => {
		const home = homeWith(JSON.stringify({ models: { "glm-5.2": { grade: "Strong" } } }));
		const grade = await gradeIn(home, "constructor");
		assert.equal(grade, null, `expected no grade, got: ${grade}`);
	});
});
