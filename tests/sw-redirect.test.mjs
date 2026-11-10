/*
 * airhorn-fdp6. public/sw.js refuses to cache or record a REDIRECTED response
 * (the factory audit's root cause behind both sw.js findings), and this suite is
 * the test that was missing: the fix had two manual mutant proofs and nothing
 * committed, so a refactor could restore the poisoning silently.
 *
 * Browser-free, deliberately: the REAL public/sw.js is loaded and run in a vm
 * sandbox whose only stubs are the platform APIs a service worker gets from the
 * browser (self.addEventListener, caches, fetch, location, console). The code
 * under test is the shipped worker, not a copy, and the assertions are on the
 * decisions it makes - the thrown message and the cache writes - so the stub
 * cannot make a wrong implementation look right.
 *
 * Three properties, one direction each:
 *   a) putVerified() REFUSES a redirected response, named, and stores nothing.
 *      The redirect used is to the SAME PATHNAME with a query, which only the
 *      `response.redirected` clause can catch: a pathname-only guard passes it.
 *   b) A redirected SERVE is returned to the page but never stored.
 *   c) A same-URL response still stores (and records its digest), so the guard
 *      cannot be satisfied by refusing everything.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { injectIntegrity } from '../tools/lib/sw-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8080';

// A Map-backed Cache. put/match/delete/keys are all the worker uses, and the
// key is the pathname because every request the worker builds is same-origin.
function fakeCache(name) {
  const entries = new Map();
  const writes = [];
  return {
    name,
    entries,
    writes,
    async put(request, response) {
      const pathname = new URL(request.url).pathname;
      writes.push(pathname);
      entries.set(pathname, response);
    },
    async match(request) {
      return entries.get(new URL(request.url).pathname);
    },
    async delete(request) {
      return entries.delete(new URL(request.url).pathname);
    },
    async keys() {
      return [...entries.keys()].map((p) => new Request(ORIGIN + p));
    },
  };
}

// Load the shipped worker with the platform stubs, and hand back the listeners
// it registered plus the caches it opened, so a test can dispatch events.
function loadWorker({ fetchImpl, digests } = {}) {
  const caches = new Map();
  const instances = [];
  const warnings = [];
  const listeners = { install: [], fetch: [], activate: [], message: [] };

  const sandbox = {
    location: { origin: ORIGIN },
    caches: {
      async open(name) {
        if (!caches.has(name)) {
          const cache = fakeCache(name);
          instances.push(cache);
          caches.set(name, cache);
        }
        return caches.get(name);
      },
      async delete(name) {
        return caches.delete(name);
      },
      async keys() {
        return [...caches.keys()];
      },
    },
    fetch: fetchImpl ?? (async () => { throw new Error('no fetch stub for this test'); }),
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
      log: () => {},
    },
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    // Platform globals the worker is entitled to.
    Request, Response, Headers, URL, AbortSignal, crypto, Uint8Array, TextDecoder,
    setTimeout, clearTimeout, Promise, JSON, Math, Array, Object, Number, String, Error,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  // airhorn-oybq: the build injects the digest manifest into dist/sw.js. A test that passes `digests` stands in for a
  // built worker; without it the placeholder stays a comment and the worker is UNBOUND, which is its own world below.
  vm.runInContext(digests ? injectIntegrity(SW_SOURCE, digests) : SW_SOURCE, sandbox, { filename: 'public/sw.js' });

  return { sandbox, caches, instances, warnings, listeners };
}

/*
 * airhorn-awhn: the precache POOL. public/sw.js:188 uses mapPooled with PRECACHE_CONCURRENCY = 6 (the 86mz work took the
 * install from 484 ms serial to 121 ms pooled), and nothing committed pinned it - a refactor back to a serial loop left
 * every suite green. The observable is not the constant or a counter: it is how many fetches the pool actually keeps in
 * flight at once, which is what the install time actually depends on. So the stub below counts overlapping fetches and
 * the assertion is on the MAXIMUM observed overlap.
 *
 * Deliberately tolerant about the exact number: a limit of 3 is not the defect, unbounded fan-out is not the defect
 * either - one-at-a-time is. The assertion is "more than one", with the measured peak in the message so a lane reading a
 * failure learns what the pool really did.
 */
