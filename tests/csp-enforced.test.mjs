/*
 * tests/csp-enforced.test.mjs — the page boots with the policy ACTUALLY ENFORCED
 * (airhorn-xnd1).
 *
 * tests/csp.test.js pins the artifact (the header, the hash, no inline script);
 * that says what we serve. This suite says what a browser DOES with it: dist/ is
 * served with the shipped public/_headers block applied to every response, and
 * the page is driven in headless Chrome under it.
 *
 *   A. The healthy page under the policy: the sheet's media swaps to 'all' and
 *      main.css really styles the document, the horn press reaches the audio
 *      buffer, and there are ZERO policy violations. A positive control then
 *      inserts an inline script - inline/attribute execution was the whole reason
 *      the policy was withheld - and asserts it is blocked with a violation that
 *      names script-src. Without that control, "no violations" would only prove
 *      the header was ignored.
 *   B. With the module bundle blocked, the BOOT WATCHDOG still reveals - so the
 *      watchdog's extraction (it was inline) did not cost the page its one
 *      failure surface.
 *   C. The negative control the pin depends on: with a loader that never swaps
 *      media, the page is left with the critical layer only and media stays
 *      'print'. That is the failure this whole change exists to prevent, and it
 *      is measured here rather than described - if the shipped loader stopped
 *      swapping, case A would go red the same way.
 *   D. The third surface's own failure: a stylesheet that never arrives leaves
 *      media at 'print' (no sheet to swap), marks the page .stylesheet-failed
 *      and reveals the horn label. This is the silent failure the inline
 *      onerror attribute used to cover, and the loader only reaches it after a
 *      deferred start - a measured branch, not an assumed one.
 *
 * The worker is stubbed (a no-op) like the other browser suites: the REAL worker
 * would precache dist/ and serve it from cache, which would make B and C
 * unobservable - the point is what the network copy does under the policy.
 *
 * Case names are emitted as `##case##` lines for the gate's report hook.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen, boundCommand } from './cdp-command-bound.mjs';
import { waitForCondition, WAIT_TIMEOUT_MS, sleep } from './support/poll.mjs';
import { parsePagesHeaders } from '../tools/lib/static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = '/tmp/airhorn-csp';

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

/** The headers public/_headers applies to `/*`, as a plain object.
 *
 * Parsed by the SHIPPED parser (tools/lib/static-server.mjs), not by a second copy of the
 * Pages subset: `/*` is the all-paths PATTERN, `#` is the comment and there is no block
 * terminator, so a local guess at "comment syntax" is how this suite and the header drifted
 * apart once already (airhorn-xnd1). The parser refuses anything outside the subset by name. */
function readHeaderBlock(headersFile) {
  const headers = parsePagesHeaders(fs.readFileSync(headersFile, 'utf8'));
  if (!headers['Content-Security-Policy']) {
    throw new Error(`${headersFile} applies no Content-Security-Policy to /*: this suite would prove nothing`);
  }
  return headers;
}

/** An inline script the page inserts; the policy must refuse to run it. */
const INLINE_PROBE = 'window.__inlineRan = true;';

// Recorded before any page script runs: violations the policy reports, and a
// count of audio buffers decoded (the horn's own path, not a proxy for it).
const PAGE_PROBE = `
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push({ directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI });
});
window.__audio = { decoded: 0 };
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const decode = AC.prototype.decodeAudioData;
  AC.prototype.decodeAudioData = function (...args) {
    window.__audio.decoded += 1;
    return decode.apply(this, args);
  };
})();
`;

