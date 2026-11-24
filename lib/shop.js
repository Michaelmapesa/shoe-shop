'use strict';
// All shop data in one place: settings, categories, products (with sizes and stock), photos and orders.
// Plain files, no dependencies. Fine for a few hundred products and thousands of orders.
//   config.json   settings + categories + products (rewritten safely on every change)
//   orders.jsonl  one line per order version (append only, tidied now and then)
//   photos/       product pictures
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const U = require('./util');
const { HttpError } = U;

const STATUSES = ['placed', 'confirmed', 'packed', 'dispatched', 'delivered', 'cancelled'];
const ACTIVE = ['placed', 'confirmed', 'packed', 'dispatched'];
const PAY = ['mpesa', 'cod'];
const GENDERS = ['men', 'women', 'kids', 'unisex'];
const KINDS = ['shoes', 'clothes', 'other'];
const MPESA_MODES = ['send', 'till', 'paybill'];
const PHOTO_MAX = 600 * 1024;
const PHOTOS_PER_PRODUCT = 8;
const PHOTO_ID = /^[A-Za-z0-9_-]{6,24}$/;
const ID = /^[A-Za-z0-9_-]{3,24}$/;

// Recognise the picture by its first bytes, not by what the upload claims to be.
function sniffImage(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length > 12 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return { ext: 'png', type: 'image/png' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function appendLine(file, obj) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureTrailingNewline(file) {
  if (!fs.existsSync(file)) return;
  const st = fs.statSync(file);
  if (!st.size) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1);
    if (b[0] !== 10) { fs.writeSync(fd, '\n', st.size); fs.fsyncSync(fd); }
  } finally { fs.closeSync(fd); }
}
function readJsonl(file, log) {
  const rows = []; let bad = 0, lines = 0;
  if (!fs.existsSync(file)) return { rows, lines, bad };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    try { rows.push(JSON.parse(line)); } catch (e) { bad++; }
  }
  if (bad && log) log(`warning: ${bad} unreadable line(s) skipped in ${path.basename(file)}`);
  return { rows, lines, bad };
}

const DEFAULT_CATEGORIES = ['Sneakers', 'Formal shoes', 'Sandals & slides', 'Boots', 'Kids', 'Clothes', 'Accessories'];

class Shop extends EventEmitter {
  constructor(dir, opts = {}) {
    super();
    this.dir = dir;
    this.log = opts.log || (() => {});
    this.defaults = opts.defaults || {};
    this.tz = opts.tz || 'Africa/Nairobi';
    this.dayOf = U.makeDayFn(this.tz);
    this.orders = new Map();
    this.refIndex = new Map();
    this.dayCounters = new Map();
    this.photos = new Map();             // photo id -> { ext, type, size, ver, etag }
    this.photoDir = path.join(dir, 'photos');
    this.settings = this.defaultSettings();
    this.categories = DEFAULT_CATEGORIES.map((name, i) => ({ id: 'c' + (i + 1), name }));
    this.products = [];
    this.f = { config: path.join(dir, 'config.json'), orders: path.join(dir, 'orders.jsonl') };
  }

  defaultSettings() {
    const d = this.defaults;
    return {
      shopName: d.shopName || 'My Shoe Shop', tagline: 'Fresh pairs, delivered in Nairobi', about: '',
      whatsapp: d.whatsapp || '', phone: d.phone || d.whatsapp || '', accent: '#C2410C',
      acceptingOrders: true, closedMessage: "We're not taking orders right now. Please check back soon!", announcement: '',
      payMpesa: true, mpesaMode: 'send', mpesaNumber: d.mpesa || '', mpesaName: '', payCod: true,
      pickupEnabled: true, pickupAddress: '', deliveryEnabled: true,
      zones: [
        { id: 'z1', name: 'Nairobi CBD', fee: 200 },
        { id: 'z2', name: 'Westlands, Kilimani, Lavington', fee: 300 },
        { id: 'z3', name: 'Other Nairobi areas', fee: 400 },
      ],
      minOrder: 0, holdMinutes: 120, hideSoldOut: false, sessionEpoch: 1,
    };
  }

