#!/usr/bin/env node
/*
 * tools/idle-cost.mjs — what does the built app cost while nobody touches it? (airhorn-1umb)
 *
 * The Air Horner is a PWA people leave open — and an installed app that idles hot
 * is a battery cost on a phone. Nothing in this repo measured that: the suites
 * prove behaviour at a moment, soak.mjs proves what a long session RETAINS, and
 * neither says whether an untouched page is burning CPU.
 *
 * This tool opens the built app, leaves it alone, and measures the work it does
 * anyway, in four states, each against a stated budget:
 *
 *   A. pristine idle    — loaded, never touched. Nothing should be scheduled:
 *                         the boot watchdog's timers are cancelled when the app
 *                         boots, the status region owns no timers, and there is
 *                         no rAF loop anywhere in src/.
 *   B. after a blast    — idle once the sound has finished. The interesting one:
 *                         the AudioContext was resumed by the gesture and is
 *                         never suspended again, so the renderer keeps an audio
 *                         graph running for nobody.
 *   C. suspended        — the same window with ctx.suspend() called by this tool,
 *                         which is the measurement that decides whether B is worth
 *                         fixing (B - C is what leaving the context running costs).
 *   D. hidden           — the installed/backgrounded path: a looping horn, then
 *                         the tab goes hidden. The app must stop the sound rather
 *                         than keep a graph running behind a hidden tab.
 *
 * How the numbers are taken:
 *   - main thread: Performance.getMetrics TaskDuration/ScriptDuration deltas, in
 *     seconds of CPU, so %of-one-core = delta / wall clock;
 *   - whole renderer: SystemInfo.getProcessInfo cpuTime (seconds) summed over
 *     renderer processes, which includes the audio and worker threads the main
 *     thread number cannot see;
 *   - scheduling: requestAnimationFrame calls, interval ticks, interval creation,
 *     timeout creation and long tasks are counted inside the page from document
 *     start, so an idle loop is a number, not a suspicion.
 *
 * Load a machine can add noise, so every phase reports both the CPU and the wake-up
 * counters, and the budget verdict uses CPU only when the counters are clean.
 *
 * Usage:
 *   node tools/idle-cost.mjs                        # report, 30s idle windows
 *   node tools/idle-cost.mjs --seconds 60           # longer windows
 *   node tools/idle-cost.mjs --check                # exit 1 if a budget is missed
 *   node tools/idle-cost.mjs --json                 # machine-readable report
 *
 * Budgets (of one core, measured on this VM's headless Chrome):
 *   A pristine idle   < 0.5%      nothing runs
 *   B after a blast   < 1.0%      a running-but-silent AudioContext is tolerated
 *   D hidden          < 0.5%      and no audio may keep playing
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../tests/support/browser.mjs';
import { installSignalExit } from '../tests/support/signal-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '../dist');

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

const BUDGET = { pristineIdle: 0.5, afterBlastIdle: 1.0, hidden: 0.5 };

// Scheduling instrumentation, installed before any page script runs: the app's
// own timers and frames are what is being counted, so this must be in place for
// the boot path too.
const instrumentation = `
  window.__idle = {
    rafs: 0, intervalTicks: 0, intervalsCreated: 0, timeoutsCreated: 0,
    longTasks: 0, longTaskMs: 0, fetches: 0, swEvents: 0, errors: [],
  };
  // Idle network work counts too: a wake-up that re-fetches (or a service worker
  // that chatters) is a wake-up even when the main thread stays cheap.
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (...args) {
      window.__idle.fetches += 1;
      return nativeFetch(...args);
    };
  }
  try {
    navigator.serviceWorker?.addEventListener('controllerchange', () => { window.__idle.swEvents += 1; });
    navigator.serviceWorker?.addEventListener('message', () => { window.__idle.swEvents += 1; });
  } catch { /* no service worker: nothing to count */ }
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (callback) {
    window.__idle.rafs += 1;
    return nativeRaf(callback);
  };
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function (handler, delay, ...args) {
    window.__idle.intervalsCreated += 1;
    return nativeSetInterval(function () {
      window.__idle.intervalTicks += 1;
      if (typeof handler === 'function') return handler.apply(this, args);
      return (0, eval)(String(handler));
    }, delay);
  };
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function (handler, delay, ...args) {
    window.__idle.timeoutsCreated += 1;
    return nativeSetTimeout(handler, delay, ...args);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__idle.longTasks += 1;
        window.__idle.longTaskMs += entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported: the CPU numbers still stand */ }
  // The app does not expose its AudioContext, and its STATE is one of the things
  // being measured. Remember the instance from the first prototype call the app
  // makes on it - same objects, no subclass, so nothing about the app changes.
  try {
    const proto = (window.BaseAudioContext || window.AudioContext || window.webkitAudioContext).prototype;
    for (const method of ['resume', 'suspend', 'createBufferSource', 'createOscillator', 'createGain']) {
      const native = proto[method];
      if (typeof native !== 'function') continue;
      proto[method] = function (...args) {
        window.__airhornContext = this;
        return native.apply(this, args);
      };
    }
  } catch { /* no Web Audio: the phases still measure the page */ }
  window.addEventListener('error', (e) => window.__idle.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__idle.errors.push(String(e.reason && e.reason.message || e.reason)));
