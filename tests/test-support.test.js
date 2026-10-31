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
// Round 6, P1: CHROME_STEAL_OVERRIDE / CHROME_STEAL_CEILING are honoured only in an
// explicit test context, so a stray variable cannot disable the ceiling in production.
// This file is that context.
process.env.AIRHORN_TEST_CONTEXT = '1';
// The shared-browser mode is not part of this branch (it was split out with its two
// P1s): this file drives the cold launch only.
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
const profilesFor = (label) => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`chrome-${label}-`));
const removeProfiles = (label) => {
  for (const name of profilesFor(label)) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
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

const CHROME_MJS = path.join(import.meta.dirname, '..', 'tools', 'lib', 'chrome.mjs');
const INSTALL_TOOL = path.join(import.meta.dirname, '..', 'tools', 'install-https-proof.mjs');
const httpsProofProfiles = () => fs.readdirSync(os.tmpdir())
  .filter((name) => /^chrome-https-proof-(?:tmp-)?[A-Za-z0-9]{6}$/.test(name));

test('an unreadable /proc/stat is UNKNOWN, and UNKNOWN refuses the launch (airhorn-w1wh review)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-stat-'));
  const stat = path.join(dir, 'stat');
  const saved = { statPath: process.env.CHROME_STAT_PATH, bin: process.env.CHROME_BIN, override: process.env.CHROME_STEAL_OVERRIDE };
  try {
    const { parseCpuTicks, cpuStatProblem, hostSteal, stealUnknownReason, launchChrome } = await import(
      `${pathToFileURL(CHROME_MJS).href}?w1wh-unknown=${Date.now()}`);

    // Round 6, P3: the parser RETURNS null rather than throwing, and says why separately.
    for (const [bad, why] of [
      ['cpu  1 2 3\n', /malformed aggregate cpu line/],
      ['cpu0  10 0 10 80 0 0 0 0\n', /not the aggregate 'cpu' line/],
      ['cpu  10 0 10 nope 0 0 0 0 0 0\n', /non-numeric/],
    ]) {
      assert.equal(parseCpuTicks(bad), null, `a malformed line must be UNKNOWN, not a number: ${JSON.stringify(bad)}`);
      assert.match(cpuStatProblem(bad), why, 'and it must name the reason');
    }
    // A well-formed line still parses, first eight counters, steal in column 8.
    assert.deepEqual(parseCpuTicks('cpu  300 0 300 7700 0 0 0 40 0 0\n', 'fixture'),
      { total: 300 + 0 + 300 + 7700 + 0 + 0 + 0 + 40, steal: 40 });

    // A missing file is UNKNOWN too, and the reason names the file.
    process.env.CHROME_STAT_PATH = path.join(dir, 'does-not-exist');
    delete process.env.CHROME_STEAL_OVERRIDE;
    assert.equal(hostSteal(), null, 'a missing /proc/stat cannot produce a steal rate');
    assert.match(stealUnknownReason(), /does-not-exist/, 'the reason must name the file it could not read');

    // And the preflight REFUSES on UNKNOWN instead of skipping the check (round 6, P3).
    process.env.CHROME_BIN = path.join(os.tmpdir(), 'must-not-be-spawned-chrome');
    await assert.rejects(() => launchChrome({ label: 'unknown-steal' }),
      (err) => /cannot judge host steal/.test(err.message) && /does-not-exist/.test(err.message),
      'an unknown steal reading must refuse the launch and say why');

    // Same for a malformed line: still a refusal, never a launch.
    fs.writeFileSync(stat, 'cpu  900 0 900 7100 0 0 0\n');   // steal column gone
    process.env.CHROME_STAT_PATH = stat;
    await assert.rejects(() => launchChrome({ label: 'malformed-steal' }),
      /cannot judge host steal: .*malformed aggregate cpu line/,
      'a line without the steal column must refuse, naming the malformed line');
  } finally {
    if (saved.statPath === undefined) delete process.env.CHROME_STAT_PATH; else process.env.CHROME_STAT_PATH = saved.statPath;
    if (saved.bin === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = saved.bin;
    if (saved.override === undefined) delete process.env.CHROME_STEAL_OVERRIDE; else process.env.CHROME_STEAL_OVERRIDE = saved.override;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the steal seams cannot be used to bypass the ceiling outside a test context (airhorn-w1wh review)', async () => {
  // Round 6, P1: CHROME_STEAL_OVERRIDE=0 on a 96% host used to proceed to spawn, and
  // CHROME_STEAL_CEILING=1 raised the ceiling - both in production. Neither may apply
  // without an explicit test context, and the ceiling can never be raised without one.
  const { resolveSeams, stealCeiling, DEFAULT_STEAL_CEILING } = await import(
    `${pathToFileURL(CHROME_MJS).href}?w1wh-seams=${Date.now()}`);

  const production = resolveSeams({ CHROME_STEAL_OVERRIDE: '0', CHROME_STEAL_CEILING: '1' });
  assert.equal(production.testContext, false);
  assert.equal(production.override, null, 'a production CHROME_STEAL_OVERRIDE must be IGNORED');
  assert.equal(production.ceiling, DEFAULT_STEAL_CEILING, 'a production CHROME_STEAL_CEILING must be IGNORED');
  assert.equal(stealCeiling({ CHROME_STEAL_CEILING: '0.99' }), DEFAULT_STEAL_CEILING,
    'the ceiling accessor ignores the variable outside a test context');

  const test = resolveSeams({ AIRHORN_TEST_CONTEXT: '1', CHROME_STEAL_OVERRIDE: '0', CHROME_STEAL_CEILING: '0.9' });
  assert.equal(test.testContext, true);
  assert.equal(test.override, 0, 'inside a test context the override applies');
  assert.equal(test.ceiling, 0.9, 'inside a test context the ceiling may be retuned');
  assert.equal(resolveSeams({ CHROME_STEAL_OVERRIDE: '0' }).override, null,
    'the context must be explicit, not implied by the presence of the variable');
});

