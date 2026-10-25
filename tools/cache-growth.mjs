#!/usr/bin/env node
/*
 * tools/cache-growth.mjs — does a returning user's CacheStorage stay bounded
 * across deploys? (airhorn-qij)
 *
 * Every deploy ships new content-hashed assets, and this worker precaches them
 * under a cache name stamped with the build. That is exactly the shape that
 * grows without bound on a device that comes back after a few releases: one
 * precache (plus its integrity record cache) per version, each holding a shell,
 * a stylesheet, the sample and a *new* hashed JS bundle that nothing else can
 * use. The worker's activate handler is supposed to delete every previous
 * version — this tool measures whether it actually does, in one browser
 * profile, over ten successive builds.
 *
 * Per version it records:
 *   - the cache names that exist, so a leftover is named rather than inferred;
 *   - entries and stored bytes per cache (read back with cache.match() and
 *     arrayBuffer(), so the number is what the device is holding, not what the
 *     build produced);
 *   - navigator.storage.estimate() usage (and its `usageDetails`, when Chrome
 *     reports them), the number a real device runs out of;
 *   - whether the previous versions' hashed assets are still readable from
 *     cache, and whether the origin still serves them (it must not: the build
 *     that named them is gone).
 *
 * The builds are simulated by copying dist/ per version and renaming the hashed
 * bundle (appending a marker byte, as a real rebuild would), rewriting the
 * references in index.html and the worker's precache list, and stamping a new
 * worker version. So each version has a distinct hashed asset, a distinct cache
 * name and new bytes — the conditions under which caches accumulate.
 *
 * Asserted: every deploy leaves exactly the current version's two caches, the
 * precache keeps the same entry count, stored bytes do not grow, nothing from
 * one or two versions ago survives (in cache or from the network), origin usage
 * stays bounded, and the horn still plays under each new worker.
 *
 * --mutant keep-old-caches serves a worker whose activate handler deletes
 * nothing, and the growth checks must then go red — a storage check that cannot
 * fail is a false green (airhorn-a6u).
 *
 * Explicit-only, like the soak and the acceptance pass: it installs ten builds
 * and reloads the page ten times, so it has no business in the fast gate.
 *
 * Usage:
 *   npm run build && node tools/cache-growth.mjs [--versions 10] [--mutant none|keep-old-caches]
 *
 * Exits 0 only when every check passes; report.json + a screenshot are the evidence.
 */

import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence } from '../tests/support/quiescence.mjs';
import { connectPage, launchChrome } from './lib/chrome.mjs';

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

const HELP = `
Usage: node tools/cache-growth.mjs [options]     (run "npm run build" first)

  --versions <n>   successive builds installed into one browser profile (default 10)
  --out <dir>      evidence directory (default /tmp/airhorn-cache-growth/<sha>-<stamp>)
  --mutant <name>  inject a known regression to prove the checks can fail:
                   none | keep-old-caches
  --self-check     browser-free proof that the exact-entry predicate rejects a
                   same-count substitution, a missing entry, an extra entry and
                   a duplicate standing in for a missing path (airhorn-3ub)
  --help           this text

Each version gets its own hashed asset, cache name and worker version, as a real
deploy does. Exits 0 only when every check passes.
`;

const MUTANTS = new Set(['none', 'keep-old-caches']);

function parseArgs(argv) {
  const options = { versions: 10, out: null, mutant: 'none', selfCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--versions': options.versions = Number(value()); break;
      case '--out': options.out = value(); break;
      case '--mutant': options.mutant = value(); break;
      case '--self-check': options.selfCheck = true; break;
      case '--help': case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isFinite(options.versions) || options.versions < 2) {
    throw new Error('--versions must be at least 2 (a single version cannot show a leftover)');
  }
  if (!MUTANTS.has(options.mutant)) {
    throw new Error(`unknown mutant ${options.mutant} (one of ${[...MUTANTS].join(', ')})`);
  }
  return options;
}

function makeEvidenceDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CACHE_GROWTH_OUT) return process.env.CACHE_GROWTH_OUT;
  let sha = 'worktree';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch {
    // not a git checkout: keep the default name
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('/tmp/airhorn-cache-growth', `${sha}-${stamp}`);
}

/* --------------------------------- checks --------------------------------- */

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(pass);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function growsMonotonically(values, tolerance) {
  if (values.length < 3) return false;
  return values.slice(1).every((value, index) => value - values[index] > tolerance);
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

/**
 * Does a cached entry list hold EXACTLY the paths the worker declares?
 *
 * Counts are not enough (airhorn-3ub): a cache holding `/` + `/unrelated.js`
 * where the worker declared `/` + `/index.html` has the right size and the wrong
 * contents, and that is the shape a drift bug takes - an entry silently dropped
 * by addAll and another one left behind. Compare pathnames as sets; a query
 * string is not part of the key the worker reasons about.
 */
function precacheMatches(declaredPaths, cachedPaths) {
  const pathname = (value) => new URL(String(value), 'http://precache.invalid').pathname;
  const expected = declaredPaths.map(pathname).sort();
  const actual = cachedPaths.map(pathname).sort();
  return expected.length === actual.length && expected.every((path, index) => path === actual[index]);
}

/** The first difference between what was declared and what the cache holds. */
function precacheMismatch(declaredPaths, cachedPaths) {
  const pathname = (value) => new URL(String(value), 'http://precache.invalid').pathname;
  const expected = declaredPaths.map(pathname).sort();
  const actual = cachedPaths.map(pathname).sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  return { missing, unexpected, declared: expected.length, cached: actual.length };
}

/* ------------------------------ build variants ---------------------------- */

const versionTag = (index) => `2.0.0-cgv${String(index).padStart(2, '0')}`;
const assetPathFor = (index) => `/assets/index-cgv${String(index).padStart(2, '0')}.js`;

/**
 * Ten "deploys" of the same source: each gets a distinct hashed bundle name and
 * content, references rewritten in index.html and in the worker's precache list,
 * and a distinct worker version. This is what makes the growth question real —
 * an identical cache name across versions would be overwritten, not accumulated.
 */
function buildVariants({ count, workRoot, mutant }) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`dist/ is missing: run "npm run build" first (looked in ${distDir})`);
  }
  const builtWorker = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf-8');
  const builtAsset = builtWorker.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!builtAsset) {
    throw new Error('could not find a hashed /assets/index-*.js in dist/sw.js (run "npm run build")');
  }

  const variants = [];
  for (let index = 1; index <= count; index += 1) {
    const tag = versionTag(index);
    const assetPath = assetPathFor(index);
    const dir = path.join(workRoot, `v${index}`);
    fs.cpSync(distDir, dir, { recursive: true });

    // Rename the bundle and give it new bytes: a rebuild that produces the same
    // name would be reused by the browser's HTTP cache and prove nothing.
    fs.renameSync(path.join(dir, builtAsset), path.join(dir, assetPath));
    fs.appendFileSync(path.join(dir, assetPath), `\n// cache-growth build ${index}\n`);

    for (const file of ['index.html', 'sw.js']) {
      const abs = path.join(dir, file);
      const text = fs.readFileSync(abs, 'utf-8');
      if (!text.includes(builtAsset)) {
        throw new Error(`${file} does not reference ${builtAsset}: the build changed shape and this tool needs updating`);
      }
      fs.writeFileSync(abs, text.split(builtAsset).join(assetPath));
    }

    let worker = fs.readFileSync(path.join(dir, 'sw.js'), 'utf-8');
    worker = worker.replace(/const version = "[^"]+";/, `const version = "${tag}";`);
    if (!worker.includes(`const version = "${tag}";`)) {
      throw new Error('could not stamp the worker version: the build changed shape and this tool needs updating');
    }
    if (mutant === 'keep-old-caches') {
      const cleanup = '.map(name => caches.delete(name))';
      if (!worker.includes(cleanup)) {
        throw new Error('could not disable the activate cleanup: the worker changed shape and this tool needs updating');
      }
      worker = worker.replace(cleanup, '.map(name => Promise.resolve(false))');
    }
    fs.writeFileSync(path.join(dir, 'sw.js'), worker);

    // What the worker says it precaches IS the expectation: reading it here means
    // a precache change (e.g. dropping the duplicate `/` entry, airhorn-btt) does
    // not silently need a matching edit in this tool, while the entry-count check
    // still catches a worker that ends up storing something else.
    const listLiteral = worker.match(/const precacheUrls = \[([\s\S]*?)\];/)?.[1]
      // Strip comments before reading the list: the worker explains itself in
      // backticks, and a comment mentioning `/index.html` must not become an
      // entry the check then reports as missing.
      ?.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (!listLiteral) {
      throw new Error('could not read precacheUrls from the worker: the build changed shape and this tool needs updating');
    }
    const precachedPaths = [...listLiteral.matchAll(/[`'"](\/[^`'"]*)[`'"]/g)].map((match) => match[1]);
    if (!precachedPaths.length) throw new Error('the worker precaches nothing');
    // `/` is served from index.html when it is in the list, so count its bytes thus.
    const expectedBytes = precachedPaths.reduce((total, relative) => {
      const file = path.join(dir, relative === '/' ? 'index.html' : relative);
      return total + (fs.existsSync(file) ? fs.statSync(file).size : 0);
    }, 0);

    variants.push({
      index, tag, dir, assetPath, expectedBytes, expectedEntries: precachedPaths.length, precachedPaths, worker,
    });
  }
  return { variants, builtAsset };
}

/* ------------------------------- self-check ------------------------------- */

/**
 * A predicate that cannot fail is worse than no predicate (airhorn-a6u,
 * airhorn-3ub), so the exact-entry rule is proven here against synthetic entry
 * lists: the faithful set passes, and every way of keeping the same COUNT while
 * changing the contents fails. No browser, no build, milliseconds.
 */
function runSelfCheck() {
  const declared = ['/', '/index.html', '/styles/main.css', '/sounds/airhorn.mp3', '/assets/index-abc.js'];
  const cases = [
    { name: 'the declared set is accepted', cached: declared, expect: true },
    {
      name: 'a same-count substitution is rejected',
      cached: ['/', '/unrelated.js', '/styles/main.css', '/sounds/airhorn.mp3', '/assets/index-abc.js'],
      expect: false,
    },
    { name: 'a missing entry is rejected', cached: declared.slice(1), expect: false },
    { name: 'an extra entry is rejected', cached: [...declared, '/extra.js'], expect: false },
    {
      name: 'a duplicate standing in for a missing path is rejected',
      cached: [...declared.slice(0, 4), declared[0]],
      expect: false,
    },
    { name: 'order does not matter', cached: [...declared].reverse(), expect: true },
    { name: 'a query string is not part of the key', cached: declared.map((path) => `${path}?v=2`), expect: true },
    { name: 'nothing cached is rejected', cached: [], expect: false },
  ];

  let failures = 0;
  for (const testCase of cases) {
    const result = precacheMatches(declared, testCase.cached);
    const ok = result === testCase.expect;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${testCase.name} (predicate ${result ? 'accepted' : 'rejected'}, expected ${testCase.expect ? 'accept' : 'reject'})`);
    if (!ok) {
      const diff = precacheMismatch(declared, testCase.cached);
      console.log(`        missing [${diff.missing.join(', ')}] unexpected [${diff.unexpected.join(', ')}] ` +
        `${diff.cached} cached / ${diff.declared} declared`);
    }
  }

  console.log(`\ncache-growth --self-check: ${failures === 0 ? 'PASS' : 'FAIL'} — ` +
    `${cases.length - failures}/${cases.length} exact-entry cases behave`);
  return failures === 0 ? 0 : 1;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfCheck) return runSelfCheck();
  const evidenceDir = makeEvidenceDir(options.out);
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-builds-'));
  const { variants, builtAsset } = buildVariants({
    count: options.versions, workRoot, mutant: options.mutant,
  });

  // The origin serves one build at a time - the newest - so a previous version's
  // hashed asset must come back 404, exactly as it would from the real CDN.
  const origin = { current: variants[0] };
  const server = http.createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const variant = origin.current;
    if (requestPath === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-store',
      });
      res.end(variant.worker);
      return;
    }
    let filePath = path.join(variant.dir, requestPath === '/' ? 'index.html' : requestPath);
    if (!path.resolve(filePath).startsWith(path.resolve(variant.dir)) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  // One launcher owns chrome, its process tree and its profile (airhorn-2po9):
  // the flag family, the startup bound, /json/list discovery and the page ws
  // bound all live in tools/lib/chrome.mjs.
  let browser = null;
  let ws = null;

  try {
    browser = await launchChrome({ label: 'cache-growth-profile', autoplay: true, timeoutMs: 20000, discoveryMs: 20000 });
    ws = await connectPage(browser, { label: 'cache-growth-profile', timeoutMs: 20000 });

    let msgId = 1;
    const pending = new Map();
    const pageErrors = [];
    const navigations = [];

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        pageErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' &&
        message.params.entry.source !== 'network') {
        // `source: network` entries are resource-load failures. This tool asks
        // the origin for previous deploys' hashed assets on purpose, and a 404
        // is the correct answer there - it is a check, not an error.
        pageErrors.push(message.params.entry.text);
      } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        navigations.push(message.params.frame.url);
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

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error('Page evaluation failed: ' +
          (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      }
      return result.result.value;
    };

    const waitFor = async (expression, timeoutMs = 15000, label = expression) => {
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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pageErrors = [];
        window.addEventListener('error', (e) => {
          window.__pageErrors.push(e.message || (e.error ? String(e.error) : String(e)));
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__pageErrors.push((e.reason && e.reason.message) || String(e.reason));
        });
        ${quiescenceProbe}
      `,
    });

    /**
     * What the device holds, read from the device: the cache names, then every
     * entry's stored bytes, then the origin's own storage estimate.
     */
    const measureStorage = async (variant, previousVariants) => {
      await waitForQuiescence(send, {
        quietExpression: '!window.__airhorn?.isPlaying?.()',
        timeoutMs: 10000,
        stableSamples: 2,
        pollMs: 25,
      });

      const storage = await evaluate(`(async () => {
        const keys = await caches.keys();
        const cachesInfo = [];
        for (const name of keys) {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          let bytes = 0;
          const entries = [];
          for (const request of requests) {
            const response = await cache.match(request);
            const body = response ? await response.arrayBuffer() : new ArrayBuffer(0);
            bytes += body.byteLength;
            entries.push({
              path: new URL(request.url).pathname,
              bytes: body.byteLength,
              status: response ? response.status : null,
            });
          }
          cachesInfo.push({ name, entries: entries.length, bytes, detail: entries });
        }
        let estimate = null;
        try {
          estimate = await navigator.storage.estimate();
        } catch {}
        return {
          keys,
          caches: cachesInfo,
          totalBytes: cachesInfo.reduce((sum, cache) => sum + cache.bytes, 0),
          estimate,
        };
      })()`);

      // Is a previous deploy's hashed asset still readable from the cache, and
      // does the origin still serve it? Both must be no.
      const previous = [];
      for (const earlier of previousVariants) {
        const cachedStatus = await evaluate(
          `caches.match(${JSON.stringify(earlier.assetPath)}).then((response) => response ? response.status : null)`,
        );
        const networkStatus = await evaluate(
          `fetch(${JSON.stringify(earlier.assetPath)}, { cache: 'no-store' })
             .then((response) => response.status)
             .catch(() => 0)`,
        );
        previous.push({ version: earlier.tag, assetPath: earlier.assetPath, cachedStatus, networkStatus });
      }

      return {
        version: variant.tag,
        assetPath: variant.assetPath,
        keys: storage.keys,
        caches: storage.caches,
        totalBytes: storage.totalBytes,
        usage: storage.estimate?.usage ?? null,
        quota: storage.estimate?.quota ?? null,
        usageDetails: storage.estimate?.usageDetails ?? null,
        previous,
      };
    };

    const playHorn = async (label) => {
      const started = await evaluate(`window.__airhorn.start({ loop: true }).then(() => window.__airhorn.isPlaying())`);
      if (!started) throw new Error(`the horn did not start under ${label}`);
      const playing = await waitFor('window.__airhorn.isPlaying()', 5000, `the horn to sound under ${label}`);
      await evaluate(`window.__airhorn.stop({ immediate: true })`);
      await waitFor('!window.__airhorn.isPlaying()', 8000, `the horn to stop under ${label}`);
      return playing;
    };

    if (options.mutant !== 'none') {
      console.log(`cache-growth: MUTANT ${options.mutant} — the growth checks are EXPECTED to fail`);
    }
    console.log(`cache-growth: ${options.versions} simulated deploys in one profile ` +
      `(${variants[0].tag} .. ${variants[options.versions - 1].tag})`);

    const records = [];

    /* ------------------------------ version 1 ------------------------------ */
    console.log('\n--- v1: a first visit installs the worker ---');
    await send('Page.navigate', { url: `${url}/` });
    await waitFor(`document.readyState === 'complete' && !!window.__airhorn`, 20000, 'the app to boot');
    await waitFor(`navigator.serviceWorker.ready.then((reg) => reg.active ? reg.active.state === 'activated' : false)`,
      20000, 'the worker to activate');
    // A returning user is controlled before the page parses, which is the only
    // case the page reloads itself on controllerchange; reload once so every
    // later update exercises that path.
    await send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!window.__airhorn`, 20000, 'the app to boot under the worker');
    await waitFor('!!navigator.serviceWorker.controller', 10000, 'the document to be worker-controlled');
    await playHorn('v1');
    records.push(await measureStorage(variants[0], []));
    console.log(`  ${records[0].version}: caches ${records[0].caches.length}, ` +
      `${records[0].caches.map((cache) => `${cache.name}=${cache.entries}/${kb(cache.bytes)} KB`).join(', ')}, ` +
      `storage ${kb(records[0].usage ?? 0)} KB`);

    /* ----------------------- versions 2..N over the top --------------------- */
    for (let index = 2; index <= options.versions; index += 1) {
      const variant = variants[index - 1];
      origin.current = variant;
      const reloadsBefore = navigations.length;

      await evaluate(`(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration.update();
        return true;
      })()`);

      // A cache carrying the new version's name is proof the new worker
      // precached; the activate sweep and the controllerchange reload follow.
      await waitFor(
        `caches.keys().then((keys) => keys.some((key) => key.includes(${JSON.stringify(variant.tag)})))`,
        25000, `worker ${variant.tag} to precache`);
      await waitUntil(() => navigations.length > reloadsBefore, 25000, `the page to reload for ${variant.tag}`);
      await sleep(300);
      await waitFor(`document.readyState === 'complete' && !!window.__airhorn`,
        20000, `the app to boot under ${variant.tag}`);
      await waitFor('!!navigator.serviceWorker.controller', 10000, `a controller under ${variant.tag}`);

      const reloads = navigations.length - reloadsBefore;
      const played = await playHorn(variant.tag);
      const record = await measureStorage(variant, variants.slice(0, index - 1));
      record.reloads = reloads;
      record.played = played;
      record.builtBytes = variant.expectedBytes;
      records.push(record);
      console.log(`  ${record.version}: caches ${record.caches.length}` +
        `${record.reloads === 1 ? '' : ` (reloads ${record.reloads})`}, ` +
        `${record.caches.map((cache) => `${cache.name}=${cache.entries}/${kb(cache.bytes)} KB`).join(', ')}, ` +
        `total ${kb(record.totalBytes)} KB, storage ${kb(record.usage ?? 0)} KB, ` +
        `old caches [${record.previous.filter((entry) => record.keys.some((key) => key.includes(entry.version))).map((entry) => entry.version).join(', ') || 'none'}]`);
    }

    /* -------------------------------- checks ------------------------------- */
    console.log('\n--- checks ---');
    const last = records[records.length - 1];
    const finalVariant = variants[variants.length - 1];

    const onlyCurrentCheck = check(
      'every deploy leaves exactly the current version\'s two caches',
      records.every((record) => record.caches.length === 2 &&
        record.keys.every((key) => key.includes(record.version))),
      records.map((record) => `${record.version}: ${record.keys.join('+')}`).join('; '),
    );

    // Look at THIS version's cache, not whichever airhornner-* happens to come
    // first: with a leftover cache present (the keep-old-caches mutant) the old
    // lookup compared the previous version's contents against this version's
    // declaration and reported an entry mismatch that was really the leak.
    const appCaches = records.map((record) => record.caches.find(
      (cache) => cache.name.startsWith('airhorner-') && cache.name.includes(record.version)) ?? null);
    const metaCaches = records.map((record) => record.caches.find(
      (cache) => cache.name.startsWith('horn-integrity-') && cache.name.includes(record.version)) ?? null);
    const cachedPaths = (cache) => (cache ? cache.detail.map((entry) => entry.path) : []);
    // Sets, not counts (airhorn-3ub): the precache and its integrity records must
    // both name exactly the paths the worker declares, or a same-sized
    // substitution passes a check that claims to be exact.
    const entriesCheck = check(
      'the precache holds exactly the entries the worker declares, every version',
      records.every((_, position) =>
        precacheMatches(variants[position].precachedPaths, cachedPaths(appCaches[position])) &&
        precacheMatches(variants[position].precachedPaths, cachedPaths(metaCaches[position]))),
      records.map((record, position) => {
        const variant = variants[position];
        const appDiff = precacheMismatch(variant.precachedPaths, cachedPaths(appCaches[position]));
        const metaDiff = precacheMismatch(variant.precachedPaths, cachedPaths(metaCaches[position]));
        const bad = [
          appDiff.missing.length ? `precache missing ${appDiff.missing.join(',')}` : '',
          appDiff.unexpected.length ? `precache unexpected ${appDiff.unexpected.join(',')}` : '',
          metaDiff.missing.length ? `integrity missing ${metaDiff.missing.join(',')}` : '',
          metaDiff.unexpected.length ? `integrity unexpected ${metaDiff.unexpected.join(',')}` : '',
        ].filter(Boolean);
        return `${record.version}: ${appDiff.cached}/${appDiff.declared}${bad.length ? ` (${bad.join('; ')})` : ''}`;
      }).join('; ') +
      ` — declared: ${variants[variants.length - 1].precachedPaths.join(', ')}`,
    );

    const bytesSeries = records.map((record) => record.totalBytes);
    const byteGrowth = (median(bytesSeries.slice(-2)) - median(bytesSeries.slice(0, 2)));
    const bytesCheck = check(
      'stored bytes stay flat across deploys (one version, not one per deploy)',
      Math.abs(byteGrowth) < 8 * 1024 && !growsMonotonically(bytesSeries, 4 * 1024),
      `${bytesSeries.map((bytes) => kb(bytes)).join(' -> ')} KB, drift ${kb(byteGrowth)} KB ` +
      `(one version is ~${kb(bytesSeries[0])} KB)`,
    );

    const staleCacheVersions = last.keys.filter(
      (key) => !key.includes(finalVariant.tag),
    );
    const twoBack = variants[variants.length - 3];
    const previousVersion = variants[variants.length - 2];
    const staleCheck = check(
      'nothing from the previous deploy — or two deploys ago — survives',
      staleCacheVersions.length === 0 &&
      !last.keys.some((key) => key.includes(previousVersion.tag)) &&
      !(twoBack && last.keys.some((key) => key.includes(twoBack.tag))),
      staleCacheVersions.length
        ? `leftover caches: ${staleCacheVersions.join(', ')}`
        : `after ${last.version}: [${last.keys.join(', ')}]` +
          (twoBack ? `; ${previousVersion.tag} and ${twoBack.tag} gone` : `; ${previousVersion.tag} gone`),
    );

    const staleAssets = last.previous.filter((entry) => entry.cachedStatus !== null || entry.networkStatus !== 404);
    const assetCheck = check(
      'previous deploys\' hashed assets are neither cached nor still served',
      staleAssets.length === 0,
      staleAssets.length
        ? staleAssets.map((entry) => `${entry.assetPath}: cached=${entry.cachedStatus} network=${entry.networkStatus}`).join('; ')
        : `${last.previous.length} earlier assets: cache miss, 404 from the origin ` +
          `(e.g. ${last.previous[last.previous.length - 1]?.assetPath})`,
    );

    const usageSeries = records.map((record) => record.usage ?? 0);
    const usageGrowth = median(usageSeries.slice(-2)) - median(usageSeries.slice(0, 2));
    const usageCheck = check(
      'the origin\'s storage estimate stays bounded',
      usageGrowth < 512 * 1024 && !growsMonotonically(usageSeries, 64 * 1024),
      `${usageSeries.map((bytes) => kb(bytes)).join(' -> ')} KB, growth ${kb(usageGrowth)} KB ` +
      `(usageDetails ${JSON.stringify(records[records.length - 1].usageDetails)})`,
    );

    const reloadCheck = check(
      'each update reloads the page exactly once',
      records.slice(1).every((record) => record.reloads === 1),
      records.slice(1).map((record) => `${record.version}:${record.reloads}`).join(' '),
    );

    const playCheck = check(
      'the horn still plays under every new worker',
      records.every((record) => record.played !== false),
      records.map((record) => `${record.version}:${record.played === false ? 'silent' : 'played'}`).join(' '),
    );

    const errors = await evaluate('window.__pageErrors.slice(0, 10)');
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, 'cache-growth-final.png'), Buffer.from(data, 'base64'));

    const errorCheck = check(
      'no page errors during the deploys',
      pageErrors.length === 0 && errors.length === 0,
      [...pageErrors, ...errors].slice(0, 5).join(' | ') || 'none',
    );

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
        origin: url,
        builtAsset,
        mutant: options.mutant,
      },
      plan: { versions: options.versions },
      records,
      checks,
      summary,
    };
    fs.writeFileSync(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

    console.log(`\ncache-growth: ${summary.pass ? 'PASS' : 'FAIL'} — ${options.versions} deploys in one profile`);
    console.log(`  per-version stored bytes: ${bytesSeries.map((bytes) => kb(bytes)).join(' -> ')} KB`);
    console.log(`  per-version origin usage: ${usageSeries.map((bytes) => kb(bytes)).join(' -> ')} KB`);
    console.log(`  final caches: ${last.keys.join(', ')}`);
    console.log(`  evidence: ${evidenceDir}`);
    if (!summary.pass) {
      console.log('  failures:');
      for (const failure of summary.failures) console.log(`   - ${failure}`);
    }

    void [onlyCurrentCheck, entriesCheck, bytesCheck, staleCheck, assetCheck, usageCheck, reloadCheck,
      playCheck, errorCheck];

    return summary.pass ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    // The handle's teardown is the launcher's: marker sweep, tree kill, profile
    // rm - and the rm runs before its first await, so the writeback race that
    // recreates Default/ after a bare rm cannot happen (airhorn-5xqi).
    if (browser) await browser.close();
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().then((code) => {
  // Hard exit on the success path too (airhorn-s1wy): a peer that swallows the
  // ws close-frame also swallows teardown's ws.close(), so the half-open socket
  // keeps the event loop alive after every check has passed and a PASSing run
  // never exits - soak.mjs's main().then exits for the same reason
  // (airhorn-uenq). The exit is drained through stdout's write callback rather
  // than called bare: a bare process.exit drops queued bytes once stdout is a
  // pipe and the output is larger than its 64KB buffer (measured on a
  // 200000-byte write; this tool's summary is ~2KB today, which is why the bead
  // asked for the drain rather than the bare call).
  process.stdout.write('', () => process.exit(code));
}).catch((err) => {
  console.error(`cache-growth: FAIL — ${err.message}`);
  // Hard exit: a hostile peer that swallowed frames also swallows the ws
  // close-frame, so the socket keeps the event loop alive past the finally
  // and a gentle exitCode would hang the process (airhorn-nbh9).
  process.exit(1);
});
