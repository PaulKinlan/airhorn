/*
 * tools/resilience-audit.mjs — drive the BUILT Air Horner PWA through its
 * failure states and record what a person would actually see.
 *
 * This is an AUDIT, not a gate: it exits 0 and prints a table whatever it
 * finds. Every scenario gets its own headless Chromium (one browser at a
 * time, closed in a finally), a screenshot, and a row in report.json/report.md.
 *
 * Scenarios (airhorn-ylx):
 *   1. offline after first load      - SW installed, then a real offline reload
 *   2. lie-fi                        - latency+drip emulation: cached nav vs uncached nav
 *   3. SW update while a page is open- new build deployed mid-press
 *   4. storage-quota denial          - QuotaExceededError at install-time precache
 *                                      and at a runtime cache write
 *   5. blocked JS / CSS / font       - third-party-SPOF equivalents for the app's own assets
 *   6. corrupt cache state           - garbage entries served from the precache
 *
 * For each: does it still render, is the horn still usable, does it explain
 * itself to the user (a live region or visible copy)?
 *
 * Usage: node tools/resilience-audit.mjs   (dist/ must exist: npm run build)
 * Evidence: $RESILIENCE_OUT or /tmp/airhorn-resilience/<sha>-<timestamp>/
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

function makeEvidenceDir() {
  if (process.env.RESILIENCE_OUT) return process.env.RESILIENCE_OUT;
  let sha = 'worktree';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch { /* not a git checkout */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('/tmp/airhorn-resilience', `${sha}-${stamp}`);
}

const OUT = makeEvidenceDir();
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ server */

function startServer() {
  const state = { version: '2.0.0-audit-base', overrides: new Map(), lieFi: null };

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }
    // Lie-fi is modelled at the server, not with CDP network emulation: a service
    // worker's own fetch() runs in the worker target, which per-page emulation does
    // not reach (that is how an earlier run of this audit measured a 404 in 303ms and
    // mistook it for a hang). A server that never answers hangs every client.
    if (state.lieFi && state.lieFi.match(pathname)) {
      const { delayMs = 10000, mode = 'destroy' } = state.lieFi;
      const timer = setTimeout(() => {
        if (mode === 'destroy') {
          res.destroy();
        } else {
          res.writeHead(504, { 'content-type': 'text/plain' }).end('gateway timeout');
        }
      }, delayMs);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    const override = state.overrides.get(pathname);
    if (override) {
      res.writeHead(override.status ?? 200, {
        'content-type': override.contentType ?? 'text/html',
        'cache-control': 'no-store',
      });
      res.end(override.body ?? '');
      return;
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (rel === '/sw.js') {
      const text = body.toString()
        .replace(/const version = "[^"]*";/, `const version = "${state.version}";`);
      body = Buffer.from(state.swShim ? state.swShim + '\n' + text : text);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
    });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

/* --------------------------------------------------------------------- CDP */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.log = { console: [], exceptions: [] }; // keyed by sessionId in collectors instead
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      for (const h of this.handlers) {
        try { h(msg); } catch { /* listener bug must not kill the run */ }
      }
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitFor(method, { sessionId, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(handler);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeout);
      const handler = (msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.handlers.delete(handler);
        resolve(msg.params);
      };
      this.handlers.add(handler);
    });
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

async function launchBrowser() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-resilience-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome launch timeout')), 20000);
    proc.stderr.on('data', (d) => {
      const m = d.toString().match(/ws:\/\/\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
  });

  const cdp = await Cdp.connect(wsUrl);
  return { proc, cdp, profileDir };
}

