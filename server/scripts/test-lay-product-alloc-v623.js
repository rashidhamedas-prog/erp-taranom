#!/usr/bin/env node
'use strict';
/**
 * v623 — تخصیص بهای لایهٔ کلاسیک برش به محصول در سفارش چندمحصولی چندفرمولی (peer BOM).
 *
 * اگر پارچهٔ یک لایهٔ کلاسیک (status='posted', batch_id NULL) فقط در bom_lines
 * یکی از فرمول‌های محصولات سفارش باشد (مثلاً پارچهٔ «کشبافت» فقط در BOM-0032 محصول ۳۳۶)،
 * باید ۱۰۰٪ به همان محصول تخصیص یابد؛ اگر در چند فرمول باشد به تسهیم تعدادی (qty share)
 * برمی‌گردد. در تطبیق خودکار رسید (reconcileOrderCosts mode:'auto') نیز هر محصول به
 * هدف خودش (target_p) می‌رسد.
 *
 * Run: node server/scripts/test-lay-product-alloc-v623.js
 */
const harness = require('./lib/test-harness');
const { freshDb, summary } = harness;
let totalChecks = 0;
let passedChecks = 0;
function ok(name, cond, extra = '') {
  totalChecks += 1;
  if (cond) passedChecks += 1;
  return harness.ok(name, cond, extra);
}
function eq(name, actual, expected, tol = 0) {
  totalChecks += 1;
  if (Math.abs(Number(actual) - Number(expected)) <= tol) passedChecks += 1;
  return harness.eq(name, actual, expected, tol);
}

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e && e.message))) {
    console.log('  SKIP مسیر دیتابیس: better-sqlite3 روی این Node لود نشد');
    summary('lay-product-alloc-v623');
  }
  throw e;
}

const { db, cleanup } = ctx;

