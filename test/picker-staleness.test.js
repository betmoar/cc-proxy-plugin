import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	hasLegacyCustomModelOption,
	noticeFor,
	pickerNotice,
	pickerNoticeState,
	readPickerRows,
	readStamp,
	writeStamp,
} from "../hooks/picker-staleness.js";

// Issue #62. The generated modelPicker rows are a SNAPSHOT: CONTEXT_WINDOW
// changing under them (a corrected window, an id crossing 1M and gaining its
// [1m] suffix) makes them wrong with no symptom — the picker still renders, the
// stale window is still enforced, nothing errors. This notice is the only thing
// that would ever tell the user, so its gating is the whole test surface.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-stale-"));

describe("picker staleness gating (issue #62)", () => {
	// Silence is the default and the common case: a healthy line every session
	// is noise the context pays for forever.
	it("says nothing when the stamp matches this version", () => {
		assert.equal(
			pickerNoticeState({
				version: "0.9.2",
				notified: "0.9.2",
				rows: [{ model: "glm-5.3[1m]" }],
				legacyEnv: false,
			}),
			null,
		);
	});

	it("reports stale rows after a version change", () => {
		assert.equal(
			pickerNoticeState({
				version: "0.10.0",
				notified: "0.9.2",
				rows: [{ model: "glm-5.3[1m]" }],
				legacyEnv: false,
			}),
			"stale",
		);
	});

	// The pre-#62 configuration: one model in the picker, and CC's 200K
	// assumption on every other id cc-proxy routes.
	it("reports the legacy one-slot config when there are no rows", () => {
		assert.equal(
			pickerNoticeState({
				version: "0.10.0",
				notified: undefined,
				rows: undefined,
				legacyEnv: true,
			}),
			"absent",
		);
		assert.equal(
			pickerNoticeState({ version: "0.10.0", notified: undefined, rows: [], legacyEnv: true }),
			"absent",
		);
	});

	// A user with no rows AND no legacy env never opted into any of this.
	// Volunteering config advice to someone who never asked is how a hook becomes
	// noise; this is the case that keeps the notice from firing for everyone.
	it("stays silent for a user who never configured a picker at all", () => {
		assert.equal(
			pickerNoticeState({
				version: "0.10.0",
				notified: undefined,
				rows: undefined,
				legacyEnv: false,
			}),
			null,
		);
	});

	// An unreadable package.json must not mean "notify on every session forever".
	it("stays silent when this tree's version is unknown", () => {
		assert.equal(
			pickerNoticeState({ version: undefined, notified: undefined, rows: [], legacyEnv: true }),
			null,
		);
	});

	it("names the fix in both notices", () => {
		for (const state of /** @type {const} */ (["absent", "stale"])) {
			const line = noticeFor(state, "0.9.2");
			assert.match(line, /cc-proxy:setup|render-model-picker/);
			assert.match(line, /^cc-proxy 0\.9\.2:/);
		}
		// The "absent" line must say WHY it matters, or it reads as a nag.
		assert.match(noticeFor("absent", "0.9.2"), /200K/);
	});
});

describe("picker staleness I/O (issue #62)", () => {
	it("fires once per version, then goes quiet", () => {
		const dir = tmp();
		const settings = path.join(dir, "settings.json");
		const stamp = path.join(dir, "stamp.json");
		fs.writeFileSync(
			settings,
			JSON.stringify({ modelPicker: { options: [{ model: "glm-5.3[1m]" }] } }),
		);

		const first = pickerNotice({ version: "0.9.9", settingsFile: settings, stampFile: stamp });
		assert.match(first, /modelPicker rows/);
		const second = pickerNotice({ version: "0.9.9", settingsFile: settings, stampFile: stamp });
		assert.equal(second, undefined, "the notice repeated within one version");
		const afterUpdate = pickerNotice({
			version: "0.10.0",
			settingsFile: settings,
			stampFile: stamp,
		});
		assert.match(afterUpdate, /modelPicker rows/, "the notice did not return after an update");
	});

	// The "absent" case is the one a user may deliberately decline. Stamping it
	// too is what stops it becoming a permanent every-session line.
	it("stamps the legacy-config notice too", () => {
		const dir = tmp();
		const settings = path.join(dir, "settings.json");
		const stamp = path.join(dir, "stamp.json");
		fs.writeFileSync(
			settings,
			JSON.stringify({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: "glm-5.3[1m]" } }),
		);
		assert.match(
			pickerNotice({ version: "0.9.9", settingsFile: settings, stampFile: stamp }),
			/200K/,
		);
		assert.equal(
			pickerNotice({ version: "0.9.9", settingsFile: settings, stampFile: stamp }),
			undefined,
		);
	});

	// Every reader here runs inside a SessionStart hook: a throw is a session
	// that starts without its proxy notice, or at all.
	it("survives every unreadable input", () => {
		const dir = tmp();
		assert.equal(readStamp(path.join(dir, "nope.json")), undefined);
		assert.equal(readPickerRows(path.join(dir, "nope.json")), undefined);
		assert.equal(hasLegacyCustomModelOption(path.join(dir, "nope.json")), false);
		const junk = path.join(dir, "junk.json");
		fs.writeFileSync(junk, "{ not json");
		assert.equal(readStamp(junk), undefined);
		assert.equal(readPickerRows(junk), undefined);
		assert.equal(hasLegacyCustomModelOption(junk), false);
		// A picker whose options is not an array reads as "no rows", not a throw.
		const odd = path.join(dir, "odd.json");
		fs.writeFileSync(odd, JSON.stringify({ modelPicker: { options: "glm" } }));
		assert.equal(readPickerRows(odd), undefined);
		// An unwritable stamp path must not throw either.
		assert.doesNotThrow(() => writeStamp("0.9.9", "/proc/nope/stamp.json"));
	});
});

