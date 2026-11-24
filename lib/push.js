'use strict';
// Web Push for the owner's devices (RFC 8030 + RFC 8291 encryption + RFC 8292 VAPID).
// No dependencies: only Node's built-in crypto and https.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

// Only real push services are accepted as destinations (the owner's browser supplies the address).
const ALLOWED_HOSTS = [
  /(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)mozaws\.net$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/,
];
function endpointOk(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.username && ALLOWED_HOSTS.some((re) => re.test(u.hostname)); } catch (e) { return false; }
}

/* ---------------- VAPID keys ---------------- */
function keysFromJwk(jwk) {
  const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { priv, pubB64u: b64u(pub) };
}
function loadOrCreateVapid(dataDir, env) {
  // 1) keys given as environment variables (best: survive any redeploy)
  if (env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY) {
    const pub = fromB64u(env.VAPID_PUBLIC_KEY);
    if (pub.length === 65 && pub[0] === 4) {
      return keysFromJwk({ kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: env.VAPID_PRIVATE_KEY });
    }
  }
  // 2) keys saved on the data disk
  const file = path.join(dataDir, 'vapid.json');
  try { const jwk = JSON.parse(fs.readFileSync(file, 'utf8')); if (jwk && jwk.d && jwk.x && jwk.y) return keysFromJwk(jwk); } catch (e) { /* create below */ }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { /* keep in memory only */ }
  return keysFromJwk(jwk);
}

function vapidHeader(keys, endpoint, subject, nowMs) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor((nowMs || Date.now()) / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: keys.priv, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.pubB64u;
}

/* ---------------- message encryption (RFC 8291, aes128gcm) ---------------- */
function encrypt(payload, sub, test) {
  const uaPublic = fromB64u(sub.keys && sub.keys.p256dh), authSecret = fromB64u(sub.keys && sub.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 8) throw new Error('bad subscription keys');
  const ecdh = (test && test.ecdh) || crypto.createECDH('prime256v1');
  if (!(test && test.ecdh)) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = (test && test.salt) || crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  if (plain.length > 4096 - 17) throw new Error('payload too large');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/* ---------------- the push service the app uses ---------------- */
function httpsTransport(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: Object.assign({ 'Content-Length': body.length }, headers), timeout: timeoutMs || 10000 }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    req.end(body);
  });
}

class Push {
  constructor(dataDir, opts = {}) {
    this.dir = dataDir; this.log = opts.log || (() => {});
    this.subject = opts.subject || 'mailto:owner@example.com';
    this.transport = opts.transport || httpsTransport;
    this.keys = loadOrCreateVapid(dataDir, opts.env || {});
    this.file = path.join(dataDir, 'push-subs.json');
    this.subs = [];
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j)) this.subs = j.filter((s) => s && endpointOk(s.endpoint) && s.keys); } catch (e) { /* none yet */ }
  }
  get publicKey() { return this.keys.pubB64u; }
  count() { return this.subs.length; }
  has(endpoint) { return this.subs.some((s) => s.endpoint === endpoint); }
  save() {
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.subs), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    catch (e) { this.log('push: could not save subscriptions: ' + e.message); }
  }
  subscribe(sub, ua) {
    const ok = sub && typeof sub === 'object' && typeof sub.endpoint === 'string' && sub.endpoint.length <= 600 && endpointOk(sub.endpoint) &&
      sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' && fromB64u(sub.keys.p256dh).length === 65 && fromB64u(sub.keys.auth).length >= 8 && fromB64u(sub.keys.auth).length <= 32;
    if (!ok) return false;
    const rec = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: Date.now(), ua: String(ua || '').slice(0, 120) };
    const i = this.subs.findIndex((s) => s.endpoint === sub.endpoint);
    if (i >= 0) this.subs[i] = Object.assign(this.subs[i], rec, { createdAt: this.subs[i].createdAt }); else this.subs.push(rec);
    if (this.subs.length > 20) this.subs.splice(0, this.subs.length - 20);
    this.save();
    return true;
  }
  unsubscribe(endpoint) {
    const n = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== n) this.save();
    return this.subs.length !== n;
  }
  clear() { this.subs = []; this.save(); }

  // Send one alert to every saved device. Never throws; failures are logged.
  async notify(msg, opts = {}) {
    const payload = JSON.stringify({ title: String(msg.title || '').slice(0, 80), body: String(msg.body || '').slice(0, 200), tag: String(msg.tag || 'jb').slice(0, 60), url: msg.url || '/owner', kind: msg.kind || 'order' });
    const targets = this.subs.slice();
    const dead = [];
    let sent = 0;
    await Promise.all(targets.map(async (s) => {
      try {
        const body = encrypt(payload, s);
        const r = await this.transport(s.endpoint, {
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(opts.ttl || 3600), Urgency: 'high',
          Authorization: vapidHeader(this.keys, s.endpoint, this.subject),
        }, body);
        if (r.status >= 200 && r.status < 300) sent++;
        else if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
        else this.log('push: service answered ' + r.status);
      } catch (e) { this.log('push: ' + e.message); }
    }));
    if (dead.length) { this.subs = this.subs.filter((s) => dead.indexOf(s.endpoint) < 0); this.save(); }
    return { sent, removed: dead.length, devices: targets.length };
  }
}

module.exports = { Push, encrypt, vapidHeader, endpointOk, b64u, fromB64u };
