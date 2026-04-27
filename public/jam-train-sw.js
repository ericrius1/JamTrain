const HANDPOSE_CACHE = 'jam-train-handpose-v1';
const HANDPOSE_CACHE_PREFIX = 'jam-train-handpose-';
const HANDPOSE_PATH_PREFIX = '/handpose/';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name.startsWith(HANDPOSE_CACHE_PREFIX) && name !== HANDPOSE_CACHE)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(HANDPOSE_PATH_PREFIX)) return;

  event.respondWith(cacheHandposeRequest(request));
});

async function cacheHandposeRequest(request) {
  const cache = await caches.open(HANDPOSE_CACHE);
  const cached = await cache.match(request);
  if (cached) return markCache(cached, 'hit');

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return markCache(response, 'miss');
}

function markCache(response, value) {
  const headers = new Headers(response.headers);
  headers.set('X-Jam-Train-Handpose-Cache', value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
