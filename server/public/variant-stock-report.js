/**
 * Warehouse report: color × size dashboard.
 * Filters refetch. View, columns, and saved layouts stay on this device.
 */
const VSR_KEY = 'erp.vsr.v1';
const VSR_VIEWS = ['overview', 'matrix', 'gaps', 'detail'];
const VSR_COLS = [
  { key: 'code', label: 'کد', kind: '', pick: function (c) { return c.code || ''; } },
  { key: 'name', label: 'کالا', kind: '', pick: function (c) { return c.name || ''; } },
  { key: 'category', label: 'گروه', kind: '', pick: function (c) { return c.category || ''; } },
  { key: 'warehouse', label: 'انبار', kind: '', pick: function (c) { return c.warehouse_name || ''; } },
  { key: 'color', label: 'رنگ', kind: '', pick: function (c) { return c.color_name || ''; } },
  { key: 'size', label: 'سایز', kind: '', pick: function (c) {
    const raw = c.size_name || '';
    return (typeof displaySizeName === 'function') ? displaySizeName(raw) : raw;
  } },
  { key: 'sku', label: 'SKU', kind: '', pick: function (c) { return c.sku || ''; } },
  { key: 'qty', label: 'موجودی', kind: 'qty', pick: function (c) { return vsrCellQty(c); } },
  { key: 'cost', label: 'بهای واحد', kind: 'avg', pick: function (c) { return c.unit_cost_rial || 0; } },
  { key: 'avgrate', label: 'میانگین موزون انبار', kind: 'avg', pick: function (c) { const n = vsrNorm(c); return n && n.avg != null ? n.avg : (c.unit_cost_rial || 0); } },
  { key: 'value', label: 'ارزش موجودی', kind: 'money', pick: function (c) { const v = c.ledger_value_rial; return v != null && isFinite(Number(v)) ? Number(v) : (c.amount_rial || 0); } },
  { key: 'drift', label: 'اختلاف با لایهٔ دیگر', kind: '', pick: function (c) { return vsrDriftText(c); }, html: function (c) { return typeof whRepDriftHtml === 'function' ? whRepDriftHtml(vsrNorm(c)) : '—'; } },
  { key: 'flags', label: 'پرچم', kind: '', pick: function (c) { return typeof whRepFlagText === 'function' ? whRepFlagText(vsrNorm(c)) : ''; }, html: function (c) { return typeof whRepFlagsHtml === 'function' ? whRepFlagsHtml(vsrNorm(c)) : '—'; } },
  { key: 'price', label: 'قیمت فروش', kind: 'avg', pick: function (c) { return c.unit_price_rial || 0; } },
  { key: 'sales', label: 'ارزش فروش', kind: 'money', pick: function (c) { return c.sales_value_rial || 0; } },
];

/* v577 فاز ۴: منبع عدد = کاردکس (kardex_qty) اگر سرور بدهد؛ وگرنه qty قدیمی */
function vsrCellQty(c) {
  const k = c && c.kardex_qty;
  if (k != null && k !== '' && isFinite(Number(k))) return Number(k);
  return Number(c && c.qty) || 0;
}

/* ردیف رنگ/سایز از vws می‌آید؛ مقایسهٔ کاردکس در سطح کالا×انبار است (data.layers از سرور) */
function vsrLayerOf(c) {
  const map = window._vsrLayerMap;
  return map && c ? map.get(c.product_id + ':' + c.warehouse_id) || null : null;
}

function vsrNorm(c) {
  if (typeof whRepNormRow !== 'function' || !c) return null;
  if (!c._vsrNorm) {
    const L = vsrLayerOf(c);
    const src = L ? Object.assign({}, c, {
      kardex_qty: L.kardex_qty, ledger_value_rial: L.kardex_value_rial, ws_qty: L.ws_qty,
      drift_qty: L.drift_qty, drift_ws_vws: !!L.ws_vs_vws, layer_drift: !!L.drift,
    }) : c;
    c._vsrNorm = whRepNormRow(src);
  }
  return c._vsrNorm;
}

function vsrLayerText(c) {
  const L = vsrLayerOf(c);
  if (!L) return '';
  return 'کالا×انبار — کاردکس ' + vsrQty(L.kardex_qty) + ' · جمع رنگ/سایز ' + vsrQty(L.variant_qty) + ' · ارزش کاردکس ' + vsrMoney(L.kardex_value_rial);
}

function vsrDriftText(c) {
  const n = vsrNorm(c);
  if (!n) return '';
  const parts = [];
  if (n.driftQty != null && Math.abs(n.driftQty) > 0.0005) parts.push(n.driftQty + ' عدد');
  if (n.driftVal != null && Math.abs(n.driftVal) > 1) parts.push(n.driftVal + ' ریال');
  const ctx = vsrLayerText(c);
  return parts.join(' ; ') + (ctx ? (parts.length ? ' — ' : '') + ctx : '');
}

function vsrIsFlagged(c) {
  const n = vsrNorm(c);
  return !!(n && n.flags.length);
}

function vsrDefaultState() {
  return {
    view: 'overview',
    onlyLow: false,
    includeZero: false,
    onlyFlag: false,
    matrixProduct: '',
    filters: { warehouse_id: '', product_id: '', category: '', color_id: '', size_id: '', q: '', low_qty: '2' },
    columns: { code: 1, name: 1, category: 1, warehouse: 1, color: 1, size: 1, sku: 0, qty: 1, cost: 1, avgrate: 1, value: 1, drift: 1, flags: 1, price: 1, sales: 1 },
    presets: [],
  };
}

function vsrState() {
  if (!window._vsrState) window._vsrState = vsrReadStore();
  return window._vsrState;
}

function vsrReadStore() {
  const next = vsrDefaultState();
  try {
    const raw = JSON.parse(localStorage.getItem(VSR_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return next;
    if (VSR_VIEWS.indexOf(raw.view) >= 0) next.view = raw.view;
    next.onlyLow = !!raw.onlyLow;
    next.includeZero = !!raw.includeZero;
    next.onlyFlag = !!raw.onlyFlag;
    next.matrixProduct = raw.matrixProduct ? String(raw.matrixProduct) : '';
    next.filters = Object.assign(next.filters, raw.filters || {});
    next.columns = Object.assign(next.columns, raw.columns || {});
    next.columns.qty = 1;
    next.presets = Array.isArray(raw.presets) ? raw.presets.slice(0, 12) : [];
  } catch (e) {}
  return next;
}

function vsrSave() {
  try { localStorage.setItem(VSR_KEY, JSON.stringify(vsrState())); } catch (e) {}
}

function vsrQty(n) {
  const text = typeof fmtQty === 'function' ? fmtQty(n) : String(n || 0);
  return text.replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; });
}