test('the steal decision uses ONLY the latest window, never an average or an earlier value (airhorn-w1wh review)', async () => {
  // Round 7. The probe owns a baseline taken at call time, but each window is computed
  // from its OWN two readings and the answer is the LAST window measured. No band
  // returns early, and nothing falls back to an earlier number.
  const { stealRate, createStealProbe } = await import(`${pathToFileURL(CHROME_MJS).href}?w1wh-window=${Date.now()}`);
  const probeOf = (readings) => {
    const it = readings[Symbol.iterator]();
    return createStealProbe({
      readStat: () => {
        const next = it.next();
        if (next.done) throw new Error('readStat exhausted: the probe read more than the fixture allows');
        return next.value;
      },
      sleep: () => {},
    });
  };

  // (1) The reported case: {10000,0}, {10100,0}, {10300,170}. Averaging from the
  // baseline gave 56.7% and launched; the latest window is 85% and must refuse.
  assert.equal(((170 - 0) / (10300 - 10000)).toFixed(3), '0.567', 'the trap: baseline-to-now reads 56.7%');
  assert.equal(probeOf([{ total: 10000, steal: 0 }, { total: 10100, steal: 0 }, { total: 10300, steal: 170 }]).rate(), 0.85,
    'the latest window (10100 -> 10300) is 85% stolen and that is the verdict');

  // (2) Two healthy reads then a rise: the rate is the latest window, not the average.
  assert.equal(probeOf([{ total: 10000, steal: 0 }, { total: 10100, steal: 20 }, { total: 10200, steal: 30 }]).rate(), 0.10,
    'the second window (20 -> 30 of 100) is 10%, not the 15% average across both');

  // (3) Counters going backwards is UNKNOWN - and never the earlier healthy number.
  // The window BEFORE the backwards one is healthy on purpose: the round-7 regression
  // kept that 0% and launched (airhorn-w1wh round 8, P2).
  const backwards = probeOf([{ total: 1000, steal: 0 }, { total: 1100, steal: 0 }, { total: 1050, steal: 5 }]);
  assert.equal(backwards.rate(), null, 'a healthy window must not survive counters going backwards');
  assert.match(backwards.reason(), /went backwards/, 'and the reason says so');

  // (3b) steal outgrowing the total is not "100% starved", it is unreadable. Clamping it
  // to 1 refused with 'host starved' for a pair that cannot both be right (round 8, P1).
  // Three readings so the probe can take its two windows: the second window is the
  // impossible pair (60 total ticks advanced, 150 of them "stolen").
  const impossible = probeOf([{ total: 100, steal: 0 }, { total: 140, steal: 0 }, { total: 200, steal: 150 }]);
  assert.equal(impossible.rate(), null, 'steal > total is UNKNOWN, not a 100% verdict');
  assert.match(impossible.reason(), /steal advanced faster than the total/, 'and it names why');

  // (3c) Running out of attempts after ONE usable window must say that, not report a
  // generic "no usable window" (round 8, P2).
  const exhausted = probeOf([{ total: 0, steal: 0 }, { total: 4, steal: 0 }, { total: 8, steal: 0 },
    { total: 12, steal: 0 }, { total: 112, steal: 0 }]);
  assert.equal(exhausted.rate(), null);
  assert.equal(typeof exhausted.reason(), 'string', 'exhaustion must carry a reason, not null');
  assert.match(exhausted.reason(), /only 1 of 2 usable windows/, 'exhaustion reports how many windows worked');

  // (4) A window whose delta is too small is retried, then UNKNOWN - not 0%.
  const short = probeOf([{ total: 10000, steal: 0 }, { total: 10004, steal: 0 }, { total: 10008, steal: 0 },
    { total: 10012, steal: 0 }, { total: 10016, steal: 0 }]);
  assert.equal(short.rate(), null, 'windows that advanced 4 ticks each are not a verdict');
  assert.match(short.reason(), /too few ticks/, 'and the reason says which');

  // ...and a short window followed by a real one still decides on the latest window.
  assert.equal(probeOf([{ total: 10000, steal: 0 }, { total: 10004, steal: 0 },
    { total: 10104, steal: 90 }, { total: 10204, steal: 180 }]).rate(), 0.90,
    'a retried window still ends the probe on the latest measurement');

  // The pure rate keeps its contract for callers that want the number alone.
  assert.ok(stealRate({ total: 10000, steal: 0 }, { total: 12000, steal: 1920 }) > 0.9,
    'the recent window reports 96%, not the 16% lifetime average');
  assert.equal(stealRate({ total: 100, steal: 0 }, { total: 104, steal: 0 }), null,
    'a window with fewer than ten ticks is not a verdict');
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
      if (!before.includes(name)) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  }
});

