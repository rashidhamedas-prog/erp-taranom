// Shared helpers for Mahak Excel import (entity parsing, product categories).
const { storeRial, guessMahakProductGroup } = require('./currency');
const fa = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Split Mahak person tafsili title → owner / business / phone. */
function parsePersonName(name) {
  const raw = fa(name);
  const phoneMatch = raw.match(/\b(0\d{10})\b/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  let clean = raw.replace(/\b0\d{10}\b/g, '').replace(/\s+/g, ' ').trim();
  const parts = clean.split(/\s*[-–/]\s*/).map(p => p.trim()).filter(Boolean);
  let owner = '', biz = clean;
  if (/^(آقاي|آقای|خانم|اقاي|اقای)\s/i.test(clean)) {
    owner = parts[0] || clean;
    biz = parts.length > 1 ? parts.slice(1).join(' — ') : owner;
  } else if (/^(فروشگاه|شرکت|کارگاه|تولیدی|پوشاک|مانتو)/.test(clean)) {
    biz = clean;
    owner = '';
  } else if (parts.length >= 2) {
    owner = parts[0];
    biz = parts.slice(1).join(' — ');
  }
  if (!biz) biz = owner || clean;
  return { owner, biz, phone };
}

/** Classify inventory row for product_categories (Mahak groups). */
function guessProductCategory(name) {
  return guessMahakProductGroup(name);
}

/** Build map full12 → {debit,credit,count} from parsed vouchers. */
function buildAccountUsage(docList) {
  const accountUsage = new Map();
  for (const [, v] of docList) {
    for (const l of v.lines) {
      const u = accountUsage.get(l.code) || { debit: 0, credit: 0, count: 0, kol: l.code.slice(0, 3), taf: l.code.slice(6) };
      u.debit += l.debit;
      u.credit += l.credit;
      u.count++;
      accountUsage.set(l.code, u);
    }
  }
  return accountUsage;
}

/** taf6 → { receivable?: full12, payable?: full12, misc?: full12 } */
function mapPersonAccounts(accountUsage, tafBestFull) {
  const byTaf = new Map();
  for (const full of accountUsage.keys()) {
    const kol = full.slice(0, 3), taf = full.slice(6);
    if (!['203', '501', '204'].includes(kol)) continue;
    if (!byTaf.has(taf)) byTaf.set(taf, {});
    const slot = kol === '203' ? 'receivable' : kol === '501' ? 'payable' : 'misc';
    byTaf.get(taf)[slot] = full;
  }
  for (const [taf, full] of tafBestFull) {
    if (!byTaf.has(taf)) byTaf.set(taf, {});
    const o = byTaf.get(taf);
    const kol = full.slice(0, 3);
    if (kol === '203' && !o.receivable) o.receivable = full;
    if (kol === '501' && !o.payable) o.payable = full;
    if (kol === '204' && !o.misc) o.misc = full;
  }
  return byTaf;
}

const num = v => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
/** Mahak amounts are Rial — store as-is (no ÷10). */
const toman = storeRial;

/** Parse roznameh.xlsx into Map docNo → voucher. */
function parseMahakJournal(journalPath) {
  const XLSX = require('xlsx');
  const jwb = XLSX.readFile(journalPath);
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
  return vouchers;
}

function sumKol(v, kol, side) {
  return v.lines.filter(l => l.kol === kol).reduce((a, l) => a + l[side], 0);
}

function hasKol(v, kol) { return v.lines.some(l => l.kol === kol); }

/** Classify Mahak voucher → operational document type. */
function classifyMahakVoucher(docNo, v) {
  const d = `${v.desc || ''} ${v.atf || ''}`;
  if (docNo === '1' || /سند افتتاح|افتتاحيه/.test(d)) return 'opening';
  if (/برگشت\s*از\s*فروش/i.test(d)) return 'sales_return';
  if (/برگشت\s*از\s*خرید/i.test(d)) return 'purchase_return';
  if (/فاکتور\s*فروش|فاکتور فروش/i.test(d)) return 'sales_invoice';
  if (/حواله\s*بین\s*انبار|بین\s*انبار/.test(d)) return 'warehouse_transfer';
  if (/رسيد\s*انبار.*ورود|رسید انبار - ورود|رسید انبار.*ورود/.test(d)) return 'warehouse_receipt';
  if (/حواله\s*انبار.*خروج|حواله انبار - خروج/.test(d)) return 'warehouse_issue';
  if (/حواله\s*انبار/.test(d)) return 'warehouse_issue';
  if (/انبارگردانی|انبار گردانی/.test(d)) return 'stocktaking';
  if (/حواله\s*حساب|حواله حساب/.test(d)) return 'account_transfer';
  if (/چک|چك|خواباندن|واگذار|عودت\s*چک|اسناد\s*دریافت/.test(d) && !v.lines.some(l => l.code.startsWith('203004'))) return 'cheque_ops';
  if (/دريافت|دریافت|واریز|واريز/.test(d) && !/پرداخت/.test(d)) return 'receipt';
  if (/پرداخت\s*حقوق|حقوق\s|دستمزد/.test(d)) return 'payroll';
  if (/پرداخت/.test(d)) return 'payment';
  if (/حواله\s*حساب.*بين|بين\s*بانک|بین\s*بانک/.test(d)) return 'transfer';
  if (/توليد|تولید|آناليز|آنالیز/.test(d)) return 'production';

  const dr203 = sumKol(v, '203', 'debit'), cr203 = sumKol(v, '203', 'credit');
  const dr202 = sumKol(v, '202', 'debit'), cr202 = sumKol(v, '202', 'credit');
  const dr501 = sumKol(v, '501', 'debit'), cr501 = sumKol(v, '501', 'credit');
  const dr206 = sumKol(v, '206', 'debit'), cr206 = sumKol(v, '206', 'credit');
  const dr601 = sumKol(v, '601', 'debit'), cr601 = sumKol(v, '601', 'credit');
  const dr704 = sumKol(v, '704', 'debit'), dr702 = sumKol(v, '702', 'debit');
  const dr801 = sumKol(v, '801', 'debit');

  if (cr601 > 0 && dr203 > 0 && /برگشت/.test(d)) return 'sales_return';
  if (dr202 > 0 && cr501 > 0 && /برگشت/.test(d)) return 'purchase_return';
  if (cr601 > 0 && dr203 > 0) return 'sales_invoice';
  if (dr206 > 0 && cr203 > 0 && !hasKol(v, '601')) return 'receipt';
  if (dr203 > 0 && cr203 > 0 && v.lines.some(l => l.code.startsWith('203001')) && v.lines.some(l => l.code.startsWith('203004'))) return 'receipt';
  if (dr203 > 0 && cr203 > 0 && !v.lines.some(l => l.code.startsWith('203004'))
    && v.lines.some(l => l.code.startsWith('203001') || l.code.startsWith('203002'))) return 'cheque_ops';
  if (dr501 > 0 && cr206 > 0 && !hasKol(v, '202')) return 'supplier_payment';
  if (dr501 > 0 && v.lines.some(l => l.code.startsWith('203001') && l.credit > 0)) return 'supplier_payment';
  if (v.lines.some(l => l.code.startsWith('203004') && l.debit > 0) && v.lines.some(l => l.code.startsWith('203001') && l.credit > 0)) return 'cheque_settlement';
  if (dr702 > 0 && cr206 > 0) return 'expense_payment';
  if (dr704 > 0 && cr202 > 0) return 'warehouse_issue';
  if (dr202 > 0 && cr501 > 0) return 'purchase';
  if (dr203 > 0 && cr501 > 0 && !hasKol(v, '202')) return 'person_transfer';
  if (dr206 > 0 && cr206 > 0 && v.lines.every(l => l.kol === '206')) return 'transfer';
  if (dr801 > 0 && cr202 > 0 && !hasKol(v, '601')) return 'cogs_only';
  if (hasKol(v, '701')) return 'payroll';
  if (/کارمزد|هزينه|هزینه/.test(d) && dr206 > 0) return 'expense_payment';
  if (hasKol(v, '906')) return 'adjustment';
  return 'other';
}

/** Extract invoice rows from combined sales+COGS voucher (202 credit lines). */
function extractSalesRows(v) {
  const salesTotal = sumKol(v, '601', 'credit') || sumKol(v, '203', 'debit');
  const invOut = v.lines.filter(l => l.kol === '202' && l.credit > 0);
  if (!invOut.length) {
    const amt = salesTotal;
    return amt > 0 ? [{ taf: null, qty: 1, price: amt, sum: amt, name: 'فروش (بدون تفکیک کالا)' }] : [];
  }
  const costTotal = invOut.reduce((a, l) => a + l.credit, 0) || invOut.length;
  return invOut.map(l => {
    const share = costTotal ? l.credit / costTotal : 1 / invOut.length;
    const sum = Math.round(salesTotal * share);
    return { taf: l.taf, qty: 1, price: sum, sum, name: l.name.split(' - ').pop() };
  });
}

/** Extract purchase rows from 202 debit lines. */
function extractPurchaseRows(v) {
  const invIn = v.lines.filter(l => l.kol === '202' && l.debit > 0);
  const total = sumKol(v, '501', 'credit') || sumKol(v, '202', 'debit');
  if (!invIn.length) return [{ taf: null, qty: 1, price: total, sum: total, name: 'خرید (بدون تفکیک کالا)' }];
  const base = invIn.reduce((a, l) => a + l.debit, 0) || invIn.length;
  return invIn.map(l => {
    const share = base ? l.debit / base : 1 / invIn.length;
    const sum = Math.round(total * share);
    return { taf: l.taf, qty: 1, price: sum, sum, name: l.name.split(' - ').pop() };
  });
}

module.exports = {
  fa, parsePersonName, guessProductCategory, buildAccountUsage, mapPersonAccounts,
  parseMahakJournal, classifyMahakVoucher, sumKol, extractSalesRows, extractPurchaseRows, toman,
};
