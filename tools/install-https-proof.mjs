/*
 * install-https-proof.mjs — prove PWA installability over a REAL HTTPS origin
 * (airhorn-c4n). Run AFTER `npm run build`:
 *
 *   node tools/install-https-proof.mjs [--out preview/https]
 *
 * What it does, in one headless Chrome (fresh profile, closed in finally):
 *
 *   1. Generates a self-signed certificate with openssl (per run, temp dir).
 *   2. Serves dist/ twice on 127.0.0.1 under the hostname `airhorn.test`
 *      (mapped to 127.0.0.1 with --host-resolver-rules, so nothing is written
 *      to /etc/hosts): once over HTTP, once over HTTPS with the self-signed
 *      cert. Same server code, same built files, same hostname — the ONLY
 *      difference is the scheme, which is exactly the variable under test.
 *   3. Why airhorn.test and not localhost: Chrome treats http://localhost and
 *      http://127.0.0.1 as secure contexts, and its installability checker
 *      agrees — beforeinstallprompt DOES fire there (captured in the 8uu
 *      evidence pack). A contrast built on localhost proves nothing; a
 *      plain hostname over HTTP is a genuine insecure context.
 *   4. On each origin it collects: manifest fields, service-worker
 *      controller, the beforeinstallprompt event (with prompt()/userChoice
 *      behaviour), the Install button's real state, and a screenshot.
 *
 * Flags needed for reproducibility (documented in the output): headless
 * Chrome, --no-sandbox (rootless container), --ignore-certificate-errors
 * (self-signed cert; production would have a real chain), and
 * --host-resolver-rules for the local hostname. Nothing else.
 *
 * Exit code 0 only if the HTTPS origin fires beforeinstallprompt and enables
 * the Install button AND the HTTP contrast does not fire it.
 */

import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { sweepStaleProfiles, writeOwnerMarker } from './lib/reap.mjs';
import { connectPage, launchChrome } from './lib/chrome.mjs';
import { openRequestUrl } from './lib/request-path.mjs';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

// The bound-kill handler (airhorn-y6mi): this is the one tool of the four that
// drives a browser and never registered one, so a SIGTERM/SIGINT - fleet-gate's
// bound, a reaper's job-tree kill, Ctrl-C - killed the node process while the
// chrome tree it had launched and its /tmp profile survived (measured at
// ba2cad3: two chrome processes and one profile dir left by a group TERM). The
// group kill only reaches chrome's main process; the sweep is what finds the
// renderers that outlive it, so the launch is registered here for the handler.
let liveBrowser = null;
installSignalExit(() => {
  const browser = liveBrowser;
  liveBrowser = null;
  // killNow() is the launcher's synchronous sweep + tree kill + profile rm,
  // sized to fit the grace; the group kill only reaches chrome's main process,
  // so the sweep is what finds the renderers that outlive it (airhorn-2po9).
  browser?.killNow();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'preview/https');
const HOSTNAME = 'airhorn.test';

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

function makeSelfSignedCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert,
    '-days', '2', '-subj', `/CN=${HOSTNAME}`,
    '-addext', `subjectAltName=DNS:${HOSTNAME}`,
  ], { stdio: 'ignore' });
  // The SHA-256 hash of the certificate's Subject Public Key Info, base64
  // encoded - the pin form --ignore-certificate-errors-spki-list wants (an
  // HPKP-style key hash, not the key bytes). With the pin, Chrome treats
  // THIS origin's certificate as valid (not merely "errors ignored"), which
  // is the closest a self-signed cert gets to real HTTPS.
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der })
    .toString('base64');
  return { key, cert, spki };
}

