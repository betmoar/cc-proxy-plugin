import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractSection, gate } from "../scripts/release-gate.mjs";

// The gate runs against a throwaway repo fixture, NOT the real files — so this
// suite stays green across version bumps. It pins the release-time coupling:
// tag == plugin.json == package.json == newest CHANGELOG heading, and that the
// emitted notes are the tag's CHANGELOG section.

function makeRepo(root, { plugin, pkg, changelog }) {
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(root, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "cc-proxy", version: plugin }),
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "cc-proxy-plugin", version: pkg }),
	);
	writeFileSync(join(root, "CHANGELOG.md"), changelog);
}

const CHANGELOG = `# Changelog

## [0.3.3] — 2026-07-09

Hardening release.

### Added
- Marketplace + release infra.

[0.3.3]: https://example/compare/v0.3.2...v0.3.3

## [0.3.2] — 2026-07-07

### Added
- Statusline reads ~/.env.
`;

describe("release-gate", () => {
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-proxy-gate-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes when tag == plugin.json == package.json == newest heading", () => {
		const root = join(dir, "ok");
		makeRepo(root, { plugin: "0.3.3", pkg: "0.3.3", changelog: CHANGELOG });
		const { problems, notes } = gate(root, "v0.3.3");
		assert.deepEqual(problems, []);
		assert.match(notes, /Hardening release/);
		assert.match(notes, /Marketplace \+ release infra/);
		assert.doesNotMatch(notes, /0\.3\.2/, "notes must not bleed into the next section");
	});

	it("rejects a malformed tag", () => {
		const root = join(dir, "badtag");
		makeRepo(root, { plugin: "0.3.3", pkg: "0.3.3", changelog: CHANGELOG });
		const { problems } = gate(root, "0.3.3");
		assert.equal(problems.length, 1);
		assert.match(problems[0], /not v<x\.y\.z>/);
	});

	it("fails when the tag does not match plugin.json", () => {
		const root = join(dir, "plugin-drift");
		makeRepo(root, { plugin: "0.3.2", pkg: "0.3.3", changelog: CHANGELOG });
		const { problems } = gate(root, "v0.3.3");
		assert.ok(problems.some((p) => /plugin\.json version/.test(p)));
	});

	it("fails when plugin.json and package.json disagree with the tag", () => {
		const root = join(dir, "pkg-drift");
		makeRepo(root, { plugin: "0.3.3", pkg: "0.3.2", changelog: CHANGELOG });
		const { problems } = gate(root, "v0.3.3");
		assert.ok(problems.some((p) => /package\.json version/.test(p)));
	});

	it("fails when the tag version is not the newest CHANGELOG heading", () => {
		const root = join(dir, "not-newest");
		makeRepo(root, { plugin: "0.3.2", pkg: "0.3.2", changelog: CHANGELOG });
		const { problems } = gate(root, "v0.3.2");
		assert.ok(problems.some((p) => /newest CHANGELOG heading/.test(p)));
	});

	it("fails when the CHANGELOG section is empty", () => {
		const root = join(dir, "empty-section");
		const emptyChangelog = `# Changelog

## [0.4.0] — 2026-07-10

## [0.3.3] — 2026-07-09
- something
`;
		makeRepo(root, { plugin: "0.4.0", pkg: "0.4.0", changelog: emptyChangelog });
		const { problems } = gate(root, "v0.4.0");
		assert.ok(problems.some((p) => /section for \[0\.4\.0\] is empty/.test(p)));
	});

	it("extractSection returns only the requested version's body", () => {
		const body = extractSection(CHANGELOG, "0.3.3");
		assert.match(body, /Hardening release/);
		assert.doesNotMatch(body, /Statusline reads/);
	});
});
