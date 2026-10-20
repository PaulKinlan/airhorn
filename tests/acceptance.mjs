/*
 * Whole-product acceptance pass for the built Air Horner PWA.
 *
 * Unlike the focused suites (a11y, service worker, WebMCP), this drives the
 * assembled product the way a person and an agent actually use it: one real
 * headless Chromium against a served `dist`, one browser session, five
 * end-to-end checks, screenshots plus a JSON report as evidence.
 *
 *   1. pointer press/release  - real audio, aria-pressed and .horning track it
 *   2. keyboard only          - Tab, visible focus ring, Space/Enter fire it
 *   3. install / offline      - SW activates, then an offline reload still
 *                               renders and still plays (real offline emulation)
 *   4. WebMCP                 - tools discovered and executed, horn sounds
 *   5. reduced motion + dark  - page renders sanely under both media queries
 *
 * Evidence is written to $ACCEPTANCE_OUT (default /tmp/airhorn-acceptance/
 * <git-sha>-<timestamp>): screenshots, report.json and a PASS/FAIL table.
 * Exits non-zero when any item fails, so it can run as a gate.
 *
 * Run with: npm run test:acceptance   (builds first)
 */

import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, chromeBin } from './support/browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEvidenceDir() {
  if (process.env.ACCEPTANCE_OUT) return process.env.ACCEPTANCE_OUT;
  let sha = 'worktree';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    // not a git checkout: keep the default name
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('/tmp/airhorn-acceptance', `${sha}-${stamp}`);
}

/* ------------------------------------------------------------------------- *
 * Instrumentation installed before any page script runs.
 *  - measures the real output level of every Web Audio buffer source, so
 *    "the horn sounded" means samples flowed, not that a flag was flipped;
 *  - spies on the app badge;
 *  - when the browser has no WebMCP, installs a spec-shaped stand-in with the
 *    documented surface (registerTool / getTools / executeTool / toolchange),
 *    and records which one is in use in window.__webmcpSource.
 * ------------------------------------------------------------------------- */
const instrumentation = `
  (() => {
    window.__probe = { starts: 0, oscStarts: 0, peak: 0, level: 0, samples: 0, ctxState: null };
    window.__badge = { calls: [], cleared: 0 };
    window.__pageErrors = [];
    window.addEventListener('error', (e) => {
      window.__pageErrors.push({ type: 'error', message: e.message });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__pageErrors.push({
        type: 'unhandledrejection',
        message: String((e.reason && e.reason.message) || e.reason),
      });
    });

    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const origCreateOsc = AC.prototype.createOscillator;
      if (origCreateOsc) {
        AC.prototype.createOscillator = function (...args) {
          const osc = origCreateOsc.apply(this, args);
          const origStart = osc.start.bind(osc);
          osc.start = function (...startArgs) {
            window.__probe.oscStarts = (window.__probe.oscStarts || 0) + 1;
            return origStart(...startArgs);
          };
          return osc;
        };
      }

      const origConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (destination, ...rest) {
        const result = origConnect.apply(this, [destination, ...rest]);
        if (destination && destination === this.context?.destination && !this.__isProbeNode) {
          try {
            const ctx = this.context;
            const analyser = ctx.createAnalyser();
            analyser.__isProbeNode = true;
            analyser.fftSize = 2048;
            const data = new Float32Array(analyser.fftSize);
            const silentSink = ctx.createGain();
            silentSink.__isProbeNode = true;
            silentSink.gain.value = 0;
            origConnect.call(this, analyser);
            origConnect.call(analyser, silentSink);
            origConnect.call(silentSink, ctx.destination);

            const timer = setInterval(() => {
              analyser.getFloatTimeDomainData(data);
              let peak = 0;
              for (let i = 0; i < data.length; i += 1) {
                const abs = Math.abs(data[i]);
                if (abs > peak) peak = abs;
              }
              window.__probe.level = peak;
              if (peak > window.__probe.peak) window.__probe.peak = peak;
              window.__probe.samples += 1;
              window.__probe.ctxState = ctx.state;
            }, 20);
            setTimeout(() => clearInterval(timer), 20000);
          } catch {}
        }
        return result;
      };

      const createBufferSource = AC.prototype.createBufferSource;
      AC.prototype.createBufferSource = function (...args) {
        const source = createBufferSource.apply(this, args);
        const origStart = source.start.bind(source);
        source.start = (...startArgs) => {
          window.__probe.starts += 1;
          return origStart(...startArgs);
        };
        return source;
      };
    }

    try {
      Object.defineProperty(Navigator.prototype, 'setAppBadge', {
        configurable: true,
        value: function (contents) { window.__badge.calls.push(contents); return Promise.resolve(); },
      });
      Object.defineProperty(Navigator.prototype, 'clearAppBadge', {
        configurable: true,
        value: function () { window.__badge.cleared += 1; return Promise.resolve(); },
      });
    } catch {}

    if (!document.modelContext) {
      const tools = new Map();
      const shim = new EventTarget();
      shim.registerTool = async (tool, options = {}) => {
        if (!tool || typeof tool.name !== 'string') throw new TypeError('tool.name is required');
        if (tools.has(tool.name)) throw new Error('Tool "' + tool.name + '" is already registered.');
        tools.set(tool.name, tool);
        options?.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true });
        shim.dispatchEvent(new Event('toolchange'));
      };
      shim.getTools = async () => [...tools.values()].map(
        ({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }),
      );
      shim.executeTool = async (tool, input, options = {}) => {
        const name = typeof tool === 'string' ? tool : tool?.name;
        const definition = tools.get(name);
        if (!definition) throw new Error('Unknown tool "' + name + '"');
        const inputObject = typeof input === 'string' ? JSON.parse(input) : (input ?? {});
        return JSON.stringify(await definition.execute(inputObject, options ?? {}));
      };
      Object.defineProperty(document, 'modelContext', { configurable: true, value: shim });
      window.__webmcpSource = 'stand-in';
    } else {
      window.__webmcpSource = 'native';
    }

    window.__call = async (name, input = {}) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error('Unknown tool "' + name + '"');
      let raw;
      try {
        raw = await document.modelContext.executeTool(tool, input, {});
      } catch (err) {
        if (String(err && err.message).startsWith('Failed to parse input')) {
          raw = await document.modelContext.executeTool(tool, JSON.stringify(input), {});
        } else {
          throw err;
        }
      }
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };
  })();
`;

