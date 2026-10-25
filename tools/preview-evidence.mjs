/*
 * preview-evidence.mjs — capture the deployable-preview evidence pack for the
 * V2 ship/no-ship decision (airhorn-8uu). Run AFTER `npm run build`:
 *
 *   node tools/preview-evidence.mjs [--out preview]
 *
 * Serves dist/ on 127.0.0.1 (ephemeral port) and drives ONE fresh-profile
 * headless Chrome at a time (closed in finally, like measure-perf.mjs) to
 * capture, into the output directory:
 *
 *   horn-light.png        default desktop viewport, light scheme
 *   horn-dark.png         same, prefers-color-scheme: dark
 *   horn-320.png          320px mobile viewport (DPR 2), light scheme
 *   horn-offline.png      after first load + SW activation, offline reload
 *   evidence.json         structured results: render checks, offline assertions,
 *                         offline-play check, WebMCP tool listing (flag on),
 *                         installability probe (manifest + SW + beforeinstallprompt),
 *                         published-file inventory (raw and gzip bytes per file,
 *                         plus the totals DEPLOY.md quotes)
 *
 * Exit code 0 only if every REQUIRED capture succeeded; assertions that cannot
 * hold without HTTPS (a real beforeinstallprompt on a device) are recorded, not
 * failed. This script never deploys anything.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

import { chromeBin, connectPage, launchChrome } from './lib/chrome.mjs';

// Every launch's teardown lives in a try/finally, which a bound-kill (fleet-gate's
// SIGTERM, a job-tree reaper, Ctrl-C) never reaches - so the chrome tree and its
// /tmp profile survived the kill (airhorn-dpua, the tools' copy of the gap
// airhorn-4vfn closed for the suites). The tool drives one browser at a time, so
// a single slot is the whole live set; the handler does the same sweep + removal
// synchronously inside its grace.
let liveBrowser = null;
installSignalExit(() => {
  const browser = liveBrowser;
  liveBrowser = null;
  // killNow() is the launcher's synchronous sweep + tree kill + profile rm,
  // sized to fit the grace (airhorn-gau8); this tool used to spell it out here.
  browser?.killNow();
});


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'preview');

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

// Collects beforeinstallprompt on every document, from the first byte on.
const BIP_PROBE = `
  window.__install = { promptFired: false, at: null };
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__install.promptFired = true;
    window.__install.at = Date.now();
  });
`;

async function startServer() {
  const server = http.createServer((req, res) => {
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
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

// Launches a fresh-profile headless Chrome through the one launcher
// (tools/lib/chrome.mjs, airhorn-2po9) and returns { chrome, ...cdp helpers } -
// the handle is the launcher's, so the flags, the startup/discovery/handshake
// bounds and the teardown are not this file's problem. cdp is the minimal
// CDP-over-WebSocket client below, bound to the fresh about:blank page.
async function openBrowser(extraFlags = []) {
  const browser = await launchChrome({
    label: 'preview-evidence',
    autoplay: true,
    extraFlags,
    timeoutMs: 15000,
    discoveryMs: 15000,
  });
  liveBrowser = browser;
  let ws = null;
  try {
    ws = await connectPage(browser, { label: 'preview-evidence', timeoutMs: 15000 });
  } catch (err) {
    // The socket never opened, so nothing downstream owns this launch.
    liveBrowser = null;
    await browser.close();
    throw err;
  }

  const cleanup = () => {
    liveBrowser = null;
    try { ws?.close(); } catch {}
    // close() reaps SYNCHRONOUSLY (marker sweep, tree kill, profile rm) before
    // its first await, so a caller that does not await cleanup still gets the
    // full teardown - which is how every caller here uses it. The catch only
    // stops a late rejection escaping that caller.
    browser.close().catch(() => { /* teardown is best-effort by design */ });
  };

  let msgId = 1;
  const pending = new Map();
  const eventWaiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      const w = eventWaiters[i];
      if (w.method === msg.method) {
        eventWaiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg.params);
      }
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

  const waitEvent = (method, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeoutMs);
    eventWaiters.push({ method, resolve, timer });
  });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('page eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  };

  const waitFor = async (expression, timeoutMs = 20000, everyMs = 200) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await new Promise(r => setTimeout(r, everyMs));
    }
    throw new Error('waitFor timeout: ' + expression + ' (last: ' + JSON.stringify(last) + ')');
  };

  const navigate = async (url) => {
    const load = waitEvent('Page.loadEventFired', 30000);
    await send('Page.navigate', { url });
    await load;
  };

  const screenshot = async (file) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(res.data, 'base64'));
    return file;
  };

  return { chrome: browser.chrome, send, evaluate, waitFor, waitEvent, navigate, screenshot, cleanup };
}

