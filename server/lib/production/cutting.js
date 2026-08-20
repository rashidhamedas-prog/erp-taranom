'use strict';
/**
 * PROD-02/03 — spreading (لایه‌چینی) + size matrix + cutting waste.
 * Consumes fabric rolls on WH-RAW. Does not receipt FG (PACK stays out).
 */

const { todayJalali } = require('../../jalali');
const { assertSafeRial } = require('../money');
const { assertJournalIdempotent } = require('../sales-document');
const { postInventoryMovement, reverseInventoryMovement } = require('../inventory/ledger');
const { adjustBatchQty } = require('../inventory/batch-serial');
const { explodeBom, resolveBom, round6 } = require('./bom');
const { dr, cr } = require('./posting');
const { setting } = require('./costing');
const { postToLedger } = require('../ledger');

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function parseJson(v, fallback) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { return JSON.parse(v); } catch (_) { return fallback; }
  }
  return fallback;
}

function classifyWasteMeters(started, wNormal, wAbnormal, allowedPct) {
  const s = Number(started) || 0;
  const pct = allowedPct != null ? Number(allowedPct) : 3;
  const allowed = round6(Math.max(0, s * pct / 100));
  let wN = Math.max(0, Number(wNormal) || 0);
  let wA = Math.max(0, Number(wAbnormal) || 0);
  let autoReclass = 0;
  if (wN > allowed + 1e-9) {
    autoReclass = round6(wN - allowed);
    wN = allowed;
    wA = round6(wA + autoReclass);
  }
  return { wN: round6(wN), wA: round6(wA), allowed, autoReclass };
}

function requireRawWarehouse(db, warehouseId) {
  const id = warehouseId
    ? Number(warehouseId)
    : Number(setting(db, 'production_wh_raw_id', '0')) || 0;
  const wh = id
    ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(id)
    : db.prepare("SELECT * FROM warehouses WHERE code='WH-RAW' LIMIT 1").get();
  if (!wh) throw httpErr(400, 'انبار مواد اولیه یافت نشد', 'E_CUT_WH');
  const code = String(wh.code || '');
  const type = String(wh.warehouse_type || wh.kind || '');
  const isRaw = code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
  if (!isRaw) throw httpErr(400, 'لایه‌چینی فقط روی انبار مواد اولیه است', 'E_CUT_WH_RAW');
  return wh;
}

function fabricLineFromBom(db, { productId, bomId, date, sizeBreakdown }) {
  let bom = null;
  if (bomId) {
    bom = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(Number(bomId));
  }
  if (!bom) {
    try { bom = resolveBom(db, { productId, date: date || todayJalali() }); }
    catch (_) { bom = null; }
  }
  if (!bom) return { bom: null, fabricLine: null, matrixMeters: 0, sizeMatrix: {} };
  const qtyPieces = Object.values(sizeBreakdown || {}).reduce((s, n) => s + (Number(n) || 0), 0) || 1;
  const ex = explodeBom(db, {
    bomId: bom.id,
    qty: qtyPieces,
    sizeBreakdown,
    priceBasis: 'average',
  });
  const fabric = (ex.lines || []).find((L) => L.line_kind === 'material') || (ex.lines || [])[0] || null;
  let sizeMatrix = {};
  if (fabric && fabric.bom_line_id) {
    const bl = db.prepare('SELECT size_matrix FROM bom_lines WHERE id=?').get(fabric.bom_line_id);
    sizeMatrix = parseJson(bl && bl.size_matrix, {}) || {};
  }
  return {
    bom,
    fabricLine: fabric,
    matrixMeters: fabric ? Number(fabric.qty_net) || 0 : 0,
    sizeMatrix,
  };
}

