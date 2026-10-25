#!/usr/bin/env node
/*
 * tools/soak.mjs — long-session resource soak for the built Air Horner (airhorn-1u1).
 *
 * Every other suite in this repo proves a *moment*: the horn sounds, the page
 * survives offline, the update lands. None of them press the horn two hundred
 * times. A demo that leaks an AudioBufferSourceNode per blast, or keeps a cache
 * per service-worker version, is green on all of them and still janks a phone
 * after ten minutes — so this drives one browser through a realistic long
 * session and measures what the page *holds*, not what it printed.
 *
 * One session, four phases, all against a served `dist/`:
 *
 *   A. cycles   — 240 start/stop cycles mixed the way people and agents really
 *                 drive it: WebMCP play/stop (the bulk), pointer press-and-hold
 *                 with the sample ringing out, keyboard Space, and `/#instant`.
 *                 Heap is sampled after a forced GC every 40 cycles.
 *   B. updates  — three service-worker versions published byte-different, each
 *                 installed over the live controller. Every update must replace
 *                 its caches (never stack them) and reload the page once.
 *   C. offline  — repeated offline/online toggles. Each offline reload must still
 *                 render the horn from cache and still play it.
 *   D. settle   — a final sample, then the assertions.
 *
 * What "leak" means here, and how each is measured:
 *   - heap            Runtime.getHeapUsage after HeapProfiler.collectGarbage, so
 *                     the number is *retained* bytes rather than garbage;
 *   - live audio      counts of AudioBufferSourceNode / OscillatorNode instances
 *                     still reachable in the heap (Runtime.queryObjects), cross-
 *                     checked against start/ended events counted in the page;
 *   - audio contexts  the app must own exactly one AudioContext for the life of
 *                     the document, not one per blast;
 *   - listeners/DOM   Memory.getDOMCounters — live nodes, documents and JS event
 *                     listeners in the renderer;
 *   - detached DOM    the app creates and removes no DOM nodes at all, and every
 *                     createElement/appendChild/removeChild is counted, so a
 *                     retained detached subtree cannot appear unmeasured (the
 *                     app only flips classes and attributes on the one button);
 *   - timers/fetches  the page must drain to zero pending timers, intervals and
 *                     fetches between cycles (tests/support/quiescence.mjs).
 *
 * Nothing here is in the fast gate on purpose: a soak is minutes long. Like the
 * acceptance pass, it is explicit-only (see tools/suite-map.tsv).
 *
 * Usage:
 *   npm run build && node tools/soak.mjs [options]
 *
 *   --cycles <n>      horn start/stop cycles (default 240, minimum 200)
 *   --updates <n>     service-worker versions to publish over the controller (default 3)
 *   --offline <n>     offline/online toggles (default 4)
 *   --out <dir>       evidence directory (default /tmp/airhorn-soak/<sha>-<stamp>)
 *   --heap-budget <mb>  retained-heap growth allowed across the cycles (default 8)
 *
 * Exits 0 only when every check passes; report.json + screenshots are the evidence.
 */

import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence } from '../tests/support/quiescence.mjs';
import { chromeBin, connectPage, launchChrome } from './lib/chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

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
  '.webmanifest': 'application/manifest+json',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Injected leaks, used to prove this harness can actually fail (--mutant).
 * A soak that passes because it measures nothing is the worst kind of green, so
 * every counter below has a mutant that must turn its check red:
 *
 *   source-leak    the page keeps every buffer source it starts (the leak the
 *                  app's own Set would hide: 'ended' still fires, so only the
 *                  heap cross-check sees it);
 *   listener-leak  one document listener added per blast; the renderer's
 *                  listener count has to climb;
 *   heap-leak      1 MB retained per blast; the retained heap has to climb.
 */
const MUTANTS = {
  none: '',
  'source-leak': `
    (() => {
      window.__mutantLeak = [];
      const proto = AudioContext.prototype;
      const create = proto.createBufferSource;
      proto.createBufferSource = function (...args) {
        const node = create.apply(this, args);
        window.__mutantLeak.push(node);
        return node;
      };
    })();
  `,
  'listener-leak': `
    (() => {
      const proto = AudioContext.prototype;
      const create = proto.createBufferSource;
      proto.createBufferSource = function (...args) {
        const node = create.apply(this, args);
        window.__mutantLeak = window.__mutantLeak || [];
        // A FRESH closure per registration: the same function object would be
        // de-duplicated by the event target and leak nothing.
        const leak = () => { window.__mutantLeak.push(1); };
        window.__mutantLeak.push(leak);
        document.addEventListener('soak-mutant', leak);
        return node;
      };
    })();
  `,
  'heap-leak': `
    (() => {
      window.__mutantLeak = [];
      const proto = AudioContext.prototype;
      const create = proto.createBufferSource;
      proto.createBufferSource = function (...args) {
        const node = create.apply(this, args);
        window.__mutantLeak.push(new Uint8Array(1024 * 1024));
        return node;
      };
    })();
  `,
};