// Exported for the browser-free proof in tests/test-support.test.js: the handler's refusal of
// a malformed escape and of an escaping path is behaviour, so it is driven over a real
// socket rather than read.
export function makeServer(distDir, tlsOptions) {
  const handler = (req, res) => {
    // A malformed percent-escape used to throw URIError here and kill the run (embargoed
    // factory finding): it is now a 400 naming the URL, the shape resilience-audit.mjs
    // already used. The containment check is the same one as before, moved into the shared
    // helper so it also covers a path that escapes the root after decoding.
    // OPEN FIRST, THEN DECIDE (airhorn-dklf): the containment answer is taken from the
    // OPENED handle, so a name re-pointed after the check cannot redirect the read.
    const served = openRequestUrl(distDir, req.url);
    if (!served.ok) { res.writeHead(served.status, { 'Content-Type': 'text/plain' }).end(served.reason); return; }
    const ext = path.extname(served.realPath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': served.size,
      'Service-Worker-Allowed': '/',
    });
    // The bytes come from the descriptor that was verified, not from the checked name.
    const stream = fs.createReadStream(null, { fd: served.fd });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// One Chrome for both origins: fresh profile, the certificate-ignoring and
// hostname-mapping flags, nothing else. Returns a cdp client bound to the
// single pre-created about:blank target; each origin navigates this page.
export async function openBrowser(extraFlags) {
  // The profile dir keeps this tool's own mkdtemp shape: sweepStaleProfiles
  // above is keyed on it, so the launcher is told the directory rather than
  // making one of its own (airhorn-2po9).
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-https-proof-'));
  let browser;
  try {
    browser = await launchChrome({
      label: 'https-proof',
      autoplay: true,
      extraFlags,
      profileDir,
      timeoutMs: 15000,
      discoveryMs: 15000,
    });
  } catch (err) {
    // A launch that never produced a handle never adopted this profile - on a
    // starved host launchChrome refuses before it spawns anything, so the rm
    // that would have run in close() never exists - and nothing else can remove
    // a directory whose owner refused to start (airhorn-w1wh review).
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
    throw err;
  }
  liveBrowser = browser;
  let ws = null;
  try {
    ws = await connectPage(browser, { label: 'https-proof', timeoutMs: 15000 });
  } catch (err) {
    // The socket never opened, so nothing downstream owns this launch.
    liveBrowser = null;
    await browser.close();
    throw err;
  }

  // Both teardowns this file used to spell out (cleanup's timer-delayed kill
  // and reapNow's synchronous spin) are the launcher's now: close() and
  // killNow() both sweep, tree-kill and rm before their first await, so a
  // caller that does not await still gets the whole teardown.
  const cleanup = () => {
    liveBrowser = null;
    try { ws?.close(); } catch {}
    // Not awaited: every caller of cleanup() is a finally or a signal path. The
    // teardown is synchronous before close()'s first await, so the reap is done
    // either way - the catch only stops a late rejection escaping the caller.
    browser.close().catch(() => { /* teardown is best-effort by design */ });
  };
  const reapNow = () => {
    liveBrowser = null;
    try { ws?.close(); } catch {}
    browser.killNow();
  };

  let msgId = 1;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
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
      // The reply wait is bounded like every wait in this file (airhorn-nbh9,
      // the class below airhorn-doek's ws-open bound): a peer that completes
      // the upgrade and then never replies rejects labelled instead of
      // parking the tool with its launch alive.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP reply timeout: ${method} got no reply within 30000ms`));
      }, 30000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  // The injection and evaluation domains must be enabled for
  // addScriptToEvaluateOnNewDocument to take effect on new documents. These
  // sends sit after the launch try/catch, so they carry their own reap: a
  // peer that completed the upgrade and swallows the replies is a launch
  // failure and must take the same synchronous teardown (airhorn-nbh9).
  try {
    await send('Page.enable');
    await send('Runtime.enable');
  } catch (err) {
    reapNow();
    throw err;
  }
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  };

  const waitFor = async (expression, timeoutMs = 20000, everyMs = 200) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try { v = await evaluate(expression); } catch { v = undefined; }
      if (v) return v;
      if (Date.now() > deadline) throw new Error('waitFor timeout: ' + expression);
      await new Promise(r => setTimeout(r, everyMs));
    }
  };
  const navigate = async url => {
    await send('Page.navigate', { url });
    await waitFor('document.readyState === "complete"', 30000);
  };
  const screenshot = async file => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(res.data, 'base64'));
    return file;
  };
  return { send, evaluate, waitFor, navigate, screenshot, cleanup };
}

