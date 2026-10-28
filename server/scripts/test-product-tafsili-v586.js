'use strict';
/**
 * v586 Phase 2 — product tafsili mode + warehouse-map guard + inventory posting source.
 * Run: node server/scripts/test-product-tafsili-v586.js
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

console.log('\n══ v586 — product tafsili + warehouse inventory posting ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-tafsili-v586-'));
process.env.DB_PATH = path.join(dir, 'pt.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'product-tafsili-v586-test-secret-at-least-32!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const realWarn = console.warn;
const warned = [];
console.warn = (...a) => { warned.push(a.join(' ')); };

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const { allocTafsili, clearCoaCache, isPostableCode } = require('../lib/coa-map');
  const { assignProductTafsili, productTafsiliMode, MODE_KEY } = require('../lib/product-tafsili');
  const L = require('../lib/inventory/ledger');
  const { initWarehouseInventorySystem } = require('../lib/inventory/periodic-close');
  const capture = require('../sync/capture');
  const { todayJalali } = require('../jalali');

  initWarehouseInventorySystem(db);

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
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const setMode = (v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MODE_KEY, v);
  const setCoa = (k, v) => {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
    clearCoaCache();
  };
  const setFlag = (v) => db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ledger_leaf_enforcement',?)").run(v);

  function coa(code, name, type, parent, level) {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
      .run(code, name, type, parent, level || 3);
  }
  coa('1100', 'دارایی جاری', 'asset', null, 2);
  coa('1104', 'موجودی کالا', 'asset', '1100', 2);
  coa('110401', 'کالای ساخته‌شده', 'asset', '1104', 3);
  coa('110402', 'انبار مرکزی', 'asset', '1104', 3);
  coa('110403', 'انبار فروشگاه', 'asset', '1104', 3);
  coa('1111', 'کالای در جریان ساخت', 'asset', '1100', 2);
  coa('5101', 'بهای تمام‌شده', 'cogs', null, 3);
  coa('5190', 'بهای تمام‌شده انبار', 'cogs', null, 3);
  ok(isPostableCode(db, '110402') && isPostableCode(db, '110403'), 'fixture: 110402/110403 are leaf');

  const adminId = insert('users', {
    name: 'مدیر', username: 'pt586_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });
  const custId = insert('customers', {
    user_id: adminId, biz: 'مشتری', owner: 'م', city: 'مشهد', phone: '0511', status: 'active',
  });
  const mkWh = (name, code, extra = {}) => insert('warehouses', Object.assign({
    name, code, active: 1, allow_negative: 1, is_default: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    inventory_coa_code: '110402', cogs_coa_code: '5190',
  }, extra));

  function countLeavesUnder(...prefixes) {
    return qa(`
      SELECT code FROM chart_of_accounts
      WHERE COALESCE(level,4)=4 AND length(code)=12 AND COALESCE(is_active,1)=1
    `).filter((r) => prefixes.some((p) => String(r.code).startsWith(p))).length;
  }
  function kidsOf(prefix) {
    return qa(`
      SELECT code FROM chart_of_accounts
      WHERE parent_code=? OR (length(code)=12 AND substr(code,1,6)=?)
    `, prefix, prefix).length;
  }

  // ── migration ──
  console.log('— migration —');
  ok(q1('SELECT value FROM settings WHERE key=?', MODE_KEY)?.value === 'legacy_leaf',
    'INSERT OR IGNORE default coa_product_tafsili_mode=legacy_leaf');
  setMode('detail_account');
  initWarehouseInventorySystem(db);
  ok(q1('SELECT value FROM settings WHERE key=?', MODE_KEY)?.value === 'detail_account',
    'second init does not overwrite existing mode');
  setMode('legacy_leaf');

  const legacyPid = insert('products', {
    user_id: adminId, name: 'کالای legacy', code: 'LEG-1', price: 10000, cost: 5000, stock: 0,
    coa_code: '110401000099', unit: 'عدد',
  });
  setMode('detail_account');
  ok(q1('SELECT coa_code FROM products WHERE id=?', legacyPid).coa_code === '110401000099',
    'mode switch does not rewrite existing products.coa_code');
  setMode('legacy_leaf');

  // HTTP harness
  const u = q1('SELECT * FROM users WHERE id=?', adminId);
  const token = issueStaffSession(db, u, {
    device_kind: 'test', device_name: 'pt586', device_fingerprint: 'pt586-fp',
  }).token;
  const app = express();
  app.use(express.json());
  app.use(capture.captureMiddleware);
  app.use('/api/products', require('../routes/products'));
  app.use('/api/invoices', require('../routes/invoices'));
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
  let reqSeq = 0;
  const saleBody = (rows, whId) => ({
    client_request_id: 'pt586-' + (++reqSeq) + '-' + Date.now(),
    cust_id: custId, type: 'normal', date: todayJalali(), pay_type: 'credit',
    warehouse_id: whId, rows,
  });

  // ── legacy_leaf ──
  console.log('— legacy_leaf —');
  setMode('legacy_leaf');
  setCoa('coa_inventory', '1104');
  const beforeLeg = countLeavesUnder('1104', '110401', '110402');
  let r = await api('POST', '/api/products', {
    name: 'کالای برگ قدیمی', code: 'PL-1', price: 1000, cost: 500, stock: 0, unit: 'عدد',
  });
  ok(r.status === 200 && r.data?.id, 'legacy_leaf: product create succeeds', r.data);
  const leg = q1('SELECT id,coa_code FROM products WHERE id=?', r.data.id);
  ok(!!leg.coa_code && String(leg.coa_code).length === 12 && String(leg.coa_code).startsWith('110401'),
    'legacy_leaf: products.coa_code = 12-digit under 110401', leg);
  ok(countLeavesUnder('1104', '110401', '110402') === beforeLeg + 1, 'legacy_leaf: one new level-4 leaf');

  // ── detail_account ──
  console.log('— detail_account —');
  setMode('detail_account');
  const beforeDet = countLeavesUnder('1104', '110401', '110402', '110403');
  r = await api('POST', '/api/products', {
    name: 'کالای تفصیلی شناور', code: 'PD-1', price: 2000, cost: 800, stock: 0, unit: 'عدد',
  });
  ok(r.status === 200 && r.data?.id, 'detail_account: product create succeeds', r.data);
  const det = q1('SELECT id,coa_code FROM products WHERE id=?', r.data.id);
  ok(det.coa_code == null || String(det.coa_code).trim() === '', 'detail_account: products.coa_code stays NULL', det);
  ok(countLeavesUnder('1104', '110401', '110402', '110403') === beforeDet,
    'detail_account: no new level-4 under 1104 family');
  const da = q1("SELECT * FROM detail_accounts WHERE linked_table='products' AND linked_id=?", det.id);
  ok(!!da && da.code && String(da.code).startsWith('PRD-'), 'detail_account: detail_accounts row linked to product', da);
  const cat = q1('SELECT code FROM detail_categories WHERE id=?', da.detail_category_id);
  ok(cat && cat.code === 'product', 'detail_account: category code=product', cat);
  assignProductTafsili(db, det.id, 'کالای تفصیلی شناور');
  ok(qa("SELECT id FROM detail_accounts WHERE linked_table='products' AND linked_id=?", det.id).length === 1,
    'detail_account: assign is idempotent by product_id');

  const beforeBulk = countLeavesUnder('1104', '110401', '110402');
  const bulkId = insert('products', {
    user_id: adminId, name: 'کالای ورود گروهی', code: 'PB-1', price: 1, cost: 1, stock: 0, unit: 'عدد',
  });
  assignProductTafsili(db, bulkId, 'کالای ورود گروهی');
  ok(!q1('SELECT coa_code FROM products WHERE id=?', bulkId).coa_code, 'detail_account bulk: coa_code NULL');
  ok(countLeavesUnder('1104', '110401', '110402') === beforeBulk, 'detail_account bulk: no new COA leaf');
  ok(!!q1("SELECT id FROM detail_accounts WHERE linked_table='products' AND linked_id=?", bulkId),
    'detail_account bulk: detail_accounts created');

  // ── warehouse-map guard ──
  console.log('— warehouse-map guard —');
  const wh34 = mkWh('انبار ۳۴', 'WH34', { inventory_coa_code: '110402', cogs_coa_code: '5190' });
  setCoa('coa_inventory', '110402');
  warned.length = 0;
  for (const mode of ['legacy_leaf', 'detail_account']) {
    setMode(mode);
    const underBefore = kidsOf('110402');
    const code = allocTafsili(db, 'product', 'نباید زیر 110402');
    ok(code == null, `guard (${mode}): allocTafsili returns null`, code);
    ok(kidsOf('110402') === underBefore, `guard (${mode}): no child under 110402`);
  }
  ok(warned.some((s) => s.includes('E_COA_LEAF_IS_WAREHOUSE_MAP')), 'guard: warn log emitted');
  setMode('legacy_leaf');
  r = await api('POST', '/api/products', {
    name: 'کالا با محافظ', code: 'PG-1', price: 1, cost: 1, stock: 0, unit: 'عدد',
  });
  ok(r.status === 200 && r.data?.id, 'guard: product create still succeeds', r.data);
  ok(!q1('SELECT coa_code FROM products WHERE id=?', r.data.id).coa_code,
    'guard+legacy: coa_code left NULL when alloc blocked');

  setCoa('coa_wip', '1111');
  db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('1111', wh34);
  ok(allocTafsili(db, 'production_order', 'سفارش تست') == null,
    'guard: production_order alloc blocked when coa_wip=warehouse inventory map');
  db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('110402', wh34);
  setCoa('coa_inventory', '1104');

  // ── sale credit = warehouse inventory map ──
  console.log('— sale inventory credit —');
  setFlag('warn');
  setMode('legacy_leaf');
  const whSale = mkWh('انبار فروش', 'WHS', { inventory_coa_code: '110403', cogs_coa_code: '5190' });
  ok(L.inventoryAccountForWarehouse(db, whSale).code === '110403', 'inventoryAccountForWarehouse → warehouse map');
  const prodSale = insert('products', {
    user_id: adminId, name: 'کالای فروش', code: 'PS-1', price: 100000, cost: 50000,
    stock: 0, average_cost_rial: 0, warehouse_id: whSale, unit: 'عدد',
  });
  let srcSeq = 8000;
  L.postInventoryMovement(db, {
    eventType: 'purchase', productId: prodSale, warehouseId: whSale, qty: 10, unitCostRial: 500000,
    sourceType: 'purchase', sourceId: ++srcSeq, date: todayJalali(), createdBy: adminId,
  });
  r = await api('POST', '/api/invoices', saleBody([{ product_id: prodSale, qty: 1, price: 100000 }], whSale));
  ok(r.status === 200 && r.data?.id, 'sale posts', r.data);
  const cogsLines = qa(`
    SELECT jl.account_code, jl.debit_rial, jl.credit_rial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.ref_type='invoice_cogs' AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0
  `, r.data.id);
  ok(cogsLines.some((l) => l.account_code === '110403' && Number(l.credit_rial) > 0),
    'sale COGS credit on warehouse inventory_coa_code=110403', cogsLines);

  // ── legacy postCogsVoucher contract ──
  console.log('— legacy postCogsVoucher contract —');
  const invSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
  const voidSrc = fs.readFileSync(path.join(__dirname, '../lib/void-invoice.js'), 'utf8');
  ok(/LEGACY[\s\S]*feature_cogs_voucher/.test(invSrc) && /function postCogsVoucher/.test(invSrc),
    'invoices.postCogsVoucher kept + documented as legacy behind feature_cogs_voucher');
  ok(/LEGACY[\s\S]*feature_cogs_voucher/.test(voidSrc),
    'void-invoice.postCogsVoucher documented as legacy');
  const amendSrc = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
  ok(!/buildLegacyCogsLines[\s\S]{0,500}p\.coa_code/.test(amendSrc),
    'amend-invoice buildLegacyCogsLines no longer uses products.coa_code');
  const revSrc = fs.readFileSync(path.join(__dirname, '../lib/production/cost-revaluation.js'), 'utf8');
  ok(/inventoryAccountForWarehouse/.test(revSrc) && !/product\.coa_code/.test(revSrc),
    'cost-revaluation uses inventoryAccountForWarehouse, not product.coa_code');

  setMode('detail_account');
  ok(productTafsiliMode(db) === 'detail_account', 'productTafsiliMode reads setting');

  server.close();
  console.warn = realWarn;
  console.log(`\n══ result: ${pass} pass, ${fail} fail ══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.warn = realWarn;
  console.error(e);
  process.exit(1);
});
