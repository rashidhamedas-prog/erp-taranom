'use strict';
/**
 * Inventory API — ledger, batches, serials, reservations, landed cost.
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { getKardex, reverseInventoryMovement, postInventoryMovement, invErr } = require('../lib/inventory/ledger');
const { listFabricRolls, receiveFabricRoll, voidFabricRoll, updateFabricRoll } = require('../lib/inventory/fabric-rolls');
const {
  createBatch, listBatches, createSerial, listSerials, setSerialStatus, pickBatchesFefo,
} = require('../lib/inventory/batch-serial');
const {
  createReservation, releaseReservation, listReservations, availableQty, expireReservations,
} = require('../lib/inventory/reservation');
const { createLandedCostDoc, allocateAndPost } = require('../lib/inventory/landed-cost');
const { recalculateMovingAverageFromLayers } = require('../lib/inventory/costing');

function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message || String(e), code: e.code || undefined, ...e });
}

router.get('/ledger', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { product_id, warehouse_id, event_type, limit } = req.query;
  const where = ["status='posted'"];
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

router.post('/ledger/:id/reverse', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    let rev;
    db.transaction(() => {
      rev = reverseInventoryMovement(db, +req.params.id, {
        createdBy: req.user.id,
        date: req.body.date || todayJalali(),
        note: req.body.note,
      });
    })();
    audit(req.user.id, 'reverse', 'inventory_ledger', req.params.id, 'معکوس تراکنش انبار');
    res.json(rev);
  } catch (e) { sendErr(res, e); }
});

// ---- Batches / Serials ----
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
    audit(req.user.id, 'create', 'fabric_roll', row.id, `طاقه ${row.batch_no}`);
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

router.post('/recalc-avg/:productId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const r = recalculateMovingAverageFromLayers(db, +req.params.productId);
    res.json(r);
  } catch (e) { sendErr(res, e); }
});

// Manual adjustment via ledger (requires reason)
router.post('/adjust', auth, adminOrAccounting, (req, res) => {
  try {
    const { product_id, warehouse_id, qty, reason, date, unit_cost_rial } = req.body;
    if (!product_id || !qty || !reason) return res.status(400).json({ error: 'کالا، تعداد و دلیل الزامی است' });
    const db = getDB();
    let led;
    db.transaction(() => {
      led = postInventoryMovement(db, {
        eventType: 'adjustment',
        productId: +product_id,
        warehouseId: warehouse_id ? +warehouse_id : null,
        qty: +qty,
        unitCostRial: unit_cost_rial,
        sourceType: 'manual_adjustment',
        sourceId: null,
        date: date || todayJalali(),
        note: reason,
        createdBy: req.user.id,
      });
    })();
    audit(req.user.id, 'create', 'inventory_adjustment', led.id, reason);
    res.json(led);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
