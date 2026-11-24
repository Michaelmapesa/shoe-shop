/* Owner app: orders, products (quick add with camera photos and sizes), settings. */
(function () {
  'use strict';
  const { $, $$, esc, ksh, icon, api, live, toast, modal, confirmBox, waLink, telLink, prettyPhone, fmtTime, ago, fmtDay } = window.SH;
  const root = $('app');
  let O = null;               // { settings, products, orders:Map, summary, today }
  let tab = 'orders', ofilter = 'active', pq = '', stream = null, liveState = 'connecting';
  let audioCtx = null;

  const NEXT = { placed: ['confirmed', 'Confirm order'], confirmed: ['packed', 'Mark packed'], packed: ['dispatched', null], dispatched: ['delivered', 'Mark delivered'] };
  const LABEL = { placed: 'New', confirmed: 'Confirmed', packed: 'Packed', dispatched: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
  const cls = { placed: 'warn', confirmed: '', packed: '', dispatched: '', delivered: 'good', cancelled: 'bad' };

  /* ---------- login ---------- */
  function showLogin(msg) {
    if (stream) { stream.close(); stream = null; }
    root.innerHTML = '<div class="login"><h1>Shop owner</h1><p class="hint u-mb18">Enter your passcode to manage orders and stock.</p>' +
      '<div class="field"><input class="text-input" id="pass" type="password" autocomplete="current-password" placeholder="Passcode" autofocus></div>' +
      '<div class="form-error" id="lerr"' + (msg ? '' : ' hidden') + '>' + esc(msg || '') + '</div><button class="btn btn-primary block" id="lgo" type="button">Log in</button></div>';
    const go = async () => {
      try { await api('POST', '/api/owner/login', { passcode: $('pass').value }); boot(); }
      catch (e) { const er = $('lerr'); er.textContent = e.message; er.hidden = false; }
    };
    $('lgo').onclick = go; $('pass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }
  async function boot() {
    try {
      const st = await api('GET', '/api/owner/status');
      if (!st.enabled) return showLogin('Owner login is not set up yet. Set OWNER_PASSCODE on the server.');
      if (!st.loggedIn) return showLogin();
      const d = await api('GET', '/api/owner/bootstrap');
      O = { settings: d.settings, products: d.products, orders: new Map(d.orders.map((o) => [o.id, o])), summary: d.summary, today: d.today };
      document.documentElement.style.setProperty('--accent', O.settings.accent);
      render(); startLive();
    } catch (e) {
      if (e.status === 401) return showLogin();
      root.innerHTML = '<div class="page"><p>Could not load. ' + esc(e.message) + '</p><button class="btn btn-primary" id="rt" type="button">Try again</button></div>'; $('rt').onclick = boot;
    }
  }
  const oapi = async (m, p, b, o) => { try { return await api(m, p, b, o); } catch (e) { if (e.status === 401) { showLogin('Please log in again.'); } throw e; } };

  /* ---------- live ---------- */
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.22, 0.44].forEach((t) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination); g.gain.setValueAtTime(0.25, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.18); o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.2); });
    } catch (e) { /* sound is optional */ }
  }
  function startLive() {
    if (stream) stream.close();
    stream = live('/api/owner/live', {
      order(o) { const isNew = !O.orders.has(o.id); O.orders.set(o.id, o); if (isNew && o.status === 'placed') { beep(); toast('New order #' + o.no + ' · ' + ksh(o.total), 5000); } if (tab === 'orders') renderBody(); badge(); },
      product(p) { const i = O.products.findIndex((x) => x.id === p.id); if (i >= 0) O.products[i] = p; else O.products.unshift(p); if (tab === 'products') renderBody(); },
      'product-removed'(d) { O.products = O.products.filter((x) => x.id !== d.id); if (tab === 'products') renderBody(); },
      settings(s) { O.settings = s; document.documentElement.style.setProperty('--accent', s.accent); },
      summary(s) { O.summary = s; if (tab === 'orders') renderBody(); },
      reset() { boot(); },
      open() { if (O && stream && liveState !== 'connecting') refresh(); },
    }, (s) => { liveState = s; const d = $('liveDot'); if (d) { d.classList.toggle('live', s === 'live'); d.nextSibling.textContent = s === 'live' ? 'Live' : 'Reconnecting…'; } });
  }
  async function refresh() { try { const d = await api('GET', '/api/owner/bootstrap'); O.products = d.products; O.settings = d.settings; O.summary = d.summary; O.orders = new Map(d.orders.map((o) => [o.id, o])); renderBody(); badge(); } catch (e) { /* next time */ } }

  /* ---------- frame ---------- */
  function render() {
    root.innerHTML = '<div id="body"></div><nav class="otabs"><button class="otab" data-tab="orders" type="button">' + icon('list') + 'Orders<span class="badge" id="bOrders" hidden>0</span></button><button class="otab" data-tab="products" type="button">' + icon('box') + 'Products</button><button class="otab" data-tab="settings" type="button">' + icon('gear') + 'Settings</button></nav>';
    root.querySelector('.otabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderBody(); } };
    renderBody();
  }
  function badge() { const n = [...O.orders.values()].filter((o) => o.status === 'placed').length, b = $('bOrders'); if (b) { b.hidden = !n; b.textContent = n; } document.title = (n ? '(' + n + ') ' : '') + 'Shop owner'; }
  function renderBody() {
    $$('.otab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const body = $('body'); const scroll = window.scrollY;
    if (tab === 'orders') body.innerHTML = ordersHtml(); else if (tab === 'products') body.innerHTML = productsHtml(); else body.innerHTML = settingsHtml();
    if (tab === 'orders') bindOrders(); else if (tab === 'products') bindProducts(); else bindSettings();
    badge(); window.scrollTo(0, scroll);
  }

  /* ---------- orders ---------- */
  let extra = [];   // orders loaded by search / "all"
  function ordersHtml() {
    const s = O.summary;
    let list;
    if (ofilter === 'active') list = [...O.orders.values()].filter((o) => ['placed', 'confirmed', 'packed', 'dispatched'].includes(o.status)).sort((a, b) => a.createdAt - b.createdAt);
    else if (ofilter === 'today') list = [...O.orders.values()].filter((o) => o.day === O.today).sort((a, b) => b.createdAt - a.createdAt);
    else list = extra;
    const tabs = [['active', 'Active'], ['today', 'Today'], ['all', 'All / search']];
    return '<div class="page"><h2><span class="live-dot' + (liveState === 'live' ? ' live' : '') + '" id="liveDot"></span><span>' + (liveState === 'live' ? 'Live' : 'Connecting…') + '</span></h2>' +
      '<div class="stats"><div class="stat"><b>' + s.orders + '</b><span>Orders today</span></div><div class="stat"><b>' + ksh(s.revenue) + '</b><span>Sales today</span></div><div class="stat"><b>' + s.waiting + '</b><span>Waiting for you</span></div></div>' +
      '<div class="seg">' + tabs.map(([k, n]) => '<button type="button" class="pill' + (ofilter === k ? ' active' : '') + '" data-of="' + k + '">' + n + '</button>').join('') + '</div>' +
      (ofilter === 'all' ? '<div class="field"><input class="text-input" id="oq" type="search" placeholder="Name, phone, order number, M-Pesa code" value="' + esc(pq) + '"></div>' : '') +
      (list.length ? list.map(orderCard).join('') : '<div class="empty">' + (ofilter === 'active' ? 'No active orders. New orders appear here with a sound.' : 'Nothing here.') + '</div>') + '<div class="u-h90"></div></div>';
  }
  function orderCard(o) {
    const nx = NEXT[o.status], pickup = o.method === 'pickup';
    let nextLabel = nx ? nx[1] : null; if (o.status === 'packed') nextLabel = pickup ? 'Ready for pickup' : 'Send out for delivery';
    if (o.status === 'dispatched' && pickup) nextLabel = 'Mark picked up';
    const payChip = o.paid ? '<span class="status-chip good">Paid</span>' : o.payMethod === 'mpesa' ? (o.payClaimed ? '<span class="status-chip warn">M-Pesa code ' + esc(o.mpesaCode) + '</span>' : '<span class="status-chip warn">Waiting for M-Pesa</span>') : '<span class="status-chip">Cash on ' + (pickup ? 'pickup' : 'delivery') + '</span>';
    return '<div class="panel" data-id="' + esc(o.id) + '"><div class="ord-head"><div><b>#' + o.no + ' · ' + esc(o.name) + '</b><div class="ord-meta">' + fmtTime(o.createdAt) + ' · ' + ago(o.createdAt) + ' · ' + (pickup ? 'Pickup' : esc(o.zone)) + '</div></div><span class="status-chip ' + (cls[o.status] || '') + '">' + LABEL[o.status] + '</span></div>' +
      '<ul class="ord-items">' + o.items.map((l) => '<li>' + l.qty + '× <b>' + esc(l.name) + '</b>' + (l.size ? ' · size ' + esc(l.size) : '') + (l.colour ? ' · ' + esc(l.colour) : '') + '</li>').join('') + '</ul>' +
      (o.address ? '<div class="ord-meta">' + icon('truck') + ' ' + esc(o.address) + '</div>' : '') + (o.note ? '<div class="ord-meta">Note: ' + esc(o.note) + '</div>' : '') +
      '<div class="sum total u-fs15"><span>' + ksh(o.total) + (o.deliveryFee ? ' <small class="u-soft">incl. ' + ksh(o.deliveryFee) + ' delivery</small>' : '') + '</span><span>' + payChip + '</span></div>' +
      '<div class="ord-actions">' + (nextLabel ? '<button class="btn btn-primary btn-sm" data-a="next" type="button">' + nextLabel + '</button>' : '') +
      (!o.paid && o.status !== 'cancelled' ? '<button class="btn btn-good btn-sm" data-a="paid" type="button">Mark paid</button>' : '') +
      '<a class="btn btn-ghost btn-sm" href="' + telLink(o.phone) + '">' + icon('phone') + ' ' + esc(prettyPhone(o.phone)) + '</a>' +
      '<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="' + waLink(o.phone, 'Hi ' + o.name + ', about your order #' + o.no + ' from ' + O.settings.shopName) + '">' + icon('wa', 'wa') + '</a>' +
      (o.status === 'cancelled' ? '<button class="btn btn-ghost btn-sm" data-a="reopen" type="button">Reopen</button>' : o.status !== 'delivered' ? '<button class="btn btn-ghost btn-sm" data-a="cancel" type="button">Cancel</button>' : '') + '</div></div>';
  }
  function bindOrders() {
    $('body').onclick = async (e) => {
      const f = e.target.closest('[data-of]'); if (f) { ofilter = f.dataset.of; if (ofilter === 'all') await loadAll(); renderBody(); return; }
      const b = e.target.closest('[data-a]'); if (!b) return;
      const card = b.closest('[data-id]'), o = O.orders.get(card.dataset.id) || extra.find((x) => x.id === card.dataset.id); if (!o) return;
      const a = b.dataset.a;
      try {
        let patch = null;
        if (a === 'next') patch = { status: NEXT[o.status][0] };
        else if (a === 'paid') patch = { paid: true };
        else if (a === 'reopen') patch = { status: 'placed' };
        else if (a === 'cancel') { if (!(await confirmBox({ title: 'Cancel order #' + o.no + '?', text: 'The sizes go back into stock.', ok: 'Cancel order', cancel: 'Keep', danger: true }))) return; patch = { status: 'cancelled' }; }
        const r = await oapi('PATCH', '/api/owner/orders/' + o.id, patch);
        O.orders.set(r.order.id, r.order); const i = extra.findIndex((x) => x.id === r.order.id); if (i >= 0) extra[i] = r.order; O.summary = r.summary; renderBody();
      } catch (x) { toast(x.message, 4000); }
    };
    const q = $('oq'); if (q) { let t; q.oninput = () => { pq = q.value; clearTimeout(t); t = setTimeout(async () => { await loadAll(); const p = $('body'); const pos = q.selectionStart; renderBody(); const nq = $('oq'); if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); } }, 350); }; }
  }
  async function loadAll() { try { const r = await oapi('GET', '/api/owner/orders?limit=60&status=all&q=' + encodeURIComponent(pq)); extra = r.orders; } catch (e) { toast(e.message); } }

  /* ---------- products ---------- */
  function productsHtml() {
    const q = pq.toLowerCase();
    const list = O.products.filter((p) => !q || (p.name + ' ' + p.brand).toLowerCase().includes(q));
    const cat = (id) => (O.settings.categories.find((c) => c.id === id) || {}).name || '';
    return '<div class="page"><h2>Products</h2><p class="hint u-mb10">' + O.products.length + ' products · ' + O.products.filter((p) => p.totalQty === 0).length + ' sold out</p>' +
      '<div class="field"><input class="text-input" id="pq" type="search" placeholder="Search products" value="' + esc(pq) + '"></div>' +
      (list.length ? list.map((p) => '<button class="prow" type="button" data-p="' + esc(p.id) + '"><div class="prow-img">' + (p.photos[0] ? '<img src="' + esc(p.photos[0]) + '" alt="">' : icon('shoe')) + '</div><div class="prow-main"><b>' + esc(p.name) + '</b><span>' + ksh(p.price) + ' · ' + esc(cat(p.cat)) + '</span><br><span>' + (p.totalQty === 0 ? '<span class="u-bad">Sold out</span>' : p.sizes.filter((z) => z.qty > 0).map((z) => esc(z.size) + (z.qty > 1 ? '×' + z.qty : '')).join(', ')) + (p.hidden ? ' · <b>Hidden</b>' : '') + '</span></div>' + icon('chev') + '</button>').join('') : '<div class="empty">No products yet. Tap “Add product” to start.</div>') +
      '<div class="u-h150"></div></div><button class="btn btn-primary fab" id="addP" type="button">' + icon('plus') + ' Add product</button>';
  }
  function bindProducts() {
    $('body').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) openEditor(O.products.find((p) => p.id === b.dataset.p)); };
    $('addP').onclick = () => openEditor(null);
    const q = $('pq'); if (q) q.oninput = () => { pq = q.value; const pos = q.selectionStart; renderBody(); const n = $('pq'); n.focus(); n.setSelectionRange(pos, pos); };
  }

  // Shrink a camera photo in the browser to about 1000px so it uploads fast and loads fast.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const max = 1000, k = Math.min(1, max / Math.max(im.width, im.height)), w = Math.round(im.width * k), h = Math.round(im.height * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let q = 0.82; const tryOnce = () => c.toBlob((b) => {
          if (!b) return reject(new Error('Could not process that photo'));
          if (b.size > 560 * 1024 && q > 0.4) { q -= 0.12; return tryOnce(); }
          const r = new FileReader(); r.onload = () => resolve({ dataUrl: r.result, size: b.size }); r.onerror = () => reject(new Error('Could not read that photo')); r.readAsDataURL(b);
        }, 'image/jpeg', q);
        tryOnce();
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this phone can open')); };
      im.src = url;
    });
  }

  function openEditor(p) {
    const isNew = !p, st = isNew ? { name: '', brand: '', price: '', was: '', cat: O.settings.categories[0].id, gender: 'unisex', kind: 'shoes', colour: '', desc: '', hidden: false, sizes: [], photos: [], photoIds: [] } : JSON.parse(JSON.stringify(p));
    const pending = []; // new photos waiting for the first save
    const opt = (arr, cur) => arr.map(([v, n]) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    const sizeRows = () => st.sizes.map((z, i) => '<div class="vrow" data-i="' + i + '"><input class="text-input u-f1" data-f="size" value="' + esc(z.size) + '" placeholder="Size" maxlength="10"><input class="text-input u-w80" data-f="qty" type="number" inputmode="numeric" min="0" value="' + z.qty + '"><button class="icon-btn" data-x="delsize" type="button" aria-label="Remove size">' + icon('x') + '</button></div>').join('');
    const thumbs = () => {
      const have = st.photos.map((u, i) => '<div class="thumb"><img src="' + esc(u) + '" alt="">' + (i === 0 ? '<em>Cover</em>' : '') + '<button type="button" data-x="delphoto" data-id="' + esc(st.photoIds[i]) + '" aria-label="Remove photo">' + icon('x') + '</button></div>').join('');
      const pen = pending.map((u, i) => '<div class="thumb"><img src="' + esc(u) + '" alt="">' + (i === 0 && !st.photos.length ? '<em>Cover</em>' : '') + '<button type="button" data-x="delpending" data-i="' + i + '" aria-label="Remove photo">' + icon('x') + '</button></div>').join('');
      return have + pen + (st.photos.length + pending.length < 8 ? '<button class="addph" type="button" data-x="addphoto">' + icon('camera') + 'Add photo</button>' : '');
    };
    const html = () => '<div class="field"><div class="field-label">Photos</div><div class="thumbs" id="thumbs">' + thumbs() + '</div><input type="file" id="file" accept="image/*" multiple hidden></div>' +
      '<div class="field"><label for="f_name">Name</label><input class="text-input" id="f_name" maxlength="80" value="' + esc(st.name) + '" placeholder="e.g. Nike Air Force 1 White"></div>' +
      '<div class="row2"><div class="field"><label for="f_price">Price (KSh)</label><input class="text-input" id="f_price" type="number" inputmode="numeric" value="' + esc(st.price) + '"></div><div class="field"><label for="f_was">Old price (optional)</label><input class="text-input" id="f_was" type="number" inputmode="numeric" value="' + (st.was || '') + '" placeholder="Shows a discount"></div></div>' +
      '<div class="row2"><div class="field"><label for="f_cat">Category</label><select class="text-input" id="f_cat">' + opt(O.settings.categories.map((c) => [c.id, c.name]), st.cat) + '</select></div><div class="field"><label for="f_gender">For</label><select class="text-input" id="f_gender">' + opt([['men', 'Men'], ['women', 'Women'], ['kids', 'Kids'], ['unisex', 'Everyone']], st.gender) + '</select></div></div>' +
      '<div class="row2"><div class="field"><label for="f_brand">Brand</label><input class="text-input" id="f_brand" maxlength="40" value="' + esc(st.brand) + '"></div><div class="field"><label for="f_colour">Colour</label><input class="text-input" id="f_colour" maxlength="30" value="' + esc(st.colour) + '"></div></div>' +
      '<div class="field"><div class="field-label">Sizes and how many pairs you have</div><div id="sizes">' + sizeRows() + '</div><div class="ord-actions u-mt4"><button class="btn btn-ghost btn-sm" data-x="addsize" type="button">' + icon('plus') + ' Add size</button><button class="btn btn-ghost btn-sm" data-x="preset" data-set="shoes" type="button">Shoes 38–45</button><button class="btn btn-ghost btn-sm" data-x="preset" data-set="clothes" type="button">S–XXL</button><button class="btn btn-ghost btn-sm" data-x="preset" data-set="one" type="button">One size</button></div></div>' +
      '<div class="field"><label for="f_desc">Description (optional)</label><textarea class="text-area" id="f_desc" maxlength="800" placeholder="Material, fit, what makes it special">' + esc(st.desc) + '</textarea></div>' +
      '<label class="check"><input type="checkbox" id="f_hidden"' + (st.hidden ? ' checked' : '') + '> Hide from customers</label>' +
      (isNew ? '' : '<button class="link-btn danger" data-x="delete" type="button">Delete this product</button>') + '<div class="form-error" id="eerr" hidden></div>';
    const readFields = (m) => { const v = (id) => m.q('#' + id).value; Object.assign(st, { name: v('f_name').trim(), price: v('f_price'), was: v('f_was'), cat: v('f_cat'), gender: v('f_gender'), brand: v('f_brand').trim(), colour: v('f_colour').trim(), desc: v('f_desc'), hidden: m.q('#f_hidden').checked }); st.sizes = $$('.vrow', m.q('#sizes')).map((r) => ({ size: r.querySelector('[data-f=size]').value.trim(), qty: r.querySelector('[data-f=qty]').value, id: (st.sizes[Number(r.dataset.i)] || {}).id })); };
    const redraw = (m) => { readFields(m); m.q('#sizes').innerHTML = sizeRows(); m.q('#thumbs').innerHTML = thumbs(); };
    const mm = modal({
      title: isNew ? 'Add product' : 'Edit product', variant: 'full', html: html(), dismissible: false,
      actions: [{ label: 'Cancel', kind: 'ghost' }, { label: isNew ? 'Save product' : 'Save changes', kind: 'primary', onClick: async (m) => {
        readFields(m); m.error('');
        if (!st.name) { m.error('Please enter a name.'); return false; }
        if (!(Number(st.price) >= 1)) { m.error('Please enter the price.'); return false; }
        const sizes = st.sizes.filter((z) => z.size).map((z) => ({ id: z.id, size: z.size, qty: Math.max(0, Math.round(Number(z.qty) || 0)) }));
        if (!sizes.length) { m.error('Add at least one size (or tap “One size”).'); return false; }
        const body = { name: st.name, price: Number(st.price), was: st.was ? Number(st.was) : 0, cat: st.cat, gender: st.gender, brand: st.brand, colour: st.colour, desc: st.desc, hidden: st.hidden, sizes };
        try {
          let prod;
          if (isNew) { body.kind = st.cat && /cloth/i.test((O.settings.categories.find((c) => c.id === st.cat) || {}).name) ? 'clothes' : 'shoes'; prod = (await oapi('POST', '/api/owner/products', body)).product; }
          else prod = (await oapi('PATCH', '/api/owner/products/' + p.id, body)).product;
          upsert(prod);
          for (const u of pending) { try { prod = (await oapi('POST', '/api/owner/products/' + prod.id + '/photos', { image: u }, { timeout: 40000 })).product; upsert(prod); } catch (e) { toast('A photo did not upload: ' + e.message, 5000); } }
          toast('Saved'); renderBody();
        } catch (e) { m.error(e.message); return false; }
      } }],
      onMount: (m) => {
        m.el.querySelector('.modal-head h2').textContent = isNew ? 'Add product' : 'Edit product';
        m.body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-x]'); if (!b) return; const x = b.dataset.x;
          if (x === 'addphoto') m.q('#file').click();
          else if (x === 'addsize') { readFields(m); st.sizes.push({ size: '', qty: 1 }); redraw(m); const rows = $$('.vrow', m.q('#sizes')); rows[rows.length - 1].querySelector('input').focus(); }
          else if (x === 'delsize') { readFields(m); st.sizes.splice(Number(b.closest('.vrow').dataset.i), 1); m.q('#sizes').innerHTML = sizeRows(); }
          else if (x === 'preset') {
            readFields(m); const set = b.dataset.set; const names = set === 'shoes' ? ['38', '39', '40', '41', '42', '43', '44', '45'] : set === 'clothes' ? ['S', 'M', 'L', 'XL', 'XXL'] : ['One size'];
            const have = new Set(st.sizes.map((z) => z.size.toLowerCase())); names.forEach((n) => { if (!have.has(n.toLowerCase())) st.sizes.push({ size: n, qty: 1 }); }); m.q('#sizes').innerHTML = sizeRows();
          } else if (x === 'delpending') { readFields(m); pending.splice(Number(b.dataset.i), 1); m.q('#thumbs').innerHTML = thumbs(); }
          else if (x === 'delphoto') {
            if (!(await confirmBox({ title: 'Remove this photo?', ok: 'Remove', danger: true }))) return;
            try { const r = await oapi('DELETE', '/api/owner/products/' + p.id + '/photos/' + b.dataset.id); upsert(r.product); st.photos = r.product.photos; st.photoIds = r.product.photoIds; m.q('#thumbs').innerHTML = thumbs(); } catch (er) { toast(er.message); }
          } else if (x === 'delete') {
            if (!(await confirmBox({ title: 'Delete ' + p.name + '?', text: 'This removes it and its photos for good. Past orders are kept.', ok: 'Delete', danger: true }))) return;
            try { await oapi('DELETE', '/api/owner/products/' + p.id); O.products = O.products.filter((z) => z.id !== p.id); m.close(); renderBody(); toast('Deleted'); } catch (er) { toast(er.message); }
          }
        });
        m.q('#file').onchange = async (e) => {
          const files = [...e.target.files]; e.target.value = '';
          for (const f of files) {
            if (st.photos.length + pending.length >= 8) { toast('Up to 8 photos per product'); break; }
            try {
              const r = await shrink(f);
              if (isNew) { readFields(m); pending.push(r.dataUrl); m.q('#thumbs').innerHTML = thumbs(); }
              else { const res = await oapi('POST', '/api/owner/products/' + p.id + '/photos', { image: r.dataUrl }, { timeout: 40000 }); upsert(res.product); st.photos = res.product.photos; st.photoIds = res.product.photoIds; m.q('#thumbs').innerHTML = thumbs(); }
            } catch (er) { toast(er.message, 4000); }
          }
        };
      },
    });
  }
  function upsert(prod) { const i = O.products.findIndex((x) => x.id === prod.id); if (i >= 0) O.products[i] = prod; else O.products.unshift(prod); }

  /* ---------- settings ---------- */
  function settingsHtml() {
    const s = O.settings;
    const chk = (id, label, v) => '<label class="check"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> ' + label + '</label>';
    return '<div class="page"><h2>Settings</h2>' +
      '<div class="panel"><h3>Shop</h3><div class="field"><label>Shop name</label><input class="text-input" id="s_shopName" maxlength="40" value="' + esc(s.shopName) + '"></div><div class="field"><label>Tagline</label><input class="text-input" id="s_tagline" maxlength="80" value="' + esc(s.tagline) + '"></div><div class="field"><label>About (shown at the bottom)</label><textarea class="text-area" id="s_about" maxlength="600">' + esc(s.about) + '</textarea></div><div class="row2"><div class="field"><label>WhatsApp number</label><input class="text-input" id="s_whatsapp" type="tel" value="' + esc(s.whatsapp) + '" placeholder="07XX XXX XXX"></div><div class="field"><label>Call number</label><input class="text-input" id="s_phone" type="tel" value="' + esc(s.phone) + '"></div></div><div class="field"><label>Shop colour</label><input class="text-input u-color" id="s_accent" type="color" value="' + esc(s.accent) + '"></div></div>' +
      '<div class="panel"><h3>Taking orders</h3>' + chk('s_acceptingOrders', 'Accepting orders', s.acceptingOrders) + '<div class="field"><label>Message when closed</label><input class="text-input" id="s_closedMessage" maxlength="160" value="' + esc(s.closedMessage) + '"></div><div class="field"><label>Banner for customers (offers, holiday hours)</label><input class="text-input" id="s_announcement" maxlength="200" value="' + esc(s.announcement) + '"></div>' + chk('s_hideSoldOut', 'Hide sold-out items from the shop', s.hideSoldOut) + '</div>' +
      '<div class="panel"><h3>Delivery and pickup</h3>' + chk('s_deliveryEnabled', 'Offer delivery', s.deliveryEnabled) + '<div id="zones">' + s.zones.map(zoneRow).join('') + '</div><button class="btn btn-ghost btn-sm" id="addZone" type="button">' + icon('plus') + ' Add area</button>' + '<div class="u-h12"></div>' + chk('s_pickupEnabled', 'Offer pickup', s.pickupEnabled) + '<div class="field"><label>Pickup address</label><input class="text-input" id="s_pickupAddress" maxlength="160" value="' + esc(s.pickupAddress) + '"></div></div>' +
      '<div class="panel"><h3>Payment</h3>' + chk('s_payMpesa', 'Accept M-Pesa', s.payMpesa) + '<div class="field"><label>M-Pesa type</label><select class="text-input" id="s_mpesaMode"><option value="send"' + (s.mpesaMode === 'send' ? ' selected' : '') + '>Send money (phone number)</option><option value="till"' + (s.mpesaMode === 'till' ? ' selected' : '') + '>Till number (Buy Goods)</option><option value="paybill"' + (s.mpesaMode === 'paybill' ? ' selected' : '') + '>Paybill</option></select></div><div class="row2"><div class="field"><label>Number / Till / Paybill</label><input class="text-input" id="s_mpesaNumber" inputmode="numeric" value="' + esc(s.mpesaNumber) + '"></div><div class="field"><label>Name shown</label><input class="text-input" id="s_mpesaName" maxlength="40" value="' + esc(s.mpesaName) + '"></div></div>' + chk('s_payCod', 'Accept cash on delivery / pickup', s.payCod) + '<div class="row2"><div class="field"><label>Minimum order (KSh)</label><input class="text-input" id="s_minOrder" type="number" inputmode="numeric" value="' + s.minOrder + '"></div><div class="field"><label>Hold unpaid M-Pesa (minutes)</label><input class="text-input" id="s_holdMinutes" type="number" inputmode="numeric" value="' + s.holdMinutes + '"></div></div></div>' +
      '<div class="panel"><h3>Categories</h3><div id="cats">' + s.categories.map(catRow).join('') + '</div><button class="btn btn-ghost btn-sm" id="addCat" type="button">' + icon('plus') + ' Add category</button></div>' +
      '<div class="form-error" id="serr" hidden></div><button class="btn btn-primary block" id="saveS" type="button">Save settings</button>' +
      '<div class="panel u-mt16"><h3>Alerts on this phone</h3><p class="hint u-mt0">Get a notification for every new order, even when the app is closed.</p><div class="ord-actions"><button class="btn btn-ghost btn-sm" id="pushOn" type="button">Turn on alerts</button><button class="btn btn-ghost btn-sm" id="pushTest" type="button">Send test</button></div></div>' +
      '<div class="panel"><h3>Your data</h3><div class="ord-actions"><a class="btn btn-ghost btn-sm" href="/api/owner/export.csv">Orders (spreadsheet)</a><a class="btn btn-ghost btn-sm" href="/api/owner/backup.json">Full backup</a><button class="btn btn-ghost btn-sm" id="restore" type="button">Restore backup</button></div><p class="hint">A backup is also saved on the server every day. Download one now and then and keep it somewhere safe.</p></div>' +
      '<div class="ord-actions"><a class="btn btn-ghost btn-sm" href="/" target="_blank">Open the shop</a><button class="btn btn-ghost btn-sm" id="logout" type="button">Log out</button><button class="btn btn-ghost btn-sm" id="logoutAll" type="button">Log out everywhere</button></div><div class="u-h100"></div></div>';
  }
  const zoneRow = (z) => '<div class="vrow" data-z="' + esc(z.id) + '"><input class="text-input u-f1" data-f="name" value="' + esc(z.name) + '" placeholder="Area name"><input class="text-input u-w84" data-f="fee" type="number" inputmode="numeric" value="' + z.fee + '" aria-label="Fee"><button class="icon-btn" data-x="rm" type="button" aria-label="Remove">' + icon('x') + '</button></div>';
  const catRow = (c) => '<div class="vrow" data-c="' + esc(c.id) + '"><input class="text-input u-f1" data-f="name" value="' + esc(c.name) + '" maxlength="30"><button class="icon-btn" data-x="rm" type="button" aria-label="Remove">' + icon('x') + '</button></div>';
  function bindSettings() {
    const b = $('body');
    b.onclick = async (e) => {
      const t = e.target.closest('button,a'); if (!t) return;
      if (t.dataset.x === 'rm') t.closest('.vrow').remove();
      else if (t.id === 'addZone') $('zones').insertAdjacentHTML('beforeend', zoneRow({ id: '', name: '', fee: 300 }));
      else if (t.id === 'addCat') $('cats').insertAdjacentHTML('beforeend', catRow({ id: '', name: '' }));
      else if (t.id === 'saveS') saveSettings();
      else if (t.id === 'logout') { await api('POST', '/api/owner/logout', {}).catch(() => {}); O = null; showLogin(); }
      else if (t.id === 'logoutAll') { if (await confirmBox({ title: 'Log out everywhere?', text: 'Every phone and computer will need the passcode again, and alerts stop.', ok: 'Log out all', danger: true })) { await api('POST', '/api/owner/logout-all', {}).catch(() => {}); O = null; showLogin(); } }
      else if (t.id === 'pushOn') pushOn(); else if (t.id === 'pushTest') { try { const r = await oapi('POST', '/api/owner/push/test', {}); toast(r && r.sent ? 'Test sent' : 'No phone is registered for alerts yet'); } catch (x) { toast(x.message); } }
      else if (t.id === 'restore') restoreFlow();
    };
  }
  async function saveSettings() {
    const v = (id) => $('s_' + id).value, c = (id) => $('s_' + id).checked, er = $('serr');
    const body = { shopName: v('shopName'), tagline: v('tagline'), about: v('about'), whatsapp: v('whatsapp'), phone: v('phone'), accent: v('accent'), acceptingOrders: c('acceptingOrders'), closedMessage: v('closedMessage'), announcement: v('announcement'), hideSoldOut: c('hideSoldOut'),
      deliveryEnabled: c('deliveryEnabled'), pickupEnabled: c('pickupEnabled'), pickupAddress: v('pickupAddress'), payMpesa: c('payMpesa'), mpesaMode: v('mpesaMode'), mpesaNumber: v('mpesaNumber'), mpesaName: v('mpesaName'), payCod: c('payCod'), minOrder: v('minOrder'), holdMinutes: v('holdMinutes'),
      zones: $$('#zones .vrow').map((r) => ({ id: r.dataset.z || undefined, name: r.querySelector('[data-f=name]').value, fee: r.querySelector('[data-f=fee]').value })).filter((z) => z.name.trim()),
      categories: $$('#cats .vrow').map((r) => ({ id: r.dataset.c || undefined, name: r.querySelector('[data-f=name]').value })).filter((z) => z.name.trim()) };
    if (!body.payMpesa && !body.payCod) { er.textContent = 'Turn on at least one payment option.'; er.hidden = false; return; }
    if (!body.deliveryEnabled && !body.pickupEnabled) { er.textContent = 'Turn on delivery or pickup.'; er.hidden = false; return; }
    if (body.payMpesa && !body.mpesaNumber.replace(/\D/g, '')) { er.textContent = 'Enter your M-Pesa number, or turn M-Pesa off.'; er.hidden = false; return; }
    try { er.hidden = true; const r = await oapi('PATCH', '/api/owner/settings', body); O.settings = r.settings; document.documentElement.style.setProperty('--accent', r.settings.accent); toast('Settings saved'); renderBody(); } catch (e) { er.textContent = e.message; er.hidden = false; }
  }

  /* ---------- alerts + restore ---------- */
  const keyBytes = (k) => { const pad = '='.repeat((4 - k.length % 4) % 4), raw = atob((k + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  async function pushOn() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('This browser cannot show alerts. On iPhone, add the app to your Home Screen first.', 5000);
    try {
      if ((await Notification.requestPermission()) !== 'granted') return toast('Alerts were blocked. Allow notifications for this site in your browser settings.', 5000);
      const cfg = await oapi('GET', '/api/owner/push/config'), reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) });
      await oapi('POST', '/api/owner/push/subscribe', { subscription: sub.toJSON() }); toast('Alerts are on for this phone');
    } catch (e) { toast('Could not turn on alerts: ' + e.message, 5000); }
  }
  async function restoreFlow() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      if (!(await confirmBox({ title: 'Restore this backup?', text: 'This REPLACES all products, photos, orders and settings with what is in the file.', ok: 'Restore', danger: true }))) return;
      try { const backup = JSON.parse(await f.text()); const r = await oapi('POST', '/api/owner/restore', { backup, confirm: 'RESTORE' }, { timeout: 60000 }); toast('Restored ' + r.products + ' products and ' + r.orders + ' orders', 5000); boot(); } catch (e) { toast(e.message, 5000); }
    };
    inp.click();
  }

  window.SH.registerSW();
  boot();
})();
