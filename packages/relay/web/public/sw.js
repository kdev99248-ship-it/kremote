/* kremote service worker - deliberately tiny (no tooling, no framework).
 *
 * Strategy:
 *  - App shell (index.html): network-first, fall back to cache when the relay
 *    is unreachable, so the login screen still opens offline.
 *  - Hashed build assets (/assets/*), icons, fonts: cache-first - they never
 *    change for a given filename, so a stale copy is always safe.
 *  - Everything else (/ws websocket, /healthz, API): never intercepted.
 *
 * Version bump = delete the old cache. Keep V only when file lists change. */
const V = 'kremote-v1';
const SHELL = '/index.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll([SHELL])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname === '/healthz') return;

  // Hashed assets + icons: immutable, cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icon-')) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(V).then((c) => c.put(e.request, copy));
        }
        return res;
      })),
    );
    return;
  }

  // Shell + manifest: network-first with offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (url.pathname === '/' || url.pathname === SHELL)) {
          const copy = res.clone();
          caches.open(V).then((c) => c.put(SHELL, copy));
        }
        return res;
      })
      .catch(() => caches.match(SHELL)),
  );
});
