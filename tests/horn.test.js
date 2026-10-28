/*
 *  Unit tests for src/horn.js: primary sample path and Web Audio synthesized fallback.
 *  Run with: node tests/horn.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Horn } from '../src/horn.js';

class FakeAudioParam {
  value = 1;
  // Every scheduled value, in order: the synth voice contract (level, length,
  // pitch - airhorn-u7s) is asserted against these rather than against one
  // final value, which release automation overwrites.
  scheduled = [];
  // The time argument each call carried: without it the attack-time pin was
  // a tautology of the level assert - the ramp could end at 0.04 s or 0.14 s
  // and both passed (airhorn-n0sd).
  scheduledTimes = [];
  setValueAtTime(val, time = 0) { this.value = val; this.scheduled.push(val); this.scheduledTimes.push(time); }
  exponentialRampToValueAtTime(val, time = 0) { this.value = val; this.scheduled.push(val); this.scheduledTimes.push(time); }
  cancelScheduledValues() {}
  get peak() { return this.scheduled.length ? Math.max(...this.scheduled) : this.value; }
}

class FakeAudioNode {
  connect() {}
  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  frequency = new FakeAudioParam();
  started = false;
  stopped = false;
  stopTime = null;
  start() { this.started = true; }
  stop(time) { this.stopped = true; this.stopTime = time ?? null; }
}

class FakeBufferSourceNode extends EventTarget {
  buffer = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  started = false;
  stopped = false;
  onended = null;
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() {
    this.stopped = true;
    this.dispatchEvent(new Event('ended'));
    if (this.onended) this.onended();
  }
}

class FakeAudioContext {
  currentTime = 0;
  destination = new FakeAudioNode();
  sources = [];
  oscillators = [];
  gains = [];
  resumed = false;
  shouldFailDecode = false;

  async resume() {
    this.resumed = true;
  }

  createBufferSource() {
    const s = new FakeBufferSourceNode();
    this.sources.push(s);
    return s;
  }

  createGain() {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g;
  }

  createOscillator() {
    const o = new FakeOscillatorNode();
    this.oscillators.push(o);
    return o;
  }

  decodeAudioData(arrayBuffer, success, error) {
    if (this.shouldFailDecode) {
      const err = new Error('Audio decoding failed');
      if (error) error(err);
      return Promise.reject(err);
    }
    const buf = { duration: 1.5, length: 44100 * 1.5, sampleRate: 44100 };
    if (success) success(buf);
    return Promise.resolve(buf);
  }
}



test('plays sample when fetch and decode succeed', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(32)
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    assert.equal(horn.hasAudioContext(), true);
    assert.equal(horn.isPlaying(), false);

    const started = await horn.start({ loop: false });
    assert.equal(started, true);
    assert.equal(horn.usingFallback, false);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.sources[0].started, true);
    assert.equal(ctx.sources[0].loop, false);

    let stoppedCalled = false;
    horn.onstopped = () => { stoppedCalled = true; };

    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
    assert.equal(stoppedCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to synth when fetch returns 404', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({
    ok: false,
    status: 404
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    assert.equal(horn.hasAudioContext(), true);

    const started = await horn.start({ loop: false });
    assert.equal(started, true);
    assert.equal(horn.usingFallback, true);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.sources.length, 0);
    assert.equal(ctx.oscillators.length, 3);
    assert.ok(ctx.oscillators.every(o => o.type === 'triangle' && o.started));

    let stoppedCalled = false;
    horn.onstopped = () => { stoppedCalled = true; };

    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
    assert.equal(stoppedCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to synth when fetch throws network error', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => {
    throw new Error('Failed to fetch (offline / network error)');
  };

  try {
    const horn = new Horn({ audioContext: ctx });
    const started = await horn.start({ loop: false });
    assert.equal(started, true);
    assert.equal(horn.usingFallback, true);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.oscillators.length, 3);

    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to synth when decodeAudioData fails', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  ctx.shouldFailDecode = true;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(16)
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    const started = await horn.start({ loop: false });
    assert.equal(started, true);
    assert.equal(horn.usingFallback, true);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.oscillators.length, 3);

    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves loop semantics in sample mode', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(32)
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    await horn.start({ loop: true });

    assert.equal(ctx.sources[0].loop, true);
    assert.equal(ctx.sources[0].loopStart, 0.24);
    assert.equal(ctx.sources[0].loopEnd, 0.34);

    await horn.stop({ immediate: true });
    assert.equal(ctx.sources[0].loop, false);
    assert.equal(horn.isPlaying(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves loop semantics in synth mode', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({ ok: false, status: 500 });

  try {
    const horn = new Horn({ audioContext: ctx });
    await horn.start({ loop: true });

    assert.equal(horn.usingFallback, true);
    assert.equal(horn.isPlaying(), true);

    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('release-before-start race condition: stopping while fetch is pending does not leave unstoppable looping synth', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  let fetchReject;
  globalThis.fetch = () => new Promise((_, rej) => {
    fetchReject = rej;
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    const pendingStart = horn.start({ loop: true });

    // Release arrives while fetch is still in flight
    await horn.stop({ immediate: false });

    // Now fetch fails with 404
    fetchReject(new Error('HTTP 404'));
    await pendingStart;

    // Assert loop was cleared and single blast scheduled: all 3 oscillators have scheduled stop
    assert.equal(ctx.oscillators.length, 3);
    assert.ok(ctx.oscillators.every(o => o.stopped), 'single-blast stop scheduled on oscillators, loop was cleared');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale start resolving >1000ms after release is discarded without playing blast', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  let fetchReject;
  globalThis.fetch = () => new Promise((_, rej) => {
    fetchReject = rej;
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    const pendingStart = horn.start({ loop: true });

    // Release arrives while fetch is in flight
    await horn.stop({ immediate: false });

    // Simulate >1000ms delay on slow network before fetch rejects
    await new Promise(r => setTimeout(r, 1050));
    fetchReject(new Error('HTTP 404 (slow lie-fi failure)'));
    const result = await pendingStart;

    // Discarded as stale start; no blast started
    assert.equal(result, false);
    assert.equal(horn.isPlaying(), false);
    assert.equal(ctx.oscillators.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale one-shot start resolving >1500ms after gesture start is discarded without playing blast', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  let fetchReject;
  globalThis.fetch = () => new Promise((_, rej) => {
    fetchReject = rej;
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    // One-shot start (loop: false, stop() is never called)
    const pendingStart = horn.start({ loop: false });

    // Simulate >1500ms delay on stalled network before fetch rejects
    await new Promise(r => setTimeout(r, 1550));
    fetchReject(new Error('HTTP 404 (slow lie-fi failure on one-shot)'));
    const result = await pendingStart;

    // Discarded as stale gesture (>1500ms since startOp.startTime); no blast started
    assert.equal(result, false);
    assert.equal(horn.isPlaying(), false);
    assert.equal(ctx.oscillators.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timely one-shot start resolving <1500ms after gesture start plays blast', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  let fetchReject;
  globalThis.fetch = () => new Promise((_, rej) => {
    fetchReject = rej;
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    // One-shot start (loop: false)
    const pendingStart = horn.start({ loop: false });

    // Resolves promptly within 50ms (<1500ms threshold)
    await new Promise(r => setTimeout(r, 50));
    fetchReject(new Error('HTTP 404 (fast response)'));
    const result = await pendingStart;

    // Timely start succeeds and starts fallback synth blast
    assert.equal(result, true);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.oscillators.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('immediate stop while fetch is pending cancels start completely', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  let fetchReject;
  globalThis.fetch = () => new Promise((_, rej) => {
    fetchReject = rej;
  });

  try {
    const horn = new Horn({ audioContext: ctx });
    const pendingStart = horn.start({ loop: true });

    // Immediate stop arrives while fetch is still in flight (e.g. stop_horn tool)
    await horn.stop({ immediate: true });

    fetchReject(new Error('HTTP 404'));
    const result = await pendingStart;

    // Start was completely cancelled
    assert.equal(result, false);
    assert.equal(horn.isPlaying(), false);
    assert.equal(ctx.oscillators.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('short non-immediate tap does not truncate synth blast prematurely', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({ ok: false, status: 500 });

  try {
    const horn = new Horn({ audioContext: ctx });
    // UI gesture: pointerdown starts loop: true
    await horn.start({ loop: true });

    assert.equal(horn.usingFallback, true);
    assert.equal(horn.isPlaying(), true);

    // 60ms later: pointerup releases (immediate: false)
    await horn.stop({ immediate: false });

    // Synth must NOT be truncated to 250ms release; remaining blast duration must ring out
    assert.equal(horn.isPlaying(), true, 'Synth should ring out naturally and not be truncated after 60ms tap');
    assert.ok(ctx.oscillators.every(o => o.stopped), 'Oscillators have scheduled stop time for full blast duration');

    // Immediate stop on the other hand cuts it off immediately
    await horn.stop({ immediate: true });
    assert.equal(horn.isPlaying(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gracefully handles unavailable AudioContext', async () => {
  const horn = new Horn({ audioContext: null });
  assert.equal(horn.hasAudioContext(), false);
  const started = await horn.start();
  assert.equal(started, false);
  assert.equal(horn.isPlaying(), false);
});

test('browser verification: forced mp3 404 still activates synth, sounds audibly, and toggles UI', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { launchBrowser } = await import('./support/browser.mjs');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run vite build first.');
  }

  let server = null;
  let browser = null;
  let ws = null;

  try {
    let delayMp3 = 0;
    server = http.createServer(async (req, res) => {
      const reqUrl = req.url.split('?')[0];
      if (reqUrl === '/sounds/airhorn.mp3') {
        if (delayMp3 > 0) {
          await new Promise(r => setTimeout(r, delayMp3));
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found (forced fallback simulation)');
        return;
      }
      if (reqUrl === '/src/horn.js') {
        // The page imports the REAL module for the device-free render below, the
        // same way tools/audio-parity.mjs measures the fallback: the bundle in
        // dist/ is built from this file, and an OfflineAudioContext render of it
        // involves no audio device, no pump and no clock to wait on.
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        fs.createReadStream(path.join(__dirname, '../src/horn.js')).pipe(res);
        return;
      }
      if (reqUrl === '/sw.js') {
        // Return a benign no-op service worker that does not cache or intercept mp3
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Service-Worker-Allowed': '/'
        });
        res.end('// No-op SW for test\nself.addEventListener("install", () => self.skipWaiting());\nself.addEventListener("activate", () => self.clients.claim());');
        return;
      }

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

      let filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
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

    // 20000, not 10000: the launch bound is a kill window, not a budget. This
    // box starts Chrome from a cold profile in 1-2 s when idle and took >10 s at
    // load 5 on 2 cores, and every other suite's browser already allows 15-20 s
    // (airhorn-ujwr).
    browser = await launchBrowser({ autoplay: true, label: 'horn', timeoutMs: 20000, discoveryMs: 40000 });

    const pageWsUrl = browser.pageWsUrl;
    ws = new WebSocket(pageWsUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket onopen timeout')), 5000);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
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
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await send('Page.enable');
    await send('Runtime.enable');

    // The app's own schedule, recorded from the REAL page: every AudioParam ramp
    // and every oscillator start/stop, in audio-clock seconds. It is exact and
    // jitter-free, which is what answers "was the blast cut short" without
    // sampling anything (review of 20f9120).
    //
    // There is deliberately NO live level reading any more. This VM has no audio
    // device (/dev/snd is absent), so headless Chromium renders the graph from a
    // timer-driven null sink and the audio clock runs at a fraction of real time -
    // measured 0.073 s of audio in ~1.4 s wall (~19x) and 0.163 s in 1.2 s (~7x) -
    // while the horn's own idle release (airhorn-1umb, 300 ms after the last
    // sound) can suspend the context mid-attack and freeze the clock for good. Any
    // assertion that waits for a live context to render a given amount of audio
    // inside a wall-clock bound is a statement about the host's CPU, and it is how
    // a working horn came to fail on "peak 0" (airhorn-ujwr). Audio production is
    // asserted offline instead - see Part A(a) - where no device is involved.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__audioProbe = {
          oscStarts: 0,
          sched: [],
          reset() {
            this.oscStarts = 0;
            this.sched = [];
          }
        };
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          // The app's own schedule, in audio-clock seconds.
          const paramSet = AudioParam.prototype.setValueAtTime;
          const paramRamp = AudioParam.prototype.exponentialRampToValueAtTime;
          AudioParam.prototype.setValueAtTime = function (value, time) {
            window.__audioProbe.sched.push({ op: 'set', value, time });
            return paramSet.call(this, value, time);
          };
          AudioParam.prototype.exponentialRampToValueAtTime = function (value, time) {
            window.__audioProbe.sched.push({ op: 'ramp', value, time });
            return paramRamp.call(this, value, time);
          };
          const origCreateOsc = AC.prototype.createOscillator;
          AC.prototype.createOscillator = function (...args) {
            const osc = origCreateOsc.apply(this, args);
            const origStart = osc.start.bind(osc);
            const origStop = osc.stop.bind(osc);
            osc.start = function (...startArgs) {
              window.__audioProbe.oscStarts++;
              window.__audioProbe.sched.push({ op: 'osc.start', t: startArgs[0] });
              return origStart(...startArgs);
            };
            osc.stop = function (...stopArgs) {
              window.__audioProbe.sched.push({ op: 'osc.stop', t: stopArgs[0] });
              return origStop(...stopArgs);
            };
            return osc;
          };
        }
      `
    });

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 600));

    // A press has to be a TRUSTED input event, not a dispatched PointerEvent
    // (airhorn-ujwr). A synthetic event grants no user activation, so
    // navigator.userActivation.hasBeenActive stays false and the horn takes its
    // UNACTIVATED resume bound - 100 ms (airhorn-dxug) - which a loaded renderer
    // routinely exceeds. The press is then refused, no oscillator is ever
    // created, and the suite reports silence from an app that is working: that
    // is the other half of how this check went red. Input.dispatchMouseEvent
    // produces real pointerdown/pointerup events and sets user activation, i.e.
    // exactly the path a user's click takes.
    const hornBox = await send('Runtime.evaluate', {
      expression: `(() => {
        const rect = document.querySelector('.horn').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width };
      })()`,
      returnByValue: true
    });
    assert.ok(hornBox.result.value.width > 0, 'the horn control must be laid out to receive a press');
    const press = (type) => send('Input.dispatchMouseEvent', {
      type,
      x: hornBox.result.value.x,
      y: hornBox.result.value.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
      pointerType: 'mouse'
    });
    // A retry needs the button genuinely UP first: a mousePressed that arrives while
    // it is still down is not a new press, so no fresh pointerdown reaches the app -
    // and the app starts a hold on pointerdown (src/main.js). Release AWAY from the
    // control at (2, 2): a release on the control also produces a click, and click is
    // the app's own one-shot start path, so a retry would be reading a blast it did
    // not ask for (airhorn-uhdv review).
    const releaseElsewhere = () => send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse'
    });

    // Part A(a): does the fallback VOICE produce audio? This is the claim the old
    // live analyser was trying to make, and it is made here device-free: the REAL
    // module (src/horn.js, the file dist/ is built from) is driven into an
    // OfflineAudioContext, which renders a fixed number of samples with no audio
    // device, no null sink, no pump and no clock to wait on, and the rendered
    // buffer is then read. A silenced fallback - level 0, oscillators never
    // started, master gain never connected - renders silence and fails here; a
    // host with no audio device cannot fail it, because nothing on this path
    // touches one. (tools/audio-parity.mjs measures the same render for parity
    // with the sample; this asserts only that it is audible.)
    const rendered = await send('Runtime.evaluate', {
      expression: `(async () => {
        const { Horn } = await import('/src/horn.js');
        const SR = 44100;
        const ctx = new OfflineAudioContext(1, Math.round(SR * 1.2), SR);
        // An offline port reports 'suspended' until startRendering(), and
        // Horn.start() refuses to schedule into a suspended context on purpose
        // (airhorn-x4l). In a tab the press itself resumes it, so the graph is a
        // running one: only 'state' is overridden, every method bound to the real
        // port (Web Audio refuses a foreign receiver). Same shim as
        // tools/audio-parity.mjs.
        const runningPort = new Proxy(ctx, {
          get(target, key) {
            if (key === 'state') return 'running';
            if (key === 'resume') return () => Promise.resolve();
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        // audioSrc is the URL the server above answers with 404, so this takes the
        // production fallback path rather than the sample path.
        const horn = new Horn({ audioContext: runningPort });
        const started = await horn.start({ loop: false });
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        let peak = 0;
        let audible = 0;
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
          if (abs > 0.01) audible += 1;
        }
        return {
          started,
          usingFallback: horn.usingFallback === true,
          peak,
          audibleS: audible / SR,
          durationS: data.length / SR
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const render = rendered.result.value;
    assert.equal(render.started, true, 'the offline render must start; a refused context measures silence, not the horn');
    assert.equal(render.usingFallback, true, 'the forced 404 must take the synthesised fallback path');
    assert.ok(
      render.peak > 0.2,
      `the fallback voice must render audibly, with no audio device involved; peak ${render.peak} ` +
        `over ${render.durationS.toFixed(2)}s (audible ${render.audibleS.toFixed(3)}s)`,
    );
    assert.ok(
      render.audibleS > 0.5,
      `the rendered blast must last about the sample's ~0.8s; audible ${render.audibleS.toFixed(3)}s`,
    );

    // Part A(b): does the LIVE path work in the real page? The pressed state, the
    // fallback engaging on the forced 404 (silence is the failure this replaces),
    // start() resolving, and the blast the app schedules on the audio clock.
    //
    // A press the app honestly REFUSES is retried like a user retries it: resuming
    // the audio graph is bounded by the app (airhorn-dxug) and a starved renderer
    // can miss that bound, which is a slow host, not a horn that does not play.
    // Three presses, each with a modest bound; if none of them sounds, the
    // assertions below still fail.
    await send('Runtime.evaluate', { expression: 'window.__audioProbe.reset()' });
    let playingWhileHeld = false;
    for (let attempt = 0; attempt < 3 && !playingWhileHeld; attempt += 1) {
      await press('mousePressed');
      for (let i = 0; i < 50; i += 1) {
        const state = await send('Runtime.evaluate', {
          expression: '!!(window.__airhorn && window.__airhorn.isPlaying())',
          returnByValue: true
        });
        if (state.result.value) {
          playingWhileHeld = true;
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!playingWhileHeld) await releaseElsewhere();
    }

    const held = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        return {
          playing: !!(window.__airhorn && window.__airhorn.isPlaying()),
          usingFallback: window.__airhorn ? window.__airhorn.usingFallback === true : null,
          horning: horn.classList.contains('horning'),
          pressed: horn.getAttribute('aria-pressed'),
          oscStarts: window.__audioProbe.oscStarts
        };
      })()`,
      returnByValue: true
    });
    await press('mouseReleased');

    // Wait for the blast to complete and the UI to settle
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `!window.__airhorn || !window.__airhorn.isPlaying()`,
        returnByValue: true
      });
      if (res.result.value) break;
      await new Promise(r => setTimeout(r, 100));
    }

    const settledResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        return {
          horning: horn.classList.contains('horning'),
          pressed: horn.getAttribute('aria-pressed'),
          classes: horn.className,
          airhornExists: !!window.__airhorn,
          isPlaying: window.__airhorn ? window.__airhorn.isPlaying() : null,
          isLooping: window.__airhorn ? window.__airhorn.isLooping() : null,
          oscStarts: window.__audioProbe.oscStarts,
          sched: window.__audioProbe.sched
        };
      })()`,
      returnByValue: true
    });
    const settled = settledResult.result.value;

    assert.equal(playingWhileHeld, true, `the horn must sound on a press in the live page; last state ${JSON.stringify(held.result.value)}`);
    assert.equal(held.result.value.horning, true, 'a held press must show the pressed state');
    assert.equal(held.result.value.pressed, 'true', 'a held press must set aria-pressed');
    // The forced 404 must reach the SYNTH, not a quiet page (airhorn-ujwr).
    assert.equal(held.result.value.usingFallback, true, 'the forced 404 must engage the synthesised fallback, not fall silent');
    assert.ok(settled.oscStarts >= 3, `Expected at least 3 oscillators to start, got ${settled.oscStarts}`);

    assert.equal(settled.horning, false, 'UI should exit horning state after blast finishes');
    assert.equal(settled.pressed, 'false', 'aria-pressed should revert to false');
    assert.equal(settled.isPlaying, false, 'Audio should finish playing');

    // The blast itself, in audio-clock seconds: 0.14 s attack (airhorn-n0sd) and
    // a release that leaves the 0.9 s blast scheduled instead of cutting it at
    // whatever moment the pointerup arrived.
    const synthStarts = settled.sched.filter((e) => e.op === 'osc.start' && typeof e.t === 'number');
    const attackRamps = settled.sched.filter((e) => e.op === 'ramp' && typeof e.value === 'number' && e.value >= 0.5);
    const stopTimes = settled.sched.filter((e) => e.op === 'osc.stop' && typeof e.t === 'number').map((e) => e.t);
    assert.ok(synthStarts.length >= 3, `Expected >=3 scheduled oscillator starts, got ${synthStarts.length}`);
    const synthStart = synthStarts[0].t;
    assert.ok(attackRamps.length > 0, 'Fallback synth must schedule an attack ramp to its loudness');
    assert.ok(
      Math.abs(attackRamps[0].time - synthStart - 0.14) < 0.02,
      `Attack must reach full level 0.14s after the start, not step there; ramp ended ` +
        `${(attackRamps[0].time - synthStart).toFixed(3)}s after the start`,
    );
    assert.ok(stopTimes.length > 0, 'Fallback synth must schedule the blast\'s end on the audio clock');
    assert.ok(
      Math.max(...stopTimes) - synthStart >= 0.7,
      `Releasing must not truncate the blast: last scheduled stop is ` +
        `${(Math.max(...stopTimes) - synthStart).toFixed(3)}s after the synth started, expected >= 0.7s`,
    );

    // Part B: Release-before-start race condition with delayed 404. The press is
    // trusted for the same reason as Part A: a synthetic event gets no user
    // activation, so a loaded renderer can refuse the press before the race is
    // ever exercised and this case would pass vacuously.
    delayMp3 = 250;
    await press('mousePressed');
    await new Promise(r => setTimeout(r, 50));
    await press('mouseReleased');

    // Wait until start resolves or sound starts playing
    for (let i = 0; i < 20; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `window.__airhorn && window.__airhorn.isPlaying()`,
        returnByValue: true
      });
      if (res.result.value) break;
      await new Promise(r => setTimeout(r, 50));
    }

    // Now wait until playback finishes and blast settles
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `!window.__airhorn || (!window.__airhorn.isPlaying() && !document.querySelector('.horn').classList.contains('horning'))`,
        returnByValue: true
      });
      if (res.result.value) break;
      await new Promise(r => setTimeout(r, 100));
    }

    const raceResult = await send('Runtime.evaluate', {
      expression: `(() => {
        return {
          isPlaying: window.__airhorn?.isPlaying(),
          isLooping: window.__airhorn?.isLooping(),
          horning: document.querySelector('.horn')?.classList.contains('horning')
        };
      })()`,
      returnByValue: true
    });

    assert.equal(raceResult.result.value.isPlaying, false, 'Quick release before mp3 404 finishes should not leave looping sound');
    assert.equal(raceResult.result.value.isLooping, false, 'isLooping must be false');
    assert.equal(raceResult.result.value.horning, false, 'horning must be false');

    assert.deepEqual(consoleErrors, [], 'No uncaught exceptions or errors on fallback playback');
  } finally {
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (browser) {
      await browser.close();
    }
    if (server) {
      server.close();
    }
  }
});

/*
 * Stuck-honk regression guard (airhorn-slmt): a pointer hold must be
 * releasable by EVERY path the platform gives, and a non-primary press must
 * never start one. Four defects made the horn sound forever:
 *   1. pointerdown had no e.button guard, so a RIGHT click started a loop
 *      whose release is a contextmenu, not a pointerup;
 *   2. window blur only retired KEYBOARD holds, so a pointer hold survived
 *      alt-tab and its pointerup went to the newly focused window;
 *   3. no contextmenu listener stopped the hold;
 *   4. pointerup/pointercancel were bound to documentElement, missing
 *      releases delivered at window level.
 * Each case below fails on the old code and passes on the fix.
 */
