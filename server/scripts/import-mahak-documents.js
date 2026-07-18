#!/usr/bin/env node
/**
 * Reconstruct operational documents from Mahak journal vouchers.
 * Run AFTER import-mahak-journal.js + import-mahak-stock.js on the same DB.
 *
 *   node server/scripts/import-mahak-documents.js <roznameh.xlsx> <target.db> [--force]
 *
 * Creates invoices, settlements, purchases, payments, warehouse moves, transfers,
 * payroll records — each linked to its existing mahak journal entry (src_doc_no).
 * Historical import: does NOT mutate product stock (snapshot already loaded).
 */
const path = require('path');
const fs = require('fs');
const {
  parseMahakJournal, classifyMahakVoucher, sumKol, extractSalesRows, extractPurchaseRows,
} = require('../lib/mahak-import-helpers');

const [journalPath, dbPath] = process.argv.slice(2);
const FORCE = process.argv.includes('--force');
if (!journalPath || !dbPath) {
  console.error('usage: node import-mahak-documents.js <roznameh.xlsx> <target.db> [--force]');
  process.exit(1);
}
process.env.DB_PATH = path.resolve(dbPath);
const { initDB, getDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

for (const tbl of ['invoices', 'purchase_invoices', 'settlements', 'supplier_payments', 'expense_payments', 'warehouse_moves', 'account_transfers', 'payroll_records', 'sales_returns', 'purchase_returns']) {
  ensureColumn(tbl, 'mahak_doc_no', 'TEXT');
  ensureColumn(tbl, 'mahak_doc_type', 'TEXT');
}

const existing = db.prepare("SELECT COUNT(*) c FROM invoices WHERE mahak_doc_no IS NOT NULL AND mahak_doc_no<>''").get().c;
if (existing > 0 && !FORCE) {
  console.error(`✋ DB already has ${existing} imported Mahak documents — use --force on a fresh import.`);
  process.exit(1);
}

const vouchers = parseMahakJournal(journalPath);
const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
const defaultWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id || null;

function buildLookups() {
  const custByCoa = new Map();
  for (const r of db.prepare('SELECT id,coa_code FROM customers WHERE coa_code IS NOT NULL').all())
    custByCoa.set(r.coa_code, r.id);
  const supByCoa = new Map();
  for (const r of db.prepare('SELECT id,coa_code FROM suppliers WHERE coa_code IS NOT NULL').all())
    supByCoa.set(r.coa_code, r.id);
  const prodByCode = new Map();
  for (const r of db.prepare('SELECT id,code,name,warehouse_id,price,cost FROM products').all())
    prodByCode.set(String(r.code).trim(), r);
  const bankByCoa = new Map();
  for (const r of db.prepare('SELECT id,coa_code,name FROM banks WHERE coa_code IS NOT NULL').all())
    bankByCoa.set(r.coa_code, r.id);
  const boxByCoa = new Map();
  for (const r of db.prepare('SELECT id,coa_code,name FROM cash_boxes WHERE coa_code IS NOT NULL').all())
    boxByCoa.set(r.coa_code, r.id);
  const personByCoa = new Map();
  for (const r of db.prepare('SELECT id,coa_code,name FROM persons WHERE coa_code IS NOT NULL').all())
    personByCoa.set(r.coa_code, r);
  return { custByCoa, supByCoa, prodByCode, bankByCoa, boxByCoa, personByCoa };
}

function linkJournal(docNo, refType, refId) {
  const je = db.prepare("SELECT id FROM journal_entries WHERE src_system='mahak' AND src_doc_no=?").get(String(docNo));
  if (je) db.prepare('UPDATE journal_entries SET ref_type=?, ref_id=? WHERE id=?').run(refType, refId, je.id);
  return je?.id || null;
}

function resolveCashFrom206(v, lookups) {
  const dr = v.lines.find(l => l.kol === '206' && l.debit > 0);
  const cr = v.lines.find(l => l.kol === '206' && l.credit > 0);
  const line = dr || cr;
  if (!line) return { pay_type: 'cash', bank_id: null, cash_box_id: null };
  if (lookups.bankByCoa.has(line.code)) return { pay_type: 'cash', bank_id: lookups.bankByCoa.get(line.code), cash_box_id: null };
  if (lookups.boxByCoa.has(line.code)) return { pay_type: 'cash', bank_id: null, cash_box_id: lookups.boxByCoa.get(line.code) };
  if (line.code.startsWith('206001')) return { pay_type: 'cash', bank_id: lookups.bankByCoa.get(line.code) || null, cash_box_id: null };
  if (line.code.startsWith('206002')) return { pay_type: 'cash', bank_id: null, cash_box_id: lookups.boxByCoa.get(line.code) || null };
  return { pay_type: 'cash', bank_id: null, cash_box_id: null };
}

function custFrom203(v, lookups, mode = 'invoice') {
  const commercial = v.lines.filter(x => x.kol === '203' && x.code.startsWith('203004'));
  const pick = mode === 'receipt'
    ? commercial.find(x => x.credit > 0) || commercial.find(x => x.debit > 0)
    : commercial.find(x => x.debit > 0) || commercial.find(x => x.credit > 0);
  return pick ? lookups.custByCoa.get(pick.code) : null;
}

function ensureCustomer(db, lookups, adminId, fullCode, lineName) {
  const existing = lookups.custByCoa.get(fullCode);
  if (existing) return existing;
  const { parsePersonName } = require('../lib/mahak-import-helpers');
  const parsed = parsePersonName((lineName || '').split(' - ').pop());
  const cid = db.prepare(`INSERT INTO customers (user_id,biz,owner,phone,coa_code,balance,note,status,type,source)
                          VALUES (?,?,?,?,0,?,?,?,?,?)`).run(
    adminId, parsed.biz || lineName || 'مشتری محک', parsed.owner, parsed.phone, fullCode,
    'ایجاد خودکار هنگام بازسازی سند محک', 'followup', 'عمده', 'mahak').lastInsertRowid;
  lookups.custByCoa.set(fullCode, cid);
  return cid;
}

function resolveCustomer(v, lookups, adminId, mode) {
  let line = v.lines.find(x => x.kol === '203' && x.code.startsWith('203004') && (mode === 'receipt' ? x.credit > 0 : x.debit > 0));
  if (!line) line = v.lines.find(x => x.kol === '203' && x.code.startsWith('203004'));
  if (!line) return null;
  let cid = lookups.custByCoa.get(line.code);
  if (!cid) cid = ensureCustomer(db, lookups, adminId, line.code, line.name);
  return cid;
}

function receiptAmount(v) {
  const commercial = v.lines.filter(x => x.kol === '203' && x.code.startsWith('203004'));
  const cr = commercial.reduce((a, l) => a + l.credit, 0);
  const dr = commercial.reduce((a, l) => a + l.debit, 0);
  return sumKol(v, '206', 'debit') || cr || dr || sumKol(v, '203', 'credit') || sumKol(v, '203', 'debit');
}

function receiptPayType(v) {
  const has206 = v.lines.some(l => l.kol === '206');
  const hasNoteRecv = v.lines.some(l => l.code.startsWith('203001') && l.debit > 0);
  if (!has206 && hasNoteRecv) return 'cheque';
  return 'cash';
}

function supFrom501(v, lookups, side) {
  const l = v.lines.find(x => x.kol === '501' && x[side] > 0);
  return l ? lookups.supByCoa.get(l.code) : null;
}

function mapRows(rawRows, lookups) {
  const rows = [];
  for (const r of rawRows) {
    const prod = r.taf ? lookups.prodByCode.get(r.taf) : null;
    rows.push({
      product_id: prod?.id || null,
      name: prod?.name || r.name,
      qty: r.qty || 1,
      price: r.price || r.sum || 0,
      disc: 0,
      disc_amt: 0,
      sum: r.sum || r.price || 0,
    });
  }
  return rows;
}

const stats = db.transaction(() => {
  // Reset sub-ledgers — will rebuild from operational docs
  db.exec('DELETE FROM customer_ledger');
  db.exec('DELETE FROM supplier_ledger');
  db.exec('UPDATE customers SET balance=0');
  db.exec('UPDATE suppliers SET balance=0');

  const lookups = buildLookups();
  const report = {
    sales_invoice: 0, sales_return: 0, receipt: 0, purchase: 0, purchase_return: 0,
    supplier_payment: 0, expense_payment: 0,
    warehouse_issue: 0, warehouse_receipt: 0, warehouse_transfer: 0, transfer: 0, payroll: 0,
    opening: 0, person_transfer: 0, production: 0, cogs_only: 0, cheque_ops: 0, cheque_settlement: 0,
    payment_misc: 0, stocktaking: 0, account_transfer: 0, other: 0, adjustment: 0,
    skipped: [], warnings: [],
  };

  const docList = [...vouchers.entries()]
    .filter(([, v]) => v.lines.length)
    .sort((a, b) => a[1].date === b[1].date ? (+a[0]) - (+b[0]) : (a[1].date < b[1].date ? -1 : 1));

  let invSeq = 0, purSeq = 0;

  for (const [docNo, v] of docList) {
    let type = classifyMahakVoucher(docNo, v);
    const desc = v.desc || `سند محک ${docNo}`;
    // Refine generic payment
    if (type === 'payment') {
      if (sumKol(v, '501', 'debit') > 0 && sumKol(v, '206', 'credit') > 0) type = 'supplier_payment';
      else if (sumKol(v, '501', 'debit') > 0 && v.lines.some(l => l.code.startsWith('203001') && l.credit > 0)) type = 'supplier_payment';
      else if (sumKol(v, '702', 'debit') > 0 || sumKol(v, '704', 'debit') > 0) type = 'expense_payment';
      else if (sumKol(v, '203', 'credit') > 0 && sumKol(v, '206', 'debit') > 0) type = 'receipt';
      else if (v.lines.some(l => l.code.startsWith('203004') && l.debit > 0) && v.lines.some(l => l.code.startsWith('203001') && l.credit > 0)) type = 'cheque_settlement';
    }

    if (type === 'opening') {
      for (const l of v.lines) {
        if (l.kol === '203' && l.debit > 0 && l.code.startsWith('203004')) {
          const cid = lookups.custByCoa.get(l.code);
          if (cid) createLedgerEntry(db, {
            customer_id: cid, date: v.date, entry_type: 'opening', ref_type: 'opening', ref_id: null,
            description: `افتتاحیه محک — سند ${docNo}`, debit: l.debit, credit: 0, user_id: adminId,
          });
        }
      }
      report.opening++;
      linkJournal(docNo, 'fiscal_opening', null);
      continue;
    }

    if (type === 'sales_invoice') {
      const custId = resolveCustomer(v, lookups, adminId, 'invoice');
      if (!custId) { report.skipped.push(`فاکتور ${docNo}: مشتری یافت نشد`); report.other++; continue; }
      const rawRows = extractSalesRows(v);
      const rows = mapRows(rawRows, lookups);
      const final = rows.reduce((a, r) => a + (r.sum || 0), 0) || sumKol(v, '203', 'debit');
      invSeq++;
      const num = `F-${docNo}`;
      const r = db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,pay_type,stock_deducted,approved,sales_channel,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,0,0,?,?,1,1,'shop',?,?)`).run(
        adminId, custId, num, 'final', v.date, `[محک:${docNo}] ${desc}`, JSON.stringify(rows),
        final, final, 'credit', docNo, 'sales_invoice');
      createLedgerEntry(db, {
        customer_id: custId, date: v.date, entry_type: 'invoice', ref_type: 'invoice', ref_id: r.lastInsertRowid,
        description: `فاکتور ${num}`, debit: final, credit: 0, user_id: adminId,
      });
      linkJournal(docNo, 'invoice', r.lastInsertRowid);
      report.sales_invoice++;
      continue;
    }

    if (type === 'sales_return') {
      const custId = resolveCustomer(v, lookups, adminId, 'invoice');
      if (!custId) { report.skipped.push(`برگشت فروش ${docNo}`); report.other++; continue; }
      const rawRows = extractSalesRows(v);
      const rows = mapRows(rawRows, lookups);
      const amount = rows.reduce((a, r) => a + (r.sum || 0), 0) || sumKol(v, '203', 'credit') || sumKol(v, '601', 'debit');
      const r = db.prepare(`INSERT INTO sales_returns (user_id,cust_id,date,note,rows,amount,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?)`).run(
        adminId, custId, v.date, `[محک:${docNo}] ${desc}`, JSON.stringify(rows), amount, docNo, 'sales_return');
      createLedgerEntry(db, {
        customer_id: custId, date: v.date, entry_type: 'return', ref_type: 'sales_return', ref_id: r.lastInsertRowid,
        description: `برگشت از فروش — ${desc}`, debit: 0, credit: amount, user_id: adminId,
      });
      linkJournal(docNo, 'sales_return', r.lastInsertRowid);
      report.sales_return++;
      continue;
    }

    if (type === 'receipt') {
      const hasCommercial = v.lines.some(l => l.code.startsWith('203004'));
      if (!hasCommercial && v.lines.some(l => l.code.startsWith('203001') || l.code.startsWith('203002'))) {
        linkJournal(docNo, 'manual_voucher', null);
        report.cheque_ops++;
        continue;
      }
      const custId = resolveCustomer(v, lookups, adminId, 'receipt');
      const amount = receiptAmount(v);
      if (!custId || !amount) { report.skipped.push(`دریافت ${docNo}: مشتری/مبلغ نامشخص`); report.other++; continue; }
      const cash = resolveCashFrom206(v, lookups);
      const payType = receiptPayType(v);
      const r = db.prepare(`INSERT INTO settlements (user_id,cust_id,amount,pay_type,date,note,bank_id,cash_box_id,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        adminId, custId, amount, payType, v.date, `[محک:${docNo}] ${desc}`,
        cash.bank_id ?? null, cash.cash_box_id ?? null, String(docNo), 'receipt');
      createLedgerEntry(db, {
        customer_id: custId, date: v.date, entry_type: 'settlement', ref_type: 'settlement', ref_id: r.lastInsertRowid,
        description: `دریافت — ${desc}`, debit: 0, credit: amount, user_id: adminId,
      });
      linkJournal(docNo, 'settlement', r.lastInsertRowid);
      report.receipt++;
      continue;
    }

    if (type === 'purchase') {
      const supId = supFrom501(v, lookups, 'credit');
      if (!supId) { report.skipped.push(`خرید ${docNo}: تأمین‌کننده یافت نشد`); report.other++; continue; }
      const rawRows = extractPurchaseRows(v);
      const rows = mapRows(rawRows, lookups);
      const final = rows.reduce((a, r) => a + (r.sum || 0), 0) || sumKol(v, '501', 'credit');
      purSeq++;
      const num = `P-${docNo}`;
      const r = db.prepare(`INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,pay_type,stock_added,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,0,0,?,?,1,?,?)`).run(
        adminId, supId, num, v.date, `[محک:${docNo}] ${desc}`, JSON.stringify(rows), final, final, 'credit', docNo, 'purchase');
      db.prepare(`INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(
        supId, v.date, 'purchase', 'purchase', r.lastInsertRowid, `فاکتور خرید ${num}`, 0, final, adminId);
      linkJournal(docNo, 'purchase', r.lastInsertRowid);
      report.purchase++;
      continue;
    }

    if (type === 'purchase_return') {
      const supId = supFrom501(v, lookups, 'debit');
      if (!supId) { report.skipped.push(`برگشت خرید ${docNo}`); report.other++; continue; }
      const rawRows = extractPurchaseRows(v);
      const rows = mapRows(rawRows, lookups);
      const amount = rows.reduce((a, r) => a + (r.sum || 0), 0) || sumKol(v, '501', 'debit') || sumKol(v, '202', 'credit');
      const r = db.prepare(`INSERT INTO purchase_returns (user_id,supplier_id,date,note,rows,amount,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?)`).run(
        adminId, supId, v.date, `[محک:${docNo}] ${desc}`, JSON.stringify(rows), amount, docNo, 'purchase_return');
      db.prepare(`INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(
        supId, v.date, 'return', 'purchase_return', r.lastInsertRowid, `برگشت از خرید — ${desc}`, amount, 0, adminId);
      linkJournal(docNo, 'purchase_return', r.lastInsertRowid);
      report.purchase_return++;
      continue;
    }

    if (type === 'supplier_payment') {
      const supId = supFrom501(v, lookups, 'debit');
      const amount = sumKol(v, '501', 'debit') || sumKol(v, '206', 'credit') || sumKol(v, '203', 'credit');
      if (!supId || !amount) { report.skipped.push(`پرداخت تأمین ${docNo}`); report.other++; continue; }
      const cash = resolveCashFrom206(v, lookups);
      const payType = v.lines.some(l => l.code.startsWith('206') && l.credit > 0) ? (cash.pay_type || 'cash')
        : v.lines.some(l => l.code.startsWith('203001') && l.credit > 0) ? 'cheque' : 'cash';
      const r = db.prepare(`INSERT INTO supplier_payments (supplier_id,amount,pay_type,date,note,bank_id,cash_box_id,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,?)`).run(
        supId, amount, payType, v.date, `[محک:${docNo}] ${desc}`, cash.bank_id ?? null, cash.cash_box_id ?? null, docNo, 'supplier_payment');
      db.prepare(`INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(
        supId, v.date, 'payment', 'supplier_payment', r.lastInsertRowid, desc, amount, 0, adminId);
      linkJournal(docNo, 'supplier_payment', r.lastInsertRowid);
      report.supplier_payment++;
      continue;
    }

    if (type === 'expense_payment') {
      const expLine = v.lines.find(l => (l.kol === '702' || l.kol === '704' || l.kol === '705') && l.debit > 0);
      const amount = expLine?.debit || sumKol(v, '206', 'credit');
      if (!amount) { report.other++; continue; }
      const cash = resolveCashFrom206(v, lookups);
      const title = expLine ? expLine.name.split(' - ').pop() : desc;
      const r = db.prepare(`INSERT INTO expense_payments (category,title,amount,pay_type,date,note,bank_id,cash_box_id,account_code,created_by,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'هزینه محک', title, amount, cash.pay_type, v.date, `[محک:${docNo}] ${desc}`,
        cash.bank_id, cash.cash_box_id, expLine?.code || null, adminId, docNo, 'expense_payment');
      linkJournal(docNo, 'expense_payment', r.lastInsertRowid);
      report.expense_payment++;
      continue;
    }

    if (type === 'warehouse_issue' || type === 'warehouse_receipt' || type === 'warehouse_transfer') {
      const isReceipt = type === 'warehouse_receipt';
      const isTransfer = type === 'warehouse_transfer';
      const prodLines = v.lines.filter(l => l.kol === '202' && (isReceipt ? l.debit > 0 : l.credit > 0));
      if (!prodLines.length) { report.other++; continue; }
      let lastMoveId = null;
      for (const pl of prodLines) {
        const prod = lookups.prodByCode.get(pl.taf);
        if (!prod) { report.warnings.push(`انبار ${docNo}: کالا ${pl.taf} یافت نشد`); continue; }
        const qty = 1;
        const whId = prod.warehouse_id || defaultWh;
        const moveType = isTransfer ? 'transfer' : isReceipt ? 'receipt' : 'issue';
        if (isReceipt) {
          const r = db.prepare(`INSERT INTO warehouse_moves (type,product_id,to_warehouse_id,qty,date,note,created_by,mahak_doc_no,mahak_doc_type)
                      VALUES ('receipt',?,?,?,?,?,?,?,?)`).run(prod.id, whId, qty, v.date, `[محک:${docNo}] ${desc}`, adminId, docNo, 'warehouse_receipt');
          lastMoveId = r.lastInsertRowid;
          report.warehouse_receipt++;
        } else if (isTransfer) {
          const r = db.prepare(`INSERT INTO warehouse_moves (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,mahak_doc_no,mahak_doc_type)
                      VALUES ('transfer',?,?,?,?,?,?,?,?,?)`).run(prod.id, whId, whId, qty, v.date, `[محک:${docNo}] ${desc}`, adminId, docNo, 'warehouse_transfer');
          lastMoveId = r.lastInsertRowid;
          report.warehouse_transfer++;
        } else {
          const r = db.prepare(`INSERT INTO warehouse_moves (type,product_id,from_warehouse_id,qty,date,note,created_by,mahak_doc_no,mahak_doc_type)
                      VALUES ('issue',?,?,?,?,?,?,?,?)`).run(prod.id, whId, qty, v.date, `[محک:${docNo}] ${desc}`, adminId, docNo, 'warehouse_issue');
          lastMoveId = r.lastInsertRowid;
          report.warehouse_issue++;
        }
      }
      linkJournal(docNo, 'warehouse_move', lastMoveId);
      continue;
    }

    if (type === 'transfer') {
      const dr = v.lines.find(l => l.kol === '206' && l.debit > 0);
      const cr = v.lines.find(l => l.kol === '206' && l.credit > 0);
      const amount = dr?.debit || cr?.credit || 0;
      if (!amount || !dr || !cr) { report.other++; continue; }
      const fromType = lookups.bankByCoa.has(dr.code) ? 'bank' : lookups.boxByCoa.has(dr.code) ? 'cash_box' : 'bank';
      const toType = lookups.bankByCoa.has(cr.code) ? 'bank' : lookups.boxByCoa.has(cr.code) ? 'cash_box' : 'bank';
      const fromId = lookups.bankByCoa.get(dr.code) || lookups.boxByCoa.get(dr.code);
      const toId = lookups.bankByCoa.get(cr.code) || lookups.boxByCoa.get(cr.code);
      if (!fromId || !toId) { report.skipped.push(`انتقال ${docNo}`); report.other++; continue; }
      const r = db.prepare(`INSERT INTO account_transfers (date,from_type,from_id,to_type,to_id,amount,note,user_id,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        v.date, fromType, fromId, toType, toId, amount, `[محک:${docNo}] ${desc}`, adminId, docNo, 'transfer');
      linkJournal(docNo, 'transfer', r.lastInsertRowid);
      report.transfer++;
      continue;
    }

    if (type === 'payroll') {
      let personId = db.prepare("SELECT id FROM persons WHERE name='کارکنان محک' LIMIT 1").get()?.id;
      if (!personId) {
        db.exec(`INSERT OR IGNORE INTO person_categories (name,nature) VALUES ('پرسنل','credit')`);
        const catId = db.prepare("SELECT id FROM person_categories WHERE name='پرسنل' LIMIT 1").get()?.id;
        personId = db.prepare("INSERT INTO persons (category_id,name,note) VALUES (?,?,?)")
          .run(catId, 'کارکنان محک', 'ایجاد خودکار برای import حقوق محک').lastInsertRowid;
      }
      const amt = sumKol(v, '701', 'debit') || sumKol(v, '501', 'credit') || sumKol(v, '206', 'credit');
      const r = db.prepare(`INSERT INTO payroll_records (person_id,period_label,date,gross_pay,net_pay,paid,note,created_by,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,1,?,?,?,?)`).run(
        personId, v.date.slice(0, 7) || v.date, v.date, amt, amt, `[محک:${docNo}] ${desc}`, adminId, docNo, 'payroll');
      linkJournal(docNo, 'payroll', r.lastInsertRowid);
      report.payroll++;
      continue;
    }

    if (type === 'cheque_settlement') {
      const custId = resolveCustomer(v, lookups, adminId, 'invoice');
      const amount = v.lines.filter(l => l.code.startsWith('203004') && l.debit > 0).reduce((a, l) => a + l.debit, 0)
        || v.lines.filter(l => l.code.startsWith('203001') && l.credit > 0).reduce((a, l) => a + l.credit, 0);
      if (!custId || !amount) {
        linkJournal(docNo, 'manual_voucher', null);
        report.cheque_ops++;
        continue;
      }
      const r = db.prepare(`INSERT INTO settlements (user_id,cust_id,amount,pay_type,date,note,bank_id,cash_box_id,mahak_doc_no,mahak_doc_type)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        adminId, custId, amount, 'cheque', v.date, `[محک:${docNo}] ${desc}`, null, null, String(docNo), 'cheque_settlement');
      createLedgerEntry(db, {
        customer_id: custId, date: v.date, entry_type: 'settlement', ref_type: 'settlement', ref_id: r.lastInsertRowid,
        description: `عملیات چک — ${desc}`, debit: 0, credit: amount, user_id: adminId,
      });
      linkJournal(docNo, 'settlement', r.lastInsertRowid);
      report.cheque_settlement++;
      continue;
    }

    if (type === 'payment') {
      linkJournal(docNo, 'manual_voucher', null);
      report.payment_misc++;
      continue;
    }

    if (type === 'production') {
      const prodLine = v.lines.find(l => l.kol === '202' && (l.debit > 0 || l.credit > 0));
      const prod = prodLine ? lookups.prodByCode.get(prodLine.taf) : null;
      if (prod) {
        db.prepare(`INSERT INTO production_runs (product_id,qty_produced,material_cost,date,note,stock_added,cost_updated,created_by)
                    VALUES (?,?,?,?,?,0,0,?)`).run(
          prod.id, 1, sumKol(v, '704', 'debit') || sumKol(v, '202', 'debit'), v.date, `[محک:${docNo}] ${desc}`, adminId);
      }
      linkJournal(docNo, 'manual_voucher', null);
      report.production++;
      continue;
    }

    if (type === 'person_transfer' || type === 'cogs_only' || type === 'adjustment' || type === 'cheque_ops') {
      linkJournal(docNo, 'manual_voucher', null);
      report[type]++;
      continue;
    }

    if (type === 'other') {
      // حواله حساب‌ها / بستن حساب / انبارگردانی — سند دستی با همان آرتیکل‌های محک
      linkJournal(docNo, 'manual_voucher', null);
      report.other++;
      continue;
    }

    report[type] = (report[type] || 0) + 1;
  }

  // Sync customer/supplier balance fields from ledgers
  for (const c of db.prepare('SELECT id FROM customers').all()) {
    const row = db.prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) bal FROM customer_ledger WHERE customer_id=?').get(c.id);
    db.prepare('UPDATE customers SET balance=? WHERE id=?').run(row.bal, c.id);
  }
  for (const s of db.prepare('SELECT id FROM suppliers').all()) {
    const row = db.prepare('SELECT COALESCE(SUM(credit)-SUM(debit),0) bal FROM supplier_ledger WHERE supplier_id=?').get(s.id);
    db.prepare('UPDATE suppliers SET balance=? WHERE id=?').run(row.bal, s.id);
  }

  return report;
})();

const rep = [];
rep.push('# گزارش بازسازی اسناد عملیاتی محک');
rep.push(`- فاکتور فروش: **${stats.sales_invoice}**`);
rep.push(`- دریافت: **${stats.receipt}**`);
rep.push(`- فاکتور خرید: **${stats.purchase}**`);
rep.push(`- پرداخت تأمین‌کننده: **${stats.supplier_payment}**`);
rep.push(`- پرداخت هزینه: **${stats.expense_payment}**`);
rep.push(`- حواله انبار (خروج): **${stats.warehouse_issue}**`);
rep.push(`- رسید انبار (ورود): **${stats.warehouse_receipt}**`);
rep.push(`- انتقال وجه: **${stats.transfer}**`);
rep.push(`- حقوق: **${stats.payroll}** | عملیات چک: **${stats.cheque_ops || 0}** | تسویه چک: **${stats.cheque_settlement || 0}**`);
rep.push(`- افتتاحیه: ${stats.opening} | سایر/دستی: ${stats.other + stats.person_transfer + stats.production + stats.cogs_only + stats.adjustment}`);
if (stats.skipped.length) {
  rep.push(`\n## رد شده (${stats.skipped.length})`);
  stats.skipped.slice(0, 40).forEach(s => rep.push('- ' + s));
}
if (stats.warnings.length) {
  rep.push(`\n## هشدار (${stats.warnings.length})`);
  stats.warnings.slice(0, 20).forEach(w => rep.push('- ' + w));
}
const linked = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type NOT IN ('mahak_import')").get().c;
const remaining = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type='mahak_import'").get().c;
const manual = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type='manual_voucher'").get().c;
rep.push(`\n- اسناد حسابداری متصل: **${linked}** (سند دستی: ${manual}) | باقی‌مانده: **${remaining}**`);

const repPath = path.join(path.dirname(path.resolve(dbPath)), 'mahak-documents-report.md');
fs.writeFileSync(repPath, rep.join('\n') + '\n');

console.log('✅ Document reconstruction complete');
console.log(`   invoices=${stats.sales_invoice} receipts=${stats.receipt} purchases=${stats.purchase}`);
console.log(`   sup_payments=${stats.supplier_payment} expenses=${stats.expense_payment}`);
console.log(`   warehouse out=${stats.warehouse_issue} in=${stats.warehouse_receipt} transfers=${stats.transfer}`);
console.log(`   journal linked=${linked} remaining mahak_import=${remaining}`);
console.log(`   report: ${repPath}`);
