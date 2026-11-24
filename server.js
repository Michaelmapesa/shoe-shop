'use strict';
// Shoe & clothes shop: live order server. No dependencies, needs Node 18 or newer.
//   OWNER_PASSCODE=yourSecret DATA_DIR=./data node server.js
const http = require('http');
const path = require('path');
const cfg = require('./lib/config');
const { Shop } = require('./lib/shop');
const { Hub } = require('./lib/live');
const { makeAuth } = require('./lib/auth');
const { loadStatic, serve } = require('./lib/static');
const { createApi } = require('./lib/api');
const { Push } = require('./lib/push');

const log = (m) => console.log(new Date().toISOString() + ' ' + m);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function start(overrides = {}) {
  const c = Object.assign({}, cfg, overrides);
  c.ownerEnabled = c.ownerPasscode.length >= 6;
  const store = new Shop(c.dataDir, { tz: c.tz, defaults: c.defaults, log }).load();
  const hub = new Hub({ maxSse: c.maxSse, maxSsePerIp: c.maxSsePerIp });
  const auth = makeAuth(c, () => store.settings.sessionEpoch);
  const { files, version } = loadStatic(c.publicDir, {});
  const push = new Push(c.dataDir, { log, subject: c.pushSubject, env: process.env, transport: c.pushTransport });
  const api = createApi({ store, hub, auth, cfg: c, log, version, push });

  const money = (n) => 'KSh ' + Number(n || 0).toLocaleString('en-US');
  const lineText = (o) => o.items.map((l) => l.qty + '× ' + l.name + (l.size ? ' (' + l.size + ')' : '')).join(', ');

  // ----- store changes -> live screens and phone alerts
  store.on('order', (o) => {
    hub.toOwners('order', store.ownerOrder(o)); hub.toOrderWatchers(o.id, 'order', store.publicOrder(o));
    hub.toOwners('summary', store.summary(store.dayOf(Date.now())));
    pushAlert(o);
  });
  function pushAlert(o) {
    if (!push.count()) return;
    const last = o.history[o.history.length - 1] || {};
    let m = null;
    if (o.rev === 1) m = { title: 'New order #' + o.no + ' · ' + money(o.total), body: o.name + ' · ' + (o.method === 'delivery' ? 'Delivery' : 'Pickup') + ' · ' + lineText(o), tag: 'order-' + o.id, kind: 'order' };
    else if (last.s === 'pay_claimed' && Date.now() - last.at < 3000) m = { title: 'Payment code sent · #' + o.no, body: o.name + ' says they paid ' + money(o.total) + ' (code ' + o.mpesaCode + '). Check your M-Pesa messages.', tag: 'pay-' + o.id, kind: 'pay' };
    else if (last.s === 'cancelled' && last.by === 'customer' && Date.now() - last.at < 3000) m = { title: 'Order #' + o.no + ' cancelled by customer', body: o.name + ' · ' + money(o.total), tag: 'cancel-' + o.id, kind: 'cancel' };
    if (m) push.notify(m).catch(() => {});
  }
  store.on('soldout', (p) => { if (push.count()) push.notify({ title: 'Sold out: ' + p.name, body: 'Every size is gone. Hide it or add stock.', tag: 'so-' + p.id, kind: 'stock' }).catch(() => {}); });
  store.on('product', (p) => {
    hub.toOwners('product', store.ownerProduct(p));
    if (store.visible(p)) hub.toPublic('product', store.publicProduct(p)); else hub.toPublic('product-removed', { id: p.id });
  });
  store.on('product-removed', (id) => { hub.toOwners('product-removed', { id }); hub.toPublic('product-removed', { id }); });
  store.on('settings', () => { hub.toPublic('settings', { settings: store.publicSettings(), categories: store.categories }); hub.toOwners('settings', store.ownerSettings()); });
  store.on('reset', () => { hub.toOwners('reset', {}); hub.toPublic('reset', {}); });

  const backupTick = () => { try { if (store.dailyBackup(c.backupKeepDays)) log('daily backup saved'); } catch (e) { log('backup problem: ' + e.message); } };
  backupTick();
  const backupTimer = setInterval(backupTick, 30 * 60 * 1000); backupTimer.unref();
  const sweepTimer = setInterval(() => { try { store.sweep(); } catch (e) { log('sweep problem: ' + e.message); } }, 60 * 1000); sweepTimer.unref();

  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
  const baseHeaders = (req) => {
    const h = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
    };
    if (api.isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
    return h;
  };

  function servePhoto(req, res, url) {
    const p = store.readPhoto(url.pathname.slice('/photos/'.length));
    if (!p) return false;
    const h = { 'Content-Type': p.type, 'Content-Length': p.buf.length, ETag: p.etag, 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300' };
    if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, h); res.end(); return true; }
    res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : p.buf);
    return true;
  }

  // The storefront page, with the shop's name and (for a product link) its picture in the share preview.
  function servePage(req, res, url) {
    const page = files.get('/index.html');
    if (!page) return false;
    const s = store.settings, origin = (api.isHttps(req) ? 'https://' : 'http://') + (req.headers.host || 'localhost');
    let title = s.shopName, desc = s.tagline, image = '', link = origin + '/';
    const m = /^\/p\/([^/]+)\/?$/.exec(url.pathname);
    if (m) {
      const id = m[1].split('-').pop(), p = store.product(id);
      if (p && !p.hidden) {
        title = p.name + ' · KSh ' + p.price.toLocaleString('en-US') + ' · ' + s.shopName;
        desc = (p.desc || s.tagline).slice(0, 160); link = origin + '/p/' + p.slug;
        const ph = p.photos[0] && store.photoUrl(p.photos[0]);
        if (ph) image = origin + ph;
      }
    }
    const tags = `<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(link)}">` +
      (image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : '') + `<meta name="theme-color" content="${esc(s.accent)}">`;
    const body = Buffer.from(page.buf.toString().replace('<!--OG-->', tags));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(baseHeaders(req))) res.setHeader(k, v);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    try {
      if (await api.handle(req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed'); }
      if (url.pathname.startsWith('/photos/') && servePhoto(req, res, url)) return;
      if (url.pathname === '/' || url.pathname.startsWith('/p/') || url.pathname === '/index.html') { if (servePage(req, res, url)) return; }
      if (serve(req, res, files, url.pathname, {})) return;
      const nf = files.get('/offline.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(nf ? nf.buf.toString().replace('<!--MSG-->', 'Page not found') : 'Not found');
    } catch (e) {
      log('error: ' + (e && e.stack || e));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });
  server.keepAliveTimeout = 65000; server.headersTimeout = 66000; server.requestTimeout = 120000;
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  function stop() {
    return new Promise((resolve) => {
      hub.closeAll(); clearInterval(backupTimer); clearInterval(sweepTimer);
      server.close(() => resolve());
      setTimeout(() => { for (const s of sockets) s.destroy(); }, 1500).unref();
    });
  }
  return new Promise((resolve) => {
    server.listen(c.port, () => {
      log(`Shop server ${version} on port ${server.address().port} | data: ${c.dataDir} | products: ${store.products.length} | orders: ${store.orders.size}`);
      if (!c.ownerEnabled) log('NOTE: OWNER_PASSCODE is missing or shorter than 6 characters, so the owner login is switched off.');
      resolve({ server, store, hub, push, stop, port: server.address().port, version });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then((app) => {
    const bye = () => { log('shutting down'); app.stop().then(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }).catch((e) => { console.error(e); process.exit(1); });
}
