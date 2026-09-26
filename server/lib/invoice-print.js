/**
 * Invoice print templates — ERP ترنم
 * Formal (final): formal-official | formal-modern | formal-premium
 * Casual (proforma): casual-simple only
 * Thermal printers: thermal (58mm / 80mm)
 * Paper: A4 | A5 | THERMAL
 */
'use strict';

const { collapsePrintRows } = require('./print-line-collapse');

const FORMAL_IDS = ['formal-official', 'formal-modern', 'formal-premium'];
const CASUAL_IDS = ['casual-simple'];
const THERMAL_ID = 'thermal';
/** @deprecated kept for migrating old settings */
const LEGACY_CASUAL = ['casual-compact', 'casual-receipt'];

/**
 * ISO 216 portrait paper sizes (mm) — single source of truth for print.
 * A4 = 210×297, A5 = 148×210. Never invent custom "A5-like" sizes.
 */
const ISO_PAPER = Object.freeze({
  A4: Object.freeze({ widthMm: 210, heightMm: 297, pageMargin: '8mm' }),
  A5: Object.freeze({ widthMm: 148, heightMm: 210, pageMargin: '8mm' }),
});

const DEFAULT_CUSTOMIZE = {
  show_logo: true,
  show_company_phone: true,
  show_company_address: true,
  show_seller: true,
  show_payment: true,
  show_discount: true,
  show_note: true,
  show_footer: true,
  footer_text: '',
  subtitle: 'تولیدی پوشاک زنانه',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function numToPersianWords(num) {
  if (num == null || isNaN(num) || Number(num) === 0) return 'صفر';
  const yekan = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  const dahgaana = ['', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هیجده', 'نوزده'];
  const dahgan = ['', 'ده', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
  const sadgan = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
  const basess = ['', 'هزار', 'میلیون', 'میلیارد', 'تریلیون'];

  function threeDigitsToWords(n) {
    if (n === 0) return '';
    let s = '';
    const sad = Math.floor(n / 100);
    const dah = Math.floor((n % 100) / 10);
    const yek = n % 10;

    if (sad > 0) s += sadgan[sad];
    if (dah === 1 && yek > 0) {
      if (s) s += ' و ';
      s += dahgaana[yek];
      return s;
    }
    if (dah > 0) {
      if (s) s += ' و ';
      s += dahgan[dah];
    }
    if (yek > 0) {
      if (s) s += ' و ';
      s += yekan[yek];
    }
    return s;
  }

  let n = Math.abs(Math.floor(Number(num)));
  let result = [];
  let baseIdx = 0;

  while (n > 0) {
    const chunk = n % 1000;
    if (chunk > 0) {
      const chunkWords = threeDigitsToWords(chunk);
      const suffix = basess[baseIdx];
      result.unshift(chunkWords + (suffix ? ' ' + suffix : ''));
    }
    n = Math.floor(n / 1000);
    baseIdx++;
  }

  return result.join(' و ');
}

function faNum(n) {
  if (n == null || n === '') return '۰';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  try {
    return num.toLocaleString('fa-IR');
  } catch (_) {
    return String(n);
  }
}

function freightTypeFa(t) {
  const n = String(t || '').trim().toLowerCase();
  if (n === 'seller' || n.includes('فروشنده')) return 'عهده فروشنده';
  if (n === 'buyer' || n.includes('خریدار')) return 'عهده خریدار';
  return t || '';
}

function parseCustomize(raw) {
  let o = {};
  try {
    if (raw && typeof raw === 'string') o = JSON.parse(raw);
    else if (raw && typeof raw === 'object') o = raw;
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_CUSTOMIZE, ...o };
}

function normalizeCasual(id) {
  if (CASUAL_IDS.includes(id)) return id;
  if (LEGACY_CASUAL.includes(id)) return 'casual-simple';
  return 'casual-simple';
}

function thermalWidthMm(settings) {
  const w = String(settings.invoice_thermal_width || '80').replace(/\D/g, '');
  return w === '58' ? 58 : 80;
}

function resolveTemplateId(invType, settings, opts) {
  const paper = String((opts && opts.paper) || '').toUpperCase();
  const override = opts && opts.templateOverride;
  if (override === THERMAL_ID || paper === 'THERMAL' || paper === '80MM' || paper === '58MM') {
    return THERMAL_ID;
  }
  if (override && FORMAL_IDS.includes(override)) return override;
  if (override === 'casual-simple') return 'casual-simple';
  if (override === 'casual-receipt' || override === 'casual-compact') return 'casual-simple';

  const formal = FORMAL_IDS.includes(settings.invoice_template_formal)
    ? settings.invoice_template_formal : 'formal-official';
  return invType === 'final' ? formal : 'casual-simple';
}

function paperDims(paper, settings) {
  const p = String(paper || 'A4').toUpperCase();
  if (p === 'THERMAL' || p === '80MM' || p === '58MM') {
    const mm = p === '58MM' ? 58 : (p === '80MM' ? 80 : thermalWidthMm(settings || {}));
    return {
      paper: 'THERMAL',
      thermalMm: mm,
      widthMm: mm,
      heightMm: 0,
      sheetMax: mm === 58 ? '220px' : '300px',
      pageSizeCss: `${mm}mm auto`,
      pageMargin: '2mm',
      pad: mm === 58 ? '8px' : '10px',
      font: mm === 58 ? '10px' : '11px',
      logoH: mm === 58 ? '36px' : '42px',
    };
  }
  const isA5 = p === 'A5';
  const iso = isA5 ? ISO_PAPER.A5 : ISO_PAPER.A4;
  return {
    paper: isA5 ? 'A5' : 'A4',
    thermalMm: 0,
    widthMm: iso.widthMm,
    heightMm: iso.heightMm,
    sheetMax: `${iso.widthMm}mm`,
    pageSizeCss: `${iso.widthMm}mm ${iso.heightMm}mm`,
    pageMargin: iso.pageMargin,
    pad: isA5 ? '12px' : '16px',
    font: isA5 ? '10px' : '11.5px',
    logoH: isA5 ? '40px' : '52px',
  };
}

function lineDiscOf(r) {
  const amt = Math.max(0, Math.round(Number(r.disc_amount) || 0));
  if (amt > 0) return amt;
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0) * (Number(r.disc) || 0) / 100);
}

function lineGross(r) {
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0));
}

