/* Shared helpers for the customer app and the owner dashboard: DOM, API, live connection, dialogs, toasts. */
(function () {
  'use strict';
  const SH = (window.SH = window.SH || {});

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const ksh = (n) => 'KSh ' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const icon = (name, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---- time: use the server's clock so phones with a wrong date/time still show correct "x min ago" ----
  const clock = {
    offset: 0,
    now() { return Date.now() + this.offset; },
    sync(serverNow) { if (typeof serverNow === 'number' && isFinite(serverNow)) this.offset = serverNow - Date.now(); },
  };
  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const fmtTime = (ts) => timeFmt.format(new Date(ts));
  function fmtDay(day, long) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    if (!m) return day || '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }, long ? { year: 'numeric' } : {}));
  }
  function ago(ts, words) {
    const s = Math.max(0, (clock.now() - ts) / 1000);
    const w = words || { now: 'just now', min: 'min ago', hr: 'h ago', day: 'd ago' };
    if (s < 45) return w.now;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' ' + w.min;
    if (s < 86400) return Math.floor(s / 3600) + ' ' + w.hr;
    return Math.floor(s / 86400) + ' ' + w.day;
  }

  // ---- API ----
  async function api(method, path, body, opts) {
    const o = opts || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeout || 15000);
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? 'The server is taking too long' : 'No internet connection');
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'offline'; err.status = 0; err.data = {};
      throw err;
    }
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || 'Something went wrong (' + res.status + ')');
      err.status = res.status; err.code = (data && data.error) || 'http'; err.data = data || {};
      throw err;
    }
    if (data && typeof data.now === 'number') clock.sync(data.now);
    return data;
  }

  // ---- live connection (Server-Sent Events) with watchdog + automatic reconnect ----
  function live(url, handlers, onState) {
    let es = null, closed = false, retry = 0, last = Date.now(), state = 'connecting', timer = null;
    const setState = (s) => { if (s !== state) { state = s; if (onState) onState(s); } };
    function schedule(now) {
      if (closed) return;
      clearTimeout(timer);
      const wait = now ? 0 : Math.min(15000, 800 * Math.pow(1.7, retry++));
      timer = setTimeout(open, wait);
    }
    function open() {
      if (closed) return;
      if (es) { try { es.close(); } catch (e) { /* ignore */ } es = null; }
      try { es = new EventSource(typeof url === 'function' ? url() : url); } catch (e) { setState('reconnecting'); return schedule(); }
      last = Date.now();
      es.addEventListener('hello', (e) => {
        retry = 0; last = Date.now(); setState('live');
        let d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ }
        clock.sync(d.now);
        if (handlers.open) handlers.open(d);
      });
      es.addEventListener('tick', (e) => { last = Date.now(); try { clock.sync(JSON.parse(e.data).now); } catch (x) { /* ignore */ } });
      es.addEventListener('bye', () => { try { es.close(); } catch (e) { /* ignore */ } setState('reconnecting'); schedule(); });
      Object.keys(handlers).forEach((name) => {
        if (name === 'open') return;
        es.addEventListener(name, (e) => { last = Date.now(); let d; try { d = JSON.parse(e.data); } catch (x) { return; } handlers[name](d); });
      });
      es.onerror = () => {
        setState('reconnecting');
        if (es && es.readyState === 2) schedule(); // the browser gave up (e.g. server error): we retry ourselves
      };
    }
    const watchdog = setInterval(() => { if (!closed && state === 'live' && Date.now() - last > 55000) { setState('reconnecting'); schedule(true); } }, 10000);
    const wake = () => { if (!closed && (state !== 'live' || Date.now() - last > 35000)) { retry = 0; schedule(true); } };
    window.addEventListener('online', wake);
    window.addEventListener('offline', () => { if (!closed && state === 'live') setState('reconnecting'); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
    open();
    return {
      reconnect() { retry = 0; schedule(true); },
      close() { closed = true; clearInterval(watchdog); clearTimeout(timer); if (es) es.close(); },
      get state() { return state; },
    };
  }

  // ---- toast ----
  let toastTimer = null;
  function toast(msg, ms) {
    let el = $('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2800);
  }

  // ---- dialogs (stackable): dialog | sheet | drawer ----
  const stack = [];
  let uid = 0;
  function modal(o) {
    const id = ++uid, prevFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'modal-root'; root.style.zIndex = String(2000 + stack.length * 10);
    const variant = o.variant || 'dialog';
    root.innerHTML = '<div class="modal-backdrop"></div><div class="modal modal-' + variant + (o.className ? ' ' + o.className : '') + '" role="dialog" aria-modal="true" aria-labelledby="mt' + id + '" tabindex="-1">' +
      '<div class="modal-head"><h2 id="mt' + id + '">' + esc(o.title || '') + '</h2>' +
      (o.hideClose ? '' : '<button type="button" class="icon-btn" data-m="close" aria-label="Close">' + icon('x') + '</button>') + '</div>' +
      '<div class="modal-body">' + (o.html || '') + '</div>' +
      ((o.actions && o.actions.length) ? '<div class="modal-actions">' + o.actions.map((a, i) => '<button type="button" class="btn btn-' + (a.kind || 'ghost') + '" data-m="act" data-i="' + i + '">' + esc(a.label) + '</button>').join('') + '</div>' : '') +
      '</div>';
    document.body.appendChild(root);
    const box = root.querySelector('.modal'), body = root.querySelector('.modal-body');
    let resolveFn; const done = new Promise((r) => { resolveFn = r; });
    const m = {
      el: root, box, body, done, closed: false,
      q: (sel) => body.querySelector(sel), qa: (sel) => $$(sel, body),
      setBody(html) { body.innerHTML = html; },
      setTitle(t) { root.querySelector('h2').textContent = t; },
      error(msg) { const e = body.querySelector('.form-error'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } },
      close(v) {
        if (m.closed) return; m.closed = true;
        const ix = stack.indexOf(m); if (ix >= 0) stack.splice(ix, 1);
        root.classList.remove('open');
        setTimeout(() => root.remove(), 220);
        if (o.onClose) o.onClose(v);
        if (!stack.length) document.documentElement.classList.remove('modal-open');
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        resolveFn(v);
      },
      btn(i) { return root.querySelectorAll('.modal-actions .btn')[i]; },
    };
    stack.push(m);
    document.documentElement.classList.add('modal-open');
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('modal-backdrop')) { if (o.dismissible !== false) m.close(undefined); return; }
      const b = t.closest('[data-m]'); if (!b) return;
      if (b.getAttribute('data-m') === 'close') return m.close(undefined);
      const a = o.actions[Number(b.getAttribute('data-i'))];
      if (!a) return;
      if (a.onClick) {
        const r = a.onClick(m, b);
        if (r && typeof r.then === 'function') { b.disabled = true; r.then((v) => { b.disabled = false; if (v !== false) m.close(a.value); }, () => { b.disabled = false; }); }
        else if (r !== false) m.close(a.value);
      } else m.close(a.value);
    });
    requestAnimationFrame(() => { root.classList.add('open'); if (o.onMount) o.onMount(m); const f = body.querySelector('[autofocus],input,textarea,select'); (o.focus === false ? box : (f || box)).focus({ preventScroll: true }); });
    return m;
  }
  document.addEventListener('keydown', (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); top.close(undefined); return; }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = $$('button:not([disabled]),input:not([disabled]),select,textarea,a[href],[tabindex]:not([tabindex="-1"])', top.box).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === top.box)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    }
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !e.target.closest('[data-no-enter]')) {
      const primary = top.el.querySelector('.modal-actions .btn-primary, .modal-actions .btn-danger');
      if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
    }
  });
  function confirmBox(o) {
    return modal({
      title: o.title, variant: 'dialog', hideClose: true, dismissible: true,
      html: (o.text ? '<p class="modal-text">' + esc(o.text) + '</p>' : '') + (o.html || ''),
      actions: [{ label: o.cancel || 'Cancel', kind: 'ghost', value: false }, { label: o.ok || 'OK', kind: o.danger ? 'danger' : 'primary', value: true, onClick: o.onOk }],
    }).done.then((v) => v === true);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  const waLink = (num, text) => 'https://wa.me/' + String(num || '').replace(/\D/g, '') + (text ? '?text=' + encodeURIComponent(text) : '');
  const telLink = (num) => 'tel:+' + String(num || '').replace(/\D/g, '');
  const prettyPhone = (n) => { const d = String(n || '').replace(/\D/g, ''); return /^254\d{9}$/.test(d) ? '0' + d.slice(3, 6) + ' ' + d.slice(6, 9) + ' ' + d.slice(9) : (d ? '+' + d : ''); };

  // PWA: register the service worker (installable + opens fast + works offline)
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
  // "Add to home screen" prompt (Android Chrome)
  let deferredInstall = null;
  const installListeners = [];
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; installListeners.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; installListeners.forEach((f) => f()); });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.startsWith('android-app://');
  const canInstall = () => !!deferredInstall && !isStandalone();
  async function promptInstall() { if (!deferredInstall) return false; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) { /* ignore */ } deferredInstall = null; installListeners.forEach((f) => f()); return true; }

  Object.assign(SH, { $, $$, esc, ksh, icon, store, clock, fmtTime, fmtDay, ago, api, live, toast, modal, confirmBox, copyText, waLink, telLink, prettyPhone, registerSW, canInstall, promptInstall, isStandalone, onInstallChange: (f) => installListeners.push(f) });
})();

/* Load the Google font without blocking the first paint (the app works fine in the fallback font). */
(function () {
  try {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  } catch (e) { /* ignore */ }
})();