test('browser verification: right-click never starts the horn, and blur/contextmenu/window-level release retire a pointer hold (airhorn-slmt)', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { launchBrowser } = await import('./support/browser.mjs');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run vite build first.');
  }

  let server = null;
  let browser = null;
  let ws = null;

  try {
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
    server = http.createServer((req, res) => {
      const reqUrl = req.url.split('?')[0];
      if (reqUrl === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
        res.end('// No-op SW for test\nself.addEventListener("install", () => self.skipWaiting());\nself.addEventListener("activate", () => self.clients.claim());');
        return;
      }
      const filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Service-Worker-Allowed': '/' });
      fs.createReadStream(filePath).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    browser = await launchBrowser({ autoplay: true, label: 'horn-stuck', timeoutMs: 20000, discoveryMs: 40000 });
    ws = new WebSocket(browser.pageWsUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket onopen timeout')), 5000);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
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
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // Case 0 has to PROVE the retry delivered a fresh press, so record every
    // pointerdown/pointerup from document start in the capture phase (nothing can
    // swallow one first), with whether it landed on the control, and keep the
    // AudioContext so the first attempt can be forced into the app's honest
    // refusal path (airhorn-uhdv review).
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pointerEvents = [];
        window.__ctxs = [];
        const record = (type) => (e) => {
          window.__pointerEvents.push({
            type,
            onHorn: !!(e.target && e.target.closest && e.target.closest('.horn'))
          });
        };
        document.addEventListener('pointerdown', record('down'), true);
        document.addEventListener('pointerup', record('up'), true);
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const wrap = function (...args) {
            const ctx = new AC(...args);
            window.__ctxs.push(ctx);
            return ctx;
          };
          wrap.prototype = AC.prototype;
          window.AudioContext = wrap;
          window.webkitAudioContext = wrap;
        }
      `
    });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    const evaluate = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const state = () => evaluate(`(() => ({
      booted: !!window.__airhorn,
      playing: !!window.__airhorn?.isPlaying(),
      horning: document.querySelector('.horn')?.classList.contains('horning') ?? null,
      pressed: document.querySelector('.horn')?.getAttribute('aria-pressed') ?? null
    }))()`);
    // No fixed sleeps for state transitions: poll until the predicate holds.
    const waitForOrNull = async (predicate, tries = 50) => {
      for (let i = 0; i < tries; i++) {
        const s = await state();
        if (predicate(s)) return s;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    };
    const waitFor = async (predicate, what, tries = 50) => {
      const s = await waitForOrNull(predicate, tries);
      if (s) return s;
      throw new Error(`Timed out waiting for ${what}; last state ${JSON.stringify(await state())}${await audioReport()}`);
    };
    // Why a press produced no sound, in the page's own terms - the numbers a
    // refusal is made of (airhorn-dxug: a resume that did not land inside the
    // activated bound is refused and the pressed state retracted).
    const audioReport = async () => {
      const info = await evaluate(`(() => {
        const probe = window.__audioProbe;
        return {
          activated: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
          contexts: probe ? probe.ctxs.map((c) => [c.state, +c.currentTime.toFixed(3)]) : null,
          oscStarts: probe ? probe.oscStarts : null,
          status: document.getElementById('app-status')?.textContent || ''
        };
      })()`);
      return `, audio ${JSON.stringify(info)}`;
    };
    // A press on a starved renderer can be REFUSED by the app on purpose: it
    // resumes the audio graph and, if that has not landed inside its activated
    // bound (airhorn-dxug), it retracts the pressed state and offers a tap
    // instead of claiming a horn nobody can hear. A user taps again; so does the
    // test - up to 3 times - and every case below then runs on a press that
    // really produced a sound. If no attempt starts a blast the final waitFor
    // still fails, so this cannot hide a horn that does not play.
    const pressUntilSounding = async (what) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await pressPrimary();
        const sounding = await waitForOrNull((s) => s.playing, 20);
        if (sounding) return sounding;
        // The button must be genuinely UP before the next press: the app starts a
        // hold on pointerdown, and a press that arrives while the button is still
        // down is not a new one - so a retry with no release between the two cannot
        // work, which is precisely the case it exists for. Away from the control,
        // where the click cannot start a blast of its own (airhorn-uhdv review).
        await releaseMouseElsewhere();
      }
      return waitFor((s) => s.playing, what);
    };

    await waitFor(s => s.booted, 'boot');

    // The presses below are TRUSTED input events, not dispatched PointerEvents
    // (airhorn-ujwr). A synthetic event grants no user activation, so the horn
    // takes its unactivated resume bound - 100 ms, airhorn-dxug - which a loaded
    // renderer exceeds: the press is refused, no sound ever starts, and every
    // "wait for the horn to sound" case times out on a working app (that is how
    // this suite went red). The RELEASES stay synthetic on purpose: a release
    // delivered at window/documentElement level, and not to the control, is
    // exactly what these cases are about, and no trusted event can be delivered
    // "at window level" without also being a release of the control.
    const horn = (await send('Runtime.evaluate', {
      expression: `(() => {
        const rect = document.querySelector('.horn').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true
    })).result.value;
    const pressPrimary = () => send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: horn.x, y: horn.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse'
    });
    // Chrome still believes the button is down when a case releases the hold with
    // a synthetic event, so each case ends by releasing it for real - AT (2, 2),
    // where the press did not happen: the click then lands on the document rather
    // than on the control, so it cannot start a blast of its own. It runs after
    // the case's assertion, so it can never stand in for the release under test.
    const releaseMouseElsewhere = () => send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse'
    });

    // Case 0 (airhorn-uhdv P1): the retry must deliver a FRESH press, and that means
    // the refused one was RELEASED first, away from the control. The app starts a
    // hold on pointerdown, so a retry issued while the button is still down is not a
    // new press - and a retry is exactly what a refused press needs.
    //
    // Attempt 1 is forced into the app's honest refusal path: suspend the graph and
    // let the FIRST resume() answer later than the app's activated bound
    // (airhorn-dxug), so start() refuses and retracts the pressed state. The record
    // then has to show, in order: a down on the control, an up that did NOT land on
    // the control, and a second down - plus the retry actually sounding.
    await evaluate(`(async () => {
      window.__pointerEvents.length = 0;
      window.__resumeCalls = 0;
      const ctx = window.__ctxs[0];
      const realResume = ctx.resume.bind(ctx);
      await ctx.suspend();
      ctx.resume = () => {
        window.__resumeCalls += 1;
        // Only the first call is slow - the press that gets refused. Every later one
        // is the real thing, so the retry can actually play.
        return window.__resumeCalls === 1
          ? new Promise((resolve) => setTimeout(() => resolve(realResume()), 2500))
          : realResume();
      };
      return true;
    })()`);
    const retried = await pressUntilSounding('horn to sound on the retry after a refused press');
    const retryRecord = await evaluate(`({
      playing: !!(window.__airhorn && window.__airhorn.isPlaying()),
      events: window.__pointerEvents,
      resumeCalls: window.__resumeCalls
    })`);
    assert.ok(retried.playing, 'the retry must produce sound after a refused press');
    const downs = retryRecord.events.filter((e) => e.type === 'down');
    assert.ok(
      downs.length >= 2,
      `the retry must deliver a second pointerdown, not press an already-held button; the page saw ${JSON.stringify(retryRecord.events)}`,
    );
    const between = retryRecord.events.slice(
      retryRecord.events.indexOf(downs[0]),
      retryRecord.events.indexOf(downs[1]),
    );
    assert.ok(
      between.some((e) => e.type === 'up'),
      `the refused press must be RELEASED before the retry presses again; events between the two downs: ${JSON.stringify(between)}`,
    );
    assert.ok(
      between.filter((e) => e.type === 'up').every((e) => e.onHorn === false),
      `the release between attempts must be away from the control, or its click starts a blast of its own; events between the two downs: ${JSON.stringify(between)}`,
    );
    assert.ok(
      retryRecord.resumeCalls >= 2,
      `the refused press must be retried (a second start/resume), not given up on; the page saw ${retryRecord.resumeCalls}`,
    );
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup')), true`);
    await waitFor(s => !s.playing && !s.horning, 'the retried hold to retire');
    await releaseMouseElsewhere();

    // Case 1: a RIGHT-click must not start the horn at all. Its release is a
    // contextmenu, so on the old code the loop it started never ended. This one
    // press stays synthetic: a trusted right press makes Chrome fire its own
    // contextmenu immediately, which on the old code would stop the loop before
    // the case could see it and the guard would pass vacuously. The `horning`
    // assertion is what carries it here - start() lights the pressed state
    // synchronously, before any audio resolves, so a missing `button !== 0`
    // guard shows up whether or not a device-less renderer ever plays the sound.
    await evaluate(`document.querySelector('.horn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 })), true`);
    await evaluate(`document.querySelector('.horn').dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })), true`);
    // Give a wrongly-started loop time to prove it is playing (fetch + decode
    // of the sample), rather than reading state before it could start.
    await new Promise(r => setTimeout(r, 800));
    const afterRightClick = await state();
    assert.equal(afterRightClick.playing, false, 'a right-click pointerdown must not start the horn');
    assert.equal(afterRightClick.horning, false, 'a right-click must not light the pressed state');
    assert.equal(afterRightClick.pressed, 'false', 'aria-pressed must stay false after a right-click');

    // Case 2: a pointer hold must be retired when the WINDOW loses focus -
    // its pointerup is then delivered to whatever got focus, not to the page.
    await pressUntilSounding('horn to sound after primary press');
    await evaluate(`window.dispatchEvent(new Event('blur')), true`);
    const afterBlur = await waitFor(s => !s.playing && !s.horning, 'horn to stop on window blur');
    assert.equal(afterBlur.playing, false, 'window blur must release a pointer hold');
    assert.equal(afterBlur.horning, false, 'window blur must clear the pressed state');
    await releaseMouseElsewhere();

    // Case 3: a contextmenu mid-hold (long-press menu, or the release half of
    // any secondary gesture) must stop the horn.
    await pressUntilSounding('horn to sound for the contextmenu case');
    await evaluate(`document.querySelector('.horn').dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })), true`);
    const afterContextmenu = await waitFor(s => !s.playing && !s.horning, 'horn to stop on contextmenu');
    assert.equal(afterContextmenu.playing, false, 'contextmenu must release a pointer hold');
    await releaseMouseElsewhere();

    // Case 4: a release delivered at WINDOW level must end the hold. Bound to
    // documentElement, the listener never saw it.
    await pressUntilSounding('horn to sound for the window-level pointerup case');
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup')), true`);
    const afterWindowPointerup = await waitFor(s => !s.playing && !s.horning, 'horn to stop on window-level pointerup');
    assert.equal(afterWindowPointerup.playing, false, 'a window-level pointerup must release the hold');
    await releaseMouseElsewhere();

    // Case 5: same for pointercancel at window level.
    await pressUntilSounding('horn to sound for the window-level pointercancel case');
    await evaluate(`window.dispatchEvent(new PointerEvent('pointercancel')), true`);
    const afterWindowPointercancel = await waitFor(s => !s.playing && !s.horning, 'horn to stop on window-level pointercancel');
    assert.equal(afterWindowPointercancel.playing, false, 'a window-level pointercancel must release the hold');
    await releaseMouseElsewhere();

    // Non-regression: a normal primary press + documentElement-bubbling
    // pointerup still behaves like a tap-hold (the release path every
    // existing suite drives).
    await pressUntilSounding('horn to sound for the ordinary release case');
    await evaluate(`document.documentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), true`);
    const afterOrdinaryRelease = await waitFor(s => !s.horning, 'horn to settle after an ordinary release');
    assert.equal(afterOrdinaryRelease.horning, false, 'an ordinary press/release still ends the hold');
    await releaseMouseElsewhere();

    assert.deepEqual(consoleErrors, [], 'No uncaught exceptions or console errors during the stuck-honk cases');
  } finally {
    if (ws) { try { ws.close(); } catch {} }
    if (browser) { await browser.close(); }
    if (server) { server.close(); }
  }
});

