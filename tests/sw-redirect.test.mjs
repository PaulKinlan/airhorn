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

// A Response that a real fetch would return after following a redirect: the
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
