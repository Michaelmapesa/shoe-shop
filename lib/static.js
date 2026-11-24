'use strict';
// Serves the app files from memory with compression and sensible caching.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const TEXTUAL = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt']);
const ROUTES = { '/': '/index.html', '/owner': '/owner.html', '/owner/': '/owner.html', '/privacy': '/privacy.html', '/offline': '/offline.html' };

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base + '/' + e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function loadStatic(root, vars) {
  const raw = new Map();
  const hash = crypto.createHash('sha1');
  for (const rel of walk(root).sort()) {
    const buf = fs.readFileSync(path.join(root, rel));
    raw.set(rel, buf); hash.update(rel).update(buf);
  }
  const version = hash.digest('hex').slice(0, 8);
  const files = new Map();
  for (const [rel, buf0] of raw) {
    const ext = path.extname(rel).toLowerCase();
    let buf = buf0;
    if (TEXTUAL.has(ext)) {
      let t = buf0.toString('utf8').replace(/__V__/g, version);
      for (const [k, v] of Object.entries(vars || {})) t = t.split(`__${k}__`).join(v);
      buf = Buffer.from(t);
    }
    const e = { type: MIME[ext] || 'application/octet-stream', buf, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"' };
    if (TEXTUAL.has(ext) && buf.length > 600) {
      e.gz = zlib.gzipSync(buf, { level: 9 });
      e.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    }
    e.cache = (ext === '.html' || rel === '/sw.js' || ext === '.webmanifest') ? 'no-cache' : null;
    files.set(rel, e);
  }
  return { files, version };
}

function serve(req, res, files, pathname, headers) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return false; }
  if (p.includes('\0') || p.includes('..')) return false;
  p = ROUTES[p] || p;
  const e = files.get(p);
  if (!e) return false;
  const h = Object.assign({}, headers, { 'Content-Type': e.type, 'ETag': e.etag, 'Vary': 'Accept-Encoding' });
  const hasV = /(^|&)v=/.test((req.url.split('?')[1]) || '');
  h['Cache-Control'] = e.cache || (hasV ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
  const isVideo = e.type.indexOf('video/') === 0;
  if (isVideo) h['Accept-Ranges'] = 'bytes';
  if (p === '/sw.js') h['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); res.end(); return true; }
  let body = e.buf;
  // Videos are sent in pieces on request (iPhones and Chrome need this to play and seek).
  if (isVideo && req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
    const size = e.buf.length;
    let start = m && m[1] !== '' ? Number(m[1]) : NaN, end = m && m[2] !== '' ? Number(m[2]) : NaN;
    if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, size - end); end = size - 1; }      // last N bytes
    else if (m && m[2] === '') end = size - 1;
    if (!m || Number.isNaN(start) || start >= size || end < start) { res.writeHead(416, Object.assign({}, h, { 'Content-Range': 'bytes */' + size })); res.end(); return true; }
    end = Math.min(end, size - 1);
    h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size; h['Content-Length'] = end - start + 1;
    res.writeHead(206, h);
    res.end(req.method === 'HEAD' ? undefined : e.buf.subarray(start, end + 1));
    return true;
  }
  const ae = String(req.headers['accept-encoding'] || '');
  if (e.br && /\bbr\b/.test(ae)) { body = e.br; h['Content-Encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

module.exports = { loadStatic, serve };
