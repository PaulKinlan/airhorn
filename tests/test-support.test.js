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
 * tools/lib/chrome.mjs: the options the migrated tools launch with - a
 * browser-level launch with no page discovery, a profile kept for a restart
 * scenario, and the page ws handshake bound - behave as the tools expect
 * (airhorn-2po9).
 *
 * tools/lib/reap.mjs: the shared profile-marker sweep must reap a tree that
 * carries the marker, and must SAY SO when nothing carries it while a process
 * still names the profile dir - the marker premise drifting must not turn into
 * silent orphan processes (airhorn-qum7).
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SUPPORT = pathToFileURL(path.join(import.meta.dirname, 'support', 'browser.mjs')).href;
const { launchBrowser, launchChrome, connectPage } = await import(SUPPORT);
const { stretchedBounds } = await import(
  pathToFileURL(path.join(import.meta.dirname, '..', 'tools', 'lib', 'chrome.mjs')).href);

// The host-steal preflight (airhorn-w1wh) is driven through its env seam, so a
// test states the host instead of asserting the machine it happens to run on
// (docs/speed.md independence). This file's launch tests are about the launch
// MECHANISM, not the host, so the seam is pinned to "healthy" for the whole
// file: steal 0 is the bounds they were written against. The tests that pin the
// starved branch set it themselves and restore it.
process.env.CHROME_STEAL_OVERRIDE = '0';
// The shared-browser mode (airhorn-w1wh) is the GATE's path: this file drives the
// cold launch, so it must not inherit a shared browser if one is exported around
// it (a gate run selects this suite too, and then AIRHORN_CHROME_WS_* is set).
for (const key of ['AIRHORN_CHROME_WS', 'AIRHORN_CHROME_WS_AUTOPLAY', 'AIRHORN_CHROME_WS_WEBMCP']) {
  delete process.env[key];
}
const withSteal = async (value, fn) => {
  const saved = process.env.CHROME_STEAL_OVERRIDE;
  process.env.CHROME_STEAL_OVERRIDE = value;
  try { return await fn(); } finally { process.env.CHROME_STEAL_OVERRIDE = saved; }
};
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

// A DevTools endpoint that is not ready yet: it drops the first `failures`
// connections, then answers like discoveryPeer. This is the measured shape of a
// starved box - chrome's DevTools HTTP server accepts the connection and answers
// late - which a single fetch reported as 'DevTools discovery timeout' before any
// suite assertion ran (airhorn-sesh).
const slowStartPeer = (failures) => new Promise((resolve) => {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    if (seen <= failures) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/x' }]));
  });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    attempts: () => seen,
    close: () => new Promise((r) => server.close(r)),
  }));
});