`;

function startServer() {
  const server = http.createServer((req, res) => {
    let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      // Every phase is measured on the same bytes: a 304 revalidation would put
      // network work inside an "idle" window.
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let liveBrowser = null;
installSignalExit(() => { liveBrowser?.killNow(); });

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? Number(argv[at + 1]) : fallback;
  };
  const seconds = value('--seconds', 30);
  const hiddenSeconds = value('--hidden-seconds', 10);
  const check = flag('--check');
  const json = flag('--json');

  if (!fs.existsSync(DIST)) throw new Error('dist directory does not exist. Run build first.');

  const server = await startServer();
  const port = server.address().port;
  /** @type {any} */
  let page = null;
  /** @type {any} */
  let browserLevel = null;
  try {
    page = await launchBrowser({ autoplay: true, label: 'idle-cost', timeoutMs: 15000 });
    liveBrowser = page;

    const ws = new WebSocket(page.pageWsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = id++;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error('page evaluation failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      }
      return result.result.value;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // SystemInfo lives on the browser target; the page session cannot reach it.
    const browserWs = new WebSocket(page.browserWsUrl);
    await new Promise((resolve, reject) => { browserWs.onopen = resolve; browserWs.onerror = reject; });
    let browserId = 1;
    const browserPending = new Map();
    browserWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && browserPending.has(message.id)) {
        const { resolve, reject } = browserPending.get(message.id);
        browserPending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
    const browserSend = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = browserId++;
      browserPending.set(messageId, { resolve, reject });
      browserWs.send(JSON.stringify({ id: messageId, method, params }));
    });
    browserLevel = browserWs;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Performance.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });

    const metrics = async () => {
      const { metrics: list } = await send('Performance.getMetrics');
      return Object.fromEntries(list.map((m) => [m.name, m.value]));
    };
    // Per-PROCESS cpuTime, keyed by process id. Summing a total over whatever
    // renderer processes exist is not monotonic: Chrome adds and drops them, and
    // the first version of this tool reported a NEGATIVE renderer delta (-0.75%)
    // because a process disappeared mid-window. Only ids present in both samples
    // are compared, so the delta is real CPU burned by processes that stayed.
    const rendererCpu = async () => {
      const { processInfo } = await browserSend('SystemInfo.getProcessInfo');
      const perProcess = new Map();
      for (const process of processInfo) {
        if (process.type === 'renderer') perProcess.set(process.id, process.cpuTime || 0);
      }
      return perProcess;
    };
    const cpuDelta = (before, after) => {
      let total = 0;
      for (const [processId, cpuTime] of after) {
        if (before.has(processId)) total += cpuTime - before.get(processId);
      }
      return total;
    };
    const counters = () => evaluate('JSON.parse(JSON.stringify(window.__idle))');

    /*
     * One measurement window: wait, then report the CPU the renderer and the main
     * thread burned, plus the scheduling counters, so a verdict can say WHAT woke
     * the page up rather than only that it was awake.
     */
    const windowOf = async (label, ms) => {
      const before = { perf: await metrics(), cpu: await rendererCpu(), counters: await counters() };
      const startedAt = Date.now();
      await sleep(ms);
      const elapsed = (Date.now() - startedAt) / 1000;
      const after = { perf: await metrics(), cpu: await rendererCpu(), counters: await counters() };
      const task = after.perf.TaskDuration - before.perf.TaskDuration;
      const script = after.perf.ScriptDuration - before.perf.ScriptDuration;
      const cpu = cpuDelta(before.cpu, after.cpu);
      const resourcesBefore = await evaluate(`performance.getEntriesByType('resource').length`);
      after.counters.resourceEntries = 0;
      before.counters.resourceEntries = 0;
      const resourcesAfter = await evaluate(`performance.getEntriesByType('resource').length`);
      after.counters.resourceEntries = resourcesAfter - resourcesBefore;
      const delta = (key) => after.counters[key] - before.counters[key];
      const sample = {
        phase: label,
        seconds: Number(elapsed.toFixed(2)),
        mainThreadCpuPct: Number(((task / elapsed) * 100).toFixed(3)),
        mainThreadScriptPct: Number(((script / elapsed) * 100).toFixed(3)),
        rendererCpuPct: Number(((cpu / elapsed) * 100).toFixed(3)),
        rafs: delta('rafs'),
        intervalTicks: delta('intervalTicks'),
        intervalsCreated: delta('intervalsCreated'),
        timeoutsCreated: delta('timeoutsCreated'),
        longTasks: delta('longTasks'),
        longTaskMs: Number(delta('longTaskMs').toFixed(1)),
        fetches: delta('fetches'),
        swEvents: delta('swEvents'),
        resourceEntries: delta('resourceEntries'),
      };
      return sample;
    };

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.__airhorn')) break;
      await sleep(100);
    }
    // Let the load-time work (sample fetch/decode, SW install) finish: that is
    // startup, not idle, and counting it would make the budget meaningless.
    await sleep(2500);

    const report = { phases: [], audio: {}, notes: [] };

    // ------------------------------------------------------------------ A
    report.phases.push(await windowOf('A pristine idle', seconds * 1000));
    report.audio.beforeGesture = await evaluate(`({
      hasAudioContext: window.__airhorn ? window.__airhorn.hasAudioContext() : null,
      contextState: window.__airhornContext ? window.__airhornContext.state : null,
    })`);

    // ------------------------------------------------------------------ B
    // A real gesture, so the browser resumes the graph exactly as it would for a
    // user: one Space press, then wait for the sound to finish.
    await evaluate(`document.querySelector('.horn').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
    await sleep(400);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    for (let i = 0; i < 60; i++) {
      if (await evaluate('window.__airhorn.isPlaying() === false')) break;
      await sleep(100);
    }
    report.audio.afterBlast = await evaluate(`({
      playing: window.__airhorn.isPlaying(),
      fallback: window.__airhorn.usingFallback,
      contextState: window.__airhornContext ? window.__airhornContext.state : null,
      samplerate: window.__airhornContext ? window.__airhornContext.sampleRate : null,
    })`);
    report.phases.push(await windowOf('B idle after a blast (context left running)', seconds * 1000));

    // ------------------------------------------------------------------ C
    const suspended = await evaluate(`(async () => {
      // The measurement that decides whether B is worth fixing: the same silent
      // page with the audio graph suspended.
      const ctx = window.__airhornContext || null;
      if (!ctx) return { suspended: false, reason: 'the app never touched an AudioContext' };
      if (ctx.state === 'suspended') return { suspended: true, already: true, state: ctx.state };
      await ctx.suspend();
      return { suspended: true, state: ctx.state };
    })()`);
    report.audio.suspendExperiment = suspended;
    report.phases.push(await windowOf('C idle with the context suspended', seconds * 1000));

    // ------------------------------------------------------------------ D
    // A looping horn, then the installed app goes to the background.
    await evaluate(`(async () => {
      const ctx = window.__airhornContext || null;
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    })()`);
    await evaluate(`window.__airhorn.start({ loop: true })`);
    await sleep(400);
    const beforeHide = await evaluate(`({ playing: window.__airhorn.isPlaying(), pressed: document.querySelector('.horn').getAttribute('aria-pressed') })`);
    const hidden = await evaluate(`(() => {
      // Stand-in for the platform hiding the tab: the app's listeners read
      // document.hidden/visibilityState, and headless cannot background itself.
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    // The app's visibilitychange handler stops the horn, and a sample source
    // rings out rather than cutting dead (by design), so wait for silence and
    // report how long it took: "playing" read 500ms after the hide is a race, not
    // a defect.
    const hideStartedAt = Date.now();
    let stopLatencyMs = null;
    for (let i = 0; i < 40; i++) {
      const state = await evaluate('window.__airhorn.isPlaying()');
      if (state === false) { stopLatencyMs = Date.now() - hideStartedAt; break; }
      await sleep(50);
    }
    report.hiddenStopLatencyMs = stopLatencyMs;
    const afterHide = await evaluate(`({
      playing: window.__airhorn.isPlaying(),
      pressed: document.querySelector('.horn').getAttribute('aria-pressed'),
      contextState: window.__airhornContext ? window.__airhornContext.state : null,
      hidden: document.hidden,
    })`);
    const postStopState = await evaluate(`({
      playing: window.__airhorn.isPlaying(),
      pressed: document.querySelector('.horn').getAttribute('aria-pressed'),
      contextState: window.__airhornContext ? window.__airhornContext.state : null,
    })`);
    report.hidden = { beforeHide, afterHide, postStopState, standInApplied: hidden, stopLatencyMs };
    report.phases.push(await windowOf('D idle while hidden (after a looping horn)', hiddenSeconds * 1000));

    // ------------------------------------------------------------------ E
    // Back to the foreground, as the installed app does when the user returns.
    const foregrounded = await evaluate(`(() => {
      delete Document.prototype.visibilityState;
      delete Document.prototype.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      return { hidden: document.hidden, visibility: document.visibilityState };
    })()`);
    // The return path must be usable: a real press still sounds the horn.
    await evaluate(`document.querySelector('.horn').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
    let pressSounded = false;
    for (let i = 0; i < 30; i++) {
      if (await evaluate('window.__airhorn.isPlaying() === true')) { pressSounded = true; break; }
      await sleep(100);
    }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    for (let i = 0; i < 40; i++) {
      if (await evaluate('window.__airhorn.isPlaying() === false')) break;
      await sleep(100);
    }
    report.foregrounded = { ...foregrounded, pressSounded };
    report.phases.push(await windowOf('E idle after returning to the foreground', hiddenSeconds * 1000));

    report.errors = (await counters()).errors;
    report.budgets = BUDGET;
    const byNameForCost = (name) => report.phases.find((p) => p.phase.startsWith(name));
    report.costOfRunningContext = {
      mainThreadPct: Number((byNameForCost('B').mainThreadCpuPct - byNameForCost('C').mainThreadCpuPct).toFixed(3)),
      rendererPct: Number((byNameForCost('B').rendererCpuPct - byNameForCost('C').rendererCpuPct).toFixed(3)),
      note: 'B minus C: what a running-but-silent AudioContext costs on this box, in % of one core',
    };

    const byName = (name) => report.phases.find((p) => p.phase.startsWith(name));
    const verdicts = [
      {
        what: 'A pristine idle: nothing scheduled and no network, main thread < budget',
        pass: byName('A').mainThreadCpuPct < BUDGET.pristineIdle && byName('A').rafs === 0
          && byName('A').intervalTicks === 0 && byName('A').fetches === 0 && byName('A').resourceEntries === 0,
        measured: `${byName('A').mainThreadCpuPct}% main thread, renderer ${byName('A').rendererCpuPct}%, ` +
          `${byName('A').rafs} rAF, ${byName('A').intervalTicks} interval ticks, ${byName('A').fetches} fetches, ` +
          `${byName('A').resourceEntries} resource entries`,
      },
      {
        what: 'B after a blast: silent page still under budget',
        pass: byName('B').mainThreadCpuPct < BUDGET.afterBlastIdle && byName('B').intervalTicks === 0,
        measured: `${byName('B').mainThreadCpuPct}% main thread, renderer ${byName('B').rendererCpuPct}%`,
      },
      {
        what: 'E foregrounded: the return path is quiet and the horn still works',
        pass: report.foregrounded.pressSounded === true
          && report.foregrounded.hidden === false
          && byName('E').mainThreadCpuPct < BUDGET.hidden,
        measured: `press sounded=${report.foregrounded.pressSounded}, hidden=${report.foregrounded.hidden}, ` +
          `${byName('E').mainThreadCpuPct}% main thread`,
      },
      {
        what: 'D hidden: a looping horn stops (within 2s), and the hidden page is quiet',
        pass: report.hiddenStopLatencyMs !== null
          && report.hidden.afterHide.pressed === 'false'
          && byName('D').mainThreadCpuPct < BUDGET.hidden,
        measured: `stopped after ${report.hiddenStopLatencyMs === null ? 'NEVER (>2s)' : report.hiddenStopLatencyMs + 'ms'}, ` +
          `pressed=${report.hidden.afterHide.pressed}, ctx=${report.hidden.afterHide.contextState}, ` +
          `${byName('D').mainThreadCpuPct}% main thread`,
      },
    ];
    report.verdicts = verdicts;

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('phase                              secs   main%  script%  renderer%   rAF  intTicks  timeouts  longTasks  fetches  swEvents');
      for (const phase of report.phases) {
        console.log(
          `${phase.phase.padEnd(34)} ${String(phase.seconds).padStart(5)} ${String(phase.mainThreadCpuPct).padStart(7)} ` +
          `${String(phase.mainThreadScriptPct).padStart(8)} ${String(phase.rendererCpuPct).padStart(10)} ` +
          `${String(phase.rafs).padStart(5)} ${String(phase.intervalTicks).padStart(9)} ${String(phase.timeoutsCreated).padStart(9)} ` +
          `${String(phase.longTasks).padStart(10)} ${String(phase.fetches).padStart(8)} ${String(phase.swEvents).padStart(9)}`
        );
      }
      console.log('');
      console.log(`audio context suspend experiment: ${JSON.stringify(report.audio.suspendExperiment)}`);
      console.log(`cost of leaving the context running (B - C): ${JSON.stringify(report.costOfRunningContext)}`);
      console.log(`hidden: ${JSON.stringify(report.hidden)}`);
      console.log(`foregrounded: ${JSON.stringify(report.foregrounded)}`);
      if (report.errors.length) console.log(`page errors: ${JSON.stringify(report.errors)}`);
      console.log('');
      for (const verdict of verdicts) {
        console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${verdict.what} — ${verdict.measured}`);
      }
    }

    if (check) {
      const failed = verdicts.filter((v) => !v.pass);
      if (failed.length) {
        console.error(`idle-cost: ${failed.length} budget(s) missed`);
        process.exitCode = 1;
      }
    }
  } finally {
    try { browserLevel?.close(); } catch { /* already gone */ }
    if (page) await page.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('idle-cost failed:', err.message);
  process.exit(1);
});
