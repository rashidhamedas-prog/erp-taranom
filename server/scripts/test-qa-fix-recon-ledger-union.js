'use strict';
/**
 * Regression: stock.ledger_vs_warehouse must UNION keys from both sources.
 * warehouse_stock-only (no ledger) is a FAIL — do not skip or weaken.
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const { runRecon } = require('../../scripts/qa/recon');

console.log('\n══ QA-FIX recon ledger ∪ warehouse_stock ══\n');

function stockCheck(result) {
  return (result.checks || []).find((c) => c.id === 'stock.ledger_vs_warehouse');
}

function insertLedger(db, { txNo, productId, warehouseId, qty, companyId, variantId }) {
  const cols = db.prepare('PRAGMA table_info(inventory_ledger)').all().map((c) => c.name);
  const fields = [
    'tx_no', 'event_type', 'product_id', 'warehouse_id',
    'qty_in', 'qty_out', 'qty_balance',
    'unit_cost_rial', 'amount_rial', 'avg_cost_after_rial',
    'date', 'status',
  ];
  const values = [
    txNo, 'receipt', productId, warehouseId,
    qty, 0, qty,
    1000, qty * 1000, 1000,
    '1404/01/01', 'posted',
  ];
  if (cols.includes('company_id') && companyId != null) {
    fields.push('company_id');
    values.push(companyId);
  }
  if (cols.includes('variant_id') && variantId != null) {
    fields.push('variant_id');
    values.push(variantId);
  }
  db.prepare(
    `INSERT INTO inventory_ledger (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
  ).run(...values);
}

function insertWarehouse(db, { productId, warehouseId, qty, companyId, variantId }) {
  const cols = db.prepare('PRAGMA table_info(warehouse_stock)').all().map((c) => c.name);
  const fields = ['product_id', 'warehouse_id', 'qty'];
  const values = [productId, warehouseId, qty];
  if (cols.includes('company_id') && companyId != null) {
    fields.push('company_id');
    values.push(companyId);
  }
  if (cols.includes('variant_id') && variantId != null) {
    fields.push('variant_id');
    values.push(variantId);
  }
  db.prepare(
    `INSERT OR REPLACE INTO warehouse_stock (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
  ).run(...values);
}

function newProduct(db, adminId, warehouseId, code) {
  return db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'کالای اتحاد QA',?,0,1000,10000,?)
  `).run(adminId, code, warehouseId).lastInsertRowid;
}

const { db, cleanup } = freshDb();
try {
  const wh = db.prepare('SELECT id FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1').get()
    || { id: db.prepare("INSERT INTO warehouses (name,code,active) VALUES ('انبار اتحاد','WH-UN',1)").run().lastInsertRowid };
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();

  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare('DELETE FROM warehouse_stock').run();

  const pWhOnly = newProduct(db, admin.id, wh.id, 'UN-QA-WH');
  insertWarehouse(db, { productId: pWhOnly, warehouseId: wh.id, qty: 12 });
  eq('fixture warehouse-only has no ledger', db.prepare(
    'SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=?'
  ).get(pWhOnly).c, 0);
  eq('fixture warehouse-only qty', db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(pWhOnly, wh.id).qty, 12);

  let recon = runRecon(db);
  let chk = stockCheck(recon);
  ok('warehouse_stock positive without ledger is FAIL', chk && chk.ok === false, JSON.stringify(chk));
  ok('warehouse-only mismatch count >= 1', chk && Number(chk.actual) >= 1, JSON.stringify(chk));

  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare('DELETE FROM warehouse_stock').run();
  const pLedOnly = newProduct(db, admin.id, wh.id, 'UN-QA-LED');
  insertLedger(db, { txNo: 'QA-UNION-LED-ONLY', productId: pLedOnly, warehouseId: wh.id, qty: 9 });
  recon = runRecon(db);
  chk = stockCheck(recon);
  ok('ledger positive without warehouse_stock is FAIL', chk && chk.ok === false, JSON.stringify(chk));
  ok('ledger-only mismatch count >= 1', chk && Number(chk.actual) >= 1, JSON.stringify(chk));

  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare('DELETE FROM warehouse_stock').run();
  const pDiff = newProduct(db, admin.id, wh.id, 'UN-QA-DIFF');
  insertWarehouse(db, { productId: pDiff, warehouseId: wh.id, qty: 15 });
  insertLedger(db, { txNo: 'QA-UNION-DIFF', productId: pDiff, warehouseId: wh.id, qty: 7 });
  recon = runRecon(db);
  chk = stockCheck(recon);
  ok('both present but qty differs is FAIL', chk && chk.ok === false, JSON.stringify(chk));
  ok('qty-diff mismatch count >= 1', chk && Number(chk.actual) >= 1, JSON.stringify(chk));

  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare('DELETE FROM warehouse_stock').run();
  const pOk = newProduct(db, admin.id, wh.id, 'UN-QA-OK');
  insertWarehouse(db, { productId: pOk, warehouseId: wh.id, qty: 8 });
  insertLedger(db, { txNo: 'QA-UNION-OK', productId: pOk, warehouseId: wh.id, qty: 8 });
  recon = runRecon(db);
  chk = stockCheck(recon);
  ok('matching ledger and warehouse_stock is PASS', chk && chk.ok === true, JSON.stringify(chk));
  eq('matching mismatch count', chk ? Number(chk.actual) : -1, 0);

  try { db.exec('ALTER TABLE warehouse_stock ADD COLUMN company_id INTEGER'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE warehouse_stock ADD COLUMN variant_id INTEGER'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE inventory_ledger ADD COLUMN company_id INTEGER'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE inventory_ledger ADD COLUMN variant_id INTEGER'); } catch { /* exists */ }

  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare('DELETE FROM warehouse_stock').run();
  const pDim = newProduct(db, admin.id, wh.id, 'UN-QA-DIM');
  insertWarehouse(db, {
    productId: pDim, warehouseId: wh.id, qty: 4, companyId: 1, variantId: 1,
  });
  insertLedger(db, {
    txNo: 'QA-UNION-DIM', productId: pDim, warehouseId: wh.id, qty: 4, companyId: 1, variantId: 2,
  });
  recon = runRecon(db);
  chk = stockCheck(recon);
  ok('company/variant key mismatch is FAIL (not collapsed to product/warehouse)',
    chk && chk.ok === false, JSON.stringify(chk));
  ok('company/variant UNION reports both missing sides',
    chk && Number(chk.actual) >= 2, JSON.stringify(chk));
} finally {
  cleanup();
}

summary();
