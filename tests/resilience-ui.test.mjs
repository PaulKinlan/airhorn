import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = '/tmp/airhorn-boot-watchdog';

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

// Drives the built app (dist/) in headless Chrome over raw CDP and verifies
// the failure-state messaging surfaces from airhorn-quk and airhorn-8nz, plus
// the review findings airhorn-d5q, airhorn-duj, airhorn-21k and airhorn-5yv:
//   1. healthy boot never shows the boot-failure banner, and the status
//      region stays empty (no false positive, silence in the normal case);
//   2. a blocked module bundle (filter/proxy) reveals the banner + retry;
//   3. a corrupt module body (cache poisoning) reveals the banner;
//   4. with scripting disabled the <noscript> notice is visible;
//   5. dropping the connection announces it, restoring announces that;
//   6. a service worker update over an existing controller announces
//      itself - including the installing phase (d5q) - then the page
//      updates (existing mechanics, unchanged);
//   7. with the stylesheet blocked the horn stays a labelled, full-size
//      button, honest about the installer, and install is reachable once
//      the prompt is available (5yv);
//   8. a bundle that arrives late retires a shown banner (duj);
//   9. a bundle that executes and then throws during setup still gets the
//      banner (21k: the boot marker only fires when the app is usable);
//  10. a successful update never announces a failure, and
//  11. a dropped upgrade IS announced - the lost-upgrade copy the page owns
//      rather than the worker (airhorn-swq, airhorn-906).
// Screenshots land in /tmp/airhorn-boot-watchdog/ as evidence.
async function testBootWatchdog() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const swV1 = '// resilience-ui suite: no-op service worker stub v1\n' +
    'self.addEventListener("install", (e) => self.skipWaiting());\n' +
    'self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));\n';
  const swV2 = swV1.replace('v1', 'v2');
  let swBody = swV1;

  const server = http.createServer((req, res) => {
    const reqUrl = req.url.split('?')[0];
    // The page registers /sw.js unconditionally; serve a no-op stub that
    // claims clients but caches and intercepts nothing, so the update case
    // (case 6) has a controller to update over and every other case still
    // hits the network (or CDP interception). The test mutates swBody to
    // publish a byte-different v2 for reg.update() to find.
    if (reqUrl === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(swBody);
      return;
    }
    let filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const chromeBin = process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

  const profileDir = '/tmp/chrome-boot-watchdog-profile-' + Date.now();
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
  let fetchHold = false; // when set, paused requests are held until released
  const heldRequests = [];
  const fulfillBody = (requestId, bodyText) => {
    ws.send(JSON.stringify({
      id: msgId++,
      method: 'Fetch.fulfillRequest',
      params: {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
        body: Buffer.from(bodyText).toString('base64'),
      },
    }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId } = msg.params;
      if (fetchHold) {
        heldRequests.push(requestId);
        return;
      }
      fulfillBody(requestId, 'this is not javascript %%');
      return;
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

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  };

  // Like evaluate, but waits for the expression's promise to settle - for
  // page-side async work whose COMPLETION the next step depends on (an
  // unregister that races the next navigation is not a teardown).
  const evaluateAwaited = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluateAwaited failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  };

  // Poll a page expression until truthy. Evaluation errors (context not yet
  // ready mid-navigation) are retried, not fatal.
  const waitUntil = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      if (Date.now() > deadline) {
        let last = null;
        try { last = await evaluate(expression); } catch {}
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label} (last value: ${last})`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  };

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(EVIDENCE_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    console.log(`  evidence: ${file}`);
  };

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
        // Journal of everything the one polite live region has said, kept in
        // sessionStorage so it survives the service-worker-update reload.
        // This runs at document start, before the region exists, so attach
        // the observer once the DOM has it.
        window.__hadControllerAtParse = !!navigator.serviceWorker.controller;
        window.__statusLog = JSON.parse(sessionStorage.getItem('__statusLog') || '[]');
        const hookRegion = () => {
          const region = document.getElementById('app-status');
          if (!region) return;
          new MutationObserver(() => {
            if (!region.textContent) return;
            window.__statusLog.push(region.textContent);
            sessionStorage.setItem('__statusLog', JSON.stringify(window.__statusLog));
          }).observe(region, { childList: true, characterData: true, subtree: true });
        };
        if (!hookRegion()) {
          document.addEventListener('DOMContentLoaded', hookRegion);
        }
      `
    });

    // --- Case 1: healthy boot must stay silent --------------------------------
    console.log('--- Case 1: healthy boot, banner must stay hidden');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot');
    // Painted invisibility is the assertion, not the hidden attribute: the
    // card's own display value once beat the UA [hidden] rule (caught by the
    // noscript screenshot), so check layout and computed display.
    const bannerHiddenExpr = `(() => {
      const el = document.getElementById('boot-failure');
      return el.hidden === true && el.getClientRects().length === 0
        && getComputedStyle(el).display === 'none';
    })()`;
    if ((await evaluate(bannerHiddenExpr)) !== true) {
      throw new Error('Boot-failure banner visible on a healthy boot');
    }
    // The one polite live region must exist but say nothing on a healthy,
    // connected boot: rendered (so changes are announced) yet visually
    // hidden while empty.
    const status = await evaluate(`(() => {
      const el = document.getElementById('app-status');
      return {
        present: !!el,
        role: el ? el.getAttribute('role') : null,
        empty: !!el && el.textContent === '',
        // The :empty rule applies the visually-hidden pattern; an empty
        // region still yields a 1px client rect, so check the clip.
        visuallyHidden: !!el && getComputedStyle(el).clipPath === 'inset(50%)',
      };
    })()`);
    if (!status.present || status.role !== 'status') {
      throw new Error(`status region missing or wrong role: ${JSON.stringify(status)}`);
    }
    if (!status.empty || !status.visuallyHidden) {
      throw new Error(`status region not silent on a healthy boot: ${JSON.stringify(status)}`);
    }
    // The watchdog arms on load + 2s grace; wait past the grace and re-check.
    await new Promise(r => setTimeout(r, 3500));
    if ((await evaluate(bannerHiddenExpr)) !== true) {
      throw new Error('Boot-failure banner appeared after the grace period on a healthy boot');
    }
    if ((await evaluate(`window.__pageErrors.length`)) !== 0) {
      throw new Error(`Unexpected page errors on healthy boot: ${JSON.stringify(await evaluate('window.__pageErrors'))}`);
    }
    console.log('  healthy boot: no banner, no errors');

    // --- Case 2: blocked module bundle ----------------------------------------
    console.log('--- Case 2: module bundle blocked (filter/proxy)');
    await send('Network.setBlockedURLs', { urls: ['*assets/*.js', '*src/main.js*'] });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 10000, 'blocked-bundle banner to appear');
    const blocked = await evaluate(`(() => {
      const banner = document.getElementById('boot-failure');
      const retry = document.getElementById('boot-retry');
      return {
        role: banner.getAttribute('role'),
        text: banner.textContent.trim(),
        retryPresent: !!retry && !retry.disabled,
        hornPresent: !!document.querySelector('.horn'),
        booted: typeof window.__airhorn !== 'undefined',
        noscriptVisible: (() => {
          const el = document.querySelector('noscript .boot-alert');
          return !!el && el.getClientRects().length > 0;
        })(),
      };
    })()`);
    if (blocked.role !== 'alert') throw new Error(`banner role: ${JSON.stringify(blocked.role)}`);
    if (!/silent/i.test(blocked.text)) throw new Error(`banner text does not explain the failure: ${JSON.stringify(blocked.text)}`);
    if (!blocked.retryPresent) throw new Error('retry button missing or disabled');
    if (!blocked.hornPresent) throw new Error('horn missing from the blocked page');
    if (blocked.booted) throw new Error('window.__airhorn exists although the bundle was blocked');
    if (blocked.noscriptVisible) throw new Error('noscript notice visible while JavaScript runs');
    await shot('blocked-bundle');
    console.log('  blocked bundle: banner + retry shown, horn present, app not booted');
    await send('Network.setBlockedURLs', { urls: [] });

    // --- Case 3: corrupt module body (cache poisoning equivalent) -------------
    console.log('--- Case 3: module bundle served corrupt');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Request' }] });
    // Every paused request is fulfilled with a corrupt body by the
    // Fetch.requestPaused branch in onmessage above.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 10000, 'corrupt-bundle banner to appear');
    const corrupt = await evaluate(`(() => ({
      booted: typeof window.__airhorn !== 'undefined',
      retryPresent: !!document.getElementById('boot-retry') && !document.getElementById('boot-retry').disabled,
    }))()`);
    if (corrupt.booted) throw new Error('window.__airhorn exists although the bundle was corrupt');
    if (!corrupt.retryPresent) throw new Error('retry button missing on corrupt bundle');
    await shot('corrupt-bundle');
    console.log('  corrupt bundle: banner shown, app not booted');
    await send('Fetch.disable');

    // --- Case 4: scripting disabled -> noscript notice -------------------------
    console.log('--- Case 4: JavaScript disabled, noscript notice');
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 1500));
    const noscript = await evaluate(`(() => {
      const el = document.querySelector('noscript .boot-alert');
      const banner = document.getElementById('boot-failure');
      return {
        present: !!el,
        visible: !!el && el.getClientRects().length > 0,
        text: el ? el.textContent.trim() : null,
        bannerPaintedAway: !banner || (banner.getClientRects().length === 0
          && getComputedStyle(banner).display === 'none'),
      };
    })()`);
    if (!noscript.present) throw new Error('noscript notice missing from the DOM with scripting disabled');
    if (!noscript.visible) throw new Error('noscript notice not visible with scripting disabled');
    if (!/JavaScript/i.test(noscript.text)) throw new Error(`noscript text does not mention JavaScript: ${JSON.stringify(noscript.text)}`);
    if (!noscript.bannerPaintedAway) throw new Error('boot-failure banner painted although it carries hidden and no JS can reveal it');
    await shot('noscript');
    console.log('  noscript: notice visible, explains JavaScript requirement');
    await send('Emulation.setScriptExecutionDisabled', { value: false });

    // --- Case 5: offline and back online ---------------------------------------
    console.log('--- Case 5: connection drops and returns');
    // Fresh navigation so main.js (with its listeners) runs: the noscript
    // page above never executed any script.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await waitUntil(`window.__statusLog.some(m => /no connection/i.test(m))`, 5000, 'offline notice');
    await shot('offline-notice');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitUntil(`window.__statusLog.some(m => /back online/i.test(m))`, 5000, 'back-online notice');
    console.log('  offline/online: both transitions announced');

    // --- Case 6: service worker update over an existing controller -------------
    console.log('--- Case 6: service worker update');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot before update');
    if ((await evaluate(`!!navigator.serviceWorker.controller`)) !== true) {
      throw new Error('stub SW did not claim the page; the update case needs a controller');
    }
    swBody = swV2;
    // Fire and forget: reg.update() is polled below, not awaited here.
    await evaluate(`navigator.serviceWorker.getRegistration().then(reg => reg.update())`);
    await waitUntil(`window.__statusLog.some(m => /new version|updating/i.test(m))`, 10000, 'update notice');
    // airhorn-d5q: the 'Updating...' notice must actually fire - at
    // updatefound the worker is already 'installing', so the announcement
    // happens outside the statechange listener.
    await waitUntil(`window.__statusLog.some(m => /updating/i.test(m))`, 5000, 'installing-phase notice');
    const updateMsgs = await evaluate(`window.__statusLog.filter(m => /new version|updating/i.test(m))`);
    console.log('  update notice(s):', JSON.stringify(updateMsgs));
    // airhorn-swq: a SUCCESSFUL update replaces the old worker, whose
    // statechange listener then sees 'redundant'. That must never produce
    // the failure copy - only a never-installed worker is a lost upgrade.
    const falseFailure = await evaluate(`window.__statusLog.filter(m => /could not update/i.test(m))`);
    if (falseFailure.length > 0) {
      throw new Error(`successful update announced a failure: ${JSON.stringify(falseFailure)}`);
    }
    await shot('update-notice');
    // The page updates itself via the existing controllerchange reload; wait
    // for v2 to be the active controller, then confirm the fresh page boots
    // and is silent again.
    await waitUntil(`navigator.serviceWorker.controller
      && navigator.serviceWorker.controller.state === 'activated'`, 15000, 'v2 to activate');
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot after update');
    if ((await evaluate(`document.getElementById('app-status').textContent`)) !== '') {
      throw new Error('status region not empty on the freshly updated page');
    }
    swBody = swV1; // hygiene for any later navigation
    console.log('  update: announced, v2 activated, page healthy and quiet again');

    // --- Case 7: stylesheet blocked -> intrinsic, labelled, honest --------------
    console.log('--- Case 7: stylesheet blocked');
    await send('Network.setBlockedURLs', { urls: ['*styles/*.css', '*assets/*.css'] });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot unstyled');
    const unstyled = await evaluate(`(() => {
      const horn = document.querySelector('.horn');
      const r = horn.getBoundingClientRect();
      const label = document.querySelector('.horn-label');
      const installer = document.getElementById('installer');
      const h1 = document.querySelector('h1');
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        labelText: label ? label.textContent.trim() : null,
        labelVisible: !!label && label.getClientRects().length > 0,
        installerGone: !!installer && installer.getClientRects().length === 0,
        // The critical fallback hides the installer only while the prompt is
        // unavailable (airhorn-5yv): once beforeinstallprompt has fired (it
        // does fire in headless Chrome - this page has a manifest) and
        // main.js adds .available, the button must be reachable. Either way
        // the page must be honest about which state it is in.
        installerHonest: (() => {
          const i = document.getElementById('installer');
          const cs = getComputedStyle(i);
          return i.classList.contains('available')
            ? (cs.visibility === 'visible' && cs.pointerEvents !== 'none')
            : (cs.visibility === 'hidden' && cs.pointerEvents === 'none');
        })(),
        h1Hidden: !!h1 && getComputedStyle(h1).clipPath === 'inset(50%)',
      };
    })()`);
    if (unstyled.w < 200 || unstyled.h < 200) {
      throw new Error(`horn collapsed without CSS: ${unstyled.w}x${unstyled.h}`);
    }
    if (!unstyled.labelVisible || !/air horn/i.test(unstyled.labelText || '')) {
      throw new Error(`horn label not visible without CSS: ${JSON.stringify(unstyled)}`);
    }
    if (!unstyled.installerHonest) throw new Error('install button neither honestly hidden nor reachable without CSS');
    if (!unstyled.h1Hidden) throw new Error('visually-hidden heading showed as prose without CSS');
    // And the unstyled horn still sounds: the failure this replaces was a
    // page that looked broken but passed a naive usability check.
    await evaluate(`document.querySelector('.horn').click()`);
    await waitUntil(`document.querySelector('.horn').getAttribute('aria-pressed') === 'true'`, 3000, 'unstyled horn to sound');
    // airhorn-5yv: the critical fallback hides the installer, but must not
    // lock install away in the very mode it protects - once the prompt is
    // available the button is reachable even unstyled.
    const installReachable = await evaluate(`(() => {
      const installer = document.getElementById('installer');
      const button = installer.querySelector('button');
      // Enable via the real beforeinstallprompt path (airhorn-fld): the
      // button is disabled at parse, and a bare classList.add would leave it
      // unfocusable - the check below asserts focusability.
      window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
        prompt() {}, userChoice: Promise.resolve({ outcome: 'accepted' }),
      }));
      const cs = getComputedStyle(installer);
      button.focus();
      return {
        visible: cs.visibility === 'visible',
        clickable: cs.pointerEvents !== 'none',
        focusable: document.activeElement === button,
      };
    })()`);
    if (!installReachable.visible || !installReachable.clickable || !installReachable.focusable) {
      throw new Error(`install unreachable unstyled even with .available: ${JSON.stringify(installReachable)}`);
    }
    await shot('blocked-css');
    console.log(`  blocked CSS: horn ${unstyled.w}x${unstyled.h}, labelled, installer hidden until .available, still sounds`);
    await send('Network.setBlockedURLs', { urls: [] });

    // --- Case 8: a slow bundle arriving late retires the banner (airhorn-duj) ---
    console.log('--- Case 8: slow bundle arrives after the banner');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Request' }] });
    fetchHold = true;
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 30 && heldRequests.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (heldRequests.length === 0) throw new Error('module request was never held; cannot test the late bundle');
    // Force the watchdog's arm without sitting out the ~14s backstop: the
    // synthetic load event runs the same arm -> grace -> show chain.
    await evaluate(`window.dispatchEvent(new Event('load'))`);
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 8000, 'banner while the bundle stalls');
    // The late bundle executes and the app becomes usable - the page must
    // take back its claim that the horn could not start.
    for (const id of heldRequests.splice(0)) fulfillBody(id, 'window.__airhornBooted && window.__airhornBooted();');
    fetchHold = false;
    await waitUntil(`document.getElementById('boot-failure').hidden === true
      && document.getElementById('boot-failure').getClientRects().length === 0`, 5000, 'banner to retire on the late boot');
    await send('Fetch.disable');
    await shot('late-bundle-retires-banner');
    console.log('  slow bundle: banner revealed while stalled, retired when the app booted');

    // --- Case 9: the bundle executes but fails during setup (airhorn-21k) -------
    console.log('--- Case 9: bundle executes then throws during setup');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Request' }] });
    fetchHold = true;
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 30 && heldRequests.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    // Valid JS that throws: an execution failure fires no `error` event on
    // the module element, and post-21k the boot marker only fires once the
    // app is usable - so only the watchdog's arm+grace can speak.
    for (const id of heldRequests.splice(0)) fulfillBody(id, 'const x = 1; throw new Error("setup boom");');
    fetchHold = false;
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 12000, 'banner for a bundle that ran and failed');
    const stillDead = await evaluate(`typeof window.__airhorn === 'undefined'`);
    if (!stillDead) throw new Error('app booted although the bundle threw during setup');
    await send('Fetch.disable');
    console.log('  setup throw: banner shown, app unbooted (marker only fires when usable)');

    // --- Case 10: a successful update must never announce failure (airhorn-swq) --
    console.log('--- Case 10: successful update, no false failure notice');
    // The reviewer's repro: the FIRST generation's worker keeps its
    // statechange listener; when a successful update replaces it, it hears
    // 'redundant' while a controller exists. To observe that deterministically
    // (the usual update page reloads itself via controllerchange and can die
    // before the event), run a whole update generation on a page that cannot
    // reload: unregister, reload so no controller exists at parse, then
    // update - every event lands on this living page.
    await evaluateAwaited(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    })()`);
    // The old worker dies with its last client (this page); give the browser
    // a beat to drop the registration before the fresh navigation.
    await new Promise(r => setTimeout(r, 500));
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'fresh page to boot (v1 generation)');
    if ((await evaluate(`window.__hadControllerAtParse`)) !== false) {
      throw new Error('expected a page with no controller at parse for the no-reload update generation');
    }
    swBody = swV2;
    await evaluate(`navigator.serviceWorker.getRegistration().then(reg => reg.update())`);
    await waitUntil(`window.__statusLog.some(m => /new version is ready/i.test(m))`, 10000, 'successful update to complete');
    await new Promise(r => setTimeout(r, 1500)); // let the replaced worker settle
    const falseFailures = await evaluate(`window.__statusLog.filter(m => /could not update/i.test(m))`);
    if (falseFailures.length > 0) {
      throw new Error(`successful update announced a failure: ${JSON.stringify(falseFailures)}`);
    }
    swBody = swV1;
    await shot('successful-update-no-failure');
    console.log('  swq: successful update announced progress only - no failure copy');

    // --- Case 11: a lost upgrade is announced by the page itself (airhorn-906) --
    console.log('--- Case 11: a dropped upgrade announces itself');
    // The lost-upgrade copy is AUTHORED on this page: #app-status plus the
    // inline registration handler next to it. The only suite asserting it used
    // to be sw-failover stage D, which airhorn-iwf took off the index.html row
    // for cost - so a one-line edit to this branch was green on the page's own
    // fast-gate row and red only in a suite that row no longer selected
    // (airhorn-906). This case lives in a suite the page row DOES select, so
    // the branch is covered where it is authored. The real worker's own
    // quota-denied upgrade stays sw-failover's job (public/sw.js row).
    await waitUntil('!!navigator.serviceWorker.controller', 10000, 'a controller to update over');
    const controllerBefore = await evaluate(`navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL`);
    // An install that is denied, the way a failed precache write denies one.
    // A byte-different body is enough for reg.update() to start a new worker;
    // the failing install is what drives it to 'redundant' without ever
    // reaching 'installed'.
    swBody = '// resilience-ui suite: an upgrade whose install is denied (quota)\n' +
      'self.addEventListener("install", (e) => {\n' +
      '  e.waitUntil(Promise.reject(new DOMException("The quota has been exceeded.", "QuotaExceededError")));\n' +
      '});\n' +
      'self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));\n';
    await evaluate(`navigator.serviceWorker.getRegistration()
      .then((reg) => reg.update()).then(() => true).catch(() => false)`);
    await waitUntil(`window.__statusLog.some((m) => /app could not update/i.test(m))`,
      10000, 'the lost-upgrade announcement');
    const lost = await evaluate(`(() => {
      const region = document.getElementById('app-status');
      return {
        text: (region && region.textContent || '').trim(),
        controlled: !!navigator.serviceWorker.controller,
        controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
      };
    })()`);
    swBody = swV1;
    await shot('lost-upgrade-announced');
    // The page owns this copy (index.html, inline registration handler); assert
    // it literally, so a reworded notice is a red test rather than a quietly
    // still-passing regex. gate-smoke reads both strings and pins them to the
    // page (airhorn-906).
    for (const copy of ['The app could not update', 'previous version']) {
      if (!lost.text.includes(copy)) {
        throw new Error(`the lost-upgrade notice is missing "${copy}": ${JSON.stringify(lost.text)}`);
      }
    }
    if (/new version is ready/i.test(lost.text)) {
      throw new Error(`a dropped upgrade announced a successful update: ${JSON.stringify(lost.text)}`);
    }
    if (!lost.controlled || lost.controller !== controllerBefore) {
      throw new Error(`a dropped upgrade replaced the worker: ${JSON.stringify({ lost, controllerBefore })}`);
    }
    console.log(`  lost upgrade reported: "${lost.text}" (still on the previous worker)`);

    console.log('ALL RESILIENCE-UI CHECKS PASSED!');
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

testBootWatchdog().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
