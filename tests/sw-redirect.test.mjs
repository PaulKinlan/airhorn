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
import { fileURLToPath } from 'node:url';

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
function loadWorker({ fetchImpl } = {}) {
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
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'public/sw.js' });

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