/* ------------------------------- options ---------------------------------- */

const HELP = `
Usage: node tools/soak.mjs [options]     (run "npm run build" first)

  --cycles <n>        horn start/stop cycles (default 240)
  --updates <n>       service-worker versions published over the controller (default 3)
  --offline <n>       offline/online toggles (default 4)
  --out <dir>         evidence directory (default /tmp/airhorn-soak/<sha>-<stamp>)
  --heap-budget <mb>  retained-heap growth allowed across the cycles (default 8)
  --mutant <name>     inject a known leak to prove the checks can fail:
                      none | source-leak | listener-leak | heap-leak
  --help              this text

Exits 0 only when every check passes; report.json + a screenshot are the evidence.
`;

function parseArgs(argv) {
  const options = {
    cycles: 240,
    updates: 3,
    offline: 4,
    out: null,
    heapBudgetMb: 8,
    mutant: 'none',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--cycles': options.cycles = Number(value()); break;
      case '--updates': options.updates = Number(value()); break;
      case '--offline': options.offline = Number(value()); break;
      case '--out': options.out = value(); break;
      case '--heap-budget': options.heapBudgetMb = Number(value()); break;
      case '--mutant': options.mutant = value(); break;
      case '--help': case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isFinite(options.cycles) || options.cycles < 1) throw new Error('--cycles must be positive');
  if (!Number.isFinite(options.updates) || options.updates < 0) throw new Error('--updates must be >= 0');
  if (!Number.isFinite(options.offline) || options.offline < 0) throw new Error('--offline must be >= 0');
  if (!(options.mutant in MUTANTS)) {
    throw new Error(`unknown mutant ${options.mutant} (one of ${Object.keys(MUTANTS).join(', ')})`);
  }
  return options;
}

function makeEvidenceDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SOAK_OUT) return process.env.SOAK_OUT;
  let sha = 'worktree';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch {
    // not a git checkout: keep the default name
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('/tmp/airhorn-soak', `${sha}-${stamp}`);
}

/* ------------------------------------------------------------------------- *
 * Instrumentation installed before any page script runs.
 *
 *  - counts AudioContext constructions, buffer sources and oscillators, and
 *    pairs every start with its `ended` event, so "live" is a node the app has
 *    not released (the heap graph would hide a leak until GC pressure);
 *  - stashes the two node prototypes so the sampler can cross-check those
 *    counters against the real heap with Runtime.queryObjects;
 *  - counts DOM node creation/removal: this app mutates one button's classes
 *    and attributes and nothing else, so any non-zero count is news;
 *  - spies on the app badge, which the horn writes on every blast;
 *  - installs a spec-shaped `document.modelContext` stand-in when the browser
 *    has no WebMCP, so the tool path is exercised on either build of Chrome.
 * ------------------------------------------------------------------------- */
const instrumentation = (mutantScript) => `
  (() => {
    const soak = {
      contexts: 0,
      sourcesCreated: 0,
      sourcesEnded: 0,
      oscillatorsCreated: 0,
      oscillatorsEnded: 0,
      domNodesCreated: 0,
      domNodesRemoved: 0,
      protos: { source: null, oscillator: null },
    };
    window.__soak = soak;
    window.__badge = { calls: 0, cleared: 0 };
    window.__pageErrors = [];
    window.addEventListener('error', (e) => {
      window.__pageErrors.push(e.message || (e.error ? String(e.error) : String(e)));
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__pageErrors.push((e.reason && e.reason.message) || String(e.reason));
    });

    // One 'ended' event per node, counted once even if something re-fires it.
    const onceEnded = (counter) => {
      let counted = false;
      return () => {
        if (counted) return;
        counted = true;
        soak[counter] += 1;
      };
    };

    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const proto = AC.prototype;

      const createBufferSource = proto.createBufferSource;
      proto.createBufferSource = function (...args) {
        const node = createBufferSource.apply(this, args);
        soak.sourcesCreated += 1;
        if (!soak.protos.source) soak.protos.source = Object.getPrototypeOf(node);
        node.addEventListener('ended', onceEnded('sourcesEnded'), { once: true });
        return node;
      };

      const createOscillator = proto.createOscillator;
      proto.createOscillator = function (...args) {
        const node = createOscillator.apply(this, args);
        soak.oscillatorsCreated += 1;
        if (!soak.protos.oscillator) soak.protos.oscillator = Object.getPrototypeOf(node);
        node.addEventListener('ended', onceEnded('oscillatorsEnded'), { once: true });
        return node;
      };

      // The app constructs exactly one AudioContext per document; count them so
      // "one per blast" would show up as 240 instead of 1.
      window.AudioContext = function SoakCountedAudioContext(...args) {
        const context = new AC(...args);
        soak.contexts += 1;
        return context;
      };
      window.AudioContext.prototype = proto;
      if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext;
    }

    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (...args) {
      soak.domNodesCreated += 1;
      return createElement.apply(this, args);
    };
    for (const method of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']) {
      const original = Node.prototype[method];
      if (typeof original !== 'function') continue;
      Node.prototype[method] = function (...args) {
        if (method === 'removeChild') soak.domNodesRemoved += 1;
        return original.apply(this, args);
      };
    }

    try {
      Object.defineProperty(Navigator.prototype, 'setAppBadge', {
        configurable: true,
        value: function () { window.__badge.calls += 1; return Promise.resolve(); },
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
        options && options.signal && options.signal.addEventListener(
          'abort', () => tools.delete(tool.name), { once: true });
        shim.dispatchEvent(new Event('toolchange'));
      };
      shim.getTools = async () => [...tools.values()].map(
        ({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }),
      );
      shim.executeTool = async (tool, input, options = {}) => {
        const name = typeof tool === 'string' ? tool : (tool && tool.name);
        const definition = tools.get(name);
        if (!definition) throw new Error('Unknown tool "' + name + '"');
        const inputObject = typeof input === 'string' ? JSON.parse(input) : (input || {});
        return JSON.stringify(await definition.execute(inputObject, options || {}));
      };
      Object.defineProperty(document, 'modelContext', { configurable: true, value: shim });
      window.__webmcpSource = 'stand-in';
    } else {
      window.__webmcpSource = 'native';
    }

    // Agent-shaped helper: discover the tool, then invoke it. Chrome <155 takes
    // the input as a JSON string, so fall back to that like the WebMCP suite.
    window.__call = async (name, input) => {
      const payload = input || {};
      const tools = await document.modelContext.getTools();
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error('Unknown tool "' + name + '"');
      window.__soak.toolCalls = (window.__soak.toolCalls || 0) + 1;
      let raw;
      try {
        raw = await document.modelContext.executeTool(tool, payload, {});
      } catch (err) {
        if (!String(err && err.message).startsWith('Failed to parse input')) throw err;
        raw = await document.modelContext.executeTool(tool, JSON.stringify(payload), {});
      }
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };

    ${quiescenceProbe}

    ${mutantScript}
  })();
`;

