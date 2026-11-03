'use strict';
/**
 * Inventory API — ledger, batches, serials, reservations, landed cost.
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requirePermission, requireWarehouseReportView } = require('../middleware/auth');
// v577 Phase 4: acc_warehouse_ops:view OR reports:view (NOT invoices:view); invoices:create keeps the line picker working.
const stockReportGate = requireWarehouseReportView({ orInvoiceCreate: true });
const { todayJalali } = require('../jalali');
const { getKardex, reverseInventoryMovement, postInventoryMovement, invErr, warehouseQty } = require('../lib/inventory/ledger');
const { variantWarehouseQty } = require('../lib/inventory/movement');
const { lineAvailability, lineAvailabilityBatch } = require('../lib/inventory/line-availability');
const { listFabricRolls, listFabricCirculation, receiveFabricRoll, voidFabricRoll, updateFabricRoll } = require('../lib/inventory/fabric-rolls');
const {
  createBatch, listBatches, createSerial, listSerials, setSerialStatus, pickBatchesFefo,
} = require('../lib/inventory/batch-serial');
const {
  createReservation, releaseReservation, listReservations, availableQty, expireReservations,
} = require('../lib/inventory/reservation');
const { createLandedCostDoc, allocateAndPost, voidLandedCost } = require('../lib/inventory/landed-cost');
const { recalculateMovingAverageFromLayers } = require('../lib/inventory/costing');
const { reverseJournalEntry } = require('../lib/void-journal');
const { postInventoryValueAdjustmentJe, MANUAL_SOURCES } = require('../lib/subledger-recon');

/**
 * Read-only per-warehouse on-hand for invoice line UI. Never INSERT / seed.
 * v577 Phase 4: `qty` stays the OPERATIONAL (enforceable) number — warehouse_stock for products,
 * vws for variants (ledger.variant_id is not complete yet). The declared report source is kardex:
 * `kardex_qty` / `kardex_value_rial` / `weighted_avg_unit_rial` + `drift` are always returned for
 * product-level reads; pass `source=kardex` to make `qty` the kardex value.
 */
function buildStockByWarehouse(db, productId, variantId, opts = {}) {
  const pid = parseInt(productId, 10);
  const vid = variantId != null && variantId !== '' ? parseInt(variantId, 10) : 0;
  const isVariant = Number.isFinite(vid) && vid > 0;
  const useKardex = opts.source === 'kardex';
  if (!Number.isFinite(pid) || pid <= 0) {
    // legacy shape for an invalid product: warehouses with qty 0
    return db.prepare('SELECT id, name, COALESCE(allow_negative,0) AS allow_negative FROM warehouses WHERE active=1 ORDER BY id')
      .all().map((w) => ({ warehouse_id: Number(w.id), name: String(w.name || ''), qty: 0, source: 'warehouse_stock', allow_negative: Number(w.allow_negative) ? 1 : 0 }));
  }
  // v580: one source of truth — qty === line-availability on_hand (same layer shortage control enforces).
  return lineAvailability(db, { productId: pid, variantId: isVariant ? vid : null }).map((a) => {
    const out = {
      warehouse_id: a.warehouse_id,
      name: a.name,
      qty: a.on_hand,
      source: a.source,
      allow_negative: a.allow_negative,
    };
    if (a.kardex_qty != null && !isVariant) {
      out.declared_source = 'kardex';
      out.kardex_qty = a.kardex_qty;
      out.kardex_value_rial = a.kardex_value_rial;
      out.weighted_avg_unit_rial = a.weighted_avg_unit_rial;
      out.drift_qty = a.drift_qty;
      out.drift = a.drift_product;
      if (useKardex) { out.qty = a.kardex_qty; out.source = 'kardex'; }
    }
    return out;
  });
}
function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message || String(e), code: e.code || undefined, ...e });
}

// v574 فاز ۱ انبار: گزارش تطبیق لایه‌های موجودی — فقط SELECT، بدون هیچ اصلاح خودکار.
router.get('/reconcile', auth, adminOrAccounting, (req, res) => {
  try {
    const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');
    const q = req.query || {};
    const flag = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
    res.json(computeLayerReconcile(getDB(), {
      productId: parseInt(q.product_id, 10) || null,
      warehouseId: parseInt(q.warehouse_id, 10) || null,
      onlyDrift: flag(q.only_drift),
      limit: parseInt(q.limit, 10) || 0,
    }));
  } catch (e) { sendErr(res, e); }
});

