import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

import { chromeBin, connectPage, launchChrome } from './lib/chrome.mjs';
import { createStaticServer } from './lib/static-server.mjs';
import { measurementExitCode, unmeasured } from './lib/perf-metrics.mjs';

// The teardown below lives in a try/finally, which a bound-kill (fleet-gate's
// SIGTERM, a job-tree reaper, Ctrl-C) never reaches - so the chrome tree and its
// /tmp profile survived the kill (airhorn-dpua, the tools' copy of the gap
// airhorn-4vfn closed for the suites). Register the live launch and reap it
// synchronously inside the handler's grace: the handle's killNow() is the
// launcher's own sweep + tree kill + profile rm (airhorn-2po9).
let liveBrowser = null;
installSignalExit(() => {
  const browser = liveBrowser;
  liveBrowser = null;
  browser?.killNow();
});


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

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

// Exported for the browser-free probes in tests/test-support.test.js (airhorn-k77v).
// The shared server decides containment on the OPENED handle (airhorn-k0xp/-dklf); this
// handler used to join req.url onto dist/ with no check at all, so '/../..' was followed.
export function createPerfServer(distDir) {
  return createStaticServer({
    root: distDir,
    mimeTypes,
    headers: { 'Service-Worker-Allowed': '/' },
  });
}

