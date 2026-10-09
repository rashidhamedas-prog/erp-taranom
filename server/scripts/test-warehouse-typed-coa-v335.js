#!/usr/bin/env node
/**
 * v335 — typed warehouse inventory COA + receipt_class GRNI vs purchase path.
 * Asserts: raw WH purchase→1110; FG COGS credits FG/typed; WH receipt grni→2112;
 * adjustment receipt→9999; inventory_coa_code override wins.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-coa-v335-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-wh-coa-v335';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { acct } = require('../lib/coa-map');
const { inventoryAccountForWarehouse } = require('../lib/inventory/ledger');
const { createWarehouseDoc } = require('../lib/warehouse-docs');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail || ''); }
}

function seed() {
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  // cost centers
  const cc = db.prepare("INSERT INTO cost_centers (code,name,active) VALUES ('CC-WH','مرکز تست',1)").run().lastInsertRowid;
  const raw = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system)
    VALUES ('مواد','WH-RAW','workshop','raw_material',?,0,0,'perpetual')
  `).run(cc).lastInsertRowid;
  const fg = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system)
    VALUES ('محصول','WH-FG','distribution_office','finished_goods',?,1,0,'perpetual')
  `).run(cc).lastInsertRowid;
  const pack = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system,inventory_coa_code)
    VALUES ('بسته','WH-PKG','workshop','packaging',?,0,0,'perpetual',?)
  `).run(cc, acct(db, 'coa_packaging_materials').code).lastInsertRowid;
  const override = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system,inventory_coa_code)
    VALUES ('اورراید','WH-OV','workshop','finished_goods',?,0,0,'perpetual',?)
  `).run(cc, acct(db, 'coa_raw_materials').code).lastInsertRowid;

  const pRaw = db.prepare(`
    INSERT INTO products (name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES ('پارچه تست','RAW-335',100000,50000,0,'متر',?,50000)
  `).run(raw).lastInsertRowid;
  const pFg = db.prepare(`
    INSERT INTO products (name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES ('مانتو تست','FG-335',200000,80000,20,'عدد',?,80000)
  `).run(fg).lastInsertRowid;

  const user = db.prepare("SELECT id FROM users LIMIT 1").get()
    || { id: db.prepare("INSERT INTO users (name,username,password,role) VALUES ('t','t','x','admin')").run().lastInsertRowid };

  return { raw, fg, pack, override, pRaw, pFg, user: user.id || user };
}

function main() {
  console.log('\n=== warehouse typed COA v335 ===\n');
  const s = seed();

  const rawAcct = inventoryAccountForWarehouse(db, s.raw);
  ok(rawAcct.code === acct(db, 'coa_raw_materials').code, 'raw_material → 1110', rawAcct.code);

  const packAcct = inventoryAccountForWarehouse(db, s.pack);
  ok(packAcct.code === acct(db, 'coa_packaging_materials').code, 'packaging → 1112', packAcct.code);

  const ovAcct = inventoryAccountForWarehouse(db, s.override);
  ok(ovAcct.code === acct(db, 'coa_raw_materials').code, 'inventory_coa_code override wins over FG type', ovAcct.code);

  const fgAcct = inventoryAccountForWarehouse(db, s.fg);
  ok(fgAcct.code === acct(db, 'coa_finished_goods').code, 'finished_goods → 1104', fgAcct.code);

  // Simulated purchase JE debit uses typed account
  const purchJe = postToLedger(db, {
    sourceType: 'test_purchase_typed', sourceId: 1, date: '1405/01/01',
    description: 'test', createdBy: s.user,
    lines: [
      { code: rawAcct.code, name: rawAcct.name, debit: rialToLedger(500000), credit: 0 },
      { code: acct(db, 'coa_payable').code, name: acct(db, 'coa_payable').name, debit: 0, credit: rialToLedger(500000) },
    ],
  });
  ok(!!purchJe, 'typed purchase JE posts');
  const purchDebit = db.prepare(
    'SELECT COALESCE(SUM(debit_rial),0) s FROM journal_lines WHERE entry_id=? AND account_code=?'
  ).get(purchJe, rawAcct.code)?.s;
  ok(Number(purchDebit) === 500000, 'purchase debit on raw COA', String(purchDebit));

  // Warehouse receipt GRNI
  const grniDoc = createWarehouseDoc(db, {
    type: 'receipt',
    warehouse_id: s.raw,
    date: '1405/01/02',
    note: 'رسید بدون فاکتور',
    receipt_class: 'grni',
    lines: [{ product_id: s.pRaw, qty: 2 }],
  }, { id: s.user });
  ok(!!grniDoc.je_id, 'GRNI receipt has JE', grniDoc);
  const grniCr = db.prepare(`
    SELECT jl.account_code, jl.credit_rial FROM journal_lines jl WHERE jl.entry_id=? AND jl.credit_rial>0
  `).get(grniDoc.je_id);
  ok(grniCr?.account_code === acct(db, 'coa_grni').code, 'GRNI receipt credits 2112', grniCr?.account_code);
  const grniDr = db.prepare(`
    SELECT jl.account_code FROM journal_lines jl WHERE jl.entry_id=? AND jl.debit_rial>0
  `).get(grniDoc.je_id);
  ok(grniDr?.account_code === rawAcct.code, 'GRNI receipt debits typed raw', grniDr?.account_code);

  // Adjustment receipt → 9999
  const adjDoc = createWarehouseDoc(db, {
    type: 'receipt',
    warehouse_id: s.fg,
    date: '1405/01/03',
    note: 'تعدیل',
    receipt_class: 'adjustment',
    lines: [{ product_id: s.pFg, qty: 1 }],
  }, { id: s.user });
  ok(!!adjDoc.je_id, 'adjustment receipt has JE');
  const adjCr = db.prepare(`
    SELECT account_code FROM journal_lines WHERE entry_id=? AND credit_rial>0
  `).get(adjDoc.je_id);
  ok(adjCr?.account_code === acct(db, 'coa_adjustment').code, 'adjustment credits 9999', adjCr?.account_code);

  // COGS credit typed FG
  const { postCogsFromMovements } = require('../lib/sales-document');
  const cogsJe = postCogsFromMovements(db, {
    invId: 99001, num: 'T-COGS', date: '1405/01/04', userId: s.user,
    cogsRial: 240000, inventoryCoaCode: fgAcct.code,
  });
  ok(!!cogsJe, 'COGS JE with typed inventory');
  const cogsCr = db.prepare(`
    SELECT account_code FROM journal_lines WHERE entry_id=? AND credit_rial>0
  `).get(cogsJe);
  ok(cogsCr?.account_code === fgAcct.code, 'COGS credits typed FG', cogsCr?.account_code);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main();
