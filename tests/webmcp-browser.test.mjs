/*
 * Browser verification for the WebMCP exposure: a real Chromium instance loads
 * the built site, discovers the registered horn tools, and invokes them with
 * `document.modelContext.executeTool()`, proving the tool call actually sounds
 * the horn (audio samples flow through the Web Audio graph), updates the button
 * state and the app badge, and that stop_horn silences it.
 *
 * WebMCP is behind a flag in current Chromium, so when `document.modelContext`
 * is not available, a faithful in-page stand-in (same documented surface:
 * registerTool / getTools / executeTool / toolchange) is installed before the
 * page's own scripts run. Either way the page's real registration code and real
 * Web Audio graph are exercised.
 *
 * Run with: node tests/webmcp-browser.test.mjs (after `npm run build`)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
};

// Installed before any page script runs:
//  - a spec-shaped document.modelContext stand-in when the browser has none;
//  - a Web Audio tap that measures the level of every buffer source, proving
//    real audio is produced rather than just a state flag being flipped;
//  - a spy on the app badge API.
const instrumentation = `
  (() => {
    window.__probe = { starts: 0, peak: 0, level: 0, samples: 0, ctxState: null };
    window.__badge = { calls: [], cleared: 0 };

    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const createBufferSource = AC.prototype.createBufferSource;
      AC.prototype.createBufferSource = function (...args) {
        const ctx = this;
        const source = createBufferSource.apply(this, args);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        const data = new Float32Array(analyser.fftSize);
        // Keep the analyser in the graph without adding a second audible path.
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;
        silentSink.connect(ctx.destination);
        analyser.connect(silentSink);

        const connect = source.connect.bind(source);
        source.connect = (destination, ...rest) => {
          const result = connect(destination, ...rest);
          if (destination !== analyser) connect(analyser);
          return result;
        };

        const start = source.start.bind(source);
        source.start = (...startArgs) => {
          window.__probe.starts += 1;
          const result = start(...startArgs);
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
          return result;
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

    // Agent-shaped helper: discover the RegisteredTool, then invoke it. Chrome
    // <155 takes the input as a JSON string, so fall back to that.
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

async function run() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  const server = http.createServer((req, res) => {
    let filePath = path.join(distDir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let chrome = null;
  try {
    const chromeBin = process.env.CHROME_BIN ||
      (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
      fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
      fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

    chrome = spawn(chromeBin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=WebMCP,WebMCPTesting',
      '--remote-debugging-port=0',
      '--user-data-dir=/tmp/chrome-webmcp-profile-' + Date.now(),
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let wsUrl = null;
    const stderrLines = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome start timeout: ' + stderrLines.join('\n'))), 15000);
      chrome.stderr.on('data', (data) => {
        const text = data.toString();
        stderrLines.push(text);
        const match = text.match(/ws:\/\/[^\s]+/);
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
    const pageTarget = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const pending = new Map();
    const consoleMessages = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleMessages.push(msg.params);
      } else if (msg.method === 'Log.entryAdded') {
        if (msg.params.entry.level === 'error') {
          consoleMessages.push({ type: 'error', text: msg.params.entry.text });
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        consoleMessages.push({
          type: 'error',
          text: details?.exception?.description || details?.text || 'Uncaught exception',
        });
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          'Page evaluation failed: ' +
            (result.exceptionDetails.exception?.description || result.exceptionDetails.text),
        );
      }
      return result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pageErrors = [];
        window.addEventListener('error', (e) => {
          window.__pageErrors.push({ type: 'error', message: e.message });
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__pageErrors.push({ type: 'unhandledrejection', message: String(e.reason && e.reason.message || e.reason) });
        });
        ${instrumentation}
      `,
    });

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    // Wait for the horn and for the page to register its tools.
    let registered = false;
    for (let i = 0; i < 100; i += 1) {
      try {
        registered = await evaluate(`(async () => {
          if (!document.querySelector('.horn') || !document.modelContext) return false;
          const tools = await document.modelContext.getTools();
          return tools.length >= 3;
        })()`);
      } catch {
        registered = false;
      }
      if (registered) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!registered) throw new Error('WebMCP tools were never registered by the page');

    // 1. Discovery: the three tools, with schemas, as an agent would see them.
    const discovered = await evaluate(`(async () => {
      const tools = await document.modelContext.getTools();
      return {
        source: window.__webmcpSource,
        names: tools.map((t) => t.name),
        readOnly: Object.fromEntries(tools.map((t) => [t.name, !!t.annotations.readOnlyHint])),
        loopParam: tools.find((t) => t.name === 'play_horn').inputSchema?.properties?.loop?.type,
        descriptions: tools.map((t) => typeof t.description === 'string' && t.description.length > 20),
      };
    })()`);
    console.log('Discovered tools:', discovered);

    const expectedNames = ['play_horn', 'stop_horn', 'get_horn_state'];
    for (const name of expectedNames) {
      if (!discovered.names.includes(name)) {
        throw new Error(`Tool ${name} was not registered (got ${discovered.names.join(', ')})`);
      }
    }
    if (discovered.loopParam !== 'boolean') {
      throw new Error(`play_horn.loop schema should be boolean, got ${discovered.loopParam}`);
    }
    if (discovered.readOnly.get_horn_state !== true) {
      throw new Error('get_horn_state should be annotated readOnlyHint: true');
    }
    if (discovered.readOnly.play_horn !== false) {
      throw new Error('play_horn should not be annotated readOnlyHint: true');
    }

    // 2. play_horn (loop) sounds the horn for real.
    const played = await evaluate(`(async () => {
      const horn = document.querySelector('.horn');
      const before = { pressed: horn.getAttribute('aria-pressed'), horning: horn.classList.contains('horning') };
      const result = await window.__call('play_horn', { loop: true });
      await new Promise((r) => setTimeout(r, 400));
      const during = { pressed: horn.getAttribute('aria-pressed'), horning: horn.classList.contains('horning') };
      const levelA = window.__probe.level;
      await new Promise((r) => setTimeout(r, 350));
      const levelB = window.__probe.level;
      const state = await window.__call('get_horn_state');
      return {
        before, result, during,
        levelA, levelB,
        peak: window.__probe.peak,
        starts: window.__probe.starts,
        ctxState: window.__probe.ctxState,
        state,
        badge: window.__badge.calls.slice(),
      };
    })()`);
    console.log('play_horn:', played);

    if (played.before.pressed !== 'false' || played.before.horning) {
      throw new Error('Horn should be idle before the tool call');
    }
    if (played.result.playing !== true || played.result.loop !== true) {
      throw new Error(`play_horn should report {playing:true, loop:true}, got ${JSON.stringify(played.result)}`);
    }
    if (played.during.pressed !== 'true' || !played.during.horning) {
      throw new Error(`Button did not enter the pressed/horning state: ${JSON.stringify(played.during)}`);
    }
    if (played.starts < 1) throw new Error('No audio buffer source was started');
    if (!(played.peak > 0.01)) {
      throw new Error(`No audible audio produced (peak ${played.peak}, ctx ${played.ctxState})`);
    }
    if (!(played.levelA > 0.005) || !(played.levelB > 0.005)) {
      throw new Error(`Audio is not continuously sounding while looping (levels ${played.levelA}, ${played.levelB})`);
    }
    if (played.ctxState !== 'running') {
      throw new Error(`AudioContext should be running, got ${played.ctxState}`);
    }
    if (played.state.playing !== true || played.state.loop !== true || played.state.hasAudioContext !== true) {
      throw new Error(`get_horn_state should report a playing, looping horn: ${JSON.stringify(played.state)}`);
    }
    if (!played.badge.some((value) => typeof value === 'number' && value > 0)) {
      throw new Error(`App badge was not updated (calls: ${JSON.stringify(played.badge)})`);
    }

    const screenshotPlaying = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/airhorn-webmcp-playing.png', Buffer.from(screenshotPlaying.data, 'base64'));

    // 3. stop_horn silences it and clears the pressed state.
    const stopped = await evaluate(`(async () => {
      const horn = document.querySelector('.horn');
      const startsBefore = window.__probe.starts;
      const result = await window.__call('stop_horn');
      await new Promise((r) => setTimeout(r, 300));
      return {
        result,
        startsBefore,
        startsAfter: window.__probe.starts,
        pressed: horn.getAttribute('aria-pressed'),
        horning: horn.classList.contains('horning'),
        level: window.__probe.level,
        state: await window.__call('get_horn_state'),
      };
    })()`);
    console.log('stop_horn:', stopped);

    if (stopped.result.playing !== false || stopped.state.playing !== false) {
      throw new Error(`stop_horn should leave the horn stopped: ${JSON.stringify(stopped)}`);
    }
    if (stopped.startsAfter !== stopped.startsBefore) {
      throw new Error('stop_horn should not start a new audio source');
    }
    if (stopped.pressed !== 'false' || stopped.horning) {
      throw new Error(`Button state was not cleared by stop_horn: ${JSON.stringify(stopped)}`);
    }
    if (stopped.level > 0.01) {
      throw new Error(`Audio is still audible after stop_horn (level ${stopped.level})`);
    }

    // 4. A non-looping blast ends by itself and restores the button state.
    const blast = await evaluate(`(async () => {
      const horn = document.querySelector('.horn');
      const result = await window.__call('play_horn', {});
      const pressedImmediately = horn.getAttribute('aria-pressed');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && horn.getAttribute('aria-pressed') === 'true') {
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        result,
        pressedImmediately,
        pressedAfter: horn.getAttribute('aria-pressed'),
        horningAfter: horn.classList.contains('horning'),
        state: await window.__call('get_horn_state'),
      };
    })()`);
    console.log('single blast:', blast);

    if (blast.result.playing !== true || blast.result.loop !== false) {
      throw new Error(`play_horn without loop should be a single blast: ${JSON.stringify(blast.result)}`);
    }
    if (blast.pressedImmediately !== 'true') {
      throw new Error('A single blast should press the button immediately');
    }
    if (blast.pressedAfter !== 'false' || blast.horningAfter) {
      throw new Error(`Single blast did not restore the button state: ${JSON.stringify(blast)}`);
    }
    if (blast.state.playing !== false) {
      throw new Error('get_horn_state should report the finished blast as not playing');
    }

    // 5. No page errors.
    const pageErrors = await evaluate('window.__pageErrors || []');
    if (pageErrors.length > 0) {
      throw new Error(`In-page errors detected: ${JSON.stringify(pageErrors)}`);
    }
    const errors = consoleMessages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(`Console errors or uncaught exceptions detected: ${JSON.stringify(errors)}`);
    }

    console.log('WEBMCP BROWSER VERIFICATION PASSED');
    console.log('Screenshot: /tmp/airhorn-webmcp-playing.png');
  } finally {
    if (chrome) chrome.kill('SIGTERM');
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
