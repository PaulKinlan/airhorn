#!/usr/bin/env node
/*
 * tools/rollback-rehearsal.mjs — execute ROLLBACK.md's undo procedure for real,
 * locally, and report every place the document and the browser disagree
 * (bead airhorn-cxim).
 *
 * ROLLBACK.md's §4 drills were measured for the plan; nothing had ever run the
 * §5 order of operations end to end, as a procedure. This tool does exactly
 * that: one mutable origin (a "traffic switch" is a variable flip, not a
 * deploy), one persistent Chrome profile per scenario (so "a device that had
 * V2" is the same device after the switch), production's measured
 * `cache-control: public, max-age=10` on every response, and 404s for unknown
 * paths (no SPA fallback, as measured on the live origin).
 *
 * It asserts the DOCUMENT's claims, not my guesses: each check carries the
 * §4/§5 sentence it is testing, and a mismatch exits non-zero and is printed
 * as a finding. Evidence (fact dumps + screenshots) is written outside the
 * repo, to ~/rollback-rehearsal-evidence/<stamp>/.
 *
 * Requires: dist/ built (npm run build), and the archive of record at
 * ~/airhorn-v1-artifact (live/, rollback-overlay/sw.js) — the same two inputs
 * the real R1 rollback deployment is made of.
 *
 * Usage:
 *   node tools/rollback-rehearsal.mjs              # every drill
 *   node tools/rollback-rehearsal.mjs baseline A E F   # selected drills
 *
 * Drills (ROLLBACK.md references in the labels):
 *   baseline  §5 Step 0 / §7: V2 installs, controls, reload, second tab, offline
 *   A         §4 A  R2 rollback, device's HTTP cache COLD   -> V1 on the first reload?
 *   E         §4 E  R2 rollback inside max-age (worst case) -> wedged on V2; then R3 frees it
 *   F         §4 F  R1 rollback (archived V1 + §6 worker)   -> clean, caches empty
 *   B         §4 B  same as A but /sw.js served `immutable` -> does the TTL pin it?
 *   D         §4 D  incomplete rollback tree                -> pinned on V2, freed when fixed
 *   G         24-hour question: what a returning visit does. A plain reload, a typed
 *             navigation, a second tab and a browser restart all made the browser read
 *             /sw.js again; registration.update() does too (and no page calls it).
 *
 * ONE THING TO KNOW ABOUT THIS HARNESS: the browser's worker update check is NOT part
 * of the navigation's own work. It landed between ~0.5s and ~2s after the page was
 * ready in every drill here, so a fact dump taken shortly after the load sees the
 * pre-check page and reports "the rollback did not happen". The first version of this
 * tool did exactly that and produced a confident, wrong answer; navigate() now waits
 * SETTLE_MS and records each check's latency (printed in the report).
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, chromeBin, killTree } from '../tests/support/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(REPO, 'dist');
const ARCHIVE = process.env.ROLLBACK_ARCHIVE || path.join(os.homedir(), 'airhorn-v1-artifact');
const V1_LIVE = path.join(ARCHIVE, 'live');
const OVERLAY = path.join(ARCHIVE, 'rollback-overlay', 'sw.js');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/x-wav', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.sketch': 'application/octet-stream',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long to wait after a navigation for the update check the rollback depends on.
// Measured, not guessed: see the latency stats in the report.
const SETTLE_MS = 2500;

// ---------------------------------------------------------------------------
// The mutable origin. One server, one port: a rollback is `state.origin = 'v1'`
// and nothing else — the same atomic-switch property a real traffic switch has.
// ---------------------------------------------------------------------------
const state = {
  origin: 'v2',           // 'v2' | 'v1' | 'v1-overlay'
  swCacheControl: null,   // override for /sw.js only (drill B)
  missing: null,          // a path answered 404 regardless of origin (drill D)
  down: false,            // destroy sockets (offline)
  requests: [],           // { path, origin, at }
};

function send404(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

function serve(res, root, urlPath, relOverride = null) {
  const rel = relOverride || (urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, ''));
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send404(res);
  const ext = path.extname(file);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    // Production's measured header (ROLLBACK.md §1/§2), on every file incl. /sw.js.
    'cache-control': (rel === 'sw.js' && state.swCacheControl) || 'public, max-age=10',
  };
  if (rel === 'sw.js') headers['service-worker-allowed'] = '/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  state.requests.push({ path: urlPath, origin: state.origin, at: Date.now() });
  if (state.down) return req.destroy();
  if (state.missing && state.missing === urlPath) return send404(res);
  if (state.origin === 'v2') return serve(res, DIST, urlPath);
  if (state.origin === 'v1') return serve(res, V1_LIVE, urlPath);
  if (state.origin === 'v1-overlay') {
    // R1 = the archived V1 tree plus §6's worker as /sw.js, and nothing else changed.
    if (urlPath === '/sw.js') return serve(res, path.dirname(OVERLAY), '/sw.js', 'sw.js');
    return serve(res, V1_LIVE, urlPath);
  }
  return send404(res);
});

// ---------------------------------------------------------------------------
// Evidence + check ledger
// ---------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(os.homedir(), 'rollback-rehearsal-evidence', stamp);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const facts = [];
const navTimings = [];

function check(drill, step, expected, actual, ok, note = '') {
  results.push({ drill, step, expected, actual, ok, note });
  const mark = ok ? 'MATCH   ' : 'MISMATCH';
  console.log(`${mark} [${drill}] ${step}\n           ROLLBACK.md says: ${expected}\n           observed:         ${actual}${note ? `\n           note:             ${note}` : ''}`);
}

function note(drill, step, actual) {
  results.push({ drill, step, expected: null, actual, ok: true, note: '' });
  console.log(`INFO    [${drill}] ${step}: ${actual}`);
}

function recordFacts(drill, label, f) {
  facts.push({ drill, label, at: new Date().toISOString(), ...f });
  fs.appendFileSync(path.join(OUT, 'facts.jsonl'), JSON.stringify({ drill, label, ...f }) + '\n');
}

async function screenshot(page, drill, label) {
  try {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${drill}-${label}.png`), Buffer.from(shot.data, 'base64'));
  } catch { /* a chrome-error page cannot be captured; the facts still record it */ }
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP socket failed to open'));
  });
  let id = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = id++;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  const close = () => { try { ws.close(); } catch { /* already closed */ } };
  await send('Page.enable');
  await send('Runtime.enable');
  const netEvents = [];
  if (process.env.REHEARSAL_NET) {
    await send('Network.enable');
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.method) return;
      if (msg.method === 'Network.requestWillBeSent' && /\/sw\.js/.test(msg.params.request.url)) {
        netEvents.push(`sent:${Date.now()}`);
      }
      if (msg.method === 'Network.requestServedFromCache') netEvents.push(`cached-read:${msg.params.requestId}:${Date.now()}`);
      if (msg.method === 'Network.responseReceived' && /\/sw\.js/.test(msg.params.response.url)) {
        netEvents.push(`response:${msg.params.response.status}:${msg.params.response.fromDiskCache ? 'disk' : 'net'}:${Date.now()}`);
      }
    });
  }
  return { send, evaluate, close, netEvents };
}