function planCutting(db, body = {}) {
  const productId = Number(body.product_id);
  if (!productId) throw httpErr(400, 'کالای دوخته‌شده الزامی است', 'E_CUT_PRODUCT');
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!prod) throw httpErr(404, 'کالا یافت نشد', 'E_CUT_PRODUCT');
  const marker = Number(body.marker_length_m);
  if (!(marker > 0) || !Number.isFinite(marker)) {
    throw httpErr(400, 'طول مارکر باید بزرگ‌تر از صفر باشد', 'E_CUT_MARKER');
  }
  const plies = Math.round(Number(body.ply_count) || 0);
  if (!(plies > 0)) throw httpErr(400, 'تعداد لایه باید بزرگ‌تر از صفر باشد', 'E_CUT_PLIES');
  const sizeBreakdown = parseJson(body.size_breakdown, {}) || {};
  const qtyPieces = Object.values(sizeBreakdown).reduce((s, n) => s + Math.round(Number(n) || 0), 0);
  if (!(qtyPieces > 0)) throw httpErr(400, 'ماتریس سایز حداقل یک عدد می‌خواهد', 'E_CUT_MATRIX');
  const planned = round6(marker * plies);
  const actual = body.actual_meters != null ? Number(body.actual_meters) : planned;
  if (!(actual > 0) || !Number.isFinite(actual)) {
    throw httpErr(400, 'متر مصرفی نامعتبر است', 'E_CUT_ACTUAL');
  }
  const date = String(body.date || todayJalali()).trim();
  const { bom, fabricLine, matrixMeters, sizeMatrix } = fabricLineFromBom(db, {
    productId, bomId: body.bom_id, date, sizeBreakdown,
  });
  const leftover = round6(Math.max(0, actual - matrixMeters));
  let wNormal = body.waste_normal_m != null ? Number(body.waste_normal_m) : leftover;
  let wAbnormal = body.waste_abnormal_m != null ? Number(body.waste_abnormal_m) : 0;
  const pct = Number(setting(db, 'production_normal_waste_default_pct', '3')) || 3;
  const classified = classifyWasteMeters(actual, wNormal, wAbnormal, pct);
  return {
    product: { id: prod.id, name: prod.name },
    bom_id: bom ? bom.id : null,
    fabric_product_id: fabricLine ? fabricLine.product_id : null,
    marker_length_m: marker,
    ply_count: plies,
    planned_meters: planned,
    actual_meters: round6(actual),
    matrix_meters: round6(matrixMeters),
    size_breakdown: sizeBreakdown,
    size_matrix: sizeMatrix,
    qty_pieces: qtyPieces,
    waste_normal_m: classified.wN,
    waste_abnormal_m: classified.wA,
    waste_allowed_m: classified.allowed,
    waste_auto_reclass_m: classified.autoReclass,
    normal_waste_pct: pct,
  };
}

function listCuttingLays(db, query = {}) {
  const where = [];
  const params = [];
  if (query.product_id) { where.push('l.product_id=?'); params.push(Number(query.product_id)); }
  if (query.status) { where.push('l.status=?'); params.push(String(query.status)); }
  else { where.push("COALESCE(l.status,'posted') <> 'reversed'"); }
  return db.prepare(`
    SELECT l.*, p.name AS product_name, fp.name AS fabric_name
    FROM cutting_lays l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN products fp ON fp.id = l.fabric_product_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC
    LIMIT 300
  `).all(...params);
}

function getCuttingLay(db, id) {
  const row = db.prepare(`
    SELECT l.*, p.name AS product_name, fp.name AS fabric_name, w.code AS warehouse_code
    FROM cutting_lays l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN products fp ON fp.id = l.fabric_product_id
    LEFT JOIN warehouses w ON w.id = l.warehouse_id
    WHERE l.id=?
  `).get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  row.rolls = db.prepare(`
    SELECT r.*, b.batch_no, b.color, b.qty_on_hand
    FROM cutting_lay_rolls r
    LEFT JOIN inventory_batches b ON b.id = r.batch_id
    WHERE r.lay_id=?
    ORDER BY r.id
  `).all(row.id);
  row.size_breakdown = parseJson(row.size_breakdown, {});
  row.size_matrix = parseJson(row.size_matrix, {});
  return row;
}

