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
	 *
	 * Reports `typeof` alongside the value, and does NOT route the value through
	 * JSON.stringify. That serializer maps BOTH `undefined` and a function to the
	 * JS value `undefined`, so a leaked `Object.prototype` member arrived here
	 * spelled exactly like a legitimate absence — measured 2026-08-12: dropping
	 * the `Object.hasOwn` guard in gradeOf() made `gradeOf("constructor")` return
	 * `function Object() { … }` while the test named for that exact leak still
	 * passed. A grade is always a string, so anything else is a defect and the
	 * type is what proves which one. */
	async function gradeInfo(home, id) {
		const url = new URL("../src/models.js", import.meta.url).href;
		const { stdout } = await execFile(
			process.execPath,
			[
				"-e",
				`import(${JSON.stringify(url)}).then(m => { const g = m.gradeOf(${JSON.stringify(id)}); process.stdout.write(JSON.stringify({ type: typeof g, value: typeof g === "string" ? g : String(g) })); })`,
			],
			{ env: { ...process.env, HOME: home } },
		);
		return JSON.parse(stdout.trim());
	}

	/** The grade string, or null when the id is unassessed. Fails loudly on any
	 * other type rather than flattening it to "no grade" the way JSON did. */
	async function gradeIn(home, id) {
		const { type, value } = await gradeInfo(home, id);
		assert.ok(
			type === "string" || type === "undefined",
			`gradeOf(${id}) returned a ${type} (${value}) — a grade is a string or absent`,
		);
		return type === "string" ? value : null;
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
		assert.equal(await gradeIn(home, "glm-5.3"), "Flagship", "built-in survives a partial refresh");
	});

	it("no grades.json at all falls back to the built-in table", async () => {
		assert.equal(await gradeIn(homeWith(undefined), "glm-5.3"), "Flagship");
	});

	// Discovery must keep answering whatever state the file is in: it is written
	// by a command that can be interrupted mid-write, and it lives in a directory
	// the user can edit by hand.
	it("malformed JSON falls back silently rather than throwing", async () => {
		assert.equal(await gradeIn(homeWith("{ not json"), "glm-5.3"), "Flagship");
	});

	it("a valid file with a junk shape falls back", async () => {
		assert.equal(
			await gradeIn(homeWith(JSON.stringify({ models: "nope" })), "glm-5.3"),
			"Flagship",
		);
	});

	it("a single malformed entry is skipped, not the whole file", async () => {
		const home = homeWith(
			JSON.stringify({
				models: { "glm-5.3": { grade: 42 }, "glm-4.7": { grade: "Flagship" } },
			}),
		);
		assert.equal(await gradeIn(home, "glm-5.3"), "Flagship", "junk grade -> built-in");
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
					"glm-5.3": { grade: "SuperDuperMax" },
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
		assert.equal(await gradeIn(home, "glm-5.3"), "Flagship", "unknown bucket -> built-in");
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
	// Asserts the TYPE, not just "no grade". Both lookups gradeOf() performs are
	// guarded by Object.hasOwn; drop either and the id inherits a function off
	// Object.prototype. Through a JSON round-trip that function was spelled
	// `undefined`, i.e. identical to a legitimate absence — so the guard could be
	// deleted with the suite still green (measured 2026-08-12). gradeInfo()
	// reports typeof from inside the subprocess, where the value is still real.
	for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
		it(`an id named ${id} cannot inherit from Object.prototype`, async () => {
			const home = homeWith(JSON.stringify({ models: { "glm-5.2": { grade: "Strong" } } }));
			const { type, value } = await gradeInfo(home, id);
			assert.equal(type, "undefined", `gradeOf(${id}) leaked a ${type}: ${value}`);
		});
	}

	// D3: readFileSync on a FIFO/socket/device BLOCKS waiting for a writer,
	// which the try/catch around it cannot stop — a stopped throw does not stop
	// a block. This ran at module load (loadRefreshedGrades() is called at top
	// level), so hitting it hangs the entire proxy boot: ECONNREFUSED for every
	// session, since proxy-lifecycle.js's SessionStart hook never sees it come
	// up. Regression for the statSync().isFile() guard. Skipped where mkfifo is
	// unavailable, and bounded so a broken fix hangs the TEST, not the suite.
	it("a non-regular file (FIFO) at grades.json does not hang module load", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-grades-fifo-"));
		tmpHomes.push(home);
		const dir = path.join(home, ".claude", "cc-proxy");
		fs.mkdirSync(dir, { recursive: true });
		const fifoPath = path.join(dir, "grades.json");
		try {
			await execFile("mkfifo", [fifoPath]);
		} catch {
			// mkfifo unavailable in this environment — skip rather than fail;
			// this is an environment limitation, not a regression.
			return;
		}
		try {
			const url = new URL("../src/models.js", import.meta.url).href;
			await execFile(
				process.execPath,
				["-e", `import(${JSON.stringify(url)}).then(() => process.stdout.write("ok"))`],
				{ env: { ...process.env, HOME: home }, timeout: 5000 },
			);
		} finally {
			fs.rmSync(fifoPath, { force: true });
		}
	});
});
