'use strict';
/**
 * P10 — quick item movement + approximate daily P&L (read-only reports).
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-p10-reports-daily-pnl.js
 *
 * Fixture: one day of sales (kardex / journal / estimate COGS sources), a sales return,
 * a purchase, expenses (posted/approved/overhead/reversed) and rep expenses → exact numbers.
 * RBAC: cashier sees qty only (no amount keys) and gets 403 on daily-pnl.
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ P10 reports: quick item movement + daily P&L ══\n');

(async () => {
  const { db, cleanup } = freshDb();
  const { buildQuickItemMovement, buildDailyPnl, APPROX_LABEL } = require('../lib/reports-p10');
  const { acct } = require('../lib/coa-map');
  const CV = require('../lib/cost-visibility');

  const D = '1405/08/10';
  const D2 = '1405/08/11';
  const adminId = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || { id: 1 }).id;
  for (const [id, username, role] of [
    [101, 'p10_acc', 'accounting'], [102, 'p10_cashier', 'store_retail'], [103, 'p10_fs', 'field_sales'],
    [104, 'p10_cashier2', 'store_retail'], [105, 'p10_noreports', 'store_retail'], [107, 'p10_branch', 'store_retail'],
  ]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)').run(id, username, 'x', username, role);
  }
  db.prepare('UPDATE users SET must_change_password=0').run();
  db.prepare('UPDATE users SET branch_id=5 WHERE id=107').run();

  // ── fixture ──
  const W1 = db.prepare("INSERT INTO warehouses (name) VALUES ('انبار P10-1')").run().lastInsertRowid;
  const W2 = db.prepare("INSERT INTO warehouses (name) VALUES ('انبار P10-2')").run().lastInsertRowid;
  const pA = db.prepare("INSERT INTO products (user_id, code, name, price) VALUES (?, 'P10-A', 'مانتو P10', 1000)").run(adminId).lastInsertRowid;
  const pB = db.prepare("INSERT INTO products (user_id, code, name, price) VALUES (?, 'P10-B', 'شال P10', 800)").run(adminId).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=400 WHERE id=?').run(pA);
  db.prepare('UPDATE products SET average_cost_rial=300 WHERE id=?').run(pB);
  const V1 = db.prepare("INSERT INTO product_variants (product_id, sku) VALUES (?, 'P10-A-RED-M')").run(pA).lastInsertRowid;
  const cust = db.prepare("INSERT INTO customers (user_id, biz) VALUES (?, 'مشتری P10')").run(adminId).lastInsertRowid;

  const inv = (type, date, rows, final, vat, wh, opts = {}) => {
    const id = db.prepare(`INSERT INTO invoices (user_id, cust_id, num, type, date, rows, subtotal, final, vat_amount, warehouse_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(opts.user || adminId, cust, 'P10-' + Math.random().toString(36).slice(2, 8), type, date,
      JSON.stringify(rows), final - vat, final, vat, wh).lastInsertRowid;
    db.prepare('UPDATE invoices SET final_rial=?, vat_amount_rial=? WHERE id=?').run(final, vat, id);
    if (opts.deleted) db.prepare('UPDATE invoices SET deleted_at=? WHERE id=?').run(Date.now(), id);
    return id;
  };
  const I1 = inv('normal', D, [{ product_id: pA, name: 'مانتو P10', qty: 3, price: 1000, sum: 3000, warehouse_id: W1 }], 3270, 270, W1);
  const I2 = inv('final', D, [{ product_id: pB, name: 'شال P10', qty: 2, price: 800, sum: 1600 }], 1600, 0, W2);
  const I3 = inv('normal', D, [{ product_id: pA, name: 'مانتو P10', qty: 1, price: 1000, sum: 1000, variant_id: V1, color_name: 'قرمز', size_name: 'M' }], 1000, 0, null);
  inv('proforma', D, [{ product_id: pA, qty: 50, price: 1000, sum: 50000 }], 50000, 0, W1);
  inv('normal', D, [{ product_id: pA, qty: 40, price: 1000, sum: 40000 }], 40000, 0, W1, { deleted: true });
  const I6 = inv('normal', D2, [{ product_id: pB, name: 'شال P10', qty: 1, price: 2000, sum: 2000 }], 2000, 0, W2, { user: 107 });

  // kardex: live sale-out for I1 (1200) + a reversal row that must be ignored
  const led = (tx, ev, pid, wh, qtyOut, amt, src, srcId, extra = {}) => db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_out, amount_rial, source_type, source_id, status, date, reversed_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(tx, ev, pid, wh, qtyOut, amt, src, srcId, extra.status || 'posted', D, extra.reversed_of || null);
  led('P10-L1', 'sale', pA, W1, 3, 1200, 'invoice', I1);
  led('P10-L2', 'reversal', pA, W1, 3, 999, 'invoice', I1);
  led('P10-L3', 'sale', pA, W1, 3, 777, 'invoice', I1, { status: 'reversed' });

  // journal COGS for I2 (650), no kardex
  const cogsCode = String(acct(db, 'coa_cogs').code);
  const je = db.prepare("INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by) VALUES (?, 'COGS P10', 'invoice_cogs', ?, ?)").run(D, I2, adminId).lastInsertRowid;
  db.prepare("INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit) VALUES (?,?,?,?,0)").run(je, cogsCode, 'COGS', 650);
  db.prepare("INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit) VALUES (?,?,?,0,?)").run(je, '1104', 'Inventory', 650);

  // sales return (posted) + reversed one (ignored)
  const sr = (rows, amount, vat, cost, status) => {
    const id = db.prepare('INSERT INTO sales_returns (user_id, cust_id, invoice_id, date, rows, amount) VALUES (?,?,?,?,?,?)')
      .run(adminId, cust, I1, D, JSON.stringify(rows), amount).lastInsertRowid;
    db.prepare('UPDATE sales_returns SET vat_amount=?, cost_amount=?, status=? WHERE id=?').run(vat, cost, status, id);
    return id;
  };
  sr([{ product_id: pA, name: 'مانتو P10', qty: 1, price: 1000, sum: 1000, warehouse_id: W1 }], 1000, 90, 400, 'posted');
  sr([{ product_id: pA, qty: 2, price: 1000, sum: 2000, warehouse_id: W1 }], 2000, 0, 800, 'reversed');

  // purchase
  db.prepare("INSERT INTO suppliers (id, name) VALUES (9101, 'تأمین P10')").run();
  db.prepare(`INSERT INTO purchase_invoices (user_id, supplier_id, num, date, rows, subtotal, final, warehouse_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(adminId, 9101, 'P10-PUR-1', D,
    JSON.stringify([{ product_id: pA, name: 'مانتو P10', qty: 10, price: 400, sum: 4000 }]), 4000, 4000, W1);

  // expenses
  const exp = (amount, fee, status, overhead) => db.prepare(`INSERT INTO expense_payments (category, title, amount, fee_rial, date, created_by, status, is_overhead)
    VALUES ('admin', 'هزینه P10', ?, ?, ?, ?, ?, ?)`).run(amount, fee, D, adminId, status, overhead ? 1 : 0);
  exp(500, 20, 'posted', false);
  exp(700, 0, 'posted', true);
  exp(300, 0, 'reversed', false);
  exp(100, 0, 'approved', false);
  exp(900, 0, 'pending', false);
  db.prepare("INSERT INTO rep_expenses (rep_id, category, amount, date, status) VALUES (?, 'fuel', 50, ?, 'approved')").run(103, D);
  db.prepare("INSERT INTO rep_expenses (rep_id, category, amount, date, status) VALUES (?, 'fuel', 60, ?, 'pending')").run(103, D);
  // P8 expense drafts: only 'approved' counts (its JE is not an expense_payments row → counted exactly once)
  ok('P8 expense_drafts table present (main ≥ v595)', db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='expense_drafts'").get());
  for (const [amount, status] of [[200, 'approved'], [1000, 'pending'], [1100, 'rejected'], [1200, 'voided'], [1300, 'cancelled']]) {
    db.prepare("INSERT INTO expense_drafts (date, amount, category, title, status, created_by) VALUES (?, ?, 'admin', 'هزینهٔ روزانه P10', ?, ?)").run(D, amount, status, adminId);
  }
  // P9 supervisor rule 10% on product A → informational commission line (not deducted)
  db.prepare("INSERT INTO commission_rules (person_id, role, scope, scope_id, pct) VALUES (1, 'supervisor', 'product', ?, 10)").run(pA);

  // ── 1) daily P&L — exact numbers ──
  console.log('— 1) daily P&L (lib) —');
  const p = buildDailyPnl(db, { date: D });
  const t = p.totals;
  ok('label is «تقریبی؛ قبل از بستن دوره»', p.approximate === true && p.label === APPROX_LABEL && APPROX_LABEL === 'تقریبی؛ قبل از بستن دوره');
  eq('invoice_count = 3 (proforma + deleted excluded)', t.invoice_count, 3);
  eq('sales gross = 5870', t.sales_gross_rial, 5870);
  eq('sales VAT = 270', t.sales_vat_rial, 270);
  eq('returns (net, excl. VAT) = 1000 (reversed excluded)', t.returns_rial, 1000);
  eq('net sales = 4600', t.net_sales_rial, 4600);
  eq('COGS sales = 1200 kardex + 650 journal + 400 estimate = 2250', t.cogs_sales_rial, 2250);
  ok('COGS source counts kardex/journal/estimate = 1/1/1', p.cogs_source.kardex === 1 && p.cogs_source.journal === 1 && p.cogs_source.estimate === 1, JSON.stringify(p.cogs_source));
  eq('COGS returns = 400', t.cogs_returns_rial, 400);
  eq('net COGS = 1850', t.cogs_rial, 1850);
  eq('gross profit = 2750', t.gross_profit_rial, 2750);
  eq('expenses = 500+20 fee + 100 approved payment + 200 approved P8 draft + 50 rep = 870', t.expenses_rial, 870);
  eq('operating profit = 1880', t.operating_profit_rial, 1880);
  ok('P8 draft counted once (only approved; pending/rejected/voided/cancelled excluded)',
    p.expenses.items.filter((e) => e.kind === 'expense_draft').length === 1 && p.expenses.items.find((e) => e.kind === 'expense_draft').amount_rial === 200);
  eq('P9 commission (info) = 10%×(3000+1000) − 10%×910 return = 309', t.commission_p9_rial, 309);
  ok('P9 commission not deducted from operating profit', p.commission_p9.available === true && p.commission_p9.deducted === false && t.operating_profit_after_commission_rial === 1880 - 309);
  ok('P9 commission per day row', p.days[0].commission_p9_rial === 309);
  eq('gross margin % = 59.8', t.gross_margin_pct, 59.8);
  ok('single day → one day row', p.days.length === 1 && p.days[0].date === D);
  ok('expense items exclude overhead/reversed/pending', p.expenses.count === 4 && !p.expenses.items.some((e) => e.amount_rial === 700 || e.amount_rial === 300 || e.amount_rial === 900 || e.amount_rial === 60));

  const pr = buildDailyPnl(db, { from: D, to: D2 });
  ok('range → two day rows', pr.days.length === 2 && pr.days[1].date === D2);
  eq('range net sales = 4600 + 2000', pr.totals.net_sales_rial, 6600);
  eq('range COGS adds estimate 300 for I6', pr.totals.cogs_rial, 2150);
  const pb = buildDailyPnl(db, { from: D, to: D2, branch_id: 5 });
  ok('branch filter (users.branch_id) → only I6', pb.totals.invoice_count === 1 && pb.totals.net_sales_rial === 2000 && pb.totals.gross_profit_rial === 1700 && pb.totals.expenses_rial === 0 && pb.commission_p9.available === false && pb.totals.commission_p9_rial === undefined, JSON.stringify(pb.totals));
  const pw = buildDailyPnl(db, { date: D, warehouse_id: W1 });
  ok('warehouse filter → I1 + its return only', pw.totals.invoice_count === 1 && pw.totals.net_sales_rial === 3000 - 1000 && pw.totals.cogs_rial === 800, JSON.stringify(pw.totals));
  let badErr = null;
  try { buildDailyPnl(db, { date: '1405-08-10' }); } catch (e) { badErr = e; }
  ok('bad date → 400 E_P10_DATE', badErr && badErr.status === 400 && badErr.code === 'E_P10_DATE');
  try { badErr = null; buildDailyPnl(db, { from: D2, to: D }); } catch (e) { badErr = e; }
  ok('from > to → 400 E_P10_RANGE', badErr && badErr.code === 'E_P10_RANGE');

  // ── 2) quick item movement ──
  console.log('— 2) quick item movement (lib) —');
  const q = buildQuickItemMovement(db, { date: D }, { showAmounts: true });
  const row = (pid, vid) => q.rows.find((r) => r.product_id === pid && (r.variant_id || null) === (vid || null));
  const a0 = row(pA, null);
  const a1 = row(pA, V1);
  const b0 = row(pB, null);
  ok('rows split by product × variant (3 rows)', q.rows.length === 3 && a0 && a1 && b0, JSON.stringify(q.rows.map((r) => [r.product_id, r.variant_id])));
  ok('A: sold 3, returned 1, net 2, purchased 10', a0.sold_qty === 3 && a0.returned_qty === 1 && a0.net_sold_qty === 2 && a0.purchased_qty === 10, JSON.stringify(a0));
  ok('A/V1: sold 1, sku + colour/size carried', a1.sold_qty === 1 && a1.sku === 'P10-A-RED-M' && a1.color_name === 'قرمز' && a1.size_name === 'M');
  ok('B: sold 2, no purchases', b0.sold_qty === 2 && b0.purchased_qty === 0);
  ok('amounts (allowed): A sales 3000, returns 1000, net 2000, purchase 4000',
    a0.sales_amount_rial === 3000 && a0.returns_amount_rial === 1000 && a0.net_sales_amount_rial === 2000 && a0.purchase_amount_rial === 4000);
  ok('totals: sold 6, returned 1, purchased 10', q.totals.sold_qty === 6 && q.totals.returned_qty === 1 && q.totals.purchased_qty === 10 && q.totals.sales_amount_rial === 5600);
  ok('proforma / deleted / reversed-return excluded (A sold not 93)', a0.sold_qty < 10);

  const qs = buildQuickItemMovement(db, { date: D, type: 'sale' }, { showAmounts: true });
  ok('type=sale → purchases zero', qs.totals.purchased_qty === 0 && qs.totals.sold_qty === 6);
  const qp = buildQuickItemMovement(db, { date: D, type: 'purchase' }, { showAmounts: true });
  ok('type=purchase → sales zero', qp.totals.sold_qty === 0 && qp.totals.purchased_qty === 10 && qp.rows.length === 1);
  const qw = buildQuickItemMovement(db, { date: D, warehouse_id: W1 }, { showAmounts: true });
  ok('warehouse W1 → only A (line/header wh), sold 3 / returned 1 / purchased 10',
    qw.rows.length === 1 && qw.rows[0].product_id === pA && qw.rows[0].sold_qty === 3 && qw.rows[0].returned_qty === 1 && qw.rows[0].purchased_qty === 10, JSON.stringify(qw.rows));
  const qq = buildQuickItemMovement(db, { date: D, q: 'شال' }, { showAmounts: false });
  ok('search q filters rows', qq.rows.length === 1 && qq.rows[0].product_id === pB);
  const qn = buildQuickItemMovement(db, { date: D }, { showAmounts: false });
  ok('showAmounts=false → no *_amount_rial keys anywhere', !/_amount_rial/.test(JSON.stringify(qn)) && qn.amounts_visible === false);
  const q2 = buildQuickItemMovement(db, { from: D, to: D2 }, { showAmounts: false });
  ok('range includes next-day sale (B sold 3)', q2.rows.find((r) => r.product_id === pB).sold_qty === 3);

  // ── 3) HTTP + RBAC ──
  console.log('— 3) HTTP + RBAC —');
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (104,'cost_visibility','view',1)").run();
  db.prepare("INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (105,'reports','view',0)").run();
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p10-' + tag, device_fingerprint: 'p10-fp-' + tag,
  }).token;
  const tok = {
    admin: tokenFor(adminId, 'admin'), acc: tokenFor(101, 'acc'), cashier: tokenFor(102, 'cashier'),
    fs: tokenFor(103, 'fs'), cashierGrant: tokenFor(104, 'cg'), noReports: tokenFor(105, 'nr'),
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
    return { status: res.status, json };
  };
  try {
    const qim = `/api/reports/quick-item-movement?from=${encodeURIComponent(D)}&to=${encodeURIComponent(D)}`;
    const pnl = `/api/reports/daily-pnl?date=${encodeURIComponent(D)}`;
    const c1 = await get(qim, 'cashier');
    ok('cashier quick-item-movement → 200 with qty', c1.status === 200 && c1.json.totals.sold_qty === 6, c1.status);
    ok('cashier → amounts_visible=false and no amount/cost/profit keys', c1.json.amounts_visible === false
      && !/_amount_rial|cost|profit|margin|cogs/i.test(JSON.stringify(Object.keys(c1.json.rows[0]))) && !/_amount_rial/.test(JSON.stringify(c1.json)));
    const c2 = await get(pnl, 'cashier');
    ok('cashier daily-pnl → 403 E_COST_VISIBILITY', c2.status === 403 && c2.json.code === 'E_COST_VISIBILITY', c2.status);
    const f1 = await get(qim, 'fs');
    ok('field_sales (reports:view) → qty only', f1.status === 200 && f1.json.amounts_visible === false);
    const f2 = await get(pnl, 'fs');
    ok('field_sales daily-pnl → 403', f2.status === 403);
    const n1 = await get(qim, 'noReports');
    ok('user with reports:view revoked → 403', n1.status === 403, n1.status);
    const a1h = await get(qim, 'acc');
    ok('accounting quick-item-movement → amounts visible', a1h.status === 200 && a1h.json.amounts_visible === true && a1h.json.totals.net_sales_amount_rial === 4600);
    const a2h = await get(pnl, 'acc');
    ok('accounting daily-pnl → 200 exact operating profit 1880 (not stripped)', a2h.status === 200 && a2h.json.totals.operating_profit_rial === 1880 && a2h.json.totals.cogs_rial === 1850, a2h.status);
    const ad = await get(pnl, 'admin');
    ok('admin daily-pnl → 200', ad.status === 200 && ad.json.totals.gross_profit_rial === 2750);
    const g1 = await get(qim, 'cashierGrant');
    const g2 = await get(pnl, 'cashierGrant');
    ok('cashier with per-user cost_visibility grant → amounts + P&L', g1.json.amounts_visible === true && g2.status === 200);
    const bad = await get('/api/reports/daily-pnl?date=bad', 'acc');
    ok('daily-pnl bad date → 400', bad.status === 400 && bad.json.code === 'E_P10_DATE');
  } finally {
    await new Promise((rs) => server.close(rs));
  }

  // ── 4) read-only + wiring gates ──
  console.log('— 4) read-only + wiring —');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reports-p10.js'), 'utf8');
  ok('lib is read-only (no INSERT/UPDATE/DELETE)', !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(libSrc));
  ok('COGS uses LEDGER_LIVE_SQL (P1 kardex SSOT filter)', libSrc.includes('LEDGER_LIVE_SQL'));
  ok('/api/reports covered by cost strip middleware', CV.COST_STRIP_PREFIXES.includes('/api/reports'));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server.js mounts cost strip before /api/reports router',
    srv.indexOf('COST_STRIP_PREFIXES') > 0 && srv.indexOf("app.use('/api/reports', require('./routes/reports'))") > srv.indexOf('COST_STRIP_PREFIXES'));
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok('UI routes registered', appJs.includes("ROUTES['quick-item-movement']") && appJs.includes("ROUTES['daily-pnl']"));
  ok('UI hides daily-pnl nav without cost_visibility', appJs.includes("it.id==='daily-pnl' && !(ME && (ME.role==='admin' || canPerm('cost_visibility','view')))"));
  ok('cashier nav (NAV_STORE) has quick-item-movement', /const NAV_STORE = \[[\s\S]*?quick-item-movement[\s\S]*?\];/.test(appJs));
  ok('help updated (P10 section in admin + sales guides)', (appJs.match(/P10 — v599/g) || []).length >= 2);
  const swVer = Number((fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8').match(/erp-taranom-v(\d+)/) || [])[1] || 0);
  ok('SW cache version >= 599', swVer >= 599, String(swVer));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appV = Number((idx.match(/\/app\.js\?v=(\d+)/) || [])[1] || 0);
  ok('index.html app.js?v >= 599', appV >= 599, String(appV));

  cleanup();
  summary('P10 reports');
})().catch((e) => { console.error(e); process.exit(1); });
