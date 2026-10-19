/*
 * tests/sw-integrity.test.mjs — a cache entry that has gone bad must not be
 * trusted forever (airhorn-un5).
 *
 * The precache is cache-first and the service worker has no notion of what a
 * good copy looked like, so a truncated or garbage entry is served for as long
 * as the build stays the same: no reload repairs it, and reg.update() does not
 * help because the worker script itself never changed. The user's only escape
 * was clearing site data.
 *
 * This suite drives the built app in headless Chromium and asserts:
 *   A. online, a corrupted shell entry is detected and healed from the network
 *   B. offline, a corrupted entry is NOT served (bytes nothing vouched for are
 *      worse than a visible failure)
 *   C. the rebuilt entry verifies again, so healing is not a one-off bypass
 *
 * It is a script-style suite (like tests/sw-offline.test.mjs): each stage
 * narrates, and the first failed assertion exits non-zero.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const GARBAGE = 'this is not the app you asked for';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  const state = { down: false };
  const server = http.createServer((req, res) => {
    // Emulated offline (CDP Network.emulateNetworkConditions) is per-target and a
    // service worker's own fetch() runs in the worker target, so it does not reach
    // it. Taking the origin down for real is the only honest way to be offline in
    // a test that the worker itself participates in.
    if (state.down) {
      req.destroy();
      return;
    }
    let pathname = req.url.split('?')[0];
    if (pathname === '/') pathname = '/index.html';
    const file = path.join(distDir, pathname);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(fs.readFileSync(file));
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
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  };
  return { ws, send };
}

async function run() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  const { server, state, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;

  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${fs.mkdtempSync('/tmp/airhorn-integrity-')}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp = null;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome timeout')), 20000);
      chrome.stderr.on('data', (d) => {
        const m = d.toString().match(/ws:\/\/\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
    });

    cdp = await connectCdp(wsUrl);
    const { send } = cdp;

    const targets = await (await fetch(
      `http://127.0.0.1:${new URL(wsUrl).port}/json/list`,
    )).json();
    const page = targets.find((t) => t.type === 'page');
    const { sessionId } = await send('Target.attachToTarget', {
      targetId: page.id, flatten: true,
    });
    const session = (method, params = {}) => send(method, params, sessionId);

    await session('Page.enable');
    await session('Runtime.enable');
    await session('Network.enable');

    const evaluate = async (expression) => {
      const res = await session('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result.value;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitForLoad = () => session('Page.loadEventFired').catch(() => null);

    /* --------------------------------------------------- install the worker */
    console.log('--- Loading the app online to install the service worker ---');
    await session('Page.navigate', { url: `${origin}/` });
    let swState = null;
    for (let i = 0; i < 40 && swState !== 'activated'; i++) {
      swState = await evaluate(`navigator.serviceWorker.ready
        .then((reg) => (reg.active ? reg.active.state : null))`).catch(() => null);
      if (swState !== 'activated') await sleep(150);
    }
    assert(swState === 'activated', `service worker did not activate (last state: ${swState})`);

    const precacheInfo = await evaluate(`(async () => {
      const names = await caches.keys();
      const name = names.find((n) => n.startsWith('airhorner-'));
      if (!name) return null;
      const cache = await caches.open(name);
      const urls = (await cache.keys()).map((r) => new URL(r.url).pathname);
      return { name, urls };
    })()`);
    assert(precacheInfo, 'no airhorner- cache was created');
    const assetUrl = (precacheInfo.urls || []).find((u) => u.startsWith('/assets/'));
    assert(assetUrl, `no hashed asset was precached: ${JSON.stringify(precacheInfo.urls)}`);
    console.log(`Precached: ${precacheInfo.urls.join(', ')}`);

    const corrupt = (pathname, body, type) => evaluate(`(async () => {
      const name = (await caches.keys()).find((n) => n.startsWith('airhorner-'));
      const cache = await caches.open(name);
      const target = (await cache.keys())
        .map((r) => r.url)
        .find((u) => new URL(u).pathname === ${JSON.stringify(pathname)});
      if (!target) return 'missing';
      await cache.put(new Request(target),
        new Response(${JSON.stringify(body)}, { headers: { 'content-type': ${JSON.stringify(type)} } }));
      return 'corrupted';
    })()`);

    /* --------------------------------------- A. online: detect and heal shell */
    console.log('\n--- A. a corrupted shell entry is healed online ---');
    // Both shell entries: '/' is what a navigation matches, '/index.html' is what
    // the worker precaches and what an in-page fetch asks for.
    for (const shellPath of ['/', '/index.html']) {
      assert(await corrupt(shellPath, `<!doctype html><title>garbage</title>${GARBAGE}`, 'text/html') === 'corrupted',
        `could not corrupt the cached ${shellPath}`);
    }
    await waitForLoad();
    await session('Page.reload');
    await sleep(1200);

    const afterHeal = await evaluate(`(() => ({
      horn: !!document.querySelector('.horn'),
      title: document.title,
    }))()`);
    assert(afterHeal.horn,
      `the page did not recover from a corrupted shell entry: ${JSON.stringify(afterHeal)}`);

    const servedShell = await evaluate(`fetch('/index.html')
      .then((r) => r.text())
      .then((t) => ({ ok: true, garbage: t.includes(${JSON.stringify(GARBAGE)}) }))
      .catch((e) => ({ ok: false, error: String(e && e.message || e) }))`);
    assert(servedShell.ok, `fetching the shell failed after healing: ${JSON.stringify(servedShell)}`);
    assert(!servedShell.garbage,
      'the corrupt shell entry was served again: the worker trusted bytes it never verified');
    console.log('Shell healed: the page renders and the cached bytes were replaced.');

    /* ------------------------- B. offline: never serve bytes we cannot vouch for */
    console.log('\n--- B. offline, a corrupted entry is refused rather than served ---');
    assert(await corrupt(assetUrl, GARBAGE, 'application/javascript') === 'corrupted',
      `could not corrupt the cached asset ${assetUrl}`);
    state.down = true;
    await waitForLoad();
    await session('Page.reload');
    await sleep(1000);

    const offlineShell = await evaluate('!!document.querySelector(\'.horn\')');
    assert(offlineShell, 'the shell should still render offline (only the asset entry was corrupted)');

    const offlineAsset = await evaluate(`fetch(${JSON.stringify(assetUrl)})
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, error: String(e && e.message || e) }))`);
    assert(offlineAsset.body !== GARBAGE,
      `the corrupted asset was served from the cache offline: ${JSON.stringify(offlineAsset)}`);
    console.log(`Corrupted asset refused offline: status ${offlineAsset.status}.`);

    const poisonedLeftBehind = await evaluate(`(async () => {
      const name = (await caches.keys()).find((n) => n.startsWith('airhorner-'));
      const cache = await caches.open(name);
      const hit = await cache.match(${JSON.stringify(assetUrl)});
      return hit ? (await hit.text()) === ${JSON.stringify(GARBAGE)} : false;
    })()`);
    assert(!poisonedLeftBehind, 'the corrupted entry was left in the cache for the next load');

    /* -------------------------- C. back online: the entry heals and verifies again */
    console.log('\n--- C. back online, the entry heals and stays healable ---');
    state.down = false;
    await waitForLoad();
    await session('Page.reload');
    await sleep(1200);

    const healed = await evaluate(`fetch(${JSON.stringify(assetUrl)})
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, error: String(e && e.message || e) }))`);
    assert(healed.status === 200, `the asset did not come back after healing: ${JSON.stringify(healed)}`);
    assert(healed.body.length > 1000 && !healed.body.includes(GARBAGE),
      'the "healed" asset is still not the real bundle');

    // Re-corrupt and load again: a one-shot repair that then trusts everything
    // would pass A and C above but fail here.
    assert(await corrupt(assetUrl, GARBAGE, 'application/javascript') === 'corrupted',
      'could not re-corrupt the asset');
    await waitForLoad();
    await session('Page.reload');
    await sleep(1200);
    const secondHeal = await evaluate(`fetch(${JSON.stringify(assetUrl)})
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, body: '' }))`);
    assert(secondHeal.status === 200 && secondHeal.body.length > 1000
      && !secondHeal.body.includes(GARBAGE),
      `healing is not repeatable: ${JSON.stringify(secondHeal)}`);

    console.log('\nALL CACHE INTEGRITY CHECKS PASSED!');
  } finally {
    try { cdp?.ws.close(); } catch { /* already gone */ }
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
