/**
 * Warehouse remittance / receipt / transfer as first-class documents.
 * Lines remain warehouse_moves (stock effects); header is warehouse_docs.
 * Edit = full void (R13) + recreate. Pattern mirrors consignment_docs.
 */
const { audit, allocateNumber, isDevice } = require('../db');
const { todayJalali } = require('../jalali');
const {
  postInventoryMovement, warehouseQty, invErr,
  allowNegative, inventoryAccountForWarehouse,
} = require('./inventory/ledger');
const {
  postStockMovement, hasActiveMatrixVariants, variantWarehouseQty,
} = require('./inventory/movement');
const {
  adjustBatchQty, pickBatchesFefo, splitBatchForTransfer,
} = require('./inventory/batch-serial');
const { isPeriodicWarehouse } = require('./inventory/periodic-close');
const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { parseQty } = require('./round3');
const { voidOneMoveInTx } = require('./void-warehouse-move');
const { reverseJournalEntry } = require('./void-journal');

function parseVariantId(body) {
  if (!body || body.variant_id == null || body.variant_id === '') return null;
  const n = parseInt(body.variant_id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Issue/transfer pre-check failure with the exact structured shortage row (v525). */
function whShortage(db, product, row) {
  const e = Object.assign(new Error(`موجودی ${product.name} کافی نیست (موجود: ${row.available})`), { status: 400 });
  return require('./inventory/shortage-error').attach(e, db, [row]);
}

function availableForIssue(db, productId, warehouseId, variantId) {
  if (variantId) return variantWarehouseQty(db, variantId, warehouseId);
  return warehouseQty(db, productId, warehouseId);
}

function userMayWhNegative(db, user) {
  if (!user) return false;
  // admin always; others only through the dedicated `acc_warehouse_ops.negative` grant
  // (Phase 2 RBAC). Until a role/user holds that action this stays admin-only.
  if (user.role === 'admin') return true;
  try {
    const { hasPermission } = require('./rbac');
    if (typeof hasPermission === 'function'
      && hasPermission(db, user, 'acc_warehouse_ops', 'negative')) {
      return true;
    }
  } catch (_) { /* RBAC action may not exist yet */ }
  return false;
}

// ── Issue types (Phase 2, v575) ──────────────────────────────────────────────
// Every issue (حواله) must carry a type. The counterpart account comes from coa-map
// (`coa_issue_<type>` — settings override or the per-type default); there is NO generic default
// (the old blanket coa_inventory_loss is gone). Type ids == coa-map ISSUE_TYPE_COA_KEYS == UI.
// needs (same vocabulary as the UI): cc | cc_or_person | person | supplier
const ISSUE_TYPES = {
  internal_consume: { label: 'مصرف داخلی', needs: 'cc' },
  sample_gift: { label: 'نمونه/هدیه', needs: 'cc_or_person' },
  scrap: { label: 'ضایعات', needs: 'cc' },
  consignment: { label: 'امانی', needs: 'person' },
  return_to_supplier: { label: 'مرجوعی به تأمین‌کننده', needs: 'supplier' },
  other: { label: 'سایر', needs: 'cc_or_person' },
};

function issueErr(msg, code, status = 400) {
  return Object.assign(new Error(msg), { status, code });
}

function normalizeIssueType(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/** { code, name } counterpart account for an issue type (setting override → LEGACY key → default). */
function resolveIssueCounterpart(db, issueType) {
  const meta = ISSUE_TYPES[issueType];
  if (!meta) throw issueErr('نوع حواله نامعتبر است', 'E_ISSUE_TYPE_INVALID');
  const key = `coa_issue_${issueType}`;
  let configured = null;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    configured = row && String(row.value || '').trim();
  } catch (_) { configured = null; }
  if (configured) {
    const acc = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(configured);
    if (!acc) {
      throw issueErr(`حساب تنظیم‌شده برای «${meta.label}» (${configured}) در کدینگ وجود ندارد`, 'E_ISSUE_COA_INVALID');
    }
    return { code: acc.code, name: acc.name };
  }
  return require('./coa-map').issueCounterpartAccount(db, issueType);
}

/**
 * Validates issue_type + required cost-center / recipient for that type.
 * Returns { issueType, costCenterId, recipient, supplierId, label }.
 */
function resolveIssueContext(db, body) {
  const issueType = normalizeIssueType(body.issue_type);
  if (!issueType) {
    throw issueErr('نوع حواله الزامی است (مصرف داخلی / نمونه‌هدیه / ضایعات / امانی / مرجوعی به تأمین‌کننده / سایر)', 'E_ISSUE_TYPE_REQUIRED');
  }
  const meta = ISSUE_TYPES[issueType];
  if (!meta) throw issueErr('نوع حواله نامعتبر است', 'E_ISSUE_TYPE_INVALID');

  // "person" = any named recipient: free text, person_id, customer_id or recipient_id.
  const personId = parseInt(body.person_id || body.recipient_person_id, 10) > 0
    ? parseInt(body.person_id || body.recipient_person_id, 10) : null;
  const recipient = String(body.recipient || body.recipient_name || '').trim()
    || (personId ? `شخص #${personId}` : '')
    || (parseInt(body.recipient_id, 10) > 0 ? `#${parseInt(body.recipient_id, 10)}` : '')
    || (parseInt(body.customer_id, 10) > 0 ? `مشتری #${parseInt(body.customer_id, 10)}` : '');
  const supplierId = parseInt(body.supplier_id, 10) > 0 ? parseInt(body.supplier_id, 10) : null;
  let costCenterId = parseInt(body.cost_center_id, 10) || null;
  if (costCenterId) {
    const cc = db.prepare('SELECT id FROM cost_centers WHERE id=?').get(costCenterId);
    if (!cc) throw issueErr('مرکز هزینه انتخاب‌شده یافت نشد', 'E_COST_CENTER_NOT_FOUND');
  } else {
    costCenterId = null;
  }

  const need = meta.needs;
  const hasRecipient = !!recipient;
  let okReq = true;
  if (need === 'cc') okReq = !!costCenterId;
  else if (need === 'cc_or_person') okReq = !!costCenterId || hasRecipient;
  else if (need === 'person') okReq = hasRecipient;
  else if (need === 'supplier') okReq = !!supplierId;
  if (!okReq) {
    const what = need === 'cc' ? 'مرکز هزینه'
      : (need === 'cc_or_person' ? 'مرکز هزینه یا گیرنده'
        : (need === 'supplier' ? 'تأمین‌کننده' : 'گیرنده'));
    throw issueErr(`برای حوالهٔ «${meta.label}» ${what} الزامی است`, 'E_ISSUE_TARGET_REQUIRED');
  }
  if (supplierId) {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId);
    if (!sup) throw issueErr('تأمین‌کننده یافت نشد', 'E_SUPPLIER_NOT_FOUND', 404);
  }
  return {
    issueType, costCenterId, recipient, supplierId, personId, label: meta.label,
  };
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) { return false; }
}