router.get('/ledger', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { product_id, warehouse_id, event_type, limit } = req.query;
  // Qualify l.status — products.status (v546+) makes bare status ambiguous on the JOIN.
  const where = ["l.status='posted' AND l.reversed_of IS NULL AND COALESCE(l.event_type,'') <> 'reversal' AND COALESCE(l.event_type,'') NOT GLOB '*_reversal'"];
  const params = [];
  if (product_id) { where.push('l.product_id=?'); params.push(+product_id); }
  if (warehouse_id) { where.push('l.warehouse_id=?'); params.push(+warehouse_id); }
  if (event_type) { where.push('l.event_type=?'); params.push(event_type); }
  const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
  const rows = db.prepare(`
    SELECT l.*, p.name as product_name, p.code as product_code, w.name as warehouse_name, u.name as recorder
    FROM inventory_ledger l
    LEFT JOIN products p ON l.product_id=p.id
    LEFT JOIN warehouses w ON l.warehouse_id=w.id
    LEFT JOIN users u ON l.created_by=u.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC LIMIT ?
  `).all(...params, lim);
  res.json({ rows });
});

router.get('/kardex/:productId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const q = req.query;
    // Phase 3 (v576): variant / Jalali period / pagination (page_size ≤ 500) / toggles.
    const { assertJalaliQuery } = require('../lib/ledgers');
    const { from, to } = assertJalaliQuery(q.from, q.to);
    const data = getKardex(db, +req.params.productId, {
      warehouseId: q.warehouse_id ? +q.warehouse_id : null,
      variantId: q.variant_id ? +q.variant_id : null,
      from,
      to,
      page: q.page,
      pageSize: q.page_size,
      showWip: q.show_wip,
      showWarehouseOnly: q.show_warehouse_only,
      showCancelled: q.show_cancelled,
    });
    res.json(data);
  } catch (e) { sendErr(res, e); }
});

// v525: voiding a manual adjustment needs acc_warehouse_ops:delete (admin always); other manual rows keep adminOrAccounting.
function reverseGate(req, res, next) {
  const row = getDB().prepare('SELECT source_type FROM inventory_ledger WHERE id=?').get(+req.params.id);
  if (row && row.source_type === 'inventory_adjust') {
    if (require('../lib/inventory/manual-adjust').canVoidAdjust(req.user, getDB())) return next();
    return res.status(403).json({ error: 'برای ابطال تعدیل موجودی دسترسی لازم است', code: 'E_PERMISSION' });
  }
  return adminOrAccounting(req, res, next);
}

// Only manual adjustments are reversed from the kardex; document-born rows go through their source document.
router.post('/ledger/:id/reverse', auth, reverseGate, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'تراکنش انبار یافت نشد', code: 'E_LEDGER_NOT_FOUND' });
    const st = String(row.source_type || '');
    if (!MANUAL_SOURCES.has(st)) {
      return res.status(409).json({
        error: 'برای ابطال این ردیف سند مبدأ را ابطال کنید',
        code: 'E_REVERSE_VIA_SOURCE',
        source_type: st,
        source_id: row.source_id,
      });
    }
    let rev;
    db.transaction(() => {
      if (st === 'inventory_adjust' && row.reversed_of == null) {
        // v525: + variant×warehouse layer and closed-month approval doc (R13).
        rev = require('../lib/inventory/manual-adjust').reverseAdjustInTx(db, row, req.user, {
          date: req.body.date || todayJalali(),
          note: req.body.note || `ابطال تعدیل انبار ${row.tx_no || row.id}`,
        });
        return;
      }
      rev = reverseInventoryMovement(db, row.id, {
        createdBy: req.user.id,
        date: req.body.date || todayJalali(),
        note: req.body.note,
      });
      if (row.je_id) {
        reverseJournalEntry(db, row.je_id, {
          userId: req.user.id,
          reason: `ابطال تعدیل انبار ${row.tx_no || row.id}`,
        });
      }
    })();
    audit(req.user.id, 'reverse', 'inventory_ledger', req.params.id, 'معکوس تراکنش انبار');
    res.json({ ...rev, je_reversed: row.je_id || null });
  } catch (e) { sendErr(res, e); }
});

