#!/usr/bin/env node
/**
 * v400 — warehouse GRNI receipt → value-only purchase invoice (no double stock).
 * Asserts: GRNI posts stock+2112; invoice clears 2112→AP stock_added=0;
 * duplicate blocked; void unlinks; SOD blocks same maker.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-grni-v400-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-wh-grni-v400';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { acct } = require('../lib/coa-map');
const { createWarehouseDoc } = require('../lib/warehouse-docs');
const {
  listOpenWarehouseGrni, invoiceWarehouseGrni, unlinkWarehouseGrniOnPurchaseVoid,
} = require('../lib/warehouse-grni-invoice');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail || ''); }
}

function seed() {
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  const admin = db.prepare(
    "INSERT INTO users (name,username,password,role) VALUES ('Admin','adm-v400','x','admin')"
  ).run().lastInsertRowid;
  const whUser = db.prepare(
    "INSERT INTO users (name,username,password,role) VALUES ('WhOp','wh-v400','x','sales')"
  ).run().lastInsertRowid;
  const acctUser = db.prepare(
    "INSERT INTO users (name,username,password,role) VALUES ('Acc','acc-v400','x','accounting')"
  ).run().lastInsertRowid;

  const cc = db.prepare("INSERT INTO cost_centers (code,name,active) VALUES ('CC-G400','CC',1)").run().lastInsertRowid;
  const wh = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system)
    VALUES ('محصول تست','WH-G400','distribution_office','finished_goods',?,1,0,'perpetual')
  `).run(cc).lastInsertRowid;

  const p1 = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'کالا الف','G400-A',100000,50000,0,'عدد',?,50000)
  `).run(admin, wh).lastInsertRowid;
  const p2 = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'کالا ب','G400-B',200000,80000,0,'عدد',?,80000)
  `).run(admin, wh).lastInsertRowid;

  const sup = db.prepare(`
    INSERT INTO suppliers (name,phone) VALUES ('تأمین تست v400','09120000000')
  `).run().lastInsertRowid;

  return { admin, whUser, acctUser, wh, p1, p2, sup };
}

function stockOf(productId) {
  return Number(db.prepare('SELECT stock FROM products WHERE id=?').get(productId)?.stock) || 0;
}

function main() {
  console.log('\n=== warehouse GRNI → invoice v400 ===\n');
  const s = seed();

  // 1) Warehouse GRNI receipt by ops user
  const doc = createWarehouseDoc(db, {
    type: 'receipt',
    warehouse_id: s.wh,
    date: '1405/07/23',
    note: 'رسید بدون فاکتور',
    receipt_class: 'grni',
    supplier_id: s.sup,
    lines: [
      { product_id: s.p1, qty: 2 },
      { product_id: s.p2, qty: 1 },
    ],
  }, { id: s.whUser, role: 'sales' });
  ok(!!doc.id, 'GRNI doc created', doc);
  ok(!!doc.je_id, 'GRNI has JE');
  const persisted = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(doc.id);
  ok(persisted.receipt_class === 'grni', 'receipt_class persisted', persisted.receipt_class);
  ok(Number(persisted.supplier_id) === s.sup, 'supplier_id persisted');
  ok(stockOf(s.p1) === 2, 'p1 stock +2', stockOf(s.p1));
  ok(stockOf(s.p2) === 1, 'p2 stock +1', stockOf(s.p2));

  const grniCr = db.prepare(`
    SELECT account_code, credit_rial FROM journal_lines
    WHERE entry_id=? AND credit_rial>0
  `).get(doc.je_id);
  ok(grniCr?.account_code === acct(db, 'coa_grni').code, 'credits 2112', grniCr?.account_code);

  // 2) List open
  const open = listOpenWarehouseGrni(db, {});
  ok(open.some((d) => d.id === doc.id), 'appears in open GRNI list');
  ok(open.find((d) => d.id === doc.id)?.lines?.length === 2, 'open list has lines');

  // 3) SOD: same maker cannot invoice
  let sodBlocked = false;
  try {
    invoiceWarehouseGrni(db, {
      warehouse_doc_ids: [doc.id],
      supplier_id: s.sup,
      date: '1405/07/23',
      rows: open.find((d) => d.id === doc.id).lines.map((l) => ({
        move_id: l.move_id, price: 60000,
      })),
    }, { id: s.whUser, role: 'sales' });
  } catch (e) {
    sodBlocked = e.code === 'E_SOD_MAKER_CHECKER' || /سازنده|maker/i.test(e.message || '');
  }
  ok(sodBlocked, 'SOD blocks warehouse maker from invoicing');

  // 4) Accounting invoices value-only
  const stockBefore = { p1: stockOf(s.p1), p2: stockOf(s.p2) };
  const openDoc = listOpenWarehouseGrni(db, {}).find((d) => d.id === doc.id);
  const inv = invoiceWarehouseGrni(db, {
    warehouse_doc_ids: [doc.id],
    supplier_id: s.sup,
    date: '1405/07/24',
    rows: openDoc.lines.map((l) => ({
      move_id: l.move_id,
      price: l.product_id === s.p1 ? 70000 : 90000,
    })),
  }, { id: s.acctUser, role: 'accounting' });
  ok(!!inv.id, 'invoice created', inv);
  ok(Number(inv.stock_added) === 0, 'stock_added=0', inv.stock_added);
  ok(stockOf(s.p1) === stockBefore.p1, 'p1 stock unchanged after invoice', stockOf(s.p1));
  ok(stockOf(s.p2) === stockBefore.p2, 'p2 stock unchanged after invoice', stockOf(s.p2));

  const linked = db.prepare('SELECT purchase_invoice_id FROM warehouse_docs WHERE id=?').get(doc.id);
  ok(Number(linked.purchase_invoice_id) === inv.id, 'warehouse_docs linked to PI');

  const je = db.prepare(`
    SELECT id FROM journal_entries WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(inv.id);
  ok(!!je, 'purchase JE exists');
  const jeDrGrni = db.prepare(`
    SELECT COALESCE(SUM(debit_rial),0) s FROM journal_lines WHERE entry_id=? AND account_code=?
  `).get(je.id, acct(db, 'coa_grni').code)?.s;
  ok(Number(jeDrGrni) > 0, 'invoice debits GRNI 2112', String(jeDrGrni));

  // 5) Duplicate blocked
  let dup = false;
  try {
    invoiceWarehouseGrni(db, {
      warehouse_doc_ids: [doc.id],
      supplier_id: s.sup,
      date: '1405/07/24',
      rows: openDoc.lines.map((l) => ({ move_id: l.move_id, price: 1 })),
    }, { id: s.acctUser, role: 'accounting' });
  } catch (e) {
    dup = e.code === 'E_WH_GRNI_BILLED' || e.status === 409;
  }
  ok(dup, 'duplicate invoice blocked');

  // 6) Open list empty for this doc
  ok(!listOpenWarehouseGrni(db, {}).some((d) => d.id === doc.id), 'no longer in open list');

  // 7) Void unlink (simulate purchase void unlink helper)
  unlinkWarehouseGrniOnPurchaseVoid(db, inv.id, { userId: s.admin });
  const after = db.prepare('SELECT purchase_invoice_id FROM warehouse_docs WHERE id=?').get(doc.id);
  ok(after.purchase_invoice_id == null, 'unlink clears purchase_invoice_id');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main();
