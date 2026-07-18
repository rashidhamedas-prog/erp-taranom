#!/usr/bin/env node
/** Deep analysis of Mahak Excel files before import — run locally, no DB writes. */
const path = require('path');
const XLSX = require('xlsx');

const codingPath = process.argv[2] || path.join(__dirname, '../../..', 'coding hesbha.xlsx');
const journalPath = process.argv[3] || path.join(__dirname, '../../..', 'daftar roznameh.xlsx');
const mojodiPath = process.argv[4] || path.join(__dirname, '../../..', 'mojodi.xlsx');

const fa = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const num = v => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
const toman = rial => Math.round(rial / 10);

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
}

// --- coding ---
const cwb = XLSX.readFile(codingPath);
const tafRows = sheetRows(cwb, 'حسابهای تفصیلی').slice(1).filter(r => r[1]);
const tafByType = {};
const tafByCode = {};
for (const r of tafRows) {
  const op = fa(r[0]), code = String(r[1]).trim(), name = fa(r[2]), type = fa(r[3]);
  tafByCode[code] = { op, name, type };
  tafByType[type] = tafByType[type] || [];
  tafByType[type].push({ code, name, op });
}

// --- journal ---
const jwb = XLSX.readFile(journalPath);
const jrows = sheetRows(jwb, jwb.SheetNames[0]).slice(1);
const vouchers = new Map();
const accountUsage = new Map(); // full12 -> {debit,credit,count,kol,moein,taf}

for (const r of jrows) {
  const code = String(r[3] == null ? '' : r[3]).trim();
  const docNo = String(r[2] == null ? '' : r[2]).trim();
  if (!docNo) continue;
  if (!vouchers.has(docNo)) vouchers.set(docNo, { date: fa(r[0]), atf: fa(r[1]), desc: '', lines: [] });
  const v = vouchers.get(docNo);
  if (!code) { if (!v.desc) v.desc = fa(r[4]); continue; }
  const debit = toman(num(r[5])), credit = toman(num(r[6]));
  if (debit === 0 && credit === 0) continue;
  v.lines.push({ code, name: fa(r[4]), debit, credit });
  const u = accountUsage.get(code) || { debit: 0, credit: 0, count: 0, kol: code.slice(0, 3), moein: code.slice(3, 6), taf: code.slice(6) };
  u.debit += debit; u.credit += credit; u.count++;
  accountUsage.set(code, u);
}

const docList = [...vouchers.values()].filter(v => v.lines.length);

// Classify persons by kol prefix in journal usage
const receivablePersons = []; // kol 203 + taf type اشخاص
const payablePersons = [];      // kol 501 + taf type اشخاص
const miscPersons = [];         // kol 204

for (const [full, u] of accountUsage) {
  const info = tafByCode[u.taf];
  if (!info || info.type !== 'اشخاص') continue;
  const net = u.debit - u.credit;
  const row = { full, code: u.taf, name: info.name, kol: u.kol, moein: u.moein, debit: u.debit, credit: u.credit, net, txCount: u.count };
  if (u.kol === '203') receivablePersons.push(row);
  else if (u.kol === '501') payablePersons.push(row);
  else if (u.kol === '204') miscPersons.push(row);
}
receivablePersons.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
payablePersons.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

// Document description patterns
const descPatterns = {};
for (const [, v] of vouchers) {
  if (!v.desc) continue;
  const d = v.desc;
  let key = 'سایر';
  if (/فاکتور|فروش|pre/i.test(d)) key = 'فروش/فاکتور';
  else if (/خرید|خريد/.test(d)) key = 'خرید';
  else if (/دریافت|دريافت|واریز|واريز/.test(d)) key = 'دریافت';
  else if (/پرداخت|پرداخت/.test(d)) key = 'پرداخت';
  else if (/حقوق|دستمزد/.test(d)) key = 'حقوق';
  else if (/افتتاح|افتتاحيه|سند افتتاح/.test(d)) key = 'افتتاحیه';
  else if (/بهاي تمام|بهای تمام|COGS|بهاي/.test(d)) key = 'بهای تمام‌شده';
  else if (/انتقال|جابجا/.test(d)) key = 'انتقال';
  else if (/تعدیل|اصلاح/.test(d)) key = 'تعدیل';
  else if (/چک|صیادی/.test(d)) key = 'چک';
  descPatterns[key] = (descPatterns[key] || 0) + 1;
}