test('the install precache keeps more than one request in flight (airhorn-awhn)', async () => {
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const settleAfter = 5;
  const worker = loadWorker({
    fetchImpl: (request) => new Promise((resolve) => {
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        // A response that vouches for the URL it was requested as (sameUrlResponse), because putVerified refuses
        // anything whose .url does not match the pathname it would be stored under - and this test must fail on the
        // POOL, not on the redirect guard.
        const requested = new URL(request.url ?? String(request), ORIGIN);
        resolve(sameUrlResponse(ORIGIN + requested.pathname, `bytes for ${requested.pathname}`));
      }, settleAfter);
    }),
  });

  let waited;
  for (const listener of worker.listeners.install) {
    listener({ waitUntil: (promise) => { waited = promise; } });
  }
  assert.ok(waited, 'the install handler must register work with waitUntil');
  await Promise.race([
    waited,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('the install precache never settled - the pool is stuck')), 15000)),
  ]);

  assert.ok(started >= 2, `the install must fetch its precache list, started ${started}`);
  assert.ok(peak > 1, `the precache pool must keep more than one request in flight; peak was ${peak} of ${started} - a `
    + 'serial loop is a measuring-invisible regression (the 86mz work took install from 484 ms to 121 ms), and this '
    + 'assertion is the only thing that notices it');
});