const RESILIENCE_TOOL = path.join(import.meta.dirname, '..', 'tools', 'resilience-audit.mjs');

test('a browser that cannot start fails the resilience audit AND still writes the report (airhorn-w1wh review)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-'));
  const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, CHROME_STEAL_OVERRIDE: '0.96', RESILIENCE_OUT: out, RESILIENCE_ONLY: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  try {
    assert.notEqual(run.status, 0,
      'an audit whose browser could not start measured nothing, so it must not exit 0');
    // Round 3: exiting nonzero is not enough - the report is the artefact, so the
    // launch failure must be a ROW in it, not just a message on stderr.
    const md = path.join(out, 'report.md');
    const json = path.join(out, 'report.json');
    assert.ok(fs.existsSync(md), `a starved audit must still write report.md (dir: ${fs.existsSync(out) ? fs.readdirSync(out).join(',') : 'missing'})`);
    assert.ok(fs.existsSync(json), 'a starved audit must still write report.json');
    assert.match(fs.readFileSync(md, 'utf8'), /\| ERROR \|.*cannot launch a browser for the audit/s,
      'the launch failure must appear as an ERROR row in the report, not only in the exit code');
    const report = JSON.parse(fs.readFileSync(json, 'utf8'));
    // Every selected scenario appears, each as an ERROR row: the report is an account of
    // the run, so the unmeasured ones say so rather than vanishing.
    assert.ok(report.scenarios.length > 0, 'the report must carry rows');
    assert.ok(report.scenarios.every((r) => r.status === 'ERROR'),
      `every row must be ERROR when nothing was measured: ${JSON.stringify(report.scenarios.map((r) => r.status))}`);
    assert.match(report.scenarios[0].error, /cannot launch a browser for the audit/,
      'the first row must carry the launch reason');
    assert.ok(report.scenarios.every((r) => r.error), 'no ERROR row may be silent');
    assert.match(output, /\bhost starved\b/, 'the failure must name the starved host, not just any error');
    // The refused launch is REMEMBERED, not retried: one attempt, then every later
    // scenario records "not measured". This is the behaviour the w1wh fix added, and
    // it is the honest replacement for an elapsed-time check against this spawn's own
    // 180 s bound - that could not tell a fast refusal from a slow grind through every
    // scenario, which was the failure its message named (airhorn-auoa). Removing the
    // launchFailed latch leaves every row saying "cannot launch" and turns this red.
    const notMeasured = report.scenarios.filter((r) => /not measured/.test(r.error || ''));
    assert.ok(notMeasured.length > 0,
      'after the first refused launch every later scenario must say "not measured" rather than relaunch: '
      + JSON.stringify(report.scenarios.map((r) => r.error)));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('an audit that selected nothing still exits 0, and still writes a report (airhorn-w1wh review)', async () => {
  // The one case where zero errors means "nothing to say", not "everything passed".
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-none-'));
  try {
    const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
      encoding: 'utf8',
      timeout: 120000,
      // The steal override only guarantees it cannot accidentally launch a browser here.
      env: { ...process.env, CHROME_STEAL_OVERRIDE: '0.96', RESILIENCE_OUT: out, RESILIENCE_ONLY: 'none' },
    });
    assert.equal(run.status, 0, `an intentionally empty selection must stay a zero exit: ${(run.stdout || '') + (run.stderr || '')}`);
    assert.ok(fs.existsSync(path.join(out, 'report.md')), 'an empty selection still writes the (empty) report');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(report.scenarios, [], 'nothing was selected, so there are no rows');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a scenario error is a failed audit, and its row reaches the report (airhorn-w1wh review)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-stub-'));
  try {
    // A scenario that throws cannot be staged without a browser, so the tool takes
    // one documented stub (RESILIENCE_STUB_SCENARIO) that records exactly that row
    // and measures nothing. No browser, no server work beyond a handler.
    const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        RESILIENCE_STUB_SCENARIO: 'fail',
        RESILIENCE_TEST_MODE: '1',
        RESILIENCE_OUT: out,
        RESILIENCE_ONLY: '',
        CHROME_STEAL_OVERRIDE: '0.96',   // cannot matter: the stub never launches
      },
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.notEqual(run.status, 0,
      `a scenario that reported ERROR must not leave the process successful: ${output}`);
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(md, /\| stub — stubbed failing scenario \| ERROR \|/, 'the failing scenario must be a row in the report');
    assert.match(md, /the scenario failed on purpose/, 'the row must carry the error text, not just ERROR');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.scenarios[0].id, 'stub', 'the row must survive into report.json');
    assert.equal(report.scenarios[0].status, 'ERROR',
      'the stub row must carry the OK/ERROR status like every other row, not just an error string');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  // The rule itself, which the entry point applies: any error row fails the audit,
  // and an empty selection is the one case that stays 0.
  const saved = { out: process.env.RESILIENCE_OUT };
  process.env.RESILIENCE_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-rule-'));
  try {
    const audit = await import(pathToFileURL(RESILIENCE_TOOL).href);
    assert.equal(audit.auditExitCode([{ id: 'stub', name: 'stubbed failing scenario', error: 'boom' }]), 1,
      'an ERROR row must make the audit fail');
    assert.equal(audit.auditExitCode([{ id: 'stub', name: 'stubbed failing scenario', status: 'ERROR' }]), 1,
      'a status ERROR row fails the audit even without an error string');
    assert.equal(audit.auditExitCode([]), 0, 'nothing selected is not a failure');
    assert.equal(audit.auditExitCode([{ id: 'ok', renders: true, hornUsable: true }]), 0,
      'measured, clean rows pass');
  } finally {
    fs.rmSync(process.env.RESILIENCE_OUT, { recursive: true, force: true });
    if (saved.out === undefined) delete process.env.RESILIENCE_OUT; else process.env.RESILIENCE_OUT = saved.out;
  }
});

