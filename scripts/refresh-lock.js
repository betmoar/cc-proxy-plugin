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
 * Single-flight guard. Takes the lock by creating the file exclusively (`wx`),
 * which is atomic — two renders racing here cannot both win. Returns false when
 * someone else holds it.
 *
 * A lock left behind by a killed refresher is reclaimed once its mtime is older
 * than REFRESH_LOCK_STALE_MS. That check is on the FILE's mtime, never a pid:
 * the composer kills the process group, so a pid recorded here would be a pid
 * that no longer exists and checking liveness would be a second race.
 *
 * THE RECLAIM IS A CEREMONY, and every piece of it exists because a smaller
 * version double-granted — each defect below was measured or forced through the
 * test seam, not imagined:
 *
 *  1. Plain overwrite after the mtime check: check-then-act, both racers win.
 *  2. rename() to a private name: rename is atomic about the PATH, not the
 *     FILE, so a loser arriving after the winner relocked renames the winner's
 *     FRESH lock away and takes over (60 rounds x 12 processes on APFS: 65
 *     winners, 5 double-grants).
 *  3. rename + inode verification: inode alone is platform-dependent — ext4/
 *     overlayfs RECYCLE a freed inode for the next create (measured on CI's
 *     image: rm then wx-create returned the identical ino), so the winner's
 *     fresh lock inherits the judged-stale file's inode number and the loser
 *     false-matches. APFS never reuses inode numbers, which is how that
 *     variant measured clean. mtime joins the check: rename PRESERVES mtime,
 *     a relock is a fresh write stamped now, and the reclaim only runs on a
 *     file ≥10s old, so the pair can never coincide.
 *  4. rename + verification, unserialized: with THREE contenders, loser A
 *     holds winner B's renamed-away lock while the path sits empty, C takes
 *     the empty path via the fast `wx`, and A's restore then overwrites C's
 *     live lock (found in review). Two answers: reclaimers now SERIALIZE on a
 *     claim file (`refresh.lock.claim`, exclusive create, held only across
 *     these few syscalls), so only one reclaimer can ever be mid-ceremony —
 *     and the ceremony re-validates staleness UNDER the claim, so a lock
 *     someone else legitimately took in the meantime is seen fresh and ceded
 *     to. The restore itself goes through link(), which atomically REFUSES an
 *     existing destination, so a fast-path winner that slipped in is never
 *     overwritten.
 *
 * What remains open, stated rather than hidden: the refresher's own
 * release-unlink is outside this protocol, so a refresher that hung past the
 * stale window and unlinks at the exact microsecond a reclaim ceremony is
 * between syscalls can still let one extra refresher through. Closing that
 * needs an OS advisory lock (flock), which Node does not expose without a
 * native dependency this zero-dependency repo does not take; the residue is a
 * duplicate round of quota fetches, self-healing, behind a coincidence of
 * microsecond windows.
 *
 * Lives in its own module purely so a test can call it in-process and force
 * exact interleavings. A statistical racer test does NOT separate the correct
 * implementation from the broken ones at any sane sample size — measured, the
 * rename-only variant loses ~8% of rounds — so the seams are what make the
 * guarantee testable at all.
 *
 * @param {string} cacheDir
 * @param {{ afterStat?: () => void, afterRestat?: () => void, afterRename?: () => void }} [hooks]
 *   test seams. `afterStat` runs after the pre-claim staleness check (where a
 *   competing reclaimer can appear); `afterRestat` runs after the re-validation
 *   under the claim (where the refresher's unlink + a fast-path relock can
 *   land); `afterRename` runs while the lock path sits empty (where a
 *   fast-path contender can take it).
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
		// syscalls below, never across a refresh. A claim left by a process that
		// crashed mid-ceremony is recovered once ITS mtime passes the stale
		// window — and a crash mid-ceremony leaves the lock path either intact
		// (re-reclaimable) or empty (the fast path self-heals), so a stuck claim
		// never wedges the gauge.
		const claimPath = `${lockPath}.claim`;
		try {
			fs.writeFileSync(claimPath, String(process.pid), { flag: "wx" });
		} catch {
			try {
				if (Date.now() - fs.statSync(claimPath).mtimeMs < REFRESH_LOCK_STALE_MS) return false;
				fs.rmSync(claimPath, { force: true });
				fs.writeFileSync(claimPath, String(process.pid), { flag: "wx" });
			} catch {
				return false;
			}
		}

		try {
			// RE-validate under the claim: between our pre-check and our claim,
			// another reclaimer may have completed the whole ceremony. Its lock is
			// a fresh write, so this stat sees it fresh and we cede — that is what
			// lets a racer that finished first keep its win.
			const seen = fs.statSync(lockPath);
			if (Date.now() - seen.mtimeMs < REFRESH_LOCK_STALE_MS) return false;
			hooks.afterRestat?.();
			// A pid-private destination, so a crashed reclaim's leftover never
			// collides with a live one; rmSync clears our own prior leftover.
			const claimed = `${lockPath}.${process.pid}.stale`;
			fs.rmSync(claimed, { force: true });
			fs.renameSync(lockPath, claimed);
			hooks.afterRename?.();
			const moved = fs.statSync(claimed);
			if (moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs) {
				// The file at the path changed between our stat and our rename —
				// only the refresher's unlink plus a fast-path relock can do that —
				// so we just moved someone's LIVE lock. Put it back via link(),
				// which atomically refuses an existing destination: if yet another
				// contender took the empty path meanwhile, their lock stands and
				// the moved one is retired rather than clobbering them.
				try {
					fs.linkSync(claimed, lockPath);
				} catch {
					// Destination exists — a fast-path winner beat the restore.
				}
				fs.rmSync(claimed, { force: true });
				return false;
			}
			fs.rmSync(claimed, { force: true });
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
