import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

import { chromeBin, connectPage, launchChrome } from './lib/chrome.mjs';

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

async function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  const server = http.createServer((req, res) => {
    let reqUrl = req.url.split('?')[0];
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
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Service-Worker-Allowed': '/'
    });
    fs.createReadStream(filePath).pipe(res);
  });

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

    // MEASUREMENT INTEGRITY (airhorn-nxuv.13, -nxuv.14, -nxuv.30). Every item pushed here means the
    // printed report is NOT a measurement of the app under its service worker, and the run exits
    // non-zero at the end of this block. It matters because this tool's stdout is checked in as
    // preview/CWV-report.txt and quoted as the perf evidence of record (docs/runbooks/DEPLOY.md:293):
    // a number the tool did not measure must not leave the tool looking clean.
    const integrity = [];

    // One reader for "is a service worker controlling THIS document", shared by both loads. The cold
    // load polled it and the repeat load never did, so the repeat row printed 'Repeat (SW-cached) Load'
    // whether or not any worker existed - a workerless repeat load was reported as the cached path the
    // row claims to measure (airhorn-nxuv.13).
    async function swControllerActive() {
      for (let i = 0; i < 40; i++) {
        const evalRes = await send('Runtime.evaluate', {
          expression: 'navigator.serviceWorker && navigator.serviceWorker.controller ? true : false',
          returnByValue: true
        });
        if (evalRes.result.value) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    }

    // Dispatch one trusted click on the horn, RE-QUERYING the element every time, and report whether the
    // interaction actually happened. The repeat load reused the cold page's coordinates and skipped the
    // click silently when .horn was absent, so a page with no horn produced an INP line of 'None' that
    // read like a measured zero (airhorn-nxuv.14).
    async function clickHorn() {
      const boxEval = await send('Runtime.evaluate', {
        expression: `
          (() => {
            const btn = document.querySelector('.horn');
            if (!btn) return null;
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null;
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()
        `,
        returnByValue: true
      });
      const box = boxEval.result.value;
      if (!box) return { dispatched: false, reason: 'the document has no visible .horn element' };
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      });
      await new Promise(r => setTimeout(r, 100));
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      });
      return { dispatched: true, reason: '' };
    }

    const observerScript = `
      window.__perfMetrics = {
        fp: null,
        fcp: null,
        lcp: null,
        lcpEntriesCount: 0,
        cls: 0,
        rawEvents: [],
        observerErrors: []
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
      } catch (e) {
        window.__perfMetrics.observerErrors.push({ type: 'paint', message: String((e && e.message) || e) });
      }

      try {
        new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          window.__perfMetrics.lcpEntriesCount += entries.length;
          if (entries.length > 0) {
            window.__perfMetrics.lcp = entries[entries.length - 1].startTime;
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {
        window.__perfMetrics.observerErrors.push({ type: 'largest-contentful-paint', message: String((e && e.message) || e) });
      }

      try {
        new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            if (!entry.hadRecentInput) {
              window.__perfMetrics.cls += entry.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) {
        window.__perfMetrics.observerErrors.push({ type: 'layout-shift', message: String((e && e.message) || e) });
      }

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
      } catch (e) {
        window.__perfMetrics.observerErrors.push({ type: 'event', message: String((e && e.message) || e) });
      }
    `;

    await send('Page.addScriptToEvaluateOnNewDocument', { source: observerScript });

    // --- COLD LOAD ---
    networkTransferred = 0;
    requestTransferred.clear();
    responses.length = 0;

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 1000));

    // Wait for service worker to activate
    const swActive = await swControllerActive();
    if (!swActive) integrity.push('no service worker controlled the COLD load');

    // Trigger user input interaction via CDP Input domain for trusted INP
    const coldInteraction = await clickHorn();
    if (!coldInteraction.dispatched) {
      integrity.push(`cold load: ${coldInteraction.reason}, so no trusted interaction was measured`);
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

    // The repeat load gets its OWN controller check and its own element query: it is a different
    // document, so neither the cold load's controller state nor its click coordinates describe it
    // (airhorn-nxuv.13, -nxuv.14).
    const repeatSwActive = await swControllerActive();
    if (!repeatSwActive) integrity.push('no service worker controlled the REPEAT load');

    const repeatInteraction = await clickHorn();
    if (!repeatInteraction.dispatched) {
      integrity.push(`repeat load: ${repeatInteraction.reason}, so no trusted interaction was measured`);
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

    function computeInp(m, interaction) {
      const events = m.rawEvents || [];
      if (events.length === 0) {
        // A bare 'None' is indistinguishable from a measured zero, and the checked-in report shipped
        // exactly that on a row whose click was dispatched (airhorn-nxuv.14). Name which of the two
        // happened: Chrome emits no event-timing entry below its 16ms granularity, so a dispatched
        // click with no entries is 'not measurable', while no click at all is 'never measured'.
        return interaction && interaction.dispatched
          ? 'None (0 event-timing entries >=16ms after a dispatched click: not a measured zero)'
          : 'UNMEASURED (no interaction was dispatched) - this row is not an INP result';
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
    // Observer failures (airhorn-nxuv.30): the four PerformanceObserver registrations used to sit in
    // empty catch blocks, so a browser that refused one left the matching column at its default (LCP
    // null, CLS 0.0000) and the report still read as a full set of measurements.
    const observerErrors = [
      ...(coldMetrics.observerErrors || []),
      ...(repeatMetrics.observerErrors || []),
    ];
    for (const e of observerErrors) {
      integrity.push(`PerformanceObserver for '${e.type}' failed: ${e.message}`);
    }

    console.log(`SW Controller Present: cold=${swActive} repeat=${repeatSwActive}`);
    if (observerErrors.length > 0) {
      console.log(`Observer Registration Failures: ${observerErrors.length}`);
      for (const e of observerErrors) console.log(`  - '${e.type}': ${e.message}`);
    }
    // The row title carries what was actually observed: a repeat load with no controlling worker is
    // not the 'SW-cached' row this report has always claimed to print (airhorn-nxuv.13).
    const repeatRowLabel = repeatSwActive
      ? 'Repeat (SW-cached) Load'
      : 'Repeat Load (NO service worker) - not a cached-path measurement';
    console.table({
      'Cold Load': {
        'Transferred Bytes': `${coldTransferred} B`,
        'Request Provenance': summarizeResponses(coldResponses),
        'First Paint (FP)': coldMetrics.fp !== null ? `${Math.round(coldMetrics.fp)} ms` : 'None',
        'LCP': formatLcp(coldMetrics),
        'INP (p98)': computeInp(coldMetrics, coldInteraction),
        'CLS': coldMetrics.cls.toFixed(4)
      },
      [repeatRowLabel]: {
        'Transferred Bytes': `${repeatTransferred} B`,
        'Request Provenance': summarizeResponses(repeatResponses),
        'First Paint (FP)': repeatMetrics.fp !== null ? `${Math.round(repeatMetrics.fp)} ms` : 'None',
        'LCP': formatLcp(repeatMetrics),
        'INP (p98)': computeInp(repeatMetrics, repeatInteraction),
        'CLS': repeatMetrics.cls.toFixed(4)
      }
    });

    if (integrity.length > 0) {
      console.log('');
      console.log('!!! MEASUREMENT INVALID - do NOT quote this report as performance evidence:');
      for (const f of integrity) console.log(`  - ${f}`);
      // Thrown after the report so the numbers that WERE collected are still printed, the finally
      // below still reaps chrome and its profile, and the caller sees a non-zero exit instead of a
      // clean-looking report of numbers this run did not measure.
      throw new Error(`measure-perf: measurement invalid (${integrity.length} integrity failure(s)); see the report above`);
    }

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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
