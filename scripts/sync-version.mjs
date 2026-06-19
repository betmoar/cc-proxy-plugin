#!/usr/bin/env node
// Propagate package.json version — the single source of truth — into the two
// plugin manifests Claude Code reads directly. Runs automatically via the
// npm/pnpm `version` lifecycle, or manually: `pnpm run sync-version`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, obj) => fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);

const pkgPath = path.join(root, "package.json");
const pluginPath = path.join(root, "plugins/cc-proxy/.claude-plugin/plugin.json");
const marketPath = path.join(root, ".claude-plugin/marketplace.json");

const { version } = read(pkgPath);
if (!version) {
	console.error("sync-version: package.json has no version field");
	process.exit(1);
}

const plugin = read(pluginPath);
plugin.version = version;
write(pluginPath, plugin);

const market = read(marketPath);
if (market.metadata) market.metadata.version = version;
for (const entry of market.plugins ?? []) {
	if (entry.name === plugin.name) entry.version = version;
}
write(marketPath, market);

console.log(`sync-version: wrote ${version} to plugin.json and marketplace.json`);
