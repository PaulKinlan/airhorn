/*
 * tests/sw-offline.test.mjs — the worker's resilience contract, in one browser
 * session (airhorn-iwf: the offline and cache-integrity suites shared their
 * whole harness — serve dist, install the worker, one Chromium — so they now
 * share one run instead of paying two launches on every worker change).
 *
 * Stage group 1 — offline PWA (this file's original scope):
 *   - manifest.json contents verified on disk
 *   - the precache exists, names the current build, holds the hashed asset
 *   - an offline navigation is served by the worker: shell renders, page controlled
 *   - a REAL second build replaces the first: new cache activated, old caches purged
 *
 * Stage group 2 — cache integrity (merged from tests/sw-integrity.test.mjs,
 * airhorn-un5): a cache entry that has gone bad must not be trusted forever.
 * The precache is cache-first and the worker has no notion of what a good copy
 * looked like, so a truncated or garbage entry would be served for as long as
 * the build stays the same. Asserts:
 *   A. online, a corrupted shell entry is detected and healed from the network
 *   B. offline, a corrupted entry is NOT served (bytes nothing vouched for are
 *      worse than a visible failure)
 *   C. the rebuilt entry verifies again, so healing is not a one-off bypass
 *
 * It is a script-style suite: each stage narrates, and the first failed
 * assertion exits non-zero.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence, lateErrorMutant } from './support/quiescence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function testSwAndManifest() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  // 1. Verify manifest.json contents
  console.log('--- Verifying manifest.json ---');
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  if (manifest.id !== '/?homescreen=1') {
    throw new Error(`Expected manifest.id to be '/?homescreen=1', got '${manifest.id}'`);
  }
  if (!Array.isArray(manifest.categories) || !manifest.categories.includes('entertainment')) {
    throw new Error(`Expected manifest.categories to include 'entertainment', got ${JSON.stringify(manifest.categories)}`);
  }
  if (!manifest.launch_handler || manifest.launch_handler.client_mode !== 'focus-existing') {
    throw new Error(`Expected manifest.launch_handler.client_mode to be 'focus-existing', got ${JSON.stringify(manifest.launch_handler)}`);
  }
  if (!Array.isArray(manifest.shortcuts) || manifest.shortcuts.length === 0) {
    throw new Error('Expected manifest.shortcuts to contain entries');
  }
  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length < 2) {
    throw new Error(`Expected manifest.screenshots to contain wide and narrow screenshots`);
  }
  for (const s of manifest.screenshots) {
    const sPath = path.join(distDir, s.src.replace(/^\//, ''));
    if (!fs.existsSync(sPath)) {
      throw new Error(`Screenshot file referenced in manifest does not exist: ${sPath}`);
    }
  }
  console.log('manifest.json verified successfully!');

  let swVersionOverride = null;
  // Taking the origin down for real (integrity stage B) is the only honest way
  // to be offline in a test that the worker itself participates in: emulated
  // offline (CDP Network.emulateNetworkConditions) is per-target and a service
  // worker's own fetch() runs in the worker target, so it does not reach it.
  const originState = { down: false };

  // 2. Start HTTP server
  const server = http.createServer((req, res) => {
    if (originState.down) {
      req.destroy();
      return;
    }
    let reqUrl = req.url.split('?')[0];
    if (reqUrl === '/sw.js' && swVersionOverride) {
      let content = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf-8');
      content = content.replace(/airhorner-2\.0\.0-[a-zA-Z0-9_-]+/g, `airhorner-${swVersionOverride}`);
      content = content.replace(/const version = "[^"]+"/g, `const version = "${swVersionOverride}"`);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/'
      });
      res.end(content);
      return;
    }

    let filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
    if (!filePath.startsWith(distDir) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Service-Worker-Allowed': '/',
      // no-store (from the integrity stages): healed re-fetches must reach the
      // origin, never an HTTP-cache copy of bytes the worker already rejected.
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`Server listening on port ${port}`);

  // 3. Launch Chrome
  const chromeBin = process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

  const profileDir = '/tmp/chrome-sw-profile-' + Date.now();
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl = null;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome timeout')), 10000);
    chrome.stderr.on('data', (d) => {
      const match = d.toString().match(/ws:\/\/[^\s]+/);
      if (match) {
        wsUrl = match[0];
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const chromePort = new URL(wsUrl).port;
  const targetsRes = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
  const targets = await targetsRes.json();
  const pageWsUrl = targets.find(t => t.type === 'page').webSocketDebuggerUrl;

  const ws = new WebSocket(pageWsUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  const send = (method, params = {}) => {
    const id = msgId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // Strict evaluate for the integrity stages: a page-side exception is a
  // failure of the stage, not an undefined value to assert about later.
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pageErrors = [];
        window.addEventListener('error', (e) => {
          window.__pageErrors.push(e.message || (e.error ? e.error.message : String(e)));
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__pageErrors.push(e.reason?.message || String(e.reason));
        });
        ${quiescenceProbe}
      `
    });

    console.log('--- Loading page online to install Service Worker ---');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    // Wait for service worker to register and activate
    console.log('Waiting for Service Worker activation...');
    let swActive = false;
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `navigator.serviceWorker.ready.then(reg => reg.active ? reg.active.state : null)`,
        awaitPromise: true,
        returnByValue: true
      });
      if (res.result.value === 'activated') {
        swActive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!swActive) {
      throw new Error('Service Worker failed to activate within 6s');
    }
    console.log('Service Worker is active!');

    // Check cache contents
    const cacheInfo = await send('Runtime.evaluate', {
      expression: `(async () => {
        const keys = await caches.keys();
        const activeCache = keys.find(k => k.startsWith('airhorner-'));
        if (!activeCache) return { keys, cachedUrls: [] };
        const cache = await caches.open(activeCache);
        const reqs = await cache.keys();
        return {
          keys,
          activeCache,
          cachedUrls: reqs.map(r => new URL(r.url).pathname)
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('Cache status:', cacheInfo.result.value);
    const { activeCache, cachedUrls } = cacheInfo.result.value;

    if (!activeCache || !activeCache.startsWith('airhorner-2.0.0-')) {
      throw new Error(`Expected active cache starting with 'airhorner-2.0.0-', got '${activeCache}'`);
    }

    const hasHashedAsset = cachedUrls.some(u => u.startsWith('/assets/index-'));
    if (!hasHashedAsset) {
      throw new Error(`Expected hashed Vite asset in precache, got cached URLs: ${JSON.stringify(cachedUrls)}`);
    }
    console.log('Vite-built hashed asset verified in precache!');

    // Test offline navigation
    console.log('--- Emulating OFFLINE conditions ---');
    await send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });

    // Reload page while completely offline
    await send('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    // Verify offline load succeeded and DOM is fully functional
    const offlineEval = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        return {
          title: document.title,
          hornPresent: !!horn,
          hornAriaLabel: horn ? horn.getAttribute('aria-label') : null,
          swController: !!navigator.serviceWorker.controller
        };
      })()`,
      returnByValue: true
    });

    console.log('Offline evaluation result:', offlineEval.result.value);
    const off = offlineEval.result.value;
    if (!off.hornPresent || off.hornAriaLabel !== 'Air horn') {
      throw new Error(`Offline load failed: ${JSON.stringify(off)}`);
    }
    if (!off.swController) {
      throw new Error('Offline page not controlled by service worker');
    }
    console.log('OFFLINE LOAD VERIFIED!');

    // Restore online network
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });

    // Test replacing old cache with a REAL second build
    console.log('--- Testing real SW update and activate cache replacement ---');
    swVersionOverride = '2.0.0-build2';

    // Pre-seed legacy cache and trigger service worker update
    await send('Runtime.evaluate', {
      expression: `(async () => {
        await caches.open('airhorner-0.7.1');
        const reg = await navigator.serviceWorker.getRegistration();
        await reg.update();
      })()`,
      awaitPromise: true
    });

    // Wait for the new service worker to install, activate, and reload the page via controllerchange
    await new Promise(r => setTimeout(r, 1500));

    // Verify cache replacement after new SW activate handler ran
    const afterKeysResult = await send('Runtime.evaluate', {
      expression: `caches.keys()`,
      awaitPromise: true,
      returnByValue: true
    });

    const afterKeys = afterKeysResult.result.value;
    console.log('Caches after real SW update:', afterKeys);

    if (!afterKeys.includes('airhorner-2.0.0-build2')) {
      throw new Error(`Expected new cache 'airhorner-2.0.0-build2' in caches after update, got: ${JSON.stringify(afterKeys)}`);
    }
    if (afterKeys.includes('airhorner-0.7.1')) {
      throw new Error(`Legacy cache 'airhorner-0.7.1' was NOT deleted by sw.js activate handler: ${JSON.stringify(afterKeys)}`);
    }
    if (afterKeys.includes(activeCache)) {
      throw new Error(`Previous build cache '${activeCache}' was NOT deleted by new build's activate handler: ${JSON.stringify(afterKeys)}`);
    }
    console.log('Real SW activate handler verified: old caches purged, new build cache activated!');

    // Wait for observed quiescence instead of sleeping for a guessed duration.
    // TEST_LATE_ERROR_MS injects a mutant: an async throw after the last
    // interaction, which the wait must notice and the error checks must catch.
    const lateErrorMs = Number(process.env.TEST_LATE_ERROR_MS || 0);
    if (lateErrorMs > 0) {
      console.log(`Injecting late error mutant: throw ${lateErrorMs}ms after the last interaction`);
      await send('Runtime.evaluate', { expression: lateErrorMutant(lateErrorMs) });
    }

    const settled = await waitForQuiescence(send);
    console.log(
      `Page quiescent after ${settled.waitedMs}ms: ${settled.pending.scheduled} async task(s) ` +
      `scheduled, ${settled.pending.completed} completed, ${settled.samples} samples`
    );

    if (consoleErrors.length > 0) {
      throw new Error(`Console errors or uncaught exceptions detected: ${JSON.stringify(consoleErrors)}`);
    }

    const inPageErrors = await send('Runtime.evaluate', {
      expression: 'window.__pageErrors || []',
      returnByValue: true
    });
    if (inPageErrors.result.value && inPageErrors.result.value.length > 0) {
      throw new Error(`In-page errors detected: ${JSON.stringify(inPageErrors.result.value)}`);
    }

    console.log('ALL SERVICE WORKER & MANIFEST CHECKS PASSED!');

    /* ================================================== stage group 2: integrity
     * From here the page runs the build2 worker with the build2 precache; the
     * integrity stages corrupt and heal entries in THAT cache, so a merge bug
     * that ran them against a stale cache would not match production. */

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
    assert(precacheInfo.name === 'airhorner-2.0.0-build2',
      `integrity stages must run against the build2 precache, got ${precacheInfo.name}`);
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
    await send('Page.reload');
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
    originState.down = true;
    await send('Page.reload');
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
    originState.down = false;
    await send('Page.reload');
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
    await send('Page.reload');
    await sleep(1200);
    const secondHeal = await evaluate(`fetch(${JSON.stringify(assetUrl)})
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, body: '' }))`);
    assert(secondHeal.status === 200 && secondHeal.body.length > 1000
      && !secondHeal.body.includes(GARBAGE),
      `healing is not repeatable: ${JSON.stringify(secondHeal)}`);

    console.log('ALL CACHE INTEGRITY CHECKS PASSED!');

    // The error watchers cover the whole session; the integrity stages drove
    // three reloads and a real origin outage, so re-check them here.
    if (consoleErrors.length > 0) {
      throw new Error(`Console errors or uncaught exceptions detected: ${JSON.stringify(consoleErrors)}`);
    }
    const endPageErrors = await send('Runtime.evaluate', {
      expression: 'window.__pageErrors || []',
      returnByValue: true
    });
    if (endPageErrors.result.value && endPageErrors.result.value.length > 0) {
      throw new Error(`In-page errors detected: ${JSON.stringify(endPageErrors.result.value)}`);
    }

    console.log('ALL RESILIENCE & OFFLINE CHECKS PASSED!');
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

testSwAndManifest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
