/**
 * Marketer sales: Catalog (filters like کاتالوگ) → Cart (pack_size qty) → checkout → Invoice
 * Version marker: marketer-ui-v209 — keep in sync with SW / script ?v=
 *
 * Checkout writes window.__pendingMarketerInvMeta = { type, vatExempt } before
 * openInvBuilder(). app.js should read it when seeding a new invoice (#inv-type,
 * #inv-vat-exempt). Until that hook exists we apply after openInvBuilder via rAF/timeout.
 */
(function (global) {
  'use strict';

  let cart = [];
  let mkFilter = { search: '', category: '', stock_status: 'all' };
  let mkTimer = null;
  let mkCheckout = { type: 'normal' };
  let mkCartError = '';

  function loadCart() {
    try { cart = JSON.parse(localStorage.getItem('marketer_cart') || '[]') || []; }
    catch { cart = []; }
    if (!Array.isArray(cart)) cart = [];
    cart.forEach(function (c) {
      if (c.disc == null) c.disc = 0;
      if (c.disc_amount == null) c.disc_amount = 0;
    });
  }
  function saveCart() {
    localStorage.setItem('marketer_cart', JSON.stringify(cart));
    const badge = document.getElementById('mkCartBadge');
    if (badge) badge.textContent = String(cart.reduce((a, c) => a + (Number(c.qty) || 0), 0));
  }

  function packQty(p) {
    return Math.max(1, parseInt(p && p.pack_size, 10) || 1);
  }

  function me() {
    return global.ME || (typeof window !== 'undefined' ? window.ME : null) || null;
  }

  function canInvoice() {
    if (typeof canCreateInvoice === 'function') return canCreateInvoice();
    const u = me();
    return !!(u && (u.role === 'admin' || u.role === 'accounting'));
  }

  function lineSum(c) {
    const qty = Number(c.qty) || 0;
    const price = Number(c.price) || 0;
    const discPct = Number(c.disc) || 0;
    const discAmt = Number(c.disc_amount) || 0;
    return Math.round(price * qty * (1 - discPct / 100) - discAmt);
  }

  function cartTotal() {
    return cart.reduce((a, c) => a + lineSum(c), 0);
  }

  function lineDiscLabel(c) {
    const amt = Number(c.disc_amount) || 0;
    const pct = Number(c.disc) || 0;
    if (amt > 0) return fmt(amt) + ' ریال';
    return fmt(pct) + '٪';
  }

  function salesWarehouseId() {
    const u = me();
    return (u && u.sales_warehouse_id) ? u.sales_warehouse_id : null;
  }

  function warehouseNameFromCache(id) {
    if (!id) return '';
    const u = me();
    if (u && u.sales_warehouse_name) return String(u.sales_warehouse_name);
    const rows = (typeof CACHE !== 'undefined' && CACHE && (CACHE.warehouses || CACHE._prodWarehouses)) || [];
    const hit = rows.find(function (w) { return Number(w.id) === Number(id); });
    return (hit && hit.name) ? hit.name : '';
  }

  async function resolveSalesWarehouseName() {
    const id = salesWarehouseId();
    if (!id) return '';
    const cached = warehouseNameFromCache(id);
    if (cached) return cached;
    try {
      const list = await api('GET', '/warehouses') || [];
      if (typeof CACHE !== 'undefined' && CACHE) CACHE.warehouses = list;
      const w = (list || []).find(function (x) { return Number(x.id) === Number(id); });
      return w && w.name ? w.name : '';
    } catch (_) {
      return '';
    }
  }

  function warehouseBannerHtml(name) {
    const id = salesWarehouseId();
    if (!id) return '';
    const label = name || warehouseNameFromCache(id) || ('کد ' + id);
    return `<div class="mk-wh-banner" role="status">🏭 انبار فروش: <b>${esc(label)}</b></div>`;
  }

  function skuLabel(c) {
    const label = [c.color_name || c.color, c.size_name].filter(Boolean).join(' / ');
    return label ? label : '';
  }

  function cartToInvoiceRows() {
    const defWh = salesWarehouseId();
    return cart.map(c => ({
      product_id: c.product_id,
      name: c.name,
      qty: Number(c.qty) || 1,
      price: c.price,
      disc: Number(c.disc) || 0,
      disc_amount: Number(c.disc_amount) || 0,
      description: '',
      warehouse_id: defWh,
      row_type: 'product',
      income_coa: '',
      variant_id: c.variant_id || null,
      color_id: c.color_id || null,
      size_id: c.size_id || null,
      color: c.color || c.color_name || '',
      color_name: c.color_name || c.color || '',
      size_name: c.size_name || '',
      sku_stock: c.sku_stock != null ? Number(c.sku_stock) : null
    }));
  }

  function readCheckoutType() {
    const radio = document.querySelector('input[name="mk-inv-type"]:checked');
    const sel = document.getElementById('mk-inv-type');
    const raw = (radio && radio.value) || (sel && sel.value) || mkCheckout.type;
    if (raw === 'proforma' || raw === 'normal' || raw === 'final') return raw;
    return 'normal';
  }

  function defaultVatExemptForType(type) {
    return type !== 'final';
  }

  /**
   * Apply type / VAT defaults on #inv-type and #inv-vat-exempt after the builder
   * HTML exists. app.js should instead consume window.__pendingMarketerInvMeta
   * while rendering (checkbox or hidden input).
   */
  function applyMarketerInvDefaults(meta, tries) {
    tries = tries || 0;
    const typeEl = document.getElementById('inv-type');
    const vatEl = document.getElementById('inv-vat-exempt');
    if (!typeEl) {
      if (tries < 30) {
        const next = function () { applyMarketerInvDefaults(meta, tries + 1); };
        if (tries === 0 && typeof requestAnimationFrame === 'function') requestAnimationFrame(next);
        else setTimeout(next, 40);
      }
      return;
    }
    typeEl.value = meta.type;
    if (vatEl) {
      if (vatEl.type === 'checkbox') vatEl.checked = !!meta.vatExempt;
      else vatEl.value = meta.vatExempt ? '1' : '';
    }
  }

  /** Seed invoice builder then open — survives async wipe in _openInvBuilder. */
  function openInvoiceWithCart() {
    loadCart();
    if (!cart.length) {
      showToast('سبد خالی است', 'error');
      return;
    }
    if (!canInvoice()) {
      showToast('دسترسی ایجاد فاکتور ندارید', 'error');
      return;
    }
    const type = readCheckoutType();
    const vatExempt = defaultVatExemptForType(type);
    mkCheckout.type = type;
    const rows = cartToInvoiceRows();
    window.__pendingMarketerInvRows = rows;
    window.__invCartFromMarketer = true;
    // app.js should read this when opening a new invoice (type + vatExempt).
    window.__pendingMarketerInvMeta = { type: type, vatExempt: vatExempt };
    if (typeof invCart !== 'undefined') invCart = rows.slice();
    if (typeof openInvBuilder === 'function') {
      openInvBuilder();
      applyMarketerInvDefaults({ type: type, vatExempt: vatExempt });
    } else {
      showToast('فاکتورساز در دسترس نیست', 'error');
    }
  }

  function setToolbarActive(i) {
    [el('mkTabCat'), el('mkTabCart'), el('mkTabInv')].forEach(function (b, idx) {
      if (!b) return;
      b.classList.toggle('ghost', idx !== i);
    });
  }

  function goCatalog() {
    setToolbarActive(0);
    renderCatalog();
  }

  async function renderMarketerPage() {
    loadCart();
    const view = el('view');
    const invOk = canInvoice();
    view.innerHTML = `
      <div class="toolbar" data-csp-style="${CSP.style(`gap:8px;flex-wrap:wrap`)}">
        <button class="btn" id="mkTabCat">🛍️ کاتالوگ</button>
        <button class="btn ghost" id="mkTabCart">🛒 سبد <span id="mkCartBadge" class="tag t-new">${cart.reduce((a,c)=>a+(Number(c.qty)||0),0)}</span></button>
        <button class="btn ghost" id="mkTabInv" ${invOk ? '' : 'disabled title="دسترسی ایجاد فاکتور ندارید"'}>🧾 ثبت فاکتور</button>
      </div>
      <div id="mkBody"></div>`;
    el('mkTabCat').onclick = function () { setToolbarActive(0); renderCatalog(); };
    el('mkTabCart').onclick = function () { setToolbarActive(1); renderCart(); };
    el('mkTabInv').onclick = function () {
      if (!canInvoice()) { showToast('دسترسی ایجاد فاکتور ندارید — از مدیر بخواهید دسترسی «فاکتورها → ایجاد» را فعال کند', 'error'); return; }
      setToolbarActive(2); renderCheckout();
    };
    setToolbarActive(0);
    await renderCatalog();
  }

  async function loadMkProducts() {
    const qs = new URLSearchParams();
    if (mkFilter.category) qs.set('category', mkFilter.category);
    if (mkFilter.search) qs.set('search', mkFilter.search);
    if (mkFilter.stock_status && mkFilter.stock_status !== 'all') qs.set('stock_status', mkFilter.stock_status);
    return await api('GET', '/products?' + qs.toString()) || [];
  }

  function catalogEmptyHtml() {
    return `<div class="empty" role="status">کالایی یافت نشد — فیلتر را عوض کنید یا بعداً دوباره تلاش کنید</div>`;
  }

  function catalogErrorHtml(retryFn) {
    const retryBind = retryFn === 'refreshMkGrid'
      ? CSP.bind('click', function () { MarketerUI.refreshMkGrid(); })
      : CSP.bind('click', function () { MarketerUI.renderCatalog(); });
    return `<div class="empty mk-state-error" role="alert">
      خطا در بارگذاری کاتالوگ.
      <div data-csp-style="${CSP.style(`margin-top:10px`)}">
        <button class="btn" data-csp-click="${retryBind}">تلاش دوباره</button>
      </div>
    </div>`;
  }

  function paintMkGrid(list) {
    const grid = el('mkGrid');
    if (!grid) return;
    if (!list || !list.length) {
      grid.innerHTML = catalogEmptyHtml();
      return;
    }
    // Always show pack on button; prefer shared catalog card when available
    if (typeof productCardHtml === 'function') {
      grid.innerHTML = list.map(p => productCardHtml(p, {
        addToCartFn: 'MarketerUI.addToCart',
        showWarehouse: false,
        selectable: false
      })).join('');
      return;
    }
    grid.innerHTML = list.map(p => {
      const low = p.stock <= p.stock_alert;
      const pack = packQty(p);
      return `
        <div class="pcard">
          <div class="img">${p.image ? prodImgTag(p.image) : '🧥'}</div>
          <div class="body">
            <div class="name">${esc(p.name)}</div>
            <div class="code">${esc(p.code || '')} ${p.category ? '· ' + esc(p.category) : ''}</div>
            <div class="price">${fmt(p.price)} ریال</div>
            <div class="stock ${low ? 'low' : ''}">موجودی: ${fmt(p.stock)} ${esc(p.unit || '')}</div>
            <div data-csp-style="${CSP.style(`font-size:11px;color:var(--muted);margin-top:2px`)}">${(Number(p.colors)>1)?'🎨 '+fmt(p.colors)+' رنگ · ':''}📦 ${pack} عدد/پک</div>
            <button class="btn sm" data-csp-style="${CSP.style(`width:100%;margin-top:8px`)}" data-csp-click="${CSP.bind('click',function(event){MarketerUI.addToCart((p.id))})}">${(Number(p.colors)>1||Number(p.has_variants)===1||Number(p.is_style)===1)?'🎨 انتخاب رنگ':('➕ افزودن به سبد ('+pack+' عدد)')}</button>
          </div>
        </div>`;
    }).join('');
  }

  async function renderCatalog() {
    const body = el('mkBody');
    if (!body) return;
    body.innerHTML = '<div class="muted" aria-busy="true" role="status">در حال بارگذاری...</div>';
    let cats = [];
    const whName = await resolveSalesWarehouseName();
    try {
      cats = await api('GET', '/products/categories') || [];
    } catch (_) { cats = []; }
    if (!Array.isArray(cats)) cats = [];
    // Normalize: API may return strings or {name} objects
    cats = cats.map(c => (typeof c === 'string' ? c : (c && (c.name || c.category || ''))).trim()).filter(Boolean);
    let prods = [];
    try {
      prods = await loadMkProducts();
      if (!Array.isArray(prods)) prods = [];
    } catch (_) {
      body.innerHTML = warehouseBannerHtml(whName) + catalogErrorHtml('renderCatalog');
      return;
    }
    body.innerHTML = `
      ${warehouseBannerHtml(whName)}
      <div class="toolbar" data-csp-style="${CSP.style(`display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px`)}">
        <input class="search" id="mkSearch" placeholder="جستجو نام یا کد..." value="${esc(mkFilter.search)}" data-csp-style="${CSP.style(`flex:1;min-width:160px`)}">
        <select id="mkCat" data-csp-style="${CSP.style(`min-width:140px`)}"><option value="">همه گروه‌ها</option>
          ${cats.map(c => `<option value="${esc(c)}" ${mkFilter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select id="mkStock" data-csp-style="${CSP.style(`min-width:120px`)}">
          <option value="all" ${mkFilter.stock_status === 'all' ? 'selected' : ''}>همه موجودی</option>
          <option value="ok" ${mkFilter.stock_status === 'ok' ? 'selected' : ''}>موجود</option>
          <option value="low" ${mkFilter.stock_status === 'low' ? 'selected' : ''}>موجودی کم</option>
        </select>
      </div>
      <div class="pgrid" id="mkGrid"></div>`;
    window._mkProds = prods;
    paintMkGrid(prods);

    el('mkSearch').addEventListener('input', () => {
      mkFilter.search = el('mkSearch').value;
      clearTimeout(mkTimer);
      mkTimer = setTimeout(refreshMkGrid, 300);
    });
    el('mkCat').addEventListener('change', () => {
      mkFilter.category = el('mkCat').value;
      refreshMkGrid();
    });
    el('mkStock').addEventListener('change', () => {
      mkFilter.stock_status = el('mkStock').value;
      refreshMkGrid();
    });
  }

  async function refreshMkGrid() {
    const grid = el('mkGrid');
    if (!grid) return;
    grid.innerHTML = `<div class="muted" aria-busy="true" role="status" data-csp-style="${CSP.style(`padding:12px`)}">در حال بارگذاری...</div>`;
    try {
      const prods = await loadMkProducts();
      window._mkProds = Array.isArray(prods) ? prods : [];
      paintMkGrid(window._mkProds);
    } catch (_) {
      grid.innerHTML = catalogErrorHtml('refreshMkGrid');
    }
  }

  function mkTabActive(id) {
    const b = el(id);
    return !!(b && !b.classList.contains('ghost'));
  }

  function refreshVisibleMkView() {
    if (mkTabActive('mkTabInv')) {
      if (typeof renderCheckout === 'function') renderCheckout();
    } else if (mkTabActive('mkTabCart')) {
      renderCart();
    }
  }

  async function addToCart(productId) {
    loadCart();
    const p = (window._mkProds || []).find(x => Number(x.id) === Number(productId));
    if (!p) return;
    let style = null;
    try { style = await api('GET', '/product-variants/style/' + Number(p.id)); }
    catch (_) { style = null; }
    const pack = (typeof livePackFromStyle === 'function')
      ? livePackFromStyle(style)
      : { matrix: [], live: [], pack: packQty(p) };
    if (pack.matrix && pack.matrix.length) {
      if (typeof openInvVariantSplitModal !== 'function') {
        showToast('پنجره انتخاب رنگ در دسترس نیست', 'error');
        return;
      }
      openInvVariantSplitModal(p, pack, { dest: 'marketer' });
      return;
    }
    const stock = Number(p.stock) || 0;
    const qty = packQty(p);
    const row = cart.find(c => Number(c.product_id) === Number(productId) && !c.variant_id);
    const already = row ? (Number(row.qty) || 0) : 0;
    if (stock <= 0) {
      showToast('کسر موجودی: «' + (p.name || '') + '» موجودی ندارد و به سبد اضافه نمی‌شود', 'error');
      return;
    }
    if (already + qty > stock) {
      showToast(
        'کسر موجودی: برای «' + (p.name || '') + '» فقط ' + fmt(stock) + ' عدد موجود است'
          + (already ? ' (در سبد: ' + fmt(already) + ')' : ''),
        'error'
      );
      return;
    }
    if (row) row.qty = already + qty;
    else cart.push({
      product_id: p.id,
      name: p.name,
      price: p.price,
      qty,
      pack_size: qty,
      disc: 0,
      disc_amount: 0,
      image: p.image || ''
    });
    saveCart();
    showToast(qty > 1
      ? `${p.name} — ${fmt(qty)} عدد (یک پک) به سبد اضافه شد`
      : (p.name + ' به سبد اضافه شد'));
    refreshVisibleMkView();
  }

  function addVariantLines(p, lines, opts) {
    loadCart();
    opts = opts || {};
    if (Array.isArray(opts.replaceIndices) && opts.replaceIndices.length) {
      opts.replaceIndices.slice().sort(function (a, b) { return b - a; }).forEach(function (i) {
        if (i >= 0 && i < cart.length) cart.splice(i, 1);
      });
    }
    let added = 0;
    (lines || []).forEach(function (line) {
      const qty = Number(line.qty) || 0;
      if (!qty) return;
      const vid = Number(line.variant_id) || 0;
      const skuStock = line.sku_stock != null ? Number(line.sku_stock) : null;
      const row = cart.find(function (c) {
        return Number(c.product_id) === Number(p.id) && Number(c.variant_id || 0) === vid;
      });
      const already = row ? (Number(row.qty) || 0) : 0;
      if (skuStock != null && skuStock >= 0 && already + qty > skuStock) {
        showToast(
          'موجودی «' + (line.color_name || '') + ' ' + (line.size_name || '') + '» کافی نیست (موجود: ' + fmt(skuStock) + ')',
          'error'
        );
        return;
      }
      if (row) row.qty = already + qty;
      else cart.push({
        product_id: p.id,
        name: p.name,
        price: p.price,
        qty: qty,
        pack_size: 1,
        disc: 0,
        disc_amount: 0,
        image: p.image || '',
        variant_id: vid || null,
        color_id: line.color_id || null,
        size_id: line.size_id || null,
        color: line.color_name || line.color || '',
        color_name: line.color_name || line.color || '',
        size_name: line.size_name || '',
        sku_stock: skuStock
      });
      added += 1;
    });
    if (!added) return;
    saveCart();
    showToast('رنگ‌های انتخاب‌شده به سبد اضافه شد');
    refreshVisibleMkView();
  }

  async function editCartProduct(productId) {
    loadCart();
    const p = (window._mkProds || []).find(function (x) { return Number(x.id) === Number(productId); })
      || { id: productId, name: (cart.find(function (c) { return Number(c.product_id) === Number(productId); }) || {}).name };
    const existing = [];
    const replaceIndices = [];
    cart.forEach(function (c, i) {
      if (Number(c.product_id) === Number(productId)) {
        existing.push(c);
        replaceIndices.push(i);
      }
    });
    let style = null;
    try { style = await api('GET', '/product-variants/style/' + Number(p.id)); }
    catch (_) { style = null; }
    const pack = (typeof livePackFromStyle === 'function')
      ? livePackFromStyle(style)
      : { matrix: [], live: [], pack: 1 };
    if (!(pack.matrix && pack.matrix.length) && !(pack.pool && pack.pool.length)) {
      showToast('ماتریس رنگ/سایز برای این کالا نیست', 'error');
      return;
    }
    if (typeof openInvVariantSplitModal !== 'function') {
      showToast('پنجره انتخاب رنگ در دسترس نیست', 'error');
      return;
    }
    openInvVariantSplitModal(p, pack, { dest: 'marketer', existing: existing, replaceIndices: replaceIndices });
  }

  function cartEmptyHtml() {
    return `<div class="empty" role="status">
      <p>سبد خالی است — از کاتالوگ کالا اضافه کنید</p>
      <div data-csp-style="${CSP.style(`margin-top:12px`)}">
        <button class="btn" data-csp-click="${CSP.bind('click',function(){MarketerUI.goCatalog()})}">🛍️ رفتن به کاتالوگ</button>
      </div>
    </div>`;
  }

  function renderCart() {
    loadCart();
    const body = el('mkBody');
    if (!body) return;
    if (!cart.length) {
      mkCartError = '';
      body.innerHTML = cartEmptyHtml();
      return;
    }
    const total = cartTotal();
    const err = mkCartError
      ? `<div class="rep-form-error" role="alert" aria-live="polite">${esc(mkCartError)}</div>`
      : '';
    body.innerHTML = `
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>کالا</th><th>فی</th><th>تعداد</th><th>تخفیف ردیف</th><th>جمع</th><th></th></tr></thead>
      <tbody>${cart.map((c, i) => `
        <tr>
          <td>${c.image ? prodImgTag(c.image, `data-csp-style="${CSP.style('height:40px;border-radius:6px;margin-left:8px;vertical-align:middle')}"`) : ''} ${esc(c.name)}${skuLabel(c)?`<div class="mk-sku-line">🎨 ${esc(skuLabel(c))}</div>`:''}${c.pack_size > 1 && !c.variant_id ? `<div class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">📦 پک ${fmt(c.pack_size)}</div>` : ''}</td>
          <td class="mono">${fmt(c.price)} ریال</td>
          <td><input type="number" min="1" step="1" inputmode="numeric" value="${c.qty}" data-csp-style="${CSP.style(`width:70px;min-height:44px`)}" data-csp-change="${CSP.bind('change',function(event){MarketerUI.setQty((i),+this.value)})}"></td>
          <td class="muted" title="تخفیف ردیف برای فروش فقط نمایشی است">${esc(lineDiscLabel(c))}</td>
          <td class="mono">${fmt(lineSum(c))} ریال</td>
          <td data-csp-style="${CSP.style(`white-space:nowrap`)}">${c.variant_id?`<button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){MarketerUI.editCartProduct((c.product_id))})}">🎨 تغییر رنگ</button>`:''}<button class="btn sm red" data-csp-click="${CSP.bind('click',function(event){MarketerUI.remove((i))})}">🗑️</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">جمع سبد</td><td class="mono" data-csp-style="${CSP.style(`font-weight:800`)}">${fmt(total)} ریال</td><td></td></tr></tfoot>
      </table></div>
      ${err}
      <div class="mk-running-total" role="status">جمع سبد: <b>${fmt(total)}</b> ریال</div>
      <div data-csp-style="${CSP.style(`margin-top:12px;display:flex;gap:8px;flex-wrap:wrap`)}">
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){document.getElementById('mkTabInv').click()})}">ادامه → ثبت فاکتور</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(){MarketerUI.goCatalog()})}">بازگشت به کاتالوگ</button>
      </div>`;
  }

  function setQty(i, q) {
    loadCart();
    if (!cart[i]) return;
    mkCartError = '';
    if (!Number.isFinite(q) || q < 1) {
      mkCartError = 'تعداد باید عدد صحیح و حداقل ۱ باشد.';
      showToast(mkCartError, 'error');
      renderCart();
      return;
    }
    const want = Math.max(1, Math.floor(q));
    const line = cart[i];
    const skuCap = line.variant_id && line.sku_stock != null ? Number(line.sku_stock) : null;
    const p = (window._mkProds || []).find(x => Number(x.id) === Number(line.product_id));
    const stock = skuCap != null ? skuCap : (p != null ? (Number(p.stock) || 0) : null);
    if (stock != null && want > stock) {
      mkCartError = 'کسر موجودی: برای «' + (line.name || '') + (skuLabel(line) ? ' / ' + skuLabel(line) : '') + '» فقط ' + fmt(stock) + ' عدد موجود است';
      showToast(mkCartError, 'error');
      cart[i].qty = Math.max(1, Math.min(want, Math.max(1, stock)));
      if (stock <= 0) {
        cart.splice(i, 1);
        saveCart();
        renderCart();
        return;
      }
    } else {
      cart[i].qty = want;
    }
    saveCart();
    renderCart();
  }
  function remove(i) {
    loadCart();
    cart.splice(i, 1);
    mkCartError = '';
    saveCart();
    renderCart();
  }

  function vatNoteForType(type) {
    if (type === 'final') {
      return 'فاکتور رسمی پیش‌فرض مشمول مالیات است. معمولی و پیش‌فاکتور پیش‌فرض معاف‌اند — تأیید نهایی را در فرم فاکتور بزنید.';
    }
    return 'معمولی و پیش‌فاکتور پیش‌فرض معاف از مالیات‌اند؛ رسمی مشمول است — تأیید نهایی در فرم فاکتور.';
  }

  function bindCheckoutTypeInputs() {
    const radios = document.querySelectorAll('input[name="mk-inv-type"]');
    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        mkCheckout.type = r.value;
        const note = el('mkVatNote');
        if (note) note.textContent = vatNoteForType(r.value);
      });
    });
    const sel = el('mk-inv-type');
    if (sel) {
      sel.addEventListener('change', function () {
        mkCheckout.type = sel.value;
        const note = el('mkVatNote');
        if (note) note.textContent = vatNoteForType(sel.value);
      });
    }
  }

  async function renderCheckout() {
    loadCart();
    const body = el('mkBody');
    if (!body) return;
    if (!cart.length) {
      body.innerHTML = cartEmptyHtml();
      return;
    }
    if (!canInvoice()) {
      body.innerHTML = '<div class="empty">دسترسی ایجاد فاکتور ندارید. از مدیر بخواهید در «کاربران → دسترسی‌ها» برای فاکتورها تیک <b>ایجاد</b> را بزند.</div>';
      return;
    }
    const type = mkCheckout.type === 'proforma' || mkCheckout.type === 'final' ? mkCheckout.type : 'normal';
    const total = cartTotal();
    const whName = await resolveSalesWarehouseName();
    body.innerHTML = `
      <div class="panel mk-checkout">
        <div class="panel-body">
          ${warehouseBannerHtml(whName)}
          <p class="muted">اقلام سبد (${cart.length} ردیف، با تعداد پک) آماده انتقال به فاکتورساز هستند.</p>
          <div class="mk-running-total" role="status">جمع سبد: <b>${fmt(total)}</b> ریال</div>
          <ul class="muted" data-csp-style="${CSP.style(`font-size:13px;margin:8px 0 14px;padding-right:18px;line-height:1.8`)}">
            ${cart.slice(0, 8).map(c => `<li>${esc(c.name)}${skuLabel(c) ? ' — ' + esc(skuLabel(c)) : ''} × ${fmt(c.qty)}</li>`).join('')}
            ${cart.length > 8 ? `<li>… و ${cart.length - 8} مورد دیگر</li>` : ''}
          </ul>

          <div class="rep-form-section">
            <div class="fg">
              <label>مشتری</label>
              <p class="inv-amend-hint">جستجو و انتخاب مشتری در <b>فاکتورساز</b> انجام می‌شود — اینجا فقط یادآوری است، نه انتخاب‌گر.</p>
            </div>
          </div>

          <div class="rep-form-section">
            <fieldset>
              <legend>نوع فاکتور</legend>
              <div class="mk-inv-types">
                <label><input type="radio" name="mk-inv-type" value="proforma" ${type === 'proforma' ? 'checked' : ''}> پیش‌فاکتور</label>
                <label><input type="radio" name="mk-inv-type" value="normal" ${type === 'normal' ? 'checked' : ''}> معمولی</label>
                <label><input type="radio" name="mk-inv-type" value="final" ${type === 'final' ? 'checked' : ''}> رسمی</label>
              </div>
              <p class="inv-amend-hint">پیش‌فاکتور: اعلام قیمت بدون اثر موجودی/حسابداری. معمولی: فروش قطعی بدون صف مودیان. رسمی: فروش قطعی + مودیان در صورت فعال بودن.</p>
            </fieldset>
            <p class="inv-amend-hint" id="mkVatNote">${esc(vatNoteForType(type))}</p>
          </div>

          <div class="rep-form-section">
            <p class="inv-amend-hint">نقد/نسیه/چک/کارت را در فاکتورساز کامل کنید.</p>
          </div>

          <button class="btn" data-csp-click="${CSP.bind('click',function(event){MarketerUI.openInvoiceWithCart()})}">🧾 باز کردن فاکتورساز با اقلام سبد</button>
          <button class="btn ghost" data-csp-style="${CSP.style(`margin-right:8px`)}" data-csp-click="${CSP.bind('click',function(event){MarketerUI.clearAfterInvoice()})}">پاک کردن سبد پس از ثبت</button>
        </div>
      </div>`;
    bindCheckoutTypeInputs();
  }

  function clearAfterInvoice() {
    cart = [];
    saveCart();
    mkCartError = '';
    window.__pendingMarketerInvRows = null;
    window.__pendingMarketerInvMeta = null;
    window.__invCartFromMarketer = false;
    showToast('سبد پاک شد');
    renderCheckout();
  }

  global.MarketerUI = {
    renderMarketerPage,
    renderCatalog,
    refreshMkGrid,
    renderCart,
    renderCheckout,
    goCatalog,
    addToCart,
    addVariantLines,
    editCartProduct,
    setQty,
    remove,
    clearAfterInvoice,
    openInvoiceWithCart,
    _ver: 'marketer-ui-v209'
  };
})(typeof window !== 'undefined' ? window : globalThis);
