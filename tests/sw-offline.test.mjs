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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence, lateErrorMutant } from './support/quiescence.mjs';
import { waitForCondition } from './support/poll.mjs';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen } from './cdp-command-bound.mjs';
import { serveDist } from './support/static-server.mjs';

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
  // Count is not content (the assertion sweep, sw-offline:82): `length >= 2`
  // passes for two 'wide' screenshots or two entries with NO form_factor at all,
  // while the store listing the manifest claims to describe gets no narrow shot.
  // The claim is one of EACH factor; an entry without a form_factor is
  // unmeasurable and fails named, never counted as either.
  const shots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
  const wide = shots.filter((s) => s.form_factor === 'wide').length;
  const narrow = shots.filter((s) => s.form_factor === 'narrow').length;
  if (wide < 1 || narrow < 1) {
    throw new Error(`Expected manifest.screenshots to contain at least one form_factor 'wide' and one 'narrow' entry; got ${JSON.stringify(shots.map((s) => s.form_factor ?? '(no form_factor)'))}`);
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

  // 2. Start HTTP server - the ONE shared static server (airhorn-yxxq), under the real
  // Pages headers, with this suite's two behaviours expressed as the route hook: taking the
  // origin down for real, and the sw.js version override. no-store is the shared default
  // (the integrity stages need healed re-fetches to reach the origin).
  const { server, port } = await serveDist({
    dir: distDir,
    headers: 'auto',
    extraHeaders: { 'Service-Worker-Allowed': '/' },
    route: (pathname, req) => {
      if (originState.down) return { destroy: true };
      if (pathname === '/sw.js' && swVersionOverride) {
        let content = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf-8');
        content = content.replace(/airhorner-2\.0\.0-[a-zA-Z0-9_-]+/g, `airhorner-${swVersionOverride}`);
        content = content.replace(/const version = "[^"]+"/g, `const version = "${swVersionOverride}"`);
        return { body: content, contentType: 'application/javascript' };
      }
    },
  });
  console.log(`Server listening on port ${port}`);

  // 3. Launch Chrome (the gate's shared one when it offers a page)
  const browser = await launchBrowser({ label: 'sw-offline', timeoutMs: 15000 });
  const pageWsUrl = browser.pageWsUrl;

  const ws = new WebSocket(pageWsUrl);
  // Bounded (airhorn-eabw): an unbounded onopen await parks the suite if the
  // socket never opens; this also rejects on error/close so the refusal is named.
  // The rejection fires before the try/finally below owns the browser and server,
  // so close both here or the fast failure leaks them (reaper evidence on
  // airhorn-eabw).
  try {
    await awaitSocketOpen(ws, { url: pageWsUrl });
  } catch (err) {
    await browser.close();
    server.close();
    throw err;
  }

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

  // Bounded condition wait (airhorn-iwf): a fixed sleep made every run pay the
  // WORST case. Polling to the SAME deadline pays only the time actually needed
  // and keeps the failure window identical, so no assertion gets a shorter
  // deadline. Returns the truthy value (or the last falsy one) so callers keep
  // their existing assertions.
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
  const pageReady = () => evaluate(`document.readyState === 'complete' && !!document.querySelector('.horn')`);
  const readAsset = (url) => evaluate(`fetch(${JSON.stringify(url)})
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .catch((e) => ({ status: 0, body: '', error: String(e && e.message || e) }))`);
  const healedOk = (r) => r.status === 200 && r.body.length > 1000 && !r.body.includes(GARBAGE);
  const waitHealed = (url, timeoutMs) => waitUntil(async () => {
    const r = await readAsset(url);
    return healedOk(r) ? r : null;
  }, timeoutMs);

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

    // Wait for service worker to register and activate. Poll the registration
    // STATE instead of awaiting navigator.serviceWorker.ready: ready only ever
    // settles when a worker activates, so a FAILED install (e.g. a precache
    // refusal) would hang the CDP awaitPromise forever - an install that never
    // completes must fail as itself, named, not hang the suite.
    console.log('Waiting for Service Worker activation...');
    let swActive = false;
    let lastSwState = 'none';
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `navigator.serviceWorker.getRegistration().then(reg => !reg ? 'unregistered' : reg.active ? reg.active.state : (reg.installing ? 'installing' : (reg.waiting ? 'waiting' : 'no-worker')))`,
        awaitPromise: true,
        returnByValue: true
      });
      lastSwState = String(res.result.value);
      if (lastSwState === 'activated') {
        swActive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!swActive) {
      throw new Error(`Service Worker failed to activate within 6s (last registration state: ${lastSwState}) - check the worker console for the install's named refusal`);
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

    // Both shell spellings are precached, and that is not redundancy to be tidied
    // away (airhorn-btt): `/` is what a navigation matches, and storing the
    // navigation response is how an emptied cache re-seeds itself from one online
    // visit - tests/sw-failover.test.mjs stage D fails without it. `/index.html` is
    // what an in-page fetch and the worker's navigation fallback ask for. A storage
    // audit measured the pair at 11,962 B of a 86,537 B precache; dropping one
    // half is a regression, not a saving.
    for (const shellPath of ['/', '/index.html']) {
      assert(cachedUrls.includes(shellPath),
        `the precache must hold both shell spellings (${JSON.stringify(cachedUrls)})`);
    }

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

    // Verify offline load succeeded and DOM is fully functional. This used to sleep a
    // fixed 1000 ms and then assert: on a loaded host the reload plus the worker-served
    // parse takes longer than a second, and the suite failed with hornPresent:false on a
    // page that had simply not been built yet (airhorn-wqge: observed at 57.9% steal).
    // Wait for the document to say it is ready, as a CONDITION.
    const readOffline = async () => {
      const r = await send('Runtime.evaluate', {
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
      return r.result.value;
    };
    // A reload destroys the execution context, so an evaluate can fail outright while the
    // new document boots - waitForCondition retries those, which is exactly the case here.
    const off = await waitForCondition(async () => {
      const seen = await readOffline();
      return seen && seen.hornPresent && seen.hornAriaLabel === 'Air horn' ? seen : null;
    }, { label: 'the offline page to load with its horn' });

    console.log('Offline evaluation result:', off);
    // The condition above IS the offline-load assertion: it only returns `seen` when the
    // horn is present and labelled, and waitForCondition throws at its bound naming what
    // it observed. Re-testing those two fields here was unreachable code (airhorn-auoa).
    // The service-worker check below is a separate claim and does bite.
    if (!off.swController) {
      throw new Error('Offline page not controlled by service worker');
    }

    // airhorn-yrpg (review finding on airhorn-xnd1): the boot watchdog can only
    // report a blocked bundle if the watchdog ITSELF was served, and xnd1 makes
    // it an external file (/boot-watchdog.js) instead of an inline block - so an
    // offline load is the first place it can go missing with no other symptom:
    // the shell renders from cache, the horn is there, and a dead bundle is
    // silent. The two globals read below are authored by the watchdog ALONE, so
    // their presence after an offline reload is proof the worker served and
    // executed it. The precache LIST is pinned separately (tests/csp.test.js:
    // entry, build digest, and airhorn-lu8a's refusal of an uncovered path);
    // this is the browser-level half the bead's CHANGE section asked for.
    //
    // Two rules, both learned from airhorn-sdzb, and one correction to the FIRST
    // attempt at this case (which read the state once, after readyState):
    //   - wait on a page STATE, never the clock - the same fact the app itself
    //     settles, not a sleep that happens to be long enough;
    //   - the wait PERSISTS (a one-shot read is the sdzb defect: it reports a
    //     value that simply had not arrived yet as a missing one), and
    //   - when it gives up, it fails BY NAME, because a bare bound expiring
    //     cannot tell a slow host from a page that never got its script.
    // readOfflineScripts() is that state read; the wait below is support/poll.mjs's
    // one policy (WAIT_TIMEOUT_MS, the suite's existing bound), and the named
    // throw is what turns its expiry into a verdict that says which world it is in.
    const readOfflineScripts = () => evaluate(`(() => ({
      announce: typeof window.__airhornAnnounce,
      booted: typeof window.__airhornBooted,
      sheetSwapped: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .some((l) => l.media === 'all' && /\\/styles\\/main\\.css$/.test(l.href)),
      sheetMedia: (document.querySelector('link[rel="stylesheet"]') || {}).media || null,
    }))()`);

    // Classification reads the LAST OBSERVED poll result, never a fresh read. A second read
    // after the bound looks obvious and is wrong: if the state settles in the milliseconds
    // between the last failed poll and that read, the read comes back HEALTHY, neither named
    // branch matches, and the fall-through calls a page that reported perfectly
    // "unreadable" - a misnamed verdict in the exact race this wait exists to handle
    // (airhorn-6r6y, reproduced by the reviewer with an instrumented run). Capturing the
    // observation inside the check means the state classified IS the state at expiry.
    let offlineScripts;
    let lastSeen = null;
    let lastReadError = null;
    try {
      offlineScripts = await waitForCondition(async () => {
        try {
          const seen = await readOfflineScripts();
          lastSeen = seen;
          lastReadError = null;
          return seen.announce === 'function' && seen.booted === 'function' && seen.sheetSwapped ? seen : null;
        } catch (err) {
          // A torn-down context mid-navigation is not a verdict on the page; keep polling.
          lastReadError = err;
          return null;
        }
      }, { label: 'the offline page to have executed its boot watchdog and swapped the stylesheet' });
    } catch (err) {
      // Name the world the LAST OBSERVATION was in, not the one a later read guesses at.
      if (lastSeen && lastSeen.announce === 'function' && lastSeen.booted === 'function' && lastSeen.sheetSwapped) {
        throw new Error('offlineScriptsSettledLate: the offline page reported a healthy script state but the wait '
          + `still expired (${JSON.stringify(lastSeen)}); the poll and the observation disagree, which is a defect in `
          + 'this case, not in the page (airhorn-6r6y)');
      }
      if (lastSeen && (lastSeen.announce !== 'function' || lastSeen.booted !== 'function')) {
        throw new Error('offlineWatchdogMissing: the boot watchdog did not execute on the offline page '
          + `(__airhornAnnounce=${lastSeen.announce}, __airhornBooted=${lastSeen.booted}). An offline load whose watchdog `
          + 'is missing cannot report a blocked bundle - the page would look alive and say nothing '
          + '(airhorn-yrpg, airhorn-xnd1)');
      }
      if (lastSeen && !lastSeen.sheetSwapped) {
        throw new Error('offlineSheetLoaderMissing: the main stylesheet never left media=print on the offline page '
          + `(media=${lastSeen.sheetMedia}); /async-css.js was not served or did not run (airhorn-yrpg, airhorn-xnd1)`);
      }
      throw new Error('offlineScriptsUnreadable: the offline page never reported its script state'
        + (lastReadError ? ` (last read failed: ${lastReadError.message})` : '') + ' (airhorn-yrpg)');
    }
    console.log('Offline scripts verified:', offlineScripts);

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

    // Wait for the new service worker to install, activate and finish its cache
    // cleanup - as a CONDITION, not as a 1500 ms window. Under load the install,
    // the activate handler and its deletions all land after a fixed sleep, and the
    // suite then reported a legacy cache that was about to be deleted as surviving
    // (airhorn-sesh: measured at load 14, sw-offline only).
    const afterKeys = await waitForCondition(async () => {
      const keysResult = await send('Runtime.evaluate', {
        expression: `caches.keys()`,
        awaitPromise: true,
        returnByValue: true
      });
      const keys = keysResult.result.value;
      return Array.isArray(keys) && keys.includes('airhorner-2.0.0-build2') && !keys.includes('airhorner-0.7.1') ? keys : null;
      // 60 s, not the shared 15 s default: this wait covers an install, an activate and the
      // activate handler's deletions, all of them on a worker thread that queues behind other
      // lanes. Measured at 16204 ms against the 15 s default on this VM, i.e. a correct worker
      // reported as a stuck one (airhorn-wqge). It stops the moment the condition holds.
    }, {
      label: 'the activated worker to install its cache and delete the legacy one',
      timeout: 60000,
    });
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

    // The real bundle bytes, captured while the origin is still up (airhorn-g0qr2). Stage B below
    // has to tell "the worker served the real asset" apart from "the worker served something", and
    // a byte comparison against this is the only form of that a wrong-but-nonempty body cannot pass.
    const onlineAsset = await readAsset(assetUrl);
    assert(healedOk(onlineAsset),
      `the asset did not read back online before the integrity stages: ${JSON.stringify(onlineAsset)}`);

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
    // the worker precaches and what an in-page fetch asks for. Both are load
    // bearing (airhorn-btt) - see the note where the precache is verified above.
    for (const shellPath of ['/', '/index.html']) {
      assert(await corrupt(shellPath, `<!doctype html><title>garbage</title>${GARBAGE}`, 'text/html') === 'corrupted',
        `could not corrupt the cached ${shellPath}`);
    }
    await send('Page.reload');
    await waitUntil(pageReady, 1200);

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

    const offlineShell = await waitUntil(pageReady, 1000);
    assert(offlineShell, 'the shell should still render offline (only the asset entry was corrupted)');

    const offlineAsset = await evaluate(`fetch(${JSON.stringify(assetUrl)})
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, error: String(e && e.message || e) }))`);
    // POSITIVE EVIDENCE, NOT A NEGATIVE STRING COMPARISON (airhorn-g0qr2). This used to read
    // `offlineAsset.body !== GARBAGE`, which is satisfied by an EMPTY body and by any 503 - i.e. by
    // "nothing at all" - so a worker that returned nothing offline passed the one assertion that
    // exists to prove it refuses bytes it cannot vouch for. The worker has exactly two legitimate
    // outcomes here, and each is now required to carry evidence that it is that outcome:
    //   - the real verified asset, BYTE-IDENTICAL to what the cache held while online; or
    //   - the intended refusal: status 503 carrying the worker's own sentence in the body.
    // Anything else - empty, a bare 503, a wrong-but-nonempty body, or the corrupted bytes - is RED.
    const REFUSAL = 'The Air Horner could not load this part of itself.';
    const servedRealAsset = offlineAsset.status === 200 && offlineAsset.body === onlineAsset.body;
    const refusedOnPurpose = offlineAsset.status === 503
      && typeof offlineAsset.body === 'string'
      && offlineAsset.body.includes(REFUSAL);
    assert(servedRealAsset || refusedOnPurpose,
      'offline, the corrupted asset neither came back as the real cached bundle nor as the worker\'s '
      + `intended refusal - it must not be served without evidence of what it is: ${JSON.stringify({
        status: offlineAsset.status,
        bodyLength: typeof offlineAsset.body === 'string' ? offlineAsset.body.length : null,
        bodyHead: typeof offlineAsset.body === 'string' ? offlineAsset.body.slice(0, 120) : null,
        error: offlineAsset.error,
        onlineBodyLength: onlineAsset.body.length,
      })}`);
    assert(!(typeof offlineAsset.body === 'string' && offlineAsset.body.includes(GARBAGE)),
      `the corrupted asset was served from the cache offline: ${JSON.stringify(offlineAsset)}`);
    console.log(`Corrupted asset refused offline: status ${offlineAsset.status}`
      + `${servedRealAsset ? ' (real verified bundle)' : ' (intended refusal body)'}.`);

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

    const healed = (await waitHealed(assetUrl, 1200)) || await readAsset(assetUrl);
    assert(healed.status === 200, `the asset did not come back after healing: ${JSON.stringify(healed)}`);
    assert(healed.body.length > 1000 && !healed.body.includes(GARBAGE),
      'the "healed" asset is still not the real bundle');

    // Re-corrupt and load again: a one-shot repair that then trusts everything
    // would pass A and C above but fail here.
    assert(await corrupt(assetUrl, GARBAGE, 'application/javascript') === 'corrupted',
      'could not re-corrupt the asset');
    await send('Page.reload');
    const secondHeal = (await waitHealed(assetUrl, 1200)) || await readAsset(assetUrl);
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
    await browser.close();
    server.close();
  }
}

testSwAndManifest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