function postCuttingLay(db, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_CUT_IDEMPOTENCY');
  const existing = db.prepare('SELECT * FROM cutting_lays WHERE idempotency_key=?').get(key);
  if (existing) return getCuttingLay(db, existing.id);

  const plan = planCutting(db, body);
  const wh = requireRawWarehouse(db, body.warehouse_id);
  const rollsIn = Array.isArray(body.rolls) ? body.rolls : [];
  if (!rollsIn.length) throw httpErr(400, 'حداقل یک طاقه انتخاب کنید', 'E_CUT_ROLLS');

  let rollSum = 0;
  const prepared = [];
  for (const r of rollsIn) {
    const batchId = Number(r.batch_id);
    const meters = Number(r.meters);
    if (!batchId || !(meters > 0)) throw httpErr(400, 'طاقه یا متر نامعتبر است', 'E_CUT_ROLL');
    const batch = db.prepare("SELECT * FROM inventory_batches WHERE id=? AND COALESCE(kind,'generic')='fabric'").get(batchId);
    if (!batch) throw httpErr(400, 'طاقه پارچه یافت نشد', 'E_CUT_ROLL');
    if (batch.status === 'reversed' || batch.status === 'empty') {
      throw httpErr(409, 'این طاقه قابل مصرف نیست', 'E_CUT_ROLL_STATUS');
    }
    if (Number(batch.warehouse_id) && Number(batch.warehouse_id) !== Number(wh.id)) {
      throw httpErr(400, 'طاقه باید در انبار مواد باشد', 'E_CUT_ROLL_WH');
    }
    if ((Number(batch.qty_on_hand) || 0) + 1e-9 < meters) {
      throw httpErr(409, 'متر طاقه کافی نیست', 'E_CUT_ROLL_QTY', { batch_no: batch.batch_no });
    }
    if (plan.fabric_product_id && Number(batch.product_id) !== Number(plan.fabric_product_id)) {
      throw httpErr(400, 'طاقه باید همان پارچهٔ فرمول باشد', 'E_CUT_ROLL_PRODUCT');
    }
    rollSum = round6(rollSum + meters);
    const unit = Math.round(Number(batch.unit_cost_rial) || 0);
    prepared.push({
      batch,
      meters: round6(meters),
      unit_cost_rial: unit,
      amount_rial: assertSafeRial(Math.round(unit * meters), 'cut roll'),
    });
  }
  if (Math.abs(rollSum - plan.actual_meters) > 0.01) {
    throw httpErr(400, 'جمع متر طاقه‌ها باید با مصرف واقعی برابر باشد', 'E_CUT_ROLL_SUM', {
      rolls: rollSum, actual: plan.actual_meters,
    });
  }
  const amount = assertSafeRial(prepared.reduce((s, r) => s + r.amount_rial, 0), 'cut amount');
  const unitCost = plan.actual_meters > 0 ? Math.round(amount / plan.actual_meters) : 0;
  const wasteAmt = assertSafeRial(Math.round(plan.waste_abnormal_m * unitCost), 'cut waste');
  const date = String(body.date || todayJalali()).trim();
  const color = String(body.color || '').trim();
  const widthCm = Math.round(Number(body.width_cm) || 0);

  let layId;
  try {
    layId = db.transaction(() => {
      const raced = db.prepare('SELECT id FROM cutting_lays WHERE idempotency_key=?').get(key);
      if (raced) return raced.id;
      let layNo;
      try {
        const { allocateNumber } = require('../../db');
        layNo = allocateNumber(db, 'cutting_lay', 'LAY');
      } catch (_) {
        layNo = 'LAY-' + Date.now().toString(36).toUpperCase();
      }
      const ins = db.prepare(`
        INSERT INTO cutting_lays (
          lay_no, product_id, bom_id, warehouse_id, fabric_product_id, color,
          marker_length_m, ply_count, width_cm, planned_meters, actual_meters, matrix_meters,
          size_breakdown, size_matrix, qty_pieces, waste_normal_m, waste_abnormal_m, waste_allowed_m,
          unit_cost_rial, amount_rial, waste_amount_rial, status, idempotency_key, date, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,?)
      `).run(
        layNo, plan.product.id, plan.bom_id, wh.id, plan.fabric_product_id, color,
        plan.marker_length_m, plan.ply_count, widthCm, plan.planned_meters, plan.actual_meters, plan.matrix_meters,
        JSON.stringify(plan.size_breakdown), JSON.stringify(plan.size_matrix), plan.qty_pieces,
        plan.waste_normal_m, plan.waste_abnormal_m, plan.waste_allowed_m,
        unitCost, amount, wasteAmt, key, date, String(body.note || '').trim(), user.id
      );
      const id = ins.lastInsertRowid;
      assertJournalIdempotent(db, 'cutting_lay', id);

      for (const r of prepared) {
        const led = postInventoryMovement(db, {
          eventType: 'production_issue',
          productId: r.batch.product_id,
          warehouseId: wh.id,
          qtyOut: r.meters,
          unitCostRial: r.unit_cost_rial,
          amountRial: r.amount_rial,
          sourceType: 'cutting_lay',
          sourceId: id,
          batchId: r.batch.id,
          date,
          note: `لایه‌چینی ${layNo}`,
          createdBy: user.id,
        });
        adjustBatchQty(db, r.batch.id, -r.meters);
        db.prepare(`
          INSERT INTO cutting_lay_rolls (lay_id, batch_id, meters, unit_cost_rial, amount_rial, ledger_id, status)
          VALUES (?,?,?,?,?,?, 'posted')
        `).run(id, r.batch.id, r.meters, r.unit_cost_rial, r.amount_rial, led.id);
      }

      let journalId = null;
      if (amount > 0) {
        journalId = postToLedger(db, {
          sourceType: 'cutting_lay',
          sourceId: id,
          date,
          description: `مصرف پارچه لایه‌چینی ${layNo}`,
          createdBy: user.id,
          lines: [
            dr(db, 'coa_wip', amount),
            cr(db, 'coa_raw_materials', amount),
          ],
        });
      }
      let wasteJe = null;
      if (plan.waste_abnormal_m > 0 && wasteAmt > 0) {
        wasteJe = postToLedger(db, {
          sourceType: 'cutting_lay_waste',
          sourceId: id,
          date,
          description: `ضایعات غیرعادی برش ${layNo} — ${plan.waste_abnormal_m} متر`,
          createdBy: user.id,
          lines: [
            dr(db, 'coa_abnormal_waste', wasteAmt),
            cr(db, 'coa_wip', wasteAmt),
          ],
        });
      }
      db.prepare('UPDATE cutting_lays SET journal_id=?, waste_journal_id=? WHERE id=?')
        .run(journalId, wasteJe, id);
      return id;
    })();
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(String(e.message)))) {
      const again = db.prepare('SELECT id FROM cutting_lays WHERE idempotency_key=?').get(key);
      if (again) return getCuttingLay(db, again.id);
    }
    throw e;
  }
  return getCuttingLay(db, layId);
}

