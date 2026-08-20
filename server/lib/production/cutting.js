'use strict';
/**
 * PROD-02/03 + PACK — spreading + size matrix + cutting waste + FG receipt.
 * Consumes fabric rolls on WH-RAW. PACK receipts FG at WH-FG (no Lot/Serial).
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

function requireFgWarehouse(db, warehouseId) {
  const id = warehouseId
    ? Number(warehouseId)
    : Number(setting(db, 'production_wh_fg_id', '0')) || 0;
  const wh = id
    ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(id)
    : db.prepare("SELECT * FROM warehouses WHERE code='WH-FG' LIMIT 1").get();
  if (!wh) throw httpErr(400, 'انبار محصول یافت نشد', 'E_PACK_WH');
  const code = String(wh.code || '');
  const type = String(wh.warehouse_type || wh.kind || '');
  const isRaw = code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
  const isFg = code === 'WH-FG' || type === 'finished_goods' || type === 'finished' || type === 'fg';
  if (isRaw || !isFg) throw httpErr(400, 'رسید برش فقط روی انبار محصول است', 'E_PACK_WH_FG');
  return wh;
}

function parseSizeBreakdown(v) {
  return parseJson(v, {}) || {};
}

function qtyFromBreakdown(breakdown) {
  return Object.values(breakdown || {}).reduce((s, n) => s + Math.round(Number(n) || 0), 0);
}

function layNetWipRial(lay) {
  const amt = Math.round(Number(lay.amount_rial) || 0);
  const waste = Math.round(Number(lay.waste_amount_rial) || 0);
  return assertSafeRial(Math.max(0, amt - waste), 'lay wip');
}

function postedPackForLay(db, layId) {
  return db.prepare(`
    SELECT * FROM cutting_packs WHERE lay_id=? AND status='posted' ORDER BY id DESC LIMIT 1
  `).get(Number(layId));
}

function resolveOptionalOrder(db, orderId, productId) {
  if (orderId == null || orderId === '' || Number(orderId) === 0) return null;
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) throw httpErr(404, 'سفارش تولید یافت نشد', 'E_PACK_ORDER');
  if (['cancelled', 'closed'].includes(String(po.status || ''))) {
    throw httpErr(409, 'سفارش تولید بسته یا لغو شده است', 'E_PACK_ORDER_STATUS');
  }
  if (productId && Number(po.product_id) !== Number(productId)) {
    throw httpErr(400, 'سفارش باید همان کالای لایه باشد', 'E_PACK_ORDER_PRODUCT');
  }
  return po;
}

function attachPacks(db, row) {
  if (!row) return row;
  row.packs = db.prepare(`
    SELECT * FROM cutting_packs WHERE lay_id=? ORDER BY id DESC
  `).all(row.id);
  const packIds = row.packs.map((p) => p.id);
  row.bundles = packIds.length
    ? db.prepare(`
        SELECT * FROM cutting_pack_bundles
        WHERE pack_id IN (${packIds.map(() => '?').join(',')})
        ORDER BY pack_id, id
      `).all(...packIds)
    : [];
  row.wip_net_rial = layNetWipRial(row);
  const packedAmt = row.packs
    .filter((p) => p.status === 'posted')
    .reduce((s, p) => s + Math.round(Number(p.amount_rial) || 0), 0);
  row.wip_residual_rial = Math.max(0, row.wip_net_rial - packedAmt);
  row.size_breakdown = parseSizeBreakdown(row.size_breakdown);
  row.size_matrix = parseJson(row.size_matrix, {}) || {};
  return row;
}

function nextBundleBarcode(db, packNo, sizeCode, color) {
  const slug = String(packNo || 'PK').replace(/[^A-Za-z0-9]/g, '');
  const sz = String(sizeCode || 'NA').replace(/\s+/g, '') || 'NA';
  const col = String(color || '').trim()
    ? '-' + String(color).trim().replace(/\s+/g, '').slice(0, 12)
    : '';
  let n = 0;
  let code;
  do {
    n += 1;
    code = `${slug}-${sz}${col}-${n}`;
  } while (db.prepare('SELECT 1 FROM cutting_pack_bundles WHERE barcode=?').get(code));
  return code;
}

/**
 * Block PO issue/backflush of fabric already consumed by a posted cutting lay.
 * Remaining unused BOM meters (std − cut) may still be issued.
 */
