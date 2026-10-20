/*
 * tests/test-support.test.js — the shared test support modules behave on their failure paths.
 *
 * tests/support/browser.mjs: launchBrowser must never leave a Chrome tree or a
 * /tmp profile behind when it fails to hand a handle back: the caller only
 * registers its own signal handler after it returns, so anything the helper
 * leaves is unattributable until the reaper's 45-minute rule finds it
 * (airhorn-9nea, airhorn-4yhb).
 *
 * tests/support/signal-exit.mjs: a bound-kill must run the cleanup exactly once,
 * must not outlive the grace bound, and must exit with the signal's own code
 * (airhorn-4vfn).
 *
 * The browser tests drive the helper with a stub CHROME_BIN (a shell script that
 * announces a ws:// URL on stderr and stays alive, exactly as the real binary
 * does) and a real silent DevTools peer - an HTTP server that accepts the
 * connection and never answers - so the abort is exercised through real undici
 * rather than a stubbed fetch. No headless browser is started: the suite costs
 * ~2s and can run beside the browser suites.
 *
 * Every test cleans up in a finally and uses a label unique to the run, so a
 * failing assertion cannot leak a server, a stub process or a profile dir - and
 * cannot be mistaken for a leak it did not cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SUPPORT = pathToFileURL(path.join(import.meta.dirname, 'support', 'browser.mjs')).href;
const { launchBrowser } = await import(SUPPORT);
const SIGNAL_EXIT = pathToFileURL(path.join(import.meta.dirname, 'support', 'signal-exit.mjs')).href;

const runLabel = (what) => `bsup-${what}-${process.pid}-${Date.now()}`;

// A DevTools endpoint that accepts and never answers (the silent peer). Its port
// is what the stub binary advertises, so launchBrowser fetches it for real.
const silentPeer = () => new Promise((resolve) => {
  const sockets = new Set();
  const server = http.createServer(() => { /* never write a response */ });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  }));
});

// A DevTools endpoint that answers /json/list with one page target - the
// discovery the helper needs to resolve a handle. The page ws it advertises is
// never dialled by these tests.
const discoveryPeer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/x' }]));
  });
  server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
});

// A stand-in for the chrome binary: prints the ws:// line the helper scrapes,
// then idles so the launch reaches discovery. Chrome's own args are ignored.
// opts.ignoreTerm makes it ignore SIGTERM - a stand-in for a chrome whose
// graceful shutdown does not fit the caller's budget, which is what makes the
// gau8 test able to FAIL against a close() that waits before it sweeps.
function stubChrome(dir, port, { ignoreTerm = false } = {}) {
  const file = path.join(dir, `chrome-stub-${port}.sh`);
  fs.writeFileSync(file,
    '#!/bin/sh\n' +
    `echo "DevTools listening on ws://127.0.0.1:${port}/devtools/browser/stub" >&2\n` +
    (ignoreTerm ? 'trap "" TERM\n' : '') +
    'while :; do sleep 5; done\n', { mode: 0o755 });
  return file;
}

const marker = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-support-test-'));

// Processes still running from this test's stub binary, and the profile dirs the
// helper made for this run's label. Both must be empty after a failed launch.
const liveStubProcesses = (stubFile) => execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
  .split('\n').filter((line) => line.includes(stubFile));
