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
	CALLABLE.stripVariantSuffix = router.stripVariantSuffix;
	CALLABLE.routingIdOf = router.routingIdOf;
	CALLABLE.parseModelSelector = router.parseModelSelector;
	CALLABLE.rankRoutes = routes.rankRoutes;
	CALLABLE.tierOf = routes.tierOf;
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

/** Every `@doctest` line in src/, with enough context to name a failure. */
function collectDoctests() {
	const found = [];
	for (const file of fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js"))) {
		const rel = path.join("src", file);
		const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
		lines.forEach((line, i) => {
			const m = /@doctest\s+(.+?)\s*$/.exec(line);
			if (m) found.push({ file: rel, line: i + 1, body: m[1] });
		});
	}
	return found;
}

describe("documented examples actually hold", () => {
	const doctests = collectDoctests();

	// A silently-empty harness is the failure mode this whole file exists to
	// prevent: rename the marker, lose every assertion, stay green.
	it("finds the @doctest examples (the harness is wired)", () => {
		assert.ok(
			doctests.length >= 8,
			`expected @doctest examples in src/, found ${doctests.length} — did the marker get renamed?`,
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
