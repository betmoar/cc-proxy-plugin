import fs from "node:fs";
import path from "node:path";

// REFRESH_LOCK_STALE_MS bounds the single-flight lock. Without the lock, all
// renders during the ~2s refresh window see the same expired cache and each
// spawns its own refresher — the stampede this fixes, moved one level down.
// Measured before the lock: six renders 300ms apart across ONE expiry all
// fetched (2241/1599/1584/1146/721/600ms) = ~6 rounds of API calls where 1 was
// intended. The lock is a file whose mtime is checked, never a pid: a refresher
// killed between spawn and completion leaves the file behind, and an mtime
// older than this window is treated as abandoned rather than wedging the gauge
// forever. It is deliberately longer than a healthy refresh (~2s) and far
// shorter than the 60s TTL.
export const REFRESH_LOCK_STALE_MS = 10_000;

/** @param {string} cacheDir */
export const refreshLockPath = (cacheDir) => path.join(cacheDir, "refresh.lock");

/**
 * Remove a judged-stale file so the caller may try an exclusive create — the
 * ONE takeover ceremony, used for the lock and for the claim alike, because
 * every smaller version of it double-granted (the ladder is in
 * takeRefreshLock's header). Steps, and why each exists:
 *
 *   stat → stale?      the judgment (check-then-act starts here, by nature)
 *   rename → private   atomic on the PATH: of N racers, exactly one moves the
 *                      file; the rest get ENOENT and cede
 *   verify ino+mtime   rename is atomic about the path, NOT the file — the
 *                      winner may have moved a lock someone legitimately
 *                      re-created. inode alone is platform-dependent (ext4/
 *                      overlayfs recycle a freed inode for the next create;
 *                      measured on CI's image), so mtime joins it: rename
 *                      preserves mtime, a relock is stamped now, and only
 *                      files ≥ staleMs old are ever judged, so the pair can
 *                      never coincide
 *   mismatch → link()  the restore must never overwrite a contender that took
 *                      the emptied path meanwhile: link() atomically refuses
 *                      an existing destination, where a rename-back clobbered
 *                      it (mutation-verified by the tests)
 *
 * Returns true when the caller removed the stale file and may race the
 * follow-up exclusive create; false when the file is fresh, vanished, or was
 * someone else's to keep.
 *
 * @param {string} filePath
 * @param {{ afterRestat?: () => void, afterRename?: () => void }} [hooks]
 */
