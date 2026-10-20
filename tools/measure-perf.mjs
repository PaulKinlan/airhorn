import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

import { sweepProfile } from './lib/reap.mjs';

// The teardown below lives in a try/finally, which a bound-kill (fleet-gate's
// SIGTERM, a job-tree reaper, Ctrl-C) never reaches - so the chrome tree and its
// /tmp profile survived the kill (airhorn-dpua, the tools' copy of the gap
// airhorn-4vfn closed for the suites). Register the live launch and do the same
// sweep + removal synchronously inside the handler's grace.
let liveBrowser = null;
installSignalExit(() => {
  if (!liveBrowser) return;
  const { chrome, profileDir } = liveBrowser;
  liveBrowser = null;
  sweepProfile(profileDir);
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
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

  const chromeBin = process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : 'google-chrome');

  const profileDir = '/tmp/chrome-perf-profile-' + Date.now();
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // NOT detached (airhorn-105n, the tools' copy of the acex fix): chrome must
  // stay in the caller's process group so an ancestor group-kill - what
  // fleet-gate's bound and any job-tree reaper send - reaches the whole tree;
  // SIGKILL runs no handler, so a detached launch outlived the kill.
  liveBrowser = { chrome, profileDir };

  // A spawn that never produced a process reports through the 'error' event,
  // not a rejection: with no listener that is an uncaughtException, so it aborts
  // the tool BEFORE the teardown below can run (airhorn-trj7). Raced against the
  // handshake so a bad CHROME_BIN takes the same cleanup as every other
  // launch-window failure.
  const spawnFailed = new Promise((_, reject) =>
    chrome.once('error', (err) => reject(new Error(`chrome launch failed: ${err.message}`))));

  let wsUrl = null;
  let ws = null;
  // The early window (handshake, discovery, ws connect) sits before the try
  // whose finally reaps, so a failure there used to throw with chrome and its
  // profile alive (airhorn-51lr). Route it into the same teardown.
  try {
    await Promise.race([spawnFailed, new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome timeout')), 10000);
      chrome.stderr.on('data', (d) => {
        const match = d.toString().match(/ws:\/\/[^\s]+/);
        if (match) {
          wsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      });
    })]);

    const chromePort = new URL(wsUrl).port;
    // Discovery is bounded like the handshake above: a DevTools endpoint that
    // accepts and never answers must reject into this tool's cleanup instead of
    // parking it until undici's ~300s headers timeout (airhorn-9vg3).
    let targets;
    try {
      const res = await fetch(`http://127.0.0.1:${chromePort}/json/list`, { signal: AbortSignal.timeout(10000) });
      targets = await res.json();
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error('DevTools discovery timeout: /json/list did not settle within 10000ms');
      throw err;
    }
    const pageWsUrl = targets.find(t => t.type === 'page').webSocketDebuggerUrl;

    ws = new WebSocket(pageWsUrl);
    // Bounded like discovery above: a peer that answers /json/list but never
    // completes the ws upgrade must reject into the cleanup instead of parking
    // the tool with its launch alive (airhorn-doek).
    await new Promise((resolve, reject) => {
      const bound = setTimeout(() => reject(new Error('DevTools ws handshake timeout: the page socket never opened within 10000ms')), 10000);
      ws.onopen = () => { clearTimeout(bound); resolve(); };
      ws.onerror = () => { clearTimeout(bound); reject(new Error('DevTools ws handshake failed: the page socket errored')); };
    });
  } catch (err) {
    liveBrowser = null;
    sweepProfile(profileDir);
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort */ }
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
    console.log(`Tooling: Google Chrome Headless (${chromeBin}) via CDP WebSocket`);
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
    sweepProfile(profileDir);
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