// FR-P334-A: correction reversal of opening/alignment kardex rows (no source document) — admin or acc_warehouse_ops:delete.
function reverseCorrectionGate(req, res, next) {
  if (require('../lib/inventory/manual-adjust').canVoidAdjust(req.user, getDB())) return next();
  return res.status(403).json({ error: 'برای ابطال اصلاحی ردیف کاردکس دسترسی لازم است', code: 'E_PERMISSION' });
}

router.get('/ledger/:id/reverse-correction-preview', auth, reverseCorrectionGate, (req, res) => {
  try {
    const { planCorrection } = require('../lib/inventory/ledger-reverse-correction');
    const se = req.query && req.query.stock_effect ? String(req.query.stock_effect) : null;
    res.json(planCorrection(getDB(), +req.params.id, { stockEffect: se }).plan);
  } catch (e) { sendErr(res, e); }
});

router.post('/ledger/:id/reverse-correction', auth, reverseCorrectionGate, (req, res) => {
  try {
    const { reverseCorrection } = require('../lib/inventory/ledger-reverse-correction');
    res.json(reverseCorrection(getDB(), +req.params.id, req.body, req.user, { audit }));
  } catch (e) { sendErr(res, e); }
});

// سند اصلاح تفکیک واریانت (VR): ردیف بدون واریانت کالای رنگ×سایز → ردیف‌های هر واریانت؛ ابطال R13.
{
  const VR = () => require('../lib/inventory/variant-reclass');
  const { centralOnlyStrict } = require('../middleware/auth');
  router.get('/variant-reclass', auth, reverseCorrectionGate, (req, res) => {
    try { res.json(VR().listDocs(getDB(), { productId: req.query.product_id || null, limit: req.query.limit })); } catch (e) { sendErr(res, e); }
  });
  router.post('/variant-reclass/preview', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try { res.json(VR().previewReclass(getDB(), req.body || {})); } catch (e) { sendErr(res, e); }
  });
  router.post('/variant-reclass', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try {
      const doc = VR().postReclass(getDB(), req.body || {}, req.user);
      audit(req.user.id, 'create', 'variant_reclass_docs', doc.id, `${doc.doc_no} ردیف ${doc.source_ledger_id}`);
      res.json(doc);
    } catch (e) { sendErr(res, e); }
  });
  router.post('/variant-reclass/:id/void', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try {
      const doc = VR().voidReclass(getDB(), +req.params.id, req.body || {}, req.user);
      audit(req.user.id, 'void', 'variant_reclass_docs', doc.id, `ابطال ${doc.doc_no}`);
      res.json(doc);
    } catch (e) { sendErr(res, e); }
  });
}

// audit-kardex K2: assign a warehouse to NULL-warehouse sale_return rows (static batch paths before /ledger/:id/…).
{
  const AW = () => require('../lib/inventory/ledger-assign-warehouse');
  const { centralOnlyStrict } = require('../middleware/auth');
  const awQuery = (q) => ({
    warehouseId: AW().parseWarehouseArg(q.warehouse_id),
    overrides: AW().parseOverrides(q.overrides),
    force: q.force === '1' || q.force === 'true',
  });
  router.get('/ledger/assign-warehouse-preview', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try {
      const db = getDB();
      const ids = req.query.ids ? AW().parseIds(String(req.query.ids)) : AW().candidateIds(db);
      res.json(ids.length ? AW().previewBatch(db, ids, awQuery(req.query)) : { ids: [], count: 0, ready: false, blockers: [], rows: [], gl_effect_rial: 0 });
    } catch (e) { sendErr(res, e); }
  });
  router.post('/ledger/assign-warehouse', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try { res.json(AW().assignWarehouse(getDB(), { body: req.body, user: req.user, audit, batch: true })); } catch (e) { sendErr(res, e); }
  });
  router.get('/ledger/:id/assign-warehouse-preview', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try {
      const p = AW().previewBatch(getDB(), [+req.params.id], awQuery(req.query));
      const r = p.rows[0];
      if (r.blocker && r.blocker.code === 'E_LEDGER_NOT_FOUND') return res.status(404).json({ error: r.blocker.error, code: r.blocker.code });
      res.json({ ...r, batch: { ready: p.ready, blockers: p.blockers, totals: p.totals } });
    } catch (e) { sendErr(res, e); }
  });
  router.post('/ledger/:id/assign-warehouse', auth, centralOnlyStrict, reverseCorrectionGate, (req, res) => {
    try { res.json(AW().assignWarehouse(getDB(), { ledgerId: +req.params.id, body: req.body, user: req.user, audit })); } catch (e) { sendErr(res, e); }
  });
}

