// tools/sweep-tree.mjs — one profile-marker tree kill for every tool
// (airhorn-byun: the copies in four tools had already drifted; this is the
// one they share).
//
// SIGKILL every process carrying this launch's --user-data-dir: the browser
// and every child it forked all carry it, so one /proc read finds the whole
// tree and the browser dies in the same pass as its children are found -
// nothing can out-fork the cleanup. The second pass catches a child that
// raced the first read. Synchronous so error/signal paths can use it.
//
// On a system without /proc this is a documented no-op; any OTHER /proc scan
// failure is printed to stderr, because a sweep that silently did nothing
// reads as a clean kill (airhorn-qum7).
import fs from 'node:fs';

export function sweepTree(profileDir) {
  const marker = `--user-data-dir=${profileDir}`;
  for (let pass = 0; pass < 2; pass += 1) {
    let victims;
    try {
      victims = fs.readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
        .filter((entry) => {
          try { return fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(marker); } catch { return false; }
        })
        .map(Number);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      console.error(`sweep-tree: /proc scan failed (${err?.message ?? err}); the tree kill did not run`);
      return;
    }
    if (victims.length === 0) return;
    for (const pid of victims) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}