const sleep2 = sleep;

async function waitFor(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await page.evaluate(expression)) return true; } catch { /* navigations in flight */ }
    if (Date.now() >= deadline) return false;
    await sleep2(100);
  }
}

const ORIGIN = () => `http://127.0.0.1:${server.address().port}`;

const FACTS_EXPR = `(async () => {
  const keys = await caches.keys().catch(() => []);
  const entries = {};
  for (const k of keys) {
    const c = await caches.open(k);
    entries[k] = (await c.keys()).map(r => new URL(r.url).pathname).sort();
  }
  const shell = await caches.match('/').catch(() => null);
  const shellHtml = shell ? await shell.text() : '';
  const shellByCache = {};
  for (const k of keys) {
    const c = await caches.open(k);
    const hit = await c.match('/').catch(() => null);
    const html = hit ? await hit.text() : '';
    shellByCache[k] = { v2: /id=['\"]app-status['\"]/.test(html), v1: /main\.min\.js/.test(html), bytes: html.length };
  }
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
  return {
    href: location.href,
    title: document.title,
    v2Shell: !!document.querySelector('#app-status'),
    v1Shell: !!document.querySelector('script[src*="main.min.js"]'),
    hornRole: document.querySelector('.horn') ? document.querySelector('.horn').getAttribute('role') : null,
    controlled: !!navigator.serviceWorker.controller,
    controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
    registrations: regs.map(r => ({ scope: r.scope, active: r.active && r.active.scriptURL, state: r.active && r.active.state })),
    caches: keys.sort(),
    entries,
    cachedShellV2: /id=['\"]app-status['\"]/.test(shellHtml),
    cachedShellV1: /main\.min\.js/.test(shellHtml),
    cachedShellBytes: shellHtml.length,
    shellByCache,
    announce: (document.getElementById('app-status') || {}).textContent || '',
  };
})()`;

