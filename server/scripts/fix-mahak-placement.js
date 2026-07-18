#!/usr/bin/env node
/**
 * Fix Mahak document placement + subgroup assignment on existing DB.
 * Run after import-mahak-documents.js (phase 4 of mahak-go-live).
 *
 *   node server/scripts/fix-mahak-placement.js <target.db>
 */
const path = require('path');
const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node fix-mahak-placement.js <target.db>');
  process.exit(1);
}
process.env.DB_PATH = path.resolve(dbPath);
const { initDB, getDB } = require('../db');
const { seedMahakSubgroups, guessMahakProductGroup } = require('../lib/currency');
const { classifyMahakVoucher } = require('../lib/mahak-import-helpers');

initDB();
const db = getDB();
seedMahakSubgroups(db);

// Ensure currency base is Rial
db.prepare("INSERT INTO settings (key,value) VALUES ('currency_base','rial') ON CONFLICT(key) DO UPDATE SET value='rial'").run();
if (!db.prepare("SELECT value FROM settings WHERE key='currency_display'").get()?.value) {
  db.prepare("INSERT INTO settings (key,value) VALUES ('currency_display','rial') ON CONFLICT(key) DO UPDATE SET value='rial'").run();
}

const custGrp = db.prepare("SELECT id FROM party_groups WHERE name='مشتریان' LIMIT 1").get()?.id;
const supGrp = db.prepare("SELECT id FROM party_groups WHERE name='فروشندگان' LIMIT 1").get()?.id;
const storeGrp = db.prepare("SELECT id FROM party_groups WHERE name='فروشگاه‌های ترنم' LIMIT 1").get()?.id;
const personGrp = db.prepare("SELECT id FROM party_groups WHERE name='پرسنل' LIMIT 1").get()?.id;

const stats = { customers: 0, suppliers: 0, persons: 0, products: 0, journals: 0, doc_types: 0, relinked: 0 };

// Assign party groups to customers
for (const c of db.prepare('SELECT id,biz,party_group_id FROM customers').all()) {
  if (c.party_group_id) continue;
  const isStore = /فروشگاه|ترنم/i.test(c.biz || '');
  const gid = isStore ? storeGrp : custGrp;
  if (gid) { db.prepare('UPDATE customers SET party_group_id=? WHERE id=?').run(gid, c.id); stats.customers++; }
}

// Assign party groups to suppliers
if (supGrp) {
  stats.suppliers = db.prepare('UPDATE suppliers SET party_group_id=? WHERE party_group_id IS NULL').run(supGrp).changes;
}

// Assign party groups to persons (default: پرسنل)
if (personGrp) {
  stats.persons = db.prepare('UPDATE persons SET party_group_id=? WHERE party_group_id IS NULL').run(personGrp).changes;
}

// Assign product categories from Mahak groups
const getCatId = db.prepare('SELECT id FROM product_categories WHERE name=? LIMIT 1');
const insCat = db.prepare('INSERT OR IGNORE INTO product_categories (name,code,sort_order) VALUES (?,?,?)');
for (const p of db.prepare('SELECT id,name,category_id FROM products').all()) {
  const grp = guessMahakProductGroup(p.name);
  insCat.run(grp, 0, 0);
  const catId = getCatId.get(grp)?.id;
  if (catId && catId !== p.category_id) {
    db.prepare('UPDATE products SET category_id=?, category=? WHERE id=?').run(catId, grp, p.id);
    stats.products++;
  }
}

// Build voucher map from journal
const entries = db.prepare("SELECT id,src_doc_no,ref_type,ref_id,description,entry_date FROM journal_entries WHERE src_system='mahak'").all();
const linesByDoc = new Map();
for (const e of entries) {
  const lines = db.prepare('SELECT account_code code,account_name name,debit,credit FROM journal_lines WHERE entry_id=?').all(e.id)
    .map(l => ({ ...l, kol: l.code.slice(0, 3), taf: l.code.slice(6) }));
  linesByDoc.set(e.src_doc_no, { id: e.id, ref_type: e.ref_type, ref_id: e.ref_id, desc: e.description, date: e.entry_date, lines });
}

