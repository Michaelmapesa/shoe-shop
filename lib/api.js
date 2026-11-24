'use strict';
// HTTP API. Public routes are for customers; /api/owner/* needs the owner cookie.
const zlib = require('zlib');
const U = require('./util');
const { HttpError, Limiter } = U;
const { parseCookies, cookieHeader, COOKIE } = require('./auth');

function createApi({ store, hub, auth, cfg, log, version, push }) {
  const startedAt = Date.now();
  const L = cfg.limits, TEN = 10 * 60 * 1000;
  const lim = {
    orderIp: new Limiter(L.ordersPerIp, TEN), orderAll: new Limiter(L.ordersGlobal, TEN),
    pay: new Limiter(10, TEN), poll: new Limiter(180, 60 * 1000),
    loginFail: new Limiter(L.loginFailsPerIp, 15 * 60 * 1000), loginAll: new Limiter(100, TEN),
  };
  setInterval(() => Object.values(lim).forEach((l) => l.sweep()), 60000).unref();

  const routes = [];
  const add = (method, pat, opts, fn) => {
    const keys = [];
    const re = new RegExp('^' + pat.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, owner: !!(opts && opts.owner), limit: (opts && opts.limit) || 64 * 1024, fn });
  };

  function clientIp(req) {
    const hops = cfg.trustProxyHops;
    if (hops > 0) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[Math.max(0, xff.length - hops)] || xff[0];
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }
  const isHttps = (req) => !!(req.socket && req.socket.encrypted) || (cfg.trustProxyHops > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  const isOwner = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE]);

  function sendJson(req, res, status, obj, extra) {
    const body = Buffer.from(JSON.stringify(obj));
    const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra);
    if (body.length > 1500 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      zlib.gzip(body, (err, z) => {
        if (err) { h['Content-Length'] = body.length; res.writeHead(status, h); return res.end(body); }
        h['Content-Encoding'] = 'gzip'; h['Content-Length'] = z.length; res.writeHead(status, h); res.end(z);
      });
    } else { h['Content-Length'] = body.length; res.writeHead(status, h); res.end(body); }
  }
  function sendText(res, status, text, type, extra) {
    const body = Buffer.from(text);
    res.writeHead(status, Object.assign({ 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' }, extra));
    res.end(body);
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = []; let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > limit) { done = true; reject(new HttpError(413, 'too_large', 'That is too big')); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }
  const rateCheck = (limiter, key) => {
    const r = limiter.hit(key);
    if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many tries. Please wait a little and try again.', { retryAfter: Math.ceil(r.retryAfterMs / 1000) });
  };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const orderFor = (id, k) => {
    const o = store.getOrder(id);
    if (!o || !U.safeEq(String(k || ''), o.key)) throw new HttpError(404, 'not_found', 'Order not found');
    return o;
  };
  const today = () => store.dayOf(Date.now());

  // ---------------- public ----------------
  add('GET', '/healthz', {}, async (c) => c.json(200, { ok: true, uptime: Math.round(process.uptime()), version }));
  add('GET', '/api/shop', {}, async (c) => {
    c.json(200, { settings: store.publicSettings(), categories: store.categories, products: store.catalogue(), now: Date.now(), version });
  });
  add('GET', '/api/owner/status', {}, async (c) => c.json(200, { enabled: auth.enabled, loggedIn: isOwner(c.req) }));

  add('POST', '/api/orders', {}, async (c) => {
    rateCheck(lim.orderIp, c.ip); rateCheck(lim.orderAll, 'all');
    const b = c.body;
    const { order, duplicate } = store.createOrder({
      items: Array.isArray(b.items) ? b.items.map((l) => ({ pid: str(l && l.pid, 40), vid: str(l && l.vid, 40), qty: l && l.qty })) : [],
      method: b.method, zone: str(b.zone, 40), name: b.name, phone: b.phone, address: b.address, note: b.note, payMethod: b.payMethod, clientRef: str(b.clientRef, 40),
    });
    c.json(duplicate ? 200 : 201, { ok: true, id: order.id, key: order.key, order: store.publicOrder(order), duplicate });
  });
  add('GET', '/api/orders/:id', {}, async (c) => {
    rateCheck(lim.poll, c.ip);
    c.json(200, { order: store.publicOrder(orderFor(c.params.id, c.url.searchParams.get('k'))), now: Date.now() });
  });
  add('POST', '/api/orders/:id/cancel', {}, async (c) => {
    rateCheck(lim.pay, c.ip);
    const o = orderFor(c.params.id, str(c.body.k, 60));
    c.json(200, { order: store.publicOrder(store.customerCancel(o.id)) });
  });
  add('POST', '/api/orders/:id/mpesa', {}, async (c) => {
    rateCheck(lim.pay, c.ip);
    const o = orderFor(c.params.id, str(c.body.k, 60));
    c.json(200, { order: store.publicOrder(store.claimPayment(o.id, str(c.body.code, 40))) });
  });
  add('GET', '/api/live', {}, async (c) => {
    let orderId = null, ord = null;
    const q = c.url.searchParams;
    if (q.get('order')) { const o = store.getOrder(q.get('order')); if (o && U.safeEq(q.get('k') || '', o.key)) { orderId = o.id; ord = o; } }
    const cl = hub.open(c.req, c.res, c.ip, { orderId });
    if (!cl) return c.json(503, { error: 'busy', message: 'Too many live connections. Try again shortly.' });
    c.keepOpen = true;
    hub.send(cl, 'hello', { now: Date.now(), version });
    if (ord) hub.send(cl, 'order', store.publicOrder(ord));
  });

  add('POST', '/api/owner/login', {}, async (c) => {
    if (!auth.enabled) throw new HttpError(503, 'owner_disabled', 'Owner login is not set up on this server yet.');
    const blocked = lim.loginFail.peek(c.ip), blockedAll = lim.loginAll.peek('all');
    if (!blocked.ok || !blockedAll.ok) {
      const r = !blocked.ok ? blocked : blockedAll;
      throw new HttpError(429, 'locked', 'Too many wrong passcodes. Please wait and try again.', { retryAfter: Math.ceil(r.retryAfterMs / 1000) });
    }
    if (!auth.checkPasscode(c.body.passcode)) {
      lim.loginFail.hit(c.ip); lim.loginAll.hit('all');
      await new Promise((r) => setTimeout(r, 600));
      throw new HttpError(401, 'bad_passcode', 'That passcode is not right.');
    }
    lim.loginFail.clear(c.ip);
    c.json(200, { ok: true }, { 'Set-Cookie': cookieHeader(auth.issue(), { secure: isHttps(c.req) }) });
  });

  // ---------------- owner ----------------
  const O = { owner: true };
  add('POST', '/api/owner/logout', O, async (c) => c.json(200, { ok: true }, { 'Set-Cookie': cookieHeader('', { secure: isHttps(c.req), clear: true }) }));
  add('POST', '/api/owner/logout-all', O, async (c) => {
    store.bumpEpoch(); push.clear();
    c.json(200, { ok: true }, { 'Set-Cookie': cookieHeader('', { secure: isHttps(c.req), clear: true }) });
  });
  add('GET', '/api/owner/bootstrap', O, async (c) => {
    const day = today(), seen = new Set(), orders = [];
    for (const o of [...store.activeOrders(), ...store.listOrders({ day, limit: 500 }).orders]) if (!seen.has(o.id)) { seen.add(o.id); orders.push(store.ownerOrder(o)); }
    c.json(200, { now: Date.now(), today: day, tz: cfg.tz, version, settings: store.ownerSettings(), products: store.ownerCatalogue(), orders, summary: store.summary(day) });
  });
  add('GET', '/api/owner/live', O, async (c) => {
    const cl = hub.open(c.req, c.res, c.ip, { owner: true });
    c.keepOpen = true;
    hub.send(cl, 'hello', { now: Date.now(), version });
  });
  add('GET', '/api/owner/orders', O, async (c) => {
    const q = c.url.searchParams;
    const r = store.listOrders({
      day: U.isDay(q.get('day')) ? q.get('day') : '', from: U.isDay(q.get('from')) ? q.get('from') : '', to: U.isDay(q.get('to')) ? q.get('to') : '',
      status: q.get('status') || '', q: (q.get('q') || '').slice(0, 60), before: Number(q.get('before')) || 0, limit: q.get('limit'),
    });
    c.json(200, { orders: r.orders.map((o) => store.ownerOrder(o)), more: r.more, nextBefore: r.nextBefore });
  });
  add('PATCH', '/api/owner/orders/:id', O, async (c) => c.json(200, { order: store.ownerOrder(store.ownerUpdate(c.params.id, c.body)), summary: store.summary(today()) }));
  add('GET', '/api/owner/summary', O, async (c) => c.json(200, store.summary(today())));

  add('GET', '/api/owner/products', O, async (c) => c.json(200, { products: store.ownerCatalogue() }));
  add('POST', '/api/owner/products', O, async (c) => c.json(201, { product: store.ownerProduct(store.addProduct(c.body)) }));
  add('PATCH', '/api/owner/products/:id', O, async (c) => c.json(200, { product: store.ownerProduct(store.updateProduct(c.params.id, c.body)) }));
  add('DELETE', '/api/owner/products/:id', O, async (c) => { store.deleteProduct(c.params.id); c.json(200, { ok: true }); });
  add('PUT', '/api/owner/products/:id/stock/:vid', O, async (c) => c.json(200, { product: store.ownerProduct(store.setStock(c.params.id, c.params.vid, c.body.qty)) }));
  add('POST', '/api/owner/products/:id/photos', { owner: true, limit: 900 * 1024 }, async (c) => c.json(201, { product: store.ownerProduct(store.addPhoto(c.params.id, c.body.image)) }));
  add('DELETE', '/api/owner/products/:id/photos/:pid', O, async (c) => c.json(200, { product: store.ownerProduct(store.removePhoto(c.params.id, c.params.pid)) }));
  add('POST', '/api/owner/products/:id/photos/:pid/cover', O, async (c) => c.json(200, { product: store.ownerProduct(store.coverPhoto(c.params.id, c.params.pid)) }));

  add('GET', '/api/owner/settings', O, async (c) => c.json(200, { settings: store.ownerSettings() }));
  add('PATCH', '/api/owner/settings', O, async (c) => c.json(200, { settings: store.updateSettings(c.body) }));

  add('GET', '/api/owner/push/config', O, async (c) => c.json(200, { publicKey: push.publicKey, devices: push.count() }));
  add('POST', '/api/owner/push/subscribe', O, async (c) => {
    if (!push.subscribe(c.body.subscription, c.req.headers['user-agent'])) throw new HttpError(400, 'bad_subscription', 'This device could not be registered for alerts');
    c.json(200, { ok: true, devices: push.count() });
  });
  add('POST', '/api/owner/push/unsubscribe', O, async (c) => { push.unsubscribe(str(c.body.endpoint, 600)); c.json(200, { ok: true, devices: push.count() }); });
  add('POST', '/api/owner/push/test', O, async (c) => {
    const r = await push.notify({ title: 'Test alert', body: 'If you can read this with the app closed, alerts work.', tag: 'test', kind: 'test' }, { ttl: 120 });
    c.json(200, r);
  });

  add('GET', '/api/owner/export.csv', O, async (c) => {
    const q = c.url.searchParams;
    const csv = store.exportCsv(U.isDay(q.get('from')) ? q.get('from') : '', U.isDay(q.get('to')) ? q.get('to') : '');
    sendText(c.res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="orders-${today()}.csv"` });
    c.sent = true;
  });
  add('GET', '/api/owner/backup.json', O, async (c) => {
    sendText(c.res, 200, JSON.stringify(store.backupObject()), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="shop-backup-${today()}.json"` });
    c.sent = true;
  });
  add('POST', '/api/owner/restore', { owner: true, limit: 60 * 1024 * 1024 }, async (c) => {
    if (c.body.confirm !== 'RESTORE') throw new HttpError(400, 'confirm', 'Type RESTORE to confirm');
    c.json(200, Object.assign({ ok: true }, store.restore(c.body.backup)));
  });
  add('GET', '/api/owner/health', O, async (c) => {
    c.json(200, {
      ok: true, version, node: process.version, startedAt, uptimeSec: Math.round(process.uptime()), dataDir: cfg.dataDir, tz: cfg.tz,
      orders: store.orders.size, products: store.products.length, photos: store.photos.size, firstBoot: !!store.firstBoot,
      pushDevices: push.count(), liveOwners: hub.owners.size, liveCustomers: hub.publics.size, lastBackupDay: store.lastBackupDay || null,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  });

  // ---------------- dispatcher ----------------
  async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/') && path !== '/healthz') return false;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const ctx = {
        req, res, url, ip: clientIp(req), params: {}, body: {}, keepOpen: false, sent: false,
        json: (status, obj, extra) => { ctx.sent = true; sendJson(req, res, status, obj, extra); },
      };
      r.keys.forEach((k, i) => { try { ctx.params[k] = decodeURIComponent(m[i + 1]); } catch (e) { ctx.params[k] = ''; } });
      try {
        if (r.owner && !isOwner(req)) throw new HttpError(401, 'auth', 'Please log in');
        if (method !== 'GET') {
          const origin = req.headers.origin;
          if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch (e) { /* bad origin */ } if (!ok) throw new HttpError(403, 'origin', 'Blocked'); }
          const raw = await readBody(req, r.limit);
          if (raw.length) {
            if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'bad_type', 'Send JSON');
            try { ctx.body = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'bad_json', 'Could not read that'); }
            if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'bad_json', 'Could not read that');
          }
        }
        await r.fn(ctx);
        if (!ctx.sent && !ctx.keepOpen && !res.writableEnded) ctx.json(200, { ok: true });
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch (x) { /* ignore */ } return true; }
        if (e instanceof HttpError) {
          const extra = e.extra && e.extra.retryAfter ? { 'Retry-After': e.extra.retryAfter } : undefined;
          sendJson(req, res, e.status, Object.assign({ error: e.code, message: e.message }, e.extra || {}), Object.assign({ Connection: e.status === 413 ? 'close' : 'keep-alive' }, extra));
        } else { log('error: ' + (e && e.stack || e)); sendJson(req, res, 500, { error: 'server', message: 'Something went wrong on our side. Please try again.' }); }
      }
      return true;
    }
    sendJson(req, res, pathMatched ? 405 : 404, { error: pathMatched ? 'method' : 'not_found', message: 'Not found' });
    return true;
  }

  return { handle, clientIp, isHttps };
}

module.exports = { createApi };
