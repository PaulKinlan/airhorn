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
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return null;

  const recordHolder = await meta.match(request, { ignoreSearch: true });
  if (!recordHolder) {
    await evict(cache, meta, request);
    return null;
  }

  let expected;
  try {
    expected = await recordHolder.json();
  } catch {
    await evict(cache, meta, request);
    return null;
  }

  const body = await cached.clone().arrayBuffer();
  if (body.byteLength !== expected.length || (await digest(body)) !== expected.sha256) {
    await evict(cache, meta, request);
    return null;
  }
  return cached;
}

async function precache() {
  const cache = await caches.open(cacheName);
  const meta = await caches.open(metaCacheName);
  const validUrls = precacheUrls.filter(url => typeof url === 'string' && url.length > 0);
  await cache.addAll(validUrls);
  const storedUrls = [...validUrls];

  // Dynamic fallback: ensure any hashed /assets/ in index.html are precached
  try {
    const res = await fetch('/index.html');
    if (res.ok) {
      const html = await res.text();
      const assetMatches = html.matchAll(/(?:src|href)=['"](\/assets\/[^'"]+)['"]/g);
      const dynamicUrls = Array.from(assetMatches, m => m[1]);
      if (dynamicUrls.length > 0) {
        await cache.addAll(dynamicUrls);
        storedUrls.push(...dynamicUrls);
      }
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

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const meta = await caches.open(metaCacheName);

    const verified = await verifiedFromCache(cache, meta, request);
    if (verified) return verified;

    try {
      const response = await fetch(request);
      // Storing is a side effect of serving, never a precondition for it.
      if (response && response.ok && precachePaths.has(url.pathname)) {
        await store(cache, meta, url.pathname, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      // Better a visible failure than bytes nobody vouched for.
      return new Response('The Air Horner could not load this part of itself.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