  /* ---------------- loading, saving, backups ---------------- */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const probe = path.join(this.dir, '.write-test');
    fs.writeFileSync(probe, String(Date.now())); fs.unlinkSync(probe);
    this.firstBoot = !fs.existsSync(this.f.config) && !fs.existsSync(this.f.orders);
    if (fs.existsSync(this.f.config)) {
      try {
        const c = JSON.parse(fs.readFileSync(this.f.config, 'utf8'));
        this.settings = Object.assign(this.defaultSettings(), this.cleanSettings(c.settings || {}));
        const cats = this.cleanCategories(c.categories);
        if (cats.length) this.categories = cats;
        this.products = this.cleanProducts(c.products);
      } catch (e) {
        const bad = this.f.config + '.corrupt-' + Date.now();
        fs.renameSync(this.f.config, bad);
        this.log(`config.json was unreadable; kept as ${path.basename(bad)} and started fresh`);
      }
    }
    this.loadPhotos();
    this.saveConfig();
    ensureTrailingNewline(this.f.orders);
    const o = readJsonl(this.f.orders, this.log);
    for (const row of o.rows) {
      const ord = this.normalizeOrder(row);
      if (!ord) continue;
      const prev = this.orders.get(ord.id);
      if (!prev || ord.rev >= prev.rev) this.orders.set(ord.id, ord);
    }
    this.reindex();
    if (o.lines > this.orders.size * 3 + 200) this.compactOrders();
    return this;
  }
  reindex() {
    this.dayCounters.clear(); this.refIndex.clear();
    for (const o of this.orders.values()) {
      this.dayCounters.set(o.day, Math.max(this.dayCounters.get(o.day) || 0, o.no));
      if (o.clientRef) this.refIndex.set(o.clientRef, o.id);
    }
  }
  saveConfig() {
    atomicWrite(this.f.config, JSON.stringify({ v: 1, savedAt: Date.now(), settings: this.settings, categories: this.categories, products: this.products }));
  }
  persistOrder(o) { appendLine(this.f.orders, o); }
  compactOrders() {
    try { fs.copyFileSync(this.f.orders, this.f.orders + '.prev'); } catch (e) { /* ignore */ }
    const text = [...this.orders.values()].sort((a, b) => a.createdAt - b.createdAt).map((o) => JSON.stringify(o)).join('\n');
    atomicWrite(this.f.orders, text ? text + '\n' : '');
  }
  dailyBackup(keepDays) {
    const day = this.dayOf(Date.now());
    const root = path.join(this.dir, 'backups'), target = path.join(root, day);
    if (fs.existsSync(target)) return false;
    fs.mkdirSync(target, { recursive: true });
    for (const k of ['config', 'orders']) if (fs.existsSync(this.f[k])) fs.copyFileSync(this.f[k], path.join(target, path.basename(this.f[k])));
    const dirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    while (dirs.length > keepDays) fs.rmSync(path.join(root, dirs.shift()), { recursive: true, force: true });
    this.lastBackupDay = day;
    return true;
  }
  bumpEpoch() { this.settings.sessionEpoch = (this.settings.sessionEpoch || 1) + 1; this.saveConfig(); }

  /* ---------------- settings ---------------- */
  cleanSettings(s, lenient) {
    const out = {}, T = (k, max) => { if (s[k] !== undefined) out[k] = U.cleanText(s[k], max); };
    const B = (k) => { if (s[k] !== undefined) out[k] = !!s[k]; };
    T('shopName', 40); T('tagline', 80); T('closedMessage', 160); T('announcement', 200); T('pickupAddress', 160); T('mpesaName', 40);
    if (s.about !== undefined) out.about = U.cleanMultiline(s.about, 600);
    ['acceptingOrders', 'payMpesa', 'payCod', 'pickupEnabled', 'deliveryEnabled', 'hideSoldOut'].forEach(B);
    if (s.whatsapp !== undefined) out.whatsapp = U.normPhone(s.whatsapp);
    if (s.phone !== undefined) out.phone = U.normPhone(s.phone);
    if (s.accent !== undefined) { if (/^#[0-9a-fA-F]{6}$/.test(String(s.accent))) out.accent = String(s.accent).toLowerCase(); else if (!lenient) throw new HttpError(400, 'bad_colour', 'Colour must look like #C2410C'); }
    if (s.mpesaMode !== undefined) { if (MPESA_MODES.includes(s.mpesaMode)) out.mpesaMode = s.mpesaMode; else if (!lenient) throw new HttpError(400, 'bad_mode', 'Unknown M-Pesa type'); }
    if (s.mpesaNumber !== undefined) out.mpesaNumber = String(s.mpesaNumber).replace(/\D/g, '').slice(0, 12);
    if (s.minOrder !== undefined) out.minOrder = U.int(s.minOrder, 0, 1e7, 0);
    if (s.holdMinutes !== undefined) out.holdMinutes = U.int(s.holdMinutes, 0, 10080, 120);
    if (s.sessionEpoch !== undefined) out.sessionEpoch = U.int(s.sessionEpoch, 1, 1e9, 1);
    if (s.zones !== undefined) {
      if (!Array.isArray(s.zones)) { if (!lenient) throw new HttpError(400, 'bad_zones', 'Delivery areas must be a list'); } else {
        const seen = new Set(), zones = [];
        for (const z of s.zones.slice(0, 40)) {
          const name = U.cleanText(z && z.name, 60);
          if (!name) continue;
          let id = z && typeof z.id === 'string' && ID.test(z.id) && !seen.has(z.id) ? z.id : 'z' + U.rid(4);
          while (seen.has(id)) id = 'z' + U.rid(4);
          seen.add(id); zones.push({ id, name, fee: U.int(z && z.fee, 0, 5000, 0) });
        }
        out.zones = zones;
      }
    }
    return out;
  }
  cleanCategories(c) {
    if (!Array.isArray(c)) return [];
    const seen = new Set(), out = [];
    for (const x of c.slice(0, 40)) {
      const name = U.cleanText(x && x.name, 30);
      if (!name) continue;
      let id = x && typeof x.id === 'string' && ID.test(x.id) && !seen.has(x.id) ? x.id : 'c' + U.rid(4);
      while (seen.has(id)) id = 'c' + U.rid(4);
      seen.add(id); out.push({ id, name });
    }
    return out;
  }
  updateSettings(p) {
    if (!p || typeof p !== 'object') throw new HttpError(400, 'bad_request', 'Bad settings');
    const patch = this.cleanSettings(p, false);
    if (patch.shopName === '') throw new HttpError(400, 'name_required', 'The shop needs a name');
    delete patch.sessionEpoch;
    Object.assign(this.settings, patch);
    if (p.categories !== undefined) {
      const cats = this.cleanCategories(p.categories);
      if (!cats.length) throw new HttpError(400, 'categories', 'Keep at least one category');
      const ids = new Set(cats.map((c) => c.id));
      this.categories = cats;
      for (const pr of this.products) if (!ids.has(pr.cat)) pr.cat = cats[0].id;
      this.products.forEach((pr) => this.emit('product', pr));
    }
    this.saveConfig();
    this.emit('settings');
    return this.ownerSettings();
  }
  publicSettings() {
    const s = this.settings;
    return {
      shopName: s.shopName, tagline: s.tagline, about: s.about, whatsapp: s.whatsapp, phone: s.phone, accent: s.accent,
      acceptingOrders: s.acceptingOrders, closedMessage: s.closedMessage, announcement: s.announcement,
      payMpesa: s.payMpesa, mpesaMode: s.mpesaMode, mpesaNumber: s.mpesaNumber, mpesaName: s.mpesaName, payCod: s.payCod,
      pickupEnabled: s.pickupEnabled, pickupAddress: s.pickupAddress, deliveryEnabled: s.deliveryEnabled,
      zones: s.zones, minOrder: s.minOrder, hideSoldOut: s.hideSoldOut,
    };
  }
  ownerSettings() { const { sessionEpoch, ...rest } = this.settings; return Object.assign({}, rest, { categories: this.categories }); }

  /* ---------------- products ---------------- */
  cleanVariants(list) {
    const out = [], seen = new Set(), ids = new Set();
    for (const v of (Array.isArray(list) ? list : []).slice(0, 40)) {
      const size = U.cleanText(v && v.size, 10);
      if (!size || seen.has(size.toLowerCase())) continue;
      seen.add(size.toLowerCase());
      let id = v && typeof v.id === 'string' && ID.test(v.id) && !ids.has(v.id) ? v.id : 'v' + U.rid(4);
      while (ids.has(id)) id = 'v' + U.rid(4);
      ids.add(id); out.push({ id, size, qty: U.int(v && v.qty, 0, 9999, 0) });
    }
    return out;
  }
  cleanProducts(list) {
    const out = [], seen = new Set();
    for (const p of (Array.isArray(list) ? list : [])) {
      if (!p || typeof p.id !== 'string' || !ID.test(p.id) || seen.has(p.id)) continue;
      const name = U.cleanText(p.name, 80); if (!name) continue;
      seen.add(p.id);
      const price = U.int(p.price, 1, 1e7, 1), was = U.int(p.was, 0, 1e7, 0);
      const cat = this.categories.some((c) => c.id === p.cat) ? p.cat : this.categories[0].id;
      out.push({
        id: p.id, slug: slugify(p.slug || name) + '-' + p.id, name, brand: U.cleanText(p.brand, 40), cat,
        gender: GENDERS.includes(p.gender) ? p.gender : 'unisex', kind: KINDS.includes(p.kind) ? p.kind : 'shoes',
        colour: U.cleanText(p.colour, 30), price, was: was > price ? was : 0, desc: U.cleanMultiline(p.desc, 800),
        variants: this.cleanVariants(p.variants), photos: (Array.isArray(p.photos) ? p.photos : []).filter((x) => typeof x === 'string' && PHOTO_ID.test(x)).slice(0, PHOTOS_PER_PRODUCT),
        hidden: !!p.hidden, createdAt: U.int(p.createdAt, 1, 8.64e15, Date.now()), updatedAt: U.int(p.updatedAt, 1, 8.64e15, Date.now()),
      });
    }
    return out;
  }
  product(id) { return this.products.find((p) => p.id === id) || null; }
  totalQty(p) { return p.variants.reduce((n, v) => n + v.qty, 0); }
  photoUrl(id) { const m = this.photos.get(id); return m ? '/photos/' + id + '.' + m.ext + '?v=' + m.ver : ''; }
  publicProduct(p) {
    const total = this.totalQty(p);
    return {
      id: p.id, slug: p.slug, name: p.name, brand: p.brand, cat: p.cat, gender: p.gender, kind: p.kind, colour: p.colour,
      price: p.price, was: p.was, desc: p.desc, photos: p.photos.map((x) => this.photoUrl(x)).filter(Boolean),
      sizes: p.variants.map((v) => ({ id: v.id, size: v.size, qty: v.qty })), soldOut: total === 0, createdAt: p.createdAt,
    };
  }
  ownerProduct(p) { return Object.assign(this.publicProduct(p), { hidden: p.hidden, totalQty: this.totalQty(p), updatedAt: p.updatedAt, photoIds: p.photos.slice() }); }
  visible(p) { return !p.hidden && !(this.settings.hideSoldOut && this.totalQty(p) === 0); }
  catalogue() { return this.products.filter((p) => this.visible(p)).sort((a, b) => b.createdAt - a.createdAt).map((p) => this.publicProduct(p)); }
  ownerCatalogue() { return this.products.slice().sort((a, b) => b.createdAt - a.createdAt).map((p) => this.ownerProduct(p)); }
  changed(p) { this.emit('product', p); }

  productFields(p, base) {
    const out = {};
    if (p.name !== undefined) { out.name = U.cleanText(p.name, 80); if (!out.name) throw new HttpError(400, 'name_required', 'Please give the product a name'); }
    if (p.brand !== undefined) out.brand = U.cleanText(p.brand, 40);
    if (p.colour !== undefined) out.colour = U.cleanText(p.colour, 30);
    if (p.desc !== undefined) out.desc = U.cleanMultiline(p.desc, 800);
    if (p.cat !== undefined) { if (!this.categories.some((c) => c.id === p.cat)) throw new HttpError(400, 'bad_category', 'Unknown category'); out.cat = p.cat; }
    if (p.gender !== undefined) { if (!GENDERS.includes(p.gender)) throw new HttpError(400, 'bad_gender', 'Choose men, women, kids or unisex'); out.gender = p.gender; }
    if (p.kind !== undefined) { if (!KINDS.includes(p.kind)) throw new HttpError(400, 'bad_kind', 'Unknown product type'); out.kind = p.kind; }
    if (p.price !== undefined) { const n = Math.round(Number(p.price)); if (!Number.isFinite(n) || n < 1 || n > 1e7) throw new HttpError(400, 'bad_price', 'Enter a price in KSh'); out.price = n; }
    if (p.was !== undefined) out.was = p.was === '' || p.was == null ? 0 : U.int(p.was, 0, 1e7, 0);
    if (p.hidden !== undefined) out.hidden = !!p.hidden;
    const price = out.price !== undefined ? out.price : (base ? base.price : 0);
    if (out.was !== undefined || out.price !== undefined) { const was = out.was !== undefined ? out.was : (base ? base.was : 0); out.was = was > price ? was : 0; }
    return out;
  }
  addProduct(p) {
    if (!p || typeof p !== 'object') throw new HttpError(400, 'bad_request', 'Bad product');
    if (this.products.length >= 5000) throw new HttpError(400, 'too_many', 'That is a lot of products. Remove old ones first.');
    if (p.name === undefined || p.price === undefined) throw new HttpError(400, 'bad_request', 'A product needs a name and a price');
    const f = this.productFields(p, null);
    const now = Date.now(); let id = U.rid(5).replace(/[^A-Za-z0-9]/g, 'x');
    while (this.product(id)) id = U.rid(5).replace(/[^A-Za-z0-9]/g, 'x');
    let variants = this.cleanVariants(p.sizes);
    if (!variants.length) variants = [{ id: 'v' + U.rid(4), size: 'One size', qty: U.int(p.qty, 0, 9999, 1) }];
    const prod = Object.assign({
      id, brand: '', colour: '', desc: '', cat: this.categories[0].id, gender: 'unisex', kind: 'shoes', was: 0, hidden: false, photos: [], createdAt: now, updatedAt: now,
    }, f, { variants });
    prod.slug = slugify(prod.name) + '-' + id;
    this.products.push(prod); this.saveConfig(); this.changed(prod);
    return prod;
  }
  updateProduct(id, p) {
    const prod = this.product(id);
    if (!prod) throw new HttpError(404, 'not_found', 'Product not found');
    if (!p || typeof p !== 'object') throw new HttpError(400, 'bad_request', 'Bad product');
    Object.assign(prod, this.productFields(p, prod));
    if (p.sizes !== undefined) {
      const wanted = this.cleanVariants((Array.isArray(p.sizes) ? p.sizes : []).map((v) => {
        const keep = prod.variants.find((x) => x.id === (v && v.id)) || prod.variants.find((x) => x.size.toLowerCase() === U.cleanText(v && v.size, 10).toLowerCase());
        return Object.assign({}, v, keep ? { id: keep.id } : { id: undefined });
      }));
      if (!wanted.length) throw new HttpError(400, 'sizes', 'Keep at least one size');
      prod.variants = wanted;
    }
    if (p.soldOut === true) prod.variants.forEach((v) => { v.qty = 0; });
    prod.updatedAt = Date.now();
    this.saveConfig(); this.changed(prod);
    return prod;
  }
  setStock(id, vid, qty) {
    const prod = this.product(id);
    if (!prod) throw new HttpError(404, 'not_found', 'Product not found');
    const v = prod.variants.find((x) => x.id === vid);
    if (!v) throw new HttpError(404, 'not_found', 'Size not found');
    const n = Math.round(Number(qty));
    if (!Number.isFinite(n) || n < 0 || n > 9999) throw new HttpError(400, 'bad_qty', 'Enter a number from 0 to 9999');
    v.qty = n; prod.updatedAt = Date.now();
    this.saveConfig(); this.changed(prod);
    return prod;
  }
  deleteProduct(id) {
    const i = this.products.findIndex((p) => p.id === id);
    if (i < 0) throw new HttpError(404, 'not_found', 'Product not found');
    const [prod] = this.products.splice(i, 1);
    prod.photos.forEach((x) => this.dropPhotoFile(x));
    this.saveConfig(); this.emit('product-removed', id);
  }

  /* ---------------- photos ---------------- */
  loadPhotos() {
    this.photos = new Map();
    let names = [];
    try { names = fs.readdirSync(this.photoDir); } catch (e) { names = []; }
    const used = new Set(); this.products.forEach((p) => p.photos.forEach((x) => used.add(x)));
    for (const n of names) {
      const m = /^([A-Za-z0-9_-]{6,24})\.(jpg|png|webp)$/.exec(n);
      if (!m) { if (!/\.tmp$/.test(n)) continue; try { fs.unlinkSync(path.join(this.photoDir, n)); } catch (e) { /* ignore */ } continue; }
      if (!used.has(m[1])) { try { fs.unlinkSync(path.join(this.photoDir, n)); } catch (e) { /* ignore */ } continue; } // orphan
      try {
        const st = fs.statSync(path.join(this.photoDir, n));
        this.photos.set(m[1], { ext: m[2], type: MIME[m[2]], size: st.size, ver: Math.floor(st.mtimeMs), etag: '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"' });
      } catch (e) { this.log('could not read photo ' + n); }
    }
    // forget photo ids whose file is gone
    for (const p of this.products) p.photos = p.photos.filter((x) => this.photos.has(x));
  }
  parsePhoto(dataUrl) {
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new HttpError(400, 'bad_photo', 'Please choose a JPG, PNG or WebP picture');
    const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
    if (buf.length < 100) throw new HttpError(400, 'bad_photo', 'That picture could not be read');
    if (buf.length > PHOTO_MAX) throw new HttpError(400, 'photo_size', 'That photo is too big. Try a smaller picture.');
    const kind = sniffImage(buf);
    if (!kind) throw new HttpError(400, 'bad_photo', 'Please choose a JPG, PNG or WebP picture');
    return { buf, kind };
  }
  dropPhotoFile(id) {
    const m = this.photos.get(id); this.photos.delete(id);
    for (const e of m ? [m.ext] : ['jpg', 'png', 'webp']) { try { fs.unlinkSync(path.join(this.photoDir, id + '.' + e)); } catch (x) { /* none */ } }
  }
  writePhoto(id, buf, kind) {
    fs.mkdirSync(this.photoDir, { recursive: true });
    const file = path.join(this.photoDir, id + '.' + kind.ext), tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
    const st = fs.statSync(file);
    this.photos.set(id, { ext: kind.ext, type: kind.type, size: st.size, ver: Math.floor(st.mtimeMs), etag: '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"' });
  }
  addPhoto(pid, dataUrl) {
    const prod = this.product(pid);
    if (!prod) throw new HttpError(404, 'not_found', 'Product not found');
    if (prod.photos.length >= PHOTOS_PER_PRODUCT) throw new HttpError(400, 'photo_limit', 'A product can have up to ' + PHOTOS_PER_PRODUCT + ' photos');
    const { buf, kind } = this.parsePhoto(dataUrl);
    const id = 'p' + U.rid(8).replace(/[^A-Za-z0-9]/g, 'x');
    try { this.writePhoto(id, buf, kind); } catch (e) { this.log('photo save failed: ' + e.message); throw new HttpError(500, 'photo_save', 'Could not save the photo on the server'); }
    prod.photos.push(id); prod.updatedAt = Date.now();
    this.saveConfig(); this.changed(prod);
    return prod;
  }
  removePhoto(pid, photoId) {
    const prod = this.product(pid);
    if (!prod) throw new HttpError(404, 'not_found', 'Product not found');
    if (!prod.photos.includes(photoId)) throw new HttpError(404, 'not_found', 'Photo not found');
    prod.photos = prod.photos.filter((x) => x !== photoId); this.dropPhotoFile(photoId);
    prod.updatedAt = Date.now(); this.saveConfig(); this.changed(prod);
    return prod;
  }
  coverPhoto(pid, photoId) {
    const prod = this.product(pid);
    if (!prod) throw new HttpError(404, 'not_found', 'Product not found');
    if (!prod.photos.includes(photoId)) throw new HttpError(404, 'not_found', 'Photo not found');
    prod.photos = [photoId].concat(prod.photos.filter((x) => x !== photoId));
    prod.updatedAt = Date.now(); this.saveConfig(); this.changed(prod);
    return prod;
  }
  // For the web server: the file's bytes and headers, or null.
  readPhoto(name) {
    const m = /^([A-Za-z0-9_-]{6,24})\.(jpg|png|webp)$/.exec(String(name || ''));
    const meta = m && this.photos.get(m[1]);
    if (!meta || meta.ext !== m[2]) return null;
    try { return { buf: fs.readFileSync(path.join(this.photoDir, m[1] + '.' + meta.ext)), type: meta.type, etag: meta.etag }; } catch (e) { return null; }
  }

  /* ---------------- orders ---------------- */
  normalizeOrder(o) {
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(o.id) || !Array.isArray(o.items)) return null;
    const items = o.items.slice(0, 60).map((l) => ({
      pid: U.cleanText(l && l.pid, 24), vid: U.cleanText(l && l.vid, 24), name: U.cleanText(l && l.name, 80) || 'Item',
      size: U.cleanText(l && l.size, 10), colour: U.cleanText(l && l.colour, 30), qty: U.int(l && l.qty, 1, 999, 1), price: U.int(l && l.price, 0, 1e7, 0),
      photo: typeof (l && l.photo) === 'string' ? l.photo.slice(0, 120) : '',
    }));
    if (!items.length) return null;
    const createdAt = U.int(o.createdAt, 1, 8.64e15, Date.now());
    const subtotal = items.reduce((s, l) => s + l.qty * l.price, 0), deliveryFee = U.int(o.deliveryFee, 0, 1e6, 0);
    const history = Array.isArray(o.history) ? o.history.slice(-40).map((h) => ({ s: U.cleanText(h && h.s, 20), at: U.int(h && h.at, 0, 8.64e15, createdAt), by: U.cleanText(h && h.by, 12) })) : [];
    return {
      id: o.id, no: U.int(o.no, 1, 1e6, 1), day: U.isDay(o.day) ? o.day : this.dayOf(createdAt), createdAt, updatedAt: U.int(o.updatedAt, 0, 8.64e15, createdAt),
      rev: U.int(o.rev, 1, 1e9, 1), status: STATUSES.includes(o.status) ? o.status : 'placed',
      method: o.method === 'delivery' ? 'delivery' : 'pickup', zone: U.cleanText(o.zone, 60),
      name: U.cleanText(o.name, 40), phone: String(o.phone || '').replace(/\D/g, '').slice(0, 15), address: U.cleanText(o.address, 160),
      note: U.cleanMultiline(o.note, 200), ownerNote: U.cleanText(o.ownerNote, 200),
      items, subtotal, deliveryFee, total: subtotal + deliveryFee,
      payMethod: PAY.includes(o.payMethod) ? o.payMethod : 'cod', paid: !!o.paid, paidAt: U.int(o.paidAt, 0, 8.64e15, 0),
      mpesaCode: String(o.mpesaCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14), payClaimed: !!o.payClaimed,
      restocked: !!o.restocked, key: typeof o.key === 'string' ? o.key.slice(0, 40) : '', clientRef: typeof o.clientRef === 'string' ? o.clientRef.slice(0, 40) : '', history,
    };
  }
  getOrder(id) { return this.orders.get(id) || null; }

  // Build, price, reserve stock and save an order. Prices and fees ALWAYS come from the server, never from the customer's phone.
  createOrder(input) {
    const s = this.settings;
    if (!input || typeof input !== 'object') throw new HttpError(400, 'bad_request', 'Bad order');
    if (!s.acceptingOrders) throw new HttpError(403, 'closed', s.closedMessage || 'Closed right now');
    this.sweep();
    const clientRef = U.cleanText(input.clientRef, 40);
    if (clientRef && this.refIndex.has(clientRef)) {
      const ex = this.orders.get(this.refIndex.get(clientRef));
      if (ex && Date.now() - ex.createdAt < 15 * 60 * 1000) return { order: ex, duplicate: true };
    }
    const method = input.method;
    if (method !== 'pickup' && method !== 'delivery') throw new HttpError(400, 'bad_method', 'Choose pickup or delivery');
    if (method === 'pickup' && !s.pickupEnabled) throw new HttpError(400, 'method_off', 'Pickup is not available right now');
    if (method === 'delivery' && !s.deliveryEnabled) throw new HttpError(400, 'method_off', 'Delivery is not available right now');
    if (!Array.isArray(input.items) || !input.items.length) throw new HttpError(400, 'bad_items', 'Your bag is empty');
    if (input.items.length > 30) throw new HttpError(400, 'bad_items', 'Too many different items');

    const wanted = new Map();
    for (const l of input.items) {
      if (!l || typeof l.pid !== 'string' || typeof l.vid !== 'string') throw new HttpError(400, 'bad_items', 'Bad item in your bag');
      const q = Number(l.qty);
      if (!Number.isInteger(q) || q < 1 || q > 10) throw new HttpError(400, 'bad_items', 'Quantity must be between 1 and 10');
      const k = l.pid + '|' + l.vid; wanted.set(k, (wanted.get(k) || 0) + q);
    }
    const lines = [], gone = [], short = [];
    for (const [k, qty] of wanted) {
      const [pid, vid] = k.split('|');
      const p = this.product(pid), v = p && p.variants.find((x) => x.id === vid);
      if (!p || !v || p.hidden) { gone.push({ pid, vid }); continue; }
      if (v.qty < qty) { short.push({ pid, vid, name: p.name, size: v.size, left: v.qty }); continue; }
      lines.push({ pid, vid, name: p.name, size: v.size, colour: p.colour, qty, price: p.price, photo: p.photos[0] ? this.photoUrl(p.photos[0]) : '' });
    }
    if (gone.length) throw new HttpError(409, 'item_gone', 'Some items are no longer available', { items: gone });
    if (short.length) throw new HttpError(409, 'stock', 'Some sizes just sold out or are running low', { items: short });

    const name = U.cleanText(input.name, 40);
    if (!name) throw new HttpError(400, 'name_required', 'Please enter your name');
    const phone = U.normPhone(input.phone);
    if (!phone) throw new HttpError(400, 'phone_required', 'Please enter a valid phone number');
    let address = '', zone = null;
    if (method === 'delivery') {
      zone = s.zones.find((z) => z.id === input.zone);
      if (!zone) throw new HttpError(400, 'zone_required', 'Please choose your delivery area');
      address = U.cleanText(input.address, 160);
      if (address.length < 3) throw new HttpError(400, 'address_required', 'Please add where we should deliver');
    }
    let payMethod = input.payMethod;
    if (!PAY.includes(payMethod)) payMethod = s.payMpesa ? 'mpesa' : 'cod';
    if ((payMethod === 'mpesa' && !s.payMpesa) || (payMethod === 'cod' && !s.payCod)) throw new HttpError(400, 'pay_method', 'That payment option is not available');
    const subtotal = lines.reduce((t, l) => t + l.qty * l.price, 0);
    if (s.minOrder && subtotal < s.minOrder) throw new HttpError(400, 'min_order', `Minimum order is KSh ${s.minOrder}`, { minOrder: s.minOrder });
    const deliveryFee = zone ? zone.fee : 0;

    // reserve the stock, then save
    for (const l of lines) this.product(l.pid).variants.find((x) => x.id === l.vid).qty -= l.qty;
    const now = Date.now(), day = this.dayOf(now), no = (this.dayCounters.get(day) || 0) + 1;
    this.dayCounters.set(day, no);
    const order = {
      id: U.rid(9), no, day, createdAt: now, updatedAt: now, rev: 1, status: 'placed', method, zone: zone ? zone.name : '',
      name, phone, address, note: U.cleanMultiline(input.note, 200), ownerNote: '',
      items: lines, subtotal, deliveryFee, total: subtotal + deliveryFee,
      payMethod, paid: false, paidAt: 0, mpesaCode: '', payClaimed: false, restocked: false, key: U.rid(16), clientRef,
      history: [{ s: 'placed', at: now, by: 'customer' }],
    };
    this.orders.set(order.id, order);
    if (clientRef) this.refIndex.set(clientRef, order.id);
    this.persistOrder(order); this.saveConfig();
    this.emit('order', order);
    const soldOut = [];
    for (const pid of new Set(lines.map((l) => l.pid))) { const p = this.product(pid); this.changed(p); if (this.totalQty(p) === 0) soldOut.push(p); }
    soldOut.forEach((p) => this.emit('soldout', p));
    return { order, duplicate: false };
  }

  stockChanged(o) { for (const pid of new Set(o.items.map((l) => l.pid))) { const p = this.product(pid); if (p) this.changed(p); } }
  restock(o) {
    if (o.restocked) return;
    for (const l of o.items) { const v = this.product(l.pid) && this.product(l.pid).variants.find((x) => x.id === l.vid); if (v) v.qty += l.qty; }
    o.restocked = true; this.saveConfig(); this.stockChanged(o);
  }
  reserveAgain(o) {
    if (!o.restocked) return;
    const short = [];
    for (const l of o.items) { const p = this.product(l.pid), v = p && p.variants.find((x) => x.id === l.vid); if (!v || v.qty < l.qty) short.push({ pid: l.pid, vid: l.vid, name: l.name, size: l.size, left: v ? v.qty : 0 }); }
    if (short.length) throw new HttpError(409, 'stock', 'Not enough stock left to reopen this order', { items: short });
    for (const l of o.items) this.product(l.pid).variants.find((x) => x.id === l.vid).qty -= l.qty;
    o.restocked = false; this.saveConfig(); this.stockChanged(o);
  }
  mutate(o, fn) { fn(o); o.updatedAt = Date.now(); o.rev++; this.persistOrder(o); this.emit('order', o); return o; }

  ownerUpdate(id, p) {
    const o = this.orders.get(id);
    if (!o) throw new HttpError(404, 'not_found', 'Order not found');
    if (p.status !== undefined && !STATUSES.includes(p.status)) throw new HttpError(400, 'bad_status', 'Unknown status');
    if (p.status !== undefined && p.status !== 'cancelled' && o.status === 'cancelled') this.reserveAgain(o); // reopening an order takes the stock again
    return this.mutate(o, (x) => {
      const now = Date.now();
      if (p.status !== undefined && p.status !== x.status) {
        x.status = p.status; x.history.push({ s: p.status, at: now, by: 'owner' });
        if (p.status === 'cancelled') this.restock(x);
        if (p.status === 'delivered' && x.payMethod === 'cod' && !x.paid) { x.paid = true; x.paidAt = now; x.history.push({ s: 'paid', at: now, by: 'owner' }); }
      }
      if (p.paid !== undefined && !!p.paid !== x.paid) { x.paid = !!p.paid; x.paidAt = x.paid ? now : 0; x.history.push({ s: x.paid ? 'paid' : 'unpaid', at: now, by: 'owner' }); }
      if (p.ownerNote !== undefined) x.ownerNote = U.cleanText(p.ownerNote, 200);
      if (x.history.length > 40) x.history = x.history.slice(-40);
    });
  }
  customerCancel(id) {
    const o = this.orders.get(id);
    if (!o) throw new HttpError(404, 'not_found', 'Order not found');
    if (o.status !== 'placed') throw new HttpError(409, 'too_late', 'The shop already started on this order. Please call or WhatsApp the shop to change it.');
    return this.mutate(o, (x) => { x.status = 'cancelled'; x.history.push({ s: 'cancelled', at: Date.now(), by: 'customer' }); this.restock(x); });
  }
  claimPayment(id, code) {
    const o = this.orders.get(id);
    if (!o) throw new HttpError(404, 'not_found', 'Order not found');
    if (o.payMethod !== 'mpesa') throw new HttpError(400, 'bad_method', 'This order is paid on delivery or pickup');
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 6 || c.length > 14) throw new HttpError(400, 'bad_code', 'That M-Pesa code does not look right');
    if (o.status === 'cancelled') throw new HttpError(409, 'cancelled', 'This order was cancelled');
    return this.mutate(o, (x) => { x.mpesaCode = c; x.payClaimed = true; x.history.push({ s: 'pay_claimed', at: Date.now(), by: 'customer' }); });
  }
  // Orders waiting for an M-Pesa payment that never came give their stock back after holdMinutes.
  sweep(now = Date.now()) {
    const mins = this.settings.holdMinutes; let n = 0;
    if (!mins) return 0;
    for (const o of this.orders.values()) {
      if (o.status === 'placed' && o.payMethod === 'mpesa' && !o.payClaimed && !o.paid && now - o.createdAt > mins * 60000) {
        this.mutate(o, (x) => { x.status = 'cancelled'; x.history.push({ s: 'cancelled', at: now, by: 'system' }); this.restock(x); }); n++;
      }
    }
    return n;
  }

  publicOrder(o) {
    return {
      id: o.id, no: o.no, createdAt: o.createdAt, updatedAt: o.updatedAt, rev: o.rev, status: o.status, method: o.method, zone: o.zone,
      name: o.name, address: o.address, items: o.items.map((l) => ({ name: l.name, size: l.size, colour: l.colour, qty: l.qty, price: l.price, photo: l.photo })),
      subtotal: o.subtotal, deliveryFee: o.deliveryFee, total: o.total, payMethod: o.payMethod, paid: o.paid, payClaimed: o.payClaimed, mpesaCode: o.mpesaCode,
      history: o.history.filter((h) => STATUSES.includes(h.s)).map((h) => ({ s: h.s, at: h.at })),
    };
  }
  ownerOrder(o) { const { key, ...rest } = o; return rest; }
  activeOrders() { return [...this.orders.values()].filter((o) => ACTIVE.includes(o.status)).sort((a, b) => a.createdAt - b.createdAt); }
  listOrders(f = {}) {
    const limit = U.int(f.limit, 1, 500, 100), q = f.q ? String(f.q).toLowerCase().trim().replace(/^#/, '') : '';
    const qDigits = q.replace(/\D/g, ''), qPhone = U.normPhone(q), res = [];
    for (const o of [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt)) {
      if (f.before && o.createdAt >= f.before) continue;
      if (f.day && o.day !== f.day) continue;
      if (f.from && o.day < f.from) continue;
      if (f.to && o.day > f.to) continue;
      if (f.status === 'active') { if (!ACTIVE.includes(o.status)) continue; } else if (f.status && f.status !== 'all' && o.status !== f.status) continue;
      if (q) {
        const hay = (o.name + ' ' + o.mpesaCode + ' ' + o.items.map((l) => l.name).join(' ') + ' ' + o.address).toLowerCase();
        if (!(hay.includes(q) || (qDigits.length >= 3 && (o.phone.includes(qDigits) || (qPhone && o.phone === qPhone))) || (/^\d{1,5}$/.test(q) && String(o.no) === q))) continue;
      }
      res.push(o);
      if (res.length > limit) break;
    }
    const more = res.length > limit; if (more) res.pop();
    return { orders: res, more, nextBefore: more ? res[res.length - 1].createdAt : null };
  }
  summary(day) {
    let orders = 0, revenue = 0, waiting = 0;
    for (const o of this.orders.values()) {
      if (ACTIVE.includes(o.status) && o.status === 'placed') waiting++;
      if (o.day === day && o.status !== 'cancelled') { orders++; revenue += o.total; }
    }
    const low = [];
    for (const p of this.products) for (const v of p.variants) if (!p.hidden && v.qty > 0 && v.qty <= 1) low.push({ pid: p.id, name: p.name, size: v.size, qty: v.qty });
    return { day, orders, revenue, waiting, products: this.products.length, soldOut: this.products.filter((p) => this.totalQty(p) === 0).length, low: low.slice(0, 30) };
  }

  /* ---------------- backup / restore / export ---------------- */
  backupObject() {
    const photos = {};
    for (const [id, m] of this.photos) { try { photos[id] = 'data:' + m.type + ';base64,' + fs.readFileSync(path.join(this.photoDir, id + '.' + m.ext)).toString('base64'); } catch (e) { /* skip */ } }
    return { app: 'shoe-shop', v: 1, savedAt: Date.now(), settings: this.settings, categories: this.categories, products: this.products, orders: [...this.orders.values()], photos };
  }
  restore(b) {
    if (!b || typeof b !== 'object' || b.app !== 'shoe-shop' || !Array.isArray(b.products)) throw new HttpError(400, 'bad_backup', 'That file is not a backup from this app');
    const settings = Object.assign(this.defaultSettings(), this.cleanSettings(b.settings || {}, true));
    settings.sessionEpoch = this.settings.sessionEpoch; // being logged in must survive a restore
    const cats = this.cleanCategories(b.categories);
    const oldSettings = this.settings, oldCats = this.categories;
    this.settings = settings; if (cats.length) this.categories = cats;
    const products = this.cleanProducts(b.products);
    const orders = new Map();
    for (const row of Array.isArray(b.orders) ? b.orders : []) { const o = this.normalizeOrder(row); if (o) orders.set(o.id, o); }
    // photos: write the ones in the backup, drop all others
    const wanted = new Set(); products.forEach((p) => p.photos.forEach((x) => wanted.add(x)));
    for (const id of [...this.photos.keys()]) this.dropPhotoFile(id);
    let skipped = 0;
    for (const [id, url] of Object.entries(b.photos && typeof b.photos === 'object' ? b.photos : {})) {
      if (!wanted.has(id) || !PHOTO_ID.test(id)) continue;
      try { const { buf, kind } = this.parsePhoto(url); this.writePhoto(id, buf, kind); } catch (e) { skipped++; }
    }
    products.forEach((p) => { p.photos = p.photos.filter((x) => this.photos.has(x)); });
    this.products = products; this.orders = orders; this.reindex(); this.saveConfig(); this.compactOrders();
    void oldSettings; void oldCats;
    this.emit('reset');
    return { products: products.length, orders: orders.size, photosSkipped: skipped };
  }
  exportCsv(from, to) {
    const rows = [['Order', 'Date', 'Status', 'Name', 'Phone', 'Method', 'Area', 'Address', 'Items', 'Subtotal', 'Delivery', 'Total', 'Payment', 'Paid', 'M-Pesa code']];
    for (const o of [...this.orders.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (from && o.day < from) continue; if (to && o.day > to) continue;
      rows.push([o.no, o.day, o.status, o.name, o.phone, o.method, o.zone, o.address, o.items.map((l) => l.qty + 'x ' + l.name + (l.size ? ' (' + l.size + ')' : '')).join('; '), o.subtotal, o.deliveryFee, o.total, o.payMethod, o.paid ? 'yes' : 'no', o.mpesaCode]);
    }
    return rows.map((r) => r.map(U.csvCell).join(',')).join('\n') + '\n';
  }
}

module.exports = { Shop, STATUSES, ACTIVE, slugify };
