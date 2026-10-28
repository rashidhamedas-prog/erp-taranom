#!/usr/bin/env node
/**
 * v575 — Warehouse Phase 2 PART B (operations core):
 *  1. issue_type mandatory + per-type counterpart COA (coa_issue_<type>) + cc/recipient rules
 *  2. transfer value: Σamount(out) = Σamount(in) from the same out ledger row
 *  3. partial lot transfer splits the lot (7 + 3) and void restores it
 *  4. opening uniqueness per (product, warehouse, variant) → 409
 *  5. inventory_ledger.variant_id written on NEW rows (when the column exists)
 *  6. userMayWhNegative: admin / dedicated `negative` grant only
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ops-p2-v575-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-wh-ops-p2-v575-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { acct, clearCoaCache } = require('../lib/coa-map');
const WD = require('../lib/warehouse-docs');
const { createBatch } = require('../lib/inventory/batch-serial');
const { ledgerHasVariantColumn } = require('../lib/inventory/ledger');
const { todayJalali } = require('../jalali');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))); }
}
function attempt(fn) {
  try { return { value: fn() }; } catch (e) { return { err: e }; }
}
function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

function main() {
  console.log('\n=== warehouse phase 2 PART B v575 ===\n');
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();

  // The additive ledger.variant_id column may be created by a parallel migration; make sure
  // it exists for this test DB (never adds a backfill).
  const hadVariantCol = ledgerHasVariantColumn(db);
  if (!hadVariantCol) {
    try { db.exec('ALTER TABLE inventory_ledger ADD COLUMN variant_id INTEGER'); } catch (_) { /* exists */ }
  }

  const adminId = insert('users', { name: 'مدیر', username: 'whp2_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctUserId = insert('users', { name: 'حسابدار', username: 'whp2_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const accounting = db.prepare('SELECT * FROM users WHERE id=?').get(acctUserId);

  const cc = insert('cost_centers', { code: 'CC-P2', name: 'مرکز تست فاز۲', active: 1 });
  const whA = insert('warehouses', {
    name: 'انبار الف', code: 'P2-A', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
  });
  const whB = insert('warehouses', {
    name: 'انبار ب', code: 'P2-B', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
  });

  const mkProduct = (name, code) => insert('products', {
    user_id: adminId, name, code, price: 200000, cost: 1000, average_cost_rial: 1000,
    stock: 0, warehouse_id: whA, unit: 'عدد',
  });
  const pA = mkProduct('کالای الف', 'P2-PA');
  const pB = mkProduct('کالای ب', 'P2-PB');
  const pBatch = mkProduct('کالای بچ', 'P2-PBATCH');
  const pOpen = mkProduct('کالای افتتاحیه', 'P2-POPEN');

  const date = todayJalali();
  const receive = (productId, wh, qty, unit, extra = {}) => WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: wh, date, receipt_class: 'adjustment',
    lines: [{ product_id: productId, qty, unit_cost_rial: unit, ...(extra.line || {}) }],
    ...(extra.body || {}),
  }, admin);
  const jeDebit = (jeId) => db.prepare(
    'SELECT account_code, cost_center_id FROM journal_lines WHERE entry_id=? AND debit_rial>0'
  ).all(jeId);
  const jeCredit = (jeId) => db.prepare(
    'SELECT account_code FROM journal_lines WHERE entry_id=? AND credit_rial>0'
  ).all(jeId);

  receive(pA, whA, 100, 1000);
  receive(pB, whA, 100, 2500);

  // ── 1) issue_type ───────────────────────────────────────────────────────────
  console.log('— issue_type —');
  const issue = (body, user = admin) => WD.createWarehouseDoc(db, {
    type: 'issue', warehouse_id: whA, date,
    lines: [{ product_id: pA, qty: 1 }], ...body,
  }, user);

  let r = attempt(() => issue({}));
  ok(r.err && r.err.code === 'E_ISSUE_TYPE_REQUIRED' && r.err.status === 400, 'issue without issue_type → 400 E_ISSUE_TYPE_REQUIRED', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'bogus', recipient: 'x' }));
  ok(r.err && r.err.code === 'E_ISSUE_TYPE_INVALID', 'unknown issue_type rejected', r.err && r.err.code);
  ok(!db.prepare("SELECT 1 FROM warehouse_docs WHERE type='issue'").get(), 'rejected issues left no document behind');

  r = attempt(() => issue({ issue_type: 'internal_consume' }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'internal_consume without cost center rejected', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'internal_consume', recipient: 'x' }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'internal_consume needs a cost center (recipient alone not enough)', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'scrap' }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'scrap needs a cost center', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'sample_gift' }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'sample_gift needs cost center or recipient', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'consignment', cost_center_id: cc }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'consignment needs a recipient (cc alone not enough)', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'return_to_supplier', recipient: 'x', cost_center_id: cc }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'return_to_supplier needs a supplier', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'other' }));
  ok(r.err && r.err.code === 'E_ISSUE_TARGET_REQUIRED', 'other needs cc or recipient', r.err && r.err.code);
  r = attempt(() => issue({ issue_type: 'internal_consume', cost_center_id: 999999 }));
  ok(r.err && r.err.code === 'E_COST_CENTER_NOT_FOUND', 'unknown cost center rejected', r.err && r.err.code);

  const expect = (label, body, code) => {
    const d = issue(body);
    const dr = jeDebit(d.je_id);
    const cr = jeCredit(d.je_id);
    ok(!!d.je_id && d.issue_type === body.issue_type, `${label}: posted with issue_type`, d);
    ok(dr.length === 1 && dr[0].account_code === code, `${label}: counterpart debit → ${code}`, dr);
    ok(cr.length === 1 && cr[0].account_code === acct(db, 'coa_finished_goods').code, `${label}: credit → inventory`, cr);
    return d;
  };
  const dInternal = expect('internal_consume', { issue_type: 'internal_consume', cost_center_id: cc }, acct(db, 'coa_admin_expense').code);
  ok(jeDebit(dInternal.je_id)[0].cost_center_id === cc, 'internal_consume: expense line carries the chosen cost center');
  expect('sample_gift (recipient)', { issue_type: 'sample_gift', recipient: 'مشتری نمونه' }, acct(db, 'coa_sales_expense').code);
  expect('sample_gift (cost center)', { issue_type: 'sample_gift', cost_center_id: cc }, acct(db, 'coa_sales_expense').code);
  expect('scrap', { issue_type: 'scrap', cost_center_id: cc }, acct(db, 'coa_inventory_loss').code);
  expect('consignment', { issue_type: 'consignment', recipient: 'پیمانکار الف' }, acct(db, 'coa_subcontract_inventory').code);
  const supId = insert('suppliers', { name: 'تأمین‌کننده تست', phone: '0' });
  expect('return_to_supplier', { issue_type: 'return_to_supplier', supplier_id: supId }, acct(db, 'coa_payable').code);
  expect('other', { issue_type: 'other', recipient: 'متفرقه' }, acct(db, 'coa_issue_other').code);

  // admin override via settings coa_issue_<type>
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_issue_scrap', ?)").run(acct(db, 'coa_admin_expense').code);
  clearCoaCache();
  expect('scrap override (setting)', { issue_type: 'scrap', cost_center_id: cc }, acct(db, 'coa_admin_expense').code);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_issue_scrap', '987654')").run();
  r = attempt(() => issue({ issue_type: 'scrap', cost_center_id: cc }));
  ok(r.err && r.err.code === 'E_ISSUE_COA_INVALID', 'override pointing to a non-existent account rejected', r.err && r.err.code);
  db.prepare("DELETE FROM settings WHERE key='coa_issue_scrap'").run();
  clearCoaCache();

  // persisted column (when the parallel schema agent has added it)
  const docCols = db.prepare('PRAGMA table_info(warehouse_docs)').all().map((c) => c.name);
  if (docCols.includes('issue_type')) {
    const row = db.prepare('SELECT issue_type FROM warehouse_docs WHERE id=?').get(dInternal.id);
    ok(row && row.issue_type === 'internal_consume', 'warehouse_docs.issue_type persisted', row);
  } else {
    console.log('  · warehouse_docs.issue_type column not present yet — persistence step skipped (defensive path)');
  }

  // revise keeps/accepts the type
  const rev = WD.reviseWarehouseDoc(db, dInternal.id, {
    type: 'issue', warehouse_id: whA, date, issue_type: 'internal_consume', cost_center_id: cc,
    lines: [{ product_id: pA, qty: 2 }],
  }, admin);
  ok(rev && rev.id && rev.issue_type === 'internal_consume', 'revise issue (void + recreate) works with issue_type', rev);

  // ── 2) transfer value ───────────────────────────────────────────────────────
  console.log('— transfer value —');
  const sumByKind = (docId) => {
    const moveIds = db.prepare('SELECT id FROM warehouse_moves WHERE doc_id=?').all(docId).map((x) => x.id);
    const q = (ev) => db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) s, COALESCE(SUM(qty_out+qty_in),0) q FROM inventory_ledger
      WHERE source_type='warehouse_transfer' AND event_type=? AND source_id IN (${moveIds.map(() => '?').join(',')})
        AND reversed_of IS NULL
    `).get(ev, ...moveIds);
    return { out: q('transfer_out'), in: q('transfer_in') };
  };
  const t1 = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pA, qty: 7 }, { product_id: pB, qty: 3 }],
  }, admin);
  const s1 = sumByKind(t1.id);
  ok(s1.out.s > 0 && s1.out.s === s1.in.s, 'Σamount(out) = Σamount(in) for a 2-line transfer', s1);
  ok(s1.out.q === s1.in.q, 'Σqty(out) = Σqty(in)', s1);
  const rows1 = db.prepare(`
    SELECT o.amount_rial oa, i.amount_rial ia FROM inventory_ledger o
    JOIN inventory_ledger i ON i.source_id=o.source_id AND i.source_type='warehouse_transfer' AND i.event_type='transfer_in'
    WHERE o.source_type='warehouse_transfer' AND o.event_type='transfer_out'
      AND o.source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?)
  `).all(t1.id);
  ok(rows1.length === 2 && rows1.every((x) => x.oa === x.ia), 'each in row equals its own out row', rows1);
  // change the average, fractional qty → still equal
  receive(pA, whA, 10, 1333);
  const t2 = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pA, qty: 3 }],
  }, admin);
  const s2 = sumByKind(t2.id);
  ok(s2.out.s === s2.in.s && s2.out.s > 0, 'equality holds after avg change', s2);
  const mv = db.prepare('SELECT amount_rial FROM warehouse_moves WHERE doc_id=?').get(t2.id);
  ok(mv.amount_rial === s2.out.s, 'warehouse_moves.amount_rial = out amount', mv);

  // ── 3) partial lot split ────────────────────────────────────────────────────
  console.log('— batch split —');
  const lot = createBatch(db, { productId: pBatch, warehouseId: whA, batchNo: 'LOT-P2', createdBy: adminId });
  receive(pBatch, whA, 10, 4000, { line: { batch_id: lot.id } });
  ok(Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(lot.id).q) === 10, 'lot received with 10');

  let tb = attempt(() => WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pBatch, qty: 11, batch_id: lot.id }],
  }, admin));
  ok(tb.err && /بچ|موجود/.test(String(tb.err.message || '')), 'transfer more than lot on-hand rejected', tb.err && tb.err.message);

  const tPart = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pBatch, qty: 3, batch_id: lot.id }],
  }, admin);
  const lots = db.prepare('SELECT * FROM inventory_batches WHERE product_id=? ORDER BY id').all(pBatch);
  ok(lots.length === 2, 'partial transfer created a second lot row', lots.length);
  const src = lots.find((l) => l.id === lot.id);
  const dst = lots.find((l) => l.id !== lot.id);
  ok(src && Number(src.qty_on_hand) === 7 && Number(src.warehouse_id) === whA, 'source lot keeps 7 in origin warehouse', src);
  ok(dst && Number(dst.qty_on_hand) === 3 && Number(dst.warehouse_id) === whB, 'new lot holds 3 in destination warehouse', dst);
  ok(dst && dst.batch_no !== src.batch_no, 'split lot has its own batch_no (UNIQUE product,batch_no)', dst && dst.batch_no);
  const sp = sumByKind(tPart.id);
  ok(sp.out.s > 0 && sp.out.s === sp.in.s, 'batch transfer: Σout = Σin', sp);
  const inRow = db.prepare(`SELECT batch_id FROM inventory_ledger WHERE source_type='warehouse_transfer' AND event_type='transfer_in'
    AND source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?)`).get(tPart.id);
  ok(inRow && inRow.batch_id === dst.id, 'transfer_in ledger row points at the new lot', inRow);

  // second partial to the same destination tops up the existing split lot
  WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pBatch, qty: 2, batch_id: lot.id }],
  }, admin);
  const lots2 = db.prepare('SELECT * FROM inventory_batches WHERE product_id=? ORDER BY id').all(pBatch);
  ok(lots2.length === 2 && Number(lots2.find((l) => l.id === dst.id).qty_on_hand) === 5
    && Number(lots2.find((l) => l.id === lot.id).qty_on_hand) === 5, 'second partial tops up the destination lot (5 + 5)', lots2.map((l) => l.qty_on_hand));

  // void the first partial → 3 returns to source
  WD.voidWarehouseDoc(db, tPart.id, admin, { reason: 'test' });
  const lots3 = db.prepare('SELECT * FROM inventory_batches WHERE product_id=? ORDER BY id').all(pBatch);
  ok(Number(lots3.find((l) => l.id === lot.id).qty_on_hand) === 8
    && Number(lots3.find((l) => l.id === dst.id).qty_on_hand) === 2, 'void restores lot quantities (8 / 2)', lots3.map((l) => l.qty_on_hand));

  // whole-lot transfer: row is moved, not split
  const lot2 = createBatch(db, { productId: pBatch, warehouseId: whA, batchNo: 'LOT-P2-WHOLE', createdBy: adminId });
  receive(pBatch, whA, 4, 4000, { line: { batch_id: lot2.id } });
  const before = db.prepare('SELECT COUNT(*) c FROM inventory_batches WHERE product_id=?').get(pBatch).c;
  const tWhole = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pBatch, qty: 4, batch_id: lot2.id }],
  }, admin);
  const after = db.prepare('SELECT COUNT(*) c FROM inventory_batches WHERE product_id=?').get(pBatch).c;
  ok(after === before && Number(db.prepare('SELECT warehouse_id w FROM inventory_batches WHERE id=?').get(lot2.id).w) === whB,
    'whole-lot transfer moves the row (no split)');
  WD.voidWarehouseDoc(db, tWhole.id, admin, { reason: 'test' });
  ok(Number(db.prepare('SELECT warehouse_id w FROM inventory_batches WHERE id=?').get(lot2.id).w) === whA, 'void of whole-lot transfer moves it back');

  // ── 4) opening uniqueness ──────────────────────────────────────────────────
  console.log('— opening uniqueness —');
  const opening = (productId, wh, extraLine = {}) => WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: wh, date, receipt_class: 'opening',
    lines: [{ product_id: productId, qty: 5, unit_cost_rial: 1500, ...extraLine }],
  }, admin);
  const o1 = opening(pOpen, whA);
  ok(o1 && o1.id, 'first opening posts');
  r = attempt(() => opening(pOpen, whA));
  ok(r.err && r.err.status === 409 && r.err.code === 'E_OPENING_EXISTS', 'second opening same (product, warehouse) → 409', r.err && { s: r.err.status, c: r.err.code });
  const stockAfterReject = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pOpen, whA);
  ok(stockAfterReject && Number(stockAfterReject.qty) === 5, 'rejected opening changed nothing', stockAfterReject);
  r = attempt(() => opening(pOpen, whB));
  ok(r.value && r.value.id, 'opening in ANOTHER warehouse is allowed');
  r = attempt(() => WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: whA, date, receipt_class: 'opening',
    lines: [
      { product_id: pBatch, qty: 1, unit_cost_rial: 100 },
      { product_id: pBatch, qty: 1, unit_cost_rial: 100 },
    ],
  }, admin));
  ok(r.err && r.err.code === 'E_OPENING_EXISTS', 'duplicate within the same document → 409', r.err && r.err.code);
  // ordinary (adjustment) receipts on an opened pair are unaffected
  r = attempt(() => receive(pOpen, whA, 1, 1500));
  ok(r.value && r.value.id, 'adjustment receipt on an already-opened pair still allowed');
  WD.voidWarehouseDoc(db, o1.id, admin, { reason: 'test' });
  r = attempt(() => opening(pOpen, whA));
  ok(r.value && r.value.id, 'after voiding the opening a new one is accepted');

  // variant-level: matrix product
  const pMx = mkProduct('کالای ماتریس', 'P2-MX');
  const colors = ['قرمز', 'آبی'].map((name) => insert('product_colors', { name, active: 1 }));
  const size = insert('product_sizes', { name: 'M', active: 1, sort_order: 0 });
  const variants = colors.map((cid) => {
    const vid = insert('product_variants', {
      product_id: pMx, color_id: cid, size_id: size, stock: 0, active: 1, is_default: 0, sku: `P2-MX-${cid}`,
    });
    db.prepare('UPDATE product_variants SET active=1 WHERE id=?').run(vid);
    return vid;
  });
  const [v1, v2] = variants;
  const ov1 = opening(pMx, whA, { variant_id: v1 });
  ok(ov1 && ov1.id, 'opening for variant 1 posts');
  r = attempt(() => opening(pMx, whA, { variant_id: v2 }));
  ok(r.value && r.value.id, 'opening for variant 2 of the same product/warehouse is a different key');
  r = attempt(() => opening(pMx, whA, { variant_id: v1 }));
  ok(r.err && r.err.code === 'E_OPENING_EXISTS', 'second opening for the same variant → 409', r.err && r.err.code);

  // ── 5) ledger.variant_id ───────────────────────────────────────────────────
  console.log('— ledger.variant_id —');
  ok(ledgerHasVariantColumn(db), 'inventory_ledger.variant_id column present');
  const lv = db.prepare(`
    SELECT l.variant_id FROM inventory_ledger l
    WHERE l.source_type='warehouse_move' AND l.source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?)
  `).all(ov1.id);
  ok(lv.length === 1 && lv[0].variant_id === v1, 'receipt ledger row carries variant_id', lv);
  const tv = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pMx, variant_id: v1, qty: 2 }],
  }, admin);
  const tvRows = db.prepare(`
    SELECT event_type, variant_id FROM inventory_ledger
    WHERE source_type='warehouse_transfer' AND source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?)
  `).all(tv.id);
  ok(tvRows.length === 2 && tvRows.every((x) => x.variant_id === v1), 'transfer_out + transfer_in rows carry variant_id', tvRows);
  const iv = WD.createWarehouseDoc(db, {
    type: 'issue', issue_type: 'scrap', cost_center_id: cc, warehouse_id: whA, date,
    lines: [{ product_id: pMx, variant_id: v1, qty: 1 }],
  }, admin);
  const ivRow = db.prepare(`SELECT variant_id FROM inventory_ledger WHERE source_type='warehouse_move'
    AND source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?)`).get(iv.id);
  ok(ivRow && ivRow.variant_id === v1, 'issue ledger row carries variant_id', ivRow);
  WD.voidWarehouseDoc(db, iv.id, admin, { reason: 'test' });
  const revRow = db.prepare(`SELECT variant_id FROM inventory_ledger WHERE reversed_of IS NOT NULL
    AND reversed_of IN (SELECT id FROM inventory_ledger WHERE source_id IN (SELECT id FROM warehouse_moves WHERE doc_id=?))`).get(iv.id);
  ok(revRow && revRow.variant_id === v1, 'reversal row copies variant_id', revRow);
  const plain = db.prepare(`SELECT variant_id FROM inventory_ledger WHERE product_id=? AND event_type='receipt' LIMIT 1`).get(pA);
  ok(plain && plain.variant_id == null, 'non-matrix movement leaves variant_id NULL', plain);

  // ── 6) negative permission ─────────────────────────────────────────────────
  console.log('— negative permission —');
  ok(WD.userMayWhNegative(db, admin) === true, 'admin may post negative');
  ok(WD.userMayWhNegative(db, accounting) === false, 'accounting without `negative` grant may not');
  ok(WD.userMayWhNegative(db, null) === false, 'no user → no');
  const rbac = require('../lib/rbac');
  const orig = rbac.hasPermission;
  rbac.hasPermission = (d, u, res, act) => res === 'acc_warehouse_ops' && act === 'negative';
  ok(WD.userMayWhNegative(db, accounting) === true, 'a user holding acc_warehouse_ops.negative may');
  rbac.hasPermission = (d, u, res, act) => res === 'acc_warehouse_ops' && act === 'create';
  ok(WD.userMayWhNegative(db, accounting) === false, 'create-only (storekeeper) may not');
  rbac.hasPermission = orig;

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { db.close(); } catch (_) { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  process.exit(fail ? 1 : 0);
}

try { main(); } catch (e) {
  console.error('FATAL', e);
  process.exit(1);
}