test('the fallback voice keeps the measured parity with the sample (airhorn-u7s)', async () => {
  // These five values are not style: they are what makes the synthesised blast
  // measure like the recording (pitch, loudness, length, attack, brightness).
  // tools/audio-parity.mjs is the evidence; this pin is the regression guard, so
  // a future tuning change cannot silently reopen the gap it closed.
  //   pitch    715/1441/2156 Hz - the sample's own partials (was 233/349/466)
  //   level    0.8 peak gain     - RMS -12.9 vs the sample's -14.0 dBFS (was 0.5)
  //   length   0.9 s scheduled   - 0.80 s audible vs the sample's 0.84 (was 1.2)
  //   attack   0.14 s            - the recording swells for ~180 ms (was 0.04)
  //   waveform triangle          - a sawtooth here measures 3.3 kHz centroid, 2.7x
  //                                the sample's 1.2 kHz; triangle lands at 1.5 kHz
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    const horn = new Horn({ audioContext: ctx });
    await horn.start({ loop: false });

    assert.equal(ctx.oscillators.length, 3);
    assert.deepEqual(
      ctx.oscillators.map((osc) => osc.type),
      ['triangle', 'triangle', 'triangle'],
      'the fallback must use the triangle voice measured in parity with the sample',
    );
    assert.deepEqual(
      ctx.oscillators.map((osc) => osc.frequency.scheduled[0]),
      [715, 1441, 2156],
      'the fallback must sound the sample\'s partials, not a 2.6-octave-lower chord',
    );

    const master = ctx.gains[0];
    assert.equal(master.gain.peak, 0.8, 'the fallback level is matched to the sample (-14 dBFS RMS)');
    assert.equal(master.gain.scheduled[1], 0.8, 'the attack ramp must reach the matched level');
    // Attack: the envelope reaches full level 0.14 s in, not 0.04 s - pinned
    // through the ramp's TIME, which the fake now records (airhorn-n0sd; the
    // previous includes() assert was a tautology of scheduled[1] === 0.8).
    const attackIdx = master.gain.scheduled.indexOf(0.8);
    assert.ok(attackIdx > 0, 'the attack must ramp to the level, not start at it');
    assert.equal(master.gain.scheduledTimes[attackIdx], 0.14, 'the attack must take the recording\'s 0.14 s swell, not a hard 40 ms step');

    for (const osc of ctx.oscillators) {
      assert.equal(osc.stopTime, 0.9, 'a single blast is scheduled for the sample\'s ~0.8 s length');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/*
 * Idle cost (airhorn-1umb). A running-but-silent AudioContext costs ~0.7% of one
 * core measured on this VM, and it keeps paying it while the page is hidden, so
 * the horn releases the context once it has been idle for IDLE_SUSPEND_MS:
 * suspending is what takes an idle page back to the counters it has at first load.
 *
 * The fake context gains a state and a suspend() spy; the tests lower
 * idleSuspendMs so the countdown is observable without slowing the suite.
 */
class ReleasableAudioContext extends FakeAudioContext {
  state = 'running';
  suspendCalls = 0;

  async resume() {
    this.resumed = true;
    this.state = 'running';
  }

  async suspend() {
    this.suspendCalls += 1;
    this.state = 'suspended';
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('idle release: the context is suspended once the blast has rung out', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(32) });
  try {
    const ctx = new ReleasableAudioContext();
    const horn = new Horn({ audioContext: ctx, idleSuspendMs: 20 });
    await horn.start();
    assert.equal(ctx.state, 'running');
    horn.stop();
    // The fake source ends only when it is told to; a real one ends at the end of
    // the sample, which is the moment the idle countdown starts.
    ctx.sources.at(-1).stop();
    await wait(120);
    assert.equal(ctx.suspendCalls, 1, 'a silent, idle horn must release the audio context');
    assert.equal(ctx.state, 'suspended');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A slow resume is what makes the guard observable: the press is still IN FLIGHT
// when the idle countdown fires, which is exactly the race this must not lose.
class SlowResumeContext extends ReleasableAudioContext {
  async resume() {
    await wait(40);
    this.resumed = true;
    this.state = 'running';
  }
}

test('idle release: a press inside the grace window is never suspended under', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(32) });
  try {
    const ctx = new SlowResumeContext();
    const horn = new Horn({ audioContext: ctx, idleSuspendMs: 15 });
    await horn.start();
    horn.stop();
    ctx.sources.at(-1).stop();
    // Still inside the countdown when this press begins, and its resume takes
    // longer than the countdown: without the pending-start guard the context is
    // suspended underneath a press that is about to schedule audio into it.
    const second = horn.start();
    await wait(120);
    assert.equal(await second, true, 'the press that overlapped the countdown must still sound');
    assert.equal(ctx.suspendCalls, 0, 'the context must not be released while a start is in flight');
    assert.equal(horn.isPlaying(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('idle release: never suspends while a sound is still in flight', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(32) });
  try {
    const ctx = new ReleasableAudioContext();
    const horn = new Horn({ audioContext: ctx, idleSuspendMs: 20 });
    await horn.start({ loop: true });
    // A looping horn never reaches the idle countdown, however long it runs.
    await wait(140);
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.suspendCalls, 0, 'a looping horn must keep its context running');
    horn.stop({ immediate: true });
    await wait(200);
    assert.equal(horn.isPlaying(), false);
    assert.equal(ctx.suspendCalls, 1, 'the release must still happen once the loop stops');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('idle release: the next press resumes the suspended context', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(32) });
  try {
    const ctx = new ReleasableAudioContext();
    const horn = new Horn({ audioContext: ctx, idleSuspendMs: 20 });
    await horn.start();
    horn.stop();
    ctx.sources.at(-1).stop();
    await wait(120);
    assert.equal(ctx.state, 'suspended', 'setup: the context must be released before this assertion means anything');
    const started = await horn.start();
    assert.equal(started, true, 'a press after an idle release must still sound the horn');
    assert.equal(ctx.state, 'running');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/*
 * airhorn-dxug: a resume that lands late must still sound the horn for a press
 * that is still held, while a document that has never been activated must keep
 * its prompt, honest refusal - that is what tests/shortcuts.test.mjs case 9
 * pins, and it is why simply raising the bound is not the fix.
 *
 * The two questions are answered by navigator.userActivation.hasBeenActive, so
 * both cases here use the SAME slow resume and differ only in that fact.
 */
class LateResumeContext extends ReleasableAudioContext {
  constructor(delayMs, state = 'suspended') {
    super();
    this.delayMs = delayMs;
    this.state = state;
  }

  async resume() {
    await wait(this.delayMs);
    this.resumed = true;
    this.state = 'running';
  }
}

const withUserActivation = async (hasBeenActive, fn) => {
  const nav = globalThis.navigator;
  const previous = Object.getOwnPropertyDescriptor(nav, 'userActivation');
  Object.defineProperty(nav, 'userActivation', {
    value: { hasBeenActive, isActive: hasBeenActive },
    configurable: true,
    writable: true
  });
  try {
    return await fn();
  } finally {
    if (previous) Object.defineProperty(nav, 'userActivation', previous);
    else delete nav.userActivation;
  }
};

const withFakeFetch = async (fn) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(32) });
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('slow resume: an activated document waits for the graph instead of refusing the press', async () => {
  await withFakeFetch(() => withUserActivation(true, async () => {
    // 300 ms is longer than the unactivated bound (100 ms) and shorter than the
    // activated one, so this press fails on the old fixed-bound code.
    const ctx = new LateResumeContext(300);
    const horn = new Horn({ audioContext: ctx });
    const started = await horn.start({ loop: true });
    assert.equal(ctx.resumed, true, 'setup: the resume must have been awaited');
    assert.equal(started, true, 'a press in an activated document must sound even when resume is slow');
    assert.equal(horn.isPlaying(), true);
    assert.equal(ctx.state, 'running');
  }));
});

// Drain the microtask queue so a promise chain that is waiting on no timer at
// all (parked on the resume race) is observably parked. No timer involved, so
// this is deterministic on any host.
const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

test('slow resume: an unactivated document still refuses promptly and never claims to play', async (t) => {
  /*
   * airhorn-ynld: this case used to assert a WALL CLOCK - `elapsed < 250` - on a
   * 100 ms bound against a 300 ms resume. Those three numbers cannot coexist on
   * a loaded box: a 100 ms timer on a host at >80% steal fires late, and the
   * full gate measured the refusal at 404 ms while the very same code passed at
   * 102-195 ms in a focused bisect. That is a machine-state assertion, which is
   * exactly the pathology the suites must not contain.
   *
   * The property this case actually wants is ORDERING, not duration: the refusal
   * must be decided by the bound while the slow resume is still IN FLIGHT, never
   * by waiting for the graph to come up - and once it has been refused, the late
   * resume must change nothing. Virtual timers pin that to the millisecond with
   * no dependence on the host: 100 ms of virtual time is 100 ms on a starved VM
   * too, and the test spends no real time at all.
   */
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  await withFakeFetch(() => withUserActivation(false, async () => {
    const ctx = new LateResumeContext(300);
    const horn = new Horn({ audioContext: ctx });
    const began = Date.now();
    let outcome = 'pending';
    horn.start({ loop: true }).then((value) => { outcome = value; }, () => { outcome = 'rejected'; });

    await flushMicrotasks();
    assert.equal(ctx.resumed, false, 'setup: the resume must still be in flight');
    assert.equal(outcome, 'pending', 'nothing may be decided before the bound is due');

    // One millisecond short of the 100 ms bound: still legitimately in flight.
    t.mock.timers.tick(99);
    await flushMicrotasks();
    assert.equal(outcome, 'pending', 'the refusal must not land early - the bound is the whole grace period');

    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(outcome, false, 'a context that cannot resume must not be reported as playing');
    assert.equal(Date.now() - began, 100, 'the refusal must be the bound firing, not the 300 ms resume completing');
    assert.equal(ctx.resumed, false, 'the answer must arrive while the graph is still suspended - waiting longer is what the activated case is for');
    assert.equal(horn.isPlaying(), false, 'nothing may be reported as playing');

    // Let the slow resume land at last: the refusal must stand unchanged.
    t.mock.timers.tick(200);
    await flushMicrotasks();
    assert.equal(ctx.state, 'running', 'setup: the late resume did eventually land');
    assert.equal(ctx.sources.length, 0, 'a refused press must not create a source');
    assert.equal(horn.isPlaying(), false, 'nothing may be scheduled into a context that was suspended when the press was refused');
  }));
});

test('slow resume: a horn that has already played waits out an idle re-suspend with no gesture at all', async () => {
  // The WebMCP path: a tool call is never a gesture, and play_horn can arrive
  // after airhorn-1umb's idle suspend has released the graph. The document has
  // played before, so the policy question is settled - only the machine is slow.
  await withFakeFetch(() => withUserActivation(false, async () => {
    const ctx = new LateResumeContext(300, 'running');
    const horn = new Horn({ audioContext: ctx });
    assert.equal(await horn.start({ loop: true }), true, 'setup: the first blast must play');
    horn.stop();
    ctx.sources.at(-1).stop();
    await wait(20);
    ctx.state = 'suspended';           // the idle countdown released the graph
    const second = await horn.start({ loop: false });
    assert.equal(second, true, 'a tool call must not be refused just because resuming was slow');
    assert.equal(ctx.state, 'running');
  }));
});

test('a synth blast announces its end on the audio clock, not on a delayed timer', async () => {
  // airhorn-dxug: the non-loop synth blast used to rely solely on
  // setTimeout(cleanup, 950). On a starved main thread that timer ran 5.3 s late,
  // so the button kept claiming a sound that had already finished.
  const originalFetch = globalThis.fetch;
  const ctx = new FakeAudioContext();
  ctx.shouldFailDecode = true;              // force the synth voice
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });
  try {
    const horn = new Horn({ audioContext: ctx });
    let stopped = 0;
    horn.onstopped = () => { stopped += 1; };
    assert.equal(await horn.start({ loop: false }), true);
    assert.equal(horn.usingFallback, true);
    assert.equal(stopped, 0);
    const lastOsc = ctx.oscillators.at(-1);
    assert.equal(typeof lastOsc.onended, 'function', 'the synth must hear its own end, not only a timer');
    lastOsc.onended();                      // the audio clock says the blast is over
    assert.equal(horn.isPlaying(), false, 'the finished blast must stop being reported as playing');
    assert.equal(stopped, 1, 'the end must be announced without waiting for a timer');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