function assertFabricIssueAllowed(db, { productId, qty, batchId, orderId } = {}) {
  const AQ = Number(qty) || 0;
  if (!(AQ > 0) || !productId) return;
  if (batchId) {
    const used = db.prepare(`
      SELECT COALESCE(SUM(r.meters),0) AS s
      FROM cutting_lay_rolls r
      JOIN cutting_lays l ON l.id = r.lay_id
      WHERE r.batch_id=? AND r.status='posted' AND COALESCE(l.status,'posted') <> 'reversed'
    `).get(Number(batchId));
    if ((Number(used && used.s) || 0) > 0) {
      throw httpErr(409, 'این طاقه در لایه‌چینی مصرف شده است', 'E_FABRIC_ALREADY_CUT', {
        batch_id: Number(batchId),
      });
    }
  }
  const cutRow = db.prepare(`
    SELECT COALESCE(SUM(l.actual_meters),0) AS s
    FROM cutting_lays l
    WHERE l.fabric_product_id=?
      AND COALESCE(l.status,'posted') <> 'reversed'
      AND (
        l.production_order_id IS NULL
        OR l.production_order_id = ?
        OR ? IS NULL
      )
  `).get(Number(productId), Number(orderId) || 0, orderId == null ? null : Number(orderId));
  const cutMeters = Number(cutRow && cutRow.s) || 0;
  if (cutMeters <= 0) return;

  let stdQty = 0;
  if (orderId) {
    const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
    if (po && po.bom_id) {
      try {
        const qtyStarted = Number(po.qty_planned) || 0;
        const { explodeBom } = require('./bom');
        const ex = explodeBom(db, {
          bomId: po.bom_id,
          qty: qtyStarted,
          sizeBreakdown: parseJson(po.size_breakdown, {}) || {},
          priceBasis: 'average',
        });
        const line = (ex.lines || []).find((L) => Number(L.product_id) === Number(productId));
        stdQty = line ? Number(line.qty_net != null ? line.qty_net : line.qty_final) || 0 : 0;
      } catch (_) { stdQty = 0; }
    }
  }
  const issuedRow = orderId
    ? db.prepare(`
        SELECT COALESCE(SUM(qty_actual),0) AS s
        FROM production_material_issues
        WHERE order_id=? AND product_id=? AND status='posted' AND qty_actual > 0
      `).get(Number(orderId), Number(productId))
    : { s: 0 };
  const alreadyIssued = Number(issuedRow && issuedRow.s) || 0;
  const allowed = Math.max(0, round6(stdQty - cutMeters));
  if (alreadyIssued + AQ > allowed + 1e-9) {
    throw httpErr(409, 'این متر پارچه در لایه‌چینی مصرف شده است', 'E_FABRIC_ALREADY_CUT', {
      product_id: Number(productId),
      cut_meters: cutMeters,
      allowed,
    });
  }
}

function isMeterUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  return u === 'm' || u === 'meter' || u === 'metre' || u === 'متر' || u.includes('متر');
}