// A Response that a real fetch would return after following a redirect: the// A Response that a real fetch would return after following a redirect: the
// browser marks it redirected and leaves .url at the FINAL address.
function redirectedResponse(finalUrl, body = 'poison') {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

function sameUrlResponse(finalUrl, body = 'good') {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

// Fire the install handler and wait for its waitUntil chain.
async function runInstall(worker) {
  let pending;
  for (const listener of worker.listeners.install) {
    listener({ waitUntil: (promise) => { pending = promise; } });
  }
  assert.ok(pending, 'the worker registered an install handler that calls waitUntil');
  return pending;
}

// Fire the fetch handler for one URL and resolve with what it respondWith'd.
async function runFetch(worker, pathname, { mode = 'cors' } = {}) {
  const request = new Request(ORIGIN + pathname, { mode });
  let pending;
  for (const listener of worker.listeners.fetch) {
    listener({ request, respondWith: (promise) => { pending = promise; } });
  }
  assert.ok(pending, `the fetch handler called respondWith for ${pathname}`);
  return pending;
}

const MP3 = '/sounds/airhorn.mp3';

test('putVerified refuses a redirected response for the SAME pathname, named, and stores nothing', async () => {
  // The redirect keeps the pathname and only adds a query: a guard that compares
  // pathnames alone would accept this and cache the wrong bytes.
  const finalUrl = `${ORIGIN}${MP3}?moved=1`;
  const worker = loadWorker({
    fetchImpl: async (request) => {
      const pathname = new URL(request.url ?? request, ORIGIN).pathname;
      if (pathname === MP3) return redirectedResponse(finalUrl, 'bytes from somewhere else');
      if (pathname === '/index.html') return sameUrlResponse(`${ORIGIN}/index.html`, '<!doctype html><title>airhorner</title>');
      return sameUrlResponse(`${ORIGIN}${pathname}`, `body of ${pathname}`);
    },
  });

  await assert.rejects(
    runInstall(worker),
    (err) => {
      assert.match(err.message, /precache refuses a redirected response for \/sounds\/airhorn\.mp3/);
      assert.match(err.message, /final URL http:\/\/127\.0\.0\.1:8080\/sounds\/airhorn\.mp3\?moved=1/);
      return true;
    },
    'a redirected precache response must fail the install, naming both URLs',
  );

  // Nothing was stored under the requested pathname, while the earlier,
  // legitimate entries WERE stored - so the refusal is specific, not a blanket
  // stop. The cache instances are inspected through the writes they recorded,
  // because a refused install goes on to delete both caches (no partial
  // precache survives a worker that never activated).
  const content = worker.instances.find((c) => c.name === 'airhorner-__BUILD_HASH__');
  assert.ok(content, 'precache opened the content cache');
  assert.deepEqual(content.writes, ['/', '/index.html', '/styles/main.css'],
    'the same-URL entries before the redirect store, and the redirected one does not');
  const meta = worker.instances.find((c) => c.name === 'horn-integrity-__BUILD_HASH__');
  assert.equal(meta?.writes.includes(MP3) ?? false, false, 'no integrity record may be written for a redirected body');
  assert.equal(worker.caches.has('airhorner-__BUILD_HASH__'), false,
    'a refused install deletes the half-built content cache (no partial precache)');
  assert.equal(worker.caches.has('horn-integrity-__BUILD_HASH__'), false,
    'and the integrity cache with it');
});

test('putVerified refuses a redirect to a DIFFERENT pathname too', async () => {
  const worker = loadWorker({
    fetchImpl: async (request) => {
      const pathname = new URL(request.url ?? request, ORIGIN).pathname;
      if (pathname === MP3) return redirectedResponse(`${ORIGIN}/sounds/other.mp3`, 'other');
      if (pathname === '/index.html') return sameUrlResponse(`${ORIGIN}/index.html`, '<!doctype html>');
      return sameUrlResponse(`${ORIGIN}${pathname}`, 'body');
    },
  });

  await assert.rejects(runInstall(worker), /precache refuses a redirected response for \/sounds\/airhorn\.mp3/);
  const content = worker.instances.find((c) => c.name === 'airhorner-__BUILD_HASH__');
  assert.equal(content.writes.includes(MP3), false, 'the redirected body is never written under the requested path');
});

test('a redirected SERVE is returned to the page but never stored', async () => {
  const finalUrl = `${ORIGIN}${MP3}?moved=1`;
  const served = redirectedResponse(finalUrl, 'bytes from somewhere else');
  const worker = loadWorker({ fetchImpl: async () => served });

  const response = await runFetch(worker, MP3);
  assert.equal(response, served, 'the network answer is served, redirect and all - that is normal browser behaviour');

  const content = worker.caches.get('airhorner-__BUILD_HASH__');
  assert.equal(content?.entries.has(MP3) ?? false, false, 'a redirected serve must not be cached');
  const meta = worker.caches.get('horn-integrity-__BUILD_HASH__');
  assert.equal(meta?.entries.has(MP3) ?? false, false, 'a redirected serve must not be recorded');
  assert.ok(worker.warnings.some((line) => line.includes(MP3) && line.includes('not caching') && line.includes('redirected=true')),
    `the refusal must be named in a warning, got: ${JSON.stringify(worker.warnings)}`);
});

test('a same-URL SERVE still stores and records, so the guard is not refusing everything', async () => {
  const worker = loadWorker({ fetchImpl: async () => sameUrlResponse(`${ORIGIN}${MP3}`, 'good bytes') });

  const response = await runFetch(worker, MP3);
  assert.equal(response.ok, true, 'the response is served');

  const content = worker.caches.get('airhorner-__BUILD_HASH__');
  assert.equal(content?.entries.has(MP3), true, 'a same-URL response must still be cached');
  const meta = worker.caches.get('horn-integrity-__BUILD_HASH__');
  assert.equal(meta?.entries.has(MP3), true, 'its digest must still be recorded');
  const record = await meta.entries.get(MP3).json();
  assert.equal(record.length, 'good bytes'.length, 'the record describes the stored bytes');
});

// airhorn-15fw. Cloudflare Pages canonicalises `/index.html` to `/` with a redirect (measured 308 with
// wrangler 3.114.17 `pages dev`, and documented HTML handling), so the redirect refusal above - correctly -
// refused the alias and the whole install failed: on Pages the app had no worker at all. The fix keeps the
// refusal and adds the other half of the fact: `/` and `/index.html` are two spellings of ONE document, so
// when the redirect lands on the canonical spelling that is itself precached, the alias is satisfied by the
// canonical copy. These tests run the shipped worker against a Pages-shaped origin and check both halves.
const SHELL_HTML = '<!doctype html><title>airhorner</title><p>the shell</p>';

// A worker whose origin behaves like Cloudflare Pages: /index.html answers with a redirect to / carrying the
// same document. `offline()` flips it to a dead network so a navigation can only be served from the cache.
function pagesShapedWorker() {
  let offline = false;
  const worker = loadWorker({
    fetchImpl: async (request) => {
      if (offline) throw new Error('offline');
      const pathname = new URL(request.url ?? request, ORIGIN).pathname;
      if (pathname === '/index.html') return redirectedResponse(`${ORIGIN}/`, SHELL_HTML);
      return sameUrlResponse(`${ORIGIN}${pathname}`, pathname === '/' ? SHELL_HTML : `body of ${pathname}`);
    },
  });
  return { worker, goOffline: () => { offline = true; } };
}

// A navigation request cannot be built by Node's Request constructor (`mode: 'navigate'` is browser-only),
// so this dispatches the shape a real navigate event carries - which is all the worker reads: url, method, mode.
function navigate(worker, pathname) {
  const request = { url: ORIGIN + pathname, mode: 'navigate', method: 'GET' };
  let pending;
  for (const listener of worker.listeners.fetch) listener({ request, respondWith: (promise) => { pending = promise; } });
  assert.ok(pending, `the fetch handler called respondWith for a navigation to ${pathname}`);
  return pending;
}

test('a canonicalised document alias installs: nothing stored under the alias, reads served by the canonical copy', async () => {
  const { worker, goOffline } = pagesShapedWorker();

  // (1) The install SUCCEEDS - the refusal is not weakened, it just does not apply to the canonical alias.
  await runInstall(worker);

  const content = worker.caches.get('airhorner-__BUILD_HASH__');
  const meta = worker.caches.get('horn-integrity-__BUILD_HASH__');
  assert.equal(content.entries.has('/'), true, 'the canonical document is stored');
  assert.equal(content.entries.has('/index.html'), false,
    'the alias wrote nothing of its own - a redirected body is still never stored under the requested key');
  assert.equal(meta.entries.has('/index.html'), false, 'and no integrity record vouches for the alias spelling');
  assert.equal(meta.entries.has('/'), true, 'the canonical copy carries its record');

  // (4a) Offline navigation to the ALIAS spelling is served from the canonical entry.
  goOffline();
  const aliased = await navigate(worker, '/index.html');
  const aliasBody = await aliased.text();
  assert.equal(aliasBody, SHELL_HTML, 'an offline navigation to /index.html must be served the stored shell');
  assert.doesNotMatch(aliasBody, /needs a connection/, 'it must not fall through to the offline page while the shell is stored');
});

test('a canonicalised document alias still serves the plain / navigation offline', async () => {
  // A separate worker on purpose: the fake cache hands back the SAME Response object on every match (the real
  // Cache API returns a fresh one), so reading two spellings in one instance would be testing the stub's body
  // reuse rather than the worker. Each instance below is a clean install, exactly like a fresh browser.
  const { worker, goOffline } = pagesShapedWorker();
  await runInstall(worker);
  goOffline();
  const response = await navigate(worker, '/');
  const body = await response.text();
  assert.equal(body, SHELL_HTML, 'an offline navigation to / must be served the stored shell');
});

test('the alias is only the canonical document: a redirect anywhere else still fails the install', async () => {
  // The alias rule must not become a general "any redirect that ends at a precached path is fine".
  const worker = loadWorker({
    fetchImpl: async (request) => {
      const pathname = new URL(request.url ?? request, ORIGIN).pathname;
      if (pathname === MP3) return redirectedResponse(`${ORIGIN}/styles/main.css`, 'css, not audio');
      if (pathname === '/index.html') return sameUrlResponse(`${ORIGIN}/index.html`, SHELL_HTML);
      return sameUrlResponse(`${ORIGIN}${pathname}`, 'body');
    },
  });

  await assert.rejects(runInstall(worker), /precache refuses a redirected response for \/sounds\/airhorn\.mp3/,
    'an audio file redirecting to a precached stylesheet is still refused');
  const content = worker.instances.find((c) => c.name === 'airhorner-__BUILD_HASH__');
  assert.equal(content.writes.includes(MP3), false, 'and it is still not stored under the requested key');
});

// airhorn-c1sx (review finding on the alias fix). The failure branches must evict the entry the read actually
// touched. On the alias path that entry is the canonical one, so evicting the alias spelling instead would leave
// an unvouched canonical copy sitting in the cache until some later direct read happened to drop it. Nothing
// unvouched is ever served either way - this pins the cleanup, so the leftover cannot come back.
test('an alias read that finds the canonical copy unvouched evicts the canonical entry it read', async () => {
  const { worker, goOffline } = pagesShapedWorker();
  await runInstall(worker);
  const content = worker.caches.get('airhorner-__BUILD_HASH__');
  const meta = worker.caches.get('horn-integrity-__BUILD_HASH__');
  assert.equal(content.entries.has('/'), true, 'the canonical copy is stored by the install');

  // Strip the vouching record, then go offline: the only way to answer a navigation is unvouched bytes.
  meta.entries.delete('/');
  goOffline();

  const response = await navigate(worker, '/index.html');
  const body = await response.text();
  assert.doesNotMatch(body, /the shell/, 'unvouched bytes must never be served');
  assert.match(body, /needs a connection/, 'with nothing vouched left, the offline page is the honest answer');
  assert.equal(content.entries.has('/'), false,
    'the read that discovered the unvouched canonical copy must drop it (not leave it for a later direct read)');
  assert.equal(content.entries.has('/index.html'), false, 'and nothing is stored under the alias spelling');
});

test('an alias read with an unparseable record evicts the canonical entry too', async () => {
  const { worker, goOffline } = pagesShapedWorker();
  await runInstall(worker);
  const content = worker.caches.get('airhorner-__BUILD_HASH__');
  const meta = worker.caches.get('horn-integrity-__BUILD_HASH__');

  meta.entries.set('/', new Response('not json at all', { status: 200 }));
  goOffline();

  const response = await navigate(worker, '/index.html');
  await response.text();
  assert.equal(content.entries.has('/'), false, 'a record that cannot be parsed evicts the entry it describes');
});

/*
 * airhorn-oybq: the integrity record used to be TRUST-ON-FIRST-USE - its baseline digest was computed from the very
 * fetch it later vouched for, so a poisoned first fetch became the truth the record defended. The build now ships a
 * digest per emitted file and the worker refuses a first fetch that is not the built bytes.
 *
 * Three worlds, because the failure mode has a direction that matters: refusing everything would be as dishonest as
 * trusting everything.
 */
test('integrity baseline: a first fetch that disagrees with the build is refused, not recorded (airhorn-oybq)', async () => {
  const POISON = 'POISONED-BYTES';
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  // The build says every precache URL is the good bytes; the network serves poison for one of them.
  const honest = '/sounds/airhorn.mp3';
  const digests = {};
  for (const url of ['/', '/index.html', '/styles/main.css', honest]) digests[url] = sha(`good ${url}`);
  digests[honest] = sha('good /sounds/airhorn.mp3');
  digests['/styles/main.css'] = sha('DEFINITELY-NOT-THE-SERVED-CSS');
  const worker = loadWorker({
    digests,
    fetchImpl: async (req) => {
      const p = new URL(req.url).pathname;
      return sameUrlResponse(ORIGIN + p, p === '/styles/main.css' ? POISON : `good ${p}`);
    },
  });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await assert.rejects(waited, /do not match the build/,
    'an install whose fetched bytes disagree with the build must fail, naming the reason');

  // And nothing survived: the install's own cleanup deletes the half-built caches, so no poisoned body and no
  // integrity record for it are left behind to be read later.
  const leftovers = [...worker.caches.keys()];
  for (const name of leftovers) {
    const cache = worker.caches.get(name);
    assert.equal(cache.entries.has('/styles/main.css'), false,
      `${name} still holds /styles/main.css after a refused install: ${JSON.stringify([...cache.entries.keys()])}`);
  }
});

test('integrity baseline: bytes that DO match the build still install and record (airhorn-oybq)', async () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const urls = ['/', '/index.html', '/styles/main.css', '/sounds/airhorn.mp3'];
  const digests = Object.fromEntries(urls.map((u) => [u, sha(`good ${u}`)]));
  const worker = loadWorker({
    digests,
    fetchImpl: async (req) => {
      const p = new URL(req.url).pathname;
      return sameUrlResponse(ORIGIN + p, `good ${p}`);
    },
  });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await waited; // must NOT reject: binding the baseline must not break the honest path
  const meta = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('horn-integrity-')));
  assert.ok(meta, `the integrity cache must exist after a matching install, caches: ${JSON.stringify([...worker.caches.keys()])}`);
  assert.ok(meta.entries.has('/styles/main.css'),
    `a matching body is recorded - the binding must not be "refuse everything"; recorded: ${JSON.stringify([...meta.entries.keys()])}`);
  // airhorn-oybq option (a): the record must SAY the build verified these bytes, or a reader cannot tell a bound baseline
  // from a first-write one.
  const record = JSON.parse(await (await meta.match(new Request(ORIGIN + '/styles/main.css'))).clone().text());
  assert.equal(record.basis, 'build-manifest', 'bytes checked against the build must be recorded as build-manifest');
  assert.equal(record.verifiedAgainstBuild, true);
});