function vsrMoney(n) { return typeof fmt === 'function' ? fmt(n) : String(n || 0); }

function vsrHexOk(hex) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex || ''));
}

function vsrSwatch(hex, name) {
  if (!vsrHexOk(hex)) return '<span class="vsr-swatch vsr-swatch-empty" title="' + esc(name || '') + '"></span>';
  return '<span class="vsr-swatch" title="' + esc(name || '') + '" data-csp-style="' + CSP.style('background:' + hex) + '"></span>';
}

function vsrOptLabel(rows, id, nameKey) {
  const hit = (rows || []).find(function (row) { return String(row.id) === String(id); });
  if (!hit) return '';
  return nameKey ? hit[nameKey] : hit.name;
}

function vsrVisibleCols() {
  return VSR_COLS.filter(function (col) { return vsrState().columns[col.key]; });
}

function vsrReadControl(id, key) {
  const st = vsrState();
  const node = el(id);
  if (!node) return;
  if (node.tagName === 'SELECT' && node.options.length <= 1 && st.filters[key]) return;
  st.filters[key] = node.value;
}

function vsrReadFilters() {
  const st = vsrState();
  vsrReadControl('vsrWh', 'warehouse_id');
  vsrReadControl('vsrProduct', 'product_id');
  vsrReadControl('vsrCat', 'category');
  vsrReadControl('vsrColor', 'color_id');
  vsrReadControl('vsrSize', 'size_id');
  if (el('vsrQ')) st.filters.q = el('vsrQ').value;
  if (el('vsrLow')) st.filters.low_qty = el('vsrLow').value;
  if (el('vsrZero')) st.includeZero = !!el('vsrZero').checked;
  if (el('vsrFlagOnly')) st.onlyFlag = !!el('vsrFlagOnly').checked;
  vsrSave();
  return st.filters;
}

function vsrQuery() {
  const f = vsrReadFilters();
  const p = new URLSearchParams();
  if (f.warehouse_id) p.set('warehouse_id', f.warehouse_id);
  if (f.product_id) p.set('product_id', f.product_id);
  if (f.category) p.set('category', f.category);
  if (f.color_id) p.set('color_id', f.color_id);
  if (f.size_id) p.set('size_id', f.size_id);
  if (f.q) p.set('q', f.q.trim());
  p.set('low_qty', f.low_qty === '' || f.low_qty == null ? '2' : String(f.low_qty));
  return p.toString();
}

let _vsrTimer = null;
let _vsrSeq = 0;

function vsrQueue() {
  clearTimeout(_vsrTimer);
  _vsrTimer = setTimeout(vsrReload, 280);
}

async function renderVariantStockReportTab(body) {
  const st = vsrState();
  body.innerHTML = vsrShell(st);
  await vsrReload();
}

function vsrShell(st) {
  const f = st.filters;
  const cols = VSR_COLS.map(function (col) {
    const on = col.key === 'qty' || st.columns[col.key];
    return '<label class="vsr-check"><input id="vsrCol-' + col.key + '" type="checkbox" ' + (on ? 'checked' : '') + (col.key === 'qty' ? ' disabled' : '') + ' data-csp-change="' + CSP.bind('change', function () { vsrToggleCol(col.key, this.checked); }) + '"> ' + esc(col.label) + '</label>';
  }).join('');
  return '<div class="vsr" id="vsrApp">'
    + '<p class="vsr-lead">موجودی همین لحظه است و به بازهٔ تاریخ حسابداری وصل نیست. هر خانه یک رنگ و یک سایز است. اگر کالا هنوز بین انبارها تقسیم نشده باشد، عدد روی انبار خود کالا می‌نشیند. عدد هر خانهٔ رنگ×سایز از موجودی رنگ/سایزِ انبار است؛ جمع هر کالا×انبار با <b>کاردکس (Σ)</b> مقایسه می‌شود و اختلاف یا «مقدار ۰ با ارزش ≠ ۰» در ستون‌های «اختلاف با لایهٔ دیگر» و «پرچم» (و ردیف قرمز/زرد) نشان داده می‌شود.</p>'
    + '<div class="vsr-filters">'
    + vsrField('انبار', '<select id="vsrWh" data-csp-change="' + CSP.bind('change', function () { vsrReload(); }) + '"><option value="">همه انبارها</option></select>')
    + vsrField('کالا', '<select id="vsrProduct" data-csp-change="' + CSP.bind('change', function () { vsrReload(); }) + '"><option value="">همه کالاها</option></select>')
    + vsrField('گروه', '<select id="vsrCat" data-csp-change="' + CSP.bind('change', function () { vsrReload(); }) + '"><option value="">همه گروه‌ها</option></select>')
    + vsrField('رنگ', '<select id="vsrColor" data-csp-change="' + CSP.bind('change', function () { vsrReload(); }) + '"><option value="">همه رنگ‌ها</option></select>')
    + vsrField('سایز', '<select id="vsrSize" data-csp-change="' + CSP.bind('change', function () { vsrReload(); }) + '"><option value="">همه سایزها</option></select>')
    + vsrField('جستجو', '<input id="vsrQ" type="search" value="' + esc(f.q || '') + '" placeholder="کد، نام، SKU" autocomplete="off" data-csp-input="' + CSP.bind('input', function () { vsrQueue(); }) + '">')
    + vsrField('آستانه کم‌موجود', '<input id="vsrLow" type="number" min="0" step="1" value="' + esc(f.low_qty == null ? '2' : f.low_qty) + '" data-csp-input="' + CSP.bind('input', function () { vsrQueue(); }) + '">')
    + '<label class="vsr-check vsr-zero"><input id="vsrZero" type="checkbox" ' + (st.includeZero ? 'checked' : '') + ' data-csp-change="' + CSP.bind('change', function () { vsrZeroChanged(); }) + '"> موجودی صفر در جدول</label>'
    + '<label class="vsr-check vsr-zero"><input id="vsrFlagOnly" type="checkbox" ' + (st.onlyFlag ? 'checked' : '') + ' data-csp-change="' + CSP.bind('change', function () { vsrFlagChanged(); }) + '"> فقط ردیف‌های دارای پرچم</label>'
    + '</div>'
    + '<div class="vsr-tools">'
    + '<div class="vsr-views" role="tablist">'
    + vsrViewBtn('overview', 'خلاصه')
    + vsrViewBtn('matrix', 'ماتریس')
    + vsrViewBtn('gaps', 'شکستگی سایز')
    + vsrViewBtn('detail', 'جدول')
    + '<button type="button" class="vsr-view" id="vsrLowView" data-csp-click="' + CSP.bind('click', function () { vsrSetView('detail', true); }) + '">فقط کم‌موجود</button>'
    + '</div>'
    + '<details class="vsr-cols"><summary>ستون‌های جدول</summary><div class="vsr-col-grid">' + cols + '</div></details>'
    + '<div class="vsr-presets">'
    + '<select id="vsrPresets" data-csp-change="' + CSP.bind('change', function () { vsrPresetChanged(); }) + '"><option value="">نماهای ذخیره‌شده</option></select>'
    + '<input id="vsrPresetName" placeholder="نام این نما" maxlength="40">'
    + '<button type="button" class="btn sm" data-csp-click="' + CSP.bind('click', function () { vsrSavePreset(); }) + '">ذخیره نما</button>'
    + '<button type="button" class="btn sm ghost" data-csp-click="' + CSP.bind('click', function () { vsrDeletePreset(); }) + '">حذف نما</button>'
    + '<button type="button" class="btn sm ghost" data-csp-click="' + CSP.bind('click', function () { vsrExport(); }) + '">خروجی CSV</button>'
    + '</div>'
    + '<p class="vsr-status" id="vsrStatus" aria-live="polite">در حال خواندن موجودی…</p>'
    + '</div>'
    + '<div id="vsrBody"></div></div>';
}