// The published-file inventory is the deploy pack's size claim, so it records the
// gzip size of every file as well as the raw size (airhorn-2rxv): DEPLOY.md used
// to quote a gzip total that nothing in the pack could reproduce, which made a
// stale number indistinguishable from a fresh one. zlib level 9, i.e. what
// `gzip -9` writes; a host's own compressor may beat it (brotli more so).
async function inventoryDist() {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const buf = fs.readFileSync(full);
        files.push({
          path: '/' + path.relative(distDir, full).split(path.sep).join('/'),
          bytes: buf.length,
          gzipBytes: zlib.gzipSync(buf, { level: 9 }).length,
        });
      }
    }
  }
  walk(distDir);
  return files;
}

async function captureMain(cdp, origin) {
  const ev = { captures: [], checks: {} };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BIP_PROBE });

  // --- First (fresh-install) load ---
  await cdp.navigate(origin + '/');
  await cdp.waitFor('!!navigator.serviceWorker.controller', 20000);
  await cdp.waitFor(`(() => {
    const b = document.querySelector('button.horn');
    return !!b && b.getBoundingClientRect().width > 150;
  })()`, 10000);
  // Give the SW a moment to finish precaching before we cut the network.
  await new Promise(r => setTimeout(r, 2000));

  ev.checks.cssAppliedDesktop = await cdp.evaluate(
    `document.querySelector('button.horn').getBoundingClientRect().width`);
  ev.checks.swControllerOnFirstLoad = true;

  // Installability probes (page is a secure context on 127.0.0.1).
  ev.installability = await cdp.evaluate(`(async () => {
    const out = {};
    out.secureContext = isSecureContext;
    const link = document.querySelector('link[rel="manifest"]');
    out.manifestLink = link ? link.href : null;
    try {
      const m = await (await fetch('/manifest.json')).json();
      out.manifest = {
        name: m.name, short_name: m.short_name, start_url: m.start_url,
        display: m.display, theme_color: m.theme_color, background_color: m.background_color,
        icons: (m.icons || []).map(i => ({ sizes: i.sizes, type: i.type, purpose: i.purpose, src: i.src })),
        shortcuts: (m.shortcuts || []).map(s => s.name),
      };
      out.has192Icon = (m.icons || []).some(i => String(i.sizes || '').includes('192'));
      out.has512Icon = (m.icons || []).some(i => String(i.sizes || '').includes('512'));
      out.hasMaskable = (m.icons || []).some(i => String(i.purpose || '').includes('maskable'));
    } catch (e) { out.manifestError = String(e); }
    const reg = await navigator.serviceWorker.getRegistration();
    out.serviceWorker = reg && reg.active ? {
      scriptURL: reg.active.scriptURL, scope: reg.active.scope, state: reg.active.state,
    } : null;
    try {
      const swSource = await (await fetch('/sw.js')).text();
      out.swHasFetchHandler = /addEventListener\\(\\s*['"]fetch['"]/.test(swSource);
      out.swPrecaches = (swSource.match(/__PRECACHE_ASSETS__|PRECACHE|cache\\./g) || []).length > 0;
    } catch (e) { out.swSourceError = String(e); }
    return out;
  })()`);

  // Screenshots: light, dark, 320px.
  // Dark-mode check must be able to FAIL: record the same computed value in
  // light, then require it to change under dark. The negative control re-runs
  // the detector while light is still forced — it must detect nothing —
  // otherwise a detector that cannot go false is a false green (airhorn-a6u).
  ev.captures.push(await cdp.screenshot('horn-light.png'));
  ev.checks.darkBaselineBg = await cdp.evaluate(
    `getComputedStyle(document.body).backgroundColor`);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await new Promise(r => setTimeout(r, 400));
  ev.checks.darkBg = await cdp.evaluate(
    `getComputedStyle(document.body).backgroundColor`);
  ev.checks.darkApplied = ev.checks.darkBg !== ev.checks.darkBaselineBg;
  ev.captures.push(await cdp.screenshot('horn-dark.png'));
  // Negative control: back to light, the detector must read "not applied".
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await new Promise(r => setTimeout(r, 400));
  ev.checks.lightControlBg = await cdp.evaluate(
    `getComputedStyle(document.body).backgroundColor`);
  ev.checks.darkDetectorCanFail = ev.checks.lightControlBg === ev.checks.darkBaselineBg;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 640, deviceScaleFactor: 2, mobile: true,
  });
  await new Promise(r => setTimeout(r, 400));
  ev.captures.push(await cdp.screenshot('horn-320.png'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await new Promise(r => setTimeout(r, 300));

  // beforeinstallprompt: did the browser offer install on localhost?
  ev.installability.beforeinstallpromptFired = await cdp.evaluate('window.__install.promptFired');

  // --- Offline reload after first load ---
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  // The document is served from the SW cache, so the load event still fires.
  const offlineLoad = cdp.waitEvent('Page.loadEventFired', 30000);
  await cdp.send('Page.reload', {});
  await offlineLoad;
  await cdp.waitFor('!!navigator.serviceWorker.controller', 15000);
  ev.checks.offlineHornWidth = await cdp.evaluate(
    `(() => { const b = document.querySelector('button.horn'); return b ? b.getBoundingClientRect().width : 0; })()`);
  ev.checks.offlineRenders = ev.checks.offlineHornWidth > 150;
  ev.checks.offlineTitle = await cdp.evaluate('document.title');
  ev.checks.offlineBootFailureShown = await cdp.evaluate(
    `(() => { const el = document.querySelector('#boot-failure'); return !!el && !el.hidden; })()`);
  ev.captures.push(await cdp.screenshot('horn-offline.png'));

  // Offline play: press and hold must still sound (state, not just pixels).
  ev.checks.offlinePlay = await cdp.evaluate(`(async () => {
    const b = document.querySelector('button.horn');
    if (!b) return { pressed: false, error: 'no horn button' };
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    await new Promise(r => setTimeout(r, 400));
    const pressed = b.getAttribute('aria-pressed');
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await new Promise(r => setTimeout(r, 100));
    return { pressedWhileHeld: pressed, released: b.getAttribute('aria-pressed') };
  })()`);

  return ev;
}

async function captureWebMCP(origin) {
  const ev = {};
  const cdp = await openBrowser(['--enable-features=WebMCP,WebMCPTesting']);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.navigate(origin + '/');
    await cdp.waitFor('document.readyState === "complete"', 20000);
    await new Promise(r => setTimeout(r, 1500));
    ev.hasModelContext = await cdp.evaluate(
      `typeof document.modelContext !== 'undefined' && document.modelContext !== null`);
    if (ev.hasModelContext) {
      ev.tools = await cdp.evaluate(
        `(async () => (await document.modelContext.getTools()).map(t => ({ name: t.name, description: t.description })))()`);
      const play = ev.tools.find(t => t.name === 'play_horn');
      const stop = ev.tools.find(t => t.name === 'stop_horn');
      const state = ev.tools.find(t => t.name === 'get_horn_state');
      ev.expectedToolsPresent = !!play && !!stop && !!state;
    } else {
      ev.note = 'document.modelContext not exposed by this Chrome build even with the flag; ' +
        'see tests/webmcp-browser.test.mjs for the spec-shaped stand-in used for local verification.';
    }
  } finally {
    cdp.cleanup();
  }
  return ev;
}