router.get('/stock-kardex-mismatch', auth, adminOrAccounting, (req, res) => {
  try {
    const { stockKardexMismatch } = require('../lib/inventory/stock-kardex-mismatch');
    res.json(stockKardexMismatch(getDB(), {
      productId: parseInt(req.query.product_id, 10) || null,
      warehouseId: parseInt(req.query.warehouse_id, 10) || null,
    }));
  } catch (e) { sendErr(res, e); }
});

// audit-kardex K1: value-only revaluation of zero transfer_in legs (central only; admin or acc_warehouse_ops:delete).
function revalueTransferInGate(req, res, next) {
  if (require('../lib/inventory/manual-adjust').canVoidAdjust(req.user, getDB())) return next();
  return res.status(403).json({ error: 'برای اصلاح ارزش ورود انتقال دسترسی لازم است', code: 'E_PERMISSION' });
}
{
  const { centralOnlyStrict } = require('../middleware/auth');
  router.get('/ledger/revalue-transfer-in-preview', auth, revalueTransferInGate, centralOnlyStrict, (req, res) => {
    try {
      res.json(require('../lib/inventory/transfer-in-revalue').preview(getDB(), req.query));
    } catch (e) { sendErr(res, e); }
  });
  router.post('/ledger/revalue-transfer-in', auth, revalueTransferInGate, centralOnlyStrict, (req, res) => {
    try {
      res.json(require('../lib/inventory/transfer-in-revalue').revalue(getDB(), req.body, req.user, { audit }));
    } catch (e) { sendErr(res, e); }
  });
}

// ---- Batches / Serials ----
router.get('/fabric-rolls/circulation', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(listFabricCirculation(db, req.query));
  } catch (e) { sendErr(res, e); }
});

router.get('/fabric-rolls/units', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const prod = db.prepare('SELECT id, unit, unit_id FROM products WHERE id=?').get(Number(req.query.product_id) || 0);
    if (!prod) return res.status(404).json({ error: 'کالا یافت نشد', code: 'E_FABRIC_PRODUCT' });
    res.json(require('../lib/uom').fabricReceiptUnits(db, prod));
  } catch (e) { sendErr(res, e); }
});

router.get('/fabric-rolls/relabel-unit/preview', auth, adminOrAccounting, (req, res) => {
  try {
    const { previewRollUnitRelabel } = require('../lib/inventory/roll-unit-relabel');
    res.json(previewRollUnitRelabel(getDB(), Number(req.query.product_id) || 0));
  } catch (e) { sendErr(res, e); }
});

router.get('/fabric-rolls/relabel-unit', auth, adminOrAccounting, (req, res) => {
  try {
    const { listRollUnitRelabels } = require('../lib/inventory/roll-unit-relabel');
    res.json(listRollUnitRelabels(getDB(), req.query));
  } catch (e) { sendErr(res, e); }
});