test('a stray RESILIENCE_STUB_SCENARIO cannot fake an audit without test mode (airhorn-w1wh review)', async () => {
  // Production entry point: the seam is honoured only under RESILIENCE_TEST_MODE=1, so
  // "RESILIENCE_STUB_SCENARIO=stale RESILIENCE_ONLY=offline" (round 4, P1) must run the
  // REAL offline scenario instead of reporting one fabricated stub row.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-stray-'));
  try {
    const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
      encoding: 'utf8',
      timeout: 180000,
      env: {
        ...process.env,
        RESILIENCE_STUB_SCENARIO: 'stale',
        RESILIENCE_TEST_MODE: '',
        RESILIENCE_ONLY: 'offline',          // the reporter's own repro
        CHROME_STEAL_OVERRIDE: '0.96',       // so this stays browser-free: the launch is refused
        RESILIENCE_OUT: out,
      },
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.match(output, /honoured only with RESILIENCE_TEST_MODE=1/, 'the ignored seam must say so');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(report.scenarios.map((r) => r.id), ['offline'],
      `the real scenario must run: a stray stub env var must not replace the audit (got ${JSON.stringify(report.scenarios.map((r) => r.id))})`);
    assert.equal(report.scenarios[0].status, 'ERROR', 'refused launch is an ERROR row, not a green one');
    assert.notEqual(run.status, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a completed audit that FOUND problems still exits 0 and reports the row (airhorn-w1wh review)', async () => {
  // The other half of the exit contract, and the half that was only in comments: a row
  // with status ERROR (could not be measured) fails the audit, while a row with status
  // OK that reports a BAD FINDING is a successful audit and exits 0. Without this, an
  // auditExitCode that failed on `renders: false` would pass every other test here.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'w1wh-audit-okfinding-'));
  try {
    const run = spawnSync(process.execPath, [RESILIENCE_TOOL], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        RESILIENCE_TEST_MODE: '1',
        RESILIENCE_STUB_SCENARIO: 'ok-finding',   // a scenario that COMPLETED and found problems
        RESILIENCE_OUT: out,
        RESILIENCE_ONLY: '',
        CHROME_STEAL_OVERRIDE: '0.96',            // irrelevant: the stub never launches
      },
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0,
      `a completed audit that found problems is a SUCCESSFUL audit - it must exit 0, not fail on the news: ${output}`);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.scenarios.length, 1, 'the finding must be recorded as a row');
    const row = report.scenarios[0];
    assert.equal(row.status, 'OK', 'a completed scenario is status OK even when everything it measured is bad');
    assert.equal(row.renders, false, 'the row must carry the bad finding itself, not drop it');
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(md, /\| stub — stubbed completed scenario with a finding \| NO \| NO \| NO \| NO \|/,
      'the report must show the finding (NO), not ERROR, for a completed scenario');
    assert.doesNotMatch(md, /stubbed completed scenario with a finding \| ERROR \|/,
      'a completed scenario must never be reported as an ERROR row');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
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

test('a CDP command that never answers is bounded and leaves nothing pending (airhorn-uhdv)', async () => {
  // The suites' send() settles only when the browser answers. When it does not - a
  // renderer wedged behind a blocked stylesheet is the observed case - the suite
  // cannot reach any of its own deadlines: resilience-ui sat in 'Case 7' for 1,092 s
  // of a 1,200 s gate and the eleven suites behind it were cancelled without
  // running. The bound turns that into one failing case.
  //
  // What is under test is the WIRING, not a callback: this drives the same
  // composition the suite's send() uses (boundCommand: pending entry + bound +
  // timer cleanup) against a real pending map, so dropping the cleanup that removes
  // the dead entry fails here - an isolated onTimeout counter would keep passing.
  const { boundCommand, CDP_COMMAND_TIMEOUT_MS } = await import(
    pathToFileURL(path.join(import.meta.dirname, 'cdp-command-bound.mjs')).href
  );

  const pending = new Map();
  const started = Date.now();
  await assert.rejects(
    () => boundCommand({ method: 'Page.navigate', pending, id: 'cmd-1', fire: () => {}, timeoutMs: 60 }),
    /CDP Page\.navigate did not answer within 60 ms/,
    'a silent command must reject, naming the method that wedged',
  );
  assert.equal(
    pending.size, 0,
    `a command that is bounded out must not leave its entry in the pending table; found ${JSON.stringify([...pending.keys()])}`,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `the bound must fire on its own timer; took ${elapsed} ms`);

  // A command that answers first settles normally, and the reply handler (the
  // suite's ws.onmessage) is what drops its entry, so nothing is left behind on
  // that path either.
  const answered = new Map();
  const value = await boundCommand({
    method: 'Runtime.evaluate',
    pending: answered,
    id: 'cmd-2',
    timeoutMs: 60,
    fire: () => {
      const entry = answered.get('cmd-2');
      answered.delete('cmd-2');
      entry.resolve('answered');
    },
  });
  assert.equal(value, 'answered', 'a command that answers must resolve with its reply, untouched by the bound');
  assert.equal(answered.size, 0, 'an answered command is dropped by its reply handler');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(Number(CDP_COMMAND_TIMEOUT_MS) > 1000, 'the shipped bound must be a generous kill window, not a budget');
});

test('opening the page socket is bounded and rejects on error or close (airhorn-2q3m)', async () => {
  // `await new Promise(r => ws.onopen = r)` is unbounded and blind to the two ways
  // an open FAILS. Nothing inside a suite exists at that point, so no deadline of
  // the suite's can fire: a socket that never opens parks the run, and one that
  // errors hangs instead of saying why. awaitSocketOpen settles once, on whichever
  // of open/error/close/the bound happens first.
  //
  // Every expectation below is bounded by `outcome()` on purpose: if a mutation
  // removes the bound or a rejection path, this test must FAIL ('hung'), not hang -
  // hanging is the defect itself, and a test that hangs in the fast gate is the
  // disease it is meant to catch.
  const { awaitSocketOpen } = await import(
    pathToFileURL(path.join(import.meta.dirname, 'cdp-command-bound.mjs')).href
  );
  const outcome = (promise) => Promise.race([
    promise.then((value) => ({ state: 'resolved', value }), (error) => ({ state: 'rejected', message: error.message })),
    new Promise((r) => setTimeout(() => r({ state: 'hung' }), 1500)),
  ]);
  const socket = () => ({
    readyState: 0,
    url: 'ws://127.0.0.1:9/devtools/page/x',
    onopen: null,
    onerror: null,
    onclose: null,
  });

  // 1. Never opens: the bound names the socket, well inside any suite bound.
  const silent = socket();
  const bounded = await outcome(awaitSocketOpen(silent, { timeoutMs: 60 }));
  assert.equal(bounded.state, 'rejected', `a socket that never opens must reject, not settle as ${bounded.state}`);
  assert.match(bounded.message, /CDP socket ws:\/\/127\.0\.0\.1:9\/devtools\/page\/x did not open within 60 ms/);
  assert.equal(silent.onopen, null, 'the handlers must be dropped once settled, not left on a dead socket');

  // 2. Errors: the reason is carried, not swallowed.
  const failing = socket();
  const erroring = outcome(awaitSocketOpen(failing, { timeoutMs: 5000 }));
  failing.onerror({ message: 'connect ECONNREFUSED' });
  const errored = await erroring;
  assert.equal(errored.state, 'rejected', `an error must reject, not settle as ${errored.state}`);
  assert.match(errored.message, /failed to open: connect ECONNREFUSED/);

  // 3. Closes before it opens.
  const closing = socket();
  const closingOutcome = outcome(awaitSocketOpen(closing, { timeoutMs: 5000 }));
  closing.onclose({ code: 1006 });
  const closed = await closingOutcome;
  assert.equal(closed.state, 'rejected', `a close before open must reject, not settle as ${closed.state}`);
  assert.match(closed.message, /closed before it opened \(code 1006\)/);

  // 4. Opens: resolves, and nothing settles afterwards - a rejection arriving after
  //    the suite moved on would surface much later as an unhandled rejection.
  const opening = socket();
  const opened = outcome(awaitSocketOpen(opening, { timeoutMs: 60 }));
  opening.onopen();
  const openOutcome = await opened;
  assert.equal(openOutcome.state, 'resolved', `an open must resolve, not settle as ${openOutcome.state}`);
  assert.equal(opening.onopen, null, 'a settled open must drop its handlers, so a late event cannot settle it again');
  // 5. An error that arrives AFTER the helper has started waiting must reject the
  //    wait, naming the socket - a helper that swallowed the error or resolved
  //    anyway would pass a suite that never connected.
  const erring = socket();
  const errWait = awaitSocketOpen(erring, { timeoutMs: 5000 });
  erring.onerror({ message: 'late' });
  await assert.rejects(errWait, /CDP socket ws:\/\/127\.0\.0\.1:9\/devtools\/page\/x failed to open: late/);

  // 6. An error that arrived BEFORE the wait leaves a dead socket: no open event is
  //    coming, so the bound must reject and name the socket, never resolve.
  const dead = socket();
  dead.readyState = 3;
  await assert.rejects(
    awaitSocketOpen(dead, { timeoutMs: 60 }),
    /CDP socket ws:\/\/127\.0\.0\.1:9\/devtools\/page\/x did not open within 60 ms/
  );

  // 7. Already open: resolves without waiting for an event that will never come.
  const already = await outcome(awaitSocketOpen({ readyState: 1 }));
  assert.equal(already.state, 'resolved', `an already-open socket must resolve, not settle as ${already.state}`);
});

test('waitForQuiescence attributes its timeout to the real cause, never to work that is not pending (airhorn-kqz1)', async () => {
  // Measured on a 60-97% steal host: the loop sampled 3 times in 20s, the
  // last sample was quiet by the function's own definition, and the timeout
  // throw still said 'work is still pending' - sending the operator hunting
  // for app work that did not exist. A stub `send` drives the loop with no
  // browser: each case below is the LAST-sample shape at deadline.
  const { waitForQuiescence } = await import('./support/quiescence.mjs');
  const sample = (over = {}) => ({
    probe: 'present', pendingTimers: 0, pendingIntervals: 0, pendingFetches: 0,
    scheduled: 3, completed: 3, quietCondition: true, ...over,
  });
  const sendOf = (s) => async () => ({ result: { value: { ...s } } });

  // 1. Quiet at the deadline, stability window never completed: the message
  //    must name the STABILITY window (flap or a starved host), and must NOT
  //    blame pending work. stableSamples is set unreachable on purpose.
  await assert.rejects(
    waitForQuiescence(sendOf(sample()), { timeoutMs: 200, pollMs: 40, stableSamples: 1000, stateTimeoutMs: 0 }),
    (err) => {
      assert.match(err.message, /never stayed quiet for 1000 consecutive samples/,
        `a quiet last sample must blame the stability window: ${err.message}`);
      assert.match(err.message, /STABILITY window, not the page/);
      assert.doesNotMatch(err.message, /work is still pending/,
        `nothing was pending - the message must not invent pending work: ${err.message}`);
      return true;
    },
  );

  // 2. Work genuinely pending at the deadline: the pending-work message is
  //    the honest one and must survive.
  await assert.rejects(
    waitForQuiescence(sendOf(sample({ pendingTimers: 1, quietCondition: false })), { timeoutMs: 200, pollMs: 40, stateTimeoutMs: 0 }),
    /work is still pending/,
  );

  // 3. Drained but the quiet condition false, with the in-loop early throw
  //    disabled (stateTimeoutMs: 0): the deadline message must blame the app
  //    STATE, not pending work.
  await assert.rejects(
    waitForQuiescence(sendOf(sample({ quietCondition: false })), { timeoutMs: 200, pollMs: 40, stateTimeoutMs: 0, quietExpression: 'false' }),
    (err) => {
      assert.match(err.message, /app state that never reached its end condition/, err.message);
      assert.doesNotMatch(err.message, /work is still pending/, err.message);
      return true;
    },
  );
});