function lineNet(r) {
  const sum = Math.round(Number(r.sum) || 0);
  if (sum > 0) return sum;
  return Math.max(0, lineGross(r) - lineDiscOf(r));
}

function linesDiscTotal(rows) {
  return (rows || []).reduce((a, r) => a + lineDiscOf(r), 0);
}

function computePrintTotals(inv, rows) {
  const list = rows || [];
  const rowsGross = list.reduce((a, r) => a + lineGross(r), 0);
  const rowsNet = list.reduce((a, r) => a + lineNet(r), 0);
  const discLines = linesDiscTotal(list);
  const headerSubtotal = Math.round(Number(inv && inv.subtotal) || 0);
  const discAmt = Math.round(Number(inv && inv.disc_amt) || 0);
  const discPct = Number(inv && inv.disc) || 0;
  const freight = Math.round(Number(inv && inv.freight_amount) || 0);
  const vat = Math.round(Number(inv && inv.vat_amount) || 0);
  const vatRate = Number(inv && inv.vat_rate) || 0;
  const headerFinal = Math.round(Number(inv && inv.final) || 0);
  const payable = headerFinal || Math.max(0, (headerSubtotal || rowsNet) - discAmt + freight + vat);
  const mismatch = headerSubtotal > 0 && list.length > 0
    && Math.abs(headerSubtotal - rowsGross) > 1
    && Math.abs(headerSubtotal - rowsNet) > 1;
  return {
    rowsGross, rowsNet, discLines,
    subtotal: headerSubtotal || rowsGross,
    discAmt, discPct, freight, vat, vatRate, payable, mismatch,
  };
}

function buildFormalRows(rows, isA5) {
  return (rows || []).map((r, i) => {
    const desc = String(r.description || '').trim();
    const nameCell = desc
      ? `${esc(r.name || '')}<div class="row-desc">${esc(desc)}</div>`
      : esc(r.name || '');
    const code = esc(r.code || r.sku || r.barcode || '—');
    const disc = lineDiscOf(r);
    if (isA5) {
      return `<tr>
        <td>${faNum(i + 1)}</td>
        <td class="rtl">${nameCell}</td>
        <td>${faNum(r.qty)}</td>
        <td class="num">${faNum(r.price)}</td>
        <td class="num disc">${disc ? faNum(disc) : '—'}</td>
        <td class="num">${faNum(lineNet(r))}</td>
      </tr>`;
    }
    return `<tr>
      <td>${faNum(i + 1)}</td>
      <td>${code}</td>
      <td class="rtl">${nameCell}</td>
      <td>${esc(r.unit || 'عدد')}</td>
      <td>${faNum(r.qty)}</td>
      <td class="num">${faNum(r.price)}</td>
      <td class="num">${faNum(lineGross(r))}</td>
      <td class="num disc">${disc ? faNum(disc) : '—'}</td>
      <td class="num">${faNum(lineNet(r))}</td>
    </tr>`;
  }).join('');
}

function buildCasualRows(rows) {
  return (rows || []).map((r, i) => {
    const desc = String(r.description || '').trim();
    const nameCell = desc
      ? `${esc(r.name || '')}<div class="row-desc">${esc(desc)}</div>`
      : esc(r.name || '');
    const disc = lineDiscOf(r);
    return `<tr>
      <td>${faNum(i + 1)}</td>
      <td class="rtl">${nameCell}</td>
      <td>${esc(r.unit || 'عدد')}</td>
      <td>${faNum(r.qty)}</td>
      <td class="num">${faNum(r.price)}</td>
      <td class="num disc">${disc ? faNum(disc) : '—'}</td>
      <td class="num">${faNum(lineNet(r))}</td>
    </tr>`;
  }).join('');
}

function buildThermalRows(rows) {
  return (rows || []).map((r) => {
    const desc = String(r.description || '').trim();
    const nameCell = desc
      ? `${esc(r.name || '')}<div class="row-desc">${esc(desc)}</div>`
      : esc(r.name || '');
    const disc = lineDiscOf(r);
    return `<tr>
      <td class="rtl">${nameCell}</td>
      <td>${faNum(r.qty)}</td>
      <td class="num disc">${disc ? faNum(disc) : '—'}</td>
      <td class="num">${faNum(lineNet(r))}</td>
    </tr>`;
  }).join('');
}

function logoHtml(customize, dims) {
  if (!customize.show_logo) return '';
  return '<div class="logo-box"><img src="/logo-sm.png" alt="لوگو"></div>';
}

function expertHtml(inv, customize) {
  if (!customize.show_seller) return '';
  const name = inv.seller_name || inv.salesperson || '';
  const phone = inv.seller_phone || '';
  if (!name && !phone) return '';
  return `<div class="expert">
    <div class="expert-l">
      <span class="expert-t">کارشناس فروش</span>
      <span class="expert-n">${esc(name || '—')}</span>
      ${phone ? `<span class="expert-m">${esc(phone)}</span>` : ''}
    </div>
  </div>`;
}