async function main() {
  if (!fs.existsSync(distDir)) throw new Error('dist/ does not exist. Run `npm run build` first.');
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = {
    generatedAt: new Date().toISOString(),
    url: origin + '/',
    chrome: chromeBin(),
    publishedFiles: await inventoryDist(),
    // Totals are what DEPLOY.md quotes; keeping them here means the doc's size
    // claim is a read of this file, not a hand-measurement that goes stale.
    publishedTotals: null,
    captures: [],
    checks: {},
    installability: {},
    webmcp: {},
  };

  let mainCdp = null;
  let webmcpEv = null;
  try {
    // Browser 1: render, offline, installability. Closed before browser 2 starts.
    mainCdp = await openBrowser();
    try {
      const mainEv = await captureMain(mainCdp, origin);
      evidence.captures.push(...mainEv.captures);
      evidence.checks = mainEv.checks;
      evidence.installability = mainEv.installability;
    } finally {
      mainCdp.cleanup();
      mainCdp = null;
    }

    // Browser 2: WebMCP listing with the flag on.
    webmcpEv = await captureWebMCP(origin);
    evidence.webmcp = webmcpEv;
  } finally {
    if (mainCdp) mainCdp.cleanup();
    server.close();
  }

  evidence.publishedTotals = {
    files: evidence.publishedFiles.length,
    bytes: evidence.publishedFiles.reduce((n, f) => n + f.bytes, 0),
    gzipBytes: evidence.publishedFiles.reduce((n, f) => n + f.gzipBytes, 0),
  };

  fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

  // Human summary.
  const ok = [];
  const t = evidence.publishedTotals;
  ok.push(`published: ${t.files} file(s), ${t.bytes} B raw, ${t.gzipBytes} B gzipped (zlib level 9)`);
  ok.push(`screenshots: ${evidence.captures.join(', ')}`);
  ok.push(`desktop horn width: ${Math.round(evidence.checks.cssAppliedDesktop)}px; offline: ${Math.round(evidence.checks.offlineHornWidth)}px`);
  ok.push(`dark applied: ${evidence.checks.darkApplied} (bg ${evidence.checks.darkBaselineBg} -> ${evidence.checks.darkBg}; negative control detects false: ${evidence.checks.darkDetectorCanFail})`);
  ok.push(`offline renders: ${evidence.checks.offlineRenders}; boot-failure shown: ${evidence.checks.offlineBootFailureShown}`);
  ok.push(`offline play: ${JSON.stringify(evidence.checks.offlinePlay)}`);
  ok.push(`installable: manifest=${!!evidence.installability.manifest} (192:${evidence.installability.has192Icon} 512:${evidence.installability.has512Icon} maskable:${evidence.installability.hasMaskable}), sw=${!!evidence.installability.serviceWorker}, fetch-handler=${evidence.installability.swHasFetchHandler}, beforeinstallprompt fired=${evidence.installability.beforeinstallpromptFired}`);
  ok.push(`webmcp: modelContext=${evidence.webmcp.hasModelContext}` +
    (evidence.webmcp.tools ? ` tools=[${evidence.webmcp.tools.map(t => t.name).join(', ')}]` : ` (${evidence.webmcp.note || 'no tools'})`));
  console.log('=== Preview evidence pack ===');
  for (const line of ok) console.log('  ' + line);
  console.log(`written to ${outDir}/evidence.json`);

  // Required captures must exist; installability/WebMCP shortfalls are recorded, not fatal.
  const required = ['horn-light.png', 'horn-dark.png', 'horn-320.png', 'horn-offline.png'];
  const missing = required.filter(f => !fs.existsSync(path.join(outDir, f)));
  if (missing.length) throw new Error('missing captures: ' + missing.join(', '));
  if (!evidence.checks.offlineRenders) throw new Error('offline reload did not render the horn');
  if (!evidence.checks.darkApplied) throw new Error('dark scheme did not change the page (detector says not applied)');
  if (!evidence.checks.darkDetectorCanFail) throw new Error('dark detector negative control failed: forced-light was read as applied');
  if (!evidence.checks.offlinePlay || evidence.checks.offlinePlay.pressedWhileHeld !== 'true') {
    throw new Error('offline press did not sound the horn (aria-pressed not true)');
  }
  console.log('preview-evidence: PASS');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