function voidCuttingLay(db, id, user, { reason } = {}) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'این لایه قبلاً ابطال شده است', 'E_CUT_REVERSED');
  const { reverseJournalEntry } = require('../void-journal');
  db.transaction(() => {
    const rolls = db.prepare("SELECT * FROM cutting_lay_rolls WHERE lay_id=? AND status='posted'").all(row.id);
    for (const r of rolls) {
      if (r.ledger_id) {
        reverseInventoryMovement(db, r.ledger_id, {
          createdBy: user.id,
          note: reason || 'ابطال لایه‌چینی',
        });
      }
      adjustBatchQty(db, r.batch_id, Number(r.meters) || 0);
      db.prepare("UPDATE cutting_lay_rolls SET status='reversed' WHERE id=?").run(r.id);
    }
    let revJe = null;
    if (row.waste_journal_id) {
      reverseJournalEntry(db, row.waste_journal_id, {
        userId: user.id,
        reason: reason || 'ابطال ضایعات برش',
        sourceType: 'cutting_lay_reversal',
      });
    }
    if (row.journal_id) {
      revJe = reverseJournalEntry(db, row.journal_id, {
        userId: user.id,
        reason: reason || 'ابطال لایه‌چینی',
        sourceType: 'cutting_lay_reversal',
      });
    }
    db.prepare(`
      UPDATE cutting_lays
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, row.id);
  })();
  return getCuttingLay(db, row.id);
}

module.exports = {
  planCutting,
  listCuttingLays,
  getCuttingLay,
  postCuttingLay,
  voidCuttingLay,
  classifyWasteMeters,
};
