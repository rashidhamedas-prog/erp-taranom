/**
 * Marketer sales: Catalog (filters like کاتالوگ) → Cart (pack_size qty) → Invoice items
 * Version marker: marketer-ui-v69 — keep in sync with SW / script ?v=
 */
(function (global) {
  'use strict';

  let cart = [];
  let mkFilter = { search: '', category: '', stock_status: 'all' };
  let mkTimer = null;

  function loadCart() {
    try { cart = JSON.parse(localStorage.getItem('marketer_cart') || '[]') || []; }
    catch { cart = []; }
    if (!Array.isArray(cart)) cart = [];
  }
  function saveCart() {
    localStorage.setItem('marketer_cart', JSON.stringify(cart));
    const badge = document.getElementById('mkCartBadge');
    if (badge) badge.textContent = String(cart.reduce((a, c) => a + (Number(c.qty) || 0), 0));
  }

  function packQty(p) {
    return Math.max(1, parseInt(p && p.pack_size, 10) || 1);
  }

  function canInvoice() {
    if (typeof canCreateInvoice === 'function') return canCreateInvoice();
    return !!(global.ME && (ME.role === 'admin' || ME.role === 'accounting'));
  }

  function cartToInvoiceRows() {
    const defWh = (typeof ME !== 'undefined' && ME && ME.sales_warehouse_id) ? ME.sales_warehouse_id : null;
    return cart.map(c => ({
      product_id: c.product_id,
      name: c.name,
      qty: Number(c.qty) || 1,
      price: c.price,
      disc: 0,
      disc_amount: 0,
      description: '',
      warehouse_id: defWh,
      row_type: 'product',
      income_coa: ''
    }));
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
    const rows = cartToInvoiceRows();
    window.__pendingMarketerInvRows = rows;
    window.__invCartFromMarketer = true;
    if (typeof invCart !== 'undefined') invCart = rows.slice();
    if (typeof openInvBuilder === 'function') openInvBuilder();
    else showToast('فاکتورساز در دسترس نیست', 'error');
  }

  async function renderMarketerPage() {
    loadCart();
    const view = el('view');
    const invOk = canInvoice();
    view.innerHTML = `
      <div class="toolbar" style="gap:8px;flex-wrap:wrap">
        <button class="btn" id="mkTabCat">🛍️ کاتالوگ</button>
        <button class="btn ghost" id="mkTabCart">🛒 سبد <span id="mkCartBadge" class="tag t-new">${cart.reduce((a,c)=>a+(Number(c.qty)||0),0)}</span></button>
        <button class="btn ghost" id="mkTabInv" ${invOk ? '' : 'disabled title="دسترسی ایجاد فاکتور ندارید"'}>🧾 ثبت فاکتور</button>
      </div>
      <div id="mkBody"></div>`;
    el('mkTabCat').onclick = () => { setActive(0); renderCatalog(); };
    el('mkTabCart').onclick = () => { setActive(1); renderCart(); };
    el('mkTabInv').onclick = () => {
      if (!canInvoice()) { showToast('دسترسی ایجاد فاکتور ندارید — از مدیر بخواهید دسترسی «فاکتورها → ایجاد» را فعال کند', 'error'); return; }
      setActive(2); renderCheckout();
    };
    function setActive(i) {
      [el('mkTabCat'), el('mkTabCart'), el('mkTabInv')].forEach((b, idx) => {
        if (!b) return;
        b.classList.toggle('ghost', idx !== i);
      });
    }
    setActive(0);
    await renderCatalog();
  }

  async function loadMkProducts() {
    const qs = new URLSearchParams();
    if (mkFilter.category) qs.set('category', mkFilter.category);
    if (mkFilter.search) qs.set('search', mkFilter.search);
    if (mkFilter.stock_status && mkFilter.stock_status !== 'all') qs.set('stock_status', mkFilter.stock_status);
    return await api('GET', '/products?' + qs.toString()) || [];
  }

  function paintMkGrid(list) {
    const grid = el('mkGrid');
    if (!grid) return;
    // Always show pack on button; prefer shared catalog card when available
    if (typeof productCardHtml === 'function') {
      grid.innerHTML = list.map(p => productCardHtml(p, {
        addToCartFn: 'MarketerUI.addToCart',
        showWarehouse: false,
        selectable: false
      })).join('') || '<div class="empty">کالایی یافت نشد</div>';
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
            <div style="font-size:11px;color:var(--muted);margin-top:2px">📦 ${pack} عدد/پک</div>
            <button class="btn sm" style="width:100%;margin-top:8px" onclick="MarketerUI.addToCart(${p.id})">➕ افزودن به سبد (${pack} عدد)</button>
          </div>
        </div>`;
    }).join('') || '<div class="empty">کالایی یافت نشد</div>';
  }

  async function renderCatalog() {
    const body = el('mkBody');
    body.innerHTML = '<div class="muted">در حال بارگذاری...</div>';
    let cats = [];
    try {
      cats = await api('GET', '/products/categories') || [];
    } catch (_) { cats = []; }
    if (!Array.isArray(cats)) cats = [];
    // Normalize: API may return strings or {name} objects
    cats = cats.map(c => (typeof c === 'string' ? c : (c && (c.name || c.category || ''))).trim()).filter(Boolean);
    const prods = await loadMkProducts();
    body.innerHTML = `
      <div class="toolbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
        <input class="search" id="mkSearch" placeholder="جستجو نام یا کد..." value="${esc(mkFilter.search)}" style="flex:1;min-width:160px">
        <select id="mkCat" style="min-width:140px"><option value="">همه گروه‌ها</option>
          ${cats.map(c => `<option value="${esc(c)}" ${mkFilter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select id="mkStock" style="min-width:120px">
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
    grid.innerHTML = '<div class="muted" style="padding:12px">در حال بارگذاری...</div>';
    const prods = await loadMkProducts();
    window._mkProds = prods;
    paintMkGrid(prods);
  }

  function addToCart(productId) {
    loadCart();
    const p = (window._mkProds || []).find(x => Number(x.id) === Number(productId));
    if (!p) return;
    const stock = Number(p.stock) || 0;
    const qty = packQty(p);
    const row = cart.find(c => Number(c.product_id) === Number(productId));
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
      image: p.image || ''
    });
    saveCart();
    showToast(qty > 1
      ? `${p.name} — ${fmt(qty)} عدد (یک پک) به سبد اضافه شد`
      : (p.name + ' به سبد اضافه شد'));
  }

  function renderCart() {
    loadCart();
    const body = el('mkBody');
    if (!cart.length) {
      body.innerHTML = '<div class="empty">سبد خالی است — از کاتالوگ کالا اضافه کنید</div>';
      return;
    }
    body.innerHTML = `
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>کالا</th><th>فی</th><th>تعداد</th><th>جمع</th><th></th></tr></thead>
      <tbody>${cart.map((c, i) => `
        <tr>
          <td>${c.image ? prodImgTag(c.image, 'style="height:40px;border-radius:6px;margin-left:8px;vertical-align:middle"') : ''} ${esc(c.name)}${c.pack_size > 1 ? `<div class="muted" style="font-size:11px">📦 پک ${fmt(c.pack_size)}</div>` : ''}</td>
          <td class="mono">${fmt(c.price)}</td>
          <td><input type="number" min="1" value="${c.qty}" style="width:70px" onchange="MarketerUI.setQty(${i},+this.value)"></td>
          <td class="mono">${fmt(c.price * c.qty)}</td>
          <td><button class="btn sm red" onclick="MarketerUI.remove(${i})">🗑️</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">جمع</td><td class="mono" style="font-weight:800">${fmt(cart.reduce((a,c)=>a+c.price*c.qty,0))}</td><td></td></tr></tfoot>
      </table></div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="document.getElementById('mkTabInv').click()">ادامه → ثبت فاکتور</button>
        <button class="btn green" onclick="MarketerUI.openInvoiceWithCart()">🧾 باز کردن فاکتورساز با اقلام سبد</button>
      </div>`;
  }

  function setQty(i, q) {
    loadCart();
    if (!cart[i]) return;
    const want = Math.max(1, q || 1);
    const p = (window._mkProds || []).find(x => Number(x.id) === Number(cart[i].product_id));
    const stock = p != null ? (Number(p.stock) || 0) : null;
    if (stock != null && want > stock) {
      showToast(
        'کسر موجودی: برای «' + (cart[i].name || '') + '» فقط ' + fmt(stock) + ' عدد موجود است',
        'error'
      );
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
    saveCart();
    renderCart();
  }

  async function renderCheckout() {
    loadCart();
    if (!cart.length) {
      el('mkBody').innerHTML = '<div class="empty">ابتدا کالا به سبد اضافه کنید</div>';
      return;
    }
    if (!canInvoice()) {
      el('mkBody').innerHTML = '<div class="empty">دسترسی ایجاد فاکتور ندارید. از مدیر بخواهید در «کاربران → دسترسی‌ها» برای فاکتورها تیک <b>ایجاد</b> را بزند.</div>';
      return;
    }
    const rows = cartToInvoiceRows();
    window.__pendingMarketerInvRows = rows;
    window.__invCartFromMarketer = true;
    if (typeof invCart !== 'undefined') invCart = rows.slice();
    el('mkBody').innerHTML = `
      <div class="panel"><div class="panel-body">
        <p class="muted">اقلام سبد (${cart.length} ردیف، با تعداد پک) آماده انتقال به فاکتورساز هستند.</p>
        <ul class="muted" style="font-size:13px;margin:8px 0 14px;padding-right:18px;line-height:1.8">
          ${cart.slice(0, 8).map(c => `<li>${esc(c.name)} × ${fmt(c.qty)}</li>`).join('')}
          ${cart.length > 8 ? `<li>… و ${cart.length - 8} مورد دیگر</li>` : ''}
        </ul>
        <button class="btn" onclick="MarketerUI.openInvoiceWithCart()">🧾 باز کردن فاکتورساز با اقلام سبد</button>
        <button class="btn ghost" style="margin-right:8px" onclick="MarketerUI.clearAfterInvoice()">پاک کردن سبد پس از ثبت</button>
      </div></div>`;
  }

  function clearAfterInvoice() {
    cart = [];
    saveCart();
    window.__pendingMarketerInvRows = null;
    window.__invCartFromMarketer = false;
    showToast('سبد پاک شد');
  }

  global.MarketerUI = {
    renderMarketerPage,
    addToCart,
    setQty,
    remove,
    clearAfterInvoice,
    openInvoiceWithCart,
    _ver: 'marketer-ui-v69'
  };
})(typeof window !== 'undefined' ? window : globalThis);
