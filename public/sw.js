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

const version = "0.7.1";
const cacheName = `airhorner-${version}`;

const precacheUrls = [
  `/`,
  `/index.html`,
  `/styles/main.css`,
  `/scripts/pwacompat.min.js`,
  `/sounds/airhorn.mp3`
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(cacheName).then(cache => {
      return cache.addAll(precacheUrls).then(() => self.skipWaiting());
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== cacheName).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
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
