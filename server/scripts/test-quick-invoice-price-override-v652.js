#!/usr/bin/env node
/**
 * v652 — quick-invoice price override.
 * POS price box must stay editable (click must not rebuild the cart), and a single
 * capability PATCH must grant price_override:edit / credit_override:approve without
 * wiping other user_permissions rows. Temp DB only. Never product 342 / code 7217.
 * Run: node server/scripts/test-quick-invoice-price-override-v652.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');
const bcrypt = require('bcryptjs');

const { ok, eq, summary } = require('./lib/test-harness');
const { swAtLeast } = require('./lib/sw-at-least');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function visibleFn(appSrc) {
  const start = appSrc.indexOf('function rbacCapabilityCellVisible');
  const end = appSrc.indexOf('function rbacMatrixRows');
  if (start < 0 || end < start) return null;
  try {
    return new Function(`${appSrc.slice(start, end)}\nreturn rbacCapabilityCellVisible;`)();
  } catch (_) {
    return null;
  }
}

if (process.env.QIP_DEVICE_CHILD === '1') {
  runDevice().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runMain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

async function runDevice() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qip-v652-dev-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.COMPANIES_DIR = path.join(dir, 'companies');
  process.env.SYNC_ROLE = 'device';
  process.env.JWT_SECRET = 'test-qip-v652-device-secret-32chars!!';
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.SMS_DISABLED = '1';
  delete process.env.APP_PLATFORM;
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB, closeDB } = require('../db');
  initDB();
  const db = getDB();
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'qip-dev', device_fingerprint: 'qip-dev-fp',
  }).token;
  const app = express();
  app.use(express.json());
  app.use('/api/rbac', require('../routes/rbac'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/rbac/matrix/' + admin.id + '/capability', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ resource: 'price_override', action: 'edit', allowed: true }),
  });
  const data = await res.json().catch(() => ({}));
  ok('device PATCH capability is centralOnly 403', res.status === 403 && /مرکزی|دسکتاپ/.test(String(data.error || '')));
  server.close();
  try { closeDB(); } catch (_) {}
  summary('v652 device');
}

async function runMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qip-v652-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.COMPANIES_DIR = path.join(dir, 'companies');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-qip-v652-secret-32-bytes-min!!';
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.SMS_DISABLED = '1';
  delete process.env.APP_PLATFORM;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

  delete require.cache[require.resolve('../db')];
  const { initDB, getDB, closeDB } = require('../db');
  initDB();
  const db = getDB();
  const { todayJalali } = require('../jalali');
  const { acct } = require('../lib/coa-map');
  const { rialToLedger } = require('../lib/money');
  const { customerLiveBalanceRial } = require('../lib/customer-books');
  const rbac = require('../lib/rbac');

  let server;
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const { issueStaffSession } = require('../lib/auth-sessions');
    const tokenFor = (u, tag) => issueStaffSession(db, u, {
      device_kind: 'test', device_name: 'qip-' + tag, device_fingerprint: 'qip-fp-' + tag,
    }).token;
    const cashCoa = '110101';
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
      .run(cashCoa, 'صندوق QIP', 'asset', '1101', 4);
    const cashBoxId = db.prepare("INSERT INTO cash_boxes (name, active, coa_code) VALUES ('صندوق QIP',1,?)").run(cashCoa).lastInsertRowid;
    const whId = db.prepare(`
      INSERT INTO warehouses (code, name, warehouse_type, active, allow_negative)
      VALUES ('WH-QIP','انبار QIP','finished_goods',1,1)
    `).run().lastInsertRowid;
    db.prepare('UPDATE users SET sales_warehouse_id=?, sales_cash_box_id=? WHERE id=?').run(whId, cashBoxId, admin.id);
    const mkUser = (username, role) => {
      const id = db.prepare(`
        INSERT INTO users (name, username, password, role, active, must_change_password, sales_warehouse_id, sales_cash_box_id)
        VALUES (?,?,?,?,1,0,?,?)
      `).run('کاربر ' + role, username, bcrypt.hashSync('Qip-test-9aZ', 10), role, whId, cashBoxId).lastInsertRowid;
      return db.prepare('SELECT id,username,role,name,phone,auth_epoch,sales_warehouse_id,sales_cash_box_id FROM users WHERE id=?').get(id);
    };
    const retU = mkUser('qip.store', 'store_retail');
    const salesU = mkUser('qip.field', 'field_sales');
    const distU = mkUser('qip.dist', 'distribution_office');
    const adminTok = tokenFor(admin, 'admin');
    const retTok = tokenFor(retU, 'ret');
    const salesTok = tokenFor(salesU, 'field');
    const distTok = tokenFor(distU, 'dist');

    db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)')
      .run(retU.id, 'inventory_negative', 'approve');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/rbac', require('../routes/rbac'));
    app.use('/api/store', require('../routes/store'));
    app.use('/api/invoices', require('../routes/invoices'));
    app.use('/api/settings', require('../routes/settings'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const BASE = `http://127.0.0.1:${server.address().port}`;
    async function api(method, p, body, tok) {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || adminTok) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
      return { status: res.status, data };
    }

    function leaf(code, name) {
      db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
        .run(code, name, 'asset', '1103', 4);
    }
    const mkCust = (biz, coa, ownerId) => {
      leaf(coa, biz);
      return db.prepare(`
        INSERT INTO customers (user_id, biz, owner, phone, status, type, coa_code)
        VALUES (?, ?, 'مالک', '0912000652', 'active', 'خرده', ?)
      `).run(ownerId || admin.id, biz, coa).lastInsertRowid;
    };
    const custId = mkCust('مشتری QIP', '110301000652');
    const creditCust = mkCust('مشتری نسیه QIP', '110301000653');
    const fieldCust = mkCust('مشتری میدانی QIP', '110301000654', salesU.id);
    const distCust = mkCust('مشتری پخش QIP', '110301000655', distU.id);
    const COST = 1000000;
    const LIST = 8000000;
    const OVR = 6500000;
    const mkProd = (name, code, price, minPrice) => {
      const pid = db.prepare(`
        INSERT INTO products (user_id, name, code, price, price_rial, retail_price, retail_price_rial, stock, vat_class, average_cost_rial, cost, warehouse_id, min_price_rial)
        VALUES (?, ?, ?, ?, ?, ?, ?, 500, 'exempt', ?, ?, ?, ?)
      `).run(admin.id, name, code, price, price, price, price, COST, COST, whId, minPrice || 0).lastInsertRowid;
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,500)').run(whId, pid);
      ok('synthetic product is not 342/7217', Number(pid) !== 342 && code !== '7217');
      return pid;
    };
    const prod = mkProd('کالای QIP', 'QIP-A', LIST, 5000000);
    const prod2 = mkProd('کالای QIP ب', 'QIP-B', LIST, 0);

    let seq = 0;
    const row = (pid, price) => ({ product_id: pid, qty: 1, price, unit_price: price, warehouse_id: whId });
    const sale = (rows, final, extra) => Object.assign({
      cust_id: custId, type: 'normal', date: todayJalali(), warehouse_id: whId, rows,
      client_request_id: 'qip-' + (++seq),
      pay_splits: [{ method: 'cash', amount: final, cash_box_id: cashBoxId }],
    }, extra || {});
    const invRows = (id) => JSON.parse(db.prepare('SELECT rows FROM invoices WHERE id=?').get(id).rows || '[]');
    const cap = (resource, action, allowed, tok) => api('PATCH', '/api/rbac/matrix/' + retU.id + '/capability', {
      resource, action, allowed,
    }, tok);

    console.log('\n— forbidden until a single capability grant —');
    const denied = await api('POST', '/api/store/quick-sale', sale([row(prod, OVR)], OVR), retTok);
    ok('store_retail price ≠ list → 403 E_PRICE_OVERRIDE_FORBIDDEN',
      denied.status === 403 && denied.data && denied.data.code === 'E_PRICE_OVERRIDE_FORBIDDEN');
    const same = await api('POST', '/api/store/quick-sale', sale([row(prod, LIST)], LIST), retTok);
    ok('store_retail at list price → 200', same.status === 200, same.data && same.data.error);

    const outsider = await cap('invoices', 'edit', true);
    ok('resource outside whitelist → 400', outsider.status === 400);
    const wrongAct = await cap('price_override', 'view', true);
    ok('price_override action other than edit → 400', wrongAct.status === 400);
    const asCashier = await cap('price_override', 'edit', true, retTok);
    ok('non-admin PATCH → 403', asCashier.status === 403);

    const granted = await cap('price_override', 'edit', true);
    ok('PATCH price_override:edit=true → 200', granted.status === 200 && granted.data && granted.data.permissions
      && granted.data.permissions.price_override && granted.data.permissions.price_override.edit === true,
      granted.data && granted.data.error);
    const kept = db.prepare("SELECT allowed FROM user_permissions WHERE user_id=? AND resource='inventory_negative' AND action='approve'").get(retU.id);
    ok('unrelated inventory_negative:approve row survives the PATCH', kept && Number(kept.allowed) === 1);
    const onlyEdit = db.prepare("SELECT action FROM user_permissions WHERE user_id=? AND resource='price_override'").all(retU.id).map((r) => r.action);
    ok('grant stores only the edit row', onlyEdit.length === 1 && onlyEdit[0] === 'edit', onlyEdit.join(','));
    const audCap = db.prepare("SELECT detail FROM audit_log WHERE entity='user_permissions' AND entity_id=? ORDER BY id DESC LIMIT 1").get(retU.id);
    ok('audit names the quick-sale capability', audCap && /دسترسی فروش سریع کاربر #/.test(audCap.detail || '') && /←/.test(audCap.detail || ''));

    const overridden = await api('POST', '/api/store/quick-sale', sale([row(prod, OVR)], OVR), retTok);
    ok('after grant, override → 200', overridden.status === 200 && Number(overridden.data && overridden.data.final) === OVR,
      overridden.data && (overridden.data.error || overridden.data.code));
    const ovrId = overridden.data && overridden.data.id;
    const ovrRow = ovrId ? invRows(ovrId)[0] : null;
    ok('line stores list_price_rial and price_overridden=1',
      ovrRow && ovrRow.list_price_rial === LIST && Number(ovrRow.price_overridden) === 1 && ovrRow.price === OVR);
    const aud = ovrId ? db.prepare("SELECT * FROM audit_log WHERE action='price_override' AND entity_id=?").get(ovrId) : null;
    const audD = aud ? JSON.parse(aud.detail || '{}') : {};
    ok('one price_override audit before→after',
      aud && aud.user_id === retU.id && audD.before_price_rial === LIST && audD.after_price_rial === OVR);

    const cogsCode = acct(db, 'coa_cogs').code;
    const cogsOf = (invId) => Math.round(Number(db.prepare(`
      SELECT COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) v FROM journal_lines jl
      JOIN journal_entries je ON je.id=jl.entry_id
      WHERE je.ref_id=? AND je.ref_type LIKE 'invoice%' AND COALESCE(je.deleted_at,0)=0
        AND (jl.account_code=? OR jl.account_code LIKE ?)
    `).get(invId, cogsCode, cogsCode + '%').v) || 0);
    const twin = await api('POST', '/api/store/quick-sale', sale([row(prod2, LIST)], LIST), retTok);
    ok('list-price twin → 200', twin.status === 200, twin.data && twin.data.error);
    const cogsOvr = ovrId ? cogsOf(ovrId) : -1;
    const cogsList = twin.data && twin.data.id ? cogsOf(twin.data.id) : -2;
    ok('COGS follows kardex cost, not the overridden price',
      cogsOvr > 0 && cogsOvr === cogsList && cogsOvr === Math.round(rialToLedger(COST)), { cogsOvr, cogsList });
    const ar = ovrId ? db.prepare(`
      SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) v FROM customer_ledger
      WHERE customer_id=? AND ref_id=?
    `).get(custId, ovrId) : { v: -1 };
    ok('customer ledger follows the overridden price', Math.round(Number(ar.v) || 0) === 0 || Math.round(Number(ar.v) || 0) === OVR,
      String(ar.v));
    // Cash sale settles AR, so the net customer book for this invoice is 0.
    // The invoice final itself is the overridden price (asserted above). A credit sale checks the live balance.

    const beforeBal = customerLiveBalanceRial(db, creditCust);
    const creditSale = await api('POST', '/api/store/quick-sale', sale([row(prod, OVR)], OVR, {
      cust_id: creditCust, pay_type: 'credit', pay_splits: undefined,
    }), retTok);
    ok('credit POS with overridden price → 200', creditSale.status === 200, creditSale.data && (creditSale.data.error || creditSale.data.code));
    const afterBal = customerLiveBalanceRial(db, creditCust);
    eq('v649 live balance grows by the overridden unpaid amount', afterBal - beforeBal, OVR);

    const revoked = await cap('price_override', 'edit', false);
    ok('PATCH allowed=false → 200 and edit is off', revoked.status === 200 && revoked.data
      && revoked.data.permissions && revoked.data.permissions.price_override.edit === false);
    const kept2 = db.prepare("SELECT COUNT(*) n FROM user_permissions WHERE user_id=? AND resource='inventory_negative' AND action='approve'").get(retU.id);
    ok('revoke still keeps the unrelated override', kept2 && kept2.n === 1);
    const deniedAgain = await api('POST', '/api/store/quick-sale', sale([row(prod, OVR)], OVR), retTok);
    ok('after revoke, price ≠ list → 403 again', deniedAgain.status === 403 && deniedAgain.data.code === 'E_PRICE_OVERRIDE_FORBIDDEN');

    console.log('\n— floor —');
    await cap('price_override', 'edit', true);
    const warn = await api('POST', '/api/store/quick-sale', sale([row(prod, 4000000)], 4000000), retTok);
    const wMin = warn.data && Array.isArray(warn.data.warnings) ? warn.data.warnings.find((w) => w.code === 'W_PRICE_BELOW_MIN') : null;
    ok('warn: override below min_price_rial → 200 + warning', warn.status === 200 && !!wMin, warn.data && (warn.data.error || warn.data.code));
    const setBlock = await api('PUT', '/api/settings', { store_price_floor_mode: 'block' });
    ok('admin sets floor mode block', setBlock.status === 200);
    const blocked = await api('POST', '/api/store/quick-sale', sale([row(prod, 4000000)], 4000000), retTok);
    ok('block: override below min → 422 E_PRICE_BELOW_FLOOR', blocked.status === 422 && blocked.data.code === 'E_PRICE_BELOW_FLOOR', blocked.data);
    await api('PUT', '/api/settings', { store_price_floor_mode: 'warn' });

    console.log('\n— regular builder is not gated —');
    const fieldFirm = await api('POST', '/api/invoices', {
      cust_id: fieldCust, type: 'normal', date: todayJalali(), warehouse_id: whId, vat_exempt: 1,
      client_request_id: 'qip-field-firm-' + (++seq),
      rows: [row(prod2, 4321000)],
    }, salesTok);
    ok('field_sales still cannot post a firm invoice (unchanged)',
      fieldFirm.status === 403 && fieldFirm.data && fieldFirm.data.code === 'E_SALES_PROFORMA_ONLY');
    const fieldInv = await api('POST', '/api/invoices', {
      cust_id: fieldCust, type: 'proforma', date: todayJalali(), warehouse_id: whId, vat_exempt: 1,
      client_request_id: 'qip-field-' + (++seq),
      rows: [row(prod2, 4321000)],
    }, salesTok);
    ok('field_sales proforma with a custom price → 200 (builder is not price_override)',
      fieldInv.status === 200, fieldInv.data && (fieldInv.data.error || fieldInv.data.code));
    const distInv = await api('POST', '/api/invoices', {
      cust_id: distCust, type: 'normal', date: todayJalali(), warehouse_id: whId, vat_exempt: 1,
      pay_type: 'cash', cash_box_id: cashBoxId,
      client_request_id: 'qip-dist-' + (++seq),
      rows: [row(prod2, 4321000)],
      pay_splits: [{ method: 'cash', amount: 4321000, cash_box_id: cashBoxId }],
    }, distTok);
    ok('distribution_office firm invoice with a custom price → 200',
      distInv.status === 200, distInv.data && (distInv.data.error || distInv.data.code));
    const noGate = [fieldInv, distInv].every((inv) => {
      if (!inv.data || !inv.data.id) return false;
      const n = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='price_override' AND entity_id=?").get(inv.data.id);
      return n && n.n === 0;
    });
    ok('regular builder does not write a price_override audit', noGate);

    console.log('\n— static UI —');
    const appSrc = read('public/app.js');
    const sw = read('public/sw.js');
    const idx = read('public/index.html');
    const editable = (appSrc.split('inputmode="numeric" class="money pos-price-input"')[1] || '').split('is-readonly')[0];
    ok('editable price input stops click and mousedown',
      /data-csp-click=/.test(editable) && /data-csp-mousedown=/.test(editable) && /stopPropagation/.test(editable));
    ok('row select does not re-render while a cart input is focused',
      appSrc.includes('function storeQsSelectLine') && appSrc.includes(".pos-cart-table input"));
    ok('user modal quick-sale box ids exist',
      appSrc.includes('id="u-pos-caps"') && appSrc.includes('id="u-pos-price-override"') && appSrc.includes('id="u-pos-credit-override"'));
    ok('readonly price click explains where to grant the permission',
      appSrc.includes('تغییر فی نیازمند مجوز «تغییر قیمت فروش» است — از مدیر بخواهید در تنظیمات › کاربران › دسترسی فروش سریع فعال کند'));
    ok('help mentions تغییر فی', appSrc.includes('تغییر فی'));
    const vis = visibleFn(appSrc);
    ok('capability cell helper loads', typeof vis === 'function');
    if (typeof vis === 'function') {
      ok('price_override shows only edit when the flag matches the role default',
        vis('price_override', 'edit', { edit: false }, { edit: false }) === true
        && vis('price_override', 'view', { view: false }, { view: false }) === false
        && vis('price_override', 'approve', { approve: false }, { approve: false }) === false);
      ok('a stored non-default price_override action stays visible (user #25)',
        vis('price_override', 'view', { view: true }, { view: false }) === true
        && vis('price_override', 'export', { export: true }, { export: false }) === true);
      ok('credit_override shows only approve when it matches the default',
        vis('credit_override', 'approve', { approve: false }, { approve: false }) === true
        && vis('credit_override', 'edit', { edit: false }, { edit: false }) === false);
      ok('hidden capability cells render an em dash', appSrc.includes('rbac-cap-na') && appSrc.includes('—'));
    }
    ok('matrix group title فروش سریع (صندوق)', appSrc.includes('فروش سریع (صندوق)'));
    ok('sw >= 652', swAtLeast(sw, 652));
    ok('index app.js?v=652', idx.includes('app.js?v=652'));
    let parsed = false;
    try { new Function(appSrc); parsed = true; } catch (e) { ok('app.js parses', false, e.message); }
    if (parsed) ok('app.js parses', true);

    const defaults = rbac.fillRoleDefaults('store_retail', db);
    ok('store_retail default price_override.edit stays off', !(defaults.price_override && defaults.price_override.edit));
    ok('admin/accounting/sales_manager defaults unchanged',
      rbac.fillRoleDefaults('admin', db).price_override.edit === true
      && rbac.fillRoleDefaults('accounting', db).price_override.edit === true
      && rbac.fillRoleDefaults('sales_manager', db).price_override.edit === true);

    console.log('\n— device role —');
    const child = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, {
        QIP_DEVICE_CHILD: '1',
        SYNC_ROLE: 'device',
        DB_PATH: path.join(dir, 'device.db'),
        AUTH_SESSION_DB_PATH: path.join(dir, 'device-sessions.db'),
      }),
      encoding: 'utf8',
      timeout: 120000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    ok('device child exited 0', child.status === 0, 'exit ' + child.status);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { closeDB(); } catch (_) {}
  }
  summary('v652 quick-invoice-price-override');
}
