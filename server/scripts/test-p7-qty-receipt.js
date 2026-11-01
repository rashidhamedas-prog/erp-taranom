'use strict';
/**
 * P7 — qty-only supplier receipt (cashier) + costing (accountant).
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-p7-qty-receipt.js
 *
 * Covers: RBAC defaults, cashier receipt via HTTP (client cost ignored, provisional = avg or 0 +
 * cost_pending), GRNI JE only when value>0, cashier never receives a monetary key (list / get /
 * create / after costing / neighbouring APIs), costing → purchase invoice + kardex value = price,
 * guards (missing price, double costing, void while costed, SOD), R13 un-cost (purchase void) and
 * receipt void (kardex + JE fully reversed), sync path map, wiring gates.
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ P7 qty-only receipt + costing ══\n');

(async () => {
  const { db, cleanup } = freshDb();
  const { hasPermission } = require('../lib/rbac');
  const { acct } = require('../lib/coa-map');
  const { buildLedgerValuationRows } = require('../lib/inventory/valuation');
  const QR = require('../lib/inventory/qty-receipt');

  // ── seed ──────────────────────────────────────────────────────────────────
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  for (const [id, username, role] of [
    [201, 'p7_cashier', 'store_retail'], [202, 'p7_acc', 'accounting'], [203, 'p7_fs', 'field_sales'],
    [204, 'p7_acc2', 'accounting'],
  ]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)')
      .run(id, username, 'x', username, role);
  }
  db.prepare('UPDATE users SET must_change_password=0').run();
  const adminId = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || { id: 1 }).id;
  const U = (id, role) => ({ id, role });
  const cashier = U(201, 'store_retail');
  const accUser = U(202, 'accounting');

  const cc = db.prepare("INSERT INTO cost_centers (code,name,active) VALUES ('CC-P7','CC P7',1)").run().lastInsertRowid;
  const wh = db.prepare(`
    INSERT INTO warehouses (name,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,inventory_system,active)
    VALUES ('فروشگاه P7','WH-P7','distribution_office','finished_goods',?,0,0,'perpetual',1)
  `).run(cc).lastInsertRowid;
  const pA = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'مانتو P7','P7-A',900000,50000,0,'عدد',?,50000)
  `).run(adminId, wh).lastInsertRowid;
  const pB = db.prepare(`
    INSERT INTO products (user_id,name,code,price,cost,stock,unit,warehouse_id,average_cost_rial)
    VALUES (?,'شال P7','P7-B',300000,0,0,'عدد',?,0)
  `).run(adminId, wh).lastInsertRowid;
  const sup = db.prepare("INSERT INTO suppliers (name,phone) VALUES ('تأمین‌کننده P7','09120000007')").run().lastInsertRowid;

  const kardex = (productId) => {
    const r = buildLedgerValuationRows(db, { warehouseId: wh }).rows
      .find((x) => Number(x.product_id) === Number(productId) && Number(x.warehouse_id) === Number(wh));
    return { qty: r ? Number(r.ledger_qty) : 0, value: r ? Number(r.ledger_value_rial) : 0 };
  };

  // ── 1) RBAC ───────────────────────────────────────────────────────────────
  console.log('— 1) RBAC —');
  ok('cashier has qty_receipt:create', hasPermission(db, cashier, 'qty_receipt', 'create'));
  ok('cashier has qty_receipt:view', hasPermission(db, cashier, 'qty_receipt', 'view'));
  ok('cashier has NO qty_receipt:delete (void = accounting)', !hasPermission(db, cashier, 'qty_receipt', 'delete'));
  ok('cashier has NO cost_visibility / acc_purchases:create',
    !hasPermission(db, cashier, 'cost_visibility', 'view') && !hasPermission(db, cashier, 'acc_purchases', 'create'));
  ok('accounting has qty_receipt view/create/delete',
    ['view', 'create', 'delete'].every((a) => hasPermission(db, accUser, 'qty_receipt', a)));
  ok('accounting can cost (cost_visibility:view + acc_purchases:create)',
    hasPermission(db, accUser, 'cost_visibility', 'view') && hasPermission(db, accUser, 'acc_purchases', 'create'));
  ok('field_sales has NO qty_receipt', !hasPermission(db, U(203, 'field_sales'), 'qty_receipt', 'create'));

  // ── HTTP app ──────────────────────────────────────────────────────────────
  const express = require('express');
  const http = require('http');
  const CV = require('../lib/cost-visibility');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p7-' + tag, device_fingerprint: 'p7-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), cashier: tokenFor(201, 'cashier'), acc: tokenFor(202, 'acc'), fs: tokenFor(203, 'fs') };
  const app = express();
  app.use(express.json());
  for (const prefix of ['/api/warehouses', '/api/purchases', '/api/inventory', '/api/products']) app.use(prefix, CV.costVisibilityStrip());
  app.use('/api/warehouses/qty-receipts', require('../routes/qty-receipts'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  app.use('/api/purchases', require('../routes/procurement'));
  app.use('/api/purchases', require('../routes/purchases'));
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/products', require('../routes/products'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who) {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json, redacted: res.headers.get('x-cost-redacted') };
  }
  // Any key that could carry money (cost, price, amount, rial value, totals, VAT, margin…).
  const MONEY_KEY = /cost|price|amount|rial|value|margin|profit|cogs|landed|final|subtotal|vat|disc|sum|total_value|provisional/i;
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

  try {
    // ── 2) cashier receipt with average cost ────────────────────────────────
    console.log('— 2) cashier receipt (avg cost, client cost ignored) —');
    const opt = await api('GET', '/api/warehouses/qty-receipts/options', null, 'cashier');
    ok('cashier options 200 with warehouse + supplier, no money keys',
      opt.status === 200 && opt.json.warehouses.some((w) => w.id === wh) && opt.json.suppliers.some((s) => s.id === sup)
      && moneyKeys(opt.json).length === 0, JSON.stringify(opt.json).slice(0, 200));
    const look = await api('GET', '/api/warehouses/qty-receipts/products?q=P7', null, 'cashier');
    ok('cashier product picker finds products, no money keys',
      look.status === 200 && Array.isArray(look.json) && look.json.some((p) => p.id === pA) && moneyKeys(look.json).length === 0,
      JSON.stringify(look.json).slice(0, 200));

    const c1 = await api('POST', '/api/warehouses/qty-receipts', {
      warehouse_id: wh, supplier_id: sup, date: '1405/08/10', note: 'بار صبح',
      lines: [{ product_id: pA, qty: 4, unit_cost_rial: 999999, amount_rial: 1, price: 7 }],
    }, 'cashier');
    ok('cashier POST receipt → 200', c1.status === 200 && c1.json.id, JSON.stringify(c1.json).slice(0, 300));
    ok('create response has NO money keys', moneyKeys(c1.json).length === 0, moneyKeys(c1.json).join(','));
    const r1 = c1.json.id;
    const d1 = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(r1);
    ok('doc: receipt / grni / qty_only=1 / cost_pending=0 / supplier',
      d1.type === 'receipt' && d1.receipt_class === 'grni' && Number(d1.qty_only) === 1 && Number(d1.cost_pending) === 0 && Number(d1.supplier_id) === sup,
      JSON.stringify(d1));
    ok('provisional value = current average (client cost ignored)', Number(d1.amount_rial_total) === 4 * 50000, d1.amount_rial_total);
    const k1 = kardex(pA);
    ok('kardex: qty 4, value 200000 (provisional)', k1.qty === 4 && k1.value === 200000, JSON.stringify(k1));
    ok('GRNI JE posted (Dr inventory / Cr GRNI) at provisional value', !!d1.je_id);
    const grniCr = db.prepare('SELECT COALESCE(SUM(credit_rial),0) s FROM journal_lines WHERE entry_id=? AND account_code=?')
      .get(d1.je_id, acct(db, 'coa_grni').code).s;
    ok('receipt JE credits GRNI 200000', Number(grniCr) === 200000, grniCr);

    // ── 3) zero-average product → cost_pending, no JE ───────────────────────
    console.log('— 3) zero average → cost_pending —');
    const c2 = await api('POST', '/api/warehouses/qty-receipts', {
      warehouse_id: wh, supplier_id: sup, date: '1405/08/10', lines: [{ product_id: pB, qty: 3 }],
    }, 'cashier');
    const r2 = c2.json && c2.json.id;
    const d2 = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(r2);
    ok('cost_pending=1 and amount 0', d2 && Number(d2.cost_pending) === 1 && Number(d2.amount_rial_total) === 0, JSON.stringify(d2));
    ok('no JE when provisional value is 0', d2 && !d2.je_id);
    const k2 = kardex(pB);
    ok('kardex: qty 3, value 0', k2.qty === 3 && k2.value === 0, JSON.stringify(k2));

    // ── 4) validation ───────────────────────────────────────────────────────
    console.log('— 4) validation —');
    const noSup = await api('POST', '/api/warehouses/qty-receipts', { warehouse_id: wh, lines: [{ product_id: pA, qty: 1 }] }, 'cashier');
    ok('supplier required → 400', noSup.status === 400 && noSup.json.code === 'E_QTY_RECEIPT_SUPPLIER');
    const fsTry = await api('POST', '/api/warehouses/qty-receipts', { warehouse_id: wh, supplier_id: sup, lines: [{ product_id: pA, qty: 1 }] }, 'fs');
    ok('field_sales cannot create → 403', fsTry.status === 403);

    // ── 5) cashier never receives money ─────────────────────────────────────
    console.log('— 5) cashier sees no amounts —');
    const cl = await api('GET', '/api/warehouses/qty-receipts', null, 'cashier');
    ok('cashier list 200, 2 receipts awaiting costing', cl.status === 200 && cl.json.length === 2
      && cl.json.every((d) => d.costing_status === 'awaiting_costing'), JSON.stringify(cl.json).slice(0, 200));
    ok('cashier list has NO money keys', moneyKeys(cl.json).length === 0, moneyKeys(cl.json).join(','));
    const cg = await api('GET', `/api/warehouses/qty-receipts/${r1}`, null, 'cashier');
    ok('cashier get: qty + product visible, NO money keys',
      cg.status === 200 && cg.json.lines[0].qty === 4 && cg.json.lines[0].product_id === pA && moneyKeys(cg.json).length === 0,
      moneyKeys(cg.json).join(','));
    ok('cashier responses flagged X-Cost-Redacted', cg.redacted === '1');
    const ag = await api('GET', `/api/warehouses/qty-receipts/${r1}`, null, 'acc');
    ok('accounting get shows provisional amounts (positive control)',
      ag.status === 200 && ag.json.amount_rial_total === 200000 && ag.json.lines[0].unit_cost_rial === 50000 && ag.json.cost_pending === 0,
      JSON.stringify(ag.json).slice(0, 300));
    const cDoc = await api('GET', `/api/warehouses/moves/docs/${r1}`, null, 'cashier');
    ok('cashier generic warehouse doc API → 403', cDoc.status === 403, cDoc.status);
    const cOpen = await api('GET', '/api/purchases/open-warehouse-grni', null, 'cashier');
    ok('cashier open-GRNI (with provisional amounts) → 403', cOpen.status === 403, cOpen.status);
    const cKx = await api('GET', `/api/inventory/kardex/${pA}`, null, 'cashier');
    ok('cashier kardex → no money keys whatever the status', moneyKeys(cKx.json).length === 0, `${cKx.status} ${moneyKeys(cKx.json).join(',')}`);
    const cProd = await api('GET', `/api/products/${pA}`, null, 'cashier');
    ok('cashier product → no cost keys (P4 rule)', cProd.status !== 200 || !Object.keys(cProd.json || {}).some((k) => CV.isCostKey(k, CV.scopeFor('/api/products/1'))), JSON.stringify(Object.keys(cProd.json || {})));

    // ── 6) costing ──────────────────────────────────────────────────────────
    console.log('— 6) costing (ریالی‌سازی) —');
    const moveA = cg.json.lines[0].move_id;
    const cCost = await api('POST', `/api/warehouses/qty-receipts/${r1}/cost`, { rows: [{ move_id: moveA, price: 60000 }] }, 'cashier');
    ok('cashier cannot cost → 403', cCost.status === 403);
    const cVoid = await api('POST', `/api/warehouses/qty-receipts/${r1}/void`, {}, 'cashier');
    ok('cashier cannot void → 403', cVoid.status === 403);
    const noPrice = await api('POST', `/api/warehouses/qty-receipts/${r1}/cost`, { rows: [], vat_exempt: 1 }, 'acc');
    ok('costing without a price → 400 E_QTY_RECEIPT_PRICE', noPrice.status === 400 && noPrice.json.code === 'E_QTY_RECEIPT_PRICE', JSON.stringify(noPrice.json));
    const cost1 = await api('POST', `/api/warehouses/qty-receipts/${r1}/cost`, {
      rows: [{ move_id: moveA, price: 60000 }], vat_exempt: 1, date: '1405/08/11',
    }, 'acc');
    ok('accounting costs receipt → purchase invoice', cost1.status === 200 && cost1.json.purchase_invoice_id, JSON.stringify(cost1.json).slice(0, 300));
    const pi1 = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(cost1.json.purchase_invoice_id);
    ok('purchase invoice: stock_added=0, final=240000, linked to doc',
      pi1 && Number(pi1.stock_added) === 0 && Number(pi1.final) === 240000 && Number(pi1.warehouse_doc_id) === r1, JSON.stringify(pi1 && { s: pi1.stock_added, f: pi1.final }));
    const k1c = kardex(pA);
    ok('kardex value = qty × price (240000), qty unchanged 4', k1c.qty === 4 && k1c.value === 240000, JSON.stringify(k1c));
    const pje = db.prepare("SELECT id FROM journal_entries WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(pi1.id);
    const sumAcct = (jeId, code, col) => Number(db.prepare(`SELECT COALESCE(SUM(${col}),0) s FROM journal_lines WHERE entry_id=? AND account_code=?`).get(jeId, code).s);
    ok('purchase JE clears GRNI 200000', pje && sumAcct(pje.id, acct(db, 'coa_grni').code, 'debit_rial') === 200000);
    ok('purchase JE credits AP 240000', pje && sumAcct(pje.id, acct(db, 'coa_payable').code, 'credit_rial') === 240000);

    const cAfter = await api('GET', `/api/warehouses/qty-receipts/${r1}`, null, 'cashier');
    ok('after costing: cashier sees costing_status=costed and still NO money keys',
      cAfter.status === 200 && cAfter.json.costing_status === 'costed' && moneyKeys(cAfter.json).length === 0, moneyKeys(cAfter.json).join(','));
    const cPur = await api('GET', `/api/purchases/${pi1.id}`, null, 'cashier');
    ok('cashier purchase invoice API → 403', cPur.status === 403);
    const twice = await api('POST', `/api/warehouses/qty-receipts/${r1}/cost`, { rows: [{ move_id: moveA, price: 1 }] }, 'acc');
    ok('double costing → 409', twice.status === 409, twice.status);

    // zero-average receipt costed → kardex from 0 to price
    const g2 = await api('GET', `/api/warehouses/qty-receipts/${r2}`, null, 'acc');
    const cost2 = await api('POST', `/api/warehouses/qty-receipts/${r2}/cost`, {
      rows: [{ move_id: g2.json.lines[0].move_id, price: 30000 }], vat_exempt: 1, date: '1405/08/11',
    }, 'acc');
    ok('cost_pending receipt costed', cost2.status === 200, JSON.stringify(cost2.json).slice(0, 200));
    const k2c = kardex(pB);
    ok('cost_pending kardex value 0 → 90000 (3 × 30000)', k2c.qty === 3 && k2c.value === 90000, JSON.stringify(k2c));

    // SOD: maker cannot cost own receipt
    const own = QR.createQtyReceipt(db, { warehouse_id: wh, supplier_id: sup, date: '1405/08/12', lines: [{ product_id: pA, qty: 1 }] }, U(204, 'accounting'));
    let sod = null;
    try {
      const doc = QR.loadQtyDoc(db, own.id);
      QR.costQtyReceipt(db, own.id, { rows: [{ move_id: doc.lines[0].id, price: 1 }], vat_exempt: 1 }, U(204, 'accounting'));
    } catch (e) { sod = e.code; }
    ok('maker-checker: creator cannot cost own receipt', sod === 'E_SOD_MAKER_CHECKER', sod);
    QR.voidQtyReceipt(db, own.id, accUser, { reason: 'test cleanup' });

    // ── 7) R13: void blocked while costed → un-cost → void ──────────────────
    console.log('— 7) R13 cancel chain —');
    const vBlocked = await api('POST', `/api/warehouses/qty-receipts/${r1}/void`, {}, 'acc');
    ok('void while costed → 400 E_WH_GRNI_LINKED', vBlocked.status === 400 && vBlocked.json.code === 'E_WH_GRNI_LINKED', JSON.stringify(vBlocked.json));
    const unc = await api('DELETE', `/api/purchases/${pi1.id}`, null, 'acc');
    ok('un-cost = void purchase invoice → 200', unc.status === 200, JSON.stringify(unc.json));
    const d1u = db.prepare('SELECT purchase_invoice_id, status FROM warehouse_docs WHERE id=?').get(r1);
    ok('receipt back to awaiting costing', d1u.purchase_invoice_id == null && d1u.status === 'posted');
    const k1u = kardex(pA);
    ok('kardex value back to provisional 200000, qty 4', k1u.qty === 4 && k1u.value === 200000, JSON.stringify(k1u));
    ok('purchase JE reversed', db.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(pi1.id).status === 'reversed');
    const v1 = await api('POST', `/api/warehouses/qty-receipts/${r1}/void`, { reason: 'تست ابطال' }, 'acc');
    ok('void receipt → 200', v1.status === 200, JSON.stringify(v1.json));
    const k1v = kardex(pA);
    ok('kardex after void: qty 0, value 0', k1v.qty === 0 && k1v.value === 0, JSON.stringify(k1v));
    const d1v = db.prepare('SELECT status, je_id FROM warehouse_docs WHERE id=?').get(r1);
    const je1 = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(d1v.je_id);
    ok('doc reversed + GRNI JE no longer live', d1v.status === 'reversed' && je1 && (je1.status === 'reversed' || je1.status === 'void' || Number(je1.deleted_at) > 0), JSON.stringify(je1));
    const physical = db.prepare('SELECT COUNT(*) c FROM warehouse_moves WHERE doc_id=?').get(r1).c;
    ok('no physical delete (moves kept)', physical === 1);
    const listAfter = await api('GET', '/api/warehouses/qty-receipts?status=awaiting_costing', null, 'cashier');
    ok('voided receipt leaves awaiting list', listAfter.status === 200 && !listAfter.json.some((d) => d.id === r1));
  } finally {
    await new Promise((rs) => server.close(rs));
  }

  // ── 8) sync + wiring gates ────────────────────────────────────────────────
  console.log('— 8) sync + wiring —');
  const { tableForPath } = require('../sync/capture');
  if (typeof tableForPath === 'function') {
    ok('sync: POST qty-receipts → warehouse_docs', tableForPath('/api/warehouses/qty-receipts') === 'warehouse_docs');
    ok('sync: void → warehouse_docs', tableForPath('/api/warehouses/qty-receipts/5/void') === 'warehouse_docs');
    ok('sync: cost → purchase_invoices', tableForPath('/api/warehouses/qty-receipts/5/cost') === 'purchase_invoices');
  } else {
    const cap = fs.readFileSync(path.join(__dirname, '..', 'sync', 'capture.js'), 'utf8');
    ok('sync: qty-receipts mapped before generic /api/warehouses',
      cap.indexOf("['/api/warehouses/qty-receipts', 'warehouse_docs']") > 0
      && cap.indexOf("['/api/warehouses/qty-receipts', 'warehouse_docs']") < cap.indexOf("['/api/warehouses', 'warehouses']"));
    ok('sync: cost branch → purchase_invoices', /qty-receipts\/'\) && \/\\\/cost\$\/\.test\(path\)\) return 'purchase_invoices'/.test(cap));
  }
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iQr = srv.indexOf("app.use('/api/warehouses/qty-receipts'");
  ok('server.js mounts qty-receipts before /api/warehouses and after cost strip',
    iQr > 0 && iQr < srv.indexOf("app.use('/api/warehouses', require('./routes/warehouses'))") && iQr > srv.indexOf('COST_STRIP_PREFIXES'));
  ok('cost strip hides amount_rial_total / provisional_rial under /api/warehouses',
    !('amount_rial_total' in CV.stripCostVisibility({ amount_rial_total: 1 }, CV.scopeFor('/api/warehouses/qty-receipts')))
    && !('provisional_rial' in CV.stripCostVisibility({ provisional_rial: 1 }, CV.scopeFor('/api/warehouses/qty-receipts'))));
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok('UI: qty receipt page + help section present', appJs.includes('renderQtyReceipts') && appJs.includes('رسید مقداری') && appJs.includes('v597'));
  ok('UI: RBAC label for qty_receipt', /qty_receipt:'/.test(appJs));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok('package.json: test:p7-qty-receipt script', !!(pkg.scripts && pkg.scripts['test:p7-qty-receipt']));

  cleanup();
  summary('P7 qty receipt');
})().catch((e) => { console.error(e); process.exit(1); });