test('integrity baseline: an UNBUILT worker says out loud that it is trust-on-first-use (airhorn-oybq)', async () => {
  const worker = loadWorker({
    fetchImpl: async (req) => sameUrlResponse(ORIGIN + new URL(req.url).pathname, 'good'),
  });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await waited; // unbound is a documented degradation, not a failure - but it must be NAMED
  const said = worker.warnings.filter((line) => line.includes('trust-on-first-use'));
  assert.ok(said.length >= 1, `an unbuilt worker must warn that its records are TOFU, got: ${JSON.stringify(worker.warnings)}`);
  assert.match(said[0], /no build digest .* trust-on-first-use \(airhorn-oybq\)/);
});

/*
 * airhorn-oybq, options (a) and (b) as coord specified them: a record must SAY how its baseline was established, and a
 * second record with different bytes must not silently replace the first.
 *
 * The shape that matters is "the digest changes between runs": the worker installs, verifies and records; then the same
 * worker version sees different bytes for the same path. Before this, the record was simply overwritten, so the changed
 * script BECAME the new truth and every later read compared against it happily.
 */
test('integrity record: a second, different digest is REFUSED rather than silently becoming the new baseline (airhorn-oybq)', async () => {
  // Option (b). The world has to reach record() TWICE for the same path with different bytes, so this worker is UNBOUND
  // (no build manifest): with a manifest the first-copy check refuses earlier and the overwrite path is never exercised -
  // my first version of this test made that mistake and stayed green when the refusal was deleted, which is the exact
  // false-green this fleet keeps finding. Under an unbound worker, the old behaviour was: record 1 = good bytes, then
  // record 2 = changed bytes REPLACES it, so every later read compares against the changed copy and passes.
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  let css = 'the original stylesheet';
  const worker = loadWorker({
    digests: {},
    fetchImpl: async (req) => {
      const p = new URL(req.url).pathname;
      return sameUrlResponse(ORIGIN + p, p === '/styles/main.css' ? css : `bytes for ${p}`);
    },
  });
  const install = async () => {
    let waited;
    for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
    return waited;
  };
  const recorded = async (pathname, meta) => JSON.parse(await (await meta.match(new Request(ORIGIN + pathname))).clone().text());

  await install();
  const meta = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('horn-integrity-')));
  const first = await recorded('/styles/main.css', meta);
  assert.equal(first.sha256, sha('the original stylesheet'));
  assert.equal(first.basis, 'tofu', 'an unbound baseline is labelled tofu, never build-manifest');

  // The response changes under the same worker version. The reinstall must not adopt the new bytes as the baseline.
  css = 'a changed stylesheet';
  await install();
  const after = await recorded('/styles/main.css', meta);
  assert.equal(after.sha256, first.sha256,
    `the recorded baseline must survive a changed response, got ${after.sha256} (the new bytes) vs ${first.sha256}`);
  assert.ok(worker.warnings.some((line) => line.includes('refusing to replace the baseline recorded for /styles/main.css')
    && line.includes(first.sha256) && line.includes(sha('a changed stylesheet'))),
    'and the refusal must be NAMED, with both digests, so an operator can see what changed: '
    + JSON.stringify(worker.warnings));
});

