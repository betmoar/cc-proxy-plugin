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
 * than REFRESH_LOCK_STALE_MS. That check is on the FILE's mtime, not a pid: the
 * composer kills the process group, so a pid recorded here would be a pid that
 * no longer exists and checking liveness would be a second race.
 *
 * Lives in its own module purely so a test can call it in-process and force one
 * exact interleaving. A statistical racer test does NOT separate the correct
 * implementation from the broken one at any sane sample size — measured, the
 * broken one loses only ~8% of rounds — so the seam is what makes the guarantee
 * testable at all.
 *
 * @param {string} cacheDir
 * @param {{ afterStat?: () => void }} [hooks] - test seam. `afterStat` runs in
 *   the window between judging the lock stale and acting on it, which is the
 *   only place a competing reclaimer can appear.
 */
export function takeRefreshLock(cacheDir, hooks = {}) {
	const lockPath = refreshLockPath(cacheDir);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		// Exists (or unwritable). Reclaim only if abandoned — and the reclaim must
		// prove it moved the file it JUDGED abandoned, not whatever sits at the
		// path by the time it acts. The mtime check is check-then-act, so two
		// renders can both call the same lock stale; a plain overwrite then handed
		// the lock to BOTH (two refreshers, a duplicate round of quota fetches —
		// the stampede this function exists to prevent, one level down).
		//
		// rename() alone does NOT close that window, which is the trap it looks
		// like it closes: rename is atomic about the PATH, not about the file, so
		// a loser arriving after the winner has already relocked just renames the
		// winner's FRESH lock away and takes over. Measured (60 rounds x 12 racing
		// processes, macOS APFS): rename-without-verification produced 65 winners
		// over 60 rounds, 5 rounds with more than one — the same defect the plain
		// overwrite had, at a lower rate. So: rename to a PRIVATE destination,
		// then confirm the file that landed there is the one statSync saw; a racer
		// that relocked in between fails the match, and the loser puts the file
		// back untouched and cedes. (APFS measurement, verified variant: exactly
		// 60 winners over 60 rounds.)
		//
		// The identity check is inode AND mtime, not inode alone — inode alone is
		// the same trap one layer down. ext4/overlayfs RECYCLE a freed inode for
		// the next file created in the directory (measured on this repo's CI
		// image: rm then wx-create came back with the identical ino), so a
		// winner's rm+recreate hands its fresh lock the judged-stale file's inode
		// number and the loser's inode comparison false-matches — double-grant
		// again, deterministically, on exactly the platform CI runs. APFS never
		// reuses inode numbers, which is how the inode-only variant measured
		// clean. mtime closes it: rename PRESERVES mtime, so the judged-stale
		// file carries `seen.mtimeMs` exactly, while any relock is a fresh write
		// stamped now — and the reclaim only runs when `seen` is ≥10s old, so the
		// two can never coincide.
		try {
			const seen = fs.statSync(lockPath);
			if (Date.now() - seen.mtimeMs < REFRESH_LOCK_STALE_MS) return false;
			hooks.afterStat?.();
			// A pid-private destination, so two reclaimers never collide on it. The
			// rmSync clears our own leftover from a prior crashed reclaim; renaming
			// onto an existing file is fine on both platforms, but an open handle
			// on it is not (see rotateLogIfLarge).
			const claimed = `${lockPath}.${process.pid}.stale`;
			fs.rmSync(claimed, { force: true });
			fs.renameSync(lockPath, claimed);
			const moved = fs.statSync(claimed);
			if (moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs) {
				// Someone relocked between our stat and our rename: we just moved
				// THEIR live lock. Put it back and lose gracefully.
				fs.renameSync(claimed, lockPath);
				return false;
			}
			fs.rmSync(claimed, { force: true });
			fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			return false;
		}
	}
}
