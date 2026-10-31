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
 * Owner markers (airhorn-nxuv.31): the liveness premise below - "a process
 * that names a dir owns it" - cannot see a dir no process ever NAMES on its
 * command line. install-https-proof's cert/server temp dir
 * (chrome-https-proof-tmp-*) is exactly that: the sweep's cmdline guard could
 * never match it, so after the grace window a concurrent run deleted the TLS
 * directory of a RUNNING server. The creator now writes
 * `<dir>/.airhorn-owner` ({pid, started}) the moment the dir exists, and the
 * sweep treats a dir as live when its marker names a live pid with a matching
 * start time (the pid-reuse key). The guard fails both ways honestly: an
 * unreadable or malformed marker, or a live pid whose state cannot be read,
 * is treated as LIVE (deleting on uncertainty is the dangerous default); a
 * dead or pid-reused marker is stale; a dir with no marker at all is legacy
 * and falls through to the age rule, so genuinely dead dirs are still reaped.
 */
const OWNER_MARKER = '.airhorn-owner';

// Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot -
// the value that distinguishes a live pid from a REUSED one. The parse keys
// off the last ')' because the comm field can itself contain spaces and
// parens. Returns null when the pid cannot be read (dead, or a /proc-less
// host); what uncertainty means is the caller's decision.
export function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const fields = stat.slice(close + 1).trim().split(' ');
    // fields[0] is state (field 3), so start time (field 22) is index 19.
    const started = Number(fields[19]);
    return Number.isFinite(started) ? started : null;
  } catch { return null; }
}

// Write the owner marker for a dir this process just created. Throws on
// failure: an unmarked live dir is exactly the defect the marker closes, and
// the creator must know it is running unprotected rather than find out when a
// sweep deletes its dir.
export function writeOwnerMarker(dir) {
  fs.writeFileSync(path.join(dir, OWNER_MARKER),
    JSON.stringify({ pid: process.pid, started: processStartTime(process.pid) }));
}

// What a dir's owner marker says: 'live' (owned by a live pid whose start
// time matches), 'stale' (the pid is gone or was REUSED by an unrelated
// process), 'absent' (no marker - a legacy dir, judged by the age rule), or
// 'unreadable' (present but not parseable, or the pid exists but its state
// cannot be read) - which the sweep treats as live.
function ownerMarkerVerdict(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, OWNER_MARKER), 'utf8'); } catch (err) {
    return { kind: err?.code === 'ENOENT' ? 'absent' : 'unreadable', why: err?.code ?? String(err) };
  }
  let marker;
  try { marker = JSON.parse(raw); } catch { return { kind: 'unreadable', why: 'malformed JSON' }; }
  const pid = marker?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unreadable', why: 'no valid pid' };
  // The caller just scanned /proc, so a missing /proc/<pid> here means the
  // owner is simply gone. A pid that EXISTS but cannot be read is ambiguous
  // and reads live.
  if (!fs.existsSync(`/proc/${pid}`)) return { kind: 'stale', pid };
  const started = processStartTime(pid);
  if (started === null) {
    return { kind: 'unreadable', why: `pid ${pid} exists but its start time is unreadable` };
  }
  // airhorn-3lx5: a parseable marker whose started is not a NUMBER (e.g. a
  // hand-written string) cannot be compared - parseable-but-wrong-typed is
  // still untrustworthy, so it reads live like every other unreadable marker.
  // (null/undefined stay on the live path below: a /proc-less writer records
  // no start time.)
  if (marker.started !== null && marker.started !== undefined && typeof marker.started !== 'number') {
    return { kind: 'unreadable', why: 'started is not a number' };
  }
  if (marker.started !== null && marker.started !== undefined && marker.started !== started) {
    return { kind: 'stale', pid }; // the pid was REUSED by an unrelated process
  }
  return { kind: 'live', pid };
}

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
 * What counts as ours is deliberately narrow (airhorn-13xr): a prefix alone is
 * a NAME a caller can also choose - `--out /tmp/chrome-https-proof-evidence`
 * matched it, and an aged evidence dir was swept with its content. So the
 * caller passes `pattern` (the exact mkdtemp shape this tool creates, random
 * suffix and all) and `exclude` (paths it knows are not litter, e.g. its own
 * --out), and a name must satisfy both the pattern and not be excluded. The
 * default - anything under the prefix - is for a caller whose whole prefix is
 * genuinely private to it.
 *
 * Returns what it did: { swept: [names], kept: [{ dir, why }] }, so the caller
 * can say what it cleaned instead of reporting silence either way.
 */
export function sweepStaleProfiles(prefix, {
  graceMs = 5000, tmpdir = os.tmpdir(), now = Date.now(), pattern = null, exclude = [],
} = {}) {
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
  const excluded = new Set(exclude.map((entry) => path.resolve(entry)));
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(tmpdir, name);
    if (pattern && !pattern.test(name)) {
      kept.push({ dir: name, why: 'not the shape this tool creates' });
      continue;
    }
    if (excluded.has(path.resolve(dir))) {
      kept.push({ dir: name, why: 'the caller owns it' });
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; } // already gone
    if (!stat.isDirectory()) continue;
    if (cmdlines.some((line) => line.includes(dir))) {
      kept.push({ dir: name, why: 'a live process names it' });
      continue;
    }
    // airhorn-nxuv.31: the cmdline premise cannot see a dir no live process
    // NAMES (the cert/server temp dir), so the owner marker is the liveness
    // evidence there. An unreadable or ambiguous marker reads live - deleting
    // on uncertainty is the dangerous default. 'absent' (a legacy dir) and
    // 'stale' (a dead or reused pid) fall through to the age rule, so
    // genuinely dead dirs are still reaped.
    const owner = ownerMarkerVerdict(dir);
    if (owner.kind === 'live') {
      kept.push({ dir: name, why: `owned by live pid ${owner.pid}` });
      continue;
    }
    if (owner.kind === 'unreadable') {
      kept.push({ dir: name, why: `owner marker ${owner.why} - treated as live` });
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

