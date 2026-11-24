/* Service worker: the app opens fast and works offline. Live data (API, order stream, photos) is never cached here. */
const V = '__V__';
const CACHE = 'shop-shell-' + V;
const SHELL = ['/', '/owner', '/offline', '/css/app.css?v=' + V, '/js/common.js?v=' + V, '/js/shop.js?v=' + V, '/js/owner.js?v=' + V, '/manifest.webmanifest?v=' + V, '/owner.webmanifest?v=' + V, '/img/icon-192.png', '/img/favicon-32.png'];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => { const c = await caches.open(CACHE); await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))); await self.skipWaiting(); })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => { for (const k of await caches.keys()) if (k.indexOf('shop-shell-') === 0 && k !== CACHE) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/^\/(api|photos)\//.test(url.pathname) || url.pathname === '/healthz' || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))]); }
      catch (e) { const c = await caches.open(CACHE); return (await c.match(url.pathname === '/owner' ? '/owner' : '/')) || (await c.match('/offline')) || Response.error(); }
    })());
    return;
  }
  event.respondWith((async () => {
    const c = await caches.open(CACHE), hit = await c.match(req);
    if (hit) return hit;
    try { const net = await fetch(req); if (net && net.ok && /^\/(css|js|img)\/|\.webmanifest$/.test(url.pathname)) c.put(req, net.clone()).catch(() => {}); return net; }
    catch (e) { return (await c.match(req, { ignoreSearch: true })) || Response.error(); }
  })());
});
self.addEventListener('push', (event) => {
  let d = {}; try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (d.kind !== 'test' && wins.some((w) => w.visibilityState === 'visible' && w.url.indexOf('/owner') >= 0)) return;
    await self.registration.showNotification(d.title || 'Shop', { body: d.body || '', tag: d.tag || 'shop', renotify: true, icon: '/img/icon-192.png', badge: '/img/favicon-48.png', vibrate: [300, 120, 300, 120, 300], requireInteraction: d.kind === 'order', data: { url: d.url || '/owner' } });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/owner';
  event.waitUntil((async () => { for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) if (c.url.indexOf('/owner') >= 0 && 'focus' in c) return c.focus(); return self.clients.openWindow(target); })());
});
