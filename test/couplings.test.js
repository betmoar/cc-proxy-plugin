import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Locks the cross-file couplings documented in CLAUDE.md ("Couplings — if you
// touch X, you must also update Y") that no behavioral test can catch: the
// files involved never import each other, so a drifted copy fails silently at
// runtime (wrong port probed, hook killed mid-poll, undocumented env knob).
// Each test names its coupling; a failure message tells you every file to fix.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

describe("cross-file couplings", () => {
	// COUPLING: PROVIDER_IDS (the set parseModelSelector strips a `<provider>:`
	// lens for) is a hand-written list that must cover every id buildProviders()
	// can push. It is deliberately NOT derived from config.providers — the whole
	// point of 0.6.1's fix is that the strip must not depend on a backend holding
	// a key (issue #20). But that also means adding a provider without adding it
	// here has NO local symptom: the new backend routes fine by predicate, while
	// `<newprovider>:<model>` silently forwards the raw lens string upstream as a
	// model id and 400s opaquely. Every provider registers when its key is set,
	// so building with all keys enumerates the full set.
	it("PROVIDER_IDS covers every provider buildProviders() can register", async () => {
		const { PROVIDER_IDS, buildProviders } = await import("../src/providers.js");
		const registrable = buildProviders({
			GLM_API_KEY: "g",
			OPENROUTER_API_KEY: "o",
			DEEPSEEK_API_KEY: "d",
			DASHSCOPE_API_KEY: "q",
		}).map((p) => p.id);
		const missing = registrable.filter((id) => !PROVIDER_IDS.has(id));
		assert.deepEqual(
			missing,
			[],
			`src/providers.js PROVIDER_IDS is missing ${missing.join(", ")} — the "<provider>:" lens for those would leak upstream unstripped`,
		);
		const stale = [...PROVIDER_IDS].filter((id) => !registrable.includes(id));
		assert.deepEqual(stale, [], `PROVIDER_IDS names providers that no longer exist: ${stale}`);
	});

	// COUPLING: the PROXY_PORT default is read independently in several files
	// (deliberately — the hook must not import src/). Change it everywhere or
	// nowhere; a split default means the proxy binds one port while the hook and
	// statusline probe another ("proxy down" forever, duplicate spawns).
	//
	// DISCOVERED, not listed. This test named four files by hand and the literal
	// had since spread to seven — bench-speed.js, list-models.js and
	// render-models.js each carried their own copy, outside the lock, so a port
	// change would have passed this assertion while those three probed the old
	// port. A hand-maintained list of "everywhere X appears" is the same drift
	// class the lock exists to catch, one level up. Walking the tree cannot go
	// stale: a new copy joins the assertion the moment it is written.
	it("the PROXY_PORT default is identical in every file that reads it", () => {
		const dirs = ["src", "scripts", "hooks", "bin"];
		/** @type {{file: string, value: string}[]} */
		const defaults = [];
		for (const dir of dirs) {
			for (const name of fs.readdirSync(path.join(root, dir))) {
				if (!/\.(js|mjs)$/.test(name)) continue;
				const rel = `${dir}/${name}`;
				const m = /process\.env\.PROXY_PORT \|\| (\d+)/.exec(read(rel));
				if (m) defaults.push({ file: rel, value: m[1] });
			}
		}
		// A floor, not a count: it fails if the walk silently matches nothing (a
		// renamed env var, a changed spelling) rather than passing vacuously.
		assert.ok(
			defaults.length >= 4,
			`expected several PROXY_PORT readers, found ${defaults.length} — has the spelling changed?`,
		);
		const distinct = new Set(defaults.map((d) => d.value));
		assert.equal(
			distinct.size,
			1,
			`PROXY_PORT defaults diverged: ${defaults.map((d) => `${d.file}=${d.value}`).join(", ")}`,
		);
	});

	// COUPLING: the default proxy log path is spelled out twice — the hook picks
	// where the proxy writes it, scripts/status.js tails it back. Not shared via
	// import, deliberately: scripts/ doesn't reach into hooks/. Drift is silent —
	// the status report just reports "no routing decisions yet" forever against a
	// file nobody writes. Both must be the same $HOME-relative segments (item 5:
	// neither may sit in /tmp, where another local user can plant a symlink).
	it("the default log path is identical in the hook and scripts/status.js", () => {
		const segs = (src) => {
			const m = /path\.join\(os\.homedir\(\), ([^)]+)\)/.exec(src);
			return m ? m[1].replace(/\s+/g, " ").trim() : null;
		};
		const hook = segs(read("hooks/proxy-lifecycle.js"));
		const status = segs(read("scripts/status.js"));
		assert.ok(hook, "could not locate the hook's homedir log default — update this coupling test");
		assert.ok(status, "could not locate status.js's homedir log default — update this test");
		assert.equal(
			status,
			hook,
			`default log path diverged: hooks/proxy-lifecycle.js=[${hook}] scripts/status.js=[${status}]`,
		);
	});

	// COUPLING: hooks.json kills the SessionStart hook at `timeout` seconds; the
	// readiness poll inside it defaults to PROXY_READY_TIMEOUT_MS. A ready
	// timeout at or past the hook kill silently never completes — raise both
	// together, keeping at least 1s of spawn/probe headroom.
	it("hook timeout exceeds the default readiness poll with headroom", () => {
		const hooks = JSON.parse(read("hooks/hooks.json"));
		const hookTimeoutMs = hooks.hooks.SessionStart[0].hooks[0].timeout * 1000;
		const m = /envTimeout > 0 \? envTimeout : (\d+)/.exec(read("hooks/proxy-lifecycle.js"));
		assert.ok(
			m,
			"could not locate the ready-timeout default in proxy-lifecycle.js — update this test",
		);
		const readyDefaultMs = Number(m[1]);
		assert.ok(
			readyDefaultMs + 1000 <= hookTimeoutMs,
			`PROXY_READY_TIMEOUT_MS default (${readyDefaultMs}ms) needs ≥1000ms headroom under the ` +
				`hooks.json timeout (${hookTimeoutMs}ms) — raise both together`,
		);
	});

	// COUPLING: the plugin description is carried by three manifests — package.json
	// (npm/tooling), plugin.json (the Claude Code plugin pane), and
	// marketplace.json's entry (the install listing). Nothing at runtime reads all
	// three, so a drifted copy is invisible until a user reads the stale one:
	// package.json still advertised "Z.ai and OpenRouter" two providers after
	// DeepSeek and Qwen shipped.
	it("plugin description is identical in package.json, plugin.json, and marketplace.json", () => {
		const pkg = JSON.parse(read("package.json")).description;
		const plugin = JSON.parse(read(".claude-plugin/plugin.json")).description;
		const market = JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].description;
		assert.equal(plugin, pkg, "plugin.json description drifted from package.json");
		assert.equal(market, pkg, "marketplace.json entry description drifted from package.json");
	});

	// COUPLING: scripts/list-models.js's display CONTEXT_WINDOW must be
	// DERIVED from src/models.js's CONTEXT_WINDOW (the wire source of truth
	// for GET /v1/models' context_window field), never a second
	// hand-maintained literal. This is the exact "same data in two files"
	// drift class this test file exists to catch — before the 0.5.1
	// promotion, list-models.js declared its own curated { id: "128K" } map
	// that could silently disagree with the number now shipped on the wire.
	it("scripts/list-models.js imports its context-window source from src/models.js instead of restating it", () => {
		const src = read("scripts/list-models.js");
		assert.ok(
			/import\s*\{[^}]*CONTEXT_WINDOW as CONTEXT_WINDOW_TOKENS[^}]*\}\s*from\s*"\.\.\/src\/models\.js"/.test(
				src,
			),
			"list-models.js must import CONTEXT_WINDOW from src/models.js (aliased), not restate it",
		);
		// Re-declaration is caught semantically (key set + every value) by
		// test/list-models.test.js "display CONTEXT_WINDOW is derived
		// byte-for-byte…"; a hand-written table diverges there the moment it
		// differs at all. This half only pins the DERIVATION SITE, so the
		// export stays a mapping over the imported table rather than a literal
		// that happens to agree today. A text probe for a literal's opening
		// comment was near-inert — it only fired on `{\n // GLM`.
		assert.ok(
			/export const CONTEXT_WINDOW\s*=\s*Object\.fromEntries\(\s*\n?\s*Object\.entries\(CONTEXT_WINDOW_TOKENS\)/.test(
				src,
			),
			"list-models.js's CONTEXT_WINDOW must stay a derivation over the imported table, not a hand-written literal",
		);
	});

	// COUPLING: the provider quota/credit/balance endpoints live ONLY in
	// scripts/quota.js. status.js (one-shot CLI) and statusline.js (300ms render
	// loop) both consume it. They each carried their own copy until 0.5.1 and
	// drifted once — the statusline's fetches grew an AbortSignal timeout while
	// status.js's could hang forever (fixed 0.3.1). A re-declared URL literal in
	// either consumer is that drift starting over, so fail on the literal itself.
	it("quota/credit endpoint URLs are declared only in scripts/quota.js", () => {
		const hosts = ["api.z.ai", "openrouter.ai/api/v1/credits", "api.deepseek.com"];
		for (const consumer of ["scripts/status.js", "scripts/statusline.js"]) {
			const src = read(consumer);
			for (const host of hosts) {
				assert.ok(
					!src.includes(host),
					`${consumer} declares its own ${host} endpoint — import it from scripts/quota.js instead`,
				);
			}
			assert.ok(
				/from\s*"\.\/quota\.js"/.test(src),
				`${consumer} must import its provider fetchers from ./quota.js`,
			);
		}
	});

	// COUPLING: scripts/quota.js is imported by scripts that call loadEnv() in
	// their body — and an import is hoisted ABOVE that call. Any module-level
	// process.env read here therefore captures the environment BEFORE ~/.env is
	// merged, silently ignoring a key or URL configured only there. That is
	// verbatim the bug that made the statusline probe the wrong PROXY_PORT
	// (fixed, locked by test/statusline.test.js). Reads must stay inside
	// functions (see deepseekBalanceUrl).
	it("scripts/quota.js reads process.env only inside functions, never at module level", () => {
		const src = read("scripts/quota.js");
		const offenders = [...src.matchAll(/^(?:export\s+)?const\s+\w+\s*=[^;]*process\.env/gm)].map(
			(m) => m[0].split("\n")[0],
		);
		assert.deepEqual(
			offenders,
			[],
			`scripts/quota.js reads process.env at module level (${offenders.join(", ")}) — imports are hoisted above the consumers' loadEnv(), so ~/.env would be ignored`,
		);
	});

	// COUPLING: `QWEN_PLAN_ALSO` (scripts/render-models.js, the "also on plan" tag)
	// must cover every id in `QWEN_PLAN_RESELLS` (src/providers.js, the routing
	// predicate). Two hand-written copies of the same curated fact — which ids the
	// Qwen Token Plan resells — in files that never import each other.
	//
	// Direction matters, and only ONE direction is an error. Every routed reseller
	// must be tagged, or the Qwen card under-reports what the plan entitles you to:
	// `deepseek-v4-pro` renders on the DeepSeek card (native-first since issue #19)
	// and would appear nowhere on Qwen's without the tag. The reverse is legitimate
	// — `glm-5.2` is in the display set but NOT in the predicate. Adding it there
	// would change the PREDICATES without changing where anything routes, because
	// `resolve()` consults `rankRoutes()` (router.js:90) BEFORE the predicate scan
	// (router.js:96), and `ROUTES["glm-5.2"]` lists glm first. Measured, with
	// `glm-5.2` added to the set and both keys present:
	//
	//   glm.match  true → false      qwen.match  false → true
	//   resolve("glm-5.2").provider.id → "glm"   (unchanged)
	//
	// So it is latent, not inert: the predicates disagree with the route table,
	// and the day `glm-5.2` loses its ROUTES entry the fallback lands on qwen
	// instead of glm — reversing "a native plan outranks a resold one" with
	// nothing to catch it. The display set has no such power: it only decides
	// whether a tag is drawn. Two sets, one shared fact, asymmetric consequences
	// — which is why this asserts containment and equality would fail on correct
	// code. (An earlier version of this comment said "dead code", and its
	// correction said routing moves. Both were wrong; these numbers are from
	// running it — `resolve()` returns `{provider, upstreamModel}`, and reading a
	// `.id` off that is what produced the second wrong answer.)
	//
	// They have drifted before: `deepseek-v4-pro` was dropped from the display set
	// on the theory that a natively-routed id is not a "dup", which is exactly
	// backwards — native routing is the PRECONDITION for the tag (caught in review
	// on PR #21, recorded in CHANGELOG). Neither file imports the other, so the
	// next drift is silent again: routing keeps working and the page just quietly
	// tells the reader less than the truth.
	it("QWEN_PLAN_ALSO (renderer) covers every id in QWEN_PLAN_RESELLS (router)", () => {
		const parse = (src, name) => {
			const m = new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
			assert.ok(m, `could not parse ${name} — the coupling test needs updating, not deleting`);
			return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
		};
		const resells = parse(read("src/providers.js"), "QWEN_PLAN_RESELLS");
		const tagged = parse(read("scripts/render-models.js"), "QWEN_PLAN_ALSO");
		assert.ok(resells.length > 0, "parsed QWEN_PLAN_RESELLS as empty — the regex has rotted");
		const untagged = resells.filter((id) => !tagged.includes(id));
		assert.deepEqual(
			untagged,
			[],
			`src/providers.js QWEN_PLAN_RESELLS has ${untagged.join(", ")} but scripts/render-models.js QWEN_PLAN_ALSO does not — the Qwen card will under-report the plan's scope for those ids`,
		);
	});

	// COUPLING: the routing log line (src/server.js) is PARSED by
	// scripts/status.js parseRoutingLines(). CLAUDE.md has carried this row since
	// 0.3.3 with nothing enforcing it — the two files never import each other, so
	// a format change breaks `/cc-proxy:status`'s recent-routing section silently
	// and only on a machine with a populated log. 0.6.3 appended a
	// `(routed as <id>)` annotation to that line, which is exactly the kind of
	// edit this row exists to catch, so it stops being a prose-only promise here.
	//
	// Asserts the CONTRACT parseRoutingLines() actually relies on — a leading
	// `[` and a ` -> ` separator — against a line built the way server.js builds
	// it, in both its annotated and unannotated forms. Deliberately not a
	// full-format lock: pinning the whole line would fail on every cosmetic edit
	// and teach the next maintainer to delete the test.
	it("the routing log line stays parseable by scripts/status.js", async () => {
		const { parseRoutingLines } = await import("../scripts/status.js");
		const src = read("src/server.js");

		// The literal must still be built the way this test models it. If the
		// template changes shape, this assertion fails FIRST with a pointer,
		// rather than the sample lines below silently testing a stale format.
		assert.match(
			src,
			/console\.log\(`\[\$\{new Date\(\)\.toISOString\(\)\}\] \$\{inboundModel\} -> \$\{provider\.id\}\$\{via\} \$\{req\.url\}`\)/,
			"the routing log template in src/server.js changed — update scripts/status.js parseRoutingLines() and this test together",
		);

		const stamp = "2026-08-14T11:15:10.068Z";
		const lines = [
			`[${stamp}] glm-5.2 -> qwen /v1/messages`,
			`[${stamp}] glm-5.2[1m] -> qwen (routed as glm-5.2) /v1/messages`,
			`[${stamp}] qwen:deepseek-v4-pro -> qwen (routed as deepseek-v4-pro) /v1/messages`,
			`[${stamp}] unknown -> claude /v1/messages/count_tokens`,
		];
		assert.deepEqual(
			parseRoutingLines(lines.join("\n")),
			lines,
			"parseRoutingLines() dropped a routing line — src/server.js and scripts/status.js have drifted",
		);
	});

	// COUPLING: the OUTBOUND-ID CONTRACT and the prose that describes it.
	//
	// Issue #34's fix reversed this contract mid-review — the `[1m]` suffix went
	// from "preserved upstream" to "stripped upstream" once both vendors were
	// measured rejecting it — and left THREE comments asserting the old one: the
	// stripVariantSuffix JSDoc, a test block comment, and resolve()'s numbered
	// step list. Each was found by a reviewer, none by a test, and the last only
	// after the PR was approved. The claim is a single word in the code
	// (`upstreamModel: routeId` vs `: tail`) and a paragraph in the prose, which
	// is exactly the asymmetry that lets them drift apart.
	//
	// So: pin the code side, and forbid the phrasings that only make sense under
	// the reversed contract. Not a general prose linter — a short deny-list of
	// claims that were literally wrong, so the next reversal trips here.
	it("no comment still promises the pre-reversal upstream contract", () => {
		const router = read("src/router.js");

		// Code side: every return in resolve() sends the normalized id.
		const body = router.slice(router.indexOf("export function resolve("));
		const returns = [...body.matchAll(/upstreamModel:\s*(\w+)/g)].map((m) => m[1]);
		assert.ok(
			returns.length >= 4,
			`expected resolve() to have 4+ upstreamModel returns, found ${returns.length}`,
		);
		assert.deepEqual(
			[...new Set(returns)],
			["routeId"],
			`resolve() must send the normalized id upstream from every return; found ${[...new Set(returns)].join(", ")}. If this is a deliberate reversal, update the prose in the same commit — that is the whole point of this test.`,
		);

		// Prose side: phrasings that are only true under the OLD contract.
		const stale = [
			"upstream gets it back",
			"ROUTING ONLY",
			"upstream gets the id it gets today",
			"Z.ai accepts the suffixed",
			"keeps the raw suffix",
		];
		for (const file of ["src/router.js", "src/server.js", "test/router.test.js", "CHANGELOG.md"]) {
			const text = read(file);
			for (const phrase of stale) {
				assert.ok(
					!text.includes(phrase),
					`${file} contains "${phrase}" — that describes the contract BEFORE the #34 reversal, and the code now strips the suffix on the way out. Fix the prose.`,
				);
			}
		}
	});

	// COUPLING: a package script a HUMAN is meant to run must be discoverable
	// where humans look. `probe:vendors` shipped in 0.6.3 as the manual gate for
	// vendor claims — and a manual gate nobody knows about is not a gate. Same
	// drift class as the .env.example row below: the code works, the knowledge
	// does not propagate.
	//
	// Only human-facing scripts are checked. `version`/`sync-version` are npm
	// lifecycle plumbing and `lint:fix`/`format` are editor conveniences; naming
	// them here would be documentation theatre.
	it("every human-facing pnpm script is documented", () => {
		const scripts = Object.keys(JSON.parse(read("package.json")).scripts);
		const internal = new Set(["version", "sync-version", "lint:fix", "format"]);
		const humanFacing = scripts.filter((s) => !internal.has(s));
		assert.ok(
			humanFacing.length >= 5,
			`expected several human-facing scripts, found ${humanFacing.length}`,
		);

		// One of these three is where a contributor actually looks first.
		const docs = ["README.md", "CONTRIBUTING.md", "docs/OPERATIONS.md"].map(read).join("\n");
		const undocumented = humanFacing.filter((s) => !docs.includes(s));
		assert.deepEqual(
			undocumented,
			[],
			`package.json defines ${undocumented.join(", ")} but no reader-facing doc mentions it — README.md, CONTRIBUTING.md and docs/OPERATIONS.md are where someone looks for "how do I run this"`,
		);
	});

	// COUPLING: every env var offered in .env.example must be documented in the
	// README env table and in docs/OPERATIONS.md (new knobs go in all three).
	it("every .env.example key is documented in README.md and docs/OPERATIONS.md", () => {
		const keys = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
		assert.ok(keys.length >= 5, `expected .env.example to define keys, parsed: ${keys.join(", ")}`);
		const readme = read("README.md");
		const ops = read("docs/OPERATIONS.md");
		for (const key of keys) {
			assert.ok(readme.includes(key), `${key} is in .env.example but missing from README.md`);
			assert.ok(ops.includes(key), `${key} is in .env.example but missing from docs/OPERATIONS.md`);
		}
	});
});