function vsrField(label, control) {
  return '<label class="vsr-field"><span>' + esc(label) + '</span>' + control + '</label>';
}

function vsrViewBtn(view, label) {
  return '<button type="button" class="vsr-view" data-vsr-view="' + view + '" data-csp-click="' + CSP.bind('click', function () { vsrSetView(view, false); }) + '">' + esc(label) + '</button>';
}

function vsrMarkViews() {
  const st = vsrState();
  document.querySelectorAll('[data-vsr-view]').forEach(function (btn) {
    const on = btn.getAttribute('data-vsr-view') === st.view && !st.onlyLow;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const low = el('vsrLowView');
  if (low) low.classList.toggle('active', st.view === 'detail' && st.onlyLow);
}

function vsrFillSelect(id, html, selected) {
  const sel = el(id);
  if (!sel) return;
  sel.innerHTML = html;
  sel.value = selected == null ? '' : String(selected);
  if (sel.value !== String(selected || '')) sel.value = '';
}

function vsrFillOptions(data) {
  const f = vsrState().filters;
  const opt = data.options || {};
  vsrFillSelect('vsrWh', '<option value="">همه انبارها</option>' + (opt.warehouses || []).map(function (w) {
    return '<option value="' + w.id + '">' + esc(w.name) + '</option>';
  }).join(''), f.warehouse_id);
  vsrFillSelect('vsrProduct', '<option value="">همه کالاها</option>' + (opt.products || []).map(function (p) {
    return '<option value="' + p.id + '">' + esc((p.code ? p.code + ' — ' : '') + (p.name || '')) + '</option>';
  }).join(''), f.product_id);
  vsrFillSelect('vsrCat', '<option value="">همه گروه‌ها</option>' + (opt.categories || []).map(function (c) {
    return '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>';
  }).join(''), f.category);
  vsrFillSelect('vsrColor', '<option value="">همه رنگ‌ها</option>' + (opt.colors || []).map(function (c) {
    return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
  }).join(''), f.color_id);
  vsrFillSelect('vsrSize', '<option value="">همه سایزها</option>' + (opt.sizes || []).map(function (s) {
    return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
  }).join(''), f.size_id);
  vsrFillPresets();
}

function vsrFillPresets() {
  const sel = el('vsrPresets');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">نماهای ذخیره‌شده</option>' + vsrState().presets.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
  }).join('');
  sel.value = current || '';
}

async function vsrReload() {
  const seq = ++_vsrSeq;
  const status = el('vsrStatus');
  if (status) status.textContent = 'در حال خواندن موجودی…';
  const body = el('vsrBody');
  if (body && !window._vsrData) body.innerHTML = '<div class="muted">در حال چیدن گزارش…</div>';
  try {
    const data = await api('GET', '/warehouses/stock/variant-report?' + vsrQuery());
    if (seq !== _vsrSeq) return;
    window._vsrData = data || { cells: [], options: { products: [] }, kpis: {}, gaps: [] };
    window._vsrLayerMap = new Map(((window._vsrData.layers) || []).map(function (L) { return [L.product_id + ':' + L.warehouse_id, L]; }));
    vsrFillOptions(window._vsrData);
    vsrPaint(window._vsrData);
  } catch (e) {
    if (seq !== _vsrSeq) return;
    if (status) status.textContent = 'گزارش خوانده نشد';
    if (body) body.innerHTML = '<div class="empty">گزارش رنگ و سایز باز نشد. اتصال را بررسی کنید و دوباره فیلتر را عوض کنید.</div>';
  }
}

function vsrSetView(view, onlyLow) {
  const st = vsrState();
  st.view = VSR_VIEWS.indexOf(view) >= 0 ? view : 'overview';
  st.onlyLow = !!onlyLow;
  vsrSave();
  if (window._vsrData) vsrPaint(window._vsrData);
  else vsrReload();
}

function vsrToggleCol(key, on) {
  const st = vsrState();
  if (key === 'qty') on = true;
  st.columns[key] = on ? 1 : 0;
  const box = el('vsrCol-' + key);
  if (box) box.checked = !!st.columns[key];
  vsrSave();
  if (window._vsrData && st.view === 'detail') vsrPaint(window._vsrData);
}