/** Phase 2: block a second ACTIVE opening for the same (product, warehouse, variant) → 409. */
function assertNoActiveOpening(db, { productId, warehouseId, variantId }) {
  const vid = variantId || null;
  const dup = db.prepare(`
    SELECT m.id, d.num FROM warehouse_moves m
    JOIN warehouse_docs d ON d.id=m.doc_id
    WHERE m.type='receipt' AND d.receipt_class='opening'
      AND COALESCE(d.status,'posted')<>'reversed'
      AND COALESCE(m.status,'posted')<>'reversed'
      AND m.product_id=? AND m.to_warehouse_id=?
      AND COALESCE(m.variant_id,0)=COALESCE(?,0)
    LIMIT 1
  `).get(productId, warehouseId, vid);
  let ledgerDup = null;
  if (!dup) {
    // Legacy/backfilled opening ledger rows (never modified — only consulted).
    const hasVar = require('./inventory/ledger').ledgerHasVariantColumn(db);
    if (hasVar) {
      ledgerDup = db.prepare(`
        SELECT id FROM inventory_ledger
        WHERE event_type='opening' AND COALESCE(status,'posted')='posted'
          AND product_id=? AND warehouse_id=? AND COALESCE(variant_id,0)=COALESCE(?,0)
        LIMIT 1
      `).get(productId, warehouseId, vid);
    } else if (!vid) {
      ledgerDup = db.prepare(`
        SELECT id FROM inventory_ledger
        WHERE event_type='opening' AND COALESCE(status,'posted')='posted'
          AND product_id=? AND warehouse_id=?
        LIMIT 1
      `).get(productId, warehouseId);
    }
  }
  if (dup || ledgerDup) {
    const ref = dup ? `سند ${dup.num || dup.id}` : `ردیف کاردکس #${ledgerDup.id}`;
    throw Object.assign(new Error(
      `برای این کالا/انبار/واریانت قبلاً موجودی اول دوره ثبت شده است (${ref}) — ابتدا آن را ابطال کنید`
    ), {
      status: 409, code: 'E_OPENING_EXISTS', product_id: productId, warehouse_id: warehouseId, variant_id: vid,
    });
  }
}

function assertIssueQtyAllowed(db, user, {
  product, product_id, variantId, warehouseId, available, needed,
}) {
  if (available + 1e-9 >= needed) return;
  const whAllows = allowNegative(db, warehouseId, { context: 'warehouse' });
  const userAllows = userMayWhNegative(db, user);
  if (whAllows && userAllows) return;
  const e = Object.assign(
    new Error(`موجودی «${product.name}» کافی نیست و ثبت منفی مجاز نیست (موجود: ${available})`),
    { status: 400, code: 'NEGATIVE_NOT_ALLOWED' }
  );
  throw require('./inventory/shortage-error').attach(e, db, [{
    product_id, variant_id: variantId, warehouse_id: warehouseId, available, needed,
  }]);
}

function postWhVariantMovement(db, {
  productId, variantId, warehouseId, qtyDelta, docType, docId, docLine, userId, note, batchId,
}) {
  if (batchId) return null;
  const negOk = allowNegative(db, warehouseId, { context: 'warehouse' });
  if (hasActiveMatrixVariants(db, productId) && !variantId) {
    throw Object.assign(new Error('برای کالای ماتریسی انتخاب واریانت الزامی است'), {
      code: 'E_VARIANT_REQUIRED', status: 400,
    });
  }
  if (!variantId && !hasActiveMatrixVariants(db, productId)) {
    return postStockMovement(db, {
      productId, variantId: null, warehouseId, qtyDelta,
      docType, docId, docLine: docLine == null ? 0 : docLine, userId, note,
      allowNegative: negOk, applyHeaderStock: false, writeStockLog: false,
    });
  }
  return postStockMovement(db, {
    productId, variantId, warehouseId, qtyDelta,
    docType, docId, docLine: docLine == null ? 0 : docLine, userId, note,
    allowNegative: negOk, applyHeaderStock: false, writeStockLog: false,
  });
}

