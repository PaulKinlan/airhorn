import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen, boundCommand } from './cdp-command-bound.mjs';
import { WAIT_TIMEOUT_MS } from './support/poll.mjs';

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
  // v2 announces ITS OWN activation to the page ("sw-v2-active"): a
  // version-true completion signal for case 10. The controller alone cannot
  // serve as one - the page self-registers swV1 during its boot, so a
  // controller exists before any update is requested (airhorn-j72n,
  // airhorn-0p88 by a new route) - and the page's announcement chain cannot
  // serve as one either, because its latency tracks box load (airhorn-bogq,
  // airhorn-twlb: the union gate failed on exactly that).
  const swV2 = swV1.replace('v1', 'v2') +
    'self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim().then(() => ' +
    'self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage("sw-v2-active"))))));\n';
  let swBody = swV1;

  // The suite times its healthy-boot assertion off the page's own watchdog
  // grace (arm on load, reveal after this many ms). Read it from the built
  // page so the suite follows the page instead of carrying a stale copy of
  // the constant; if the watchdog's shape changes and the constant can no
  // longer be found, this suite fails loudly rather than guessing.
  const graceMatch = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')
    .match(/setTimeout\(show,\s*(\d+)\)/);
  if (!graceMatch) {
    throw new Error('boot watchdog grace not found in dist/index.html; the healthy-boot case times itself off it');
  }
  const WATCHDOG_GRACE_MS = Number(graceMatch[1]);

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

  const browser = await launchBrowser({ label: 'resilience-ui', timeoutMs: 15000 });
  const pageWsUrl = browser.pageWsUrl;

  const ws = new WebSocket(pageWsUrl);
  // Bounded (airhorn-2q3m): an unbounded `await new Promise(r => ws.onopen = r)` is
  // the command-bound defect one step earlier - nothing in the suite exists yet, so
  // none of its deadlines can fire, and a socket that neither opens nor errors parks
  // the suite for the rest of the gate. It also rejects on error/close, so a socket
  // the browser refused says so instead of hanging to the gate bound.
  // The rejection fires BEFORE the try/finally below exists, so close the browser
  // and server here or the fast failure leaks them (reaper killed just such an
  // orphaned chrome 45 min after the proof run - airhorn-eabw).
  try {
    await awaitSocketOpen(ws, { url: pageWsUrl });
  } catch (err) {
    await browser.close();
    server.close();
    throw err;
  }

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
        console.log('  held:', msg.params.request?.url);
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

  // Bounded (airhorn-uhdv): a command the browser never answers must fail and name
  // itself, instead of parking the suite until the gate bound cancels every suite
  // queued behind it - 1,092 s of a 1,200 s gate for one case. The condition polls
  // have their own bounds; this is the command's, and the composition (pending
  // entry + bound + timer cleanup) lives in cdp-command-bound.mjs so its test holds
  // the wiring rather than a copy of it.
  const send = (method, params = {}) => {
    const id = msgId++;
    return boundCommand({
      method,
      pending,
      id,
      fire: () => ws.send(JSON.stringify({ id, method, params }))
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

  // Every wait here uses support/poll.mjs's one policy - WAIT_TIMEOUT_MS, how
  // long we are willing to wait for a resource or a state, not a claim about how
  // long the app takes (airhorn-uhdv). The suite used to hardcode 5-12 s windows,
  // which is the machine-state assertion poll.mjs exists to remove: on this box a
  // single CDP round trip measured 13 s at load 10.5, so a 10 s window could be
  // one sample of a loaded renderer and the banner it was watching for had not
  // been given its chance yet. Worst case the file now waits ~15 s per case, well
  // inside the gate bound; AIRHORN_WAIT_MS raises it for a host under real load.

  // Poll a page expression until truthy. Evaluation errors (context not yet
  // ready mid-navigation) are retried, not fatal - but the LAST one is reported
  // with the timeout: when the command was bounded out (cdp-command-bound.mjs) or the
  // renderer stopped answering, "timed out waiting for X" alone does not say
  // which resource wedged, and that was the whole of what a hung case could show.
  const waitUntil = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        if (await evaluate(expression)) return;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() > deadline) {
        let last = null;
        try { last = await evaluate(expression); } catch {}
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label} (last value: ${last})`
          + (lastError ? `; last error: ${lastError.message}` : ''));
      }
      await new Promise(r => setTimeout(r, 100));
    }
  };

  // The same poll for an expression whose VALUE IS A PROMISE. waitUntil's
  // plain evaluate cannot be used for these: a pending promise is a truthy
  // object, so it would pass on the first poll without the answer arriving.
  const waitForAwait = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      let value;
      try {
        value = await evaluateAwaited(expression);
        if (value) return value;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label} (last value: ${value})`
          + (lastError ? `; last error: ${lastError.message}` : ''));
      }
      await new Promise(r => setTimeout(r, 100));
    }
  };

  // Navigate to the app and wait for the FRESH document to boot.
  //
  // Page.navigate resolves when the browser ACCEPTS the navigation, not when
  // the new document commits (airhorn-ie0b, airhorn-byl0), and every case here
  // navigates to the SAME url - so on this origin the previous document already
  // defines window.__airhorn and a bare boot wait passes INSTANTLY on it. The
  // probe that follows then lands in the fresh document mid-parse, where the
  // DOM the case queries does not exist yet, and the case fails with a null
  // dereference that says nothing about the app (Case 7 lost a green run this
  // way at 47% steal).
  //
  // Mark the outgoing document, so the marker's absence can only mean a
  // document that started after the marker was set; require the boot signal
  // too, so the wait cannot end mid-parse (__airhorn comes from the deferred
  // bundle, which cannot have run before the parse completes). Case 8 does
  // this by hand; this is the same guard for every other navigation.
  const navigateFresh = async (label, booted = 'typeof window.__airhorn !== "undefined"') => {
    // Only a page that has booted can steal the wait, so only a page that has
    // booted needs marking - and there, failing to mark it is fatal: an
    // unmarked previous document is exactly the race this exists to close.
    if (await evaluate('typeof window.__airhorn !== "undefined"').catch(() => false)) {
      const marked = await evaluate('window.__outgoingDocument = true; 1').catch(() => false);
      if (!marked) throw new Error(`${label}: could not mark the outgoing document before navigating`);
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!window.__outgoingDocument && (${booted})`, WAIT_TIMEOUT_MS,
      `${label}: a fresh document to commit and boot`);
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
        // The v2 generation announces its own activation ("sw-v2-active"), and
        // case 10 gates on that announcement. Record it from document START, in
        // a fresh window per navigation, so the announcement can never be
        // posted into a void: attaching the listener after reg.update() lost it
        // whenever the page's own boot registration (index.html) was the
        // generation that installed v2 - the page installs /sw.js itself, so on
        // a loaded box its fetch can land after the suite publishes the v2 body
        // and activate before the test is listening (airhorn-ye54: server-side
        // request logs show the failing signature [v1, v2, v2] - the page's own
        // v2 install plus the update's v2 fetch - against [v1, v1, v2] for the
        // 1.0-1.2s passes; forced 3/3 by publishing v2 before the navigation,
        // and never once the boot registration had settled).
        window.__v2active = false;
        if (navigator.serviceWorker) {
          navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data === 'sw-v2-active') window.__v2active = true;
          });
        }
        // Case 7 asserts that the unstyled horn RESPONDS. The attribute it used
        // to read is owned by the app and is not a stable state there:
        // main.js sets aria-pressed optimistically and RETRACTS it when the
        // audio start does not complete, and whether it completes is decided by
        // main.js's own 100ms race with AudioContext.resume() - which is what a
        // loaded box changes (airhorn-ye54: the slmt-only union gate lost this
        // wait at 3s while idle runs, and 5 runs of the slmt-only tree, saw
        // 'true' in 9-34ms; under load the tap hint appeared and the first
        // sample moved to 46-83ms). Record the transition from document start
        // so the assertion is about the event that happened, never about a
        // sample landing inside a window the app owns.
        // airhorn-uhdv: if a trusted press never reaches the app, the ONLY
        // question worth asking is whether the event arrived at all. Record every
        // pointer/mouse event at document start (capture phase, so nothing can
        // swallow it before it is seen) and the case reports this on a miss.
        window.__inputLog = [];
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click']) {
          document.addEventListener(type, (e) => {
            const t = e.target;
            window.__inputLog.push(type + ':button=' + e.button + ':target=' + (t?.className || t?.tagName));
          }, true);
        }
        window.__pressedLog = [];
        const hookHorn = () => {
          const horn = document.querySelector('.horn');
          if (!horn) return false;
          window.__pressedLog.push(horn.getAttribute('aria-pressed'));
          new MutationObserver(() => {
            window.__pressedLog.push(horn.getAttribute('aria-pressed'));
          }).observe(horn, { attributes: true, attributeFilter: ['aria-pressed'] });
          return true;
        };
        if (!hookHorn()) {
          document.addEventListener('DOMContentLoaded', hookHorn);
        }
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
    await navigateFresh('case 1');
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
    // The pre-swap/styled geometry contract (airhorn-fgvq): #airhorn must
    // fill the viewport in BOTH frames. It used to shrink-wrap the horn before
    // the async sheet landed (219px wide at a 780px viewport) and become full
    // width when the sheet applied - the page's only layout shift, measured at
    // CLS 0.3599 on 5 of 6 loads, attributed to div#airhorn. Case 7 pins the
    // unstyled frame; this pins the styled one, so the two cannot drift again.
    const airhornBoxExpr = `(() => {
      const r = document.getElementById('airhorn').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
    })()`;
    const styledBox = await evaluate(airhornBoxExpr);
    // Tolerance covers a classic scrollbar, not a shrink-wrap: the defect this
    // guards was 219px against 780px.
    if (styledBox.w < styledBox.vw - 20 || styledBox.h < styledBox.vh - 20) {
      throw new Error(`styled #airhorn does not fill the viewport: ${JSON.stringify(styledBox)}`);
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
    // The watchdog arms on load and reveals after its grace; wait until the
    // page's own timeline says the grace has fully elapsed, measured from the
    // page's load event (not a fudge sleep), then assert silence. Same
    // assertion, same lower bound on page time - just no arbitrary margin.
    await waitUntil(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return !!nav && nav.loadEventEnd > 0 &&
        performance.now() - nav.loadEventEnd >= ${WATCHDOG_GRACE_MS} + 250;
    })()`, WATCHDOG_GRACE_MS + 8000, 'watchdog grace to elapse past the page\'s load event');
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
    await waitUntil(`!document.getElementById('boot-failure').hidden`, WAIT_TIMEOUT_MS, 'blocked-bundle banner to appear');
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
    await waitUntil(`!document.getElementById('boot-failure').hidden`, WAIT_TIMEOUT_MS, 'corrupt-bundle banner to appear');
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
    // The notice is static HTML: wait for it to actually render instead of
    // sleeping a fixed margin past it.
    await waitUntil(`(() => {
      const el = document.querySelector('noscript .boot-alert');
      return !!el && el.getClientRects().length > 0;
    })()`, WAIT_TIMEOUT_MS, 'noscript notice to render');
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
    await navigateFresh('case 5');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await waitUntil(`window.__statusLog.some(m => /no connection/i.test(m))`, WAIT_TIMEOUT_MS, 'offline notice');
    await shot('offline-notice');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitUntil(`window.__statusLog.some(m => /back online/i.test(m))`, WAIT_TIMEOUT_MS, 'back-online notice');
    console.log('  offline/online: both transitions announced');

    // --- Case 6: service worker update over an existing controller -------------
    console.log('--- Case 6: service worker update');
    await navigateFresh('case 6');
    if ((await evaluate(`!!navigator.serviceWorker.controller`)) !== true) {
      throw new Error('stub SW did not claim the page; the update case needs a controller');
    }
    swBody = swV2;
    // Fire and forget: reg.update() is polled below, not awaited here.
    await evaluate(`navigator.serviceWorker.getRegistration().then(reg => reg.update())`);
    await waitUntil(`window.__statusLog.some(m => /new version|updating/i.test(m))`, WAIT_TIMEOUT_MS, 'update notice');
    // airhorn-d5q: the 'Updating...' notice must actually fire - at
    // updatefound the worker is already 'installing', so the announcement
    // happens outside the statechange listener.
    await waitUntil(`window.__statusLog.some(m => /updating/i.test(m))`, WAIT_TIMEOUT_MS, 'installing-phase notice');
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
      && navigator.serviceWorker.controller.state === 'activated'`, WAIT_TIMEOUT_MS, 'v2 to activate');
    await waitUntil('typeof window.__airhorn !== "undefined"', WAIT_TIMEOUT_MS, 'app to boot after update');
    if ((await evaluate(`document.getElementById('app-status').textContent`)) !== '') {
      throw new Error('status region not empty on the freshly updated page');
    }
    swBody = swV1; // hygiene for any later navigation
    console.log('  update: announced, v2 activated, page healthy and quiet again');

    // --- Case 7: stylesheet blocked -> intrinsic, labelled, honest --------------
    console.log('--- Case 7: stylesheet blocked');
    await send('Network.setBlockedURLs', { urls: ['*styles/*.css', '*assets/*.css'] });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', WAIT_TIMEOUT_MS, 'app to boot unstyled');
    const unstyled = await evaluate(`(() => {
      const horn = document.querySelector('.horn');
      const r = horn.getBoundingClientRect();
      const label = document.querySelector('.horn-label');
      const lr = label ? label.getBoundingClientRect() : null;
      const inner = document.querySelector('.horn .inner');
      const ir = inner ? inner.getBoundingClientRect() : null;
      const installer = document.getElementById('installer');
      const h1 = document.querySelector('h1');
      const airhorn = document.getElementById('airhorn');
      const ar = airhorn ? airhorn.getBoundingClientRect() : null;
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        // airhorn-fgvq: the frame before the sheet lands must already be the
        // STYLED frame's geometry (a viewport-filling #airhorn), or the swap
        // shifts the only element on the page by 0.3599 CLS.
        airhornW: ar ? Math.round(ar.width) : 0,
        airhornH: ar ? Math.round(ar.height) : 0,
        viewportW: innerWidth,
        viewportH: innerHeight,
        labelText: label ? label.textContent.trim() : null,
        labelVisible: !!label && label.getClientRects().length > 0,
        // airhorn-e18: the pre-swap frame must be the designed horn -
        // .inner a concentric square disc, never a second grid row's
        // squashed ellipse, and the label never inside the horn body.
        innerSquare: !!ir && Math.abs(ir.width - ir.height) <= 2,
        innerConcentric: !!ir && Math.abs((ir.left + ir.width / 2) - (r.left + r.width / 2)) <= 2
          && Math.abs((ir.top + ir.height / 2) - (r.top + r.height / 2)) <= 2,
        innerRatio: !!ir ? Math.round((ir.width / r.width) * 100) : 0,
        labelBelowHorn: !!lr && !!r && lr.top >= r.bottom - 2,
        // airhorn-e18 second-order: while unavailable the installer must be
        // out of flow, or the pre-swap frame carries dead height that
        // collapses when the sheet lands. Pinned as a CSSOM contract (not a
        // live-position probe) because the natural beforeinstallprompt can
        // legitimately have fired before this probe runs - once it has, the
        // installer is supposed to be reachable below the fold.
        installerOutOfFlowRule: (() => {
          for (const sheet of document.styleSheets) {
            if (sheet.href) continue;
            const walk = rules => {
              for (const rule of rules) {
                if (rule.cssRules && rule.cssRules.length) { const hit = walk(rule.cssRules); if (hit) return hit; }
                if (rule.selectorText && rule.selectorText.includes('#installer:not(.available)')
                  && rule.style && rule.style.getPropertyValue('position') === 'absolute') return true;
              }
              return false;
            };
            if (walk(sheet.cssRules)) return true;
          }
          return false;
        })(),
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
    // airhorn-e18: unstyled must mean the designed horn, not a squashed one.
    if (!unstyled.innerSquare || !unstyled.innerConcentric || unstyled.innerRatio !== 80) {
      throw new Error(`pre-swap horn malformed (airhorn-e18): ${JSON.stringify(unstyled)}`);
    }
    if (!unstyled.labelBelowHorn) throw new Error(`label inside the horn body pre-swap: ${JSON.stringify(unstyled)}`);
    if (!unstyled.installerOutOfFlowRule) throw new Error(`critical layer no longer takes the unavailable installer out of flow: ${JSON.stringify(unstyled)}`);
    // And the unstyled horn still responds: the failure this replaces was a
    // page that looked broken but passed a naive usability check. The press is
    // a TRUSTED one (Input.dispatchMouseEvent), not element.click(): a
    // synthetic click carries no user activation, so the audio graph may stay
    // suspended, main.js honestly retracts the pressed state, and whether that
    // retraction beats this wait's first sample is a function of box load -
    // not of the unstyled page working (airhorn-ye54). The wait reads the
    // document-start record of the transition, so no sample can miss it.
    const hornBox = await evaluate(`(() => {
      const horn = document.querySelector('.horn');
      // Unstyled, the page is tall prose and the control can sit below the fold,
      // where a trusted press at its coordinates lands on nothing at all
      // (airhorn-uhdv: the press then never reached the app and the case failed
      // only as a 15 s timeout with no cause). Centre it first, and report what
      // is actually at the press point so a miss names itself.
      horn.scrollIntoView({ block: 'center' });
      const r = horn.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        overHorn: !!hit && !!hit.closest('.horn'),
        hit: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : null,
        viewport: [innerWidth, innerHeight],
        top: Math.round(r.top),
        height: Math.round(r.height),
        found: !!horn
      };
    })()`);
    if (!hornBox.found || !hornBox.overHorn) {
      throw new Error(`the press point is not over the horn, so the press would prove nothing: ${JSON.stringify(hornBox)}`);
    }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hornBox.x, y: hornBox.y, button: 'left', buttons: 1, clickCount: 1 });
    // WAIT_TIMEOUT_MS, not a 3 s window (airhorn-uhdv): the bound is how long we
    // are willing to wait for the record to show the transition, and on this box
    // a single CDP round trip measured 13 s at load 10.5 - a 3 s window is two
    // samples of a loaded renderer, i.e. a machine-state assertion, which is what
    // airhorn-ye54 already fought here once. Nothing about the unstyled page is
    // being given more room: the press either reaches the document-start record
    // or it does not, and a slow box may only take longer to say so.
    try {
      await waitUntil(`window.__pressedLog.includes('true')`, WAIT_TIMEOUT_MS, `unstyled horn to respond to a trusted press at ${hornBox.x},${hornBox.y} (viewport ${hornBox.viewport.join('x')}, control top ${hornBox.top})`);
    } catch (err) {
      // A miss has to say which of the two things failed: the press never
      // arriving (input log empty) or the app not recording the transition
      // (input present, pressed log unchanged). airhorn-uhdv.
      const diag = await evaluate(`(() => ({
        input: window.__inputLog || null,
        pressed: window.__pressedLog || null,
        activation: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
        booted: typeof window.__airhorn,
        focused: document.hasFocus(),
        visibility: document.visibilityState
      }))()`);
      throw new Error(`${err.message}; press diagnostics ${JSON.stringify(diag)}`);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hornBox.x, y: hornBox.y, button: 'left', buttons: 0, clickCount: 1 });
    // The release must retire the hold - the record carries the transition, so
    // this cannot be missed by a slow sample either.
    await waitUntil(`window.__pressedLog.lastIndexOf('false') > window.__pressedLog.lastIndexOf('true')`,
      WAIT_TIMEOUT_MS, 'release to retire the unstyled hold');
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
    if (unstyled.airhornW < unstyled.viewportW - 20 || unstyled.airhornH < unstyled.viewportH - 20) {
      throw new Error(`unstyled #airhorn does not fill the viewport, so the sheet swap shifts the page: ${JSON.stringify(unstyled)}`);
    }
    await shot('blocked-css');
    console.log(`  blocked CSS: horn ${unstyled.w}x${unstyled.h}, labelled, installer hidden until .available, still sounds`);
    await send('Network.setBlockedURLs', { urls: [] });

    // --- Case 8: a slow bundle arriving late retires the banner (airhorn-duj) ---
    console.log('--- Case 8: slow bundle arrives after the banner');
    // Run the late-boot scenario on a page with NO service-worker controller.
    // The update cases (6/10) publish a byte-different worker; a page WITH a
    // controller reloads itself via controllerchange the moment that worker
    // takes over, and the fresh document's banner is hidden BY DEFAULT - the
    // 'banner retired' assertion then passes without the retirement ever
    // running. (Found by the ie0b mutation check: disabling the retirement in
    // the page left this case green; navs showed 'reload'.) Unregister first,
    // like case 10, so the only thing that can hide the banner is the boot.
    await evaluateAwaited(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    })()`);
    // The old worker dies with its last client (this page); give the browser
    // a beat to drop the registration before the fresh navigation.
    await new Promise(r => setTimeout(r, 500));
    await send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Request' }] });
    fetchHold = true;
    // Mark the outgoing document first: Page.navigate resolves when the
    // browser ACCEPTS the navigation, not when the new document commits, so
    // an evaluate sent right after it can still run in the PREVIOUS page -
    // where dispatching 'load' is a no-op on an already-booted document,
    // leaving the new page's watchdog unarmed forever (airhorn-ie0b). The
    // marker surviving proves the old context; the watchdog existing proves
    // the new one parsed its inline script.
    await evaluate(`window.__case8Outgoing = true`);
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!window.__case8Outgoing && typeof window.__airhornBooted === 'function'`,
      WAIT_TIMEOUT_MS, 'case 8 navigation to commit a fresh document');
    for (let i = 0; i < 30 && heldRequests.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (heldRequests.length === 0) throw new Error('module request was never held; cannot test the late bundle');
    // Force the watchdog's arm without sitting out the ~14s backstop: the
    // synthetic load event runs the same arm -> grace -> show chain.
    await evaluate(`window.dispatchEvent(new Event('load'))`);
    try {
      await waitUntil(`!document.getElementById('boot-failure').hidden`, WAIT_TIMEOUT_MS, 'banner while the bundle stalls');
    } catch (err) {
      // On timeout, say WHICH invariant broke: the app booting early (a cache
      // hit bypassing the interception) reads differently from the watchdog
      // never arming, and the two have opposite fixes.
      const state = await evaluate(`(() => ({ booted: typeof window.__airhorn !== 'undefined', bannerHidden: document.getElementById('boot-failure')?.hidden }))()`).catch((e) => String(e));
      throw new Error(`${err.message} (post-timeout state: ${JSON.stringify(state)})`);
    }
    // The late bundle executes and the app becomes usable - the page must
    // take back its claim that the horn could not start.
    for (const id of heldRequests.splice(0)) fulfillBody(id, 'window.__airhornBooted && window.__airhornBooted();');
    fetchHold = false;
    await waitUntil(`document.getElementById('boot-failure').hidden === true
      && document.getElementById('boot-failure').getClientRects().length === 0`, WAIT_TIMEOUT_MS, 'banner to retire on the late boot');
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
    await waitUntil(`!document.getElementById('boot-failure').hidden`, WAIT_TIMEOUT_MS, 'banner for a bundle that ran and failed');
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
    await navigateFresh('case 10 v1 generation');
    if ((await evaluate(`window.__hadControllerAtParse`)) !== false) {
      throw new Error('expected a page with no controller at parse for the no-reload update generation');
    }
    // __statusLog survives navigation via sessionStorage, so it still holds
    // case 6's "new version is ready". Without clearing it, the wait below
    // matches that leftover on its first poll and case 10 passes without any
    // update happening at all (airhorn-0p88 / airhorn-tuuq R1,
    // mutation-verified: swBody = swV1 here still passed green).
    await evaluate(`window.__statusLog.length = 0; sessionStorage.setItem('__statusLog', '[]'); 1`);
    // Publish the v2 body only once the page's OWN boot registration has
    // settled. index.html registers /sw.js itself, so a bootstrap fetch that
    // returns after `swBody = swV2` makes the PAGE the installer of the v2
    // generation: it then announces itself from its own activate, this test's
    // reg.update() below finds nothing to install, and the wait had nothing to
    // hear (airhorn-ye54). Settling first means the only way v2 can exist is
    // the update this case asks for.
    await waitForAwait(
      `navigator.serviceWorker.getRegistration()
        .then(r => !!r && !!r.active && !r.installing && !r.waiting)
        .catch(() => false)`,
      WAIT_TIMEOUT_MS, 'the boot registration to settle before publishing v2');
    swBody = swV2;
    await evaluate(`navigator.serviceWorker.getRegistration().then(reg => reg.update())`);
    // Completion gates on a VERSION-TRUE signal from the v2 worker itself:
    // the page listens for the worker's own postMessage, which only v2's
    // activate sends. The controller cannot be the gate - the page
    // self-registers swV1 during boot, so a controller exists before the
    // update is even requested (airhorn-j72n) - and the announcement chain
    // cannot be the gate - its latency tracks box load (airhorn-bogq,
    // airhorn-twlb). The listener lives in the document-start script above, so
    // it exists before any generation can announce itself (airhorn-ye54); the
    // announcement is still observed and logged, and the swq false-failure
    // check still polices its copy.
    await waitUntil('window.__v2active', WAIT_TIMEOUT_MS,
      'the v2 worker itself to report active and claiming (version-true ground truth)');
    const announcement = await evaluate(`window.__statusLog.filter(m => /new version is ready/i.test(m))`);
    console.log('  swq: v2 active and claiming; announcement chain so far:', JSON.stringify(announcement));
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
    await waitUntil('!!navigator.serviceWorker.controller', WAIT_TIMEOUT_MS, 'a controller to update over');
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
      WAIT_TIMEOUT_MS, 'the lost-upgrade announcement');
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
    await browser.close();
    server.close();
  }
}

testBootWatchdog().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
