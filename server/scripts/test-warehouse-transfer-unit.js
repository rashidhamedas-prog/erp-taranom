#!/usr/bin/env node
/**
 * Phase 0 — warehouse transfer / receipt JE amount unit regression.
 * Confirms Σ kardex amount_rial (RIAL) → postToLedger TOMAN → debit_rial/credit_rial round-trip
 * (odd rial like 1,234,567 and large opening 71,232,000), and same-account transfer skips JE.
 *
 * Run: node server/scripts/test-warehouse-transfer-unit.js
 *   or: npm run test:wh-transfer-unit  (from server/)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-xfer-unit-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-wh-xfer-unit-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const WD = require('../lib/warehouse-docs');
const { todayJalali } = require('../jalali');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else {
    fail += 1;
    console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
}

function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

function coa(code, name, type, parent, level) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
    .run(code, name, type, parent || null, level || 3);
}

function main() {
  console.log('\n=== warehouse transfer amount unit (phase 0) ===\n');
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();

  // Leaf inventory accounts under 1104 (distinct so transfer posts a reclass JE)
  coa('1104', 'موجودی کالا', 'asset', null, 2);
  coa('110401', 'موجودی — انبار الف', 'asset', '1104', 3);
  coa('110402', 'موجودی — انبار ب', 'asset', '1104', 3);
  coa('5101', 'بهای تمام‌شده', 'cogs', '5000', 3);

  const adminId = insert('users', {
    name: 'مدیر', username: 'xfer_unit_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const date = todayJalali();

  const whA = insert('warehouses', {
    name: 'انبار الف', code: 'XU-A', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    inventory_coa_code: '110401', cogs_coa_code: '5101',
  });
  const whB = insert('warehouses', {
    name: 'انبار ب', code: 'XU-B', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    inventory_coa_code: '110402', cogs_coa_code: '5101',
  });
  const whSame = insert('warehouses', {
    name: 'انبار همحساب', code: 'XU-S', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    inventory_coa_code: '110401', cogs_coa_code: '5101',
  });

  const pOdd = insert('products', {
    user_id: adminId, name: 'کالای فرد', code: 'XU-ODD', price: 200000, cost: 1000,
    average_cost_rial: 0, stock: 0, warehouse_id: whA, unit: 'عدد',
  });
  const pOpen = insert('products', {
    user_id: adminId, name: 'کالای افتتاحیه', code: 'XU-OPEN', price: 200000, cost: 1000,
    average_cost_rial: 0, stock: 0, warehouse_id: whA, unit: 'عدد',
  });
  const pSame = insert('products', {
    user_id: adminId, name: 'کالای همحساب', code: 'XU-SAME', price: 200000, cost: 1000,
    average_cost_rial: 0, stock: 0, warehouse_id: whA, unit: 'عدد',
  });

  const ODD_RIAL = 1234567;
  const OPEN_RIAL = 71232000;

  // ── 1) odd RIAL receipt → transfer across distinct leaf COAs ───────────────
  console.log('— odd rial transfer JE —');
  const recvOdd = WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: whA, date, receipt_class: 'adjustment',
    lines: [{ product_id: pOdd, qty: 1, unit_cost_rial: ODD_RIAL }],
  }, admin);
  ok(!!recvOdd && !!recvOdd.id, 'odd receipt created', recvOdd);
  const recvOddLines = db.prepare(`
    SELECT jl.account_code, jl.debit_rial, jl.credit_rial
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.id=? AND COALESCE(je.deleted_at,0)=0
  `).all(recvOdd.je_id);
  const invDebitOdd = recvOddLines.find((l) => Number(l.debit_rial) > 0);
  ok(invDebitOdd && Number(invDebitOdd.debit_rial) === ODD_RIAL,
    `odd receipt inventory debit_rial = ${ODD_RIAL}`, invDebitOdd);

  const xfer = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date,
    lines: [{ product_id: pOdd, qty: 1 }],
  }, admin);
  ok(!!xfer && !!xfer.je_id, 'cross-account transfer posted a JE', xfer);

  const je = db.prepare(`
    SELECT id, ref_type FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0
  `).get(xfer.je_id);
  ok(je && je.ref_type === 'warehouse_transfer_batch', 'JE source = warehouse_transfer_batch', je);

  const xferLines = db.prepare(`
    SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?
  `).all(xfer.je_id);
  const sumDr = xferLines.reduce((s, l) => s + Number(l.debit_rial || 0), 0);
  const sumCr = xferLines.reduce((s, l) => s + Number(l.credit_rial || 0), 0);
  ok(sumDr === ODD_RIAL && sumCr === ODD_RIAL,
    `transfer JE debit_rial = credit_rial = ${ODD_RIAL}`, { sumDr, sumCr, xferLines });

  const moveIds = db.prepare('SELECT id FROM warehouse_moves WHERE doc_id=?').all(xfer.id).map((r) => r.id);
  const kardexOut = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM inventory_ledger
    WHERE source_type='warehouse_transfer' AND event_type='transfer_out'
      AND source_id IN (${moveIds.map(() => '?').join(',')}) AND reversed_of IS NULL
  `).get(...moveIds).s;
  const kardexIn = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM inventory_ledger
    WHERE source_type='warehouse_transfer' AND event_type='transfer_in'
      AND source_id IN (${moveIds.map(() => '?').join(',')}) AND reversed_of IS NULL
  `).get(...moveIds).s;
  ok(kardexOut === ODD_RIAL && kardexIn === ODD_RIAL,
    `Σ kardex out = Σ in = ${ODD_RIAL}`, { kardexOut, kardexIn });
  ok(sumDr === kardexOut && sumCr === kardexIn,
    'JE rial equals Σ kardex amount_rial out/in', { sumDr, kardexOut, sumCr, kardexIn });

  // ── 2) large opening-style receipt (71,232,000 RIAL) ───────────────────────
  console.log('— large receipt JE —');
  const recvOpen = WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: whA, date, receipt_class: 'adjustment',
    lines: [{ product_id: pOpen, qty: 1, unit_cost_rial: OPEN_RIAL }],
  }, admin);
  ok(!!recvOpen && !!recvOpen.je_id, 'large receipt created with JE', recvOpen);
  const openInv = db.prepare(`
    SELECT jl.debit_rial, jl.account_code FROM journal_lines jl
    WHERE jl.entry_id=? AND jl.debit_rial>0
  `).get(recvOpen.je_id);
  ok(openInv && Number(openInv.debit_rial) === OPEN_RIAL,
    `large receipt inventory debit_rial = ${OPEN_RIAL}`, openInv);
  ok(openInv && openInv.account_code === '110401',
    'large receipt inventory line hits warehouse leaf 110401', openInv);

  // ── 3) same inventory account → no JE ──────────────────────────────────────
  console.log('— same-account transfer (no JE) —');
  WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: whA, date, receipt_class: 'adjustment',
    lines: [{ product_id: pSame, qty: 2, unit_cost_rial: 50000 }],
  }, admin);
  const jeBefore = db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE COALESCE(deleted_at,0)=0').get().c;
  const xferSame = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whSame, date,
    lines: [{ product_id: pSame, qty: 2 }],
  }, admin);
  const jeAfter = db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE COALESCE(deleted_at,0)=0').get().c;
  ok(!!xferSame && !!xferSame.id, 'same-account transfer created doc', xferSame);
  ok(!xferSame.je_id, 'same-account transfer has no je_id', xferSame);
  ok(jeAfter === jeBefore, 'same-account transfer did not create a journal entry', { jeBefore, jeAfter });

  console.log(`\n=== result: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
}