function assertWarehouseActive(db, warehouseId, label) {
  const wh = db.prepare('SELECT id, name, active FROM warehouses WHERE id=?').get(warehouseId);
  if (!wh) throw Object.assign(new Error(`${label || 'انبار'} یافت نشد`), { status: 404 });
  if (Number(wh.active) === 0) {
    throw Object.assign(new Error(`انبار «${wh.name}» غیرفعال است`), {
      status: 400, code: 'E_WH_INACTIVE',
    });
  }
  return wh;
}

function touchBatchQty(db, batchId, delta) {
  if (!batchId || !delta) return;
  adjustBatchQty(db, batchId, delta);
}

function ensureWarehouseDocSequence(db) {
  if (!db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get('warehouse_doc')) {
    db.prepare('INSERT INTO number_sequences (key,current_value) VALUES (?,0)').run('warehouse_doc');
  }
}

function typeLabelFa(type) {
  if (type === 'receipt') return 'رسید';
  if (type === 'issue') return 'حواله';
  if (type === 'transfer') return 'انتقال';
  return type || '';
}

function lineVariantId(db, moveId, preferredDocTypes) {
  try {
    for (const dt of preferredDocTypes) {
      const row = db.prepare(`
        SELECT variant_id FROM inventory_movements
        WHERE doc_type=? AND doc_id=? AND variant_id IS NOT NULL
        ORDER BY id ASC LIMIT 1
      `).get(dt, moveId);
      if (row && row.variant_id) return row.variant_id;
    }
  } catch (_) { /* optional */ }
  return null;
}

function listWarehouseDocs(db, { limit = 300, includeReversed = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000);
  const statusClause = includeReversed ? '' : "WHERE COALESCE(d.status,'posted')<>'reversed'";
  return db.prepare(`
    SELECT d.*,
      fw.name AS from_warehouse_name,
      tw.name AS to_warehouse_name,
      u.name AS recorder
    FROM warehouse_docs d
    LEFT JOIN warehouses fw ON fw.id=d.from_warehouse_id
    LEFT JOIN warehouses tw ON tw.id=d.to_warehouse_id
    LEFT JOIN users u ON u.id=d.created_by
    ${statusClause}
    ORDER BY d.date DESC, d.id DESC
    LIMIT ?
  `).all(lim);
}

function getWarehouseDoc(db, docId) {
  const id = parseInt(docId, 10);
  if (!id) return null;
  const doc = db.prepare(`
    SELECT d.*,
      fw.name AS from_warehouse_name,
      tw.name AS to_warehouse_name,
      u.name AS recorder
    FROM warehouse_docs d
    LEFT JOIN warehouses fw ON fw.id=d.from_warehouse_id
    LEFT JOIN warehouses tw ON tw.id=d.to_warehouse_id
    LEFT JOIN users u ON u.id=d.created_by
    WHERE d.id=?
  `).get(id);
  if (!doc) return null;

  const lines = db.prepare(`
    SELECT m.*,
      p.name AS product_name, p.code AS product_code, p.unit AS product_unit,
      fw.name AS from_warehouse_name, tw.name AS to_warehouse_name
    FROM warehouse_moves m
    LEFT JOIN products p ON p.id=m.product_id
    LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id
    LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id
    WHERE m.doc_id=?
    ORDER BY COALESCE(m.line_no, m.id) ASC
  `).all(id);

  const enriched = lines.map((m) => {
    let variantId = m.variant_id || null;
    if (!variantId) {
      const preferred = m.type === 'receipt' ? ['wh_receipt']
        : m.type === 'issue' ? ['wh_issue']
          : ['wh_transfer_out', 'wh_transfer_in'];
      variantId = lineVariantId(db, m.id, preferred);
    }
    let color_name = '';
    let size_name = '';
    let variant_sku = '';
    if (variantId) {
      try {
        const pv = db.prepare(`
          SELECT pv.sku, c.name AS color_name, s.name AS size_name
          FROM product_variants pv
          LEFT JOIN product_colors c ON c.id=pv.color_id
          LEFT JOIN product_sizes s ON s.id=pv.size_id
          WHERE pv.id=?
        `).get(variantId);
        if (pv) {
          color_name = pv.color_name || '';
          size_name = pv.size_name || '';
          variant_sku = pv.sku || '';
        }
      } catch (_) { /* optional tables */ }
    }
    return {
      ...m,
      variant_id: variantId,
      color_name,
      size_name,
      variant_sku,
      product_label: [m.product_name, [color_name, size_name].filter(Boolean).join(' / ')].filter(Boolean).join(' — '),
    };
  });

  return { ...doc, lines: enriched };
}

/**
 * Create multi-line warehouse document inside caller's transaction or own TX.
 * opts.outerTx: if true, do not wrap (caller already in transaction).
 */