function themeCss(id, dims) {
  // Explicit mm (ISO 216) — more reliable than named keywords like "A5" across print engines.
  const pageSize = dims.pageSizeCss
    || (dims.paper === 'THERMAL' ? `${dims.thermalMm}mm auto` : dims.paper);
  const pageMargin = dims.pageMargin || (dims.paper === 'THERMAL' ? '2mm' : '8mm');
  const sheetMinH = dims.heightMm > 0 ? `min-height:${dims.heightMm}mm;` : '';

  const common = `
  *{box-sizing:border-box;margin:0;padding:0}
  html{width:100%;min-width:100vw;min-height:100%;direction:rtl}
  body{font-family:'Vazirmatn',Tahoma,sans-serif;background:#EEF3EF;color:#12271C;padding:16px;font-size:${dims.font};width:100%;min-width:100%;min-height:100vh;display:flex;flex-direction:column;align-items:center;box-sizing:border-box}
  .sheet{width:100%;max-width:${dims.sheetMax};${sheetMinH}margin:0 auto;margin-inline:auto;background:#fff;position:relative;box-sizing:border-box;box-shadow:0 12px 32px rgba(18,39,28,.08)}
  .pad{padding:${dims.pad};width:100%;box-sizing:border-box}
  .num{font-variant-numeric:tabular-nums}
  .rtl{text-align:right}
  .brand-row{display:flex;gap:10px;align-items:center}
  .brand-sub{font-size:.85em;color:#5F7268}
  .thermal-brand{font-weight:800;color:#1A5C38;font-size:1.15em;margin-top:6px}
  .thermal-kind{color:#5F7268;margin-top:3px}
  .thermal-number{margin-top:4px}
  .thermal-customer{line-height:1.7}
  .row-desc{font-size:9px;color:#5F7268;margin-top:2px;font-weight:400;white-space:normal;overflow-wrap:anywhere;word-break:break-word;line-height:1.45}
  .warn-line{color:#b45309;font-size:11px;font-weight:700}
  .thanks{margin-top:6px;color:#8A7020;font-size:.85em;font-weight:600}
  .logo-box{background:#fff;border:1px solid #c5d6cc;border-radius:10px;padding:3px 8px;display:inline-flex;align-items:center}
  .logo-box img{display:block;height:${dims.logoH};background:transparent;mix-blend-mode:multiply}
  .pbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;margin:16px auto 0;background:linear-gradient(135deg,#1A5C38,#2E7D4F);color:#fff;border:none;padding:10px 22px;border-radius:10px;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(26,92,56,.25);transition:all .15s ease}
  .pbtn:hover{background:linear-gradient(135deg,#123F28,#1A5C38);transform:translateY(-1px);box-shadow:0 6px 16px rgba(26,92,56,.35)}
  .watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}
  .watermark span{transform:rotate(-25deg);font-size:32px;font-weight:800;color:rgba(220,38,38,.14);border:3px solid rgba(220,38,38,.14);border-radius:12px;padding:6px 18px;white-space:nowrap}
  table.items{width:100%;border-collapse:collapse;margin-top:6px}
  table.items th,table.items td{border:1px solid #c5d6cc;padding:6px 4px;text-align:center;vertical-align:middle}
  table.items th{background:#1A5C38;color:#fff;font-weight:700;font-size:.9em;line-height:1.3}
  table.items tbody tr:nth-child(even){background:#f6faf7}
  .expert{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;background:linear-gradient(90deg,#FDF3D9,#fff 60%);border:1px solid rgba(201,168,67,.55);border-radius:10px;padding:7px 10px;margin:8px 0}
  .expert-l{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
  .expert-t{font-size:.7em;font-weight:800;color:#8A7020;background:#fff;border:1px solid rgba(201,168,67,.45);border-radius:999px;padding:2px 8px}
  .expert-n{font-weight:800;color:#1A5C38}
  .expert-m{font-weight:700;direction:ltr}
  .note{margin-top:10px;font-size:.85em;color:#5F7268;background:#EDF3EE;border-radius:8px;padding:8px 10px;line-height:1.7}
  .footer-bar{background:#163F2A;color:#e8f2ec;text-align:center;padding:7px 8px;font-size:.78em;line-height:1.7}
  .footer-bar.light{background:#dce9e1;color:#12271C}
  .sum-box{border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;font-size:.92em;width:100%;box-sizing:border-box}
  .sum-box .line{display:flex;justify-content:space-between;padding:6px 9px;border-bottom:1px solid #c5d6cc}
  .sum-box .line.pay{background:#163F2A;color:#fff;font-weight:800;border:0}
  .sum-box .line.pay .gold{color:#C9A843}
  .receipts-box{margin-top:8px}
  .receipts-box .receipts-head{font-weight:700}
  .print-top-meta{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;font-size:.95em;font-weight:700;border-bottom:1px solid #c5d6cc;background:#fff;width:100%;box-sizing:border-box}
  .print-top-meta .print-top-num .num{font-weight:800}
  .print-top-meta .print-top-date{font-weight:700}
  .words{border:1px solid #c5d6cc;border-radius:8px;padding:8px 10px;line-height:1.8;font-size:.88em;background:#fbfdfb;display:flex;flex-direction:column;justify-content:center}
  .words-num{font-size:.92em;font-weight:700;color:#12271C}
  .words-fa{font-size:.86em;color:#1A5C38;margin-top:4px;font-weight:700;line-height:1.6;border-top:1px dashed #c5d6cc;padding-top:4px}
  .stamps{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;width:70%;max-width:420px;margin-inline:auto}
  .stamp{border:1px solid #c5d6cc;border-radius:6px;min-height:42px;text-align:center;padding:6px 8px;font-size:.72em;color:#5F7268;display:flex;flex-direction:column;justify-content:space-between}
  .stamp.dash{border-style:dashed;border-color:#2E7D4F}
  .stamp .t{font-weight:800;color:#1A5C38;margin-bottom:2px;font-size:.95em}
  .stamp-line{border-bottom:1px dotted #a8c4b8;margin-top:14px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;width:100%}
  .party{border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;min-width:0}
  .party h4{background:#eef5f0;color:#1A5C38;padding:5px 8px;font-size:.85em;font-weight:800;border-bottom:1px solid #c5d6cc}
  .party .b{padding:7px 8px;line-height:1.75;font-size:.88em}
  .party .b b{color:#5F7268;font-weight:600}
  .meta-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:0;border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;margin-bottom:8px;font-size:.78em;width:100%}
  .meta-strip .c{padding:6px 7px;border-left:1px solid #c5d6cc;background:#fbfdfb;min-width:0}
  .meta-strip b{display:block;color:#5F7268;font-weight:600}
  .meta-strip span{font-weight:700}
  .sum-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:10px;margin-top:10px;width:100%}
  @media print{
    html,body{display:block;width:auto;min-width:0;min-height:0;background:#fff;padding:0}
    .sheet{box-shadow:none!important;border-radius:0!important;max-width:100%!important;width:100%!important}
    .pbtn{display:none!important}
    @page{size:${pageSize};margin:${pageMargin}}
  }
  @media screen and (max-width:420px){
    .parties,.sum-grid,.stamps,.meta-strip{grid-template-columns:1fr!important}
  }
  `;

  const themes = {
    // ── اداری / مالیاتی: بنر سبز رسمی، جعبه‌های واضح فروشنده/خریدار، قاب مربع پررنگ
    'formal-official': `
      .sheet{border:1.5px solid #1A5C38;border-radius:0}
      .off-banner{background:#1A5C38;color:#fff;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:9px 12px}
      .off-banner .serial{font-size:.8em;line-height:1.85}
      .off-banner .serial b{color:#C9A843;font-weight:700}
      .off-banner .serial .num{font-weight:800}
      .off-banner .title{text-align:center;font-size:1.16em;font-weight:800;letter-spacing:.3px}
      .off-banner .kind{text-align:left;font-size:.86em;font-weight:800;color:#C9A843}
      .off-gold{height:3px;background:#C9A843}
      .off-ident{display:flex;align-items:center;gap:12px;border-bottom:2px solid #1A5C38;padding:8px 0 9px;margin-bottom:9px}
      .off-ident .name{font-size:1.08em;font-weight:800;color:#1A5C38}
      .off-ident .sub{font-size:.78em;color:#5F7268;margin-top:2px}
      .off-ident .spacer{flex:1}
      .off-ident .co-meta{font-size:.77em;line-height:1.85;color:#5F7268;text-align:left}
      .off-ident .co-meta b{color:#12271C;font-weight:600}
      .party h4{background:#1A5C38;color:#fff;border-bottom:0}
      .party .b b{color:#5F7268}
      table.items th{border-color:#0f3d24}
      ${dims.paper === 'A5' ? '.off-banner{grid-template-columns:1fr;text-align:center}.off-banner .kind,.off-banner .serial{text-align:center}.off-ident{flex-direction:column;align-items:stretch;text-align:center}.off-ident .co-meta{text-align:center}.meta-strip{grid-template-columns:1fr 1fr}.stamps{grid-template-columns:1fr 1fr}' : ''}
    `,
    // ── مدرن ERP: هدر گرادیانی، گوشه‌های نرم، چیپ‌های متادیتا، کارت‌های سایه‌دار
    'formal-modern': `
      .sheet{border-radius:18px;border:1px solid rgba(18,39,28,.1);overflow:hidden;box-shadow:0 16px 40px rgba(18,39,28,.12)}
      .mod-header{background:linear-gradient(120deg,#123F28,#1A5C38 45%,#2E7D4F);color:#fff;padding:15px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
      .mod-header .brand-row .name{font-size:1.24em;font-weight:800;color:#fff}
      .mod-header .brand-sub{color:rgba(255,255,255,.82)}
      .mod-header .logo-box{background:rgba(255,255,255,.92);border-color:rgba(255,255,255,.5)}
      .mod-chips{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .mod-chip{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.28);border-radius:14px;padding:5px 12px;font-size:.8em;line-height:1.35;text-align:center;min-width:66px}
      .mod-chip b{display:block;font-size:.82em;opacity:.82;font-weight:600;margin-bottom:1px}
      .mod-chip span{font-weight:800}
      .party{border-radius:14px;border-color:rgba(18,39,28,.12)}
      .party::before{content:"";display:block;height:3px;background:linear-gradient(90deg,#1A5C38,#C9A843)}
      .party h4{background:#EDF3EE}
      .meta-strip{border-radius:12px}
      table.items{border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(18,39,28,.06)}
      table.items th{background:linear-gradient(90deg,#1A5C38,#2E7D4F);border-color:rgba(255,255,255,.16)}
      .sum-box{border-radius:12px}
      .sum-box .line.pay{background:linear-gradient(90deg,#1A5C38,#2E7D4F)}
      .stamp{border-radius:12px}
      ${dims.paper === 'A5' ? '.mod-header{flex-direction:column;align-items:stretch}.mod-chips{justify-content:center}.meta-strip{grid-template-columns:1fr 1fr}.stamps{grid-template-columns:1fr 1fr}' : ''}
    `,
    // ── لوکس: قاب سبز/طلایی، هیرو برند، خط طلایی تزئینی، سرستون تیره
    'formal-premium': `
      .sheet{border-radius:16px;overflow:hidden;border:2.5px solid transparent;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(120deg,#1A5C38,#C9A843,#2E7D4F,#C9A843) border-box}
      .hero{background:linear-gradient(115deg,#123F28,#1A5C38 45%,#2E7D4F);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;gap:10px;align-items:center;position:relative}
      .hero .name{font-weight:800;font-size:1.3em;letter-spacing:.3px}
      .hero .sub{opacity:.85;font-size:.82em;margin-top:3px}
      .hero .logo-box{background:rgba(255,255,255,.94);border-color:rgba(201,168,67,.6)}
      .hero .meta{text-align:left;font-size:.9em;line-height:1.75}
      .hero .meta .tag{display:inline-block;background:#C9A843;color:#12271C;font-weight:800;font-size:.82em;border-radius:6px;padding:2px 9px;margin-bottom:4px}
      .hero .meta .num{font-weight:800}
      .prem-rule{height:4px;background:linear-gradient(90deg,#C9A843,#1A5C38 50%,#C9A843)}
      .party{border-color:rgba(201,168,67,.55)}
      .party h4{background:linear-gradient(90deg,#1A5C38,#2E7D4F);color:#fff;border-bottom:0}
      .meta-strip{border-color:rgba(201,168,67,.5)}
      .meta-strip .c{border-left-color:rgba(201,168,67,.35)}
      table.items th{background:#163F2A;border-color:#0d3320}
      .sum-box{border-color:rgba(201,168,67,.6)}
      .sum-box .line{border-bottom-color:rgba(201,168,67,.35)}
      .sum-box .line.pay{background:#163F2A}
      .sum-box .line.pay .gold{color:#C9A843}
      .words{border-color:rgba(201,168,67,.5);background:#FEFBF2}
      .stamp{border-color:rgba(201,168,67,.5)}
      .stamp .t{color:#1A5C38}
      ${dims.paper === 'A5' ? '.hero{flex-direction:column;align-items:stretch;text-align:center}.hero .meta{text-align:center}.meta-strip{grid-template-columns:1fr 1fr}.stamps{grid-template-columns:1fr 1fr}' : ''}
    `,
    'casual-simple': `
      .sheet{border-radius:12px;border:1px solid rgba(18,39,28,.1);overflow:hidden;box-shadow:0 8px 22px rgba(18,39,28,.06)}
      .top-simple{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;border-bottom:2px solid #C9A843;padding-bottom:10px;margin-bottom:10px}
      .top-simple .title{font-size:1.15em;font-weight:800;color:#1A5C38}
      .inv-meta .box{border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;min-width:140px}
      .inv-meta .row{display:flex;justify-content:space-between;padding:5px 8px;border-bottom:1px solid #c5d6cc;font-size:.9em}
      .inv-meta .row:last-child{border-bottom:0}
      .inv-meta .row span:last-child{font-weight:800;color:#b91c1c}
      .meta-strip{grid-template-columns:repeat(4,1fr)}
      ${dims.paper === 'A5' ? '.meta-strip{grid-template-columns:1fr 1fr}.stamps{grid-template-columns:1fr 1fr}' : ''}
    `,
    thermal: `
      body{background:#fff;padding:4px}
      .sheet{max-width:${dims.sheetMax};border:none;box-shadow:none}
      .center{text-align:center}
      .dash{border:0;border-top:1px dashed #999;margin:6px 0}
      table.items th{background:transparent;color:#1A5C38;border:0;border-bottom:1px dashed #999;padding:4px 2px}
      table.items td{border:0;border-bottom:1px dotted #ddd;padding:4px 2px;font-size:.95em}
      table.items tbody tr:nth-child(even){background:transparent}
      .expert{border-radius:0;padding:4px 0;background:transparent;border:0;border-top:1px dashed #ccc;border-bottom:1px dashed #ccc;justify-content:center}
      .expert-l{justify-content:center;width:100%}
      .sum-box{border:0;border-radius:0}
      .sum-box .line{border-bottom:1px dashed #ccc;padding:4px 0}
      .sum-box .line.pay{background:transparent;color:#1A5C38;border-top:2px solid #1A5C38;justify-content:space-between}
      .sum-box .line.pay .gold{color:#1A5C38}
      .footer-bar{background:transparent;color:#5F7268;border-top:1px dashed #999}
      .logo-box{border:none;padding:0}
    `,
  };

  return common + (themes[id] || themes['formal-official']);
}

