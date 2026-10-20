/*
 * tools/lib/reap.mjs — the one profile-marker sweep (airhorn-byun).
 *
 * Five copies of this lived in five files (the four tools' sweepTree and
 * tests/support/browser.mjs's sweepProfile) and they had already drifted:
 * the tool copies ran 2 passes where the original ran 3 - and the third pass
 * is the one that re-reads after the kill of the pass that may still have
 * been forking, so a child forked between the reads was missed. One module
 * now owns the marker premise, the pass count and the failure diagnostic,
 * the way airhorn-4vfn collapsed the signal-exit copies. tools/resilience-
 * audit.mjs migrates with this landing too (its copy was airhorn-mgcl).
 *
 * Failure diagnostic (airhorn-qum7, airhorn-chxk): a sweep that silently did
 * nothing reads as a clean kill. A missing /proc is a documented no-op (a
 * non-Linux host); ANY other /proc scan failure is printed to stderr and the
 * sweep gives up loudly - 'reaped 14' and 'reaped 0, scan broken' no longer
 * read the same. The same applies to the marker premise itself: if no process
 * carries `--user-data-dir=<dir>` while one still names the profile dir on its
 * command line, chrome's argv has drifted, nothing is reaped, and the sweep now
 * says so instead of leaving an orphan tree in silence (airhorn-qum7).
 */
import fs from 'node:fs';

/*
 * SIGKILL every process whose command line carries this launch's unique
 * --user-data-dir: the browser itself and every child it forked all carry it,
 * so one /proc read finds the whole tree and one pass kills it. The browser
 * dies in the same pass as its children are found, so it cannot out-fork the
 * cleanup - the measured failure of a snapshot tree-kill that leaves chrome
 * alive while it works (airhorn-77ih: 11 processes survived a kill ~95ms into
 * startup). A later pass runs only while the previous one found somebody, and
 * it exists for the fork race: a child forked between the first read and its
 * parent's death is visible to it. Synchronous by design so signal handlers
 * can use it; on a /proc-less system it does nothing and killTree is the
 * fallback.
 */
export function sweepProfile(profileDir) {
  const marker = `--user-data-dir=${profileDir}`;
  for (let pass = 0; pass < 3; pass += 1) {
    const victims = [];
    // Processes that name the profile dir without carrying the marker. On a
    // zero-victim pass these are the difference between "the browser is
    // already gone" and "chrome renamed the flag and we are about to leave a
    // tree behind", so they are collected only to explain the second case.
    const related = [];
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        let cmdline;
        try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
        if (cmdline.includes(marker)) victims.push(pid);
        else if (cmdline.includes(profileDir)) related.push(pid);
      }
    } catch (err) {
      if (err?.code === 'ENOENT') return; // no /proc (non-Linux): documented no-op
      console.error(`reap: /proc scan failed (${err?.message ?? err}); the tree kill did not run`);
      return;
    }
    if (victims.length === 0) {
      // A real swallow, not a clean kill: somebody is still holding this
      // launch's profile but no longer carries the marker the sweep keys on.
      // Report it and reap nothing - killing on a path match alone would be a
      // different (unreviewed) premise, and silence is how the orphan happens.
      if (related.length > 0) {
        console.error(`reap: no process carries --user-data-dir=${profileDir}, but ${related.length} ` +
          `still name the profile dir (pid ${related.join(', ')}); nothing was reaped - ` +
          `chrome's argv may have drifted from the marker`);
      }
      return;
    }
    for (const pid of victims) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