function createWarehouseDocInTx(db, body, user, opts = {}) {
  const type = body.type;
  if (!['receipt', 'issue', 'transfer'].includes(type)) {
    const err = new Error('نوع سند نامعتبر است');
    err.status = 400;
    throw err;
  }
  // Phase 2: issue type is mandatory; it selects the counterpart COA (no generic default).
  const issueCtx = type === 'issue' ? resolveIssueContext(db, body) : null;
  const issueCounterpart = issueCtx ? resolveIssueCounterpart(db, issueCtx.issueType) : null;
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) {
    const err = new Error('حداقل یک ردیف کالا لازم است');
    err.status = 400;
    throw err;
  }
  if (lines.length > 500) {
    const err = new Error('حداکثر ۵۰۰ ردیف در یک سند انبار مجاز است');
    err.status = 400;
    throw err;
  }

  ensureWarehouseDocSequence(db);
  const date = body.date || todayJalali();
  const note = body.note || '';
  const fromWh = type === 'transfer'
    ? parseInt(body.from_warehouse_id, 10)
    : (type === 'issue' ? parseInt(body.warehouse_id || body.from_warehouse_id, 10) : null);
  const toWh = type === 'transfer'
    ? parseInt(body.to_warehouse_id, 10)
    : (type === 'receipt' ? parseInt(body.warehouse_id || body.to_warehouse_id, 10) : null);

  if (type === 'receipt' && !toWh) throw Object.assign(new Error('انبار مقصد الزامی است'), { status: 400 });
  if (type === 'issue' && !fromWh) throw Object.assign(new Error('انبار مبدأ الزامی است'), { status: 400 });
  if (type === 'transfer') {
    if (!fromWh || !toWh) throw Object.assign(new Error('انبار مبدأ و مقصد الزامی است'), { status: 400 });
    if (fromWh === toWh) throw Object.assign(new Error('انبار مبدأ و مقصد نمی‌تواند یکسان باشد'), { status: 400 });
  }
  if (fromWh) assertWarehouseActive(db, fromWh, 'انبار مبدأ');
  if (toWh) assertWarehouseActive(db, toWh, 'انبار مقصد');
  // v578 Phase 5: a warehouse with an open stocktaking (draft/completed) is frozen against its kardex
  // snapshot — lock (409 E_STOCKTAKE_LOCKED) or warn per setting `stocktake_move_lock`.
  const stkGuard = require('./inventory/cycle-count').assertWarehouseNotCounting(
    db, [fromWh, toWh], { label: `ثبت ${typeLabelFa(type)} انبار` },
  );

  const num = isDevice()
    ? ('موقت-WH-' + Date.now().toString(36).toUpperCase())
    : allocateNumber(db, 'warehouse_doc', 'WH');

  let receiptClass = 'adjustment';
  let supplierId = null;
  if (type === 'receipt') {
    const rawClass = String(body.receipt_class || body.counterpart || '').toLowerCase().trim();
    // Only explicit receipt_class/opening flag — never infer from free-text note.
    const isOpening = !!(body.opening || rawClass === 'opening');
    const isGrni = !isOpening && (rawClass === 'grni' || rawClass === 'supplier'
      || rawClass === 'supplier_receipt');
    receiptClass = isOpening ? 'opening' : (isGrni ? 'grni' : 'adjustment');
    const sid = parseInt(body.supplier_id, 10);
    if (sid) supplierId = sid;
  }

  const docIns = db.prepare(`
    INSERT INTO warehouse_docs (
      num, type, from_warehouse_id, to_warehouse_id, date, note, status,
      line_count, qty_total, amount_rial_total, created_by, replaces_doc_id,
      receipt_class, supplier_id
    ) VALUES (?,?,?,?,?,?,'posted',0,0,0,?,?,?,?)
  `).run(
    num, type,
    type === 'receipt' ? null : fromWh,
    type === 'issue' ? null : toWh,
    date, note, user.id,
    opts.replacesDocId || body.replaces_doc_id || null,
    type === 'receipt' ? receiptClass : null,
    supplierId
  );
  const docId = docIns.lastInsertRowid;
  if (issueCtx) {
    // Additive columns (parallel schema agent) — persist only what exists.
    const sets = [];
    const vals = [];
    for (const [col, v] of [
      ['issue_type', issueCtx.issueType],
      ['cost_center_id', issueCtx.costCenterId],
      ['recipient', issueCtx.recipient || null],
      ['person_id', issueCtx.personId],
      ['supplier_id', issueCtx.supplierId],
    ]) {
      if (tableHasColumn(db, 'warehouse_docs', col)) { sets.push(`${col}=?`); vals.push(v); }
    }
    if (sets.length) db.prepare(`UPDATE warehouse_docs SET ${sets.join(', ')} WHERE id=?`).run(...vals, docId);
  }
  const ids = [];
  let totalAmountRial = 0;
  let qtyTotal = 0;
  let lineIdx = 0;
  // v525 closed inventory month: every parked rate difference of this document → ONE approval doc.
  const VAP = require('./inventory/value-approval');
  const valueClosed = require('./inventory/period-lock').isValueLocked(db, date);
  const valueGroup = {
    sourceType: 'warehouse_doc',
    sourceId: docId,
    label: `سند انبار ${num} — مابه‌التفاوت نرخ با میانگین استخر (قفل دوره)`,
  };

  for (const line of lines) {
    const product_id = parseInt(line.product_id, 10);
    const qty = parseQty(line.qty);
    const variantId = parseVariantId(line);
    const batchId = line.batch_id ? parseInt(line.batch_id, 10) : null;
    if (!product_id || !qty || qty <= 0) throw invErr('E_INV_QTY', 400);
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) throw invErr('E_PRODUCT_NOT_FOUND', 404);
    if (hasActiveMatrixVariants(db, product_id) && !variantId && !batchId) {
      throw Object.assign(new Error('برای کالای ماتریسی انتخاب واریانت الزامی است'), {
        code: 'E_VARIANT_REQUIRED', status: 400,
      });
    }
    const lineNo = lineIdx + 1;
    qtyTotal += qty;

    if (type === 'receipt') {
      const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(toWh);
      if (!warehouse) throw Object.assign(new Error('انبار یافت نشد'), { status: 404 });
      if (receiptClass === 'opening') {
        assertNoActiveOpening(db, { productId: product_id, warehouseId: toWh, variantId });
      }
      const explicitUnitCost = Math.round(Number(line.unit_cost_rial) || (
        Number(line.amount_rial) > 0 ? Number(line.amount_rial) / qty : 0
      ));
      const led = VAP.withSourceGroup(valueGroup, () => postInventoryMovement(db, {
        eventType: 'receipt', productId: product_id, warehouseId: toWh, qty,
        unitCostRial: explicitUnitCost > 0 ? explicitUnitCost : Math.round(Number(product.average_cost_rial) || 0),
        batchId: batchId || null, variantId,
        sourceType: 'warehouse_move', date,
        note: `رسید انبار (${warehouse.name})${note ? ' - ' + note : ''}`,
        createdBy: user.id,
      }));
      const r = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status,doc_id,line_no,variant_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?)
      `).run('receipt', product_id, toWh, qty, date, note, user.id,
        led.id, led.unit_cost_rial, led.amount_rial, batchId || null, docId, lineNo, variantId);
      // source_id = move id (stable join for kardex); aggregation uses wm.doc_id → WH-####.
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(r.lastInsertRowid, led.id);
      ids.push(r.lastInsertRowid);
      postWhVariantMovement(db, {
        productId: product_id, variantId, warehouseId: toWh, qtyDelta: qty,
        docType: 'wh_receipt', docId: r.lastInsertRowid, docLine: lineIdx, userId: user.id,
        note: `رسید انبار (${warehouse.name})`, batchId,
      });
      touchBatchQty(db, batchId, qty);
      totalAmountRial += Math.round(Number(led.amount_rial) || 0);
    } else if (type === 'issue') {
      const available = availableForIssue(db, product_id, fromWh, variantId);
      assertIssueQtyAllowed(db, user, {
        product, product_id, variantId, warehouseId: fromWh, available, needed: qty,
      });
      // Auto FEFO: if no batch chosen but one generic lot covers the qty, use earliest expiry.
      let issueBatchId = batchId;
      if (!issueBatchId && !variantId) {
        try {
          const { picks, shortfall } = pickBatchesFefo(db, product_id, fromWh, qty);
          if (!shortfall && picks && picks.length === 1) {
            issueBatchId = picks[0].batch_id;
          }
        } catch (_) { /* FEFO optional */ }
      }
      const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(fromWh);
      const led = postInventoryMovement(db, {
        eventType: 'issue', productId: product_id, warehouseId: fromWh, qty: -qty,
        batchId: issueBatchId || null, variantId,
        sourceType: 'warehouse_move', date,
        note: `حواله انبار (${warehouse?.name || fromWh})${note ? ' - ' + note : ''}`,
        createdBy: user.id,
      });
      const r = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,from_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status,doc_id,line_no,variant_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?)
      `).run('issue', product_id, fromWh, qty, date, note, user.id,
        led.id, led.unit_cost_rial, led.amount_rial, issueBatchId || null, docId, lineNo, variantId);
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(r.lastInsertRowid, led.id);
      ids.push(r.lastInsertRowid);
      postWhVariantMovement(db, {
        productId: product_id, variantId, warehouseId: fromWh, qtyDelta: -qty,
        docType: 'wh_issue', docId: r.lastInsertRowid, docLine: lineIdx, userId: user.id,
        note: `حواله انبار (${warehouse?.name || fromWh})`, batchId: issueBatchId,
      });
      touchBatchQty(db, issueBatchId, -qty);
      totalAmountRial += Math.round(Number(led.amount_rial) || 0);
    } else {
      const available = availableForIssue(db, product_id, fromWh, variantId);
      assertIssueQtyAllowed(db, user, {
        product, product_id, variantId, warehouseId: fromWh, available, needed: qty,
      });
      const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(toWh);
      const fromWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(fromWh);
      const unit = Math.round(Number(product.average_cost_rial) || 0);
      const ledOut = postInventoryMovement(db, {
        eventType: 'transfer_out', productId: product_id, warehouseId: fromWh, qty: -qty,
        unitCostRial: unit, sourceType: 'warehouse_transfer', date, variantId,
        batchId: batchId || null,
        note: `خروج انتقال به ${toWarehouse?.name}`, createdBy: user.id, updateAvg: false,
      });
      // Phase 2: inbound value === outbound value, taken from the SAME out ledger row
      // (Σamount(out) = Σamount(in) per transfer doc). The unit is the out row's effective unit.
      // Only exception: closed value month + different destination pool (v525) — there the
      // destination enters at its pool rate and the difference is parked for approval.
      const outAmount = Math.round(Number(ledOut.amount_rial) || 0);
      let inAmount = outAmount;
      let inUnit = Math.round(Number(ledOut.unit_cost_rial) || 0) || unit;
      let transferPark = 0;
      if (valueClosed && VAP.poolKeyOf(db, product_id, fromWh) !== VAP.poolKeyOf(db, product_id, toWh)) {
        const destUnit = VAP.closedInboundPoolUnit(db, product_id, toWh);
        if (destUnit != null && Math.round(destUnit * qty) !== inAmount) {
          transferPark = inAmount - Math.round(destUnit * qty);
          inAmount = Math.round(destUnit * qty);
          inUnit = destUnit;
        }
      }
      // Partial lot transfer → split the lot (new row for the destination); whole lot → move row.
      let destBatchId = null;
      if (batchId) {
        const sp = splitBatchForTransfer(db, {
          batchId, productId: product_id, qty, fromWarehouseId: fromWh,
          toWarehouseId: toWh, createdBy: user.id,
        });
        destBatchId = sp.destBatchId;
      }
      const ledIn = postInventoryMovement(db, {
        eventType: 'transfer_in', productId: product_id, warehouseId: toWh, qty,
        unitCostRial: inUnit, amountRial: inAmount, sourceType: 'warehouse_transfer', date,
        variantId, batchId: destBatchId || null,
        note: `ورود انتقال از ${fromWarehouse?.name}`, createdBy: user.id, updateAvg: false,
      });
      if (transferPark) {
        VAP.withSourceGroup(valueGroup, () => VAP.parkReceiptDifference(db, {
          sourceType: 'warehouse_transfer', sourceId: null, ledgerId: ledIn.id,
          productId: product_id, warehouseId: toWh, qtyIn: qty, diffRial: transferPark, date,
          createdBy: user.id, note: 'انتقال با تاریخ ماه قفل‌شده — مابه‌التفاوت نرخ مبدأ با میانگین مقصد',
        }));
      }
      const r = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status,doc_id,line_no,variant_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?)
      `).run('transfer', product_id, fromWh, toWh, qty, date, note, user.id,
        ledOut.id, inUnit, ledOut.amount_rial, batchId || null, docId, lineNo, variantId);
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id IN (?,?)').run(r.lastInsertRowid, ledOut.id, ledIn.id);
      ids.push(r.lastInsertRowid);
      postWhVariantMovement(db, {
        productId: product_id, variantId, warehouseId: fromWh, qtyDelta: -qty,
        docType: 'wh_transfer_out', docId: r.lastInsertRowid, docLine: lineIdx, userId: user.id,
        note: `خروج انتقال به ${toWarehouse?.name}`,
      });
      postWhVariantMovement(db, {
        productId: product_id, variantId, warehouseId: toWh, qtyDelta: qty,
        docType: 'wh_transfer_in', docId: r.lastInsertRowid, docLine: lineIdx, userId: user.id,
        note: `ورود انتقال از ${fromWarehouse?.name}`,
      });
      totalAmountRial += outAmount;
    }
    lineIdx += 1;
  }

  let jeId = null;
  const amountToman = totalAmountRial / 10;
  const whCc = (warehouseId) => {
    const id = parseInt(warehouseId, 10);
    if (!id) return null;
    return db.prepare('SELECT cost_center_id FROM warehouses WHERE id=?').get(id)?.cost_center_id || null;
  };
  if (type === 'transfer' && totalAmountRial > 0) {
    // Reclass only when warehouse types map to different inventory COA (no P&L).
    const fromAcct = inventoryAccountForWarehouse(db, fromWh);
    const toAcct = inventoryAccountForWarehouse(db, toWh);
    if (fromAcct.code !== toAcct.code) {
      jeId = postToLedger(db, {
        sourceType: 'warehouse_transfer_batch',
        sourceId: ids[0],
        date,
        description: `انتقال انبار ${num} (${ids.length} ردیف)`,
        createdBy: user.id,
        voucherType: 'auto',
        lines: [
          { code: toAcct.code, name: toAcct.name, debit: amountToman, credit: 0, cost_center_id: whCc(toWh) },
          { code: fromAcct.code, name: fromAcct.name, debit: 0, credit: amountToman, cost_center_id: whCc(fromWh) },
        ],
      });
    }
  } else if (type !== 'transfer' && totalAmountRial > 0) {
    // Periodic warehouses: qty moves only; valuation JE is period-close (IAS 2 periodic).
    const valuationWh = type === 'receipt' ? toWh : fromWh;
    if (!isPeriodicWarehouse(db, valuationWh)) {
      const inventory = inventoryAccountForWarehouse(db, valuationWh);
      const receiptClass = String(body.receipt_class || body.counterpart || '').toLowerCase().trim();
      const isOpening = !!(body.opening || receiptClass === 'opening');
      const isGrni = !isOpening && (receiptClass === 'grni' || receiptClass === 'supplier'
        || receiptClass === 'supplier_receipt');
      // Purchase with invoice must use /purchases or /procurement GR — not this path with 9999.
      // Classes: opening→3102 | grni→2112 | adjustment (default)→9999 for ops/count fixes.
      // Receipt: class-driven. Issue: per issue_type (coa_issue_<type>) — never a blanket loss account.
      let counterpart;
      if (type === 'receipt') {
        counterpart = acct(db, isOpening ? 'coa_opening_balance' : (isGrni ? 'coa_grni' : 'coa_adjustment'));
      } else {
        counterpart = issueCounterpart;
      }
      const lineCc = whCc(valuationWh);
      // Issue: the counterpart (expense / consignment / …) is charged to the chosen cost center.
      const counterpartCc = (type === 'issue' && issueCtx && issueCtx.costCenterId) || lineCc;
      // return_to_supplier debits the payable control → tag the supplier's tafsili when known.
      let counterpartDetailId = null;
      if (type === 'issue' && issueCtx && issueCtx.supplierId) {
        try {
          const s = db.prepare('SELECT party_id FROM suppliers WHERE id=?').get(issueCtx.supplierId);
          const p = s && s.party_id ? db.prepare('SELECT detail_account_id FROM parties WHERE id=?').get(s.party_id) : null;
          counterpartDetailId = (p && p.detail_account_id) || null;
        } catch (_) { counterpartDetailId = null; }
      }
      const receiptJeType = isOpening ? 'opening_inventory'
        : (isGrni ? 'warehouse_receipt_grni' : `warehouse_${type}_batch`);
      jeId = postToLedger(db, {
        sourceType: type === 'receipt' ? receiptJeType : `warehouse_${type}_batch`,
        sourceId: ids[0],
        date,
        description: type === 'receipt' && isOpening
          ? `موجودی اول دوره — رسید انبار (${ids.length} ردیف)`
          : (type === 'receipt' && isGrni
            ? `رسید تأمین‌کننده (GRNI) — انبار ${num} (${ids.length} ردیف)`
            : (type === 'issue' && issueCtx
              ? `حواله ${issueCtx.label} انبار ${num} (${ids.length} ردیف)${issueCtx.recipient ? ' — گیرنده: ' + issueCtx.recipient : ''}`
              : `${typeLabelFa(type)} انبار ${num} (${ids.length} ردیف)`)),
        createdBy: user.id,
        voucherType: isOpening && type === 'receipt' ? 'opening' : 'auto',
        srcSystem: body.from_excel || body.src_system === 'excel' ? 'excel' : null,
        costCenterId: lineCc,
        lines: type === 'receipt'
          ? [
            { code: inventory.code, name: inventory.name, debit: amountToman, credit: 0, cost_center_id: lineCc },
            { code: counterpart.code, name: counterpart.name, debit: 0, credit: amountToman, cost_center_id: lineCc },
          ]
          : [
            { code: counterpart.code, name: counterpart.name, debit: amountToman, credit: 0, cost_center_id: counterpartCc, detail_account_id: counterpartDetailId },
            { code: inventory.code, name: inventory.name, debit: 0, credit: amountToman, cost_center_id: lineCc },
          ],
      });
    }
  }
  if (jeId && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE warehouse_moves SET je_id=? WHERE id IN (${placeholders})`).run(jeId, ...ids);
  }

  db.prepare(`
    UPDATE warehouse_docs
    SET line_count=?, qty_total=?, amount_rial_total=?, je_id=?
    WHERE id=?
  `).run(ids.length, qtyTotal, totalAmountRial, jeId, docId);

  audit(user.id, 'create', 'warehouse_doc', docId,
    `${typeLabelFa(type)} انبار ${num}: ${ids.length} ردیف / ${qtyTotal} عدد`);

  // v574 فاز ۱: اگر لایه‌های کالا×انبار لمس‌شده اختلاف دارند فقط هشدار audit — بدون هیچ اصلاح (heal).
  try {
    const pairs = [];
    for (const line of lines) {
      const pid = parseInt(line.product_id, 10);
      if (!pid) continue;
      if (fromWh) pairs.push({ product_id: pid, warehouse_id: fromWh });
      if (toWh) pairs.push({ product_id: pid, warehouse_id: toWh });
    }
    if (pairs.length) {
      const drift = require('./inventory/layer-reconcile').detectPairDrift(db, pairs);
      if (drift.drift) {
        audit(user.id, 'warning', 'inventory_layer_drift', docId,
          `اختلاف لایه‌های موجودی پس از ${typeLabelFa(type)} انبار ${num} (فقط هشدار، بدون اصلاح): ${drift.summary}`.slice(0, 900));
      }
    }
  } catch (_) { /* هشدار drift هرگز نباید سند انبار را خراب کند */ }

  return {
    ok: true,
    id: docId,
    doc_id: docId,
    num,
    ids,
    move_ids: ids,
    count: ids.length,
    je_id: jeId,
    type,
    issue_type: issueCtx ? issueCtx.issueType : null,
    ...(stkGuard.warned ? {
      stocktake_warning: true,
      stocktake_sessions: stkGuard.sessions.map((s) => s.id),
      warning: `انبار در حال انبارگردانی است (${stkGuard.sessions.map((s) => '#' + s.id).join('، ')}) — مغایرت با snapshot شمارش ممکن است`,
    } : {}),
  };
}

