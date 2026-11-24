/* Customer storefront: browse, pick a size, bag, checkout, follow the order live. */
(function () {
  'use strict';
  const { $, $$, esc, ksh, icon, store, api, live, toast, modal, confirmBox, copyText, waLink, telLink, prettyPhone, fmtTime, ago } = window.SH;

  let S = { settings: null, categories: [], products: [] };
  let F = { cat: 'all', gender: 'all', size: 'all', sort: 'new', q: '' };
  let bag = store.get('sh_bag', []);                 // [{pid, vid, qty}]
  let myOrder = store.get('sh_order', null);         // {id, key}
  let pv = null;                                     // open product view modal
  let orderLive = null;

  const byId = (id) => S.products.find((p) => p.id === id);
  const saveBag = () => { store.set('sh_bag', bag); renderBag(); };
  const GEN = { men: 'Men', women: 'Women', kids: 'Kids', unisex: 'Unisex' };

  /* ---------- data ---------- */
  async function load() {
    try {
      const d = await api('GET', '/api/shop');
      S = { settings: d.settings, categories: d.categories, products: d.products };
      reconcileBag(); paint(); openFromUrl();
    } catch (e) {
      $('grid').innerHTML = '<div class="empty">Could not load the shop.<br>' + esc(e.message) + '<br><br><button class="btn btn-primary" id="retry" type="button">Try again</button></div>';
      const r = $('retry'); if (r) r.onclick = load;
    }
  }
  function reconcileBag() {
    const next = [];
    for (const l of bag) {
      const p = byId(l.pid), v = p && p.sizes.find((s) => s.id === l.vid);
      if (!p || !v) continue;
      next.push({ pid: l.pid, vid: l.vid, qty: Math.max(1, Math.min(10, l.qty | 0)) });
    }
    bag = next; store.set('sh_bag', bag);
  }

  /* ---------- page ---------- */
  function paint() {
    const s = S.settings;
    document.documentElement.style.setProperty('--accent', s.accent);
    $('shopName').textContent = s.shopName; $('tagline').textContent = s.tagline || '';
    let n = '';
    if (!s.acceptingOrders) n = '<div class="notice closed">' + esc(s.closedMessage) + '</div>';
    else if (s.announcement) n = '<div class="notice">' + esc(s.announcement) + '</div>';
    $('notice').innerHTML = n;
    const cats = [['all', 'All']].concat(S.categories.map((c) => [c.id, c.name]));
    $('catPills').innerHTML = cats.map(([id, name]) => '<button type="button" class="pill' + (F.cat === id ? ' active' : '') + '" data-cat="' + esc(id) + '">' + esc(name) + '</button>').join('');
    const gens = ['all'].concat(['men', 'women', 'kids'].filter((g) => S.products.some((p) => p.gender === g)));
    $('genderPills').hidden = gens.length < 3;
    $('genderPills').innerHTML = gens.map((g) => '<button type="button" class="pill' + (F.gender === g ? ' active' : '') + '" data-gender="' + g + '">' + (g === 'all' ? 'Everyone' : GEN[g]) + '</button>').join('');
    const sizes = [...new Set(S.products.flatMap((p) => p.sizes.filter((z) => z.qty > 0).map((z) => z.size)))].sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
    if (F.size !== 'all' && !sizes.includes(F.size)) F.size = 'all';
    $('sizeSel').innerHTML = '<option value="all">Any size</option>' + sizes.map((z) => '<option' + (F.size === z ? ' selected' : '') + '>' + esc(z) + '</option>').join('');
    $('footer').innerHTML = (s.about ? '<p>' + esc(s.about) + '</p>' : '') + (s.whatsapp ? '<p><a href="' + waLink(s.whatsapp) + '" target="_blank" rel="noopener">Chat on WhatsApp</a>' + (s.phone ? ' · <a href="' + telLink(s.phone) + '">' + esc(prettyPhone(s.phone)) + '</a>' : '') + '</p>' : '');
    $('btnOrder').hidden = !myOrder;
    renderGrid(); renderBag();
  }
  function filtered() {
    const q = F.q.trim().toLowerCase();
    let list = S.products.filter((p) => (F.cat === 'all' || p.cat === F.cat) && (F.gender === 'all' || p.gender === F.gender || p.gender === 'unisex') &&
      (F.size === 'all' || p.sizes.some((z) => z.size === F.size && z.qty > 0)) &&
      (!q || (p.name + ' ' + p.brand + ' ' + p.colour).toLowerCase().includes(q)));
    if (F.sort === 'low') list.sort((a, b) => a.price - b.price); else if (F.sort === 'high') list.sort((a, b) => b.price - a.price);
    else list.sort((a, b) => (a.soldOut - b.soldOut) || (b.createdAt - a.createdAt));
    return list;
  }
  const img = (p) => p.photos[0] ? '<img src="' + esc(p.photos[0]) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async">' : icon('shoe');
  function renderGrid() {
    const list = filtered();
    $('count').textContent = S.products.length ? list.length + (list.length === 1 ? ' item' : ' items') : '';
    if (!list.length) { $('grid').innerHTML = '<div class="empty u-span">' + (S.products.length ? 'Nothing matches. Try another size or category.' : 'New stock is coming soon. Check back shortly!') + '</div>'; return; }
    $('grid').innerHTML = list.map((p) => {
      const off = p.was > p.price ? Math.round((1 - p.price / p.was) * 100) : 0;
      return '<a class="card' + (p.soldOut ? ' soldout' : '') + '" href="/p/' + esc(p.slug) + '" data-open="' + esc(p.id) + '"><div class="card-img">' + img(p) +
        (off ? '<span class="tag">-' + off + '%</span>' : '') + (p.soldOut ? '<span class="soldtag">Sold out</span>' : '') + '</div>' +
        (p.brand ? '<div class="card-brand">' + esc(p.brand) + '</div>' : '') + '<div class="card-name">' + esc(p.name) + '</div>' +
        '<div class="price">' + ksh(p.price) + (p.was > p.price ? '<s>' + ksh(p.was) + '</s>' : '') + '</div></a>';
    }).join('');
  }

  /* ---------- product view ---------- */
  function openProduct(id, fromUrl) {
    const p = byId(id); if (!p) return;
    if (pv) pv.close();
    let sel = null;
    const only = p.sizes.filter((z) => z.qty > 0);
    if (only.length === 1) sel = only[0].id;
    const s = S.settings;
    const html = () => {
      const off = p.was > p.price ? p.was - p.price : 0;
      return '<div class="pv"><div class="pv-top"><button class="icon-btn" data-x="close" type="button" aria-label="Back">' + icon('back') + '</button><button class="icon-btn" data-x="share" type="button" aria-label="Share">' + icon('share') + '</button></div>' +
        '<div class="pv-scroll"><div class="gallery"><div class="slides" id="slides">' + (p.photos.length ? p.photos.map((u, i) => '<div class="slide"><img src="' + esc(u) + '" alt="' + esc(p.name) + ' photo ' + (i + 1) + '"' + (i ? ' loading="lazy"' : '') + '></div>').join('') : '<div class="slide">' + icon('shoe') + '</div>') + '</div>' +
        (p.photos.length > 1 ? '<div class="dots" id="dots">' + p.photos.map((_, i) => '<i class="' + (i ? '' : 'on') + '"></i>').join('') + '</div>' : '') + '</div>' +
        '<div class="pv-body">' + (p.brand ? '<div class="pv-brand">' + esc(p.brand) + '</div>' : '') + '<h2>' + esc(p.name) + '</h2>' +
        '<div class="pv-price">' + ksh(p.price) + (off ? '<s>' + ksh(p.was) + '</s><span class="save">Save ' + ksh(off) + '</span>' : '') + '</div>' +
        (p.colour ? '<div class="hint">Colour: ' + esc(p.colour) + (p.gender !== 'unisex' ? ' · ' + GEN[p.gender] : '') + '</div>' : '') +
        '<div class="h-label">' + (p.soldOut ? 'Sold out' : 'Choose size') + '</div><div class="sizes" id="sizes">' +
        p.sizes.map((z) => '<button type="button" class="size' + (z.qty < 1 ? ' out' : '') + (sel === z.id ? ' sel' : '') + '" data-vid="' + esc(z.id) + '"' + (z.qty < 1 ? ' disabled' : '') + '>' + esc(z.size) + (z.qty > 0 && z.qty <= 2 ? '<small>' + z.qty + ' left</small>' : '') + '</button>').join('') + '</div>' +
        '<div class="form-error" id="pvErr" hidden></div>' +
        (p.desc ? '<div class="h-label">About this item</div><div class="desc">' + esc(p.desc) + '</div>' : '') +
        '<div class="trust"><span>' + icon('truck') + 'Delivery across Nairobi</span><span>' + icon('shield') + 'Pay by M-Pesa or on delivery</span></div></div></div>' +
        '<div class="pv-foot">' + (s.whatsapp ? '<a class="btn btn-ghost u-ns" target="_blank" rel="noopener" href="' + waLink(s.whatsapp, 'Hi, I am asking about ' + p.name + ' ' + location.origin + '/p/' + p.slug) + '" aria-label="Ask on WhatsApp">' + icon('wa', 'wa') + '</a>' : '') +
        '<button class="btn btn-primary" data-x="add" type="button"' + (p.soldOut ? ' disabled' : '') + '>' + (p.soldOut ? 'Sold out' : 'Add to bag') + '</button></div></div>';
    };
    pv = modal({
      title: p.name, variant: 'full', html: html(), hideClose: true, focus: false,
      onClose: () => { pv = null; if (location.pathname.startsWith('/p/') && !fromUrl) history.back(); else if (location.pathname.startsWith('/p/')) history.replaceState({}, '', '/'); },
      onMount: (m) => {
        m.el.querySelector('.modal-head').hidden = true;
        const slides = m.q('#slides');
        if (slides) slides.addEventListener('scroll', () => { const i = Math.round(slides.scrollLeft / slides.clientWidth); $$('#dots i', m.body).forEach((d, k) => d.classList.toggle('on', k === i)); }, { passive: true });
        m.body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-x],[data-vid]'); if (!b) return;
          const cur = byId(id) || p;
          if (b.dataset.vid) { sel = b.dataset.vid; $$('.size', m.body).forEach((x) => x.classList.toggle('sel', x.dataset.vid === sel)); m.q('#pvErr').hidden = true; return; }
          const act = b.dataset.x;
          if (act === 'close') m.close();
          else if (act === 'share') {
            const url = location.origin + '/p/' + cur.slug;
            try { if (navigator.share) { await navigator.share({ title: cur.name, text: cur.name + ' · ' + ksh(cur.price), url }); return; } } catch (x) { return; }
            toast((await copyText(url)) ? 'Link copied' : url);
          } else if (act === 'add') {
            const sz = cur.sizes.find((z) => z.id === sel);
            if (!sz) { const er = m.q('#pvErr'); er.textContent = 'Please choose a size first.'; er.hidden = false; return; }
            const line = bag.find((l) => l.pid === cur.id && l.vid === sz.id);
            const have = line ? line.qty : 0;
            if (have + 1 > sz.qty) { toast('Only ' + sz.qty + ' in stock in size ' + sz.size); return; }
            if (line) line.qty++; else bag.push({ pid: cur.id, vid: sz.id, qty: 1 });
            saveBag(); m.close(); toast('Added to bag');
          }
        });
      },
    });
    pv.p = p; pv.rerender = () => { const np = byId(id); if (!np) { pv.close(); toast('This item was just removed'); return; } Object.assign(p, np); pv.setBody(html()); };
    if (!fromUrl && !location.pathname.startsWith('/p/')) history.pushState({ pv: id }, '', '/p/' + p.slug);
  }
  window.addEventListener('popstate', () => { if (pv && !location.pathname.startsWith('/p/')) { const m = pv; pv = null; m.close(); } else if (!pv && location.pathname.startsWith('/p/')) openFromUrl(); });
  function openFromUrl() {
    const m = /^\/p\/([^/]+)/.exec(location.pathname); if (!m || pv) return;
    const id = decodeURIComponent(m[1]).split('-').pop();
    if (byId(id)) openProduct(id, true); else if (S.products.length) { history.replaceState({}, '', '/'); toast('That item is no longer available'); }
  }

  /* ---------- bag ---------- */
  function bagLines() {
    return bag.map((l) => { const p = byId(l.pid), z = p && p.sizes.find((s) => s.id === l.vid); return p && z ? { l, p, z } : null; }).filter(Boolean);
  }
  function renderBag() {
    const lines = bagLines(), n = lines.reduce((t, x) => t + x.l.qty, 0), sub = lines.reduce((t, x) => t + x.l.qty * x.p.price, 0);
    $('bagCount').hidden = !n; $('bagCount').textContent = n;
    $('bagbar').hidden = !n;
    $('bagbarBtn').textContent = 'View bag · ' + n + (n === 1 ? ' item' : ' items') + ' · ' + ksh(sub);
    if (bagModal) bagModal.render();
  }
  let bagModal = null;
  function openBag() {
    if (bagModal) return;
    const view = () => {
      const lines = bagLines(), sub = lines.reduce((t, x) => t + x.l.qty * x.p.price, 0);
      if (!lines.length) return '<div class="empty">Your bag is empty.</div>';
      return lines.map(({ l, p, z }) => {
        const bad = z.qty < l.qty;
        return '<div class="line"><div class="line-img">' + (p.photos[0] ? '<img src="' + esc(p.photos[0]) + '" alt="">' : icon('shoe')) + '</div><div class="line-main"><div class="line-name">' + esc(p.name) + '</div>' +
          '<div class="line-sub">Size ' + esc(z.size) + (p.colour ? ' · ' + esc(p.colour) : '') + ' · ' + ksh(p.price) + '</div>' +
          (z.qty < 1 ? '<div class="line-warn">Sold out. Please remove.</div>' : bad ? '<div class="line-warn">Only ' + z.qty + ' left</div>' : '') +
          '<div class="stepper"><button type="button" data-d="-1" data-k="' + esc(l.pid + '|' + l.vid) + '" aria-label="One less">' + icon('minus') + '</button><b>' + l.qty + '</b><button type="button" data-d="1" data-k="' + esc(l.pid + '|' + l.vid) + '" aria-label="One more">' + icon('plus') + '</button></div></div>' +
          '<div><b>' + ksh(p.price * l.qty) + '</b></div></div>';
      }).join('') + '<div class="sum total"><span>Subtotal</span><span>' + ksh(sub) + '</span></div><p class="hint">Delivery fee is added at checkout.</p>';
    };
    const ok = () => { const lines = bagLines(); return lines.length && lines.every((x) => x.z.qty >= x.l.qty) && S.settings.acceptingOrders; };
    bagModal = modal({
      title: 'Your bag', variant: 'sheet', html: view(),
      actions: [{ label: 'Keep shopping', kind: 'ghost' }, { label: 'Checkout', kind: 'primary', onClick: () => { if (!ok()) { toast(S.settings.acceptingOrders ? 'Fix the items marked in red first' : S.settings.closedMessage); return false; } setTimeout(openCheckout, 230); } }],
      onClose: () => { bagModal = null; },
      onMount: (m) => m.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-d]'); if (!b) return;
        const [pid, vid] = b.dataset.k.split('|'), i = bag.findIndex((l) => l.pid === pid && l.vid === vid), d = Number(b.dataset.d);
        if (i < 0) return;
        const z = (byId(pid) || { sizes: [] }).sizes.find((s) => s.id === vid);
        if (d > 0 && z && bag[i].qty + 1 > z.qty) return toast('Only ' + z.qty + ' in stock');
        bag[i].qty += d; if (bag[i].qty < 1) bag.splice(i, 1);
        saveBag();
      }),
    });
    bagModal.render = () => { if (!bagLines().length) { bagModal.close(); return; } bagModal.setBody(view()); };
  }

  /* ---------- checkout ---------- */
  function openCheckout() {
    const s = S.settings, saved = store.get('sh_me', {});
    const lines = bagLines(); if (!lines.length) return;
    const sub = lines.reduce((t, x) => t + x.l.qty * x.p.price, 0);
    const methods = [s.deliveryEnabled && 'delivery', s.pickupEnabled && 'pickup'].filter(Boolean);
    const pays = [s.payMpesa && 'mpesa', s.payCod && 'cod'].filter(Boolean);
    if (!methods.length || !pays.length) { toast('Ordering is not set up yet. Please contact the shop.'); return; }
    const st = { method: methods[0], zone: s.zones[0] ? s.zones[0].id : '', pay: pays[0] };
    const clientRef = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const fee = () => (st.method === 'delivery' ? ((s.zones.find((z) => z.id === st.zone) || {}).fee || 0) : 0);
    const totals = () => '<div class="sum"><span>Items</span><span>' + ksh(sub) + '</span></div><div class="sum"><span>Delivery</span><span>' + (st.method === 'delivery' ? ksh(fee()) : 'Free (pickup)') + '</span></div><div class="sum total"><span>Total</span><span>' + ksh(sub + fee()) + '</span></div>';
    const html = '<div class="field"><div class="field-label">How do you want it?</div>' + methods.map((mth) => '<label class="opt" data-grp="method"><input type="radio" name="method" value="' + mth + '"' + (mth === st.method ? ' checked' : '') + '><div><b>' + (mth === 'delivery' ? 'Delivery in Nairobi' : 'Pick up from the shop') + '</b><span>' + (mth === 'pickup' ? esc(s.pickupAddress || 'We will confirm the pickup address') : 'We bring it to you') + '</span></div></label>').join('') + '</div>' +
      '<div id="delivBox"><div class="field"><label for="zone">Delivery area</label><select class="text-input" id="zone">' + s.zones.map((z) => '<option value="' + esc(z.id) + '">' + esc(z.name) + ' · ' + ksh(z.fee) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="addr">Where should we deliver?</label><textarea class="text-area u-mh64" id="addr" maxlength="160" placeholder="Building, street, landmark">' + esc(saved.address || '') + '</textarea></div></div>' +
      '<div class="field"><label for="nm">Your name</label><input class="text-input" id="nm" maxlength="40" autocomplete="name" value="' + esc(saved.name || '') + '"></div>' +
      '<div class="field"><label for="ph">Phone number</label><input class="text-input" id="ph" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX" value="' + esc(saved.phone || '') + '"></div>' +
      '<div class="field"><label for="nt">Note for the shop (optional)</label><input class="text-input" id="nt" maxlength="200"></div>' +
      '<div class="field"><div class="field-label">How will you pay?</div>' + pays.map((p) => '<label class="opt" data-grp="pay"><input type="radio" name="pay" value="' + p + '"' + (p === st.pay ? ' checked' : '') + '><div><b>' + (p === 'mpesa' ? 'M-Pesa' : 'Cash on delivery / pickup') + '</b><span>' + (p === 'mpesa' ? 'You get payment steps after you order' : 'Pay when you receive it') + '</span></div></label>').join('') + '</div>' +
      '<div id="tot">' + totals() + '</div><div class="form-error" id="coErr" hidden></div>';
    const m = modal({
      title: 'Checkout', variant: 'sheet', html,
      actions: [{ label: 'Back', kind: 'ghost', onClick: () => { setTimeout(openBag, 230); } }, { label: 'Place order', kind: 'primary', onClick: async (mm) => {
        const v = (id) => mm.q('#' + id).value.trim();
        const body = { clientRef, method: st.method, zone: st.zone, name: v('nm'), phone: v('ph'), address: st.method === 'delivery' ? v('addr') : '', note: v('nt'), payMethod: st.pay, items: bag.map((l) => ({ pid: l.pid, vid: l.vid, qty: l.qty })) };
        if (body.name.length < 2) { mm.error('Please enter your name.'); mm.q('#nm').focus(); return false; }
        if (body.phone.replace(/\D/g, '').length < 9) { mm.error('Please enter a valid phone number.'); mm.q('#ph').focus(); return false; }
        if (st.method === 'delivery' && body.address.length < 3) { mm.error('Please add where we should deliver.'); mm.q('#addr').focus(); return false; }
        mm.error('');
        try {
          const r = await api('POST', '/api/orders', body, { timeout: 25000 });
          store.set('sh_me', { name: body.name, phone: body.phone, address: body.address });
          myOrder = { id: r.id, key: r.key }; store.set('sh_order', myOrder);
          bag = []; saveBag(); $('btnOrder').hidden = false;
          setTimeout(() => openOrder(r.order, true), 230);
        } catch (e) {
          if (e.code === 'stock' || e.code === 'item_gone') { await load(); mm.error('Some items just sold out. We updated your bag. Please check it and try again.'); setTimeout(() => { m.close(); openBag(); }, 1800); return false; }
          mm.error(e.message); return false;
        }
      } }],
      onMount: (mm) => {
        const upd = () => { mm.q('#delivBox').hidden = st.method !== 'delivery'; mm.q('#tot').innerHTML = totals(); $$('.opt', mm.body).forEach((o) => o.classList.toggle('on', o.querySelector('input').checked)); };
        mm.body.addEventListener('change', (e) => { const t = e.target; if (t.name === 'method') st.method = t.value; else if (t.name === 'pay') st.pay = t.value; else if (t.id === 'zone') st.zone = t.value; upd(); });
        upd();
      },
    });
  }

  /* ---------- my order ---------- */
  const FLOW = [['placed', 'Order received'], ['confirmed', 'Confirmed by the shop'], ['packed', 'Packed'], ['dispatched', 'On the way'], ['delivered', 'Delivered']];
  let orderModal = null, lastOrder = null;
  function orderHtml(o) {
    const s = S.settings || {};
    const cancelled = o.status === 'cancelled';
    const idx = FLOW.findIndex((f) => f[0] === o.status);
    const pickup = o.method === 'pickup';
    const steps = cancelled ? '<p><span class="status-chip bad">Cancelled</span></p>' : '<ul class="steps">' + FLOW.map((f, i) => '<li class="' + (i < idx || o.status === 'delivered' ? 'done' : i === idx ? 'cur' : '') + '"><i>' + (i < idx || o.status === 'delivered' ? icon('check') : '') + '</i>' + (pickup && f[0] === 'dispatched' ? 'Ready for pickup' : pickup && f[0] === 'delivered' ? 'Picked up' : f[1]) + '</li>').join('') + '</ul>';
    let pay = '';
    if (o.payMethod === 'mpesa' && !o.paid && !cancelled) {
      const mode = s.mpesaMode, name = s.mpesaName ? ' (' + esc(s.mpesaName) + ')' : '';
      const how = mode === 'till' ? 'Open M-Pesa → Lipa na M-Pesa → Buy Goods and Services.<br>Till number: <span class="big">' + esc(s.mpesaNumber) + '</span>'
        : mode === 'paybill' ? 'Open M-Pesa → Lipa na M-Pesa → Pay Bill.<br>Business no: <span class="big">' + esc(s.mpesaNumber) + '</span><br>Account no: <b>' + o.no + '</b>'
          : 'Open M-Pesa → Send Money.<br>Number: <span class="big">' + esc(s.mpesaNumber) + '</span>' + name;
      pay = '<div class="pay-box"><b>Pay ' + ksh(o.total) + ' with M-Pesa</b><br>' + how + '<br>Amount: <b>' + ksh(o.total) + '</b>' + (s.mpesaNumber ? '<br><button class="btn btn-ghost btn-sm u-mt8" data-o="copy" type="button">' + icon('copy') + ' Copy number</button>' : '') + '</div>' +
        (o.payClaimed ? '<p><span class="status-chip warn">Code ' + esc(o.mpesaCode) + ' sent. The shop is checking it.</span></p>' :
          '<div class="field"><label for="code">After paying, enter the M-Pesa code from the SMS</label><input class="text-input" id="code" maxlength="14" autocapitalize="characters" placeholder="e.g. SK12AB34CD"></div><button class="btn btn-primary block" data-o="code" type="button">I have paid</button><div class="form-error" id="oErr" hidden></div>' +
          (s.holdMinutes ? '<p class="hint">We hold your pair for ' + Math.round(s.holdMinutes / 60 * 10) / 10 + ' hours. Orders with no payment code after that are released.</p>' : ''));
    } else if (o.paid) pay = '<p><span class="status-chip good">Paid</span></p>';
    else if (o.payMethod === 'cod' && !cancelled) pay = '<p><span class="status-chip">Pay ' + ksh(o.total) + ' when you ' + (pickup ? 'pick up' : 'receive it') + '</span></p>';
    return '<p class="ord-meta">Order #' + o.no + ' · ' + fmtTime(o.createdAt) + ' · ' + (pickup ? 'Pickup' : 'Delivery to ' + esc(o.zone)) + '</p>' + steps + pay +
      '<div class="u-mt10">' + o.items.map((l) => '<div class="sum"><span>' + l.qty + '× ' + esc(l.name) + (l.size ? ' (' + esc(l.size) + ')' : '') + '</span><span>' + ksh(l.qty * l.price) + '</span></div>').join('') +
      (o.deliveryFee ? '<div class="sum"><span>Delivery</span><span>' + ksh(o.deliveryFee) + '</span></div>' : '') + '<div class="sum total"><span>Total</span><span>' + ksh(o.total) + '</span></div></div>' +
      '<div class="ord-actions">' + (s.whatsapp ? '<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="' + waLink(s.whatsapp, 'Hi, about my order #' + o.no) + '">' + icon('wa', 'wa') + ' Message the shop</a>' : '') +
      (o.status === 'placed' ? '<button class="btn btn-ghost btn-sm" data-o="cancel" type="button">Cancel order</button>' : '') + '</div>' +
      (o.status === 'confirmed' || o.status === 'packed' ? '<p class="hint">To change or cancel now, please message the shop.</p>' : '');
  }
  async function openOrder(o0, fresh) {
    if (!myOrder) return;
    if (orderModal) return;
    lastOrder = o0 || lastOrder;
    orderModal = modal({
      title: fresh ? 'Thank you! Order placed' : 'Your order', variant: 'sheet', html: lastOrder ? orderHtml(lastOrder) : '<p class="hint">Loading…</p>',
      actions: [{ label: 'Close', kind: 'ghost' }],
      onClose: () => { orderModal = null; if (orderLive) { orderLive.close(); orderLive = null; } },
      onMount: (m) => {
        const draw = (o) => { lastOrder = o; const keep = m.q('#code') ? m.q('#code').value : ''; m.setBody(orderHtml(o)); if (keep && m.q('#code')) m.q('#code').value = keep; };
        orderLive = live(() => '/api/live?order=' + encodeURIComponent(myOrder.id) + '&k=' + encodeURIComponent(myOrder.key), { order: draw });
        api('GET', '/api/orders/' + myOrder.id + '?k=' + encodeURIComponent(myOrder.key)).then((r) => draw(r.order)).catch((e) => { if (e.status === 404) { store.del('sh_order'); myOrder = null; $('btnOrder').hidden = true; m.close(); } });
        m.body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-o]'); if (!b) return;
          const k = b.dataset.o, base = '/api/orders/' + myOrder.id;
          try {
            if (k === 'copy') toast((await copyText(String(S.settings.mpesaNumber))) ? 'Number copied' : 'Could not copy');
            else if (k === 'code') { const r = await api('POST', base + '/mpesa', { k: myOrder.key, code: m.q('#code').value }); draw(r.order); toast('Thanks! The shop will confirm your payment.'); }
            else if (k === 'cancel') { if (await confirmBox({ title: 'Cancel this order?', text: 'The shoes go back on sale.', ok: 'Yes, cancel', cancel: 'Keep it', danger: true })) { const r = await api('POST', base + '/cancel', { k: myOrder.key }); draw(r.order); } }
          } catch (x) { const er = m.q('#oErr'); if (er) { er.textContent = x.message; er.hidden = false; } else toast(x.message); }
        });
      },
    });
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]'); if (c) { F.cat = c.dataset.cat; paint(); return; }
    const g = e.target.closest('[data-gender]'); if (g) { F.gender = g.dataset.gender; paint(); return; }
    const a = e.target.closest('a[data-open]'); if (a && !(e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); openProduct(a.dataset.open); }
  });
  $('btnBag').onclick = openBag; $('bagbarBtn').onclick = openBag; $('btnOrder').onclick = () => openOrder();
  $('btnSearch').onclick = () => { const w = $('searchWrap'); w.hidden = !w.hidden; if (!w.hidden) $('q').focus(); else { F.q = ''; $('q').value = ''; renderGrid(); } };
  $('q').oninput = () => { F.q = $('q').value; renderGrid(); };
  $('sizeSel').onchange = () => { F.size = $('sizeSel').value; renderGrid(); };
  $('sortSel').onchange = () => { F.sort = $('sortSel').value; renderGrid(); };

  // live shop changes: stock, new arrivals, settings
  let liveSeen = false;
  live('/api/live', {
    product(p) { const i = S.products.findIndex((x) => x.id === p.id); if (i >= 0) S.products[i] = p; else S.products.push(p); reconcileBag(); paint(); if (pv && pv.p && pv.p.id === p.id) pv.rerender(); },
    'product-removed'(d) { S.products = S.products.filter((x) => x.id !== d.id); reconcileBag(); paint(); if (pv && pv.p && pv.p.id === d.id) pv.rerender(); },
    settings(d) { S.settings = d.settings; S.categories = d.categories; paint(); },
    reset() { load(); },
    open() { if (liveSeen) load(); liveSeen = true; },
  });
  window.SH.registerSW();
  load();
})();
