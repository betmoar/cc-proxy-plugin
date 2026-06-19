#!/usr/bin/env node
// @ts-check
import { parseArgs } from "node:util";
import { load } from "../src/config.js";
import { defaultProvider, providerById } from "../src/providers.js";
import { createServer } from "../src/server.js";

// Load a local .env from the package root if present (standalone `npm run
// proxy` / dev). Values already in process.env — e.g. from Claude Code's
// settings.json `env` block in the plugin flow — take precedence, so this is a
// no-op there. Silently skipped when the file is absent.
try {
	process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

const { values } = parseArgs({
	options: {
		port: { type: "string", short: "p" },
		"default-backend": { type: "string", short: "d" },
	},
});

const config = load({
	port: values.port,
	defaultBackend: values["default-backend"],
});

const glm = providerById(config, "glm");
if (glm && !glm.apiKey) {
	console.error("GLM_API_KEY is not set.");
	process.exit(1);
}

const server = createServer(config);
server.listen(config.port, () => {
	console.log(`cc-proxy listening on http://localhost:${config.port}`);
	for (const p of config.providers) {
		console.log(`  ${p.id.padEnd(6)} -> ${p.baseUrl}  [auth: ${p.auth}]`);
	}
	console.log(`  default: ${defaultProvider(config).id}`);
});
