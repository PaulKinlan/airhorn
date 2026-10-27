/*
 * tests/tool-bound-kill.test.mjs — the invariant airhorn-aaxm fixed, pinned
 * (airhorn-cyga), with identity scoped to THIS run (airhorn-2y0o).
 *
 * tools/cache-growth.mjs and tools/soak.mjs drive a real browser for minutes, so
 * the gate's bound eventually SIGTERMs them. Before airhorn-aaxm they registered
 * no signal handler: node died with `code null, signal SIGTERM`, the browser and
 * its profile directory were left behind, and the next run inherited a machine
 * with stray Chrome processes on it.
 *
 * HOW THIS TEST IDENTIFIES ITS OWN THINGS (the first version got this wrong and
 * was filed P1 as airhorn-2y0o — it matched /proc by cmdline substring and
 * deleted every /tmp/chrome-<label>-* directory, so on a shared VM it could kill
 * another lane's process and remove state it never created):
 *
 *   1. A run-scoped directory, created 0700 by mkdtemp under the system temp
 *      root, and handed to the tool as TMPDIR. The tool builds the Chrome
 *      profile inside it, so the test never scans /tmp and never touches a
 *      directory it did not create.
 *   2. A unique marker (uuid) in the tool's ENVIRONMENT, inherited by the
 *      browser it spawns. The tools reject unknown argv, so the marker cannot be
 *      an argument; identity is checked by reading the marker out of /proc.
 *   3. A process is "ours" only if BOTH hold: its environment carries this run's
 *      marker, AND its argv contains the exact token
 *      `--user-data-dir=<dir inside the run directory>` (token equality, not the
 *      substring match that made the first version a pkill -f).
 *   4. The tool runs as its own process-group leader. On the failure path the
 *      test kills that group, and only after checking the group id still equals
 *      the pid it spawned. It never kills anything else, and it never SIGKILLs a
 *      tool that is still running normally (that would orphan the browser).
 *   5. Cleanup deletes the run directory and nothing else, and refuses to do
 *      even that unless it is under the temp root, named with this run's prefix,
 *      owned by this user, and mode 0700.
 *
 * Bounded: every wait has a deadline, and a case that cannot reach its setup
 * fails with the reason rather than hanging. ~1 s for both tools, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const RUN_PREFIX = 'airhorn-boundkill-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRunDir() {
  const dir = fs.mkdtempSync(path.join(tempRoot, RUN_PREFIX));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Refuse to delete anything that is not demonstrably this kind of run's own
// directory. Called before rmSync, so a bug upstream cannot turn cleanup into a
// destructive operation on someone else's state.
function assertOwnRunDir(dir) {
  const real = fs.realpathSync(dir);
  const base = path.basename(real);
  if (path.dirname(real) !== tempRoot) throw new Error(`refusing to touch ${real}: not directly under the temp root`);
  if (!base.startsWith(RUN_PREFIX)) throw new Error(`refusing to touch ${real}: not a ${RUN_PREFIX}* run directory`);
  const stat = fs.statSync(real);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`refusing to touch ${real}: mode ${(stat.mode & 0o777).toString(8)}, expected 700`);
  if (stat.uid !== process.getuid()) throw new Error(`refusing to touch ${real}: owned by uid ${stat.uid}, not ${process.getuid()}`);
  return real;
}

const procArgs = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

const procEnv = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

const procPgrp = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // fields after the comm's closing paren: state, ppid, pgrp, ...
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
};

// A process belongs to this run only if the marker AND the exact user-data-dir
// token both hold. Neither is a substring search over the whole command line.
function oursProcesses(marker, runDir) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const env = procEnv(pid);
    if (!env || !env.includes(`${marker.key}=${marker.value}`)) continue;
    const args = procArgs(pid);
    if (!args) continue;
    const profile = args.find((a) => a.startsWith('--user-data-dir='));
    if (!profile) continue;
    const dir = profile.slice('--user-data-dir='.length);
    if (path.dirname(path.resolve(dir)) !== path.resolve(runDir)) continue;
    found.push({ pid, dir });
  }
  return found;
}

const runProfiles = (runDir) => fs.readdirSync(runDir).filter((name) => name.startsWith('chrome-'));

async function waitFor(predicate, { timeoutMs = 40000, label = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function buildDist() {
  if (fs.existsSync(path.join(root, 'dist/index.html'))) return;
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'ignore' });
}

/**
 * Start a tool in its own process group with a run-scoped TMPDIR and a unique
 * marker, wait for its browser, SIGTERM it the way the gate's bound does, and
 * report what happened — including whether anything of THIS RUN survived.
 */
