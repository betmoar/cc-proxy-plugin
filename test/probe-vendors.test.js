import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { judge } from "../scripts/probe-vendors.mjs";
import { guard } from "../scripts/version-guard.js";

// The probe script's verdict rule, pinned hermetically (no network). The
// script itself is the manual vendor gate; what the SUITE owns is that a
// verdict can never again be computed against a truncated body — that defect
// shipped through the 0.8.1 audit unnoticed because nothing executed this
// logic offline (issue #52).
describe("probe-vendors judge()", () => {
	it("matches on the FULL body, not a 300-char truncation", () => {
		const deep = `${"x".repeat(500)}"tool_use"`;
		assert.equal(
			judge({ status: 200, body: deep, expect: 200, bodyMatch: /"tool_use"/ }),
			true,
			"a pattern deeper than 300 chars must still match",
		);
	});

	it("fails when the pattern is genuinely absent, deep or shallow", () => {
		assert.equal(
			judge({ status: 200, body: "x".repeat(500), expect: 200, bodyMatch: /nope/ }),
			false,
		);
	});

	it("status alone decides when no bodyMatch is given", () => {
		assert.equal(judge({ status: 200, body: "", expect: 200 }), true);
		assert.equal(judge({ status: 500, body: "boom", expect: 200 }), false);
	});

	it("a status mismatch is a mismatch even with a matching body", () => {
		assert.equal(judge({ status: 403, body: '"error"', expect: 404, bodyMatch: /"error"/ }), false);
	});

	it("an absent body with a bodyMatch never passes (network results are judged elsewhere)", () => {
		assert.equal(judge({ status: 200, expect: 200, bodyMatch: /x/ }), false);
	});
});

// The case TABLE has invariants of its own that the script checks only at run
// time — and two of them exist only because a case violated them first. Pin
// them statically so a bad case is a red build, not a red manual gate.
const SOURCE = fs.readFileSync(
	path.join(import.meta.dirname, "..", "scripts", "probe-vendors.mjs"),
	"utf8",
);

describe("probe-vendors case table", () => {
	// Extract the CASES array text. A regexp over the source keeps this test
	// independent of the module's network-time side effects (loadEnv, fetches).
	const tableMatch = /const CASES = \[([\s\S]*?)\n\];/.exec(SOURCE);
	const table = tableMatch?.[1] ?? "";

	it("every non-200 expectation carries a bodyMatch", () => {
		// Mirrors the runtime guard at the bottom of the CASES block, but
		// statically: the runtime guard runs only in the manual script, never in
		// CI. Each case block is split on its `name:` so one broken case names
		// itself in the failure.
		const cases = table.split(/\n\t\{\n/).slice(1);
		assert.ok(cases.length >= 10, `expected the full case table, found ${cases.length}`);
		for (const c of cases) {
			const name = /name: "([^"]+)"/.exec(c)?.[1] ?? "(unnamed)";
			const expect = /expect: (?!200\b)(\w+|"[^"]+")/.exec(c);
			if (!expect) continue;
			assert.match(
				c,
				/bodyMatch:/,
				`case "${name}" expects ${expect[1]} without a bodyMatch — a status alone cannot tell the vendor's real objection from an unrelated one`,
			);
		}
	});

	it("the Google negative claim is measured per-path with a positive control (issue #42)", () => {
		assert.match(table, /google: \/v1\/messages/);
		assert.match(table, /google: \/v1beta\/messages/);
		assert.match(table, /google: \/v1beta\/anthropic\/v1\/messages/);
		assert.match(table, /google: \/anthropic\/v1\/messages/);
		assert.match(table, /positive control/);
		// The 404 body is EMPTY (text/html routing miss) — the bodyMatch pins the
		// shape, so a Google 404-with-JSON-error page cannot read as confirmation.
		const v1 = /google: \/v1\/messages[\s\S]*?bodyMatch: (\/[^/]*\/),/.exec(table);
		assert.ok(v1, "the /v1/messages case must pin the empty-body shape");
		assert.equal(
			new RegExp(v1[1].slice(1, -1)).test("any content"),
			false,
			"must reject non-empty bodies",
		);
	});

	it("the keyless positive control stays keyless (no key gate)", () => {
		// The control is the LAST case, so it runs to the captured table's end.
		const control = /google: the generateContent path[\s\S]*$/.exec(table)?.[0] ?? "";
		assert.ok(control, "control case not found");
		assert.doesNotMatch(control, /\n\s*key:/, "the control must run without a key gate");
	});
});

// The release-tag guard (issue #41): `pnpm version` on a feature branch tags
// a commit the squash-merge discards. The decision table is measured against
// the real managers (see scripts/version-guard.js header) — this pins it so a
// refactor cannot silently reopen the trap.
describe("version-guard decision table", () => {
	it("allows anything on main — tagging on main is the point", () => {
		assert.deepEqual(guard({ branch: "main", client: "pnpm/11", command: "" }), { ok: true });
	});

	it("allows npm off main: the repo .npmrc (git-tag-version=false) disarms its tag", () => {
		assert.deepEqual(
			guard({ branch: "feat/x", client: "npm/10.9.3 node/v22", command: "npm version patch" }),
			{ ok: true },
		);
	});

	it("refuses pnpm off main without --no-git-tag-version (it ignores .npmrc — measured)", () => {
		const r = guard({
			branch: "feat/x",
			client: "pnpm/11.3.0",
			command: "corepack pnpm version patch",
		});
		assert.equal(r.ok, false);
		assert.match(r.reason, /issue #41/);
	});

	it("allows pnpm off main WITH --no-git-tag-version", () => {
		assert.deepEqual(
			guard({
				branch: "feat/x",
				client: "pnpm/11.3.0",
				command: "corepack pnpm version patch --no-git-tag-version",
			}),
			{ ok: true },
		);
	});

	it("fails safe: an unknown client off main needs the flag", () => {
		assert.equal(guard({ branch: "feat/x", client: "", command: "" }).ok, false);
	});
});
