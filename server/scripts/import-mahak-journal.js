#!/usr/bin/env node
// Import the full Mahak accounting books into a fresh CRM Taranom database.
// docs/MAHAK-MIGRATION.md is the authoritative spec (owner-approved decisions).
//
//   node server/scripts/import-mahak-journal.js <coding.xlsx> <roznameh.xlsx> <target.db> [--force]
//
// Everything runs in ONE transaction: chart of accounts (4-level Mahak tree),
// products/banks/cash-boxes/warehouses from tafsili definitions, and every
// journal voucher (amounts rial→toman ÷10 rounded PER LINE; unbalanced
// vouchers get an explicit adjustment line on account 906001). Verification
// runs inside the same process and a mahak-import-report.md is written next
// to the target DB. Any failed assertion rolls the whole import back.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const [codingPath, journalPath, dbPath] = process.argv.slice(2);
const FORCE = process.argv.includes('--force');
if (!codingPath || !journalPath || !dbPath) {
  console.error('usage: node import-mahak-journal.js <coding.xlsx> <roznameh.xlsx> <target.db> [--force]');
  process.exit(1);
}
process.env.DB_PATH = path.resolve(dbPath);

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const fa = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const num = v => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
const toman = rial => Math.round(rial / 10);          // decision #1: rial ÷ 10, per line

// group نوع → app account type (drives balance sheet / P&L classification)
const TYPE_MAP = { 'دارايي': 'asset', 'دارایی': 'asset', 'بدهي': 'liability', 'بدهی': 'liability', 'سرمايه': 'equity', 'سرمایه': 'equity', 'درآمد': 'revenue', 'هزينه': 'expense', 'هزینه': 'expense' };
// unused-tafsili default معین per tafsili type (spec §4-A-3)
const TAF_DEFAULT_MOEIN = { 'اشخاص': '203004', 'کالاها': '202001', 'بانک ها': '206001', 'صندوق ها': '206002', 'هزينه ها': '702001', 'درآمدها': '601001', 'انبارها': '202001', 'ساير حساب هاي تفصيلي': '204001', '': '204001' };

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error('sheet not found: ' + name);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }).slice(1);
}

// ---------- parse coding ----------
const cwb = XLSX.readFile(codingPath);
const groups = sheetRows(cwb, 'گروه حساب ها').filter(r => r[0] && r[0] !== '0');
const kols = sheetRows(cwb, 'حسابهای کل').filter(r => r[0]);
const moeins = sheetRows(cwb, 'حسابهای معین').filter(r => r[0]);
const tafs = sheetRows(cwb, 'حسابهای تفصیلی').filter(r => r[1]);
const moeinName = {}; moeins.forEach(r => { moeinName[String(r[0]).padStart(3, '0')] = fa(r[1]); });
const tafInfo = {};   tafs.forEach(r => { tafInfo[String(r[1]).trim()] = { name: fa(r[2]), type: fa(r[3]) }; });
const kolInfo = {};   kols.forEach(r => { kolInfo[String(r[0]).trim()] = { name: fa(r[1]), nature: fa(r[3]) }; });
const groupInfo = {}; groups.forEach(r => { groupInfo[String(r[0]).trim()] = { name: fa(r[1]), type: TYPE_MAP[fa(r[2])] || 'expense' }; });

// ---------- parse journal ----------
const jwb = XLSX.readFile(journalPath);
const jrows = XLSX.utils.sheet_to_json(jwb.Sheets[jwb.SheetNames[0]], { header: 1, raw: false }).slice(1);
const vouchers = new Map();   // docNo → {date, atf, desc, lines:[{code,name,debit,credit}]}
for (const r of jrows) {
  const code = String(r[3] == null ? '' : r[3]).trim();
  const docNo = String(r[2] == null ? '' : r[2]).trim();
  if (!docNo) continue;
  if (!vouchers.has(docNo)) vouchers.set(docNo, { date: fa(r[0]), atf: fa(r[1]), desc: '', lines: [] });
  const v = vouchers.get(docNo);
  if (!code) { if (!v.desc) v.desc = fa(r[4]); continue; }         // trailing description row
  if (!/^\d{12}$/.test(code)) throw new Error(`unexpected account code "${code}" in doc ${docNo}`);
  const debit = toman(num(r[5])), credit = toman(num(r[6]));
  if (debit === 0 && credit === 0) continue;
  v.lines.push({ code, name: fa(r[4]), debit, credit });
}
const docList = [...vouchers.entries()]
  .filter(([, v]) => v.lines.length)
  .sort((a, b) => a[1].date === b[1].date ? (+a[0]) - (+b[0]) : (a[1].date < b[1].date ? -1 : 1));