test('integrity record: an UNVERIFIED baseline is labelled tofu, not left looking verified (airhorn-oybq)', async () => {
  // No manifest for this path: the worker still precaches (offline must work), but the record must not claim the build
  // verified it. This is option (a) - provenance on the record itself, so an audit reads the truth without reading code.
  const worker = loadWorker({ digests: {}, fetchImpl: async (req) => sameUrlResponse(ORIGIN + new URL(req.url).pathname, 'bytes') });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await waited;
  const meta = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('horn-integrity-')));
  const record = JSON.parse(await (await meta.match(new Request(ORIGIN + '/styles/main.css'))).clone().text());
  assert.equal(record.basis, 'tofu', 'a first-write baseline must be labelled tofu');
  assert.equal(record.verifiedAgainstBuild, false);
  assert.equal(record.sha256.length, 64, 'the digest is still recorded - the label is provenance, not a weaker check');
});

/*
 * airhorn-5km4 (P2, found by the cross-family review of oybq): the build check lived only in putVerified, so the INSTALL
 * refused a mismatched copy while the RUNTIME path stored and recorded whatever the network returned. After an eviction
 * there is no record for record()'s refusal to compare against, so poison became a fresh, durable baseline - the exact
 * TOFU shape oybq exists to close, one step later on a path anyone can reach by leaving the tab open.
 */
