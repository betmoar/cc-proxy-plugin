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

// Fail loud on a bad port instead of letting listen() throw a bare RangeError:
// a typo'd PROXY_PORT would otherwise leave a cryptic stack in the log while
// ANTHROPIC_BASE_URL points at the (equally typo'd) dead port.
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
	console.error(
		`Invalid proxy port "${process.env.PROXY_PORT ?? config.port}" — set PROXY_PORT (or --port) to an integer 1–65535.`,
	);
	process.exit(1);
}

const server = createServer(config);
server.on("error", (err) => {
	// Two SessionStart hooks can race past the TCP probe and both spawn; the
	// loser lands here. One proxy on the port is the goal state, so report
	// plainly rather than dumping an uncaught stack into the log.
	if (/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE") {
		console.error(
			`Port ${config.port} is already in use (another cc-proxy?). Nothing started; check lsof -ti:${config.port}.`,
		);
	} else {
		console.error(`cc-proxy failed to listen: ${err.message}`);
	}
	process.exit(1);
});
server.listen(config.port, config.host, () => {
	console.log(`cc-proxy listening on http://${config.host}:${config.port}`);
	for (const p of config.providers) {
		console.log(`  ${p.id.padEnd(6)} -> ${p.baseUrl}  [auth: ${p.auth}]`);
	}
	console.log(`  default: ${defaultProvider(config).id}`);
});
