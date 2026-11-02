'use strict';
/**
 * P10-fix — RBAC `sales_amount:view` (مشاهدهٔ مبلغ فروش) for the quick item movement report.
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-p10-sales-amount-perm.js
 *
 * Decision (Hamed): cashier sees sales amounts; purchase amount / cost / profit stay behind
 * cost_visibility:view. daily-pnl unchanged (cost_visibility only).
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ P10-fix: sales_amount:view ══\n');

(async () => {
  const { db, cleanup } = freshDb();
  const {
    RESOURCES, CLOSED_DEFAULT_NONE, fillRoleDefaults, hasPermission, saveRoleOverrides,
  } = require('../lib/rbac');
  const CV = require('../lib/cost-visibility');
  const { buildQuickItemMovement } = require('../lib/reports-p10');

  // ── 1) RBAC matrix ──
  console.log('— 1) RBAC matrix defaults —');
  // Append-only: only resources added later (FR-POS-DRAFTS) may follow sales_amount.
  const LATER_RESOURCES = ['price_override', 'credit_override', 'opening_stock'];
  ok('RESOURCES: sales_amount appended (only later resources after it)',
    RESOURCES.indexOf('sales_amount') >= 0
      && RESOURCES.slice(RESOURCES.indexOf('sales_amount') + 1).every((r) => LATER_RESOURCES.includes(r)));
  ok('cost_visibility / qty_receipt keep their position before sales_amount',
    RESOURCES.indexOf('cost_visibility') < RESOURCES.indexOf('qty_receipt') && RESOURCES.indexOf('qty_receipt') < RESOURCES.indexOf('sales_amount'));
  ok('sales_amount closed by default', CLOSED_DEFAULT_NONE.has('sales_amount'));
  const granted = ['admin', 'accounting', 'store_retail'];
  const denied = ['sales_manager', 'field_sales', 'inside_sales', 'distribution_office', 'production_manager',
    'production_operator', 'unit_manager', 'department_manager'];
  for (const r of granted) ok(`${r} → sales_amount:view`, fillRoleDefaults(r, db).sales_amount.view === true);
  for (const r of denied) ok(`${r} → no sales_amount:view`, fillRoleDefaults(r, db).sales_amount.view === false);
  ok('store_retail sales_amount only view (no create/edit/export)',
    ['create', 'edit', 'delete', 'approve', 'export'].every((a) => fillRoleDefaults('store_retail', db).sales_amount[a] === false));
  ok('store_retail still has NO cost_visibility', fillRoleDefaults('store_retail', db).cost_visibility.view === false);
  ok('accounting keeps cost_visibility', fillRoleDefaults('accounting', db).cost_visibility.view === true);
  ok('unknown role falls back (field_sales) → no sales_amount', fillRoleDefaults('nope_role', db).sales_amount.view === false);

  for (const [id, username, role] of [
    [301, 'sa_acc', 'accounting'], [302, 'sa_cashier', 'store_retail'], [303, 'sa_fs', 'field_sales'],
    [304, 'sa_fs_grant', 'field_sales'], [305, 'sa_cashier_deny', 'store_retail'], [306, 'sa_sm', 'sales_manager'],
  ]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)').run(id, username, 'x', username, role);
  }
  db.prepare('UPDATE users SET must_change_password=0').run();
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (304,'sales_amount','view',1)").run();
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (305,'sales_amount','view',0)").run();
  ok('per-user grant (field_sales 304) → sales_amount:view', hasPermission(db, { id: 304, role: 'field_sales' }, 'sales_amount', 'view'));
  ok('per-user deny (cashier 305) → no sales_amount:view', !hasPermission(db, { id: 305, role: 'store_retail' }, 'sales_amount', 'view'));
  saveRoleOverrides(db, { sales_manager: { sales_amount: { view: true } } });
  ok('role override (role_permission_defaults) grants sales_manager', hasPermission(db, { id: 306, role: 'sales_manager' }, 'sales_amount', 'view'));
  saveRoleOverrides(db, {});
  ok('role override removed → sales_manager back to default (no)', !hasPermission(db, { id: 306, role: 'sales_manager' }, 'sales_amount', 'view'));

  // ── 2) strip middleware key classification ──
  console.log('— 2) cost strip key patterns —');
  const reportsScope = CV.scopeFor('/api/reports/quick-item-movement');
  for (const k of ['sales_amount_rial', 'returns_amount_rial', 'net_sales_amount_rial', 'sales_amounts_visible', 'amounts_visible']) {
    ok(`${k} is NOT a cost key`, !CV.isCostKey(k, reportsScope));
  }
  for (const k of ['purchase_amount_rial', 'purchase_returns_amount_rial', 'purchase_price', 'gross_profit_rial', 'cogs_rial', 'gross_margin_pct']) {
    ok(`${k} IS a cost key`, CV.isCostKey(k, reportsScope));
  }

  // ── fixture ──
  const D = '1405/08/12';
  const adminId = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || { id: 1 }).id;
  const W1 = db.prepare("INSERT INTO warehouses (name) VALUES ('انبار SA-1')").run().lastInsertRowid;
  const pA = db.prepare("INSERT INTO products (user_id, code, name, price) VALUES (?, 'SA-A', 'مانتو SA', 1000)").run(adminId).lastInsertRowid;
  const cust = db.prepare("INSERT INTO customers (user_id, biz) VALUES (?, 'مشتری SA')").run(adminId).lastInsertRowid;
  const I1 = db.prepare(`INSERT INTO invoices (user_id, cust_id, num, type, date, rows, subtotal, final, vat_amount, warehouse_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(adminId, cust, 'SA-1', 'normal', D,
    JSON.stringify([{ product_id: pA, name: 'مانتو SA', qty: 4, price: 1000, sum: 4000, warehouse_id: W1 }]), 4000, 4000, 0, W1).lastInsertRowid;
  const srId = db.prepare('INSERT INTO sales_returns (user_id, cust_id, invoice_id, date, rows, amount) VALUES (?,?,?,?,?,?)')
    .run(adminId, cust, I1, D, JSON.stringify([{ product_id: pA, qty: 1, price: 1000, sum: 1000, warehouse_id: W1 }]), 1000).lastInsertRowid;
  db.prepare("UPDATE sales_returns SET status='posted' WHERE id=?").run(srId);
  db.prepare("INSERT INTO suppliers (id, name) VALUES (9301, 'تأمین SA')").run();
  db.prepare(`INSERT INTO purchase_invoices (user_id, supplier_id, num, date, rows, subtotal, final, warehouse_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(adminId, 9301, 'SA-PUR-1', D,
    JSON.stringify([{ product_id: pA, name: 'مانتو SA', qty: 10, price: 450, sum: 4500 }]), 4500, 4500, W1);

  // ── 3) lib flags ──
  console.log('— 3) lib flags —');
  const ls = buildQuickItemMovement(db, { date: D }, { showSalesAmounts: true });
  ok('showSalesAmounts → sales keys present, purchase keys absent',
    ls.totals.sales_amount_rial === 4000 && ls.totals.returns_amount_rial === 1000 && ls.totals.net_sales_amount_rial === 3000
    && !/purchase_(returns_)?amount_rial/.test(JSON.stringify(ls)) && ls.sales_amounts_visible === true && ls.purchase_amounts_visible === false);
  const lf = buildQuickItemMovement(db, { date: D }, { showAmounts: true });
  ok('showAmounts (cost) → sales + purchase keys', lf.totals.net_sales_amount_rial === 3000 && lf.totals.purchase_amount_rial === 4500 && lf.purchase_amounts_visible === true);
  const ln = buildQuickItemMovement(db, { date: D }, {});
  ok('neither → no *_amount_rial keys, quantities intact', !/_amount_rial/.test(JSON.stringify(ln)) && ln.amounts_visible === false && ln.totals.sold_qty === 4 && ln.totals.purchased_qty === 10);

  // ── 4) HTTP through the real strip middleware ──
  console.log('— 4) HTTP + RBAC —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'sa-' + tag, device_fingerprint: 'sa-fp-' + tag,
  }).token;
  const tok = {
    admin: tokenFor(adminId, 'admin'), acc: tokenFor(301, 'acc'), cashier: tokenFor(302, 'cashier'),
    fs: tokenFor(303, 'fs'), fsGrant: tokenFor(304, 'fsg'), cashierDeny: tokenFor(305, 'cd'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/reports', CV.costVisibilityStrip());
  app.use('/api/reports', require('../routes/reports'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const get = async (p2, who) => {
    const res = await fetch(BASE + p2, { headers: { Authorization: 'Bearer ' + tok[who] } });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json, redacted: res.headers.get('x-cost-redacted') };
  };
  const COST_RE = /purchase_(returns_)?amount_rial|cost|profit|margin|cogs/i;
  try {
    const qim = `/api/reports/quick-item-movement?from=${encodeURIComponent(D)}&to=${encodeURIComponent(D)}`;
    const pnl = `/api/reports/daily-pnl?date=${encodeURIComponent(D)}`;

    const c = await get(qim, 'cashier');
    ok('cashier → 200', c.status === 200, c.status);
    eq('cashier sees sales amount (gross)', c.json.totals.sales_amount_rial, 4000);
    eq('cashier sees sales returns amount', c.json.totals.returns_amount_rial, 1000);
    eq('cashier sees net sales amount', c.json.totals.net_sales_amount_rial, 3000);
    ok('cashier row has sales_amount_rial (not stripped by P4 middleware)', c.json.rows[0].sales_amount_rial === 4000);
    ok('cashier gets NO purchase/cost/profit/margin keys', !COST_RE.test(JSON.stringify(c.json)));
    ok('cashier flags: sales visible, purchase hidden', c.json.sales_amounts_visible === true && c.json.purchase_amounts_visible === false);
    eq('cashier still sees purchase quantity', c.json.totals.purchased_qty, 10);
    const cp = await get(pnl, 'cashier');
    ok('cashier daily-pnl → 403 E_COST_VISIBILITY (unchanged)', cp.status === 403 && cp.json.code === 'E_COST_VISIBILITY', cp.status);

    const f = await get(qim, 'fs');
    ok('field_sales (neither perm) → quantities only', f.status === 200 && f.json.amounts_visible === false
      && !/_amount_rial/.test(JSON.stringify(f.json)) && f.json.totals.sold_qty === 4 && f.json.totals.net_sold_qty === 3);
    const cd = await get(qim, 'cashierDeny');
    ok('cashier with per-user sales_amount deny → quantities only', cd.status === 200 && !/_amount_rial/.test(JSON.stringify(cd.json)));
    const fg = await get(qim, 'fsGrant');
    ok('field_sales with per-user sales_amount grant → sales amounts, no purchase',
      fg.json.totals.net_sales_amount_rial === 3000 && !COST_RE.test(JSON.stringify(fg.json)));
    const fgp = await get(pnl, 'fsGrant');
    ok('sales_amount grant does NOT open daily-pnl', fgp.status === 403);

    const a = await get(qim, 'acc');
    ok('accounting sees sales + purchase amounts', a.status === 200 && a.json.totals.net_sales_amount_rial === 3000
      && a.json.totals.purchase_amount_rial === 4500 && a.json.purchase_amounts_visible === true && !a.redacted);
    const ap = await get(pnl, 'acc');
    ok('accounting daily-pnl → 200', ap.status === 200 && ap.json.totals.net_sales_rial === 3000);
    const ad = await get(qim, 'admin');
    ok('admin sees everything', ad.json.totals.purchase_amount_rial === 4500 && ad.json.totals.sales_amount_rial === 4000);
  } finally {
    await new Promise((rs) => server.close(rs));
  }

  // ── 5) wiring ──
  console.log('— 5) wiring —');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok('UI: RBAC label «مشاهدهٔ مبلغ فروش»', appJs.includes("sales_amount:'مشاهدهٔ مبلغ فروش'"));
  ok('UI: sales columns gated by canPerm(sales_amount) or cost', appJs.includes("canPerm('sales_amount','view')") && /function qimCanSalesAmt\(\)/.test(appJs));
  ok('UI: CSV uses separate sales/purchase gates', /amtSale\?\['مبلغ فروش \(ریال\)'/.test(appJs) && /amtPur\?\['مبلغ خرید \(ریال\)'/.test(appJs));
  ok('help updated (P10-fix in admin + sales guides)', (appJs.match(/v\w+ — P10-fix/g) || []).length >= 2);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  ok("route passes showSalesAmounts from canDo(sales_amount,'view')", route.includes("showSalesAmounts: canDo(req.user, 'sales_amount', 'view', db)"));

  cleanup();
  summary('P10-fix sales_amount');
})().catch((e) => { console.error(e); process.exit(1); });