function vsrZeroChanged() {
  vsrState().includeZero = !!(el('vsrZero') && el('vsrZero').checked);
  vsrSave();
  if (window._vsrData) vsrPaint(window._vsrData);
}

function vsrFlagChanged() {
  vsrState().onlyFlag = !!(el('vsrFlagOnly') && el('vsrFlagOnly').checked);
  vsrSave();
  if (window._vsrData) vsrPaint(window._vsrData);
}

function vsrClearFilter(key) {
  const map = {
    warehouse_id: 'vsrWh', product_id: 'vsrProduct', category: 'vsrCat',
    color_id: 'vsrColor', size_id: 'vsrSize',
  };
  if (key === 'all') {
    Object.keys(map).forEach(function (name) { if (el(map[name])) el(map[name]).value = ''; });
    if (el('vsrQ')) el('vsrQ').value = '';
  } else if (key === 'q') {
    if (el('vsrQ')) el('vsrQ').value = '';
  } else if (el(map[key])) el(map[key]).value = '';
  vsrState().onlyLow = false;
  vsrReload();
}

function vsrSavePreset() {
  const name = (el('vsrPresetName') && el('vsrPresetName').value || '').trim();
  if (!name) { showToast('نام نما را بنویسید', 'error'); return; }
  const st = vsrState();
  vsrReadFilters();
  const presets = st.presets.filter(function (p) { return p.name !== name; });
  presets.unshift({
    id: Date.now().toString(36),
    name: name,
    view: st.view,
    onlyLow: st.onlyLow,
    includeZero: st.includeZero,
    onlyFlag: st.onlyFlag,
    matrixProduct: st.matrixProduct,
    filters: Object.assign({}, st.filters),
    columns: Object.assign({}, st.columns),
  });
  st.presets = presets.slice(0, 12);
  vsrSave();
  if (el('vsrPresetName')) el('vsrPresetName').value = '';
  vsrFillPresets();
  showToast('نما ذخیره شد');
}

function vsrPresetChanged() {
  const id = el('vsrPresets') ? el('vsrPresets').value : '';
  if (!id) return;
  const preset = vsrState().presets.find(function (p) { return String(p.id) === String(id); });
  if (!preset) return;
  const st = vsrState();
  st.view = VSR_VIEWS.indexOf(preset.view) >= 0 ? preset.view : 'overview';
  st.onlyLow = !!preset.onlyLow;
  st.includeZero = !!preset.includeZero;
  st.onlyFlag = !!preset.onlyFlag;
  st.matrixProduct = preset.matrixProduct || '';
  st.filters = Object.assign(vsrDefaultState().filters, preset.filters || {});
  st.columns = Object.assign(vsrDefaultState().columns, preset.columns || {});
  st.columns.qty = 1;
  vsrSave();
  ['vsrWh', 'vsrProduct', 'vsrCat', 'vsrColor', 'vsrSize'].forEach(function (idName) {
    const key = { vsrWh: 'warehouse_id', vsrProduct: 'product_id', vsrCat: 'category', vsrColor: 'color_id', vsrSize: 'size_id' }[idName];
    if (el(idName)) el(idName).value = st.filters[key] || '';
  });
  if (el('vsrQ')) el('vsrQ').value = st.filters.q || '';
  if (el('vsrLow')) el('vsrLow').value = st.filters.low_qty == null ? '2' : st.filters.low_qty;
  if (el('vsrZero')) el('vsrZero').checked = st.includeZero;
  if (el('vsrFlagOnly')) el('vsrFlagOnly').checked = st.onlyFlag;
  VSR_COLS.forEach(function (col) {
    const box = el('vsrCol-' + col.key);
    if (box) box.checked = !!st.columns[col.key];
  });
  vsrReload();
}

function vsrDeletePreset() {
  const sel = el('vsrPresets');
  const id = sel ? sel.value : '';
  if (!id) { showToast('اول یک نمای ذخیره‌شده را انتخاب کنید', 'error'); return; }
  const st = vsrState();
  st.presets = st.presets.filter(function (p) { return String(p.id) !== String(id); });
  vsrSave();
  vsrFillPresets();
  showToast('نما حذف شد');
}

function vsrStatusText(data) {
  const k = data.kpis || {};
  const flagged = (data.cells || []).filter(vsrIsFlagged).length;
  const drift = Number(k.layer_drift_count) || 0;
  const badge = drift
    ? ' · ⚠ اختلاف با کاردکس: ' + vsrMoney(drift)
    : ' · ✅ جمع گزارش = کاردکس';
  const unattr = Math.abs(Number(k.unattributed_qty) || 0) > 1e-9
    ? ' · بدون رنگ/سایز: ' + vsrQty(k.unattributed_qty)
    : '';
  return 'موجودی ' + vsrQty(k.total_qty) + ' · ' + vsrMoney(k.color_count) + ' رنگ · ' + vsrMoney(k.size_count) + ' سایز · ' + vsrMoney(k.gap_count) + ' شکستگی' + (flagged ? ' · ' + vsrMoney(flagged) + ' پرچم اختلاف/ارزش' : '') + badge + unattr;
}

function vsrChips(data) {
  const f = vsrState().filters;
  const opt = data.options || {};
  const chips = [];
  function add(key, text) {
    if (!text) return;
    chips.push('<button type="button" class="vsr-chip" data-csp-click="' + CSP.bind('click', function () { vsrClearFilter(key); }) + '">' + esc(text) + ' ×</button>');
  }
  if (f.warehouse_id) add('warehouse_id', 'انبار: ' + (vsrOptLabel(opt.warehouses, f.warehouse_id) || f.warehouse_id));
  if (f.product_id) add('product_id', 'کالا: ' + (vsrOptLabel(opt.products, f.product_id) || f.product_id));
  if (f.category) add('category', 'گروه: ' + f.category);
  if (f.color_id) add('color_id', 'رنگ: ' + (vsrOptLabel(opt.colors, f.color_id) || f.color_id));
  if (f.size_id) add('size_id', 'سایز: ' + (vsrOptLabel(opt.sizes, f.size_id) || f.size_id));
  if ((f.q || '').trim()) add('q', 'جستجو: ' + f.q.trim());
  if (!chips.length) return '';
  return '<div class="vsr-chips">' + chips.join('') + '<button type="button" class="btn sm ghost" data-csp-click="' + CSP.bind('click', function () { vsrClearFilter("all"); }) + '">پاک کردن فیلترها</button></div>';
}

