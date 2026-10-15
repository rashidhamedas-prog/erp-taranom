'use strict';
/**
 * Financialize warehouse_docs GRNI receipts into purchase invoices (value-only).
 * Pattern: ERPNext Purchase Receipt → Invoice (Update Stock OFF).
 * Receipt already posted Dr inventory / Cr 2112; invoice clears GRNI → AP.
 * Price variance vs provisional cost is capitalized value-only (landed-cost style).
 */
const { allocateNumber, isDevice, audit } = require('../db');
const { todayJalali } = require('../jalali');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { assertJournalIdempotent } = require('./sales-document');
const {
  postInventoryMovement, reverseInventoryMovement,
  inventoryAccountForWarehouse,
} = require('./inventory/ledger');
const { bumpOpenLayersValue } = require('./inventory/landed-cost');
const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');
const { assertMakerChecker } = require('./rbac');

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

function normalizeReceiptClass(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'grni' || s === 'supplier' || s === 'supplier_receipt') return 'grni';
  if (s === 'opening') return 'opening';
  return 'adjustment';
}

/**
 * Open GRNI warehouse receipts (not yet linked to a purchase invoice).
 */
function listOpenWarehouseGrni(db, {
  warehouseId = null, supplierId = null, limit = 100,
} = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const where = [
    "d.type='receipt'",
    "COALESCE(d.status,'posted')='posted'",
    "COALESCE(d.receipt_class,'adjustment')='grni'",
    'd.purchase_invoice_id IS NULL',
  ];
  const params = [];
  if (warehouseId) {
    where.push('d.to_warehouse_id=?');
    params.push(Number(warehouseId));
  }
  if (supplierId) {
    where.push('(d.supplier_id IS NULL OR d.supplier_id=?)');
    params.push(Number(supplierId));
  }
  const docs = db.prepare(`
    SELECT d.*, w.name AS warehouse_name, s.name AS supplier_name, u.name AS created_by_name
    FROM warehouse_docs d
    LEFT JOIN warehouses w ON w.id=d.to_warehouse_id
    LEFT JOIN suppliers s ON s.id=d.supplier_id
    LEFT JOIN users u ON u.id=d.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY d.date DESC, d.id DESC
    LIMIT ?
  `).all(...params, lim);

  return docs.map((d) => {
    const lines = db.prepare(`
      SELECT m.id AS move_id, m.product_id, m.variant_id, m.qty, m.unit_cost_rial, m.amount_rial,
             p.name AS product_name, p.code AS product_code
      FROM warehouse_moves m
      JOIN products p ON p.id=m.product_id
      WHERE m.doc_id=? AND COALESCE(m.status,'posted')='posted'
      ORDER BY m.line_no ASC, m.id ASC
    `).all(d.id);
    return {
      ...d,
      lines,
      provisional_rial: Math.round(Number(d.amount_rial_total) || lines.reduce((s, l) => s + (Number(l.amount_rial) || 0), 0)),
    };
  });
}

