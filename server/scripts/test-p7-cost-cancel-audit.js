'use strict';
/**
 * P7-fix — full cycle create → cost → uncost → cancel for qty-only receipts (R13 + audit).
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-p7-cost-cancel-audit.js
 *
 * Per step: live GL balance per account, kardex qty/value, supplier sub-ledger + payable leaf,
 * receipt status / costing_status / cost_pending, audit_log rows (entity qty_receipt), and every
 * cashier response free of monetary keys. Also: a failing GRNI unlink rolls back the whole purchase
 * void (no half-reversed JE), and audit amounts are reachable only through admin-only APIs.
 */
const { ok, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ P7-fix cost / cancel / audit ══\n');

(async () => {
  const { db, cleanup } = freshDb();
  const { acct } = require('../lib/coa-map');
  const { buildLedgerValuationRows } = require('../lib/inventory/valuation');
  const { createWarehouseDoc } = require('../lib/warehouse-docs');
  const grniMod = require('../lib/warehouse-grni-invoice');

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  for (const [id, username, role] of [[301, 'p7f_cashier', 'store_retail'], [302, 'p7f_acc', 'accounting']]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)')
      .run(id, username, 'x', username, role);
  }
  db.prepare('UPDATE users SET must_change_password=0').run();
  const adminId = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || { id: 1 }).id;

  const cc = db.prepare("INSERT INTO cost_centers (code,name,active) VALUES ('CC-P7F','CC P7F',1)").run().lastInsertRowid;
  const wh = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system,active)
    VALUES ('فروشگاه P7F','WH-P7F','distribution_office','finished_goods',?,0,0,'perpetual',1)
  `).run(cc).lastInsertRowid;
  const pA = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'مانتو P7F','P7F-A',900000,50000,0,'عدد',?,50000)
  `).run(adminId, wh).lastInsertRowid;
  const pB = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'شال P7F','P7F-B',300000,0,0,'عدد',?,0)
  `).run(adminId, wh).lastInsertRowid;
  const sup = db.prepare("INSERT INTO suppliers (name,phone) VALUES ('تأمین‌کننده P7F','09120000077')").run().lastInsertRowid;

  // Opening stock for A so "back to original" is a non-zero baseline.
  createWarehouseDoc(db, {
    type: 'receipt', receipt_class: 'opening', warehouse_id: wh, date: '1405/08/01',
    lines: [{ product_id: pA, qty: 10, unit_cost_rial: 50000 }],
  }, { id: adminId, role: 'admin' });

  const kardex = (productId) => {
    const r = buildLedgerValuationRows(db, { warehouseId: wh }).rows
      .find((x) => Number(x.product_id) === Number(productId) && Number(x.warehouse_id) === Number(wh));
    return { qty: r ? Number(r.ledger_qty) : 0, value: r ? Number(r.ledger_value_rial) : 0 };
  };
  const glSnap = () => {
    const m = {};
    for (const r of db.prepare(`
      SELECT l.account_code AS c, SUM(COALESCE(l.debit_rial,0)-COALESCE(l.credit_rial,0)) AS b
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE COALESCE(e.status,'') NOT IN ('reversed','void') AND COALESCE(e.deleted_at,0)=0
      GROUP BY l.account_code
    `).all()) {
      if (Math.round(Number(r.b) || 0)) m[r.c] = Math.round(Number(r.b));
    }
    return m;
  };
  const glDiff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => (a[k] || 0) !== (b[k] || 0))
    .map((k) => `${k}:${a[k] || 0}→${b[k] || 0}`);
  const supplierBal = () => Number(db.prepare(
    'SELECT COALESCE(SUM(COALESCE(credit,0)-COALESCE(debit,0)),0) AS s FROM supplier_ledger WHERE supplier_id=?',
  ).get(sup).s);
  const auditRows = (docId) => db.prepare(
    "SELECT action, user_id, detail FROM audit_log WHERE entity='qty_receipt' AND entity_id=? ORDER BY id",
  ).all(docId);
  const docRow = (id) => db.prepare('SELECT status, purchase_invoice_id, cost_pending, je_id FROM warehouse_docs WHERE id=?').get(id);

  // ── HTTP app ──────────────────────────────────────────────────────────────
  const express = require('express');
  const http = require('http');
  const CV = require('../lib/cost-visibility');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p7f-' + tag, device_fingerprint: 'p7f-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), cashier: tokenFor(301, 'cashier'), acc: tokenFor(302, 'acc') };
  const app = express();
  app.use(express.json());
  for (const prefix of ['/api/warehouses', '/api/purchases', '/api/inventory']) app.use(prefix, CV.costVisibilityStrip());
  app.use('/api/warehouses/qty-receipts', require('../routes/qty-receipts'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  app.use('/api/purchases', require('../routes/procurement'));
  app.use('/api/purchases', require('../routes/purchases'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/activity-log', require('../routes/activity-log'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who) {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json };
  }
  const MONEY_KEY = /cost|price|amount|rial|value|margin|profit|cogs|landed|final|subtotal|vat|disc|sum|total_value|provisional|je_id|detail/i;
  const SAFE_KEY = /^(qty_total|line_count|costing_status)$/;
  const moneyKeys = (json) => {
    const out = new Set();
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (MONEY_KEY.test(k) && !SAFE_KEY.test(k)) out.add(k);
          walk(v);
        }
      }
    };
    walk(json);
    return [...out];
  };
  const cashierLeaks = [];
  const cashierView = async (id, step) => {
    const g = await api('GET', `/api/warehouses/qty-receipts/${id}`, null, 'cashier');
    const l = await api('GET', '/api/warehouses/qty-receipts?include_reversed=1', null, 'cashier');
    const leak = [...moneyKeys(g.json), ...moneyKeys(l.json)];
    if (g.status !== 200 || l.status !== 200 || leak.length) cashierLeaks.push(`${step}:${g.status}/${l.status}:${leak.join(',')}`);
    return g.json;
  };

  /**
   * One full cycle. price → unit price at costing; vat → VAT exempt or not.
   * Returns nothing; asserts each transition against the pre-receipt baseline.
   */
  async function cycle(label, productId, qty, price, { vatExempt, expectPending }) {
    console.log(`— ${label} —`);
    const gl0 = glSnap();
    const k0 = kardex(productId);
    const sup0 = supplierBal();
    const piCount0 = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;

    // create (cashier)
    const c = await api('POST', '/api/warehouses/qty-receipts', {
      warehouse_id: wh, supplier_id: sup, date: '1405/08/10', lines: [{ product_id: productId, qty, unit_cost_rial: 1 }],
    }, 'cashier');
    ok(`${label}: cashier create → 200 without money keys`, c.status === 200 && c.json.id && moneyKeys(c.json).length === 0,
      JSON.stringify(c.json).slice(0, 200));
    const id = c.json.id;
    const dCreated = docRow(id);
    ok(`${label}: created posted, awaiting costing, cost_pending=${expectPending}`,
      dCreated.status === 'posted' && dCreated.purchase_invoice_id == null && Number(dCreated.cost_pending) === expectPending,
      JSON.stringify(dCreated));
    const cv1 = await cashierView(id, `${label}/created`);
    ok(`${label}: cashier sees costing_status=awaiting_costing`, cv1 && cv1.costing_status === 'awaiting_costing');
    const kC = kardex(productId);
    ok(`${label}: kardex qty +${qty}`, kC.qty === k0.qty + qty, JSON.stringify(kC));

    // cost (accounting)
    const g = await api('GET', `/api/warehouses/qty-receipts/${id}`, null, 'acc');
    const cost = await api('POST', `/api/warehouses/qty-receipts/${id}/cost`, {
      rows: [{ move_id: g.json.lines[0].move_id, price }], vat_exempt: vatExempt ? 1 : 0, date: '1405/08/11',
    }, 'acc');
    ok(`${label}: accounting cost → purchase invoice`, cost.status === 200 && cost.json.purchase_invoice_id, JSON.stringify(cost.json).slice(0, 200));
    const piId = cost.json.purchase_invoice_id;
    const pi = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(piId);
    const goods = qty * price;
    const vat = vatExempt ? 0 : Math.round(goods * 0.1);
    ok(`${label}: purchase final = ${goods + vat} (VAT ${vat}), stock_added=0`,
      Number(pi.final) === goods + vat && Number(pi.vat_amount) === vat && Number(pi.stock_added) === 0, JSON.stringify({ f: pi.final, v: pi.vat_amount }));
    const dCosted = docRow(id);
    ok(`${label}: costed → linked + cost_pending=0`, Number(dCosted.purchase_invoice_id) === Number(piId) && Number(dCosted.cost_pending) === 0,
      JSON.stringify(dCosted));
    const kCost = kardex(productId);
    ok(`${label}: kardex value = original + qty × price`, kCost.qty === k0.qty + qty && kCost.value === k0.value + goods, JSON.stringify(kCost));
    ok(`${label}: supplier sub-ledger +${goods + vat}`, supplierBal() === sup0 + goods + vat, `${sup0}→${supplierBal()}`);
    const gl1 = glSnap();
    const payCode = acct(db, 'coa_payable').code;
    ok(`${label}: GL payable credited ${goods + vat}`, (gl1[payCode] || 0) - (gl0[payCode] || 0) === -(goods + vat),
      glDiff(gl0, gl1).join(' '));
    ok(`${label}: GL GRNI net zero after costing`, (gl1[acct(db, 'coa_grni').code] || 0) === (gl0[acct(db, 'coa_grni').code] || 0),
      glDiff(gl0, gl1).join(' '));
    const cv2 = await cashierView(id, `${label}/costed`);
    ok(`${label}: cashier sees costing_status=costed`, cv2 && cv2.costing_status === 'costed');
    const vBlocked = await api('POST', `/api/warehouses/qty-receipts/${id}/void`, {}, 'acc');
    ok(`${label}: receipt cancel while costed → 400 E_WH_GRNI_LINKED`, vBlocked.status === 400 && vBlocked.json.code === 'E_WH_GRNI_LINKED');

    // uncost = void purchase invoice
    const unc = await api('DELETE', `/api/purchases/${piId}`, null, 'acc');
    ok(`${label}: uncost (purchase void) → 200`, unc.status === 200, JSON.stringify(unc.json));
    const dUnc = docRow(id);
    ok(`${label}: back to awaiting costing, cost_pending=${expectPending} restored`,
      dUnc.status === 'posted' && dUnc.purchase_invoice_id == null && Number(dUnc.cost_pending) === expectPending, JSON.stringify(dUnc));
    const piU = db.prepare('SELECT status, reversal_journal_id FROM purchase_invoices WHERE id=?').get(piId);
    ok(`${label}: purchase invoice reversed (no physical delete)`, piU && piU.status === 'reversed');
    const kUnc = kardex(productId);
    ok(`${label}: kardex value back to provisional`, kUnc.qty === kC.qty && kUnc.value === kC.value, `${JSON.stringify(kC)} vs ${JSON.stringify(kUnc)}`);
    const revalLive = db.prepare(`
      SELECT COUNT(*) c FROM inventory_ledger
      WHERE source_type='warehouse_grni_reval' AND source_id=? AND COALESCE(status,'posted')='posted'
        AND COALESCE(event_type,'')<>'reversal'
    `).get(piId).c;
    ok(`${label}: no live value-only kardex row left`, revalLive === 0, revalLive);
    ok(`${label}: supplier balance back`, supplierBal() === sup0, `${sup0}→${supplierBal()}`);
    const cv3 = await cashierView(id, `${label}/uncosted`);
    ok(`${label}: cashier sees awaiting_costing again`, cv3 && cv3.costing_status === 'awaiting_costing');

    // cancel receipt
    const v = await api('POST', `/api/warehouses/qty-receipts/${id}/void`, { reason: 'P7-fix test' }, 'acc');
    ok(`${label}: receipt cancel → 200`, v.status === 200, JSON.stringify(v.json));
    const dV = docRow(id);
    ok(`${label}: receipt reversed`, dV.status === 'reversed', JSON.stringify(dV));
    const cv4 = await cashierView(id, `${label}/reversed`);
    ok(`${label}: cashier sees costing_status=reversed`, cv4 && cv4.costing_status === 'reversed');
    const kV = kardex(productId);
    ok(`${label}: kardex qty/value back to original`, kV.qty === k0.qty && kV.value === k0.value, `${JSON.stringify(k0)} vs ${JSON.stringify(kV)}`);
    const gl2 = glSnap();
    const diff = glDiff(gl0, gl2);
    ok(`${label}: GL net zero on every account`, diff.length === 0, diff.join(' '));
    ok(`${label}: supplier balance = original`, supplierBal() === sup0);
    ok(`${label}: physical rows kept (moves + purchase)`,
      db.prepare('SELECT COUNT(*) c FROM warehouse_moves WHERE doc_id=?').get(id).c === 1
      && db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c === piCount0 + 1);

    // audit
    const au = auditRows(id);
    ok(`${label}: audit create → cost → cost_reverse → reverse`,
      au.map((r) => r.action).join(',') === 'create,cost,cost_reverse,reverse', au.map((r) => r.action).join(','));
    ok(`${label}: audit users = cashier, acc, acc, acc`, au.map((r) => r.user_id).join(',') === '301,302,302,302', au.map((r) => r.user_id).join(','));
    const costRow = au.find((r) => r.action === 'cost');
    ok(`${label}: cost audit carries purchase num/id and amount`,
      costRow && costRow.detail.includes(pi.num) && costRow.detail.includes(`#${piId}`) && costRow.detail.includes(String(goods + vat)), costRow && costRow.detail);
    const unRow = au.find((r) => r.action === 'cost_reverse');
    ok(`${label}: cost_reverse audit carries purchase id + reversal`, unRow && unRow.detail.includes(`#${piId}`) && unRow.detail.includes(String(goods + vat)), unRow && unRow.detail);
    const purAu = db.prepare("SELECT action FROM audit_log WHERE entity='purchase' AND entity_id=? ORDER BY id").all(piId).map((r) => r.action).join(',');
    ok(`${label}: purchase audit create + reverse`, purAu === 'create,reverse', purAu);
    return id;
  }

  try {
    const glStart = glSnap();
    const kAStart = kardex(pA);
    const r1 = await cycle('A avg>0 + VAT', pA, 4, 60000, { vatExempt: false, expectPending: 0 });
    await cycle('B avg=0 (cost_pending)', pB, 3, 30000, { vatExempt: true, expectPending: 1 });
    ok('whole run: GL unchanged from start', glDiff(glStart, glSnap()).length === 0, glDiff(glStart, glSnap()).join(' '));
    ok('whole run: product A kardex = opening 10 × 50000', JSON.stringify(kardex(pA)) === JSON.stringify(kAStart) && kAStart.value === 500000,
      JSON.stringify(kardex(pA)));
    ok('cashier never received a monetary key (all steps)', cashierLeaks.length === 0, cashierLeaks.join(' | '));

    // ── atomic uncost: a failing GRNI unlink must roll back the whole purchase void ──
    console.log('— atomic uncost —');
    const c = await api('POST', '/api/warehouses/qty-receipts', {
      warehouse_id: wh, supplier_id: sup, date: '1405/08/12', lines: [{ product_id: pA, qty: 2 }],
    }, 'cashier');
    const id = c.json.id;
    const g = await api('GET', `/api/warehouses/qty-receipts/${id}`, null, 'acc');
    const cost = await api('POST', `/api/warehouses/qty-receipts/${id}/cost`, {
      rows: [{ move_id: g.json.lines[0].move_id, price: 70000 }], vat_exempt: 1, date: '1405/08/12',
    }, 'acc');
    const piId = cost.json.purchase_invoice_id;
    const glC = glSnap();
    const kCx = kardex(pA);
    const supC = supplierBal();
    const auditN = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
    const orig = grniMod.unlinkWarehouseGrniOnPurchaseVoid;
    grniMod.unlinkWarehouseGrniOnPurchaseVoid = () => { throw Object.assign(new Error('simulated unlink failure'), { status: 500 }); };
    let bad;
    try { bad = await api('DELETE', `/api/purchases/${piId}`, null, 'acc'); }
    finally { grniMod.unlinkWarehouseGrniOnPurchaseVoid = orig; }
    ok('failing unlink → error response (not ok)', bad.status >= 400 && bad.json && /simulated/.test(bad.json.error || ''), JSON.stringify(bad.json));
    ok('purchase still live after failed void', db.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(piId).status !== 'reversed');
    ok('receipt still linked after failed void', Number(docRow(id).purchase_invoice_id) === Number(piId));
    ok('GL / kardex / supplier untouched by failed void',
      glDiff(glC, glSnap()).length === 0 && JSON.stringify(kardex(pA)) === JSON.stringify(kCx) && supplierBal() === supC, glDiff(glC, glSnap()).join(' '));
    ok('no audit row from the rolled-back void', db.prepare('SELECT COUNT(*) c FROM audit_log').get().c === auditN);
    const okVoid = await api('DELETE', `/api/purchases/${piId}`, null, 'acc');
    ok('retry void succeeds after restore', okVoid.status === 200 && docRow(id).purchase_invoice_id == null);
    await api('POST', `/api/warehouses/qty-receipts/${id}/void`, {}, 'acc');

    // ── audit exposure ───────────────────────────────────────────────────────
    console.log('— audit exposure —');
    const cAudit = await api('GET', '/api/admin/audit?entity=qty_receipt', null, 'cashier');
    ok('cashier /api/admin/audit → 403', cAudit.status === 403, cAudit.status);
    const cAct = await api('GET', '/api/activity-log', null, 'cashier');
    ok('cashier /api/activity-log → 403', cAct.status === 403, cAct.status);
    const aAudit = await api('GET', '/api/admin/audit?entity=qty_receipt', null, 'acc');
    ok('non-admin accounting /api/admin/audit → 403', aAudit.status === 403, aAudit.status);
    const adAudit = await api('GET', `/api/admin/audit?entity=qty_receipt&limit=200`, null, 'admin');
    ok('admin (cost_visibility) sees qty_receipt audit incl. amounts',
      adAudit.status === 200 && adAudit.json.rows.some((r) => Number(r.entity_id) === r1 && r.action === 'cost' && /ریال/.test(r.detail)),
      adAudit.status);
    const { SYNCABLE_TABLES } = require('../sync/tables');
    const names = (SYNCABLE_TABLES || []).map((t) => t.name || t);
    ok('audit_log / user_activity_log are not synced to devices', !names.includes('audit_log') && !names.includes('user_activity_log'));
  } finally {
    await new Promise((rs) => server.close(rs));
  }

  cleanup();
  summary('P7-fix cost/cancel/audit');
})().catch((e) => { console.error(e); process.exit(1); });
