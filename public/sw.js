/*
 *
 *  Air Horner
 *  Copyright 2015 Google Inc. All rights reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License
 *
 */

const version = "__BUILD_HASH__";
const cacheName = `airhorner-${version}`;
// Integrity records live in their own cache, deliberately NOT under the
// airhorner- prefix: the activate cleanup below and the existing suites both
// treat `airhorner-*` as "the app's precache".
const metaCacheName = `horn-integrity-${version}`;

const precacheUrls = [
  // Both shell spellings, deliberately (airhorn-btt): `/` is what a navigation
  // matches, and storing a navigation response is the only way an emptied cache
  // re-seeds itself from one online visit (tests/sw-failover.test.mjs stage D
  // depends on it); `/index.html` is what an in-page fetch and the navigation
  // fallback below ask for. It looks like a 11,962 B duplicate of the same
  // document - it is, byte for byte - and dropping it was measured to break
  // offline recovery after a cache wipe.
  `/`,
  `/index.html`,
  `/styles/main.css`,
  `/sounds/airhorn.mp3`,
  /* __PRECACHE_ASSETS__ */
];

const precachePaths = new Set(
  precacheUrls
    .filter(url => typeof url === 'string' && url.length > 0)
    .map(url => new URL(url, self.location.origin).pathname)
);

// Two spellings of ONE document, not two documents (airhorn-15fw): a static-asset
// host is entitled to canonicalise `/index.html` to `/` with a redirect - Cloudflare
// Pages does exactly that (308 locally, documented as HTML handling) - and when it
// does, `putVerified()`'s redirect refusal (airhorn-fdp6/98mt) would correctly refuse
// to store the alias and the whole install would fail, leaving the app with no worker.
// The refusal is NOT relaxed: a redirected response is still never stored under the key
// it was requested as. What this map adds is the other half of the fact - when the
// redirect lands on the canonical spelling of the same document AND that spelling is
// itself precached, the alias is satisfied by the canonical copy, reads for the alias
// resolve to it, and nothing extra is stored.
const documentAliases = new Map([
  [`/index.html`, `/`],
]);

function requestFor(pathname) {
  return new Request(new URL(pathname, self.location.origin));
}