router.post('/fabric-rolls/relabel-unit', auth, adminOrAccounting, (req, res) => {
  try {
    const { relabelRollUnits } = require('../lib/inventory/roll-unit-relabel');
    const b = req.body || {};
    const out = relabelRollUnits(getDB(), Number(b.product_id) || 0, {
      reason: b.reason,
      confirm: b.confirm === true || b.confirm === 1 || b.confirm === '1' || b.confirm === 'true',
    }, req.user);
    audit(req.user.id, 'update', 'fabric_roll_unit_relabel', out.id,
      `اصلاح برچسب واحد ${out.count} طاقه کالا #${out.product_id} → ${out.new_unit}: ${String(b.reason || '').trim()}`, req);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

router.post('/fabric-rolls/relabel-unit/:id/undo', auth, adminOrAccounting, (req, res) => {
  try {
    const { undoRollUnitRelabel } = require('../lib/inventory/roll-unit-relabel');
    const out = undoRollUnitRelabel(getDB(), req.params.id, { reason: req.body && req.body.reason }, req.user);
    audit(req.user.id, 'reverse', 'fabric_roll_unit_relabel', out.id,
      `بازگردانی برچسب واحد ${out.count} طاقه → ${out.restored_unit}: ${String((req.body && req.body.reason) || '').trim()}`, req);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

router.get('/fabric-rolls', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json({ rows: listFabricRolls(db, req.query) });
  } catch (e) { sendErr(res, e); }
});

router.post('/fabric-rolls', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = receiveFabricRoll(db, req.body || {}, req.user);
    const label = String(row.kind) === 'attr' ? 'مواد' : 'طاقه';
    audit(req.user.id, 'create', 'fabric_roll', row.id, `${label} ${row.batch_no}`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.post('/fabric-rolls/:id/void', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = voidFabricRoll(db, req.params.id, req.user, { reason: req.body && req.body.reason });
    audit(req.user.id, 'reverse', 'fabric_roll', row.id, 'ابطال طاقه');
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.patch('/fabric-rolls/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = updateFabricRoll(db, req.params.id, req.body || {}, req.user);
    audit(req.user.id, 'update', 'fabric_roll', row.id, `ویرایش طاقه ${row.batch_no}`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.get('/batches', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json({ rows: listBatches(db, {
    productId: req.query.product_id ? +req.query.product_id : null,
    warehouseId: req.query.warehouse_id ? +req.query.warehouse_id : null,
    status: req.query.status || 'active',
  }) });
});

router.post('/batches', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const b = createBatch(db, {
      productId: +req.body.product_id,
      warehouseId: req.body.warehouse_id ? +req.body.warehouse_id : null,
      batchNo: req.body.batch_no,
      supplierBatch: req.body.supplier_batch,
      mfgDate: req.body.mfg_date,
      expiryDate: req.body.expiry_date,
      bestBefore: req.body.best_before,
      qualityGrade: req.body.quality_grade,
      qty: req.body.qty,
      note: req.body.note,
      createdBy: req.user.id,
    });
    audit(req.user.id, 'create', 'inventory_batch', b.id, `بچ ${b.batch_no}`);
    res.json(b);
  } catch (e) { sendErr(res, e); }
});

router.get('/batches/fefo', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const productId = +req.query.product_id;
  const qty = +req.query.qty;
  if (!productId || !(qty > 0)) return res.status(400).json({ error: 'product_id و qty الزامی است' });
  res.json(pickBatchesFefo(db, productId, req.query.warehouse_id ? +req.query.warehouse_id : null, qty));
});

router.get('/serials', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json({ rows: listSerials(db, {
    productId: req.query.product_id ? +req.query.product_id : null,
    warehouseId: req.query.warehouse_id ? +req.query.warehouse_id : null,
    status: req.query.status || undefined,
  }) });
});

router.post('/serials', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const s = createSerial(db, {
      productId: +req.body.product_id,
      warehouseId: req.body.warehouse_id ? +req.body.warehouse_id : null,
      serialNo: req.body.serial_no,
      batchId: req.body.batch_id ? +req.body.batch_id : null,
      warrantyUntil: req.body.warranty_until,
      sourceType: req.body.source_type,
      sourceId: req.body.source_id,
      note: req.body.note,
      createdBy: req.user.id,
    });
    audit(req.user.id, 'create', 'inventory_serial', s.id, `سریال ${s.serial_no}`);
    res.json(s);
  } catch (e) { sendErr(res, e); }
});

router.post('/serials/:id/status', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const s = setSerialStatus(db, +req.params.id, req.body.status, {
      warehouseId: req.body.warehouse_id,
      ownerPartyId: req.body.owner_party_id,
      note: req.body.note,
    });
    res.json(s);
  } catch (e) { sendErr(res, e); }
});

// ---- Reservations ----
router.get('/reservations', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  expireReservations(db);
  res.json({ rows: listReservations(db, {
    productId: req.query.product_id ? +req.query.product_id : null,
    warehouseId: req.query.warehouse_id ? +req.query.warehouse_id : null,
    status: req.query.status || 'active',
    kind: req.query.kind,
    sourceType: req.query.source_type,
    sourceId: req.query.source_id,
  }) });
});

router.get('/available/:productId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const wh = req.query.warehouse_id ? +req.query.warehouse_id : null;
  res.json({
    product_id: +req.params.productId,
    warehouse_id: wh,
    available: availableQty(db, +req.params.productId, wh),
  });
});

