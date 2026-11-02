/**
 * P4 — R13 completeness for covered-lay value deltas (cutting_lay_fg_delta) + receipt date guard.
 *  A) covered lay void → fg_delta JE + FG value row linked to the order;
 *     reverseOrder (receipt cancel) voids them → WIP 1111 / FG 1104 / FG value net 0; idempotent.
 *  B) legacy row (no link) → purgeOrder finds it through the lay's order link, voids it, records the link.
 *  C) single-order guess: same FG + receipt not before the lay; recorded as 'guess'.
 *  D) receipt date guard: earlier than last activity → E_RECEIPT_BEFORE_LAST_ACTIVITY; same date passes.
 * Run: node server/scripts/test-prodcycle-p4-reverse-fgdelta.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodcycle-p4-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prodcycle-p4-fgdelta-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function gl(code) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS b
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(code);
  return Math.round(Number(row && row.b) || 0);
}

function liveFgDeltaJes(layId) {
  return db.prepare(`
    SELECT * FROM journal_entries WHERE ref_type='cutting_lay_fg_delta' AND ref_id=?
      AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'') NOT IN ('reversed','void')
  `).all(layId);
}

function liveFgDeltaRows(layId) {
  return db.prepare(`
    SELECT * FROM inventory_ledger WHERE source_type='cutting_lay_fg_delta' AND source_id=?
      AND status='posted' AND reversed_of IS NULL
  `).all(layId);
}

function fgValue(productId) {
  const { isCancelledLedgerRow } = require('../lib/inventory/ledger');
  const rows = db.prepare('SELECT * FROM inventory_ledger WHERE product_id=?').all(productId);
  let v = 0;
  for (const r of rows) {
    if (isCancelledLedgerRow(r)) continue;
    const qIn = Number(r.qty_in) || 0;
    const qOut = Number(r.qty_out) || 0;
    const amt = Math.round(Number(r.amount_rial) || 0);
    v += qIn > 0 ? amt : (qOut > 0 ? -amt : amt);
  }
  return v;
}

function codeOf(fn) {
  try { fn(); return null; } catch (e) { return e && e.code; }
}

(async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  new Function(appJs);
  ok(true, 'app.js parses');
  ok(appJs.includes('E_RECEIPT_BEFORE_LAST_ACTIVITY'), 'help/error map names the date guard');
  ok(appJs.includes('ابطال کامل سفارش و تعدیل لایه'), 'help explains fg_delta reverse');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'p4', device_fingerprint: 'p4-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
  ok(!!raw && !!fgWh, 'warehouses');
  db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('38','38',1,1)").run();
  db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('40','40',1,2)").run();
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی P4')`).run().lastInsertRowid;
  const bomLib = require('../lib/production/bom');
  const { postEvent, dr, cr } = require('../lib/production/posting');
  const { postInventoryMovement } = require('../lib/inventory/ledger');
  const engine = require('../lib/production/engine');
  const cutting = require('../lib/production/cutting');

  /** Covered order: lay → completed order + posted FG receipt (JE + ledger row) → covered lay void. */
  async function coveredScenario(tag) {
    const fgId = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
      VALUES (?, ?, ?, 0, 0, 'عدد', 1, 'finished')
    `).run(admin.id, `مانتو ${tag}`, `${tag}-FG`).lastInsertRowid;
    const fabId = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
      VALUES (?, ?, ?, 0, 0, 'متر', 200000, 'raw')
    `).run(admin.id, `کرپ ${tag}`, `${tag}-FAB`).lastInsertRowid;
    const rec = await api('POST', '/api/inventory/fabric-rolls', {
      product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 50,
      unit: 'متر', unit_cost_rial: 200000, supplier_id: supId, roll_no: `R-${tag}`,
      date: '1405/07/10', idempotency_key: `${tag}-roll`,
    });
    ok(rec.status === 200 && rec.data && rec.data.id, `${tag}: receive roll`, rec.data && rec.data.error);
    const bom = bomLib.createBom(db, { product_id: fgId, name: `BOM ${tag}`, base_qty: 1, yield_percent: 100 }, admin.id);
    bomLib.addLine(db, bom.id, {
      component_product_id: fabId, qty_per_base: 1.5, scrap_percent: 0,
      line_type: 'material', size_matrix: JSON.stringify({ '38': 1.5, '40': 1.5 }),
    }, admin.id);
    bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);
    const posted = await api('POST', '/api/production/cutting-lays', {
      product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
      marker_length_m: 2, ply_count: 3, actual_meters: 6, width_cm: 150,
      size_breakdown: { '38': 2, '40': 2 },
      rolls: [{ batch_id: rec.data.id, meters: 6 }],
      date: '1405/07/10', idempotency_key: `${tag}-lay`,
    });
    ok(posted.status === 200 && posted.data && posted.data.id, `${tag}: post lay`, posted.data && posted.data.error);
    const layId = posted.data.id;
    const layNo = posted.data.lay_no;
    const oldAmount = Math.round(Number(posted.data.amount_rial) || 0);
    const oldWaste = Math.round(Number(posted.data.waste_amount_rial) || 0);
    const oldNet = Math.max(0, oldAmount - oldWaste);
    const unit = oldNet > 0 ? Math.round(oldNet / 4) : 0;
    const orderNo = `PO-${tag}`;
    const poId = db.prepare(`
      INSERT INTO production_orders
        (order_no, product_id, bom_id, analysis_type, qty_planned, qty_produced,
         date, status, material_cost_rial, total_cost_rial, unit_cost_rial, abnormal_waste_rial)
      VALUES (?, ?, ?, 'fixed', 4, 4, '1405/07/10', 'completed', ?, ?, ?, ?)
    `).run(orderNo, fgId, bom.id, oldAmount, oldNet, unit, oldWaste).lastInsertRowid;
    const receiptId = db.prepare(`
      INSERT INTO production_receipts
        (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
         warehouse_id, prev_stock_qty, date, status, created_by)
      VALUES (?, ?, ?, 'main', 4, ?, ?, ?, 0, '1405/07/10', 'posted', ?)
    `).run(`PR-${tag}`, poId, fgId, unit, oldNet, fgWh.id, admin.id).lastInsertRowid;
    db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(poId, layId);
    db.prepare(`
      INSERT INTO production_material_issues
        (doc_no, order_id, product_id, issue_type, qty_actual, qty_standard,
         unit_cost_rial, std_cost_rial, amount_rial, std_amount_rial,
         warehouse_id, date, status, note, created_by)
      VALUES (?, ?, ?, 'cutting_lay', 6, 6, ?, ?, ?, ?, ?, '1405/07/10', 'posted', ?, ?)
    `).run(layNo, poId, fabId, Math.round(oldAmount / 6), Math.round(oldAmount / 6),
      oldAmount, oldAmount, raw.id, `لایه‌چینی ${layNo} — مصرف پارچه مرحله برش`, admin.id);
    const je = postEvent(db, {
      event: 'PRD-07', sourceId: receiptId, date: '1405/07/10',
      description: `رسید تست ${orderNo}`, createdBy: admin.id,
      lines: [dr(db, 'coa_finished_goods', oldNet), cr(db, 'coa_wip', oldNet)],
    });
    db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je.je_id, receiptId);
    postInventoryMovement(db, {
      eventType: 'production_receipt', productId: fgId, warehouseId: fgWh.id,
      qtyIn: 4, unitCostRial: unit, amountRial: oldNet,
      sourceType: 'production_receipt', sourceId: poId, date: '1405/07/10',
      note: `تولید ${orderNo}`, createdBy: admin.id, updateAvg: true,
    });

    const voided = await api('POST', `/api/production/cutting-lays/${layId}/void`, { reason: 'ابطال بعد از رسید' });
    ok(voided.status === 200 && voided.data && voided.data.status === 'reversed', `${tag}: covered void`, voided.data && (voided.data.error || voided.data.code));
    return { fgId, poId, layId, receiptId, oldNet, orderNo };
  }

  // ── A: reverseOrder (receipt cancel) voids the fg_delta JE + FG value rows ──
  console.log('A — reverseOrder');
  const A = await coveredScenario('P4A');
  ok(A.oldNet > 0, 'A: lay has value', A.oldNet);
  const layA = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(A.layId);
  ok(Number(layA.fg_delta_order_id) === A.poId, 'A: fg_delta linked to order', layA.fg_delta_order_id);
  const jesA = liveFgDeltaJes(A.layId);
  ok(jesA.length >= 1, 'A: fg_delta JE posted', jesA.length);
  ok(jesA.every((j) => j.src_doc_no === A.orderNo), 'A: JE carries order no', jesA.map((j) => j.src_doc_no));
  const rowsA = liveFgDeltaRows(A.layId);
  ok(rowsA.length >= 1 && rowsA.every((r) => Number(r.warehouse_id) === fgWh.id), 'A: FG value-only row', rowsA.length);
  ok(gl('1111') === 0, 'A: WIP 0 after covered void', gl('1111'));
  ok(fgValue(A.fgId) === 0, 'A: FG value 0 after covered void', fgValue(A.fgId));

  engine.reverseOrder(db, A.poId, admin.id, 'ابطال تست P4');
  ok(liveFgDeltaJes(A.layId).length === 0, 'A: fg_delta JE voided');
  ok(liveFgDeltaRows(A.layId).length === 0, 'A: FG value rows reversed');
  ok(gl('1111') === 0, 'A: WIP 1111 nets 0 after reverse', gl('1111'));
  ok(gl('1104') === 0, 'A: FG 1104 nets 0 after reverse', gl('1104'));
  ok(fgValue(A.fgId) === 0, 'A: FG ledger value 0 after reverse', fgValue(A.fgId));
  const recA = db.prepare('SELECT status FROM production_receipts WHERE id=?').get(A.receiptId);
  ok(recA.status === 'reversed', 'A: receipt reversed', recA.status);
  const again = cutting.reverseOrderFgDeltas(db, { orderId: A.poId, userId: admin.id });
  ok(again.journals === 0 && again.ledger_rows === 0, 'A: second pass is a no-op', again);
  const purged = engine.purgeOrder(db, A.poId, admin.id, 'حذف کامل تست');
  ok(purged && purged.status === 'voided', 'A: purge after reverse', purged && purged.status);
  ok(gl('1111') === 0 && gl('1104') === 0, 'A: GL still 0 after purge');

  // ── B: legacy fg_delta (no link) → purgeOrder → reverseOrder finds it via the lay's order ──
  console.log('B — purgeOrder legacy');
  const B = await coveredScenario('P4B');
  db.prepare('UPDATE cutting_lays SET fg_delta_order_id=NULL WHERE id=?').run(B.layId);
  ok(liveFgDeltaJes(B.layId).length >= 1, 'B: legacy fg_delta live');
  const before1111 = gl('1111');
  ok(before1111 === 0, 'B: WIP 0 before purge', before1111);
  const pB = engine.purgeOrder(db, B.poId, admin.id, 'حذف کامل legacy');
  ok(pB && pB.status === 'voided', 'B: order voided', pB && pB.status);
  ok(liveFgDeltaJes(B.layId).length === 0, 'B: legacy fg_delta JE voided');
  ok(liveFgDeltaRows(B.layId).length === 0, 'B: legacy FG value rows reversed');
  ok(Number(db.prepare('SELECT fg_delta_order_id FROM cutting_lays WHERE id=?').get(B.layId).fg_delta_order_id) === B.poId,
    'B: attribution recorded');
  ok(gl('1111') === 0 && gl('1104') === 0, 'B: WIP/FG GL 0 after purge', [gl('1111'), gl('1104')]);
  ok(fgValue(B.fgId) === 0, 'B: FG ledger value 0', fgValue(B.fgId));

  // ── C: single-order guess for unlinked lays ──
  console.log('C — guess safety');
  const fgC = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو P4C', 'P4C-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const poC = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, qty_produced, date, status)
    VALUES ('PO-P4C', ?, 'fixed', 10, 10, '1405/07/05', 'completed')
  `).run(fgC).lastInsertRowid;
  const recC = db.prepare(`
    INSERT INTO production_receipts (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES ('PR-P4C', ?, ?, 'main', 10, 0, 0, ?, '1405/07/05', 'posted')
  `).run(poC, fgC, fgWh.id).lastInsertRowid;
  const layLater = { id: -1, status: 'posted', product_id: fgC, qty_pieces: 10, date: '1405/07/20' };
  ok(cutting.layFgCoveredByOrder(db, layLater).fg_covered_by_order === 0, 'C: receipt before lay → no guess');
  const laySame = Object.assign({}, layLater, { date: '1405/07/05' });
  const covC = cutting.layFgCoveredByOrder(db, laySame);
  ok(covC.fg_covered_by_order === 1 && covC.covered_attribution === 'guess', 'C: same FG, receipt not before lay → guess', covC);
  ok(cutting.layFgCoveredByOrder(db, Object.assign({}, laySame, { qty_pieces: 11 })).fg_covered_by_order === 0,
    'C: receipt qty short → no guess');
  db.prepare("UPDATE production_orders SET status='voided' WHERE id=?").run(poC);
  ok(cutting.layFgCoveredByOrder(db, laySame).fg_covered_by_order === 0, 'C: voided order never guessed');
  db.prepare("UPDATE production_receipts SET status='reversed' WHERE id=?").run(recC);

  // ── D: receipt date guard ──
  console.log('D — receipt date guard');
  const RDG = require('../lib/production/receipt-date-guard');
  ok(RDG.dateKey('۱۴۰۵/۷/۵') === '14050705', 'D: Persian digits / unpadded normalise');
  const fgD = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'دکمه‌دار P4D', 'P4D-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const btn = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'دکمه P4D', 'P4D-BTN', 0, 100, 'عدد', 1000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const bomD = bomLib.createBom(db, { product_id: fgD, name: 'BOM P4D', base_qty: 1, yield_percent: 100 }, admin.id);
  bomLib.addLine(db, bomD.id, { component_product_id: btn, qty_per_base: 2, scrap_percent: 0, line_type: 'material' }, admin.id);
  bomLib.activateBom(db, bomD.id, '1405/01/01', admin.id);
  const poD = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, bom_id, analysis_type, qty_planned, date, period_label, status,
       warehouse_raw_id, warehouse_fg_id, completeness_waive_reason, created_by)
    VALUES ('PO-P4D', ?, ?, 'variable', 5, '1405/07/01', '1405/07', 'in_progress', ?, ?, 'تست تاریخ', ?)
  `).run(fgD, bomD.id, raw.id, fgWh.id, admin.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO production_material_issues
      (doc_no, order_id, product_id, issue_type, qty_actual, qty_standard, unit_cost_rial, amount_rial,
       warehouse_id, date, status, created_by)
    VALUES ('MI-P4D', ?, ?, 'manual', 10, 10, 1000, 10000, ?, '1405/07/20', 'posted', ?)
  `).run(poD, btn, raw.id, admin.id);
  db.prepare(`
    INSERT INTO production_labor_entries (doc_no, order_id, cost_center_id, method, amount_rial, date, status, created_by)
    VALUES ('LB-P4D', ?, ?, 'hourly', 5000, '1405/07/28', 'posted', ?)
  `).run(poD, db.prepare('SELECT id FROM cost_centers ORDER BY id LIMIT 1').get().id, admin.id);
  const last = RDG.lastOrderActivity(db, poD);
  ok(last && last.date === '1405/07/28', 'D: last activity = labor date', last);
  let early = null;
  try {
    engine.postReceiptVariable(db, { orderId: poD, body: { date: '1405/07/05', qty_produced: 5 }, userId: admin.id });
  } catch (e) { early = e; }
  ok(early && early.code === 'E_RECEIPT_BEFORE_LAST_ACTIVITY', 'D: early receipt rejected', early && (early.code || early.message));
  ok(early && /قبل از آخرین/.test(early.message), 'D: Persian message', early && early.message);
  ok(db.prepare("SELECT COUNT(*) c FROM production_receipts WHERE order_id=?").get(poD).c === 0, 'D: nothing posted');
  ok(codeOf(() => RDG.assertReceiptNotBeforeLastActivity(db, poD, '1405/07/28')) === null, 'D: same date accepted');
  ok(codeOf(() => RDG.assertReceiptNotBeforeLastActivity(db, poD, '1405/08/02')) === null, 'D: later date accepted');
  let same = null;
  try {
    engine.postReceiptVariable(db, { orderId: poD, body: { date: '1405/07/28', qty_produced: 5 }, userId: admin.id });
  } catch (e) { same = e; }
  ok(!same || same.code !== 'E_RECEIPT_BEFORE_LAST_ACTIVITY', 'D: same-date receipt passes the guard', same && (same.code || same.message));
  ok(RDG.defaultReceiptDate(db, poD, '1405/07/01') === '1405/07/28', 'D: blank date defaults to last activity');
  // Edit of a receipt = reverse + re-post: the re-post goes through the same guard.
  db.prepare("UPDATE production_labor_entries SET status='reversed' WHERE order_id=?").run(poD);
  ok(codeOf(() => RDG.assertReceiptNotBeforeLastActivity(db, poD, '1405/07/25')) === null, 'D: reversed activity ignored');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