async function digest(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Record what a good copy of this response looked like, so a later hit can be
// checked against it instead of trusted (airhorn-un5).
async function record(meta, pathname, response) {
  const body = await response.clone().arrayBuffer();
  await meta.put(requestFor(pathname), new Response(JSON.stringify({
    sha256: await digest(body),
    length: body.byteLength,
  }), { headers: { 'content-type': 'application/json' } }));
}

async function store(cache, meta, pathname, response) {
  await cache.put(requestFor(pathname), response.clone());
  await record(meta, pathname, response);
}

async function evict(cache, meta, request) {
  await cache.delete(request, { ignoreSearch: true });
  await meta.delete(request, { ignoreSearch: true });
}

// A cache hit is returned only when the bytes still match the record written
// alongside them. Anything else - a truncated write, a garbage body, an entry
// from a build that kept no record - is dropped so nothing keeps serving it,
// and the caller goes to the network instead.
async function verifiedFromCache(cache, meta, request) {
  let cached = await cache.match(request, { ignoreSearch: true });
  // An alias spelling is satisfied by the canonical document it names, so an
  // offline navigation to /index.html serves the stored `/` (airhorn-15fw). The
  // bytes are still only ever read from the entry whose key they were fetched as.
  let heldBy = request;
  if (!cached) {
    const canonical = documentAliases.get(new URL(request.url).pathname);
    if (!canonical) return null;
    heldBy = requestFor(canonical);
    cached = await cache.match(heldBy, { ignoreSearch: true });
    if (!cached) return null;
  }

  const recordHolder = await meta.match(heldBy, { ignoreSearch: true });
  // Every failure branch evicts the entry it actually READ (heldBy), not the
  // spelling that asked for it: on the alias path those differ, and evicting the
  // alias would leave an unvouched canonical entry in the cache until some later
  // direct read happened to drop it (airhorn-c1sx). Nothing unvouched is ever
  // served either way - this is about not leaving it behind.
  if (!recordHolder) {
    await evict(cache, meta, heldBy);
    return null;
  }

  let expected;
  try {
    expected = await recordHolder.json();
  } catch {
    await evict(cache, meta, heldBy);
    return null;
  }

  const body = await cached.clone().arrayBuffer();
  if (body.byteLength !== expected.length || (await digest(body)) !== expected.sha256) {
    await evict(cache, meta, heldBy);
    return null;
  }
  return cached;
}

// A redirect must never be cached or recorded as the thing it was asked for
// (factory audit 2026-11-03, the root cause behind both sw.js findings):
// cache.addAll() follows redirects silently and keys the FINAL body under the
// REQUESTED URL, so a 302 poisons the cache and the integrity record then
// vouches for the poison. Fetch, verify the bytes came from the URL they will
// be stored under, then put - and a redirect fails the install as ITSELF,
// naming both URLs, rather than recording poison.
// ONE statement of the redirect rule (airhorn-98mt), because both guards below enforce the same thing
// and two hand-copied expressions drift. The rule: a response may only be trusted for the URL it was
// REQUESTED as. A redirect means the bytes came from somewhere else; storing them under the requested
// pathname is what cache.addAll() did silently, and the integrity record then vouches for the poison.
function redirectedAwayFrom(response, pathname) {
  return response.redirected || new URL(response.url).pathname !== pathname;
}

async function putVerified(cache, url) {
  const pathname = new URL(url, self.location.origin).pathname;
  const response = await fetch(requestFor(pathname));
  if (!response.ok) throw new Error(`precache fetch failed for ${pathname}: HTTP ${response.status}`);
  if (redirectedAwayFrom(response, pathname)) {
    // The ONE redirect that is not a poison: the origin canonicalised this spelling
    // to the other spelling of the same document, which is precached itself. Nothing
    // is stored under this key - the canonical entry is what reads resolve to.
    const canonical = documentAliases.get(pathname);
    const finalPathname = new URL(response.url).pathname;
    if (canonical && finalPathname === canonical && precachePaths.has(canonical)) {
      return { alias: pathname, canonical };
    }
    throw new Error(`precache refuses a redirected response for ${pathname} (final URL ${response.url}): the bytes would be stored and recorded as ${pathname}`);
  }
  await cache.put(requestFor(pathname), response);
  return { stored: pathname };
}

// Bounded concurrency (airhorn-86mz): the redirect fix's per-URL
// fetch-then-put made precaching N assets N sequential round trips, where
// addAll fetched concurrently. A small pool restores the overlap WITHOUT
// relaxing the guarantee: every URL still goes through putVerified (fetch,
// refuse a redirect, then put), and a rejection propagates out of the pool
// exactly as it did out of the serial loop - the install fails, named, and
// the install catch deletes the half-built caches, so no half-populated
// cache can survive to be recorded.
const PRECACHE_CONCURRENCY = 6;
async function mapPooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function precache() {
  const cache = await caches.open(cacheName);
  const meta = await caches.open(metaCacheName);
  const validUrls = precacheUrls.filter(url => typeof url === 'string' && url.length > 0);
  const written = await mapPooled(validUrls, PRECACHE_CONCURRENCY, (url) => putVerified(cache, url));
  // An aliased spelling wrote nothing of its own; its reads are answered by the
  // canonical entry, so only the copies that were actually stored get a record.
  const storedUrls = written.filter((result) => result.stored).map((result) => result.stored);

  // Dynamic fallback: ensure any hashed /assets/ in index.html are precached
  try {
    const res = await fetch('/index.html');
    if (res.ok) {
      const html = await res.text();
      const assetMatches = html.matchAll(/(?:src|href)=['"](\/assets\/[^'"]+)['"]/g);
      const dynamicUrls = Array.from(assetMatches, m => m[1]);
      await mapPooled(dynamicUrls, PRECACHE_CONCURRENCY, (url) => putVerified(cache, url));
      storedUrls.push(...dynamicUrls);
    }
  } catch (err) {
    console.warn('Fallback asset precaching error:', err);
  }

  // One record per precached copy: the baseline the next read is checked against.
  for (const url of storedUrls) {
    const pathname = new URL(url, self.location.origin).pathname;
    const cached = await cache.match(requestFor(pathname), { ignoreSearch: true });
    if (cached) await record(meta, pathname, cached);
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    precache()
      .catch(async (err) => {
        // A denied write (QuotaExceededError) rejects the install, and the half-built
        // cache that caches.open() already created would be left behind for good: the
        // cleanup in the activate handler lives in the worker that never activated
        // (airhorn-nv9). The install still fails - a partial precache must not be
        // treated as complete - but it no longer leaks an empty cache. The integrity
        // records are in their own cache, so they need deleting too.
        await caches.delete(cacheName).catch(() => {});
        await caches.delete(metaCacheName).catch(() => {});
        throw err;
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name =>
            (name.startsWith('airhorner-') && name !== cacheName)
            || (name.startsWith('horn-integrity-') && name !== metaCacheName))
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

// A connection that answers late and then dies must not cost the user the app:
// both budgets are bounded, so the worker always answers (airhorn-46o).
const NAVIGATION_TIMEOUT_MS = 4000;
const FETCH_TIMEOUT_MS = 5000;

// Shown only when there is no verified shell to serve and the network did not
// answer: the one case where nothing on the device is worth showing.
const offlineDocument = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>The Air Horner - no connection</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center;
         font: 1.125rem/1.5 system-ui, sans-serif; text-align: center; padding: 1.5rem; }
  h1 { font-size: 1.5rem; margin-block: 0 0.75rem; }
  a { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem;
      border-radius: 999px; background: #2196f3; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>The Air Horner needs a connection</h1>
  <p>This page is not stored on your device yet, and the network did not answer.</p>
  <a href="/">Try again</a>
</main>
</body>
</html>`;

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const meta = await caches.open(metaCacheName);
    const isNavigation = request.mode === 'navigate';

    // A verified copy is served without waiting for the connection. For a
    // navigation that is the app shell: this app is one document and its
    // freshness is governed by the worker version, so hanging on a connection
    // that may never answer buys nothing (airhorn-46o).
    const verified = await verifiedFromCache(cache, meta, request);
    if (verified) return verified;

    if (isNavigation) {
      const shell = await verifiedFromCache(cache, meta, requestFor('/index.html'));
      if (shell) return shell;
    }

    try {
      const response = await fetch(request, {
        signal: AbortSignal.timeout(isNavigation ? NAVIGATION_TIMEOUT_MS : FETCH_TIMEOUT_MS),
      });
      // Storing is a side effect of serving, never a precondition for it - and
      // a REDIRECTED response is never stored at all: its bytes would sit under
      // the requested pathname, poisoning offline recovery, and the integrity
      // record would vouch for them (the same root cause putVerified() refuses
      // at install). Serving the network's answer is fine; caching it is not.
      if (response && response.ok && precachePaths.has(url.pathname)) {
        if (redirectedAwayFrom(response, url.pathname)) {
          console.warn(`sw: not caching ${url.pathname}: the response came from ${response.url} (redirected=${response.redirected})`);
        } else {
          await store(cache, meta, url.pathname, response.clone()).catch(() => {});
        }
      }
      return response;
    } catch (err) {
      if (isNavigation) {
        return new Response(offlineDocument, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      // Better a visible failure than bytes nobody vouched for, or a request
      // that never settles.
      return new Response('The Air Horner could not load this part of itself.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
