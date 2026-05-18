const CACHE_NAME = 'golden-lines-mobile-v2';
const BASE_URL = new URL('./', self.location.href);
const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'vocab-store.json'
].map((path) => new URL(path, BASE_URL).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.hostname === 'api.github.com') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok && url.origin === self.location.origin) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match(new URL('index.html', BASE_URL).toString())))
  );
});