/* WCAG relative-luminance contrast ratio, used by the dark-mode check. */
function contrastRatio(rgbA, rgbB) {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(rgbA);
  const b = lum(rgbB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const parseRgb = (value) => {
  const match = String(value).match(/-?\d+(\.\d+)?/g);
  if (!match) return null;
  return match.slice(0, 3).map(Number);
};

async function run() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run `npm run build` first.');
  }

  const evidenceDir = makeEvidenceDir();
  fs.mkdirSync(evidenceDir, { recursive: true });

  const results = [];
  const observations = [];
  const notes = {};
  const pageConsole = [];

  const record = (item, ok, detail, evidence = []) => {
    results.push({ item, status: ok ? 'PASS' : 'FAIL', detail, evidence });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${item}: ${detail}`);
  };

  /* ------------------------------ static server ------------------------------ */
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!path.resolve(filePath).startsWith(path.resolve(distDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  let browser = null;
  let ws = null;
  let browserWs = null;

  try {
    /* -------------------------------- browser -------------------------------- */
    browser = await launchBrowser({ autoplay: true, webmcp: true, label: 'acceptance', timeoutMs: 20000 });
    ws = new WebSocket(browser.pageWsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    // Browser-level connection: creating and activating a real second tab is
    // how the keyboard-hold case produces a genuine window blur and tab-hide
    // (airhorn-ay73).
    const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
    browserWs = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { browserWs.onopen = resolve; browserWs.onerror = reject; });
    let browserMsgId = 1;
    const browserPending = new Map();
    browserWs.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && browserPending.has(msg.id)) {
        const p = browserPending.get(msg.id);
        browserPending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    };
    const browserSend = (method, params = {}) => {
      const id = browserMsgId++;
      return new Promise((resolve, reject) => {
        browserPending.set(id, { resolve, reject });
        browserWs.send(JSON.stringify({ id, method, params }));
      });
    };

    let msgId = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        pageConsole.push({ type: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageConsole.push({ type: 'error', text: d?.exception?.description || d?.text || 'Uncaught exception' });
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        pageConsole.push({ type: 'error', text: msg.params.entry.text });
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
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
      const result = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error('Page evaluation failed: ' +
          (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      }
      return result.result.value;
    };

    const waitFor = async (expression, timeoutMs = 8000, label = expression) => {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return true;
        } catch (err) {
          lastError = err;
        }
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
    };

    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(evidenceDir, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return path.relative(evidenceDir, file);
    };

    const resetProbe = () => evaluate(
      'window.__probe.peak = 0; window.__probe.level = 0; window.__probe.starts = 0; true',
    );

    const hornState = () => evaluate(`({
      pressed: document.querySelector('.horn').getAttribute('aria-pressed'),
      horning: document.querySelector('.horn').classList.contains('horning'),
      peak: window.__probe.peak,
      level: window.__probe.level,
      starts: window.__probe.starts,
      ctxState: window.__probe.ctxState,
      audio: !!document.querySelector('.horn'),
    })`);

    const hornCentre = () => evaluate(`(() => {
      const r = document.querySelector('.horn').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    })()`);

    const pressAndHold = async () => {
      const centre = await hornCentre();
      await resetProbe();
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', clickCount: 1, buttons: 1,
      });
      await sleep(350);
      return hornState();
    };

    const releasePointer = async (state = null) => {
      const centre = await hornCentre();
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', clickCount: 1, buttons: 0,
      });
      if (state) state.afterRelease = await hornState();
      return state;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });

    await send('Page.navigate', { url: `${origin}/` });
    await waitFor(
      `document.readyState === 'complete' && !!document.querySelector('.horn')`,
      15000, 'initial page load',
    );
    await sleep(300);

    const webmcpNative = await evaluate('typeof document.modelContext !== "undefined"');
    notes.webmcp = {
      native: webmcpNative,
      source: await evaluate('window.__webmcpSource || "none"'),
      chrome: execSync(`${JSON.stringify(chromeBin())} --version`).toString().trim(),
      flags: '--enable-features=WebMCP,WebMCPTesting',
    };

    /* --------------------- 1. pointer press sounds the horn --------------------- */
    try {
      const during = await pressAndHold();
      const pressShot = await shot('01-pointer-press.png');
      await releasePointer();
      const after = await hornState();
      // Give the ringing sample time to finish so we can prove it falls silent.
      let silent = false;
      for (let i = 0; i < 100; i += 1) {
        if ((await evaluate('window.__probe.level')) < 0.005) { silent = true; break; }
        await sleep(100);
      }
      const releasedShot = await shot('02-pointer-released.png');

      const problems = [];
      if (!(during.starts >= 1)) problems.push(`no buffer source started (starts=${during.starts})`);
      if (!(during.peak > 0.01)) problems.push(`no audible samples (peak=${during.peak})`);
      if (during.pressed !== 'true') problems.push(`aria-pressed=${during.pressed} while held`);
      if (!during.horning) problems.push('.horning missing while held');
      if (after.pressed !== 'false') problems.push(`aria-pressed=${after.pressed} after release`);
      if (after.horning) problems.push('.horning still set after release');
      if (!silent) problems.push('audio never fell silent after release');
      record('1. pointer press plays audio, state tracks it',
        problems.length === 0,
        problems.length ? problems.join('; ') :
          `starts=${during.starts} peak=${during.peak.toFixed(3)} ` +
          `aria-pressed true while held, false after release; audio silent again`,
        [pressShot, releasedShot]);
      notes.pointer = during;
    } catch (err) {
      record('1. pointer press plays audio, state tracks it', false, err.message, []);
    }

    /* ------------------------ 2. keyboard-only interaction ---------------------- */
    try {
      // A pointer click sets the sequential-focus starting point, so Tab can
      // resume after the horn. Walk the focus order until the horn is reached,
      // exactly as a keyboard user would (wrapping past the Install button).
      await send('Page.bringToFront');
      let tabStops = 0;
      let focus = null;
      for (let i = 1; i <= 6; i += 1) {
        await send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await sleep(120);
        focus = await evaluate(`(() => {
          const el = document.querySelector('.horn');
          const cs = getComputedStyle(el);
          return {
            reached: document.activeElement === el,
            focused: document.activeElement === el,
            focusVisible: el.matches(':focus-visible'),
            outlineWidth: cs.outlineWidth,
            outlineStyle: cs.outlineStyle,
            outlineColor: cs.outlineColor,
            outlineOffset: cs.outlineOffset,
          };
        })()`);
        if (focus.reached) { tabStops = i; break; }
      }
      const focusShot = await shot('03-keyboard-focus.png');

      await resetProbe();
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ',
      });
      await sleep(350);
      const duringSpace = await hornState();
      const spaceShot = await shot('04-keyboard-space-held.png');
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
      });
      await sleep(150);
      const afterSpace = await hornState();

      await resetProbe();
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
      });
      await sleep(350);
      const duringEnter = await hornState();
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await sleep(150);
      const afterEnter = await hornState();

      const problems = [];
      if (!focus.focused) problems.push('the horn is not reachable with Tab');
      if (!focus.focusVisible) problems.push(':focus-visible not matched');
      const hasRing = parseFloat(focus.outlineWidth) > 0 && focus.outlineStyle !== 'none';
      if (!hasRing) problems.push(`no visible focus ring (outline ${focus.outlineWidth} ${focus.outlineStyle})`);
      if (!(duringSpace.peak > 0.01)) problems.push(`Space produced no audio (peak=${duringSpace.peak})`);
      if (duringSpace.pressed !== 'true') problems.push('Space did not set aria-pressed');
      if (afterSpace.pressed !== 'false') problems.push('Space keyup did not clear aria-pressed');
      if (!(duringEnter.peak > 0.01)) problems.push(`Enter produced no audio (peak=${duringEnter.peak})`);
      if (duringEnter.pressed !== 'true') problems.push('Enter did not set aria-pressed');
      if (afterEnter.pressed !== 'false') problems.push('Enter keyup did not clear aria-pressed');

      record('2. keyboard-only: Tab, focus ring, Space/Enter fire the horn',
        problems.length === 0,
        problems.length ? problems.join('; ') :
          `reached in ${tabStops} Tab stop(s); focus ring ${focus.outlineWidth} ${focus.outlineStyle}; ` +
          `Space peak=${duringSpace.peak.toFixed(3)}, Enter peak=${duringEnter.peak.toFixed(3)}, state clears on keyup`,
        [focusShot, spaceShot]);
      notes.keyboard = { tabStops, focus, duringSpace, duringEnter };
    } catch (err) {
      record('2. keyboard-only: Tab, focus ring, Space/Enter fire the horn', false, err.message, []);
    }

    /* ------------------- 3. service worker install + offline ------------------- */
    try {
      await waitFor(
        `navigator.serviceWorker && navigator.serviceWorker.controller !== null`,
        15000, 'service worker to control the page',
      );
      const sw = await evaluate(`(async () => {
        const reg = await navigator.serviceWorker.ready;
        const keys = await caches.keys();
        let cached = 0;
        for (const key of keys) cached += (await (await caches.open(key)).keys()).length;
        return {
          state: reg.active && reg.active.state,
          script: reg.active && reg.active.scriptURL,
          keys,
          cached,
        };
      })()`);
      const installedShot = await shot('05-service-worker-installed.png');

      await send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
      await send('Page.reload', { ignoreCache: false });
      await waitFor(
        `document.readyState === 'complete' && !!document.querySelector('.horn')`,
        15000, 'offline reload to render',
      );
      await sleep(300);
      const offlineRender = await evaluate(`({
        onLine: navigator.onLine,
        title: document.title,
        hornVisible: (() => {
          const r = document.querySelector('.horn').getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })(),
        stylesApplied: getComputedStyle(document.querySelector('.horn')).backgroundColor,
        controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        responsive: window.matchMedia('(display-mode: browser)').matches || true,
      })`);
      const offlineShot = await shot('06-offline-reload.png');

      const duringOffline = await pressAndHold();
      const offlinePressShot = await shot('07-offline-press.png');
      await releasePointer();

      // Test synthesised fallback: missing/corrupted audio sample offline
      await evaluate(`(async () => {
        const keys = await caches.keys();
        for (const k of keys) {
          const cache = await caches.open(k);
          const reqs = await cache.keys();
          for (const req of reqs) {
            if (req.url.includes('airhorn.mp3')) {
              await cache.delete(req);
            }
          }
        }
      })()`);

      await send('Network.clearBrowserCache');
      await send('Network.setBlockedURLs', { urls: ['*airhorn.mp3*'] });

      await send('Page.reload', { ignoreCache: false });
      await waitFor(
        `document.readyState === 'complete' && !!document.querySelector('.horn')`,
        15000, 'offline reload without cached audio',
      );
      await sleep(300);

      const duringFallback = await pressAndHold();
      const fallbackShot = await shot('08-offline-fallback-press.png');
      await releasePointer();
      const afterFallback = await hornState();
      const usingFallback = await evaluate('!!(window.__airhorn && window.__airhorn.usingFallback)');
      const oscStarts = await evaluate('window.__probe.oscStarts || 0');

      await send('Network.setBlockedURLs', { urls: [] });

      const problems = [];
      if (sw.state !== 'activated') problems.push(`service worker state=${sw.state}`);
      if (!/\/sw\.js$/.test(sw.script || '')) problems.push(`unexpected SW script ${sw.script}`);
      if (!(sw.cached > 0)) problems.push('nothing precached');
      if (offlineRender.onLine !== false) problems.push('browser did not report offline');
      if (!offlineRender.hornVisible) problems.push('horn not visible offline');
      if (!offlineRender.stylesApplied || offlineRender.stylesApplied === 'rgba(0, 0, 0, 0)') {
        problems.push(`stylesheet missing offline (background=${offlineRender.stylesApplied})`);
      }
      if (!offlineRender.controller) problems.push('no SW controller after offline reload');
      if (!(duringOffline.peak > 0.01)) problems.push(`no audio offline (peak=${duringOffline.peak})`);
      if (duringOffline.pressed !== 'true') problems.push('aria-pressed not set offline');
      if (!usingFallback) problems.push('usingFallback is false when sample is missing offline');
      if (!(oscStarts >= 3)) problems.push(`oscStarts=${oscStarts} (expected >= 3 harmonics)`);
      if (!(duringFallback.peak > 0.01)) problems.push(`fallback synth produced no audio (peak=${duringFallback.peak})`);
      if (duringFallback.pressed !== 'true') problems.push('fallback press did not set aria-pressed');
      if (afterFallback.pressed !== 'false') problems.push('fallback release did not clear aria-pressed');

      record('3. install/offline: SW activates, offline reload renders and plays, synth fallback handles missing sample',
        problems.length === 0,
        problems.length ? problems.join('; ') :
          `SW ${sw.state}, ${sw.cached} precached entries; offline reload rendered ` +
          `(bg ${offlineRender.stylesApplied}, sample peak=${duringOffline.peak.toFixed(3)}, synth peak=${duringFallback.peak.toFixed(3)}, oscStarts=${oscStarts})`,
        [installedShot, offlineShot, offlinePressShot, fallbackShot]);
      notes.offline = { sw, offlineRender, duringOffline, duringFallback, oscStarts, usingFallback };

      await send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
    } catch (err) {
      record('3. install/offline: SW activates, offline reload renders and plays', false, err.message, []);
      try {
        await send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        });
      } catch {}
    }

    /* --------------------------------- 4. WebMCP -------------------------------- */
    try {
      // The current page already carries whatever modelContext the browser
      // offers (real API or the page-load stand-in), so it is the right
      // surface to drive: the app registered its tools against it on load.
      await waitFor(`typeof document.modelContext !== 'undefined'`, 5000, 'document.modelContext');
      await waitFor(`(async () => (await document.modelContext.getTools()).length >= 3)()`,
        8000, 'horn tools to register');

      const discovery = await evaluate(`(async () => {
        const tools = await document.modelContext.getTools();
        return {
          source: window.__webmcpSource || 'native',
          names: tools.map((t) => t.name),
          descriptions: Object.fromEntries(tools.map((t) => [t.name, t.description])),
          hasSchemas: tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'),
          readOnlyHints: Object.fromEntries(
            tools.map((t) => [t.name, t.annotations && t.annotations.readOnlyHint]),
          ),
        };
      })()`);
      const toolsShot = await shot('08-webmcp-tools-discovered.png');

      await resetProbe();
      const playResult = await evaluate(`window.__call('play_horn', {})`);
      await sleep(400);
      const duringPlay = await hornState();
      const playingShot = await shot('09-webmcp-play.png');

      const stateResult = await evaluate(`window.__call('get_horn_state', {})`);
      const stopResult = await evaluate(`window.__call('stop_horn', {})`);
      await sleep(150);
      const afterStop = await hornState();
      let silent = false;
      for (let i = 0; i < 60; i += 1) {
        if ((await evaluate('window.__probe.level')) < 0.005) { silent = true; break; }
        await sleep(100);
      }
      const stoppedShot = await shot('10-webmcp-stop.png');

      const problems = [];
      for (const name of ['play_horn', 'stop_horn', 'get_horn_state']) {
        if (!discovery.names.includes(name)) problems.push(`tool ${name} not registered`);
      }
      if (!discovery.hasSchemas) problems.push('a tool is missing an object inputSchema');
      if (!(duringPlay.peak > 0.01)) problems.push(`executeTool('play_horn') made no audio (peak=${duringPlay.peak})`);
      if (playResult.playing !== true) problems.push(`play_horn returned ${JSON.stringify(playResult)}`);
      if (duringPlay.pressed !== 'true') problems.push('play_horn did not update aria-pressed');
      if (stateResult.playing !== true) problems.push('get_horn_state did not report playing');
      if (stateResult.hasAudioContext !== true) problems.push('get_horn_state reports no AudioContext');
      if (stopResult.playing !== false) problems.push(`stop_horn returned ${JSON.stringify(stopResult)}`);
      if (afterStop.pressed !== 'false') problems.push('stop_horn did not clear aria-pressed');
      if (!silent) problems.push('audio still audible after stop_horn');

      record('4. WebMCP: tools discovered and executeTool sounds the horn',
        problems.length === 0,
        (problems.length ? problems.join('; ') + ' | ' : '') +
          `source=${discovery.source}, tools=[${discovery.names.join(', ')}], ` +
          `play peak=${duringPlay.peak.toFixed(3)}, stop silent=${silent}` +
          (webmcpNative ? '' : ' | NOTE: browser exposes no native document.modelContext'),
        [toolsShot, playingShot, stoppedShot]);
      notes.webmcp = { ...notes.webmcp, discovery, playResult, stateResult, stopResult };
    } catch (err) {
      record('4. WebMCP: tools discovered and executeTool sounds the horn', false, err.message, []);
    }

    /* --------------------- 5. reduced motion + dark mode ----------------------- */
    try {
      await send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [
          { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-color-scheme', value: 'dark' },
        ],
      });
      await sleep(250);

      const media = await evaluate(`(() => {
        const horn = document.querySelector('.horn');
        const rect = horn.getBoundingClientRect();
        const cs = getComputedStyle(horn);
        const bodyCs = getComputedStyle(document.body);
        const htmlCs = getComputedStyle(document.documentElement);
        return {
          prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
          horn: {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            inViewport: rect.top >= -1 && rect.left >= -1 &&
              rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            background: cs.backgroundColor,
          },
          body: { background: bodyCs.backgroundColor, color: bodyCs.color },
          html: { colorScheme: htmlCs.colorScheme },
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          viewport: { width: innerWidth, height: innerHeight },
        };
      })()`);

      // Does the page honour reduced motion once the horn is sounding? Focus the
      // horn first: its key handler lives on the button, not the document.
      await evaluate(`document.querySelector('.horn').focus(); true`);
      await resetProbe();
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
      await sleep(350);
      const motion = await evaluate(`(() => {
        const horn = document.querySelector('.horn');
        const animations = horn.getAnimations({ subtree: true });
        return {
          horning: horn.classList.contains('horning'),
          peak: window.__probe.peak,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          animationCount: animations.length,
          durations: animations.slice(0, 4).map((a) => (a.effect && a.effect.getTiming().duration)),
          iterations: animations.slice(0, 4).map((a) => (a.effect && a.effect.getTiming().iterations)),
        };
      })()`);
      const reducedShot = await shot('11-reduced-motion-dark.png');
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await sleep(150);

      // Restore automatic media so the normal look is captured too.
      await send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });
      await sleep(200);
      const normal = await evaluate(`(() => {
        const cs = getComputedStyle(document.querySelector('.horn'));
        const bodyCs = getComputedStyle(document.body);
        return { hornBackground: cs.backgroundColor, bodyBackground: bodyCs.backgroundColor };
      })()`);
      const normalShot = await shot('12-normal-media.png');

      const problems = [];
      if (!media.prefersReducedMotion) problems.push('prefers-reduced-motion not emulated');
      if (!media.prefersDark) problems.push('prefers-color-scheme: dark not emulated');
      if (!media.horn.inViewport) problems.push('horn outside the viewport');
      if (media.horn.width < 100) problems.push(`horn collapsed to ${media.horn.width}px wide`);
      if (media.horn.display === 'none' || media.horn.visibility === 'hidden' || media.horn.opacity === '0') {
        problems.push('horn not rendered');
      }
      if (media.overflowX) problems.push('horizontal overflow');
      const hornRgb = parseRgb(media.horn.background);
      const bodyRgb = parseRgb(media.body.background);
      // Informational only: the red-on-blue brand palette is the same in both
      // schemes, so this is a description of the design, not a media regression.
      const ratio = hornRgb && bodyRgb ? contrastRatio(hornRgb, bodyRgb) : 0;
      notes.media = { media, motion, contrast: ratio, normal };

      // Rendering is sane, so item 5 passes, but both media preferences are
      // unhandled by the stylesheet. Record them here so the report is honest
      // even for a reader who only skims the PASS/FAIL column.
      if (motion.animationCount > 0) {
        observations.push(
          `prefers-reduced-motion is not honoured: while the horn is held, ` +
          `${motion.animationCount} animations keep running (durations ` +
          `${JSON.stringify(motion.durations)}ms, infinite iterations).`,
        );
      }
      if (media.horn.background === normal.hornBackground &&
          media.body.background === normal.bodyBackground) {
        observations.push(
          `prefers-color-scheme: dark is not honoured: identical colours in both ` +
          `schemes and color-scheme=${media.html.colorScheme}; the page stays on the ` +
          `brand blue background.`,
        );
      }

      record('5. reduced motion + dark mode render sanely',
        problems.length === 0,
        (problems.length ? problems.join('; ') : 'renders and stays pressable') +
          ` | dark: horn ${media.horn.background} on body ${media.body.background} ` +
          `(${ratio.toFixed(2)}:1), color-scheme=${media.html.colorScheme}; ` +
          `reduced-motion (horn sounding=${motion.horning}, peak=${Number(motion.peak).toFixed(3)}): ` +
          `${motion.animationCount} animation(s) still running ` +
          `(durations ${JSON.stringify(motion.durations)}, iterations ${JSON.stringify(motion.iterations)}); ` +
          `dark-mode-specific styling: ${
            media.horn.background !== normal.hornBackground ||
            media.body.background !== normal.bodyBackground ? 'yes' : 'none'}`,
        [reducedShot, normalShot]);
    } catch (err) {
      record('5. reduced motion + dark mode render sanely', false, err.message, []);
    }

    /* ----------------------- 6. keyboard hold semantics ---------------------- */
    try {
      // A fresh page: case 3 forces the synth fallback and case 5 leaves the
      // context's gesture state warm, and neither must decide whether a
      // keyboard hold works - the semantics under test are per page load
      // (airhorn-ay73).
      await send('Page.reload');
      for (let i = 0; i < 60; i += 1) {
        try {
          if (await evaluate(`!!window.__airhorn && document.readyState === 'complete' && document.querySelector('.horn')`)) break;
        } catch {}
        await sleep(250);
      }
      const key = (type, over = {}) => send('Input.dispatchKeyEvent', {
        type,
        key: over.key ?? ' ',
        code: over.code ?? 'Space',
        windowsVirtualKeyCode: over.wvk ?? 32,
        ...(type === 'keyDown' ? { text: over.text ?? ' ' } : {}),
        ...(over.autoRepeat ? { autoRepeat: true } : {}),
      });
      const spaceDown = (autoRepeat = false) => key('keyDown', autoRepeat ? { autoRepeat: true } : {});
      const spaceUp = () => key('keyUp');
      const escapeDown = () => key('keyDown', { key: 'Escape', code: 'Escape', wvk: 27 });
      // The hold state machine is asserted through its DOM state (horning
      // class, aria-pressed, isLooping), not through the audio layer: once
      // case 3 forces the synth fallback the source counter and peaks no
      // longer mean what they mean on the sample path (airhorn-ay73).
      const state = () => evaluate(`(() => ({
        horning: document.querySelector('.horn').classList.contains('horning'),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed'),
        loop: window.__airhorn.isLooping(),
        kd: window.__kd || 0,
        ku: window.__ku || 0,
        active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : 'none',
      }))()`);
      const problems = [];
      const seq = [];
      const note = () => `[${seq.join(' -> ')}]`;

      await evaluate(`document.querySelector('.horn').focus(); window.__kd = 0; window.__ku = 0; window.__blurs = 0; window.__hides = 0; window.addEventListener('blur', () => { window.__blurs++; }); document.addEventListener('visibilitychange', () => { if (document.hidden) window.__hides++; }); document.querySelector('.horn').addEventListener('keydown', () => { window.__kd++; }); document.querySelector('.horn').addEventListener('keyup', () => { window.__ku++; }); true`);

      // Hold Space: exactly one blast; 2s of OS key repeat must not retrigger.
      await spaceDown();
      seq.push('Space down');
      await sleep(200);
      let s = await state();
      if (s.horning !== true || s.pressed !== 'true' || s.loop !== true) problems.push(`holding Space did not light the hold (horning=${s.horning}, pressed=${s.pressed}, loop=${s.loop}) ${note()}`);
      for (let i = 0; i < 40; i += 1) { await spaceDown(true); await sleep(50); }
      seq.push('Space repeat x40 (~2s)');
      s = await state();
      if (s.horning !== true || s.pressed !== 'true') problems.push(`the hold did not survive 2s of OS key repeat (horning=${s.horning}, pressed=${s.pressed}) - the repeat tail must not retire or retrigger it ${note()}`);
      await spaceUp();
      await sleep(250);
      seq.push('Space up');
      s = await state();
      if (s.horning !== false || s.pressed !== 'false' || s.loop !== false) problems.push(`Space keyup did not stop the hold (horning=${s.horning}, pressed=${s.pressed}, loop=${s.loop}) - the ring-out may sound but the hold must be off ${note()}`);

      // Escape mid-hold: the horn retires and stays retired through the
      // repeat tail; the key's release clears the cancellation so a fresh
      // hold works.
      await spaceDown();
      seq.push('Space down');
      await sleep(200);
      s = await state();
      if (s.horning !== true) problems.push(`the fresh hold before Escape was not lit (horning=${s.horning}) ${note()}`);
      await escapeDown();
      seq.push('Escape (while held)');
      await sleep(150);
      for (let i = 0; i < 6; i += 1) { await spaceDown(true); await sleep(50); }
      seq.push('Space repeat x6 after Escape');
      s = await state();
      if (s.horning !== false || s.pressed !== 'false' || s.loop !== false) problems.push(`Escape did not stop the held horn (horning=${s.horning}, pressed=${s.pressed}, loop=${s.loop}) or its repeat tail restarted it ${note()}`);
      await spaceUp();
      await sleep(100);
      seq.push('Space up');
      await spaceDown();
      seq.push('Space down (fresh)');
      await sleep(200);
      s = await state();
      if (s.horning !== true || s.pressed !== 'true') problems.push(`a fresh hold after Escape did not start the horn (horning=${s.horning}, pressed=${s.pressed}) ${note()}`);
      await spaceUp();
      await sleep(250);

      // Blur + tab-hide mid-hold: a real second tab takes activation, which
      // blurs the window and hides the page in one real browser step. The
      // horn must be stopped - and stay stopped through repeats arriving
      // after the hide; and after the key is released the hold must not be
      // stuck: a fresh hold starts exactly one blast.
      await spaceDown();
      seq.push('Space down');
      await sleep(200);
      s = await state();
      if (s.horning !== true) problems.push(`the fresh hold before the tab switch was not lit (horning=${s.horning}) ${note()}`);
      const extra = await browserSend('Target.createTarget', { url: `${origin}/` });
      await sleep(500);
      seq.push('second tab activated (blur + hide)');
      s = await state();
      if (s.horning !== false || s.pressed !== 'false' || s.loop !== false) problems.push(`the hold kept sounding after the window lost activation (blur/tab-hide): horning=${s.horning}, pressed=${s.pressed}, loop=${s.loop} ${note()}`);
      for (let i = 0; i < 4; i += 1) { await spaceDown(true); await sleep(50); }
      seq.push('Space repeat x4 while hidden');
      s = await state();
      if (s.horning !== false || s.pressed !== 'false') problems.push(`the hold restarted from repeats while the page was hidden (horning=${s.horning}, pressed=${s.pressed}) ${note()}`);
      await spaceUp();
      seq.push('Space up while hidden');
      await browserSend('Target.closeTarget', { targetId: extra.targetId });
      await sleep(400);
      await evaluate(`document.querySelector('.horn').focus(); true`);
      await spaceDown();
      seq.push('Space down (fresh after hide)');
      await sleep(200);
      s = await state();
      if (s.horning !== true || s.pressed !== 'true') problems.push(`after hide + keyup the hold was stuck: a fresh hold did not start (horning=${s.horning}, pressed=${s.pressed}) ${note()}`);
      await spaceUp();
      await sleep(250);

      record('6. keyboard hold: one blast per hold, repeats ignored, Escape/blur/hide never stick',
        problems.length === 0,
        (problems.length ? problems.join('; ') + ' | ' : '') + `key sequence: ${seq.join(' -> ')}`,
        []);
    } catch (err) {
      record('6. keyboard hold: one blast per hold, repeats ignored, Escape/blur/hide never stick', false, err.message, []);
    }

    /* -------------------------- page errors / badge --------------------------- */
    const pageErrors = await evaluate('window.__pageErrors || []');
    const errorLines = [...pageErrors, ...pageConsole.filter((m) => m.type === 'error')];
    record('0. no uncaught errors in the page',
      errorLines.length === 0,
      errorLines.length ? errorLines.map((e) => e.message || e.text).join(' | ') : 'none observed',
      []);

    notes.badge = await evaluate('window.__badge');
    notes.console = pageConsole;

    /* ------------------------------- report ---------------------------------- */
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.length - passed;
    const report = {
      generatedAt: new Date().toISOString(),
      origin,
      evidenceDir,
      passed,
      failed,
      results,
      observations,
      notes,
    };
    fs.writeFileSync(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(evidenceDir, 'summary.txt'),
      results.map((r) => `${r.status}\t${r.item}\t${r.detail}`).join('\n') + '\n' +
      (observations.length ? `\nObservations:\n${observations.map((o) => `- ${o}`).join('\n')}\n` : ''),
    );

    console.log('\n=== Acceptance report ===');
    console.log(`evidence: ${evidenceDir}`);
    for (const r of results) console.log(`${r.status}  ${r.item}`);
    console.log(`${passed} passed, ${failed} failed`);
    if (observations.length) {
      console.log('\nObservations (file as findings, not failures):');
      for (const o of observations) console.log(`- ${o}`);
    }

    if (failed > 0) process.exitCode = 1;
  } finally {
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (browserWs) {
      try { browserWs.close(); } catch {}
    }
    if (browser) {
      await browser.close();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error('Acceptance run failed:', err);
  process.exitCode = 1;
});
