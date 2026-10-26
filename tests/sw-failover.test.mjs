/*
 * tests/sw-failover.test.mjs — the worker must fail visibly, not hang or lie
 * (airhorn-46o, airhorn-nv9).
 *
 * 46o: a lie-fi connection (answers late, then dies) used to hang a navigation
 *      for ~18s and end on the browser's error page, even though a complete
 *      precached shell was available. Uncached subresource fetches had no bound
 *      at all and never settled.
 * nv9: a quota-denied precache rejects the install, which silently drops the
 *      upgrade — the user keeps the old build and is never told.
 *
 * Each stage asserts behaviour that fails on the worker before those fixes:
 *   A. navigation with a cached shell + lie-fi  -> shell renders, fast
 *   B. uncached subresource + lie-fi            -> bounded, never hangs open
 *   C. navigation with no cached shell          -> a self-explaining fallback page
 *   D. quota-denied upgrade                     -> reported, no empty cache left,
 *                                                  and the old build still works
 *
 * Script-style suite (like tests/sw-offline.test.mjs). The origin is taken down
 * or made to hang for real: CDP network emulation is per-target and does not
 * reach the worker's own fetches, so emulating offline would not test the worker.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { WAIT_TIMEOUT_MS } from './support/poll.mjs';
import { installSignalExit } from './support/signal-exit.mjs';

// A bound-kill (SIGTERM first, then the grace bound) bypasses the try/finally
// in run(), which is the only place the browser is closed (SIGTERM, tree
// SIGKILL, profile removal): without this, a timed-out run leaked the whole
// chrome tree plus its /tmp profile (airhorn-1l0a). The handler itself is
// shared with the other suites and the browser tools (tests/support/
// signal-exit.mjs, airhorn-4vfn); it runs once, races the close against the
// grace bound, and exits with the signal's own code.
let liveBrowser = null;
installSignalExit(async () => {
  const browser = liveBrowser;
  liveBrowser = null;
  if (browser) await browser.close().catch(() => {});
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

// A connection that answers late and then dies: the classic lie-fi.
const LIE_FI_DELAY_MS = 7000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  const state = { hang: false, down: false, version: null, swShim: null };
  const server = http.createServer((req, res) => {
    if (state.down) {
      req.destroy();
      return;
    }
    if (state.hang) {
      const timer = setTimeout(() => res.destroy(), LIE_FI_DELAY_MS);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    let pathname = req.url.split('?')[0];
    if (pathname === '/') pathname = '/index.html';
    const file = path.join(distDir, pathname);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (pathname === '/sw.js') {
      let text = body.toString();
      if (state.version) {
        text = text.replace(/const version = "[^"]*";/, `const version = "${state.version}";`);
      }
      if (state.swShim) text = `${state.swShim}\n${text}`;
      body = Buffer.from(text);
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cannot connect to Chrome'));
  });
  let nextId = 1;
  const pending = new Map();
  const waiters = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
      return;
    }
    for (const waiter of [...waiters]) waiter(msg);
  };
  const waitForEvent = (method, { sessionId, timeout = 15000 } = {}) => new Promise((resolve, reject) => {
    const waiter = (msg) => {
      if (msg.method !== method) return;
      if (sessionId && msg.sessionId !== sessionId) return;
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(msg.params);
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeout);
    waiters.add(waiter);
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  };
  return { ws, send, waitForEvent };
}

async function run() {
  if (!fs.existsSync(distDir)) throw new Error('dist directory does not exist. Run build first.');

  const { server, state, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Bounded condition wait (airhorn-iwf): same deadline, but it returns as soon
  // as the condition holds instead of always paying the worst case.
  const waitUntil = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    for (;;) {
      try { value = await predicate(); } catch { value = undefined; }
      if (value) return value;
      if (Date.now() >= deadline) return value;
      await sleep(100);
    }
  };

  const browser = await launchBrowser({ label: 'sw-failover', timeoutMs: 20000 });
  liveBrowser = browser;

  let cdp = null;
  try {
    cdp = await connectCdp(browser.browserWsUrl);
    const { send, waitForEvent } = cdp;

    const { sessionId } = await send('Target.attachToTarget', { targetId: browser.pageTargetId, flatten: true });
    const session = (method, params = {}) => send(method, params, sessionId);

    await session('Page.enable');
    await session('Runtime.enable');
    await session('Network.enable');

    const evaluate = async (expression) => {
      const res = await session('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result.value;
    };

    const navigate = async (url, timeout = 25000) => {
      const started = Date.now();
      const loaded = waitForEvent('Page.loadEventFired', { sessionId, timeout })
        .then(() => true).catch(() => false);
      await session('Page.navigate', { url }).catch(() => {});
      const ok = await loaded;
      return { loaded: ok, ms: Date.now() - started };
    };

    const waitForSw = async () => {
      for (let i = 0; i < 40; i++) {
        const st = await evaluate(`navigator.serviceWorker.ready
          .then((reg) => (reg.active ? reg.active.state : null))`).catch(() => null);
        if (st === 'activated') return true;
        await sleep(150);
      }
      return false;
    };

    const hornPresent = () => evaluate('!!document.querySelector(\'.horn\')');

    /* ------------------------------------------------------- install the worker */
    console.log('--- Loading the app online to install the service worker ---');
    const first = await navigate(`${origin}/`);
    assert(first.loaded, 'the app did not load for the first time');
    assert(await waitForSw(), 'service worker did not activate');

    /* ------------- A. lie-fi navigation, with a cached shell available ------- */
    console.log('\n--- A. lie-fi navigation falls back to the cached shell ---');
    state.hang = true;
    const lieFi = await navigate(`${origin}/deep-link`, 20000);
    const hornAfterLieFi = await hornPresent();
    state.hang = false;
    assert(hornAfterLieFi,
      `a lie-fi navigation did not fall back to the cached shell (loaded=${lieFi.loaded} after ${lieFi.ms}ms)`);
    assert(lieFi.ms < 8000,
      `a lie-fi navigation took ${lieFi.ms}ms before the app appeared: it should never wait out the connection`);
    console.log(`Lie-fi navigation rendered the app in ${lieFi.ms}ms.`);

    /* ---------------- B. lie-fi subresource: bounded, never hangs open ------- */
    console.log('\n--- B. a lie-fi subresource request is bounded ---');
    state.hang = true;
    const subresource = await evaluate(`(async () => {
      const started = Date.now();
      const raced = await Promise.race([
        fetch('/images/touch/android-launchericon-192-192.png')
          .then((r) => ({ settled: true, status: r.status }))
          .catch((e) => ({ settled: true, status: 0, error: String(e && e.message || e) })),
        new Promise((r) => setTimeout(() => r({ settled: false }), 15000)),
      ]);
      return { ...raced, waitedMs: Date.now() - started };
    })()`);
    state.hang = false;
    assert(subresource.settled,
      `an uncached subresource never settled under lie-fi: ${JSON.stringify(subresource)}`);
    assert(subresource.status !== 200,
      `a lie-fi subresource should not report success: ${JSON.stringify(subresource)}`);
    console.log(`Lie-fi subresource settled after ${subresource.waitedMs}ms with status ${subresource.status}.`);

    /* ------------ C. no cached shell at all: a self-explaining fallback ------ */
    console.log('\n--- C. with no cached shell, the fallback page explains itself ---');
    const wiped = await evaluate(`(async () => {
      const names = await caches.keys();
      for (const name of names) {
        if (name.startsWith('airhorner-') || name.startsWith('horn-integrity-')) {
          await caches.delete(name);
        }
      }
      return (await caches.keys()).length;
    })()`);
    state.hang = true;
    const noShell = await navigate(`${origin}/no-shell`, 20000);
    state.hang = false;
    const fallback = await evaluate(`(() => {
      const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      const retry = document.querySelector('a[href], button');
      return { title: document.title, text: text.slice(0, 300), hasRetry: !!retry };
    })()`).catch(() => ({ title: '', text: '', hasRetry: false }));
    assert(noShell.loaded, 'the fallback navigation never completed');
    // The title pins the served document: without it, the app's own shell
    // (buttons + long body text) or Chrome's offline error page (reload
    // button + "No internet") both satisfy hasRetry and text.length
    // (airhorn-tuuq F3).
    assert(fallback.title === 'The Air Horner - no connection',
      `the no-shell fallback was not the service worker's offline document: ${JSON.stringify(fallback)}`);
    assert(fallback.hasRetry,
      `the no-shell fallback offers no way to retry: ${JSON.stringify(fallback)}`);
    assert(fallback.text.length > 10,
      `the no-shell fallback explains nothing: ${JSON.stringify(fallback)}`);
    console.log(`Fallback page after wiping ${wiped} cache(s): "${fallback.text.slice(0, 80)}"`);

    /* ------------------ D. quota-denied upgrade is reported, not swallowed -- */
    console.log('\n--- D. a quota-denied upgrade is reported to the user ---');
    await navigate(`${origin}/`);
    assert(await waitForSw(), 'service worker did not reactivate after the cache wipe');
    const before = await evaluate(`caches.keys()`);

    state.version = '2.0.0-failover-quota';
    state.swShim = `Cache.prototype.addAll = () => Promise.reject(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'));`;
    await evaluate(`navigator.serviceWorker.getRegistration()
      .then((reg) => reg && reg.update()).then(() => true).catch(() => false)`);
    const readReport = () => evaluate(`(() => {
      const live = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];
      const text = live.map((el) => (el.textContent || '').trim()).join(' | ');
      return { regions: live.length, text };
    })()`);
    // The FAILURE copy, not the progress copy: /update/i alone matches the
    // "Updating the Air Horner..." announcement that fires at updatefound, so
    // the old regex passed green with the failure announcement deleted
    // (airhorn-tuuq F1). It must name the failure outcome.
    const REPORT_RE = /could not update|previous version|update failed/i;
    // Stops as soon as the report lands (airhorn-iwf). The bound is how long we
    // are willing to wait for the worker, not a claim that it lands in 3 s: the
    // upgrade announcement waits on a real worker statechange, and on a loaded
    // box that is late for reasons that have nothing to do with the app
    // (airhorn-sesh).
    const report = (await waitUntil(async () => {
      const r = await readReport();
      return REPORT_RE.test(r.text) ? r : null;
    }, WAIT_TIMEOUT_MS)) || await readReport();
    const after = await evaluate(`caches.keys()`);
    state.swShim = null;

    assert(report.text && REPORT_RE.test(report.text),
      `a failed upgrade was never reported to the user: ${JSON.stringify(report)}`);
    assert(after.length === before.length,
      `a failed upgrade left caches behind: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    console.log(`Reported: "${report.text}" (caches unchanged: ${JSON.stringify(after)})`);

    /* ------------------- the old build must still work offline after a failed upgrade */
    state.down = true;
    const stillWorks = await navigate(`${origin}/`);
    const hornStillThere = await hornPresent();
    state.down = false;
    assert(stillWorks.loaded && hornStillThere,
      'after a failed upgrade the previous build stopped working offline');
    console.log('The previous build still serves offline after the failed upgrade.');

    console.log('\nALL FAILOVER CHECKS PASSED!');
  } finally {
    liveBrowser = null;
    try { cdp?.ws.close(); } catch { /* already gone */ }
    // browser.close() does what airhorn-jx9's inline group-kill + rmSync did:
    // SIGTERM, tree-SIGKILL after 1.5s, profile removal.
    try { await browser.close(); } catch { /* already gone */ }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
