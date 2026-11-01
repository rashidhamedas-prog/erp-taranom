'use strict';
/**
 * P4 — cost_visibility:view (field-level RBAC). Draft test, offline.
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-cost-visibility-p4.js
 *
 * Covers: matrix defaults, recursive strip + key snapshot, safe keys kept,
 * HTTP via real routers (products / kardex / inventory kardex / adv-reports / store),
 * accounting keeps cost, per-user revoke, excel export rows, api_v1 scope, wiring gates.
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');
const { hasPermission, fillRoleDefaults, RESOURCES, CLOSED_DEFAULT_NONE } = require('../lib/rbac');
const CV = require('../lib/cost-visibility');

console.log('\n══ P4 cost_visibility RBAC ══\n');

(async () => {
  const { db, cleanup } = freshDb();

  // ── 1) matrix ─────────────────────────────────────────────────────────────
  console.log('— 1) matrix —');
  ok('RESOURCES has cost_visibility (append-only tail group)', RESOURCES.includes('cost_visibility'));
  ok('closed-by-default set has cost_visibility', CLOSED_DEFAULT_NONE.has('cost_visibility'));
  const U = (id, role) => ({ id, role });
  for (const [id, username, role] of [
    [101, 'cv_acc', 'accounting'], [102, 'cv_cashier', 'store_retail'], [103, 'cv_fs', 'field_sales'],
    [104, 'cv_sm', 'sales_manager'], [105, 'cv_pm', 'production_manager'], [106, 'cv_acc2', 'accounting'],
  ]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)')
      .run(id, username, 'x', username, role);
  }
  const adminRow = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const adminId = adminRow ? adminRow.id : 1;
  db.prepare('UPDATE users SET must_change_password=0').run();
  ok('admin has cost_visibility:view', hasPermission(db, U(adminId, 'admin'), 'cost_visibility', 'view'));
  ok('accounting has cost_visibility:view', hasPermission(db, U(101, 'accounting'), 'cost_visibility', 'view'));
  ok('cashier (store_retail) has NO cost_visibility', !hasPermission(db, U(102, 'store_retail'), 'cost_visibility', 'view'));
  ok('field_sales has NO cost_visibility', !hasPermission(db, U(103, 'field_sales'), 'cost_visibility', 'view'));
  ok('sales_manager has NO cost_visibility (default)', !hasPermission(db, U(104, 'sales_manager'), 'cost_visibility', 'view'));
  ok('production_manager has NO cost_visibility (default; grant per role if wanted)', !hasPermission(db, U(105, 'production_manager'), 'cost_visibility', 'view'));
  ok('accounting grant is view-only (no edit/delete)', !fillRoleDefaults('accounting', db).cost_visibility.edit);
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (106,'cost_visibility','view',0)").run();
  ok('per-user revoke on accounting works', !hasPermission(db, U(106, 'accounting'), 'cost_visibility', 'view'));
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (102,'cost_visibility','view',1)").run();
  ok('per-user grant on cashier works', hasPermission(db, U(102, 'store_retail'), 'cost_visibility', 'view'));
  db.prepare("DELETE FROM user_permissions WHERE user_id=102 AND resource='cost_visibility'").run();

  // ── 2) strip function + key snapshot ──────────────────────────────────────
  console.log('— 2) stripCostVisibility —');
  const sample = {
    id: 1, name: 'کالا', price: 1000, retail_price: 1200, stock: 5,
    cost: 500, average_cost_rial: 480, unit_cost_rial: 470, std_cost_rial: 1, purchase_price: 450, opening_price: 440,
    margin_pct: 10, gross_margin: 5, profit_rial: 9, net_profit: 1, cogs_rial: 3, landed_cost_rial: 4,
    cost_center_id: 7, cost_center_name: 'مرکز', costing_method: 'fifo', cost_sheet_id: 2,
    logs: [{ qty: 1, unit_cost_rial: 1, amount_rial: 2, avg_cost_after_rial: 3, note: 'x' }],
    nested: { deep: [{ avgCost: 1, unitCost: 2, grossProfit: 3, keep: 'ok' }] },
  };
  const stripped = CV.stripCostVisibility(sample, CV.scopeFor('/api/products/1'));
  const keysOf = (o, acc = new Set()) => {
    if (Array.isArray(o)) o.forEach((x) => keysOf(x, acc));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.add(k); keysOf(v, acc); }
    return acc;
  };
  const ks = [...keysOf(stripped)].sort();
  ok('snapshot: remaining keys exactly the safe set', JSON.stringify(ks) === JSON.stringify([
    'cost_center_id', 'cost_center_name', 'cost_sheet_id', 'costing_method', 'deep', 'id', 'keep', 'logs', 'name',
    'nested', 'note', 'price', 'qty', 'retail_price', 'stock', 'amount_rial',
  ].sort()), JSON.stringify(ks));
  // amount_rial is only stripped under stock-value scope (products scope keeps it)
  const kardexScope = CV.scopeFor('/api/inventory/kardex/5');
  ok('kardex scope strips amount_rial', !('amount_rial' in CV.stripCostVisibility({ amount_rial: 1, qty: 2 }, kardexScope)));
  ok('products-scope keeps amount_rial (non-stock-value)', 'amount_rial' in CV.stripCostVisibility({ amount_rial: 1 }, CV.scopeFor('/api/products/1')));
  ok('/api/products/:id/kardex path gets stockValue scope', CV.scopeFor('/api/products/1/kardex').stockValue === true);
  const purchaseScope = CV.scopeFor('/api/purchases/9');
  const ps = CV.stripCostVisibility({ price: 5, qty: 2, sum: 10, disc_amount: 1, supplier_id: 3, rows: [{ price: 7, qty: 1 }] }, purchaseScope);
  ok('purchases scope strips price/sum, keeps qty/disc', !('price' in ps) && !('sum' in ps) && ps.qty === 2 && ps.disc_amount === 1 && !('price' in ps.rows[0]));
  ok('selling price kept outside purchases', CV.stripCostVisibility({ price: 5 }, CV.scopeFor('/api/store/bootstrap')).price === 5);
  ok('arrays/primitives/null pass through', CV.stripCostVisibility(null) === null && CV.stripCostVisibility([1, 'a']).length === 2);
  ok('/api/warehouses scope strips unit_cost', !('unit_cost_rial' in CV.stripCostVisibility({ unit_cost_rial: 1 }, CV.scopeFor('/api/warehouses/moves'))));

  // ── 3) export rows ────────────────────────────────────────────────────────
  console.log('— 3) excel export —');
  const exRows = [{ 'نام کالا': 'A', 'بهای تمام‌شده (ریال)': 5, 'بهای واحد (ریال)': 4, 'مبلغ (ریال)': 8, 'مرکز هزینه/شناسه': 'x', 'عنصر بهای تمام‌شده': 'بله', 'قیمت واحد (ریال)': 3, تعداد: 2 }];
  const exMove = CV.stripCostExportRows(exRows, 'warehouse-receipt')[0];
  ok('export (warehouse): no بها / مبلغ / قیمت واحد columns', !Object.keys(exMove).some((k) => /بها|مبلغ|قیمت/.test(k) && !/عنصر/.test(k)), JSON.stringify(Object.keys(exMove)));
  ok('export keeps name, qty, cost-center and COA element flag', exMove['نام کالا'] === 'A' && exMove['تعداد'] === 2 && exMove['مرکز هزینه/شناسه'] === 'x' && exMove['عنصر بهای تمام‌شده'] === 'بله');
  const exSales = CV.stripCostExportRows([{ 'قیمت واحد (ریال)': 3, 'سود': 1 }], 'sales-invoices')[0];
  ok('export (sales): selling price column kept, profit dropped', exSales['قیمت واحد (ریال)'] === 3 && !('سود' in exSales));

  // ── 4) middleware (fake res) ──────────────────────────────────────────────
  console.log('— 4) middleware + api_v1 scope —');
  const mw = CV.costVisibilityStrip(() => db);
  const run = (req, body) => new Promise((resolve) => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, json(b) { resolve({ body: b, headers }); return this; } };
    mw(req, res, () => res.json(body));
  });
  const m1 = await run({ user: { id: 102, role: 'store_retail' }, baseUrl: '/api/products', path: '/1' }, { cost: 1, price: 2 });
  ok('mw strips for cashier + sets X-Cost-Redacted', m1.body.cost === undefined && m1.body.price === 2 && m1.headers['X-Cost-Redacted'] === '1');
  const m2 = await run({ user: { id: 101, role: 'accounting' }, baseUrl: '/api/products', path: '/1' }, { cost: 1 });
  ok('mw keeps cost for accounting', m2.body.cost === 1 && !m2.headers['X-Cost-Redacted']);
  const m3 = await run({ apiKey: { scopes: 'read' }, baseUrl: '/api/v1', path: '/products' }, { cost: 1, name: 'x' });
  ok('api_v1 key without cost scope → stripped', m3.body.cost === undefined && m3.body.name === 'x');
  const m4 = await run({ apiKey: { scopes: 'read,cost' }, baseUrl: '/api/v1', path: '/products' }, { cost: 1 });
  ok('api_v1 key with cost scope → kept', m4.body.cost === 1);

  // ── 5) HTTP via real routers ──────────────────────────────────────────────
  console.log('— 5) HTTP: products / kardex / inventory / reports / store —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p4-' + tag, device_fingerprint: 'p4-fp-' + tag,
  }).token;
  const tok = {
    admin: tokenFor(adminId, 'admin'), acc: tokenFor(101, 'acc'), cashier: tokenFor(102, 'cashier'),
    noCostAcc: tokenFor(106, 'acc2'),
  };
  const app = express();
  app.use(express.json());
  for (const prefix of CV.COST_STRIP_PREFIXES) {
    if (['/api/products', '/api/inventory', '/api/warehouses', '/api/adv-reports', '/api/store', '/api/purchases'].includes(prefix)) app.use(prefix, CV.costVisibilityStrip());
  }
  app.use('/api/products', require('../routes/products'));
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  app.use('/api/adv-reports', require('../routes/adv-reports'));
  app.use('/api/store', require('../routes/store'));
  app.use('/api/purchases', require('../routes/purchases'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json };
  }
  const COST_RE = /"[^"]*(cost|margin|profit|cogs|landed)[^"]*"\s*:/gi;
  const costKeys = (json) => (JSON.stringify(json).match(COST_RE) || [])
    .map((s) => s.replace(/[":\s]/g, ''))
    .filter((k) => !/cost_?(center|centre|cc|sheet|type|code|id|name|account|basis|mode|method|policy|ing|element|owner|label|group)|costing/i.test(k));

  try {
    const create = await api('POST', '/api/products', {
      name: 'کالای تست P4', code: 'P4-001', price: 1000, retail_price: 1200, cost: 500, stock: 10, unit: 'عدد',
    });
    const pid = create.json && (create.json.id || (create.json.product && create.json.product.id));
    ok('seed: product created by admin', create.status === 200 && pid, JSON.stringify(create.json).slice(0, 200));

    const aProd = await api('GET', `/api/products/${pid}`, null, 'admin');
    ok('admin GET product → has cost keys', costKeys(aProd.json).length > 0, JSON.stringify(Object.keys(aProd.json || {})));
    const accProd = await api('GET', `/api/products/${pid}`, null, 'acc');
    ok('accounting GET product → has cost keys', costKeys(accProd.json).length > 0);
    const cProd = await api('GET', `/api/products/${pid}`, null, 'cashier');
    ok('cashier GET product → 200, selling price kept, NO cost keys', cProd.status === 200 && cProd.json.price === 1000 && costKeys(cProd.json).length === 0, costKeys(cProd.json).join(','));
    const nProd = await api('GET', `/api/products/${pid}`, null, 'noCostAcc');
    ok('accounting with revoked cost_visibility → NO cost keys', nProd.status === 200 && costKeys(nProd.json).length === 0, costKeys(nProd.json).join(','));

    const cList = await api('GET', '/api/products?limit=50', null, 'cashier');
    ok('cashier GET products list → NO cost keys', cList.status === 200 && costKeys(cList.json).length === 0, costKeys(cList.json).join(','));
    const aList = await api('GET', '/api/products?limit=50', null, 'admin');
    ok('admin products list → has cost keys', costKeys(aList.json).length > 0);

    const aK = await api('GET', `/api/products/${pid}/kardex`, null, 'admin');
    const cK = await api('GET', `/api/products/${pid}/kardex`, null, 'cashier');
    ok('admin product kardex → has cost/amount keys', aK.status === 200 && (costKeys(aK.json).length > 0 || JSON.stringify(aK.json).includes('amount_rial')), aK.status);
    ok('cashier product kardex → NO cost/amount_rial keys', cK.status === 200 && costKeys(cK.json).length === 0 && !JSON.stringify(cK.json).includes('amount_rial'), JSON.stringify(cK.json).slice(0, 200));

    const aIK = await api('GET', `/api/inventory/kardex/${pid}`, null, 'acc');
    const nIK = await api('GET', `/api/inventory/kardex/${pid}`, null, 'noCostAcc');
    ok('accounting inventory kardex → 200 with cost/amount keys', aIK.status === 200 && (costKeys(aIK.json).length > 0 || JSON.stringify(aIK.json).includes('amount_rial')), aIK.status);
    ok('revoked accounting inventory kardex → none', nIK.status === 200 && costKeys(nIK.json).length === 0 && !JSON.stringify(nIK.json).includes('amount_rial'));

    const aVal = await api('GET', '/api/adv-reports/inventory-valuation', null, 'acc');
    const nVal = await api('GET', '/api/adv-reports/inventory-valuation', null, 'noCostAcc');
    ok('accounting valuation report 200', aVal.status === 200, aVal.status);
    ok('revoked accounting valuation report → no cost keys', nVal.status === 200 && costKeys(nVal.json).length === 0, costKeys(nVal.json).join(','));
    const aCA = await api('GET', '/api/adv-reports/cost-accounting', null, 'noCostAcc');
    ok('revoked accounting cost-accounting report → no cost keys', costKeys(aCA.json).length === 0, costKeys(aCA.json).join(','));

    const cStore = await api('GET', '/api/store/bootstrap', null, 'cashier');
    ok('cashier store bootstrap → no cost keys (status ' + cStore.status + ')', costKeys(cStore.json).length === 0);

    ok('accounting valuation report carries cost/value keys (positive control)',
      costKeys(aVal.json).length > 0 || /average_cost|unit_cost|value/i.test(JSON.stringify(aVal.json)), JSON.stringify(aVal.json).slice(0, 160));

    db.prepare("INSERT INTO suppliers (id, name) VALUES (9001,'تأمین P4')").run();
    const prInv = db.prepare(`INSERT INTO purchase_invoices (user_id, supplier_id, num, date, rows, subtotal, final)
      VALUES (?,?,?,?,?,?,?)`).run(adminId, 9001, 'P4-PUR-1', '1405/08/10',
      JSON.stringify([{ product_id: pid, name: 'x', qty: 2, price: 500, sum: 1000 }]), 1000, 1000).lastInsertRowid;
    const aPur = await api('GET', `/api/purchases/${prInv}`, null, 'acc');
    const nPur = await api('GET', `/api/purchases/${prInv}`, null, 'noCostAcc');
    ok('accounting purchase invoice keeps line price (positive control)', aPur.status === 200 && aPur.json.rows[0].price === 500, JSON.stringify(aPur.json).slice(0, 160));
    ok('revoked accounting purchase invoice → line price/sum stripped, qty kept',
      nPur.status === 200 && nPur.json.rows[0].price === undefined && nPur.json.rows[0].sum === undefined && nPur.json.rows[0].qty === 2, JSON.stringify(nPur.json).slice(0, 200));
    const nPurList = await api('GET', '/api/purchases', null, 'noCostAcc');
    ok('revoked accounting purchases list → no cost keys', nPurList.status === 200 && costKeys(nPurList.json).length === 0);
    const pr1 = await fetch(`${BASE}/api/purchases/${prInv}/print`, { headers: { Authorization: 'Bearer ' + tok.noCostAcc } });
    const pr2 = await fetch(`${BASE}/api/purchases/${prInv}/print`, { headers: { Authorization: 'Bearer ' + tok.acc } });
    ok('purchase print: revoked → 403, accounting → not 403', pr1.status === 403 && pr2.status !== 403, [pr1.status, pr2.status].join('/'));

    // ── edit-safety: cashier-like caller must not overwrite cost on update ──
    const upd = await api('PUT', `/api/products/${pid}`, { name: 'کالای تست P4 ویرایش' }, 'admin');
    const after = await api('GET', `/api/products/${pid}`, null, 'admin');
    ok('PUT without cost key keeps existing cost (UI omits cost when hidden)', upd.status === 200 && Number(after.json.cost) === 500, JSON.stringify([upd.status, after.json && after.json.cost]));
  } finally {
    await new Promise((rs) => server.close(rs));
  }

  // ── 6) wiring gates ───────────────────────────────────────────────────────
  console.log('— 6) wiring gates —');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idxMw = srv.indexOf('COST_STRIP_PREFIXES');
  const idxProducts = srv.indexOf("app.use('/api/products', require('./routes/products'))");
  ok('server.js mounts cost strip BEFORE /api/products router', idxMw > 0 && idxProducts > idxMw);
  const spec = ['/api/products', '/api/inventory', '/api/warehouses', '/api/purchases', '/api/store', '/api/pos', '/api/reports', '/api/adv-reports', '/api/excel', '/api/v1'];
  ok('COST_STRIP_PREFIXES covers spec routes', spec.every((p) => CV.COST_STRIP_PREFIXES.includes(p)));
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok('UI: window.__canSeeCostVis defined from cost_visibility perm', /__canSeeCostVis\s*=\s*!!\(ME\.role==='admin'\s*\|\|\s*canPerm\('cost_visibility','view'\)\)/.test(appJs));
  ok('UI: product save does not send cost without permission', /if\(window\.__canSeeCostVis!==false\) fd\.append\('cost'/.test(appJs));
  const excelJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'excel.js'), 'utf8');
  ok('excel export honours cost_visibility', excelJs.includes('stripCostExportRows(rows, req.params.entity)'));

  cleanup();
  summary('P4 cost_visibility');
})().catch((e) => { console.error(e); process.exit(1); });