test('runtime re-store: after an eviction, bytes that disagree with the build are NOT cached or recorded (airhorn-5km4)', async () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const urls = ['/', '/index.html', '/styles/main.css', '/sounds/airhorn.mp3'];
  const digests = Object.fromEntries(urls.map((u) => [u, sha(`good ${u}`)]));
  const POISON = 'POISONED-CSS';
  let servePoison = false;
  const worker = loadWorker({
    digests,
    fetchImpl: async (req) => {
      // Accept a string too: precache()'s dynamic step calls fetch('/index.html') that way, and a stub that threw on it
      // would leave "Invalid URL" in the warning list, where it would look like a worker defect in a later failure.
      const p = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
      const body = p === '/styles/main.css' ? (servePoison ? POISON : `good ${p}`) : `good ${p}`;
      return sameUrlResponse(ORIGIN + p, body);
    },
  });
  const install = async () => {
    let waited;
    for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
    return waited;
  };
  await install();
  const meta = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('horn-integrity-')));
  const content = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('airhorner-')));

  // Something corrupts the cached body, so the next read fails verification and the worker evicts - which also deletes
  // the record the (b) refusal would have compared against. Then the network answers with poison.
  content.entries.set('/styles/main.css', new Response('tampered on disk'));
  servePoison = true;
  await runFetch(worker, '/styles/main.css');

  // The refusal must be NAMED (a silently swallowed side-effect failure looks identical to a successful store).
  assert.ok(worker.warnings.some((line) => line.includes('not caching /styles/main.css') && line.includes('do not match the build')),
    `the runtime refusal must say why nothing was cached, got: ${JSON.stringify(worker.warnings)}`);
  // And nothing durable: no body, and no record vouching for the poison.
  assert.equal(content.entries.has('/styles/main.css'), false, 'poison must not be left in the content cache');
  assert.equal(meta.entries.has('/styles/main.css'), false, 'and no record may vouch for it');

  // Offline afterwards: the poison must not come back as a verified hit.
  servePoison = false;
  const gone = { offline: true };
  worker.sandbox.fetch = async () => { throw new TypeError('network down'); };
  const offline = await runFetch(worker, '/styles/main.css').catch((err) => err);
  if (offline instanceof Response) {
    const text = await offline.text();
    assert.doesNotMatch(text, /POISONED-CSS/, 'a poisoned body must never be served from cache as verified');
  } else {
    assert.ok(offline, 'an offline miss may reject, but must not resolve to the poisoned cached body');
  }
});

