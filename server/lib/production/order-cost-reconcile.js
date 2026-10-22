'use strict';

/**
 * ستون‌های بهای سفارش از اسناد زنده ساخته می‌شوند، نه از جمع‌های افزایشی.
 *
 * ماندهٔ WIP فقط ضایعاتی را کم می‌کند که واقعاً از WIP خارج شده‌اند
 * (production_waste + اتلاف لایهٔ کلاسیک با بستانکار WIP).
 * اتلاف طولی برش مشترک (ADR-005: بستانکار مواد، نه WIP) در ماندهٔ بستن نیست.
 *
 * اگر ستون‌ها با اسناد یکی باشند ولی رسید ≠ خالص WIP، تطبیق رسید
 * (الگوی ADR-006 / v466) مانده را صفر می‌کند.
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

/** اتلاف لایهٔ کلاسیک: وارد WIP شده و با PRD-09 از WIP خارج می‌شود. */
function classicLayWasteRial(db, orderId) {
  return sumOf(db, `
    SELECT COALESCE(SUM(waste_amount_rial),0) AS s
    FROM cutting_lays
    WHERE production_order_id=? AND COALESCE(status,'posted')='posted'
      AND (batch_id IS NULL OR batch_id=0)
  `, [orderId]);
}

/** اتلاف طولی برش مشترک: هرگز وارد WIP نشده (بستانکار مواد). */
function sharedLayWasteRial(db, orderId) {
  return sumOf(db, `
    SELECT COALESCE(SUM(waste_amount_rial),0) AS s
    FROM cutting_lays
    WHERE production_order_id=? AND COALESCE(status,'posted')='posted'
      AND batch_id IS NOT NULL AND batch_id!=0
  `, [orderId]);
}

function stageAbnormalWasteRial(db, orderId) {
  return sumOf(db, `
    SELECT COALESCE(SUM(amount_rial),0) AS s
    FROM production_waste
    WHERE order_id=? AND status='posted' AND waste_type='abnormal'
  `, [orderId]);
}

/** مصرف اضافهٔ غیرعادی مرحله (v513): بستانکار مواد، بدهکار ۵۲۲۱ — هرگز وارد WIP نشده. */
function extraAbnormalMaterialRial(db, orderId) {
  return sumOf(db, `
    SELECT COALESCE(SUM(amount_rial),0) AS s
    FROM production_material_issues
    WHERE order_id=? AND status='posted' AND issue_type='extra' AND COALESCE(extra_class,'')='abnormal'
  `, [orderId]);
}

/** ضایعات مؤثر بر ماندهٔ WIP (برای بستن سفارش). */
function wipEffectiveAbnormalWasteRial(db, orderId) {
  return stageAbnormalWasteRial(db, orderId) + classicLayWasteRial(db, orderId);
}

