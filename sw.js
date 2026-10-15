'use strict';
// Bump the cache version whenever the app shell changes.
const CACHE_PREFIX = 'sx12-app-shell-' + encodeURIComponent(new URL(self.registration.scope).pathname) + '-';
const CACHE_NAME = CACHE_PREFIX + '2026-10-15-v1';
const SHELL = [
  './index.html', './pwa.js', './manifest.webmanifest',
  './icons/apple-touch-icon.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-maskable-512.png'
].map(path => new URL(path, self.registration.scope).href);
const INDEX_URL = SHELL[0];
const SCOPE_URL = new URL(self.registration.scope);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Reject login redirects or HTML substituted for JS/icons, rather than
    // caching a broken shell. Samples and settings live separately in IndexedDB.
    const responses = await Promise.all(SHELL.map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      const type = response.headers.get('content-type') || '';
      const validType = url.endsWith('.html') ? type.includes('text/html')
        : url.endsWith('.js') ? /javascript/.test(type)
        : url.endsWith('.png') ? type.includes('image/png')
        : /json|manifest/.test(type);
      if (!response.ok || response.redirected || !validType)throw Error('App shell unavailable: ' + url);
      return response;
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map((url, i) => cache.put(url, responses[i])));
    // A new version waits until the user explicitly chooses to apply it.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only our own shell caches are removed; sample data is never cleared.
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET')return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin)return;
  url.search = '';
  url.hash = '';
  const canonical = url.href;
  const isAppNavigation = request.mode === 'navigate' && (canonical === SCOPE_URL.href || canonical === INDEX_URL);
  if (!isAppNavigation && !SHELL.includes(canonical))return;
  // Every controlled client uses one complete shell version until activation.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(isAppNavigation ? INDEX_URL : canonical) || fetch(request);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING')event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'CHECK_OFFLINE' && event.ports[0]) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const entries = await Promise.all(SHELL.map(url => cache.match(url)));
      event.ports[0].postMessage({ ready: entries.every(Boolean) });
    })());
  }
});
