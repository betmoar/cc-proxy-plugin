import { strict as assert } from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";

// COUPLING drift-lock: the standalone-install marketplace advertises the plugin
// at repo root. Its plugin entry name and source must stay in sync with
// plugin.json so `/plugin install cc-proxy@cc-proxy-plugin` resolves. The
// marketplace carries no per-plugin version (it points at ./ ), so there is
// nothing to keep in step with the version — only the name and source.
describe("marketplace manifest", () => {
	const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));

	it("advertises cc-proxy at source ./ matching plugin.json", () => {
		const mk = read("../.claude-plugin/marketplace.json");
		const plugin = read("../.claude-plugin/plugin.json");
		assert.ok(Array.isArray(mk.plugins) && mk.plugins.length >= 1);
		const entry = mk.plugins.find((p) => p.name === plugin.name);
		assert.ok(entry, `marketplace has no entry named ${plugin.name}`);
		assert.equal(entry.source, "./", "plugin lives at repo root — source must be ./");
		assert.ok(mk.name && mk.owner && mk.owner.name, "marketplace missing name/owner");
	});
});
