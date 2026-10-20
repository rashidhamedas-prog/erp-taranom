'use strict';

/**
 * ستون‌های بهای سفارش از اسناد زنده ساخته می‌شوند، نه از جمع‌های افزایشی.
 * رسید تولید، موجودی و سند حسابداری اینجا عوض نمی‌شوند.
 * الگوی مرجع: ERPNext بهای ساخت را از Stock Entry می‌خواند؛ Odoo بهای محصول
 * تمام‌شده را از حرکت مصرف و عملیات دوباره حساب می‌کند، نه از یک جمع ذخیره‌شده.
 */

const BUCKETS = [
  'material_cost_rial',
  'packaging_cost_rial',
  'labor_cost_rial',
  'overhead_cost_rial',
  'subcontract_cost_rial',
  'abnormal_waste_rial',
  'scrap_credit_rial',
];

function num(v) {
  return Math.round(Number(v) || 0);
}

function sumOf(db, sql, params) {
  try {
    const row = db.prepare(sql).get(...params);
    return num(row && row.s);
  } catch (_) {
    return 0;
  }
}

function documentCostBuckets(db, orderId) {
  const issued = db.prepare(`
    SELECT COALESCE(SUM(mi.amount_rial),0) AS total,
           COALESCE(SUM(CASE
             WHEN bl.line_type='packaging' OR p.item_type='packaging' THEN mi.amount_rial
             ELSE 0 END),0) AS pkg
    FROM production_material_issues mi
    LEFT JOIN bom_lines bl ON bl.id = mi.bom_line_id
    LEFT JOIN products p ON p.id = mi.product_id
    WHERE mi.order_id=? AND mi.status='posted'
  `).get(orderId);
  const totalIssued = num(issued && issued.total);
  const pkg = num(issued && issued.pkg);
  const layWaste = sumOf(db, `
    SELECT COALESCE(SUM(waste_amount_rial),0) AS s
    FROM cutting_lays
    WHERE production_order_id=? AND COALESCE(status,'posted')='posted'
  `, [orderId]);
  const abnormalDocs = sumOf(db, `
    SELECT COALESCE(SUM(amount_rial),0) AS s
    FROM production_waste
    WHERE order_id=? AND status='posted' AND waste_type='abnormal'
  `, [orderId]);
  return {
    material_cost_rial: totalIssued - pkg,
    packaging_cost_rial: pkg,
    labor_cost_rial: sumOf(db, `
      SELECT COALESCE(SUM(amount_rial),0) AS s
      FROM production_labor_entries
      WHERE order_id=? AND status='posted'
    `, [orderId]),
    overhead_cost_rial: sumOf(db, `
      SELECT COALESCE(SUM(amount_rial),0) AS s
      FROM production_overhead_applications
      WHERE order_id=? AND status='posted'
    `, [orderId]),
    subcontract_cost_rial: sumOf(db, `
      SELECT COALESCE(SUM(fee_amount_rial),0) AS s
      FROM production_subcontract
      WHERE order_id=? AND status='posted' AND direction='in'
    `, [orderId]),
    abnormal_waste_rial: abnormalDocs + layWaste,
    scrap_credit_rial: sumOf(db, `
      SELECT COALESCE(SUM(amount_rial),0) AS s
      FROM production_waste
      WHERE order_id=? AND status='posted' AND waste_type='salable'
    `, [orderId]),
  };
}

function headerBuckets(po) {
  const out = {};
  for (const key of BUCKETS) out[key] = num(po[key]);
  return out;
}

function receiptSum(db, orderId) {
  return sumOf(db, `
    SELECT COALESCE(SUM(amount_rial),0) AS s
    FROM production_receipts
    WHERE order_id=? AND status='posted'
  `, [orderId]);
}

function residualOf(buckets, po, receipts) {
  const inn = num(buckets.material_cost_rial) + num(buckets.packaging_cost_rial)
    + num(buckets.labor_cost_rial) + num(buckets.overhead_cost_rial)
    + num(buckets.subcontract_cost_rial) + num(po.rework_cost_rial);
  const out = num(buckets.abnormal_waste_rial) + num(buckets.scrap_credit_rial)
    + num(po.byproduct_credit_rial) + num(receipts);
  return inn - out;
}

function bucketsDiffer(a, b) {
  return BUCKETS.some((key) => num(a[key]) !== num(b[key]));
}

function loadOrder(db, orderId) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) {
    const fail = new Error('سفارش تولید پیدا نشد');
    fail.status = 404;
    fail.code = 'E_NOT_FOUND';
    throw fail;
  }
  return po;
}

function previewOrderCostReconcile(db, orderId) {
  const po = loadOrder(db, orderId);
  const documents = documentCostBuckets(db, po.id);
  const before = headerBuckets(po);
  const receipts = receiptSum(db, po.id);
  return {
    order_id: po.id,
    order_no: po.order_no,
    status: po.status,
    receipts_rial: receipts,
    rework_cost_rial: num(po.rework_cost_rial),
    byproduct_credit_rial: num(po.byproduct_credit_rial),
    before,
    documents,
    before_residual_rial: residualOf(before, po, receipts),
    after_residual_rial: residualOf(documents, po, receipts),
    aligned: !bucketsDiffer(before, documents),
    receipts_touched: false,
    journal_touched: false,
  };
}

function applyDocumentCosts(db, orderId) {
  const before = previewOrderCostReconcile(db, orderId);
  if (before.status === 'closed') {
    const fail = new Error('سفارش بسته است. اول بازگشایی کنید، بعد بها را با اسناد یکی کنید.');
    fail.status = 409;
    fail.code = 'E_ORDER_CLOSED';
    throw fail;
  }
  if (['cancelled', 'voided'].includes(before.status)) {
    const fail = new Error('سفارش لغو یا حذف‌شده قابل اصلاح بها نیست');
    fail.status = 409;
    fail.code = 'E_INVALID_STATUS';
    throw fail;
  }
  if (before.aligned) return Object.assign({ applied: false }, before);
  const docs = before.documents;
  db.prepare(`
    UPDATE production_orders SET
      material_cost_rial=?,
      packaging_cost_rial=?,
      labor_cost_rial=?,
      overhead_cost_rial=?,
      subcontract_cost_rial=?,
      abnormal_waste_rial=?,
      scrap_credit_rial=?,
      updated_at=strftime('%s','now')
    WHERE id=?
  `).run(
    docs.material_cost_rial,
    docs.packaging_cost_rial,
    docs.labor_cost_rial,
    docs.overhead_cost_rial,
    docs.subcontract_cost_rial,
    docs.abnormal_waste_rial,
    docs.scrap_credit_rial,
    before.order_id
  );
  const after = previewOrderCostReconcile(db, orderId);
  return Object.assign({ applied: true }, after);
}

module.exports = {
  BUCKETS,
  documentCostBuckets,
  previewOrderCostReconcile,
  applyDocumentCosts,
};
