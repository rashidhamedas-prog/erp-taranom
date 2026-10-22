'use strict';
/**
 * v525 — stock adjustment UX + API (تعدیل موجودی در لحظهٔ خطای کسری).
 * Run: node server/scripts/test-stock-adjust-v525.js
 *
 * Isolated temp DB only. Covers:
 *   preview (count + delta, read-only), adjust per reason → counter account by stage,
 *   surplus unit-cost override permission, closed month → value-approval doc,
 *   structured shortage payload (invoice sale, warehouse issue, ledger/movement/production helpers),
 *   R13 void (ledger + variant layer + JE + approval), preview never captured to the sync outbox.
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

console.log('\n══ v525 — stock adjustment ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-adjust-v525-'));
process.env.DB_PATH = path.join(dir, 'adj.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'stock-adjust-v525-test-secret-at-least-32-chars!!';
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
  const L = require('../lib/inventory/ledger');
  const M = require('../lib/inventory/movement');
  const VA = require('../lib/inventory/value-accounts');
  const PL = require('../lib/inventory/period-lock');
  const VAP = require('../lib/inventory/value-approval');
  const SE = require('../lib/inventory/shortage-error');
  const capture = require('../sync/capture');
  const { acct } = require('../lib/coa-map');
  const { todayJalali } = require('../jalali');

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
  const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
  const whQty = (pid, wh) => n3(L.warehouseQty(db, pid, wh));
  const vwsQty = (vid, wh) => n3(q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh)?.qty);
  const jeLines = (jeId) => qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', jeId);
  const jeLive = (jeId) => {
    const h = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', jeId);
    return !!h && !(Number(h.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(h.status || ''));
  };
  const liveNet = (code) => {
    const r = q1(`
      SELECT COALESCE(SUM(jl.debit_rial),0) - COALESCE(SUM(jl.credit_rial),0) AS net
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'') NOT IN ('reversed','void')
    `, code);
    return Math.round(Number(r?.net || 0));
  };

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminId = insert('users', { name: 'مدیر', username: 'adj_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'adj_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const delId = insert('users', { name: 'انباردار', username: 'adj_wh', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const plainId = insert('users', { name: 'فروشنده', username: 'adj_sales', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const storeId = insert('users', { name: 'انباردار فروشگاه', username: 'adj_store', password: 'x', role: 'store_retail', active: 1, must_change_password: 0 });
  for (const a of ['view', 'create', 'edit']) {
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)').run(delId, 'acc_warehouse_ops', a);
  }
  const custA = insert('customers', { user_id: adminId, biz: 'مشتری الف', owner: 'الف', city: 'مشهد', phone: '0511', status: 'active' });
  const whFG = insert('warehouses', { name: 'انبار کالای ساخته', code: 'FG', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whRAW = insert('warehouses', { name: 'انبار مواد', code: 'RAW', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'raw_material', inventory_system: 'perpetual' });
  const whWIP = insert('warehouses', { name: 'انبار در جریان', code: 'WIP', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'wip', inventory_system: 'perpetual' });

  function product(name, whId, extra = {}) {
    return insert('products', Object.assign({
      user_id: adminId, name, code: 'ADJ-' + name, price: 100000, cost: 50000, stock: 0, warehouse_id: whId,
      average_cost_rial: 0, unit: 'عدد',
    }, extra));
  }
  let srcSeq = 9000;
  function receive(pid, wh, qty, unit = 500000) {
    return L.postInventoryMovement(db, {
      eventType: 'purchase', productId: pid, warehouseId: wh, qty, unitCostRial: unit,
      sourceType: 'purchase', sourceId: ++srcSeq, date: todayJalali(), createdBy: adminId,
    });
  }
  const PFG = product('پیراهن', whFG); receive(PFG, whFG, 10);
  const PRAW = product('پارچه', whRAW, { unit: 'متر' }); receive(PRAW, whRAW, 50, 200000);
  const PWIP = product('نیم‌ساخته', whWIP); receive(PWIP, whWIP, 5, 300000);
  // matrix product with one variant in FG
  const PMX = product('مانتو', whFG);
  const colorId = insert('product_colors', { name: 'قرمز', code: 'RED', active: 1 });
  const sizeM = insert('product_sizes', { name: 'M', code: 'M', active: 1 });
  const VMX = insert('product_variants', { product_id: PMX, color_id: colorId, size_id: sizeM, sku: 'MX-RED-M', stock: 0, active: 1, is_default: 0 });
  receive(PMX, whFG, 4, 400000);
  M.postVariantLayer(db, { productId: PMX, variantId: VMX, warehouseId: whFG, qtyDelta: 4, docType: 'seed', docId: 1, userId: adminId, note: 'seed' });

  ok(whQty(PFG, whFG) === 10 && whQty(PRAW, whRAW) === 50 && whQty(PWIP, whWIP) === 5, 'seed: stock received', {
    fg: whQty(PFG, whFG), raw: whQty(PRAW, whRAW), wip: whQty(PWIP, whWIP),
  });

  // ── http harness ──
  const tok = {};
  for (const [k, uid] of [['admin', adminId], ['acct', acctId], ['del', delId], ['plain', plainId], ['store', storeId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'adj-' + k, device_fingerprint: 'adj-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/invoices', require('../routes/invoices'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  app.use('/api/purchases', require('../routes/purchases'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  const count = (t) => q1(`SELECT COUNT(*) AS c FROM ${t}`).c;
  const settingsDump = () => JSON.stringify(qa('SELECT key, value FROM settings ORDER BY key'));

  const cogs = acct(db, 'coa_cogs');
  const overhead = acct(db, 'coa_overhead_control');
  const fgInv = L.inventoryAccountForWarehouse(db, whFG);
  const rawInv = L.inventoryAccountForWarehouse(db, whRAW);

  try {
    // ── 1. preview (read-only) ──
    console.log('\n— preview —');
    const snap = {
      led: count('inventory_ledger'), je: count('journal_entries'), coa: count('chart_of_accounts'),
      outbox: count('sync_outbox'), settings: settingsDump(),
    };
    let r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -2, reason_code: 'shortage' });
    ok(r.status === 200, 'preview delta → 200', r.data);
    ok(r.data?.current_qty === 10 && r.data?.new_qty === 8 && r.data?.delta_qty === -2, 'preview delta: 10 → 8 (Δ −2)', r.data);
    ok(r.data?.unit_cost_rial === 500000 && r.data?.value_rial === -1000000, 'preview delta: live rate 500,000 → value −1,000,000', r.data);
    ok(r.data?.counter_account?.code === cogs.code && r.data?.stage === 'goods', 'preview goods stage → COGS counter', r.data?.counter_account);
    ok(r.data?.inventory_account?.code === fgInv.code, 'preview inventory account = FG account');
    ok(r.data?.period_locked === false && Array.isArray(r.data?.warnings), 'preview: open month, warnings[]');
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'count', qty: 7, reason_code: 'count_correction' });
    ok(r.status === 200 && r.data?.delta_qty === -3 && r.data?.new_qty === 7, 'preview count 7 → Δ −3', r.data);
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PRAW, warehouse_id: whRAW, mode: 'delta', qty: -1, reason_code: 'shortage' });
    ok(r.status === 200 && r.data?.stage === 'materials' && r.data?.counter_account?.name === 'کسری و اضافات انبار',
      'preview materials → «کسری و اضافات انبار» (not created yet)', r.data?.counter_account);
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PWIP, warehouse_id: whWIP, mode: 'delta', qty: 1, reason_code: 'surplus' });
    ok(r.status === 200 && r.data?.stage === 'wip' && r.data?.counter_account?.code === overhead.code, 'preview WIP → overhead control', r.data);
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'count', qty: 10, reason_code: 'other' });
    ok(r.status === 200 && r.data?.delta_qty === 0 && r.data.warnings.length > 0, 'preview no-change → warning, still 200');
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'nope' });
    ok(r.status === 400 && r.data?.code === 'E_ADJUST_REASON', 'preview invalid reason → 400 E_ADJUST_REASON', r.data);
    ok(count('inventory_ledger') === snap.led && count('journal_entries') === snap.je && count('chart_of_accounts') === snap.coa,
      'preview wrote nothing (ledger / JE / COA unchanged)');
    ok(settingsDump() === snap.settings, 'preview wrote no settings');
    ok(count('sync_outbox') === snap.outbox, 'preview not captured to sync_outbox');
    ok(capture.BLOCKLIST.includes('/api/inventory/adjust/preview'), 'capture BLOCKLIST has /api/inventory/adjust/preview');
    ok(capture.tableForPath('/api/inventory/adjust') === 'inventory_ledger', 'adjust itself still maps to inventory_ledger for sync');

    // ── 2. adjust per reason → counter account ──
    console.log('\n— adjust per reason —');
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1 });
    ok(r.status === 400 && r.data?.code === 'E_ADJUST_REASON_REQUIRED', 'new UI (mode set) without reason_code → 400', r.data);
    const fgAdj = [];
    for (const reason of Object.keys(VA.ADJUST_REASONS)) {
      const qty = reason === 'surplus' ? 1 : -1;
      r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty, reason_code: reason, note: 'تست ' + reason });
      const lines = r.data?.je_id ? jeLines(r.data.je_id) : [];
      ok(r.status === 200 && r.data?.counter_account?.code === cogs.code && lines.some((l) => l.account_code === cogs.code)
        && lines.some((l) => l.account_code === fgInv.code), `FG ${reason} → JE inventory ↔ COGS`, { st: r.status, d: r.data, lines });
      ok(!!r.data?.je_no && r.data?.reason_code === reason, `FG ${reason}: je_no + reason echoed`);
      fgAdj.push(r.data);
    }
    ok(whQty(PFG, whFG) === 10 - 5 + 1, 'FG qty after six reasons = 6', whQty(PFG, whFG));
    r = await api('POST', '/api/inventory/adjust', { product_id: PRAW, warehouse_id: whRAW, mode: 'delta', qty: -2, reason_code: 'wastage' });
    const c6118 = q1("SELECT code FROM chart_of_accounts WHERE name='کسری و اضافات انبار'")?.code;
    ok(r.status === 200 && !!c6118 && r.data?.counter_account?.code === c6118 && jeLines(r.data.je_id).some((l) => l.account_code === rawInv.code),
      'RAW wastage → «کسری و اضافات انبار» created + JE', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PWIP, warehouse_id: whWIP, mode: 'delta', qty: -1, reason_code: 'damage' });
    ok(r.status === 200 && r.data?.counter_account?.code === overhead.code, 'WIP damage → overhead control', r.data?.counter_account);
    VA.setReasonAccounts(db, { damage: c6118 });
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1, reason_code: 'damage' });
    ok(r.status === 200 && r.data?.counter_account?.code === c6118, 'reason mapped in settings wins over stage default', r.data?.counter_account);
    VA.setReasonAccounts(db, {});
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'count', qty: 3, reason_code: 'count_correction', date: todayJalali() });
    ok(r.status === 200 && r.data?.delta_qty === -2 && whQty(PFG, whFG) === 3, 'count mode: counted 3 from 5 → Δ −2', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'count', qty: 3, reason_code: 'count_correction' });
    ok(r.status === 400 && r.data?.code === 'E_ADJUST_NO_CHANGE', 'count equal to on-hand → 400 E_ADJUST_NO_CHANGE', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -50, reason_code: 'shortage' });
    ok(r.status >= 400 && Array.isArray(r.data?.shortages) && r.data.shortages[0]?.product_id === PFG,
      'adjust below zero → shortage payload too', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, qty: 1, reason: 'legacy' });
    ok(r.status === 200 && r.data?.posted_counter_account?.code === acct(db, 'coa_adjustment').code, 'legacy call (no mode/reason_code) keeps coa_adjustment', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus', date: '1405-07-01' });
    ok(r.status === 400 && r.data?.code === 'E_ADJUST_DATE', 'non-Jalali date → 400 E_ADJUST_DATE', r.data);
    // matrix product
    r = await api('POST', '/api/inventory/adjust', { product_id: PMX, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus' });
    ok(r.status === 400 && r.data?.code === 'E_VARIANT_REQUIRED', 'matrix product without variant → 400 E_VARIANT_REQUIRED', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PMX, variant_id: VMX, warehouse_id: whFG, mode: 'count', qty: 6, reason_code: 'surplus' });
    ok(r.status === 200 && vwsQty(VMX, whFG) === 6 && whQty(PMX, whFG) === 6, 'matrix variant count 6 → variant×warehouse and warehouse 6', { d: r.data, v: vwsQty(VMX, whFG) });
    const mxAdj = r.data;

    // ── 3. permissions + surplus unit cost ──
    console.log('\n— permissions + unit cost —');
    r = await api('GET', '/api/inventory/adjust/meta', null, 'del');
    ok(r.status === 200 && r.data?.can_adjust === true && r.data?.can_override_cost === false, 'delegate (acc_warehouse_ops) can adjust, cannot override cost', r.data);
    r = await api('GET', '/api/inventory/adjust/meta', null, 'plain');
    ok(r.status === 200 && r.data?.can_adjust === false, 'plain sales user cannot adjust', r.data);
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus' }, 'plain');
    ok(r.status === 403, 'plain sales user preview → 403', r.status);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus', unit_cost_rial: 999000 }, 'del');
    ok(r.status === 403 && r.data?.code === 'E_ADJUST_COST_FORBIDDEN', 'delegate surplus with unit cost override → 403', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus' }, 'del');
    ok(r.status === 200 && Math.round(r.data?.unit_cost_rial) === 500000, 'delegate surplus at live rate → 200', r.data);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus', unit_cost_rial: 700000 }, 'acct');
    ok(r.status === 200 && Math.round(r.data?.unit_cost_rial) === 700000 && Math.round(r.data?.amount_rial) === 700000,
      'accounting surplus with override 700,000 → ledger at 700,000', r.data);
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1, reason_code: 'shortage', unit_cost_rial: 1 }, 'del');
    ok(r.status === 200 && r.data?.cost_overridden === false, 'outbound ignores unit_cost_rial (leaves at live rate)', r.data);
    // storekeeper (no acc_warehouse_ops grant) → 403 everywhere; grant create → 200
    const body1 = { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: 1, reason_code: 'surplus' };
    r = await api('POST', '/api/inventory/adjust', body1, 'store');
    ok(r.status === 403 && r.data?.code === 'E_PERMISSION' && r.data?.error === 'برای تعدیل موجودی دسترسی لازم است', 'storekeeper adjust → 403 E_PERMISSION (Persian)', r.data);
    r = await api('GET', '/api/inventory/adjust/recent', null, 'store');
    ok(r.status === 403, 'storekeeper recent → 403', r.status);
    r = await api('GET', '/api/inventory/adjust/meta', null, 'store');
    ok(r.status === 200 && r.data?.can_adjust === false && r.data?.can_void === false, 'storekeeper meta: can_adjust/can_void false', r.data);
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)').run(storeId, 'acc_warehouse_ops', 'create');
    r = await api('POST', '/api/inventory/adjust', body1, 'store');
    ok(r.status === 200 && !!r.data?.je_no, 'storekeeper with acc_warehouse_ops:create grant → 200', r.data);
    const storeAdj = r.data;
    r = await api('POST', `/api/inventory/ledger/${storeAdj.id}/reverse`, {}, 'store');
    ok(r.status === 403, 'storekeeper without :delete cannot void → 403', r.data);
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)').run(storeId, 'acc_warehouse_ops', 'delete');
    r = await api('POST', `/api/inventory/ledger/${storeAdj.id}/reverse`, {}, 'store');
    ok(r.status === 200, 'storekeeper with :delete grant voids → 200', r.data);
    r = await api('GET', '/api/inventory/adjust/meta', null, 'acct');
    ok(r.data?.can_adjust === true && r.data?.can_void === true, 'accounting role default: can adjust + void', r.data);
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,0)').run(acctId, 'acc_warehouse_ops', 'create');
    r = await api('POST', '/api/inventory/adjust/preview', body1, 'acct');
    ok(r.status === 403, 'accounting with explicit per-user deny → 403 (no automatic pass)', r.status);
    db.prepare('DELETE FROM user_permissions WHERE user_id=? AND resource=? AND action=?').run(acctId, 'acc_warehouse_ops', 'create');
    r = await api('POST', '/api/inventory/adjust/preview', body1, 'acct');
    ok(r.status === 200, 'deny removed → accounting back to 200', r.status);

    // ── 4. closed month → value approval ──
    console.log('\n— closed month —');
    PL.closePeriod(db, '1405/05', { id: adminId }, { reason: 'بستن آزمایشی' });
    r = await api('POST', '/api/inventory/adjust/preview', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1, reason_code: 'shortage', date: '1405/05/20' });
    ok(r.status === 200 && r.data?.period_locked === true && r.data?.value_gated === true
      && r.data.warnings.includes('ماه بسته است؛ اثر ریالی برای تأیید می‌رود'), 'preview in closed month → notice', r.data);
    const clearing = VA.clearingAccount(db);
    const qBefore = whQty(PFG, whFG);
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1, reason_code: 'shortage', date: '1405/05/20' });
    const closedA = r.data;
    ok(r.status === 200 && closedA?.value_approval?.status === 'pending', 'closed-month adjust → approval doc pending', r.data);
    ok(closedA?.posted_counter_account?.code === clearing.code && jeLines(closedA.je_id).some((l) => l.account_code === clearing.code),
      'closed-month JE counter side = clearing account', closedA?.posted_counter_account);
    ok(closedA?.counter_account?.code === cogs.code, 'suggested reason counter still reported (COGS)');
    const lineA = q1('SELECT * FROM inventory_value_approval_lines WHERE approval_id=?', closedA.value_approval.id);
    ok(lineA?.counter_code === cogs.code && lineA?.ledger_ref_id === closedA.id, 'approval line stores counter_code + ledger_ref_id', lineA);
    ok(whQty(PFG, whFG) === qBefore - 1, 'closed-month qty still moves');
    r = await api('POST', '/api/inventory/adjust', { product_id: PFG, warehouse_id: whFG, mode: 'delta', qty: -1, reason_code: 'shortage', date: '1405/05/21' });
    const closedB = r.data;
    ok(r.status === 200 && closedB?.value_approval?.id, 'second closed-month adjust → second approval doc');
    VAP.approve(db, closedB.value_approval.id, { id: adminId, role: 'admin' }, { note: 'ok' });
    ok(q1('SELECT status FROM inventory_value_approvals WHERE id=?', closedB.value_approval.id)?.status === 'approved', 'approval B approved');
    const decB = q1('SELECT decision_je_id FROM inventory_value_approvals WHERE id=?', closedB.value_approval.id)?.decision_je_id;
    const dlB = decB ? jeLines(decB) : [];
    const amtB = Math.round(Math.abs(Number(closedB.amount_rial) || 0));
    ok(dlB.some((l) => l.account_code === cogs.code && Math.round(l.debit_rial) === amtB)
      && dlB.some((l) => l.account_code === clearing.code && Math.round(l.credit_rial) === amtB)
      && !dlB.some((l) => l.account_code === fgInv.code), 'approve FG shortage → Dr COGS (reason counter) / Cr clearing, no inventory row', { dlB, amtB });
    // materials: counter = «کسری و اضافات انبار», NOT COGS
    r = await api('POST', '/api/inventory/adjust', { product_id: PRAW, warehouse_id: whRAW, mode: 'delta', qty: -1, reason_code: 'wastage', date: '1405/05/22' });
    const closedC = r.data;
    ok(r.status === 200 && closedC?.value_approval?.id && closedC?.counter_account?.code === c6118, 'closed-month RAW wastage → approval, suggested 6118', r.data);
    const clr0 = liveNet(clearing.code);
    VAP.approve(db, closedC.value_approval.id, { id: adminId, role: 'admin' }, {});
    const decC = q1('SELECT decision_je_id FROM inventory_value_approvals WHERE id=?', closedC.value_approval.id)?.decision_je_id;
    const dlC = decC ? jeLines(decC) : [];
    const amtC = Math.round(Math.abs(Number(closedC.amount_rial) || 0));
    ok(dlC.some((l) => l.account_code === c6118 && Math.round(l.debit_rial) === amtC) && !dlC.some((l) => l.account_code === cogs.code)
      && !dlC.some((l) => l.account_code === rawInv.code), 'approve RAW wastage → Dr 6118 whole amount (no COGS, no inventory)', { dlC, amtC });
    ok(clr0 - liveNet(clearing.code) === amtC, 'approve clears the parked clearing balance (shortage: Cr clearing)', { clr0, now: liveNet(clearing.code) });
    VAP.reopen(db, closedC.value_approval.id, { id: adminId, role: 'admin' }, { reason: 'تست' });
    ok(q1('SELECT status FROM inventory_value_approvals WHERE id=?', closedC.value_approval.id)?.status === 'pending' && !jeLive(decC)
      && liveNet(clearing.code) === clr0, 'reopen reverses the counter-account decision');
    // surplus (inbound) in closed month on WIP → reject goes to price variance, not the overhead counter
    r = await api('POST', '/api/inventory/adjust', { product_id: PWIP, warehouse_id: whWIP, mode: 'delta', qty: 1, reason_code: 'surplus', date: '1405/05/22' });
    const closedD = r.data;
    ok(r.status === 200 && closedD?.value_approval?.id && closedD?.counter_account?.code === overhead.code, 'closed-month WIP surplus → approval, suggested overhead', r.data);
    VAP.reject(db, closedD.value_approval.id, { id: adminId, role: 'admin' }, { note: 'رد' });
    const decD = q1('SELECT decision_je_id FROM inventory_value_approvals WHERE id=?', closedD.value_approval.id)?.decision_je_id;
    const dlD = decD ? jeLines(decD) : [];
    ok(dlD.length > 0 && !dlD.some((l) => l.account_code === overhead.code) && dlD.some((l) => l.account_code === clearing.code),
      'reject → price variance (counter account untouched)', dlD);

    // ── 5. R13 void ──
    console.log('\n— void (R13) —');
    let rc = await api('GET', '/api/inventory/adjust/recent?limit=100');
    ok(rc.status === 200 && rc.data.rows.some((x) => x.id === closedA.id && x.value_approval?.status === 'pending'), 'recent list shows adjustments + approval status');
    const qv = whQty(PFG, whFG);
    r = await api('POST', `/api/inventory/ledger/${closedA.id}/reverse`, { note: 'ابطال تست' });
    ok(r.status === 200, 'void closed-month adjust A → 200', r.data);
    ok(whQty(PFG, whFG) === qv + 1, 'void A restores qty');
    ok(!jeLive(closedA.je_id), 'void A reverses the JE');
    ok(q1('SELECT status FROM inventory_value_approvals WHERE id=?', closedA.value_approval.id)?.status === 'cancelled', 'void A cancels the approval doc');
    r = await api('POST', `/api/inventory/ledger/${closedB.id}/reverse`, {});
    ok(r.status === 200 && !jeLive(closedB.je_id), 'void approved adjust B → JE reversed', r.data);
    ok(q1('SELECT status FROM inventory_value_approvals WHERE id=?', closedB.value_approval.id)?.status === 'cancelled', 'void B reopens + cancels the approved doc');
    r = await api('POST', `/api/inventory/ledger/${closedC.id}/reverse`, {}, 'del');
    ok(r.status === 403 && r.data?.code === 'E_PERMISSION', 'delegate without acc_warehouse_ops:delete cannot void → 403', r.data);
    r = await api('POST', `/api/inventory/ledger/${closedC.id}/reverse`, {}, 'acct');
    ok(r.status === 200, 'accounting (role default delete) voids C', r.data);
    r = await api('POST', `/api/inventory/ledger/${closedD.id}/reverse`, {});
    ok(r.status === 200 && q1('SELECT status FROM inventory_value_approvals WHERE id=?', closedD.value_approval.id)?.status === 'cancelled',
      'void rejected D → decision undone + cancelled', r.data);
    ok(liveNet(clearing.code) === 0, 'clearing account nets to zero after both voids', liveNet(clearing.code));
    const qm = vwsQty(VMX, whFG);
    r = await api('POST', `/api/inventory/ledger/${mxAdj.id}/reverse`, {});
    ok(r.status === 200 && vwsQty(VMX, whFG) === qm - 2 && whQty(PMX, whFG) === 4, 'void variant adjust restores variant×warehouse (6 → 4)', { v: vwsQty(VMX, whFG), w: whQty(PMX, whFG) });
    const one = fgAdj[0];
    r = await api('POST', `/api/inventory/ledger/${one.id}/reverse`, {});
    ok(r.status === 200 && !jeLive(one.je_id), 'void open-month adjust → JE reversed');
    r = await api('POST', `/api/inventory/ledger/${one.id}/reverse`, {});
    ok(r.status >= 400, 'second void of the same row is rejected', r.data);
    rc = await api('GET', '/api/inventory/adjust/recent?limit=100');
    ok(rc.data.rows.some((x) => x.id === one.id && x.status === 'reversed'), 'recent list marks the voided row', rc.data.rows.find((x) => x.id === one.id));

    // ── 6. structured shortage payloads ──
    console.log('\n— shortage payload —');
    const shapeOk = (s) => s && ['product_id', 'product_name', 'warehouse_id', 'warehouse_name', 'available_qty', 'required_qty', 'shortfall_qty', 'unit']
      .every((k) => Object.prototype.hasOwnProperty.call(s, k));
    const fgNow = whQty(PFG, whFG);
    r = await api('POST', '/api/invoices', {
      cust_id: custA, type: 'normal', date: todayJalali(), pay_type: 'credit', warehouse_id: whFG,
      rows: [{ product_id: PFG, qty: fgNow + 5, price: 100000 }],
    });
    const s0 = r.data?.shortages?.[0];
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'invoice sale over stock → 409 E_ATP_INSUFFICIENT (unchanged)', r.data);
    ok(shapeOk(s0) && s0.product_id === PFG && s0.warehouse_id === whFG && s0.shortfall_qty === 5 && s0.product_name === 'پیراهن'
      && s0.warehouse_name === 'انبار کالای ساخته', 'invoice shortage: uniform shortages[] (shortfall 5)', s0);
    ok(Array.isArray(r.data?.atp_shortages), 'invoice keeps legacy atp_shortages');

    r = await api('POST', '/api/warehouses/moves/issue', { warehouse_id: whRAW, product_id: PRAW, qty: 500, date: todayJalali() });
    const s1 = r.data?.shortages?.[0];
    ok(r.status === 400 && /کافی نیست/.test(r.data?.error || ''), 'warehouse issue over stock → 400, Persian message unchanged', r.data);
    ok(r.data?.code === 'E_INSUFFICIENT_STOCK' && shapeOk(s1) && s1.product_id === PRAW && s1.warehouse_id === whRAW
      && s1.required_qty === 500 && s1.available_qty === whQty(PRAW, whRAW) && s1.unit === 'متر', 'warehouse issue: code + shortages[] filled', r.data);

    let e = null;
    try { L.postInventoryMovement(db, { eventType: 'issue', productId: PRAW, warehouseId: whRAW, qty: -999, sourceType: 'test', date: todayJalali() }); } catch (x) { e = x; }
    ok(e && e.code === 'E_NEGATIVE_STOCK' && shapeOk(e.shortages?.[0]) && e.shortages[0].shortfall_qty === n3(999 - whQty(PRAW, whRAW)),
      'ledger issue: E_NEGATIVE_STOCK carries shortages[]', e && { code: e.code, s: e.shortages });
    e = null;
    try {
      M.postVariantLayer(db, { productId: PMX, variantId: VMX, warehouseId: whFG, qtyDelta: -99, docType: 'test', docId: 1, userId: adminId, allowNegative: false });
    } catch (x) { e = x; }
    ok(e && e.code === 'E_NEGATIVE_STOCK' && e.shortages?.[0]?.variant_id === VMX && !!e.shortages[0].variant_label,
      'variant layer issue: shortages[] with variant label', e && { code: e.code, s: e.shortages });
    e = null;
    try {
      require('../lib/production/costing').issueFromStock(db, { productId: PRAW, warehouseId: whRAW, qty: 9999, userId: adminId, sourceType: 'test', sourceId: 1, date: todayJalali() });
    } catch (x) { e = x; }
    const ps = e ? SE.fromError(db, e) : [];
    ok(e && e.code === 'E_NEGATIVE_STOCK' && shapeOk(ps[0]) && ps[0].product_id === PRAW, 'material issue (production) error → fromError() gives shortages[]', ps);
    ok(e && Array.isArray(e.shortages) && e.shortages[0]?.required_qty === 9999 && e.shortages[0]?.warehouse_id === whRAW && !e.shortages[0].inferred,
      'production issueFromStock attaches exact shortages[] (not inferred)', e && e.shortages);
    ok(!s1?.inferred, 'warehouse issue shortage is exact (pre-check helper), not inferred', s1);
    // production shortage through the response hook (route sends only {error, code})
    {
      const papp = express();
      papp.use(express.json());
      papp.use('/api', SE.requestScope);
      papp.post('/api/prod-issue', (req, res) => {
        try {
          require('../lib/production/costing').issueFromStock(db, { productId: PRAW, warehouseId: whRAW, qty: 7777, userId: adminId, sourceType: 'test', sourceId: 2, date: todayJalali() });
          res.json({ ok: true });
        } catch (x) { res.status(x.status || 409).json({ error: x.message, code: x.code }); }
      });
      const ps2 = http.createServer(papp);
      await new Promise((rr) => ps2.listen(0, '127.0.0.1', rr));
      const pr = await fetch(`http://127.0.0.1:${ps2.address().port}/api/prod-issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const pj = await pr.json();
      ps2.close();
      ok(pr.status === 409 && pj.code === 'E_NEGATIVE_STOCK' && pj.shortages?.[0]?.required_qty === 7777 && pj.shortages[0].product_id === PRAW,
        'production route body gets exact shortages[] via request scope', pj);
    }

    // ── 7. closed month: purchase return parks the pool difference ──
    console.log('\n— purchase return (closed month) —');
    const PRET = product('شلوار', whFG); receive(PRET, whFG, 10, 500000);
    const supId = insert('suppliers', { name: 'تأمین‌کننده الف', phone: '0512', user_id: adminId });
    const avgBefore = Math.round(Number(q1('SELECT average_cost_rial FROM products WHERE id=?', PRET)?.average_cost_rial) || 0);
    const inv0 = liveNet(fgInv.code);
    const clr1 = liveNet(clearing.code);
    r = await api('POST', '/api/purchases/returns', {
      supplier_id: supId, date: '1405/05/24', rows: [{ product_id: PRET, qty: 2, price: 800000, warehouse_id: whFG }],
    });
    const retId = r.data?.id;
    ok(r.status === 200 && retId, 'closed-month purchase return posts (qty normal)', r.data);
    ok(whQty(PRET, whFG) === 8, 'purchase return: qty 10 → 8', whQty(PRET, whFG));
    const retLed = q1("SELECT * FROM inventory_ledger WHERE source_type='purchase_return' AND source_id=? AND reversed_of IS NULL", retId);
    ok(Math.round(retLed?.amount_rial) === 1000000, 'return leaves at pool rate (2 × 500,000), not doc cost 1,600,000', retLed);
    ok(Math.round(Number(q1('SELECT average_cost_rial FROM products WHERE id=?', PRET)?.average_cost_rial) || 0) === avgBefore, 'pool average unchanged by the back-dated return');
    const retDocs = qa("SELECT * FROM inventory_value_approvals WHERE source_type='receipt:purchase_return' AND source_id=?", retId);
    const retLines = retDocs[0] ? qa('SELECT * FROM inventory_value_approval_lines WHERE approval_id=?', retDocs[0].id) : [];
    ok(retDocs.length === 1 && retDocs[0].status === 'pending' && retDocs[0].reason === 'closed_period' && retLines.length === 1
      && Math.round(retLines[0].delta_rial) === -600000, 'ONE closed_period approval doc per return (delta −600,000)', { retDocs, retLines });
    ok(liveNet(fgInv.code) - inv0 === -1000000, 'GL inventory moved by the pool amount (return JE + parking JE)', liveNet(fgInv.code) - inv0);
    r = await api('DELETE', `/api/purchases/returns/${retId}`);
    ok(r.status === 200, 'void purchase return → 200', r.data);
    ok(whQty(PRET, whFG) === 10 && q1('SELECT status FROM inventory_value_approvals WHERE id=?', retDocs[0]?.id)?.status === 'cancelled',
      'void restores qty + cancels the approval doc');
    ok(liveNet(fgInv.code) === inv0 && liveNet(clearing.code) === clr1, 'void: inventory GL + clearing back to before', { inv: liveNet(fgInv.code) - inv0, clr: liveNet(clearing.code) - clr1 });
    // open month → no approval
    r = await api('POST', '/api/purchases/returns', { supplier_id: supId, date: todayJalali(), rows: [{ product_id: PRET, qty: 1, price: 800000, warehouse_id: whFG }] });
    ok(r.status === 200 && qa("SELECT id FROM inventory_value_approvals WHERE source_type='receipt:purchase_return' AND source_id=?", r.data?.id).length === 0,
      'open-month purchase return → no approval doc', r.data);

    // ── 8. portal transfer_in: one approval doc per parameter ──
    console.log('\n— portal transfer (closed month) —');
    const whPA = insert('warehouses', { name: 'بخش برش', code: 'PA', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
    const whPB = insert('warehouses', { name: 'بخش دوخت', code: 'PB', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
    db.prepare("UPDATE warehouses SET valuation_level='warehouse' WHERE id IN (?,?)").run(whPA, whPB);
    const PP1 = product('قطعه۱', whPA); const PP2 = product('قطعه۲', whPA);
    for (const p of [PP1, PP2]) { receive(p, whPA, 10, 500000); receive(p, whPB, 10, 300000); }
    const portal = require('../routes/portal');
    db.transaction(() => {
      portal.transferBetweenWarehouses(db, { productId: PP1, fromWh: whPA, toWh: whPB, qty: 2, userId: adminId, date: '1405/05/25', paramId: 77, paramLabel: 'P-77' });
      portal.transferBetweenWarehouses(db, { productId: PP2, fromWh: whPA, toWh: whPB, qty: 3, userId: adminId, date: '1405/05/25', paramId: 77, paramLabel: 'P-77' });
    })();
    const pd = qa("SELECT * FROM inventory_value_approvals WHERE source_type='portal_param' AND source_id=77");
    const pl = pd[0] ? qa('SELECT * FROM inventory_value_approval_lines WHERE approval_id=?', pd[0].id) : [];
    ok(pd.length === 1 && pd[0].reason === 'closed_period' && pl.length === 2, 'portal: two closed-month transfers of one parameter → ONE approval doc, 2 lines', { pd, n: pl.length });
    ok(Math.round(pd[0]?.total_delta_rial) === 2 * 200000 + 3 * 200000, 'portal doc total = Σ(source − dest rate) × qty (1,000,000)', pd[0]?.total_delta_rial);
    db.transaction(() => {
      portal.transferBetweenWarehouses(db, { productId: PP1, fromWh: whPA, toWh: whPB, qty: 1, userId: adminId, date: '1405/05/25', paramId: 78, paramLabel: 'P-78' });
    })();
    ok(qa("SELECT id FROM inventory_value_approvals WHERE source_type='portal_param' AND source_id=78").length === 1, 'another parameter → its own doc');
    db.transaction(() => {
      portal.transferBetweenWarehouses(db, { productId: PP1, fromWh: whPA, toWh: whPB, qty: 1, userId: adminId, date: todayJalali(), paramId: 79 });
    })();
    ok(qa("SELECT id FROM inventory_value_approvals WHERE source_type='portal_param' AND source_id=79").length === 0, 'open-month portal transfer → no doc');
    ok(SE.isShortageBody({ error: 'موجودی پارچه کافی نیست (موجود: 3)' }) && !SE.isShortageBody({ error: 'اعتبار کافی نیست (موجود: 3)' }),
      'shortage body detection: stock message yes, credit message no');
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { require('../lib/auth-sessions').closeSessionStore?.(); } catch (_) { /* ignore */ }
  try { db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
