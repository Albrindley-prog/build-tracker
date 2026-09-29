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
    // Keep the offline page if the device lets us. If its storage is full or
    // unavailable, carry on without it: always-fresh pages matter more.
    try {
      const cache = await caches.open(VERSION);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    } catch (e) { /* no offline page on this device */ }
    await self.skipWaiting();   // a new version takes over straight away
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key); } catch (e) {}
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
      const saved = await caches.match(OFFLINE_URL).catch(() => null);
      return saved || new Response('You are offline. Check your connection, then try again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
