// @ts-check
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PORT = Number(process.env.PROXY_PORT || 4000);
const POLL_INTERVAL_MS = 100;

// This file runs from inside the plugin tree (marketplace cache dir or dev
// repo), so its own location identifies the CURRENT plugin version — unlike a
// PROXY_PATH pinned into settings.json by an old /cc-proxy:setup run, which
// keeps pointing at the cache dir of whatever version was installed then.
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the proxy entry point. The plugin tree's own `bin/cc-proxy.js`
 * (sibling of hooks/) wins; a PROXY_PATH from env is only a fallback for
 * hand-rolled installs where the tree carries no bin. This is the fix for the
 * staleness trap: settings.json's version-pinned PROXY_PATH used to outrank
 * everything, so plugin updates shipped code nobody ran.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [hooksDir]  Overridable for tests.
 * @returns {string | undefined}
 */
export function resolveProxyPath(env = process.env, hooksDir = HOOKS_DIR) {
	const own = path.resolve(hooksDir, "..", "bin", "cc-proxy.js");
	if (fs.existsSync(own)) return own;
	return env.PROXY_PATH || undefined;
}

/**
 * Version of the plugin tree this hook runs from (package.json sibling of
 * hooks/). Undefined when unreadable — callers must then skip version checks.
 * @param {string} [hooksDir]  Overridable for tests.
 * @returns {string | undefined}
 */
export function pluginVersion(hooksDir = HOOKS_DIR) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(hooksDir, "..", "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Is `a` an OLDER version than `b`? Numeric, segment-by-segment — a string
 * compare would rank "0.6.10" below "0.6.9" and evict the newer build.
 *
 * Only the leading numeric segments are compared; a pre-release suffix
 * ("0.7.0-rc.1") is deliberately treated as its base version, because the
 * question here is "is this proxy behind the tree", not "which release is
 * canonical". A malformed segment reads as 0, so garbage sorts oldest and is
 * replaced rather than trusted.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isOlderVersion(a, b) {
	/** @param {string} v @returns {number[]} */
	const parse = (v) =>
		String(v)
			.split("-")[0]
			.split(".")
			.map((n) => {
				const i = Number.parseInt(n, 10);
				return Number.isFinite(i) ? i : 0;
			});
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d < 0;
	}
	return false;
}

/**
 * GET /_status on a listening proxy and return its reported version.
 * Distinguishes three cases: a cc-proxy that reports a version (string), a
 * cc-proxy too old to report one (null), and something that doesn't speak the
 * contract at all — foreign listener, timeout (undefined).
 * @param {number} port
 * @returns {Promise<string | null | undefined>}
 */
export function probeProxyVersion(port) {
	return new Promise((resolve) => {
		const req = http.get(
			{ hostname: "127.0.0.1", port, path: "/_status", timeout: 1000 },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					try {
						const json = JSON.parse(Buffer.concat(chunks).toString());
						// Only trust a payload that looks like our /_status contract.
						if (res.statusCode === 200 && Array.isArray(json.providers)) {
							resolve(typeof json.version === "string" ? json.version : null);
							return;
						}
					} catch {}
					resolve(undefined);
				});
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(undefined));
	});
}

/**
 * POST /_shutdown to a running proxy. Resolves once the response arrives (or
 * errors); the caller then polls the port until the listener is gone.
 * @param {number} port
 * @returns {Promise<boolean>} true if the proxy acknowledged the shutdown.
 */
