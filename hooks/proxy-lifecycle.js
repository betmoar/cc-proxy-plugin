// @ts-check
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export const PORT = Number(process.env.PROXY_PORT || 4000);
const POLL_INTERVAL_MS = 100;

// The proxy log is append-only and never truncated by the proxy itself, so it
// grows unbounded over the life of the machine (~1 routing line per request).
// Before each spawn, if it has passed this cap, rotate it to a single `.1`
// backup so the live log starts fresh. One generation is enough — this is a
// debug breadcrumb, not an audit trail.
export const LOG_MAX_BYTES = Number(process.env.PROXY_LOG_MAX_BYTES) || 5 * 1024 * 1024;

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
		fs.renameSync(logPath, `${logPath}.1`);
	} catch {
		// Log absent (statSync throws) or rename failed — nothing to rotate.
	}
}

/**
 * Non-blocking TCP probe to 127.0.0.1:port. Resolves true if a connection
 * succeeds within the default socket timeout, false otherwise.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function checkPort(port) {
	return new Promise((resolve) => {
		const sock = net.createConnection(port, "127.0.0.1");
		sock.on("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => resolve(false));
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
 */
export function spawnProxy(proxyPath, logPath) {
	rotateLogIfLarge(logPath);
	const logFd = fs.openSync(logPath, "a");
	try {
		const child = spawn(process.execPath, [proxyPath], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.unref();
	} finally {
		fs.closeSync(logFd);
	}
}

/**
 * Ensure the proxy is reachable on its port. If not, spawn it and wait for
 * readiness. Safe to call from any hook; if PROXY_PATH is unset we can't
 * spawn and the caller must tolerate a dead proxy.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]         Defaults to PROXY_PORT or 4000.
 * @param {number} [opts.readyTimeoutMs] Defaults to PROXY_READY_TIMEOUT_MS or 3000.
 * @param {string} [opts.proxyPath]    Defaults to PROXY_PATH.
 * @param {string} [opts.logPath]      Defaults to PROXY_LOG or /tmp/cc-proxy.log.
 * @returns {Promise<"already-up" | "started" | "missing-path" | "unreachable">}
 */
export async function ensureProxyRunning(opts = {}) {
	const port = opts.port ?? PORT;
	// Validate the env value: a non-numeric PROXY_READY_TIMEOUT_MS would yield
	// NaN, making the readiness deadline NaN and waitReady() return false
	// immediately (proxy reported unreachable even when it comes up).
	const envTimeout = Number(process.env.PROXY_READY_TIMEOUT_MS);
	const readyTimeoutMs =
		opts.readyTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 3000);
	const proxyPath = opts.proxyPath ?? process.env.PROXY_PATH;
	const logPath = opts.logPath ?? process.env.PROXY_LOG ?? "/tmp/cc-proxy.log";

	if (await checkPort(port)) return "already-up";
	if (!proxyPath) return "missing-path";

	spawnProxy(proxyPath, logPath);
	const up = await waitReady(port, Date.now() + readyTimeoutMs);
	return up ? "started" : "unreachable";
}
