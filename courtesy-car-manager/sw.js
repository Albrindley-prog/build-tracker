// Courtesy Car Manager — service worker (online-only).
//
// Scope is this folder, /courtesy-car-manager/, so nothing else on
// build-tracker.co.uk is ever affected.
//
// It deliberately stores nothing but a small "you're offline" page. Every
// screen is fetched fresh from the network (skipping the browser's 10-minute
// cache), and data, photos, PDFs and sign-in requests are never touched —
// the browser handles those exactly as it would without a service worker.
// So whatever is published reaches installed apps the next time they open.
//
// Bump VERSION only if the offline page changes.
const VERSION = 'ccm-sw-1';
const OFFLINE_URL = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    await self.skipWaiting();   // a new version takes over straight away
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;   // only opening the app's pages
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' });
      // A page reached via a redirect can't be handed back as-is; pass on a clean copy.
      return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
    } catch (e) {
      return (await caches.match(OFFLINE_URL)) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