try {
  const splitMod = require('../lib/production/order-cost-split');
  const reconcileMod = require('../lib/production/order-cost-reconcile');
  const engine = require('../lib/production/engine');

  // بررسی وجود توابع قرارداد در خروجی ماژول‌ها
  for (const fn of [
    'layFabricOwnerProducts',
    'layFabricByProduct',
    'splitOrderCost',
    'orderMainShareOuts',
    'receiptTargetsByProduct',
  ]) {
    ok(`order-cost-split خروجی ${fn} را دارد`, typeof splitMod[fn] === 'function');
  }
  ok('order-cost-reconcile خروجی reconcileOrderCosts را دارد',
    typeof reconcileMod.reconcileOrderCosts === 'function');

  const {
    layFabricOwnerProducts,
    layFabricByProduct,
    splitOrderCost,
    orderMainShareOuts,
    receiptTargetsByProduct,
  } = splitMod;
  const {
    applyDocumentCosts,
    reconcileOrderCosts,
    wipAccountCode,
  } = reconcileMod;

  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() || { id: 1 };
  const whRow = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()
    || db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  const whId = whRow.id;
  const cc10 = (db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()
    || db.prepare('SELECT id FROM cost_centers LIMIT 1').get()).id;

  let seq = 0;
  function makeProduct(name, code, itemType = 'finished', isManufactured = 1, stock = 100) {
    seq += 1;
    return Number(db.prepare(`
      INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured, price, stock, average_cost_rial)
      VALUES (?, ?, ?, 'عدد', ?, ?, 0, ?, 1000)
    `).run(admin.id, name, `${code}-${seq}`, itemType, isManufactured ? 1 : 0, stock).lastInsertRowid);
  }

  function makeBom(productId, code, fabricIds) {
    const bomId = Number(db.prepare(`
      INSERT INTO bom_headers
        (code, product_id, version, revision, name, base_qty, status, is_default, has_routing, has_coproducts, yield_percent, created_by)
      VALUES (?, ?, 1, 'A', ?, 1, 'draft', 1, 0, 0, 100, ?)
    `).run(code, productId, code, admin.id).lastInsertRowid);
    const insLine = db.prepare(`
      INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, line_type, stage_cost_center_id)
      VALUES (?, ?, ?, 1, 'material', ?)
    `);
    fabricIds.forEach((fid, idx) => {
      insLine.run(bomId, idx + 1, fid, cc10);
    });
    db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);
    return bomId;
  }

  function makePeerOrder(orderNo, prodA, bomA, qtyA, prodB, bomB, qtyB, materialCostRial = 0) {
    const fgPlan = JSON.stringify([
      { product_id: prodA, qty: qtyA, bom_id: bomA },
      { product_id: prodB, qty: qtyB, bom_id: bomB },
    ]);
    const id = Number(db.prepare(`
      INSERT INTO production_orders
        (order_no, product_id, bom_id, qty_planned, date, status, analysis_type, fg_plan_json, material_cost_rial, warehouse_fg_id, created_by)
      VALUES (?, ?, ?, ?, '1405/08/10', 'completed', 'fixed_adv', ?, ?, ?, ?)
    `).run(orderNo, prodA, bomA, qtyA, fgPlan, materialCostRial, whId, admin.id).lastInsertRowid);
    return db.prepare('SELECT * FROM production_orders WHERE id=?').get(id);
  }

  let laySeq = 0;
  function insertLay(orderId, productId, fabricProductId, amountRial, opts = {}) {
    laySeq += 1;
    const status = opts.status || 'posted';
    const batchId = opts.batchId != null ? opts.batchId : null;
    const wasteRial = opts.wasteRial || 0;
    return Number(db.prepare(`
      INSERT INTO cutting_lays
        (lay_no, product_id, fabric_product_id, marker_length_m, ply_count, status, date, amount_rial, waste_amount_rial, batch_id, production_order_id)
      VALUES (?, ?, ?, 1, 10, ?, '1405/08/10', ?, ?, ?, ?)
    `).run(`LAY-V623-${laySeq}`, productId, fabricProductId, status, amountRial, wasteRial, batchId, orderId).lastInsertRowid);
  }

  function insertIssue(orderId, productId, amountRial, note = 'LAY') {
    return Number(db.prepare(`
      INSERT INTO production_material_issues
        (order_id, product_id, issue_type, qty_actual, unit_cost_rial, amount_rial, warehouse_id, date, status, note)
      VALUES (?, ?, 'cutting_lay', 1, ?, ?, ?, '1405/08/10', 'posted', ?)
    `).run(orderId, productId, amountRial, amountRial, whId, note).lastInsertRowid);
  }

  function insertReceipt(orderId, productId, qty, amountRial) {
    const unitCost = qty > 0 ? Math.round(amountRial / qty) : amountRial;
    return Number(db.prepare(`
      INSERT INTO production_receipts
        (order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
      VALUES (?, ?, ?, ?, ?, ?, '1405/08/10', 'posted')
    `).run(orderId, productId, qty, unitCost, amountRial, whId).lastInsertRowid);
  }

  // مواد اولیه: پارچه مشترک M و پارچه اختصاصی K «کشبافت»
  const fabricM = makeProduct('پارچه اصلی مشترک M', 'RM-FAB-M', 'raw', 0);
  const fabricK = makeProduct('کشبافت', 'RM-FAB-K', 'raw', 0);

  // محصولات نهایی: محصول A (فقط M) و محصول B شبیه ۳۳۶ (دارای کشبافت K + پارچه M)
  const prodA = makeProduct('مانتو محصول A', 'FG-A', 'finished', 1, 60);
  const prodB = makeProduct('هودی محصول ۳۳۶ (B)', 'FG-336', 'finished', 1, 40);

  const bomA = makeBom(prodA, 'BOM-0031', [fabricM]);
  const bomB = makeBom(prodB, 'BOM-0032', [fabricK, fabricM]);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۱: تشخیص مالک پارچه در فرمول‌های سفارش چندمحصولی (layFabricOwnerProducts)
  // ══════════════════════════════════════════════════════════════════════════
  const po1 = makePeerOrder('PO-V623-S1', prodA, bomA, 60, prodB, bomB, 40);
  const ownersK = layFabricOwnerProducts(db, po1, fabricK, [prodA, prodB]);
  const ownersM = layFabricOwnerProducts(db, po1, fabricM, [prodA, prodB]);

  eq('سناریو ۱: تعداد مالک پارچه کشبافت (K) دقیقاً ۱ محصول است', ownersK.length, 1);
  eq('سناریو ۱: مالک پارچه کشبافت (K) فقط محصول B است', ownersK[0], prodB);
  ok('سناریو ۱: مالک پارچه مشترک (M) هر دو محصول A و B است (بدون حساسیت به ترتیب)',
    ownersM.length === 2
      && [...ownersM].sort((x, y) => x - y).join(',') === [prodA, prodB].sort((x, y) => x - y).join(','),
    JSON.stringify(ownersM));

  const mainShares1 = orderMainShareOuts(db, po1);
  eq('سناریو ۱: orderMainShareOuts دو محصول اصلی برمی‌گرداند', mainShares1.shareOuts.length, 2);
  eq('سناریو ۱: سهم محصول A از تعداد ۶۰٪ است',
    mainShares1.shareOuts.find(x => Number(x.product_id) === prodA).cost_share_percent, 60);
  eq('سناریو ۱: سهم محصول B از تعداد ۴۰٪ است',
    mainShares1.shareOuts.find(x => Number(x.product_id) === prodB).cost_share_percent, 40);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۲: تسهیم بهای سفارش (splitOrderCost) با لایهٔ اختصاصی K و لایهٔ مشترک M
  // ══════════════════════════════════════════════════════════════════════════
  // لایهٔ کلاسیک K = ۱٬۰۰۰٬۰۰۰ ریال (فقط در BOM-B) و لایهٔ کلاسیک M = ۶۰۰٬۰۰۰ ریال (مشترک در هر دو BOM)
  // کل بها = ۲٬۶۰۰٬۰۰۰ ریال (شامل ۱٬۰۰۰٬۰۰۰ K + ۶۰۰٬۰۰۰ M + ۱٬۰۰۰٬۰۰۰ سایر هزینه‌های مشترک)
  insertLay(po1.id, prodB, fabricK, 1000000);
  insertLay(po1.id, prodA, fabricM, 600000);

  const TOTAL_S2 = 2600000;
  const sp2 = splitOrderCost(db, po1, {
    total: TOTAL_S2,
    products: [
      { product_id: prodA, pct: 60 },
      { product_id: prodB, pct: 40 },
    ],
    residueProductId: prodA,
  });
  const rowA2 = sp2.rows.find(r => Number(r.product_id) === prodA);
  const rowB2 = sp2.rows.find(r => Number(r.product_id) === prodB);

  eq('سناریو ۲: B.lay_fabric_rial برابر ۱٬۰۰۰٬۰۰۰ ریال است', rowB2.lay_fabric_rial, 1000000);
  eq('سناریو ۲: A.lay_fabric_rial برابر ۰ ریال است', rowA2.lay_fabric_rial, 0);
  eq('سناریو ۲: sp.lay_fabric_rial کل برابر ۱٬۰۰۰٬۰۰۰ ریال است (لایه M مستقیم نیست)', sp2.lay_fabric_rial, 1000000);
  eq('سناریو ۲: حوضچهٔ مشترک (pool_rial) شامل لایهٔ M و سایر هزینه‌ها (۱٬۶۰۰٬۰۰۰) است', sp2.pool_rial, 1600000);
  eq('سناریو ۲: سهم مشترک A (۶۰٪ از ۱٬۶۰۰٬۰۰۰) برابر ۹۶۰٬۰۰۰ ریال است', rowA2.shared_rial, 960000);
  eq('سناریو ۲: سهم مشترک B (۴۰٪ از ۱٬۶۰۰٬۰۰۰) برابر ۶۴۰٬۰۰۰ ریال است', rowB2.shared_rial, 640000);
  eq('سناریو ۲: مبلغ نهایی A برابر ۹۶۰٬۰۰۰ ریال است', rowA2.amount_rial, 960000);
  eq('سناریو ۲: مبلغ نهایی B برابر ۱٬۶۴۰٬۰۰۰ ریال است', rowB2.amount_rial, 1640000);
  eq('سناریو ۲: جمع سطرها دقیقاً برابر total است',
    sp2.rows.reduce((s, r) => s + r.amount_rial, 0), TOTAL_S2);
  ok('سناریو ۲: fabric_source شامل lay_bom است',
    String(sp2.fabric_source || '').includes('lay_bom'), sp2.fabric_source);

  const targets2 = receiptTargetsByProduct(db, po1, TOTAL_S2);
  ok('سناریو ۲: receiptTargetsByProduct برای سفارش چندمحصولی خروجی می‌دهد', !!targets2);
  eq('سناریو ۲: هدف رسید B در receiptTargetsByProduct برابر ۱٬۶۴۰٬۰۰۰ است',
    targets2 && targets2.rows.find(r => Number(r.product_id) === prodB).amount_rial, 1640000);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۳: نادیده گرفتن لایهٔ ابطال‌شده (reversed) و لایهٔ دارای batch_id در layFabricByProduct
  // ══════════════════════════════════════════════════════════════════════════
  const po3 = makePeerOrder('PO-V623-S3', prodA, bomA, 60, prodB, bomB, 40);
  insertLay(po3.id, prodB, fabricK, 1000000, { status: 'posted' });
  insertLay(po3.id, prodB, fabricK, 500000, { status: 'reversed' });
  const batchId3 = Number(db.prepare(`
    INSERT INTO cutting_batches (batch_no, fabric_product_id, date, status, common_rial)
    VALUES ('CB-V623-S3', ?, '1405/08/10', 'posted', 750000)
  `).run(fabricK).lastInsertRowid);
  insertLay(po3.id, prodB, fabricK, 750000, { status: 'posted', batchId: batchId3 });

  const layMap3 = layFabricByProduct(db, po3, [prodA, prodB]);
  eq('سناریو ۳: layFabricByProduct فقط لایهٔ کلاسیک posted بدون batch را برای B لحاظ می‌کند (۱٬۰۰۰٬۰۰۰)',
    layMap3.get(prodB) || 0, 1000000);
  eq('سناریو ۳: layFabricByProduct برای محصول A مقدار ۰ دارد',
    layMap3.get(prodA) || 0, 0);

  // ضایعات غیرعادی لایهٔ کلاسیک با PRD-09 از WIP خارج شده ⇒ فقط مبلغ خالص به محصول مالک
  const po3w = makePeerOrder('PO-V623-S3W', prodA, bomA, 60, prodB, bomB, 40);
  insertLay(po3w.id, prodB, fabricK, 1000000, { status: 'posted', wasteRial: 150000 });
  eq('سناریو ۳: لایه با ضایعات غیرعادی ۱۵۰٬۰۰۰ ⇒ سهم خالص B = ۸۵۰٬۰۰۰',
    layFabricByProduct(db, po3w, [prodA, prodB]).get(prodB) || 0, 850000);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۴: تطبیق خودکار (reconcile auto) با افزودن لایهٔ کشبافت K (gap = 1,000,000 فقط روی B)
  // ══════════════════════════════════════════════════════════════════════════
  // ابتدا سفارش با ۱٬۶۰۰٬۰۰۰ ریال مواد اولیه (مثلاً لایه مشترک M = ۶۰۰٬۰۰۰ + سایر مواد = ۱٬۰۰۰٬۰۰۰)
  // و رسیدهای ثبت‌شده به نسبت ۶۰/۴۰ قبل از لایهٔ K (A = ۹۶۰٬۰۰۰ و B = ۶۴۰٬۰۰۰)
  const po4 = makePeerOrder('PO-V623-S4', prodA, bomA, 60, prodB, bomB, 40, 1600000);
  insertIssue(po4.id, fabricM, 600000, 'LAY-M');
  insertIssue(po4.id, fabricM, 1000000, 'BASE-MAT');
  insertLay(po4.id, prodA, fabricM, 600000, { status: 'posted' });
  const recA4Id = insertReceipt(po4.id, prodA, 60, 960000);
  const recB4Id = insertReceipt(po4.id, prodB, 40, 640000);
  applyDocumentCosts(db, po4.id);
  eq('سناریو ۴: ماندهٔ WIP پیش از افزودن لایهٔ K صفر است', engine.wipResidual(db, po4.id), 0);

  // افزودن هزینهٔ لایهٔ K (۱٬۰۰۰٬۰۰۰ ریال) به اسناد سفارش → شکاف ۱٬۰۰۰٬۰۰۰ ریال
  insertIssue(po4.id, fabricK, 1000000, 'LAY-K');
  insertLay(po4.id, prodB, fabricK, 1000000, { status: 'posted' });
  applyDocumentCosts(db, po4.id);

  const res4 = reconcileOrderCosts(db, po4.id, { mode: 'auto', userId: admin.id });
  const recA4After = db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(recA4Id).amount_rial;
  const recB4After = db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(recB4Id).amount_rial;

  ok('سناریو ۴: تطبیق خودکار اعمال شد', res4.applied === true);
  eq('سناریو ۴: روش تخصیص رسید product_target است', res4.allocation === 'product_target' ? 1 : 0, 1);
  eq('سناریو ۴: رسید محصول B به اندازهٔ +۱٬۰۰۰٬۰۰۰ ریال افزایش یافت (۱٬۶۴۰٬۰۰۰)', recB4After, 1640000, 1);
  eq('سناریو ۴: رسید محصول A بدون تغییر ماند (۹۶۰٬۰۰۰)', recA4After, 960000, 1);
  eq('سناریو ۴: after_residual_rial پس از تطبیق حدود صفر است', res4.after_residual_rial, 0, 1);
  eq('سناریو ۴: ماندهٔ WIP موتور پس از تطبیق صفر است', engine.wipResidual(db, po4.id), 0, 1);

  // بررسی سند حسابداری (JE تراز و بستانکار شدن WIP به اندازهٔ شکاف)
  const je4 = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='order_cost_receipt_align' AND ref_id=?
    ORDER BY id DESC LIMIT 1
  `).get(po4.id);
  ok('سناریو ۴: سند حسابداری تطبیق رسید صادر شده است', !!(je4 && je4.id));
  const jLines4 = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(je4 ? je4.id : 0);
  const sumDr4 = jLines4.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const sumCr4 = jLines4.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  eq('سناریو ۴: سند حسابداری تراز است (جمع بدهکار = جمع بستانکار = ۱۰۰٬۰۰۰ تومان)', sumDr4, sumCr4);
  const wipCode = wipAccountCode(db);
  const wipCrLine4 = jLines4.find(l => String(l.account_code) === String(wipCode));
  eq('سناریو ۴: حساب WIP به اندازهٔ شکاف (۱٬۰۰۰٬۰۰۰ ریال = ۱۰۰٬۰۰۰ تومان) بستانکار شده است',
    wipCrLine4 ? Number(wipCrLine4.credit) * 10 : 0, 1000000);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۵: بازگشت به تسهیم تعدادی (Fallback 60/40) وقتی لایهٔ اضافه پارچهٔ مشترک M است
  // ══════════════════════════════════════════════════════════════════════════
  const po5 = makePeerOrder('PO-V623-S5', prodA, bomA, 60, prodB, bomB, 40, 1600000);
  insertIssue(po5.id, fabricM, 1600000, 'BASE-MAT');
  const recA5Id = insertReceipt(po5.id, prodA, 60, 960000);
  const recB5Id = insertReceipt(po5.id, prodB, 40, 640000);
  applyDocumentCosts(db, po5.id);

  // لایهٔ اضافه با پارچهٔ M (مشترک در هر دو BOM) به مبلغ ۱٬۰۰۰٬۰۰۰ ریال
  insertIssue(po5.id, fabricM, 1000000, 'LAY-M-EXTRA');
  insertLay(po5.id, prodA, fabricM, 1000000, { status: 'posted' });
  applyDocumentCosts(db, po5.id);

  const res5 = reconcileOrderCosts(db, po5.id, { mode: 'auto', userId: admin.id });
  const recA5After = db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(recA5Id).amount_rial;
  const recB5After = db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(recB5Id).amount_rial;

  eq('سناریو ۵: روش تخصیص در سفارش چندمحصولی همچنان product_target است',
    res5.allocation === 'product_target' ? 1 : 0, 1);
  eq('سناریو ۵: رسید محصول A شصت درصد شکاف (+۶۰۰٬۰۰۰ → ۱٬۵۶۰٬۰۰۰) دریافت کرد', recA5After, 1560000, 1);
  eq('سناریو ۵: رسید محصول B چهل درصد شکاف (+۴۰۰٬۰۰۰ → ۱٬۰۴۰٬۰۰۰) دریافت کرد', recB5After, 1040000, 1);
  eq('سناریو ۵: after_residual_rial پس از تطبیق صفر است', res5.after_residual_rial, 0, 1);

  // ══════════════════════════════════════════════════════════════════════════
  // سناریو ۶: سفارش تک‌محصولی همچنان با allocation==='amount_share' و رفتار قبلی کار می‌کند
  // ══════════════════════════════════════════════════════════════════════════
  const po6Id = Number(db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, bom_id, qty_planned, date, status, analysis_type, material_cost_rial, warehouse_fg_id, created_by)
    VALUES ('PO-V623-S6', ?, ?, 50, '1405/08/10', 'completed', 'fixed_adv', 1000000, ?, ?)
  `).run(prodB, bomB, whId, admin.id).lastInsertRowid);
  const po6 = db.prepare('SELECT * FROM production_orders WHERE id=?').get(po6Id);
  eq('سناریو ۶: receiptTargetsByProduct برای سفارش تک‌محصولی null برمی‌گرداند',
    receiptTargetsByProduct(db, po6, 1500000), null);

  insertIssue(po6Id, fabricK, 1000000, 'BASE-SINGLE');
  const rec6Id = insertReceipt(po6Id, prodB, 50, 1000000);
  // افزودن ۵۰۰٬۰۰۰ ریال هزینهٔ جدید به اسناد سفارش تک‌محصولی
  insertIssue(po6Id, fabricK, 500000, 'EXTRA-SINGLE');
  insertLay(po6Id, prodB, fabricK, 500000, { status: 'posted' });
  applyDocumentCosts(db, po6Id);

  const res6 = reconcileOrderCosts(db, po6Id, { mode: 'auto', userId: admin.id });
  const rec6After = db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(rec6Id).amount_rial;

  ok('سناریو ۶: تطبیق خودکار سفارش تک‌محصولی اعمال شد', res6.applied === true);
  eq('سناریو ۶: allocation در سفارش تک‌محصولی amount_share است',
    res6.allocation === 'amount_share' ? 1 : 0, 1);
  eq('سناریو ۶: رسید سفارش تک‌محصولی به ۱٬۵۰۰٬۰۰۰ ریال رسید', rec6After, 1500000, 1);
  eq('سناریو ۶: ماندهٔ نهایی سفارش تک‌محصولی صفر است', res6.after_residual_rial, 0, 1);
} catch (e) {
  ok('اجرای تست تخصیص لایه به محصول (v623)', false, e && (e.stack || e.message || e.code));
} finally {
  cleanup();
}

console.log(`\n${passedChecks}/${totalChecks} passed`);
summary('v623 lay-product-alloc');