const profilesFor = (label) => fs.readdirSync('/tmp').filter((name) => name.startsWith(`chrome-${label}-`));
const removeProfiles = (label) => {
  for (const name of profilesFor(label)) fs.rmSync(path.join('/tmp', name), { recursive: true, force: true });
};
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('a stalled /json/list is bounded: the launch rejects, the browser and its profile are reaped (airhorn-4yhb)', async () => {
  const dir = marker();
  const peer = await silentPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('stalled');
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = stub;
    const startedAt = Date.now();
    await assert.rejects(launchBrowser({ label, discoveryMs: 400, timeoutMs: 5000 }),
      /DevTools discovery timeout \(400ms\) .*never answered/,
      'a peer that accepts and never answers must reject at the discovery bound, not park the launch');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `the discovery bound did not hold: launchBrowser took ${elapsed}ms against a 400ms bound`);
    assert.deepEqual(liveStubProcesses(stub), [], 'the stalled launch left its chrome process tree running');
    assert.deepEqual(profilesFor(label), [], 'the stalled launch left its /tmp profile behind');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    await peer.close();
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the discovery bound holds against a fetch that ignores its AbortSignal (the reviewer repro)', async () => {
  // airhorn-4yhb's repro replaces fetch with a never-settling promise, which no
  // AbortSignal can interrupt. The bound must not depend on the peer or on the
  // fetch implementation cooperating.
  const dir = marker();
  const peer = await silentPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('stubfetch');
  const realChromeBin = process.env.CHROME_BIN;
  const realFetch = globalThis.fetch;
  try {
    process.env.CHROME_BIN = stub;
    globalThis.fetch = () => new Promise(() => { /* never settles, ignores the signal */ });
    await assert.rejects(launchBrowser({ label, discoveryMs: 300, timeoutMs: 5000 }),
      /DevTools discovery timeout \(300ms\)/);
    assert.deepEqual(liveStubProcesses(stub), [], 'a fetch that ignores the signal left its chrome process tree running');
    assert.deepEqual(profilesFor(label), [], 'a fetch that ignores the signal left its /tmp profile behind');
  } finally {
    globalThis.fetch = realFetch;
    process.env.CHROME_BIN = realChromeBin;
    await peer.close();
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a /json/list with no page target reaps the browser too (airhorn-9nea)', async () => {
  const dir = marker();
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stub = stubChrome(dir, server.address().port);
  const label = runLabel('nopage');
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = stub;
    await assert.rejects(launchBrowser({ label, discoveryMs: 2000, timeoutMs: 5000 }), /no page target in \/json\/list/);
    assert.deepEqual(liveStubProcesses(stub), [], 'the empty-list failure left its chrome process tree running');
    assert.deepEqual(profilesFor(label), [], 'the empty-list failure left its /tmp profile behind');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    await new Promise((r) => server.close(r));
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bound-kill during discovery reaps the browser before the process dies (airhorn-4yhb)', async () => {
  const dir = marker();
  const peer = await silentPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('sigt');
  // A separate process stands in for a suite: it is mid-launch, has no handle
  // yet, and is the one the gate's bound sends SIGTERM to.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { launchBrowser } = await import(${JSON.stringify(SUPPORT)});
    launchBrowser({ label: ${JSON.stringify(label)}, discoveryMs: 60000, timeoutMs: 60000 }).catch(() => {});
    console.log('launching');
    await new Promise(() => {});
  `], { env: { ...process.env, CHROME_BIN: stub }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  try {
    assert.ok(await waitFor(async () => out.includes('launching') && liveStubProcesses(stub).length > 0),
      'the stand-in suite never got as far as launching the stub browser');
    const exit = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGTERM');
    const how = await exit;
    assert.equal(how.signal, 'SIGTERM',
      `the signal must still kill the process (no other handler exists here): ${JSON.stringify(how)}`);
    assert.ok(await waitFor(() => liveStubProcesses(stub).length === 0),
      'a bound-kill during discovery left the chrome process tree running - nothing reaps it');
    assert.deepEqual(profilesFor(label), [], 'a bound-kill during discovery left its /tmp profile behind');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await peer.close();
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ancestor group-kill reaches the browser: it is not detached into its own group (airhorn-acex)', async () => {
  // fleet-gate's bound and any job-tree reaper kill the caller's PROCESS GROUP,
  // and a SIGKILL runs no node handler - so if the launcher had put the browser
  // into its own group (detached: true), nothing but the reaper's orphan sweep
  // would ever reach it. The stand-in suite below is spawned detached exactly
  // as a gate job is (it is its own group leader), and the kill is the bound's:
  // SIGKILL to the whole group.
  const dir = marker();
  const peer = await silentPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('groupkill');
  const realChromeBin = process.env.CHROME_BIN;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { launchBrowser } = await import(${JSON.stringify(SUPPORT)});
    launchBrowser({ label: ${JSON.stringify(label)}, discoveryMs: 60000, timeoutMs: 60000 }).catch(() => {});
    console.log('launching');
    await new Promise(() => {});
  `], { env: { ...process.env, CHROME_BIN: stub }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  try {
    assert.ok(await waitFor(async () => out.includes('launching') && liveStubProcesses(stub).length > 0),
      'the stand-in suite never got as far as launching the stub browser');
    const exit = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    process.kill(-child.pid, 'SIGKILL');
    const how = await exit;
    assert.equal(how.signal, 'SIGKILL',
      `the group kill must take the stand-in itself: ${JSON.stringify(how)}`);
    assert.ok(await waitFor(() => liveStubProcesses(stub).length === 0),
      'the browser was launched into its own process group: it escaped the ancestor group-kill ' +
      'that a bound sends (airhorn-acex) - it must be in the caller\'s group');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await peer.close();
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGTERM in the launch window leaves no profile for the OWNED browser either (airhorn-gau8)', async () => {
  // The half the earlier verification missed: 0 chrome PIDs reproduced, but
  // the OWNED browser's /tmp profile survived - close() paid a 1.5s graceful
  // wait inside signal-exit's grace and the rm never ran. Both browsers'
  // processes AND profiles are asserted here. The owned stub ignores TERM and
  // the grace is 800ms, so a close() that waits before it sweeps loses the
  // profile and FAILS this test (airhorn-x0eu); the writeback-storm shape of
  // the defect is separately proven by the bead's real-chrome repro.
  const dir = marker();
  const labelOwned = runLabel('gau8owned');
  const labelInflight = runLabel('gau8inflight');
  const peerOwned = await discoveryPeer();
  const peerInflight = await silentPeer();
  const stubOwned = stubChrome(dir, peerOwned.port, { ignoreTerm: true });
  const stubInflight = stubChrome(dir, peerInflight.port);
  const realChromeBin = process.env.CHROME_BIN;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { launchBrowser } = await import(${JSON.stringify(SUPPORT)});
    const { installSignalExit } = await import(${JSON.stringify(SIGNAL_EXIT)});
    let owned = null, inflight = null;
    // 800ms grace: TIGHTER than the default 2s, so the pre-gau8 close() (which
    // waited up to 1500ms for a graceful exit before sweeping) cannot finish
    // inside it - the owned stub below IGNORES TERM, exactly the slow-exit
    // case that made the real defect. Post-fix close() sweeps and rms
    // synchronously before its first await (~10ms) and passes with room to
    // spare: the test can now FAIL against the defect it guards (airhorn-x0eu).
    installSignalExit(async () => { await Promise.all([owned?.close(), inflight?.close()]); }, { graceMs: 800 });
    process.env.CHROME_BIN = ${JSON.stringify(stubOwned)};
    owned = await launchBrowser({ label: ${JSON.stringify(labelOwned)} });
    process.env.CHROME_BIN = ${JSON.stringify(stubInflight)};
    launchBrowser({ label: ${JSON.stringify(labelInflight)}, discoveryMs: 60000, timeoutMs: 60000 })
      .then((h) => { inflight = h; }).catch(() => {});
    console.log('two-up');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);
    await new Promise(() => {});
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  try {
    assert.ok(await waitFor(async () => out.includes('two-up') && liveStubProcesses(stubOwned).length > 0 && liveStubProcesses(stubInflight).length > 0),
      'the stand-in never got both browsers up');
    const exit = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGTERM');
    const how = await exit;
    assert.equal(how.code, 128 + 15,
      `the stand-in must die the bound-kill way (installSignalExit exits 143): ${JSON.stringify(how)}`);
    assert.ok(await waitFor(() => liveStubProcesses(stubOwned).length === 0 && liveStubProcesses(stubInflight).length === 0),
      'a SIGTERM in the launch window left chrome processes running');
    assert.ok(await waitFor(() => profilesFor(labelOwned).length === 0),
      'the OWNED browser\'s /tmp profile survived the bound-kill (airhorn-gau8)');
    assert.deepEqual(profilesFor(labelInflight), [],
      'the in-flight browser\'s /tmp profile survived the bound-kill');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    process.env.CHROME_BIN = realChromeBin;
    await peerOwned.close();
    await peerInflight.close();
    removeProfiles(labelOwned);
    removeProfiles(labelInflight);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -- the shared bound-kill handler (airhorn-4vfn) --------------------------- */

// A stand-in suite: install the shared handler, then take the signal a bound
// kill sends. Everything asserted here is real process behaviour - the exit
// status, how many times the cleanup ran, and whether a wedged cleanup can hold
// the process past the grace bound.
const runStandIn = ({ signal, graceMs, cleanup }) => new Promise((resolve) => {
  const dir = marker();
  const seen = path.join(dir, 'cleanup.log');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const { installSignalExit } = await import(${JSON.stringify(SIGNAL_EXIT)});
    const seen = ${JSON.stringify(seen)};
    installSignalExit(async () => {
      fs.appendFileSync(seen, 'ran\\n');
      ${cleanup}
    }${graceMs ? `, { graceMs: ${graceMs} }` : ''});
    console.log('ready');
    // A real suite is busy when the bound-kill lands, so keep the loop alive:
    // signal handles alone are unref'd, and an idle process would exit on its
    // own (code 13, unsettled top-level await) before the signal is delivered.
    setInterval(() => {}, 1000);
    await new Promise((r) => setTimeout(r, 50));
    process.kill(process.pid, ${JSON.stringify(signal)});
    ${signal === 'SIGTERM' ? "process.kill(process.pid, 'SIGTERM');" : ''}
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const startedAt = Date.now();
  child.on('exit', (code, sig) => {
    const runs = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).length : 0;
    fs.rmSync(dir, { recursive: true, force: true });
    resolve({ code, signal: sig, runs, elapsed: Date.now() - startedAt, out });
  });
});

test('a bound-kill exits with the signal code and runs the cleanup exactly once (airhorn-4vfn)', async () => {
  // Two SIGTERMs: the second must not run the cleanup again.
  const result = await runStandIn({ signal: 'SIGTERM', cleanup: '' });
  assert.equal(result.code, 128 + 15, `SIGTERM must exit 143: ${JSON.stringify(result)}`);
  assert.equal(result.runs, 1, `the cleanup ran ${result.runs} time(s), not once: ${JSON.stringify(result)}`);
});

test('SIGINT exits 130, not SIGTERM’s 143 (airhorn-4vfn)', async () => {
  const result = await runStandIn({ signal: 'SIGINT', cleanup: '' });
  assert.equal(result.code, 128 + 2, `SIGINT must exit 130: ${JSON.stringify(result)}`);
});

test('a wedged cleanup cannot hold the process past the grace bound (airhorn-4vfn)', async () => {
  const result = await runStandIn({ signal: 'SIGTERM', graceMs: 250, cleanup: 'await new Promise(() => {});' });
  assert.equal(result.code, 128 + 15, `the grace bound must still exit 143: ${JSON.stringify(result)}`);
  assert.ok(result.elapsed < 3000, `a wedged cleanup held the process for ${result.elapsed}ms against a 250ms grace bound`);
});