function pickFabricLine(db, lines, preferredProductId) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return null;
  if (preferredProductId) {
    const hit = list.find((L) => Number(L.product_id) === Number(preferredProductId));
    if (hit) return hit;
  }
  const scored = list.map((L) => {
    const p = db.prepare('SELECT unit, item_type FROM products WHERE id=?').get(L.product_id) || {};
    const bl = L.bom_line_id
      ? db.prepare('SELECT size_matrix FROM bom_lines WHERE id=?').get(L.bom_line_id)
      : null;
    const matrix = parseJson(bl && bl.size_matrix, {}) || {};
    let score = 0;
    if (L.line_kind === 'material') score += 2;
    if (isMeterUnit(p.unit)) score += 8;
    if (Object.keys(matrix).length) score += 6;
    if (String(p.item_type || '') === 'raw') score += 1;
    return { L, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return (scored[0] && scored[0].score > 0 ? scored[0].L : list[0]) || null;
}

function fabricLineFromBom(db, { productId, bomId, date, sizeBreakdown, fabricProductId }) {
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
  const fabric = pickFabricLine(db, ex.lines, fabricProductId);
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
    fabricProductId: body.fabric_product_id,
  });
  const leftover = round6(Math.max(0, actual - matrixMeters));
  let wNormal;
  let wAbnormal;
  if (body.waste_normal_m != null || body.waste_abnormal_m != null) {
    wNormal = Math.max(0, Number(body.waste_normal_m) || 0);
    wAbnormal = Math.max(0, Number(body.waste_abnormal_m) || 0);
    if (!Number.isFinite(wNormal) || !Number.isFinite(wAbnormal)) {
      throw httpErr(400, 'ضایعات نامعتبر است', 'E_CUT_WASTE');
    }
    const wasteSum = round6(wNormal + wAbnormal);
    if (wasteSum > leftover + 1e-9) {
      throw httpErr(400, 'جمع ضایعات از مازاد مصرف بیشتر است', 'E_CUT_WASTE_SUM', {
        leftover, waste: wasteSum,
      });
    }
    if (wasteSum + 1e-9 < leftover) wNormal = round6(wNormal + (leftover - wasteSum));
  } else {
    wNormal = leftover;
    wAbnormal = 0;
  }
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
  const rows = db.prepare(`
    SELECT l.*, p.name AS product_name, fp.name AS fabric_name
    FROM cutting_lays l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN products fp ON fp.id = l.fabric_product_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC
    LIMIT 300
  `).all(...params);
  return rows.map((row) => {
    const pack = postedPackForLay(db, row.id);
    row.pack_posted = pack ? 1 : 0;
    row.pack_no = pack ? pack.pack_no : null;
    return row;
  });
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
  return attachPacks(db, row);
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
  let wasteAmt = assertSafeRial(Math.round(plan.waste_abnormal_m * unitCost), 'cut waste');
  if (wasteAmt > amount) wasteAmt = amount;
  const date = String(body.date || todayJalali()).trim();
  const color = String(body.color || '').trim();
  const widthCm = Math.round(Number(body.width_cm) || 0);
  const po = resolveOptionalOrder(db, body.production_order_id, plan.product.id);

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
          unit_cost_rial, amount_rial, waste_amount_rial, status, idempotency_key, date, note, created_by,
          production_order_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,?,?)
      `).run(
        layNo, plan.product.id, plan.bom_id, wh.id, plan.fabric_product_id, color,
        plan.marker_length_m, plan.ply_count, widthCm, plan.planned_meters, plan.actual_meters, plan.matrix_meters,
        JSON.stringify(plan.size_breakdown), JSON.stringify(plan.size_matrix), plan.qty_pieces,
        plan.waste_normal_m, plan.waste_abnormal_m, plan.waste_allowed_m,
        unitCost, amount, wasteAmt, key, date, String(body.note || '').trim(), user.id,
        po ? po.id : null
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
  if (postedPackForLay(db, row.id)) {
    throw httpErr(409, 'ابتدا رسید برش را ابطال کنید', 'E_CUT_HAS_PACK');
  }
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

function linkCuttingLayOrder(db, id, productionOrderId, user) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل پیوند نیست', 'E_CUT_REVERSED');
  const po = resolveOptionalOrder(db, productionOrderId, row.product_id);
  if (!po) throw httpErr(400, 'شناسه سفارش الزامی است', 'E_PACK_ORDER');
  db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(po.id, row.id);
  return getCuttingLay(db, row.id);
}

function getCuttingPack(db, packId) {
  const pack = db.prepare(`
    SELECT p.*, l.lay_no, pr.name AS product_name, w.code AS warehouse_code
    FROM cutting_packs p
    LEFT JOIN cutting_lays l ON l.id = p.lay_id
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN warehouses w ON w.id = p.warehouse_id
    WHERE p.id=?
  `).get(Number(packId));
  if (!pack) throw httpErr(404, 'رسید برش یافت نشد', 'E_PACK');
  pack.size_breakdown = parseSizeBreakdown(pack.size_breakdown);
  pack.bundles = db.prepare(`
    SELECT * FROM cutting_pack_bundles WHERE pack_id=? ORDER BY id
  `).all(pack.id);
  return pack;
}

function postCuttingPack(db, layId, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_PACK_IDEMPOTENCY');
  const existing = db.prepare('SELECT * FROM cutting_packs WHERE idempotency_key=?').get(key);
  if (existing) return getCuttingPack(db, existing.id);

  const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(layId));
  if (!lay) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (lay.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل بسته‌بندی نیست', 'E_CUT_REVERSED');
  const live = postedPackForLay(db, lay.id);
  if (live) throw httpErr(409, 'این لایه قبلاً رسید شده است', 'E_PACK_EXISTS');

  const po = resolveOptionalOrder(
    db,
    body.production_order_id != null ? body.production_order_id : lay.production_order_id,
    lay.product_id
  );
  const wh = requireFgWarehouse(db, body.warehouse_id);
  const breakdown = parseSizeBreakdown(lay.size_breakdown);
  const qty = qtyFromBreakdown(breakdown) || Math.round(Number(lay.qty_pieces) || 0);
  if (!(qty > 0)) throw httpErr(400, 'تعداد سایز برای رسید صفر است', 'E_PACK_QTY');
  const wipNet = layNetWipRial(lay);
  const unitCost = qty > 0 ? Math.round(wipNet / qty) : 0;
  const date = String(body.date || lay.date || todayJalali()).trim();
  const color = String(lay.color || '').trim();

  let packId;
  try {
    packId = db.transaction(() => {
      const raced = db.prepare('SELECT id FROM cutting_packs WHERE idempotency_key=?').get(key);
      if (raced) return raced.id;
      if (po && Number(lay.production_order_id) !== Number(po.id)) {
        db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(po.id, lay.id);
      }
      let packNo;
      try {
        const { allocateNumber } = require('../../db');
        packNo = allocateNumber(db, 'cutting_pack', 'PK');
      } catch (_) {
        packNo = 'PK-' + Date.now().toString(36).toUpperCase();
      }
      const ins = db.prepare(`
        INSERT INTO cutting_packs (
          pack_no, lay_id, production_order_id, product_id, warehouse_id, qty,
          amount_rial, unit_cost_rial, size_breakdown, status, idempotency_key, date, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,'posted',?,?,?,?)
      `).run(
        packNo, lay.id, po ? po.id : null, lay.product_id, wh.id, qty,
        wipNet, unitCost, JSON.stringify(breakdown), key, date,
        String(body.note || '').trim(), user.id
      );
      const id = ins.lastInsertRowid;
      assertJournalIdempotent(db, 'cutting_pack', id);

      const led = postInventoryMovement(db, {
        eventType: 'production_receipt',
        productId: lay.product_id,
        warehouseId: wh.id,
        qtyIn: qty,
        unitCostRial: unitCost,
        amountRial: wipNet,
        sourceType: 'cutting_pack',
        sourceId: id,
        date,
        note: `رسید برش ${packNo}`,
        createdBy: user.id,
      });

      let journalId = null;
      if (wipNet > 0) {
        journalId = postToLedger(db, {
          sourceType: 'cutting_pack',
          sourceId: id,
          date,
          description: `رسید برش ${qty} عدد — ${packNo}`,
          createdBy: user.id,
          lines: [
            dr(db, 'coa_finished_goods', wipNet),
            cr(db, 'coa_wip', wipNet),
          ],
        });
      }
      db.prepare('UPDATE cutting_packs SET journal_id=?, ledger_id=? WHERE id=?')
        .run(journalId, led.id, id);

      const sizes = Object.keys(breakdown);
      if (!sizes.length) {
        db.prepare(`
          INSERT INTO cutting_pack_bundles (pack_id, product_id, color, size_code, qty, amount_rial, barcode, status)
          VALUES (?,?,?,?,?,?,?, 'posted')
        `).run(id, lay.product_id, color, '', qty, wipNet, nextBundleBarcode(db, packNo, 'ALL', color));
      } else {
        let allocated = 0;
        sizes.forEach((sz, idx) => {
          const q = Math.round(Number(breakdown[sz]) || 0);
          if (!(q > 0)) return;
          const share = idx === sizes.length - 1
            ? Math.max(0, wipNet - allocated)
            : Math.round(wipNet * q / qty);
          allocated += share;
          db.prepare(`
            INSERT INTO cutting_pack_bundles (pack_id, product_id, color, size_code, qty, amount_rial, barcode, status)
            VALUES (?,?,?,?,?,?,?, 'posted')
          `).run(id, lay.product_id, color, sz, q, share, nextBundleBarcode(db, packNo, sz, color));
        });
      }
      return id;
    })();
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(String(e.message)))) {
      const again = db.prepare('SELECT id FROM cutting_packs WHERE idempotency_key=?').get(key);
      if (again) return getCuttingPack(db, again.id);
    }
    throw e;
  }
  return getCuttingPack(db, packId);
}

function voidCuttingPack(db, packId, user, { reason } = {}) {
  const pack = db.prepare('SELECT * FROM cutting_packs WHERE id=?').get(Number(packId));
  if (!pack) throw httpErr(404, 'رسید برش یافت نشد', 'E_PACK');
  if (pack.status === 'reversed') throw httpErr(409, 'این رسید قبلاً ابطال شده است', 'E_PACK_REVERSED');
  const { reverseJournalEntry } = require('../void-journal');
  db.transaction(() => {
    if (pack.ledger_id) {
      reverseInventoryMovement(db, pack.ledger_id, {
        createdBy: user.id,
        note: reason || 'ابطال رسید برش',
      });
    }
    let revJe = null;
    if (pack.journal_id) {
      revJe = reverseJournalEntry(db, pack.journal_id, {
        userId: user.id,
        reason: reason || 'ابطال رسید برش',
        sourceType: 'cutting_pack_reversal',
      });
    }
    db.prepare("UPDATE cutting_pack_bundles SET status='reversed' WHERE pack_id=? AND status='posted'")
      .run(pack.id);
    db.prepare(`
      UPDATE cutting_packs
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, pack.id);
  })();
  return getCuttingPack(db, pack.id);
}

function voidCuttingPackByLay(db, layId, user, opts) {
  const pack = db.prepare(`
    SELECT * FROM cutting_packs WHERE lay_id=? ORDER BY id DESC LIMIT 1
  `).get(Number(layId));
  if (!pack) throw httpErr(404, 'رسید برش یافت نشد', 'E_PACK');
  return voidCuttingPack(db, pack.id, user, opts);
}

module.exports = {
  planCutting,
  listCuttingLays,
  getCuttingLay,
  postCuttingLay,
  voidCuttingLay,
  classifyWasteMeters,
  assertFabricIssueAllowed,
  linkCuttingLayOrder,
  postCuttingPack,
  getCuttingPack,
  voidCuttingPack,
  voidCuttingPackByLay,
  layNetWipRial,
};