function payTypeFa(pt) {
  return {
    cash: 'نقد',
    cheque: 'چک',
    credit: 'نسیه',
    bank_transfer: 'واریز بانکی',
    bank: 'واریز بانکی',
    pos_card: 'کارتخوان',
    mixed: 'چندمرحله‌ای',
  }[pt] || pt || '—';
}

function payLabel(inv) {
  return payTypeFa(inv && inv.pay_type);
}

function normalizePrintReceipts(opts) {
  const list = [];
  const settlements = (opts && opts.settlements) || [];
  const pos = (opts && opts.posReceipts) || [];
  for (const s of settlements) {
    const dest = s.bank_name || s.cash_box_name || s.cheque_bank || s.account_code || '';
    list.push({
      kind: 'settlement',
      pay_type: s.pay_type,
      label: payTypeFa(s.pay_type),
      amount: Math.round(Number(s.amount_rial != null ? s.amount_rial : s.amount) || 0),
      dest: dest || (s.pay_type === 'cheque' ? 'اسناد دریافتنی' : ''),
      detail: s.pay_type === 'cheque'
        ? [s.cheque_number, s.cheque_sayadi, s.cheque_due].filter(Boolean).join(' · ')
        : (s.note || ''),
    });
  }
  for (const p of pos) {
    list.push({
      kind: 'pos',
      pay_type: 'pos_card',
      label: 'کارتخوان',
      amount: Math.round(Number(p.amount_rial != null ? p.amount_rial : p.amount) || 0),
      dest: p.terminal_name || 'در جریان',
      detail: p.note || '',
    });
  }
  return list;
}

