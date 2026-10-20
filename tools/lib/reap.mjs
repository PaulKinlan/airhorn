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
 * audit.mjs still carries its own copy (airhorn-mgcl) and migrates with that
 * bead.
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
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        let cmdline;
        try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
        if (cmdline.includes(marker)) victims.push(pid);
      }
    } catch {
      return; // no /proc (non-Linux)
    }
    if (victims.length === 0) return;
    for (const pid of victims) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