export function requestShutdown(port) {
	return new Promise((resolve) => {
		const req = http.request(
			{ hostname: "127.0.0.1", port, path: "/_shutdown", method: "POST", timeout: 1000 },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode === 200));
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}

/**
 * Poll until nothing accepts connections on the port, or the deadline passes.
 * @param {number} port
 * @param {number} deadline ms epoch
 * @returns {Promise<boolean>} true once the port is free.
 */
async function waitGone(port, deadline) {
	while (Date.now() < deadline) {
		if (!(await checkPort(port))) return true;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return !(await checkPort(port));
}

// The proxy log is append-only and never truncated by the proxy itself, so it
// grows unbounded over the life of the machine (~1 routing line per request).
// Before each spawn, if it has passed this cap, rotate it to a single `.1`
// backup so the live log starts fresh. One generation is enough — this is a
// debug breadcrumb, not an audit trail.
// The default log used to be /tmp/cc-proxy.log. On a multi-user machine /tmp is
// world-writable and sticky-bit only protects against *deletion*: another local
// user can pre-create cc-proxy.log as a symlink, and our O_APPEND open then
// follows it, splicing routing lines into a file they choose. No key material
// leaks (the log carries model ids and paths), but it is a free write primitive
// into any path this user can write. $HOME is not shared, so defaulting there
// removes the whole class. PROXY_LOG still wins — this is a default, not a policy.
export const DEFAULT_LOG_PATH = path.join(os.homedir(), ".claude", "cc-proxy", "cc-proxy.log");

const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const envLogMax = Number(process.env.PROXY_LOG_MAX_BYTES);
// Only honor a finite, positive override; a negative/0/NaN value would disable
// rotation (size <= cap always true) or be meaningless, so fall back to default.
export const LOG_MAX_BYTES =
	Number.isFinite(envLogMax) && envLogMax > 0 ? envLogMax : DEFAULT_LOG_MAX_BYTES;

/**
 * Rotate `logPath` to `logPath.1` if it exists and exceeds `maxBytes`. Replaces
 * any prior `.1` (single-generation). Best-effort: any fs error is swallowed so
 * a rotation problem never blocks spawning the proxy.
 * @param {string} logPath
 * @param {number} [maxBytes]
 */
export function rotateLogIfLarge(logPath, maxBytes = LOG_MAX_BYTES) {
	try {
		if (fs.statSync(logPath).size <= maxBytes) return;
		// Remove the prior backup first. Not for EEXIST — modern libuv renames
		// through MoveFileEx(MOVEFILE_REPLACE_EXISTING) and overwrites an
		// existing FILE on Windows just as POSIX does (the EEXIST divergence was
		// `_wrename`, fixed in libuv over a decade ago). The real Windows hazard
		// is a sharing violation: an open handle on the destination — an editor,
		// a tail, an antivirus scan — surfaces as EPERM/EBUSY, and rename cannot
		// retry past it while unlink-then-rename usually can. This catch swallows,
		// so a failure here leaves the log unrotated forever and silently.
		fs.rmSync(`${logPath}.1`, { force: true });
		fs.renameSync(logPath, `${logPath}.1`);
	} catch {
		// Log absent (statSync throws) or rename failed — nothing to rotate.
	}
}

// COUPLING: this bounds ONE probe, and checkPort is called in a poll loop
// (waitReady/waitGone, every POLL_INTERVAL_MS) inside the SessionStart hook,
// which hooks.json kills at 10s. Without a timer a connect that is DROPped
// rather than REJECTed (loopback behind a deny-by-drop firewall) never errors:
// the socket sits until the OS connect timeout (~75s), so the first poll
// iteration eats the whole hook budget and the hook dies with no proxy and no
// message. 300ms matches probePort in scripts/statusline.js and stays well
// under the 3000ms PROXY_READY_TIMEOUT_MS default, so a stuck probe still
// leaves room for several polls before the readiness deadline.
export const PROBE_TIMEOUT_MS = 300;

/**
 * Non-blocking TCP probe to 127.0.0.1:port. Resolves true if a connection
 * succeeds within `timeoutMs`, false on error or timeout. The timer is cleared
 * on both terminal paths — a live Timeout keeps the event loop alive, which
 * would hang the hook process just as surely as the stall it guards against.
 * @param {number} port
 * @param {number} [timeoutMs]  Overridable for tests.
 * @param {string} [host]  Overridable for tests (a blackhole address is the
 *   only way to exercise the timeout path); production always probes loopback.
 * @returns {Promise<boolean>}
 */
export function checkPort(port, timeoutMs = PROBE_TIMEOUT_MS, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const sock = net.createConnection(port, host);
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, timeoutMs);
		sock.on("connect", () => {
			clearTimeout(timer);
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

/**
 * Poll checkPort until it returns true or the deadline (ms epoch) passes.
 * @param {number} port
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
export async function waitReady(port, deadline) {
	while (Date.now() < deadline) {
		if (await checkPort(port)) return true;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return false;
}

/**
 * Spawn the proxy detached, routing stdio to the configured log file.
 * Caller is responsible for polling readiness; this function returns
 * immediately after spawn.
 * @param {string} proxyPath
 * @param {string} logPath
 * @param {NodeJS.ProcessEnv} [env]  Defaults to process.env. Pass an explicit
 *   env when the caller carries vars the current process lacks — e.g.
 *   /cc-proxy:setup reads keys from settings.json before any SessionStart hook
 *   has injected them into process.env.
 */
export function spawnProxy(proxyPath, logPath, env = process.env) {
	// The default log now lives under ~/.claude/cc-proxy/, which need not exist
	// on a fresh machine — /tmp always did. Two guards, because this runs inside
	// the SessionStart hook and an uncaught throw here means no proxy at all and
	// ECONNREFUSED for every request in the session: create the directory, and if
	// the open still fails (unwritable PROXY_LOG, read-only $HOME, full disk),
	// spawn with discarded stdio rather than not spawning. Losing the debug log
	// is survivable; losing the proxy is not.
	let logFd;
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		rotateLogIfLarge(logPath);
		logFd = fs.openSync(logPath, "a");
	} catch {
		logFd = undefined;
	}
	try {
		const child = spawn(process.execPath, [proxyPath], {
			detached: true,
			stdio: logFd === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd],
			env,
		});
		child.unref();
	} finally {
		if (logFd !== undefined) fs.closeSync(logFd);
	}
}

/**
 * Ensure the CURRENT proxy is reachable on its port. If nothing listens, spawn
 * and wait for readiness. If a cc-proxy is listening but reports an OLDER
 * version than this plugin tree (stale process from before an update), ask it
 * to shut down via POST /_shutdown and spawn the current one in its place. A
 * proxy at the same version — or NEWER, i.e. a dev tree deliberately ahead of
 * the installed plugin — is left alone (issue #24).
 * Anything on the port that doesn't speak the /_status contract is treated as
 * foreign and left untouched ("already-up" — same behavior as the pre-version
 * TCP probe, and never a kill).
 *
 * @param {object} [opts]
 * @param {number} [opts.port]         Defaults to PROXY_PORT or 4000.
 * @param {number} [opts.readyTimeoutMs] Defaults to PROXY_READY_TIMEOUT_MS or 3000.
 * @param {string} [opts.proxyPath]    Defaults to resolveProxyPath() (own tree's
 *   bin, then env PROXY_PATH).
 * @param {string} [opts.logPath]      Defaults to PROXY_LOG or DEFAULT_LOG_PATH.
 * @param {NodeJS.ProcessEnv} [opts.env] Defaults to process.env. Forwarded to
 *   spawnProxy; see spawnProxy for when to override.
 * @returns {Promise<"already-up" | "started" | "restarted" | "missing-path" | "unreachable">}
 */
export async function ensureProxyRunning(opts = {}) {
	const port = opts.port ?? PORT;
	// Validate the env value: a non-numeric PROXY_READY_TIMEOUT_MS would yield
	// NaN, making the readiness deadline NaN and waitReady() return false
	// immediately (proxy reported unreachable even when it comes up).
	const envTimeout = Number(process.env.PROXY_READY_TIMEOUT_MS);
	const readyTimeoutMs =
		opts.readyTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 3000);
	const proxyPath = opts.proxyPath ?? resolveProxyPath();
	const logPath = opts.logPath ?? process.env.PROXY_LOG ?? DEFAULT_LOG_PATH;

	if (await checkPort(port)) {
		const running = await probeProxyVersion(port);
		const current = pluginVersion();
		// Foreign listener (undefined), unknown own version, or a proxy at least
		// as new as this tree → leave it. Only a confirmed cc-proxy (running !==
		// undefined) that is confirmed OLDER is replaced. `null` (a cc-proxy too
		// old to report a version) counts as older — every version from that
		// change on reports one, so null is by definition behind.
		//
		// ORDERED, not `!==` (issue #24). Inequality also evicted a proxy NEWER
		// than the hook's tree, which is the normal state during development: the
		// working tree runs `bin/cc-proxy.js` at the next version while the
		// installed plugin cache is still on the last one. Because SessionStart
		// fires on every `claude` invocation, the client under test kept
		// replacing the binary under test — a routing fix verified as broken four
		// times in a row before the cause was found. The staleness protection is
		// unchanged in the direction it was written for: an older long-lived
		// proxy is still replaced after a plugin update.
		const stale =
			running !== undefined &&
			current !== undefined &&
			(running === null || isOlderVersion(running, current));
		if (!stale) return "already-up";
		if (!proxyPath) return "missing-path";

		const acked = await requestShutdown(port);
		// close() waits for in-flight responses, so allow the drain a share of
		// the ready budget; if the old process won't die, leave it — two proxies
		// racing one port is worse than one stale proxy.
		const gone = acked && (await waitGone(port, Date.now() + readyTimeoutMs));
		if (!gone) return "already-up";

		spawnProxy(proxyPath, logPath, opts.env);
		const up = await waitReady(port, Date.now() + readyTimeoutMs);
		return up ? "restarted" : "unreachable";
	}

	if (!proxyPath) return "missing-path";

	spawnProxy(proxyPath, logPath, opts.env);
	const up = await waitReady(port, Date.now() + readyTimeoutMs);
	return up ? "started" : "unreachable";
}