function loadGrniDocsForInvoice(db, docIds) {
  const ids = [...new Set((docIds || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (!ids.length) throw httpErr(400, 'حداقل یک رسید انبار GRNI انتخاب کنید', 'E_WH_GRNI_DOCS');
  const docs = [];
  for (const id of ids) {
    const d = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(id);
    if (!d || d.type !== 'receipt' || d.status === 'reversed') {
      throw httpErr(400, `رسید انبار #${id} یافت نشد`, 'E_WH_GRNI_NOT_FOUND');
    }
    if (normalizeReceiptClass(d.receipt_class) !== 'grni') {
      throw httpErr(400, `سند ${d.num || id} از نوع GRNI نیست`, 'E_WH_NOT_GRNI');
    }
    if (d.purchase_invoice_id) {
      throw httpErr(409, `رسید ${d.num || id} قبلاً فاکتور شده`, 'E_WH_GRNI_BILLED');
    }
    const moves = db.prepare(`
      SELECT m.*, p.name AS product_name, p.code AS product_code
      FROM warehouse_moves m
      JOIN products p ON p.id=m.product_id
      WHERE m.doc_id=? AND COALESCE(m.status,'posted')='posted'
      ORDER BY m.line_no ASC, m.id ASC
    `).all(id);
    if (!moves.length) throw httpErr(400, `رسید ${d.num || id} ردیف فعال ندارد`, 'E_WH_GRNI_EMPTY');
    docs.push({ ...d, moves });
  }
  const whIds = [...new Set(docs.map((d) => Number(d.to_warehouse_id)).filter(Boolean))];
  if (whIds.length > 1) {
    throw httpErr(400, 'همهٔ رسیدهای انتخابی باید همان انبار مقصد باشند', 'E_WH_GRNI_WH_MIX');
  }
  return docs;
}

/**
 * Apply per-line invoice prices. Body rows keyed by move_id (preferred) or product_id+qty.
 * Qty must match receipt move qty (full bill of selected docs in v400).
 */
function buildInvoiceRows(docs, bodyRows) {
  const byMove = new Map();
  for (const r of bodyRows || []) {
    const mid = parseInt(r.move_id || r.warehouse_move_id, 10);
    if (mid) byMove.set(mid, r);
  }
  const rows = [];
  let provisionalTotal = 0;
  let invoiceGoods = 0;
  for (const doc of docs) {
    for (const m of doc.moves) {
      const override = byMove.get(m.id) || {};
      const qty = Number(m.qty) || 0;
      const reqQty = override.qty != null ? Number(override.qty) : qty;
      if (Math.abs(reqQty - qty) > 1e-9) {
        throw httpErr(400, `مقدار ردیف ${m.product_name || m.product_id} باید برابر رسید باشد (فاکتور جزئی فعلاً پشتیبانی نمی‌شود)`, 'E_WH_GRNI_PARTIAL');
      }
      const price = Math.round(Number(override.price != null ? override.price : override.unit_price_rial) || 0);
      if (price < 0) throw httpErr(400, 'فی نمی‌تواند منفی باشد', 'E_WH_GRNI_PRICE');
      const amount = Math.round(qty * price);
      const provisional = Math.round(Number(m.amount_rial) || 0);
      provisionalTotal += provisional;
      invoiceGoods += amount;
      rows.push({
        product_id: m.product_id,
        variant_id: m.variant_id || null,
        name: m.product_name || '',
        qty,
        price,
        amount,
        disc: 0,
        disc_amount: 0,
        warehouse_id: doc.to_warehouse_id,
        warehouse_doc_id: doc.id,
        warehouse_move_id: m.id,
        provisional_rial: provisional,
        description: override.description || `از رسید ${doc.num || ('#' + doc.id)}`,
      });
    }
  }
  if (!rows.length) throw httpErr(400, 'ردیفی برای فاکتور نیست', 'E_WH_GRNI_ROWS');
  return { rows, provisionalTotal, invoiceGoods };
}

function applyValueVariance(db, {
  productId, warehouseId, deltaRial, purchaseId, date, userId,
}) {
  const share = Math.round(Number(deltaRial) || 0);
  if (!share) return null;
  const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  if (!prod) return null;
  const stock = Number(prod.stock) || 0;
  if (stock > 0) {
    const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
    const newAvg = Math.max(0, Math.round((stock * prevAvg + share) / stock));
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
      .run(newAvg, catalogCostFromAvgRial(newAvg), productId);
  }
  bumpOpenLayersValue(db, {
    productId,
    warehouseId: warehouseId || null,
    amountRial: share,
    sourceType: 'warehouse_grni_reval',
    sourceId: purchaseId,
  });
  return postInventoryMovement(db, {
    eventType: 'landed_cost',
    productId,
    warehouseId: warehouseId || null,
    qtyIn: 0,
    qtyOut: 0,
    unitCostRial: Math.abs(share),
    amountRial: share,
    sourceType: 'warehouse_grni_reval',
    sourceId: purchaseId,
    date,
    note: `تعدیل بهای GRNI → فاکتور خرید #${purchaseId}`,
    createdBy: userId,
    updateAvg: false,
    skipStock: true,
    valueOnly: true,
  });
}

/**
 * Create purchase invoice from one or more open warehouse GRNI docs.
 * stock_added=0 — no second qty receipt.
 */
function invoiceWarehouseGrni(db, body, user) {
  const docs = loadGrniDocsForInvoice(db, body.warehouse_doc_ids || body.doc_ids || (body.warehouse_doc_id ? [body.warehouse_doc_id] : []));
  const supplierId = parseInt(body.supplier_id, 10)
    || docs.map((d) => d.supplier_id).find(Boolean)
    || 0;
  if (!supplierId) throw httpErr(400, 'تأمین‌کننده الزامی است', 'E_WH_GRNI_SUPPLIER');
  const supplier = db.prepare('SELECT id,name FROM suppliers WHERE id=?').get(supplierId);
  if (!supplier) throw httpErr(400, 'تأمین‌کننده یافت نشد', 'E_WH_GRNI_SUPPLIER');

  // SOD: warehouse maker should not financialize own receipt (admin exempt)
  for (const d of docs) {
    assertMakerChecker(user, d.created_by);
  }

  const { rows, provisionalTotal, invoiceGoods } = buildInvoiceRows(docs, body.rows);
  const date = body.date || todayJalali();
  const warehouseId = docs[0].to_warehouse_id;
  const disc = Number(body.disc) || 0;
  const discAmt = Math.round(Number(body.disc_amt) || (invoiceGoods * disc / 100) || 0);
  const netBeforeVat = Math.max(0, invoiceGoods - discAmt);
  const vatExempt = body.vat_exempt ? 1 : 0;
  const vatRate = vatExempt ? 0 : (Number(body.vat_rate) || 10);
  const vatAmount = vatExempt ? 0 : Math.round(netBeforeVat * vatRate / 100);
  const finalAmt = netBeforeVat + vatAmount;
  const note = String(body.note || `فاکتور از رسید انبار GRNI: ${docs.map((d) => d.num).join('، ')}`);
  const costCenterId = body.cost_center_id ? parseInt(body.cost_center_id, 10) : null;

  const created = db.transaction(() => {
    const num = isDevice()
      ? ('موقت-' + Date.now().toString(36).toUpperCase())
      : allocateNumber(db, 'purchase', 'PO');
    const ins = db.prepare(`
      INSERT INTO purchase_invoices (
        user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,
        vat_amount,vat_rate,pay_type,stock_added,warehouse_id,vat_exempt,cost_center_id,
        warehouse_doc_id,goods_receipt_id,purchase_order_id
      ) VALUES (?,?,?,?,?,?,?,?,?, ?,?,?, 'credit',0,?,?, ?,?,NULL,NULL)
    `).run(
      user.id, supplierId, num, date, note,
      JSON.stringify(rows), invoiceGoods, disc, discAmt, finalAmt,
      vatAmount, vatRate, warehouseId, vatExempt, costCenterId,
      docs[0].id
    );
    const invId = ins.lastInsertRowid;
    assertJournalIdempotent(db, 'purchase', invId);

    const grni = acct(db, 'coa_grni');
    const ap = payableAcct(db, supplierId);
    const invAcct = inventoryAccountForWarehouse(db, warehouseId);
    const delta = netBeforeVat - provisionalTotal;
    const jeLines = [];
    // Clear provisional GRNI at receipt valuation
    if (provisionalTotal > 0) {
      jeLines.push({
        code: grni.code, name: grni.name,
        debit: rialToLedger(provisionalTotal), credit: 0,
        description: 'تسویه GRNI رسید انبار',
      });
    }
    if (delta > 0) {
      jeLines.push({
        code: invAcct.code, name: invAcct.name,
        debit: rialToLedger(delta), credit: 0,
        description: 'مابه‌التفاوت بهای فاکتور نسبت به رسید',
        cost_center_id: costCenterId,
      });
    } else if (delta < 0) {
      jeLines.push({
        code: invAcct.code, name: invAcct.name,
        debit: 0, credit: rialToLedger(-delta),
        description: 'مابه‌التفاوت بهای فاکتور نسبت به رسید',
        cost_center_id: costCenterId,
      });
    }
    if (vatAmount > 0) {
      const vatRec = acct(db, 'coa_vat_receivable');
      jeLines.push({
        code: vatRec.code, name: vatRec.name,
        debit: rialToLedger(vatAmount), credit: 0, description: 'VAT خرید',
      });
    }
    jeLines.push({
      code: ap.code, name: ap.name,
      debit: 0, credit: rialToLedger(finalAmt),
      description: `بدهی تأمین‌کننده ${supplier.name}`,
    });

    const jeId = postToLedger(db, {
      sourceType: 'purchase',
      sourceId: invId,
      date,
      description: `فاکتور خرید از رسید انبار GRNI ${docs.map((d) => d.num).join(',')}`,
      createdBy: user.id,
      costCenterId,
      lines: jeLines,
    });

    // Value-only reval per product (allocate delta by provisional share or equal qty)
    if (delta !== 0) {
      const baseSum = provisionalTotal > 0
        ? provisionalTotal
        : rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      let left = delta;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let part;
        if (i === rows.length - 1) {
          part = left;
        } else if (provisionalTotal > 0) {
          part = Math.round(delta * ((Number(r.provisional_rial) || 0) / baseSum));
        } else {
          part = Math.round(delta * ((Number(r.qty) || 0) / baseSum));
        }
        left -= part;
        applyValueVariance(db, {
          productId: r.product_id,
          warehouseId: r.warehouse_id || warehouseId,
          deltaRial: part,
          purchaseId: invId,
          date,
          userId: user.id,
        });
      }
      db.prepare(`
        UPDATE inventory_ledger SET je_id=?
        WHERE source_type='warehouse_grni_reval' AND source_id=?
      `).run(jeId, invId);
    }

    // Supplier books
    try {
      db.prepare(`
        INSERT INTO supplier_ledger (supplier_id,entry_type,ref_type,ref_id,debit,credit,date,note,created_by)
        VALUES (?,'purchase','purchase',?,0,?,?,?,?)
      `).run(supplierId, invId, finalAmt, date, note, user.id);
    } catch (_) {
      /* older schema */
    }

    for (const d of docs) {
      db.prepare('UPDATE warehouse_docs SET purchase_invoice_id=?, supplier_id=COALESCE(supplier_id,?) WHERE id=?')
        .run(invId, supplierId, d.id);
    }

    return db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(invId);
  })();

  audit(user.id, 'create', 'purchase', created.id, created.num);
  return created;
}

/**
 * On purchase void: unlink warehouse GRNI docs + reverse value-only revals.
 * Caller already reverses the purchase JE when stock_added=0.
 */
function unlinkWarehouseGrniOnPurchaseVoid(db, purchaseId, { userId = null, reason = '' } = {}) {
  const docs = db.prepare('SELECT id FROM warehouse_docs WHERE purchase_invoice_id=?').all(purchaseId);
  const leds = db.prepare(`
    SELECT id, product_id, warehouse_id, amount_rial FROM inventory_ledger
    WHERE source_type='warehouse_grni_reval' AND source_id=? AND COALESCE(status,'posted')='posted'
  `).all(purchaseId);
  for (const led of leds) {
    const share = Math.round(Number(led.amount_rial) || 0);
    if (share) {
      const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(led.product_id);
      if (prod) {
        const stock = Number(prod.stock) || 0;
        if (stock > 0) {
          const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
          const newAvg = Math.max(0, Math.round((stock * prevAvg - share) / stock));
          db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
            .run(newAvg, catalogCostFromAvgRial(newAvg), led.product_id);
        }
      }
      bumpOpenLayersValue(db, {
        productId: led.product_id,
        warehouseId: led.warehouse_id || null,
        amountRial: -share,
        sourceType: 'warehouse_grni_reval_void',
        sourceId: purchaseId,
      });
    }
    reverseInventoryMovement(db, led.id, {
      createdBy: userId,
      note: reason || `ابطال تعدیل بهای GRNI فاکتور #${purchaseId}`,
    });
  }
  db.prepare('UPDATE warehouse_docs SET purchase_invoice_id=NULL WHERE purchase_invoice_id=?').run(purchaseId);
  return { unlinked: docs.length, revals_reversed: leds.length };
}

function assertWarehouseDocNotBilled(db, docId) {
  const d = db.prepare('SELECT id,num,purchase_invoice_id FROM warehouse_docs WHERE id=?').get(docId);
  if (d && d.purchase_invoice_id) {
    throw httpErr(400, `رسید ${d.num || docId} به فاکتور خرید وصل است — ابتدا فاکتور را ابطال کنید`, 'E_WH_GRNI_LINKED');
  }
}

module.exports = {
  listOpenWarehouseGrni,
  invoiceWarehouseGrni,
  unlinkWarehouseGrniOnPurchaseVoid,
  assertWarehouseDocNotBilled,
  normalizeReceiptClass,
};
