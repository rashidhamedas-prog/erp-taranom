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
const { adjustBatchQty, pickBatchesFefo } = require('./inventory/batch-serial');
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

function availableForIssue(db, productId, warehouseId, variantId) {
  if (variantId) return variantWarehouseQty(db, variantId, warehouseId);
  return warehouseQty(db, productId, warehouseId);
}

function postWhVariantMovement(db, {
  productId, variantId, warehouseId, qtyDelta, docType, docId, docLine, userId, note, batchId,
}) {
  if (batchId) return null;
  const negOk = allowNegative(db, warehouseId);
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
    ORDER BY d.created_at DESC, d.id DESC
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

  const num = isDevice()
    ? ('موقت-WH-' + Date.now().toString(36).toUpperCase())
    : allocateNumber(db, 'warehouse_doc', 'WH');

  const docIns = db.prepare(`
    INSERT INTO warehouse_docs (
      num, type, from_warehouse_id, to_warehouse_id, date, note, status,
      line_count, qty_total, amount_rial_total, created_by, replaces_doc_id
    ) VALUES (?,?,?,?,?,?,'posted',0,0,0,?,?)
  `).run(
    num, type,
    type === 'receipt' ? null : fromWh,
    type === 'issue' ? null : toWh,
    date, note, user.id,
    opts.replacesDocId || body.replaces_doc_id || null
  );
  const docId = docIns.lastInsertRowid;
  const ids = [];
  let totalAmountRial = 0;
  let qtyTotal = 0;
  let lineIdx = 0;

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
      const explicitUnitCost = Math.round(Number(line.unit_cost_rial) || (
        Number(line.amount_rial) > 0 ? Number(line.amount_rial) / qty : 0
      ));
      const led = postInventoryMovement(db, {
        eventType: 'receipt', productId: product_id, warehouseId: toWh, qty,
        unitCostRial: explicitUnitCost > 0 ? explicitUnitCost : Math.round(Number(product.average_cost_rial) || 0),
        batchId: batchId || null,
        sourceType: 'warehouse_move', date,
        note: `رسید انبار (${warehouse.name})${note ? ' - ' + note : ''}`,
        createdBy: user.id,
      });
      const r = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status,doc_id,line_no,variant_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?)
      `).run('receipt', product_id, toWh, qty, date, note, user.id,
        led.id, led.unit_cost_rial, led.amount_rial, batchId || null, docId, lineNo, variantId);
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
      if (available < qty && !allowNegative(db, fromWh)) {
        throw Object.assign(new Error(`موجودی ${product.name} کافی نیست (موجود: ${available})`), { status: 400 });
      }
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
        batchId: issueBatchId || null,
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
      if (available < qty && !allowNegative(db, fromWh)) {
        throw Object.assign(new Error(`موجودی ${product.name} کافی نیست (موجود: ${available})`), { status: 400 });
      }
      const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(toWh);
      const fromWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(fromWh);
      const unit = Math.round(Number(product.average_cost_rial) || 0);
      const ledOut = postInventoryMovement(db, {
        eventType: 'transfer_out', productId: product_id, warehouseId: fromWh, qty: -qty,
        unitCostRial: unit, sourceType: 'warehouse_transfer', date,
        note: `خروج انتقال به ${toWarehouse?.name}`, createdBy: user.id, updateAvg: false,
      });
      const ledIn = postInventoryMovement(db, {
        eventType: 'transfer_in', productId: product_id, warehouseId: toWh, qty,
        unitCostRial: unit, amountRial: ledOut.amount_rial, sourceType: 'warehouse_transfer', date,
        note: `ورود انتقال از ${fromWarehouse?.name}`, createdBy: user.id, updateAvg: false,
      });
      const r = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status,doc_id,line_no,variant_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?)
      `).run('transfer', product_id, fromWh, toWh, qty, date, note, user.id,
        ledOut.id, unit, ledOut.amount_rial, docId, lineNo, variantId);
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
      if (batchId) {
        db.prepare('UPDATE inventory_batches SET warehouse_id=? WHERE id=?').run(toWh, batchId);
      }
      totalAmountRial += Math.round(Number(ledOut.amount_rial) || 0);
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
      const isOpening = !!(body.opening || /اول\s*دوره|افتتاحیه|موجودی\s*اول/i.test(String(note || '')));
      const counterpart = acct(db, type === 'receipt'
        ? (isOpening ? 'coa_opening_balance' : 'coa_adjustment')
        : 'coa_inventory_loss');
      const lineCc = whCc(valuationWh);
      jeId = postToLedger(db, {
        sourceType: isOpening && type === 'receipt' ? 'opening_inventory' : `warehouse_${type}_batch`,
        sourceId: ids[0],
        date,
        description: isOpening && type === 'receipt'
          ? `موجودی اول دوره — رسید انبار (${ids.length} ردیف)`
          : `${typeLabelFa(type)} انبار ${num} (${ids.length} ردیف)`,
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
            { code: counterpart.code, name: counterpart.name, debit: amountToman, credit: 0, cost_center_id: lineCc },
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
  };
}

function createWarehouseDoc(db, body, user, opts = {}) {
  if (opts.outerTx) return createWarehouseDocInTx(db, body, user, opts);
  return db.transaction(() => createWarehouseDocInTx(db, body, user, opts))();
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
  const moves = db.prepare(`
    SELECT * FROM warehouse_moves
    WHERE doc_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id ASC
  `).all(docId);

  for (const m of moves) {
    voidOneMoveInTx(db, m, user.id);
  }

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
  ensureWarehouseDocSequence,
};
