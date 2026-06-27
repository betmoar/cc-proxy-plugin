import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../scripts/statusline.js",
);

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
	it("shows claude usage when rate_limits is present", async () => {
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

	it("shows -- for claude when rate_limits is missing", async () => {
		const { stdout } = await run({}, { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.ok(stdout.includes("cc 5h:--"), `Expected --, got: ${stdout}`);
	});

	it("handles empty stdin gracefully", async () => {
		const { stdout, code } = await run("", { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.equal(code, 0);
		assert.ok(stdout.includes("cc 5h:--"), `Expected graceful handling, got: ${stdout}`);
	});

	// Integration test — only runs when GLM_API_KEY is set
	it("shows GLM quota when key is set", { skip: !process.env.GLM_API_KEY }, async () => {
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