function vsrDestroyCharts() {
  (window._vsrCharts || []).forEach(function (chart) { try { chart.destroy(); } catch (e) {} });
  window._vsrCharts = [];
}

function vsrPaint(data) {
  vsrDestroyCharts();
  const body = el('vsrBody');
  const status = el('vsrStatus');
  if (status) status.textContent = vsrStatusText(data);
  vsrMarkViews();
  if (!body) return;
  const products = (data.options && data.options.products) || [];
  if (!products.length) {
    body.innerHTML = '<div class="empty">هنوز کالایی با رنگ و سایز ندارید. از فهرست کالاها برای همان مدل، ماتریس رنگ و سایز بسازید.</div>';
    return;
  }
  const st = vsrState();
  let html = vsrChips(data);
  if (st.view !== 'overview') html += vsrKardexBadge(data);
  if (st.view === 'matrix') html += vsrHtmlMatrix(data);
  else if (st.view === 'gaps') html += vsrHtmlGaps(data);
  else if (st.view === 'detail') html += vsrHtmlDetail(data);
  else html += vsrHtmlOverview(data);
  body.innerHTML = html;
  if (st.view === 'overview') vsrDrawCharts(data);
  if (typeof enhanceAccTables === 'function') enhanceAccTables(body);
}

function vsrKpi(id, label, value, sub, active, click) {
  return '<button type="button" class="vsr-kpi' + (active ? ' active' : '') + '" data-csp-click="' + CSP.bind('click', click) + '"><span>' + esc(label) + '</span><strong>' + value + '</strong><em>' + esc(sub) + '</em></button>';
}

function vsrKardexBadge(data) {
  const k = data.kpis || {};
  const drift = Number(k.layer_drift_count) || 0;
  const pid = (vsrState().filters && vsrState().filters.product_id) || '';
  const checkBtn = '<button type="button" class="btn sm ghost" title="بررسی فقط‌خواندنی اختلاف کش/گزارش/کاردکس" data-csp-click="' + CSP.bind('click', function () { vsrOpenSyncCheck(pid); }) + '">🔍 همگامی رنگ</button>';
  if (!drift) {
    return '<div class="vsr-badge vsr-badge-ok" data-csp-style="' + CSP.style('margin:8px 0;padding:8px 12px;border-radius:8px;background:#ecfdf5;color:#065f46;display:flex;gap:10px;align-items:center;flex-wrap:wrap') + '"><b>✅ جمع گزارش = کاردکس</b>' + checkBtn + '</div>';
  }
  return '<div class="vsr-badge vsr-badge-drift" data-csp-style="' + CSP.style('margin:8px 0;padding:8px 12px;border-radius:8px;background:#fef2f2;color:#991b1b;display:flex;gap:10px;align-items:center;flex-wrap:wrap') + '"><b>⚠ اختلاف با کاردکس: ' + vsrMoney(drift) + ' کالا×انبار</b>' + checkBtn + '</div>';
}

async function vsrOpenSyncCheck(productId) {
  try {
    const q = productId ? ('?product_id=' + encodeURIComponent(productId)) : '';
    const d = await api('GET', '/inventory/variant-sync-check' + q, null, false, true);
    const rows = (d && d.products) || [];
    const lines = rows.slice(0, 20).map(function (p) {
      const bad = (p.warehouses || []).filter(function (w) {
        return Math.abs((w.report_qty || 0) - (w.kardex_qty || 0)) > 1e-6 || (w.mismatches || []).length;
      });
      return (p.product_code || p.product_id) + ' — ' + (bad.length ? (bad.length + ' انبار ناهمخوان') : 'هم‌خوان');
    });
    showToast(lines.length ? lines.join(' · ') : 'اختلافی نیست', rows.some(function (p) {
      return (p.warehouses || []).some(function (w) { return (w.mismatches || []).length || Math.abs((w.report_qty || 0) - (w.kardex_qty || 0)) > 1e-6; });
    }) ? 'error' : undefined);
  } catch (e) {
    showToast((e && e.message) || 'بررسی همگامی ناموفق', 'error');
  }
}

function vsrHtmlOverview(data) {
  const k = data.kpis || {};
  const st = vsrState();
  const cards = vsrKardexBadge(data) + '<div class="vsr-kpis">'
    + vsrKpi('qty', 'موجودی', vsrQty(k.total_qty), 'جمع عدد رنگ×سایز (+بدون رنگ)', st.view === 'overview' && !st.onlyLow, function () { vsrSetView('overview', false); })
    + vsrKpi('sales', 'ارزش فروش', vsrMoney(k.sales_value_rial), 'موجودی × قیمت فروش', false, function () { vsrSetView('detail', false); })
    + vsrKpi('cost', 'ارزش موجودی', vsrMoney(k.cost_value_rial), 'موجودی × بها', false, function () { vsrSetView('detail', false); })
    + vsrKpi('colors', 'رنگ دارای موجودی', vsrMoney(k.color_count), 'حداقل یک عدد', false, function () { vsrSetView('matrix', false); })
    + vsrKpi('low', 'کم‌موجود', vsrMoney(k.low_count), 'بیشتر از صفر تا ' + vsrQty(k.low_qty), st.onlyLow, function () { vsrSetView('detail', true); })
    + vsrKpi('gap', 'شکستگی سایز', vsrMoney(k.gap_count), 'بعضی سایزها تمام شده', st.view === 'gaps', function () { vsrSetView('gaps', false); })
    + '</div>';
  const charts = '<div class="vsr-charts">'
    + '<section class="vsr-panel"><h3>موجودی رنگ‌ها</h3><div class="vsr-chart"><canvas id="vsrChartColor"></canvas></div></section>'
    + '<section class="vsr-panel"><h3>موجودی سایزها</h3><div class="vsr-chart"><canvas id="vsrChartSize"></canvas></div></section>'
    + '</div>';
  const rows = (data.by_product || []).slice(0, 8);
  const table = '<section class="vsr-panel"><h3>کالاهای پرموجود</h3><div class="tbl-wrap" data-scroll="1"><table class="tbl"><thead><tr><th>کد</th><th>کالا</th><th>موجودی</th><th>رنگ</th><th>سایز</th><th>شکستگی</th><th>ارزش فروش</th><th class="no-sort"></th></tr></thead><tbody>'
    + (rows.map(function (p) {
      return '<tr><td class="mono">' + esc(p.code || '—') + '</td><td>' + esc(p.name) + '</td><td class="mono" data-col-kind="qty">' + vsrQty(p.qty) + '</td><td class="mono">' + vsrMoney(p.color_count) + '</td><td class="mono">' + vsrMoney(p.size_count) + '</td><td class="mono">' + vsrMoney(p.gap_count || 0) + '</td><td class="mono" data-col-kind="money">' + vsrMoney(p.sales_value_rial) + '</td><td><button type="button" class="btn sm ghost" data-csp-click="' + CSP.bind('click', function () { vsrOpenProduct(p.product_id); }) + '">ماتریس</button></td></tr>';
    }).join('') || '<tr><td colspan="8" class="muted">در این فیلتر موجودی بالای صفر نیست.</td></tr>')
    + '</tbody></table></div></section>';
  return cards + charts + table;
}

