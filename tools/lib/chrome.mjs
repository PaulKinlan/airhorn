/*
 * tools/lib/chrome.mjs — THE one Chrome launch path (airhorn-2po9).
 *
 * Eight tools each carried their own copy of this (resolve the binary, spawn,
 * scrape the ws:// URL off stderr, bound /json/list, find the page target, kill
 * the tree, rm the profile) and tests/support/browser.mjs carried a ninth. The
 * copies had already drifted and the drift was paid for one merge at a time:
 * the 2026-10-20 reaper burst was >=10 merges fixing one bug class (bounds per
 * tool: e885f1c/01ba7fc/0e1dbf7/489d42b; close()/sweep per suite:
 * f52e450/50c5bc0/a0b38eb/4dd2b46) and the converge commit 3615e5c+a06d482 is
 * the only one that fixed the class once. The "Raced against the handshake"
 * comment (airhorn-trj7) was pasted in three files for the same reason.
 *
 * So: resolve-bin, spawn, startup bound, profile dir, /json/list discovery,
 * the page ws handshake bound, tree kill and profile rm live HERE. A tool or a
 * suite adds only what is genuinely its own (an extra flag, a browser-level CDP
 * session, a persistent profile). Behaviour is unchanged for the suites:
 * tests/support/browser.mjs is now a re-export of this module, not a copy.
 *
 * Everything hard-won by the earlier copies is kept, because each one cost a
 * merge:
 *   - NOT detached (airhorn-acex, airhorn-105n): chrome must stay in the
 *     caller's process group. fleet-gate's bound and any job-tree reaper kill
 *     the GROUP, and a SIGKILL runs no node handler, so a detached launch
 *     outlives the kill (15 processes + the profile survived a group SIGKILL).
 *   - --disable-breakpad / --disable-crash-reporter everywhere (airhorn-hlg):
 *     a crashpad handler outlives a bound-killed browser and the reaper cannot
 *     attribute it.
 *   - --disable-dev-shm-usage everywhere (airhorn-ecp): a small /dev/shm is the
 *     ordinary case on these boxes.
 *   - the profile-marker sweep (airhorn-byun/77ih): one /proc read finds the
 *     whole tree by `--user-data-dir=`, so nothing can out-fork the cleanup.
 *   - one reap path for every way a launch can end without a handle: spawn
 *     failure (airhorn-trj7/r5me), a startup that never announces itself, a
 *     /json/list that rejects (airhorn-9nea), one that accepts and never
 *     answers (airhorn-4yhb), a page ws that never opens (airhorn-doek), and a
 *     bound-kill during any of it (airhorn-4yhb) - the caller cannot have
 *     registered its own handler yet.
 *   - the discovery bound is enforced twice, by the abort AND by a race, so a
 *     fetch that ignores its AbortSignal (a stub, an older runtime) cannot park
 *     the launch past every gate bound (airhorn-4yhb).
 *
 * A shared-Chrome mode (one long-lived browser per flag family, fresh page per
 * suite via Target.createTarget) was built and measured for airhorn-ecp and
 * REJECTED on this 2-core box: one browser process serialises the parallel
 * suites' work and costs more than the cold launches it saves (A/B gate runs:
 * master 62-70s vs shared 82-98s; per-suite e.g. shortcuts 16s -> 31s,
 * sw-failover 11s -> 24s in-gate, while a solo shared run took 15s - it is
 * contention, not the mechanism). Off-the-record browser contexts were also
 * unusable: serviceWorker is undefined there (probed), and most suites drive
 * the SW. The history has the full implementation if a bigger box revives it.
 *
 * The handle:
 *   {
 *     chrome,          // child process
 *     browserWsUrl,    // browser-level CDP endpoint
 *     port,            // devtools HTTP port
 *     pageTargetId,    // the fresh page's target id (null if discoverPage:false)
 *     pageWsUrl,       // ... and its WebSocket URL (connectPage() dials it)
 *     profileDir,      // the --user-data-dir this launch owns
 *     close(),         // sweep + profile rm synchronously (signal-safe); exit race after
 *     killNow(),       // synchronous tree-kill, for signal handlers
 *   }
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The one profile-marker sweep (airhorn-byun): the tools and this helper share
// a single definition in tools/lib/reap.mjs instead of five drifting copies.
import { sweepProfile } from './reap.mjs';

export { sweepProfile };

export function chromeBin() {
  return process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');
}

// The flag family every launch shares, for the reasons in the header. A caller
// that needs more passes `extraFlags`; none of it re-derives the family.
function familyArgs({ autoplay = false, webmcp = false } = {}) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    '--disable-crash-reporter',
  ];
  if (autoplay) args.push('--autoplay-policy=no-user-gesture-required');
  if (webmcp) args.push('--enable-features=WebMCP,WebMCPTesting');
  return args;
}

// Kill a process tree, children deepest-first: killing the parent alone leaves
// its renderers behind (the reaper found 13 processes, 47 minutes old, from one
// such run). Synchronous by design so signal handlers can use it. It walks
// ppid, so it is the fallback for a /proc-less host and the belt to the marker
// sweep's braces (a child reparented when the browser died first is invisible
// here and found there).
export function killTree(pid) {
  try {
    const table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map();
    for (const line of table.trim().split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const order = [];
    const walk = (node) => {
      for (const child of children.get(node) || []) {
        walk(child);
        order.push(child);
      }
    };
    walk(pid);
    for (const child of [...order].reverse()) {
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* ps failed; fall through to killing the parent */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * launchChrome({ autoplay, webmcp, extraFlags, label, timeoutMs, discoveryMs,
 *                profileDir, keepProfile, discoverPage })
 *
 *   autoplay:     --autoplay-policy=no-user-gesture-required (a launch from a
 *                 shortcut is a user gesture; anything asserting blocked
 *                 autoplay passes false)
 *   webmcp:       --enable-features=WebMCP,WebMCPTesting (every caller that
 *                 sets it also sets autoplay)
 *   extraFlags:   appended after the family flags - the caller's own flags
 *                 (certificate ignoring, --no-first-run, ...)
 *   label:        names the profile dir and the timeout errors
 *   timeoutMs:    bound on chrome startup
 *   discoveryMs:  bound on /json/list discovery (capped by timeoutMs)
 *   profileDir:   use this directory instead of a fresh mkdtemp. A tool whose
 *                 stale-profile sweep keys on the mkdtemp SHAPE
 *                 (sweepStaleProfiles) passes its own; everyone else lets the
 *                 launch own it.
 *   keepProfile:  leave the profile on disk at close (a "what does this device
 *                 do after a restart" scenario, tools/rollback-rehearsal.mjs)
 *   discoverPage: fetch /json/list and resolve the page target. false for a
 *                 browser-level CDP session (tools/resilience-audit.mjs), which
 *                 never needs a page.
 */
export async function launchChrome({
  autoplay = false,
  webmcp = false,
  extraFlags = [],
  label = 'chrome',
  timeoutMs = 15000,
  discoveryMs = 5000,
  profileDir: givenProfileDir = null,
  keepProfile = false,
  discoverPage = true,
} = {}) {
  const profileDir = givenProfileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `chrome-${label}-`));
  const chrome = spawn(chromeBin(), [
    ...familyArgs({ autoplay, webmcp }),
    ...extraFlags,
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  // NOT detached: chrome must stay in the caller's process group. As its own
  // group leader (detached: true) it sat outside every ancestor group-kill -
  // fleet-gate's bound and any job-tree reaper kill the GROUP, and a SIGKILL
  // runs no node handler, so the whole browser tree outlived the kill
  // (airhorn-acex: 15 processes + the profile survived a group SIGKILL that
  // the pre-77ih code cleaned). In the caller's group the same kill reaches
  // every process of this launch instantaneously, handler or no handler.
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // One reap path for every way a launch can end without a handle: startup
  // failure, discovery failure, or the launch being cut short (airhorn-9nea,
  // airhorn-4yhb).
  let closed = false;
  const reap = () => {
    if (closed) return;
    closed = true;
    // The marker sweep first (airhorn-77ih): the browser is killed in the same
    // pass that finds its children, so nothing can out-fork the cleanup, and
    // anything that raced the read is visible to the sweep's second pass.
    sweepProfile(profileDir);
    // Belt and braces for anything the marker somehow missed.
    try { killTree(chrome.pid); } catch { /* already gone */ }
    if (keepProfile) return;
    // A SIGKILL'd child lands final writebacks during the rm walk, so this
    // needs the retries, not a bare rm (airhorn-jx9, airhorn-yfh8). The
    // budget is sized to fit a signal handler's grace: the launch-window
    // guard runs BEFORE a caller's signal-exit cleanup, so every millisecond
    // spent here is taken off close()'s budget downstream (airhorn-gau8).
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
  };
  // Nothing in the caller can reap this browser yet: a caller registers its own
  // signal handler only AFTER launchChrome resolves, so a bound-kill during
  // startup or discovery left the whole chrome tree and its profile behind
  // (airhorn-4yhb). Prepended, so it reaps before a caller's own handler runs;
  // if it is the only listener, the signal is re-raised so the process still
  // dies the way it would have without the guard.
  const onSignal = function onLaunchSignal(signal) {
    reap();
    if (process.listenerCount(signal) > 1) return;
    process.removeListener(signal, onLaunchSignal);
    process.kill(process.pid, signal);
  };
  const onExit = () => reap();
  const signals = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) process.prependListener(signal, onSignal);
  process.on('exit', onExit);
  const release = () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
    process.removeListener('exit', onExit);
  };

  let browserWsUrl = null;
  let pageTarget = null;
  let port = null;
  const stderrLines = [];
  const discoveryBound = Math.max(1, Math.min(discoveryMs, timeoutMs));
  try {
    await new Promise((resolve, reject) => {
      // A spawn that never produced a process reports through the 'error'
      // event, not a rejection - and a missing CHROME_BIN is the ordinary case,
      // since the default path does not exist on a machine without Chrome. With
      // no listener that is an uncaughtException: it aborts the caller BEFORE
      // reap() can run and leaves the launch profile behind (airhorn-trj7,
      // airhorn-r5me). Raced against the handshake so it takes the same
      // teardown as the ws-silent and exits-early shapes.
      const timeout = setTimeout(
        () => reject(new Error(`Chrome start timeout (${label}): ${stderrLines.join('\n')}`)), timeoutMs);
      const onData = (data) => {
        const text = data.toString();
        stderrLines.push(text);
        const match = text.match(/ws:\/\/[^\s]+/);
        if (match && !browserWsUrl) {
          browserWsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      };
      // Chrome announces the endpoint on stderr; a wrapper script may use
      // stdout, so both are watched (the tools' copies always did).
      chrome.stderr.on('data', onData);
      chrome.stdout.on('data', onData);
      chrome.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`chrome launch failed: ${err.message}`));
      });
      chrome.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early (${code}) (${label}): ${stderrLines.join('\n')}`));
      });
    });

    port = new URL(browserWsUrl).port;
    if (discoverPage) {
      // DevTools discovery is a failure path too: if the /json/list fetch rejects
      // or no page target exists, launchChrome must not return with the Chrome
      // process and its profile still alive (airhorn-9nea). A peer that accepts
      // the connection and never answers is the third case: with no bound it
      // parked the launch until undici's 300s headers timeout - longer than any
      // suite or gate bound - so the practical outcome was a bound-kill with an
      // unreaped browser (airhorn-4yhb). The bound is enforced twice: the abort
      // frees the socket straight away, and the race holds even if the fetch in
      // scope ignores an AbortSignal (a stub in a test, an older runtime). The
      // clock starts here, not at spawn, so a slow chrome start cannot eat it.
      const discoverySignal = AbortSignal.timeout(discoveryBound);
      let discoveryTimer = null;
      const discoveryTimeout = new Promise((resolve, reject) => {
        discoveryTimer = setTimeout(() => reject(new Error(
          `DevTools discovery timeout (${discoveryBound}ms) (${label}): /json/list never answered on port ${port}`)),
        discoveryBound);
      });
      let targets;
      try {
        targets = await Promise.race([
          discoveryTimeout,
          (async () => {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: discoverySignal });
              return await res.json();
            } catch (err) {
              // The abort fires at the same bound, so it can win the race: the
              // failure must read the same however it lost.
              if (discoverySignal.aborted) {
                throw new Error(`DevTools discovery timeout (${discoveryBound}ms) (${label}): /json/list never answered on port ${port}`);
              }
              throw err;
            }
          })(),
        ]);
      } finally {
        clearTimeout(discoveryTimer);
      }
      pageTarget = targets.find((t) => t.type === 'page');
      if (!pageTarget) throw new Error(`no page target in /json/list (${label}): ${JSON.stringify(targets.map((t) => t.type))}`);
    }
  } catch (err) {
    reap();
    throw err;
  } finally {
    // Past this point the caller owns the lifecycle (it registers its own
    // handler as soon as it has the handle).
    release();
  }

  const exited = new Promise((r) => chrome.on('exit', r));
  return {
    chrome,
    browserWsUrl,
    port,
    pageTargetId: pageTarget ? pageTarget.id : null,
    pageWsUrl: pageTarget ? pageTarget.webSocketDebuggerUrl : null,
    profileDir,
    async close() {
      if (closed) return 0;
      closed = true;
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      // Everything that matters below is SYNCHRONOUS, and it must be: once
      // this method awaits, the process can be exited under it - a signal
      // handler's grace timer, or a sibling cleanup throwing while this one
      // is in flight (airhorn-gau8's repro: a launch still pending makes
      // inflight?.close() a TypeError, and signal-exit answers the rejection
      // by exiting 143 while close() is still awaiting). close() used to
      // wait 1500ms for a graceful exit before touching the profile; inside
      // a bound-kill that wait alone ate the whole grace and the profile
      // survived. A healthy chrome TERM-exits in ~120ms (measured); the rm
      // retries absorb its writeback, which is what they are for
      // (airhorn-jx9, airhorn-yfh8) - and the rm budget is sized so the
      // signal path fits signal-exit's 2s grace with room to spare.
      sweepProfile(profileDir);
      // Belt and braces for anything the marker somehow missed, as in reap()
      // above - and the ONLY kill on a /proc-less system, where the sweep
      // returns without acting (airhorn-v54f).
      try { killTree(chrome.pid); } catch { /* already gone */ }
      if (!keepProfile) {
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
      }
      // Tidiness only - the profile is already gone; nothing above is guarded
      // by this await.
      await Promise.race([exited.then(() => true), sleep(400).then(() => false)]);
      return 0;
    },
    killNow() {
      reap();
    },
  };
}

/*
 * connectPage(wsUrlOrHandle, { label, timeoutMs }) — dial the page socket.
 *
 * The ws open is part of the launch window and gets the same treatment as the
 * handshake above: a peer that answers /json/list but never completes the
 * upgrade must reject, labelled, instead of parking the caller with a live
 * browser (airhorn-doek, airhorn-nbfp, airhorn-e4im - the same bound fixed in
 * four copies before this module owned it).
 */
export async function connectPage(target, { label = 'chrome', timeoutMs = 15000 } = {}) {
  const wsUrl = typeof target === 'string' ? target : target?.pageWsUrl;
  if (!wsUrl) throw new Error(`connectPage: no page socket to dial (${label})`);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    // Settle exactly once. Closing the socket is part of settling (a half-open
    // ws keeps the event loop alive and the caller never exits), and that close
    // fires onerror SYNCHRONOUSLY - so an unguarded onerror would replace the
    // labelled bound message with the generic one, and the caller would see the
    // wrong reason for the same failure.
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      if (!err) { resolve(); return; }
      try { ws.close(); } catch { /* never opened, or already closed */ }
      reject(err);
    };
    const bound = setTimeout(() => settle(new Error(
      `DevTools ws handshake timeout (${label}): the page socket never opened within ${timeoutMs}ms`)), timeoutMs);
    ws.onopen = () => settle(null);
    ws.onerror = (err) => settle(err instanceof Error && err.message
      ? new Error(`DevTools ws handshake failed (${label}): ${err.message}`)
      : new Error(`DevTools ws handshake failed (${label}): the page socket errored`));
  });
  return ws;
}
