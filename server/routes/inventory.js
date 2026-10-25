'use strict';
/**
 * Inventory API — ledger, batches, serials, reservations, landed cost.
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { getKardex, reverseInventoryMovement, postInventoryMovement, invErr } = require('../lib/inventory/ledger');
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

function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message || String(e), code: e.code || undefined, ...e });
}

router.get('/ledger', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { product_id, warehouse_id, event_type, limit } = req.query;
  // Qualify l.status — products.status (v546+) makes bare status ambiguous on the JOIN.
  const where = ["l.status='posted'"];
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
    const data = getKardex(db, +req.params.productId, {
      warehouseId: req.query.warehouse_id ? +req.query.warehouse_id : null,
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