function vsrOpenProduct(productId) {
  if (el('vsrProduct')) el('vsrProduct').value = String(productId);
  vsrState().matrixProduct = String(productId);
  vsrState().view = 'matrix';
  vsrState().onlyLow = false;
  vsrSave();
  vsrReload();
}

function vsrMatrixLens(data) {
  const source = data.matrix_cells || data.cells || [];
  const st = vsrState();
  const forced = st.filters.product_id ? String(st.filters.product_id) : '';
  let pick = forced || st.matrixProduct || '';
  const ids = [];
  source.forEach(function (cell) {
    if (ids.indexOf(String(cell.product_id)) < 0) ids.push(String(cell.product_id));
  });
  if (pick && pick !== 'all' && ids.indexOf(pick) < 0) pick = '';
  if (!pick) {
    const top = (data.by_product || [])[0];
    pick = top ? String(top.product_id) : 'all';
  }
  const cells = pick === 'all' ? source : source.filter(function (cell) { return String(cell.product_id) === pick; });
  return { pick: pick, ids: ids, cells: cells, locked: !!forced };
}

function vsrGrid(cells) {
  const colors = new Map();
  const sizes = new Map();
  const qty = new Map();
  cells.forEach(function (cell) {
    if (!colors.has(cell.color_id)) colors.set(cell.color_id, cell);
    if (!sizes.has(cell.size_id)) sizes.set(cell.size_id, cell);
    const key = cell.color_id + ':' + cell.size_id;
    qty.set(key, (qty.get(key) || 0) + vsrCellQty(cell));
  });
  return {
    colors: [...colors.values()].sort(function (a, b) { return a.color_sort - b.color_sort || String(a.color_name).localeCompare(String(b.color_name), 'fa'); }),
    sizes: [...sizes.values()].sort(function (a, b) { return a.size_sort - b.size_sort || String(a.size_name).localeCompare(String(b.size_name), 'fa'); }),
    qty: qty,
  };
}

