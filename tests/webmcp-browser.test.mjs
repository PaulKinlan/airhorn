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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';

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
    window.__probe = { starts: 0, peak: 0, level: 0, samples: 0, ctxState: null, active: 0, maxActive: 0, contexts: 0, oscStarts: 0, oscActive: 0, maxOscActive: 0 };
    window.__badge = { calls: [], cleared: 0 };

    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      // Count AudioContext constructions: more than one for a page's lifetime is
      // a leak, which a hostile caller must not be able to provoke (airhorn-9e9).
      try {
        window.AudioContext = new Proxy(AC, {
          construct(target, args, newTarget) {
            window.__probe.contexts += 1;
            return Reflect.construct(target, args, newTarget);
          },
        });
      } catch {}

      // Count oscillators (the synth fallback path) the same way.
      const createOscillator = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function (...args) {
        const osc = createOscillator.apply(this, args);
        const oscStart = osc.start.bind(osc);
        osc.start = (...startArgs) => {
          window.__probe.oscStarts += 1;
          window.__probe.oscActive += 1;
          if (window.__probe.oscActive > window.__probe.maxOscActive) window.__probe.maxOscActive = window.__probe.oscActive;
          return oscStart(...startArgs);
        };
        const oscStop = osc.stop.bind(osc);
        let oscReleased = false;
        osc.stop = (...stopArgs) => {
          const result = oscStop(...stopArgs);
          if (!oscReleased) {
            oscReleased = true;
            setTimeout(() => { window.__probe.oscActive -= 1; }, 0);
          }
          return result;
        };
        return osc;
      };

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
          window.__probe.active += 1;
          if (window.__probe.active > window.__probe.maxActive) window.__probe.maxActive = window.__probe.active;
          let released = false;
          source.addEventListener('ended', () => {
            if (released) return;
            released = true;
            window.__probe.active -= 1;
          });
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

    // Hostile-input helper: object inputs go to executeTool as objects (what a
    // native model context requires). A non-object cannot reach a native model
    // context at all, so the JSON-text form is attempted and its refusal is
    // recorded as the platform's own safe no-op.
    window.__callAny = async (name, value) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error('Unknown tool "' + name + '"');
      const payload = value !== null && typeof value === 'object' ? value : JSON.stringify(value);
      const raw = await document.modelContext.executeTool(tool, payload, {});
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

  let browser = null;
  try {
    browser = await launchBrowser({ autoplay: true, webmcp: true, label: 'webmcp-browser', timeoutMs: 15000 });

    const pageWsUrl = browser.pageWsUrl;
    const ws = new WebSocket(pageWsUrl);
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

    // 5. Hostile callers (airhorn-9e9): wrong types, huge payloads, extra
    // properties. Every call must end in a structured refusal or a safe no-op -
    // never a coercion, never an unhandled rejection, never a started horn.
    // Some of these (anything that is not an object) are refused by the
    // platform itself before the tool runs; that is a safe no-op too, and the
    // check below records which layer said no.
    const hostile = await evaluate(`(async () => {
      const cases = [
        ['loop as a string', { loop: 'true' }, true],
        ['loop as an object', { loop: { value: true } }, true],
        ['loop as a number', { loop: 1 }, true],
        ['loop as null', { loop: null }, true],
        ['loop as an array', { loop: [true] }, true],
        ['input as a plain string', 'hello', true],
        ['input as a number', 42, true],
        ['input as an array', [1, 2, 3], true],
        ['input as null (missing arguments)', null, false],
        ['extra properties', { loop: false, volume: 11, nested: { a: [1, 2] } }, false],
      ];
      const out = [];
      for (const [label, value, expectRefusal] of cases) {
        const horn = document.querySelector('.horn');
        const before = { starts: window.__probe.starts, pressed: horn.getAttribute('aria-pressed') };
        const began = performance.now();
        let entry;
        try {
          entry = { label, expectRefusal, resolved: true, result: await window.__callAny('play_horn', value) };
        } catch (err) {
          entry = { label, expectRefusal, resolved: false, platformRefused: true, rejected: String((err && err.message) || err) };
        }
        entry.ms = Math.round(performance.now() - began);
        entry.startsDelta = window.__probe.starts - before.starts;
        entry.pressedBefore = before.pressed;
        entry.pressedAfter = horn.getAttribute('aria-pressed');
        out.push(entry);
        await window.__call('stop_horn');
        await new Promise((r) => setTimeout(r, 40));
      }
      // A megabyte of junk must be refused promptly and echoed back at nobody.
      const mega = 'x'.repeat(1000000);
      const megaBegan = performance.now();
      const megaStartsBefore = window.__probe.starts;
      const megaEntry = { label: 'megabyte payload', expectRefusal: true };
      try {
        megaEntry.resolved = true;
        megaEntry.result = await window.__callAny('play_horn', { loop: mega });
        megaEntry.responseBytes = JSON.stringify(megaEntry.result).length;
        megaEntry.echoedPayload = JSON.stringify(megaEntry.result).includes(mega.slice(0, 32));
      } catch (err) {
        megaEntry.resolved = false;
        megaEntry.platformRefused = true;
        megaEntry.rejected = String((err && err.message) || err);
      }
      megaEntry.ms = Math.round(performance.now() - megaBegan);
      megaEntry.startsDelta = window.__probe.starts - megaStartsBefore;
      await window.__call('stop_horn');
      out.push(megaEntry);
      return out;
    })()`);
    console.log('hostile input:', hostile);

    for (const entry of hostile) {
      if (!entry.resolved) {
        // Refused before the tool ran: nothing may have sounded or stuck.
        if (!/invalid input|not an object|is required/i.test(entry.rejected)) {
          throw new Error(`${entry.label} rejected unexpectedly: ${entry.rejected}`);
        }
        if (entry.startsDelta !== 0) {
          throw new Error(`${entry.label} was refused by the platform but still started audio`);
        }
        if (entry.pressedAfter !== entry.pressedBefore) {
          throw new Error(`${entry.label} was refused by the platform but changed the button state`);
        }
        continue;
      }
      if (typeof entry.result.playing !== 'boolean' || typeof entry.result.loop !== 'boolean') {
        throw new Error(`play_horn result is not structured for ${entry.label}: ${JSON.stringify(entry.result)}`);
      }
      if (entry.expectRefusal) {
        if (entry.result.code !== 'invalid_input') {
          throw new Error(`${entry.label} should be refused as invalid_input: ${JSON.stringify(entry.result)}`);
        }
        if (entry.result.playing !== false) {
          throw new Error(`${entry.label} reported a playing horn despite being refused`);
        }
        if (entry.startsDelta !== 0) {
          throw new Error(`${entry.label} started audio despite being refused`);
        }
        if (entry.pressedAfter !== entry.pressedBefore) {
          throw new Error(`${entry.label} changed the button state`);
        }
      } else {
        if (entry.result.error) {
          throw new Error(`${entry.label} should be a safe no-op, got ${JSON.stringify(entry.result)}`);
        }
        if (entry.startsDelta !== 1) {
          throw new Error(`${entry.label} should sound the horn once, starts delta ${entry.startsDelta}`);
        }
        if (entry.result.loop !== false) {
          throw new Error(`${entry.label} should not have looped: ${JSON.stringify(entry.result)}`);
        }
      }
      if (entry.result.code && entry.result.error.length > 200) {
        throw new Error(`${entry.label} returned a ${entry.result.error.length}-character error message`);
      }
    }

    const mega = hostile.find((entry) => entry.label === 'megabyte payload');
    if (mega.resolved) {
      if (mega.result.code !== 'invalid_input') {
        throw new Error(`a megabyte payload should be refused: ${JSON.stringify(mega.result)}`);
      }
      if (mega.responseBytes > 512) {
        throw new Error(`the refusal repeated ${mega.responseBytes} bytes back at the caller`);
      }
      if (mega.echoedPayload) throw new Error('the refusal echoed the hostile payload');
      if (mega.ms > 500) throw new Error(`refusing a megabyte took ${mega.ms}ms`);
    } else if (mega.ms > 500) {
      throw new Error(`the platform took ${mega.ms}ms to refuse a megabyte payload`);
    }

    // 6. Rapid repeated invocation: a flood must not stack playback, allocate
    // more audio nodes than it can clean up, or leak an AudioContext.
    const flood = await evaluate(`(async () => {
      const horn = document.querySelector('.horn');
      const before = { starts: window.__probe.starts, contexts: window.__probe.contexts, pressed: horn.getAttribute('aria-pressed') };
      window.__probe.maxActive = window.__probe.active;
      let rejected = 0;
      const results = await Promise.all(Array.from({ length: 40 }, () =>
        window.__call('play_horn', { loop: true }).catch((err) => {
          rejected += 1;
          return { rejected: String((err && err.message) || err) };
        })
      ));
      await new Promise((r) => setTimeout(r, 300));
      const during = {
        active: window.__probe.active,
        maxActive: window.__probe.maxActive,
        level: window.__probe.level,
        pressed: horn.getAttribute('aria-pressed'),
        contexts: window.__probe.contexts,
        state: await window.__call('get_horn_state'),
      };
      const stopped = await window.__call('stop_horn');
      await new Promise((r) => setTimeout(r, 400));
      return {
        before,
        rejected,
        answers: results.length,
        accepted: results.filter((r) => r.code === undefined).length,
        rateLimited: results.filter((r) => r.code === 'rate_limited').length,
        structured: results.every((r) => typeof r.playing === 'boolean' && typeof r.loop === 'boolean'),
        during,
        stopped,
        after: {
          active: window.__probe.active,
          level: window.__probe.level,
          pressed: horn.getAttribute('aria-pressed'),
          contexts: window.__probe.contexts,
          started: window.__probe.starts - before.starts,
          state: await window.__call('get_horn_state'),
        },
      };
    })()`);
    console.log('play flood (40 concurrent):', flood);

    if (flood.rejected !== 0) throw new Error('a play flood must not reject');
    if (flood.answers !== 40) throw new Error('every call in a flood must be answered');
    if (!flood.structured) throw new Error('every answer in a flood must be structured');
    if (flood.accepted < 1) throw new Error('a flood should still sound the horn at least once');
    if (flood.rateLimited < 1) throw new Error('the rate limit should refuse part of a 40-call flood');
    if (flood.during.state.playing !== true) throw new Error('the flood should leave the horn sounding');
    if (flood.during.active > 1) {
      throw new Error(`the flood left ${flood.during.active} playbacks sounding at once (max ${flood.during.maxActive})`);
    }
    if (flood.during.contexts !== flood.before.contexts) {
      throw new Error(`the flood created ${flood.during.contexts - flood.before.contexts} extra AudioContext(s)`);
    }
    if (flood.stopped.playing !== false) throw new Error('stop_horn after a flood must silence the horn');
    if (flood.after.active !== 0) throw new Error(`stop_horn left ${flood.after.active} source(s) sounding`);
    if (flood.after.level > 0.01) throw new Error(`audio is still audible after the flood (level ${flood.after.level})`);
    if (flood.after.pressed !== 'false') throw new Error('the flood left the button pressed');
    if (flood.after.state.playing !== false || flood.after.state.loop !== false) {
      throw new Error(`the horn did not settle after the flood: ${JSON.stringify(flood.after.state)}`);
    }

    // 7. Invocation while offline: a structured answer, and silence still works.
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const offline = await evaluate(`(async () => {
      const before = window.__probe.starts;
      let entry;
      try {
        entry = { resolved: true, result: await window.__call('play_horn', { loop: true }) };
      } catch (err) {
        entry = { resolved: false, rejected: String((err && err.message) || err) };
      }
      entry.startsDelta = window.__probe.starts - before;
      return { entry, stopped: await window.__call('stop_horn'), state: await window.__call('get_horn_state') };
    })()`);
    console.log('offline invocation:', offline);
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    if (!offline.entry.resolved) throw new Error(`play_horn rejected while offline: ${offline.entry.rejected}`);
    if (typeof offline.entry.result.playing !== 'boolean') throw new Error('offline play_horn was not structured');
    if (offline.entry.result.error && typeof offline.entry.result.code !== 'string') {
      throw new Error('an offline refusal must carry a machine-readable code');
    }
    if (offline.stopped.playing !== false) throw new Error('stop_horn must work offline');
    if (offline.state.playing !== false) throw new Error('the horn must be silent after an offline stop');

    // 8. The sample never decodes (audio graph not ready): the horn still
    // answers structurally and falls back to live synthesis instead of failing.
    const pageErrorsBeforeReload = await evaluate('window.__pageErrors || []');
    if (pageErrorsBeforeReload.length > 0) {
      throw new Error(`In-page errors before the fallback reload: ${JSON.stringify(pageErrorsBeforeReload)}`);
    }
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC && AC.prototype) {
          AC.prototype.decodeAudioData = () => Promise.reject(new Error('sample decode blocked by the fuzz suite'));
        }
      })();`,
    });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    let fallbackReady = false;
    for (let i = 0; i < 100; i += 1) {
      try {
        fallbackReady = await evaluate(`(async () => {
          if (!document.querySelector('.horn') || !document.modelContext) return false;
          return (await document.modelContext.getTools()).length >= 3;
        })()`);
      } catch {
        fallbackReady = false;
      }
      if (fallbackReady) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!fallbackReady) throw new Error('WebMCP tools were never registered after the fallback reload');

    const fallback = await evaluate(`(async () => {
      const horn = document.querySelector('.horn');
      const before = { oscStarts: window.__probe.oscStarts, starts: window.__probe.starts };
      let entry;
      try {
        entry = { resolved: true, result: await window.__call('play_horn', { loop: true }) };
      } catch (err) {
        entry = { resolved: false, rejected: String((err && err.message) || err) };
      }
      await new Promise((r) => setTimeout(r, 250));
      const during = {
        oscStarts: window.__probe.oscStarts - before.oscStarts,
        oscActive: window.__probe.oscActive,
        sampleStarts: window.__probe.starts - before.starts,
        pressed: horn.getAttribute('aria-pressed'),
        state: await window.__call('get_horn_state'),
      };
      const stopped = await window.__call('stop_horn');
      await new Promise((r) => setTimeout(r, 300));
      return {
        entry,
        during,
        stopped,
        after: { oscActive: window.__probe.oscActive, pressed: horn.getAttribute('aria-pressed'), state: await window.__call('get_horn_state') },
      };
    })()`);
    console.log('synth fallback (sample decode blocked):', fallback);

    if (!fallback.entry.resolved) throw new Error(`play_horn rejected on the synth fallback: ${fallback.entry.rejected}`);
    if (fallback.entry.result.playing !== true) {
      throw new Error(`the synth fallback should still sound the horn: ${JSON.stringify(fallback.entry.result)}`);
    }
    if (fallback.during.oscStarts < 1) throw new Error('the synth fallback produced no oscillators');
    if (fallback.during.sampleStarts !== 0) throw new Error('the synth fallback should not start a sample source');
    if (fallback.during.state.playing !== true) throw new Error('the synth fallback should report a playing horn');
    if (fallback.during.pressed !== 'true') throw new Error('the synth fallback should press the button');
    if (fallback.stopped.playing !== false) throw new Error('stop_horn must silence the synth fallback');
    if (fallback.after.oscActive !== 0) throw new Error(`the synth fallback leaked ${fallback.after.oscActive} oscillator(s)`);
    if (fallback.after.state.playing !== false) throw new Error('the synth fallback did not settle after stop_horn');

    // 9. No page errors. Note: the page-level `__pageErrors` array is per-document,
    // so this covers the reloaded document; the pre-reload check above covered the first.
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
    if (browser) await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
