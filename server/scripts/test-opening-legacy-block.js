'use strict';
/**
 * Opening SSOT — legacy stock/opening writers are blocked.
 * Run: node server/scripts/test-opening-legacy-block.js
 *
 * Isolated temp DB. Covers: POST /products stock>0 → 422 E_STOCK_VIA_OPENING (no ledger/WS);
 * stock 0 → 200; /products/quick stock>0 → 422; /products/import with stock → 422;
 * updateProductFromExcel differing stock → error + no write; reconcileInventoryLedgerGaps is
 * report-only (zero ledger rows, report setting); postProductOpeningInventory with live opening → 409;
 * warehouse opening receipt with legacy opening → 409 E_OPENING_EXISTS; seedMissingAverageCost with
 * live opening → no opening row/JE; manual inventory opening voucher → 409 E_OPENING_VIA_PRODUCT.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ Opening SSOT — legacy paths blocked ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-legacy-'));
process.env.DB_PATH = path.join(dir, 'legacy.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'opening-legacy-block-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const SE = require('../lib/inventory/shortage-error');
  const { XLSX } = require('../lib/excel-safe');
  const OP = require('../lib/opening-post');
  const { updateProductFromExcel } = require('../lib/product-quick');
  const { seedMissingAverageCost } = require('../lib/inventory/seed-avg');
  const { createWarehouseDoc } = require('../lib/warehouse-docs');
  const { postManualVoucher } = require('../routes/accounting');
  const { acct } = require('../lib/coa-map');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const count = (sql, ...p) => Number(q1(sql, ...p).c) || 0;
  const ledgerCount = () => count('SELECT COUNT(*) AS c FROM inventory_ledger');
  const openingDate = OP.fiscalOpeningDate(db);

  const adminId = insert('users', { name: 'مدیر', username: 'olb_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const admin = q1('SELECT * FROM users WHERE id=?', adminId);
  const wh = insert('warehouses', { name: 'انبار اصلی', code: 'OLB', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  let seq = 0;
  const product = (name, extra = {}) => insert('products', Object.assign({
    user_id: adminId, name, code: `OLB-${++seq}`, price: 100000, cost: 0, stock: 0, warehouse_id: wh, average_cost_rial: 0, unit: 'عدد',
  }, extra));
  let tx = 0;
  const legacyOpening = (pid, qty) => insert('inventory_ledger', {
    tx_no: 'OLB-' + (++tx), qty_balance: qty, avg_cost_after_rial: 1000,
    event_type: 'opening', product_id: pid, warehouse_id: wh, qty_in: qty, qty_out: 0,
    unit_cost_rial: 1000, amount_rial: qty * 1000, source_type: 'opening_inventory', source_id: pid,
    status: 'posted', date: openingDate, note: 'موجودی اول دوره', created_by: adminId,
  });

  const token = issueStaffSession(db, admin, { device_kind: 'test', device_name: 'olb', device_fingerprint: 'olb-fp' }).token;
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use('/api/products', require('../routes/products'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  try {
    // ── 1. POST /api/products ──
    {
      const ledBefore = ledgerCount();
      const wsBefore = count('SELECT COUNT(*) AS c FROM warehouse_stock');
      const r = await api('POST', '/api/products', { name: 'کالای با موجودی', stock: 5, cost: 200000 });
      ok(r.status === 422 && r.data && r.data.code === 'E_STOCK_VIA_OPENING', 'POST /products stock>0 → 422 E_STOCK_VIA_OPENING', r);
      ok(r.data && /موجودی اول دوره/.test(r.data.error || ''), 'Persian message mentions موجودی اول دوره', r.data);
      ok(!q1("SELECT id FROM products WHERE name='کالای با موجودی'"), 'no product row created on 422');
      ok(ledgerCount() === ledBefore, 'no inventory_ledger rows on 422');
      ok(count('SELECT COUNT(*) AS c FROM warehouse_stock') === wsBefore, 'no warehouse_stock rows on 422');

      const r0 = await api('POST', '/api/products', { name: 'کالای بدون موجودی', stock: 0, cost: 200000 });
      ok(r0.status === 200 && r0.data && r0.data.id, 'POST /products stock 0 → 200', r0);
      const pid = r0.data && r0.data.id;
      ok(Number(q1('SELECT stock FROM products WHERE id=?', pid)?.stock) === 0, 'created product stock=0');
      ok(count('SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id=?', pid) === 0, 'created product has no ledger rows');
      ok(Number(q1('SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stock WHERE product_id=?', pid).q) === 0, 'created product WS qty=0');

      const rOq = await api('POST', '/api/products', { name: 'کالای opening_qty', opening_qty: 3, cost: 1 });
      ok(rOq.status === 422 && rOq.data.code === 'E_STOCK_VIA_OPENING', 'POST /products opening_qty>0 → 422', rOq);
    }

    // ── 2. POST /api/products/quick ──
    {
      const ledBefore = ledgerCount();
      const r = await api('POST', '/api/products/quick', { name: 'سریع با موجودی', stock: 4, cost: 1000 });
      ok(r.status === 422 && r.data && r.data.code === 'E_STOCK_VIA_OPENING', '/products/quick stock>0 → 422', r);
      ok(!q1("SELECT id FROM products WHERE name='سریع با موجودی'"), 'quick: no product row on 422');
      ok(ledgerCount() === ledBefore, 'quick: no ledger rows on 422');
      const r0 = await api('POST', '/api/products/quick', { name: 'سریع بدون موجودی', cost: 1000 });
      ok(r0.status === 200 && r0.data && r0.data.id && Number(r0.data.stock) === 0, '/products/quick stock absent → 200 stock 0', r0);
    }

    // ── 3. POST /api/products/import ──
    {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
        { 'نام محصول': 'ایمپورت الف', 'قیمت': 1000, 'موجودی': 0 },
        { 'نام محصول': 'ایمپورت ب', 'قیمت': 1000, 'موجودی': 7 },
      ]), 'محصولات');
      const buf = await XLSX.write(wb);
      const fd = new FormData();
      fd.append('file', new Blob([buf]), 'p.xlsx');
      const res = await fetch(BASE + '/api/products/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      const data = await res.json().catch(() => null);
      ok(res.status === 422 && data && data.code === 'E_STOCK_VIA_OPENING', 'import with stock → 422', { status: res.status, data });
      ok(data && Array.isArray(data.rows) && data.rows.includes(3), 'import 422 lists row number 3', data);
      ok(!q1("SELECT id FROM products WHERE name IN ('ایمپورت الف','ایمپورت ب')"), 'import: nothing inserted');
    }

    // ── 4. updateProductFromExcel ──
    {
      const pid = product('اکسل آپدیت', { stock: 3 });
      insert('warehouse_stock', { product_id: pid, warehouse_id: wh, qty: 3 });
      const ledBefore = ledgerCount();
      let err = null;
      try { updateProductFromExcel(db, admin, pid, { name: 'اکسل آپدیت ۲', stock: 7, cost: 5000 }); } catch (e) { err = e; }
      ok(err && err.code === 'E_STOCK_VIA_OPENING' && err.status === 422, 'excel update differing stock → E_STOCK_VIA_OPENING', err && { code: err.code, msg: err.message });
      const p = q1('SELECT name, stock, average_cost_rial FROM products WHERE id=?', pid);
      ok(Number(p.stock) === 3 && p.name === 'اکسل آپدیت', 'excel update: product untouched', p);
      ok(Number(q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wh).qty) === 3, 'excel update: WS untouched');
      ok(ledgerCount() === ledBefore, 'excel update: no ledger rows');
      ok(count("SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='opening_inventory' AND ref_id=?", pid) === 0, 'excel update: no opening JE');
      // Stock compared against the ledger-derived on-hand (no ledger rows here → 0), not the legacy cache.
      updateProductFromExcel(db, admin, pid, { name: 'اکسل آپدیت ۲', stock: 0, cost: 5000 });
      ok(q1('SELECT name FROM products WHERE id=?', pid).name === 'اکسل آپدیت ۲', 'excel update with same stock still updates fields');
      updateProductFromExcel(db, admin, pid, { name: 'اکسل آپدیت ۳' });
      ok(q1('SELECT name FROM products WHERE id=?', pid).name === 'اکسل آپدیت ۳', 'excel update without stock column updates fields');
      ok(ledgerCount() === ledBefore, 'excel update success path: still no ledger rows');
    }

    // ── 5. reconcileInventoryLedgerGaps is report-only ──
    {
      const pGap = product('گپ کاردکس', { stock: 10 });
      insert('warehouse_stock', { product_id: pGap, warehouse_id: wh, qty: 10 });
      const pOrphan = product('موجودی هدر بدون انبار', { stock: 4 });
      const ledBefore = ledgerCount();
      const wsBefore = count('SELECT COUNT(*) AS c FROM warehouse_stock');
      const r = OP.reconcileInventoryLedgerGaps(db);
      ok(ledgerCount() === ledBefore, 'reconcileInventoryLedgerGaps inserts ZERO ledger rows', { before: ledBefore, after: ledgerCount() });
      ok(count('SELECT COUNT(*) AS c FROM warehouse_stock') === wsBefore, 'reconcileInventoryLedgerGaps inserts ZERO warehouse_stock rows');
      ok(r && r.count === 0 && r.report_only === true, 'returns count 0 + report_only', r);
      const rep = JSON.parse(q1("SELECT value FROM settings WHERE key='inventory_ledger_gap_report_v2'")?.value || 'null');
      ok(rep && rep.at && Array.isArray(rep.gaps) && rep.count >= 2, 'report setting written', rep && { count: rep.count });
      const g = rep && rep.gaps.find((x) => x.product_id === pGap);
      ok(g && g.warehouse_id === wh && g.ws_qty === 10 && g.kardex_qty === 0 && g.variant_id === null, 'gap row shape for WS>kardex', g);
      ok(rep && rep.gaps.some((x) => x.product_id === pOrphan && x.header_stock === 4), 'orphan header stock reported');
      const one = OP.reconcileProductStockLedger(db, pGap);
      ok(one.count === 0 && one.gaps.length === 1 && ledgerCount() === ledBefore, 'reconcileProductStockLedger report-only', one);
      const bf = OP.backfillOpeningInventoryLedger(db);
      ok(ledgerCount() === ledBefore && (bf.count || 0) === 0, 'backfillOpeningInventoryLedger writes no rows', bf);
    }

    // ── 6. postProductOpeningInventory guard ──
    {
      const pLive = product('دارای افتتاحیه');
      legacyOpening(pLive, 2);
      const ledBefore = ledgerCount();
      const jeBefore = count('SELECT COUNT(*) AS c FROM journal_entries');
      let err = null;
      try {
        OP.postProductOpeningInventory(db, { productId: pLive, qty: 5, unitCostRial: 1000, userId: adminId });
      } catch (e) { err = e; }
      ok(err && err.status === 409 && err.code === 'E_OPENING_EXISTS', 'postProductOpeningInventory with live opening → 409', err && { code: err.code, msg: err.message });
      ok(ledgerCount() === ledBefore && count('SELECT COUNT(*) AS c FROM journal_entries') === jeBefore, 'no ledger/JE written on 409');

      const pFree = product('بدون افتتاحیه');
      const je = OP.postProductOpeningInventory(db, { productId: pFree, qty: 2, unitCostRial: 1000, userId: adminId });
      ok(!!je && count("SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id=? AND event_type='opening'", pFree) === 1, 'postProductOpeningInventory without live opening still posts');
    }

    // ── 7. seedMissingAverageCost with live opening ──
    {
      const pSeed = product('سید میانگین', { stock: 2 });
      insert('warehouse_stock', { product_id: pSeed, warehouse_id: wh, qty: 2 });
      legacyOpening(pSeed, 2);
      const ledBefore = ledgerCount();
      const r = seedMissingAverageCost(db, { productId: pSeed, unitCostRial: 3000, userId: adminId });
      ok(ledgerCount() === ledBefore, 'seedMissingAverageCost: no new opening ledger row');
      ok(!r.je_id && r.live_opening === true, 'seedMissingAverageCost: no opening JE when live opening exists', r);
      ok(Number(q1('SELECT average_cost_rial FROM products WHERE id=?', pSeed).average_cost_rial) === 3000, 'seedMissingAverageCost still sets average cost');
    }

    // ── 8. Warehouse opening receipt with legacy opening ──
    {
      const pWh = product('رسید افتتاحیه');
      legacyOpening(pWh, 1);
      const ledBefore = ledgerCount();
      let err = null;
      try {
        createWarehouseDoc(db, {
          type: 'receipt', warehouse_id: wh, date: openingDate, receipt_class: 'opening',
          lines: [{ product_id: pWh, qty: 3, unit_cost_rial: 1000 }],
        }, admin);
      } catch (e) { err = e; }
      ok(err && err.status === 409 && err.code === 'E_OPENING_EXISTS', 'warehouse opening receipt with legacy opening → 409 E_OPENING_EXISTS', err && { code: err.code, msg: err.message });
      ok(ledgerCount() === ledBefore, 'opening receipt 409 wrote nothing');
    }

    // ── 9. Manual inventory opening voucher ──
    {
      const leafUnder = (code) => q1(`
        SELECT code FROM chart_of_accounts
        WHERE (code=? OR code LIKE ? || '%') AND COALESCE(is_active,1)=1
          AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c2 WHERE c2.parent_code=chart_of_accounts.code)
        ORDER BY LENGTH(code) DESC, code LIMIT 1
      `, code, code)?.code || code;
      const invCode = leafUnder(acct(db, 'coa_finished_goods').code);
      const openCode = leafUnder(acct(db, 'coa_opening_balance').code);
      const jeBefore = count('SELECT COUNT(*) AS c FROM journal_entries');
      let err = null;
      try {
        postManualVoucher(db, admin, {
          date: openingDate, doc_type: 'beginning_inventory', description: 'افتتاحیه موجودی دستی',
          lines: [
            { code: invCode, debit: 100000, credit: 0 },
            { code: openCode, debit: 0, credit: 100000 },
          ],
        }, { excelTrusted: false });
      } catch (e) { err = e; }
      ok(err && err.status === 409 && err.code === 'E_OPENING_VIA_PRODUCT', 'manual inventory opening voucher with inventory line → 409 E_OPENING_VIA_PRODUCT', err && { code: err.code, status: err.status, msg: err.message, invCode });
      ok(count('SELECT COUNT(*) AS c FROM journal_entries') === jeBefore, 'blocked voucher wrote no JE');

      const cashCode = leafUnder(acct(db, 'coa_cash_default').code);
      let okNoInv = null;
      try {
        okNoInv = postManualVoucher(db, admin, {
          date: openingDate, doc_type: 'beginning_inventory', description: 'افتتاحیه بدون حساب موجودی',
          lines: [
            { code: cashCode, debit: 50000, credit: 0 },
            { code: openCode, debit: 0, credit: 50000 },
          ],
        }, { excelTrusted: false });
      } catch (e) { okNoInv = e; }
      ok(okNoInv && okNoInv.id && !okNoInv.code, 'inventory-type opening voucher without inventory account still posts', okNoInv && { code: okNoInv.code, msg: okNoInv.message, cashCode });
    }
  } finally {
    server.close();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(1);
});