// Document type → table + ref_type mapping
const TYPE_MAP = {
  sales_invoice: { table: 'invoices', ref: 'invoice', idCol: 'id' },
  sales_return: { table: 'sales_returns', ref: 'sales_return', idCol: 'id' },
  receipt: { table: 'settlements', ref: 'settlement', idCol: 'id' },
  cheque_settlement: { table: 'settlements', ref: 'settlement', idCol: 'id' },
  purchase: { table: 'purchase_invoices', ref: 'purchase', idCol: 'id' },
  purchase_return: { table: 'purchase_returns', ref: 'purchase_return', idCol: 'id' },
  supplier_payment: { table: 'supplier_payments', ref: 'supplier_payment', idCol: 'id' },
  expense_payment: { table: 'expense_payments', ref: 'expense_payment', idCol: 'id' },
  warehouse_issue: { table: 'warehouse_moves', ref: 'warehouse_move', idCol: 'id' },
  warehouse_receipt: { table: 'warehouse_moves', ref: 'warehouse_move', idCol: 'id' },
  warehouse_transfer: { table: 'warehouse_moves', ref: 'warehouse_move', idCol: 'id' },
  transfer: { table: 'account_transfers', ref: 'transfer', idCol: 'id' },
  payroll: { table: 'payroll_records', ref: 'payroll', idCol: 'id' },
  opening: { table: null, ref: 'fiscal_opening', idCol: null },
  account_transfer: { table: 'account_transfers', ref: 'transfer', idCol: 'id' },
  stocktaking: { table: null, ref: 'manual_voucher', idCol: null },
  production: { table: 'production_runs', ref: 'production', idCol: 'id' },
};

for (const [docNo, je] of linesByDoc) {
  const v = { desc: je.desc, atf: '', lines: je.lines };
  let type = classifyMahakVoucher(docNo, v);

  // Refine payment types
  const sumKol = (kol, side) => je.lines.filter(l => l.kol === kol).reduce((a, l) => a + l[side], 0);
  if (type === 'payment') {
    if (sumKol('501', 'debit') > 0 && (sumKol('206', 'credit') > 0 || je.lines.some(l => l.code.startsWith('203001') && l.credit > 0)))
      type = 'supplier_payment';
    else if (sumKol('702', 'debit') > 0 || sumKol('704', 'debit') > 0) type = 'expense_payment';
    else if (je.lines.some(l => l.code.startsWith('203004') && l.debit > 0) && je.lines.some(l => l.code.startsWith('203001') && l.credit > 0))
      type = 'cheque_settlement';
    else if (sumKol('203', 'credit') > 0 && sumKol('206', 'debit') > 0) type = 'receipt';
  }

  const mapping = TYPE_MAP[type];
  if (!mapping) continue;

  // Set mahak_doc_type on operational table
  if (mapping.table) {
    const r = db.prepare(`UPDATE ${mapping.table} SET mahak_doc_type=? WHERE mahak_doc_no=? AND (mahak_doc_type IS NULL OR mahak_doc_type='')`).run(type, docNo);
    stats.doc_types += r.changes;

    // Relink journal to operational doc if still mahak_import/manual_voucher
    if (je.ref_type === 'mahak_import' || (je.ref_type === 'manual_voucher' && mapping.ref !== 'manual_voucher')) {
      const doc = db.prepare(`SELECT ${mapping.idCol} id FROM ${mapping.table} WHERE mahak_doc_no=? ORDER BY id DESC LIMIT 1`).get(docNo);
      if (doc) {
        db.prepare('UPDATE journal_entries SET ref_type=?, ref_id=? WHERE id=?').run(mapping.ref, doc.id, je.id);
        stats.relinked++;
      }
    }
  } else if (type === 'opening' && je.ref_type === 'mahak_import') {
    db.prepare('UPDATE journal_entries SET ref_type=? WHERE id=?').run('fiscal_opening', je.id);
    stats.relinked++;
  } else if ((type === 'stocktaking' || type === 'account_transfer' || type === 'cheque_ops') && je.ref_type === 'mahak_import') {
    db.prepare('UPDATE journal_entries SET ref_type=?, ref_id=? WHERE id=?').run('manual_voucher', null, je.id);
    stats.relinked++;
  }
}

// Count remaining unlinked
const remaining = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type='mahak_import'").get().c;
stats.remaining_mahak_import = remaining;

console.log('fix-mahak-placement:', JSON.stringify(stats, null, 2));
console.log('party_groups:', db.prepare('SELECT COUNT(*) c FROM party_groups').get().c);
console.log('product_categories:', db.prepare('SELECT COUNT(*) c FROM product_categories').get().c);
console.log('currency_base:', db.prepare("SELECT value FROM settings WHERE key='currency_base'").get()?.value);
console.log('currency_display:', db.prepare("SELECT value FROM settings WHERE key='currency_display'").get()?.value);