/** ستون نمایشی/گزارشی: همهٔ ضایعات غیرعادی اقتصادی. */
function economicAbnormalWasteRial(db, orderId) {
  return stageAbnormalWasteRial(db, orderId)
    + classicLayWasteRial(db, orderId)
    + sharedLayWasteRial(db, orderId)
    + extraAbnormalMaterialRial(db, orderId);
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
      AND COALESCE(mi.extra_class,'')<>'abnormal'
  `).get(orderId);
  const totalIssued = num(issued && issued.total);
  const pkg = num(issued && issued.pkg);
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
    abnormal_waste_rial: economicAbnormalWasteRial(db, orderId),
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

function innOf(buckets, po) {
  return num(buckets.material_cost_rial) + num(buckets.packaging_cost_rial)
    + num(buckets.labor_cost_rial) + num(buckets.overhead_cost_rial)
    + num(buckets.subcontract_cost_rial) + num(po.rework_cost_rial);
}

function residualOf(buckets, po, receipts, wipAbnormal) {
  const out = num(wipAbnormal) + num(buckets.scrap_credit_rial)
    + num(po.byproduct_credit_rial) + num(receipts);
  return innOf(buckets, po) - out;
}

function expectedReceiptsRial(buckets, po, wipAbnormal) {
  return innOf(buckets, po)
    - num(wipAbnormal)
    - num(buckets.scrap_credit_rial)
    - num(po.byproduct_credit_rial);
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

function assertOrderMutableForReconcile(before) {
  if (before.status === 'closed') {
    const fail = new Error('سفارش بسته است. اول بازگشایی کنید، بعد بها را اصلاح کنید.');
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
}

function previewOrderCostReconcile(db, orderId) {
  const po = loadOrder(db, orderId);
  const documents = documentCostBuckets(db, po.id);
  const before = headerBuckets(po);
  const receipts = receiptSum(db, po.id);
  const wipAbnormal = wipEffectiveAbnormalWasteRial(db, po.id);
  const sharedWaste = sharedLayWasteRial(db, po.id);
  const expected = expectedReceiptsRial(documents, po, wipAbnormal);
  const afterResidual = residualOf(documents, po, receipts, wipAbnormal);
  const aligned = !bucketsDiffer(before, documents);
  return {
    order_id: po.id,
    order_no: po.order_no,
    status: po.status,
    receipts_rial: receipts,
    expected_receipts_rial: expected,
    receipt_gap_rial: receipts - expected,
    rework_cost_rial: num(po.rework_cost_rial),
    byproduct_credit_rial: num(po.byproduct_credit_rial),
    wip_abnormal_waste_rial: wipAbnormal,
    shared_lay_waste_rial: sharedWaste,
    before,
    documents,
    before_residual_rial: residualOf(before, po, receipts, wipAbnormal),
    after_residual_rial: afterResidual,
    // بعد از auto (ستون‌ها + تطبیق رسید در صورت نیاز) مانده باید صفر شود
    projected_after_auto_rial: residualOf(documents, po, expected, wipAbnormal),
    aligned,
    can_align_columns: !aligned,
    can_align_receipt: Math.abs(receipts - expected) > 5,
    receipts_touched: false,
    journal_touched: false,
  };
}

function applyDocumentCosts(db, orderId) {
  const before = previewOrderCostReconcile(db, orderId);
  assertOrderMutableForReconcile(before);
  if (before.aligned) return Object.assign({ applied: false, mode: 'columns' }, before);
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
  return Object.assign({ applied: true, mode: 'columns' }, after);
}

/**
 * تطبیق مبلغ رسیدهای زنده با خالص WIP مورد انتظار (R2).
 * موجودی فروخته‌نشده → FG؛ فروخته‌شده → COGS؛ طرف مقابل WIP.
 */
function applyReceiptToWipNet(db, orderId, userId) {
  const preview = previewOrderCostReconcile(db, orderId);
  assertOrderMutableForReconcile(preview);
  if (!['completed', 'in_progress'].includes(preview.status) && preview.status !== 'released') {
    // completed is the normal case; allow in_progress if receipts already exist
  }
  const gap = num(preview.expected_receipts_rial) - num(preview.receipts_rial);
  if (Math.abs(gap) <= 5) {
    return Object.assign({ applied: false, mode: 'receipt', receipt_delta_rial: 0 }, preview);
  }
  if (!preview.aligned) {
    const fail = new Error('اول ستون‌های سفارش را با اسناد یکی کنید، بعد رسید را تطبیق دهید.');
    fail.status = 409;
    fail.code = 'E_COLUMNS_NOT_ALIGNED';
    throw fail;
  }

  const po = loadOrder(db, orderId);
  const receipts = db.prepare(`
    SELECT * FROM production_receipts
    WHERE order_id=? AND status='posted' AND COALESCE(amount_rial,0) > 0
    ORDER BY id
  `).all(po.id);
  if (!receipts.length) {
    const fail = new Error('رسید تولید زنده‌ای برای تطبیق پیدا نشد');
    fail.status = 409;
    fail.code = 'E_NO_RECEIPT';
    throw fail;
  }
  const totalAmt = receipts.reduce((s, r) => s + num(r.amount_rial), 0);
  if (!(totalAmt > 0)) {
    const fail = new Error('مبلغ رسید صفر است');
    fail.status = 409;
    fail.code = 'E_NO_RECEIPT';
    throw fail;
  }

  let assigned = 0;
  const shares = receipts.map((receipt, i) => {
    const part = i === receipts.length - 1
      ? gap - assigned
      : Math.round(gap * (num(receipt.amount_rial) / totalAmt));
    assigned += part;
    return { receipt, share: part };
  });
  for (const { receipt, share } of shares) {
    const nextAmt = num(receipt.amount_rial) + share;
    if (nextAmt < 0) {
      const fail = new Error('اختلاف بها از مبلغ رسید بیشتر است');
      fail.status = 409;
      fail.code = 'E_RECEIPT_DELTA_EXCEEDS';
      throw fail;
    }
  }

  const { postToLedger } = require('../ledger');
  const { dr, cr } = require('./posting');
  const { todayJalali } = require('../../jalali');
  const date = po.actual_end || po.date || todayJalali();

  for (const { receipt, share } of shares) {
    if (!share) continue;
    const nextAmt = num(receipt.amount_rial) + share;
    const qty = Number(receipt.qty) || 0;
    const nextUnit = qty > 0 ? Math.round(nextAmt / qty) : num(receipt.unit_cost_rial);
    db.prepare('UPDATE production_receipts SET amount_rial=?, unit_cost_rial=? WHERE id=?')
      .run(nextAmt, nextUnit, receipt.id);
  }
  const routed = routeReceiptValueChange(db, {
    sourceType: 'order_cost_receipt_align',
    sourceId: po.id,
    label: `تطبیق رسید با خالص WIP — ${po.order_no}`,
    eventNote: `تطبیق رسید با خالص WIP — ${po.order_no}`,
    shares,
    date,
    userId: userId || po.created_by || 1,
  });
  const lines = routed.lines.slice();
  if (gap > 0) lines.push(cr(db, 'coa_wip', gap, po.coa_wip_tafsili || null));
  else lines.push(dr(db, 'coa_wip', -gap, po.coa_wip_tafsili || null));

  if (lines.length) {
    postToLedger(db, {
      sourceType: 'order_cost_receipt_align',
      sourceId: po.id,
      date,
      description: `تطبیق رسید با خالص WIP — ${po.order_no}`,
      createdBy: userId || po.created_by || 1,
      costCenterId: po.cost_center_id || null,
      lines,
    });
  }

  const sum = receiptSum(db, po.id);
  const header = db.prepare(`
    SELECT amount_rial, qty FROM production_receipts
    WHERE order_id=? AND product_id=? AND status='posted'
    ORDER BY id DESC LIMIT 1
  `).get(po.id, po.product_id) || db.prepare(`
    SELECT amount_rial, qty FROM production_receipts
    WHERE order_id=? AND status='posted' ORDER BY id DESC LIMIT 1
  `).get(po.id);
  const unit = header && Number(header.qty) > 0
    ? Math.round(num(header.amount_rial) / Number(header.qty))
    : 0;
  db.prepare('UPDATE production_orders SET total_cost_rial=?, unit_cost_rial=? WHERE id=?')
    .run(sum, unit, po.id);

  const after = previewOrderCostReconcile(db, orderId);
  return Object.assign({}, after, {
    applied: true,
    mode: 'receipt',
    receipt_delta_rial: gap,
    receipts_touched: true,
    journal_touched: true,
    value_approval_id: routed.approval ? routed.approval.id : null,
  });
}

/**
 * Value side of a change to posted production receipts (receipt align, covered lay delta).
 * shares: [{ receipt, share }] — receipt amounts are already updated by the caller.
 *  Open month: unsold part → FG value row, sold part → COGS (JE lines returned; WIP side is the caller's).
 *  Closed inventory month (v525): the whole change → «تعدیل بهای در انتظار تأیید» + ONE closed_period
 *  approval doc per source; approval/rejection follows value-approval.js.
 * Earlier approval docs of the same source are cancelled first (decisions undone, R13) and their
 * un-applied change is re-routed with this posting — so one source never has two live docs.
 */
function routeReceiptValueChange(db, {
  sourceType, sourceId, label, eventNote, shares, date, userId,
}) {
  const VAP = require('../inventory/value-approval');
  const VA = require('../inventory/value-accounts');
  const { acct } = require('../coa-map');
  const { postInventoryMovement } = require('../inventory/ledger');
  const fg = acct(db, 'coa_finished_goods');
  const cogs = acct(db, 'coa_cogs');
  const clearing = VA.clearingAccount(db);
  const lines = [];
  const push = (acc, amount, description) => {
    const a = num(amount);
    if (!a) return;
    lines.push({
      code: acc.code, name: acc.name,
      debit: a > 0 ? a / 10 : 0, credit: a < 0 ? -a / 10 : 0,
      description: description || label,
    });
  };
  const gate = VAP.begin(db, { sourceType, sourceId, date, createdBy: userId, label });
  const carry = VAP.cancelForSourceCarry(db, sourceType, sourceId, { id: userId }, `ثبت مجدد — ${label}`);
  const items = [];
  for (const { receipt, share } of shares || []) {
    if (!num(share)) continue;
    items.push({
      productId: receipt.product_id, warehouseId: receipt.warehouse_id || null,
      refQty: Number(receipt.qty) || 0, delta: num(share), fromClearing: false, inv: fg,
    });
  }
  for (const c of carry.lines) {
    items.push({
      productId: c.product_id, warehouseId: c.warehouse_id || null, refQty: Number(c.ref_qty) || 0,
      delta: num(c.delta_rial), fromClearing: true,
      inv: c.inventory_code ? { code: c.inventory_code, name: c.inventory_name || fg.name } : fg,
    });
  }
  for (const it of items) {
    if (gate.closed) {
      gate.gate({
        productId: it.productId, warehouseId: it.warehouseId, refQty: it.refQty, deltaRial: it.delta,
        inventoryCode: it.inv.code, inventoryName: it.inv.name, note: eventNote || label,
      });
      // A carried line already sits in clearing; a new share goes there now.
      if (!it.fromClearing) push(clearing, it.delta, 'تغییر بها در انتظار تأیید (قفل دوره)');
      continue;
    }
    if (it.fromClearing) push(clearing, -it.delta, 'تسویه تعدیل بهای در انتظار تأیید');
    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(it.productId);
    const onHand = Math.max(0, Number(prod && prod.stock) || 0);
    const unsold = it.refQty > 0 ? Math.min(1, onHand / it.refQty) : (onHand > 0 ? 1 : 0);
    const invShare = Math.round(it.delta * unsold);
    const cogsShare = it.delta - invShare;
    push(it.inv, invShare);
    push(cogs, cogsShare);
    if (invShare && onHand > 0) {
      // Header avg moves by value inside postInventoryMovement (valueOnly row).
      postInventoryMovement(db, {
        eventType: 'production_receipt',
        productId: it.productId,
        warehouseId: it.warehouseId,
        qtyIn: 0,
        qtyOut: 0,
        unitCostRial: Math.abs(invShare),
        amountRial: invShare,
        sourceType,
        sourceId,
        date,
        note: eventNote || label,
        createdBy: userId,
        updateAvg: false,
        skipStock: true,
        valueOnly: true,
      });
    }
  }
  const approval = gate.finish({ park: false });
  return { lines: mergeLines(lines), approval, carried_rial: carry.total };
}

function mergeLines(lines) {
  const by = new Map();
  for (const l of lines) {
    const cur = by.get(l.code) || { code: l.code, name: l.name, net: 0, description: l.description };
    cur.net += (Number(l.debit) || 0) - (Number(l.credit) || 0);
    by.set(l.code, cur);
  }
  return [...by.values()].filter((l) => Math.abs(l.net) > 1e-9).map((l) => ({
    code: l.code, name: l.name, debit: l.net > 0 ? l.net : 0, credit: l.net < 0 ? -l.net : 0, description: l.description,
  }));
}

/**
 * auto: اول ستون‌ها، بعد در صورت نیاز رسید.
 * mode: 'columns' | 'receipt' | 'auto'
 */
function reconcileOrderCosts(db, orderId, { mode, userId } = {}) {
  const m = String(mode || 'auto').toLowerCase();
  if (m === 'columns') return applyDocumentCosts(db, orderId);
  if (m === 'receipt') return applyReceiptToWipNet(db, orderId, userId);

  const col = applyDocumentCosts(db, orderId);
  if (Math.abs(num(col.after_residual_rial)) <= 5) {
    return Object.assign({ applied: !!col.applied, mode: 'auto', steps: ['columns'] }, col);
  }
  if (!col.aligned && col.applied) {
    // columns just applied; re-check
  }
  const afterCol = previewOrderCostReconcile(db, orderId);
  if (!afterCol.aligned) {
    return Object.assign({
      applied: !!col.applied,
      mode: 'auto',
      steps: ['columns'],
      receipt_skipped: true,
    }, afterCol);
  }
  if (!afterCol.can_align_receipt) {
    return Object.assign({
      applied: !!col.applied,
      mode: 'auto',
      steps: ['columns'],
    }, afterCol);
  }
  const rec = applyReceiptToWipNet(db, orderId, userId);
  return Object.assign({}, rec, {
    mode: 'auto',
    steps: col.applied ? ['columns', 'receipt'] : ['receipt'],
    columns_applied: !!col.applied,
    applied: !!(col.applied || rec.applied),
  });
}

function wipResidualFromDocs(db, orderId) {
  const po = loadOrder(db, orderId);
  const buckets = headerBuckets(po);
  const receipts = receiptSum(db, po.id);
  const wipAbnormal = wipEffectiveAbnormalWasteRial(db, po.id);
  return residualOf(buckets, po, receipts, wipAbnormal);
}

module.exports = {
  BUCKETS,
  documentCostBuckets,
  previewOrderCostReconcile,
  applyDocumentCosts,
  applyReceiptToWipNet,
  reconcileOrderCosts,
  routeReceiptValueChange,
  wipEffectiveAbnormalWasteRial,
  classicLayWasteRial,
  sharedLayWasteRial,
  extraAbnormalMaterialRial,
  wipResidualFromDocs,
};