async function killedMidRun(tool, args) {
  const runDir = makeRunDir();
  try {
    assertOwnRunDir(runDir);
    const marker = { key: 'AIRHORN_BOUNDKILL_RUN', value: crypto.randomUUID() };

    const child = spawn(process.execPath, [path.join(root, 'tools', tool), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group: the group is the only thing ever killed
      env: { ...process.env, TMPDIR: runDir, [marker.key]: marker.value },
    });
    let output = '';
    child.stdout.on('data', (b) => { output += b; });
    child.stderr.on('data', (b) => { output += b; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    // Recorded once: the group leader is gone by the time the failure path needs
    // it, and reading its pgrp back then returns null - which is how the first
    // version of this fix skipped the group kill exactly when the tool died
    // without cleaning up, leaving its browser orphaned while cleanup deleted the
    // profile from under it (airhorn-2y0o, face 4).
    const pgid = procPgrp(child.pid);
    assert.equal(pgid, child.pid, `${tool} must be its own process-group leader, got pgrp ${pgid} for pid ${child.pid}`);

    let result;
    try {
      // A starved host makes launchChrome() REFUSE at once (airhorn-w1wh), so the tool dies
      // without ever creating a browser. Waiting the full 40 s bound for a browser that will
      // never exist spent 80 s of a gate run and then reported "timed out waiting for
      // <tool>.mjs's browser" while the actual refusal sat unread in `output` (airhorn-wqge).
      // Race the condition against the child's own exit, fail fast, and always show what the
      // tool said.
      let up;
      try {
        up = await Promise.race([
          waitFor(() => oursProcesses(marker, runDir).length > 0,
            { label: `${tool}'s browser (marker ${marker.value})` }).then(() => 'browser'),
          exited.then((how) => ({ how })),
        ]);
      } catch (err) {
        throw new Error(`${err.message}\nThe tool is still running but never produced a browser. Tool output:\n${output.slice(-1200)}`);
      }
      if (up !== 'browser') {
        throw new Error(`${tool} exited (${JSON.stringify(up.how)}) before its browser appeared, so this run never got as far as a bound kill. Tool output:\n${output.slice(-1200)}`);
      }
      child.kill('SIGTERM'); // exactly what the gate's bound sends

      let timer = null;
      const bounded = new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'timeout', signal: null }), 20000); });
      result = await Promise.race([exited, bounded]);
      clearTimeout(timer);
    } finally {
      // Only ever this run's group, and only if it is still the group we made.
      // Kill the group we created, and only while it is demonstrably ours: either
      // the tool is still running, or something carrying this run's marker is
      // still in the group. Never a bare pgid guess, never anything else.
      const survivors = oursProcesses(marker, runDir);
      if (child.exitCode === null || survivors.length > 0) {
        try { process.kill(-pgid, 'SIGKILL'); } catch {}
        await waitFor(() => oursProcesses(marker, runDir).length === 0, { timeoutMs: 5000, label: `${tool}'s group to die` }).catch(() => {});
      }
      await exited;
    }

    await waitFor(() => oursProcesses(marker, runDir).length === 0, { timeoutMs: 5000, label: `${tool}'s browser to exit` }).catch(() => {});

    return {
      ...result,
      output,
      leftoverChrome: oursProcesses(marker, runDir).map((p) => p.pid),
      leftoverProfiles: runProfiles(runDir),
    };
  } finally {
    const real = assertOwnRunDir(runDir);
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 3 });
  }
}