async function closeBrowser(browser) {
  if (!browser) return;
  try { await browser.cdp.send('Browser.close'); } catch { /* already dead */ }
  try { browser.proc.kill('SIGKILL'); } catch { /* already dead */ }
  browser.cdp.close();
  try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ----------------------------------------------------- page instrumentation */

const PROBE = `
(() => {
  window.__probe = { bufferStarts: 0, oscStarts: 0 };
  window.__errors = [];
  window.__marker = Math.random().toString(36).slice(2) + Date.now();
  window.addEventListener('error', (e) => window.__errors.push('error: ' + (e.message || String(e))));
  window.addEventListener('unhandledrejection', (e) => {
    window.__errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason));
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    if (AC.prototype.createBufferSource) {
      const orig = AC.prototype.createBufferSource;
      AC.prototype.createBufferSource = function (...a) {
        const node = orig.apply(this, a);
        const start = node.start.bind(node);
        node.start = (...x) => { window.__probe.bufferStarts++; return start(...x); };
        return node;
      };
    }
    if (AC.prototype.createOscillator) {
      const orig = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function (...a) {
        const node = orig.apply(this, a);
        const start = node.start.bind(node);
        node.start = (...x) => { window.__probe.oscStarts++; return start(...x); };
        return node;
      };
    }
  }
  if ('serviceWorker' in navigator) {
    window.__controllerChanges = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => { window.__controllerChanges += 1; });
  }
})();
`;

const READ_STATE = `(() => {
  const horn = document.querySelector('.horn');
  const rect = horn ? horn.getBoundingClientRect() : null;
  const cs = horn ? getComputedStyle(horn) : null;
  const visible = !!(
    horn && rect && rect.width > 4 && rect.height > 4 &&
    cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
  );
  // What the platform says is rendered AND readable (airhorn-od1):
  // checkVisibility covers display:none, the hidden attribute, closed
  // <details>, opacity:0, and visibility with its inheritable-override
  // semantics - a visibility:visible region inside a hidden ancestor IS
  // shown, which an ancestor walk gets wrong in the opposite direction
  // (airhorn-4jw). But content-visibility:hidden keeps the element's box
  // (checkVisibility says true) while skipping its contents - innerText is
  // empty there - so a region with text is only 'shown' if its text survives
  // into innerText. A visually-hidden-but-rendered region - the app-status
  // pattern - still counts: innerText is non-empty for it, and what matters
  // is whether the region HAS something to say.
  // Open shadow roots are invisible to querySelectorAll, so a page whose
  // alert lives in one was reported 'explains itself: NO' while the user
  // saw it plainly (airhorn-70o): recurse through them. Closed roots are
  // unreachable from script - a noted limit, not worked around.
  const collectRegions = (root) => {
    const found = [...root.querySelectorAll('[role="status"],[role="alert"],[aria-live]')];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...collectRegions(el.shadowRoot));
    }
    return found;
  };
  // ONE instrument for everything the audit reads as text (airhorn-w4k,
  // airhorn-ami): walk the composed tree - light DOM plus open shadow roots,
  // any depth - and collect each rendered element's own direct text nodes.
  // A node the platform does not render (display:none, [hidden], closed
  // <details>, content-visibility, opacity:0; checkVisibility knows all of
  // them, including ancestors) contributes nothing, so a hidden shadow
  // message can neither earn nor fake 'explains itself', and nested shadows
  // are descended instead of stopping at one level.
  const renderedFragments = (root) => {
    const out = [];
    // A shadow root renders through its host; elements render through
    // checkVisibility (ancestors included); documents are always read.
    const rendered = (n) => {
      if (n.nodeType === 11 && n.host) n = n.host;
      if (n.nodeType !== 1) return true;
      // Walk ancestors: a descendant's own checkVisibility does not see an
      // ANCESTOR's content-visibility skip (airhorn-v3t); c-v:hidden is a
      // definite skip, c-v:auto skips when the ancestor itself is not
      // rendered (which checkVisibility reports for that ancestor).
      for (let a = n; a; a = a.parentElement) {
        if (a.checkVisibility && !a.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true })) return false;
        if (getComputedStyle(a).contentVisibility === 'hidden') return false;
      }
      return true;
    };
    const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3)
      .map((c) => c.textContent).join(' ').replace(/\\s+/g, ' ').trim();
    const visit = (node) => {
      // The node's OWN shadow root first: a shadow child is not in the
      // light traversal, so without this its subtree - and its shadow -
      // is never seen (airhorn-ami).
      if (node.shadowRoot) visit(node.shadowRoot);
      // The visited ROOT's own direct text nodes: querySelectorAll('*')
      // returns descendants only, so a light-DOM region whose message is
      // its own text node would read empty and flip 'explains itself'
      // to NO (airhorn-q8j). Each element's own text is collected exactly
      // once - as its parent-traversal's 'own', or here for the root.
      if (rendered(node)) {
        const rootOwn = ownText(node);
        if (rootOwn) out.push(rootOwn);
      }
      for (const child of node.querySelectorAll('*')) {
        if (!rendered(child)) continue;
        const own = ownText(child);
        if (own) out.push(own);
        if (child.shadowRoot) visit(child.shadowRoot);
      }
    };
    visit(root);
    return out;
  };
  const live = collectRegions(document).map((el) => {
      const vis = typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true })
        : !el.hidden && getComputedStyle(el).display !== 'none';
      const text = renderedFragments(el).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
      return {
        role: el.getAttribute('role'),
        live: el.getAttribute('aria-live'),
        shown: vis && text.length > 0,
        text,
      };
    });
  const bodyText = renderedFragments(document).join(' ')
    .replace(/\\s+/g, ' ').trim().slice(0, 600);
  let navType = null;
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    navType = entry ? entry.type : null;
  } catch { /* older engines */ }
  return {
    title: document.title,
    readyState: document.readyState,
    url: location.href,
    navType,
    horn: horn
      ? { present: true, visible, width: Math.round(rect.width), height: Math.round(rect.height),
          ariaPressed: horn.getAttribute('aria-pressed'), ariaLabel: horn.getAttribute('aria-label') }
      : { present: false, visible: false },
    live,
    bodyText,
    controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    controllerChanges: window.__controllerChanges || 0,
    marker: window.__marker || null,
    probe: window.__probe || null,
    errors: window.__errors || [],
    online: navigator.onLine,
  };
})()`;

function makeCollectors(cdp) {
  const bySession = new Map();
  const get = (sessionId) => {
    if (!bySession.has(sessionId)) bySession.set(sessionId, { console: [], exceptions: [] });
    return bySession.get(sessionId);
  };
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      get(msg.sessionId).exceptions.push(
        (d.exception && d.exception.description) || d.text || 'exception',
      );
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      get(msg.sessionId).console.push(`${msg.params.type}: ${text}`);
    }
  });
  return get;
}