// mojodi analysis
const mwb = XLSX.readFile(mojodiPath);
const mrows = sheetRows(mwb, mwb.SheetNames[0]);
const mHeader = mrows[0];
const mData = mrows.slice(1).filter(r => r[0]);
const mojodiItems = mData.map(r => ({ op: fa(r[0]), name: fa(r[1]), qty: Math.round(num(r[2])), unit: fa(r[3]) || 'عدد' }));

// Match mojodi to taf coding
let matchedProducts = 0, unmatchedMojodi = [];
const opToTaf = new Map();
for (const r of tafRows) if (fa(r[3]) === 'کالاها') opToTaf.set(fa(r[0]), String(r[1]).trim());

for (const m of mojodiItems) {
  const taf = opToTaf.get(m.op);
  if (taf && tafByCode[taf]) matchedProducts++;
  else unmatchedMojodi.push(m);
}

// Products in coding but not in mojodi
const mojodiTafSet = new Set(mojodiItems.map(m => opToTaf.get(m.op)).filter(Boolean));
const productsNoStock = (tafByType['کالاها'] || []).filter(t => !mojodiTafSet.has(t.code));

// Kol-level summary
const kolSummary = {};
for (const [, u] of accountUsage) {
  kolSummary[u.kol] = kolSummary[u.kol] || { d: 0, c: 0, accounts: new Set() };
  kolSummary[u.kol].d += u.debit;
  kolSummary[u.kol].c += u.credit;
  kolSummary[u.kol].accounts.add(u.taf);
}

console.log('=== MAHAK DEEP ANALYSIS ===\n');
console.log('Coding tafsili by type:');
for (const [type, list] of Object.entries(tafByType).sort((a, b) => b[1].length - a[1].length))
  console.log(`  ${type}: ${list.length}`);

console.log(`\nJournal: ${docList.length} vouchers, ${jrows.length} raw rows`);
console.log('\nDocument description patterns:');
Object.entries(descPatterns).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

console.log('\nKol-level turnover (toman):');
Object.entries(kolSummary).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) =>
  console.log(`  ${k}: Dr ${v.d.toLocaleString()} Cr ${v.c.toLocaleString()} (${v.accounts.size} tafsili)`));

console.log(`\nReceivable persons (203+اشخاص): ${receivablePersons.length}`);
receivablePersons.slice(0, 15).forEach(p => console.log(`  ${p.code} ${p.name} net=${p.net.toLocaleString()} tx=${p.txCount}`));

console.log(`\nPayable persons (501+اشخاص): ${payablePersons.length}`);
payablePersons.slice(0, 15).forEach(p => console.log(`  ${p.code} ${p.name} net=${p.net.toLocaleString()} tx=${p.txCount}`));

console.log(`\nMisc persons (204): ${miscPersons.length}`);
miscPersons.slice(0, 10).forEach(p => console.log(`  ${p.code} ${p.name} net=${p.net.toLocaleString()}`));

console.log(`\nMojodi: ${mojodiItems.length} rows, matched to coding: ${matchedProducts}, unmatched: ${unmatchedMojodi.length}`);
if (unmatchedMojodi.length) unmatchedMojodi.slice(0, 10).forEach(m => console.log(`  UNMATCHED: ${m.op} ${m.name} qty=${m.qty}`));

console.log(`\nProducts in coding without mojodi row: ${productsNoStock.length} (will be stock=0)`);
console.log(`Total mojodi qty: ${mojodiItems.reduce((s, m) => s + m.qty, 0)}`);

// Sample vouchers by type
console.log('\nSample voucher descriptions:');
const samples = { 'افتتاحیه': null, 'فروش/فاکتور': null, 'خرید': null, 'دریافت': null, 'پرداخت': null, 'بهای تمام‌شده': null };
for (const [docNo, v] of vouchers) {
  for (const key of Object.keys(samples)) {
    if (samples[key]) continue;
    const d = v.desc || '';
    if (key === 'افتتاحیه' && /افتتاح/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
    if (key === 'فروش/فاکتور' && /فاکتور|فروش/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
    if (key === 'خرید' && /خرید|خريد/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
    if (key === 'دریافت' && /دریافت|واریز/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
    if (key === 'پرداخت' && /پرداخت/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
    if (key === 'بهای تمام‌شده' && /بهاي تمام|بهای تمام/.test(d)) samples[key] = { docNo, date: v.date, desc: d.slice(0, 80), lines: v.lines.length };
  }
}
for (const [k, s] of Object.entries(samples)) if (s) console.log(`  [${k}] doc ${s.docNo} ${s.date}: ${s.desc} (${s.lines} lines)`);