// Runs one origin end to end and returns its evidence object. On the HTTP
// contrast leg the service worker CANNOT register - that is the point of the
// contrast - so the controller wait only applies to the secure origin.
async function probeOrigin(cdp, originUrl, label, expectSecure) {
  // Collect the install prompt from the first parse instant, and remember
  // exactly what the event offered. requestPrompt() needs a user gesture in
  // some Chrome versions, so it is attempted but never fatal: the FIRING of
  // the event is the proof, the button state is the page's reaction to it.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__install = { fired: false, at: 0, platforms: null, promptError: null, choice: null };
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      window.__install.fired = true;
      window.__install.at = Date.now();
      window.__install.platforms = e.platforms || null;
      e.prompt().then(() => e.userChoice.then(c => { window.__install.choice = c.outcome; }))
        .catch(err => { window.__install.promptError = String(err); });
    });
  ` });

  await cdp.navigate(originUrl);
  if (expectSecure) {
    await cdp.waitFor(`!!navigator.serviceWorker.controller`, 20000);
  } else {
    // Insecure context: give the page's SW registration attempt time to fail
    // (it must - that is the contrast), then record what the page got.
    await new Promise(r => setTimeout(r, 2500));
  }
  // Give any late prompt event and the page's Install-button reaction a beat.
  await cdp.waitFor(`window.__install.fired`, 8000).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  const ev = { origin: originUrl, label };
  ev.href = await cdp.evaluate('location.href');
  ev.installCollectorType = await cdp.evaluate(`typeof window.__install`);
  ev.secureContext = await cdp.evaluate('isSecureContext');
  ev.serviceWorkerRegistration = await cdp.evaluate(`(async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? { scope: reg.scope, state: reg.active && reg.active.state } : null;
    } catch (e) { return { error: String(e) }; }
  })()`);
  ev.serviceWorker = await cdp.evaluate(`(() => {
    // navigator.serviceWorker does not exist in insecure contexts - its
    // absence here is part of the contrast, not an error.
    if (!('serviceWorker' in navigator)) return { unavailable: 'insecure context' };
    const c = navigator.serviceWorker.controller;
    return c ? { scriptURL: c.scriptURL, state: c.state } : null;
  })()`);
  ev.manifest = await cdp.evaluate(`(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return { error: 'no manifest link' };
    const m = await (await fetch(link.href)).json();
    return {
      name: m.name, start_url: m.start_url, scope: m.scope, display: m.display,
      icons_192_512: (m.icons || []).filter(i => ['192','512'].some(s => String(i.sizes||'').includes(s))).map(i => i.sizes),
    };
  })()`);
  ev.startUrlInScope = await cdp.evaluate(`(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && reg.scope === '/';
  })()`);
  ev.installPrompt = await cdp.evaluate('window.__install');
  ev.installButton = await cdp.evaluate(`(() => {
    const wrap = document.getElementById('installer');
    if (!wrap) return null;
    const b = wrap.querySelector('button');
    if (!b) return null;
    // Read the BUTTON, never the wrapper (airhorn-nxuv.11): a wrap that is visible while the button inside it is
    // display:none, zero-sized or pointer-events:none is not an affordance, and measuring the parent made all three
    // read as fine. The rect is the only evidence that the thing would actually be painted where a user can hit it.
    const cs = getComputedStyle(b);
    const rect = b.getBoundingClientRect();
    // airhorn-0u67: paint-level evidence. The style properties above answer 'laid out and
    // clickable'; they say nothing about whether anything is PAINTED (opacity 0, a filter
    // that zeroes opacity, fully transparent colour) or whether the button is what a click
    // at its centre would actually hit (an overlay). Collect those too.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const topAtCentre = rect.width > 0 && rect.height > 0
      ? (document.elementsFromPoint(cx, cy)[0] || null) : null;
    // airhorn-iqrz (gap 1): opacity is NOT inherited, so the button's own computed opacity
    // stays '1' under a parent whose opacity is 0 - and the app hides #installer with
    // exactly that property one level up. Multiply the ANCESTOR chain above the button:
    // the product is the subtree's real paint alpha (one zero zeroes the whole subtree).
    let ancestorProduct = 1;
    let ancestorFilterProduct = 1;
    for (let n = b.parentElement; n; n = n.parentElement) {
      const ncs = getComputedStyle(n);
      ancestorProduct *= Number(ncs.opacity);
      // airhorn-5exb: a filter is not inherited either, and a filter: opacity(0) on a wrap zeroes the
      // subtree's paint while every inherited property - including opacity - still reads healthy, and
      // hit testing is unaffected. Multiply the chain's opacity() factors the same way the opacity
      // clause multiplies the chain's opacity, so the wrap-transparent defect has no road left.
      for (const m of String(ncs.filter || '').matchAll(/\\bopacity\\(\\s*([0-9.]+)\\s*\\)/g)) {
        ancestorFilterProduct *= Number(m[1]);
      }
      if (ancestorProduct === 0 && ancestorFilterProduct === 0) break;
    }
    // airhorn-iqrz (gap 2): coveredBy below answers 'an overlay covers the centre', but it
    // conflates 'the button itself was hit' with 'NOTHING was hit' - both leave it null
    // (measured: a wrap shrunk by .visually-hidden empties elementsFromPoint at the
    // button's centre while its own rect still claims 75x40). Record the boolean
    // separately so the verdict can name the empty-hit case instead of passing it.
    const hitIsButtonOrChild = !!topAtCentre && (topAtCentre === b || b.contains(topAtCentre));
    return {
      disabled: b.disabled,
      hasAvailableClass: wrap.classList.contains('available'),
      display: cs.display,
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      rect: { width: rect.width, height: rect.height },
      opacity: cs.opacity,
      ancestorOpacity: String(ancestorProduct),
      ancestorFilter: String(ancestorFilterProduct),
      filter: cs.filter,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      coveredBy: topAtCentre && topAtCentre !== b && !b.contains(topAtCentre)
        ? (topAtCentre.id ? '#' + topAtCentre.id : topAtCentre.tagName.toLowerCase()) : null,
      hitIsButtonOrChild,
      text: b.textContent.trim(),
    };
  })()`);
  ev.screenshot = await cdp.screenshot(`install-${label}.png`);
  return ev;
}

async function main() {
  if (!fs.existsSync(distDir)) throw new Error('dist/ does not exist. Run `npm run build` first.');
  // A SIGKILLed run (a fleet-gate/queue bound, the reaper, the OOM killer) runs
  // neither installSignalExit's handler nor the finally below, so its chrome
  // profile AND its cert/server temp dir stay in /tmp with no process left to
  // remove them - nothing inside a dead process can clean that up (airhorn-9gao,
  // measured: 2 profile dirs + 17 cert temp dirs from killed runs). The next run
  // sweeps them with the shared reap helper.
  //
  // What may be swept is the exact mkdtemp shape this tool creates, and never a
  // caller's --out (airhorn-13xr): a bare prefix is a name a caller can choose
  // too, and `--out /tmp/chrome-https-proof-evidence` used to be deleted with its
  // content. The helper still only removes a dir no live process names and that
  // is older than the launch window, on top of these two.
  const { swept } = sweepStaleProfiles('chrome-https-proof-', {
    pattern: /^chrome-https-proof-(?:tmp-)?[A-Za-z0-9]{6}$/, // node's mkdtemp alphabet
    exclude: [outDir],
  });
  if (swept.length) {
    console.log(`install-https-proof: swept ${swept.length} chrome-https-proof-* dir(s) left by a killed earlier run: ${swept.join(', ')}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // The cert/server temp dir shares the profile's owned prefix (chrome-https-
  // proof-*) so one stale sweep covers both, under the same mkdtemp shape.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-https-proof-tmp-'));
  // airhorn-nxuv.31: no process ever NAMES this dir on its command line, so
  // the sweep's cmdline guard could never see it as live - a concurrent run
  // deleted a running server's TLS dir after the grace window. The owner
  // marker is the liveness evidence; write it before the dir holds anything.
  writeOwnerMarker(tmp);
  let serverHttp = null;
  let serverHttps = null;
  let cdp = null;
  try {
    const { key, cert, spki } = makeSelfSignedCert(tmp);
    serverHttp = await makeServer(distDir, null);
    serverHttps = await makeServer(distDir, { key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    const httpPort = serverHttp.address().port;
    const httpsPort = serverHttps.address().port;

    // Blanket --ignore-certificate-errors is NOT enough on Chrome 155: the
    // page loads, isSecureContext is true, but the installability checker
    // still sees the invalid certificate and never fires the prompt
    // (measured; recorded in the report). Trusting the generated key via
    // spki-list is the configuration that simulates a valid certificate.
    cdp = await openBrowser([
      `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${spki}`,
    ]);

    const httpEv = await probeOrigin(cdp, `http://${HOSTNAME}:${httpPort}/`, 'http-insecure', false);
    const httpsEv = await probeOrigin(cdp, `https://${HOSTNAME}:${httpsPort}/`, 'https-selfsigned', true);

    const browserVersion = await cdp.evaluate('navigator.userAgent');

    const evidence = {
      generatedAt: new Date().toISOString(),
      hostname: HOSTNAME + ' (mapped to 127.0.0.1 via --host-resolver-rules)',
      chromeUserAgent: browserVersion,
      flagsUsed: [
        '--headless=new', '--no-sandbox', '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`,
        '--ignore-certificate-errors-spki-list=<base64 sha256 of the cert SPKI>',
        '--remote-debugging-port=0', '--user-data-dir=<fresh tmp profile>',
      ],
      flagFindings: 'Blanket --ignore-certificate-errors was measured first and does NOT fire beforeinstallprompt on this Chrome (155.0.0.0 headless): the page loads and isSecureContext is true, but the installability checker still sees the invalid certificate. Trusting the key via --ignore-certificate-errors-spki-list is required; see flagFindings fields on each leg.',
      http: httpEv,
      https: httpsEv,
    };
    fs.writeFileSync(path.join(outDir, 'install-https-evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n');

    console.log('=== Install over HTTPS proof ===');
    console.log(`  chrome: ${browserVersion}`);
    console.log(`  HTTP  ${httpEv.origin}: secureContext=${httpEv.secureContext} sw=${httpEv.serviceWorker && !httpEv.serviceWorker.unavailable && !!httpEv.serviceWorker.scriptURL} prompt=${JSON.stringify(httpEv.installPrompt)}`);
    console.log(`  HTTPS ${httpsEv.origin}: secureContext=${httpsEv.secureContext} sw=${!!httpsEv.serviceWorker} prompt=${JSON.stringify(httpsEv.installPrompt)} button=${JSON.stringify(httpsEv.installButton)}`);
    console.log(`  screenshots: ${httpEv.screenshot}, ${httpsEv.screenshot}`);

    if (!httpsEv.installPrompt.fired) throw new Error('beforeinstallprompt did NOT fire over HTTPS');
    assertInstallEvidence(httpEv, httpsEv);
    console.log('install-https-proof: PASS');
  } finally {
    liveBrowser = null; // the handle's teardown owns it now; a late signal must not repeat it
    // Synchronous reap (airhorn-nbh9): cleanup() reaps the launch before its
    // first await, so a failure that throws past the launch window still leaves
    // no chrome tree and no profile behind.
    if (cdp) cdp.cleanup();
    if (serverHttp) serverHttp.close();
    if (serverHttps) serverHttps.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Only drive the tool when this file is the entry point: the regression tests
// import openBrowser to prove a refused launch leaves no profile behind, and an
// import must not start a server. Same guard (and same reason) as
// The button-state assertions, exported so a browser-free test can drive them
// against synthetic evidence (the assertion-honesty sweep, tools/ map:
// install-https-proof :406-411/:407 - the HTTP contrast asserted only
// '!prompt fired', so an install button ENABLED over insecure HTTP landed green;
// and the HTTPS leg collected visibility/pointerEvents but never asserted them,
// so an invisible or unclickable 'enabled' button passed). The button's semantics
// come from src/install.js: disabled=true until beforeinstallprompt fires, which
// is also what adds the 'available' class - so over HTTP the honest contrast is
// 'prompt never fired AND the button stayed disabled AND never got available'.
/**
 * Why this button would not be hit by a user, or null if it would (airhorn-nxuv.11).
 *
 * A button can be present in the DOM and still be unclickable in four independent ways, and checking two of them was
 * how a display:none or zero-sized button kept passing: `visibility` stays 'visible' under display:none, and neither
 * property notices that the element has no painted box at all. Both legs use this one function so the two halves of
 * the contrast cannot drift into asking different questions again.
 */
/* airhorn-qpac: classify a computed colour's alpha. Spellings the proof supports:
 * 'transparent'; hex with an alpha channel (#RGBA / #RRGGBBAA - defensive: getComputedStyle
 * never emits hex, but the classifier must not guess); every CSS colour FUNCTION
 * (rgb/rgba, hsl/hsla, oklch, oklab, lab, lch, color(...), color-mix(...)) whose alpha is
 * the trailing '/ a' segment or last comma argument. Alpha exactly 0 -> 'transparent';
 * present and non-zero, or absent -> 'opaque'; anything else -> 'unknown' (refused by the
 * caller, never greened). Pinned per spelling in tests/test-support.test.js. */
export function classifyPaintAlpha(c) {
  if (typeof c !== 'string' || c === '') return 'unknown';
  if (c === 'transparent') return 'transparent';
  const hex = c.match(/^#([0-9a-fA-F]+)$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 4 || h.length === 8) {
      const alpha = h.length === 4 ? h[3] + h[3] : h.slice(6, 8);
      return parseInt(alpha, 16) === 0 ? 'transparent' : 'opaque';
    }
    return h.length === 3 || h.length === 6 ? 'opaque' : 'unknown';
  }
  const fn = c.match(/^([a-z-]+)\((.*)\)$/s);
  if (!fn) return 'unknown';
  if (!/^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)$/.test(fn[1])) return 'unknown';
  const body = fn[2].trim();
  const slashAlpha = body.match(/\/\s*([0-9.]+%?)\s*$/);
  if (slashAlpha) return parseFloat(slashAlpha[1]) === 0 ? 'transparent' : 'opaque';
  const commaParts = body.split(',').map((x) => x.trim());
  if (commaParts.length === 4) return parseFloat(commaParts[3]) === 0 ? 'transparent' : 'opaque';
  if (commaParts.length >= 2) return 'opaque'; // comma form with no alpha channel
  return 'opaque'; // space-separated with no '/' means no alpha channel
}

/* airhorn-0u67: what this proof owes is 'the user could see and click it'. The enumeration
 * below is the contract, one clause per way a laid-out button is not an affordance; each is
 * pinned BY NAME in tests/test-support.test.js. Known limits (recorded in
 * docs/runbooks/EVIDENCE-LIMITS.md): mix-blend-mode, an offscreen-but-
 * scrollable rect, and aria-hidden are not consulted - the first is paint trickery the
 * screenshot exists to catch by eye, the second is a layout fact the rect alone cannot judge,
 * the third is an AT contract, not a visual one. airhorn-iqrz closed the two gaps that
 * remained: an ANCESTOR's opacity (read as the product of the chain above the button) and a
 * centre hit-test that comes back EMPTY (a clip/shrink that removes the button from hit
 * testing while its rect still claims a box). */
export function affordanceProblem(btn) {
  if (btn.display === 'none') return 'display is none, so nothing is painted';
  if (btn.visibility !== 'visible') return `visibility is ${btn.visibility}`;
  if (btn.pointerEvents === 'none') return 'pointer-events is none, so a click would pass through it';
  const rect = btn.rect || {};
  if (!(Number(rect.width) > 0 && Number(rect.height) > 0)) {
    return `it has no painted box (rect ${JSON.stringify(rect)}) - zero pixels cannot be clicked`;
  }
  // Paint-level invisibility: a laid-out, clickable box that paints NOTHING.
  if (btn.opacity !== undefined && Number(btn.opacity) === 0) return 'opacity is 0, so nothing is painted';
  // airhorn-iqrz: opacity is not inherited, so the clause above cannot see an ancestor that
  // fades the whole subtree - the app hides #installer with exactly that property one level
  // up. The collector multiplies the chain above the button; at or below the same 0.05
  // floor resilience-audit.mjs treats as invisible, nothing of the button meaningfully
  // shows, so this is the opacity-0 defect by another road.
  if (btn.ancestorOpacity !== undefined && Number(btn.ancestorOpacity) <= 0.05) {
    return `an ancestor's opacity is ${btn.ancestorOpacity}, so the button's whole subtree paints (almost) nothing`;
  }
  if (typeof btn.filter === 'string' && /\bopacity\(0(\.0+)?\)/.test(btn.filter)) {
    return `filter zeroes the opacity ('${btn.filter}') - checkVisibility does not consult filters`;
  }
  // airhorn-5exb: the clause above reads the button's OWN filter. A filter on an ANCESTOR zeroes the
  // subtree's paint without being inherited and without touching hit testing, so the chain walk
  // collects its opacity() product too and it is refused here with the same 0.05 floor.
  if (btn.ancestorFilter !== undefined && Number(btn.ancestorFilter) <= 0.05) {
    return `an ancestor's filter is opacity(${btn.ancestorFilter}), so the button's whole subtree paints (almost) nothing`;
  }
  // airhorn-qpac: the transparency verdict comes from ONE classifier over the computed
  // colour string. What it cannot classify is 'unknown' - and unknown FAILS NAMED, because
  // a proof that greens a spelling it cannot read is exactly the defect this bead closed.
  const channels = [btn.color, btn.backgroundColor, btn.borderColor].filter((c) => c !== undefined);
  if (channels.length === 3) {
    const verdicts = channels.map(classifyPaintAlpha);
    if (verdicts.every((v) => v === 'transparent')) {
      return 'colour, background and border are all fully transparent - there is nothing to see';
    }
    const unknownIdx = verdicts.findIndex((v) => v === 'unknown');
    if (unknownIdx !== -1 && !verdicts.includes('opaque')) {
      return `cannot evaluate the paint spelling '${channels[unknownIdx]}' - the proof refuses to green a colour it cannot read`;
    }
  }
  if (btn.coveredBy) return `covered at its centre by ${btn.coveredBy} - a click would hit the overlay, not the button`;
  // airhorn-iqrz: the other way a centre hit-test says 'not an affordance' is when NOTHING
  // is hittable there. The collector's coveredBy cannot express that (it is null both when
  // the button was hit and when the stack was empty), so it rides on this boolean - strict
  // === false so legacy evidence without the field still passes.
  if (btn.hitIsButtonOrChild === false) {
    return `nothing is hittable at the button's centre (rect ${JSON.stringify(btn.rect || {})} claims a box there, but the engine returns no hit target) - clipped, shrunk or moved away, not an affordance`;
  }
  return null;
}

export function assertInstallEvidence(httpEv, httpsEv) {
  const httpsBtn = httpsEv.installButton;
  if (httpsBtn === null || httpsBtn === undefined || httpsBtn.disabled === null) {
    throw new Error('install button unmeasurable over HTTPS (no #installer wrap or no button in it) - cannot prove the affordance');
  }
  if (httpsBtn.disabled !== false || !httpsBtn.hasAvailableClass) {
    throw new Error('Install button not enabled over HTTPS: ' + JSON.stringify(httpsBtn));
  }
  const httpsUnusable = affordanceProblem(httpsBtn);
  if (httpsUnusable) {
    throw new Error('Install button enabled over HTTPS but not clickable/visible: ' + httpsUnusable
      + ' (visibility=' + httpsBtn.visibility + ', pointerEvents=' + httpsBtn.pointerEvents
      + ', display=' + httpsBtn.display + ', rect=' + JSON.stringify(httpsBtn.rect)
      + ') - an affordance the user cannot use');
  }
  if (httpEv.installPrompt.fired) throw new Error('the insecure-HTTP contrast fired the prompt - the contrast is invalid');
  const httpBtn = httpEv.installButton;
  if (httpBtn === null || httpBtn === undefined || httpBtn.disabled === null) {
    throw new Error('install button unmeasurable over HTTP (no #installer wrap or no button in it) - the contrast measures nothing');
  }
  // The HTTP leg collects the SAME evidence (same evaluate, same shape) so a future edit cannot measure less on one
  // side than the other and call the contrast done. Its polarity is inverted on purpose - over HTTP an enabled,
  // paintable button is the defect - so it asks the shared helper only whether the evidence exists.
  if (httpBtn.display === undefined || httpBtn.rect === undefined) {
    throw new Error('install button evidence over HTTP is incomplete (display/rect not collected): '
      + JSON.stringify(httpBtn) + ' - the two legs must measure the same properties');
  }
  if (httpBtn.disabled !== true || httpBtn.hasAvailableClass) {
    throw new Error('Install button USABLE over insecure HTTP: ' + JSON.stringify(httpBtn)
      + ' - the page exposes an install affordance that cannot work, and the contrast asserted only the prompt');
  }
}

// tools/resilience-audit.mjs - import.meta.main is the reliable test (Node 24+),
// and the argv fallback keeps older runtimes from turning a real run into a
// silent no-op that exits 0.
const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error(err); process.exit(1); });