function receiptsHtml(receipts, payable, isPurchase) {
  if (!receipts || !receipts.length) return '';
  const paid = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const remain = Math.max(0, Math.round(Number(payable) || 0) - paid);
  const verb = isPurchase ? 'پرداخت' : 'دریافت';
  const rows = receipts.map((r, i) => `
    <div class="line"><span>${esc(verb)} ${faNum(i + 1)} — ${esc(r.label)}${r.dest ? ` (${esc(r.dest)})` : ''}${r.detail ? ` · ${esc(r.detail)}` : ''}</span><span class="num">${faNum(r.amount)} ریال</span></div>`).join('');
  return `
    <div class="sum-box receipts-box">
      <div class="line receipts-head"><span>${esc(verb)}‌های ثبت‌شده</span><span></span></div>
      ${rows}
      <div class="line"><span>جمع ${esc(verb)}</span><span class="num">${faNum(paid)} ریال</span></div>
      <div class="line"><span>مانده</span><span class="num">${faNum(remain)} ریال</span></div>
    </div>`;
}

function renderInvoicePrintHtml(opts) {
  const inv = opts.inv || {};
  const settings = opts.settings || {};
  const customize = parseCustomize(settings.invoice_customize);
  const dims = paperDims(opts.paper || settings.invoice_paper_size || 'A4', settings);
  const templateId = resolveTemplateId(inv.type, settings, {
    paper: dims.paper === 'THERMAL' ? 'THERMAL' : (opts.paper || ''),
    templateOverride: opts.templateOverride || (dims.paper === 'THERMAL' ? THERMAL_ID : undefined),
  });
  const isThermal = templateId === THERMAL_ID;
  const rows = collapsePrintRows(opts.rows || [], isThermal ? { thermal: true } : undefined);
  const isA5 = dims.paper === 'A5';
  const htmlClass = [
    'inv-print',
    isThermal ? `paper-thermal paper-thermal-${dims.thermalMm}` : (isA5 ? 'paper-a5' : 'paper-a4'),
    `tmpl-${templateId}`,
  ].join(' ');
  const typeLabel = isThermal
    ? 'فاکتور حرارتی'
    : (inv.doc_kind === 'purchase' || inv.type === 'purchase'
      ? 'فاکتور خرید'
      : (inv.type === 'final' ? 'فاکتور رسمی' : inv.type === 'normal' ? 'فاکتور فروش' : 'پیش‌فاکتور'));
  const isPurchase = inv.doc_kind === 'purchase' || inv.type === 'purchase';
  const counterpartyTitle = isPurchase ? 'مشخصات فروشنده' : 'مشخصات خریدار';
  const companyPartyTitle = isPurchase ? 'مشخصات خریدار' : 'مشخصات فروشنده';
  const t = computePrintTotals(inv, rows);
  const receipts = normalizePrintReceipts(opts);
  // Prefer settlement sum (POS also creates a settlement); avoid double-count.
  const paidSett = receipts.filter((r) => r.kind === 'settlement')
    .reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const paidPos = receipts.filter((r) => r.kind === 'pos')
    .reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const paidTotal = paidSett > 0 ? paidSett : paidPos;
  const invoiceFinal = t.payable;
  const duePayable = Math.max(0, invoiceFinal - paidTotal);
  const receiptsBlock = receiptsHtml(receipts, invoiceFinal, isPurchase);
  const emptyColspan = isA5 ? 6 : 9;
  const topMeta = `
    <div class="print-top-meta">
      <span class="print-top-num"><b>شماره:</b> <span class="num">${esc(inv.num || '')}</span></span>
      <span class="print-top-date"><b>تاریخ:</b> ${esc(inv.date || '—')}</span>
    </div>`;
  const isProvisional = String(inv.num || '').startsWith('موقت');
  const companyName = settings.company_name || 'پوشاک ترنم';
  const companyAddr = settings.company_address || '';
  const companyPhone = settings.company_phone || '';
  const subtitle = customize.subtitle || 'تولیدی پوشاک زنانه';
  const payTypeLabel = payLabel(inv);
  const logo = logoHtml(customize, dims);
  const expert = expertHtml(inv, customize);

  let payExtra = '';
  if (customize.show_payment && inv.pay_type === 'cheque') {
    if (inv.cheque_duration) payExtra += ` · مدت ${esc(inv.cheque_duration)} روز`;
    if (inv.cheque_due_date) payExtra += ` · سررسید ${esc(inv.cheque_due_date)}`;
  }
  if (customize.show_payment && receipts.length) {
    const paidSum = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    payExtra += ` · ${isPurchase ? 'پرداخت' : 'دریافت'} ${faNum(paidSum)} ریال`;
  }

  const noteHtml = (customize.show_note && inv.note)
    ? `<div class="note"><b>توضیحات:</b> ${esc(inv.note)}</div>` : '';
  const footerText = customize.footer_text
    ? esc(customize.footer_text)
    : `این ${typeLabel} در تاریخ ${esc(inv.date || '')} صادر شده است.`;
  const contactLine = [
    companyName,
    customize.show_company_address && companyAddr ? companyAddr : '',
    customize.show_company_phone && companyPhone ? companyPhone : '',
  ].filter(Boolean).join(' · ');

  const companyEconomicCode = settings.company_economic_code || settings.economic_code || '';
  const companyNationalId = settings.company_national_id || settings.national_id || '';
  const companyPostalCode = settings.company_postal_code || settings.postal_code || '';

  const custEconomicCode = inv.cust_economic_code || inv.economic_code || '';
  const custNationalId = inv.cust_national_id || inv.national_id || inv.cust_code || '';
  const custPostalCode = inv.cust_postal_code || inv.postal_code || '';
  const custAddr = inv.cust_address || inv.address || '';

  const sellerBits = `
    <div><b>نام:</b> ${esc(companyName)}</div>
    ${companyEconomicCode ? `<div><b>کد اقتصادی:</b> ${esc(companyEconomicCode)}</div>` : ''}
    ${companyNationalId ? `<div><b>شناسه ملی:</b> ${esc(companyNationalId)}</div>` : ''}
    ${customize.show_company_address ? `<div><b>نشانی:</b> ${esc(companyAddr || '—')}</div>` : ''}
    ${customize.show_company_phone ? `<div><b>تلفن:</b> ${esc(companyPhone || '—')}</div>` : ''}
    ${companyPostalCode ? `<div><b>کد پستی:</b> ${esc(companyPostalCode)}</div>` : ''}
    ${customize.show_payment ? `<div><b>پرداخت:</b> ${esc(payTypeLabel)}${payExtra}</div>` : ''}`;

  const buyerBits = `
    <div><b>نام:</b> ${esc(inv.cust_biz || '—')}${inv.cust_owner ? ' — ' + esc(inv.cust_owner) : ''}</div>
    ${custEconomicCode ? `<div><b>کد اقتصادی:</b> ${esc(custEconomicCode)}</div>` : ''}
    ${custNationalId ? `<div><b>شناسه/کد ملی:</b> ${esc(custNationalId)}</div>` : ''}
    <div><b>شهر:</b> ${esc(inv.cust_city || '—')}</div>
    ${custAddr ? `<div><b>نشانی:</b> ${esc(custAddr)}</div>` : ''}
    <div><b>تلفن:</b> ${esc(inv.cust_phone || '—')}</div>
    ${custPostalCode ? `<div><b>کد پستی:</b> ${esc(custPostalCode)}</div>` : ''}`;

  const payableWords = numToPersianWords(duePayable);
  const wordsHtml = `
    <div class="words">
      <div class="words-num"><b>مبلغ قابل پرداخت:</b> <span class="num">${faNum(duePayable)}</span> ریال</div>
      <div class="words-fa"><b>به حروف:</b> ${esc(payableWords)} ریال</div>
      ${noteHtml || '<div class="thanks">با تشکر از انتخاب شما</div>'}
    </div>`;

  const formalHead = isA5
    ? `<tr><th>ردیف</th><th>شرح</th><th>تعداد</th><th>فی</th><th>تخفیف ردیف</th><th>جمع</th></tr>`
    : `<tr><th>ردیف</th><th>کد</th><th>شرح کالا / خدمات</th><th>واحد</th><th>تعداد</th><th>فی (ریال)</th><th>مبلغ</th><th>تخفیف ردیف</th><th>پس از تخفیف</th></tr>`;

  const sumBox = `
    <div class="sum-box">
      <div class="line"><span>جمع اقلام</span><span class="num">${faNum(t.rowsNet)} ریال</span></div>
      ${customize.show_discount && t.discLines ? `<div class="line"><span>جمع تخفیف ردیفی</span><span class="num disc">${faNum(t.discLines)} ریال</span></div>` : ''}
      ${customize.show_discount && (t.discAmt || t.discPct) ? `<div class="line"><span>تخفیف کل${t.discPct ? ` (${faNum(t.discPct)}٪)` : ''}</span><span class="num">${faNum(t.discAmt)} ریال</span></div>` : ''}
      ${t.freight ? `<div class="line"><span>کرایه حمل${inv.freight_type ? ` (${esc(freightTypeFa(inv.freight_type))})` : ''}</span><span class="num">${faNum(t.freight)} ریال</span></div>` : ''}
      ${t.vat ? `<div class="line"><span>مالیات بر ارزش افزوده${t.vatRate ? ` (${faNum(t.vatRate)}٪)` : ''}</span><span class="num">${faNum(t.vat)} ریال</span></div>` : ''}
      ${paidTotal > 0 ? `<div class="line"><span>مبلغ فاکتور</span><span class="num">${faNum(invoiceFinal)} ریال</span></div>` : ''}
      <div class="line pay"><span>مبلغ قابل پرداخت</span><span class="num gold">${faNum(duePayable)} ریال</span></div>
      ${t.mismatch ? `<div class="line warn-line"><span>هشدار</span><span>جمع سربرگ (${faNum(t.subtotal)}) با جمع اقلام یکی نیست</span></div>` : ''}
    </div>${receiptsBlock}`;

  const stamps = `
    <div class="stamps">
      <div class="stamp"><div class="t">مهر و امضای خریدار</div><div class="stamp-line"></div></div>
      <div class="stamp"><div class="t">مهر و امضای فروشنده</div><div class="stamp-line"></div></div>
    </div>`;

  let bodyInner = '';

  if (isThermal) {
    bodyInner = `
      ${topMeta}
      <div class="pad">
        <div class="center">
          ${logo}
          <div class="thermal-brand">${esc(companyName)}</div>
          ${customize.show_company_phone && companyPhone ? `<div>${esc(companyPhone)}</div>` : ''}
        </div>
        <hr class="dash">
        <div class="center thermal-customer">
          ${esc(inv.cust_biz || '')}${inv.cust_owner ? ' — ' + esc(inv.cust_owner) : ''}<br>
          ${esc(inv.cust_phone || '')}
        </div>
        ${expert}
        <hr class="dash">
        <table class="items">
          <thead><tr><th>شرح</th><th>تعداد</th><th>تخفیف</th><th>جمع</th></tr></thead>
          <tbody>${buildThermalRows(rows) || '<tr><td colspan="4">—</td></tr>'}</tbody>
        </table>
        <hr class="dash">
        ${sumBox}
        ${noteHtml}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else if (templateId === 'casual-simple') {
    bodyInner = `
      ${topMeta}
      <div class="pad">
        <div class="top-simple">
          <div class="brand-row">
            ${logo}
            <div>
              <div class="title">${esc(companyName)}</div>
              <div class="brand-sub">${esc(subtitle)} · ${esc(typeLabel)}</div>
            </div>
          </div>
        </div>
        <div class="parties">
          <div class="party"><h4>${counterpartyTitle}</h4><div class="b">${buyerBits}</div></div>
          <div class="party"><h4>${companyPartyTitle}</h4><div class="b">${sellerBits}</div></div>
        </div>
        <div class="meta-strip">
          <div class="c"><b>نوع</b><span>${esc(typeLabel)}</span></div>
          <div class="c"><b>پرداخت</b><span>${esc(payTypeLabel)}</span></div>
          <div class="c"><b>کاغذ</b><span>${dims.paper}</span></div>
          <div class="c"><b>سررسید</b><span>${esc(inv.cheque_due_date || '—')}</span></div>
        </div>
        ${expert}
        <table class="items">
          <thead><tr><th>ردیف</th><th>شرح کالا</th><th>واحد</th><th>تعداد</th><th>فی</th><th>تخفیف ردیف</th><th>جمع</th></tr></thead>
          <tbody>${buildCasualRows(rows) || '<tr><td colspan="7">بدون ردیف</td></tr>'}</tbody>
        </table>
        <div class="sum-grid">
          ${sumBox}
          ${wordsHtml}
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar light">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else if (templateId === 'formal-premium') {
    // لوکس: هیرو برند سبز/طلایی + خط تزئینی طلایی + قاب گرادیانی
    bodyInner = `
      ${topMeta}
      <div class="hero">
        <div class="brand-row">
          ${logo}
          <div>
            <div class="name">${esc(companyName)}</div>
            <div class="sub">${esc(subtitle)} · صورتحساب فروش کالا و خدمات</div>
          </div>
        </div>
      </div>
      <div class="prem-rule"></div>
      <div class="pad">
        <div class="parties">
          <div class="party"><h4>${companyPartyTitle}</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>${counterpartyTitle}</h4><div class="b">${buyerBits}</div></div>
        </div>
        <div class="meta-strip">
          <div class="c"><b>نوع فاکتور</b><span>فروش رسمی</span></div>
          <div class="c"><b>پرداخت</b><span>${esc(payTypeLabel)}</span></div>
          <div class="c"><b>سررسید</b><span>${esc(inv.cheque_due_date || '—')}</span></div>
          <div class="c"><b>تاریخ</b><span>${esc(inv.date || '—')}</span></div>
          <div class="c"><b>شماره</b><span class="num">${esc(inv.num || '')}</span></div>
        </div>
        ${expert}
        <table class="items">
          <thead>${formalHead}</thead>
          <tbody>${buildFormalRows(rows, isA5) || `<tr><td colspan="${emptyColspan}">بدون ردیف</td></tr>`}</tbody>
        </table>
        <div class="sum-grid">${sumBox}${wordsHtml}</div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else if (templateId === 'formal-modern') {
    // مدرن ERP: هدر گرادیانی + کارت‌های نرم
    bodyInner = `
      ${topMeta}
      <div class="mod-header">
        <div class="brand-row">
          ${logo}
          <div>
            <div class="name">${esc(companyName)}</div>
            <div class="brand-sub">${esc(subtitle)} · ${esc(typeLabel)}</div>
          </div>
        </div>
      </div>
      <div class="pad">
        <div class="parties">
          <div class="party"><h4>${companyPartyTitle}</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>${counterpartyTitle}</h4><div class="b">${buyerBits}</div></div>
        </div>
        ${expert}
        <table class="items">
          <thead>${formalHead}</thead>
          <tbody>${buildFormalRows(rows, isA5) || `<tr><td colspan="${emptyColspan}">بدون ردیف</td></tr>`}</tbody>
        </table>
        <div class="sum-grid">
          ${sumBox}
          ${wordsHtml}
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else {
    // اداری / مالیاتی (formal-official): ردیف شماره/تاریخ + هویت شرکت + جعبه‌های فروشنده/خریدار
    bodyInner = `
      ${topMeta}
      <div class="off-gold"></div>
      <div class="pad">
        <div class="off-ident">
          ${logo}
          <div>
            <div class="name">${esc(companyName)}</div>
            <div class="sub">${esc(subtitle)}</div>
          </div>
          <div class="spacer"></div>
          <div class="co-meta">
            ${customize.show_company_phone && companyPhone ? `<div><b>تلفن:</b> ${esc(companyPhone)}</div>` : ''}
            ${customize.show_company_address && companyAddr ? `<div><b>نشانی:</b> ${esc(companyAddr)}</div>` : ''}
            <div><b>کاغذ:</b> ${dims.paper}</div>
          </div>
        </div>
        <div class="parties">
          <div class="party"><h4>${companyPartyTitle}</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>${counterpartyTitle}</h4><div class="b">${buyerBits}</div></div>
        </div>
        <div class="meta-strip">
          <div class="c"><b>نوع</b><span>${esc(typeLabel)}</span></div>
          <div class="c"><b>پرداخت</b><span>${esc(payTypeLabel)}</span></div>
          <div class="c"><b>سررسید</b><span>${esc(inv.cheque_due_date || '—')}</span></div>
          <div class="c"><b>زیرعنوان</b><span>${esc(subtitle)}</span></div>
          <div class="c"><b>مدل</b><span>اداری</span></div>
        </div>
        ${expert}
        <table class="items">
          <thead>${formalHead}</thead>
          <tbody>${buildFormalRows(rows, isA5) || `<tr><td colspan="${emptyColspan}">بدون ردیف</td></tr>`}</tbody>
        </table>
        <div class="sum-grid">
          ${sumBox}
          ${wordsHtml}
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  }

  const printLabel = isThermal
    ? `چاپ حرارتی (${dims.thermalMm}mm)`
    : `چاپ فاکتور (${dims.paper})`;

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl" class="${esc(htmlClass)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(typeLabel)} ${esc(inv.num || '')}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<link href="/invoice-print.css?v=243" rel="stylesheet">
<style>${themeCss(templateId, dims)}
html.inv-print .sheet,html.inv-print .sheet *:not(.pbtn):not(img):not(svg):not(path){color:#000!important;-webkit-text-fill-color:#000!important;border-color:#000!important;outline-color:#000!important;text-shadow:none!important;box-shadow:none!important;background-color:#fff!important;background-image:none!important;opacity:1!important}
html.inv-print .sheet *::before,html.inv-print .sheet *::after{color:#000!important;border-color:#000!important;background-image:none!important;opacity:1!important}
html.inv-print .watermark span{color:#000!important;border-color:#000!important;opacity:.18}
html.inv-print table,html.inv-print th,html.inv-print td,html.inv-print .sheet{border-color:#000!important}
html.inv-print .off-gold,html.inv-print .prem-rule,html.inv-print .party::before{background:#000!important;background-image:none!important}
</style>
</head>
<body>
  <div class="sheet">
    ${isProvisional ? `<div class="watermark"><span>پیش‌نویس — در انتظار شماره رسمی</span></div>` : ''}
    ${bodyInner}
    <button class="pbtn" type="button" data-print>${printLabel}</button>
  </div>
  <script src="/print-page.js"></script>
</body>
</html>`;
}

module.exports = {
  FORMAL_IDS, CASUAL_IDS, THERMAL_ID, DEFAULT_CUSTOMIZE, ISO_PAPER,
  parseCustomize, resolveTemplateId, normalizeCasual, thermalWidthMm,
  renderInvoicePrintHtml, computePrintTotals, faNum, esc, paperDims,
  collapsePrintRows,
};
