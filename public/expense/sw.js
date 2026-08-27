/* Brixpense service worker — conservative PWA shell.
 * - Navigations: network-first (so a new deploy is never masked by a stale cache),
 *   falling back to the cached shell only when offline.
 * - Hashed build assets (/expense/assets/*): cache-first (they're immutable).
 * - Everything else (Supabase, fonts, APIs = cross-origin) is left untouched.
 * Bump CACHE to invalidate old caches on the next activate. */
const CACHE = 'brixpense-v2';
const SHELL = [
  '/expense/',
  '/expense/index.html',
  '/expense/Brix-Round-Logo.png',
  '/expense/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't intercept Supabase/fonts/APIs

  // App navigations: always try the network first; fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match('/expense/index.html')) ||
            (await cache.match('/expense/')) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Immutable hashed assets: cache-first.
  if (url.pathname.startsWith('/expense/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const net = await fetch(request);
        if (net.ok) cache.put(request, net.clone());
        return net;
      })()
    );
  }
});
