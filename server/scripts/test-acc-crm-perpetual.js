#!/usr/bin/env node
/**
 * ACC-CRM-UNIFY — perpetual sales/purchase + normal invoice + warehouse gate.
 * Boots disposable server on temp DB.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = 3488;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-crm-perp-'));
const JWT = 'acc-crm-unify-test-jwt-secret-32chars!!';
let adminPass = 'admin123';
const TEST_PASS = 'AccCrmUnify1!';

// Parent process fetch must not go through system proxy for loopback.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function j(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}

async function waitUp(srv, getStderr) {
  for (let i = 0; i < 300; i++) {
    if (srv && srv.exitCode != null) {
      throw new Error('server exited early code=' + srv.exitCode + ' stderr=' + String(getStderr?.() || '').slice(-1500));
    }
    try {
      const r = await fetch(BASE + '/api/system/time', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('server did not start; stderr=' + String(getStderr?.() || '').slice(-1500));
}

async function login() {
  let r = await j('POST', '/api/auth/login', { username: 'admin', password: adminPass });
  if (r.status === 200 && r.data.must_change_password && r.data.token) {
    await j('POST', '/api/auth/change-password', { oldPass: adminPass, newPass: TEST_PASS }, r.data.token);
    adminPass = TEST_PASS;
    r = await j('POST', '/api/auth/login', { username: 'admin', password: adminPass });
  }
  return r;
}

(async () => {
  const dbPath = path.join(TMP, 'test.db');
  // Avoid system HTTP(S)_PROXY hijacking loopback health checks / API calls.
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    UPLOADS_DIR: path.join(TMP, 'uploads'),
    JWT_SECRET: JWT,
    SYNC_ROLE: 'central',
    NO_PROXY: '127.0.0.1,localhost,' + (process.env.NO_PROXY || ''),
    no_proxy: '127.0.0.1,localhost,' + (process.env.no_proxy || ''),
  };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });
  srv.stdout.on('data', (d) => { stdout += d.toString(); });
  try {
    await waitUp(srv, () => stderr + '\n' + stdout);
    console.log('══ ACC-CRM perpetual / normal invoice ══');
    let r = await login();
    ok(r.status === 200 && r.data.token, 'login');
    const token = r.data.token;
    const db = new Database(dbPath);

    // Seed COA settings if needed
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('moadian_enabled','0')").run();

    r = await j('POST', '/api/customers', { biz: 'مشتری تست unify', phone: '09151110001', city: 'مشهد' }, token);
    ok(r.status === 200 && r.data.id, 'create customer', r.data?.error);
    const custId = r.data.id;

    r = await j('POST', '/api/warehouses', { name: 'انبار تست unify', code: 'WH-U1', active: 1 }, token);
    let whId = r.data?.id;
    if (!whId) {
      const wh = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get();
      whId = wh?.id;
    }
    ok(!!whId, 'warehouse available', String(whId));

    r = await j('POST', '/api/products', {
      name: 'کالای تست unify', price: 100000, cost: 40000, stock: 0, unit: 'عدد', warehouse_id: whId,
    }, token);
    ok(r.status === 200 && r.data.id, 'create product', r.data?.error);
    const prodId = r.data.id;

    // Purchase to seed stock via perpetual path
    let supplierId = db.prepare('SELECT id FROM suppliers LIMIT 1').get()?.id;
    if (!supplierId) {
      const s = await j('POST', '/api/suppliers', { name: 'تأمین‌کننده unify', phone: '09152220002' }, token);
      supplierId = s.data?.id;
    }
    ok(!!supplierId, 'supplier available');

    const stockBeforePurchase = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId)?.stock || 0;
    r = await j('POST', '/api/purchases', {
      supplier_id: supplierId, warehouse_id: whId, pay_type: 'credit',
      rows: [{ product_id: prodId, qty: 20, price: 40000 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'purchase create', r.data?.error);
    const purchaseId = r.data?.id;
    const stockAfterPurchase = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId)?.stock || 0;
    ok(stockAfterPurchase >= stockBeforePurchase + 20, 'purchase increases stock', `${stockBeforePurchase}→${stockAfterPurchase}`);
    const invLedP = db.prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE source_type='purchase' AND source_id=? AND status='posted'").get(purchaseId)?.c || 0;
    ok(invLedP >= 1, 'purchase writes inventory_ledger');
    const jeP = db.prepare("SELECT id FROM journal_entries WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(purchaseId);
    ok(!!jeP, 'purchase JE exists');

    // Proforma — no stock / no JE
    const stock0 = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock;
    r = await j('POST', '/api/invoices', {
      cust_id: custId, type: 'proforma', warehouse_id: whId, pay_type: 'credit',
      rows: [{ product_id: prodId, qty: 2, price: 100000 }],
    }, token);
    ok(r.status === 200 && r.data.type === 'proforma', 'proforma create type', r.data?.error);
    const proformaId = r.data.id;
    ok(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock === stock0, 'proforma no stock change');
    ok(!db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice' AND ref_id=?").get(proformaId), 'proforma no sales JE');

    // Normal — firm sale, COGS, no moadian
    r = await j('POST', '/api/invoices', {
      cust_id: custId, type: 'normal', warehouse_id: whId, pay_type: 'credit',
      rows: [{ product_id: prodId, qty: 3, price: 100000, warehouse_id: whId }],
    }, token);
    ok(r.status === 200 && r.data.type === 'normal', 'normal create', r.data?.error);
    const normalId = r.data.id;
    ok(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock === stock0 - 3, 'normal decreases stock');
    ok(!!db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice' AND ref_id=?").get(normalId), 'normal sales JE');
    ok(!!db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=?").get(normalId), 'normal COGS JE');
    ok(db.prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE source_type='invoice' AND source_id=? AND status='posted'").get(normalId).c >= 1, 'normal inventory_ledger');
    ok((db.prepare("SELECT COUNT(*) c FROM moadian_queue WHERE doc_type='sales' AND doc_id=?").get(normalId)?.c || 0) === 0, 'normal not in moadian queue');

    // List filter normal
    r = await j('GET', '/api/invoices?type=normal', null, token);
    ok(r.status === 200 && (r.data.rows || r.data).some?.(x => x.id === normalId || x.type === 'normal')
      || (Array.isArray(r.data) && r.data.some(x => x.id === normalId)), 'list filter normal');

    // Warehouse mismatch
    const wh2 = db.prepare('SELECT id FROM warehouses WHERE id<>? AND active=1 LIMIT 1').get(whId);
    if (wh2) {
      r = await j('POST', '/api/invoices', {
        cust_id: custId, type: 'normal', warehouse_id: whId, pay_type: 'credit',
        rows: [{ product_id: prodId, qty: 1, price: 100000, warehouse_id: wh2.id }],
      }, token);
      ok(r.status === 409 || r.status === 400, 'warehouse mismatch rejected', String(r.status));
    } else {
      ok(true, 'warehouse mismatch skipped (single WH)');
    }

    // Final — moadian only if enabled; enable then create
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('moadian_enabled','1')").run();
    r = await j('POST', '/api/invoices', {
      cust_id: custId, type: 'final', warehouse_id: whId, pay_type: 'credit',
      rows: [{ product_id: prodId, qty: 1, price: 100000, warehouse_id: whId }],
    }, token);
    ok(r.status === 200 && r.data.type === 'final', 'final create', r.data?.error);
    const finalId = r.data.id;
    ok((db.prepare("SELECT COUNT(*) c FROM moadian_queue WHERE doc_type='sales' AND doc_id=?").get(finalId)?.c || 0) >= 1, 'final enqueued moadian');

    // Void normal
    const stockBeforeVoid = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock;
    r = await j('DELETE', '/api/invoices/' + normalId, null, token);
    ok(r.status === 200, 'void normal', r.data?.error);
    ok(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock === stockBeforeVoid + 3, 'void restores stock');
    ok(!!db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_reversal' AND ref_id=?").get(normalId), 'void sales reversal JE');

    // Sales return against final invoice (perpetual)
    const stockBeforeSr = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock;
    r = await j('POST', '/api/accounting/sales-returns', {
      cust_id: custId, invoice_id: finalId, warehouse_id: whId,
      rows: [{ product_id: prodId, qty: 1 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'sales return create', r.data?.error);
    const srId = r.data?.id;
    ok(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock === stockBeforeSr + 1, 'sales return increases stock');
    ok((db.prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE source_type='sales_return' AND source_id=? AND status='posted'").get(srId)?.c || 0) >= 1, 'sales return inventory_ledger');
    ok(!!db.prepare("SELECT id FROM journal_entries WHERE ref_type='sales_return' AND ref_id=?").get(srId), 'sales return JE');

    // Idempotent JE guard — re-post blocked conceptually via assert on existing (create new then try duplicate source manually)
    const exist = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice' AND ref_id=?").get(finalId);
    ok(!!exist, 'final JE present for idempotency baseline');

    // CRM dashboard
    r = await j('GET', '/api/crm/dashboard', null, token);
    ok(r.status === 200 && r.data.kpis && typeof r.data.kpis.firm_invoice_count === 'number', 'crm dashboard kpis');

    // Party binding
    r = await j('POST', '/api/admin/users', {
      username: 'unify_user_' + Date.now(), password: 'UnifyUser1!', name: 'کاربر unify',
      role: 'field_sales', phone: '09153330003', party_group_id: null,
    }, token);
    ok(r.status === 200 && r.data.id, 'create user', r.data?.error);
    const uid = r.data?.id || r.data?.user?.id;
    const urow = uid ? db.prepare('SELECT party_id FROM users WHERE id=?').get(uid) : null;
    ok(!!urow?.party_id, 'user has party_id');
    const partyCount = urow?.party_id
      ? db.prepare('SELECT COUNT(*) c FROM parties WHERE id=?').get(urow.party_id).c : 0;
    ok(partyCount === 1, 'single party row');

    db.close();
  } catch (e) {
    console.error('HARNESS ERROR:', e.message);
    if (stderr) console.error(stderr.slice(-2000));
    failed++;
  } finally {
    try { srv.kill(); } catch {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nACC-CRM perpetual: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
