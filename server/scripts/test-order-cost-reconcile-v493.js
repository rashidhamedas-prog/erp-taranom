'use strict';
/**
 * v493 — ستون بهای سفارش از اسناد زنده؛ رسید و سند دست نمی‌خورند.
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const engine = require('../lib/production/engine');
const { applyDocumentCosts, previewOrderCostReconcile } = require('../lib/production/order-cost-reconcile');

const { db, cleanup } = freshDb();

function product() {
  return db.prepare(`INSERT INTO products (user_id, name, price, stock) VALUES (1,'کاپشن تست',0,0)`).run().lastInsertRowid;
}
function wh() {
  return db.prepare('SELECT id FROM warehouses LIMIT 1').get().id;
}
function order(no, material) {
  const pid = product();
  const id = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, qty_planned, date, status, analysis_type, material_cost_rial)
    VALUES (?,?,96,'1405/07/05','completed','fixed_adv',?)
  `).run(no, pid, material).lastInsertRowid;
  return { id, pid };
}
function issue(orderId, productId, amount, status, note) {
  db.prepare(`
    INSERT INTO production_material_issues
      (order_id, product_id, issue_type, qty_actual, unit_cost_rial, amount_rial, warehouse_id, date, status, note)
    VALUES (?,?, 'cutting_lay', 1, ?, ?, ?, '1405/07/05', ?, ?)
  `).run(orderId, productId, amount, amount, wh(), status, note);
}
function receipt(orderId, productId, amount) {
  db.prepare(`
    INSERT INTO production_receipts
      (order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES (?,?,96,?,? ,?,'1405/07/05','posted')
  `).run(orderId, productId, amount, amount, wh());
}

const a = order('PO-T493A', 100);
issue(a.id, a.pid, 361, 'posted', 'LAY زنده');
issue(a.id, a.pid, 50, 'reversed', 'LAY ابطال');
receipt(a.id, a.pid, 361);
eq('قبل از اصلاح مانده منفی است', engine.wipResidual(db, a.id), 100 - 361);
const applied = applyDocumentCosts(db, a.id);
eq('اصلاح انجام شد', applied.applied ? 1 : 0, 1);
eq('مواد برابر حوالهٔ زنده شد', applied.documents.material_cost_rial, 361);
eq('حوالهٔ ابطال‌شده در بها نیست', applied.documents.material_cost_rial, 361);
eq('مانده بعد از اصلاح صفر است', engine.wipResidual(db, a.id), 0);
eq('مبلغ رسید عوض نشد', db.prepare('SELECT amount_rial FROM production_receipts WHERE order_id=?').get(a.id).amount_rial, 361);
const again = applyDocumentCosts(db, a.id);
eq('بار دوم چیزی عوض نمی‌شود', again.applied ? 1 : 0, 0);
eq('پیش‌نمایش هم‌تراز است', previewOrderCostReconcile(db, a.id).aligned ? 1 : 0, 1);

db.prepare(`UPDATE production_orders SET status='closed', material_cost_rial=1 WHERE id=?`).run(a.id);
throws('سفارش بسته رد می‌شود', () => applyDocumentCosts(db, a.id), 'E_ORDER_CLOSED');
eq('بستن، مواد را عوض نکرد', db.prepare('SELECT material_cost_rial FROM production_orders WHERE id=?').get(a.id).material_cost_rial, 1);

const b = order('PO-T493B', 0);
issue(b.id, b.pid, 90, 'posted', 'LAY خالص');
db.prepare(`
  INSERT INTO cutting_lays
    (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id)
  VALUES ('LAY-T493', ?, 1, 1, '1405/07/05', 'posted', 10, ?)
`).run(b.pid, b.id);
const cc = db.prepare('SELECT id FROM cost_centers LIMIT 1').get().id;
db.prepare(`
  INSERT INTO production_labor_entries
    (order_id, cost_center_id, amount_rial, status, date)
  VALUES (?, ?, 40, 'posted', '1405/07/05')
`).run(b.id, cc);
receipt(b.id, b.pid, 120);
const healed = applyDocumentCosts(db, b.id);
eq('اتلاف لایه در ضایعات غیرعادی است', healed.documents.abnormal_waste_rial, 10);
eq('دستمزد از سند دستمزد است', healed.documents.labor_cost_rial, 40);
eq('خالص اسناد با رسید یکی است', engine.wipResidual(db, b.id), 0);

cleanup();
summary('v493 اصلاح بهای سفارش');
