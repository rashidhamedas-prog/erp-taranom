/**
 * P8a — اسکریپت‌های اصلاح داده روی DB آزمایشی (fixture):
 *  برای هر قلم ۱..۴: dry-run (DB مبدأ دست‌نخورده) → apply (اثر درست GL/کاردکس + audit) → undo R13
 *  (بازگشت دقیق کاردکس زنده و GL، بدون حذف فیزیکی ردیف).
 * Run: node server/scripts/test-prodcycle-p8a.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodcycle-p8a-'));
const DB_FILE = path.join(dir, 't.db');
process.env.DB_PATH = DB_FILE;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prodcycle-p8a-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const C = require('./lib/p8a-common');
const items = require('./lib/p8a-items');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); } else { fail += 1; console.log(' FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}
const db = () => getDB();
const gl = (code) => {
  const b = C.glBalances(db()).get(code) || { d: 0, c: 0 };
  return b.d - b.c;
};
const live = (pid, wh) => C.liveKardexOf(db(), pid, wh);
const count = (t) => db().prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

async function run(spec, cfg, extra = {}) {
  const r = await C.runItem(spec, { cfg, args: Object.assign({ db: DB_FILE, out: dir }, extra), noWrite: true });
  process.env.DB_PATH = DB_FILE;
  return r;
}
const apply = (spec, cfg) => run(spec, cfg, { apply: true, approval: true, reason: 'تست P8a' });
const undo = (spec, auditId) => run(spec, {}, { undo: auditId, approval: true, reason: 'بازگردانی تست P8a' });

(async () => {
  const L = require('../lib/inventory/ledger');
  const { postToLedger } = require('../lib/ledger');
  try { db().prepare("UPDATE settings SET value='warn' WHERE key LIKE 'coa_leaf%'").run(); } catch (_) { /* optional */ }
  const admin = db().prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
  const wh = (code) => (db().prepare('SELECT id FROM warehouses WHERE code=?').get(code) || {}).id;
  const raw = wh('WH-RAW');
  const fg = wh('WH-FG');
  let wip = wh('WH-WIP');
  if (!wip) {
    wip = db().prepare("INSERT INTO warehouses (name, code, warehouse_type, kind, inventory_coa_code) VALUES ('WIP','WH-WIP','raw_material','wip','1111')").run().lastInsertRowid;
  }
  ok(raw && fg && wip, 'warehouses', { raw, fg, wip });
  const product = (name, unit, avg) => db().prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, ?, ?, 0, 0, ?, ?, 'raw')`).run(admin, name, `P8A-${name}`, unit, avg).lastInsertRowid;
  const mv = (o) => L.postInventoryMovement(db(), Object.assign({ createdBy: admin, date: '1405/07/10' }, o));

  // ───── item1 ─────
  console.log('item1 — legacy opening/reconcile void');
  const fab = product('FAB1', 'یارد', 1000);
  mv({ eventType: 'receipt', productId: fab, warehouseId: raw, qtyIn: 10, unitCostRial: 1000, amountRial: 10000, sourceType: 'fabric_roll', sourceId: 1 });
  const op = mv({ eventType: 'opening', productId: fab, warehouseId: raw, qtyIn: 5, unitCostRial: 1000, amountRial: 5000, sourceType: 'opening_inventory', sourceId: fab, skipStock: true, date: '1405/06/31', note: 'موجودی اول دوره' });
  const rc = mv({ eventType: 'adjustment', productId: fab, warehouseId: raw, qtyOut: 8, unitCostRial: 1000, amountRial: 8000, sourceType: 'stock_reconcile', sourceId: fab, skipStock: true, note: 'هم‌ترازی کاردکس با موجودی انبار' });
  db().prepare(`INSERT INTO product_opening_stock (product_id, warehouse_id, qty, unit_cost_rial, value_rial, ledger_id, status, candidate_ledger_ids)
    VALUES (?,?,5,1000,5000,?,'needs_review',?)`).run(fab, raw, op.id, JSON.stringify([op.id]));
  const k0 = live(fab, raw);
  ok(k0.qty === 7 && k0.val === 7000, 'item1: live kardex before 7 / 7000', k0);
  const cfg1 = { productId: fab, warehouseId: raw, openingRowIds: [op.id], reconcileRowIds: [rc.id], expectQty: 10 };
  const nLed = count('inventory_ledger');
  const d1 = await run(items.item1, cfg1);
  ok(count('inventory_ledger') === nLed, 'item1 dry-run: source DB untouched');
  ok(d1.res.kardex.some((x) => x.dv === 3000 && x.dq === 3), 'item1 dry-run reports +3 / +3000', d1.res.kardex);
  const a1 = await apply(items.item1, cfg1);
  const k1 = live(fab, raw);
  ok(k1.qty === 10 && k1.val === 10000, 'item1 apply: live kardex 10 / 10000', k1);
  ok(db().prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(fab, raw).qty === 10, 'item1 apply: warehouse_stock unchanged');
  ok(db().prepare('SELECT status FROM product_opening_stock WHERE product_id=?').get(fab).status === 'void', 'item1 apply: opening stock → void');
  const b1 = db().prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(fab, raw);
  ok(b1 && b1.qty === 10 && b1.value_rial === 10000, 'item1 apply: bucket = 10 / 10000', b1);
  ok(a1.res.gl.length === 0, 'item1 apply: no GL effect');
  ok(db().prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE id IN (?,?) AND status='reversed'").get(op.id, rc.id).c === 2, 'item1 apply: originals soft-reversed (not deleted)');
  ok(a1.auditId > 0, 'item1 apply: audit row');
  await undo(items.item1, a1.auditId);
  const k1u = live(fab, raw);
  ok(k1u.qty === 7 && k1u.val === 7000, 'item1 undo: live kardex back to 7 / 7000', k1u);
  ok(db().prepare('SELECT status FROM product_opening_stock WHERE product_id=?').get(fab).status === 'needs_review', 'item1 undo: opening stock restored');
  let twice = null;
  try { await undo(items.item1, a1.auditId); } catch (e) { twice = e; }
  ok(twice && /قبلاً بازگردانی/.test(twice.message), 'item1: second undo refused');

  // ───── item2 ─────
  console.log('item2 — WIP pack exit at pack amount');
  const fg2 = product('FG2', 'عدد', 0);
  const po2 = db().prepare("INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, date, status) VALUES ('PO-T2', ?, 'fixed', 10, '1405/07/10', 'closed')").run(fg2).lastInsertRowid;
  const lay2 = db().prepare("INSERT INTO cutting_lays (lay_no, product_id, production_order_id, status, date) VALUES ('LAY-T2', ?, ?, 'posted', '1405/07/10')").run(fg2, po2).lastInsertRowid;
  const pack2 = db().prepare("INSERT INTO cutting_packs (pack_no, lay_id, production_order_id, product_id, warehouse_id, qty, amount_rial, status, date) VALUES ('PK-T2', ?, ?, ?, ?, 10, 50000, 'posted', '1405/07/10')").run(lay2, po2, fg2, wip).lastInsertRowid;
  mv({ eventType: 'cutting_pack', productId: fg2, warehouseId: wip, qtyIn: 10, unitCostRial: 5000, amountRial: 50000, sourceType: 'cutting_pack', sourceId: pack2, warehouseOnly: true, updateAvg: false });
  const ex2 = mv({ eventType: 'cutting_pack', productId: fg2, warehouseId: wip, qtyOut: 10, unitCostRial: 12000, amountRial: 120000, sourceType: 'cutting_pack', sourceId: pack2, warehouseOnly: true, updateAvg: false, note: 'تخلیه WIP بسته برش هنگام رسید 1' });
  ok(live(fg2, wip).val === -70000, 'item2: WIP value before −70000', live(fg2, wip));
  const cfg2 = { warehouseId: wip, ledgerIds: [ex2.id] };
  const a2 = await apply(items.item2, cfg2);
  ok(live(fg2, wip).val === 0 && live(fg2, wip).qty === 0, 'item2 apply: WIP value/qty 0', live(fg2, wip));
  ok(a2.res.gl.length === 0, 'item2 apply: no GL effect');
  ok(db().prepare('SELECT stock FROM products WHERE id=?').get(fg2).stock === 0, 'item2 apply: FG header untouched');
  const bw = () => db().prepare('SELECT qty, value_rial FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(fg2, wip);
  ok(bw() && bw().qty === 0 && bw().value_rial === 0, 'item2 apply: WIP bucket = live kardex (0 / 0)', bw());
  await undo(items.item2, a2.auditId);
  ok(live(fg2, wip).val === -70000, 'item2 undo: WIP back to −70000', live(fg2, wip));

  // ───── item3 ─────
  console.log('item3 — receipt split shift + sold share → COGS');
  const pa = product('FGA', 'عدد', 0);
  const pb = product('FGB', 'عدد', 0);
  const po3 = db().prepare("INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, qty_produced, date, status) VALUES ('PO-T3', ?, 'fixed', 20, 20, '1405/07/10', 'closed')").run(pa).lastInsertRowid;
  const rec = (pid, doc) => db().prepare(`INSERT INTO production_receipts (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES (?, ?, ?, 'main', 10, 10000, 100000, ?, '1405/07/10', 'posted')`).run(doc, po3, pid, fg).lastInsertRowid;
  rec(pa, 'PR-T3A'); rec(pb, 'PR-T3B');
  mv({ eventType: 'production_receipt', productId: pa, warehouseId: fg, qtyIn: 10, unitCostRial: 10000, amountRial: 100000, sourceType: 'production_receipt', sourceId: po3 });
  mv({ eventType: 'production_receipt', productId: pb, warehouseId: fg, qtyIn: 10, unitCostRial: 10000, amountRial: 100000, sourceType: 'production_receipt', sourceId: po3 });
  postToLedger(db(), { sourceType: 'production_receipt', sourceId: po3, date: '1405/07/10', description: 'رسید T3', createdBy: admin,
    lines: [{ code: '1104', name: 'موجودی کالا', debit: 20000, credit: 0 }, { code: '1111', name: 'WIP', debit: 0, credit: 20000 }] });
  mv({ eventType: 'sale', productId: pb, warehouseId: fg, qtyOut: 5, unitCostRial: 10000, amountRial: 50000, sourceType: 'invoice', sourceId: 1 });
  const g0 = { inv: gl('1104'), cogs: gl('5101') };
  const cfg3 = { orderId: po3, targets: { [pa]: 80000, [pb]: 120000 }, expected: null, date: '1405/07/10' };
  const a3 = await apply(items.item3, cfg3);
  ok(gl('1104') - g0.inv === -10000 && gl('5101') - g0.cogs === 10000, 'item3 apply: 1104 −10000 / 5101 +10000', { inv: gl('1104') - g0.inv, cogs: gl('5101') - g0.cogs });
  ok(live(pa, fg).val === 80000 && live(pb, fg).val === 60000, 'item3 apply: FG kardex A 80000, B 60000', [live(pa, fg), live(pb, fg)]);
  const rcA = db().prepare("SELECT amount_rial, unit_cost_rial FROM production_receipts WHERE doc_no='PR-T3A'").get();
  ok(rcA.amount_rial === 80000 && rcA.unit_cost_rial === 8000, 'item3 apply: receipt A amount/unit updated', rcA);
  await undo(items.item3, a3.auditId);
  ok(gl('1104') === g0.inv && gl('5101') === g0.cogs, 'item3 undo: GL back', { inv: gl('1104'), cogs: gl('5101') });
  ok(live(pa, fg).val === 100000 && live(pb, fg).val === 50000, 'item3 undo: FG kardex back', [live(pa, fg), live(pb, fg)]);
  ok(db().prepare("SELECT amount_rial FROM production_receipts WHERE doc_no='PR-T3A'").get().amount_rial === 100000, 'item3 undo: receipt amount restored');

  // ───── item4 ─────
  console.log('item4 — orphan fg_delta reversal');
  const pf = product('FG4', 'عدد', 0);
  mv({ eventType: 'production_receipt', productId: pf, warehouseId: fg, qtyIn: 10, unitCostRial: 1000, amountRial: 10000, sourceType: 'production_receipt', sourceId: 999 });
  const po4 = db().prepare("INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, date, status) VALUES ('PO-T4', ?, 'fixed', 10, '1405/07/10', 'voided')").run(pf).lastInsertRowid;
  const lay4 = db().prepare("INSERT INTO cutting_lays (lay_no, product_id, status, date) VALUES ('LAY-T4', ?, 'reversed', '1405/07/10')").run(pf).lastInsertRowid;
  const je4 = postToLedger(db(), { sourceType: 'cutting_lay_fg_delta', sourceId: lay4, date: '1405/07/10', description: 'تعدیل بهای محصول LAY-T4', createdBy: admin,
    lines: [{ code: '1111', name: 'WIP', debit: 300, credit: 0 }, { code: '1104', name: 'موجودی کالا', debit: 0, credit: 200 }, { code: '5101', name: 'COGS', debit: 0, credit: 100 }] });
  mv({ eventType: 'production_receipt', productId: pf, warehouseId: fg, qtyIn: 0, qtyOut: 0, unitCostRial: 2000, amountRial: -2000, sourceType: 'cutting_lay_fg_delta', sourceId: lay4, valueOnly: true, skipStock: true, updateAvg: false });
  const g4 = { wip: gl('1111'), inv: gl('1104'), cogs: gl('5101'), k: live(pf, fg).val };
  ok(g4.k === 8000, 'item4: FG value before 8000', g4.k);
  const cfg4 = { attributions: [{ layId: lay4, orderId: po4 }], expectJeIds: [je4] };
  const a4 = await apply(items.item4, cfg4);
  ok(gl('1111') - g4.wip === -3000 && gl('1104') - g4.inv === 2000 && gl('5101') - g4.cogs === 1000, 'item4 apply: 1111 −3000 / 1104 +2000 / 5101 +1000',
    [gl('1111') - g4.wip, gl('1104') - g4.inv, gl('5101') - g4.cogs]);
  ok(live(pf, fg).val === 10000, 'item4 apply: FG value +2000', live(pf, fg));
  ok(db().prepare('SELECT fg_delta_order_id FROM cutting_lays WHERE id=?').get(lay4).fg_delta_order_id === po4, 'item4 apply: attribution set');
  ok(db().prepare('SELECT COUNT(*) c FROM journal_entries WHERE id=?').get(je4).c === 1, 'item4 apply: JE kept (soft-void, not deleted)');
  await undo(items.item4, a4.auditId);
  ok(gl('1111') === g4.wip && gl('1104') === g4.inv && gl('5101') === g4.cogs, 'item4 undo: GL back (re-posted with new voucher)');
  ok(live(pf, fg).val === 8000, 'item4 undo: FG value back', live(pf, fg));
  ok(db().prepare('SELECT fg_delta_order_id FROM cutting_lays WHERE id=?').get(lay4).fg_delta_order_id == null, 'item4 undo: attribution cleared');

  // ───── guards ─────
  console.log('guards');
  let g = null;
  try { await run(items.item1, cfg1, { apply: true, reason: 'x' }); } catch (e) { g = e; }
  ok(g && /i-have-approval/.test(g.message), 'apply without --i-have-approval refused');
  let p = null;
  try { await apply(items.item2, cfg2); } catch (e) { p = e; }
  ok(p && /زنده نیست/.test(p.message), 'apply on already-corrected row refused by precheck');
  ok(C.isLivePath('/home/taranom/crm-taranom/server/crm.db'), 'live production path detected');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { getDB().close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
