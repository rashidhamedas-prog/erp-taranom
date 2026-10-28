'use strict';
/**
 * Phase 0 warehouse-module: defined picker, neg context, soft-delete, opening class.
 * Run: node server/scripts/test-wh-picker-defined-v573.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ warehouse Phase 0 picker / integrity (v573) ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('resolveServerModalPack(id, wh)') && /async function whPickProduct/.test(appJs),
  'whPickProduct uses resolveServerModalPack');
ok(/whPickProduct[\s\S]*?resolveServerModalPack/.test(appJs)
  && !/async function whPickProduct[\s\S]{0,400}resolveServerAutoPack/.test(appJs),
  'whPickProduct does not call resolveServerAutoPack');
ok(appJs.includes('openWhSkuMatrixModal') && appJs.includes('wh-sku-qty'),
  'SKU matrix modal present');
ok(/whDocType\s*=\s*'receipt'/.test(appJs) && /whDocType\s*=\s*'issue'/.test(appJs),
  'modals set whDocType');

const whDocs = fs.readFileSync(path.join(__dirname, '../lib/warehouse-docs.js'), 'utf8');
ok(!/اول\\s\*دوره\|افتتاحیه/.test(whDocs) && whDocs.includes("rawClass === 'opening'"),
  'opening only via receipt_class (no note regex)');
ok(whDocs.includes("code: 'NEGATIVE_NOT_ALLOWED'") && whDocs.includes("context: 'warehouse'"),
  'NEGATIVE_NOT_ALLOWED + warehouse context');

const movSrc = fs.readFileSync(path.join(__dirname, '../lib/inventory/movement.js'), 'utf8');
ok(/opts\.allowNegative === true/.test(movSrc), 'postStockMovement fail-closed allowNegative');

const ledSrc = fs.readFileSync(path.join(__dirname, '../lib/inventory/ledger.js'), 'utf8');
ok(ledSrc.includes("ctx === 'production'") && ledSrc.includes('production_allow_negative_stock'),
  'allowNegative production flag only in production context');

const whRoutes = fs.readFileSync(path.join(__dirname, '../routes/warehouses.js'), 'utf8');
ok(whRoutes.includes('inventory_ledger') && whRoutes.includes('deactivated: true'),
  'delete warehouse soft-deactivates on ledger history');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-p0-'));
process.env.DB_PATH = path.join(dir, 'wh-p0.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wh-p0-test-secret-32chars!!!!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

(async () => {
  const { getDB, initDB } = require('../db');
  initDB();
  const db = getDB();
  const { issueStaffSession } = require('../lib/auth-sessions');
  const { createWarehouseDoc } = require('../lib/warehouse-docs');
  const { allowNegative } = require('../lib/inventory/ledger');
  const { todayJalali } = require('../jalali');

  function insert(table, obj) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const keys = Object.keys(obj).filter((k) => cols.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_allow_negative_stock','1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();

  const adminId = insert('users', { name: 'مدیر', username: 'whp0_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'whp0_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const acct = db.prepare('SELECT * FROM users WHERE id=?').get(acctId);

  const whStrict = insert('warehouses', {
    name: 'انبار سخت', code: 'WH-S', active: 1, allow_negative: 0, warehouse_type: 'finished_goods',
  });
  const whNeg = insert('warehouses', {
    name: 'انبار منفی', code: 'WH-N', active: 1, allow_negative: 1, warehouse_type: 'finished_goods',
  });

  ok(allowNegative(db, whStrict, { context: 'warehouse' }) === false,
    'warehouse context: production_allow_negative does not unlock strict WH');
  ok(allowNegative(db, whStrict, { context: 'production' }) === true,
    'production context still honors production_allow_negative_stock');

  const prodId = insert('products', {
    user_id: adminId, name: 'کالای ماتریس P0', code: 'WHP0-1', price: 100000, cost: 40000,
    average_cost_rial: 40000, stock: 0, warehouse_id: whStrict, unit: 'عدد',
  });
  let colorIds = [];
  let sizeIds = [];
  try {
    for (const name of ['قرمز', 'آبی', 'سبز']) {
      colorIds.push(insert('product_colors', { name, active: 1 }));
    }
    for (const name of ['M', 'L']) {
      sizeIds.push(insert('product_sizes', { name, active: 1, sort_order: sizeIds.length }));
    }
  } catch (e) {
    ok(false, 'colors/sizes tables', e.message);
  }
  const variants = [];
  for (const cid of colorIds) {
    for (const sid of sizeIds) {
      const vid = insert('product_variants', {
        product_id: prodId, color_id: cid, size_id: sid, stock: 0, active: 1, is_default: 0,
        sku: `WHP0-${cid}-${sid}`,
      });
      db.prepare('UPDATE product_variants SET active=1 WHERE id=?').run(vid);
      variants.push(vid);
    }
  }
  ok(variants.length === 6, '6 matrix variants seeded', variants.length);
  ok(variants.every((vid) => Number(db.prepare('SELECT active FROM product_variants WHERE id=?').get(vid).active) === 1),
    'all seeded variants active');

  // Receipt of zero-stock SKU on allow_negative=0 must succeed
  let receiptOk = null;
  try {
    receiptOk = createWarehouseDoc(db, {
      type: 'receipt', warehouse_id: whStrict, date: todayJalali(), note: 'رسید تست',
      receipt_class: 'adjustment',
      lines: [{ product_id: prodId, variant_id: variants[0], qty: 2 }],
    }, admin);
  } catch (e) { receiptOk = e; }
  ok(receiptOk && receiptOk.id && !receiptOk.code, 'receipt zero-stock SKU succeeds', receiptOk);

  // Note saying opening without receipt_class must NOT open opening JE path — class stays adjustment
  let noteOpening = null;
  try {
    noteOpening = createWarehouseDoc(db, {
      type: 'receipt', warehouse_id: whStrict, date: todayJalali(),
      note: 'موجودی اول دوره آزمایشی بدون کلاس',
      receipt_class: 'adjustment',
      lines: [{ product_id: prodId, variant_id: variants[1], qty: 1 }],
    }, admin);
  } catch (e) { noteOpening = e; }
  ok(noteOpening && noteOpening.id, 'receipt with opening-like note still posts', noteOpening);
  if (noteOpening && noteOpening.id) {
    const doc = db.prepare('SELECT receipt_class FROM warehouse_docs WHERE id=?').get(noteOpening.id);
    ok(doc && doc.receipt_class === 'adjustment', 'note text does not force opening class', doc);
  }

  // Issue over stock on strict WH → NEGATIVE_NOT_ALLOWED (even if production_allow_negative=1)
  let issueDenied = null;
  try {
    createWarehouseDoc(db, {
      type: 'issue', issue_type: 'other', recipient: 'تست', warehouse_id: whStrict, date: todayJalali(), note: 'حواله بیش از موجودی',
      lines: [{ product_id: prodId, variant_id: variants[0], qty: 999 }],
    }, acct);
  } catch (e) { issueDenied = e; }
  ok(!!issueDenied && (issueDenied.code === 'NEGATIVE_NOT_ALLOWED' || /موجودی/.test(String(issueDenied.message||''))),
    'issue over stock denied despite production_allow_negative', issueDenied && issueDenied.code);

  // allow_negative=1 + non-admin without operate → still denied
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(prodId, whNeg, 0);
  try {
    db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(variants[2], whNeg, 0);
  } catch (_) {}
  let issueAcctNeg = null;
  try {
    createWarehouseDoc(db, {
      type: 'issue', issue_type: 'other', recipient: 'تست', warehouse_id: whNeg, date: todayJalali(), note: 'منفی بدون مجوز',
      lines: [{ product_id: prodId, variant_id: variants[2], qty: 1 }],
    }, acct);
  } catch (e) { issueAcctNeg = e; }
  ok(!!issueAcctNeg && issueAcctNeg.code === 'NEGATIVE_NOT_ALLOWED',
    'allow_negative WH + accounting without neg perm → NEGATIVE_NOT_ALLOWED', issueAcctNeg);

  // admin on allow_negative WH → accepted
  let issueAdmin = null;
  try {
    issueAdmin = createWarehouseDoc(db, {
      type: 'issue', issue_type: 'other', recipient: 'تست', warehouse_id: whNeg, date: todayJalali(), note: 'منفی با ادمین',
      lines: [{ product_id: prodId, variant_id: variants[2], qty: 1 }],
    }, admin);
  } catch (e) { issueAdmin = e; }
  ok(issueAdmin && issueAdmin.id, 'admin may issue negative on allow_negative WH', issueAdmin);

  // Soft-delete warehouse that has ledger/doc history but no assigned products
  const whHist = insert('warehouses', {
    name: 'انبار سابقه', code: 'WH-H', active: 1, allow_negative: 0, warehouse_type: 'finished_goods',
  });
  createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: whHist, date: todayJalali(), note: 'سابقه برای soft-delete',
    receipt_class: 'adjustment',
    lines: [{ product_id: prodId, variant_id: variants[3], qty: 1 }],
  }, admin);
  // zero stock so qty gate does not block; keep ledger/docs
  try {
    db.prepare('UPDATE warehouse_stock SET qty=0 WHERE warehouse_id=?').run(whHist);
  } catch (_) {}
  try {
    db.prepare('UPDATE variant_warehouse_stock SET qty=0 WHERE warehouse_id=?').run(whHist);
  } catch (_) {}

  const app = express();
  app.use(express.json());
  app.use('/api/warehouses', require('../routes/warehouses'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tok = issueStaffSession(db, admin, { device_kind: 'test', device_name: 'whp0', device_fingerprint: 'fp-whp0' }).token;
  const del = await fetch(`http://127.0.0.1:${port}/api/warehouses/${whHist}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + tok },
  });
  const delBody = await del.json().catch(() => ({}));
  ok(del.status === 200 && delBody.deactivated === true, 'DELETE warehouse with history → deactivated', delBody);
  const still = db.prepare('SELECT active FROM warehouses WHERE id=?').get(whHist);
  ok(still && Number(still.active) === 0, 'warehouse row remains inactive', still);

  server.close();
  try { db.close(); } catch (_) {}
  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
