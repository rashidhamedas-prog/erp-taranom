/**
 * Invoice print templates — ERP ترنم
 * Formal: formal-official | formal-modern | formal-premium
 * Casual: casual-simple | casual-compact | casual-receipt
 * Paper: A4 | A5
 */
'use strict';

const FORMAL_IDS = ['formal-official', 'formal-modern', 'formal-premium'];
const CASUAL_IDS = ['casual-simple', 'casual-compact', 'casual-receipt'];

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

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

function parseCustomize(raw) {
  let o = {};
  try {
    if (raw && typeof raw === 'string') o = JSON.parse(raw);
    else if (raw && typeof raw === 'object') o = raw;
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_CUSTOMIZE, ...o };
}

function resolveTemplateId(invType, settings) {
  const formal = FORMAL_IDS.includes(settings.invoice_template_formal)
    ? settings.invoice_template_formal : 'formal-official';
  const casual = CASUAL_IDS.includes(settings.invoice_template_casual)
    ? settings.invoice_template_casual : 'casual-simple';
  return invType === 'final' ? formal : casual;
}

function paperDims(paper) {
  const isA5 = String(paper || 'A4').toUpperCase() === 'A5';
  return {
    paper: isA5 ? 'A5' : 'A4',
    sheetMax: isA5 ? '520px' : '820px',
    pad: isA5 ? '16px' : '28px',
    font: isA5 ? '11px' : '13px',
    logoH: isA5 ? '44px' : '58px',
  };
}

function buildRowsHtml(rows, compact) {
  return (rows || []).map((r, i) => {
    const desc = String(r.description || '').trim();
    const nameCell = desc
      ? `${esc(r.name || '')}<div class="row-desc">${esc(desc)}</div>`
      : esc(r.name || '');
    const lineDisc = Math.max(0, Math.round(Number(r.disc_amount) || 0))
      || Math.round((Number(r.qty) || 0) * (Number(r.price) || 0) * (Number(r.disc) || 0) / 100);
    const discNote = lineDisc
      ? `<div class="row-disc">تخفیف: ${r.disc ? faNum(r.disc) + '٪ ≈ ' : ''}${faNum(lineDisc)}</div>`
      : '';
    if (compact) {
      return `<tr><td>${faNum(i + 1)}</td><td class="rtl">${nameCell}${discNote}</td><td>${faNum(r.qty)}×${faNum(r.price)}</td><td>${faNum(r.sum)}</td></tr>`;
    }
    return `<tr><td>${faNum(i + 1)}</td><td class="rtl">${nameCell}${discNote}</td><td>${faNum(r.qty)}</td><td>${faNum(r.price)}</td><td>${faNum(r.sum)}</td></tr>`;
  }).join('');
}

function linesDiscTotal(rows) {
  return (rows || []).reduce((a, r) => {
    const amt = Math.max(0, Math.round(Number(r.disc_amount) || 0));
    if (amt > 0) return a + amt;
    return a + Math.round((Number(r.qty) || 0) * (Number(r.price) || 0) * (Number(r.disc) || 0) / 100);
  }, 0);
}

