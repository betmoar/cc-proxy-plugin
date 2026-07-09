// @ts-check
import os from "node:os";
import path from "node:path";

/**
 * Load proxy config from dotenv files. The canonical key store for the installed
 * plugin is `~/.env`; the repo-root `.env` is the dev/inline convenience. Both are
 * loaded best-effort — `process.loadEnvFile` never overwrites an existing
 * `process.env` var, so precedence is process.env > repo `.env` > `~/.env`.
 *
 * No-op when a file is absent (silent), so this is safe to call from every entry
 * point (the proxy, status, statusline) regardless of which files exist on disk.
 *
 * @param {string} [home] Home dir holding `.env`. Defaults to `os.homedir()`.
 */
export function loadEnv(home = os.homedir()) {
	// Repo `.env` first so a dev checkout's file wins over a stale global `~/.env`,
	// then the home file. In the install cache the repo file is absent (gitignored),
	// so only `~/.env` loads there.
	try {
		process.loadEnvFile(new URL("../.env", import.meta.url));
	} catch {}
	try {
		process.loadEnvFile(path.join(home, ".env"));
	} catch {}
}
