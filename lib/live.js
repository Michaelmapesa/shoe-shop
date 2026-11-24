'use strict';
// Live updates over Server-Sent Events (SSE): one long-lived GET per open app.
// Works through proxies, reconnects by itself, and needs no extra libraries.
class Hub {
  constructor(opts) {
    this.maxTotal = opts.maxSse; this.maxPerIp = opts.maxSsePerIp;
    this.owners = new Set(); this.publics = new Set(); this.perIp = new Map(); this.seq = 0;
    this.timer = setInterval(() => this.ping(), 20000); this.timer.unref();
  }
  get size() { return this.owners.size + this.publics.size; }

  open(req, res, ip, meta) {
    const owner = !!meta.owner;
    if (!owner) {
      if (this.size >= this.maxTotal) return null;
      if ((this.perIp.get(ip) || 0) >= this.maxPerIp) return null;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 30000); }
    const c = { res, ip, owner, orderId: meta.orderId || null };
    (owner ? this.owners : this.publics).add(c);
    if (!owner) this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    const drop = () => this.drop(c);
    req.on('close', drop); res.on('close', drop); res.on('error', drop);
    return c;
  }
  drop(c) {
    if (c.dead) return;
    c.dead = true;
    (c.owner ? this.owners : this.publics).delete(c);
    if (!c.owner) { const n = (this.perIp.get(c.ip) || 1) - 1; if (n <= 0) this.perIp.delete(c.ip); else this.perIp.set(c.ip, n); }
  }
  send(c, event, data) {
    if (c.dead) return;
    try {
      if (c.res.writableLength > 1e6) { this.drop(c); c.res.destroy(); return; } // a stuck phone must not eat our memory
      c.res.write(`id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { this.drop(c); }
  }
  toOwners(event, data) { for (const c of this.owners) this.send(c, event, data); }
  toPublic(event, data) { for (const c of this.publics) this.send(c, event, data); }
  toOrderWatchers(orderId, event, data) { for (const c of this.publics) if (c.orderId === orderId) this.send(c, event, data); }
  ping() {
    for (const set of [this.owners, this.publics]) for (const c of set) {
      // A real event (not a comment) so the app can notice if the line goes quiet and reconnect.
      try { c.res.write(`event: tick\ndata: {"now":${Date.now()}}\n\n`); } catch (e) { this.drop(c); }
    }
  }
  closeAll() {
    clearInterval(this.timer);
    for (const set of [this.owners, this.publics]) for (const c of [...set]) {
      try { c.res.write('event: bye\ndata: {}\n\n'); c.res.end(); } catch (e) { /* ignore */ }
      this.drop(c);
    }
  }
}
module.exports = { Hub };