function vsrHeat(qty, max) {
  if (!(qty > 0) || !(max > 0)) return 0;
  const ratio = qty / max;
  if (ratio > 0.8) return 5;
  if (ratio > 0.6) return 4;
  if (ratio > 0.4) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

function vsrHtmlMatrix(data) {
  const lens = vsrMatrixLens(data);
  const grid = vsrGrid(lens.cells);
  const low = Number((data.filters && data.filters.low_qty) || 2);
  let max = 0;
  grid.qty.forEach(function (q) { if (q > max) max = q; });
  const warehouses = new Set(lens.cells.map(function (cell) { return cell.warehouse_id; }));
  const products = (data.options && data.options.products) || [];
  const select = lens.locked ? '' : '<label class="vsr-field"><span>مدل در ماتریس</span><select id="vsrMatrixProduct" data-csp-change="' + CSP.bind('change', function () { vsrState().matrixProduct = this.value; vsrSave(); vsrPaint(window._vsrData); }) + '">'
    + '<option value="all"' + (lens.pick === 'all' ? ' selected' : '') + '>جمع فیلتر فعلی</option>'
    + lens.ids.map(function (id) {
      const prod = products.find(function (p) { return String(p.id) === id; });
      const label = prod ? ((prod.code ? prod.code + ' — ' : '') + prod.name) : id;
      return '<option value="' + id + '"' + (lens.pick === id ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('')
    + '</select></label>';
  const sizeNote = vsrState().filters.size_id ? '<p class="vsr-note">فیلتر سایز اینجا اعمال نشده تا خانهٔ خالی پنهان نشود.</p>' : '';
  const sumNote = warehouses.size > 1 ? '<p class="vsr-note">عدد هر خانه جمع انبارهای داخل فیلتر است. برای یک انبار، انبار را بالا انتخاب کنید.</p>' : '';
  if (!grid.colors.length || !grid.sizes.length) {
    return select + sizeNote + '<div class="empty">با این فیلتر خانه‌ای برای ماتریس نیست.</div>';
  }
  const head = '<tr><th class="vsr-sticky">رنگ</th>' + grid.sizes.map(function (size) {
    return '<th>' + esc(size.size_name) + '</th>';
  }).join('') + '<th>جمع</th></tr>';
  const body = grid.colors.map(function (color) {
    let rowQty = 0;
    let rowHas = false;
    grid.sizes.forEach(function (size) {
      const q = grid.qty.get(color.color_id + ':' + size.size_id) || 0;
      rowQty += q;
      if (q > 0) rowHas = true;
    });
    const cells = grid.sizes.map(function (size) {
      const q = grid.qty.get(color.color_id + ':' + size.size_id) || 0;
      const heat = vsrHeat(q, max);
      const lowCls = q > 0 && q <= low ? ' vsr-low' : '';
      const gapCls = rowHas && !(q > 0) ? ' vsr-gap' : '';
      const flagCls = (lens.cells || []).some(function (cl) { return cl.color_id === color.color_id && cl.size_id === size.size_id && vsrIsFlagged(cl); }) ? ' vsr-flagged' : '';
      const label = color.color_name + '، سایز ' + size.size_name + '، موجودی ' + vsrQty(q);
      const pid = lens.pick === 'all' ? '' : lens.pick;
      return '<td><button type="button" class="vsr-cell vsr-h' + heat + lowCls + gapCls + flagCls + '" aria-label="' + esc(label) + '" data-csp-click="' + CSP.bind('click', function () { vsrDrill(pid, color.color_id, size.size_id); }) + '">' + vsrQty(q) + '</button></td>';
    }).join('');
    return '<tr><th class="vsr-sticky">' + vsrSwatch(color.color_hex, color.color_name) + '<span>' + esc(color.color_name) + '</span></th>' + cells + '<td class="mono vsr-row-total">' + vsrQty(rowQty) + '</td></tr>';
  }).join('');
  return '<div class="vsr-matrix-head">' + select + '</div>' + sizeNote + sumNote
    + '<p class="vsr-legend">پررنگ‌تر یعنی تعداد بیشتر. خط‌چین یعنی صفر. قاب قرمز یعنی این سایز تمام شده در حالی که همان رنگ سایز دیگری دارد. قاب نارنجی یعنی کم‌موجود. نقطه‌چین قرمز یعنی اختلاف کاردکس با لایهٔ دیگر یا ارزش ≠ ۰ با مقدار ۰ (جزئیات در نمای «جدول»). عدد همیشه داخل خانه است.</p>'
    + '<div class="vsr-matrix-wrap"><table class="vsr-matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function vsrDrill(productId, colorId, sizeId) {
  if (productId && el('vsrProduct')) el('vsrProduct').value = String(productId);
  if (el('vsrColor')) el('vsrColor').value = colorId ? String(colorId) : '';
  if (el('vsrSize')) el('vsrSize').value = sizeId ? String(sizeId) : '';
  const st = vsrState();
  st.view = 'detail';
  st.onlyLow = false;
  st.includeZero = true;
  if (el('vsrZero')) el('vsrZero').checked = true;
  vsrSave();
  vsrReload();
}

function vsrHtmlGaps(data) {
  const gaps = data.gaps || [];
  const note = vsrState().filters.size_id ? '<p class="vsr-note">فیلتر سایز روی شکستگی اثر ندارد تا سایز تمام‌شده حذف نشود.</p>' : '';
  if (!gaps.length) return note + '<div class="empty">در این فیلتر رنگی نیست که بعضی سایزهایش تمام شده باشد.</div>';
  const rows = gaps.map(function (gap) {
    const have = gap.in_stock.map(function (size) { return esc(size.size_name) + ' (' + vsrQty(size.qty) + ')'; }).join('، ');
    const miss = gap.missing.map(function (size) { return esc(size.size_name); }).join('، ');
    return '<tr><td class="mono">' + esc(gap.code || '—') + '</td><td>' + esc(gap.name) + '</td><td>' + esc(gap.warehouse_name) + '</td><td>' + vsrSwatch(gap.color_hex, gap.color_name) + ' ' + esc(gap.color_name) + '</td><td>' + have + '</td><td>' + miss + '</td><td class="mono" data-col-kind="qty">' + vsrQty(gap.qty) + '</td><td><button type="button" class="btn sm ghost" data-csp-click="' + CSP.bind('click', function () { vsrOpenGap(gap.product_id, gap.color_id); }) + '">ماتریس</button></td></tr>';
  }).join('');
  return note + '<div class="tbl-wrap" data-scroll="1"><table class="tbl"><thead><tr><th>کد</th><th>کالا</th><th>انبار</th><th>رنگ</th><th>سایز موجود</th><th>سایز تمام‌شده</th><th>جمع رنگ</th><th class="no-sort"></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function vsrOpenGap(productId, colorId) {
  if (el('vsrProduct')) el('vsrProduct').value = String(productId);
  if (el('vsrColor')) el('vsrColor').value = String(colorId);
  if (el('vsrSize')) el('vsrSize').value = '';
  const st = vsrState();
  st.view = 'matrix';
  st.onlyLow = false;
  st.matrixProduct = String(productId);
  vsrSave();
  vsrReload();
}

function vsrDetailRows(data) {
  const st = vsrState();
  const low = Number((data.filters && data.filters.low_qty) != null ? data.filters.low_qty : 2);
  return (data.cells || []).filter(function (cell) {
    const q = vsrCellQty(cell);
    if (st.onlyFlag && !vsrIsFlagged(cell)) return false;
    if (st.onlyLow) return q > 0 && q <= low;
    // ردیف مقدار ۰ با ارزش ≠ ۰ (ghost) همیشه دیده شود
    if (!st.includeZero && !(q > 0) && !vsrIsFlagged(cell)) return false;
    return true;
  });
}

function vsrHtmlDetail(data) {
  const cols = vsrVisibleCols();
  const rows = vsrDetailRows(data);
  const canFix = typeof canVariantReclassMutate === 'function' && canVariantReclassMutate() && typeof openVariantReclassModal === 'function';
  const head = cols.map(function (col) {
    return '<th' + (col.kind ? ' data-col-kind="' + col.kind + '"' : '') + '>' + esc(col.label) + '</th>';
  }).join('') + (canFix ? '<th class="no-sort"></th>' : '');
  const body = rows.map(function (cell) {
    const nrm = vsrNorm(cell);
    const rowCls = nrm && nrm.ghost ? ' class="whrep-ghost"' : (nrm && nrm.drift ? ' class="whrep-drift"' : '');
    const drifted = !!(nrm && (nrm.drift || nrm.ghost)) || !!(vsrLayerOf(cell) && vsrLayerOf(cell).drift);
    const unattr = !!cell.unattributed;
    const unattrNeg = unattr && (Number(cell.qty) || 0) < 0;
    if (unattr) rowCls = ' class="vsr-unattr' + (unattrNeg ? ' neg-qty' : '') + '"';
    const fixCell = canFix
      ? '<td>' + (drifted && !unattr ? '<button type="button" class="btn sm ghost" title="اصلاح تفکیک رنگ و سایز این کالا در همین انبار (بدون اثر روی دفتر کل)" data-csp-click="' + CSP.bind('click', function () { openVariantReclassModal({ product_id: cell.product_id, warehouse_id: cell.warehouse_id, onDone: function () { vsrReload(); } }); }) + '">🎨 اصلاح تفکیک</button>' : (unattr ? '<span class="muted" title="ردیف کاردکس بدون رنگ؛ با «تفکیک رنگ» یا «ابطال اصلاحی» در کاردکس اصلاح شود">بدون رنگ</span>' : '')) + '</td>'
      : '';
    return '<tr' + rowCls + (unattr ? ' title="ردیف کاردکس بدون رنگ؛ با «تفکیک رنگ» یا «ابطال اصلاحی» در کاردکس اصلاح شود"' : '') + ' data-csp-style="' + (unattrNeg ? CSP.style('color:#b91c1c;font-weight:700') : '') + '">' + cols.map(function (col) {
      if (col.html) return '<td>' + col.html(cell) + '</td>';
      const raw = col.pick(cell);
      const text = col.key === 'qty' ? vsrQty(raw) : (col.kind === 'money' || col.kind === 'avg' ? vsrMoney(raw) : esc(raw || '—'));
      const color = col.key === 'color' ? vsrSwatch(cell.color_hex, cell.color_name) + ' ' + esc(cell.color_name) : text;
      return '<td class="' + (col.kind || col.key === 'code' || col.key === 'sku' ? 'mono' : '') + (unattrNeg && col.key === 'qty' ? ' neg-qty' : '') + '"' + (col.kind ? ' data-col-kind="' + col.kind + '"' : '') + '>' + (col.key === 'color' ? color : text) + '</td>';
    }).join('') + fixCell + '</tr>';
  }).join('');
  const empty = '<tr><td colspan="' + (cols.length + (canFix ? 1 : 0)) + '" class="muted">' + (vsrState().onlyLow ? 'خانه‌ای در بازهٔ کم‌موجود نیست. آستانه را از بالا عوض کنید.' : 'ردیفی برای این فیلتر نیست. اگر صفرها را می‌خواهید، «موجودی صفر در جدول» را روشن کنید.') + '</td></tr>';
  return '<div class="tbl-wrap" data-scroll="1"><table class="tbl"><thead><tr>' + head + '</tr></thead><tbody>' + (body || empty) + '</tbody></table></div>';
}

async function vsrDrawCharts(data) {
  const seq = _vsrSeq;
  if (typeof loadProdChartJs !== 'function') return;
  try { await loadProdChartJs(); }
  catch (e) { return; }
  if (seq !== _vsrSeq || vsrState().view !== 'overview' || !window.Chart) return;
  const palette = typeof prodChartColors === 'function' ? prodChartColors() : { primary: '#1A5C38', secondary: '#2E7D4F', gold: '#C9A843', blue: '#2563EB', orange: '#D97706' };
  const colors = [palette.primary, palette.secondary, palette.gold, palette.blue, palette.orange];
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw(canvasId, rows, colorOf) {
    const canvas = el(canvasId);
    if (!canvas || !rows.length) {
      if (canvas && canvas.parentNode) canvas.parentNode.innerHTML = '<p class="muted">در این فیلتر عددی برای نمودار نیست.</p>';
      return;
    }
    const chart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(function (row) { return row.name; }),
        datasets: [{
          label: 'موجودی',
          data: rows.map(function (row) { return row.qty; }),
          backgroundColor: rows.map(colorOf),
          borderRadius: 6,
          maxBarThickness: 22,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: reduce ? false : { duration: 280 },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { family: 'Vazirmatn' } }, beginAtZero: true },
          y: { ticks: { font: { family: 'Vazirmatn' } } },
        },
      },
    });
    window._vsrCharts.push(chart);
  }
  draw('vsrChartColor', (data.by_color || []).slice(0, 12), function (row, i) {
    if (row.unattributed || row.name === 'بدون رنگ/سایز') return '#b91c1c';
    const hex = String(row.hex || '').toLowerCase();
    if (hex === '#fff' || hex === '#ffffff') return '#94a3b8';
    return vsrHexOk(row.hex) ? row.hex : colors[i % colors.length];
  });
  draw('vsrChartSize', (data.by_size || []).slice(0, 12), function (_row, i) {
    return colors[i % colors.length];
  });
}

