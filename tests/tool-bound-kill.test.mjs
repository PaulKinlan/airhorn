/*
 * tests/tool-bound-kill.test.mjs — the invariant airhorn-aaxm fixed, pinned.
 *
 * tools/cache-growth.mjs and tools/soak.mjs drive a real browser for minutes, so
 * the gate's bound eventually SIGTERMs them. Before airhorn-aaxm they registered
 * no signal handler: node died with `code null, signal SIGTERM`, the browser and
 * its profile directory were left behind, and the next run inherited a machine
 * with stray Chrome processes on it.
 *
 * Each case below starts the tool, waits until its browser is really up, sends
 * SIGTERM the way the bound does, and then asserts the whole tree is gone:
 *   exit shape  code 143, signal null      (a handler ran; the pre-fix shape was
 *                                           code null, signal 'SIGTERM')
 *   no Chrome   any process whose --user-data-dir is this tool's profile
 *   no profile  the directory itself, so the next run starts clean
 *
 * Deliberately lane-safe: it only ever kills the PID it spawned, and only ever
 * looks at processes and directories carrying the label it generated, so a
 * concurrent suite on the same VM is never touched. It never uses pkill.
 *
 * Bounded: every wait has a deadline, and a case that cannot reach its setup
 * (browser never appears) fails with the reason rather than hanging.
 * Runs in about 7 s for both tools; no server, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome processes are identified by the profile directory they were given, never
// by executable name: another lane's browser on this VM is not our business.
function chromeProcessesFor(profileDir) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (cmdline.includes(profileDir)) found.push(Number(entry));
  }
  return found;
}

function profilesFor(label) {
  const prefix = `chrome-${label}-`;
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

async function waitFor(predicate, { timeoutMs = 30000, label = 'the condition' } = {}) {
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
 * Start a tool, wait for its browser, SIGTERM it mid-run, and return what the
 * process did. `label` must be the label the tool passes to launchChrome, which
 * is what names its profile directory.
 */
async function killedMidRun(tool, args, label) {
  const child = spawn(process.execPath, [path.join(root, 'tools', tool), ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: a stray grandchild cannot hold the test runner's
    // pipes open, and the group is what the final sweep checks.
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let profileDir = null;
  try {
    await waitFor(() => profilesFor(label).length > 0, { timeoutMs: 40000, label: `${tool}'s browser profile` });
    profileDir = path.join(os.tmpdir(), profilesFor(label)[0]);
    // The profile exists before Chrome is up; wait for a live process on it so the
    // case really tests a running browser rather than a half-started launch.
    await waitFor(() => chromeProcessesFor(profileDir).length > 0, { timeoutMs: 40000, label: `${tool}'s Chrome` });

    child.kill('SIGTERM');            // exactly what the gate's bound sends
    // A race with a bare sleep() would leave its timer pending and hold the test
    // process open for the full timeout (measured: a 0.6 s case turning into a
    // 21 s suite), so the bound is cleared as soon as the child exits.
    let timer = null;
    const bounded = new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'timeout', signal: null }), 20000); });
    const result = await Promise.race([exited, bounded]);
    clearTimeout(timer);

    // The handler reaps synchronously, but give the kernel a moment to close the
    // process tree before asserting nothing is left.
    await waitFor(() => chromeProcessesFor(profileDir).length === 0, { timeoutMs: 5000, label: `${tool}'s Chrome to exit` })
      .catch(() => {});

    return { ...result, profileDir, output, leftoverChrome: chromeProcessesFor(profileDir), leftoverProfiles: profilesFor(label) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    // Lane-safe sweep of anything this case created, by its own label only.
    for (const pid of profileDir ? chromeProcessesFor(profileDir) : []) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    for (const name of profilesFor(label)) {
      try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }
}

buildDist();

test('cache-growth: a bound kill reaps the browser and its profile, and exits 143', async () => {
  const result = await killedMidRun('cache-growth.mjs', ['--versions', '2'], 'cache-growth-profile');
  assert.notEqual(result.code, 'timeout', `the tool ignored SIGTERM and had to be killed\n${result.output.slice(-800)}`);
  assert.equal(result.signal, null,
    `the run died from the signal instead of exiting: no bound-kill handler ran (code ${result.code}, signal ${result.signal})`);
  assert.equal(result.code, 143, `a handled bound kill must exit 143, got ${result.code}\n${result.output.slice(-800)}`);
  assert.deepEqual(result.leftoverChrome, [], 'the bound kill left Chrome processes behind');
  assert.deepEqual(result.leftoverProfiles, [], 'the bound kill left the browser profile behind');
});

test('soak: a bound kill reaps the browser and its profile, and exits 143', async () => {
  const result = await killedMidRun('soak.mjs', ['--cycles', '200'], 'soak-profile');
  assert.notEqual(result.code, 'timeout', `the tool ignored SIGTERM and had to be killed\n${result.output.slice(-800)}`);
  assert.equal(result.signal, null,
    `the run died from the signal instead of exiting: no bound-kill handler ran (code ${result.code}, signal ${result.signal})`);
  assert.equal(result.code, 143, `a handled bound kill must exit 143, got ${result.code}\n${result.output.slice(-800)}`);
  assert.deepEqual(result.leftoverChrome, [], 'the bound kill left Chrome processes behind');
  assert.deepEqual(result.leftoverProfiles, [], 'the bound kill left the browser profile behind');
});
