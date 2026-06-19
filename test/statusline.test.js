import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../plugins/cc-proxy/scripts/statusline.js",
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
		assert.ok(stdout.includes("claude 5h:"), `Expected claude section, got: ${stdout}`);
		assert.ok(stdout.includes("42%"), `Expected 42%, got: ${stdout}`);
	});

	it("shows -- for claude when rate_limits is missing", async () => {
		const { stdout } = await run({}, { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.ok(stdout.includes("claude 5h:--"), `Expected --, got: ${stdout}`);
	});

	it("handles empty stdin gracefully", async () => {
		const { stdout, code } = await run("", { GLM_API_KEY: "", OPENROUTER_API_KEY: "" });
		assert.equal(code, 0);
		assert.ok(stdout.includes("claude 5h:--"), `Expected graceful handling, got: ${stdout}`);
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
		assert.ok(stdout.includes("glm["), `Expected glm section, got: ${stdout}`);
	});

	// Integration test — only runs when OPENROUTER_API_KEY is set
	it(
		"shows OpenRouter credits when key is set",
		{ skip: !process.env.OPENROUTER_API_KEY },
		async () => {
			const { stdout } = await run({}, { GLM_API_KEY: "" });
			assert.ok(stdout.includes("or:$"), `Expected openrouter section, got: ${stdout}`);
		},
	);
});
