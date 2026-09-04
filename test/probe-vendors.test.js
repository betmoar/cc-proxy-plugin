import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { judge, renderBody } from "../scripts/probe-vendors.mjs";
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

// The network catch spreads `...c` into its result, and two cases define `body`
// as a TEMPLATE FUNCTION. Printing called `.replace` on it and killed the whole
// run with a TypeError — which exits 1, the same code as "a vendor disagrees",
// so a crash masqueraded as the one signal this script exists to send.
describe("probe-vendors renderBody()", () => {
	it("renders a string body, collapsed and capped for display", () => {
		assert.equal(renderBody({ body: "a\n\nb" }), "a b");
		assert.equal(renderBody({ body: "x".repeat(500) }).length, 160);
	});

	it("never throws on a body that is a case's template FUNCTION", () => {
		const template = (model) => ({ model });
		assert.doesNotThrow(() => renderBody({ body: template }));
		assert.equal(renderBody({ body: template }), "", "a template is not a response body");
	});

	it("is empty for a missing body (a network failure has none)", () => {
		assert.equal(renderBody({}), "");
		assert.equal(renderBody({ body: undefined }), "");
	});
});

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

	// The two LM Studio cases derive their URL from LMSTUDIO_BASE_URL, and CASES
	// is built at module-eval time — BEFORE the CLI guard's loadEnv(). Calling
	// the resolver in the literal baked `url: ""` in and fetch died with
	// "Failed to parse URL from", which reads like a URL bug and is an ordering
	// bug. Storing the FUNCTION is the fix; this pins it, because the defect is
	// invisible to anyone whose LMSTUDIO_BASE_URL is already in the process env.
	it("an env-derived url is stored as a thunk, never called in the CASES literal", () => {
		// Capture the whole url value, INCLUDING a trailing `()` — matching only
		// the identifier makes the call-vs-reference distinction invisible, which
		// is the one thing this test exists to see.
		const derived = table.match(/url: lmstudio\w*(?:\(\))?/g) ?? [];
		assert.ok(derived.length >= 2, `expected the lmstudio cases, found ${derived.length}`);
		for (const u of derived) {
			assert.doesNotMatch(
				u,
				/\(\)/,
				`${u} — an env-reading url must be the function, not its result: CASES is built before loadEnv()`,
			);
		}
	});

	// Exit 3 means "no vendor claim was checked". The keyless control runs on
	// every machine by design, so a test on `ran` alone can never fire again and
	// a keyless machine scores 0 — the silent green the header forbids.
	it("the no-claims-checked exit keys on KEYED cases, not on any case running", () => {
		assert.match(
			SOURCE,
			/if \(!ranKeyed\.length\) return 3;/,
			"exit 3 must key on ranKeyed — the keyless control makes ran.length permanently >= 1",
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

	it("allows npm off main when nothing re-enabled its tag", () => {
		assert.deepEqual(
			guard({
				branch: "feat/x",
				client: "npm/10.9.3 node/v22",
				command: "npm version patch",
				tagEnv: "",
			}),
			{ ok: true },
		);
	});

	// The hole the first cut had: `.npmrc` is not a seatbelt. A CLI
	// `--git-tag-version` or an `npm_config_git_tag_version=true` env var
	// overrides the file and npm DOES tag (measured 2026-08-31, three spellings).
	// Trusting the client name alone let the tag land on a branch commit —
	// issue #41 reopened for npm specifically.
	it("REFUSES npm off main when an override re-enabled tagging", () => {
		const r = guard({
			branch: "feat/x",
			client: "npm/10.9.3 node/v22",
			command: "npm version patch",
			tagEnv: "true",
		});
		assert.equal(r.ok, false, "npm with --git-tag-version tags — it must not be waved through");
		assert.match(r.reason, /issue #41/);
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

	// The second hole: `--no-git-tag-version=false` READS like a no-tag request
	// and TAGS (measured on both managers). A substring test allows exactly the
	// one spelling that defeats the guard.
	it("REFUSES the --no-git-tag-version=false spelling, which re-enables tagging", () => {
		const r = guard({
			branch: "feat/x",
			client: "pnpm/11.3.0",
			command: "pnpm version patch --no-git-tag-version=false",
		});
		assert.equal(r.ok, false, "=false re-enables the tag; it is not a no-tag request");
	});

	// The full measured grid (2026-08-31, npm 10.9.3 / pnpm 11.3.0, off main,
	// repo .npmrc = git-tag-version=false). `tags` is what the real manager did.
	// Every row that TAGGED must refuse; every row that did not must pass.
	const GRID = [
		{ client: "npm/10.9.3", flag: "", tagEnv: "", tags: false },
		{ client: "npm/10.9.3", flag: "--git-tag-version", tagEnv: "true", tags: true },
		{ client: "npm/10.9.3", flag: "--git-tag-version=false", tagEnv: "", tags: false },
		{ client: "npm/10.9.3", flag: "--no-git-tag-version", tagEnv: "", tags: false },
		{ client: "npm/10.9.3", flag: "--no-git-tag-version=true", tagEnv: "", tags: false },
		{ client: "npm/10.9.3", flag: "--no-git-tag-version=false", tagEnv: "true", tags: true },
		{ client: "pnpm/11.3.0", flag: "", tagEnv: undefined, tags: true },
		{ client: "pnpm/11.3.0", flag: "--git-tag-version", tagEnv: undefined, tags: true },
		{ client: "pnpm/11.3.0", flag: "--git-tag-version=false", tagEnv: undefined, tags: false },
		{ client: "pnpm/11.3.0", flag: "--no-git-tag-version", tagEnv: undefined, tags: false },
		{ client: "pnpm/11.3.0", flag: "--no-git-tag-version=true", tagEnv: undefined, tags: false },
		{ client: "pnpm/11.3.0", flag: "--no-git-tag-version=false", tagEnv: undefined, tags: true },
	];

	it("refuses exactly the invocations that were measured to tag", () => {
		for (const row of GRID) {
			const command = `${row.client.split("/")[0]} version patch ${row.flag}`.trim();
			const { ok } = guard({ branch: "feat/x", client: row.client, command, tagEnv: row.tagEnv });
			assert.equal(
				ok,
				!row.tags,
				`${command} (tagEnv=${JSON.stringify(row.tagEnv)}) measured tags=${row.tags}, guard said ok=${ok}`,
			);
		}
	});
});

// The pure decision table above says nothing about the CLI layer that makes it
// effective: if `isDirectRun` ever stops matching, or the git read or the env
// wiring breaks, the guard silently never fires and every test here stays
// green. Run the real script, in a throwaway repo (the release-gate.test.js
// pattern), because the guard reads the branch of the CWD — pointing it at this
// repo would invert the expectation the moment someone runs the suite on main.
describe("version-guard CLI", () => {
	const GUARD = path.join(import.meta.dirname, "..", "scripts", "version-guard.js");

	function fixtureRepo(branch) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-proxy-guard-"));
		const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","version":"1.0.0"}\n');
		git("add", "-A");
		git("commit", "-qm", "init");
		git("checkout", "-qB", branch);
		return dir;
	}

	function runGuard(dir, env) {
		return spawnSync(process.execPath, [GUARD], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, npm_config_user_agent: "", npm_config_git_tag_version: "", ...env },
		});
	}

	it("exits 1 and says why when a tagging invocation runs off main", () => {
		const dir = fixtureRepo("feat/x");
		try {
			const r = runGuard(dir, { npm_config_user_agent: "pnpm/11.3.0" });
			assert.equal(r.status, 1, `expected a refusal, got ${r.status}: ${r.stderr}`);
			assert.match(r.stderr, /issue #41/);
			assert.match(r.stderr, /feat\/x/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits 0 on main — tagging there is the point", () => {
		const dir = fixtureRepo("main");
		try {
			const r = runGuard(dir, { npm_config_user_agent: "pnpm/11.3.0" });
			assert.equal(r.status, 0, `expected an allow, got ${r.status}: ${r.stderr}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits 1 for npm off main once an override re-enabled its tag", () => {
		const dir = fixtureRepo("feat/x");
		try {
			const allowed = runGuard(dir, { npm_config_user_agent: "npm/10.9.3" });
			assert.equal(allowed.status, 0, "plain npm is allowed — .npmrc holds on the default path");
			const refused = runGuard(dir, {
				npm_config_user_agent: "npm/10.9.3",
				npm_config_git_tag_version: "true",
			});
			assert.equal(refused.status, 1, "an override makes npm tag; it must be refused");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── Catalog drift (issue #37) ────────────────────────────────────────────────
import { diffCatalogs } from "../scripts/probe-vendors.mjs";
import { ROUTES } from "../src/routes.js";

describe("diffCatalogs()", () => {
	it("STALE fires only for a status-200 route the vendor list cannot see", () => {
		// glm-5.3 is ROUTES glm:200 and IS in the (real) vendor list today; feed a
		// list that omits it -> exactly one STALE line naming the contract.
		const lines = diffCatalogs("glm", ["glm-5.2"], "glm test-endpoint");
		assert.ok(
			lines.some((l) => l.includes("STALE") && l.includes("glm-5.3") && l.includes("glm:200")),
		);
	});

	it("a non-200 ROUTES row omitted by the vendor is AGREEMENT, not staleness", () => {
		// qwen rows for glm-5.3 (400) and glm-5.1/5 (403) document refusal; the
		// vendor list omitting them must not print STALE.
		const lines = diffCatalogs("qwen", ["qwen3.8-max"], "qwen test-endpoint");
		const stale = lines.filter((l) => l.startsWith("STALE"));
		for (const l of stale) {
			assert.ok(!/glm-5\.3|glm-5\.1|glm-5(?!\.)/.test(l), `non-200 row reported STALE: ${l}`);
		}
	});

	it("INFO fires only for shape-matched, non-media ids the vendor lists but ROUTES lacks", () => {
		const lines = diffCatalogs(
			"qwen",
			["qwen3.9-max", "qwen-audio-9-tts", "wan9-image", "z-ai/glm-9"],
			"qwen t",
		);
		const info = lines.filter((l) => l.startsWith("INFO"));
		assert.equal(
			info.length,
			1,
			`exactly one INFO (a new qwen shape id), got: ${info.join(" | ")}`,
		);
		assert.ok(info[0].includes("qwen3.9-max"));
	});

	it("a clean list prints nothing", () => {
		// The exact current ROUTES glm ids, listed by the vendor: no STALE, no INFO.
		const glmIds = Object.keys(ROUTES).filter((id) => ROUTES[id].some((r) => r.provider === "glm"));
		const lines = diffCatalogs("glm", glmIds, "glm t");
		assert.equal(lines.length, 0, `unexpected lines: ${lines.join(" | ")}`);
	});

	it("a slash id never reports (OpenRouter namespace, not shape-routed)", () => {
		const lines = diffCatalogs("glm", ["z-ai/glm-9"], "glm t");
		assert.equal(lines.filter((l) => l.startsWith("INFO")).length, 0);
	});
});

// The drift pass folds into the same exit contract as case mismatches. This is
// pinned by reading main()'s exit block textually — the same style the CASES
// invariants above use for run-time-only checks. A drift that did NOT raise
// the exit code would print as a warning and never gate a release.
describe("drift exit-code fold", () => {
	const SRC = () =>
		fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "probe-vendors.mjs"), "utf8");

	it("a drift line makes main() return 1 (source-table disagreement)", () => {
		assert.match(SRC(), /disagreed\.length \|\| drift\.drifts\) return 1/);
	});

	// Review finding (critical): an UNREACHABLE drift LEG (alias check or list
	// fetch) that coexists with exit 0 breaks "0 = everything ran and matched".
	// The exit-2 condition must key on unreachableLegs, not on ran alone.
	it("any unreachable drift leg feeds exit 2, not just a fully-dead pass", () => {
		assert.match(SRC(), /unreachable\.length \|\| drift\.unreachableLegs > 0\) return 2/);
	});

	// Review finding (important): drift prose after the JSON blob would kill
	// every downstream `| jq`. driftReport() must print nothing in --json mode.
	it("--json mode keeps stdout parseable: drift prints only in non-JSON mode", () => {
		assert.match(SRC(), /if \(!JSON_OUT\) \{\n\t\tif \(lines\.length\) \{/);
	});
});