// Phase 0 / Phase 4 — stock by warehouse (read-only; acc_warehouse_ops:view | reports:view | invoices:create)
router.get('/stock-by-warehouse', auth, stockReportGate, (req, res) => {
  const productId = parseInt(req.query.product_id, 10);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ error: 'product_id الزامی است', code: 'E_PRODUCT_REQUIRED' });
  }
  const variantId = req.query.variant_id != null && req.query.variant_id !== ''
    ? parseInt(req.query.variant_id, 10)
    : null;
  const db = getDB();
  const warehouses = buildStockByWarehouse(db, productId, variantId, { source: req.query.source });
  res.json({
    product_id: productId,
    variant_id: Number.isFinite(variantId) && variantId > 0 ? variantId : null,
    warehouses,
  });
});

router.post('/stock-by-warehouse/batch', auth, stockReportGate, (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) {
    return res.status(400).json({ error: 'items الزامی است', code: 'E_ITEMS_REQUIRED' });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: 'حداکثر ۱۰۰ قلم در هر درخواست', code: 'E_ITEMS_LIMIT' });
  }
  const db = getDB();
  const results = [];
  for (const it of items) {
    const productId = parseInt(it && it.product_id, 10);
    if (!Number.isFinite(productId) || productId <= 0) continue;
    const variantId = it && it.variant_id != null && it.variant_id !== ''
      ? parseInt(it.variant_id, 10)
      : null;
    results.push({
      product_id: productId,
      variant_id: Number.isFinite(variantId) && variantId > 0 ? variantId : null,
      warehouses: buildStockByWarehouse(db, productId, variantId, { source: req.body && req.body.source }),
    });
  }
  res.json({ results });
});

/**
 * v580 invoice-stock-display Phase 1 — unified sellable quantity per (product, variant, warehouse).
 * READ-ONLY POST (body carries the item list; nothing is written) → deliberately NOT in capture.js
 * PATH_TABLE_MAP; the sync outbox must not replay it. No new tables → SYNCABLE_TABLES unchanged.
 * available = on_hand − reserved + own_doc_qty (own_doc_qty only with a viewable exclude_invoice_id).
 */
function canUseInvoiceForAvailability(db, req, inv) {
  if (!inv) return false;
  try {
    const { canViewWalkinInvoice } = require('../lib/store-quick-sale');
    const walkin = canViewWalkinInvoice(db, req, inv);
    if (walkin !== null) return walkin;
  } catch (_) { /* fall through */ }
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'accounting' || role === 'sales_manager') return true;
  return Number(inv.user_id) === Number(req.user && req.user.id);
}

router.post('/line-availability/batch', auth, stockReportGate, (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) {
    return res.status(400).json({ error: 'items الزامی است', code: 'E_ITEMS_REQUIRED' });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: 'حداکثر ۱۰۰ قلم در هر درخواست', code: 'E_ITEMS_LIMIT' });
  }
  const db = getDB();
  let excludeInvoiceId = null;
  if (body.exclude_invoice_id != null && body.exclude_invoice_id !== '') {
    const id = parseInt(body.exclude_invoice_id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'exclude_invoice_id نامعتبر است', code: 'E_EXCLUDE_INVOICE_INVALID' });
    }
    const inv = db.prepare('SELECT id, user_id, cust_id FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'فاکتور پیدا نشد', code: 'E_INVOICE_NOT_FOUND' });
    if (!canUseInvoiceForAvailability(db, req, inv)) {
      return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_INVOICE_FORBIDDEN' });
    }
    excludeInvoiceId = id;
  }
  const results = lineAvailabilityBatch(db, items, { excludeInvoiceId });
  res.json({ exclude_invoice_id: excludeInvoiceId, results });
});

