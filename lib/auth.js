'use strict';
// Owner login: one passcode (set in the host's settings as OWNER_PASSCODE).
// After login the browser gets a signed, HttpOnly cookie that lasts 30 days. Nothing about sessions is stored on disk;
// changing the passcode, or pressing "Log out everywhere", signs every device out.
const crypto = require('crypto');
const U = require('./util');

const COOKIE = 'sh_owner';
const MAX_AGE = 30 * 24 * 3600;

function makeAuth(cfg, getEpoch) {
  const key = crypto.createHmac('sha256', 'shop-session-v1').update(cfg.ownerPasscode + '\n' + cfg.sessionSecret).digest();
  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  return {
    enabled: cfg.ownerEnabled,
    checkPasscode(p) { return cfg.ownerEnabled && typeof p === 'string' && p.length <= 200 && U.safeEq(p, cfg.ownerPasscode); },
    issue() {
      const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
      const body = `v1.${exp}.${getEpoch()}`;
      return body + '.' + sign(body);
    },
    verify(token) {
      if (!cfg.ownerEnabled || typeof token !== 'string' || token.length > 200) return false;
      const parts = token.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') return false;
      if (!U.safeEq(parts[3], sign(parts.slice(0, 3).join('.')))) return false;
      if (Number(parts[1]) < Date.now() / 1000) return false;
      return Number(parts[2]) === getEpoch();
    },
  };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore */ } }
  });
  return out;
}
function cookieHeader(value, { secure, clear }) {
  return `${COOKIE}=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : MAX_AGE}${secure ? '; Secure' : ''}`;
}

module.exports = { makeAuth, parseCookies, cookieHeader, COOKIE };
