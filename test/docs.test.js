import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The docs were restructured in 0.10.2 because they had become a wall of text
// (a 44 KB CLAUDE.md loaded into every session, a 2,135-character bullet in
// OPERATIONS) and had drifted from the code in twenty-odd places. These locks
// keep the structure honest: every link resolves, every doc is reachable from
// the README's map, no line grows back into a paragraph, and the places where
// two docs must agree with the code or with each other are checked from the
// code side, not by hand.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const docFiles = fs
	.readdirSync(path.join(root, "docs"))
	.filter((f) => f.endsWith(".md"))
	.map((f) => `docs/${f}`);
const PROSE = ["README.md", "CONTRIBUTING.md", "CLAUDE.md", ...docFiles];
const ALL = [...PROSE, "CHANGELOG.md", "skills/setup/SKILL.md", ".env.example"];

/** GitHub-style heading slug, close enough for the anchors these docs use. */
function slug(heading) {
	return heading
		.toLowerCase()
		.replace(/[`*_]/g, "")
		.replace(/[^\w\- ]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

describe("documentation structure", () => {
	it("every relative link and #anchor in the docs resolves", () => {
		const anchors = new Map();
		for (const f of ALL) {
			if (!f.endsWith(".md")) continue;
			const set = new Set();
			for (const line of read(f).split("\n")) {
				const m = /^#+\s+(.*)$/.exec(line);
				if (m) set.add(slug(m[1]));
			}
			anchors.set(f, set);
		}
		const broken = [];
		for (const f of ALL) {
			const text = read(f);
			for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = m[1];
				if (/^https?:/.test(target)) continue;
				const [file, anchor] = target.split("#");
				const resolved = file ? path.normalize(path.join(path.dirname(f), file)) : f;
				if (file && !fs.existsSync(path.join(root, resolved))) {
					broken.push(`${f}: ${target} (file missing)`);
					continue;
				}
				if (anchor && anchors.has(resolved) && !anchors.get(resolved).has(anchor)) {
					broken.push(`${f}: ${target} (no such heading)`);
				}
			}
		}
		assert.deepEqual(broken, [], `broken links:\n  ${broken.join("\n  ")}`);
	});

	it("README's docs map links every docs/*.md", () => {
		const readme = read("README.md");
		const unlisted = docFiles.filter((f) => !readme.includes(`](${f})`));
		assert.deepEqual(unlisted, [], `not in README's docs table: ${unlisted.join(", ")}`);
	});

	// The measurable half of "not a wall of text". Prose here is hard-wrapped
	// near 80 columns; a table row can legitimately reach a few hundred. Past
	// 400 a line is a paragraph, which is the shape this restructure removed
	// (the old README had 29 of them, OPERATIONS one of 2,135 characters).
	it("no line in a prose doc exceeds 400 characters", () => {
		const long = [];
		for (const f of PROSE) {
			read(f)
				.split("\n")
				.forEach((line, i) => {
					if (line.length > 400) long.push(`${f}:${i + 1} (${line.length} chars)`);
				});
		}
		assert.deepEqual(long, [], `lines that grew back into paragraphs:\n  ${long.join("\n  ")}`);
	});

	it("ARCHITECTURE and CLAUDE.md list the same number of invariants", () => {
		const count = (file) => {
			const text = read(file);
			const start = text.indexOf("## Invariants");
			assert.ok(start >= 0, `${file} has no "## Invariants" heading`);
			const section = text.slice(start).split("\n## ")[0];
			return [...section.matchAll(/^\d+\. \*\*/gm)].length;
		};
		const claude = count("CLAUDE.md");
		assert.ok(claude >= 7, `CLAUDE.md lists ${claude} invariants — has the format changed?`);
		assert.equal(
			count("docs/ARCHITECTURE.md"),
			claude,
			"ARCHITECTURE's invariant list and CLAUDE.md's have drifted apart (invariants 6 and 7 were missing from ARCHITECTURE for two releases)",
		);
	});

	it("ARCHITECTURE's repository layout names every file in src/, hooks/, scripts/ and commands/", () => {
		const text = read("docs/ARCHITECTURE.md");
		const block = /## Repository layout\s+```([\s\S]*?)```/.exec(text);
		assert.ok(block, "ARCHITECTURE has no repository layout code block");
		const missing = [];
		for (const dir of ["src", "hooks", "scripts", "commands"]) {
			for (const name of fs.readdirSync(path.join(root, dir))) {
				if (!block[1].includes(name)) missing.push(`${dir}/${name}`);
			}
		}
		assert.deepEqual(missing, [], `files absent from the layout tree: ${missing.join(", ")}`);
	});

	it("the Provider typedef's properties appear in CONTRIBUTING's and ARCHITECTURE's Provider block", () => {
		const typedef = /@typedef \{object\} Provider([\s\S]*?)\*\//.exec(read("src/providers.js"));
		assert.ok(typedef, "could not find the Provider typedef in src/providers.js");
		const props = [...typedef[1].matchAll(/@property \{[^}]*\} \[?(\w+)\]?/g)].map((m) => m[1]);
		assert.ok(props.length >= 6, `parsed only ${props.length} Provider properties`);
		for (const doc of ["CONTRIBUTING.md", "docs/ARCHITECTURE.md"]) {
			const block = /```js\s*Provider = \{([\s\S]*?)\}\s*```/.exec(read(doc));
			assert.ok(block, `${doc} has no \`Provider = { … }\` block`);
			const absent = props.filter((p) => !new RegExp(`\\b${p}\\b`).test(block[1]));
			assert.deepEqual(absent, [], `${doc}'s Provider block lacks ${absent.join(", ")}`);
		}
	});

	it("README's routing table names every registrable provider", async () => {
		const { PROVIDER_IDS } = await import("../src/providers.js");
		const readme = read("README.md");
		const section = readme.slice(readme.indexOf("## What routes where")).split("\n## ")[0];
		const absent = [...PROVIDER_IDS].filter((id) => !new RegExp(id, "i").test(section));
		assert.deepEqual(absent, [], `README's routing table does not mention ${absent.join(", ")}`);
	});

	it("OPERATIONS says PROXY_AUTH_TOKEN gates /_shutdown", () => {
		const row = read("docs/OPERATIONS.md")
			.split("\n")
			.find((l) => l.startsWith("|") && l.includes("/_shutdown"));
		assert.ok(row, "OPERATIONS has no endpoint row for /_shutdown");
		assert.match(row, /PROXY_AUTH_TOKEN/, "the /_shutdown row must say the token gates it (#45)");
		assert.doesNotMatch(row, /no auth/);
	});

	// The setup skill tells the model which script phrases to react to. Each
	// must be a literal in the script it names, or the model waits for a line
	// that never comes (the "could not be read as JSON" phrase was stale for a
	// release).
	it("the setup skill's expected script phrases are literals in those scripts", () => {
		const skill = read("skills/setup/SKILL.md");
		const expect = {
			"scripts/render-model-picker.js": [
				"wrote ",
				"no provider keys are registered",
				"could not be read (",
				"CLAUDE_CODE_MAX_CONTEXT_TOKENS is still set",
			],
			"scripts/start-proxy.js": [
				"cc-proxy already up",
				"cc-proxy started",
				"cc-proxy restarted",
				"PROXY_PATH is unset",
				"did not become reachable in time",
			],
		};
		for (const [script, phrases] of Object.entries(expect)) {
			const src = read(script);
			for (const phrase of phrases) {
				assert.ok(
					skill.includes(phrase),
					`SKILL.md no longer mentions "${phrase}" — update this test`,
				);
				assert.ok(
					src.includes(phrase),
					`${script} no longer prints "${phrase}", but SKILL.md tells the model to expect it`,
				);
			}
		}
	});
});
