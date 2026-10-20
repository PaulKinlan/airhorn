/*
 * tests/support/browser.mjs — one browser-launch path for every suite (airhorn-ecp).
 *
 * Every browser suite used to inline its own copy of this: spawn Chrome, scrape
 * the devtools WebSocket URL off stderr, find the page target. One helper now
 * owns it, so fixes land once (this also folded in: --disable-breakpad and
 * --disable-crash-reporter everywhere, not just shortcuts — a crashpad handler
 * outlives a bound-killed browser, airhorn-hlg; --disable-dev-shm-usage
 * everywhere, not just sw-failover; tree-kill close for every suite; and the
 * profile dir is removed on close instead of leaking into /tmp).
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
 *     pageTargetId,    // the fresh page's target id
 *     pageWsUrl,       // ... and its WebSocket URL (suites connect their client here)
 *     close(),         // SIGTERM, then tree-SIGKILL after 1.5s; removes the profile
 *     killNow(),       // synchronous tree-kill, for signal handlers
 *   }
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function chromeBin() {
  return process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');
}

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
// such run). Synchronous by design so signal handlers can use it.
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
 * launchBrowser({ autoplay, webmcp, label, timeoutMs })
 *   autoplay:  --autoplay-policy=no-user-gesture-required (a launch-from-shortcut
 *              is a user gesture; suites asserting blocked autoplay pass false)
 *   webmcp:    --enable-features=WebMCP,WebMCPTesting (every suite that sets it
 *              also sets autoplay)
 *   label:       names the profile dir and timeout errors
 *   timeoutMs:   bound on chrome startup
 *   discoveryMs: bound on /json/list discovery (capped by timeoutMs)
 */
export async function launchBrowser({ autoplay = false, webmcp = false, label = 'suite', timeoutMs = 15000, discoveryMs = 5000 } = {}) {
  const profileDir = fs.mkdtempSync(`/tmp/chrome-${label}-`);
  const chrome = spawn(chromeBin(), [
    ...familyArgs({ autoplay, webmcp }),
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // One reap path for every way a launch can end without a handle: startup
  // failure, discovery failure, or the launch being cut short (airhorn-9nea,
  // airhorn-4yhb).
  let closed = false;
  const reap = () => {
    if (closed) return;
    closed = true;
    killTree(chrome.pid);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  // Nothing in the caller can reap this browser yet: every suite registers its
  // own signal handler only AFTER launchBrowser resolves, so a bound-kill during
  // startup or discovery left the whole chrome tree and its profile behind
  // (airhorn-4yhb). Prepended, so it reaps before a suite's own handler runs;
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
      const timeout = setTimeout(
        () => reject(new Error(`Chrome start timeout (${label}): ${stderrLines.join('\n')}`)), timeoutMs);
      chrome.stderr.on('data', (data) => {
        const text = data.toString();
        stderrLines.push(text);
        const match = text.match(/ws:\/\/[^\s]+/);
        if (match) {
          browserWsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      });
      chrome.on('error', (err) => { clearTimeout(timeout); reject(err); });
      chrome.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early (${code}) (${label}): ${stderrLines.join('\n')}`));
      });
    });

    port = new URL(browserWsUrl).port;
    // DevTools discovery is a failure path too: if the /json/list fetch rejects
    // or no page target exists, launchBrowser must not return with the Chrome
    // process and its /tmp profile still alive (airhorn-9nea). A peer that
    // accepts the connection and never answers is the third case: with no
    // bound it parked the launch until undici's 300s headers timeout - longer
    // than any suite or gate bound - so the practical outcome was a bound-kill
    // with an unreaped browser (airhorn-4yhb). The bound is enforced twice: the
    // abort frees the socket straight away, and the race holds even if the fetch
    // in scope ignores an AbortSignal (a stub in a test, an older runtime). The
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
    pageTargetId: pageTarget.id,
    pageWsUrl: pageTarget.webSocketDebuggerUrl,
    async close() {
      if (closed) return;
      closed = true;
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      const gone = await Promise.race([exited.then(() => true), sleep(1500).then(() => false)]);
      if (!gone) killTree(chrome.pid);
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
    killNow() {
      reap();
    },
  };
}