/*
 * airhorn-s15g (P3, same review): the provenance label under-claimed in two places. A hashed asset whose bytes the
 * manifest BOUND was recorded as 'tofu' because precache() threw away the dynamic batch's results - the label said
 * first-write about a copy the build had verified. And a runtime re-store of identical good bytes flipped a
 * build-manifest baseline to tofu. Under-claiming is the safe direction, but (a)'s whole point is that an audit reads the
 * record and learns how the baseline was established, so a wrong label is a wrong record.
 */
test('provenance: a bound hashed asset and a bound runtime re-store are labelled build-manifest, not tofu (airhorn-s15g)', async () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const ASSET = '/assets/app-abc123.js';
  const HTML = '<script type="module" src="/assets/app-abc123.js"></script>';
  const urls = ['/', '/styles/main.css', '/sounds/airhorn.mp3', ASSET];
  const digests = Object.fromEntries(urls.map((u) => [u, sha(`good ${u}`)]));
  digests['/index.html'] = sha(HTML);
  const worker = loadWorker({
    digests,
    fetchImpl: async (req) => {
      // precache()'s dynamic step calls fetch('/index.html') with a STRING, so this stub has to accept both shapes.
      const p = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
      if (p === '/index.html') return sameUrlResponse(ORIGIN + p, HTML);
      return sameUrlResponse(ORIGIN + p, `good ${p}`);
    },
  });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await waited;
  const meta = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('horn-integrity-')));
  const recorded = async (pathname) => JSON.parse(await (await meta.match(new Request(ORIGIN + pathname))).clone().text());

  // (1) The dynamically discovered hashed asset: bound by the manifest, so its record must say so.
  const asset = await recorded(ASSET);
  assert.equal(asset.basis, 'build-manifest',
    'a hashed asset the manifest bound must not be labelled tofu just because it was discovered from index.html');
  assert.equal(asset.verifiedAgainstBuild, true);

  // (2) A runtime re-store of IDENTICAL good bytes after an eviction keeps the build-manifest label.
  const content = worker.caches.get([...worker.caches.keys()].find((k) => k.startsWith('airhorner-')));
  content.entries.set('/styles/main.css', new Response('tampered on disk'));
  await runFetch(worker, '/styles/main.css');
  const restored = await recorded('/styles/main.css');
  assert.equal(restored.basis, 'build-manifest', 'a re-store of bytes that match the build is still build-verified');
  assert.equal(restored.sha256, sha('good /styles/main.css'), 'and it re-established the GOOD bytes, not the tampered ones');
});

