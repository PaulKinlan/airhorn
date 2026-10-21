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
 *
 * Stale-profile sweep (airhorn-9gao): sweepProfile cleans up a launch the
 * process still owns - it runs in the finally or the signal handler. A SIGKILL
 * (a fleet-gate bound, the reaper, the OOM killer) runs neither, so the profile
 * DIR stays in /tmp with no process left to remove it. Nothing inside a dead
 * process can fix that; the next run does, and sweepStaleProfiles is that pass.
 * It shares this module's premise - a process that names a dir owns it - and
 * adds an age guard for the window between mkdtemp and chrome appearing in
 * /proc, so a concurrent launch cannot have its profile removed from under it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/*
 * Remove the profile dirs a KILLED earlier run of the same tool left behind.
 *
 * The premise is the same one sweepProfile uses, read the other way round: a
 * dir that NO live process names is nobody's, and a dir one does name is left
 * alone. Two guards keep that safe:
 *   - live:  the owner may be in the ~ms window between mkdtemp and chrome's
 *            argv showing up in /proc, so a named dir is never removed;
 *   - fresh: anything touched within `graceMs` is kept for the same window,
 *            which also means two tools starting at once cannot sweep each
 *            other's brand-new profile.
 * A /proc-less host is the documented no-op sweepProfile already has (nothing
 * can be attributed, so nothing is removed); any other /proc failure is printed
 * and nothing is swept, rather than guessing.
 *
 * Returns what it did: { swept: [names], kept: [{ dir, why }] }, so the caller
 * can say what it cleaned instead of reporting silence either way.
 */
export function sweepStaleProfiles(prefix, { graceMs = 5000, tmpdir = os.tmpdir(), now = Date.now() } = {}) {
  const cmdlines = [];
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try { cmdlines.push(fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8')); } catch { /* exited mid-scan */ }
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return { swept: [], kept: [] }; // no /proc (non-Linux): documented no-op
    console.error(`reap: /proc scan failed (${err?.message ?? err}); no stale profile dirs were swept`);
    return { swept: [], kept: [] };
  }

  let names;
  try { names = fs.readdirSync(tmpdir); } catch { return { swept: [], kept: [] }; }

  const swept = [];
  const kept = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(tmpdir, name);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; } // already gone
    if (!stat.isDirectory()) continue;
    if (cmdlines.some((line) => line.includes(dir))) {
      kept.push({ dir: name, why: 'a live process names it' });
      continue;
    }
    if (now - stat.mtimeMs <= graceMs) {
      kept.push({ dir: name, why: 'inside the launch window' });
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      swept.push(name);
    } catch (err) {
      kept.push({ dir: name, why: `rm failed: ${err?.message ?? err}` });
    }
  }
  return { swept, kept };
}

