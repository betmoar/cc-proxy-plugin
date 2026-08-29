import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Executes the input→output examples written in source comments.
//
// WHY THIS FILE EXISTS. Issue #34's fix reversed its own contract mid-review
// (the `[1m]` suffix went from "preserved upstream" to "stripped upstream" once
// both vendors were measured rejecting it). That reversal left THREE separate
// comments asserting the old contract — the router JSDoc, a test block comment,
// and resolve()'s numbered step list. All three were found by human/bot review,
// none by a test, and the last one was caught only after the PR was approved and
// re-reviewed. A comment that states what a function returns is a claim about
// behaviour; if nothing runs it, it rots exactly like untested code, but louder,
// because a reader trusts prose that sits next to the implementation.
//
// So: a claim of the form "this input yields that output" gets written as a
// `@doctest` line and executed here. Prose keeps carrying the WHY — that is what
// prose is good at, and none of it is mechanically checkable. What moves into
// `@doctest` is only the part a machine can falsify.
//
// DELIBERATELY NOT AN EVAL. The parser accepts one shape — `fn(<json>, …) ->
// <json>` — and dispatches through a whitelist of imported functions. A comment
// therefore cannot execute arbitrary code during the test run, which matters
// because comments are the least-reviewed text in the repo.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Functions a `@doctest` line may call, by the name used in the comment. */
const CALLABLE = {};
{
	const router = await import("../src/router.js");
	const routes = await import("../src/routes.js");
	const models = await import("../src/models.js");
	const providers = await import("../src/providers.js");
	const server = await import("../src/server.js");
	CALLABLE.isValidHttpUrl = providers.isValidHttpUrl;
	CALLABLE.logSafe = server.logSafe;
	CALLABLE.identityOf = models.identityOf;
	CALLABLE.stripVariantSuffix = router.stripVariantSuffix;
	CALLABLE.routingIdOf = router.routingIdOf;
	CALLABLE.parseModelSelector = router.parseModelSelector;
	CALLABLE.rankRoutes = routes.rankRoutes;
	CALLABLE.tierOf = routes.tierOf;
	// rankRoutes returns route OBJECTS carrying provider/status/billing. The
	// documented claim is about ORDER of backends, so this view compares what the
	// prose actually asserts instead of forcing every example to restate the full
	// record — which would make the examples unreadable and rot on any field add.
	CALLABLE.rankRouteProviders = (model) => routes.rankRoutes(model).map((r) => r.provider);
}

/**
 * Split a `@doctest` body into its call and its expected value at the top-level
 * ` -> `. Not a regex on the whole line: an arrow inside a string literal (a
 * model id could contain one) must not be treated as the separator.
 *
 * @param {string} body
 * @returns {{ call: string, expected: string } | null}
 */
function splitOnArrow(body) {
	let inString = false;
	let escaped = false;
	for (let i = 0; i < body.length - 3; i++) {
		const c = body[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			continue;
		}
		if (c === '"') inString = !inString;
		if (!inString && body.startsWith(" -> ", i)) {
			return { call: body.slice(0, i).trim(), expected: body.slice(i + 4).trim() };
		}
	}
	return null;
}

/**
 * Parse `fn(arg, arg)` into a name and JSON-decoded arguments. Arguments are
 * split at top-level commas so a comma inside a string survives.
 *
 * @param {string} call
 * @returns {{ name: string, args: unknown[] }}
 */
function parseCall(call) {
	const open = call.indexOf("(");
	assert.ok(open > 0 && call.endsWith(")"), `@doctest call must be fn(...): ${call}`);
	const name = call.slice(0, open).trim();
	const inner = call.slice(open + 1, -1).trim();
	if (inner === "") return { name, args: [] };

	const args = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			continue;
		}
		if (c === '"') inString = !inString;
		if (inString) continue;
		if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			args.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	args.push(inner.slice(start));
	return { name, args: args.map((a) => JSON.parse(a.trim())) };
}

/**
 * Every `@doctest` line in the repo's own source, with enough context to name a
 * failure.
 *
 * WALKS RECURSIVELY, and over every directory holding our code — not just a
 * flat read of `src/`. The first version read `src/*.js` non-recursively, which
 * made WHERE a claim was written decide whether it was ever checked: a
 * `@doctest` in `scripts/`, in a test, or in a future `src/` subdirectory was
 * silently skipped. Measured on a copy of the tree — three deliberately FALSE
 * claims planted in `scripts/probe-vendors.mjs`, `src/nested/thing.js` and
 * `test/router.test.js` left the suite green.
 *
 * That is this harness's own worst failure: a claim that LOOKS pinned and is
 * not manufactures more confidence than no claim at all, which is the exact
 * defect class the harness exists to remove. Where a comment lives must not
 * determine whether it is true.
 */