// A stand-in for the chrome binary: prints the ws:// line the helper scrapes,
// then idles so the launch reaches discovery. Chrome's own args are ignored.
// trapsTerm: a stub that ignores SIGTERM, standing in for the real browser's
// writeback window where a TERM does not end it - the shape that makes a
// graceful-exit wait in close() cost its full length (airhorn-gau8).
function stubChrome(dir, port, { trapsTerm = false } = {}) {
  const file = path.join(dir, `chrome-stub-${port}.sh`);
  fs.writeFileSync(file,
    '#!/bin/sh\n' +
    `echo "DevTools listening on ws://127.0.0.1:${port}/devtools/browser/stub" >&2\n` +
    (trapsTerm ? "trap '' TERM\n" : '') +
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

test('a /json/list that refuses its first attempts is retried until it answers (airhorn-sesh)', async () => {
  const dir = marker();
  const peer = await slowStartPeer(3);
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('slow-start');
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = stub;
    const browser = await launchBrowser({ label, discoveryMs: 8000, timeoutMs: 8000 });
    try {
      assert.ok(peer.attempts() > 3,
        `discovery was not retried: /json/list answered on attempt ${peer.attempts()}, so the launch gave up on an endpoint that was merely not ready yet`);
      assert.ok(browser.pageWsUrl, 'the retried discovery must still resolve the page target');
    } finally {
      await browser.close();
    }
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
  // processes AND profiles are asserted here. The two shapes below are what
  // make the test falsifiable against the pre-fix helper (which awaited its
  // graceful exit BEFORE the rm - airhorn-x0eu); with the old shape (a stub
  // that died on TERM, the handle assigned in a .then) the test passed on the
  // pre-fix helper in ~0.3s:
  // - the in-flight launch is held as the PENDING promise, so the cleanup's
  //   inflight?.close() is the TypeError the fix commit named as the repro's
  //   actual killer: signal-exit swallows it and its race resolves at ~0ms,
  //   so the process exits while owned's rm is still scheduled behind the
  //   graceful wait - and if close() ever grows an await before its rm again,
  //   this shape leaks again.
  // - the OWNED stub traps SIGTERM, so a graceful-exit wait costs its full
  //   1500ms (real chrome's writeback window). The stand-in installs the
  //   handler with graceMs 1200 < 1500: a wait-then-rm close() cannot fit the
  //   wait inside the grace, so the wait-before-rm half fails deterministically
  //   even if the sibling throw is ever guarded away. On the fixed helper the
  //   rm is synchronous before the first await, so neither bound is reached.
  const dir = marker();
  const labelOwned = runLabel('gau8owned');
  const labelInflight = runLabel('gau8inflight');
  const peerOwned = await discoveryPeer();
  const peerInflight = await silentPeer();
  const stubOwned = stubChrome(dir, peerOwned.port, { trapsTerm: true });
  const stubInflight = stubChrome(dir, peerInflight.port);
  const realChromeBin = process.env.CHROME_BIN;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { launchBrowser } = await import(${JSON.stringify(SUPPORT)});
    const { installSignalExit } = await import(${JSON.stringify(SIGNAL_EXIT)});
    let owned = null, inflight = null;
    installSignalExit(async () => { await Promise.all([owned?.close(), inflight?.close()]); }, { graceMs: 1200 });
    process.env.CHROME_BIN = ${JSON.stringify(stubOwned)};
    owned = await launchBrowser({ label: ${JSON.stringify(labelOwned)} });
    process.env.CHROME_BIN = ${JSON.stringify(stubInflight)};
    inflight = launchBrowser({ label: ${JSON.stringify(labelInflight)}, discoveryMs: 60000, timeoutMs: 60000 })
      .catch(() => {});
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
    // A failed run can leave the TERM-trapping stub alive (nothing below the
    // failed assertion SIGKILLed it): kill it by its unique per-run path, or
    // this test becomes the leak it asserts against. -KILL, not pkill's
    // default TERM: the owned stub ignores TERM, that is its point.
    for (const stub of [stubOwned, stubInflight]) {
      try { execFileSync('pkill', ['-KILL', '-f', stub]); } catch { /* already gone */ }
    }
    process.env.CHROME_BIN = realChromeBin;
    await peerOwned.close();
    await peerInflight.close();
    removeProfiles(labelOwned);
    removeProfiles(labelInflight);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -- tools/lib/chrome.mjs: the options the tools launch with (airhorn-2po9) -- */

// The eight tools migrated onto the one launcher in airhorn-2po9. Three of its
// options exist only for them, and each replaces a private copy of a bound that
// already cost a merge somewhere: discoverPage:false (a browser-level CDP
// session, tools/resilience-audit.mjs), keepProfile:true (the persistent-profile
// scenarios, tools/rollback-rehearsal.mjs), and connectPage()'s ws bound
// (airhorn-doek/nbfp/e4im - the same handshake timeout fixed in four copies).

test('connectPage bounds the page ws handshake instead of parking the caller (airhorn-doek)', async () => {
  // The silent peer accepts the TCP connection and writes no HTTP response, so
  // the WebSocket upgrade never completes - the shape that parked a tool with a
  // live browser when the open was unbounded.
  const peer = await silentPeer();
  try {
    const startedAt = Date.now();
    await assert.rejects(
      connectPage(`ws://127.0.0.1:${peer.port}/devtools/page/x`, { label: 'ws-bound', timeoutMs: 300 }),
      /DevTools ws handshake timeout \(ws-bound\): the page socket never opened within 300ms/);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `the ws bound did not hold: connectPage took ${elapsed}ms against a 300ms bound`);
  } finally {
    await peer.close();
  }
});

test('connectPage refuses to dial a handle that has no page target', async () => {
  await assert.rejects(connectPage({ pageWsUrl: null }, { label: 'no-page' }),
    /connectPage: no page socket to dial \(no-page\)/);
});

test('discoverPage:false launches without touching /json/list (tools/resilience-audit.mjs)', async () => {
  // A browser-level CDP session never needs a page, and the peer below never
  // answers /json/list: if the launcher fetched it, this launch would sit at the
  // discovery bound and fail.
  const dir = marker();
  const peer = await silentPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('nopagefetch');
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = stub;
    const handle = await launchChrome({ label, discoverPage: false, discoveryMs: 60000, timeoutMs: 5000 });
    try {
      assert.match(handle.browserWsUrl, /^ws:\/\//, 'the browser-level endpoint must still be resolved');
      assert.equal(handle.port, String(peer.port), 'the port must come from the announced endpoint');
      assert.equal(handle.pageWsUrl, null, 'no page target was asked for, so there must be none');
      assert.equal(handle.pageTargetId, null, 'no page target was asked for, so there must be none');
    } finally {
      await handle.close();
    }
    assert.deepEqual(liveStubProcesses(stub), [], 'close() must reap the browser it launched');
    assert.deepEqual(profilesFor(label), [], 'close() must remove the profile it made');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    await peer.close();
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keepProfile:true leaves the profile on disk for a restart scenario (tools/rollback-rehearsal.mjs)', async () => {
  const dir = marker();
  const peer = await discoveryPeer();
  const stub = stubChrome(dir, peer.port);
  const label = runLabel('keep');
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = stub;
    const handle = await launchChrome({ label, keepProfile: true });
    const profileDir = handle.profileDir;
    await handle.close();
    try {
      assert.ok(fs.existsSync(profileDir), 'keepProfile must leave the directory: a restart scenario reuses it');
      assert.deepEqual(liveStubProcesses(stub), [], 'the browser must still be reaped');
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    await peer.close();
    removeProfiles(label);
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

/*
 * Host steal (airhorn-w1wh): the bounds must state the host's condition instead
 * of asserting a machine speed. Measured on the fleet box, /proc/stat steal sat
 * at 88-96% for minutes, chrome needed 22-57s to answer /json/list at ONE
 * browser, and a gate paid 1800s to report eleven expired bounds as eleven
 * suite failures. These three tests pin both branches and the wiring, and none
 * of them reads the machine.
 */
test('a starved host refuses the launch before spawning or creating a profile, naming the steal (airhorn-w1wh)', async () => {
  const dir = marker();
  const ran = path.join(dir, 'stub-ran');
  const stub = path.join(dir, 'chrome-stub-starved.sh');
  // The stub's only job is to record that it was started at all.
  fs.writeFileSync(stub, `#!/bin/sh\ntouch "${ran}"\nwhile :; do sleep 5; done\n`, { mode: 0o755 });
  const label = runLabel('starved');
  const realChromeBin = process.env.CHROME_BIN;
  process.env.CHROME_BIN = stub;
  try {
    await withSteal('0.96', () => assert.rejects(
      () => launchChrome({ label }),
      /host starved: steal 96% \(ceiling 60%\)/,
      'a starved host must refuse at once, and the message must carry the measured steal'));
    assert.equal(fs.existsSync(ran), false, 'the browser binary must not be spawned on a starved host');
    assert.deepEqual(profilesFor(label), [], 'a launch that never started must not create a profile dir');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    removeProfiles(label);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bounds stretch with the load, and are untouched on an unstarved host (airhorn-w1wh)', () => {
  const bounds = (steal) => stretchedBounds({ timeoutMs: 15000, discoveryMs: 15000, steal });
  // Healthy and unknown are the SAME bounds as before this existed: no behaviour
  // change on a box that is not starved is the point, not a nicety.
  assert.deepEqual(bounds(0), { timeoutMs: 15000, discoveryMs: 15000 }, 'a healthy host keeps its bounds exactly');
  assert.deepEqual(bounds(null), { timeoutMs: 15000, discoveryMs: 15000 }, 'an unknown reading must not invent a bound');
  // 1/(1-steal): the factor the machine is slower by, not a guess.
  assert.deepEqual(bounds(0.5), { timeoutMs: 30000, discoveryMs: 30000 });
  assert.deepEqual(bounds(0.25), { timeoutMs: 20000, discoveryMs: 20000 });
  // Capped: 0.99 asks for 100x, and an unbounded stretch is just a hang.
  assert.deepEqual(bounds(0.99), { timeoutMs: 120000, discoveryMs: 120000 }, 'the stretch is capped');
});

test('the stretched bound is the one a stalled launch actually reports (airhorn-w1wh)', async () => {
  const dir = marker();
  // Announces nothing, ever: the startup bound is what ends this launch.
  const stub = path.join(dir, 'chrome-stub-silent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nwhile :; do sleep 5; done\n', { mode: 0o755 });
  const realChromeBin = process.env.CHROME_BIN;
  process.env.CHROME_BIN = stub;
  try {
    const healthyLabel = runLabel('healthy-bound');
    await withSteal('0', () => assert.rejects(
      () => launchChrome({ label: healthyLabel, timeoutMs: 400, discoveryMs: 400 }),
      /Chrome start timeout \(bsup-healthy-bound-[^)]*\) after 400ms \(steal 0%\)/,
      'an unstarved host must still fail at the bound the caller asked for'));
    assert.deepEqual(profilesFor(healthyLabel), [], 'the reaped launch left a profile behind');

    const loadedLabel = runLabel('loaded-bound');
    const startedAt = Date.now();
    await withSteal('0.5', () => assert.rejects(
      () => launchChrome({ label: loadedLabel, timeoutMs: 400, discoveryMs: 400 }),
      /Chrome start timeout \(bsup-loaded-bound-[^)]*\) after 800ms \(steal 50%\)/,
      'the caller\'s bound must be the STRETCHED one, and the error must say by how much'));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 700, `the launch did not honour the stretched bound: rejected after only ${elapsed}ms`);
    assert.deepEqual(liveStubProcesses(stub), [], 'the stalled launch left its stub process tree running');
    assert.deepEqual(profilesFor(loadedLabel), [], 'the stalled launch left its /tmp profile behind');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * The gate's shared browser (airhorn-w1wh). A suite that finds a family env var
 * gets a fresh page in ONE browser the gate already started, instead of paying a
 * launch - on the starved box that is the difference between a gate that runs and
 * one that refuses (eleven launches at 22-57s each). The stub here is a real
 * minimal devtools peer over a real WebSocket, so the client's handshake,
 * Target.createTarget and id-matched /json/list lookup all run for real.
 */
function devtoolsFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

const sharedDevtoolsPeer = ({ targetId, pageWsUrl }) => new Promise((resolve) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // A shared browser lists EVERY suite's targets: the client must match by id.
      res.end(JSON.stringify([
        { id: 'another-suite', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/other' },
        { id: targetId, type: 'page', webSocketDebuggerUrl: pageWsUrl },
      ]));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (buffer) => {
      let offset = 0;
      while (offset + 2 <= buffer.length) {
        const opcode = buffer[offset] & 0x0f;
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;
        if (length === 126) { length = buffer.readUInt16BE(cursor); cursor += 2; }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
        const masked = (buffer[offset + 1] & 0x80) !== 0;
        let mask = null;
        if (masked) { mask = buffer.subarray(cursor, cursor + 4); cursor += 4; }
        const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        offset = cursor + length;
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString());
        const reply = (result) => socket.write(devtoolsFrame(JSON.stringify({ id: message.id, result })));
        if (message.method === 'Target.createTarget') reply({ targetId });
        else reply({});
      }
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/shared-stub`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  }));
});

test('a shared browser hands the suite a fresh page instead of launching one (airhorn-w1wh)', async () => {
  const targetId = 'page-for-this-suite';
  const pageWsUrl = 'ws://127.0.0.1:9/devtools/page/page-for-this-suite';
  const peer = await sharedDevtoolsPeer({ targetId, pageWsUrl });
  const saved = { chrome: process.env.CHROME_BIN, ws: process.env.AIRHORN_CHROME_WS };
  // A binary that must NOT be used: in shared mode there is nothing to spawn.
  process.env.CHROME_BIN = path.join(os.tmpdir(), 'must-not-be-spawned-chrome');
  process.env.AIRHORN_CHROME_WS = peer.url;
  try {
    const handle = await launchBrowser({ label: 'shared-mode' });
    assert.equal(handle.shared, true, 'the shared path must be the one that ran');
    assert.equal(handle.pageWsUrl, pageWsUrl, 'the page must be the one this suite created, matched by target id');
    assert.equal(handle.chrome, null, 'shared mode must not spawn a browser');
    assert.deepEqual(profilesFor('shared-mode'), [], 'shared mode must not create a profile of its own');
    assert.equal(fs.existsSync(process.env.CHROME_BIN), false, 'the configured binary was never needed');
    await handle.close();
  } finally {
    process.env.CHROME_BIN = saved.chrome;
    if (saved.ws === undefined) delete process.env.AIRHORN_CHROME_WS; else process.env.AIRHORN_CHROME_WS = saved.ws;
    await peer.close();
  }
});

test('with no shared browser exported, the suite still cold-launches (airhorn-w1wh)', async () => {
  const label = runLabel('cold-fallback');
  const saved = { chrome: process.env.CHROME_BIN, ws: process.env.AIRHORN_CHROME_WS };
  delete process.env.AIRHORN_CHROME_WS;
  process.env.CHROME_BIN = path.join(os.tmpdir(), 'no-such-chrome-for-cold-fallback');
  try {
    await assert.rejects(() => launchBrowser({ label, timeoutMs: 900, discoveryMs: 900 }),
      'a suite with no shared browser must fall back to a launch, not silently do nothing');
    assert.deepEqual(profilesFor(label), [], 'the failed cold launch left its profile behind');
  } finally {
    process.env.CHROME_BIN = saved.chrome;
    if (saved.ws !== undefined) process.env.AIRHORN_CHROME_WS = saved.ws;
    removeProfiles(label);
  }
});

/*
 * Findings from the airhorn-w1wh review. All three are browser-free: the steal
 * seam and a fixture /proc/stat stand in for the host, and the two tools are
 * driven only as far as the launch.
 */
const CHROME_MJS = path.join(import.meta.dirname, '..', 'tools', 'lib', 'chrome.mjs');
const INSTALL_TOOL = path.join(import.meta.dirname, '..', 'tools', 'install-https-proof.mjs');
const RESILIENCE_TOOL = path.join(import.meta.dirname, '..', 'tools', 'resilience-audit.mjs');
const httpsProofProfiles = () => fs.readdirSync('/tmp')
  .filter((name) => /^chrome-https-proof-(?:tmp-)?[A-Za-z0-9]{6}$/.test(name));

test('a malformed /proc/stat reads as UNKNOWN, never as zero steal (airhorn-w1wh review)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-stat-'));
  const stat = path.join(dir, 'stat');
  // user nice system idle iowait irq softirq steal (guest/guest_nice omitted: the kernel
  // counts those inside user/nice, and the parser must not need them).
  const line = (busy, steal) => `cpu  ${busy} 0 ${busy} ${8000 - busy} 0 0 0 ${steal} 0 0\n`;
  fs.writeFileSync(stat, line(100, 0));
  const saved = { statPath: process.env.CHROME_STAT_PATH, override: process.env.CHROME_STEAL_OVERRIDE };
  process.env.CHROME_STAT_PATH = stat;
  delete process.env.CHROME_STEAL_OVERRIDE;
  try {
    // A fresh module instance takes its baseline from this fixture, not from the
    // machine (a cache-busting query busts ESM's module cache).
    const mod = await import(`${pathToFileURL(CHROME_MJS).href}?w1wh-stat=${Date.now()}`);
    fs.writeFileSync(stat, line(300, 0));   // 200 ticks advanced, no steal: a genuine 0%
    assert.equal(mod.hostSteal(), 0, 'a well-formed line whose steal column did not advance is a real 0%');

    // The defect: a line that LOST the steal column was filled with 0, so once the
    // other counters advanced the preflight reported a confident "healthy" host.
    fs.writeFileSync(stat, `cpu  ${900} 0 ${900} ${8000 - 900} 0 0 0\n`);
    assert.equal(mod.hostSteal(), null, 'a line with no steal field must be UNKNOWN');
    fs.writeFileSync(stat, 'cpu0  10 0 10 80 0 0 0 0\n');
    assert.equal(mod.hostSteal(), null, 'a per-cpu line is not the aggregate line: UNKNOWN');
    fs.writeFileSync(stat, 'cpu  10 0 10 nope 0 0 0 0 0 0\n');
    assert.equal(mod.hostSteal(), null, 'a non-numeric counter must be UNKNOWN');
    // And the pure parser says why, rather than quietly returning a number.
    assert.throws(() => mod.parseCpuTicks('cpu  1 2 3\n'), /malformed aggregate cpu line/);
    assert.throws(() => mod.parseCpuTicks('intr 1 2 3\n'), /not the aggregate 'cpu' line/);
    assert.deepEqual(mod.parseCpuTicks(line(300, 40), 'fixture'),
      { total: 300 + 0 + 300 + (8000 - 300) + 0 + 0 + 0 + 40, steal: 40 },
      'a well-formed line parses to the first eight counters, steal in column 8');
  } finally {
    if (saved.statPath === undefined) delete process.env.CHROME_STAT_PATH; else process.env.CHROME_STAT_PATH = saved.statPath;
    if (saved.override === undefined) delete process.env.CHROME_STEAL_OVERRIDE; else process.env.CHROME_STEAL_OVERRIDE = saved.override;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused launch leaves no profile behind in install-https-proof (airhorn-w1wh review)', async () => {
  const before = httpsProofProfiles();
  const saved = process.env.CHROME_STEAL_OVERRIDE;
  process.env.CHROME_STEAL_OVERRIDE = '0.96';
  try {
    const { openBrowser } = await import(pathToFileURL(INSTALL_TOOL).href);
    await assert.rejects(() => openBrowser([]), /host starved: steal 96%/,
      'the tool passes the preflight parameters that make it refuse on a starved host');
    assert.deepEqual(httpsProofProfiles(), before,
      'the launch never adopted the profile the caller created, so the caller must remove it');
  } finally {
    if (saved === undefined) delete process.env.CHROME_STEAL_OVERRIDE; else process.env.CHROME_STEAL_OVERRIDE = saved;
    for (const name of httpsProofProfiles()) {
      if (!before.includes(name)) fs.rmSync(path.join('/tmp', name), { recursive: true, force: true });
    }
  }
});

test('a browser that cannot start fails the resilience audit instead of passing it (airhorn-w1wh review)', async () => {
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, CHROME_STEAL_OVERRIDE: '0.96' },   // the child must see a starved host
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  assert.notEqual(run.status, 0,
    'an audit whose browser could not start measured nothing, so it must not exit 0 (it reported a table of errors and 0 before)');
  assert.match(output, /cannot launch a browser for the audit|\bhost starved\b/,
    `the failure must name the launch, not just any error: ${output.slice(-400)}`);
  assert.ok(Date.now() - startedAt < 120000, 'the audit must fail at the launch, not run every scenario first');
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

/* ------------------------------------------------------- tools/lib/reap.mjs */

const REAP = pathToFileURL(path.join(import.meta.dirname, '..', 'tools', 'lib', 'reap.mjs')).href;

// Runs the real sweep in a child process so its stderr diagnostic is asserted
// on rather than inferred: sweepProfile writes to the process it runs in, and
// silencing that in-suite would also silence the thing under test.
const runSweep = (dir) => {
  const script = `import { sweepProfile } from ${JSON.stringify(REAP)};\n` +
    `sweepProfile(${JSON.stringify(dir)});\n`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  return { rc: res.status, stderr: res.stderr ?? '' };
};

// A process whose command line carries exactly the given trailing arguments -
// a stand-in for a chrome that either does or does not carry the sweep's
// marker. A unique profile path per test keeps the sweep from seeing anything
// but this run's stand-in.
const spawnStandIn = (args) => spawn(process.execPath,
  ['--input-type=module', '-e', 'setInterval(() => {}, 1000);', ...args], { stdio: 'ignore' });

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('a sweep whose marker matches nothing, while a process still names the profile, says so (airhorn-qum7)', async () => {
  const label = runLabel('reap-drift');
  const dir = `/tmp/${label}`;
  const standIn = spawnStandIn([dir]);          // names the dir, no --user-data-dir=
  try {
    await new Promise((r) => setTimeout(r, 300)); // let the stand-in exec
    const result = runSweep(dir);
    assert.equal(result.rc, 0, `the sweep must not fail: ${JSON.stringify(result)}`);
    assert.match(result.stderr, /no process carries --user-data-dir=/,
      `a sweep that reaped nothing while a process still names the profile must say so; got ${JSON.stringify(result.stderr)}`);
    assert.match(result.stderr, new RegExp(`pid ${standIn.pid}\\b`),
      `the diagnostic must name the process it left alone; got ${JSON.stringify(result.stderr)}`);
    assert.ok(isAlive(standIn.pid), 'a marker miss must not kill anything - the diagnostic is the whole output');
  } finally {
    try { standIn.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('the same sweep still kills everything that carries the marker, silently (airhorn-qum7)', async () => {
  const label = runLabel('reap-marker');
  const dir = `/tmp/${label}`;
  const standIn = spawnStandIn([`--user-data-dir=${dir}`]);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const result = runSweep(dir);
    assert.equal(result.rc, 0, `the sweep must not fail: ${JSON.stringify(result)}`);
    assert.equal(result.stderr, '', `a normal sweep must stay quiet; got ${JSON.stringify(result.stderr)}`);
    assert.ok(!isAlive(standIn.pid), 'a process carrying the marker must be reaped');
  } finally {
    try { standIn.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('a profile left by a SIGKILLed run is swept, a live or brand-new one is not (airhorn-9gao)', async () => {
  // A KILLED run runs neither the finally nor the signal handler, so its
  // profile dir survives with no process to remove it; the next run's stale
  // sweep is the only thing that can. The tmpdir is the test's own, so the
  // sweep cannot see - or remove - a real tool's profile.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `reapstale-${process.pid}-`));
  const stale = path.join(tmpdir, 'chrome-https-proof-stale');
  const fresh = path.join(tmpdir, 'chrome-https-proof-fresh');
  const live = path.join(tmpdir, 'chrome-https-proof-live');
  for (const dir of [stale, fresh, live]) fs.mkdirSync(dir);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(live, old, old);
  const standIn = spawnStandIn([live]); // a live process (a chrome) names this profile
  try {
    await new Promise((r) => setTimeout(r, 300)); // let the stand-in exec
    const { sweepStaleProfiles } = await import(REAP);
    const result = sweepStaleProfiles('chrome-https-proof-', { tmpdir });
    assert.deepEqual(result.swept, ['chrome-https-proof-stale'],
      `only the unreferenced, aged dir may be swept: ${JSON.stringify(result)}`);
    assert.ok(!fs.existsSync(stale), 'the stale dir must be gone from disk');
    assert.ok(fs.existsSync(fresh), 'a dir inside the launch window must be left alone');
    assert.ok(fs.existsSync(live), 'a dir a live process names must be left alone');
    assert.ok(isAlive(standIn.pid), 'the sweep is a directory sweep - it must not touch processes');
  } finally {
    try { standIn.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('a caller-owned --out dir under the sweep prefix is never swept (airhorn-13xr)', async () => {
  // A prefix is a name a caller can choose too: `--out /tmp/chrome-https-proof-
  // evidence` matched the sweep and lost its content. Only the exact mkdtemp
  // shape the tool itself creates may be swept, and an explicit exclude always
  // wins - even when a caller's name happens to look like that shape.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `reapshape-${process.pid}-`));
  const litter = path.join(tmpdir, 'chrome-https-proof-a1B2c3');
  const certTemp = path.join(tmpdir, 'chrome-https-proof-tmp-z9Y8x7');
  const evidence = path.join(tmpdir, 'chrome-https-proof-evidence');
  const shapedEvidence = path.join(tmpdir, 'chrome-https-proof-q4W5e6');
  for (const dir of [litter, certTemp, evidence, shapedEvidence]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(shapedEvidence, 'keep-me.txt'), 'precious');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const dir of [litter, certTemp, evidence, shapedEvidence]) fs.utimesSync(dir, old, old);
  try {
    const { sweepStaleProfiles } = await import(REAP);
    const result = sweepStaleProfiles('chrome-https-proof-', {
      tmpdir,
      pattern: /^chrome-https-proof-(?:tmp-)?[A-Za-z0-9]{6}$/,
      exclude: [shapedEvidence],
    });
    assert.deepEqual(result.swept.sort(), ['chrome-https-proof-a1B2c3', 'chrome-https-proof-tmp-z9Y8x7'],
      `only the mkdtemp-shaped litter may be swept: ${JSON.stringify(result)}`);
    assert.ok(fs.existsSync(evidence), 'a longer name is not the shape this tool creates');
    assert.equal(fs.readFileSync(path.join(shapedEvidence, 'keep-me.txt'), 'utf8'), 'precious',
      'an excluded --out must survive even when its name matches the mkdtemp shape');
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
