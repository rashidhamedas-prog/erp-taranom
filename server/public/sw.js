// ERP Taranom - service worker: network-first for HTML+JS+CSS, cache-first for images
const CACHE = 'erp-taranom-v187';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.url.includes('/api/')) return;
  if (req.url.includes('/uploads/')) return;

  const url = new URL(req.url);
  const path = url.pathname || '';
  const isHTML = req.headers.get('accept')?.includes('text/html') ||
                 path.endsWith('/') || path.endsWith('.html');
  // App logic must not stick on stale cache (marketer-ui.js etc.)
  const isAppCode = /\.(js|css)$/i.test(path) || path.endsWith('sw.js');

  if (isHTML || isAppCode) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }
          return res;
        });
      })
    );
  }
});