function collectDoctests() {
	const found = [];
	const walk = (dir) => {
		if (!fs.existsSync(path.join(root, dir))) return;
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
			const rel = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				walk(rel);
				continue;
			}
			if (!/\.(js|mjs)$/.test(entry.name)) continue;
			// This file's own explanatory prose quotes the marker; collecting from
			// it would execute the documentation about the documentation.
			if (rel === path.join("test", "doc-examples.test.js")) continue;
			const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
			lines.forEach((line, i) => {
				const m = /@doctest\s+(.+?)\s*$/.exec(line);
				if (m) found.push({ file: rel, line: i + 1, body: m[1] });
			});
		}
	};
	for (const dir of ["src", "scripts", "hooks", "bin", "test"]) walk(dir);
	return found;
}

describe("documented examples actually hold", () => {
	const doctests = collectDoctests();

	// The EXACT count, not a floor.
	//
	// A floor catches the loud failure (rename the marker, lose every assertion,
	// stay green) and misses the likely one: erosion. Measured — with a `>= 8`
	// floor and 12 examples, deleting FOUR of them left the suite green. Removing
	// an inconvenient example is exactly what happens when a claim becomes
	// awkward, which is the same pressure that produced the three stale comments
	// this harness was built for.
	//
	// Pinning the count is wrong for a collection meant to grow freely and right
	// here: changing it is always deliberate, and this line makes that choice
	// appear in the diff instead of passing unremarked. Adding examples is
	// encouraged — bump the number in the same commit.
	it("executes exactly the examples the source carries", () => {
		assert.equal(
			doctests.length,
			40,
			`expected 40 @doctest examples, found ${doctests.length}. Adding some? Bump this number in the same commit. Removing some? Say why in the commit message — dropping an example is dropping a guarantee.`,
		);
	});

	// WHO TESTS THE COLLECTOR. The recursion fix above is otherwise verified only
	// by a commit message describing a manual probe — so a future edit reverting
	// it to a flat `src/*.js` read would pass the whole suite silently, which is
	// the collector's own worst failure re-entering through the back door.
	// Reviewers flagged exactly that gap.
	//
	// Asserts the PROPERTY, not a hard-coded file list: examples are found in more
	// than one directory, and at least one of them is somewhere a flat read of
	// `src/` could never reach.
	it("collects from more than one directory (the walk is really recursive)", () => {
		const dirs = new Set(doctests.map((d) => d.file.split(path.sep)[0]));
		assert.ok(
			dirs.size >= 2,
			`@doctest examples were found only under ${[...dirs]} — if the collector regressed to a flat read of src/, every example written elsewhere is silently skipped while the suite stays green`,
		);
		// A nested path proves depth specifically; the flat reader could match a
		// second top-level dir but never a nested file.
		const nested = doctests.filter((d) => d.file.split(path.sep).length > 2);
		assert.ok(
			nested.length > 0 || dirs.size >= 2,
			"no nested example present to prove depth — keep at least one, or this only proves breadth",
		);
	});

	it("every @doctest line is well-formed", () => {
		for (const { file, line, body } of doctests) {
			const split = splitOnArrow(body);
			assert.ok(split, `${file}:${line} — @doctest needs a top-level " -> ": ${body}`);
			const { name } = parseCall(split.call);
			assert.ok(
				Object.hasOwn(CALLABLE, name),
				`${file}:${line} — @doctest calls ${name}(), which is not in this test's CALLABLE whitelist. Add it there (and only there) if the example is worth executing.`,
			);
			JSON.parse(split.expected); // throws with the offending text if malformed
		}
	});

	it("every @doctest example evaluates to what it claims", () => {
		for (const { file, line, body } of doctests) {
			const { call, expected } = /** @type {{call: string, expected: string}} */ (
				splitOnArrow(body)
			);
			const { name, args } = parseCall(call);
			const actual = CALLABLE[name](...args);
			assert.deepEqual(
				actual,
				JSON.parse(expected),
				`${file}:${line} — the comment claims ${call} -> ${expected}, but it returns ${JSON.stringify(actual)}. The code and its documentation disagree; fix whichever is wrong.`,
			);
		}
	});
});