async function run() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) throw new Error('dist directory does not exist. Run build first.');
  const headers = readHeaderBlock(path.join(distDir, '_headers'));
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // What each navigation is served. The REAL files are the default; a case opts
  // into a mutant and the next navigation gets it.
  const mode = { loader: 'real', bundle: 'real', styles: 'real' };
  const realLoader = fs.readFileSync(path.join(distDir, 'async-css.js'), 'utf8');
  // The swap is what makes main.css apply. Removing it leaves the page on the
  // critical layer with media at 'print' - the exact failure mode of an inline
  // onload attribute under script-src 'self'.
  const mutantLoader = realLoader.replace("if (link.media !== 'all') link.media = 'all';", '/* mutant: media swap removed */');
  if (mutantLoader === realLoader) {
    throw new Error('could not build the negative control: async-css.js no longer contains the media swap this case removes');
  }

  let mp3Requests = 0;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (status, type, body) => {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      if (body !== undefined) res.end(body);
    };

    // The other suites' stub: a real worker would answer from its own cache.
    if (url === '/sw.js') {
      send(200, 'application/javascript',
        'self.addEventListener("install", () => self.skipWaiting());\n'
        + 'self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));\n');
      return;
    }
    if (url === '/async-css.js' && mode.loader === 'no-swap') {
      send(200, 'application/javascript', mutantLoader);
      return;
    }
    // A blocked module bundle: the fetch fails, which is what a filter or proxy
    // looks like to the page - and what the watchdog is for.
    if (mode.bundle === 'blocked' && url.startsWith('/assets/')) {
      send(404, 'text/plain', 'blocked by this case');
      return;
    }
    // A stylesheet that never arrives: the failure the CSP made silent (the
    // inline onerror attribute), and the one the loader's deferred verdict has
    // to reach without an error event it was present for.
    if (mode.styles === 'blocked' && url === '/styles/main.css') {
      send(404, 'text/plain', 'blocked by this case');
      return;
    }
    if (url === '/sounds/airhorn.mp3') mp3Requests += 1;

    let filePath = path.join(distDir, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(filePath)) {
      send(404, 'text/plain', 'Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    send(200, mimeTypes[path.extname(filePath)] || 'application/octet-stream', fs.readFileSync(filePath));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  let browser = null;
  try {
    browser = await launchBrowser({ autoplay: true, label: 'csp-enforced', timeoutMs: 20000, discoveryMs: 40000 });
    const ws = new WebSocket(browser.pageWsUrl);
    try {
      await awaitSocketOpen(ws, { url: browser.pageWsUrl });
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
        consoleErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
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
      return boundCommand({ method, pending, id, fire: () => ws.send(JSON.stringify({ id, method, params })) });
    };
    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (res.exceptionDetails) {
        throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
      }
      return res.result.value;
    };
    const waitUntil = (expression, label) => waitForCondition(async () => Boolean(await evaluate(expression)), {
      label,
      timeout: WAIT_TIMEOUT_MS,
      observe: () => evaluate(expression),
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_PROBE });

    const navigate = async (label) => {
      await send('Page.navigate', { url: `${origin}/?case=${label}` });
      await waitUntil('document.readyState === "complete"', `${label}: document load`);
    };

    // ---------------------------------------------------------------- case A
    console.log('##case## A: the healthy page boots with the policy enforced');
    mode.loader = 'real';
    mode.bundle = 'real';
    mp3Requests = 0;
    await navigate('a');

    await waitUntil('document.getElementById("main-css").media === "all"', 'the sheet switches from media=print to all');
    const media = await evaluate('document.getElementById("main-css").media');
    console.log(`   #main-css media is now ${media}`);

    // main.css really applies: overscroll-behavior is declared by main.css alone
    // (the critical layer must not carry it - tests/csp.test.js pins that), so it
    // is 'none' only when the swapped-in sheet styles the document.
    await waitUntil('getComputedStyle(document.body).overscrollBehaviorY === "none"',
      'main.css to style the document (body overscroll-behavior from the real sheet)');
    const sheet = await evaluate(`({
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
      sheets: [...document.styleSheets].map((s) => s.href),
    })`);
    console.log(`   body overscroll-behavior=${sheet.overscroll}; sheets=${JSON.stringify(sheet.sheets)}`);
    if (!sheet.sheets.some((href) => href && href.endsWith('/styles/main.css'))) {
      throw new Error(`the main sheet is not in the document's styleSheets: ${JSON.stringify(sheet.sheets)}`);
    }

    // No violations on the healthy path, and the boot banner stayed quiet (a
    // watchdog that fires on a healthy page is its own defect).
    const healthy = await evaluate('({ violations: window.__cspViolations, bannerHidden: document.getElementById("boot-failure").hidden })');
    if (healthy.violations.length > 0) {
      throw new Error(`the shipped policy reported violations on the healthy page: ${JSON.stringify(healthy.violations)}`);
    }
    if (!healthy.bannerHidden) throw new Error('the boot-failure banner is visible on a healthy page');
    console.log('   no policy violations, no boot banner');

    // Positive control: the policy is ENFORCED, not merely present. An inline
    // script is what script-src 'self' exists to refuse, and the violation names
    // the directive.
    await evaluate(`(() => {
      const script = document.createElement('script');
      script.textContent = ${JSON.stringify(INLINE_PROBE)};
      document.head.appendChild(script);
    })()`);
    await waitUntil('window.__cspViolations.length > 0', 'a violation for the inline-script probe');
    const blocked = await evaluate('({ ran: window.__inlineRan === true, violations: window.__cspViolations })');
    if (blocked.ran) throw new Error('an inline script RAN under the shipped policy: the header is not being enforced');
    if (!blocked.violations.some((v) => /script-src/.test(v.directive))) {
      throw new Error(`the inline-script probe was blocked without naming script-src: ${JSON.stringify(blocked.violations)}`);
    }
    console.log(`   inline script refused by ${blocked.violations.map((v) => v.directive).join(', ')}`);

    // The horn still sounds: a real pointer press reaches the audio path (the
    // buffer is fetched under connect-src 'self' and decoded) - the app is
    // hydrated and usable, not merely styled.
    const box = await evaluate(`(() => {
      const r = document.querySelector('.horn').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const press = (type) => send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    await press('mousePressed');
    await waitUntil('window.__audio.decoded > 0', 'the horn to decode its sample');
    await press('mouseReleased');
    const decoded = await evaluate('window.__audio.decoded');
    console.log(`   horn press decoded ${decoded} buffer(s); ${mp3Requests} mp3 request(s) reached the server`);
    if (mp3Requests < 1) throw new Error('the horn decoded a buffer the server never served: that decode was not the app');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'a-healthy-under-csp.png'), Buffer.from(shot.data, 'base64'));

    // ---------------------------------------------------------------- case B
    console.log('##case## B: a blocked module bundle still reveals the boot watchdog');
    mode.bundle = 'blocked';
    await navigate('b');
    await waitUntil('document.getElementById("boot-failure").hidden === false',
      'the boot watchdog to reveal the failure banner for a blocked bundle');
    const watchdogCopy = await evaluate('document.getElementById("boot-failure").textContent.trim()');
    console.log(`   banner shown: ${JSON.stringify(watchdogCopy.slice(0, 60))}`);
    const shotB = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'b-watchdog-under-csp.png'), Buffer.from(shotB.data, 'base64'));

    // ---------------------------------------------------------------- case C
    console.log('##case## C: a loader that never swaps media leaves the page unstyled (the pin can fail)');
    mode.bundle = 'real';
    mode.loader = 'no-swap';
    await navigate('c');
    // The load event has fired (document complete), so a loader that swaps has
    // already done it. Give a bounded grace for the swap it no longer performs.
    await sleep(300);
    const mutant = await evaluate(`({
      media: document.getElementById("main-css").media,
      failed: document.documentElement.classList.contains('stylesheet-failed'),
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
      sheetLoaded: Boolean(document.getElementById("main-css").sheet),
      sheetRules: (() => { try { const s = document.getElementById("main-css").sheet; return s ? s.cssRules.length : -1; } catch (e) { return -1; } })(),
    })`);
    console.log(`   media=${mutant.media} stylesheet-failed=${mutant.failed} overscroll=${mutant.overscroll} sheet=${mutant.sheetLoaded} rules=${mutant.sheetRules}`);
    // The loader is deferred, so it runs AFTER a load event may already have
    // fired, and it decides that case from the sheet's own state. The state it
    // reads is "rules", not "link.sheet": a loaded media=print sheet exposes
    // its rules, and (measured separately) a sheet whose fetch FAILED exposes a
    // non-null empty shell whose cssRules access throws. If a loaded sheet
    // exposed no rules, the verdict could not tell loaded from failed and the
    // deferred loader would be guessing.
    if (!mutant.sheetRules || mutant.sheetRules < 1) {
      throw new Error(`a loaded media=print sheet exposes ${mutant.sheetRules} CSS rules (sheet=${mutant.sheetLoaded}), which is what the deferred loader reads to tell loaded from failed`);
    }
    if (mutant.media !== 'print') {
      throw new Error(`with the media swap removed the sheet still left print: media=${mutant.media} - case A's swap assertion would pass on a page that swapped by itself, so the pin is not measuring the loader`);
    }
    if (mutant.overscroll === 'none') {
      throw new Error('main.css applied even though media stayed at print: the sheet is applied regardless of media, so the media swap assertion proves nothing');
    }

    // ---------------------------------------------------------------- case D
    console.log('##case## D: a stylesheet that never arrives still reveals the labelled fallback');
    mode.loader = 'real';
    mode.bundle = 'real';
    mode.styles = 'blocked';
    await navigate('d');
    // The loader is deferred, so the error event may have been dispatched before
    // it ran; the failed state is declared from the DOM (a sheet with no rules)
    // at window load. Wait for the contract, not for a clock.
    await waitUntil('document.documentElement.classList.contains("stylesheet-failed")',
      'the failed-sheet state for a stylesheet that never arrived');
    const fallback = await evaluate(`({
      media: document.getElementById("main-css").media,
      labelVisible: document.querySelector(".horn-label").getClientRects().length > 0,
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
    })`);
    console.log(`   media=${fallback.media} labelVisible=${fallback.labelVisible} overscroll=${fallback.overscroll}`);
    if (!fallback.labelVisible) {
      throw new Error('the page marked the sheet failed but the horn label is still hidden: the labelled-unstyled contract never fires');
    }
    if (fallback.overscroll === 'none') {
      throw new Error('main.css is applied even though the server never served it');
    }
    const shotD = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'd-stylesheet-blocked.png'), Buffer.from(shotD.data, 'base64'));

    const fatal = consoleErrors.filter(Boolean);
    if (fatal.length > 0) throw new Error(`uncaught page errors: ${JSON.stringify(fatal)}`);

    console.log('THE PAGE BOOTS UNDER THE SHIPPED POLICY, AND THE PIN MEASURES THE LOADER');
    console.log(`evidence: ${EVIDENCE_DIR}`);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
