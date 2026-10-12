/**
 * Warehouse slip print — حواله / رسید / انتقال انبار (عملیاتی برای انباردار)
 *
 * Invariant: فقط‌خواندنی — موجودی/دفتر را عوض نمی‌کند.
 * Segregation: مبلغ/فی/تخفیف چاپ نمی‌شود (برگه انبار ≠ فاکتور مالی).
 * Picking: رنگ و سایز و کد کالا باید دیده شوند (برخلاف فشرده‌سازی چاپ فاکتور).
 * کد = کد کاتالوگ (نه SKU ماتریس)؛ سایز بدون پرانتز «مناسب تا/از».
 * Paper: فقط ISO A4 / A5.
 */
'use strict';

const { ISO_PAPER } = require('./invoice-print');
const { displayProductCode, displaySizeName } = require('./display-labels');

const DOC_TITLES = Object.freeze({
  sales_issue: 'حواله خروج انبار',
  purchase_receipt: 'رسید ورود انبار',
  sales_return_receipt: 'رسید برگشت به انبار',
  purchase_return_issue: 'حواله خروج برگشت خرید',
  wh_receipt: 'رسید انبار',
  wh_issue: 'حواله انبار',
  wh_transfer: 'حواله انتقال بین انبارها',
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function faNum(n) {
  if (n == null || n === '') return '۰';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  try { return num.toLocaleString('fa-IR'); } catch (_) { return String(n); }
}

function paperDims(paper) {
  const p = String(paper || 'A4').toUpperCase() === 'A5' ? 'A5' : 'A4';
  const iso = ISO_PAPER[p];
  return {
    paper: p,
    widthMm: iso.widthMm,
    heightMm: iso.heightMm,
    pageMargin: iso.pageMargin,
    htmlClass: p === 'A5' ? 'wh-slip paper-a5' : 'wh-slip paper-a4',
  };
}

function resolveWarehouseName(db, warehouseId) {
  const id = parseInt(warehouseId, 10);
  if (!id) return '';
  try {
    const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(id);
    return (w && w.name) || '';
  } catch (_) { return ''; }
}

/**
 * Normalize mixed source rows into warehouse-slip lines.
 * Keeps color/size; skips income/service rows; no prices.
 */
function normalizeSlipLines(rawRows, opts = {}) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  const out = [];
  let lineNo = 0;
  for (const r of list) {
    if (!r) continue;
    if (r.row_type === 'income') continue;
    const qty = Number(r.qty);
    if (!Number.isFinite(qty) || qty === 0) continue;
    lineNo += 1;
    const color = String(r.color_name || r.color || '').trim();
    const sizeRaw = String(r.size_name || '').trim();
    const size = displaySizeName(sizeRaw);
    const code = displayProductCode({
      product_code: r.product_code,
      code: r.code || r.sku || r.barcode || r.variant_sku,
      sku: r.sku || r.variant_sku,
      barcode: r.barcode,
      color_name: color,
      color,
      size_name: sizeRaw,
    });
    const name = String(r.name || r.product_name || r.product_label || '').trim() || '—';
    const unit = String(r.unit || r.product_unit || 'عدد').trim() || 'عدد';
    // توضیح ردیف اگر فقط برچسب تناسب/واریانت باشد چاپ نشود
    let note = String(r.description || r.note || '').trim();
    if (note && /مناسب\s+(?:از|تا)/u.test(note) && note.length < 80) note = '';
    const warehouse = String(
      r.warehouse_name || r.from_warehouse_name || r.to_warehouse_name || opts.defaultWarehouse || ''
    ).trim();
    out.push({
      line_no: lineNo,
      code,
      name,
      color,
      size,
      qty,
      unit,
      warehouse,
      note,
    });
  }
  return out;
}

function enrichInvoiceRowsForSlip(db, rows) {
  return (rows || []).map((r) => {
    if (!r || r.row_type === 'income') return r;
    let code = String(r.code || r.sku || r.barcode || '').trim();
    let color = String(r.color_name || r.color || '').trim();
    let size = String(r.size_name || '').trim();
    let unit = String(r.unit || '').trim();
    let name = String(r.name || '').trim();
    let warehouseName = '';
    const pid = parseInt(r.product_id, 10);
    if (pid) {
      try {
        const p = db.prepare('SELECT code, name, unit, barcode FROM products WHERE id=?').get(pid);
        if (p) {
          // حواله: همیشه کد کاتالوگ را ترجیح بده (نه SKU ماتریس روی ردیف)
          const catalog = String(p.code || p.barcode || '').trim();
          if (catalog) code = catalog;
          if (!name) name = String(p.name || '').trim();
          if (!unit) unit = String(p.unit || 'عدد').trim();
        }
      } catch (_) { /* ignore */ }
    }
    const vid = parseInt(r.variant_id, 10);
    if (vid) {
      try {
        const v = db.prepare(`
          SELECT pv.sku, pv.barcode, c.name AS color_name, s.name AS size_name
          FROM product_variants pv
          LEFT JOIN product_colors c ON c.id=pv.color_id
          LEFT JOIN product_sizes s ON s.id=pv.size_id
          WHERE pv.id=?
        `).get(vid);
        if (v) {
          if (!code) code = String(v.sku || v.barcode || '').trim();
          if (!color) color = String(v.color_name || '').trim();
          if (!size) size = String(v.size_name || '').trim();
        }
      } catch (_) { /* optional */ }
    }
    const whId = parseInt(r.warehouse_id, 10);
    if (whId) warehouseName = resolveWarehouseName(db, whId);
    return Object.assign({}, r, {
      code, name, unit: unit || 'عدد',
      color_name: color, size_name: size,
      warehouse_name: warehouseName,
    });
  });
}

function companyBlock(settings) {
  const name = esc(settings.company_name || 'پوشاک ترنم');
  const phone = settings.company_phone ? `<span class="meta">تلفن: ${esc(settings.company_phone)}</span>` : '';
  const addr = settings.company_address ? `<span class="meta">آدرس: ${esc(settings.company_address)}</span>` : '';
  return `<div class="co">
    <div class="co-name">${name}</div>
    <div class="co-sub">برگه عملیاتی انبار — بدون اثر مالی</div>
    <div class="co-meta">${phone}${addr}</div>
  </div>`;
}

function metaRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

function linesTable(lines) {
  const rows = lines.map((l) => `<tr>
    <td class="c mono">${faNum(l.line_no)}</td>
    <td class="mono">${esc(l.code || '—')}</td>
    <td class="name">${esc(l.name)}</td>
      <td>${esc(l.color || '—')}</td>
      <td>${/^\d+(\.\d+)?$/.test(String(l.size || '')) ? faNum(l.size) : esc(l.size || '—')}</td>
      <td class="c mono">${faNum(l.qty)}</td>
    <td class="c">${esc(l.unit)}</td>
    <td class="muted">${esc(l.warehouse || '—')}</td>
    <td class="muted">${esc(l.note || '')}</td>
  </tr>`).join('');
  const qtyTotal = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  return `<table class="lines" dir="rtl">
    <thead><tr>
      <th>#</th><th>کد</th><th>شرح کالا</th><th>رنگ</th><th>سایز</th>
      <th>تعداد</th><th>واحد</th><th>انبار</th><th>توضیح</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="9" class="c muted">ردیفی برای تحویل/دریافت ثبت نشده</td></tr>`}</tbody>
    <tfoot><tr>
      <td colspan="5" class="c">جمع اقلام: ${faNum(lines.length)} ردیف</td>
      <td class="c mono">${faNum(qtyTotal)}</td>
      <td colspan="3"></td>
    </tr></tfoot>
  </table>`;
}

function signatureBlock(kind) {
  const roles = kind === 'receipt'
    ? ['صادرکننده', 'انباردار (ورود)', 'تحویل‌دهنده']
    : kind === 'transfer'
      ? ['صادرکننده', 'انبار مبدأ', 'انبار مقصد']
      : ['صادرکننده', 'انباردار (خروج)', 'تحویل‌گیرنده'];
  return `<div class="signs">${roles.map((r) => `<div class="sign"><div class="sign-label">${esc(r)}</div><div class="sign-line">امضا / تاریخ</div></div>`).join('')}</div>`;
}

/**
 * @param {object} opts
 * @param {string} opts.docKind — key in DOC_TITLES
 * @param {object} opts.doc — header fields
 * @param {object[]} opts.lines — normalized lines
 * @param {object} opts.settings
 * @param {string} [opts.paper]
 * @param {string} [opts.watermark]
 * @param {'issue'|'receipt'|'transfer'} [opts.signKind]
 */
function renderWarehouseSlipHtml(opts) {
  const docKind = opts.docKind || 'wh_issue';
  const title = DOC_TITLES[docKind] || 'برگه انبار';
  const doc = opts.doc || {};
  const settings = opts.settings || {};
  const dims = paperDims(opts.paper);
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  const signKind = opts.signKind
    || (docKind.includes('receipt') ? 'receipt'
      : (docKind === 'wh_transfer' ? 'transfer' : 'issue'));

  const meta = [
    metaRow('شماره سند', doc.num || ''),
    metaRow('تاریخ', doc.date || ''),
    metaRow('سند مرجع', doc.ref_num || ''),
    metaRow('طرف حساب', doc.party || ''),
    metaRow('از انبار', doc.from_warehouse || ''),
    metaRow('به انبار', doc.to_warehouse || ''),
    metaRow('انبار', doc.warehouse || ''),
    metaRow('ثبت‌کننده', doc.recorder || ''),
    metaRow('یادداشت', doc.note || ''),
  ].filter(Boolean).join('');

  const purpose = signKind === 'receipt'
    ? 'این برگه مبنای کنترل فیزیکی ورود کالا به انبار است. پس از شمارش و تأیید انباردار، رسید در سیستم ثبت می‌شود.'
    : (signKind === 'transfer'
      ? 'این برگه مبنای کنترل فیزیکی جابه‌جایی بین انبارهاست. خروج از مبدأ و ورود به مقصد باید هر دو تأیید شوند.'
      : 'این برگه مبنای کنترل فیزیکی خروج کالا از انبار است. تحویل فقط پس از تأیید انباردار مجاز است.');

  const watermark = opts.watermark
    ? `<div class="watermark"><span>${esc(opts.watermark)}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl" class="${esc(dims.htmlClass)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} ${esc(doc.num || '')}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<link href="/warehouse-slip-print.css?v=345" rel="stylesheet">
<style>
@page { size: ${dims.widthMm}mm ${dims.heightMm}mm; margin: ${dims.pageMargin}; }
@media print {
  html.wh-slip body { background:#fff!important; padding:0!important; }
  html.wh-slip .pbtn { display:none!important; }
  html.wh-slip .sheet { box-shadow:none!important; max-width:100%!important; }
}
</style>
</head>
<body>
  <div class="sheet">
    ${watermark}
    <header class="head">
      ${companyBlock(settings)}
      <div class="doc-badge">
        <div class="doc-title">${esc(title)}</div>
        <div class="doc-paper">${esc(dims.paper)} · ${faNum(dims.widthMm)}×${faNum(dims.heightMm)} mm</div>
      </div>
    </header>
    <p class="purpose">${esc(purpose)}</p>
    <div class="meta-grid">${meta}</div>
    ${linesTable(lines)}
    <p class="legal muted">توجه: این سند جایگزین فاکتور فروش/خرید یا سند حسابداری نیست و مبلغ ریالی ندارد. هر مغایرت تعداد باید قبل از خروج/ورود کالا اعلام و اصلاح شود.</p>
    ${signatureBlock(signKind)}
    <button class="pbtn" type="button" data-print>🖨️ چاپ ${esc(title)} (${esc(dims.paper)})</button>
  </div>
  <script src="/print-page.js"></script>
</body>
</html>`;
}

function companySettings(db, getSetting) {
  return {
    company_name: getSetting(db, 'company_name') || 'پوشاک ترنم',
    company_address: getSetting(db, 'company_address') || '',
    company_phone: getSetting(db, 'company_phone') || '',
  };
}

function buildSalesInvoiceSlip(db, inv, rawRows, settings, paper) {
  const enriched = enrichInvoiceRowsForSlip(db, rawRows);
  const headerWh = resolveWarehouseName(db, inv.warehouse_id);
  const lines = normalizeSlipLines(enriched, { defaultWarehouse: headerWh });
  const isProforma = String(inv.type || '') === 'proforma';
  return renderWarehouseSlipHtml({
    docKind: 'sales_issue',
    paper,
    settings,
    signKind: 'issue',
    watermark: isProforma ? 'پیش‌فاکتور — موجودی ممکن است هنوز کسر نشده باشد' : '',
    doc: {
      num: inv.num || '',
      date: inv.date || '',
      ref_num: inv.ref_doc_no || '',
      party: [inv.cust_biz, inv.cust_owner].filter(Boolean).join(' — ') || '',
      warehouse: headerWh,
      recorder: inv.seller_name || inv.salesperson || '',
      note: inv.note || '',
    },
    lines,
  });
}

function buildPurchaseInvoiceSlip(db, row, rawRows, settings, paper) {
  const enriched = enrichInvoiceRowsForSlip(db, rawRows);
  const headerWh = resolveWarehouseName(db, row.warehouse_id);
  const lines = normalizeSlipLines(enriched, { defaultWarehouse: headerWh });
  return renderWarehouseSlipHtml({
    docKind: 'purchase_receipt',
    paper,
    settings,
    signKind: 'receipt',
    doc: {
      num: row.num || '',
      date: row.date || '',
      ref_num: row.ref_doc_no || '',
      party: row.supplier_name || '',
      warehouse: headerWh,
      recorder: row.recorder || '',
      note: row.note || '',
    },
    lines,
  });
}

function buildSalesReturnSlip(db, sr, settings, paper) {
  let raw = [];
  try { raw = typeof sr.rows === 'string' ? JSON.parse(sr.rows || '[]') : (sr.rows || []); } catch (_) { raw = []; }
  const enriched = enrichInvoiceRowsForSlip(db, raw);
  const headerWh = resolveWarehouseName(db, sr.warehouse_id);
  const lines = normalizeSlipLines(enriched, { defaultWarehouse: headerWh });
  return renderWarehouseSlipHtml({
    docKind: 'sales_return_receipt',
    paper,
    settings,
    signKind: 'receipt',
    doc: {
      num: sr.num || ('SR-' + (sr.id || '')),
      date: sr.date || '',
      ref_num: sr.invoice_num || sr.ref_doc_no || '',
      party: sr.cust_biz || '',
      warehouse: headerWh,
      recorder: sr.recorder || '',
      note: sr.note || '',
    },
    lines,
  });
}

function buildWarehouseDocSlip(doc, settings, paper) {
  const type = doc.type;
  const docKind = type === 'receipt' ? 'wh_receipt'
    : (type === 'transfer' ? 'wh_transfer' : 'wh_issue');
  const signKind = type === 'receipt' ? 'receipt'
    : (type === 'transfer' ? 'transfer' : 'issue');
  const lines = normalizeSlipLines((doc.lines || []).map((l) => ({
    product_id: l.product_id,
    name: l.product_name || l.product_label,
    code: l.product_code || l.variant_sku,
    qty: l.qty,
    unit: l.product_unit || l.unit || 'عدد',
    color_name: l.color_name,
    size_name: l.size_name,
    warehouse_name: type === 'receipt'
      ? (l.to_warehouse_name || doc.to_warehouse_name)
      : (type === 'issue'
        ? (l.from_warehouse_name || doc.from_warehouse_name)
        : [l.from_warehouse_name || doc.from_warehouse_name, l.to_warehouse_name || doc.to_warehouse_name]
          .filter(Boolean).join(' → ')),
    description: l.note || '',
  })));
  const reversed = String(doc.status || '') === 'reversed';
  return renderWarehouseSlipHtml({
    docKind,
    paper,
    settings,
    signKind,
    watermark: reversed ? 'ابطال‌شده' : '',
    doc: {
      num: doc.num || ('#' + doc.id),
      date: doc.date || '',
      from_warehouse: doc.from_warehouse_name || '',
      to_warehouse: doc.to_warehouse_name || '',
      warehouse: type === 'receipt' ? (doc.to_warehouse_name || '')
        : (type === 'issue' ? (doc.from_warehouse_name || '') : ''),
      recorder: doc.recorder || '',
      note: doc.note || '',
    },
    lines,
  });
}

module.exports = {
  DOC_TITLES,
  esc,
  faNum,
  paperDims,
  resolveWarehouseName,
  normalizeSlipLines,
  enrichInvoiceRowsForSlip,
  renderWarehouseSlipHtml,
  companySettings,
  buildSalesInvoiceSlip,
  buildPurchaseInvoiceSlip,
  buildSalesReturnSlip,
  buildWarehouseDocSlip,
};
