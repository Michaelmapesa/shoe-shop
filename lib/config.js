'use strict';
const path = require('path');
const env = process.env;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; };

const cfg = {
  port: num(env.PORT, 3000),
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  publicDir: path.join(__dirname, '..', 'public'),
  ownerPasscode: String(env.OWNER_PASSCODE || ''),
  sessionSecret: String(env.SESSION_SECRET || ''),
  tz: env.SHOP_TZ || 'Africa/Nairobi',
  trustProxyHops: num(env.TRUST_PROXY_HOPS, 1),
  maxSse: num(env.MAX_LIVE_CONNECTIONS, 3000),
  maxSsePerIp: num(env.MAX_LIVE_PER_IP, 20),
  limits: {
    ordersPerIp: num(env.LIMIT_ORDERS_PER_IP, 12),
    ordersGlobal: num(env.LIMIT_ORDERS_GLOBAL, 150),
    loginFailsPerIp: num(env.LIMIT_LOGIN_FAILS, 5),
  },
  defaults: {
    shopName: env.SHOP_NAME || 'My Shoe Shop',
    whatsapp: env.SHOP_WHATSAPP || '',
    mpesa: env.MPESA_NUMBER || '',
  },
  pushSubject: env.VAPID_SUBJECT || 'mailto:owner@example.com',
  backupKeepDays: num(env.BACKUP_KEEP_DAYS, 14),
};
cfg.ownerEnabled = cfg.ownerPasscode.length >= 6;
module.exports = cfg;