router.post('/reservations', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    let row;
    db.transaction(() => {
      row = createReservation(db, {
        kind: req.body.kind || 'sales',
        productId: +req.body.product_id,
        warehouseId: req.body.warehouse_id ? +req.body.warehouse_id : null,
        qty: +req.body.qty,
        priority: req.body.priority,
        sourceType: req.body.source_type,
        sourceId: req.body.source_id,
        batchId: req.body.batch_id,
        note: req.body.note,
        createdBy: req.user.id,
        ttlHours: req.body.ttl_hours,
      });
    })();
    audit(req.user.id, 'create', 'inventory_reservation', row.id, row.reservation_no);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.post('/reservations/:id/release', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = releaseReservation(db, +req.params.id, req.body.qty != null ? +req.body.qty : null);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

// ---- Landed cost ----
router.post('/landed-cost', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const doc = createLandedCostDoc(db, {
      purchaseId: req.body.purchase_id,
      date: req.body.date || todayJalali(),
      allocMethod: req.body.alloc_method || 'value',
      note: req.body.note,
      createdBy: req.user.id,
      lines: req.body.lines || [],
    });
    audit(req.user.id, 'create', 'landed_cost', doc.id, doc.doc_no);
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

router.post('/landed-cost/:id/post', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = allocateAndPost(db, +req.params.id, req.body.allocations || [], {
      createdBy: req.user.id,
      counterpartAcctKey: req.body.counterpart_acct_key || 'coa_payable',
      date: req.body.date || todayJalali(),
    });
    audit(req.user.id, 'post', 'landed_cost', req.params.id, 'ثبت هزینه حمل');
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

router.post('/landed-cost/:id/void', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = voidLandedCost(db, +req.params.id, {
      createdBy: req.user.id,
      reason: req.body.reason || '',
    });
    audit(req.user.id, 'void', 'landed_cost', req.params.id, 'ابطال هزینه حمل');
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

router.post('/recalc-avg/:productId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const r = recalculateMovingAverageFromLayers(db, +req.params.productId);
    res.json(r);
  } catch (e) { sendErr(res, e); }
});

/** First average for stock that was stored with no cost. Qty unchanged. */
router.post('/seed-avg-cost', auth, adminOrAccounting, (req, res) => {
  try {
    const { seedMissingAverageCost } = require('../lib/inventory/seed-avg');
    const productId = Number(req.body?.product_id);
    if (!productId) return res.status(400).json({ error: 'کالا الزامی است', code: 'E_NOT_FOUND' });
    const r = seedMissingAverageCost(getDB(), {
      productId,
      unitCostRial: req.body.unit_cost_rial,
      userId: req.user.id,
      date: req.body.date,
    });
    res.json(r);
  } catch (e) { sendErr(res, e); }
});

// ---- v525 manual stock adjustment (تعدیل موجودی) ----
// Gate: admin, or rbac acc_warehouse_ops:create (accounting has it by role default; a bare
// storekeeper/sales user gets 403 unless granted). Void: :delete — see reverseGate.
const MA = require('../lib/inventory/manual-adjust');
function requireAdjust(req, res, next) {
  if (MA.canAdjustStock(req.user, getDB())) return next();
  return res.status(403).json({ error: 'برای تعدیل موجودی دسترسی لازم است', code: 'E_PERMISSION' });
}

router.get('/adjust/meta', auth, (req, res) => {
  const db = getDB();
  const VA = require('../lib/inventory/value-accounts');
  res.json({
    can_adjust: MA.canAdjustStock(req.user, db),
    can_void: MA.canVoidAdjust(req.user, db),
    can_override_cost: MA.canOverrideCost(req.user, db),
    reasons: VA.ADJUST_REASONS,
  });
});

// Read-only (no writes; not captured into the device outbox — see sync/capture.js BLOCKLIST).
router.post('/adjust/preview', auth, requireAdjust, (req, res) => {
  try {
    res.json(MA.planAdjust(getDB(), req.body || {}, req.user, { peek: true }));
  } catch (e) { sendErr(res, e); }
});

router.get('/adjust/recent', auth, requireAdjust, (req, res) => {
  try {
    res.json({ rows: MA.listRecent(getDB(), {
      limit: req.query.limit, productId: req.query.product_id, warehouseId: req.query.warehouse_id,
    }) });
  } catch (e) { sendErr(res, e); }
});

// Manual adjustment via ledger. New UI sends mode + reason_code (required); legacy callers
// (API / old devices) keep { product_id, qty, reason } with optional reason_code.
// Counter account: value-accounts.adjustCounterAccount (stage + reason) inside MA.planAdjust.
router.post('/adjust', auth, requireAdjust, (req, res) => {
  try {
    const db = getDB();
    const body = req.body || {};
    const out = MA.postAdjust(db, body, req.user, { requireReason: body.mode != null && body.mode !== '' });
    audit(req.user.id, 'create', 'inventory_adjustment', out.id,
      `${out.tx_no} ${out.reason_label || ''} Δ${out.delta_qty} ${String(body.note || body.reason || '').slice(0, 120)}`.trim());
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
