'use strict';
/**
 * موجودی اول دوره از کارت کالا + ثبت/ابطال گروهی.
 * Run: node server/scripts/test-opening-bulk.js
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

console.log('\n══ opening stock — product warehouse & bulk ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-bulk-'));
process.env.DB_PATH = path.join(dir, 'opening-bulk.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'opening-bulk-test-secret-at-least-32-characters';
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
  const capture = require('../sync/capture');
  const SE = require('../lib/inventory/shortage-error');
  const { acct } = require('../lib/coa-map');

  const colsCache = new Map();
  const cols = (table) => {
    if (!colsCache.has(table)) colsCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    return colsCache.get(table);
  };
  function insert(table, obj) {
    const keys = Object.keys(obj).filter((k) => cols(table).has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...args) => db.prepare(sql).get(...args);
  const qa = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (table) => Number(q1(`SELECT COUNT(*) AS c FROM ${table}`).c);

  const adminA = insert('users', { name: 'مدیر الف', username: 'bulk_admin_a', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const adminB = insert('users', { name: 'مدیر ب', username: 'bulk_admin_b', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const accounting = insert('users', { name: 'حسابدار', username: 'bulk_accounting', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const sales = insert('users', { name: 'فروشنده', username: 'bulk_sales', password: 'x', role: 'field_sales', active: 1, must_change_password: 0 });
  const wh = insert('warehouses', { name: 'انبار محصول', code: 'BULK-FG', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whBad = insert('warehouses', { name: 'انبار آزمایشی', code: 'BULK-BAD', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  let pseq = 0;
  const product = (name, warehouseId = wh) => insert('products', {
    user_id: adminA, name, code: `BULK-P-${++pseq}`, price: 100000, cost: 0, stock: 0,
    warehouse_id: warehouseId, average_cost_rial: 0, unit: 'عدد',
  });

  const matrixProduct = product('مانتوی ماتریسی');
  const color = insert('product_colors', { name: 'سرمه‌ای', code: 'NAVY', active: 1 });
  const size1 = insert('product_sizes', { name: '۱', code: '1', active: 1 });
  const size2 = insert('product_sizes', { name: '۲', code: '2', active: 1 });
  const v1 = insert('product_variants', { product_id: matrixProduct, color_id: color, size_id: size1, sku: 'BULK-V1', stock: 0, active: 1, is_default: 0 });
  const v2 = insert('product_variants', { product_id: matrixProduct, color_id: color, size_id: size2, sku: 'BULK-V2', stock: 0, active: 0, is_default: 0 });

  const tokens = {};
  for (const [name, id] of Object.entries({ adminA, adminB, accounting, sales })) {
    tokens[name] = issueStaffSession(db, q1('SELECT * FROM users WHERE id=?', id), {
      device_kind: 'test', device_name: `opening-bulk-${name}`, device_fingerprint: `opening-bulk-fp-${name}`,
    }).token;
  }

  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/opening-stock', require('../routes/opening-stock'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, route, body, who = 'adminA') {
    const response = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data;
    try { data = await response.json(); } catch (_) { data = null; }
    return { status: response.status, data };
  }

  try {
    console.log('— product warehouse draft —');
    const before = { docs: count('opening_stock_docs'), ledger: count('inventory_ledger'), je: count('journal_entries') };
    let r = await api('POST', '/api/opening-stock/product-warehouse', {
      product_id: matrixProduct,
      warehouse_id: wh,
      lines: [
        { variant_id: v1, qty: 3, unit_cost_rial: 1000 },
        { variant_id: v2, qty: 2, unit_cost_rial: 1500 },
        { variant_id: 999999, qty: '', unit_cost_rial: 2000 },
      ],
    }, 'adminA');
    ok(r.status === 200 && r.data?.status === 'draft', 'کارت کالا یک پیش‌نویس می‌سازد', r.data);
    const cardDoc = r.data;
    ok(count('opening_stock_docs') === before.docs + 1 && cardDoc?.lines?.length === 2, 'ردیف خالی حذف و فقط یک سند با دو خط ساخته شد', r.data);
    ok(cardDoc?.note === 'موجودی اول دوره از کارت کالا', 'یادداشت پیش‌فرض کارت کالا');
    ok(count('inventory_ledger') === before.ledger && count('journal_entries') === before.je, 'پیش‌نویس هیچ کاردکس یا JE ندارد');
    ok(Number(q1('SELECT active FROM product_variants WHERE id=?', v2).active) === 0, 'واریانت غیرفعال در پیش‌نویس فعال نمی‌شود');

    r = await api('POST', '/api/opening-stock/product-warehouse', {
      product_id: matrixProduct, warehouse_id: wh,
      lines: [{ variant_id: v1, qty: 1, unit_cost_rial: 1000 }],
    }, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_DRAFT_EXISTS' && String(r.data?.error).includes(cardDoc.doc_no),
      'پیش‌نویس تکراری با شماره سند رد می‌شود', r.data);

    r = await api('POST', `/api/opening-stock/${cardDoc.id}/post`, null, 'accounting');
    ok(r.status === 200 && r.data?.status === 'posted' && r.data?.je_id > 0, 'کاربر دیگر سند کارت کالا را ثبت می‌کند', r.data);
    const postedCard = r.data;
    const cardJeCount = Number(q1("SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='opening_stock_doc' AND ref_id=?", cardDoc.id).c);
    ok(cardJeCount === 1, 'برای سند کارت کالا دقیقاً یک JE ساخته شد', cardJeCount);
    const journalLines = qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', postedCard.je_id);
    const debit = journalLines.reduce((sum, x) => sum + Math.round(Number(x.debit_rial) || 0), 0);
    const credit = journalLines.reduce((sum, x) => sum + Math.round(Number(x.credit_rial) || 0), 0);
    const total = 3 * 1000 + 2 * 1500;
    const openingCode = String(acct(db, 'coa_opening_balance').code);
    const openingCredit = journalLines.filter((x) => String(x.account_code) === openingCode)
      .reduce((sum, x) => sum + Math.round(Number(x.credit_rial) || 0), 0);
    ok(debit === credit && debit === total && openingCredit === total, 'JE تراز و بستانکار 3102 برابر ارزش کل است', { debit, credit, openingCredit });
    const cardLedger = qa("SELECT * FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=?", cardDoc.id);
    ok(cardLedger.length === 2 && cardLedger.every((x) => Number(x.je_id) === Number(postedCard.je_id)), 'دو ردیف کاردکس به همان JE وصل‌اند');
    ok(Number(q1('SELECT active FROM product_variants WHERE id=?', v2).active) === 1, 'واریانت غیرفعال هنگام ثبت فعال شد');

    console.log('\n— bulk post —');
    const pA = product('کالای A');
    const pB = product('کالای B');
    const pC = product('کالای C', whBad);
    const create = async (pid, wid, who) => api('POST', '/api/opening-stock', {
      lines: [{ product_id: pid, warehouse_id: wid, qty: 1, unit_cost_rial: 2000 }],
    }, who);
    const docA = (await create(pA, wh, 'adminA')).data;
    const docB = (await create(pB, wh, 'accounting')).data;
    const docC = (await create(pC, whBad, 'accounting')).data;
    db.prepare('UPDATE warehouses SET active=0 WHERE id=?').run(whBad);
    r = await api('POST', '/api/opening-stock/bulk-post', { ids: [docA.id, docB.id, docC.id, docB.id, -1, 'x'] }, 'adminA');
    ok(r.status === 200 && r.data?.total === 3 && r.data?.ok_count === 1 && r.data?.fail_count === 2, 'ثبت گروهی نتیجه جزئی صحیح دارد', r.data);
    const byId = Object.fromEntries((r.data?.results || []).map((x) => [x.id, x]));
    ok(byId[docA.id]?.code === 'E_SOD_MAKER_CHECKER' && byId[docB.id]?.ok === true && byId[docC.id]?.code === 'E_WAREHOUSE_INACTIVE',
      'maker-checker و خطای اعتبارسنجی هر سند مستقل گزارش شد', byId);
    ok(q1('SELECT status FROM opening_stock_docs WHERE id=?', docA.id).status === 'draft'
      && q1('SELECT status FROM opening_stock_docs WHERE id=?', docB.id).status === 'posted'
      && q1('SELECT status FROM opening_stock_docs WHERE id=?', docC.id).status === 'draft', 'فقط سند موفق posted شد');
    ok(!q1("SELECT 1 FROM journal_entries WHERE ref_type='opening_stock_doc' AND ref_id=?", docA.id)
      && !!q1("SELECT 1 FROM journal_entries WHERE ref_type='opening_stock_doc' AND ref_id=?", docB.id)
      && !q1("SELECT 1 FROM journal_entries WHERE ref_type='opening_stock_doc' AND ref_id=?", docC.id), 'سندهای ناموفق JE ندارند');

    const own1 = (await create(product('کالای خودی ۱'), wh, 'adminA')).data;
    const own2 = (await create(product('کالای خودی ۲'), wh, 'adminA')).data;
    r = await api('POST', '/api/opening-stock/bulk-post', { ids: [own1.id, own2.id] }, 'adminA');
    ok(r.status === 200 && r.data?.ok_count === 0 && r.data?.fail_count === 2
      && r.data?.results?.every((x) => x.code === 'E_SOD_MAKER_CHECKER'), 'سازنده هیچ‌یک از اسناد خودش را گروهی تأیید نمی‌کند', r.data);
    ok([own1.id, own2.id].every((id) => q1('SELECT status FROM opening_stock_docs WHERE id=?', id).status === 'draft'), 'همه اسناد خودی draft ماندند');

    r = await api('POST', '/api/opening-stock/bulk-post', { ids: [own1.id] }, 'sales');
    ok(r.status === 403 && r.data?.code === 'E_PERMISSION', 'فروشنده به ثبت گروهی دسترسی ندارد', r.data);
    r = await api('POST', '/api/opening-stock/bulk-void', { ids: [own1.id], reason: 'انصراف' }, 'sales');
    ok(r.status === 403 && r.data?.code === 'E_PERMISSION', 'فروشنده به ابطال گروهی دسترسی ندارد', r.data);

    console.log('\n— bulk void & meta —');
    r = await api('POST', '/api/opening-stock/bulk-void', { ids: [own1.id] }, 'adminB');
    ok(r.status === 400 && r.data?.code === 'E_OPENING_REASON_REQUIRED', 'علت ابطال گروهی الزامی است', r.data);
    r = await api('POST', '/api/opening-stock/bulk-void', { ids: [own1.id, own2.id, docB.id], reason: 'انصراف گروهی' }, 'adminB');
    ok(r.status === 200 && r.data?.ok_count === 2 && r.data?.fail_count === 1, 'دو پیش‌نویس ابطال و سند posted رد شد', r.data);
    const voidById = Object.fromEntries((r.data?.results || []).map((x) => [x.id, x]));
    ok(voidById[docB.id]?.code === 'E_OPENING_BULK_DRAFT_ONLY'
      && q1('SELECT status FROM opening_stock_docs WHERE id=?', own1.id).status === 'void'
      && q1('SELECT status FROM opening_stock_docs WHERE id=?', own2.id).status === 'void'
      && q1('SELECT status FROM opening_stock_docs WHERE id=?', docB.id).status === 'posted', 'ابطال گروهی فقط draft را تغییر داد', voidById);

    r = await api('GET', '/api/opening-stock/meta', null, 'accounting');
    ok(r.status === 200 && r.data?.can_bulk_post === true && r.data?.can_bulk_void === true && r.data?.can_product_warehouse === true,
      'پرچم‌های meta برای حسابداری فعال‌اند', r.data);
    r = await api('GET', '/api/opening-stock/meta', null, 'sales');
    ok(r.status === 200 && r.data?.can_bulk_post === false && r.data?.can_bulk_void === false && r.data?.can_product_warehouse === false,
      'پرچم‌های meta برای فروشنده غیرفعال‌اند', r.data);

    const actions = new Set(qa("SELECT action FROM audit_log WHERE entity='opening_stock_doc'").map((x) => x.action));
    ok(['create', 'post', 'post_failed', 'bulk_post', 'void', 'void_failed', 'bulk_void'].every((x) => actions.has(x)),
      'لاگ ممیزی create/post/void/failed/summary وجود دارد', [...actions]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => {
  console.log(`\nOpening bulk: ${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  try { db.close(); } catch (_) { /* noop */ }
  process.exit(2);
});
