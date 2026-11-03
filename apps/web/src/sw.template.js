/* Accident service worker: keeps the whole app available offline so practice works without a network.
 * Every built file is cached at install time, including the Web Worker the computer runs in, which
 * the page would otherwise only fetch once a game starts (too late if the phone is already offline).
 *
 * Strategy:
 *  - Page navigations: network first, fall back to the cached shell (so updates arrive when online).
 *  - Same-origin static assets (hashed by the build): cache first, since they never change.
 *  - Everything else (RPC, relay, APIs): never touched. Friend mode needs the network anyway.
 */
// Filled in by the build (see vite.config.ts): every file the app needs, with its hashed name, and a
// version derived from their names so each release gets a fresh cache.
const VERSION = '__VERSION__';
const SHELL = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith('/assets/')) {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
