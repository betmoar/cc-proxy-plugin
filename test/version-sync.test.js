import { strict as assert } from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";

// INVARIANT (release plumbing): package.json is the single source of truth for
// the version, and .claude-plugin/plugin.json must match it — the plugin cache
// key IS the plugin.json version string, so a stale plugin.json means end users
// silently never receive an update. `pnpm sync-version` (or the npm `version`
// lifecycle) keeps them in step; this test makes forgetting it a red build.
describe("version sync", () => {
	it("plugin.json version matches package.json (run `pnpm sync-version` if not)", () => {
		const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
		const pkg = read("../package.json");
		const plugin = read("../.claude-plugin/plugin.json");
		assert.equal(
			plugin.version,
			pkg.version,
			"plugin.json version drifted from package.json — run `pnpm sync-version`",
		);
	});
});