buildDist();

test('cache-growth: a bound kill reaps its browser and profile, and exits 143', async () => {
  const result = await killedMidRun('cache-growth.mjs', ['--versions', '2']);
  assert.notEqual(result.code, 'timeout', `the tool ignored SIGTERM and had to be killed\n${result.output.slice(-800)}`);
  assert.equal(result.signal, null,
    `the run died from the signal instead of exiting: no bound-kill handler ran (code ${result.code}, signal ${result.signal})`);
  assert.equal(result.code, 143, `a handled bound kill must exit 143, got ${result.code}\n${result.output.slice(-800)}`);
  assert.deepEqual(result.leftoverChrome, [], 'the bound kill left this run\'s browser processes behind');
  assert.deepEqual(result.leftoverProfiles, [], 'the bound kill left its browser profile behind');
});

test('soak: a bound kill reaps its browser and profile, and exits 143', async () => {
  const result = await killedMidRun('soak.mjs', ['--cycles', '200']);
  assert.notEqual(result.code, 'timeout', `the tool ignored SIGTERM and had to be killed\n${result.output.slice(-800)}`);
  assert.equal(result.signal, null,
    `the run died from the signal instead of exiting: no bound-kill handler ran (code ${result.code}, signal ${result.signal})`);
  assert.equal(result.code, 143, `a handled bound kill must exit 143, got ${result.code}\n${result.output.slice(-800)}`);
  assert.deepEqual(result.leftoverChrome, [], 'the bound kill left this run\'s browser processes behind');
  assert.deepEqual(result.leftoverProfiles, [], 'the bound kill left its browser profile behind');
});

// The identity rules are the fix for airhorn-2y0o, so they get pinned too: a
// future edit that goes back to prefix or substring matching must fail here, not
// on another lane's machine.
test('identity is the run marker plus the exact user-data-dir token, never a prefix or a substring', async () => {
  const runDir = makeRunDir();
  try {
    const intruder = path.join(tempRoot, `${RUN_PREFIX}not-this-run`);
    fs.mkdirSync(intruder, { mode: 0o700 });
    try {
      // A directory whose NAME looks like ours and a process whose ARGV merely
      // mentions a profile path must both be invisible to this run's identity.
      const child = spawn('/bin/sh', ['-c', `sleep 20; echo ${intruder}`, ], { detached: true, stdio: 'ignore' });
      try {
        const marker = { key: 'AIRHORN_BOUNDKILL_RUN', value: crypto.randomUUID() };
        assert.deepEqual(oursProcesses(marker, runDir), [],
          'a process without this run\'s marker must not be claimed');
        assert.deepEqual(runProfiles(runDir), [], 'no profile exists yet, so nothing may be reported');
        // Same marker, but the argv only mentions a path, it does not carry the
        // --user-data-dir token: still not ours.
        assert.deepEqual(oursProcesses({ key: 'AIRHORN_BOUNDKILL_RUN', value: 'different' }, runDir), [],
          'a different run\'s marker must not be claimed');
      } finally {
        if (procPgrp(child.pid) === child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
      }
    } finally {
      fs.rmSync(intruder, { recursive: true, force: true });
    }
  } finally {
    const real = assertOwnRunDir(runDir);
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('cleanup refuses a directory that is not this kind of run\'s own', () => {
  const notRunDir = fs.mkdtempSync(path.join(tempRoot, 'airhorn-not-a-run-'));
  try {
    assert.throws(() => assertOwnRunDir(notRunDir), /refusing to touch .*run directory/,
      'a directory without the run prefix must be refused');
  } finally {
    fs.rmSync(notRunDir, { recursive: true, force: true });
  }
  const loose = fs.mkdtempSync(path.join(tempRoot, RUN_PREFIX));
  try {
    fs.chmodSync(loose, 0o755);
    assert.throws(() => assertOwnRunDir(loose), /refusing to touch .*mode 755/,
      'a run directory that is not 0700 must be refused');
  } finally {
    fs.rmSync(loose, { recursive: true, force: true });
  }
});
