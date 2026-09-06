/**
 * v184 — settings ops: Gemini detect, Site-B2B target, module_portal persist,
 * invoice templates, SMS catalog, live reports, fabric convert (no double-count).
 * Run: node server/scripts/test-settings-ops-v184.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-v184-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-settings-ops-v184-secret-32bytes';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { detectProvider } = require('../services/ai');
const { resolveTarget, testWebsiteConnection } = require('../lib/website-stock-sync');
const { SMS_EVENTS, applyVars, dispatchSmsEvent } = require('../lib/sms-dispatch');
const { ALLOWED_KEYS } = require('../routes/settings');
const { resolveTemplateId, FORMAL_IDS, renderInvoicePrintHtml } = require('../lib/invoice-print');
const { receiveFabricRoll, consumeFabricRollOnSale, liveBatchMeters } = require('../lib/inventory/fabric-rolls');
const { postSaleStockMovements } = require('../lib/sales-document');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  console.log('\n— Gemini / provider —');
  ok(detectProvider({ provider: 'gemini' }) === 'gemini', 'explicit gemini');
  ok(detectProvider({ provider: 'google' }) === 'gemini', 'google alias');
  ok(detectProvider({ model: 'gemini-2.0-flash' }) === 'gemini', 'model prefix');
  ok(detectProvider({ apiKey: 'AIzaSyDummyTestKeyNotReal' }) === 'gemini', 'AIza key prefix');
  ok(detectProvider({ model: 'claude-haiku-4-5-20251001' }) === 'claude', 'claude model');
  ok(detectProvider({}) === 'claude', 'default claude');

  console.log('\n— Site-B2B target —');
  ok(resolveTarget({ website_target: 'woocommerce' }) === 'woo', 'woocommerce alias → woo');
  ok(resolveTarget({ website_target: 'site_b2b' }) === 'site_b2b', 'site_b2b');
  ok(resolveTarget({ website_target: 'both' }) === 'both', 'both');
  ok(resolveTarget({ website_b2b_url: 'https://example.com' }) === 'both', 'url implies both when unset');
  const probe = await testWebsiteConnection({});
  ok(probe && probe.reason === 'missing db', 'testWebsiteConnection rejects missing db');

  console.log('\n— Settings allow-list —');
  ok(ALLOWED_KEYS.includes('module_portal'), 'module_portal persistable');
  ok(ALLOWED_KEYS.includes('ai_provider'), 'ai_provider persistable');
  ok(ALLOWED_KEYS.includes('website_b2b_url'), 'website_b2b_url persistable');
  ok(ALLOWED_KEYS.includes('website_b2b_token'), 'website_b2b_token persistable');

  console.log('\n— SMS catalog —');
  const keys = SMS_EVENTS.map((e) => e.key);
  for (const k of [
    'invoice.created', 'invoice.converted', 'invoice.approved',
    'settlement.created', 'payment.created', 'customer.created',
    'customer.welcome', 'party.created', 'followup.reminder',
    'auth.otp', 'b2b.otp', 'portal.invite', 'rep.notify',
  ]) {
    ok(keys.includes(k), 'event ' + k);
  }
  ok(applyVars('کد {code}', { '{code}': '123456' }) === 'کد 123456', 'applyVars {code}');
  const noRule = await dispatchSmsEvent(db, 'invoice.created', { phone: '09151111111', amount: 1000 });
  ok(noRule && noRule.ok && noRule.sent === 0, 'no rule → no send');

  console.log('\n— Invoice templates —');
  ok(FORMAL_IDS.includes('formal-official') && FORMAL_IDS.includes('formal-modern') && FORMAL_IDS.includes('formal-premium'), 'three formal ids');
  ok(resolveTemplateId('proforma', { invoice_template_formal: 'formal-premium' }) === 'casual-simple', 'proforma always casual');
  ok(resolveTemplateId('final', { invoice_template_formal: 'formal-premium' }) === 'formal-premium', 'final premium');
  const htmlOff = renderInvoicePrintHtml({
    inv: { type: 'final', num: 'T-0001', date: '1405/06/12', cust_biz: 'آزمایش' },
    rows: [{ name: 'مانتو', qty: 1, price: 1000, sum: 1000 }],
    settings: { invoice_template_formal: 'formal-official', company_name: 'ترنم' },
  });
  const htmlMod = renderInvoicePrintHtml({
    inv: { type: 'final', num: 'T-0001', date: '1405/06/12', cust_biz: 'آزمایش' },
    rows: [{ name: 'مانتو', qty: 1, price: 1000, sum: 1000 }],
    settings: { invoice_template_formal: 'formal-modern', company_name: 'ترنم' },
  });
  const htmlPrem = renderInvoicePrintHtml({
    inv: { type: 'final', num: 'T-0001', date: '1405/06/12', cust_biz: 'آزمایش' },
    rows: [{ name: 'مانتو', qty: 1, price: 1000, sum: 1000 }],
    settings: { invoice_template_formal: 'formal-premium', company_name: 'ترنم' },
  });
  ok(htmlOff.includes('off-banner') && !htmlOff.includes('mod-header'), 'official markup');
  ok(htmlMod.includes('mod-header') && !htmlMod.includes('off-banner'), 'modern markup');
  ok(htmlPrem.includes('hero') && htmlPrem.includes('prem-rule'), 'premium markup');

  console.log('\n— Fabric convert: exact remaining after ledger post —');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  ok(!!raw, 'WH-RAW exists');
  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'کرپ v184', 'FAB-184', 0, 0, 'متر')
  `).run(admin.id).lastInsertRowid;
  const rec = receiveFabricRoll(db, {
    product_id: prodId, warehouse_id: raw.id, color: 'سرمه‌ای',
    meters: 20, unit: 'متر', unit_cost_rial: 0,
    roll_no: 'LOT-0007', date: '1405/06/12', idempotency_key: 'fab-v184',
  }, admin);
  ok(rec && rec.id, 'receive 20m');
  ok(liveBatchMeters(db, rec.id) === 20, 'live 20 before sale');

  let convertErr = null;
  try {
    db.transaction(() => {
      postSaleStockMovements(db, {
        rows: [{ product_id: prodId, qty: 20, batch_id: rec.id }],
        warehouseId: raw.id,
        sourceType: 'invoice',
        sourceId: 184,
        userId: admin.id,
        date: '1405/06/12',
        note: 'تبدیل تست v184',
      });
    })();
  } catch (e) {
    convertErr = e;
  }
  ok(!convertErr, 'exact 20 of 20 converts', convertErr && convertErr.message);
  ok(Math.abs((liveBatchMeters(db, rec.id) || 0)) < 1e-6, 'live 0 after exact sale');

  let oversell = null;
  try {
    db.transaction(() => {
      postSaleStockMovements(db, {
        rows: [{ product_id: prodId, qty: 5, batch_id: rec.id }],
        warehouseId: raw.id,
        sourceType: 'invoice',
        sourceId: 185,
        userId: admin.id,
        date: '1405/06/12',
        note: 'oversell v184',
      });
    })();
  } catch (e) {
    oversell = e;
  }
  ok(oversell && /مانده 0/.test(String(oversell.message)) && /نیاز 5/.test(String(oversell.message)),
    'oversell shows pre-sale remainder not negative leftover', oversell && oversell.message);

  console.log('\n— HTTP: modules + reports live —');
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v184', device_fingerprint: 'v184-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/reports', require('../routes/reports'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  }

  let r = await api('PUT', '/api/settings', { module_portal: '0', ai_provider: 'gemini' });
  ok(r.status === 200, 'PUT settings 200');
  r = await api('GET', '/api/settings/modules');
  ok(r.status === 200 && r.data.module_portal === '0', 'module_portal persisted off', r.data && r.data.module_portal);
  ok(r.data.feature_ai_assistant === '0' || r.data.feature_ai_assistant === '1', 'feature flags present');

  r = await api('GET', '/api/reports/summary');
  ok(r.status === 200 && r.data.live === true && r.data.generated_at, 'summary live stamp');
  ok(typeof r.data.collection_rate === 'number', 'collection_rate');

  r = await api('GET', '/api/reports/monthly');
  ok(r.status === 200 && r.data && Array.isArray(r.data.rows), 'monthly.rows object shape');
  ok(r.data.generated_at, 'monthly generated_at');

  r = await api('GET', '/api/reports/salesperson');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.some((u) => u.role), 'salesperson has roles');

  server.close();
  closeSessionStore();
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  process.exitCode = 1;
});