async function readFacts(page) {
  return page.evaluate(FACTS_EXPR);
}

const v2Caches = (f) => f.caches.filter((k) => k.startsWith('airhorner-2.0.0-') || k.startsWith('horn-integrity-2.0.0-'));
const v1CachePresent = (f) => f.caches.some((k) => k === 'airhorner-0.6.20');
// What V1's OWN cache holds. `caches.match('/')` searches every cache, so a
// substring marker is never enough: V1's manifest meta is
// `apple-mobile-web-app-status-bar-style`, which contains "app-status".
const v1CacheShell = (f) => (f.shellByCache && f.shellByCache['airhorner-0.6.20']) || { v1: false, v2: false };

async function navigate(page, url, { reload = false } = {}) {
  const from = state.requests.length;
  const startedAt = Date.now();
  if (reload) await page.send('Page.reload', {});
  else await page.send('Page.navigate', { url });
  // A served page is "ready" when the horn is in the DOM. An error page never
  // is, so this returns false rather than throwing (drill F offline).
  const ok = await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('.horn')`, 12000);
  // THE SETTLE MATTERS: the browser's worker update check is not part of the
  // navigation's own work - it landed up to a couple of seconds AFTER the page
  // was ready and interactive in every drill here. Reading the page 400ms after
  // the load (the first version of this tool) concluded "no check happened" and
  // was simply measuring too early; see the latency numbers in the report.
  await sleep2(SETTLE_MS);
  const check = state.requests.slice(from).find((r) => r.path === '/sw.js');
  if (check) navTimings.push({ startedAt, latencyMs: check.at - startedAt, origin: check.origin });
  if (process.env.REHEARSAL_DEBUG) {
    const seen = state.requests.slice(from);
    console.log(`  DEBUG navigate(${reload ? 'reload' : url}) origin=${state.origin} -> ${seen.length} requests: ` +
      (seen.map((r) => `${r.path}@${r.origin}`).join(' ') || '(none)') +
      (check ? `  [update check arrived ${check.at - startedAt}ms after the navigation began]` : '  [no /sw.js read]'));
  }
  return ok;
}

async function openSecondTab(browser, url) {
  const res = await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const page = await connect(target.webSocketDebuggerUrl);
  await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('.horn')`, 12000);
  await sleep2(SETTLE_MS); // the same update-check window as navigate()
  return page;
}

// Install V2 and hand the page back once its worker controls it — the state
// "a visitor who has picked up V2" is in.
async function installV2(page) {
  state.origin = 'v2';
  state.down = false;
  state.missing = null;
  state.swCacheControl = null;
  await navigate(page, `${ORIGIN()}/`);
  await waitFor(page, `navigator.serviceWorker.ready.then(r => !!(r && r.active))`, 12000);
  await navigate(page, `${ORIGIN()}/`, { reload: true });
  await waitFor(page, `!!navigator.serviceWorker.controller`, 8000);
}

function swRequests() {
  return state.requests.filter((r) => r.path === '/sw.js');
}

