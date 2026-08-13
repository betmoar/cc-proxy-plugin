#!/usr/bin/env node
// @ts-check
import { parseArgs } from "node:util";
import { load } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { defaultProvider } from "../src/providers.js";
import { createServer } from "../src/server.js";

// Load API keys + config from ~/.env (canonical for the installed plugin) and,
// if present, the repo-root .env (dev/inline). Values already in process.env —
// e.g. Claude Code's settings.json `env` block — win over either file. Silent
// no-op when a file is absent.
loadEnv();

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

// GLM (and every other third-party backend) is opt-in: buildProviders() only
// registers it when its key is present. Claude (OAuth, no key) is always
// available, so a zero-key start is a valid install, never a misconfigured
// one — never exit on a missing third-party key. Still surface it loudly: a
// user who MEANT to configure GLM (the product's original reason to exist)
// should notice it silently didn't register.
const active = config.providers.map((p) => p.id);
const thirdParty = active.filter((id) => id !== "claude");
if (thirdParty.length === 0) {
	console.error(
		"cc-proxy: active backends: claude only (no third-party keys found). Run /cc-proxy:setup to add GLM/OpenRouter/DeepSeek/Qwen.",
	);
} else if (!active.includes("glm")) {
	// Some third-party backend registered but GLM didn't — most likely an
	// unset/typo'd GLM_API_KEY rather than a deliberate choice, so name it.
	console.error(
		`cc-proxy: active backends: ${active.join(", ")} (GLM_API_KEY is not set — put it in ~/.env, or run /cc-proxy:setup)`,
	);
} else {
	console.error(`cc-proxy: active backends: ${active.join(", ")}`);
}

// DEFAULT_BACKEND can name a backend that never registered — keys became opt-in
// in #20, so `DEFAULT_BACKEND=deepseek` with no DeepSeek key is a live
// misconfiguration, not a typo the shell would catch. buildProviders() sets
// `isDefault` only on a provider it actually built, so NOBODY carrying the flag
// means the requested id is not here and defaultProvider() has quietly fallen
// through to claude. Before this, that install printed a success line
// byte-identical to a correct one, and skills/setup/SKILL.md RECOMMENDS
// DEFAULT_BACKEND for backends the single /model slot cannot select — so this
// is a documented path, not an exotic one. Say which backend is really serving.
const requestedDefault = values["default-backend"] || process.env.DEFAULT_BACKEND;
if (requestedDefault && !config.providers.some((p) => p.isDefault)) {
	console.error(
		`cc-proxy: DEFAULT_BACKEND=${requestedDefault} did NOT register (no key?) — falling back to claude. Unmatched ids go to claude, not ${requestedDefault}.`,
	);
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
