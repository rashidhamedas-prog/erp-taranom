'use strict';
/**
 * v503 — اصلاح بها: اتلاف برش مشترک در ماندهٔ WIP نیست؛
 * تطبیق رسید وقتی ستون‌ها هم‌ترازند ولی رسید ≠ خالص WIP.
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const engine = require('../lib/production/engine');
const {
  applyDocumentCosts,
  applyReceiptToWipNet,
  previewOrderCostReconcile,
  reconcileOrderCosts,
  sharedLayWasteRial,
  wipEffectiveAbnormalWasteRial,
} = require('../lib/production/order-cost-reconcile');

const { db, cleanup } = freshDb();

function product(name) {
  return db.prepare(`INSERT INTO products (user_id, name, price, stock) VALUES (1,?,0,0)`).run(name).lastInsertRowid;
}
function wh() {
  return db.prepare('SELECT id FROM warehouses LIMIT 1').get().id;
}
function order(no, material) {
  const pid = product('کاپشن ' + no);
  const id = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, qty_planned, date, status, analysis_type, material_cost_rial)
    VALUES (?,?,96,'1405/07/05','completed','fixed_adv',?)
  `).run(no, pid, material).lastInsertRowid;
  return { id, pid };
}
function issue(orderId, productId, amount) {
  db.prepare(`
    INSERT INTO production_material_issues
      (order_id, product_id, issue_type, qty_actual, unit_cost_rial, amount_rial, warehouse_id, date, status, note)
    VALUES (?,?, 'cutting_lay', 1, ?, ?, ?, '1405/07/05', 'posted', 'LAY')
  `).run(orderId, productId, amount, amount, wh());
}
function receipt(orderId, productId, amount) {
  db.prepare(`
    INSERT INTO production_receipts
      (order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES (?,?,96,?,? ,?,'1405/07/05','posted')
  `).run(orderId, productId, amount, amount, wh());
}

// A: regression v493 — ستون مواد از حوالهٔ زنده
const a = order('PO-T503A', 100);
issue(a.id, a.pid, 361);
receipt(a.id, a.pid, 361);
eq('A مانده قبل اصلاح منفی', engine.wipResidual(db, a.id), 100 - 361);
const appliedA = applyDocumentCosts(db, a.id);
eq('A اصلاح ستون', appliedA.applied ? 1 : 0, 1);
eq('A مانده بعد صفر', engine.wipResidual(db, a.id), 0);

// B: اتلاف لایهٔ کلاسیک (بدون batch) در ماندهٔ WIP هست
const b = order('PO-T503B', 0);
issue(b.id, b.pid, 100);
db.prepare(`
  INSERT INTO cutting_lays
    (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id, amount_rial)
  VALUES ('LAY-T503B', ?, 1, 1, '1405/07/05', 'posted', 15, ?, 100)
`).run(b.pid, b.id);
receipt(b.id, b.pid, 85);
applyDocumentCosts(db, b.id);
eq('B ضایعات مؤثر WIP', wipEffectiveAbnormalWasteRial(db, b.id), 15);
eq('B مانده صفر با رسید خالص', engine.wipResidual(db, b.id), 0);

// C: اتلاف برش مشترک وارد WIP نشده — نباید بستن را ببندد
const c = order('PO-T503C', 0);
issue(c.id, c.pid, 200);
const batchId = db.prepare(`
  INSERT INTO cutting_batches (batch_no, fabric_product_id, date, status, common_rial)
  VALUES ('CB-T503', ?, '1405/07/05', 'posted', 200)
`).run(c.pid).lastInsertRowid;
db.prepare(`
  INSERT INTO cutting_lays
    (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id, amount_rial, batch_id)
  VALUES ('LAY-T503C', ?, 1, 1, '1405/07/05', 'posted', 3999461, ?, 200, ?)
`).run(c.pid, c.id, batchId);
receipt(c.id, c.pid, 200);
const healedC = applyDocumentCosts(db, c.id);
eq('C ضایعات مشترک در اسناد هست', healedC.documents.abnormal_waste_rial, 3999461);
eq('C ضایعات مشترک جدا گزارش می‌شود', sharedLayWasteRial(db, c.id), 3999461);
eq('C ضایعات مؤثر WIP صفر', wipEffectiveAbnormalWasteRial(db, c.id), 0);
eq('C مانده با رسید خالص صفر است', engine.wipResidual(db, c.id), 0);
eq('C پیش‌نمایش can_align_receipt خیر', previewOrderCostReconcile(db, c.id).can_align_receipt ? 1 : 0, 0);

// D: ستون‌ها هم‌تراز، رسید بیش از خالص (سناریوی UI بدون دکمهٔ قبلی)
const d = order('PO-T503D', 0);
issue(d.id, d.pid, 100);
db.prepare(`
  INSERT INTO cutting_lays
    (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id, amount_rial)
  VALUES ('LAY-T503D', ?, 1, 1, '1405/07/05', 'posted', 20, ?, 100)
`).run(d.pid, d.id);
receipt(d.id, d.pid, 100); // باید ۸۰ باشد
applyDocumentCosts(db, d.id);
const prevD = previewOrderCostReconcile(db, d.id);
eq('D هم‌تراز است', prevD.aligned ? 1 : 0, 1);
eq('D مانده منفی برابر ضایعات', engine.wipResidual(db, d.id), -20);
eq('D can_align_receipt', prevD.can_align_receipt ? 1 : 0, 1);
eq('D projected بعد از auto صفر', prevD.projected_after_auto_rial, 0);
db.prepare('UPDATE production_orders SET material_cost_rial=1 WHERE id=?').run(d.id);
throws('D رسید قبل از هم‌ترازی ستون رد می‌شود', () => applyReceiptToWipNet(db, d.id, 1), 'E_COLUMNS_NOT_ALIGNED');
applyDocumentCosts(db, d.id);
const autoD = reconcileOrderCosts(db, d.id, { mode: 'auto', userId: 1 });
eq('D auto اعمال شد', autoD.applied ? 1 : 0, 1);
eq('D رسید لمس شد', autoD.receipts_touched ? 1 : 0, 1);
eq('D مانده بعد auto صفر', engine.wipResidual(db, d.id), 0);
eq('D مبلغ رسید خالص شد', db.prepare('SELECT amount_rial FROM production_receipts WHERE order_id=?').get(d.id).amount_rial, 80);

cleanup();
summary('v503 اصلاح بها + تطبیق رسید');