function vsrCsv(rows) {
  if (!rows.length) { showToast('ردیفی برای خروجی نیست', 'error'); return; }
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(',')].concat(rows.map(function (row) {
    return keys.map(function (key) {
      const value = row[key] == null ? '' : String(row[key]);
      return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
    }).join(',');
  }));
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'variant-stock.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('خروجی CSV آماده شد');
}

function vsrExport() {
  const data = window._vsrData;
  if (!data) { showToast('اول گزارش را بخوانید', 'error'); return; }
  const st = vsrState();
  if (st.view === 'gaps') {
    vsrCsv((data.gaps || []).map(function (gap) {
      return {
        'کد': gap.code || '', 'کالا': gap.name || '', 'انبار': gap.warehouse_name || '', 'رنگ': gap.color_name || '',
        'سایز موجود': gap.in_stock.map(function (size) { return size.size_name + ' (' + size.qty + ')'; }).join(' | '),
        'سایز تمام‌شده': gap.missing.map(function (size) { return size.size_name; }).join(' | '),
        'جمع': gap.qty,
      };
    }));
    return;
  }
  if (st.view === 'overview') {
    vsrCsv((data.by_product || []).map(function (p) {
      return { 'کد': p.code || '', 'کالا': p.name || '', 'گروه': p.category || '', 'موجودی': p.qty, 'رنگ': p.color_count, 'سایز': p.size_count, 'شکستگی': p.gap_count || 0, 'ارزش موجودی': p.amount_rial, 'ارزش فروش': p.sales_value_rial };
    }));
    return;
  }
  const cells = st.view === 'matrix' ? vsrMatrixLens(data).cells : vsrDetailRows(data);
  const cols = st.view === 'matrix' ? VSR_COLS.filter(function (col) { return col.key !== 'sku'; }) : vsrVisibleCols();
  vsrCsv(cells.map(function (cell) {
    const row = {};
    cols.forEach(function (col) { row[col.label] = col.pick(cell); });
    return row;
  }));
}
