/**
 * Invoice print templates — ERP ترنم
 * Formal (final): formal-official | formal-modern | formal-premium
 * Casual (proforma): casual-simple only
 * Thermal printers: thermal (58mm / 80mm)
 * Paper: A4 | A5 | THERMAL
 */
'use strict';

const FORMAL_IDS = ['formal-official', 'formal-modern', 'formal-premium'];
const CASUAL_IDS = ['casual-simple'];
const THERMAL_ID = 'thermal';
/** @deprecated kept for migrating old settings */
const LEGACY_CASUAL = ['casual-compact', 'casual-receipt'];

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
      sheetMax: mm === 58 ? '220px' : '300px',
      pad: mm === 58 ? '8px' : '10px',
      font: mm === 58 ? '10px' : '11px',
      logoH: mm === 58 ? '36px' : '42px',
    };
  }
  const isA5 = p === 'A5';
  return {
    paper: isA5 ? 'A5' : 'A4',
    thermalMm: 0,
    sheetMax: isA5 ? '520px' : '820px',
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
  return (rows || []).map((r, i) => {
    const disc = lineDiscOf(r);
    return `<tr>
      <td class="rtl">${esc(r.name || '')}</td>
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
  const pageSize = dims.paper === 'THERMAL'
    ? `${dims.thermalMm}mm auto`
    : dims.paper;
  const pageMargin = dims.paper === 'THERMAL' ? '2mm' : '8mm';

  const common = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Vazirmatn',Tahoma,sans-serif;background:#EEF3EF;color:#12271C;padding:12px;font-size:${dims.font}}
  .sheet{max-width:${dims.sheetMax};margin:0 auto;background:#fff;position:relative}
  .pad{padding:${dims.pad}}
  .num{font-variant-numeric:tabular-nums}
  .rtl{text-align:right}
  .brand-row{display:flex;gap:10px;align-items:center}
  .brand-sub{font-size:.85em;color:#5F7268}
  .thermal-brand{font-weight:800;color:#1A5C38;font-size:1.15em;margin-top:6px}
  .thermal-kind{color:#5F7268;margin-top:3px}
  .thermal-number{margin-top:4px}
  .thermal-customer{line-height:1.7}
  .row-desc{font-size:9px;color:#5F7268;margin-top:2px;font-weight:400}
  .disc{color:#b45309;font-weight:700}
  .logo-box{background:#fff;border:1px solid #c5d6cc;border-radius:10px;padding:3px 8px;display:inline-flex;align-items:center}
  .logo-box img{display:block;height:${dims.logoH};background:transparent;mix-blend-mode:multiply}
  .pbtn{display:block;margin:14px auto 0;background:#1A5C38;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-family:inherit;font-size:13px;cursor:pointer}
  .watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}
  .watermark span{transform:rotate(-25deg);font-size:32px;font-weight:800;color:rgba(220,38,38,.14);border:3px solid rgba(220,38,38,.14);border-radius:12px;padding:6px 18px;white-space:nowrap}
  table.items{width:100%;border-collapse:collapse;margin-top:4px}
  table.items th,table.items td{border:1px solid #c5d6cc;padding:5px 3px;text-align:center;vertical-align:middle}
  table.items th{background:#1A5C38;color:#fff;font-weight:700;font-size:.9em;line-height:1.3}
  table.items tbody tr:nth-child(even){background:#f3f8f5}
  .expert{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;background:linear-gradient(90deg,#FDF3D9,#fff 60%);border:1px solid rgba(201,168,67,.55);border-radius:10px;padding:7px 10px;margin:8px 0}
  .expert-l{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
  .expert-t{font-size:.7em;font-weight:800;color:#8A7020;background:#fff;border:1px solid rgba(201,168,67,.45);border-radius:999px;padding:2px 8px}
  .expert-n{font-weight:800;color:#1A5C38}
  .expert-m{font-weight:700;direction:ltr}
  .note{margin-top:10px;font-size:.85em;color:#5F7268;background:#EDF3EE;border-radius:8px;padding:8px 10px;line-height:1.7}
  .footer-bar{background:#163F2A;color:#e8f2ec;text-align:center;padding:7px 8px;font-size:.78em;line-height:1.7}
  .footer-bar.light{background:#dce9e1;color:#12271C}
  .sum-box{border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;font-size:.92em}
  .sum-box .line{display:flex;justify-content:space-between;padding:6px 9px;border-bottom:1px solid #c5d6cc}
  .sum-box .line.pay{background:#163F2A;color:#fff;font-weight:800;border:0}
  .sum-box .line.pay .gold{color:#C9A843}
  .words{border:1px solid #c5d6cc;border-radius:8px;padding:8px 10px;line-height:1.8;font-size:.88em;background:#fbfdfb}
  .stamps{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
  .stamp{border:1px solid #c5d6cc;border-radius:8px;min-height:70px;text-align:center;padding:8px;font-size:.8em;color:#5F7268}
  .stamp.dash{border-style:dashed;border-color:#2E7D4F}
  .stamp .t{font-weight:800;color:#1A5C38;margin-bottom:4px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
  .party{border:1px solid #c5d6cc;border-radius:8px;overflow:hidden}
  .party h4{background:#eef5f0;color:#1A5C38;padding:5px 8px;font-size:.85em;font-weight:800;border-bottom:1px solid #c5d6cc}
  .party .b{padding:7px 8px;line-height:1.75;font-size:.88em}
  .party .b b{color:#5F7268;font-weight:600}
  .meta-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:0;border:1px solid #c5d6cc;border-radius:8px;overflow:hidden;margin-bottom:8px;font-size:.78em}
  .meta-strip .c{padding:6px 7px;border-left:1px solid #c5d6cc;background:#fbfdfb}
  .meta-strip b{display:block;color:#5F7268;font-weight:600}
  .meta-strip span{font-weight:700}
  .sum-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:10px;margin-top:10px}
  @media print{
    body{background:#fff;padding:0}
    .sheet{box-shadow:none!important;border-radius:0!important;max-width:100%!important}
    .pbtn{display:none}
    @page{size:${pageSize};margin:${pageMargin}}
  }
  @media (max-width:640px){
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

function payLabel(inv) {
  return { cash: 'نقد', cheque: 'چک', credit: 'نسیه', bank_transfer: 'واریز بانکی' }[inv.pay_type] || inv.pay_type || 'نقد';
}

function renderInvoicePrintHtml(opts) {
  const inv = opts.inv || {};
  const rows = opts.rows || [];
  const settings = opts.settings || {};
  const customize = parseCustomize(settings.invoice_customize);
  const dims = paperDims(opts.paper || settings.invoice_paper_size || 'A4', settings);
  const templateId = resolveTemplateId(inv.type, settings, {
    paper: dims.paper === 'THERMAL' ? 'THERMAL' : (opts.paper || ''),
    templateOverride: opts.templateOverride || (dims.paper === 'THERMAL' ? THERMAL_ID : undefined),
  });
  const isThermal = templateId === THERMAL_ID;
  const isA5 = dims.paper === 'A5';
  const typeLabel = isThermal
    ? 'فاکتور حرارتی'
    : (inv.type === 'final' ? 'فاکتور رسمی' : inv.type === 'normal' ? 'فاکتور فروش' : 'پیش‌فاکتور');
  const t = computePrintTotals(inv, rows);
  const emptyColspan = isA5 ? 6 : 9;
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

  const sellerBits = `
    <div><b>نام:</b> ${esc(companyName)}</div>
    ${customize.show_company_address ? `<div><b>نشانی:</b> ${esc(companyAddr || '—')}</div>` : ''}
    ${customize.show_company_phone ? `<div><b>تلفن:</b> ${esc(companyPhone || '—')}</div>` : ''}
    ${customize.show_payment ? `<div><b>پرداخت:</b> ${esc(payTypeLabel)}${payExtra}</div>` : ''}`;

  const buyerBits = `
    <div><b>نام:</b> ${esc(inv.cust_biz || '—')}${inv.cust_owner ? ' — ' + esc(inv.cust_owner) : ''}</div>
    <div><b>شهر:</b> ${esc(inv.cust_city || '—')}</div>
    <div><b>تلفن:</b> ${esc(inv.cust_phone || '—')}</div>`;

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
      <div class="line pay"><span>مبلغ قابل پرداخت</span><span class="num gold">${faNum(t.payable)} ریال</span></div>
      ${t.mismatch ? `<div class="line" style="color:#b45309;font-size:11px"><span>هشدار</span><span>جمع سربرگ (${faNum(t.subtotal)}) با جمع اقلام یکی نیست</span></div>` : ''}
    </div>`;

  const stamps = `
    <div class="stamps">
      <div class="stamp"><div class="t">مهر و امضای خریدار</div></div>
      <div class="stamp dash"><div class="t">مهر شرکت</div></div>
      <div class="stamp"><div class="t">مهر و امضای فروشنده</div></div>
    </div>`;

  let bodyInner = '';

  if (isThermal) {
    bodyInner = `
      <div class="pad">
        <div class="center">
          ${logo}
          <div class="thermal-brand">${esc(companyName)}</div>
          <div class="thermal-kind">فاکتور حرارتی · ${dims.thermalMm}mm</div>
          <div class="thermal-number">${esc(inv.num || '')} · ${esc(inv.date || '—')}</div>
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
      <div class="pad">
        <div class="top-simple">
          <div class="brand-row">
            ${logo}
            <div>
              <div class="title">${esc(companyName)}</div>
              <div class="brand-sub">${esc(subtitle)} · ${esc(typeLabel)}</div>
            </div>
          </div>
          <div class="inv-meta"><div class="box">
            <div class="row"><span>شماره</span><span class="num">${esc(inv.num || '')}</span></div>
            <div class="row"><span>تاریخ</span><span>${esc(inv.date || '—')}</span></div>
          </div></div>
        </div>
        <div class="parties">
          <div class="party"><h4>مشخصات خریدار</h4><div class="b">${buyerBits}</div></div>
          <div class="party"><h4>مشخصات فروشنده</h4><div class="b">${sellerBits}</div></div>
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
          <div>
            <div class="words"><b>مبلغ قابل پرداخت:</b> ${faNum(t.payable)} ریال</div>
            ${noteHtml}
          </div>
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar light">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else if (templateId === 'formal-premium') {
    // لوکس: هیرو برند سبز/طلایی + خط تزئینی طلایی + قاب گرادیانی
    bodyInner = `
      <div class="hero">
        <div class="brand-row">
          ${logo}
          <div>
            <div class="name">${esc(companyName)}</div>
            <div class="sub">${esc(subtitle)} · صورتحساب فروش کالا و خدمات</div>
          </div>
        </div>
        <div class="meta">
          <div class="tag">${esc(typeLabel)}</div>
          <div><span class="num">${esc(inv.num || '')}</span></div>
          <div>${esc(inv.date || '—')} · ${dims.paper}</div>
        </div>
      </div>
      <div class="prem-rule"></div>
      <div class="pad">
        <div class="parties">
          <div class="party"><h4>مشخصات فروشنده</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>مشخصات خریدار</h4><div class="b">${buyerBits}</div></div>
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
        <div class="sum-grid">${sumBox}<div class="words"><b>مبلغ قابل پرداخت:</b> ${faNum(t.payable)} ریال${noteHtml || '<div style="margin-top:6px;color:#8A7020">با تشکر از اعتماد شما</div>'}</div></div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else if (templateId === 'formal-modern') {
    // مدرن ERP: هدر گرادیانی با چیپ‌های متادیتا + کارت‌های نرم
    bodyInner = `
      <div class="mod-header">
        <div class="brand-row">
          ${logo}
          <div>
            <div class="name">${esc(companyName)}</div>
            <div class="brand-sub">${esc(subtitle)} · ${esc(typeLabel)}</div>
          </div>
        </div>
        <div class="mod-chips">
          <div class="mod-chip"><b>شماره</b><span class="num">${esc(inv.num || '')}</span></div>
          <div class="mod-chip"><b>تاریخ</b><span>${esc(inv.date || '—')}</span></div>
          <div class="mod-chip"><b>پرداخت</b><span>${esc(payTypeLabel)}</span></div>
          <div class="mod-chip"><b>کاغذ</b><span>${dims.paper}</span></div>
        </div>
      </div>
      <div class="pad">
        <div class="parties">
          <div class="party"><h4>مشخصات فروشنده</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>مشخصات خریدار</h4><div class="b">${buyerBits}</div></div>
        </div>
        ${expert}
        <table class="items">
          <thead>${formalHead}</thead>
          <tbody>${buildFormalRows(rows, isA5) || `<tr><td colspan="${emptyColspan}">بدون ردیف</td></tr>`}</tbody>
        </table>
        <div class="sum-grid">
          ${sumBox}
          <div>
            <div class="words"><b>مبلغ قابل پرداخت:</b> ${faNum(t.payable)} ریال</div>
            ${noteHtml}
          </div>
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  } else {
    // اداری / مالیاتی (formal-official): بنر سبز رسمی + هویت شرکت + جعبه‌های فروشنده/خریدار
    bodyInner = `
      <div class="off-banner">
        <div class="serial"><b>شماره:</b> <span class="num">${esc(inv.num || '')}</span><br><b>تاریخ:</b> ${esc(inv.date || '—')}</div>
        <div class="title">صورتحساب فروش کالا و خدمات</div>
        <div class="kind">${esc(typeLabel)}</div>
      </div>
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
          <div class="party"><h4>مشخصات فروشنده</h4><div class="b">${sellerBits}</div></div>
          <div class="party"><h4>مشخصات خریدار</h4><div class="b">${buyerBits}</div></div>
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
          <div>
            <div class="words"><b>مبلغ قابل پرداخت:</b> ${faNum(t.payable)} ریال</div>
            ${noteHtml}
          </div>
        </div>
        ${stamps}
      </div>
      ${customize.show_footer ? `<div class="footer-bar">${footerText}<br>${esc(contactLine)}</div>` : ''}`;
  }

  const printLabel = isThermal
    ? `چاپ حرارتی (${dims.thermalMm}mm)`
    : `چاپ فاکتور (${dims.paper})`;

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(typeLabel)} ${esc(inv.num || '')}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<style>${themeCss(templateId, dims)}</style>
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
  FORMAL_IDS, CASUAL_IDS, THERMAL_ID, DEFAULT_CUSTOMIZE,
  parseCustomize, resolveTemplateId, normalizeCasual, thermalWidthMm,
  renderInvoicePrintHtml, computePrintTotals, faNum, esc, paperDims,
};