// codes actually used + best (most frequent) full code per tafsili
const usedFull = new Map();                                  // full 12-digit → count
const tafBestFull = new Map();                               // taf6 → full code with max count
for (const [, v] of docList) for (const l of v.lines) usedFull.set(l.code, (usedFull.get(l.code) || 0) + 1);
for (const [full, c] of usedFull) {
  const taf = full.slice(6);
  if (!tafBestFull.has(taf) || usedFull.get(tafBestFull.get(taf)) < c) tafBestFull.set(taf, full);
}

// ---------- guards ----------
const existing = db.prepare("SELECT COUNT(*) c FROM journal_entries").get().c;
if (existing > 0 && !FORCE) {
  console.error(`✋ target DB already has ${existing} journal entries — use a FRESH database (or --force on a scratch copy).`);
  process.exit(1);
}
const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;

// ---------- import (single transaction) ----------
const report = { adjustments: [], warnings: [], openings: [] };
const stats = db.transaction(() => {
  const insCoa = db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,nature,tafsili_type)
                             VALUES (?,?,?,?,?,?,?)
                             ON CONFLICT(code) DO UPDATE SET name=excluded.name, level=excluded.level,
                               parent_code=excluded.parent_code, nature=excluded.nature, tafsili_type=excluded.tafsili_type`);
  const typeOfKol = kol => (groupInfo[kol[0]] || { type: 'expense' }).type;

  // level 1..2
  for (const [g, info] of Object.entries(groupInfo)) insCoa.run(g, info.name, info.type, null, 1, null, null);
  for (const [k, info] of Object.entries(kolInfo)) insCoa.run(k, info.name, typeOfKol(k), k[0], 2, info.nature, null);

  // level 3 (کل+معین) from codes seen in the journal
  const level3 = new Set();
  const addL3 = six => {
    if (level3.has(six)) return;
    level3.add(six);
    const kol = six.slice(0, 3), mo = six.slice(3);
    insCoa.run(six, `${(kolInfo[kol] || { name: kol }).name} — ${moeinName[mo] || 'معین ' + mo}`,
      typeOfKol(kol), kol, 3, (kolInfo[kol] || {}).nature || null, null);
  };
  for (const full of usedFull.keys()) addL3(full.slice(0, 6));
  for (const six of Object.values(TAF_DEFAULT_MOEIN)) addL3(six);
  addL3('906001');                                            // adjustments home

  // level 4 (full 12-digit) — every tafsili, journal-used code wins
  let tafCount = 0;
  for (const [taf, info] of Object.entries(tafInfo)) {
    const full = tafBestFull.get(taf) || (TAF_DEFAULT_MOEIN[info.type] || '204001') + taf;
    insCoa.run(full, info.name, typeOfKol(full.slice(0, 3)), full.slice(0, 6), 4, null, info.type);
    tafCount++;
  }
  // journal codes whose tafsili is missing from the coding file
  for (const full of usedFull.keys()) {
    if (!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(full)) {
      const line = docList.flatMap(([, v]) => v.lines).find(l => l.code === full);
      const nm = line ? fa(line.name.split(' - ').pop()) : 'حساب ' + full;
      insCoa.run(full, nm, typeOfKol(full.slice(0, 3)), full.slice(0, 6), 4, null, null);
      report.warnings.push(`کد ${full} در روزنامه هست ولی در فایل کدینگ نبود — با نام «${nm}» ساخته شد`);
    }
  }

  // operational entities from tafsili types (decisions #5, #6)
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const insProd = db.prepare(`INSERT INTO products (user_id,category,code,name,price,cost,stock,stock_alert,unit,coa_code,needs_qty,note,warehouse_id)
                              VALUES (?,?,?,?,0,0,0,5,'عدد',?,1,?,?)`);
  const insBank = db.prepare('INSERT INTO banks (name,account_number,branch,coa_code) VALUES (?,?,?,?)');
  const insBox = db.prepare('INSERT INTO cash_boxes (name,coa_code) VALUES (?,?)');
  const insWh = db.prepare('INSERT INTO warehouses (name) VALUES (?)');
  // opening values from voucher #1 (1405/01/01) — kept for the report/product note
  const opening = new Map();
  const v1 = vouchers.get('1');
  if (v1) for (const l of v1.lines) if (l.debit > 0) opening.set(l.code.slice(6), l.debit);

  let products = 0, banks = 0, boxes = 0, whs = 0;
  for (const [taf, info] of Object.entries(tafInfo)) {
    const full = tafBestFull.get(taf) || (TAF_DEFAULT_MOEIN[info.type] || '204001') + taf;
    if (info.type === 'کالاها') {
      const opv = opening.get(taf);
      insProd.run(adminId, 'محک', taf, info.name, full,
        opv ? `ارزش افتتاحیه محک: ${opv.toLocaleString('en-US')} تومان — تعداد را تعیین کنید` : 'ورود از محک — تعداد را تعیین کنید',
        wh ? wh.id : null);
      if (opv) report.openings.push({ taf, name: info.name, value: opv });
      products++;
    } else if (info.type === 'بانک ها') { insBank.run(info.name, '', 'ورود از محک', full); banks++; }
    else if (info.type === 'صندوق ها') { insBox.run(info.name, full); boxes++; }
    else if (info.type === 'انبارها') { insWh.run(info.name); whs++; }
  }

  // vouchers
  const insEntry = db.prepare(`INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,created_by,src_system,src_doc_no,src_atf)
                               VALUES (?,?,?,NULL,?,'mahak',?,?)`);
  const insLine = db.prepare('INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit) VALUES (?,?,?,?,?)');
  let entries = 0, lines = 0;
  for (const [docNo, v] of docList) {
    let deb = 0, cre = 0;
    for (const l of v.lines) { deb += l.debit; cre += l.credit; }
    const eid = insEntry.run(v.date, v.desc || `سند محک ${docNo}`, 'mahak_import', adminId, docNo, v.atf).lastInsertRowid;
    for (const l of v.lines) {
      const tafName = (tafInfo[l.code.slice(6)] || {}).name || fa(l.name.split(' - ').pop());
      insLine.run(eid, l.code, tafName, l.debit, l.credit);
      lines++;
    }
    const diff = deb - cre;
    if (diff !== 0) {
      insLine.run(eid, '906001', 'اصلاحات و تعدیلات',
        diff < 0 ? -diff : 0, diff > 0 ? diff : 0);
      lines++;
      report.adjustments.push({ docNo, date: v.date, diff });
    }
    entries++;
  }

  // settings: coa mode + control-account mapping (spec §3.2)
  const best = kol => { let b = null, c = -1; for (const [f, n] of usedFull) if (f.startsWith(kol) && n > c) { b = f; c = n; } return b; };
  const setS = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const mapping = {
    coa_mode: 'mahak',
    coa_receivable: '203004', coa_payable: '501002',
    coa_sales: best('601001') || '601001', coa_sales_discount: best('601004') || '601004',
    coa_cogs: best('801') || '801001', coa_inventory: '202001',
    coa_cash_default: tafBestFull.get('500001') || '206002500001',
    coa_bank_default: '206001', coa_adjustment: '906001',
    coa_payroll_expense: best('701') || '701001', coa_payroll_payable: '501002',
    coa_misc_persons: '204001', feature_cogs_voucher: '1'
  };
  for (const [k, val] of Object.entries(mapping)) setS.run(k, String(val));

  // ---- verification INSIDE the transaction: any failure rolls everything back ----
  const tb = db.prepare(`SELECT SUM(debit) d, SUM(credit) c FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.src_system='mahak'`).get();
  const perKol = db.prepare(`SELECT substr(account_code,1,3) k, SUM(debit) d, SUM(credit) c
                             FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
                             WHERE je.src_system='mahak' AND account_code!='906001' GROUP BY k ORDER BY k`).all();
  const srcKol = {};
  for (const [, v] of docList) for (const l of v.lines) {
    const k = l.code.slice(0, 3);
    srcKol[k] = srcKol[k] || { d: 0, c: 0 };
    srcKol[k].d += l.debit; srcKol[k].c += l.credit;
  }
  const failures = [];
  if (Math.round(tb.d) !== Math.round(tb.c)) failures.push(`تراز کل نامتراز: ${tb.d} vs ${tb.c}`);
  if (entries !== docList.length) failures.push(`تعداد سند: ${entries} != ${docList.length}`);
  for (const row of perKol) {
    const s = srcKol[row.k] || { d: 0, c: 0 };
    if (Math.round(row.d) !== Math.round(s.d) || Math.round(row.c) !== Math.round(s.c))
      failures.push(`گردش کل ${row.k}: DB(${row.d}/${row.c}) != منبع(${s.d}/${s.c})`);
  }
  const orphan = db.prepare(`SELECT COUNT(*) c FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
                             WHERE je.src_system='mahak' AND jl.account_code NOT IN (SELECT code FROM chart_of_accounts)`).get().c;
  if (orphan) failures.push(`${orphan} آرتیکل با کد حساب خارج از کدینگ`);
  if (failures.length) throw new Error('VERIFY_FAILED:\n' + failures.join('\n'));

  return { entries, lines, tafCount, products, banks, boxes, whs, mapping, tb, perKol };
})();
const { tb, perKol } = stats;
const failures = [];

// ---------- report ----------
const rep = [];
rep.push('# گزارش ورود اسناد محک به CRM ترنم');
rep.push(`- تاریخ اجرا: ${new Date().toISOString()}`);
rep.push(`- سند: **${stats.entries}** | آرتیکل: **${stats.lines}** (شامل ${report.adjustments.length} خط تعدیل)`);
rep.push(`- حساب تفصیلی: ${stats.tafCount} | محصول: ${stats.products} (همه نیازمند تعیین تعداد) | بانک: ${stats.banks} | صندوق: ${stats.boxes} | انبار: ${stats.whs}`);
rep.push(`- جمع بدهکار=بستانکار: **${Math.round(tb.d).toLocaleString('en-US')} تومان** ${Math.round(tb.d) === Math.round(tb.c) ? '✅' : '❌'}`);
rep.push('\n## گردش حساب‌های کل (تومان — مقایسه با محک ÷۱۰)');
rep.push('| کل | نام | بدهکار | بستانکار |'); rep.push('|---|---|---|---|');
for (const row of perKol) rep.push(`| ${row.k} | ${(kolInfo[row.k] || {}).name || ''} | ${Math.round(row.d).toLocaleString('en-US')} | ${Math.round(row.c).toLocaleString('en-US')} |`);
rep.push(`\n## تعدیل‌های کسری (${report.adjustments.length} سند — تصمیم ۴)`);
rep.push('| ش سند | تاریخ | اختلاف (تومان) |'); rep.push('|---|---|---|');
for (const a of report.adjustments) rep.push(`| ${a.docNo} | ${a.date} | ${a.diff} |`);
if (report.warnings.length) { rep.push('\n## هشدارها'); report.warnings.forEach(w => rep.push('- ' + w)); }
rep.push(`\n## ارزش افتتاحیه کالاها (${report.openings.length} قلم از سند ۱)`);
report.openings.slice(0, 30).forEach(o => rep.push(`- ${o.name}: ${o.value.toLocaleString('en-US')} تومان`));
if (report.openings.length > 30) rep.push(`- ... و ${report.openings.length - 30} قلم دیگر`);
if (failures.length) { rep.push('\n## ❌ خطاهای راستی‌آزمایی'); failures.forEach(f => rep.push('- ' + f)); }
const repPath = path.join(path.dirname(path.resolve(dbPath)), 'mahak-import-report.md');
fs.writeFileSync(repPath, rep.join('\n') + '\n');

console.log(`\n${failures.length ? '❌ FAILED' : '✅ OK'} — entries=${stats.entries} lines=${stats.lines} adjustments=${report.adjustments.length}`);
console.log(`   debit=credit=${Math.round(tb.d).toLocaleString('en-US')} toman`);
console.log(`   report: ${repPath}`);
if (failures.length) { failures.forEach(f => console.error('  ✗ ' + f)); process.exit(1); }
