'use strict';
const { XLSX } = require('../excel-safe');
/** CSV / XLSX / HTML-PDF export for production reports */

const { err } = require('./posting');

const EXPORT_ROW_LIMIT = 60000;

function extractRows(reportResult) {
  const d = reportResult?.data;
  if (!d) return [];
  if (Array.isArray(d.rows)) return d.rows;
  if (Array.isArray(d.series)) return d.series;
  if (Array.isArray(d)) return d;
  return [];
}

function assertRowLimit(rows) {
  if (rows.length > EXPORT_ROW_LIMIT) throw err('E_EXPORT_TOO_LARGE', 422);
}

function toCsv(reportResult) {
  const rows = extractRows(reportResult);
  assertRowLimit(rows);
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(',')];
  for (const r of rows) {
    lines.push(keys.map(k => JSON.stringify(r[k] ?? '')).join(','));
  }
  return lines.join('\n');
}

async function toExcel(reportResult) {
  if (reportResult.report === 'PR-02' || reportResult.data?.summary) {
    const stages = reportResult.data?.stages || [];
    assertRowLimit(stages);
    const wb = XLSX.utils.book_new();
    const summary = reportResult.data.summary || {};
    const sumRows = Object.entries(summary).map(([field, value]) => ({ field, value }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows.length ? sumRows : [{ field: 'order_id', value: '' }]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stages.length ? stages : [{ seq: '' }]), 'Stages');
    return {
      format: 'xlsx',
      buffer: await XLSX.write(wb),
    };
  }

  const rows = extractRows(reportResult);
  assertRowLimit(rows);
  if (!rows.length) throw err('E_NO_DATA', 422);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, reportResult.report || 'Report');
  return { format: 'xlsx', buffer: await XLSX.write(wb) };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtToman(rial) {
  return Math.round(Number(rial || 0) / 10).toLocaleString('fa-IR');
}

function costSheetHtml(reportResult) {
  const s = reportResult.data?.summary || {};
  const stages = reportResult.data?.stages || [];
  const title = reportResult.title || 'برگه بهای تمام‌شده';
  const stageRows = stages.map(st => `<tr>
    <td>${escHtml(st.seq)}</td>
    <td>${escHtml(st.cc_code)} — ${escHtml(st.cc_name)}</td>
    <td class="num">${escHtml(st.qty_in)}</td>
    <td class="num">${escHtml(st.qty_out)}</td>
    <td class="num">${fmtToman(st.material_in_rial)}</td>
    <td class="num">${fmtToman(st.labor_rial)}</td>
    <td class="num">${fmtToman(st.overhead_rial)}</td>
    <td class="num">${fmtToman(st.cost_out_rial)}</td>
  </tr>`).join('');

  return `<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="utf-8">
<title>${escHtml(title)}</title>
<style>
  body{font-family:Tahoma,Vazirmatn,sans-serif;font-size:13px;color:#12271C;margin:24px}
  h1{font-size:18px;color:#1A5C38;margin:0 0 8px}
  .meta{color:#5F7268;font-size:12px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:right}
  th{background:#F2F7F3;color:#1A5C38}
  .num{direction:ltr;text-align:left;font-family:monospace}
  .summary td:first-child{font-weight:600;width:40%}
  @media print{body{margin:12mm} @page{size:A4;margin:12mm}}
</style></head><body>
<h1>${escHtml(title)}</h1>
<div class="meta">سفارش: ${escHtml(s.order_no || '—')} · محصول: ${escHtml(s.product_name || '—')} · دوره: ${escHtml(s.period_label || '—')}</div>
<table class="summary"><tbody>
  <tr><td>تعداد برنامه</td><td class="num">${escHtml(s.qty_planned)}</td></tr>
  <tr><td>تعداد تولید</td><td class="num">${escHtml(s.qty_produced)}</td></tr>
  <tr><td>بهره‌وری</td><td class="num">${escHtml(s.yield_pct)}٪</td></tr>
  <tr><td>مواد</td><td class="num">${fmtToman(s.material_cost_rial)} ت</td></tr>
  <tr><td>دستمزد</td><td class="num">${fmtToman(s.labor_cost_rial)} ت</td></tr>
  <tr><td>سربار</td><td class="num">${fmtToman(s.overhead_cost_rial)} ت</td></tr>
  <tr><td>بسته‌بندی</td><td class="num">${fmtToman(s.packaging_cost_rial)} ت</td></tr>
  <tr><td>پیمانکاری</td><td class="num">${fmtToman(s.subcontract_cost_rial)} ت</td></tr>
  <tr><td><strong>جمع کل</strong></td><td class="num"><strong>${fmtToman(s.total_cost_rial)} ت</strong></td></tr>
  <tr><td>بهای واحد</td><td class="num">${fmtToman(s.unit_cost_rial)} ت</td></tr>
</tbody></table>
<h2>مراحل تولید</h2>
<table><thead><tr>
  <th>seq</th><th>مرکز هزینه</th><th>ورودی</th><th>خروجی</th>
  <th>مواد</th><th>دستمزد</th><th>سربار</th><th>بهای مرحله</th>
</tr></thead><tbody>${stageRows || '<tr><td colspan="8">مرحله‌ای ثبت نشده</td></tr>'}</tbody></table>
</body></html>`;
}

function genericTableHtml(reportResult) {
  const rows = extractRows(reportResult);
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const head = keys.map(k => `<th>${escHtml(k)}</th>`).join('');
  const body = rows.slice(0, 5000).map(r =>
    `<tr>${keys.map(k => `<td>${escHtml(r[k])}</td>`).join('')}</tr>`
  ).join('');
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>${escHtml(reportResult.title || '')}</title>
<style>body{font-family:Tahoma,sans-serif} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:4px 6px;text-align:right}</style>
</head><body><h1>${escHtml(reportResult.title || reportResult.report || '')}</h1>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function toPdf(reportResult) {
  if (reportResult.report === 'PR-02' || reportResult.data?.summary) {
    return { format: 'html', html: costSheetHtml(reportResult) };
  }
  const tableHtml = genericTableHtml(reportResult);
  if (tableHtml) return { format: 'html', html: tableHtml };
  return {
    format: 'html',
    html: `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>${escHtml(reportResult.title || '')}</title></head><body><pre>${escHtml(JSON.stringify(reportResult, null, 2))}</pre></body></html>`,
  };
}

module.exports = { toCsv, toExcel, toPdf, EXPORT_ROW_LIMIT };