function createWarehouseDoc(db, body, user, opts = {}) {
  // Receiving one matrix SKU must not retire sibling zero-stock colors (Phase 0 picker).
  const run = () => {
    const { holdColorRetire, releaseColorRetire } = require('./product-variants/service');
    holdColorRetire(db);
    try {
      return createWarehouseDocInTx(db, body, user, opts);
    } finally {
      releaseColorRetire(db);
    }
  };
  if (opts.outerTx) return run();
  return db.transaction(run)();
}

function voidWarehouseDocInTx(db, docId, user, { reason } = {}) {
  const doc = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(docId);
  if (!doc) {
    const err = new Error('سند انبار یافت نشد');
    err.status = 404;
    throw err;
  }
  if (doc.status === 'reversed') {
    const err = new Error('این سند قبلاً ابطال شده است');
    err.status = 400;
    throw err;
  }
  if (doc.purchase_invoice_id) {
    const err = new Error(`رسید ${doc.num || docId} به فاکتور خرید وصل است — ابتدا فاکتور را ابطال کنید`);
    err.status = 400;
    err.code = 'E_WH_GRNI_LINKED';
    throw err;
  }
  const moves = db.prepare(`
    SELECT * FROM warehouse_moves
    WHERE doc_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id ASC
  `).all(docId);

  for (const m of moves) {
    voidOneMoveInTx(db, m, user.id);
  }
  require('./inventory/value-approval').cancelForSource(db, 'warehouse_doc', Number(docId), user,
    reason || `ابطال سند انبار ${doc.num || ('#' + docId)}`);

  const jeId = doc.je_id || (moves.find((m) => m.je_id) || {}).je_id;
  if (jeId) {
    reverseJournalEntry(db, jeId, {
      userId: user.id,
      reason: reason || `ابطال سند انبار ${doc.num || ('#' + docId)}`,
      sourceType: 'warehouse_doc_reversal',
    });
  }

  db.prepare(`
    UPDATE warehouse_docs
    SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(user.id, docId);

  audit(user.id, 'reverse', 'warehouse_doc', docId,
    reason || `ابطال سند انبار ${doc.num || ('#' + docId)} (${moves.length} ردیف)`);

  return { ok: true, doc_id: docId, num: doc.num, voidedIds: moves.map((m) => m.id), count: moves.length };
}

function voidWarehouseDoc(db, docId, user, opts = {}) {
  return db.transaction(() => voidWarehouseDocInTx(db, docId, user, opts))();
}

function reviseWarehouseDoc(db, docId, body, user) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM warehouse_docs WHERE id=?').get(docId);
    if (!old) {
      const err = new Error('سند انبار یافت نشد');
      err.status = 404;
      throw err;
    }
    if (old.status === 'reversed') {
      const err = new Error('سند ابطال‌شده قابل ویرایش نیست');
      err.status = 400;
      throw err;
    }
    voidWarehouseDocInTx(db, docId, user, {
      reason: `ویرایش سند انبار ${old.num || ('#' + docId)} — ابطال و صدور مجدد`,
    });
    const created = createWarehouseDocInTx(db, {
      ...body,
      // keep the original issue type / targets when the editor does not resend them
      issue_type: body.issue_type || old.issue_type || undefined,
      cost_center_id: body.cost_center_id || old.cost_center_id || undefined,
      recipient: body.recipient || old.recipient || undefined,
      person_id: body.person_id || old.person_id || undefined,
      supplier_id: body.supplier_id || (old.type === 'issue' ? old.supplier_id : undefined) || undefined,
      type: body.type || old.type,
      replaces_doc_id: docId,
    }, user, { replacesDocId: docId });
    db.prepare('UPDATE warehouse_docs SET replaced_by_doc_id=? WHERE id=?').run(created.id, docId);
    return { ...created, replaced_doc_id: docId, replaced_num: old.num };
  })();
}

/**
 * One-shot: attach legacy flat warehouse_moves to warehouse_docs.
 * Groups: shared je_id → one doc; else same (type,from,to,date,created_by,note,created_at) → one doc;
 * remaining singles → one doc each. No stock mutation.
 */
function backfillWarehouseDocs(db) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='warehouse_docs_backfill_v1'").get();
  if (flag && flag.value === '1') return { skipped: true };

  ensureWarehouseDocSequence(db);
  let docsCreated = 0;
  let movesLinked = 0;

  db.transaction(() => {
    const orphan = db.prepare(`
      SELECT * FROM warehouse_moves WHERE doc_id IS NULL ORDER BY id ASC
    `).all();
    if (!orphan.length) {
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('warehouse_docs_backfill_v1','1')").run();
      return;
    }

    const assigned = new Set();

    function makeDoc(group) {
      if (!group.length) return;
      const first = group[0];
      const allReversed = group.every((m) => m.status === 'reversed');
      const anyPosted = group.some((m) => m.status !== 'reversed');
      const status = anyPosted ? 'posted' : (allReversed ? 'reversed' : 'posted');
      const qtyTotal = group.reduce((s, m) => s + (Number(m.qty) || 0), 0);
      const amountTotal = group.reduce((s, m) => s + (Number(m.amount_rial) || 0), 0);
      const jeId = group.map((m) => m.je_id).find(Boolean) || null;
      const fromId = first.type === 'receipt' ? null : first.from_warehouse_id;
      const toId = first.type === 'issue' ? null : first.to_warehouse_id;
      const num = allocateNumber(db, 'warehouse_doc', 'WH');
      const ins = db.prepare(`
        INSERT INTO warehouse_docs (
          num, type, from_warehouse_id, to_warehouse_id, date, note, status,
          je_id, line_count, qty_total, amount_rial_total, created_by, created_at,
          reversed_at, reversed_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        num, first.type, fromId, toId, first.date || '', first.note || '', status,
        jeId, group.length, qtyTotal, amountTotal, first.created_by, first.created_at || null,
        status === 'reversed' ? (first.reversed_at || null) : null,
        status === 'reversed' ? (first.reversed_by || null) : null
      );
      const docId = ins.lastInsertRowid;
      docsCreated += 1;
      let lineNo = 1;
      for (const m of group) {
        db.prepare('UPDATE warehouse_moves SET doc_id=?, line_no=? WHERE id=?').run(docId, lineNo, m.id);
        assigned.add(m.id);
        movesLinked += 1;
        lineNo += 1;
      }
    }

    // 1) Group by je_id
    const byJe = new Map();
    for (const m of orphan) {
      if (!m.je_id || assigned.has(m.id)) continue;
      const key = String(m.je_id);
      if (!byJe.has(key)) byJe.set(key, []);
      byJe.get(key).push(m);
    }
    for (const group of byJe.values()) makeDoc(group);

    // 2) Heuristic batch: same type/warehouses/date/user/note/created_at
    const remain = orphan.filter((m) => !assigned.has(m.id));
    const byCluster = new Map();
    for (const m of remain) {
      const key = [
        m.type,
        m.from_warehouse_id || '',
        m.to_warehouse_id || '',
        m.date || '',
        m.created_by || '',
        m.note || '',
        m.created_at || '',
      ].join('|');
      if (!byCluster.has(key)) byCluster.set(key, []);
      byCluster.get(key).push(m);
    }
    for (const group of byCluster.values()) {
      if (group.length > 1) makeDoc(group);
    }

    // 3) Singles
    for (const m of orphan) {
      if (assigned.has(m.id)) continue;
      makeDoc([m]);
    }

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('warehouse_docs_backfill_v1','1')").run();
  })();

  return { skipped: false, docsCreated, movesLinked };
}

module.exports = {
  listWarehouseDocs,
  getWarehouseDoc,
  createWarehouseDoc,
  createWarehouseDocInTx,
  voidWarehouseDoc,
  voidWarehouseDocInTx,
  reviseWarehouseDoc,
  backfillWarehouseDocs,
  postWhVariantMovement,
  parseVariantId,
  availableForIssue,
  ISSUE_TYPES,
  resolveIssueCounterpart,
  userMayWhNegative,
  ensureWarehouseDocSequence,
};
