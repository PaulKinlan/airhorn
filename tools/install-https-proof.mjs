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
 * the Install button AND the HTTP contrast does not fire it and leaves the
 * Install button disabled.
 */

import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { sweepStaleProfiles } from './lib/reap.mjs';
import { connectPage, launchChrome } from './lib/chrome.mjs';
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

function makeServer(distDir, tlsOptions) {
  const handler = (req, res) => {
    let reqUrl = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
    if (!path.resolve(filePath).startsWith(path.resolve(distDir))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Service-Worker-Allowed': '/',
    });
    fs.createReadStream(filePath).pipe(res);
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
    const cs = getComputedStyle(wrap);
    // The button's OWN computed style and box, collected next to the wrap's
    // (airhorn-nxuv.11): visibility and pointer-events inherit, so a rule
    // pinning the button itself is invisible at the wrap - and it is the
    // button a user taps. The rect catches what no style property can: a
    // zero-size or off-screen button still computes 'visible'.
    const csBtn = b ? getComputedStyle(b) : null;
    const rect = b ? b.getBoundingClientRect() : null;
    // Two ENGINE answers, not more properties (airhorn-iqrz): a fixed
    // property allow-list cannot see ancestor opacity (opacity does not
    // inherit - the app's own hidden state sets it on the wrap) nor
    // clip/overflow/occlusion (the rect still reports the unclipped box).
    // checkVisibility walks the ancestor chain for display/visibility/
    // opacity; elementFromPoint at the box's centre is a real hit-test - a
    // clipped-away or covered button does not receive the hit.
    const engineVisible = b && b.checkVisibility
      ? b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : null;
    const hit = b && rect
      ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
    return {
      disabled: b ? b.disabled : null,
      hasAvailableClass: wrap.classList.contains('available'),
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      button: csBtn ? {
        display: csBtn.display,
        visibility: csBtn.visibility,
        opacity: csBtn.opacity,
        pointerEvents: csBtn.pointerEvents,
        engineVisible,
        hitTarget: b ? (hit === b || b.contains(hit)) : null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
      } : null,
      text: b ? b.textContent.trim() : null,
    };
  })()`);
  ev.screenshot = await cdp.screenshot(`install-${label}.png`);
  return ev;
}

// Whether the collected installButton state describes a button a user can
// actually perceive and tap (airhorn-nxuv.11, airhorn-iqrz). Two engine
// answers carry the load, because a fixed property allow-list cannot:
//   - engineVisible (checkVisibility with checkOpacity +
//     checkVisibilityCSS): false when the button OR ANY ANCESTOR hides it
//     via display, visibility or opacity - ancestor opacity does not
//     inherit, so a per-element read can never see it;
//   - hitTarget (elementFromPoint at the box's centre): false when the
//     centre point is clipped away, off-screen or covered by another
//     element - the rect alone still reports the unclipped box.
// The per-property reads (display/visibility/opacity/pointer-events, wrap
// and button) and the rect/viewport stay, so a failure still names the
// mechanism, and zero-size is caught even where the engine would say
// 'visible'.
// Any unreadable field fails AS unreadable - it never defaults to
// 'visible'/'auto', because a style the tool cannot read is a state it
// knows nothing about.
function buttonPerceptibility(btn) {
  const unreadable = [];
  const str = (name, v) => {
    if (typeof v !== 'string' || v === '') unreadable.push(`${name} unreadable: ${JSON.stringify(v)}`);
    return v;
  };
  const num = (name, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) unreadable.push(`${name} unreadable: ${JSON.stringify(v)}`);
    return v;
  };
  if (!btn || typeof btn !== 'object') {
    return { unreadable: ['installButton unreadable: ' + JSON.stringify(btn)], notPerceivable: [], notOperable: [] };
  }
  const wrapVisibility = str('wrap.visibility', btn.visibility);
  const wrapPointerEvents = str('wrap.pointerEvents', btn.pointerEvents);
  const b = btn.button;
  if (!b || typeof b !== 'object') {
    unreadable.push('button computed style unreadable: ' + JSON.stringify(btn));
    return { unreadable, notPerceivable: [], notOperable: [] };
  }
  const display = str('button.display', b.display);
  const visibility = str('button.visibility', b.visibility);
  const pointerEvents = str('button.pointerEvents', b.pointerEvents);
  const bool = (name, v) => {
    if (typeof v !== 'boolean') unreadable.push(`${name} unreadable: ${JSON.stringify(v)}`);
    return v;
  };
  const engineVisible = bool('button.engineVisible', b.engineVisible);
  const hitTarget = bool('button.hitTarget', b.hitTarget);
  const opacity = str('button.opacity', b.opacity);
  if (typeof opacity === 'string' && opacity !== '' && !Number.isFinite(Number(opacity))) {
    unreadable.push(`button.opacity is not a number: ${JSON.stringify(opacity)}`);
  }
  const r = b.rect || {};
  const vp = b.viewport || {};
  const x = num('button.rect.x', r.x);
  const y = num('button.rect.y', r.y);
  const width = num('button.rect.width', r.width);
  const height = num('button.rect.height', r.height);
  const vw = num('button.viewport.width', vp.width);
  const vh = num('button.viewport.height', vp.height);
  if (unreadable.length) return { unreadable, notPerceivable: [], notOperable: [] };

  const notPerceivable = [];
  if (engineVisible === false) notPerceivable.push('engine reports the button not visible (display/visibility/opacity chain, ancestors included)');
  if (display === 'none') notPerceivable.push('button.display is none');
  if (visibility !== 'visible') notPerceivable.push(`button.visibility is ${visibility}`);
  if (Number(opacity) <= 0) notPerceivable.push(`button.opacity is ${opacity}`);
  if (wrapVisibility !== 'visible') notPerceivable.push(`wrap.visibility is ${wrapVisibility}`);
  if (width <= 0 || height <= 0) notPerceivable.push(`button is zero-size (${width}x${height})`);
  if (x >= vw || y >= vh || x + width <= 0 || y + height <= 0) {
    notPerceivable.push(`button box (${x},${y} ${width}x${height}) is outside the viewport (${vw}x${vh})`);
  }
  const notOperable = [];
  if (hitTarget === false) notOperable.push('elementFromPoint at the button centre does not reach the button (clipped away, off-screen or covered)');
  if (pointerEvents === 'none') notOperable.push('button.pointerEvents is none');
  if (wrapPointerEvents === 'none') notOperable.push('wrap.pointerEvents is none');
  return { unreadable, notPerceivable, notOperable };
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
    console.log(`  HTTP  ${httpEv.origin}: secureContext=${httpEv.secureContext} sw=${httpEv.serviceWorker && !httpEv.serviceWorker.unavailable && !!httpEv.serviceWorker.scriptURL} prompt=${JSON.stringify(httpEv.installPrompt)} button=${JSON.stringify(httpEv.installButton)}`);
    console.log(`  HTTPS ${httpsEv.origin}: secureContext=${httpsEv.secureContext} sw=${!!httpsEv.serviceWorker} prompt=${JSON.stringify(httpsEv.installPrompt)} button=${JSON.stringify(httpsEv.installButton)}`);
    console.log(`  screenshots: ${httpEv.screenshot}, ${httpsEv.screenshot}`);

    if (!httpsEv.installPrompt.fired) throw new Error('beforeinstallprompt did NOT fire over HTTPS');
    if (!httpsEv.installButton || typeof httpsEv.installButton.disabled !== 'boolean') {
      throw new Error('Install button state unreadable over HTTPS: ' + JSON.stringify(httpsEv.installButton));
    }
    if (httpsEv.installButton.disabled !== false || !httpsEv.installButton.hasAvailableClass) {
      throw new Error('Install button not enabled over HTTPS: ' + JSON.stringify(httpsEv.installButton));
    }
    // Enabled in the DOM is not tappable on the glass (airhorn-nxuv.11): an
    // 'available' installer that is display:none, visibility:hidden,
    // opacity:0, zero-size, off-screen or pointer-events:none passes every
    // check above while a user could never tap it. The HTTPS stage claims an
    // OPERABLE button, so assert perceivable AND operable, by property name.
    const httpsPerc = buttonPerceptibility(httpsEv.installButton);
    if (httpsPerc.unreadable.length) {
      throw new Error('Install button computed state unreadable over HTTPS: ' + httpsPerc.unreadable.join('; '));
    }
    if (httpsPerc.notPerceivable.length || httpsPerc.notOperable.length) {
      throw new Error('Install button enabled but not tappable over HTTPS - ' +
        httpsPerc.notPerceivable.map(f => `not perceivable: ${f}`)
          .concat(httpsPerc.notOperable.map(f => `not operable: ${f}`)).join('; ') +
        ' :: ' + JSON.stringify(httpsEv.installButton));
    }
    if (httpEv.installPrompt.fired) throw new Error('the insecure-HTTP contrast fired the prompt - the contrast is invalid');
    if (!httpEv.installButton || typeof httpEv.installButton.disabled !== 'boolean') {
      throw new Error('Install button state unreadable over HTTP: ' + JSON.stringify(httpEv.installButton));
    }
    if (httpEv.installButton.disabled !== true || httpEv.installButton.hasAvailableClass) {
      throw new Error('Install button not disabled over HTTP: ' + JSON.stringify(httpEv.installButton));
    }
    // The contrast's other half: over HTTP the not-installable stage must
    // also RENDER as such - a disabled button still shown as perceivable and
    // operable would present an install affordance the platform just refused.
    const httpPerc = buttonPerceptibility(httpEv.installButton);
    if (httpPerc.unreadable.length) {
      throw new Error('Install button computed state unreadable over HTTP: ' + httpPerc.unreadable.join('; '));
    }
    if (!httpPerc.notPerceivable.length && !httpPerc.notOperable.length) {
      throw new Error('Install button disabled but still perceivable and operable over HTTP: ' + JSON.stringify(httpEv.installButton));
    }
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
// tools/resilience-audit.mjs - import.meta.main is the reliable test (Node 24+),
// and the argv fallback keeps older runtimes from turning a real run into a
// silent no-op that exits 0.
const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error(err); process.exit(1); });