describe("session-start emits one payload (issue #62)", () => {
	/**
	 * A plugin tree holding ONLY the three hook files and a package.json —
	 * deliberately NO `bin/`.
	 *
	 * THIS IS A SAFETY PROPERTY, NOT A CONVENIENCE. `resolveProxyPath()` prefers
	 * the tree's own `bin/cc-proxy.js` and only falls back to env `PROXY_PATH`,
	 * so running the REPO's hook from a test means any code path that decides to
	 * spawn starts a REAL, DETACHED, unref'd proxy on the runner. That is
	 * unkillable by the test and it does not merely leak: a CI step never
	 * finishes while an orphaned child of it is alive, so the job hangs with no
	 * log and no failing test name (measured — 6+ minutes in `pnpm test` against
	 * ~10 s locally, twice, before `--test-timeout` turned it into a nameable
	 * failure). With no `bin/` and `PROXY_PATH=""` the spawn is unreachable by
	 * construction rather than by argument.
	 *
	 * The package.json is load-bearing too: both hooks read their own tree's
	 * version, and without one `treeVersion()` is undefined, `pickerNoticeState`
	 * returns null, and a test asserting the picker line would pass while
	 * measuring only the proxy line.
	 *
	 * @param {string} dir  the fake HOME
	 * @returns {string} path to the tree's session-start.js
	 */
	function isolatedHook(dir) {
		const hooks = path.join(dir, "tree", "hooks");
		fs.mkdirSync(hooks, { recursive: true });
		for (const f of ["session-start.js", "proxy-lifecycle.js", "picker-staleness.js"]) {
			fs.copyFileSync(path.join(root, "hooks", f), path.join(hooks, f));
		}
		fs.writeFileSync(
			path.join(dir, "tree", "package.json"),
			JSON.stringify({ name: "cc-proxy", version: "0.9.9", type: "module" }),
		);
		return path.join(hooks, "session-start.js");
	}

	/**
	 * Run the isolated hook and resolve its stdout.
	 *
	 * ASYNC ON PURPOSE. `execFileSync` blocks this process's event loop, so an
	 * in-process http server CANNOT answer the hook's `/_status` probe while it
	 * runs — the "already-up" test then passed only because that probe timed out
	 * and the listener read as foreign. That is a pass for the wrong reason, and
	 * a timing-dependent one: it is decided by whether a 1 s probe expires before
	 * a 20 s exec, which is exactly the kind of margin that behaves differently
	 * on a loaded CI runner. Awaiting instead lets the server actually serve.
	 *
	 * @param {string} dir @param {Record<string,string>} env
	 * @returns {Promise<string>}
	 */
	async function runHook(dir, env) {
		const { stdout } = await promisify(execFile)(process.execPath, [isolatedHook(dir)], {
			env: {
				...process.env,
				HOME: dir,
				USERPROFILE: dir,
				PROXY_PATH: "",
				PROXY_READY_TIMEOUT_MS: "300",
				PROXY_LOG: path.join(dir, "log"),
				...env,
			},
			encoding: "utf8",
			timeout: 20000,
		});
		return stdout;
	}

	// The hook may have TWO things to say (proxy down, picker stale) and exactly
	// one additionalContext field to say them in. A second process.stdout.write
	// would emit two JSON objects on one stream, which is not parseable as a
	// hook result — the proxy notice would be lost.
	it("merges both notices into a single valid JSON object", async () => {
		const dir = tmp();
		// The hook resolves settings from ~/.claude/settings.json, so the fake HOME
		// must carry that directory — writing to $HOME/settings.json silently
		// yields no picker notice and the assertion below would then be measuring
		// the proxy line twice.
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: "glm-5.3[1m]" } }),
		);
		// Nothing on the port and no bin anywhere -> "missing-path", so BOTH lines
		// apply. 1 is always free of a cc-proxy (it is privileged and never ours).
		const out = await runHook(dir, { PROXY_PORT: "1" });
		const parsed = JSON.parse(out);
		assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
		const text = parsed.hookSpecificOutput.additionalContext;
		assert.match(text, /the proxy did not start/, "the proxy notice was lost");
		assert.match(text, /200K/, "the picker notice was lost");
	});

	// Silence must stay byte-exact silence: a hook that prints "{}" on a healthy
	// session adds an empty context entry to every session forever.
	it("prints nothing at all when there is nothing to say", async () => {
		const dir = tmp();
		// The healthy path is "already-up": something already speaks the /_status
		// contract AT THE TREE'S OWN VERSION. Reporting a DIFFERENT version (or
		// none — `probeProxyVersion` resolves null for a JSON body without one)
		// makes the listener read as STALE, which sends the hook down the
		// shutdown-and-respawn branch. Matching 0.9.9 keeps this test on the
		// branch it means to test.
		const srv = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ version: "0.9.9", providers: [] }));
		});
		await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
		const port = srv.address().port;
		try {
			// No settings.json and no legacy env in this HOME -> no picker notice.
			assert.equal(await runHook(dir, { PROXY_PORT: String(port) }), "");
		} finally {
			srv.closeAllConnections();
			srv.close();
		}
	});
});
