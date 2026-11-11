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

/* --- the build side of the worker's integrity manifest (airhorn-oybq) --------- */

test('sw-integrity: the manifest maps served paths to the bytes the build emitted (airhorn-oybq)', async () => {
  const { digestsFor, injectIntegrity, servedPathFor, INTEGRITY_PLACEHOLDER } = await import(
    `${pathToFileURL(path.join(import.meta.dirname, '..', 'tools', 'lib', 'sw-integrity.mjs')).href}?oybq=${Date.now()}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oybq-dist-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), 'root document');
    fs.mkdirSync(path.join(dir, 'styles'));
    fs.writeFileSync(path.join(dir, 'styles', 'main.css'), 'css bytes');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'bundle');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'the worker itself');

    const digests = digestsFor(dir);
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    assert.equal(servedPathFor('index.html'), '/', 'the root document is served as /, not /index.html');
    assert.equal(servedPathFor(path.join('assets', 'app-abc123.js')), '/assets/app-abc123.js', 'nested files keep their path');
    assert.equal(digests['/'], sha('root document'), 'the root digest is the digest of index.html');
    // airhorn-lu8a: the worker precaches BOTH shell spellings, so the manifest must carry both or the non-canonical one
    // silently degrades to trust-on-first-use.
    assert.equal(digests['/index.html'], sha('root document'), 'the second shell spelling is bound to the same bytes');
    assert.equal(digests['/styles/main.css'], sha('css bytes'));
    assert.equal(digests['/assets/app-abc123.js'], sha('bundle'), 'hashed assets are bound too - they are precached dynamically');
    assert.equal(digests['/sw.js'], undefined, 'sw.js cannot digest itself');

    // The injection replaces EVERY occurrence and leaves a parseable worker in both directions: built, and unbuilt.
    const built = injectIntegrity('const d = (typeof __PRECACHE_INTEGRITY__ === \'object\') ? __PRECACHE_INTEGRITY__ : {};', { '/a': 'x' });
    assert.doesNotMatch(built, /__PRECACHE_INTEGRITY__/, 'no placeholder may survive into the built worker');
    assert.match(built, /typeof \{"\/a":"x"\} ===/, 'the literal replaces the identifier in both places');
    assert.equal(injectIntegrity('const d = {};', { '/a': 'x' }), 'const d = {};', 'a source with no placeholder is untouched');
    assert.doesNotMatch(injectIntegrity(`const d = ${INTEGRITY_PLACEHOLDER};`, {}), /undefined/,
      'an EMPTY map injects {} rather than the word undefined');
    // An empty output dir is valid (no files yet) and yields an empty map, not a crash.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oybq-empty-'));
    try { assert.deepEqual(digestsFor(empty), {}); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CHROME_MJS = path.join(import.meta.dirname, '..', 'tools', 'lib', 'chrome.mjs');
const INSTALL_TOOL = path.join(import.meta.dirname, '..', 'tools', 'install-https-proof.mjs');
const httpsProofProfiles = () => fs.readdirSync(os.tmpdir())
  .filter((name) => /^chrome-https-proof-(?:tmp-)?[A-Za-z0-9]{6}$/.test(name));

test('install-https-proof asserts the Install button, not just the prompt (airhorn-nxuv.10)', async () => {
  // The assertion-honesty sweep's claim was that the HTTP contrast asserted only
  // '!installPrompt.fired', so a button ENABLED over insecure HTTP landed green. The
  // assertions now live in an exported function; without a test of its own a future edit
  // could drop the button half and nothing would notice. Semantics come from
  // src/install.js: disabled=true and no 'available' class until beforeinstallprompt fires.
  const { assertInstallEvidence, affordanceProblem } = await import(`${pathToFileURL(INSTALL_TOOL).href}?nxuv11=${Date.now()}`);
  // The evidence a real run collects now: the BUTTON's own computed display/visibility/pointer-events and its rect
  // (airhorn-nxuv.11). It used to be the wrapper's two style properties, which passed for a button that was never
  // painted at all.
  const button = (over = {}) => ({
    disabled: false, hasAvailableClass: true, display: 'block', visibility: 'visible',
    pointerEvents: 'auto', rect: { width: 120, height: 40 }, ...over,
  });
  const httpEv = (over = {}) => ({ installPrompt: { fired: false }, installButton: button({ disabled: true, hasAvailableClass: false, ...over }) });
  const httpsEv = (over = {}) => ({ installPrompt: { fired: true }, installButton: button(over) });

  assert.doesNotThrow(() => assertInstallEvidence(httpEv(), httpsEv()), 'the honest pair must pass');
  assert.throws(() => assertInstallEvidence(httpEv({ disabled: false }), httpsEv()),
    /USABLE over insecure HTTP/, 'an enabled Install button over HTTP is the defect the sweep named');
  assert.throws(() => assertInstallEvidence(httpEv({ disabled: false, hasAvailableClass: true }), httpsEv()),
    /USABLE over insecure HTTP/, 'and the available class makes it worse, not better');
  assert.throws(() => assertInstallEvidence(httpEv({ disabled: null }), httpsEv()),
    /unmeasurable over HTTP/, 'an unmeasurable button cannot prove the contrast');
  // airhorn-61m1: every verdict clause in assertInstallEvidence needs a world, or a one-line edit can delete one
  // and leave the gate green. These two are the branches that had none: the HTTP leg's "evidence incomplete"
  // guard (it must collect the same properties as the HTTPS leg, or the contrast compares different questions)
  // and the HTTP polarity's second half.
  assert.throws(() => assertInstallEvidence(httpEv({ display: undefined }), httpsEv()),
    /evidence over HTTP is incomplete/, 'an HTTP leg that did not collect display/rect compared less than the HTTPS leg');
  assert.throws(() => assertInstallEvidence(httpEv({ rect: undefined }), httpsEv()),
    /evidence over HTTP is incomplete/, 'and the same when the box was not measured at all');
  assert.throws(() => assertInstallEvidence(httpEv({ disabled: true, hasAvailableClass: true }), httpsEv()),
    /USABLE over insecure HTTP/, 'the available class alone is still an exposed affordance over HTTP');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ visibility: 'hidden' })),
    /not clickable\/visible/, 'an enabled but invisible button is not an affordance');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ pointerEvents: 'none' })),
    /not clickable\/visible/, 'nor is an unclickable one');

  // airhorn-nxuv.11: the four ways a present button is not an affordance. The first two PASSED before this change,
  // because the old check read the wrapper's `visibility` - which stays 'visible' under display:none - and never looked
  // at the box at all. Each must fail BY NAME, so a future reader can tell which property was wrong.
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ display: 'none' })),
    /display is none, so nothing is painted/, 'a display:none button is not painted, whatever its visibility says');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ rect: { width: 0, height: 40 } })),
    /no painted box .*zero pixels cannot be clicked/, 'a zero-width button cannot be clicked');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ rect: { width: 120, height: 0 } })),
    /no painted box/, 'nor a zero-height one');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ rect: undefined })),
    /no painted box/, 'nor an unmeasured one - unknown is not a pass');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ visibility: 'hidden' })),
    /visibility is hidden/);
  // The shared check is exported so both legs cannot drift: a wrapper-level reading cannot sneak back in unnoticed.
  assert.equal(affordanceProblem(button()), null, 'a visible, painted, clickable button has no problem');
  assert.match(affordanceProblem(button({ pointerEvents: 'none' })), /pointer-events is none/);
  assert.equal(affordanceProblem(button({ display: 'inline' })), null,
    'a non-block display is not itself a problem: an inline-block button with a real rect is clickable');
  assert.match(affordanceProblem(button({ display: 'inline', rect: { width: 0, height: 0 } })), /no painted box/,
    'the RECT is what decides paintability, not the display keyword');
  assert.throws(() => assertInstallEvidence({ installPrompt: { fired: true }, installButton: httpEv().installButton }, httpsEv()),
    /the contrast is invalid/, 'if the prompt fired over HTTP the contrast measured nothing');

  // airhorn-kmvu: the HTTPS half needs its own worlds. No pair above has a disabled or class-less HTTPS button, so
  // deleting the throw at tools/install-https-proof.mjs:475 left this test green - a pin that cannot go red for the
  // half it exists to protect. These three fail BY NAME through that exact branch.
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ disabled: true })),
    /Install button not enabled over HTTPS/, 'a disabled Install button over HTTPS is the state beforeinstallprompt should have cleared');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ hasAvailableClass: false })),
    /Install button not enabled over HTTPS/, 'and so is an enabled button without the available class - src/install.js sets both together');
  assert.throws(() => assertInstallEvidence(httpEv(), httpsEv({ disabled: null })),
    /unmeasurable over HTTPS/, 'an unreadable HTTPS button cannot prove the affordance either');
});

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

test('owner markers: a live-owned dir is kept, a dead owner is reaped, an unreadable marker reads live (airhorn-nxuv.31)', async () => {
  // The cert/server temp dir is never named on any command line, so the
  // cmdline premise cannot protect it; the owner marker is the only liveness
  // evidence. A stand-in that is ALIVE but names nothing is exactly the
  // running-server case the sweep used to delete.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `reapowner-${process.pid}-`));
  const liveOwned = path.join(tmpdir, 'chrome-https-proof-tmp-live01');
  const deadOwned = path.join(tmpdir, 'chrome-https-proof-tmp-dead99');
  const mangled = path.join(tmpdir, 'chrome-https-proof-tmp-mangle');
  const wrongType = path.join(tmpdir, 'chrome-https-proof-tmp-wrongt');
  const legacy = path.join(tmpdir, 'chrome-https-proof-tmp-legac1');
  for (const dir of [liveOwned, deadOwned, mangled, wrongType, legacy]) fs.mkdirSync(dir);
  const { sweepStaleProfiles, processStartTime } = await import(REAP);
  const standIn = spawnStandIn([]); // alive, names NOTHING - the cert-dir case
  try {
    await new Promise((r) => setTimeout(r, 300)); // let the stand-in exec
    // Live owner: marker names the stand-in's pid WITH its real start time
    // (the pid-reuse key).
    fs.writeFileSync(path.join(liveOwned, '.airhorn-owner'),
      JSON.stringify({ pid: standIn.pid, started: processStartTime(standIn.pid) }));
    // Dead owner: a process that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(path.join(deadOwned, '.airhorn-owner'),
      JSON.stringify({ pid: dead.pid, started: null }));
    // Unreadable marker: present but not parseable - must read as LIVE.
    fs.writeFileSync(path.join(mangled, '.airhorn-owner'), 'not json{');
    // Parseable but wrong-typed (airhorn-3lx5): a STRING started field cannot
    // be compared, so it must read live like any untrustworthy marker -
    // a strict string-vs-number compare used to read it as STALE (reapable).
    fs.writeFileSync(path.join(wrongType, '.airhorn-owner'),
      JSON.stringify({ pid: standIn.pid, started: String(processStartTime(standIn.pid)) }));
    // Age the dirs AFTER the marker writes: creating the marker file bumps
    // the dir's mtime, which would otherwise read as inside the launch window.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    for (const dir of [liveOwned, deadOwned, mangled, wrongType, legacy]) fs.utimesSync(dir, old, old);
    const result = sweepStaleProfiles('chrome-https-proof-', { tmpdir });
    assert.deepEqual([...result.swept].sort(), ['chrome-https-proof-tmp-dead99', 'chrome-https-proof-tmp-legac1'],
      `only the dead-owned and legacy dirs may be swept: ${JSON.stringify(result)}`);
    assert.ok(fs.existsSync(liveOwned), 'a dir owned by a live pid must be left alone');
    assert.ok(fs.existsSync(mangled), 'an unreadable marker must read as live, never as stale');
    assert.ok(fs.existsSync(wrongType), 'a wrong-typed started field must read as live, never as stale (airhorn-3lx5)');
    assert.ok(!fs.existsSync(deadOwned), 'a dir whose owner pid is gone must be reaped');
    assert.ok(!fs.existsSync(legacy), 'a markerless legacy dir must still be reaped');
    const why = Object.fromEntries(result.kept.map((k) => [k.dir, k.why]));
    assert.match(why['chrome-https-proof-tmp-live01'] ?? '', /owned by live pid/);
    assert.match(why['chrome-https-proof-tmp-mangle'] ?? '', /treated as live/);
    assert.match(why['chrome-https-proof-tmp-wrongt'] ?? '', /started is not a number - treated as live/);
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

/*
 * tools/lib/perf-metrics.mjs: a performance report is evidence only for what it actually
 * measured. tools/measure-perf.mjs printed "LCP: None (0 entries recorded)" and exited 0,
 * so a CWV report could be quoted for a field it never measured (airhorn-lmlu). The
 * judgement is a pure function so it can be tested without a browser or a starved host.
 */
test('perf-metrics: an absent LCP is unmeasured, and the run says so instead of exiting 0', async () => {
  const { isMeasured, measurementExitCode, unmeasured } = await import('../tools/lib/perf-metrics.mjs');

  // Zero and null are both "no measurement": an LCP of 0 ms is an absent entry, not a
  // fast page, which is exactly the shape the starved host produced.
  assert.equal(isMeasured(null), false);
  assert.equal(isMeasured(0), false);
  assert.equal(isMeasured(undefined), false);
  assert.equal(isMeasured(Number.NaN), false);
  assert.equal(isMeasured(8204), true);

  const measuredRun = [
    { label: 'cold load', metrics: { lcp: 820, lcpEntriesCount: 1, cls: 0, rawEvents: [] } },
    { label: 'repeat load', metrics: { lcp: 610, lcpEntriesCount: 1, cls: 0, rawEvents: [] } },
  ];
  assert.deepEqual(unmeasured(measuredRun), [], 'a fully measured run reports nothing');
  assert.equal(measurementExitCode(unmeasured(measuredRun)), 0);

  const starvedRun = [
    { label: 'cold load', metrics: { lcp: null, lcpEntriesCount: 0, cls: 0, rawEvents: [] } },
    { label: 'repeat load', metrics: { lcp: null, lcpEntriesCount: 0, cls: 0, rawEvents: [] } },
  ];
  const findings = unmeasured(starvedRun);
  assert.equal(findings.length, 2, 'one finding per load, so an operator can see which run failed to paint');
  assert.match(findings[0], /cold load: LCP was not measured \(0 entries recorded\)/);
  assert.equal(measurementExitCode(findings), 2, 'unmeasured exits 2 - distinct from 1, which means the harness crashed');

  // CLS of 0 is a real measurement (a page with no layout shift), not an absent one.
  const noShift = [{ label: 'cold load', metrics: { lcp: 800, lcpEntriesCount: 1, cls: 0, rawEvents: [] } }];
  assert.deepEqual(unmeasured(noShift), []);

  // A missing metrics object and a missing event buffer are named, never thrown on.
  const broken = unmeasured([
    { label: 'cold load', metrics: null },
    { label: 'repeat load', metrics: { lcp: 500, lcpEntriesCount: 1, cls: 0 } },
  ]);
  assert.match(broken.join(' | '), /cold load: no metrics object/);
  assert.match(broken.join(' | '), /repeat load: the interaction events for INP were not collected/);
  assert.equal(measurementExitCode(undefined), 0);
});

/*
 * tools/lib/request-path.mjs: the tools serve dist/ on loopback and each one turned req.url
 * into a file path by hand. Two embargoed factory findings came from that — an unguarded
 * decodeURIComponent (URIError kills the run mid-measurement) and an unchecked path.join
 * ('..' walked out of the root) — so the decisions are pure functions here, testable with
 * no browser, and every refusal carries a reason an operator can read.
 */
test('request-path: a malformed percent-escape is a 400 naming the URL, not a URIError', async () => {
  const { decodeRequestPath, resolveRequestUrl } = await import('../tools/lib/request-path.mjs');
  const root = path.join(os.tmpdir(), 'request-path-root');

  const bad = resolveRequestUrl(root, '/%zz/assets/app.js');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400, 'a path that cannot be decoded is a client error, not a crash');
  assert.match(bad.reason, /bad percent-escape in the request URL "\/%zz\/assets\/app\.js"/);
  assert.match(bad.reason, /refused instead of throwing/);

  // The old shape: decodeURIComponent throws and takes the whole run with it.
  assert.throws(() => decodeURIComponent('/%zz/assets/app.js'), /URIError|URI malformed/,
    'the thing being guarded really does throw - this is not a hypothetical');

  const good = decodeRequestPath('/assets/app.js?v=2');
  assert.deepEqual(good, { ok: true, pathname: '/assets/app.js' }, 'the query is dropped, not decoded into the path');
  assert.equal(decodeRequestPath(undefined).pathname, '/', 'a missing url is the root');
});

test('request-path: a path that escapes the served root is a 403 naming what was refused', async () => {
  const { resolveWithinRoot, resolveRequestUrl } = await import('../tools/lib/request-path.mjs');
  // A real root on disk: containment is decided on REAL paths now, so the fixture has to
  // exist (that is the point of the check, not an inconvenience).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'request-path-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), 'index');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'app');
  try {

  const escaped = resolveRequestUrl(root, '/../../etc/passwd');
  assert.equal(escaped.ok, false);
  assert.equal(escaped.status, 403);
  assert.match(escaped.reason, /refusing to serve "\/\.\.\/\.\.\/etc\/passwd"/);
  assert.match(escaped.reason, /outside the served root/);

  // Encoded traversal decodes first and is refused for the same reason - this is the shape
  // idle-cost and measure-perf had (they never decoded at all).
  const encoded = resolveRequestUrl(root, '/%2e%2e/%2e%2e/etc/passwd');
  assert.equal(encoded.ok, false, 'percent-encoded .. must not be a way around the check');
  assert.equal(encoded.status, 403);

  // A sibling directory sharing a string prefix with the root must not pass: the check is a
  // path prefix with a separator, not a startsWith on the raw string.
  const sibling = resolveWithinRoot(root, '/../request-path-root-evil/x');
  assert.equal(sibling.ok, false);

  // The ordinary cases still resolve, inside the root, with the query already gone.
  const index = resolveRequestUrl(root, '/');
  assert.equal(index.ok, true);
  assert.equal(index.filePath, path.join(root, 'index.html'));
  assert.equal(index.pathname, '/', 'soak matches /sw.js on the decoded path before reading anything');
  const asset = resolveRequestUrl(root, '/assets/app.js?x=1');
  assert.equal(asset.ok, true);
  assert.equal(asset.filePath, path.join(root, 'assets', 'app.js'));
  const dotted = resolveWithinRoot(root, '/assets/./app.js');
  assert.equal(dotted.ok, true, 'a harmless dot segment is not a refusal');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('request-path: every tool serves through the shared guard, none keeps its own decode/join', async () => {
  // The helper being correct is not the fix - the TOOLS calling it is. This pins the wiring
  // so a future edit cannot quietly reintroduce the bare decode (which throws) or the bare
  // path.join (which follows '..') in one tool while the shared helper stays green.
  const toolsDir = path.join(import.meta.dirname, '..', 'tools');
  // DERIVED, not a snapshot (airhorn-0s4v): the list used to name four tools by hand, and the
  // five that were left out (plus this module) kept the bare decode and the string-prefix
  // containment for two more landings. Every file that opens an http server is in scope, so a
  // NEW tool cannot arrive uncovered and no existing one can silently leave the guard.
  const served = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/createServer\s*\(/.test(source)) served.push([path.relative(toolsDir, full), source]);
    }
  };
  walk(toolsDir);
  assert.ok(served.length >= 10,
    `the derived scan must still find the tool servers it guards, found ${JSON.stringify(served.map(([n]) => n))}`);
  for (const [name, source] of served) {
    // openRequestUrl, not resolveRequestUrl: the guard must OPEN the file and decide on the
    // handle (airhorn-dklf), so pinning the opening call is what keeps the TOCTOU window shut
    // in every tool rather than only in the helper.
    assert.match(source, /(openRequestUrl|openWithinRoot)\(/,
      `${name} must OPEN and verify its request path through tools/lib/request-path.mjs, not resolve it and open the name later`);
    assert.doesNotMatch(source, /decodeURIComponent\(/,
      `${name} must not decode a request URL itself - an unguarded decode throws URIError and kills the run`);
    assert.doesNotMatch(source, /path\.join\((DIST|distDir),\s*(req\.url|requestPath|reqUrl)/,
      `${name} must not join a request path onto the served root without a containment check`);
  }
});

test('request-path: the install-proof server answers a malformed escape with 400 and a traversal with 403 (real socket)', async () => {
  // Behaviour, not source: a real http server from the shipped module, driven over a real
  // socket. Before the fix the first request threw URIError out of the handler and killed
  // the run; the second was never checked at all in idle-cost/measure-perf.
  const { makeServer } = await import('../tools/install-https-proof.mjs');
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-path-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>ok');
  const server = await makeServer(distDir, null);
  try {
    const port = server.address().port;
    // node:http with an explicit `path`, not fetch: a WHATWG URL parser normalises dot
    // segments (%2e%2e included) before the request leaves, so a traversal cannot be sent
    // through fetch at all. The raw path is what an attacker controls, so it is what the
    // handler must be shown.
    const get = (requestPath) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

    const ok = await get('/');
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '<!doctype html>ok');

    const badEscape = await get('/%zz/app.js');
    assert.equal(badEscape.status, 400, 'a malformed escape is a client error, not a crash');
    assert.match(badEscape.body, /bad percent-escape in the request URL "\/%zz\/app\.js"/);

    // The dots are ENCODED on purpose: an HTTP client normalises a literal '/../..' before
    // it ever reaches the wire (that request arrives as '/etc/passwd', which is inside the
    // root and simply 404s). %2e%2e is what actually crosses the socket, and it is the shape
    // idle-cost and measure-perf never even decoded.
    const traversal = await get('/%2e%2e/%2e%2e/etc/passwd');
    assert.equal(traversal.status, 403, 'a path outside dist/ must never be served');
    assert.match(traversal.body, /refusing to serve/);
    assert.match(traversal.body, /outside the served root/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

/*
 * airhorn-k77v: the SIBLING world, end to end. A root of /tmp/x and a directory /tmp/xyz share the string prefix
 * "/tmp/x", so a containment check written as `candidate.startsWith(root)` (what the install-proof handler and the
 * soak guard both did before the shared request-path helper) treated the sibling as inside the root: at 4f3fcfb the
 * shipped handler answered /../xyz/secret.txt with 200 and the sibling's bytes. The helper checks the prefix WITH a
 * separator and then decides on the OPENED handle, so both tools refuse - this test drives the shipped server over a
 * real socket, which is the only level the original defect was visible at, and asserts the same paths through the
 * helper soak calls.
 *
 * It also pins the two ways a fix like this fails in the other direction: a legitimate nested in-root path must still
 * serve, and a symlink that lives in the root but points AT the sibling must be refused rather than followed.
 */
test('request-path: a SIBLING directory sharing the root prefix is refused, and an in-root subdirectory still serves (airhorn-k77v)', async () => {
  const { makeServer } = await import('../tools/install-https-proof.mjs');
  const { openRequestUrl } = await import('../tools/lib/request-path.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k77v-sibling-'));
  const rootDir = path.join(base, 'x');
  const siblingDir = path.join(base, 'xyz');
  fs.mkdirSync(path.join(rootDir, 'nested', 'deep'), { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'index.html'), '<!doctype html>in-root');
  fs.writeFileSync(path.join(rootDir, 'nested', 'deep', 'asset.txt'), 'IN_ROOT_NESTED');
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'SIBLING_SECRET');
  fs.symlinkSync(siblingDir, path.join(rootDir, 'escape'));
  const server = await makeServer(rootDir, null);
  try {
    const port = server.address().port;
    const get = (requestPath) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

    // The two spellings of the sibling walk, both of which a bare prefix check accepts.
    for (const requestPath of ['/../xyz/secret.txt', '/%2e%2e/xyz/secret.txt']) {
      const sibling = await get(requestPath);
      assert.equal(sibling.status, 403, `${requestPath} must be refused, not served: ${sibling.status} ${sibling.body}`);
      assert.doesNotMatch(sibling.body, /SIBLING_SECRET/, `${requestPath} leaked the sibling directory's bytes`);
      assert.match(sibling.body, /refusing to serve|outside the served root/);
    }
    // A symlink in the root that points AT the sibling: lexically inside, really outside.
    const viaLink = await get('/escape/secret.txt');
    assert.equal(viaLink.status, 403, `a symlink to the sibling must be refused: ${viaLink.status} ${viaLink.body}`);
    assert.doesNotMatch(viaLink.body, /SIBLING_SECRET/);

    // The other direction: refusing everything is not a fix.
    const index = await get('/');
    assert.equal(index.status, 200, 'the root index must still serve');
    assert.equal(index.body, '<!doctype html>in-root');
    const nested = await get('/nested/deep/asset.txt');
    assert.equal(nested.status, 200, 'a legitimate nested path must still serve');
    assert.equal(nested.body, 'IN_ROOT_NESTED');

    // soak's guard is the same helper, driven with the same inputs (soak never builds a server here).
    for (const requestPath of ['/../xyz/secret.txt', '/%2e%2e/xyz/secret.txt', '/escape/secret.txt']) {
      const decision = openRequestUrl(rootDir, requestPath);
      assert.equal(decision.ok, false, `soak's guard must refuse ${requestPath} too`);
      assert.equal(decision.status, 403);
      assert.match(decision.reason, /refusing to serve|not found/);
    }
    const soakNested = openRequestUrl(rootDir, '/nested/deep/asset.txt');
    assert.equal(soakNested.ok, true, "soak's guard must still serve an in-root nested path");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/*
 * The reviewer's own reproduction of the containment hole (airhorn-k0xp review FAIL): a
 * symlink INSIDE dist that points OUTSIDE it. A lexical containment check approves
 * '/linked.txt' because the request path is inside the root; the bytes came from outside.
 * Containment is now decided on realpath, and an unresolvable target fails CLOSED.
 */
test('request-path: a symlink inside the root that points outside it is REFUSED, not followed', async () => {
  const { resolveRequestUrl } = await import('../tools/lib/request-path.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'request-path-link-'));
  const root = path.join(base, 'dist');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'index.html'), 'index');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'INSIDE_ROOT_MARKER');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_ROOT_MARKER');
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
    fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'inside-link.txt'));
    fs.symlinkSync(path.join(outside), path.join(root, 'out-dir'));
    fs.symlinkSync(path.join(root, 'loop-b.txt'), path.join(root, 'loop-a.txt'));
    fs.symlinkSync(path.join(root, 'loop-a.txt'), path.join(root, 'loop-b.txt'));
    fs.symlinkSync(path.join(outside, 'not-there.txt'), path.join(root, 'dangling.txt'));

    // 1. The hole: lexically inside, really outside.
    const escaped = resolveRequestUrl(root, '/linked.txt');
    assert.equal(escaped.ok, false, 'a symlink inside the root must not be a way out of it');
    assert.equal(escaped.status, 403);
    assert.match(escaped.reason, /resolves through a symlink to .*secret\.txt, which is outside the served root/);

    // 2. A symlink that stays inside is still served, and the caller gets the real path.
    const insideLink = resolveRequestUrl(root, '/inside-link.txt');
    assert.equal(insideLink.ok, true, 'a symlink to a file inside the root is not a defect');
    assert.equal(insideLink.filePath, fs.realpathSync(path.join(root, 'inside.txt')));

    // 3. A symlink to a DIRECTORY outside the root cannot serve that directory or its index.
    const outDir = resolveRequestUrl(root, '/out-dir/secret.txt');
    assert.equal(outDir.ok, false);
    assert.equal(outDir.status, 403);
    assert.match(outDir.reason, /outside the served root/);

    // 4. A loop fails AS ITSELF (ELOOP), not as "not found".
    const loop = resolveRequestUrl(root, '/loop-a.txt');
    assert.equal(loop.ok, false);
    assert.equal(loop.status, 403);
    assert.match(loop.reason, /symlink loop \(ELOOP\)/);

    // 5. A dangling symlink fails closed with a named 404 - never a lexical guess.
    const dangling = resolveRequestUrl(root, '/dangling.txt');
    assert.equal(dangling.ok, false);
    assert.equal(dangling.status, 404);
    assert.match(dangling.reason, /no real path to verify/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('request-path: the served matrix over a real socket — 200, 400, 403 (traversal and symlink), ELOOP', async () => {
  const { makeServer } = await import('../tools/install-https-proof.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'request-path-matrix-'));
  const distDir = path.join(base, 'dist');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(distDir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>ok');
  fs.writeFileSync(path.join(distDir, 'inside.txt'), 'INSIDE_ROOT_MARKER');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_ROOT_MARKER');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(distDir, 'linked.txt'));
  fs.symlinkSync(path.join(distDir, 'inside.txt'), path.join(distDir, 'inside-link.txt'));
  const server = await makeServer(distDir, null);
  try {
    const port = server.address().port;
    const get = (requestPath) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

    const index = await get('/');
    assert.equal(index.status, 200);
    assert.equal(index.body, '<!doctype html>ok');

    const direct = await get('/inside.txt');
    assert.equal(direct.status, 200);
    assert.equal(direct.body, 'INSIDE_ROOT_MARKER');

    const insideLink = await get('/inside-link.txt');
    assert.equal(insideLink.status, 200, 'a symlink to a file inside the root still serves');
    assert.equal(insideLink.body, 'INSIDE_ROOT_MARKER');

    const badEscape = await get('/%zz/app.js');
    assert.equal(badEscape.status, 400);
    assert.match(badEscape.body, /bad percent-escape/);

    const traversal = await get('/%2e%2e/%2e%2e/etc/passwd');
    assert.equal(traversal.status, 403);
    assert.match(traversal.body, /outside the served root/);

    // THE REVIEWER'S REPRODUCTION: before this fix this returned 200 with OUTSIDE_ROOT_MARKER.
    const linked = await get('/linked.txt');
    assert.equal(linked.status, 403, 'a symlink inside dist must never serve a file outside it');
    assert.doesNotMatch(linked.body, /OUTSIDE_ROOT_MARKER/, 'the outside bytes must not reach the caller');
    assert.match(linked.body, /resolves through a symlink to .*secret\.txt/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('request-path: containment is decided on the OPENED handle, so the dklf swap window is closed by construction', async () => {
  // airhorn-dklf: resolve-then-open leaves an interval in which the name can be re-pointed at
  // a file outside the root. That interval is not a timing artefact to be caught by luck - it
  // is the difference between deciding on a NAME and deciding on a HANDLE, so both halves are
  // shown deterministically here rather than raced.
  const { openWithinRoot, resolveWithinRoot } = await import('../tools/lib/request-path.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dklf-'));
  const root = path.join(base, 'dist');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), 'INDEX');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'INSIDE_MARKER');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_MARKER');
  const link = path.join(root, 'page.txt');
  fs.symlinkSync(path.join(root, 'inside.txt'), link);
  try {
    // (a) The OLD ordering: verify a name, then open the SAME NAME later. The verification
    //     passes, the name is re-pointed, and the read follows the new target - the window
    //     airhorn-dklf named, shown without needing to win a race.
    const verified = resolveWithinRoot(root, '/page.txt');
    assert.equal(verified.ok, true, verified.reason);
    assert.equal(verified.filePath, fs.realpathSync(path.join(root, 'inside.txt')), 'the verification passed on a file inside the root');
    const nameTheOldHandlerWouldOpen = path.join(root, 'page.txt');
    assert.equal(fs.readFileSync(nameTheOldHandlerWouldOpen, 'utf8'), 'INSIDE_MARKER', 'the name resolves inside the root first');
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    assert.equal(fs.readFileSync(nameTheOldHandlerWouldOpen, 'utf8'), 'OUTSIDE_MARKER',
      'this is exactly the window airhorn-dklf named: a verified NAME re-pointed before the open');

    // (b) The shipped ordering: open first, verify the HANDLE. Re-point the name after the
    //     open and the bytes are still the verified file's, because the read uses the fd.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, 'inside.txt'), link);
    const opened = openWithinRoot(root, '/page.txt');
    assert.equal(opened.ok, true, opened.reason);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    const viaHandle = fs.readFileSync(`/proc/self/fd/${opened.fd}`, 'utf8');
    fs.closeSync(opened.fd);
    assert.equal(viaHandle, 'INSIDE_MARKER',
      'the response reads the descriptor that was VERIFIED, so re-pointing the name afterwards cannot redirect it');

    // (c) THE WINDOW ITSELF, closed: the probe re-points the name in the exact interval the
    //     old ordering left open (after the name was verified, before it was opened). A design
    //     that decides on the name returns ok here; the shipped design opens first and refuses,
    //     because the handle it got lives outside the root.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, 'inside.txt'), link);
    const raced = openWithinRoot(root, '/page.txt', {
      afterResolve: (resolvedPath) => {
        // The attacker's move mid-interval, with no timing luck involved: the RESOLVED path
        // itself is replaced by a symlink to a file outside the root. A design that trusts the
        // verified name then opens straight through it; the shipped design opens first and
        // asks the handle where it lives.
        fs.unlinkSync(resolvedPath);
        fs.symlinkSync(path.join(outside, 'secret.txt'), resolvedPath);
      },
    });
    assert.equal(raced.ok, false, 'a file swapped in during the resolve->open interval must be REFUSED, not served');
    assert.equal(raced.status, 403);
    assert.match(raced.reason, /the OPENED file lives at .*outside\/secret\.txt, which is outside the served root/);

    // The tree is now compromised at the resolved path; restore it for the rest of the test.
    fs.unlinkSync(path.join(root, 'inside.txt'));
    fs.writeFileSync(path.join(root, 'inside.txt'), 'INSIDE_MARKER');

    // (d) A request for a name that points outside is refused outright - the ordinary
    //     symlink case, unchanged by the reordering.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    const after = openWithinRoot(root, '/page.txt');
    assert.equal(after.ok, false);
    assert.equal(after.status, 403);
    assert.match(after.reason, /outside the served root/);

    // (e) Ordinary serving is unchanged: the 200/403/404 matrix still holds.
    const ok = openWithinRoot(root, '/');
    assert.equal(ok.ok, true);
    assert.equal(ok.realPath, fs.realpathSync(path.join(root, 'index.html')));
    fs.closeSync(ok.fd);
    assert.equal(openWithinRoot(root, '/nope.txt').status, 404, 'a missing file has no handle to verify: fail closed');
    const loopRoot = path.join(base, 'loop');
    fs.mkdirSync(loopRoot, { recursive: true });
    fs.symlinkSync(path.join(loopRoot, 'b.txt'), path.join(loopRoot, 'a.txt'));
    fs.symlinkSync(path.join(loopRoot, 'a.txt'), path.join(loopRoot, 'b.txt'));
    const loop = openWithinRoot(loopRoot, '/a.txt');
    assert.equal(loop.ok, false);
    assert.equal(loop.status, 403);
    assert.match(loop.reason, /symlink loop \(ELOOP\)/, 'a loop is named as a loop, not reported as missing');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});


/* airhorn-yxxq: the shared static server's Pages-_headers parser must apply the real file
 * and REFUSE what it does not understand - a rule silently ignored is a test running
 * without the policy it claims to serve. */
test('parsePagesHeaders applies the shipped _headers and refuses outside the subset (airhorn-yxxq)', async () => {
  const { parsePagesHeaders } = await import('../tools/lib/static-server.mjs');
  const real = parsePagesHeaders(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', '_headers'), 'utf8'));
  assert.equal(real['X-Content-Type-Options'], 'nosniff', 'the real file parses');
  assert.equal(real['X-Frame-Options'], 'DENY');
  for (const bad of [
    '/only-this-path\n  X-Test: 1',          // a non-/* path block
    '/*\n  X-Test: 1\n/admin/*\n  X-Other: 2', // a second block
    '/*\n  not a header line',               // garbage inside the block
  ]) {
    assert.throws(() => parsePagesHeaders(bad), /_headers/, `must refuse: ${JSON.stringify(bad)}`);
  }
});


/* airhorn-zm8z: a timeout's 'observed' payload must be the last page state, not the
 * stringified Promise ('{}') that the un-awaited default observe produced. The diagnostic
 * is the whole point of the message - every suite's timeout shipped without it. */
test('waitForCondition timeout reports the awaited observed value, never {} (airhorn-zm8z)', async () => {
  const { waitForCondition } = await import('./support/poll.mjs');
  const err = await waitForCondition(async () => null, { timeout: 120, interval: 20, label: 'a never-true state' })
    .then(() => null, (e) => e);
  assert.ok(err, 'a never-true condition must time out');
  assert.match(err.message, /observed null/, `the observed value must be the awaited result, got: ${err.message}`);
  assert.doesNotMatch(err.message, /observed \{\}/, 'the Promise-stringification bug is back (airhorn-zm8z)');
  // A rejecting observe reads as a named fallback, not a crash that masks the timeout.
  const err2 = await waitForCondition(async () => null, {
    timeout: 120, interval: 20, label: 'x', observe: async () => { throw new Error('observe blew up'); },
  }).then(() => null, (e) => e);
  assert.match(err2.message, /<unserializable>/, 'a rejecting observe must not mask the timeout');
});

test('static-server: serveDist decodes the request path and contains it by handle (airhorn-0s4v)', async () => {
  // Behaviour, not source: the suites' shared server (tools/lib/static-server.mjs, airhorn-yxxq)
  // used to split the query off and match a SEPARATOR-LESS string prefix, so a sibling directory
  // sharing the root's name prefix or a symlink under the root left the served tree - and an
  // encoded path never matched its file at all. Driven over a real socket against a real tree.
  const { serveDist } = await import('../tools/lib/static-server.mjs');
  const net = await import('node:net');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'servedist-'));
  const root = path.join(base, 'dist');
  const sibling = path.join(base, 'dist-evil'); // shares the root's NAME PREFIX, is not inside it
  const outside = path.join(base, 'outside');
  for (const dir of [root, sibling, outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), 'INDEX');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'APP_JS');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SIBLING_SECRET');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  const rawGet = (port, target) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => socket.destroy(new Error('serveDist never answered')));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });

  const served = await serveDist({ dir: root });
  try {
    const statusOf = (response) => Number((response.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);

    const index = await rawGet(served.port, '/');
    assert.equal(statusOf(index), 200, index.slice(0, 200));
    assert.match(index, /INDEX/, 'the directory index still resolves');

    // The decode half: an encoded path must reach the file it names. Before the fix the raw
    // '%2E'-bearing pathname was joined literally and 404'd.
    const encoded = await rawGet(served.port, '/assets%2Fapp.js');
    assert.equal(statusOf(encoded), 200, `an encoded path must resolve to its file: ${encoded.slice(0, 200)}`);
    assert.match(encoded, /APP_JS/);

    // The containment half, both shapes: ../ out to a SIBLING whose name shares the root's
    // prefix, and a symlink that lives inside the root and points outside it.
    const traversal = await rawGet(served.port, '/../dist-evil/secret.txt');
    assert.equal(statusOf(traversal), 403, `a sibling sharing the root's name prefix must be refused: ${traversal.slice(0, 200)}`);
    assert.doesNotMatch(traversal, /SIBLING_SECRET/, 'the sibling file must never be served');
    assert.match(traversal, /outside the served root/, 'the refusal must name what it refused');

    const symlink = await rawGet(served.port, '/link.txt');
    assert.equal(statusOf(symlink), 403, `a symlink out of the root must be refused: ${symlink.slice(0, 200)}`);
    assert.doesNotMatch(symlink, /OUTSIDE_SECRET/, 'the outside file must never be served');

    // A malformed escape is a named 400, not a thrown URIError that kills the suite process.
    const malformed = await rawGet(served.port, '/%zz');
    assert.equal(statusOf(malformed), 400, malformed.slice(0, 200));
    assert.match(malformed, /bad percent-escape/);

    const missing = await rawGet(served.port, '/nope.txt');
    assert.equal(statusOf(missing), 404);
  } finally {
    await served.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* airhorn-7jqv: the acceptance harness reports the browser's version to its JSON payload, and
 * the value it reports comes from CHROME_BIN - the environment. It used to ask with
 *   execSync(`${JSON.stringify(chromeBin())} --version`)
 * and execSync with a STRING runs /bin/sh -c. JSON.stringify does quote the value, so spaces,
 * semicolons and quotes are contained (measured); what quoting does NOT contain is substitution,
 * because inside double quotes a backslash does not stop `...` or $(...). Measured on this box
 * with CHROME_BIN set to a path carrying `touch <marker>`: the old shape CREATED the marker and
 * then ran the command, the argv shape cannot. So the pin has two halves - the SHAPE (no shell
 * string is built from the environment) and the BEHAVIOUR (a metacharacter-laden path reaches
 * chrome as a path) - and its negative control is the old shape, which must still show teeth.
 *
 * What this covers, honestly: tests/support/browser.mjs's chromeBin() resolution and the exact
 * invocation tests/acceptance.mjs now makes. It does not boot the acceptance run itself. */
test('CHROME_BIN reaches chrome as an argv, never as shell text (airhorn-7jqv)', async () => {
  const { chromeBin } = await import(SUPPORT);
  const { execFileSync: execArgv, execSync: execShell } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bin-7jqv-'));
  // Two hazards in one value: a SPACE (a naive unquoted concatenation breaks on it) and a
  // SUBSTITUTION (which shell quoting cannot neutralise). `$(echo)` substitutes to nothing, so
  // the same directory also holds the file the shell WOULD have run - which is how the negative
  // control proves the substitution happened without needing a marker file or a failing command.
  const argvBin = path.join(dir, 'fake$(echo) chrome');
  const shellBin = path.join(dir, 'fake chrome');
  const stub = '#!/bin/sh\necho "FakeChrome 1.0 $0"\n';
  for (const f of [argvBin, shellBin]) fs.writeFileSync(f, stub, { mode: 0o755 });
  const realChromeBin = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = argvBin;
    assert.equal(chromeBin(), argvBin, 'chromeBin() must pass the environment value through unchanged');

    // THE SHIPPED CALL: an argv, so the value stays a path and the substitution stays text.
    const version = execArgv(chromeBin(), ['--version']).toString().trim();
    assert.equal(version, `FakeChrome 1.0 ${argvBin}`,
      `a metacharacter-laden CHROME_BIN must reach chrome verbatim: got ${JSON.stringify(version)}`);
    assert.equal(version.includes('$(echo)'), true,
      'the argv call substituted in CHROME_BIN: the environment value is reaching a shell again');

    // NEGATIVE CONTROL: the shape this replaced. It substitutes, so the same value resolves to
    // the OTHER file - if this stops happening the pin has lost its teeth (a different shell, a
    // Node change) and would pass for the wrong reason.
    const old = execShell(`${JSON.stringify(argvBin)} --version`).toString().trim();
    assert.equal(old, `FakeChrome 1.0 ${shellBin}`,
      `execSync(string) no longer substitutes, so this pin cannot show that the argv shape is what `
      + `prevents it - got ${JSON.stringify(old)}`);

    // And the SHAPE, so a regression to the string form fails here even if no run happens to hit it.
    const harness = fs.readFileSync(path.join(import.meta.dirname, 'acceptance.mjs'), 'utf8');
    assert.equal(/execSync\([^)]*chromeBin\(/.test(harness), false,
      'tests/acceptance.mjs must not build a shell string from chromeBin(): CHROME_BIN is environment '
      + 'and execSync(string) runs it through /bin/sh -c (airhorn-7jqv)');
    assert.match(harness, /execFileSync\(chromeBin\(\), \['--version'\]\)/,
      'tests/acceptance.mjs must ask chrome for its version with an argv');
  } finally {
    process.env.CHROME_BIN = realChromeBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