/*
 * airhorn-lu8a (P2, found by the second review): the manifest mapped index.html to '/' only, but the worker precaches BOTH
 * shell spellings on purpose, so '/index.html' had no build digest and basisFor() fell back to TOFU for a statically
 * precached path. A poisoned first fetch of '/index.html' installed cleanly and was then served offline as a VERIFIED hit.
 *
 * Two grounds, because the fix has two halves and either one alone can regress silently: the manifest must cover every
 * spelling the worker asks for, and a built worker must REFUSE an uncovered static path rather than record it as TOFU.
 */
test('manifest covers both shell spellings, so a poisoned /index.html cannot install (airhorn-lu8a)', async () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const HTML = 'the one document, under two spellings';
  // A real build's manifest now carries both keys; the network poisons the NON-canonical spelling.
  const digests = {
    '/': sha(HTML),
    '/index.html': sha(HTML),
    '/styles/main.css': sha('good /styles/main.css'),
    '/sounds/airhorn.mp3': sha('good /sounds/airhorn.mp3'),
  };
  const worker = loadWorker({
    digests,
    fetchImpl: async (req) => {
      const p = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
      if (p === '/index.html') return sameUrlResponse(ORIGIN + p, 'POISONED DOCUMENT');
      return sameUrlResponse(ORIGIN + p, p === '/' ? HTML : `good ${p}`);
    },
  });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await assert.rejects(waited, /do not match the build/,
    'a document fetched under a second spelling is still the build\'s bytes and must be checked as such');
  // The failed install's own cleanup deletes the half-built caches, so check EVERY surviving cache rather than assume the
  // content cache still exists - and check the bytes, not just presence, since a record is also a place poison can hide.
  for (const name of worker.caches.keys()) {
    const cache = worker.caches.get(name);
    const held = cache.entries.get('/index.html');
    assert.notEqual(held?.body, 'POISONED DOCUMENT', `${name} must not hold the poisoned document`);
  }
});

test('a BUILT worker REFUSES a statically precached path the manifest does not cover (airhorn-lu8a)', async () => {
  // The belt to the manifest's braces: if a future precacheUrls entry (or a mapping regression) is uncovered, the install
  // must fail by name. Silently recording TOFU for a static path is precisely how lu8a went unnoticed - the record looked
  // fine and the gap was in what the manifest omitted.
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const digests = {
    '/': sha('doc'),
    '/styles/main.css': sha('good /styles/main.css'),
    '/sounds/airhorn.mp3': sha('good /sounds/airhorn.mp3'),
    // '/index.html' deliberately missing, which is exactly the real build's behaviour before this fix.
  };
  const worker = loadWorker({ digests, fetchImpl: async (req) => sameUrlResponse(ORIGIN + new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname, 'doc') });
  let waited;
  for (const listener of worker.listeners.install) listener({ waitUntil: (promise) => { waited = promise; } });
  await assert.rejects(waited, /build manifest does not cover this path/,
    'an uncovered STATIC precache path must fail the install in a built worker, not degrade to TOFU');
  assert.ok(worker.warnings.every((line) => !line.includes('trust-on-first-use')),
    `and it must not also claim TOFU-by-design for it: ${JSON.stringify(worker.warnings)}`);
});


/* airhorn-htix: the skipWaiting handler's unvalidated sender is a DECISION, not an
 * oversight - the nightly threat-model station re-reported it until the reasoning sat next
 * to the handler. The pin keeps the decision with the code: remove the handler's decision
 * comment and this fails, so the next audit reads the answer instead of re-asking. */
test('the skipWaiting message handler carries its sender-validation decision (airhorn-htix)', () => {
  const handlerIdx = SW_SOURCE.indexOf("event.data === 'skipWaiting'");
  assert.ok(handlerIdx > 0, 'the skipWaiting handler must exist (the update flow depends on it)');
  const before = SW_SOURCE.slice(Math.max(0, handlerIdx - 1400), handlerIdx);
  assert.match(before, /DECISION \(airhorn-htix/,
    'the handler must carry the htix decision comment: unvalidated sender is deliberate (same-origin-only reachability, null-source risk), not an oversight');
});