/* ----------------------------------------------------------- page controls */

async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sessionId);
  return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

async function navigate(cdp, sessionId, url, timeout = 12000) {
  const loaded = cdp.waitFor('Page.loadEventFired', { sessionId, timeout }).then(() => true).catch(() => false);
  await cdp.send('Page.navigate', { url }, sessionId).catch(() => {});
  const ok = await loaded;
  if (ok) await sleep(250);
  return ok;
}

async function reload(cdp, sessionId, timeout = 12000) {
  const loaded = cdp.waitFor('Page.loadEventFired', { sessionId, timeout }).then(() => true).catch(() => false);
  await cdp.send('Page.reload', {}, sessionId).catch(() => {});
  const ok = await loaded;
  if (ok) await sleep(250);
  return ok;
}

async function waitForSw(cdp, sessionId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const state = await evaluate(cdp, sessionId, `navigator.serviceWorker.ready
      .then((reg) => (reg.active ? reg.active.state : null))
      .catch(() => null)`).catch(() => null);
    if (state === 'activated') return true;
    await sleep(150);
  }
  return false;
}

async function readState(cdp, sessionId) {
  return evaluate(cdp, sessionId, READ_STATE);
}

/** Real pointer press on the horn: does it respond, and does audio actually run? */
async function pressHorn(cdp, sessionId) {
  const box = await evaluate(cdp, sessionId, `(() => {
    const horn = document.querySelector('.horn');
    if (!horn) return null;
    const r = horn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!box || box.w < 2 || box.h < 2) {
    return { dispatched: false, responded: false, sounded: false, reason: 'horn has no hit area' };
  }
  const before = await evaluate(cdp, sessionId, 'window.__probe ? (window.__probe.bufferStarts + window.__probe.oscStarts) : -1');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1,
  }, sessionId);
  await sleep(600);
  const mid = await readState(cdp, sessionId);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1,
  }, sessionId);
  await sleep(150);
  const after = await evaluate(cdp, sessionId, 'window.__probe ? (window.__probe.bufferStarts + window.__probe.oscStarts) : -1');
  const started = before >= 0 && after > before;
  return {
    dispatched: true,
    ariaPressedWhileHeld: mid.horn.ariaPressed,
    responded: mid.horn.ariaPressed === 'true',
    sounded: started,
    audioStarts: { before, after },
  };
}

async function shot(cdp, sessionId, name) {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  } catch {
    return null;
  }
}

const EXPLAINS_RE = /offline|no connection|can.?t (?:reach|load|connect)|failed to load|unable to|retry|reconnect|try again|update available|new version|something went wrong|error/i;

function summarise(state) {
  // Evidence is what the page actually says somewhere rendered (airhorn-01e):
  // a region with no text, or a hidden one, explains nothing.
  const liveEvidence = (state.live || []).filter((l) => l.shown && l.text);
  const liveText = liveEvidence.map((l) => l.text).join(' | ');
  const mentions = state.bodyText.match(EXPLAINS_RE);
  return {
    renders: state.horn.present,
    hornVisible: state.horn.visible,
    hornSize: state.horn.present ? `${state.horn.width}x${state.horn.height}` : null,
    title: state.title,
    navType: state.navType ?? null,
    liveRegions: state.live.length,
    shownLiveRegions: liveEvidence.length,
    liveText,
    explainsItself: liveEvidence.length > 0 || !!mentions,
    explanationEvidence: liveText || (mentions ? `body text mentions "${mentions[0]}"` : 'none'),
    controller: state.controller,
    controllerChanges: state.controllerChanges,
    online: state.online,
    pageErrors: state.errors,
  };
}

/* --------------------------------------------------------------- scenarios */

const results = [];

async function withBrowser(id, name, fn) {
  let browser = null;
  let result = { id, name };
  try {
    browser = await launchBrowser();
    const collectors = makeCollectors(browser.cdp);
    result = { id, name, ...(await fn(browser, collectors)) };
  } catch (err) {
    result = { id, name, error: String((err && err.message) || err) };
  } finally {
    await closeBrowser(browser);
  }
  results.push(result);
  const verdict = result.error
    ? `ERROR ${result.error}`
    : `renders=${result.renders} hornVisible=${result.hornVisible} hornUsable=${result.hornUsable} explains=${result.explainsItself}`;
  console.log(`[${id}] ${name}\n  ${verdict}`);
}

async function runAudit() {
  const { server, port, state } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const reset = () => {
    state.version = '2.0.0-audit-base';
    state.swShim = null;
    state.overrides.clear();
    state.lieFi = null;
  };

  // RESILIENCE_ONLY=liefi,update re-runs just those scenarios (they all share one server).
  const only = (process.env.RESILIENCE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const want = (id) => only.length === 0 || only.includes(id);

  try {
    /* ---- 1. real offline after first load ---- */
    if (want('offline')) await withBrowser('offline', 'offline after first load', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const swActive = await waitForSw(cdp, sessionId);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      }, sessionId);
      const loaded = await reload(cdp, sessionId);
      const st = await readState(cdp, sessionId);
      const horn = await pressHorn(cdp, sessionId);
      const shotFile = await shot(cdp, sessionId, '1-offline');
      return {
        swActive,
        navigationCompleted: loaded,
        ...summarise(st),
        hornUsable: horn.sounded,
        hornCheck: horn,
        screenshot: shotFile,
        pageErrors: [...(st.errors || []), ...collectors(sessionId).exceptions],
        console: collectors(sessionId).console,
      };
    });

    /* ---- 2. lie-fi: cached navigation vs a navigation the precache does not cover ---- */
    if (want('liefi')) await withBrowser('liefi', 'lie-fi (nav hangs then fails)', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const swActive = await waitForSw(cdp, sessionId);

      // The connection answers, then dies without a response: the classic lie-fi.
      state.lieFi = { match: () => true, delayMs: 9000, mode: 'destroy' };

      // (a) the precached shell should still be instant, lie-fi or not
      const cachedStart = Date.now();
      const cachedLoaded = await reload(cdp, sessionId, 8000);
      const cachedMs = Date.now() - cachedStart;
      const cachedState = cachedLoaded ? await readState(cdp, sessionId) : null;

      // (b) an in-page request the precache does not cover: the SW falls through to
      //     fetch() with no timeout and no catch, so it hangs for as long as the
      //     connection does
      const subresource = await evaluate(cdp, sessionId, `(async () => {
        const started = Date.now();
        const raced = await Promise.race([
          fetch('/images/touch/android-launchericon-192-192.png')
            .then((r) => ({ settled: true, status: r.status }))
            .catch((e) => ({ settled: true, error: String(e && e.message || e) })),
          new Promise((r) => setTimeout(() => r({ settled: false }), 6000)),
        ]);
        return { ...raced, waitedMs: Date.now() - started };
      })()`);

      // (c) a navigation the precache does not cover: it must be served by the network,
      //     which hangs and then fails
      const uncachedStart = Date.now();
      const uncachedLoaded = await navigate(cdp, sessionId, `${origin}/deep-link`, 12000);
      const uncachedMs = Date.now() - uncachedStart;
      const uncachedState = await readState(cdp, sessionId).catch(() => null);
      const shotFile = await shot(cdp, sessionId, '2-liefi-uncached-nav');
      // Headline usability is MEASURED on the post-navigation state (airhorn-dse,
      // the airhorn-0aq instrument): the literal `false` here called the horn
      // unusable while the same row's measured state showed it rendered and
      // visible - a failed navigation leaves the previous (cached, working)
      // document on screen, and that is the truth to report. No document at
      // all (uncachedState null) earns false without a press.
      const hornAfterUncached = uncachedState ? await pressHorn(cdp, sessionId) : null;
      return {
        swActive,
        cachedNavigation: { completed: cachedLoaded, ms: cachedMs,
          hornPresent: cachedState ? cachedState.horn.present : false },
        uncachedSubresource: subresource,
        uncachedNavigation: { completed: uncachedLoaded, ms: uncachedMs },
        ...(uncachedState ? summarise(uncachedState) : { renders: false, hornVisible: false,
          explainsItself: false, explanationEvidence: 'no document at all' }),
        hornUsable: hornAfterUncached ? hornAfterUncached.sounded : false,
        hornCheck: hornAfterUncached || { sounded: false, reason: 'no document after the uncached navigation' },
        cachedShellWasAvailable: cachedLoaded,
        screenshot: shotFile,
        console: collectors(sessionId).console,
        pageErrors: uncachedState ? uncachedState.errors : [],
      };
    });

    /* ---- 3. service worker update while a page is open (and pressed) ---- */
    if (want('update')) await withBrowser('update', 'SW update while page is open', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const swActive = await waitForSw(cdp, sessionId);
      const before = await readState(cdp, sessionId);

      // Count real document swaps, not markers: a reload replaces the document and
      // its performance.navigation entry reads 'reload'.
      let navigations = 0;
      const stopCounting = cdp.on((msg) => {
        if (msg.method === 'Page.frameNavigated' && msg.sessionId === sessionId) navigations += 1;
      });

      // Hold the horn, then deploy a new build underneath the user.
      const box = await evaluate(cdp, sessionId, `(() => {
        const r = document.querySelector('.horn').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1,
      }, sessionId);
      await sleep(400);
      const pressedState = await readState(cdp, sessionId);

      state.version = '2.0.0-audit-next';
      await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => reg && reg.update()).then(() => true).catch(() => false)`);
      await sleep(3000);

      const afterState = await readState(cdp, sessionId).catch(() => null);
      stopCounting();
      const reloaded = navigations > 0 || (!!afterState && before.marker !== afterState.marker);
      const shotFile = await shot(cdp, sessionId, '3-update-mid-press');

      // After the dust settles, is it still a horn?
      const horn = await pressHorn(cdp, sessionId);
      const finalState = await readState(cdp, sessionId);
      return {
        swActive,
        pressedWhileHeld: pressedState.horn.ariaPressed,
        autoReloaded: reloaded,
        navigationsObserved: navigations,
        navTypeAfterUpdate: finalState.navType,
        controllerChanges: finalState.controllerChanges,
        ...summarise(finalState),
        hornUsable: horn.sounded,
        hornCheck: horn,
        pressInterrupted: pressedState.horn.ariaPressed === 'true' && reloaded,
        screenshot: shotFile,
        console: collectors(sessionId).console,
        pageErrors: finalState.errors,
      };
    });

    /* ---- 4. storage-quota denial on a cache write ---- */
    if (want('quota')) await withBrowser('quota', 'storage-quota denial on cache write', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const swActive = await waitForSw(cdp, sessionId);

      // (a) install-time precache is denied: the new worker's addAll rejects.
      state.swShim = `Cache.prototype.addAll = () => Promise.reject(
        new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
      Cache.prototype.put = () => Promise.reject(
        new DOMException('The quota has been exceeded.', 'QuotaExceededError'));`;
      state.version = '2.0.0-audit-quota';
      const updateOutcome = await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => reg && reg.update()).then(() => 'update-called').catch((e) => 'update-failed: ' + e.message)`);
      await sleep(2500);
      const registration = await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => reg ? {
          installing: reg.installing ? reg.installing.state : null,
          waiting: reg.waiting ? reg.waiting.state : null,
          active: reg.active ? reg.active.state : null,
        } : null).catch(() => null)`);
      const cachesList = await evaluate(cdp, sessionId, `caches.keys().catch(() => [])`);
      const afterQuota = await readState(cdp, sessionId);

      // Did the failed install break the app the user already has?
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      }, sessionId);
      const offlineLoaded = await reload(cdp, sessionId);
      const offlineState = await readState(cdp, sessionId);
      const horn = await pressHorn(cdp, sessionId);
      const shotFile = await shot(cdp, sessionId, '4-quota-offline-after-failed-install');
      return {
        swActive,
        updateOutcome,
        registration,
        caches: cachesList,
        stillRenderedAfterFailedInstall: afterQuota.horn.present,
        offlineNavigationCompleted: offlineLoaded,
        ...summarise(offlineState),
        hornUsable: horn.sounded,
        hornCheck: horn,
        screenshot: shotFile,
        console: collectors(sessionId).console,
        pageErrors: [...afterQuota.errors, ...offlineState.errors],
      };
    });

    /* ---- 5. blocked JS / CSS / font ---- */
    if (want('blocked')) await withBrowser('blocked', 'blocked JS / CSS / font', async ({ cdp }, collectors) => {
      reset();
      // Baseline: the same page with nothing blocked, so "degraded" is measured,
      // not guessed.
      const baselinePage = await openPage(cdp);
      await navigate(cdp, baselinePage.sessionId, `${origin}/`);
      await sleep(500);
      const baseline = await readState(cdp, baselinePage.sessionId);
      const baselineArea = baseline.horn.present
        ? baseline.horn.width * baseline.horn.height
        : 0;
      await cdp.send('Target.closeTarget', { targetId: baselinePage.targetId }).catch(() => {});

      const sub = async (label, urls) => {
        const { targetId, sessionId } = await openPage(cdp);
        await cdp.send('Network.setBlockedURLs', { urls }, sessionId);
        const loaded = await navigate(cdp, sessionId, `${origin}/`);
        await sleep(600);
        const st = await readState(cdp, sessionId);
        const horn = await pressHorn(cdp, sessionId);
        const shotFile = await shot(cdp, sessionId, `5-${label}`);
        const area = st.horn.present ? st.horn.width * st.horn.height : 0;
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        return {
          label,
          blocked: urls,
          navigationCompleted: loaded,
          ...summarise(st),
          hornArea: area,
          baselineHornArea: baselineArea,
          degraded: baselineArea > 0 ? area < baselineArea * 0.5 : area === 0,
          hornUsable: horn.sounded,
          hornResponded: horn.responded,
          hornCheck: horn,
          screenshot: shotFile,
          pageErrors: [...st.errors, ...collectors(sessionId).exceptions],
        };
      };

      const js = await sub('blocked-js', ['*assets/*.js', '*src/main.js*']);
      const css = await sub('blocked-css', ['*styles/*.css', '*assets/*.css']);

      // Fonts: does the app request any web font at all?
      const { sessionId } = await openPage(cdp);
      const fontRequests = [];
      cdp.on((msg) => {
        if (msg.method !== 'Network.requestWillBeSent') return;
        if (msg.sessionId !== sessionId) return;
        const type = msg.params.type;
        const url = msg.params.request.url;
        if (type === 'Font' || /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) fontRequests.push(url);
      });
      await navigate(cdp, sessionId, `${origin}/`);
      await sleep(800);
      const fontState = await readState(cdp, sessionId);
      const fontFace = await evaluate(cdp, sessionId,
        `getComputedStyle(document.querySelector('.horn')).fontFamily`);
      const fontShot = await shot(cdp, sessionId, '5-fonts');

      return {
        // top-level row describes the worst blocked-asset case, the CSS one
        ...css,
        subCases: { js, css },
        baselineHornSize: baseline.horn.present ? `${baseline.horn.width}x${baseline.horn.height}` : null,
        fonts: {
          requestedUrls: fontRequests,
          webFontUsed: fontRequests.length > 0 || /@font-face/i.test(fontFace || ''),
          computedFontFamily: fontFace,
          note: fontRequests.length === 0
            ? 'no web font is requested; blocking fonts cannot affect this page'
            : 'web font requested',
          screenshot: fontShot,
          renders: fontState.horn.present,
        },
        console: collectors(sessionId).console,
      };
    });

    /* ---- 6. corrupt cache state ---- */
    if (want('corrupt')) await withBrowser('corrupt', 'corrupt cache state', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const swActive = await waitForSw(cdp, sessionId);

      const cacheInfo = await evaluate(cdp, sessionId, `(async () => {
        const names = await caches.keys();
        const name = names.find((n) => n.startsWith('airhorner-'));
        if (!name) return { name: null, urls: [] };
        const cache = await caches.open(name);
        const keys = await cache.keys();
        return { name, urls: keys.map((r) => new URL(r.url).pathname) };
      })()`);
      const assetUrl = (cacheInfo.urls || []).find((u) => u.startsWith('/assets/'));

      // Corrupt the cached JS bundle: valid response, broken body.
      const jsCorrupted = await evaluate(cdp, sessionId, `(async () => {
        const name = (await caches.keys()).find((n) => n.startsWith('airhorner-'));
        if (!name) return 'no cache';
        const cache = await caches.open(name);
        const target = (await cache.keys())
          .map((r) => r.url).find((u) => new URL(u).pathname.startsWith('/assets/'));
        if (!target) return 'no hashed asset in cache';
        await cache.put(new Request(target), new Response('this is not javascript',
          { headers: { 'content-type': 'application/javascript' } }));
        return target;
      })()`);

      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      }, sessionId);
      const offlineLoaded = await reload(cdp, sessionId);
      const afterJsCorruption = await readState(cdp, sessionId);
      const hornAfterJs = await pressHorn(cdp, sessionId);
      const jsShot = await shot(cdp, sessionId, '6-corrupt-asset-offline');

      // Now corrupt the shell itself.
      const shellCorrupted = await evaluate(cdp, sessionId, `(async () => {
        const name = (await caches.keys()).find((n) => n.startsWith('airhorner-'));
        if (!name) return 'no cache';
        const cache = await caches.open(name);
        const keys = await cache.keys();
        let touched = 0;
        for (const request of keys) {
          const p = new URL(request.url).pathname;
          if (p === '/' || p === '/index.html') {
            await cache.put(new Request(request.url), new Response(
              '<!doctype html><title>corrupt</title><body><p>cache entry is garbage</p>',
              { headers: { 'content-type': 'text/html' } }));
            touched += 1;
          }
        }
        return touched;
      })()`);
      const shellLoaded = await reload(cdp, sessionId);
      const afterShellCorruption = await readState(cdp, sessionId);
      const shellShot = await shot(cdp, sessionId, '6-corrupt-shell-offline');
      const hornAfterShell = await pressHorn(cdp, sessionId);

      // Back online: does the app recover by itself, or is the poison sticky?
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }, sessionId);
      await reload(cdp, sessionId);
      const onlineAgain = await readState(cdp, sessionId);
      await reload(cdp, sessionId);
      const onlineSecond = await readState(cdp, sessionId);
      await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => reg && reg.update()).then(() => true).catch(() => false)`);
      await sleep(1500);
      const afterUpdate = await readState(cdp, sessionId).catch(() => null);
      const finalShot = await shot(cdp, sessionId, '6-corrupt-after-online-update');

      return {
        swActive,
        cache: cacheInfo,
        assetUrl,
        corruptedAsset: jsCorrupted,
        offlineNavigationCompleted: offlineLoaded,
        rendersAfterAssetCorruption: afterJsCorruption.horn.present,
        hornVisibleAfterAssetCorruption: afterJsCorruption.horn.visible,
        hornUsableAfterAssetCorruption: hornAfterJs.sounded,
        corruptedShellEntries: shellCorrupted,
        shellNavigationCompleted: shellLoaded,
        rendersAfterShellCorruption: afterShellCorruption.horn.present,
        hornUsableAfterShellCorruption: hornAfterShell.sounded,
        // the headline row: the state after both corruptions, with every
        // headline field MEASURED (airhorn-0aq). The literal `hornUsable:
        // false` here outlived the bug it described - once the worker healed
        // corrupt entries again (airhorn-un5), the row still claimed the app
        // was unusable while the per-stage measurement said otherwise.
        renders: afterShellCorruption.horn.present,
        hornVisible: afterShellCorruption.horn.visible,
        ...summarise(afterShellCorruption),
        hornUsable: hornAfterShell.sounded,
        recoveredOnline: !!onlineAgain && onlineAgain.horn.present,
        recoveredAfterSecondLoad: !!onlineSecond && onlineSecond.horn.present,
        recoveredAfterSwUpdate: !!(afterUpdate && afterUpdate.horn.present),
        screenshots: [jsShot, shellShot, finalShot],
        console: collectors(sessionId).console,
        pageErrors: [...afterJsCorruption.errors, ...afterShellCorruption.errors],
      };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  /* ------------------------------------------------------------ reporting */

  const report = {
    target: 'airhorn',
    auditedAt: new Date().toISOString(),
    origin: 'local dist/ over http (headless Chromium, CDP)',
    scenarios: results,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  const row = (r) => [
    r.id,
    r.name,
    r.error ? 'ERROR' : (r.renders ? 'yes' : 'NO'),
    r.error ? '-' : (r.hornVisible ? 'yes' : 'NO'),
    r.error ? '-' : (r.hornUsable ? 'yes' : 'NO'),
    r.error ? '-' : (r.explainsItself ? `yes (${r.explanationEvidence})` : 'NO'),
    r.error || '',
  ];
  const lines = [
    '# Air Horner resilience audit',
    '',
    `Target: ${report.target} — built \`dist/\` served over http, one headless Chromium per scenario.`,
    `Audited: ${report.auditedAt}`,
    '',
    '| scenario | renders | horn visible | horn usable | explains itself | note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const c = row(r);
      return `| ${c[0]} — ${c[1]} | ${c[2]} | ${c[3]} | ${c[4]} | ${c[5]} | ${c[6]} |`;
    }),
    '',
    '## Detail',
    ...results.map((r) => {
      const keep = { ...r };
      delete keep.console;
      return `\n### ${r.id} — ${r.name}\n\n\`\`\`json\n${JSON.stringify(keep, null, 2)}\n\`\`\`\n`;
    }),
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));

  console.log(`\n${lines.slice(5, 6 + results.length).join('\n')}\n`);
  console.log(`Evidence: ${OUT}`);
  console.log('\nThis is an audit: exit 0 whatever it found. File findings against the bead, do not gate on it.');
}

runAudit().catch((err) => {
  console.error('audit harness failed:', err);
  process.exit(1);
});
