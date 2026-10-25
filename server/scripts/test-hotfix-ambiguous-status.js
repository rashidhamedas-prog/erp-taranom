/**
 * Hotfix — ambiguous column name: status (products.status v546 + JOIN)
 * Run: node server/scripts/test-hotfix-ambiguous-status.js
 *   or: npm --prefix server run test:hotfix-ambiguous-status
 *
 * Uses a throw-away temp DB only (never crm*.db).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambig-status-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-hotfix-ambiguous-status-secret-32!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  console.log('\n══ Hotfix ambiguous status (products.status × JOIN) ══\n');

  // products.status must exist (v546) — the regression trigger
  const prodCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  ok(prodCols.includes('status'), 'products.status column present (v546)');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user seeded');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'ambig-status', device_fingerprint: 'ambig-status-fp',
  }).token;

  const productId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type, status)
    VALUES (?, 'کالای تست مبهم', 'AMB-FG', 0, 0, 'عدد', 1, 'finished', 'active')
  `).run(admin.id).lastInsertRowid;

  const period = '1405/08';
  const liveId = db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, status, date, period_label, created_by
    ) VALUES ('PO-AMB-LIVE', ?, 'fixed', 10, 'in_progress', '1405/08/01', ?, ?)
  `).run(productId, period, admin.id).lastInsertRowid;

  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, status, date, period_label, created_by
    ) VALUES ('PO-AMB-VOID', ?, 'fixed', 5, 'voided', '1405/08/01', ?, ?)
  `).run(productId, period, admin.id);

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/close', require('../routes/production-close'));
  app.use('/api/production/reports', require('../routes/production-reports'));
  app.use('/api/production/boms', require('../routes/production-boms'));
  app.use('/api/production/orders', require('../routes/production-orders'));
  app.use('/api/production/cost-centers', require('../routes/production-cost-centers'));
  app.use('/api/production/cost-revaluations', require('../routes/production-cost-revaluations'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
  app.use('/api/production/cutting-batches', require('../routes/production-shared-cut'));
  app.use('/api/production/mrp', require('../routes/production-mrp'));
  app.use('/api/production', require('../routes/production-access'));
  app.use('/api/production', require('../routes/production'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    return { status: res.status, data, text };
  }

  // ── Primary regression: listOrders JOIN products ──
  const list = await api('GET', '/api/production/orders');
  ok(list.status === 200, 'GET /api/production/orders → 200', list.status + ' ' + (list.data && list.data.error));
  ok(!/ambiguous column name/i.test(list.text || ''), 'orders list not ambiguous', list.data && list.data.error);
  const rows = (list.data && list.data.rows) || [];
  ok(rows.some((r) => Number(r.id) === Number(liveId)), 'in_progress order in list');
  ok(!rows.some((r) => String(r.status) === 'voided'), 'voided excluded by default');
  ok(Number(list.data && list.data.total) === 1, 'total=1 (voided hidden)', list.data && list.data.total);

  const byStatus = await api('GET', '/api/production/orders?status=in_progress');
  ok(byStatus.status === 200, 'GET orders?status=in_progress → 200', byStatus.data && byStatus.data.error);
  ok(((byStatus.data && byStatus.data.rows) || []).length === 1, 'status filter returns live only');

  const withVoid = await api('GET', '/api/production/orders?include_voided=1');
  ok(withVoid.status === 200, 'GET orders?include_voided=1 → 200', withVoid.data && withVoid.data.error);
  ok(Number(withVoid.data && withVoid.data.total) >= 2, 'include_voided total≥2', withVoid.data && withVoid.data.total);

  const byProduct = await api('GET', `/api/production/orders?product_id=${productId}`);
  ok(byProduct.status === 200, 'GET orders?product_id= → 200', byProduct.data && byProduct.data.error);

  const byPeriod = await api('GET', `/api/production/orders?period=${encodeURIComponent(period)}`);
  ok(byPeriod.status === 200, 'GET orders?period= → 200', byPeriod.data && byPeriod.data.error);

  const one = await api('GET', `/api/production/orders/${liveId}`);
  ok(one.status === 200 && one.data && Number(one.data.id) === Number(liveId),
    'GET orders/:id → 200', one.data && one.data.error);

  // ── Sibling production GETs (no required params) ──
  const getOk = async (label, p) => {
    const r = await api('GET', p);
    const ambig = /ambiguous column name/i.test(r.text || '') || /ambiguous column name/i.test(String((r.data && r.data.error) || ''));
    ok(r.status === 200 && !ambig, `${label} → 200`, r.status + ' ' + (r.data && (r.data.error || r.data.message)));
    return r;
  };

  await getOk('GET /api/production/reports/dashboard', '/api/production/reports/dashboard');
  await getOk('GET /api/production/reports', '/api/production/reports');
  await getOk('GET /api/production/boms', '/api/production/boms');
  await getOk('GET /api/production/boms/missing', '/api/production/boms/missing');
  await getOk('GET /api/production/boms/unused', '/api/production/boms/unused');
  await getOk('GET /api/production/cost-centers', '/api/production/cost-centers');
  await getOk('GET /api/production/cost-centers/rates', '/api/production/cost-centers/rates');
  await getOk('GET /api/production/cost-revaluations', '/api/production/cost-revaluations');
  await getOk('GET /api/production/cutting-lays', '/api/production/cutting-lays');
  await getOk('GET /api/production/cutting-batches/policy', '/api/production/cutting-batches/policy');
  await getOk('GET /api/production/close', '/api/production/close');
  await getOk('GET /api/production/config', '/api/production/config');
  await getOk('GET /api/production/health-check', '/api/production/health-check');
  await getOk('GET /api/production/', '/api/production/');

  // ── inventory ledger JOIN products (same class of bug) ──
  await getOk('GET /api/inventory/ledger', '/api/inventory/ledger');

  // Source-level guards (keep regression from returning)
  const engSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine.js'), 'utf8');
  ok(/where\.push\('po\.status=\?'\)/.test(engSrc), 'engine listOrders qualifies po.status');
  ok(/IFNULL\(po\.status/.test(engSrc), 'engine listOrders qualifies IFNULL(po.status)');
  ok(/FROM production_orders po WHERE/.test(engSrc), 'COUNT uses alias po');
  const invSrc = fs.readFileSync(path.join(__dirname, '../routes/inventory.js'), 'utf8');
  ok(/l\.status='posted'/.test(invSrc), 'inventory ledger qualifies l.status');

  // v557 perf guards — parallel journey + no SQL retry storm
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(/Promise\.allSettled\(/.test(appSrc) && /fetchProdJourneyState/.test(appSrc),
    'app.js fetchProdJourneyState uses Promise.allSettled');
  ok(/PROD_JOURNEY_TTL_MS/.test(appSrc) && /ordersFresh/.test(appSrc),
    'app.js journey TTL + one-shot orderRows reuse');
  const netSrc = fs.readFileSync(path.join(__dirname, '../public/net-resilience.js'), 'utf8');
  ok(/isDeterministicServerErrorBody/.test(netSrc) && /ambiguous column/.test(netSrc),
    'net-resilience skips retry on deterministic SQL 500');
  const NetResilience = require('../public/net-resilience.js');
  ok(NetResilience.isDeterministicServerErrorBody('ambiguous column name: status'),
    'det-body detects ambiguous column');
  ok(!NetResilience.isDeterministicServerErrorBody('سرور موقتاً در دسترس نیست'),
    'det-body ignores generic transient text');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
