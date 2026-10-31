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
 *   2. lie-fi                        - app-shell navigation + bounded subresource
 *                                      vs a connection that hangs then dies
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


// The one profile-marker sweep (airhorn-mgcl, ported from fleet/leaks b6e44fb):
// the fifth local copy is gone - ENOENT-only silence, stderr warning otherwise,
// and the shared module's three passes include the fork-race pass this copy
// had lost.
import { launchChrome } from './lib/chrome.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRenderModel } from './render-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
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

  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    // Bounded like every other wait in the launch window: a peer that
    // completes the HTTP discovery and never finishes the ws upgrade must
    // reject instead of parking the tool with its launch alive (airhorn-e4im,
    // same class as airhorn-doek).
    await new Promise((resolve, reject) => {
      // The rejected paths close the socket too: a half-open ws keeps the
      // event loop alive and the audit never exits after a failed scenario.
      const bound = setTimeout(() => {
        try { ws.close(); } catch { /* never opened */ }
        reject(new Error(`DevTools ws handshake timeout: ${wsUrl} never opened within ${timeoutMs}ms`));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(bound); resolve(); };
      ws.onerror = () => {
        clearTimeout(bound);
        try { ws.close(); } catch { /* already closed */ }
        reject(new Error(`cannot connect to ${wsUrl}`));
      };
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The reply wait is bounded like every wait in the launch window
      // (airhorn-1t5c, the nbh9 class): a peer that completes the upgrade and
      // never replies rejects labelled instead of parking the audit before
      // its fail() teardown can run.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP reply timeout: ${method} got no reply within 30000ms`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
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
  // One launcher owns the browser, its process tree and its profile
  // (airhorn-2po9). discoverPage:false is this audit's shape: it attaches CDP
  // sessions to targets it creates, so there is no pre-made page to discover
  // and no /json/list fetch to bound. The startup bound, the process group, the
  // tree kill and the profile rm are the launcher's.
  const handle = await launchChrome({
    label: 'resilience',
    autoplay: true,
    extraFlags: ['--no-first-run'],
    timeoutMs: 20000,
    discoverPage: false,
  });
  try {
    const cdp = await Cdp.connect(handle.browserWsUrl);
    return { handle, cdp };
  } catch (err) {
    // The socket never opened, so nothing downstream owns this launch
    // (airhorn-e4im's teardown, now the launcher's).
    await handle.close();
    throw err;
  }
}

async function closeBrowser(browser) {
  if (!browser) return;
  try { await browser.cdp.send('Browser.close'); } catch { /* already dead */ }
  browser.cdp.close();
  // close() is the launcher's one teardown: the marker sweep ends the
  // renderers/cache children a main-only kill leaves behind to recreate files
  // after the rm (airhorn-jx9, airhorn-nn26), then the pid kill as belt and
  // braces, then the rm with its retries - all before its first await.
  await browser.handle.close();
}

/* ----------------------------------------------------- page instrumentation */

// Mutation seam (airhorn-nxuv.9): under test mode, the real start() is
// replaced by one that throws, so the probe must leave its counters
// UNCHANGED and record the throw - the proof the counter tracks playback,
// not intent. Honoured only with RESILIENCE_TEST_MODE=1, like the stub seam.
const START_THROWS_SEAM = process.env.RESILIENCE_TEST_MODE === '1'
  && process.env.RESILIENCE_START_THROWS === '1';
// A seam env var without the test mode must SAY it was dropped
// (airhorn-t00l): a silent ignore produces a GREEN, honest-looking audit
// that can be misrecorded as RED evidence. The stub seam already warns this
// way; the load-time seam warns here, the scenario-time ones in runAudit.
if (process.env.RESILIENCE_START_THROWS && process.env.RESILIENCE_TEST_MODE !== '1') {
  console.warn('RESILIENCE_START_THROWS is honoured only with RESILIENCE_TEST_MODE=1 - ignoring it and running the real audit.');
}

const PROBE = `
(() => {
  window.__probe = { bufferStarts: 0, oscStarts: 0, startThrows: 0, lastStartError: null };
  window.__errors = [];
  window.__marker = Math.random().toString(36).slice(2) + Date.now();
  window.addEventListener('error', (e) => window.__errors.push('error: ' + (e.message || String(e))));
  window.addEventListener('unhandledrejection', (e) => {
    window.__errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason));
  });
  // A start() counts only when playback actually STARTED: run it FIRST and
  // increment after it returns (airhorn-nxuv.9). The old order (++ before
  // start) recorded intent, so a start() that threw still read as a buffer
  // started - absence looked like success. A throw is counted as a THROW,
  // with the message kept, so a failed start is an explicit outcome in the
  // record, not a zero that looks healthy. (The app swallows start() throws
  // - airhorn.js .catch(() => false) and horn.js try/catch around osc.start -
  // so without this the failure would be invisible everywhere.)
  const wrapStart = (node, field) => {
    const start = ${START_THROWS_SEAM
      ? '() => { throw new Error("start() forced to throw (mutation seam airhorn-nxuv.9)"); }'
      : 'node.start.bind(node)'};
    node.start = (...x) => {
      try {
        const r = start(...x);
        window.__probe[field]++;
        return r;
      } catch (e) {
        window.__probe.startThrows++;
        window.__probe.lastStartError = String((e && e.message) || e);
        throw e;
      }
    };
  };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    if (AC.prototype.createBufferSource) {
      const orig = AC.prototype.createBufferSource;
      AC.prototype.createBufferSource = function (...a) {
        const node = orig.apply(this, a);
        wrapStart(node, 'bufferStarts');
        return node;
      };
    }
    if (AC.prototype.createOscillator) {
      const orig = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function (...a) {
        const node = orig.apply(this, a);
        wrapStart(node, 'oscStarts');
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

// Exported so a diagnostic can drive the SAME instrument the audit runs
// (there is no second copy of the page code - airhorn-0w9).
export const READ_STATE = `(() => {
  const horn = document.querySelector('.horn');
  const rect = horn ? horn.getBoundingClientRect() : null;
  const cs = horn ? getComputedStyle(horn) : null;
  const visible = !!(
    horn && rect && rect.width > 4 && rect.height > 4 &&
    cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
  );
  // The decision itself is NOT here (airhorn-0w9, -cpi, -9py): it lives in
  // tools/render-model.mjs and is injected BY SOURCE, so the instrument
  // Chromium runs is byte-identical to the one tests/gate-smoke.test.js pins
  // in Node. 'shown' used to be checkVisibility(el) while 'text' came from
  // this walk, and every finding in that lineage was the two disagreeing.
  const model = (${makeRenderModel.toString()})();
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
  // The adapter supplies FACTS only, never verdicts, so there is exactly one
  // place a decision can be wrong - the tested model above.
  // Is the box chain (display, [hidden], closed <details>, opacity, c-v)
  // painted? Asked WITHOUT visibilityProperty: visibility does not take a box
  // away, and a visibility:visible descendant of a hidden ancestor must keep
  // its text in every walk, including the body read (airhorn-od1, -s52).
  // A boxed element answers for itself (checkVisibility includes its
  // ancestors); a display:contents element has no box at all (measured:
  // false even while plainly painted), so its nearest BOXED ancestor answers.
  const boxOptions = { opacityProperty: true, contentVisibilityAuto: true };
  const boxChainOf = (el, style) => {
    const answers = (n) => {
      if (typeof n.checkVisibility === 'function') return n.checkVisibility(boxOptions);
      const s = getComputedStyle(n);
      return s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    if (style.display !== 'contents') return answers(el);
    const up = (n) => n.parentElement || (n.getRootNode ? n.getRootNode().host : null);
    let n = up(el);
    while (n && getComputedStyle(n).display === 'contents') n = up(n);
    return n ? answers(n) : true; // nothing above to ask: we are the root
  };
  const ownTextOf = (n) => [...(n.childNodes || [])].filter((c) => c.nodeType === 3)
    .map((c) => c.textContent).join(' ').replace(/\\s+/g, ' ').trim();
  const adapter = (node) => {
    // A shadow root renders through its host, so the host carries its facts.
    const host = node.nodeType === 11 && node.host ? node.host : node;
    let facts = { type: 'other' };
    if (host.nodeType === 1) {
      const style = getComputedStyle(host);
      facts = {
        type: 'element',
        display: style.display,
        contentVisibility: style.contentVisibility,
        boxChain: boxChainOf(host, style),
        // Used values: visibility inherits (with an override allowed at any
        // level), opacity does not.
        visibility: style.visibility,
        opacity: Number(style.opacity),
      };
      // The two layout queries are read only by the c-v branch, so an ordinary
      // element never pays for them.
      Object.defineProperty(facts, 'hasTextContent', { get: () => (host.textContent || '').trim() !== '' });
      Object.defineProperty(facts, 'renderedText', { get: () => (host.innerText || '').trim() });
    }
    return {
      facts,
      ownText: ownTextOf(node),
      // DIRECT element children: each node is visited exactly once, and its
      // own text nodes with it (airhorn-q8j, airhorn-ami).
      elements: [...(node.children || [])],
      shadow: node.shadowRoot || null,
    };
  };
  const live = collectRegions(document).map((el) => {
    // shown IS 'the composed rendered text is non-empty': one decision, so the
    // verdict and its evidence cannot disagree (airhorn-0w9).
    const text = model.renderedText(el, adapter).slice(0, 200);
    return {
      role: el.getAttribute('role'),
      live: el.getAttribute('aria-live'),
      shown: text.length > 0,
      text,
    };
  });
  const bodyText = model.renderedText(document, adapter).slice(0, 600);
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

export async function waitForSw(cdp, sessionId, attempts = 40, sleepFn = sleep) {
  let lastState = null;
  let evaluateErrors = 0;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await evaluate(cdp, sessionId, `(() => {
        if (!('serviceWorker' in navigator)) {
          return { status: 'unsupported', error: 'navigator.serviceWorker is not supported in this browser context' };
        }
        return navigator.serviceWorker.getRegistration().then((reg) => {
          if (!reg) return { status: 'unregistered', detail: 'no service worker registration found' };
          if (reg.active && reg.active.state === 'activated') {
            return { status: 'activated' };
          }
          const installing = reg.installing ? reg.installing.state : null;
          const waiting = reg.waiting ? reg.waiting.state : null;
          const active = reg.active ? reg.active.state : null;
          if (installing === 'redundant' || waiting === 'redundant' || active === 'redundant') {
            return {
              status: 'redundant',
              error: 'service worker entered redundant state during boot or install',
            };
          }
          return {
            status: 'pending',
            detail: \`installing=\${installing} waiting=\${waiting} active=\${active}\`,
          };
        }).catch((err) => ({
          status: 'error',
          error: \`getRegistration rejected: \${String(err && err.message || err)}\`,
        }));
      })()`);
    } catch (err) {
      evaluateErrors += 1;
      lastState = { status: 'evaluate_error', error: `evaluate failed: ${String(err && err.message || err)}` };
      await sleepFn(150);
      continue;
    }

    if (res && res.status === 'activated') {
      return { active: true, state: 'activated' };
    }
    if (res && res.status === 'redundant') {
      return {
        active: false,
        reason: 'no_sw_redundant',
        detail: res.error || 'service worker boot or install threw and entered redundant state',
      };
    }
    if (res && res.status === 'unsupported') {
      return {
        active: false,
        reason: 'unsupported',
        detail: res.error,
      };
    }
    lastState = res;
    await sleepFn(150);
  }

  if (evaluateErrors >= attempts) {
    return {
      active: false,
      reason: 'unreadable_evaluate',
      detail: lastState?.error || 'CDP evaluate failed on all attempts while probing service worker',
    };
  }
  return {
    active: false,
    reason: 'timed_out',
    detail: `service worker never activated within ${attempts * 150}ms (last state: ${lastState?.status} - ${lastState?.detail || lastState?.error || 'none'})`,
  };
}

export function assertSwActive(sw, scenarioName) {
  if (!sw || !sw.active) {
    const reason = sw ? sw.reason : 'unknown';
    const detail = sw ? sw.detail : 'waitForSw returned nullish';
    throw new Error(`cannot score ${scenarioName} scenario: service worker failed to activate (${reason}): ${detail}`);
  }
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
  const probeShot = 'window.__probe ? { starts: window.__probe.bufferStarts + window.__probe.oscStarts, throws: window.__probe.startThrows || 0, lastError: window.__probe.lastStartError || null } : null';
  const before = await evaluate(cdp, sessionId, probeShot);
  // A page WITH a hit area but no probe means the instrumentation never
  // injected: hornUsable is UNMEASURABLE, and unmeasurable fails as itself
  // (airhorn-nxuv.9) rather than reading as a horn that made no sound.
  if (!before) {
    throw new Error('horn press unmeasurable: the audio probe (__probe) was not injected into a document that has a horn');
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1,
  }, sessionId);
  await sleep(600);
  const mid = await readState(cdp, sessionId);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1,
  }, sessionId);
  await sleep(150);
  const after = await evaluate(cdp, sessionId, probeShot);
  if (!after) {
    throw new Error('horn press unmeasurable: the audio probe (__probe) vanished across the press');
  }
  const started = after.starts > before.starts;
  const startThrows = after.throws - before.throws;
  return {
    dispatched: true,
    ariaPressedWhileHeld: mid.horn.ariaPressed,
    responded: mid.horn.ariaPressed === 'true',
    sounded: started,
    audioStarts: { before: before.starts, after: after.starts },
    // A start() that threw is an explicit failing outcome with the error in
    // the record - never a zero that looks healthy (airhorn-nxuv.9).
    startThrows,
    ...(startThrows > 0 ? { startError: after.lastError } : {}),
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

export function summarise(state) {
  // Evidence is what the page actually says somewhere rendered (airhorn-01e):
  // a region with no text, or a hidden one, explains nothing.
  const liveEvidence = (state.live || []).filter((l) => l.shown && l.text);
  const liveText = liveEvidence.map((l) => l.text).join(' | ');
  // airhorn-nxuv.5: an explanation is credited only from an EXPLANATORY
  // ELEMENT (a status/alert/aria-live region - collectRegions collects exactly
  // those) whose own text says something explanatory. Crash prose elsewhere in
  // the body ('something went wrong' in a paragraph) is not an explanation,
  // and a live region saying something unrelated ('Ready') is not one either -
  // both used to count. An unreadable evidence shape (no live-region array, no
  // body text) is UNMEASURABLE - its own failing outcome, not a pass on
  // whatever text happened to be around.
  const measured = Array.isArray(state.live) && typeof state.bodyText === 'string';
  const explanatory = measured ? liveEvidence.filter((l) => EXPLAINS_RE.test(l.text)) : [];
  return {
    renders: state.horn.present,
    hornVisible: state.horn.visible,
    hornSize: state.horn.present ? `${state.horn.width}x${state.horn.height}` : null,
    title: state.title,
    navType: state.navType ?? null,
    liveRegions: Array.isArray(state.live) ? state.live.length : 0,
    shownLiveRegions: liveEvidence.length,
    liveText,
    explainsItself: measured && explanatory.length > 0,
    explanationMeasured: measured,
    explanationEvidence: !measured
      ? 'unmeasurable: the live-region evidence was not collected'
      : explanatory.length
        ? explanatory.map((l) => `${l.role || l.live}: "${l.text}"`).join(' | ')
        : 'none',
    controller: state.controller,
    controllerChanges: state.controllerChanges,
    online: state.online,
    pageErrors: state.errors,
  };
}

/* --------------------------------------------------------------- scenarios */

const results = [];

// A browser that cannot START is not a scenario result - but it IS a finding, and
// the report is where findings live (airhorn-w1wh review, round 3). So the launch
// catch records an ERROR row and returns; one launch failure marks the audit
// failed, and every later scenario is recorded as unmeasured rather than
// relaunching a browser the host has already refused.
let launchFailed = false;

async function withBrowser(id, name, fn) {
  if (launchFailed) {
    const result = { id, name, status: 'ERROR', error: 'not measured: the browser could not start earlier in this audit' };
    results.push(result);
    console.log(`[${id}] ${name}\n  ERROR ${result.error}`);
    return;
  }
  let browser = null;
  let result = { id, name };
  try {
    browser = await launchBrowser();
  } catch (err) {
    launchFailed = true;
    const why = String((err && err.message) || err);
    result = {
      id,
      name,
      status: 'ERROR',
      error: `cannot launch a browser for the audit, so no scenario was measured: ${why}`,
      launchError: true,
    };
    results.push(result);
    console.log(`[${id}] ${name}\n  ERROR ${result.error}`);
    return;
  }
  try {
    const collectors = makeCollectors(browser.cdp);
    result = { id, name, status: 'OK', ...(await fn(browser, collectors)) };
  } catch (err) {
    result = { id, name, status: 'ERROR', error: String((err && err.message) || err) };
  } finally {
    await closeBrowser(browser);
  }
  results.push(result);
  const verdict = result.error
    ? `ERROR ${result.error}`
    : `renders=${result.renders} hornVisible=${result.hornVisible} hornUsable=${result.hornUsable} explains=${result.explainsItself}${result.measuredDocument ? ` doc=${result.measuredDocument}` : ''}`;
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
  // A selection naming no known scenario measured nothing BY MISTAKE
  // (airhorn-nxuv.23): a typo used to run zero scenarios and exit 0. 'none'
  // is the documented intentional empty selection; anything else unknown is
  // an ERROR row, so the audit fails and names the typo.
  const KNOWN_SCENARIOS = ['offline', 'liefi', 'update', 'quota', 'blocked', 'corrupt'];
  const unknownSelection = only.filter((s) => s !== 'none' && !KNOWN_SCENARIOS.includes(s));
  if (unknownSelection.length) {
    results.push({
      id: 'selection',
      name: 'scenario selection',
      status: 'ERROR',
      error: `RESILIENCE_ONLY names unknown scenario(s): ${unknownSelection.join(', ')} - known: ${KNOWN_SCENARIOS.join(', ')} (use 'none' for an intentional empty selection)`,
    });
  }

  // Test seam (airhorn-w1wh review, rounds 3 and 4): a scenario error is otherwise
  // unreachable without a working browser, so a spawned run can stage exactly one
  // failing row. It is honoured ONLY under RESILIENCE_TEST_MODE=1 (airhorn-w1wh
  // round 4, P1): this is a production entry point, and a stray
  // RESILIENCE_STUB_SCENARIO in the environment must never be able to replace a
  // real audit with a single fabricated row.
  const stub = (process.env.RESILIENCE_STUB_SCENARIO || '').trim();
  const testMode = process.env.RESILIENCE_TEST_MODE === '1';
  if (stub && !testMode) {
    console.warn('RESILIENCE_STUB_SCENARIO is honoured only with RESILIENCE_TEST_MODE=1 - ignoring it and running the real scenarios.');
  }
  const useStub = Boolean(stub) && testMode;
  for (const seamVar of ['RESILIENCE_UPDATE_REJECT', 'RESILIENCE_CACHE_MISS']) {
    if (process.env[seamVar] && !testMode) {
      console.warn(`${seamVar} is honoured only with RESILIENCE_TEST_MODE=1 - ignoring it and running the real scenarios.`);
    }
  }

  try {
    if (useStub) {
      // Two shapes, because the exit contract has two halves that must be told apart
      // (airhorn-w1wh review): a scenario that could not be measured (ERROR -> the
      // audit fails) and one that completed and FOUND PROBLEMS (OK -> the audit
      // succeeds). RESILIENCE_STUB_SCENARIO=ok-finding stages the second.
      if (/^ok-finding/.test(stub)) {
        results.push({
          id: 'stub',
          name: 'stubbed completed scenario with a finding',
          status: 'OK',
          renders: false,
          hornVisible: false,
          hornUsable: false,
          explainsItself: false,
          explanationEvidence: 'none',
        });
      } else {
        results.push({ id: 'stub', name: 'stubbed failing scenario', status: 'ERROR', error: `the scenario failed on purpose: ${stub}` });
      }
    } else {
    /* ---- 1. real offline after first load ---- */
    if (want('offline')) await withBrowser('offline', 'offline after first load', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const sw = await waitForSw(cdp, sessionId);
      assertSwActive(sw, 'offline');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      }, sessionId);
      const loaded = await reload(cdp, sessionId);
      const st = await readState(cdp, sessionId);
      const horn = await pressHorn(cdp, sessionId);
      const shotFile = await shot(cdp, sessionId, '1-offline');
      return {
        swActive: sw.active,
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
    if (want('liefi')) await withBrowser('liefi', 'lie-fi (app-shell nav vs uncached subresource)', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const sw = await waitForSw(cdp, sessionId);
      assertSwActive(sw, 'liefi');

      // The connection answers, then dies without a response: the classic lie-fi.
      state.lieFi = { match: () => true, delayMs: 9000, mode: 'destroy' };

      // (a) the precached shell should still be instant, lie-fi or not
      const cachedStart = Date.now();
      const cachedLoaded = await reload(cdp, sessionId, 8000);
      const cachedMs = Date.now() - cachedStart;
      const cachedState = cachedLoaded ? await readState(cdp, sessionId) : null;

      // (b) an in-page request the precache does not cover: the SW bounds the
      //     fall-through fetch at FETCH_TIMEOUT_MS (5000) and answers 503 on
      //     failure (public/sw.js) - so under lie-fi this settles ~5s with a
      //     visible failure, it does not hang for the connection's 9s.
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

      // (c) a deep-link navigation under lie-fi. The premise is the CURRENT
      //     worker (airhorn-p344): public/sw.js answers EVERY navigation from
      //     the verified precache shell without touching the network, and
      //     with no shell its fetch is bounded at NAVIGATION_TIMEOUT_MS
      //     (4000) and falls back to offlineDocument (status 200) - so the
      //     deep link must COMMIT a new document, quickly, lie-fi or not.
      //     measuredDocument tells that apart from the one remaining
      //     leftover shape: a navigation that never commits within the
      //     12000ms navigate bound (only possible if the worker is gone AND
      //     the network hangs forever - not this 9s-destroy shape).
      const preDeepLink = await readState(cdp, sessionId);
      const uncachedStart = Date.now();
      const uncachedLoaded = await navigate(cdp, sessionId, `${origin}/deep-link`, 12000);
      const uncachedMs = Date.now() - uncachedStart;
      // An unreadable state is UNMEASURABLE, not a synthesised 'no document'
      // row with status OK (airhorn-nxuv.8): it fails as itself.
      const uncachedState = await readState(cdp, sessionId).catch((err) => {
        throw new Error(`lie-fi measured nothing: the state after the uncached navigation is unreadable (${String((err && err.message) || err)})`);
      });
      const onDeepLink = uncachedLoaded
        && uncachedState.marker !== preDeepLink.marker
        && /\/deep-link/.test(uncachedState.url || '');
      const shotFile = await shot(cdp, sessionId, '2-liefi-uncached-nav');
      const hornAfterUncached = await pressHorn(cdp, sessionId);
      return {
        swActive: sw.active,
        cachedNavigation: { completed: cachedLoaded, ms: cachedMs,
          hornPresent: cachedState ? cachedState.horn.present : false },
        uncachedSubresource: subresource,
        uncachedNavigation: { completed: uncachedLoaded, ms: uncachedMs, reachedDeepLink: onDeepLink },
        // The headline describes the DEEP-LINK outcome. When the attempt never
        // replaced the document, the previous cached page is still on screen;
        // measuring it and reporting it as the lie-fi result was the mask
        // (airhorn-nxuv.8). The previous page IS still measured - nested and
        // labelled, so a leftover working page and a working deep link are no
        // longer indistinguishable in the row.
        ...(onDeepLink
          ? { measuredDocument: 'deep-link', ...summarise(uncachedState),
              hornUsable: hornAfterUncached.sounded, hornCheck: hornAfterUncached }
          : { measuredDocument: 'previous-cached-document',
              renders: false, hornVisible: false, explainsItself: false,
              explanationEvidence: 'the deep-link navigation never replaced the document; nothing about /deep-link was measured',
              hornUsable: false,
              hornCheck: { sounded: false, reason: 'the press measured the previous cached page, not /deep-link (see previousDocument)' },
              previousDocument: { ...summarise(uncachedState),
                hornUsable: hornAfterUncached.sounded, hornCheck: hornAfterUncached } }),
        cachedShellWasAvailable: cachedLoaded,
        screenshot: shotFile,
        console: collectors(sessionId).console,
        pageErrors: uncachedState.errors,
      };
    });

    /* ---- 3. service worker update while a page is open (and pressed) ---- */
    if (want('update')) await withBrowser('update', 'SW update while page is open', async ({ cdp }, collectors) => {
      reset();
      const { sessionId } = await openPage(cdp);
      await navigate(cdp, sessionId, `${origin}/`);
      const sw = await waitForSw(cdp, sessionId);
      assertSwActive(sw, 'update');
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
      // Mutation seam (airhorn-nxuv.6): under test mode, make the update fetch
      // fail so reg.update() really rejects - the proof that this scenario CAN
      // fail. Honoured only with RESILIENCE_TEST_MODE=1, like the stub seam.
      if (testMode && process.env.RESILIENCE_UPDATE_REJECT === '1') {
        state.overrides.set('/sw.js', { status: 500, body: 'update forced to fail (mutation seam)' });
      }
      // The update call is the thing under test, so its outcome is RECORDED,
      // never swallowed (airhorn-nxuv.6): the old `.catch(() => false)` turned
      // a rejected reg.update() into a discarded `false` and the row reported
      // pressInterrupted:false with status OK - a failed update read as a pass.
      // Now a rejection is its own explicit FAILING outcome with the rejection
      // message in the record, and a missing registration is UNMEASURABLE -
      // both fail the scenario instead of fitting current behaviour.
      const update = await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => {
          if (!reg) return { outcome: 'unmeasurable', detail: 'no service worker registration to update' };
          return reg.update().then(
            () => ({ outcome: 'updated' }),
            (err) => ({ outcome: 'rejected', detail: String((err && err.message) || err) }),
          );
        })`);
      if (update.outcome !== 'updated') {
        throw new Error(`update-during-press measured nothing: reg.update() ${update.outcome} - ${update.detail}`);
      }
      await sleep(3000);

      const afterState = await readState(cdp, sessionId).catch(() => null);
      stopCounting();
      const reloaded = navigations > 0 || (!!afterState && before.marker !== afterState.marker);
      const shotFile = await shot(cdp, sessionId, '3-update-mid-press');

      // After the dust settles, is it still a horn?
      const horn = await pressHorn(cdp, sessionId);
      const finalState = await readState(cdp, sessionId);
      return {
        swActive: sw.active,
        update,
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
      const sw = await waitForSw(cdp, sessionId);
      assertSwActive(sw, 'quota');

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
        swActive: sw.active,
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

      // The headline row is the WORST subcase, NAMED (airhorn-nxuv.22):
      // spreading ...css let a JS-blocked failure (hornUsable false) pass
      // under the CSS subcase's green in the summary table. 'Worst' = the
      // first subcase that fails to render, show or sound; the CSS case
      // stays the default when everything is green (it is the layout one).
      const worst = [js, css].find((s) => !s.renders || !s.hornVisible || !s.hornUsable) || css;
      return {
        ...worst,
        headlineCase: worst.label,
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
      const sw = await waitForSw(cdp, sessionId);
      assertSwActive(sw, 'corrupt');

      // Mutation seam (airhorn-nxuv.7): under test mode, delete every cache so
      // the scenario must FAIL naming the missing cache - the proof that this
      // check can fail. Honoured only with RESILIENCE_TEST_MODE=1, like the
      // stub seam.
      if (testMode && process.env.RESILIENCE_CACHE_MISS === '1') {
        await evaluate(cdp, sessionId, `(async () => {
          for (const n of await caches.keys()) await caches.delete(n);
          return true;
        })()`);
      }
      const cacheInfo = await evaluate(cdp, sessionId, `(async () => {
        const names = await caches.keys();
        const name = names.find((n) => n.startsWith('airhorner-'));
        if (!name) return { name: null, urls: [] };
        const cache = await caches.open(name);
        const keys = await cache.keys();
        return { name, urls: keys.map((r) => new URL(r.url).pathname) };
      })()`);
      // The corruption is the thing under test, so what it corrupts must EXIST
      // and the corruption must LAND - a missing cache, a cache with no asset,
      // or a corruption that touched nothing used to read exactly like a
      // healthy run (airhorn-nxuv.7): the row passed without the corruption
      // ever being exercised. Each is an explicit failing outcome naming what
      // was missing, not a false green. (Same false-green family as nxuv.21:
      // an empty container is not the thing - a cache with zero entries is not
      // a corrupted cache.)
      if (!cacheInfo || !cacheInfo.name) {
        throw new Error('corrupt-cache measured nothing: no airhorner-* cache exists to corrupt (precache missing or unreadable after an activated SW)');
      }
      const assetUrl = (cacheInfo.urls || []).find((u) => u.startsWith('/assets/'));
      if (!assetUrl) {
        throw new Error(`corrupt-cache measured nothing: cache "${cacheInfo.name}" has no /assets/ entry to corrupt (entries: ${(cacheInfo.urls || []).length})`);
      }

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
      if (typeof jsCorrupted !== 'string' || !jsCorrupted.startsWith('http')) {
        throw new Error(`corrupt-cache measured nothing: the asset corruption was not exercised (${jsCorrupted})`);
      }

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
      if (!(shellCorrupted > 0)) {
        throw new Error(`corrupt-cache measured nothing: the shell corruption touched ${shellCorrupted} entries (no / or /index.html in cache "${cacheInfo.name}")`);
      }
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
      // The recovery update is the mechanism under test, so its outcome is
      // RECORDED, never swallowed (airhorn-v7ba, the same fix as nxuv.6's
      // update scenario): a rejected reg.update() or a null registration used
      // to fold into recoveredAfterSwUpdate:false, indistinguishable from
      // 'the update ran and the app did not recover'. The same mutation seam
      // as scenario 3 forces the rejection under test mode.
      if (testMode && process.env.RESILIENCE_UPDATE_REJECT === '1') {
        state.overrides.set('/sw.js', { status: 500, body: 'update forced to fail (mutation seam)' });
      }
      const recoveryUpdate = await evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistration()
        .then((reg) => {
          if (!reg) return { outcome: 'unmeasurable', detail: 'no service worker registration to update' };
          return reg.update().then(
            () => ({ outcome: 'updated' }),
            (err) => ({ outcome: 'rejected', detail: String((err && err.message) || err) }),
          );
        })`);
      await sleep(1500);
      const afterUpdate = await readState(cdp, sessionId).catch((err) => ({ unreadable: String((err && err.message) || err) }));
      const finalShot = await shot(cdp, sessionId, '6-corrupt-after-online-update');

      return {
        swActive: sw.active,
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
        swUpdate: recoveryUpdate,
        // Claimed only when an update RAN and the page was READABLE
        // (airhorn-v7ba): anything else is a named 'unmeasurable', never
        // folded into false next to a real not-recovered.
        recoveredAfterSwUpdate: recoveryUpdate.outcome !== 'updated'
          ? `unmeasurable: reg.update() ${recoveryUpdate.outcome} - ${recoveryUpdate.detail}`
          : afterUpdate.unreadable
            ? `unmeasurable: state unreadable after the update (${afterUpdate.unreadable})`
            : !!afterUpdate.horn.present,
        screenshots: [jsShot, shellShot, finalShot],
        console: collectors(sessionId).console,
        pageErrors: [...afterJsCorruption.errors, ...afterShellCorruption.errors],
      };
    });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  /* ------------------------------------------------------------ reporting */

  // The exit contract is applied HERE, by the entry point: writeReport() only
  // writes and reports, so importing it cannot change a caller's exit code.
  process.exitCode = writeReport(results);
}

/*
 * The audit's exit contract (airhorn-w1wh review, round 3): a report row with an
 * error - a browser that would not start, or a scenario that threw - is a FAILED
 * audit, not a green one. An empty selection (nothing wanted, RESILIENCE_ONLY=none)
 * measured nothing on purpose and stays 0, which is the one case where zero errors
 * means nothing to report rather than a pass.
 */
export function auditExitCode(scenarios) {
  return (scenarios || []).some((row) => row && (row.status === 'ERROR' || row.error)) ? 1 : 0;
}

// Extracted from runAudit so a browser-free test can hand it a stubbed failing
// scenario and check the row really lands in the file, not just in memory.
export function writeReport(scenarios, outDir = OUT) {
  const results = scenarios;
  const OUT = outDir;
  const report = {
    target: 'airhorn',
    auditedAt: new Date().toISOString(),
    origin: 'local dist/ over http (headless Chromium, CDP)',
    scenarios: results,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  // The named reason must reach the operator even when it explains a NO
  // (airhorn-mslu): 'NO (the deep-link navigation never replaced the
  // document...)' is a different row from 'NO', and measuredDocument is what
  // tells a leftover cached page apart from the page under test.
  const row = (r) => [
    r.id,
    r.name,
    (r.status === 'ERROR' || r.error) ? 'ERROR' : (r.renders ? 'yes' : 'NO'),
    r.error ? '-' : (r.hornVisible ? 'yes' : 'NO'),
    r.error ? '-' : (r.hornUsable ? 'yes' : 'NO'),
    r.error
      ? '-'
      : r.explainsItself
        ? `yes (${r.explanationEvidence})`
        : r.explanationEvidence && r.explanationEvidence !== 'none'
          ? `NO (${r.explanationEvidence})`
          : 'NO',
    [r.measuredDocument ? `doc: ${r.measuredDocument}` : '', r.error || ''].filter(Boolean).join('; '),
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
  const exitCode = auditExitCode(results);
  console.log(exitCode === 0
    ? '\nThis is an audit: every selected scenario was measured and none reported an error.'
    : '\nThis audit MEASURED NOTHING OR FOUND ERRORS (see the ERROR rows): exiting nonzero so a starved host or a broken scenario is not read as a green audit.');
  return exitCode;
}

// Only drive the audit when this file is the entry point: importing it (to
// read READ_STATE, above) must not launch six Chromiums. import.meta.main is
// the reliable test (Node 24+); the argv fallback keeps older runtimes - where
// import.meta.main is undefined - from turning a real audit run into a silent
// no-op that exits 0.
const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  runAudit().then(() => {
    // Force the exit once the report is written: a hostile DevTools peer that
    // swallowed frames also swallows the ws close-frame, so the socket holds
    // the event loop forever after the scenarios are done (airhorn-1t5c; the
    // same shape cache-growth and soak handle in their catches). The short
    // delay lets piped stdout flush.
    setTimeout(() => process.exit(process.exitCode || 0), 250);
  }).catch((err) => {
    console.error('audit harness failed:', err);
    process.exit(1);
  });
}
