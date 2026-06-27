import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

	it("renders api: $-tiers by digit count, unbounded above $999", async () => {
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
					plain(stdout).includes(`api:${expected} `) || plain(stdout).endsWith(`api:${expected}`),
					`remaining=${remaining}: expected api:${expected}, got: ${plain(stdout)}`,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
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

	// Integration test — only runs when OPENROUTER_API_KEY is set
	it(
		"shows OpenRouter credits when key is set",
		{ skip: !process.env.OPENROUTER_API_KEY },
		async () => {
			const { stdout } = await run({}, { GLM_API_KEY: "" });
			// Strip ANSI color codes: the script emits `api:<color>$$<reset>`,
			// so a color code sits between `api:` and the $ tier on a live run.
			// ESC built via fromCharCode to avoid a literal control char in the regex.
			const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
			const plain = stdout.replace(ansi, "");
			assert.match(plain, /api:\$+/, `Expected api section, got: ${stdout}`);
		},
	);
});
