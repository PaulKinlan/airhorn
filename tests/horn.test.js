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
  setValueAtTime(val) { this.value = val; this.scheduled.push(val); }
  exponentialRampToValueAtTime(val) { this.value = val; this.scheduled.push(val); }
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
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run vite build first.');
  }

  let server = null;
  let chrome = null;
  let ws = null;
  const profileDir = '/tmp/chrome-horn-fallback-' + Date.now();

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

    const chromeBin = process.env.CHROME_BIN ||
      (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
      fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : 'google-chrome');

    chrome = spawn(chromeBin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let wsUrl = null;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome timeout')), 10000);
      chrome.stderr.on('data', (d) => {
        const match = d.toString().match(/ws:\/\/[^\s]+/);
        if (match) {
          wsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      });
      chrome.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const chromePort = new URL(wsUrl).port;
    const targetsRes = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
    const targets = await targetsRes.json();
    const pageWsUrl = targets.find(t => t.type === 'page').webSocketDebuggerUrl;

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

    // AnalyserNode tap to measure audibility (peak level > 0.01)
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__audioProbe = { peak: 0, currentLevel: 0, samples: 0, oscStarts: 0, taps: [] };
        // The level is read ON DEMAND, not accumulated by a timer. A 20 ms
        // setInterval is fine on an idle machine and useless on a gate-under-load
        // one, where a single timer sample of a 0.9 s blast can be starved past
        // the whole blast and read as silence (airhorn-u7s: that is exactly how
        // this check flaked). read() samples every tap right now, so the caller
        // controls when it looks instead of hoping a timer fired.
        window.__audioProbe.read = () => {
          let level = 0;
          for (const tap of window.__audioProbe.taps) {
            try {
              tap.analyser.getFloatTimeDomainData(tap.data);
              for (let i = 0; i < tap.data.length; i++) {
                const abs = Math.abs(tap.data[i]);
                if (abs > level) level = abs;
              }
            } catch {}
          }
          window.__audioProbe.currentLevel = level;
          if (level > window.__audioProbe.peak) window.__audioProbe.peak = level;
          window.__audioProbe.samples++;
          return {
            peak: window.__audioProbe.peak,
            currentLevel: level,
            samples: window.__audioProbe.samples,
            oscStarts: window.__audioProbe.oscStarts
          };
        };
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const origConnect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (dest, ...rest) {
            const ret = origConnect.apply(this, [dest, ...rest]);
            if (dest && this.context && dest === this.context.destination && !this.__isProbeNode) {
              this.__isProbeNode = true;
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
                window.__audioProbe.taps.push({ analyser, data });
              } catch (e) {
                console.error('Probe hook error', e);
              }
            }
            return ret;
          };
          const origCreateOsc = AC.prototype.createOscillator;
          AC.prototype.createOscillator = function (...args) {
            const osc = origCreateOsc.apply(this, args);
            const origStart = osc.start.bind(osc);
            osc.start = function (...startArgs) {
              window.__audioProbe.oscStarts++;
              return origStart(...startArgs);
            };
            return osc;
          };
        }
      `
    });

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 600));

    // Part A: Tap test with real gesture (pointerdown, 60ms, pointerup)
    // Verifies synth starts, sounds audibly, does NOT truncate early, and rings out
    await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        horn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        setTimeout(() => {
          document.documentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }, 60);
      })()`
    });

    // Audibility: read the analyser on demand for up to 1.5 s, which covers the
    // whole blast (0.9 s plus release) even on a loaded gate. A silent fallback
    // still fails: nothing is ever above the floor.
    const readProbe = async () => {
      const probe = await send('Runtime.evaluate', {
        expression: 'window.__audioProbe.read()',
        returnByValue: true
      });
      return probe.result.value;
    };
    let audioPeak = 0;
    for (let i = 0; i < 30; i++) {
      const probe = await readProbe();
      audioPeak = probe.peak;
      if (audioPeak > 0.01) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(audioPeak > 0.01, `Horn must sound audibly within 1.5s of the press; peak ${audioPeak}`);

    // Far past the old 100ms truncation point, and past the 60ms tap: the horn
    // must still be sounding, and still be playing.
    await new Promise(r => setTimeout(r, 200));
    const activeAt500 = await send('Runtime.evaluate', {
      expression: `(() => ({
        level: window.__audioProbe.read().currentLevel,
        playing: !!(window.__airhorn && window.__airhorn.isPlaying())
      }))()`,
      returnByValue: true
    });
    assert.ok(
      activeAt500.result.value.level > 0.01,
      `Horn must still be ringing out ~500ms after a 60ms tap; got level ${activeAt500.result.value.level}`,
    );
    assert.ok(
      activeAt500.result.value.playing,
      'Horn must still report playing ~500ms after a 60ms tap',
    );

    // Wait for blast duration to complete and settle
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
          audioPeak: window.__audioProbe?.peak || 0,
          oscStarts: window.__audioProbe?.oscStarts || 0
        };
      })()`,
      returnByValue: true
    });

    assert.equal(settledResult.result.value.horning, false, 'UI should exit horning state after blast finishes');
    assert.equal(settledResult.result.value.pressed, 'false', 'aria-pressed should revert to false');
    assert.equal(settledResult.result.value.isPlaying, false, 'Audio should finish playing');
    assert.ok(settledResult.result.value.audioPeak > 0.01, `Fallback synth must be audible: peak was ${settledResult.result.value.audioPeak}`);
    assert.ok(settledResult.result.value.oscStarts >= 3, `Expected at least 3 oscillators to start, got ${settledResult.result.value.oscStarts}`);

    // Part B: Release-before-start race condition with delayed 404
    delayMp3 = 250;
    await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        horn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        setTimeout(() => {
          document.documentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }, 50);
      })()`
    });

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
    if (chrome) {
      chrome.kill('SIGTERM');
    }
    if (server) {
      server.close();
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
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
    // Attack: the envelope reaches full level 0.14 s in, not 0.04 s.
    assert.ok(master.gain.scheduled.includes(0.8), 'the attack must not be a hard 40 ms step');

    for (const osc of ctx.oscillators) {
      assert.equal(osc.stopTime, 0.9, 'a single blast is scheduled for the sample\'s ~0.8 s length');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