/* --------------------------------- report --------------------------------- */

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(pass);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Does a series rise at every step, by more than `tolerance`? One sample that
 * gives memory back is enough to say "not monotonic" — allocators are chunky and
 * a flat leak plus GC noise still shows as a sawtooth, so the question worth
 * asking is whether the floor keeps climbing.
 */
function growsMonotonically(values, tolerance) {
  if (values.length < 3) return false;
  return values.slice(1).every((value, index) => value - values[index] > tolerance);
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(distDir)) {
    throw new Error(`dist/ is missing: run "npm run build" first (looked in ${distDir})`);
  }

  const evidenceDir = makeEvidenceDir(options.out);
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const heapBudget = options.heapBudgetMb * 1024 * 1024;

  // The worker body is served from dist/sw.js; publishing a new version means
  // changing the stamped version constant, exactly like a real deployment
  // (a new cache name, so the activate handler has something to clean up).
  const worker = { version: null };
  const builtWorker = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf-8');

  const server = http.createServer((req, res) => {
    if (worker.unpublished) {
      req.destroy();
      return;
    }
    const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (requestPath === '/sw.js' && worker.version) {
      const body = builtWorker.replace(/const version = "[^"]+"/, `const version = "${worker.version}"`);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    let filePath = path.join(distDir, requestPath === '/' ? 'index.html' : requestPath);
    if (!path.resolve(filePath).startsWith(path.resolve(distDir)) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Service-Worker-Allowed': '/',
      // no-store: a re-fetch after an update must reach this origin, not an
      // HTTP-cache copy of the previous build.
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  // One launcher owns chrome, its process tree and its profile (airhorn-2po9):
  // flag family, startup bound, /json/list discovery and the page ws bound all
  // live in tools/lib/chrome.mjs, so a soak that is bound-killed mid-run leaks
  // nothing the other tools would not.
  let browser = null;
  let ws = null;

  try {
    /* -------------------------------- browser ------------------------------- */
    browser = await launchChrome({
      label: 'soak-profile',
      autoplay: true,
      webmcp: true,
      timeoutMs: 20000,
      discoveryMs: 20000,
    });
    ws = await connectPage(browser, { label: 'soak-profile', timeoutMs: 20000 });

    let msgId = 1;
    const pending = new Map();
    const pageConsole = [];
    const navigations = [];

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        pageConsole.push({ type: 'error', text: details?.exception?.description || details?.text || 'Uncaught exception' });
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        pageConsole.push({
          type: 'error',
          text: (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '),
        });
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        pageConsole.push({ type: 'error', text: message.params.entry.text });
      } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        navigations.push({ url: message.params.frame.url, at: Date.now() });
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };

    const send = (method, params = {}) => {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        // The reply wait is bounded like every wait in this file (airhorn-kduy,
        // the nbh9 class): a peer that completes the upgrade and swallows the
        // frame rejects labelled instead of parking the soak with its launch
        // alive and its cleanup unrun.
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

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
        await sleep(25);
      }
      throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
    };

    const waitUntil = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(data, 'base64'));
      return name;
    };

    /* --------------------------- heap instrumentation ---------------------- */
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Memory.enable').catch(() => {});
    await send('HeapProfiler.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation(MUTANTS[options.mutant]) });

    /** Count objects of a prototype still reachable in the heap. */
    const countInstances = async (expression) => {
      const group = `soak-count-${msgId}`;
      try {
        const proto = await send('Runtime.evaluate', { expression, objectGroup: group });
        const prototypeObjectId = proto.result?.objectId;
        if (!prototypeObjectId) return null;
        // CDP returns ONE RemoteObject: the array of matching objects, not an
        // array of RemoteObjects.
        const { objects } = await send('Runtime.queryObjects', { prototypeObjectId, objectGroup: group });
        const arrayId = objects?.objectId;
        if (!arrayId) return null;
        const counted = await send('Runtime.callFunctionOn', {
          objectId: arrayId,
          functionDeclaration: 'function () { return this.length; }',
          returnByValue: true,
        });
        return counted.result?.value ?? null;
      } finally {
        await send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
      }
    };

    const readDomCounters = async () => {
      try {
        return await send('Memory.getDOMCounters');
      } catch {
        return { documents: null, nodes: null, jsEventListeners: null };
      }
    };

    /**
     * One measurement point: the page has settled (its own timers, intervals and
     * fetches drained), garbage has been collected, and then everything the soak
     * cares about is read. Every number is taken *after* GC so it is memory the
     * page is keeping, not memory it has already dropped.
     */
    const sample = async (label, { settle = true } = {}) => {
      const quiet = settle
        ? await waitForQuiescence(send, {
          quietExpression: '!window.__airhorn?.isPlaying?.()',
          timeoutMs: 10000,
          stableSamples: 2,
          pollMs: 25,
        })
        : null;

      await send('HeapProfiler.collectGarbage');
      const heap = await send('Runtime.getHeapUsage');
      // V8's used heap alone misses typed-array backing stores, which is exactly
      // the shape of an audio leak (a retained AudioBuffer is PCM in a
      // ArrayBuffer): measure both, and keep the parts in the sample.
      const heapUsed = heap.usedSize + (heap.backingStorageSize || 0);
      const dom = await readDomCounters();
      const inPage = await evaluate(`(() => {
        const s = window.__soak;
        const q = window.__quiescence;
        return {
          contexts: s.contexts,
          sourcesCreated: s.sourcesCreated,
          sourcesEnded: s.sourcesEnded,
          oscillatorsCreated: s.oscillatorsCreated,
          oscillatorsEnded: s.oscillatorsEnded,
          liveSources: s.sourcesCreated - s.sourcesEnded,
          liveOscillators: s.oscillatorsCreated - s.oscillatorsEnded,
          domNodesCreated: s.domNodesCreated,
          domNodesRemoved: s.domNodesRemoved,
          toolCalls: s.toolCalls || 0,
          badgeCalls: window.__badge.calls,
          playing: window.__airhorn?.isPlaying?.() ?? null,
          usingFallback: window.__airhorn?.usingFallback ?? null,
          pendingTimers: q ? q.pendingTimers : null,
          pendingIntervals: q ? q.pendingIntervals : null,
          pendingFetches: q ? q.pendingFetches : null,
          errors: window.__pageErrors.length,
        };
      })()`);

      return {
        label,
        at: new Date().toISOString(),
        heapUsed,
        heapV8: heap.usedSize,
        heapBackingStorage: heap.backingStorageSize ?? null,
        heapEmbedder: heap.embedderHeapUsedSize ?? null,
        heapTotal: heap.totalSize,
        documents: dom.documents,
        nodes: dom.nodes,
        listeners: dom.jsEventListeners,
        heapAudioContexts: await countInstances('window.AudioContext.prototype'),
        heapBufferSources: await countInstances('window.__soak?.protos?.source || null'),
        heapOscillators: await countInstances('window.__soak?.protos?.oscillator || null'),
        quiescenceMs: quiet ? quiet.waitedMs : null,
        ...inPage,
      };
    };

    /* ------------------------------- load the app -------------------------- */
    if (options.mutant !== 'none') {
      console.log(`soak: MUTANT ${options.mutant} injected - the checks it targets are EXPECTED to fail`);
    }
    console.log(`soak: ${chromeBin()} against ${origin} (cycles=${options.cycles}, ` +
      `updates=${options.updates}, offline toggles=${options.offline})`);
    await send('Page.navigate', { url: `${origin}/` });
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('.horn') && !!window.__airhorn`,
      20000, 'the app to boot');
    await waitFor(`navigator.serviceWorker.ready.then((reg) => reg.active ? reg.active.state === 'activated' : false)`,
      20000, 'the service worker to activate');

    // Reload once now that a worker exists. The page only reloads itself on
    // controllerchange when it was ALREADY controlled at parse time ("a first
    // install is silent", index.html), so this document would otherwise never
    // take part in the update/reload path - and a returning visitor always is
    // controlled. It also gives the soak a page whose audio context, listeners
    // and heap are established under the worker, the way a real session is.
    await send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('.horn') && !!window.__airhorn`,
      20000, 'the app to boot under the worker');
    await waitFor('!!navigator.serviceWorker.controller', 10000, 'the document to be worker-controlled');

    const chromeVersion = await evaluate('navigator.userAgent');
    const webmcpSource = await evaluate('window.__webmcpSource || "none"');
    console.log(`soak: ${chromeVersion.slice(0, 60)}... webmcp=${webmcpSource}`);

    const cycleKinds = { tool: 0, pointer: 0, keyboard: 0, instant: 0 };
    const played = { ok: 0, failed: [] };

    const hornCentre = () => evaluate(`(() => {
      const rect = document.querySelector('.horn').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);

    const waitPlaying = (label) => waitFor('window.__airhorn.isPlaying()', 5000, `the horn to sound (${label})`);
    const waitSilent = (label) => waitFor('!window.__airhorn.isPlaying()', 8000, `the horn to go silent (${label})`);

    /* one cycle per shape a real session has */
    async function cycleTool(index) {
      cycleKinds.tool += 1;
      const played_ = await evaluate(`window.__call('play_horn', { loop: true })`);
      await waitPlaying(`tool ${index}`);
      await sleep(70);
      const stopped = await evaluate(`window.__call('stop_horn', {})`);
      await waitSilent(`tool ${index}`);
      return { sounded: played_.playing === true, stopped: stopped.playing === false };
    }

    async function cyclePointer(index) {
      cycleKinds.pointer += 1;
      const centre = await hornCentre();
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', clickCount: 1, buttons: 1,
      });
      await waitPlaying(`pointer ${index}`);
      await sleep(110);
      const pressed = await evaluate(`document.querySelector('.horn').getAttribute('aria-pressed')`);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', clickCount: 1, buttons: 0,
      });
      // Pointer release is the non-immediate path: the sample rings out, so
      // this cycle also proves the ring-out releases its node.
      await waitSilent(`pointer ${index}`);
      return { sounded: pressed === 'true', stopped: true };
    }

    async function cycleKeyboard(index) {
      cycleKinds.keyboard += 1;
      await evaluate(`document.querySelector('.horn').focus()`);
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ',
      });
      await waitPlaying(`keyboard ${index}`);
      await sleep(110);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
      });
      await waitSilent(`keyboard ${index}`);
      return { sounded: true, stopped: true };
    }

    async function cycleInstant(index) {
      cycleKinds.instant += 1;
      await evaluate(`location.hash = '#instant'`);
      await waitPlaying(`instant ${index}`);
      await waitSilent(`instant ${index}`);
      await evaluate(`location.hash = ''`);
      await sleep(30);
      return { sounded: true, stopped: true };
    }

    /* ------------------------------ A. cycles ------------------------------ */
    console.log('\n--- A. horn cycles ---');
    const samples = [];

    // Warm up before the baseline: the first blast pays for the sample decode,
    // the AudioContext unlock and the WebMCP registration, and none of that is
    // a leak, so measuring it as "growth" would be noise.
    for (let i = 0; i < 5; i += 1) await cycleTool(i);
    // The warm-up is not part of the measured phase: report the mix of the
    // `--cycles` cycles only, or the kinds would not add up to that number.
    for (const kind of Object.keys(cycleKinds)) cycleKinds[kind] = 0;
    played.ok = 0;
    await waitSilent('warmup');
    const baseline = await sample('baseline');
    samples.push(baseline);
    console.log(`  baseline: heap ${mb(baseline.heapUsed)} MB, ${baseline.listeners} listeners, ` +
      `${baseline.nodes} nodes, ${baseline.heapAudioContexts} AudioContext`);

    const sampleEvery = Math.max(10, Math.round(options.cycles / 6));
    for (let i = 0; i < options.cycles; i += 1) {
      let result;
      if (i % 12 === 0) result = await cycleKeyboard(i);
      else if (i % 6 === 0) result = await cyclePointer(i);
      else if (i % 20 === 0) result = await cycleInstant(i);
      else result = await cycleTool(i);

      if (result.sounded && result.stopped) played.ok += 1;
      else played.failed.push(i);

      if ((i + 1) % sampleEvery === 0) {
        const point = await sample(`cycle-${i + 1}`);
        samples.push(point);
        console.log(`  after ${i + 1} cycles: heap ${mb(point.heapUsed)} MB, ` +
          `live sources ${point.liveSources}/${point.heapBufferSources}, ` +
          `${point.listeners} listeners, ${point.nodes} nodes`);
      }
    }
    await waitForQuiescence(send, {
      quietExpression: '!window.__airhorn.isPlaying()', timeoutMs: 10000, stableSamples: 3, pollMs: 25,
    });
    const afterCycles = await sample('after-cycles');
    samples.push(afterCycles);

    const cycleCheck = check(
      `every one of the ${options.cycles} cycles sounded and stopped`,
      played.ok === options.cycles,
      `${played.ok}/${options.cycles} (tool ${cycleKinds.tool}, pointer ${cycleKinds.pointer}, ` +
      `keyboard ${cycleKinds.keyboard}, instant ${cycleKinds.instant})` +
      (played.failed.length ? `; stuck at ${played.failed.slice(0, 8).join(', ')}` : ''),
    );

    const cycleSamples = samples.filter((point) => point.label === 'baseline' || point.label.startsWith('cycle-'));
    const heapSeries = cycleSamples.map((point) => point.heapUsed);
    const heapGrowth = median(heapSeries.slice(-2)) - median(heapSeries.slice(0, 2));
    const heapMonotonic = growsMonotonically(heapSeries, 256 * 1024);

    const heapCheck = check(
      'retained heap does not grow across the cycles',
      heapGrowth < heapBudget && !heapMonotonic,
      `${heapSeries.map((bytes) => mb(bytes)).join(' -> ')} MB, growth ${mb(heapGrowth)} MB ` +
      `(budget ${options.heapBudgetMb} MB, monotonic=${heapMonotonic})`,
    );

    const liveSourcesMax = Math.max(...samples.map((point) => point.liveSources));
    const heapSourcesMax = Math.max(...samples.map((point) => point.heapBufferSources ?? 0));
    const liveCheck = check(
      'audio nodes are released after every cycle',
      liveSourcesMax <= 2 && heapSourcesMax <= 2 && afterCycles.liveSources === 0,
      `live sources max ${liveSourcesMax} (heap ${heapSourcesMax}), oscillators max ` +
      `${Math.max(...samples.map((point) => point.liveOscillators))}, ` +
      `sources created ${afterCycles.sourcesCreated} / ended ${afterCycles.sourcesEnded}`,
    );

    const contextMax = Math.max(...samples.map((point) => point.heapAudioContexts ?? 0));
    const contextMin = Math.min(...samples.map((point) => point.heapAudioContexts ?? 0));
    const contextCheck = check(
      'the app keeps one AudioContext, not one per blast',
      contextMax === 1 && contextMin === 1,
      `heap AudioContexts ${contextMin}..${contextMax}, constructed ${afterCycles.contexts} across the session ` +
      '(the page reloads once per update/offline toggle later, so one per document is expected)',
    );

    const listenerSeries = samples.map((point) => point.listeners).filter((value) => value !== null);
    const listenerDelta = listenerSeries.length ? Math.max(...listenerSeries) - Math.min(...listenerSeries) : null;
    const nodeSeries = samples.map((point) => point.nodes).filter((value) => value !== null);
    const nodeDelta = nodeSeries.length ? Math.max(...nodeSeries) - Math.min(...nodeSeries) : null;
    const listenerCheck = check(
      'renderer listeners and nodes stay flat',
      listenerDelta !== null && listenerDelta <= 2 && nodeDelta !== null && nodeDelta <= 2,
      `listeners ${Math.min(...listenerSeries)}..${Math.max(...listenerSeries)} (delta ${listenerDelta}), ` +
      `nodes ${Math.min(...nodeSeries)}..${Math.max(...nodeSeries)} (delta ${nodeDelta})`,
    );

    const domCheck = check(
      'the session creates no DOM nodes (so no detached subtree can be retained)',
      afterCycles.domNodesCreated === baseline.domNodesCreated &&
      afterCycles.domNodesRemoved === baseline.domNodesRemoved,
      `createElement ${baseline.domNodesCreated} -> ${afterCycles.domNodesCreated}, ` +
      `append/insert/remove ${baseline.domNodesRemoved} -> ${afterCycles.domNodesRemoved} ` +
      '(boot-time creation by the browser tooling is not the app; the cycle phase must add none)',
    );

    const drainCheck = check(
      'the page drains after every sample (no timers, intervals or fetches left pending)',
      samples.every((point) => point.pendingTimers === 0 && point.pendingIntervals === 0 && point.pendingFetches === 0),
      samples.map((point) => `${point.label}:${point.pendingTimers}/${point.pendingIntervals}/${point.pendingFetches}`)
        .join(' '),
    );

    /* ------------------------------ B. updates ----------------------------- */
    console.log('\n--- B. service-worker updates ---');
    const updateResults = [];
    for (let i = 1; i <= options.updates; i += 1) {
      worker.version = `2.0.0-soak${i}`;
      const reloadsBefore = navigations.length;
      await evaluate(`(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration.update();
        return registration.installing ? registration.installing.state : null;
      })()`);
      // The new worker precaches under its own cache name, activates (deleting
      // the previous caches), claims the page - and the page reloads once on
      // controllerchange. Wait for the sweep, then for that one navigation.
      await waitFor(
        `caches.keys().then((keys) => keys.length === 2 && keys.every((key) => key.includes('soak${i}')))`,
        20000, `worker ${i} to replace its caches`);
      await waitUntil(() => navigations.length > reloadsBefore, 20000, `the page to reload for worker ${i}`);
      const reloads = navigations.length - reloadsBefore;
      await sleep(300);

      // A fresh document means a fresh window: re-wait for the app and prove the
      // horn still works with the new worker in charge.
      await waitFor(`document.readyState === 'complete' && !!window.__airhorn && !!window.__soak`,
        20000, `the app to boot after update ${i}`);
      const caches = await evaluate(`caches.keys()`);
      const cacheEntries = await evaluate(`(async () => {
        const keys = await caches.keys();
        const out = {};
        for (const key of keys) {
          const cache = await caches.open(key);
          out[key] = (await cache.keys()).length;
        }
        return out;
      })()`);
      const playedAfter = await evaluate(`window.__call('play_horn', { loop: true })`);
      await waitFor('window.__airhorn.isPlaying()', 5000, `the horn to sound under worker ${i}`);
      await evaluate(`window.__call('stop_horn', {})`);
      await waitFor('!window.__airhorn.isPlaying()', 8000, `the horn to stop under worker ${i}`);

      const appCaches = caches.filter((key) => key.startsWith('airhorner-'));
      const metaCaches = caches.filter((key) => key.startsWith('horn-integrity-'));
      const replacesOnly = appCaches.length === 1 && metaCaches.length === 1 &&
        appCaches[0].includes(`soak${i}`) && metaCaches[0].includes(`soak${i}`);

      updateResults.push({
        version: worker.version,
        reloads,
        caches,
        cacheEntries,
        replacesOnly,
        played: playedAfter.playing === true,
      });
      console.log(`  update ${i}: reloads ${reloads}, caches ${JSON.stringify(caches)}, ` +
        `entries ${JSON.stringify(cacheEntries)}, played=${playedAfter.playing}`);

      // Sample after the reload so the next update's caches are measured from a
      // clean document rather than one that has already been torn down.
      if (i === options.updates) samples.push(await sample(`after-update-${i}`));
    }
    worker.version = null;

    const updateCheck = options.updates === 0 ? null : check(
      `${options.updates} service-worker updates each replace their caches and reload once`,
      updateResults.every((result) => result.replacesOnly && result.reloads === 1 && result.played),
      updateResults.map((result) => `#${result.version}: reloads=${result.reloads} ` +
        `caches=[${result.caches.join(', ')}] played=${result.played}`).join('; '),
    );

    /* ------------------------------ C. offline ----------------------------- */
    console.log('\n--- C. offline/online toggles ---');
    const offlineResults = [];
    for (let i = 1; i <= options.offline; i += 1) {
      await send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
      await send('Page.reload');
      const shell = await waitFor(`document.readyState === 'complete' && !!document.querySelector('.horn')`,
        15000, `the cached shell offline (toggle ${i})`).then(() => true).catch(() => false);
      await waitFor(`!!window.__airhorn && !!window.__soak`, 20000, `the app to boot offline (toggle ${i})`);
      const controlled = await evaluate('!!navigator.serviceWorker.controller');
      const playedOffline = await evaluate(`window.__call('play_horn', { loop: true })`);
      await waitFor('window.__airhorn.isPlaying()', 5000, `the horn to sound offline (toggle ${i})`);
      const fallbackOffline = await evaluate('window.__airhorn.usingFallback');
      await evaluate(`window.__call('stop_horn', {})`);
      await waitFor('!window.__airhorn.isPlaying()', 8000, `the horn to stop offline (toggle ${i})`);
      const offlineSample = await sample(`offline-${i}`);
      samples.push(offlineSample);

      await send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await send('Page.reload');
      await waitFor(`document.readyState === 'complete' && !!window.__airhorn && !!window.__soak`,
        20000, `the app to boot back online (toggle ${i})`);
      const playedOnline = await evaluate(`window.__call('play_horn', { loop: true })`);
      await waitFor('window.__airhorn.isPlaying()', 5000, `the horn to sound back online (toggle ${i})`);
      await evaluate(`window.__call('stop_horn', {})`);
      await waitFor('!window.__airhorn.isPlaying()', 8000, `the horn to stop back online (toggle ${i})`);

      offlineResults.push({
        toggle: i,
        shell,
        controlled,
        playedOffline: playedOffline.playing === true,
        fallbackOffline,
        playedOnline: playedOnline.playing === true,
        heapUsed: offlineSample.heapUsed,
      });
      console.log(`  toggle ${i}: shell=${shell} controlled=${controlled} ` +
        `played offline=${playedOffline.playing} (fallback=${fallbackOffline}) ` +
        `played online=${playedOnline.playing} heap ${mb(offlineSample.heapUsed)} MB`);
    }

    const offlineCheck = options.offline === 0 ? null : check(
      `${options.offline} offline reloads render from cache and still play`,
      offlineResults.every((result) => result.shell && result.controlled && result.playedOffline && result.playedOnline),
      offlineResults.map((result) => `#${result.toggle}: shell=${result.shell} ` +
        `offline=${result.playedOffline} online=${result.playedOnline}`).join('; '),
    );

    const offlineHeap = offlineResults.map((result) => result.heapUsed);
    const offlineGrowth = offlineHeap.length ? median(offlineHeap.slice(-2)) - median(offlineHeap.slice(0, 2)) : 0;
    const offlineHeapCheck = offlineHeap.length < 2 ? null : check(
      'heap after repeated reloads stays bounded',
      offlineGrowth < heapBudget && !growsMonotonically(offlineHeap, 256 * 1024),
      `${offlineHeap.map((bytes) => mb(bytes)).join(' -> ')} MB, growth ${mb(offlineGrowth)} MB`,
    );

    /* ------------------------------- D. settle ----------------------------- */
    console.log('\n--- D. settle ---');
    const finalSample = await sample('final');
    samples.push(finalSample);
    const errors = await evaluate('window.__pageErrors.slice(0, 10)');
    await shot('soak-final.png');

    const errorCheck = check(
      'no page errors during the session',
      pageConsole.length === 0 && errors.length === 0,
      [...pageConsole.map((entry) => entry.text), ...errors].slice(0, 5).join(' | ') || 'none',
    );

    const finalDrainCheck = check(
      'the page is quiescent at the end',
      finalSample.pendingTimers === 0 && finalSample.pendingIntervals === 0 && finalSample.pendingFetches === 0 &&
      finalSample.playing === false,
      `timers=${finalSample.pendingTimers} intervals=${finalSample.pendingIntervals} ` +
      `fetches=${finalSample.pendingFetches} playing=${finalSample.playing}`,
    );

    /* -------------------------------- report ------------------------------- */
    const failures = checks.filter((entry) => !entry.pass);
    const summary = {
      pass: failures.length === 0,
      failures: failures.map((entry) => `${entry.name}: ${entry.detail}`),
    };

    const report = {
      airhorn: {
        sha: (() => {
          try { return execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch { return 'unknown'; }
        })(),
        origin,
        chrome: chromeVersion,
        webmcp: webmcpSource,
        heapBudgetMb: options.heapBudgetMb,
        mutant: options.mutant,
      },
      plan: { cycles: options.cycles, updates: options.updates, offlineToggles: options.offline },
      phases: {
        cycles: { kinds: cycleKinds, played: played.ok, stuck: played.failed },
        updates: updateResults,
        offline: offlineResults,
      },
      series: {
        heapUsedMb: samples.map((point) => ({ label: point.label, mb: Number(mb(point.heapUsed)) })),
        liveSources: samples.map((point) => ({ label: point.label, live: point.liveSources, heap: point.heapBufferSources })),
        listeners: listenerSeries,
        nodes: nodeSeries,
      },
      samples,
      checks,
      summary,
    };
    fs.writeFileSync(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

    console.log(`\nsoak: ${summary.pass ? 'PASS' : 'FAIL'} — ` +
      `${options.cycles} cycles, ${options.updates} worker updates, ${options.offline} offline toggles`);
    console.log(`  heap (after GC): ${heapSeries.map((bytes) => mb(bytes)).join(' -> ')} MB ` +
      `(growth ${mb(heapGrowth)} MB, budget ${options.heapBudgetMb} MB)`);
    console.log(`  audio: contexts ${contextMin}..${contextMax}, live sources max ${liveSourcesMax}, ` +
      `created ${afterCycles.sourcesCreated}, ended ${afterCycles.sourcesEnded}`);
    console.log(`  renderer: listeners delta ${listenerDelta}, nodes delta ${nodeDelta}, ` +
      `documents ${finalSample.documents}`);
    console.log(`  evidence: ${evidenceDir}`);
    if (!summary.pass) {
      console.log(`  failures:`);
      for (const failure of summary.failures) console.log(`   - ${failure}`);
    }

    // Keep the tree honest: a busy check that the caller forgot to assert on
    // would be dead weight, so every check above is at least referenced here.
    void [cycleCheck, heapCheck, liveCheck, contextCheck, listenerCheck, domCheck, drainCheck,
      updateCheck, offlineCheck, offlineHeapCheck, errorCheck, finalDrainCheck];

    return summary.pass ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    // The handle's teardown is the launcher's: marker sweep, tree kill, profile
    // rm - and the rm runs before its first await (airhorn-5xqi's writeback
    // race cannot recreate Default/ after it).
    if (browser) await browser.close();
  }
}

main().then((code) => {
  // Same drain the catch has: even a PASSING soak against a peer that
  // swallows the ws close-frame holds the event loop on the half-open socket
  // after every check has passed (airhorn-uenq). The summary and report are
  // written by the time main() resolves; nothing legitimate is pending.
  process.exit(code);
}).catch((err) => {
  console.error(`soak: FAIL — ${err.message}`);
  // Hard exit: a hostile peer that swallowed frames also swallows the ws
  // close-frame, so teardown's ws.close() never completes and the socket
  // holds the event loop past the finally (airhorn-kduy; cache-growth's
  // catch does the same).
  process.exit(1);
});