async function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  const server = createPerfServer(distDir);

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // One launcher owns chrome, its process tree and its profile (airhorn-2po9):
  // the flags, the startup bound, /json/list discovery and the page ws bound
  // are all tools/lib/chrome.mjs's, and both the bound-kill hook above and the
  // finally below reap the same handle.
  const browser = await launchChrome({ label: 'perf-profile', timeoutMs: 10000, discoveryMs: 10000 });
  liveBrowser = browser;
  let ws;
  try {
    ws = await connectPage(browser, { label: 'perf-profile', timeoutMs: 10000 });
  } catch (err) {
    // The socket never opened, so nothing downstream owns this launch: stop the
    // signal hook reaching a handle that is already being reaped here.
    liveBrowser = null;
    await browser.close();
    throw err;
  }

  let msgId = 1;
  const pending = new Map();
  let networkTransferred = 0;
  const requestTransferred = new Map();
  const responses = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Network.dataReceived') {
      networkTransferred += msg.params.encodedDataLength || 0;
    } else if (msg.method === 'Network.loadingFinished') {
      requestTransferred.set(msg.params.requestId, msg.params.encodedDataLength || 0);
    } else if (msg.method === 'Network.responseReceived') {
      responses.push({
        url: msg.params.response.url,
        fromServiceWorker: msg.params.response.fromServiceWorker,
        fromDiskCache: msg.params.response.fromDiskCache,
        encodedDataLength: msg.params.response.encodedDataLength
      });
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

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const observerScript = `
      window.__perfMetrics = {
        fp: null,
        fcp: null,
        lcp: null,
        lcpEntriesCount: 0,
        cls: 0,
        rawEvents: []
      };

      try {
        new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            if (entry.name === 'first-paint') {
              window.__perfMetrics.fp = entry.startTime;
            } else if (entry.name === 'first-contentful-paint') {
              window.__perfMetrics.fcp = entry.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (e) {}

      try {
        new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          window.__perfMetrics.lcpEntriesCount += entries.length;
          if (entries.length > 0) {
            window.__perfMetrics.lcp = entries[entries.length - 1].startTime;
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {}

      try {
        new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            if (!entry.hadRecentInput) {
              window.__perfMetrics.cls += entry.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) {}

      try {
        new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            window.__perfMetrics.rawEvents.push({
              name: entry.name,
              duration: entry.duration,
              interactionId: entry.interactionId || 0,
              startTime: entry.startTime
            });
          }
        }).observe({ type: 'event', durationThreshold: 0, buffered: true });
      } catch (e) {}
    `;

    await send('Page.addScriptToEvaluateOnNewDocument', { source: observerScript });

    // --- COLD LOAD ---
    networkTransferred = 0;
    requestTransferred.clear();
    responses.length = 0;

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 1000));

    // Wait for service worker to activate
    let swActive = false;
    for (let i = 0; i < 40; i++) {
      const evalRes = await send('Runtime.evaluate', {
        expression: 'navigator.serviceWorker.controller ? true : false',
        returnByValue: true
      });
      if (evalRes.result.value) {
        swActive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // Trigger user input interaction via CDP Input domain for trusted INP
    const boxEval = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const btn = document.querySelector('.horn');
          if (!btn) return null;
          const rect = btn.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `,
      returnByValue: true
    });
    if (boxEval.result.value) {
      const { x, y } = boxEval.result.value;
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1
      });
      await new Promise(r => setTimeout(r, 100));
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1
      });
    }
    await new Promise(r => setTimeout(r, 500));

    const coldEval = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__perfMetrics)',
      returnByValue: true
    });
    const coldMetrics = JSON.parse(coldEval.result.value);

    let coldTransferred = 0;
    for (const b of requestTransferred.values()) coldTransferred += b;
    if (coldTransferred === 0) coldTransferred = networkTransferred;
    const coldResponses = [...responses];

    // --- REPEAT LOAD ---
    networkTransferred = 0;
    requestTransferred.clear();
    responses.length = 0;

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 1000));

    if (boxEval.result.value) {
      const { x, y } = boxEval.result.value;
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1
      });
      await new Promise(r => setTimeout(r, 100));
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1
      });
    }
    await new Promise(r => setTimeout(r, 500));

    const repeatEval = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__perfMetrics)',
      returnByValue: true
    });
    const repeatMetrics = JSON.parse(repeatEval.result.value);

    let repeatTransferred = 0;
    for (const b of requestTransferred.values()) repeatTransferred += b;
    if (repeatTransferred === 0) repeatTransferred = networkTransferred;
    const repeatResponses = [...responses];

    function formatLcp(m) {
      if (m.lcp !== null && m.lcp > 0) {
        return `${Math.round(m.lcp)} ms`;
      }
      return `None (${m.lcpEntriesCount} entries recorded)`;
    }

    function computeInp(m) {
      const events = m.rawEvents || [];
      if (events.length === 0) {
        return 'None (0 events >=16ms)';
      }
      const interactions = new Map();
      for (const ev of events) {
        const key = ev.interactionId ? String(ev.interactionId) : `${Math.round(ev.startTime / 100)}`;
        const cur = interactions.get(key) || 0;
        if (ev.duration > cur) interactions.set(key, ev.duration);
      }
      const durations = Array.from(interactions.values()).sort((a, b) => a - b);
      const p98Index = Math.min(durations.length - 1, Math.floor(durations.length * 0.98));
      const inp = durations[p98Index];
      const maxEvent = Math.max(...events.map(e => e.duration));
      return `${Math.round(inp)} ms (max: ${Math.round(maxEvent)} ms, ${events.length} evts >=16ms)`;
    }

    function summarizeResponses(resps) {
      const sw = resps.filter(r => r.fromServiceWorker).length;
      const disk = resps.filter(r => r.fromDiskCache).length;
      const net = resps.filter(r => !r.fromServiceWorker && !r.fromDiskCache).length;
      return `${sw} SW / ${disk} Disk / ${net} Net (${resps.length} total)`;
    }

    console.log('=== Performance Measurement Report ===');
    console.log(`Tooling: Google Chrome Headless (${chromeBin()}) via CDP WebSocket`);
    // The conditions belong IN the report, not only next to it (airhorn-qons):
    // the checked-in preview/CWV-report.txt is quoted as perf evidence, and a
    // reader who sees only these lines has to be able to tell that this is not
    // a phone. The tool applies no Emulation at all - no CPU throttle, no
    // network throttle, default viewport, loopback server.
    const viewportRes = await send('Runtime.evaluate', {
      expression: '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })',
      returnByValue: true,
    });
    const viewport = viewportRes.result.value
      ? `${viewportRes.result.value.w}x${viewportRes.result.value.h} @${viewportRes.result.value.dpr}x`
      : 'unknown';
    console.log(`Conditions: NO CPU throttling, NO network throttling, default viewport ${viewport}, ` +
      'server on loopback - a desktop-class measurement, NOT a phone on a mobile network');
    console.log(`SW Controller Present: ${swActive}`);
    console.table({
      'Cold Load': {
        'Transferred Bytes': `${coldTransferred} B`,
        'Request Provenance': summarizeResponses(coldResponses),
        'First Paint (FP)': coldMetrics.fp !== null ? `${Math.round(coldMetrics.fp)} ms` : 'None',
        'LCP': formatLcp(coldMetrics),
        'INP (p98)': computeInp(coldMetrics),
        'CLS': coldMetrics.cls.toFixed(4)
      },
      'Repeat (SW-cached) Load': {
        'Transferred Bytes': `${repeatTransferred} B`,
        'Request Provenance': summarizeResponses(repeatResponses),
        'First Paint (FP)': repeatMetrics.fp !== null ? `${Math.round(repeatMetrics.fp)} ms` : 'None',
        'LCP': formatLcp(repeatMetrics),
        'INP (p98)': computeInp(repeatMetrics),
        'CLS': repeatMetrics.cls.toFixed(4)
      }
    });

    // A report is evidence only for what it measured (airhorn-lmlu): when the LCP
    // observer registered but never fired, the table said "None (0 entries recorded)"
    // and the tool STILL exited 0, so a CWV report could be quoted for a field it
    // never measured. The row already told the truth; the exit code now agrees with it.
    const notMeasured = unmeasured([
      { label: 'cold load', metrics: coldMetrics },
      { label: 'repeat (SW-cached) load', metrics: repeatMetrics },
    ]);
    if (notMeasured.length > 0) {
      console.log('\nNOT MEASURED (this run is not evidence for these fields):');
      for (const finding of notMeasured) console.log(`  - ${finding}`);
      console.log('Exiting nonzero so an unmeasured report cannot be read as a green one.');
    }
    process.exitCode = measurementExitCode(notMeasured);

  } finally {
    try { ws.close(); } catch { /* already closed */ }
    // The success path used to leak one profile dir per run (airhorn-5xqi):
    // `chrome.kill('SIGKILL')` is asynchronous, so chrome's children were still
    // writing to the profile when the bare rm ran, and their writeback re-created
    // Default/ inside the directory it had just deleted (observed: rc=0 and
    // /tmp/chrome-perf-profile-*/Default/ left behind). Sweep the whole tree by
    // this launch's --user-data-dir first - a SIGKILL runs no handler and every
    // child carries the marker, so one /proc read kills the writers - then remove
    // with the retries the failure path above already had.
    liveBrowser = null;
    server.close();
    await browser.close();
  }
}

// Only a direct `node tools/measure-perf.mjs` runs the measurement: importing the module
// (the browser-free server probes in tests/test-support.test.js) must not launch Chrome.
// Same idiom as resilience-audit.mjs and idle-cost.mjs (airhorn-k77v).
const invokedAsScript = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
