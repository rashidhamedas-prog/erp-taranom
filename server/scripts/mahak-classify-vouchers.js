#!/usr/bin/env node
/** Classify all Mahak journal vouchers by line-pattern + description. Read-only. */
const path = require('path');
const { XLSX, readWorkbook } = require('../lib/excel-safe');
const { fa } = require('../lib/mahak-import-helpers');

const journalPath = process.argv[2] || path.join(__dirname, '../../..', 'daftar roznameh.xlsx');
const num = v => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
const toman = rial => Math.round(rial / 10);


(async () => {
const jwb = await readWorkbook(require("fs").readFileSync(journalPath));
const jrows = XLSX.utils.sheet_to_json(jwb.Sheets[jwb.SheetNames[0]], { header: 1, raw: false }).slice(1);
const vouchers = new Map();
for (const r of jrows) {
  const code = String(r[3] == null ? '' : r[3]).trim();
  const docNo = String(r[2] == null ? '' : r[2]).trim();
  if (!docNo) continue;
  if (!vouchers.has(docNo)) vouchers.set(docNo, { date: fa(r[0]), atf: fa(r[1]), desc: '', lines: [] });
  const v = vouchers.get(docNo);
  if (!code) { if (!v.desc) v.desc = fa(r[4]); continue; }
  const debit = toman(num(r[5])), credit = toman(num(r[6]));
  if (debit === 0 && credit === 0) continue;
  v.lines.push({ code, name: fa(r[4]), debit, credit, kol: code.slice(0, 3), taf: code.slice(6) });
}

function kols(v) {
  const s = new Set(v.lines.map(l => l.kol));
  return [...s].sort();
}
function hasKol(v, k) { return v.lines.some(l => l.kol === k); }
function sumKol(v, k, side) {
  return v.lines.filter(l => l.kol === k).reduce((a, l) => a + l[side], 0);
}

function classify(docNo, v) {
  const d = (v.desc || '') + ' ' + (v.atf || '');
  const ks = kols(v);

  if (/افتتاح|سند افتتاح/.test(d) || docNo === '1') return 'opening';
  if (/فاکتور\s*فروش|فروش\s*\(|pre\s*invoice/i.test(d)) return 'sales_invoice';
  if (/فاکتور|فروش/.test(d) && hasKol(v, '601')) return 'sales_invoice';
  if (/خرید|خريد|حواله\s*حساب.*خرید/.test(d)) return 'purchase';
  if (/دریافت|دريافت|واریز|واريز/.test(d) && !/پرداخت/.test(d)) return 'receipt';
  if (/پرداخت/.test(d)) return 'payment';
  if (/حقوق|دستمزد|پرداخت\s*حقوق/.test(d)) return 'payroll';
  if (/بهاي\s*تمام|بهای\s*تمام|COGS/.test(d)) return 'cogs';
  if (/حواله\s*انبار|حواله\s*کالا|انتقال\s*انبار|رسید\s*انبار/.test(d)) return 'warehouse';
  if (/انتقال\s*وجه|انتقال\s*از|جابجایی/.test(d)) return 'transfer';
  if (/تعدیل|اصلاح/.test(d)) return 'adjustment';

  // Pattern-based fallback
  const dr203 = sumKol(v, '203', 'debit'), cr601 = sumKol(v, '601', 'credit');
  const dr202 = sumKol(v, '202', 'debit'), cr202 = sumKol(v, '202', 'credit'), cr501 = sumKol(v, '501', 'credit'), dr501 = sumKol(v, '501', 'debit');
  const dr206 = sumKol(v, '206', 'debit'), cr206 = sumKol(v, '206', 'credit');
  const dr801 = sumKol(v, '801', 'debit'), cr202cogs = sumKol(v, '202', 'credit');
  const cr203 = sumKol(v, '203', 'credit');
  const dr701 = sumKol(v, '701', 'debit');

  if (dr801 > 0 && cr202cogs > 0 && ks.length <= 3) return 'cogs';
  if (dr203 > 0 && cr601 > 0) return 'sales_invoice';
  if (cr203 > 0 && dr206 > 0 && !hasKol(v, '601')) return 'receipt';
  if (dr501 > 0 && cr206 > 0 && !hasKol(v, '202')) return 'payment';
  if (dr202 > 0 && cr501 > 0) return 'purchase';
  if (cr202 > 0 && dr501 > 0) return 'purchase_return';
  if (dr701 > 0 || (hasKol(v, '701') && hasKol(v, '501'))) return 'payroll';
  if (dr206 > 0 && cr206 > 0 && ks.filter(k => k === '206').length) return 'transfer';
  if (hasKol(v, '202') && ks.length === 1 && v.lines.length >= 2) return 'warehouse';
  if (hasKol(v, '906')) return 'adjustment';

  return 'other';
}

const counts = {};
const samples = {};
for (const [docNo, v] of vouchers) {
  if (!v.lines.length) continue;
  const type = classify(docNo, v);
  counts[type] = (counts[type] || 0) + 1;
  if (!samples[type] || samples[type].length < 2) {
    (samples[type] = samples[type] || []).push({ docNo, date: v.date, desc: (v.desc || v.atf).slice(0, 70), lines: v.lines.length, kols: kols(v) });
  }
}

console.log('=== VOUCHER CLASSIFICATION ===\n');
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
  console.log(`${t}: ${n}`);
  (samples[t] || []).forEach(s => console.log(`  ex ${s.docNo} ${s.date} [${s.kols.join(',')}] ${s.lines}L — ${s.desc}`));
});
console.log('\nTotal classified:', Object.values(counts).reduce((a, b) => a + b, 0));

})().catch((e) => {
  console.error(e);
  process.exit(1);
});
