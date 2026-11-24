'use strict';
// Small helpers with no dependencies: ids, time, phone numbers, CSV, rate limiting.
const crypto = require('crypto');

const rid = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// Constant-time string compare (also safe for different lengths).
function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}

// "2026-11-15" in the shop's time zone (so "today" matches the shop's day, not the server's).
function makeDayFn(tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return (ts) => fmt.format(new Date(ts));
}

// Shift a YYYY-MM-DD string by n days (pure calendar maths, no time zones involved).
function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

// Normalise a phone number. Kenyan numbers become 2547XXXXXXXX / 2541XXXXXXXX;
// international numbers must start with + and are kept as digits. Returns '' if invalid.
function normPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (plus) return digits.length >= 8 && digits.length <= 15 ? digits : '';
  const m = digits.match(/^(?:254|0)?([17]\d{8})$/);
  return m ? '254' + m[1] : '';
}

// Plain text from user input: collapse whitespace, strip control characters, cap length.
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Same but keeps line breaks (for longer notes / comments).
function cleanMultiline(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
const int = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Sliding-window limiter: allow `max` hits per `windowMs` for each key.
class Limiter {
  constructor(max, windowMs, maxKeys = 20000) { this.max = max; this.windowMs = windowMs; this.maxKeys = maxKeys; this.map = new Map(); }
  hit(key, now = Date.now()) {
    let arr = this.map.get(key);
    if (!arr) {
      if (this.map.size >= this.maxKeys) this.map.delete(this.map.keys().next().value);
      arr = []; this.map.set(key, arr);
    }
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= this.max) return { ok: false, retryAfterMs: arr[0] + this.windowMs - now };
    arr.push(now);
    return { ok: true, retryAfterMs: 0 };
  }
  // Check without counting (used for lockouts).
  peek(key, now = Date.now()) {
    const arr = this.map.get(key);
    if (!arr) return { ok: true, retryAfterMs: 0 };
    const cutoff = now - this.windowMs;
    const live = arr.filter((t) => t > cutoff);
    if (live.length >= this.max) return { ok: false, retryAfterMs: live[0] + this.windowMs - now };
    return { ok: true, retryAfterMs: 0 };
  }
  clear(key) { this.map.delete(key); }
  sweep(now = Date.now()) {
    for (const [k, arr] of this.map) {
      while (arr.length && arr[0] <= now - this.windowMs) arr.shift();
      if (!arr.length) this.map.delete(k);
    }
  }
}

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}

module.exports = { rid, safeEq, makeDayFn, shiftDay, isDay, normPhone, cleanText, cleanMultiline, int, csvCell, Limiter, HttpError };
