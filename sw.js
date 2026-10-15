'use strict';
// Change this version whenever any shell file changes.
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = 'sx12-app-shell-' + encodeURIComponent(SCOPE_URL.pathname) + '-';
const CACHE_NAME = CACHE_PREFIX + '2026-10-15-v3-refactor';
const SHELL = [
  './index.html', './styles.css', './pwa.js', './manifest.webmanifest',
  './js/app.js', './js/config.js', './js/sample.js', './js/presets.js',
  './js/session.js', './js/session-storage.js', './js/backup-codec.js',
  './js/audio-utils.js', './js/waveform.js',
  './icons/apple-touch-icon.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-maskable-512.png'
].map(path => new URL(path, SCOPE_URL).href);
const SHELL_URLS = new Set(SHELL);
const INDEX_URL = SHELL[0];

function expectedContentType(url, type) {
  if (url.endsWith('.html'))return type.includes('text/html');
  if (url.endsWith('.css'))return type.includes('text/css');
  if (url.endsWith('.js'))return /javascript/.test(type);
  if (url.endsWith('.png'))return type.includes('image/png');
  return /json|manifest/.test(type);
}

async function loadShellResponse(url) {
  const request = new Request(url, { cache: 'reload', credentials: 'same-origin' });
  const response = await fetch(request);
  const type = response.headers.get('content-type') || '';
  if (!response.ok || response.redirected || !expectedContentType(url, type)) {
    throw Error('App shell unavailable: ' + url);
  }
  return response;
}

async function installShell() {
  // Validate every response before writing the new shell. Login pages must fail.
  const responses = await Promise.all(SHELL.map(loadShellResponse));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(SHELL.map((url, index) => cache.put(url, responses[index])));
  // Wait for an explicit update action while an older version is still open.
}

async function activateShell() {
  const names = await caches.keys();
  await Promise.all(names
    .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map(name => caches.delete(name)));
  // Sample data is stored in IndexedDB, separate from these shell caches.
  await self.clients.claim();
}

function shellKey(request) {
  if (request.method !== 'GET')return null;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin)return null;
  url.search = '';
  url.hash = '';
  const appNavigation = request.mode === 'navigate' && (url.href === SCOPE_URL.href || url.href === INDEX_URL);
  if (appNavigation)return INDEX_URL;
  return SHELL_URLS.has(url.href) ? url.href : null;
}

async function cachedShellResponse(key, request) {
  const cache = await caches.open(CACHE_NAME);
  return await cache.match(key) || fetch(request);
}

async function reportOfflineReadiness(port) {
  const cache = await caches.open(CACHE_NAME);
  const entries = await Promise.all(SHELL.map(url => cache.match(url)));
  port.postMessage({ ready: entries.every(Boolean) });
}

self.addEventListener('install', event => event.waitUntil(installShell()));
self.addEventListener('activate', event => event.waitUntil(activateShell()));
self.addEventListener('fetch', event => {
  const key = shellKey(event.request);
  if (key)event.respondWith(cachedShellResponse(key, event.request));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING')event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'CHECK_OFFLINE' && event.ports[0]) {
    event.waitUntil(reportOfflineReadiness(event.ports[0]));
  }
});
