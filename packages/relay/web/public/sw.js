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
const V = 'kremote-v2';
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

// ── Web Push (tail alerts) ─────────────────────────────────────────────────
// The agent is the sender; here we just render whatever payload it pushed.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'kremote';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'kremote',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