function themeCss(id, dims) {
  const common = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Vazirmatn',sans-serif;background:#F5F8F4;color:#12271C;padding:16px;font-size:${dims.font}}
  .sheet{max-width:${dims.sheetMax};margin:0 auto;background:#fff;padding:${dims.pad};position:relative}
  .num{font-variant-numeric:tabular-nums}
  .rtl{text-align:right}
  .row-desc{font-size:10px;color:#5F7268;margin-top:3px;font-weight:400}
  .row-disc{font-size:10px;color:#9ca3af}
  .pbtn{display:block;margin:18px auto 0;background:#1A5C38;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
  .watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}
  .watermark span{transform:rotate(-25deg);font-size:40px;font-weight:800;color:rgba(220,38,38,.14);border:4px solid rgba(220,38,38,.14);border-radius:14px;padding:8px 24px;white-space:nowrap}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{padding:8px 6px;text-align:center;vertical-align:middle}
  .totals .line{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed rgba(18,39,28,.12)}
  .totals .final{font-weight:800;border:none;padding-top:10px;font-size:1.15em;color:#1A5C38}
  .totals .final .gold{color:#C9A843}
  .note{margin-top:14px;font-size:12px;color:#5F7268;background:#EDF3EE;border-radius:8px;padding:10px 12px}
  .footer{margin-top:18px;text-align:center;font-size:11px;color:#5F7268;border-top:1px solid rgba(18,39,28,.11);padding-top:12px;line-height:1.9}
  .logo-box{background:#0a0a0a;border-radius:10px;padding:4px 8px;display:inline-flex;align-items:center}
  .logo-box img{height:${dims.logoH};display:block}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none!important;border-radius:0!important;max-width:100%!important}.pbtn{display:none}@page{size:${dims.paper};margin:8mm}}
  `;
  const themes = {
    'formal-official': `
      .sheet{border:1.5px solid #1A5C38;box-shadow:0 12px 36px rgba(18,39,28,.12)}
      .band{background:linear-gradient(180deg,#163F2A 0%,#1A5C38 45%,#2E7D4F 100%);color:#fff;padding:12px 14px;display:flex;justify-content:space-between;gap:12px;align-items:center;margin:${dims.pad === '16px' ? '-16px -16px 12px' : '-28px -28px 16px'}}
      .band h1{font-size:1.15em;font-weight:800}
      .band .meta{text-align:left;font-size:.92em;line-height:1.7}
      .gold-line{height:3px;background:linear-gradient(90deg,#C9A843,transparent 85%);margin-bottom:12px}
      .sec{border:1px solid #1A5C38;margin-bottom:10px}
      .sec-h{background:#EAF4EE;border-bottom:1px solid #1A5C38;padding:5px 10px;font-weight:800;color:#1A5C38;font-size:.9em}
      .sec-b{padding:10px;line-height:1.9;font-size:.92em}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      thead th{background:#1A5C38;color:#fff;border:1px solid #145032}
      td{border:1px solid #b7cfc2}
      tbody tr:nth-child(even){background:#F2F7F3}
      .tag{display:inline-block;background:rgba(255,255,255,.12);color:#FDF3D9;border:1px solid rgba(201,168,67,.4);padding:3px 10px;border-radius:999px;font-weight:800;font-size:.75em}
    `,
    'formal-modern': `
      .sheet{border-radius:16px;border:1px solid rgba(18,39,28,.11);box-shadow:0 1px 0 rgba(18,39,28,.11),0 20px 36px -28px rgba(18,39,28,.42)}
      .head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
      .head h1{font-size:1.2em;font-weight:800;color:#1A5C38}
      .meta-cards{display:grid;gap:6px;min-width:140px}
      .meta-card{background:#EDF3EE;border:1px solid rgba(18,39,28,.11);border-radius:10px;padding:7px 10px;font-size:.85em}
      .meta-card b{display:block;color:#5F7268;font-size:.72em;font-weight:600}
      .cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
      .card{border:1px solid rgba(18,39,28,.11);border-radius:12px;padding:12px;position:relative;box-shadow:0 8px 20px rgba(18,39,28,.04);line-height:1.85;font-size:.9em}
      .card::before{content:"";position:absolute;top:0;right:0;bottom:0;width:4px;background:#1A5C38;border-radius:0 12px 12px 0}
      .card h4{margin:0 0 8px;font-size:.85em;font-weight:800;color:#1A5C38}
      .table-shell{border:1px solid rgba(18,39,28,.11);border-radius:12px;overflow:hidden}
      thead th{background:#F2F7F3;color:#1A5C38;border-bottom:1px solid rgba(18,39,28,.11)}
      td{border-bottom:1px solid #edf3ee}
      .tag{display:inline-block;background:#EAF4EE;color:#1A5C38;padding:3px 10px;border-radius:999px;font-weight:800;font-size:.75em}
      .sum{margin-top:12px;border-radius:12px;padding:12px;background:linear-gradient(160deg,#EAF4EE,#fff 70%);border:1px solid rgba(26,92,56,.18);max-width:320px;margin-right:auto}
    `,
    'formal-premium': `
      .sheet{border-radius:18px;border:1px solid rgba(22,63,42,.35);box-shadow:0 24px 50px rgba(18,39,28,.16);overflow:hidden;padding:0}
      .hero{background:linear-gradient(120deg,#1A5C38 0%,#2E7D4F 55%,#C9A843 135%);color:#fff;padding:18px 20px;display:flex;justify-content:space-between;gap:12px;align-items:center}
      .hero h1{font-size:1.2em;font-weight:800}
      .hero .sub{opacity:.85;font-size:.8em;margin-top:4px}
      .hero .meta{text-align:left;font-size:.85em;line-height:1.7}
      .pill{display:inline-block;margin-bottom:6px;padding:3px 10px;border-radius:999px;background:rgba(0,0,0,.18);border:1px solid rgba(201,168,67,.45);color:#FDF3D9;font-weight:700;font-size:.7em}
      .body{padding:${dims.pad}}
      .parties{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
      .party{background:#EDF3EE;border:1px solid rgba(18,39,28,.11);border-radius:14px;padding:12px;position:relative;line-height:1.85;font-size:.9em}
      .party::after{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(#1A5C38,#C9A843)}
      .party h4{margin:0 0 8px;font-weight:800;color:#1A5C38;font-size:.85em}
      .table-shell{border-radius:14px;overflow:hidden;border:1px solid rgba(18,39,28,.11)}
      thead th{background:#1A5C38;color:#EAF4EE}
      td{border-bottom:1px solid #edf3ee}
      .total-wrap{margin-top:14px;padding:2px;border-radius:14px;background:linear-gradient(120deg,#1A5C38,#C9A843,#2E7D4F);max-width:340px;margin-right:auto}
      .total-inner{background:#163F2A;color:#F5F8F4;border-radius:12px;padding:12px 14px}
      .total-inner .line{border-bottom-color:rgba(201,168,67,.25);color:#c8ddd1}
      .total-inner .final{color:#C9A843;border:none}
      .tag{display:inline-block;background:rgba(0,0,0,.18);color:#FDF3D9;border:1px solid rgba(201,168,67,.45);padding:3px 10px;border-radius:999px;font-weight:800;font-size:.75em}
      .note,.footer{margin-left:20px;margin-right:20px}
      .footer{margin-bottom:16px}
    `,
    'casual-simple': `
      .sheet{border-radius:12px;border:1px solid rgba(18,39,28,.08);box-shadow:0 8px 24px rgba(18,39,28,.06)}
      .head{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;margin-bottom:14px;border-bottom:2px solid #C9A843}
      .head h1{font-size:1.15em;font-weight:800;color:#1A5C38}
      .head .meta{text-align:left;font-size:.88em;line-height:1.75;color:#5F7268}
      .cust{background:#F7FAF7;border-radius:10px;padding:12px 14px;margin-bottom:12px;line-height:1.85;font-size:.92em}
      .cust b{color:#1A5C38}
      thead th{background:#EAF4EE;color:#1A5C38;border-bottom:2px solid #1A5C38}
      td{border-bottom:1px solid #edf3ee}
      .tag{display:inline-block;background:#FDF3D9;color:#7a6418;padding:3px 10px;border-radius:999px;font-weight:800;font-size:.75em}
      .totals{max-width:280px;margin:14px 0 0 auto}
    `,
    'casual-compact': `
      .sheet{border-radius:8px;border:1px solid rgba(18,39,28,.1)}
      .head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px}
      .head h1{font-size:1em;font-weight:800;color:#1A5C38}
      .head .meta{text-align:left;font-size:.8em;line-height:1.6}
      .bar{display:flex;flex-wrap:wrap;gap:8px 14px;background:#EDF3EE;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:.82em}
      .bar span b{color:#1A5C38}
      thead th{background:#1A5C38;color:#fff;font-size:.78em;padding:6px 4px}
      td{border-bottom:1px solid #e8eee9;padding:5px 4px;font-size:.82em}
      .tag{font-size:.7em;font-weight:800;color:#2E7D4F}
      .totals{max-width:240px;margin:10px 0 0 auto;font-size:.9em}
    `,
    'casual-receipt': `
      .sheet{max-width:${dims.paper === 'A5' ? '360px' : '420px'};border-radius:0;border:none;box-shadow:none;padding:${dims.paper === 'A5' ? '12px' : '18px'}}
      body{background:#fff}
      .receipt-head{text-align:center;margin-bottom:12px}
      .receipt-head h1{font-size:1.1em;font-weight:800;color:#1A5C38;margin-top:8px}
      .receipt-head .meta{font-size:.85em;color:#5F7268;line-height:1.7;margin-top:6px}
      .dash{border:none;border-top:1px dashed #a8c8b4;margin:10px 0}
      .cust{font-size:.88em;line-height:1.8;text-align:center}
      thead th{background:transparent;color:#1A5C38;border-bottom:1px dashed #a8c8b4;font-size:.8em}
      td{border:none;border-bottom:1px dotted #e8eee9;padding:6px 4px;font-size:.85em}
      .totals{margin:12px auto 0;max-width:100%;font-size:.95em}
      .totals .final{text-align:center;display:block;border-top:2px solid #1A5C38;padding-top:8px}
      .tag{font-weight:800;color:#C9A843}
      .footer{border:none;font-size:10px}
    `,
  };
  return common + (themes[id] || themes['formal-official']);
}

function renderInvoicePrintHtml(opts) {
  const inv = opts.inv || {};
  const rows = opts.rows || [];
  const settings = opts.settings || {};
  const customize = parseCustomize(settings.invoice_customize);
  const dims = paperDims(opts.paper || settings.invoice_paper_size || 'A4');
  const templateId = opts.templateOverride || resolveTemplateId(inv.type, settings);
  const typeLabel = inv.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور';
  const isProvisional = String(inv.num || '').startsWith('موقت');
  const companyName = settings.company_name || 'پوشاک ترنم';
  const companyAddr = settings.company_address || '';
  const companyPhone = settings.company_phone || '';
  const subtitle = customize.subtitle || 'تولیدی پوشاک زنانه';
  const compact = templateId === 'casual-compact' || templateId === 'casual-receipt';
  const rowsHtml = buildRowsHtml(rows, compact);
  const discLines = linesDiscTotal(rows);
  const payTypeLabel = { cash: 'نقد', cheque: 'چک', credit: 'نسیه', bank_transfer: 'واریز بانکی' }[inv.pay_type] || inv.pay_type || 'نقد';

  let payBlock = '';
  if (customize.show_payment) {
    payBlock = `<div><b>نوع پرداخت:</b> ${esc(payTypeLabel)}</div>`;
    if (inv.pay_type === 'cheque') {
      if (inv.cheque_duration) payBlock += `<div><b>مدت چک:</b> ${esc(inv.cheque_duration)} روز</div>`;
      if (inv.cheque_due_date) payBlock += `<div><b>سررسید:</b> ${esc(inv.cheque_due_date)}</div>`;
      if (inv.cheque_info) payBlock += `<div><b>اطلاعات چک:</b> ${esc(inv.cheque_info)}</div>`;
    }
  }

  const logoHtml = customize.show_logo
    ? `<div class="logo-box"><img src="/logo-sm.png" alt="" onerror="this.src='/logo.png';this.onerror=()=>{this.style.display='none'}"></div>`
    : '';

  const tableHead = compact
    ? `<tr><th>ردیف</th><th>شرح</th><th>تعداد×فی</th><th>جمع</th></tr>`
    : `<tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>فی (ریال)</th><th>جمع (ریال)</th></tr>`;

  const totalsHtml = `
    <div class="totals ${templateId === 'formal-modern' ? 'sum' : ''} ${templateId === 'formal-premium' ? 'total-wrap' : ''}">
      ${templateId === 'formal-premium' ? '<div class="total-inner">' : ''}
      <div class="line"><span>جمع کل:</span><span class="num">${faNum(inv.subtotal)} ریال</span></div>
      ${customize.show_discount && discLines ? `<div class="line"><span>تخفیف ردیف‌ها:</span><span class="num">${faNum(discLines)} ریال</span></div>` : ''}
      ${customize.show_discount ? `<div class="line"><span>تخفیف کل (${faNum(inv.disc)}٪):</span><span class="num">${faNum(inv.disc_amt)} ریال</span></div>` : ''}
      <div class="line final"><span>مبلغ نهایی:</span><span class="num gold">${faNum(inv.final)} ریال</span></div>
      ${templateId === 'formal-premium' ? '</div>' : ''}
    </div>`;

  const noteHtml = (customize.show_note && inv.note) ? `<div class="note"><b>توضیحات:</b> ${esc(inv.note)}</div>` : '';
  const footerText = customize.footer_text
    ? esc(customize.footer_text)
    : `این ${typeLabel} در تاریخ ${esc(inv.date || '')} صادر شده است.`;
  const footerHtml = customize.show_footer ? `<div class="footer">
    <div>${footerText}</div>
    <div>${esc(companyName)}${customize.show_company_address && companyAddr ? ' — ' + esc(companyAddr) : ''}${customize.show_company_phone && companyPhone ? ' — ' + esc(companyPhone) : ''}</div>
  </div>` : '';

  const custBits = `
    <div><b>نام فروشگاه:</b> ${esc(inv.cust_biz || '-')}</div>
    <div><b>نام کامل:</b> ${esc(inv.cust_owner || '-')}</div>
    <div><b>شهر:</b> ${esc(inv.cust_city || '-')}</div>
    <div><b>تلفن:</b> ${esc(inv.cust_phone || '-')}</div>`;

  const sellerBits = customize.show_seller ? `
    <div><b>فروشنده:</b> ${esc(inv.seller_name || '-')}</div>
    <div><b>تلفن فروشنده:</b> ${esc(inv.seller_phone || '-')}</div>` : '';

  const companyBits = `
    ${customize.show_company_address ? `<div><b>آدرس شرکت:</b> ${esc(companyAddr || '-')}</div>` : ''}
    ${customize.show_company_phone ? `<div><b>تلفن شرکت:</b> ${esc(companyPhone || '-')}</div>` : ''}
    ${payBlock}`;

  let bodyInner = '';

  if (templateId === 'formal-official') {
    bodyInner = `
      <div class="band">
        <div style="display:flex;gap:12px;align-items:center">
          ${logoHtml}
          <div>
            <span class="tag">${esc(typeLabel)}</span>
            <h1 style="margin-top:6px">${esc(companyName)}</h1>
            <div style="opacity:.85;font-size:.8em">${esc(subtitle)} · ${dims.paper}</div>
          </div>
        </div>
        <div class="meta">
          <div class="num" style="font-size:1.2em;font-weight:800">${esc(inv.num || '')}</div>
          <div>تاریخ: ${esc(inv.date || '-')}</div>
          ${customize.show_company_phone && companyPhone ? `<div>${esc(companyPhone)}</div>` : ''}
        </div>
      </div>
      <div class="gold-line"></div>
      <div class="grid2">
        <div class="sec"><div class="sec-h">مشتری</div><div class="sec-b">${custBits}</div></div>
        <div class="sec"><div class="sec-h">فروشنده / شرکت</div><div class="sec-b">${sellerBits}${companyBits}</div></div>
      </div>
      <div class="sec"><div class="sec-h">اقلام</div>
        <table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody></table>
      </div>
      ${totalsHtml}${noteHtml}${footerHtml}`;
  } else if (templateId === 'formal-modern') {
    bodyInner = `
      <div class="head">
        <div style="display:flex;gap:12px;align-items:center">
          ${logoHtml}
          <div>
            <span class="tag">${esc(typeLabel)}</span>
            <h1 style="margin-top:6px">${esc(companyName)}</h1>
            <div style="color:#5F7268;font-size:.85em">${esc(subtitle)}</div>
          </div>
        </div>
        <div class="meta-cards">
          <div class="meta-card"><b>شماره</b><span class="num">${esc(inv.num || '')}</span></div>
          <div class="meta-card"><b>تاریخ</b>${esc(inv.date || '-')}</div>
          <div class="meta-card"><b>کاغذ</b>${dims.paper}</div>
        </div>
      </div>
      <div class="cards">
        <div class="card"><h4>مشتری</h4>${custBits}</div>
        <div class="card"><h4>فروشنده / شرکت</h4>${sellerBits}${companyBits}</div>
      </div>
      <div class="table-shell"><table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody></table></div>
      ${totalsHtml}${noteHtml}${footerHtml}`;
  } else if (templateId === 'formal-premium') {
    bodyInner = `
      <div class="hero">
        <div style="display:flex;gap:12px;align-items:center">
          ${logoHtml}
          <div>
            <span class="tag">${esc(typeLabel)}</span>
            <h1 style="margin-top:6px">${esc(companyName)}</h1>
            <div class="sub">${esc(subtitle)} · ${dims.paper}</div>
          </div>
        </div>
        <div class="meta">
          <div class="pill">TARANOM</div>
          <div>شماره: <b class="num">${esc(inv.num || '')}</b></div>
          <div>تاریخ: ${esc(inv.date || '-')}</div>
        </div>
      </div>
      <div class="body">
        <div class="parties">
          <div class="party"><h4>مشتری</h4>${custBits}</div>
          <div class="party"><h4>فروشنده / شرکت</h4>${sellerBits}${companyBits}</div>
        </div>
        <div class="table-shell"><table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody></table></div>
        ${totalsHtml}${noteHtml}
      </div>
      ${footerHtml}`;
  } else if (templateId === 'casual-simple') {
    bodyInner = `
      <div class="head">
        <div style="display:flex;gap:10px;align-items:center">
          ${logoHtml}
          <div>
            <h1>${esc(companyName)}</h1>
            <div style="color:#5F7268;font-size:.85em">${esc(subtitle)}</div>
          </div>
        </div>
        <div class="meta">
          <span class="tag">${esc(typeLabel)}</span>
          <div class="num" style="font-weight:800;font-size:1.1em;color:#1A5C38">${esc(inv.num || '')}</div>
          <div>${esc(inv.date || '-')}</div>
        </div>
      </div>
      <div class="cust">${custBits}${sellerBits ? '<hr style="border:none;border-top:1px dashed #cfe0d6;margin:8px 0">' + sellerBits : ''}${payBlock}</div>
      <table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody></table>
      ${totalsHtml}${noteHtml}${footerHtml}`;
  } else if (templateId === 'casual-compact') {
    bodyInner = `
      <div class="head">
        <div style="display:flex;gap:8px;align-items:center">
          ${logoHtml}
          <div>
            <h1>${esc(companyName)}</h1>
            <span class="tag">${esc(typeLabel)} · ${dims.paper}</span>
          </div>
        </div>
        <div class="meta">
          <div><b class="num">${esc(inv.num || '')}</b></div>
          <div>${esc(inv.date || '-')}</div>
        </div>
      </div>
      <div class="bar">
        <span><b>مشتری:</b> ${esc(inv.cust_biz || inv.cust_owner || '-')}</span>
        <span><b>تلفن:</b> ${esc(inv.cust_phone || '-')}</span>
        ${customize.show_seller ? `<span><b>فروشنده:</b> ${esc(inv.seller_name || '-')}</span>` : ''}
        ${customize.show_payment ? `<span><b>پرداخت:</b> ${esc(payTypeLabel)}</span>` : ''}
      </div>
      <table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="4">—</td></tr>'}</tbody></table>
      ${totalsHtml}${noteHtml}${footerHtml}`;
  } else {
    bodyInner = `
      <div class="receipt-head">
        ${logoHtml}
        <h1>${esc(companyName)}</h1>
        <div class="meta">
          <div class="tag">${esc(typeLabel)}</div>
          <div>${esc(inv.num || '')} · ${esc(inv.date || '-')}</div>
          ${customize.show_company_phone && companyPhone ? `<div>${esc(companyPhone)}</div>` : ''}
        </div>
      </div>
      <hr class="dash">
      <div class="cust">${esc(inv.cust_biz || '')}${inv.cust_owner ? ' — ' + esc(inv.cust_owner) : ''}<br>${esc(inv.cust_phone || '')}</div>
      <hr class="dash">
      <table><thead>${tableHead}</thead><tbody>${rowsHtml || '<tr><td colspan="4">—</td></tr>'}</tbody></table>
      <hr class="dash">
      ${totalsHtml}
      ${noteHtml}${footerHtml}`;
  }

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
    <button class="pbtn" onclick="window.print()">چاپ فاکتور (${dims.paper})</button>
  </div>
</body>
</html>`;
}

module.exports = {
  FORMAL_IDS, CASUAL_IDS, DEFAULT_CUSTOMIZE,
  parseCustomize, resolveTemplateId, renderInvoicePrintHtml, faNum, esc,
};