function takeStale(filePath, hooks = {}) {
	let seen;
	try {
		seen = fs.statSync(filePath);
	} catch {
		// Already gone — the follow-up `wx` is the arbiter.
		return true;
	}
	if (Date.now() - seen.mtimeMs < REFRESH_LOCK_STALE_MS) return false;
	hooks.afterRestat?.();
	// A pid-private destination, so a crashed takeover's leftover never collides
	// with a live one; rmSync clears our own prior leftover.
	const moved = `${filePath}.${process.pid}.stale`;
	try {
		fs.rmSync(moved, { force: true });
		fs.renameSync(filePath, moved);
		hooks.afterRename?.();
		const got = fs.statSync(moved);
		if (got.ino !== seen.ino || got.mtimeMs !== seen.mtimeMs) {
			try {
				fs.linkSync(moved, filePath);
			} catch {
				// Destination exists — a fast-path winner beat the restore.
			}
			fs.rmSync(moved, { force: true });
			return false;
		}
		fs.rmSync(moved, { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Single-flight guard. Takes the lock by creating the file exclusively (`wx`),
 * which is atomic — two renders racing here cannot both win. Returns false when
 * someone else holds it.
 *
 * A lock left behind by a killed refresher is reclaimed once its mtime is older
 * than REFRESH_LOCK_STALE_MS. That check is on the FILE's mtime, never a pid:
 * the composer kills the process group, so a pid recorded here would be a pid
 * that no longer exists and checking liveness would be a second race.
 *
 * THE RECLAIM IS A CEREMONY, and every piece exists because a smaller version
 * double-granted — each defect below was measured or forced through the test
 * seams, not imagined:
 *
 *  1. Plain overwrite after the mtime check: check-then-act, both racers win.
 *  2. rename() to a private name: rename is atomic about the PATH, not the
 *     FILE — a loser arriving after the winner relocked renames the winner's
 *     FRESH lock away and takes over (60 rounds x 12 processes on APFS: 65
 *     winners, 5 double-grants).
 *  3. rename + inode verification: ext4/overlayfs recycle a freed inode for
 *     the next create (measured on CI's image), so the loser false-matches;
 *     mtime joins the check (see takeStale).
 *  4. rename + verification, unserialized: with three contenders the loser
 *     holds the winner's renamed-away lock while the path sits empty for a
 *     fast-path `wx`, and a rename-back restore then clobbers that contender
 *     (found in review). Reclaimers now SERIALIZE on a claim file and every
 *     restore goes through link(), which refuses to overwrite.
 *  5. claim recovery by rm + recreate: the same check-then-act race one level
 *     down — two racers both judge the claim stale, one deletes the other's
 *     fresh claim, and both run the ceremony (found in review). The claim is
 *     therefore taken over by the SAME takeStale ceremony as the lock; the
 *     protocol exists once, not twice.
 *
 * What remains open, stated rather than hidden: mtime staleness plus POSIX
 * path operations cannot be made fully airtight — the refresher's own
 * release-unlink sits outside the protocol, so takeovers landing in the same
 * microsecond windows as that unlink can still admit one duplicate refresher.
 * Each ceremony layer multiplies the required coincidence by another
 * microsecond window; closing it entirely needs an OS advisory lock (flock),
 * which Node does not expose without a native dependency this zero-dependency
 * repo does not take. The residue is one duplicate round of quota fetches,
 * self-healing.
 *
 * Lives in its own module purely so tests can call it in-process and force
 * exact interleavings. A statistical racer test does NOT separate the correct
 * implementation from the broken ones at any sane sample size — measured, the
 * rename-only variant loses ~8% of rounds — so the seams are what make the
 * guarantee testable at all.
 *
 * @param {string} cacheDir
 * @param {{ afterStat?: () => void, afterRestat?: () => void, afterRename?: () => void,
 *           claim?: { afterRestat?: () => void, afterRename?: () => void } }} [hooks]
 *   test seams. `afterStat` runs after the pre-claim staleness check (where a
 *   competing reclaimer can appear); `afterRestat`/`afterRename` thread into
 *   the LOCK's takeover ceremony (where the refresher's unlink, a fast-path
 *   relock, or a contender on the emptied path can land); `claim.*` thread
 *   into the CLAIM's takeover ceremony the same way.
 */
export function takeRefreshLock(cacheDir, hooks = {}) {
	const lockPath = refreshLockPath(cacheDir);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		// Exists (or unwritable). Cheap pre-check before the ceremony: a fresh
		// lock is the overwhelmingly common case and needs no claim traffic.
		try {
			if (Date.now() - fs.statSync(lockPath).mtimeMs < REFRESH_LOCK_STALE_MS) return false;
		} catch {
			return false;
		}
		hooks.afterStat?.();

		// Serialize reclaimers (defect 4). The claim is held only across the few
		// syscalls below, never across a refresh. A claim left by a crash
		// mid-ceremony is recovered by the SAME takeover ceremony as the lock
		// (defect 5) — and a crash mid-ceremony leaves the lock path either
		// intact (re-reclaimable) or empty (the fast path self-heals), so a
		// stuck claim never wedges the gauge.
		const claimPath = `${lockPath}.claim`;
		try {
			fs.writeFileSync(claimPath, String(process.pid), { flag: "wx" });
		} catch {
			if (!takeStale(claimPath, hooks.claim)) return false;
			try {
				fs.writeFileSync(claimPath, String(process.pid), { flag: "wx" });
			} catch {
				return false;
			}
		}

		try {
			// The lock's own takeover, re-validated UNDER the claim: between our
			// pre-check and our claim, another reclaimer may have completed the
			// whole ceremony — its fresh lock reads fresh here and we cede, which
			// is what lets a racer that finished first keep its win.
			if (!takeStale(lockPath, hooks)) return false;
			// The exclusive create, same as the fast path: a contender that took
			// the empty path while we verified wins, and this fails closed.
			fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			return false;
		} finally {
			fs.rmSync(claimPath, { force: true });
		}
	}
}
