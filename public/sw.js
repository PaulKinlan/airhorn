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

const precacheUrls = [
  `/`,
  `/index.html`,
  `/styles/main.css`,
  `/sounds/airhorn.mp3`,
  /* __PRECACHE_ASSETS__ */
];

async function precache() {
  const cache = await caches.open(cacheName);
  const validUrls = precacheUrls.filter(url => typeof url === 'string' && url.length > 0);
  await cache.addAll(validUrls);

  // Dynamic fallback: ensure any hashed /assets/ in index.html are precached
  try {
    const res = await fetch('/index.html');
    if (res.ok) {
      const html = await res.text();
      const assetMatches = html.matchAll(/(?:src|href)=['"](\/assets\/[^'"]+)['"]/g);
      const dynamicUrls = Array.from(assetMatches, m => m[1]);
      if (dynamicUrls.length > 0) {
        await cache.addAll(dynamicUrls);
      }
    }
  } catch (err) {
    console.warn('Fallback asset precaching error:', err);
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n.startsWith('airhorner-') && n !== cacheName).map(n => caches.delete(n))
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
  const url = new URL(event.request.url);

  // Hashed assets (e.g. /assets/index-Cb7tU7WW.js) are immutable —
  // serve from cache or fetch and cache for offline use.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(cacheName).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Precached resources: serve from cache, fall back to network.
  event.respondWith(
    caches.open(cacheName)
      .then(cache => cache.match(event.request, {ignoreSearch: true}))
      .then(response => response || fetch(event.request))
  );
});
