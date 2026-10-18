/*
 *  Unit tests for src/horn.js: primary sample path and Web Audio synthesized fallback.
 *  Run with: node tests/horn.test.js
 */

import assert from 'node:assert/strict';
import { Horn } from '../src/horn.js';

class FakeAudioParam {
  value = 1;
  setValueAtTime(val) { this.value = val; }
  exponentialRampToValueAtTime(val) { this.value = val; }
  cancelScheduledValues() {}
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
  start() { this.started = true; }
  stop() { this.stopped = true; }
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

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
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
    assert.ok(ctx.oscillators.every(o => o.type === 'sawtooth' && o.started));

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

test('gracefully handles unavailable AudioContext', async () => {
  const horn = new Horn({ audioContext: null });
  assert.equal(horn.hasAudioContext(), false);
  const started = await horn.start();
  assert.equal(started, false);
  assert.equal(horn.isPlaying(), false);
});

test('browser verification: forced mp3 404 still activates synth and toggles UI', async () => {
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

  // Server that intercepts /sounds/airhorn.mp3 and returns 404
  const server = http.createServer((req, res) => {
    const reqUrl = req.url.split('?')[0];
    if (reqUrl === '/sounds/airhorn.mp3') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found (forced fallback simulation)');
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

  const profileDir = '/tmp/chrome-horn-fallback-' + Date.now();
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
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
  });

  const chromePort = new URL(wsUrl).port;
  const targetsRes = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
  const targets = await targetsRes.json();
  const pageWsUrl = targets.find(t => t.type === 'page').webSocketDebuggerUrl;

  const ws = new WebSocket(pageWsUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      console.log('[Browser Console]', msg.params.args?.map(a => a.value).join(' '));
      if (msg.params.type === 'error') {
        consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
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

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    // Wait for page ready
    await new Promise(r => setTimeout(r, 600));

    // Trigger horn click in browser while mp3 404s
    const triggerResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        horn.click();
        return {
          horning: horn.classList.contains('horning'),
          pressed: horn.getAttribute('aria-pressed')
        };
      })()`,
      returnByValue: true
    });

    assert.equal(triggerResult.result.value.horning, true, 'UI should enter horning state on fallback play');
    assert.equal(triggerResult.result.value.pressed, 'true', 'aria-pressed should be true on fallback play');

    // Wait for blast duration and settle
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `!document.querySelector('.horn').classList.contains('horning')`,
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
        };
      })()`,
      returnByValue: true
    });
    assert.equal(settledResult.result.value.horning, false, 'UI should exit horning state after blast finishes');
    assert.equal(settledResult.result.value.pressed, 'false', 'aria-pressed should revert to false');

    assert.deepEqual(consoleErrors, [], 'No uncaught exceptions or errors on fallback playback');
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} Horn audio tests passed`);
if (failures > 0) process.exit(1);