// A browser whose profile is KEPT: the only way to ask "what does this device do
// after a restart", which is what "a returning visitor" means in the plan.
// Mirrors tests/support/browser.mjs's flag family (same reasons), spawned here
// because that helper deliberately owns and deletes its own mkdtemp profile.
async function launchPersistent(profileDir, label) {
  const chrome = spawn(chromeBin(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-breakpad', '--disable-crash-reporter',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`chrome start timeout (${label}): ${stderr}`)), 20000);
    chrome.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = stderr.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chrome exited (${code}) (${label}): ${stderr}`)); });
  });
  const port = new URL(wsUrl).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const page = await connect(target.webSocketDebuggerUrl);
  const browser = { port };
  return {
    browser,
    page,
    async close() {
      page.close();
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      try { killTree(chrome.pid); } catch { /* already gone */ }
      await sleep2(300);
    },
  };
}

async function withProfile(label, fn) {
  const browser = await launchBrowser({ label: `rehearsal-${label}`, timeoutMs: 20000 });
  const page = await connect(browser.pageWsUrl);
  try {
    return await fn(page, browser);
  } finally {
    page.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Checks shared by the drills, each quoting the document it is testing
// ---------------------------------------------------------------------------

function checkV2Installed(drill, f) {
  check(drill, 'V2 installs and takes control',
    '§5 Step 0: the tree "installs (...), worker activates, airhorner-0.6.20 holds its 8 precached paths" (same shape for V2)',
    `controlled=${f.controlled} controller=${f.controller} caches=${f.caches.join(',') || '(none)'}`,
    f.controlled === true && v2Caches(f).length > 0);
  check(drill, 'the page is V2',
    '§4: the V2 shell renders while V2 is serving',
    `v2Shell=${f.v2Shell} v1Shell=${f.v1Shell} title="${f.title}"`,
    f.v2Shell === true && f.v1Shell === false);
}

function checkV1Page(drill, step, f) {
  check(drill, step,
    '§4: "V1 renders" — the archived V1 document, not just a V1 worker in control',
    `v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} hornRole=${f.hornRole} title="${f.title}"`,
    f.v1Shell === true && f.v2Shell === false);
}

// ---------------------------------------------------------------------------
// Drills
// ---------------------------------------------------------------------------

const drills = {
  // The bead's step (2): a visitor who has picked up V2 — reload, second tab, offline.
  async baseline() {
    const drill = 'baseline';
    await withProfile(drill, async (page, browser) => {
      await installV2(page);
      let f = await readFacts(page);
      recordFacts(drill, 'installed', f);
      await screenshot(page, drill, 'v2-installed');
      checkV2Installed(drill, f);
      const before = swRequests().length;

      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'reload', f);
      check(drill, 'a normal reload stays V2 and controlled',
        '§4 A: a V2 device works normally until the rollback',
        `v2Shell=${f.v2Shell} controlled=${f.controlled} controller=${f.controller}`,
        f.v2Shell === true && f.controlled === true);
      note(drill, '/sw.js requests on that reload', String(swRequests().length - before));

      const tab2 = await openSecondTab(browser, `${ORIGIN()}/`);
      const f2 = await readFacts(tab2);
      recordFacts(drill, 'second-tab', f2);
      tab2.close();
      check(drill, 'a second tab is V2 and controlled',
        '§4: a device that visited during the V2 window has V2 in every tab (shared registration)',
        `v2Shell=${f2.v2Shell} controlled=${f2.controlled} caches=${f2.caches.join(',')}`,
        f2.v2Shell === true && f2.controlled === true);

      state.down = true;
      const rendered = await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page).catch(() => null);
      recordFacts(drill, 'offline', f || { error: 'no document' });
      state.down = false;
      check(drill, 'an offline reload is served by the V2 worker',
        '§5 Step 0: the archived tree "survives an offline reload with the origin destroyed" (V2 precaches its shell too)',
        `rendered=${rendered} ${f ? `v2Shell=${f.v2Shell} controlled=${f.controlled}` : 'no page'}`,
        rendered === true && !!f && f.v2Shell === true);
      await navigate(page, `${ORIGIN()}/`, { reload: true });
    });
  },

  // R2 on a COLD HTTP cache: the fast, plain "switch back to the V1 version".
  async A() {
    const drill = 'A';
    await withProfile(drill, async (page) => {
      await installV2(page);
      checkV2Installed(drill, await readFacts(page));
      note(drill, 'waiting out max-age before the switch', '11s (production sends max-age=10)');
      await sleep(11000);
      state.origin = 'v1';

      const before = swRequests().length;
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      let f = await readFacts(page);
      recordFacts(drill, 'first-reload-after-switch', f);
      await screenshot(page, drill, 'after-switch');
      check(drill, 'R2, cold device: V1 on the first reload',
        '§4 A: "V1 worker installs → activates → clients.claim() → V2\'s controllerchange handler reloads the tab → V1 renders"',
        `/sw.js reads: ${swRequests().length - before}; v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} controlled=${f.controlled}`,
        swRequests().length - before > 0 && f.v1Shell === true);
      check(drill, 'R2, cold device: one reload is enough (the automatic controllerchange reload)',
        '§4 A: "V2\'s controllerchange handler reloads the tab → V1 renders"',
        `v1Shell=${f.v1Shell} controller=${f.controller}`,
        f.v1Shell === true && String(f.controller).endsWith('/sw.js'));

      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'second-reload', f);
      check(drill, 'R2, cold device: stays V1',
        '§4 A: the rollback holds across reloads',
        `v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} caches=${f.caches.join(',')}`,
        f.v1Shell === true);
      check(drill, 'R2 leaves the V2 caches on the device',
        '§5 Step 1 R2: "leaves airhorner-2.0.0-* / horn-integrity-2.0.0-* on every V2 device for good (V1\'s worker never deletes caches)"',
        `caches=${f.caches.join(',') || '(none)'}`,
        v2Caches(f).length > 0 && v1CachePresent(f));
      check(drill, 'R2, cold device: the V1 cache holds the V1 shell',
        '§4 A: a cold device gets the V1 document into airhorner-0.6.20',
        `airhorner-0.6.20 shell: ${JSON.stringify(v1CacheShell(f))}`,
        v1CacheShell(f).v1 === true && v1CacheShell(f).v2 === false);
    });
  },

  // R2 while the device's HTTP cache is still fresh (§4 E), then §6's worker as the
  // documented correction (§5 Step 1 R3).
  async E() {
    const drill = 'E';
    await withProfile(drill, async (page) => {
      await installV2(page);
      const lastV2 = Math.max(...state.requests.map((r) => r.at));
      checkV2Installed(drill, await readFacts(page));
      state.origin = 'v1';
      note(drill, 'switched inside the max-age window', `${Date.now() - lastV2}ms after the last V2 response`);

      let before = swRequests().length;
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      let f = await readFacts(page);
      recordFacts(drill, 'first-reload-after-switch', f);
      await screenshot(page, drill, 'wedged');
      check(drill, 'R2, warm device: still V2 after the rollback',
        '§4 E: "The device keeps showing V2, silently, indefinitely"',
        `/sw.js reads: ${swRequests().length - before}; v1Shell=${f.v1Shell} v2Shell=${f.v2Shell}`,
        f.v2Shell === true);
      check(drill, 'R2, warm device: a V1 worker is in control of a V2 page',
        '§4 E: "The V1 worker\'s cache.addAll() is answered from the browser\'s HTTP cache with V2 bytes ... with a V1 worker in control"',
        `airhorner-0.6.20 present: ${v1CachePresent(f)}; its shell: ${JSON.stringify(v1CacheShell(f))}; controller=${f.controller}`,
        v1CachePresent(f) && v1CacheShell(f).v2 === true);
      for (let i = 2; i <= 3; i += 1) {
        await navigate(page, `${ORIGIN()}/`, { reload: true });
        f = await readFacts(page);
        recordFacts(drill, `reload-${i}`, f);
        check(drill, `R2, warm device: still V2 on reload ${i} (nothing self-heals)`,
          '§4 E: "wedged across three reloads"; "nothing self-heals"; "its own sw.js will not change again — so there is no second chance"',
          `v2Shell=${f.v2Shell} v1Shell=${f.v1Shell}`,
          f.v2Shell === true);
      }

      // §5 Step 1 R3: publish §6's worker on its own — the documented escape hatch.
      state.origin = 'v1-overlay';
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'R3-first-reload', f);
      await screenshot(page, drill, 'r3');
      check(drill, 'R3 frees a drill-E device on its next visit',
        '§5 Step 1 R3: "publish the rollback worker on its own as soon as R2 is live; devices from drill E are freed on their next visit by the sw.js change alone"',
        `v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} caches=${f.caches.join(',') || '(none)'} controller=${f.controller}`,
        f.v1Shell === true && f.caches.length === 0);
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'R3-second-reload', f);
      check(drill, 'R3 keeps the freed device on V1 with no caches',
        '§6: "It does not loop. Measured across three reloads: one reload on the change, then stable."',
        `v1Shell=${f.v1Shell} caches=${f.caches.join(',') || '(none)'}`,
        f.v1Shell === true && f.caches.length === 0);
    });
  },

  // R1: the atomic switch to archived-V1-plus-§6-worker, in the worst case (the
  // V2 visit was seconds ago, so the device's HTTP cache is warm).
  async F() {
    const drill = 'F';
    await withProfile(drill, async (page) => {
      await installV2(page);
      const lastV2 = Math.max(...state.requests.map((r) => r.at));
      checkV2Installed(drill, await readFacts(page));
      state.origin = 'v1-overlay';
      note(drill, 'R1 switched inside the max-age window', `${Date.now() - lastV2}ms after the last V2 response`);

      let before = swRequests().length;
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      let f = await readFacts(page);
      recordFacts(drill, 'first-reload-after-switch', f);
      await screenshot(page, drill, 'r1-first-reload');
      check(drill, 'R1: V1 on the first reload',
        '§4 F: "Page is V1 on the first reload"',
        `/sw.js reads: ${swRequests().length - before}; v1Shell=${f.v1Shell} v2Shell=${f.v2Shell}`,
        f.v1Shell === true);
      check(drill, 'R1: caches.keys() is empty',
        '§4 F: "caches.keys() is []"; §6 "Measured: caches.keys() is empty after this worker activates"',
        `caches=${f.caches.join(',') || '(none)'}`,
        f.caches.length === 0);
      check(drill, 'R1: the device is still controlled by a worker',
        '§4 F: "still controlled by a worker (so no unregister/re-register churn)"',
        `controlled=${f.controlled} controller=${f.controller}`,
        f.controlled === true && String(f.controller).endsWith('/sw.js'));

      const loads = [];
      for (let i = 2; i <= 3; i += 1) {
        const n = swRequests().length;
        await navigate(page, `${ORIGIN()}/`, { reload: true });
        f = await readFacts(page);
        loads.push({ i, v1: f.v1Shell, v2: f.v2Shell, caches: f.caches.length, sw: swRequests().length - n });
        recordFacts(drill, `reload-${i}`, f);
      }
      check(drill, 'R1: stable V1, no reload loop, no reinstall',
        '§6: "It does not loop. Measured across three reloads: one reload on the change, then stable."',
        JSON.stringify(loads),
        loads.every((l) => l.v1 === true && l.v2 === false && l.caches === 0));

      // The stated cost: offline support is off while this worker is deployed.
      state.down = true;
      const rendered = await navigate(page, `${ORIGIN()}/`, { reload: true });
      const offlineFacts = await readFacts(page).catch(() => null);
      recordFacts(drill, 'offline', offlineFacts || { error: 'no document' });
      state.down = false;
      check(drill, 'R1: offline is off, as §6 says it is',
        '§6: "offline support is off for everyone while this is deployed and every load is a network load"',
        `rendered=${rendered} ${offlineFacts ? `v1Shell=${offlineFacts.v1Shell} v2Shell=${offlineFacts.v2Shell}` : 'chrome error page (no document)'}`,
        rendered === false);
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'back-online', f);
      check(drill, 'R1: recovers to V1 once the network is back',
        '§6: nothing is stored, so every load is the origin\'s; the worker still controls',
        `v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} caches=${f.caches.join(',') || '(none)'}`,
        f.v1Shell === true);
    });
  },

  // §4 B: a long TTL / immutable on /sw.js must not pin the device.
  async B() {
    const drill = 'B';
    await withProfile(drill, async (page) => {
      state.swCacheControl = 'public, max-age=31536000, immutable';
      try {
        await installV2(page);
        checkV2Installed(drill, await readFacts(page));
        await sleep(11000);
        state.origin = 'v1';
        const before = swRequests().length;
        await navigate(page, `${ORIGIN()}/`, { reload: true });
        const f = await readFacts(page);
        recordFacts(drill, 'after-switch', f);
        check(drill, 'B: an immutable /sw.js does not pin the device',
          '§4 B: "Same result" as A — "the update check sends cache-control: max-age=0 (+If-None-Match) ... so a long TTL on /sw.js does not pin Chromium"',
          `/sw.js reads: ${swRequests().length - before}; v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} controller=${f.controller}`,
          swRequests().length - before > 0 && f.v1Shell === true);
      } finally {
        state.swCacheControl = null;
      }
    });
  },

  // §4's "24-hour question": does a restored /sw.js reach a device on its NEXT VISIT?
  // Measured across the four things a visitor can do — a reload, a fresh navigation, a
  // second tab, a browser restart on the same profile — plus registration.update().
  // Only the /sw.js request count matters here; the page outcome is drill A's or E's.
  async G() {
    const drill = 'G';
    const profile = fs.mkdtempSync('/tmp/rehearsal-G-');
    let session = await launchPersistent(profile, `${drill}-1`);
    const swCount = () => swRequests().length;
    try {
      let page = session.page;
      await installV2(page);
      recordFacts(drill, 'installed', await readFacts(page));
      state.origin = 'v1';
      note(drill, 'the R2 rollback happened now', 'the origin is V1 from here on');

      const visit = async (label, how) => {
        const before = swCount();
        await how();
        const n = swCount() - before;
        const f = await readFacts(page);
        recordFacts(drill, label, { ...f, swRequests: n });
        return { n, f };
      };

      let r = await visit('reload', () => navigate(page, `${ORIGIN()}/`, { reload: true }));
      check(drill, 'a plain reload re-reads /sw.js',
        '§4: "/sw.js was requested on every reload in every scenario"',
        `/sw.js reads: ${r.n}; page: v2=${r.f.v2Shell} v1=${r.f.v1Shell} (warm HTTP cache, so the outcome is drill E\'s)`,
        r.n > 0);

      r = await visit('fresh-navigation', () => navigate(page, `${ORIGIN()}/`));
      check(drill, 'a fresh navigation re-reads /sw.js',
        '§4: "Treat \\"the device is released on its next visit\\" as the measured case"',
        `/sw.js reads: ${r.n}; page: v2=${r.f.v2Shell} v1=${r.f.v1Shell}`,
        r.n > 0);

      r = await visit('second-tab', () => openSecondTab(session.browser, `${ORIGIN()}/`).then((t) => t.close()));
      check(drill, 'a second tab re-reads /sw.js',
        '§4: "a device that visited during the V2 window" moves on its next visit',
        `/sw.js reads: ${r.n}; page after it: v2=${r.f.v2Shell} v1=${r.f.v1Shell}`,
        r.n > 0);

      // A returning visitor, same profile, new browser process: a day later looks
      // like this, minus the day.
      await session.close();
      session = await launchPersistent(profile, `${drill}-2`);
      page = session.page;
      r = await visit('browser-restart', () => navigate(page, `${ORIGIN()}/`));
      check(drill, 'a browser restart on the same profile re-reads /sw.js',
        '§4: "the device is released on its next visit" — the plan depends on that visit',
        `/sw.js reads: ${r.n}; page: v2=${r.f.v2Shell} v1=${r.f.v1Shell}`,
        r.n > 0);

      // And the lever a page could use if it wanted a check now, which neither
      // version's page calls.
      const before = swCount();
      await page.evaluate(`navigator.serviceWorker.getRegistration().then(r => r.update()).then(() => true)`);
      await sleep2(1500);
      const forced = swCount() - before;
      check(drill, 'registration.update() is also a lever (no page calls it)',
        '§4: "Only the next read of /sw.js does" reach an installed worker',
        `/sw.js reads: ${forced}; neither V1's nor V2's page calls update()`,
        forced > 0);
    } finally {
      await session.close();
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
    }
  },

  // §4 D: an incomplete rollback tree pins the device — and fixing the tree frees it.
  async D() {
    const drill = 'D';
    await withProfile(drill, async (page) => {
      await installV2(page);
      checkV2Installed(drill, await readFacts(page));
      await sleep(11000); // cold, so this is drill D and not drill E
      // A half-restored upload: the worker's precache 404s one path.
      state.origin = 'v1';
      state.missing = '/scripts/main.min.js';
      const before = swRequests().length;
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      let f = await readFacts(page);
      recordFacts(drill, 'incomplete-first-reload', f);
      await screenshot(page, drill, 'pinned');
      check(drill, 'D: incomplete tree — the device stays on V2',
        '§4 D: "The device stays on V2 forever. Install rejects, the empty cache it created is abandoned and recreated on each attempt, the old V2 worker keeps control"',
        `/sw.js reads: ${swRequests().length - before}; v2Shell=${f.v2Shell} v1Shell=${f.v1Shell} controller=${f.controller}`,
        f.v2Shell === true);
      check(drill, 'D: the V2 page announces the failed update',
        '§4 D: "The V2 page does announce \\"The app could not update – you are still on the previous version.\\""',
        `announce="${f.announce}"`,
        f.announce.includes('could not update'));
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'incomplete-second-reload', f);
      check(drill, 'D: a second visit fails again and the device still stays on V2',
        '§4 D: "each reload re-fetches sw.js and fails again"',
        `/sw.js reads on that reload: ${state.requests.filter((r) => r.path === '/sw.js').length - before}; v2Shell=${f.v2Shell}`,
        f.v2Shell === true);

      state.missing = null; // "fix the tree"
      await navigate(page, `${ORIGIN()}/`, { reload: true });
      f = await readFacts(page);
      recordFacts(drill, 'fixed-tree', f);
      check(drill, 'D: fixing the tree frees the device on the next visit',
        '§4 D: "Fix the tree and the next visit installs."',
        `v1Shell=${f.v1Shell} v2Shell=${f.v2Shell} caches=${f.caches.join(',')}`,
        f.v1Shell === true);
    });
  },
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  for (const [label, dir] of [['dist/', DIST], ['archive live/', V1_LIVE], ['§6 overlay', OVERLAY]]) {
    if (!fs.existsSync(dir)) {
      console.error(`missing ${label} at ${dir}` + (label === 'dist/' ? ' — run npm run build' : ' — see ROLLBACK.md §5 Step 0'));
      process.exit(2);
    }
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`origin http://127.0.0.1:${server.address().port} (v2=dist/, v1=archive live/, v1-overlay=archive + §6 worker)`);
  console.log(`evidence: ${OUT}\n`);

  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = wanted.length ? wanted : Object.keys(drills);
  try {
    for (const name of names) {
      if (!drills[name]) { console.error(`unknown drill: ${name} (have: ${Object.keys(drills).join(', ')})`); process.exit(2); }
      console.log(`\n=== drill ${name} ===`);
      await drills[name]();
      // Reset both the origin and the offline/missing switches between drills.
      state.origin = 'v2';
      state.down = false;
      state.missing = null;
      state.swCacheControl = null;
      state.requests = [];
    }
  } finally {
    server.close();
  }

  const mismatches = results.filter((r) => r.expected !== null && !r.ok);
  const checked = results.filter((r) => r.expected !== null);
  const latencies = navTimings.map((t) => t.latencyMs).sort((a, b) => a - b);
  if (latencies.length) {
    console.log(`\nupdate-check latency after a navigation: min ${latencies[0]}ms, median ${latencies[Math.floor(latencies.length / 2)]}ms, max ${latencies[latencies.length - 1]}ms over ${latencies.length} reads`);
  }
  const report = [
    `rollback rehearsal ${stamp}`,
    `origin: loopback, cache-control: public, max-age=10, no SPA fallback`,
    `drills: ${names.join(', ')}`,
    `checks: ${checked.length}, matched: ${checked.length - mismatches.length}, mismatched: ${mismatches.length}`,
    latencies.length ? `update-check latency after a navigation: min ${latencies[0]}ms, median ${latencies[Math.floor(latencies.length / 2)]}ms, max ${latencies[latencies.length - 1]}ms (${latencies.length} reads)` : 'update-check latency: no /sw.js read recorded',
    '',
    ...mismatches.map((m) => `MISMATCH [${m.drill}] ${m.step}\n  doc: ${m.expected}\n  saw: ${m.actual}`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.txt'), report + '\n');
  console.log(`\n${report}`);
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { server.close(); } catch { /* already closed */ }
  process.exit(2);
});
