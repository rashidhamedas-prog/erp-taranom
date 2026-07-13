#!/usr/bin/env node
// Set product stock quantities from Mahak's inventory report (mojodi.xlsx).
// Run AFTER import-mahak-journal.js on the same DB.
//
//   node server/scripts/import-mahak-stock.js <coding.xlsx> <mojodi.xlsx> <target.db>
//
// Join: mojodi.کد == coding tafsili sheet's کد عملیاتی, filtered to نوع=کالاها
// (operational codes are per-type sequences, so the type filter is essential).
// The inventory file is treated as the authoritative snapshot: products absent
// from it are set to stock=0. Unit cost is recovered from the opening-voucher
// value stashed in the product note by the journal importer (value ÷ qty).
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { guessProductCategory } = require('../lib/mahak-import-helpers');

const [codingPath, mojodiPath, dbPath] = process.argv.slice(2);
if (!codingPath || !mojodiPath || !dbPath) {
  console.error('usage: node import-mahak-stock.js <coding.xlsx> <mojodi.xlsx> <target.db>');
  process.exit(1);
}
process.env.DB_PATH = path.resolve(dbPath);
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const fa = s => String(s == null ? '' : s).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\s+/g, ' ').trim();
const qty = v => Math.round(parseFloat(String(v == null ? '0' : v).replace(/,/g, '')) || 0);

// کد عملیاتی → کد تفصیلی for کالاها only
const cwb = XLSX.readFile(codingPath);
const tafRows = XLSX.utils.sheet_to_json(cwb.Sheets['حسابهای تفصیلی'], { header: 1, raw: false }).slice(1);
const opToTaf = new Map();
for (const r of tafRows) if (fa(r[3]) === 'کالاها') opToTaf.set(fa(r[0]), String(r[1]).trim());

const mwb = XLSX.readFile(mojodiPath);
const rows = XLSX.utils.sheet_to_json(mwb.Sheets[mwb.SheetNames[0]], { header: 1, raw: false }).slice(1).filter(r => r[0]);

const byCode = db.prepare('SELECT id,name,note FROM products WHERE code=?');
const byName = db.prepare('SELECT id,name,note FROM products WHERE name=?');
const upd = db.prepare('UPDATE products SET stock=?, unit=?, cost=?, needs_qty=0, category=?, category_id=? WHERE id=?');
const report = { matched: 0, unmatched: [], zeroed: 0, withCost: 0 };

db.transaction(() => {
  const ensureCat = db.prepare('INSERT OR IGNORE INTO product_categories (name) VALUES (?)');
  const getCatId = db.prepare('SELECT id FROM product_categories WHERE name=? LIMIT 1');
  const seen = new Set();
  for (const r of rows) {
    const op = fa(r[0]), name = fa(r[1]), q = qty(r[2]), unit = fa(r[3]) || 'عدد';
    const taf = opToTaf.get(op);
    let prod = taf ? byCode.get(taf) : null;
    if (!prod) prod = byName.get(name);
    if (!prod) { report.unmatched.push(`${op} | ${name} | qty=${q}`); continue; }
    const catName = guessProductCategory(prod.name || name);
    ensureCat.run(catName);
    const catId = getCatId.get(catName)?.id || null;
    // unit cost from the opening value the journal importer left in the note
    let cost = 0;
    const m = /ارزش افتتاحیه محک: ([\d,]+)/.exec(prod.note || '');
    if (m && q > 0) { cost = Math.round(parseInt(m[1].replace(/,/g, ''), 10) / q); report.withCost++; }
    upd.run(q, unit, cost, catName, catId, prod.id);
    seen.add(prod.id);
    report.matched++;
  }
  // authoritative snapshot: anything not in the file has zero stock
  const rest = db.prepare('SELECT id FROM products WHERE needs_qty=1').all();
  for (const p of rest) { db.prepare('UPDATE products SET stock=0, needs_qty=0 WHERE id=?').run(p.id); report.zeroed++; }
})();

const totalStock = db.prepare('SELECT SUM(stock) s, COUNT(*) c FROM products').get();
const rep = [];
rep.push('# گزارش ورود موجودی محک');
rep.push(`- قلم‌های فایل موجودی: ${rows.length} | تطبیق‌یافته: **${report.matched}** | بدون تطبیق: ${report.unmatched.length}`);
rep.push(`- کالاهای خارج از فایل (موجودی صفر شد): ${report.zeroed}`);
rep.push(`- بهای واحد از ارزش افتتاحیه محاسبه شد: ${report.withCost} قلم`);
rep.push(`- جمع موجودی نهایی: ${totalStock.s} عدد در ${totalStock.c} کالا`);
if (report.unmatched.length) { rep.push('\n## بدون تطبیق (بررسی دستی)'); report.unmatched.forEach(u => rep.push('- ' + u)); }
const repPath = path.join(path.dirname(path.resolve(dbPath)), 'mahak-stock-report.md');
fs.writeFileSync(repPath, rep.join('\n') + '\n');
console.log(`${report.unmatched.length ? '⚠️' : '✅'} matched=${report.matched} unmatched=${report.unmatched.length} zeroed=${report.zeroed} cost-set=${report.withCost}`);
console.log('   total stock:', totalStock.s, '| report:', repPath);
