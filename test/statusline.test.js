import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { refreshLockPath, takeRefreshLock } from "../scripts/refresh-lock.js";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../scripts/statusline.js",
);

// Seed a fresh OpenRouter credits cache so the renderer reads the fixture
// instead of calling the network. A dummy key makes the loader proceed past
// its no-key guard; the <60s _ts keeps the cache non-stale. Returns the temp
// dir to pass as CLAUDE_PLUGIN_DATA. The proxy-alive cache shares this dir but
// is independent, so it just probes (and prints "proxy down") harmlessly.
function seedOpenRouterCache(remaining) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
	fs.writeFileSync(
		path.join(dir, "openrouter_credits_cache.json"),
		JSON.stringify({ remaining, usedPct: 0, _ts: Date.now() }),
	);
	return dir;
}

// Same idea for the DeepSeek balance cache: a fresh `_ts` keeps the loader on the
// cache branch so it never touches the network. `remaining` is the single
// total_balance DeepSeek reports (no used-percentage, unlike OpenRouter).
function seedDeepSeekCache(remaining) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
	fs.writeFileSync(
		path.join(dir, "deepseek_balance_cache.json"),
		JSON.stringify({ remaining, currency: "USD", _ts: Date.now() }),
	);
	return dir;
}

// Strip ANSI color codes for label/shape assertions.
function plain(s) {
	return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function run(input, env = {}) {
	return new Promise((resolve) => {
		const child = execFile(
			"node",
			[SCRIPT],
			{ env: { ...process.env, ...env } },
			(err, stdout, stderr) => {
				resolve({ code: err?.code ?? 0, stdout, stderr });
			},
		);
		child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
		child.stdin.end();
	});
}

describe("statusline.js", () => {
	it("shows cc usage when rate_limits is present", async () => {
		const { stdout } = await run(
			{
				rate_limits: {
					five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
				},
			},
			{ GLM_API_KEY: "", OPENROUTER_API_KEY: "" },
		);
		assert.ok(stdout.includes("cc 5h:"), `Expected cc section, got: ${stdout}`);
		assert.ok(stdout.includes("42%"), `Expected 42%, got: ${stdout}`);
	});

	it("replaces percentage with a reset countdown at 100% usage", async () => {
		const { stdout } = await run(
			{
				rate_limits: {
					five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 7200 },
				},
			},
			{ GLM_API_KEY: "", OPENROUTER_API_KEY: "" },
		);
		assert.match(stdout, /cc 5h:\S*⏱\d+h/, `Expected countdown, got: ${stdout}`);
		assert.ok(!stdout.includes("100%"), `Expected no percentage at 100%, got: ${stdout}`);
	});

	it("shows -- for cc when rate_limits is missing", async () => {
		const { stdout } = await run({}, { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.ok(stdout.includes("cc 5h:--"), `Expected --, got: ${stdout}`);
	});

	it("handles empty stdin gracefully", async () => {
		const { stdout, code } = await run("", { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.equal(code, 0);
		assert.ok(stdout.includes("cc 5h:--"), `Expected graceful handling, got: ${stdout}`);
	});

	it("renders -- for cc when usage is non-numeric", async () => {
		const { stdout } = await run(
			{
				rate_limits: {
					five_hour: { used_percentage: "oops", resets_at: Math.floor(Date.now() / 1000) + 3600 },
				},
			},
			{ GLM_API_KEY: "", OPENROUTER_API_KEY: "" },
		);
		assert.ok(stdout.includes("cc 5h:--"), `Expected -- placeholder, got: ${stdout}`);
		assert.ok(!stdout.includes("NaN"), `Expected no NaN, got: ${stdout}`);
	});

	it("does not trigger countdown when usage rounds up to 100 but is below it", async () => {
		const { stdout } = await run(
			{
				rate_limits: {
					five_hour: { used_percentage: 99.6, resets_at: Math.floor(Date.now() / 1000) + 3600 },
				},
			},
			{ GLM_API_KEY: "", OPENROUTER_API_KEY: "" },
		);
		assert.ok(stdout.includes("100%"), `Expected rounded 100%, got: ${stdout}`);
		assert.ok(!stdout.includes("⏱"), `Expected no countdown below 100%, got: ${stdout}`);
	});

	it("renders or: $-tiers by digit count, unbounded above $999", async () => {
		const cases = [
			[0, "$0"],
			[0.5, "$"], // non-empty sub-$1 floors to 0 but must still show one $
			[7, "$"],
			[42, "$$"],
			[150, "$$$"],
			[1200, "$$$$"], // unbounded by design — does NOT cap at $$$
			[undefined, "--"], // non-finite balance (corrupt/schema drift) → placeholder
		];
		for (const [remaining, expected] of cases) {
			const dir = seedOpenRouterCache(remaining);
			try {
				const { stdout } = await run(
					{},
					{ GLM_API_KEY: "", OPENROUTER_API_KEY: "dummy", CLAUDE_PLUGIN_DATA: dir },
				);
				assert.ok(
					plain(stdout).includes(`or:${expected} `) || plain(stdout).endsWith(`or:${expected}`),
					`remaining=${remaining}: expected or:${expected}, got: ${plain(stdout)}`,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("renders ds: $-tiers from the DeepSeek balance cache", async () => {
		const cases = [
			[0, "$0"],
			[0.5, "$"], // non-empty sub-$1 floors to 0 but must still show one $
			[42, "$$"],
			[1200, "$$$$"], // unbounded by design, same as or:
			[undefined, "--"], // non-finite balance (corrupt/schema drift) → placeholder
		];
		for (const [remaining, expected] of cases) {
			const dir = seedDeepSeekCache(remaining);
			try {
				const { stdout } = await run(
					{},
					{
						GLM_API_KEY: "",
						OPENROUTER_API_KEY: "",
						DEEPSEEK_API_KEY: "dummy",
						CLAUDE_PLUGIN_DATA: dir,
					},
				);
				assert.ok(
					plain(stdout).includes(`ds:${expected} `) || plain(stdout).endsWith(`ds:${expected}`),
					`remaining=${remaining}: expected ds:${expected}, got: ${plain(stdout)}`,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	// GUARDRAIL: the ds: gauge is denominated in dollars (`dollarTier`), but
	// /user/balance is per-currency. The loader used to fall back to
	// balance_infos[0] when no USD row existed, so a CNY-only account rendered
	// ¥50 as `$$` — a confidently wrong dollar reading. Only a USD row may drive
	// the gauge; anything else is unknown (`--`). Uses a local stub backend
	// (no cache seeded) so the real selection logic runs, not a fixture.
	it("renders ds:-- for a CNY-only balance instead of a wrong-currency $ tier", async () => {
		const http = await import("node:http");
		const bodies = {
			// CNY-only: no USD row at all → unknown.
			cny: { balance_infos: [{ currency: "CNY", total_balance: "50.00" }] },
			// Both present, CNY listed first → the USD row must still win, and
			// the tier must come from 42 (`$$`), not 50.
			both: {
				balance_infos: [
					{ currency: "CNY", total_balance: "50.00" },
					{ currency: "USD", total_balance: "42.00" },
				],
			},
		};
		for (const [name, expected] of [
			["cny", "--"],
			["both", "$$"],
		]) {
			const server = http.createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(bodies[name]));
			});
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			const url = `http://127.0.0.1:${server.address().port}/user/balance`;
			// A fresh empty dir. The render path never fetches, so the FIRST render
			// only triggers the detached refresher and omits the gauge (there is
			// nothing cached to show); the currency selection this test is about
			// happens in that refresher and shows from the second render on. The
			// wait is for the cache FILE, not a fixed sleep, so a slow machine
			// doesn't turn into a flake.
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
			try {
				const env = {
					GLM_API_KEY: "",
					OPENROUTER_API_KEY: "",
					DEEPSEEK_API_KEY: "dummy",
					DEEPSEEK_BALANCE_URL: url,
					CLAUDE_PLUGIN_DATA: dir,
				};
				await run({}, env);
				const cacheFile = path.join(dir, "deepseek_balance_cache.json");
				for (let i = 0; i < 100 && !fs.existsSync(cacheFile); i += 1) {
					await new Promise((r) => setTimeout(r, 50));
				}
				assert.ok(fs.existsSync(cacheFile), `${name}: refresher never wrote ${cacheFile}`);
				const { stdout } = await run({}, env);
				assert.ok(
					plain(stdout).includes(`ds:${expected} `) || plain(stdout).endsWith(`ds:${expected}`),
					`${name}: expected ds:${expected}, got: ${plain(stdout)}`,
				);
			} finally {
				await new Promise((r) => server.close(r));
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("omits the ds: segment entirely when DEEPSEEK_API_KEY is unset", async () => {
		// A seeded cache must not be enough — the no-key guard short-circuits first,
		// so an unconfigured user never sees a DeepSeek gauge.
		const dir = seedDeepSeekCache(42);
		try {
			const { stdout } = await run(
				{},
				{
					GLM_API_KEY: "",
					OPENROUTER_API_KEY: "",
					DEEPSEEK_API_KEY: "",
					CLAUDE_PLUGIN_DATA: dir,
				},
			);
			assert.ok(!plain(stdout).includes("ds:"), `Expected no ds: segment, got: ${plain(stdout)}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// A repo-root .env is loaded before ~/.env by loadEnv() and would win over the
	// fixture home written below — skip in that dev-machine configuration, exactly
	// like dotenv.test.js's repoEnvHasGlmKey guard.
	function repoEnvHasProxyPort() {
		try {
			const repoEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
			return /^PROXY_PORT=/m.test(fs.readFileSync(repoEnv, "utf8"));
		} catch {
			return false;
		}
	}

	// GUARDRAIL for the load-order bug: PROXY_PORT was read at module load BEFORE
	// loadEnv() ran, so a port configured only in ~/.env was silently ignored and
	// the liveness probe watched the default port instead. Two-sided so the test
	// fails pre-fix regardless of whether something happens to listen on 4000.
	it("liveness probe honors PROXY_PORT from ~/.env", { skip: repoEnvHasProxyPort() }, async () => {
		const net = await import("node:net");
		const listener = net.createServer();
		await new Promise((r) => listener.listen(0, "127.0.0.1", r));
		const livePort = listener.address().port;
		// Acquire a second ephemeral port and release it — a just-freed port is
		// reliably closed, unlike livePort+1 which some other service may hold.
		const scratch = net.createServer();
		await new Promise((r) => scratch.listen(0, "127.0.0.1", r));
		const deadPort = scratch.address().port;
		await new Promise((r) => scratch.close(r));

		async function runWithHomeEnv(port) {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-home-"));
			const cache = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-cache-"));
			fs.writeFileSync(path.join(home, ".env"), `PROXY_PORT=${port}\n`);
			// PROXY_PORT must come from ~/.env, not the process env, so strip it.
			const { PROXY_PORT: _ignored, ...baseEnv } = process.env;
			const env = {
				...baseEnv,
				HOME: home,
				CLAUDE_PLUGIN_DATA: cache,
				GLM_API_KEY: "",
				OPENROUTER_API_KEY: "",
			};
			try {
				return await new Promise((resolve) => {
					const child = execFile("node", [SCRIPT], { env }, (_err, stdout) => resolve(stdout));
					child.stdin.end("{}");
				});
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
				fs.rmSync(cache, { recursive: true, force: true });
			}
		}

		try {
			const upOut = await runWithHomeEnv(livePort);
			assert.ok(
				!upOut.includes("proxy down"),
				`~/.env port ${livePort} is live but probe missed it: ${upOut}`,
			);
			const downOut = await runWithHomeEnv(deadPort);
			assert.ok(
				downOut.includes("proxy down"),
				`~/.env port ${deadPort} is dead but no warning shown: ${downOut}`,
			);
		} finally {
			await new Promise((r) => listener.close(r));
		}
	});

	it("shows GLM 5h quota when key is set", { skip: !process.env.GLM_API_KEY }, async () => {
		const { stdout } = await run(
			{
				rate_limits: {
					five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
				},
			},
			{ OPENROUTER_API_KEY: "" },
		);
		assert.ok(stdout.includes("glm 5h:"), `Expected glm section, got: ${stdout}`);
		// Normal (non-exhausted) GLM shows a percentage, not a countdown. The
		// ⏱ countdown only appears at 100%, which a live quota rarely is.
		assert.match(stdout, /glm 5h:\S*\d+%/, `Expected glm percentage, got: ${stdout}`);
	});

	it("renders qw:on as a presence marker, gated on DASHSCOPE_API_KEY", async () => {
		// Deliberately not a gauge: QwenCloud has no quota API reachable with an API
		// key (the console figure is cookie-authenticated), so the marker carries no
		// number. If this ever grows a percentage, a real endpoint must back it.
		const on = await run(
			{},
			{ GLM_API_KEY: "", OPENROUTER_API_KEY: "", DASHSCOPE_API_KEY: "qwen-test" },
		);
		assert.ok(plain(on.stdout).includes("qw:on"), `Expected qw:on, got: ${on.stdout}`);

		const off = await run({}, { GLM_API_KEY: "", OPENROUTER_API_KEY: "", DASHSCOPE_API_KEY: "" });
		assert.ok(!plain(off.stdout).includes("qw:"), `Expected no qw section, got: ${off.stdout}`);
	});

	// --- stale-while-revalidate: the render path never touches the network ----
	//
	// These drive the real script against a LOCAL counting stub, because the
	// defect they lock is about how many upstream requests one cache expiry
	// costs — something no unit test of a pure function can observe. Measured
	// before the fix, at the p50 latency of the real GLM endpoint: six renders
	// 300ms apart across ONE expiry issued FIVE rounds of fetches, and cold
	// renders ran 1478–2216ms against cc-status's 2s kill.

	// A stub that counts requests and answers slowly enough that several renders
	// overlap one refresh window. Returns { url, count(), close() }.
	async function countingBalanceStub(delayMs = 600) {
		const http = await import("node:http");
		let count = 0;
		const server = http.createServer((_req, res) => {
			count += 1;
			setTimeout(() => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "42.00" }] }));
			}, delayMs);
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		return {
			url: `http://127.0.0.1:${server.address().port}/user/balance`,
			count: () => count,
			close: () => new Promise((r) => server.close(r)),
		};
	}

	// Render N times at Claude Code's real ~300ms cadence, all sharing one cache
	// dir, and resolve once every render has exited.
	async function renderBurst(n, env, gapMs = 300) {
		const running = [];
		for (let i = 0; i < n; i += 1) {
			running.push(run({}, env));
			if (i < n - 1) await new Promise((r) => setTimeout(r, gapMs));
		}
		return Promise.all(running);
	}

	it("one cache expiry costs ONE upstream fetch, not one per render", async () => {
		const stub = await countingBalanceStub();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-swr-"));
		try {
			const env = {
				CLAUDE_PLUGIN_DATA: dir,
				DEEPSEEK_BALANCE_URL: stub.url,
				DEEPSEEK_API_KEY: "stub-key",
				GLM_API_KEY: "",
				OPENROUTER_API_KEY: "",
				DASHSCOPE_API_KEY: "",
			};
			await renderBurst(6, env);
			// Let the detached refresher finish before counting.
			await new Promise((r) => setTimeout(r, 1500));
			assert.equal(
				stub.count(),
				1,
				`6 renders across one expiry must issue exactly 1 fetch, got ${stub.count()}`,
			);
		} finally {
			await stub.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never blocks the render on a slow provider", async () => {
		// The renderer must return well inside cc-status's 2s kill even when the
		// upstream would take longer than that window on its own.
		const stub = await countingBalanceStub(3000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-swr-"));
		try {
			const env = {
				CLAUDE_PLUGIN_DATA: dir,
				DEEPSEEK_BALANCE_URL: stub.url,
				DEEPSEEK_API_KEY: "stub-key",
				GLM_API_KEY: "",
				OPENROUTER_API_KEY: "",
				DASHSCOPE_API_KEY: "",
			};
			const started = Date.now();
			await run({}, env);
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 1000, `Render must not wait on the fetch; took ${elapsed}ms`);
		} finally {
			await stub.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("serves an expired value marked stale instead of dropping the segment", async () => {
		// The old code re-fetched inline on expiry and, when that overran the
		// composer's kill, emitted NOTHING — the segment vanished from the bar.
		// An expired cache must still render, with "!" saying the number is old.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-swr-"));
		try {
			fs.writeFileSync(
				path.join(dir, "deepseek_balance_cache.json"),
				JSON.stringify({ remaining: 42, currency: "USD", _ts: Date.now() - 120_000 }),
			);
			const { stdout } = await run(
				{},
				{
					CLAUDE_PLUGIN_DATA: dir,
					// Unreachable: proves the render does not depend on the fetch.
					DEEPSEEK_BALANCE_URL: "http://127.0.0.1:1/user/balance",
					DEEPSEEK_API_KEY: "stub-key",
					GLM_API_KEY: "",
					OPENROUTER_API_KEY: "",
					DASHSCOPE_API_KEY: "",
				},
			);
			assert.match(plain(stdout), /ds:\$\$!/, `Expected a stale-marked ds gauge, got: ${stdout}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("holds the refresh lock so a concurrent render does not spawn a second refresher", async () => {
		// MUTATION GUARD for takeRefreshLock(): with the lock removed, every render
		// in the window spawns its own refresher and the fetch count rises with the
		// render count. A fresh lock file must therefore suppress the spawn.
		const stub = await countingBalanceStub();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-swr-"));
		try {
			fs.writeFileSync(path.join(dir, "refresh.lock"), "999999");
			await run(
				{},
				{
					CLAUDE_PLUGIN_DATA: dir,
					DEEPSEEK_BALANCE_URL: stub.url,
					DEEPSEEK_API_KEY: "stub-key",
					GLM_API_KEY: "",
					OPENROUTER_API_KEY: "",
					DASHSCOPE_API_KEY: "",
				},
			);
			await new Promise((r) => setTimeout(r, 1200));
			assert.equal(stub.count(), 0, `A held lock must suppress the refresh, got ${stub.count()}`);
		} finally {
			await stub.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refresh survives the composer's process-group kill", async () => {
		// THE load-bearing property. cc-status's `_run_bounded` kills the renderer's
		// whole process GROUP (`kill -TERM -- -$pid`) at CC_STATUS_TIMEOUT. An
		// ordinary child is reaped by that kill, so a non-detached refresher would
		// die before writing and the cache would never fill — the gauge would go
		// permanently blank instead of merely flickering. `detached: true` puts the
		// refresher in its own group, out of the kill's reach.
		//
		// Reproduces the composer's kill exactly: setsid-equivalent via `set -m`,
		// then the same `kill -TERM -- -$pid` against the render's group.
		const stub = await countingBalanceStub(700);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-kill-"));
		try {
			// The kill is UNCONDITIONAL and inline — not a watchdog racing `wait`.
			// The render now exits in ~150ms, so a watchdog cancelled after `wait`
			// returns would never fire and the test would pass for the wrong reason
			// (it did, on the first attempt: `detached: false` survived it).
			// Sleeping past the render's exit but well inside the 700ms fetch means
			// the kill lands while ONLY the refresher is still running.
			const script = [
				"set -m",
				`( printf '{}' | node ${JSON.stringify(SCRIPT)} ) >/dev/null 2>&1 &`,
				"pid=$!",
				"sleep 0.4",
				"kill -TERM -- -$pid 2>/dev/null",
				"wait $pid 2>/dev/null",
				"true",
			].join("\n");
			await new Promise((resolve) => {
				const child = execFile(
					"bash",
					["-c", script],
					{
						env: {
							...process.env,
							CLAUDE_PLUGIN_DATA: dir,
							DEEPSEEK_BALANCE_URL: stub.url,
							DEEPSEEK_API_KEY: "stub-key",
							GLM_API_KEY: "",
							OPENROUTER_API_KEY: "",
							DASHSCOPE_API_KEY: "",
						},
					},
					() => resolve(),
				);
				child.stdin?.end();
			});
			const cacheFile = path.join(dir, "deepseek_balance_cache.json");
			for (let i = 0; i < 60 && !fs.existsSync(cacheFile); i += 1) {
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.ok(
				fs.existsSync(cacheFile),
				"Refresher was reaped by the group kill — it must be detached, or the gauge never refreshes",
			);
		} finally {
			await stub.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reclaims an abandoned lock instead of wedging the gauge forever", async () => {
		// A refresher killed by the composer's group-kill leaves its lock behind.
		// Without the mtime reclaim the gauge would never refresh again — a
		// permanent freeze, strictly worse than the flicker this replaces.
		const stub = await countingBalanceStub();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-swr-"));
		try {
			const lock = path.join(dir, "refresh.lock");
			fs.writeFileSync(lock, "999999");
			// Backdate past REFRESH_LOCK_STALE_MS (10s).
			const old = Date.now() - 30_000;
			fs.utimesSync(lock, old / 1000, old / 1000);
			await run(
				{},
				{
					CLAUDE_PLUGIN_DATA: dir,
					DEEPSEEK_BALANCE_URL: stub.url,
					DEEPSEEK_API_KEY: "stub-key",
					GLM_API_KEY: "",
					OPENROUTER_API_KEY: "",
					DASHSCOPE_API_KEY: "",
				},
			);
			await new Promise((r) => setTimeout(r, 1500));
			assert.equal(stub.count(), 1, `An abandoned lock must be reclaimed, got ${stub.count()}`);
		} finally {
			await stub.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// Integration test — only runs when OPENROUTER_API_KEY is set
	it(
		"shows OpenRouter credits when key is set",
		{ skip: !process.env.OPENROUTER_API_KEY },
		async () => {
			const { stdout } = await run({}, { GLM_API_KEY: "" });
			// Strip ANSI color codes: the script emits `or:<color>$$<reset>`,
			// so a color code sits between `or:` and the $ tier on a live run.
			// ESC built via fromCharCode to avoid a literal control char in the regex.
			const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
			const plain = stdout.replace(ansi, "");
			assert.match(plain, /or:\$+/, `Expected or section, got: ${stdout}`);
		},
	);
});

describe("takeRefreshLock (scripts/refresh-lock.js)", () => {
	const stale = (dir) => {
		const lock = refreshLockPath(dir);
		fs.writeFileSync(lock, "999999");
		const old = (Date.now() - 30_000) / 1000;
		fs.utimesSync(lock, old, old);
		return lock;
	};

	it("hands an abandoned lock to exactly ONE of two racing reclaimers", () => {
		// THE defect this seam exists to catch. Both racers pass the mtime check
		// before either acts — the check-then-act window — and then act in turn.
		// A plain overwrite gave the lock to both. So did a bare rename(): rename
		// is atomic about the PATH, not the FILE, so the second racer simply
		// renamed the first one's FRESH lock away. And so did rename plus an
		// inode-only verification, on exactly this platform: ext4/overlayfs
		// recycle a freed inode for the next create, so the winner's fresh lock
		// inherits the judged-stale file's inode number and the loser's check
		// false-matches (this test failed that way on CI while passing on APFS,
		// which never reuses inode numbers). Only verifying the moved file is the
		// one we judged stale — inode AND mtime, which rename preserves and a
		// fresh write cannot reproduce — makes the loser cede everywhere.
		//
		// Deterministic on purpose: a real racing test does NOT separate the two
		// implementations. Measured, 60 rounds x 12 processes: the broken variant
		// double-granted in 5 of 60 rounds, so ~92% of runs are green against the
		// defect and any CI sample would pass it.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-lock-race-"));
		try {
			stale(dir);
			let second = null;
			// A's reclaim is interrupted after it judged the lock stale; B runs to
			// completion inside that window and legitimately takes the lock.
			const first = takeRefreshLock(dir, {
				afterStat: () => {
					if (second === null) second = takeRefreshLock(dir);
				},
			});
			assert.equal(second, true, "the racer that acts inside the window must win");
			assert.equal(first, false, "the racer whose lock was taken must NOT also win");
			assert.equal(
				fs.readFileSync(refreshLockPath(dir), "utf8"),
				String(process.pid),
				"the winner's lock must still be in place",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves no .stale debris behind when a reclaim loses", () => {
		// The loser renames the winner's lock to a private path and must put it
		// back. A leftover would wedge nothing (the path is pid-private) but a
		// LOST lock would freeze the gauge forever — the failure the reclaim
		// exists to prevent, re-created by its own error path.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-lock-debris-"));
		try {
			stale(dir);
			takeRefreshLock(dir, { afterStat: () => takeRefreshLock(dir) });
			const left = fs.readdirSync(dir).filter((f) => f.endsWith(".stale"));
			assert.deepEqual(left, [], `no .stale debris, got ${left.join(", ")}`);
			assert.ok(fs.existsSync(refreshLockPath(dir)), "the lock file must survive a lost race");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes a free lock and refuses a fresh one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-lock-basic-"));
		try {
			assert.equal(takeRefreshLock(dir), true, "a free lock is taken");
			assert.equal(takeRefreshLock(dir), false, "a lock held by someone else is refused");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
