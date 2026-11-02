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
const {
  availableBatchMeters,
  applyLiveRollQty,
  syncFabricProductWarehouse,
  colorsMatch,
} = require('../inventory/fabric-rolls');
const { explodeBom, resolveBom, round6 } = require('./bom');
const { dr, cr, postEvent, resolveCuttingCostCenterId } = require('./posting');
const { setting } = require('./costing');
const { resolveLayUnit, markerToUnit } = require('./lay-unit');

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

function isRawWarehouseRow(wh) {
  if (!wh) return false;
  const code = String(wh.code || '');
  const type = String(wh.warehouse_type || wh.kind || '');
  return code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
}

function loadWarehouse(db, id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(id)) || null;
}

/** Resolve raw warehouse: explicit id → selected rolls → live setting → WH-RAW → any raw_material. */
function requireRawWarehouse(db, warehouseId, rollWarehouseIds) {
  const assertRaw = (wh, missingOk) => {
    if (!wh) {
      if (missingOk) return null;
      throw httpErr(400, 'انبار مواد اولیه یافت نشد', 'E_CUT_WH');
    }
    if (!isRawWarehouseRow(wh)) throw httpErr(400, 'لایه‌چینی فقط روی انبار مواد اولیه است', 'E_CUT_WH_RAW');
    return wh;
  };

  if (warehouseId) return assertRaw(loadWarehouse(db, warehouseId), false);

  const unique = [...new Set((rollWarehouseIds || []).map(Number).filter(Boolean))];
  if (unique.length > 1) throw httpErr(400, 'طاقه‌ها باید از یک انبار مواد باشند', 'E_CUT_ROLL_WH');
  if (unique.length === 1) {
    const fromRoll = assertRaw(loadWarehouse(db, unique[0]), false);
    if (fromRoll) return fromRoll;
  }

  const settingId = Number(setting(db, 'production_wh_raw_id', '0')) || 0;
  const fromSetting = settingId ? loadWarehouse(db, settingId) : null;
  if (fromSetting && isRawWarehouseRow(fromSetting)) return fromSetting;

  const byCode = db.prepare("SELECT * FROM warehouses WHERE code='WH-RAW' LIMIT 1").get();
  if (byCode && isRawWarehouseRow(byCode)) return byCode;

  const anyRaw = db.prepare(`
    SELECT * FROM warehouses
    WHERE COALESCE(is_active,1)=1
      AND (
        code='WH-RAW'
        OR COALESCE(warehouse_type,'') IN ('raw_material','raw')
        OR COALESCE(kind,'') IN ('raw_material','raw')
      )
    LIMIT 1
  `).get();
  return assertRaw(anyRaw, false);
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

function isWipWarehouseRow(wh) {
  if (!wh) return false;
  const code = String(wh.code || '');
  const types = [String(wh.warehouse_type || ''), String(wh.kind || '')];
  return code === 'WH-WIP' || code === 'WH-CUT'
    || types.some((t) => ['wip', 'work_in_process', 'semi'].includes(t));
}

/**
 * WIP / cut-bundle warehouse for pack when linked to a production order (F06).
 * Unfinished goods must never land in the FG warehouse — no FG fallback: if no WIP
 * warehouse is configured the pack is refused with E_WIP_WAREHOUSE_REQUIRED.
 */
function requirePackWarehouse(db, warehouseId, { linkedOrder }) {
  if (!linkedOrder) return requireFgWarehouse(db, warehouseId);
  const id = warehouseId
    ? Number(warehouseId)
    : Number(setting(db, 'production_wh_wip_id', '0')) || 0;
  let wh = id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(id) : null;
  if (!wh && !warehouseId) {
    wh = db.prepare(`
      SELECT * FROM warehouses
      WHERE COALESCE(warehouse_type,'') IN ('wip','work_in_process','semi')
         OR COALESCE(kind,'') IN ('wip','work_in_process','semi')
         OR code IN ('WH-WIP','WH-CUT')
      LIMIT 1
    `).get();
  }
  if (!wh) {
    throw httpErr(
      400,
      'انبار کار در جریان (WIP) تعریف نشده است — برای بستهٔ برش سفارش‌دار انبار WH-WIP بسازید یا تنظیم production_wh_wip_id را پر کنید',
      'E_WIP_WAREHOUSE_REQUIRED'
    );
  }
  const code = String(wh.code || '');
  const type = String(wh.warehouse_type || wh.kind || '');
  const isRaw = code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
  if (isRaw) throw httpErr(400, 'بسته برش سفارش‌دار نباید به انبار مواد برود', 'E_PACK_WH');
  if (!isWipWarehouseRow(wh)) {
    throw httpErr(
      400,
      'بستهٔ برش سفارش‌دار باید در انبار کار در جریان (WIP) ثبت شود، نه انبار محصول',
      'E_WIP_WAREHOUSE_REQUIRED',
      { warehouse_id: wh.id, warehouse_code: code }
    );
  }
  return wh;
}

/**
 * PA-05: lay/pack JEs honor production_period_close like engine.assertPeriodOpen.
 * Inlined (engine.js requires this module — avoid a circular import).
 */
function assertCutPeriodOpen(db, date) {
  const parts = String(date || '').split('/');
  if (parts.length < 2) return;
  const period = `${parts[0]}/${String(parts[1]).padStart(2, '0')}`;
  const closed = db.prepare(`
    SELECT 1 FROM production_period_close WHERE period_label=? AND status='closed'
  `).get(period);
  if (closed) throw httpErr(409, 'دورهٔ تولید بسته است', 'E_PERIOD_CLOSED', { period });
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
  // Any live posted PACK blocks lay void/amend — including WIP stubs without
  // ledger_id yet (audit #81 / test-cutting-lay-covered-void-v468).
  return db.prepare(`
    SELECT * FROM cutting_packs
    WHERE lay_id=? AND COALESCE(status,'posted')='posted'
    ORDER BY id DESC LIMIT 1
  `).get(Number(layId));
}

function resolveOptionalOrder(db, orderId, productId) {
  if (orderId == null || orderId === '' || Number(orderId) === 0) return null;
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) throw httpErr(404, 'سفارش تولید یافت نشد', 'E_PACK_ORDER');
  if (['cancelled', 'closed', 'voided'].includes(String(po.status || ''))) {
    throw httpErr(409, 'سفارش تولید بسته یا لغو شده است', 'E_PACK_ORDER_STATUS');
  }
  if (productId && Number(po.product_id) !== Number(productId)) {
    const { orderBomPeerLines } = require('./bom');
    const peers = orderBomPeerLines(po);
    const onOrder = peers && peers.some((l) => Number(l.product_id) === Number(productId));
    if (!onOrder) throw httpErr(400, 'سفارش باید همان کالای لایه باشد', 'E_PACK_ORDER_PRODUCT');
  }
  return po;
}

/** Open make-to-order jobs for a FG product (not yet completed). */
function findOpenProductionOrdersForProduct(db, productId) {
  const pid = Number(productId);
  if (!pid) return [];
  return db.prepare(`
    SELECT id, order_no, status, product_id
    FROM production_orders
    WHERE (
        product_id=?
        OR instr(IFNULL(fg_plan_json,''), '"product_id":' || ? || ',') > 0
        OR instr(IFNULL(fg_plan_json,''), '"product_id":' || ? || '}') > 0
      )
      AND COALESCE(status,'') NOT IN ('cancelled','closed','completed','done','voided')
    ORDER BY id DESC
  `).all(pid, pid, pid);
}

/**
 * F06 ownership: sellable FG is posted once — either by finalize (PO path) or by
 * standalone cut-to-stock PACK. Never both for the same physical pieces.
 *
 * When the lay/body omits PO but exactly one open order exists for the product,
 * auto-link. Multiple open orders → force an explicit choice. Explicit
 * cut_to_stock=true keeps the legacy FG receipt even if open orders exist.
 */
function resolvePackProductionOrder(db, lay, body) {
  const cutToStock = body && (body.cut_to_stock === true || body.cut_to_stock === 1
    || String(body.cut_to_stock || '').toLowerCase() === 'true');
  let po = resolveOptionalOrder(
    db,
    body && body.production_order_id != null ? body.production_order_id : lay.production_order_id,
    lay.product_id
  );
  if (po) {
    const st = String(po.status || '');
    if (['completed', 'done'].includes(st)) {
      throw httpErr(
        409,
        `سفارش ${po.order_no || po.id} قبلاً نهایی شده — رسید محصول از مسیر PACK برای آن مجاز نیست`,
        'E_PACK_ORDER_FINALIZED',
        { order_id: po.id, order_no: po.order_no }
      );
    }
    return { po, cutToStock: false, autoLinked: false };
  }
  if (cutToStock) return { po: null, cutToStock: true, autoLinked: false };

  const open = findOpenProductionOrdersForProduct(db, lay.product_id);
  if (open.length === 1) {
    po = resolveOptionalOrder(db, open[0].id, lay.product_id);
    return { po, cutToStock: false, autoLinked: true };
  }
  if (open.length > 1) {
    throw httpErr(
      400,
      'برای این کالا چند سفارش تولید باز است — شناسه سفارش را در لایه‌چینی/PACK مشخص کنید (یا cut_to_stock=true برای رسید مستقیم بدون سفارش)',
      'E_PACK_PO_REQUIRED',
      {
        orders: open.map((o) => ({ id: o.id, order_no: o.order_no, status: o.status })),
      }
    );
  }
  return { po: null, cutToStock: true, autoLinked: false };
}

/**
 * Block finalize when a standalone (sellable) cutting pack already credited FG
 * for the same product — that path already ran PRD-07 / products.stock.
 */
function assertNoOrphanSellablePack(db, productId, orderId) {
  const has = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_packs'"
  ).get();
  if (!has) return;
  // Sellable cut-to-stock packs use event_type=production_receipt (not cutting_pack WIP).
  const rows = db.prepare(`
    SELECT p.id, p.pack_no, p.qty, p.production_order_id
    FROM cutting_packs p
    WHERE p.product_id=?
      AND p.status='posted'
      AND (p.production_order_id IS NULL OR p.production_order_id = 0
           OR p.production_order_id != ?)
      AND EXISTS (
        SELECT 1 FROM inventory_ledger il
        WHERE il.source_type='cutting_pack' AND il.source_id=p.id
          AND il.status='posted'
          AND COALESCE(il.event_type,'') = 'production_receipt'
          AND COALESCE(il.qty_in,0) > 0
      )
  `).all(Number(productId), Number(orderId) || 0);
  if (!rows.length) return;
  const sample = rows.slice(0, 3).map((r) => r.pack_no || ('#' + r.id)).join('، ');
  throw httpErr(
    409,
    `برای این کالا رسید برش فروش‌پذیر بدون پیوند سفارش ثبت شده (${sample}). اول آن رسید را ابطال کنید یا به همین سفارش پیوند دهید تا موجودی دوبار وارد نشود`,
    'E_STANDALONE_PACK_FG',
    { packs: rows.map((r) => ({ id: r.id, pack_no: r.pack_no, qty: r.qty })) }
  );
}

/**
 * Apparel fabric path: meter fabric in BOM must go
 * lay → PACK (WIP) → order receipt/finalize (FG). Never short-circuit via
 * POST /production/orders/:id/receipt alone.
 *
 * v467: پارچهٔ متری در BOM حتی قبل از ورود اولین طاقه همین مسیر را می‌خواهد
 * تا ضایعات/انحراف لایه‌چینی از بهای تمام‌شده جا نماند. مواد غیرمتری
 * (زیپ و …) و مسیر بدون پارچهٔ متری معاف‌اند.
 */
function orderRequiresFabricCutting(db, po) {
  if (!po || !po.bom_id || !po.product_id) return false;
  const { fabricLine } = fabricLineFromBom(db, {
    productId: po.product_id,
    bomId: po.bom_id,
    date: po.date || todayJalali(),
    sizeBreakdown: parseJson(po.size_breakdown, {}) || {},
  });
  if (!fabricLine || !fabricLine.product_id) return false;
  return isRollFabricProduct(db, Number(fabricLine.product_id));
}

function cuttingQtyForOrder(db, orderId) {
  const oid = Number(orderId) || 0;
  if (!oid) return { lay_qty: 0, pack_qty: 0 };
  const hasLay = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_lays'"
  ).get();
  const hasPack = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_packs'"
  ).get();
  const lay_qty = hasLay
    ? Number(db.prepare(`
        SELECT COALESCE(SUM(COALESCE(qty_pieces,0)),0) AS s
        FROM cutting_lays
        WHERE production_order_id=? AND COALESCE(status,'posted')<>'reversed'
      `).get(oid)?.s) || 0
    : 0;
  const pack_qty = hasPack
    ? Number(db.prepare(`
        SELECT COALESCE(SUM(COALESCE(qty,0)),0) AS s
        FROM cutting_packs
        WHERE production_order_id=? AND status='posted' AND ledger_id IS NOT NULL
      `).get(oid)?.s) || 0
    : 0;
  return { lay_qty, pack_qty };
}

function fabricCuttingGateInfo(db, po) {
  const qty = cuttingQtyForOrder(db, po && po.id);
  const required = orderRequiresFabricCutting(db, po);
  const produced = Number(po && po.qty_produced) || 0;
  const receipt_ready = !required
    || (qty.lay_qty > produced + 1e-9 && qty.pack_qty > produced + 1e-9);
  return {
    requires_fabric_cutting: !!required,
    cutting_lay_qty: qty.lay_qty,
    cutting_pack_qty: qty.pack_qty,
    cutting_receipt_ready: !!receipt_ready,
  };
}

/**
 * Gate simple FG receipt (fixed/variable) when the order is roll-fabric apparel.
 * Advanced finalize keeps its own stage checks; still call this before FG there
 * if rolls are required (finalizeAdvancedOrder already assumes routing done).
 */
function assertFabricCuttingPathForFgReceipt(db, po, qtyGood) {
  if (!orderRequiresFabricCutting(db, po)) return { required: false };
  const need = (Number(po.qty_produced) || 0) + (Number(qtyGood) || 0);
  const { lay_qty, pack_qty } = cuttingQtyForOrder(db, po.id);
  if (lay_qty + 1e-9 < need) {
    throw httpErr(
      409,
      `این سفارش طاقه‌دار است — قبل از رسید انبار محصول، لایه‌چینی برای حداقل ${need} عدد ثبت کنید (فعلی: ${lay_qty}). مسیر: لایه‌چینی → PACK → سپس رسید/نهایی‌سازی سفارش`,
      'E_CUTTING_LAY_REQUIRED',
      { need, lay_qty, pack_qty, order_id: po.id, order_no: po.order_no }
    );
  }
  if (pack_qty + 1e-9 < need) {
    throw httpErr(
      409,
      `بعد از لایه‌چینی، بسته‌بندی/ورود WIP (PACK) برای حداقل ${need} عدد لازم است (فعلی: ${pack_qty}). سپس از سفارش «رسید» یا نهایی‌سازی بزنید تا وارد انبار محصول شود`,
      'E_CUTTING_PACK_REQUIRED',
      { need, lay_qty, pack_qty, order_id: po.id, order_no: po.order_no }
    );
  }
  return { required: true, need, lay_qty, pack_qty };
}

function cuttingQtyForOrderProduct(db, orderId, productId) {
  const oid = Number(orderId) || 0;
  const pid = Number(productId) || 0;
  if (!oid || !pid) return { lay_qty: 0, pack_qty: 0 };
  const layShared = Number(db.prepare(`
    SELECT COALESCE(SUM(o.planned_pieces),0) AS s
    FROM cutting_batch_outputs o
    JOIN cutting_batches b ON b.id = o.batch_id
    JOIN cutting_lays l ON l.id = b.lay_id
    WHERE l.production_order_id=? AND o.product_id=?
      AND COALESCE(l.status,'posted')<>'reversed'
      AND COALESCE(b.status,'posted')<>'reversed'
  `).get(oid, pid)?.s) || 0;
  const layClassic = Number(db.prepare(`
    SELECT COALESCE(SUM(COALESCE(qty_pieces,0)),0) AS s
    FROM cutting_lays
    WHERE production_order_id=? AND product_id=? AND batch_id IS NULL
      AND COALESCE(status,'posted')<>'reversed'
  `).get(oid, pid)?.s) || 0;
  const pack_qty = Number(db.prepare(`
    SELECT COALESCE(SUM(COALESCE(qty,0)),0) AS s
    FROM cutting_packs
    WHERE production_order_id=? AND product_id=? AND status='posted' AND ledger_id IS NOT NULL
  `).get(oid, pid)?.s) || 0;
  return { lay_qty: layShared + layClassic, pack_qty };
}

/** برش و بسته‌بندی هر محصول سفارش باید با تعداد همان محصول برابر باشد. */
function assertOrderCutQtyMatches(db, po) {
  if (!orderRequiresFabricCutting(db, po)) return { required: false };
  const { orderBomPeerLines } = require('./bom');
  const peers = orderBomPeerLines(po);
  const lines = peers || [{ product_id: po.product_id, qty_planned: Number(po.qty_planned) || 0 }];
  for (const line of lines) {
    const need = Number(line.qty_planned) || 0;
    const q = cuttingQtyForOrderProduct(db, po.id, line.product_id);
    const name = db.prepare('SELECT name FROM products WHERE id=?').get(line.product_id)?.name || ('#' + line.product_id);
    if (Math.abs(q.lay_qty - need) > 0.001) {
      throw httpErr(
        409,
        `تعداد برش «${name}» (${q.lay_qty}) با تعداد سفارش (${need}) یکی نیست. لایه‌چینی را به همین سفارش وصل کنید.`,
        'E_CUT_QTY_MISMATCH',
        { product_id: line.product_id, need, lay_qty: q.lay_qty, pack_qty: q.pack_qty }
      );
    }
    if (Math.abs(q.pack_qty - need) > 0.001) {
      throw httpErr(
        409,
        `بسته‌بندی «${name}» (${q.pack_qty}) با تعداد سفارش (${need}) یکی نیست. از تب «بسته‌بندی / رسید محصول» ثبت کنید؛ تا قبل از آن کالا وارد انبار محصول نمی‌شود.`,
        'E_CUTTING_PACK_REQUIRED',
        { product_id: line.product_id, need, lay_qty: q.lay_qty, pack_qty: q.pack_qty }
      );
    }
  }
  return { required: true };
}

/**
 * Linked cutting packs stage bundle qty in a WIP warehouse (warehouseOnly).
 * Order receipt / finalize must take that qty out of WIP without a second
 * products.stock hit. The exit is valued at the pack's own cost (never the FG
 * average); the last exit of a pack takes the exact remaining amount.
 */
const PACK_RELIEF_SQL = `
  FROM inventory_ledger
  WHERE source_type='cutting_pack' AND source_id=? AND event_type='cutting_pack'
    AND COALESCE(qty_out,0)>0 AND status='posted' AND reversed_of IS NULL
`;

function relieveStagedPackQty(db, { orderId, productId, qtyGood, userId, date, receiptId }) {
  const has = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_packs'"
  ).get();
  if (!has) return;
  const packs = db.prepare(`
    SELECT id, warehouse_id, qty, amount_rial FROM cutting_packs
    WHERE production_order_id=? AND product_id=? AND status='posted' AND COALESCE(qty,0)>0
    ORDER BY id
  `).all(orderId, productId);
  const relievedOf = db.prepare(`
    SELECT COALESCE(SUM(qty_out),0) AS q, COALESCE(SUM(amount_rial),0) AS a ${PACK_RELIEF_SQL}
  `);
  let left = Number(qtyGood) || 0;
  for (const p of packs) {
    if (!(left > 0)) break;
    const wh = Number(p.warehouse_id) || 0;
    if (!wh) continue;
    const packQty = Number(p.qty) || 0;
    const done = relievedOf.get(p.id);
    const remainingQty = packQty - (Number(done.q) || 0);
    const take = Math.min(left, remainingQty);
    if (!(take > 1e-9)) continue;
    const packAmt = Math.round(Number(p.amount_rial) || 0);
    const remainingAmt = Math.max(0, packAmt - Math.round(Number(done.a) || 0));
    const amount = take >= remainingQty - 1e-9
      ? remainingAmt
      : Math.min(remainingAmt, Math.round(packAmt * take / packQty));
    postInventoryMovement(db, {
      eventType: 'cutting_pack',
      productId,
      warehouseId: wh,
      qtyOut: take,
      unitCostRial: Math.round(amount / take),
      amountRial: amount,
      allowZeroCost: amount <= 0,
      sourceType: 'cutting_pack',
      sourceId: p.id,
      date: date || '',
      note: `تخلیه WIP بسته برش هنگام رسید ${receiptId || ''}`,
      createdBy: userId || null,
      updateAvg: false,
      warehouseOnly: true,
    });
    try {
      require('../inventory/apparel-lines').reverseApparelDoc(db, {
        docType: 'cutting_pack', docId: p.id, userId: userId || null,
        note: `تخلیه apparel WIP بسته ${p.id}`,
      });
    } catch (_) { /* no apparel layer */ }
    left -= take;
  }
}

/** Undo every WIP pack exit of an order (receipt reversal): mirror rows put the packs back in WIP at the same amounts. */
function reverseStagedPackRelief(db, { orderId, userId, date, note }) {
  const has = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_packs'"
  ).get();
  if (!has) return 0;
  const rows = db.prepare(`
    SELECT il.id FROM inventory_ledger il
    JOIN cutting_packs p ON p.id = il.source_id
    WHERE p.production_order_id=? AND il.source_type='cutting_pack' AND il.event_type='cutting_pack'
      AND COALESCE(il.qty_out,0)>0 AND il.status='posted' AND il.reversed_of IS NULL
    ORDER BY il.id DESC
  `).all(orderId);
  for (const r of rows) {
    reverseInventoryMovement(db, r.id, {
      createdBy: userId || null,
      date: date || '',
      note: note || 'ابطال تخلیه WIP بسته برش',
    });
  }
  return rows.length;
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
 * Remaining fabric meters that may still be issued via PO material issue after cutting.
 *
 * Scope (v384): cut meters count only lays that belong to THIS production order
 * (production_order_id) OR, for legacy lays without PO, the same finished goods
 * product_id as the order. Lays for a different FG/SKU must NOT lock another
 * order's BOM fabric line (cross-product contamination bug on PO-0009 / آبان).
 *
 * Double-issue of the same physical roll is still blocked by batch_id check in
 * assertFabricIssueAllowed — independent of this scope.
 *
 * `allowed === null` means no cutting lock for this order/FG.
 */
function fabricIssueAllowance(db, { productId, orderId } = {}) {
  const out = {
    product_id: productId ? Number(productId) : null,
    cut_meters: 0,
    cut_scope: null,
    cut_fg_product_id: null,
    std_qty: 0,
    already_issued: 0,
    allowed: null,
    remaining: null,
  };
  if (!productId) return out;

  let cutMeters = 0;
  let po = null;
  if (orderId) {
    po = db.prepare('SELECT id, product_id, bom_id, qty_planned, size_breakdown FROM production_orders WHERE id=?')
      .get(Number(orderId));
  }

  if (po) {
    // PO-linked lays for this order + legacy unlinked lays for the same FG only.
    const cutRow = db.prepare(`
      SELECT COALESCE(SUM(l.actual_meters),0) AS s
      FROM cutting_lays l
      WHERE l.fabric_product_id=?
        AND COALESCE(l.status,'posted') <> 'reversed'
        AND (
          l.production_order_id = ?
          OR (l.production_order_id IS NULL AND l.product_id = ?)
        )
    `).get(Number(productId), Number(po.id), Number(po.product_id));
    cutMeters = Number(cutRow && cutRow.s) || 0;
    out.cut_scope = 'order_or_fg';
    out.cut_fg_product_id = Number(po.product_id);
  } else {
    // No order context — keep legacy fabric-SKU sum (batch guard still applies).
    const cutRow = db.prepare(`
      SELECT COALESCE(SUM(l.actual_meters),0) AS s
      FROM cutting_lays l
      WHERE l.fabric_product_id=?
        AND COALESCE(l.status,'posted') <> 'reversed'
    `).get(Number(productId));
    cutMeters = Number(cutRow && cutRow.s) || 0;
    out.cut_scope = 'fabric_sku_global';
  }

  out.cut_meters = cutMeters;
  if (cutMeters <= 0) return out;

  let stdQty = 0;
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
  const issuedRow = orderId
    ? db.prepare(`
        SELECT COALESCE(SUM(qty_actual),0) AS s
        FROM production_material_issues
        WHERE order_id=? AND product_id=? AND status='posted' AND qty_actual > 0
      `).get(Number(orderId), Number(productId))
    : { s: 0 };
  const alreadyIssued = Number(issuedRow && issuedRow.s) || 0;
  const allowed = Math.max(0, round6(stdQty - cutMeters));
  out.std_qty = stdQty;
  out.already_issued = alreadyIssued;
  out.allowed = allowed;
  out.remaining = Math.max(0, round6(allowed - alreadyIssued));
  return out;
}

/**
 * Block PO issue/backflush of fabric already consumed by a posted cutting lay
 * for this order/FG. Same physical roll (batch) cannot be re-issued regardless
 * of order. Remaining unused BOM meters (std − cut_scoped) may still be issued
 * from other rolls / other orders.
 */
function assertFabricIssueAllowed(db, { productId, qty, batchId, orderId } = {}) {
  const AQ = Number(qty) || 0;
  if (!(AQ > 0) || !productId) return;
  const lengthProd = db.prepare('SELECT id, name, unit, unit_id FROM products WHERE id=?').get(Number(productId));
  if (lengthProd && isRollFabricProduct(db, lengthProd)) {
    throw httpErr(
      409,
      `«${lengthProd.name}» پارچهٔ طاقه‌ای است (${rollFabricUnitLabel(db, lengthProd)}). مصرفش فقط با لایه‌چینی و طاقه است، نه حوالهٔ مرحله یا رسید مستقیم سفارش.`,
      'E_FABRIC_VIA_CUT',
      { product_id: Number(productId), unit: lengthProd.unit }
    );
  }
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
  const allow = fabricIssueAllowance(db, { productId, orderId });
  if (allow.allowed == null) return;
  if (allow.already_issued + AQ > allow.allowed + 1e-9) {
    throw httpErr(409, 'این متر پارچه در لایه‌چینی مصرف شده است', 'E_FABRIC_ALREADY_CUT', {
      product_id: Number(productId),
      cut_meters: allow.cut_meters,
      cut_scope: allow.cut_scope,
      cut_fg_product_id: allow.cut_fg_product_id,
      allowed: allow.allowed,
      remaining: allow.remaining,
    });
  }
}

function isMeterUnit(unit) {
  // یارد همان پارچهٔ طولی است؛ موجودی در واحد خود کالا می‌ماند و به متر تبدیل نمی‌شود.
  return require('../uom').isLengthText(unit);
}

/** بعد واحد انبار کالا؛ بدون کاتالوگ واحدها از نام واحد. */
function stockUnitDimension(db, prod) {
  const uom = require('../uom');
  let row = null;
  try { row = uom.stockUnitForProduct(db, prod); } catch (_) { row = null; }
  if (row && row.dimension) return row.dimension;
  const k = String(prod.unit || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!k) return '';
  const spec = uom.SPECS.find((s) => s.aliases.some((a) => a.replace(/\s+/g, '') === k));
  return spec ? spec.dimension : '';
}

/** کالا در BOM فعال به عملیات مرکز برش وصل است (همان شناسهٔ posting.resolveCuttingCostCenterId). */
function onActiveBomCuttingOperation(db, productId) {
  try {
    return !!db.prepare(`
      SELECT 1
      FROM bom_lines bl
      JOIN bom_headers bh ON bh.id = bl.bom_id
      JOIN bom_material_assignments ma ON ma.bom_line_id = bl.id
      JOIN bom_operations o ON o.id = ma.operation_id
      JOIN cost_centers cc ON cc.id = o.cost_center_id
      WHERE bl.component_product_id=? AND bh.deleted_at IS NULL AND bh.status='active'
        AND (cc.code='CC-10' OR cc.name='برش')
      LIMIT 1
    `).get(Number(productId));
  } catch {
    return false;
  }
}

/**
 * پارچهٔ طاقه‌ای = مصرف فقط از لایه‌چینی.
 * واحد کالا طولی باشد، یا طاقه (kind=fabric) داشته باشد — به هر واحدی (متر، یارد، کیلوگرم، مترمربع)،
 * یا واحد وزنی/مساحتی داشته باشد و در BOM فعال به عملیات برش وصل باشد (پیش از ورود اولین طاقه).
 * لایه‌چینی به واحد همان طاقه حساب می‌شود (lay-unit.js).
 */
function isRollFabricProduct(db, productOrId) {
  const uom = require('../uom');
  const prod = productOrId && typeof productOrId === 'object'
    ? productOrId
    : db.prepare('SELECT id, unit, unit_id FROM products WHERE id=?').get(Number(productOrId));
  if (!prod) return false;
  if (uom.isLengthProduct(db, prod)) return true;
  if (!prod.id) return false;
  try {
    const row = db.prepare(`
      SELECT 1 FROM inventory_batches
      WHERE product_id=? AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'active') <> 'reversed'
      LIMIT 1
    `).get(Number(prod.id));
    if (row) return true;
  } catch { /* no batches table */ }
  if (!['mass', 'area'].includes(stockUnitDimension(db, prod))) return false;
  return onActiveBomCuttingOperation(db, prod.id);
}

/** برچسب واحد برای پیام — P9: همیشه واحد خود کالا (مقدار طاقه‌ها به واحد کالاست). */
function rollFabricUnitLabel(db, prod) {
  if (!prod) return 'متر';
  let name = '';
  try { name = require('../uom').productRollUnit(db, prod).name; } catch (_) { name = ''; }
  name = name || String(prod.unit || '').trim();
  try {
    if (prod.id) {
      const b = db.prepare(`
        SELECT unit FROM inventory_batches
        WHERE product_id=? AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'active') <> 'reversed'
        ORDER BY id DESC LIMIT 1
      `).get(Number(prod.id));
      if (b) {
        if (!name) {
          const row = require('./lay-unit').unitRowForToken(db, b.unit);
          name = row ? row.name : (b.unit || '');
        }
        return `${name || 'متر'} طاقه`;
      }
    }
  } catch (_) { /* fall through */ }
  return name || 'متر';
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
    if (isRollFabricProduct(db, L.product_id)) score += 8;
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
  const layUnit = resolveLayUnit(db, {
    fabricProductId: body.fabric_product_id,
    batchIds: (Array.isArray(body.rolls) ? body.rolls : []).map((r) => r && r.batch_id),
    markerFactor: body.marker_factor,
    widthCm: body.width_cm,
  });
  const planned = round6(markerToUnit(layUnit, marker) * plies);
  const actual = body.actual_meters != null ? Number(body.actual_meters) : planned;
  if (!(actual > 0) || !Number.isFinite(actual)) {
    throw httpErr(400, `مصرف واقعی (${layUnit.unit_name}) نامعتبر است`, 'E_CUT_ACTUAL');
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
    qty_unit: layUnit.qty_unit,
    unit_name: layUnit.unit_name,
    marker_unit: layUnit.marker_unit,
    marker_factor: layUnit.marker_factor,
    lay_unit: layUnit,
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

/**
 * Lay pieces already entered sellable FG via production_receipt on a linked
 * (or uniquely matching closed) order — PACK CTA must not re-offer FG.
 */
function layFgCoveredByOrder(db, lay) {
  const out = {
    fg_covered_by_order: 0,
    covered_order_id: null,
    covered_order_no: null,
    covered_receipt_qty: 0,
    covered_attribution: null,
  };
  if (!lay || String(lay.status || '') === 'reversed') return out;
  const loadPo = (id) => db.prepare(`
    SELECT id, order_no, status, qty_produced, product_id
    FROM production_orders WHERE id=?
  `).get(Number(id));
  let po = null;
  let attribution = null;
  if (lay.production_order_id) {
    po = loadPo(lay.production_order_id);
    attribution = 'linked';
  }
  if (!po && lay.fg_delta_order_id) {
    // An earlier covered edit/void already recorded which order absorbed this lay.
    po = loadPo(lay.fg_delta_order_id);
    attribution = 'recorded';
  }
  if (!po && lay.product_id) {
    // Legacy unlinked lays: exactly one completed/closed order for this same FG
    // whose posted receipts cover the lay qty and are not dated before the lay.
    const candidates = db.prepare(`
      SELECT id, order_no, status, qty_produced, product_id
      FROM production_orders
      WHERE product_id=? AND status IN ('completed','closed')
      ORDER BY id DESC
    `).all(Number(lay.product_id));
    if (candidates.length === 1) {
      const c = candidates[0];
      const recs = db.prepare(`
        SELECT qty, date FROM production_receipts WHERE order_id=? AND status='posted'
      `).all(Number(c.id));
      const recQty = recs.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const { dateKey } = require('./receipt-date-guard');
      const layKey = dateKey(lay.date);
      const lastRecKey = recs.reduce((m, r) => (dateKey(r.date) > m ? dateKey(r.date) : m), '');
      const need = Number(lay.qty_pieces) || 0;
      if (Number(c.product_id) === Number(lay.product_id)
        && recQty + 1e-9 >= need
        && (!layKey || !lastRecKey || lastRecKey >= layKey)) {
        po = c;
        attribution = 'guess';
      }
    }
  }
  if (!po || !['completed', 'closed', 'done'].includes(String(po.status || ''))) return out;
  const rec = db.prepare(`
    SELECT COALESCE(SUM(qty),0) AS s FROM production_receipts
    WHERE order_id=? AND status='posted'
  `).get(Number(po.id));
  const receiptQty = Number(rec && rec.s) || 0;
  const need = Number(lay.qty_pieces) || 0;
  if (!(receiptQty + 1e-9 >= need) && !(Number(po.qty_produced) + 1e-9 >= need)) return out;
  out.fg_covered_by_order = 1;
  out.covered_order_id = Number(po.id);
  out.covered_order_no = po.order_no || null;
  out.covered_receipt_qty = receiptQty;
  out.covered_attribution = attribution;
  return out;
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
    row.has_live_pack = pack ? 1 : 0;
    row.pack_posted = pack ? 1 : 0;
    row.pack_no = pack ? pack.pack_no : null;
    Object.assign(row, layFgCoveredByOrder(db, row));
    // Covered-by-order counts as "done" for pending-pack queues (F06 already posted).
    // pack_via_order_fg فقط وقتی پوشش سفارش هست و PACK انبار زنده نیست — تا UI ابطال PACK را مخفی نکند.
    if (row.fg_covered_by_order && !row.has_live_pack) {
      row.pack_posted = 1;
      row.pack_via_order_fg = 1;
    } else {
      row.pack_via_order_fg = 0;
    }
    if (row.batch_id) {
      const outs = db.prepare(`
        SELECT o.product_id, o.size_code, o.pieces_per_ply, o.planned_pieces, o.weight_pct, p.name AS product_name
        FROM cutting_batch_outputs o
        LEFT JOIN products p ON p.id = o.product_id
        WHERE o.batch_id=?
        ORDER BY o.product_id, o.size_code
      `).all(row.batch_id);
      row.shared_outputs = outs;
      row.shared_product_names = [...new Set(outs.map((o) => o.product_name || ('#' + o.product_id)))];
      row.is_shared_cut = 1;
    } else {
      row.shared_outputs = [];
      row.shared_product_names = [];
      row.is_shared_cut = 0;
    }
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
  if (row.stage_id) {
    const st = db.prepare(`
      SELECT id, seq, status, operation_name, cost_center_id FROM production_order_stages WHERE id=?
    `).get(row.stage_id);
    if (st) {
      row.stage_seq = st.seq;
      row.stage_status = st.status;
      row.stage_operation_name = st.operation_name || 'برش';
    }
  }
  const covered = layFgCoveredByOrder(db, row);
  Object.assign(row, covered);
  const livePack = postedPackForLay(db, row.id);
  row.has_live_pack = livePack ? 1 : 0;
  if (livePack) {
    row.pack_posted = 1;
    row.pack_no = livePack.pack_no;
    row.pack_via_order_fg = 0;
  } else if (covered.fg_covered_by_order) {
    row.pack_posted = 1;
    row.pack_via_order_fg = 1;
  } else {
    row.pack_via_order_fg = 0;
  }
  if (row.batch_id) {
    row.shared_outputs = db.prepare(`
      SELECT o.product_id, o.size_code, o.pieces_per_ply, o.planned_pieces, o.weight_pct, p.name AS product_name
      FROM cutting_batch_outputs o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE o.batch_id=?
      ORDER BY o.product_id, o.size_code
    `).all(row.batch_id);
    row.is_shared_cut = 1;
  } else {
    row.shared_outputs = [];
    row.is_shared_cut = 0;
  }
  return attachPacks(db, row);
}

function postCuttingLay(db, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_CUT_IDEMPOTENCY');
  const existing = db.prepare('SELECT * FROM cutting_lays WHERE idempotency_key=?').get(key);
  if (existing) return getCuttingLay(db, existing.id);

  const plan = planCutting(db, body);
  const { prepared, wh } = prepareCuttingLayRolls(db, body, plan);
  const amount = assertSafeRial(prepared.reduce((s, r) => s + r.amount_rial, 0), 'cut amount');
  const unitCost = plan.actual_meters > 0 ? Math.round(amount / plan.actual_meters) : 0;
  let wasteAmt = assertSafeRial(Math.round(plan.waste_abnormal_m * unitCost), 'cut waste');
  if (wasteAmt > amount) wasteAmt = amount;
  const date = String(body.date || todayJalali()).trim();
  assertCutPeriodOpen(db, date);
  let color = String(body.color || '').trim();
  const widthCm = Math.round(Number(body.width_cm) || 0);
  const po = resolveOptionalOrder(db, body.production_order_id, plan.product.id);
  if (po && po.color) {
    const { colorsMatch } = require('../inventory/fabric-rolls');
    if (!color) color = String(po.color).trim();
    else if (!colorsMatch(po.color, color)) {
      throw httpErr(400, 'رنگ برش باید با رنگ سفارش تولید یکی باشد', 'E_CUT_PO_COLOR', {
        po_color: po.color, lay_color: color,
      });
    }
  }
  if (!color) {
    throw httpErr(400, 'رنگ برش الزامی است — از رنگ طاقه/سفارش انتخاب کنید', 'E_CUT_COLOR_REQUIRED');
  }
  assertCuttingLayColorWidth(db, prepared, color, widthCm);
  const costCenterId = resolveCuttingCostCenterId(db, {
    explicitId: body.cost_center_id,
    bomId: plan.bom_id,
    warehouseId: wh.id,
  });

  let layId;
  let stageBind = null;
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
          production_order_id, cost_center_id, qty_unit, marker_unit, marker_factor
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?,?)
      `).run(
        layNo, plan.product.id, plan.bom_id, wh.id, plan.fabric_product_id, color,
        plan.marker_length_m, plan.ply_count, widthCm, plan.planned_meters, plan.actual_meters, plan.matrix_meters,
        JSON.stringify(plan.size_breakdown), JSON.stringify(plan.size_matrix), plan.qty_pieces,
        plan.waste_normal_m, plan.waste_abnormal_m, plan.waste_allowed_m,
        unitCost, amount, wasteAmt, key, date, String(body.note || '').trim(), user.id,
        po ? po.id : null, costCenterId, plan.qty_unit, plan.marker_unit, plan.marker_factor
      );
      const id = ins.lastInsertRowid;
      postCuttingLayStockAndJe(db, {
        id, layNo, prepared, wh, plan, amount, wasteAmt, unitCost, date, user,
        costCenterId,
      });
      if (po) {
        stageBind = bindCuttingLayToOrderStage(db, {
          orderId: po.id,
          layId: id,
          layNo,
          fabricProductId: plan.fabric_product_id,
          amountRial: amount,
          wasteAmountRial: wasteAmt,
          qtyPieces: plan.qty_pieces,
          meters: plan.actual_meters,
          date,
          userId: user.id,
        });
      }
      return id;
    })();
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(String(e.message)))) {
      const again = db.prepare('SELECT id FROM cutting_lays WHERE idempotency_key=?').get(key);
      if (again) return getCuttingLay(db, again.id);
    }
    throw e;
  }
  const lay = getCuttingLay(db, layId);
  if (stageBind) lay.stage_bind = stageBind;
  return lay;
}

/** v410 — اتصال لایه‌چینی به مرحلهٔ برش سفارش پیشرفته (lazy require ضد حلقه) */
function bindCuttingLayToOrderStage(db, opts) {
  const { applyCuttingLayToStage } = require('./engine-advanced');
  return applyCuttingLayToStage(db, opts);
}

function unbindCuttingLayFromOrderStage(db, row, user, date) {
  if (!row || !row.production_order_id) return { ok: false, skipped: true };
  const { unlinkCuttingLayFromStage } = require('./engine-advanced');
  return unlinkCuttingLayFromStage(db, {
    orderId: row.production_order_id,
    layId: row.id,
    layNo: row.lay_no,
    amountRial: row.amount_rial,
    wasteAmountRial: row.waste_amount_rial,
    userId: user.id,
    date: date || row.date,
  });
}

/**
 * R13 — reverse all create-side effects of a posted cutting lay
 * (inventory + batch qty + JE) without deleting the header row.
 * Caller decides whether to mark status=reversed (void) or re-post (amend).
 */
function reverseCuttingLayEffects(db, row, user, reason) {
  const { reverseJournalEntry } = require('../void-journal');
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
      sourceType: 'production_waste_reversal',
    });
  }
  if (row.journal_id) {
    revJe = reverseJournalEntry(db, row.journal_id, {
      userId: user.id,
      reason: reason || 'ابطال لایه‌چینی',
      sourceType: 'production_material_issue_reversal',
    });
  }
  db.prepare('UPDATE cutting_lays SET journal_id=NULL, waste_journal_id=NULL WHERE id=?').run(row.id);
  return { revJe };
}

/**
 * Validate + cost rolls for create/amend. Call AFTER any reverse so live
 * meters include restored qty from this lay.
 */
function prepareCuttingLayRolls(db, body, plan) {
  const rollsIn = Array.isArray(body.rolls) ? body.rolls : [];
  if (!rollsIn.length) throw httpErr(400, 'حداقل یک طاقه انتخاب کنید', 'E_CUT_ROLLS');

  let rollSum = 0;
  const prepared = [];
  const rollWarehouseIds = [];
  for (const r of rollsIn) {
    const batchId = Number(r.batch_id);
    const meters = Number(r.meters);
    if (!batchId || !(meters > 0)) throw httpErr(400, `طاقه یا مقدار (${plan.unit_name || 'متر'}) نامعتبر است`, 'E_CUT_ROLL');
    const batch = db.prepare("SELECT * FROM inventory_batches WHERE id=? AND COALESCE(kind,'generic')='fabric'").get(batchId);
    if (!batch) throw httpErr(400, 'طاقه پارچه یافت نشد', 'E_CUT_ROLL');
    if (batch.status === 'reversed' || batch.status === 'empty') {
      throw httpErr(409, 'این طاقه قابل مصرف نیست', 'E_CUT_ROLL_STATUS');
    }
    if (Number(batch.warehouse_id)) rollWarehouseIds.push(Number(batch.warehouse_id));
    prepared.push({ batch, meters: round6(meters), _metersIn: meters });
  }

  const wh = requireRawWarehouse(db, body.warehouse_id, rollWarehouseIds);

  for (const item of prepared) {
    const batch = item.batch;
    const meters = item._metersIn;
    if (Number(batch.warehouse_id) && Number(batch.warehouse_id) !== Number(wh.id)) {
      throw httpErr(400, 'طاقه باید در انبار مواد باشد', 'E_CUT_ROLL_WH');
    }
    applyLiveRollQty(db, batch);
    const avail = availableBatchMeters(db, batch.id);
    if (avail + 1e-9 < meters) {
      throw httpErr(409, `مانده طاقه (${plan.unit_name || 'متر'}) کافی نیست`, 'E_CUT_ROLL_QTY', {
        batch_no: batch.batch_no,
        available: avail,
        needed: meters,
      });
    }
    if (plan.fabric_product_id && Number(batch.product_id) !== Number(plan.fabric_product_id)) {
      throw httpErr(400, 'طاقه باید همان پارچهٔ فرمول باشد', 'E_CUT_ROLL_PRODUCT');
    }
    rollSum = round6(rollSum + meters);
    const unit = Math.round(Number(batch.unit_cost_rial) || 0);
    item.meters = round6(meters);
    item.unit_cost_rial = unit;
    item.amount_rial = assertSafeRial(Math.round(unit * meters), 'cut roll');
    delete item._metersIn;
  }
  {
    const seen = new Set();
    for (const item of prepared) {
      const k = `${item.batch.product_id}:${wh.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      syncFabricProductWarehouse(db, item.batch.product_id, wh.id);
    }
  }
  if (Math.abs(rollSum - plan.actual_meters) > 0.01) {
    throw httpErr(400, `جمع مصرف طاقه‌ها (${plan.unit_name || 'متر'}) باید با مصرف واقعی برابر باشد`, 'E_CUT_ROLL_SUM', {
      rolls: rollSum, actual: plan.actual_meters,
    });
  }
  return { prepared, wh, rollSum };
}

function assertCuttingLayColorWidth(db, prepared, color, widthCm) {
  const { colorsMatch } = require('../inventory/fabric-rolls');
  for (const item of prepared) {
    const batch = item.batch;
    if (!colorsMatch(batch.color, color)) {
      throw httpErr(400, 'طاقه باید همان رنگ برش/سفارش باشد', 'E_CUT_ROLL_COLOR', {
        batch_no: batch.batch_no, roll_color: batch.color, lay_color: color,
      });
    }
    const rollW = Math.round(Number(batch.width_cm) || 0);
    if (widthCm > 0 && rollW > 0 && rollW !== widthCm) {
      throw httpErr(400, 'عرض طاقه با عرض لایه‌چینی یکی نیست', 'E_CUT_ROLL_WIDTH', {
        batch_no: batch.batch_no, roll_width: rollW, lay_width: widthCm,
      });
    }
  }
}

function postCuttingLayStockAndJe(db, {
  id, layNo, prepared, wh, plan, amount, wasteAmt, unitCost, date, user, costCenterId,
}) {
  assertJournalIdempotent(db, 'production_material_issue', id);
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
    const je = postEvent(db, {
      event: 'PRD-01',
      sourceId: id,
      date,
      description: `مصرف پارچه لایه‌چینی ${layNo}`,
      createdBy: user.id,
      costCenterId: costCenterId || null,
      warehouseId: wh && wh.id,
      lines: [
        dr(db, 'coa_wip', amount),
        cr(db, 'coa_raw_materials', amount),
      ],
    });
    journalId = je ? je.je_id : null;
  }
  let wasteJe = null;
  if (plan.waste_abnormal_m > 0 && wasteAmt > 0) {
    assertJournalIdempotent(db, 'production_waste', id);
    const wje = postEvent(db, {
      event: 'PRD-09',
      sourceId: id,
      date,
      description: `ضایعات غیرعادی برش ${layNo} — ${plan.waste_abnormal_m} ${plan.unit_name || 'متر'}`,
      createdBy: user.id,
      costCenterId: costCenterId || null,
      warehouseId: wh && wh.id,
      lines: [
        dr(db, 'coa_abnormal_waste', wasteAmt),
        cr(db, 'coa_wip', wasteAmt),
      ],
    });
    wasteJe = wje ? wje.je_id : null;
  }
  db.prepare('UPDATE cutting_lays SET journal_id=?, waste_journal_id=? WHERE id=?')
    .run(journalId, wasteJe, id);
}

function layIssueNoteMatchers(layNo, layId) {
  const tag = layNo || ('#' + layId);
  return [`*${tag}[^0-9]*`, `*${tag}`];
}

function voidCuttingLay(db, id, user, { reason } = {}) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'این لایه قبلاً ابطال شده است', 'E_CUT_REVERSED');
  // برش مشترک (چندمحصول روی یک مارکر): PACKهای WIP داخل همان برنامه است — ابطال از موتور shared-cut.
  if (row.batch_id) {
    const { voidSharedCut } = require('./shared-cut');
    voidSharedCut(db, row.batch_id, user, reason || 'ابطال لایه‌چینی چندمحصولی');
    return getCuttingLay(db, row.id);
  }
  if (postedPackForLay(db, row.id)) {
    throw httpErr(409, 'ابتدا رسید برش (PACK) را ابطال کنید؛ بعد خود لایه‌چینی ابطال می‌شود', 'E_CUT_HAS_PACK');
  }
  const covered = layFgCoveredByOrder(db, row);
  db.transaction(() => {
    let po = null;
    if (covered.fg_covered_by_order) {
      const oid = Number(row.production_order_id || covered.covered_order_id || 0);
      po = oid ? db.prepare('SELECT * FROM production_orders WHERE id=?').get(oid) : null;
      if (!po) throw httpErr(409, 'سفارش پوشش‌دهندهٔ این لایه پیدا نشد', 'E_CUT_NO_RECEIPT');
      if (['cancelled', 'voided'].includes(String(po.status || ''))) {
        throw httpErr(409, 'سفارش تولید لغو شده است', 'E_PACK_ORDER_STATUS');
      }
    } else {
      unbindCuttingLayFromOrderStage(db, row, user, row.date);
    }
    const { revJe } = reverseCuttingLayEffects(db, row, user, reason || 'ابطال لایه‌چینی');
    if (po) {
      absorbCoveredLayDelta(db, {
        lay: row,
        po,
        oldAmount: Math.round(Number(row.amount_rial) || 0),
        oldWaste: Math.round(Number(row.waste_amount_rial) || 0),
        newAmount: 0,
        newWaste: 0,
        newMeters: 0,
        newUnit: 0,
        date: row.date || todayJalali(),
        user,
      });
      const [globMid, globEnd] = layIssueNoteMatchers(row.lay_no, row.id);
      db.prepare(`
        UPDATE production_material_issues SET status='reversed'
        WHERE order_id=? AND issue_type='cutting_lay' AND status='posted'
          AND (note GLOB ? OR note GLOB ?)
      `).run(po.id, globMid, globEnd);
    }
    db.prepare(`
      UPDATE cutting_lays
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?, stage_id=NULL
      WHERE id=?
    `).run(user.id, revJe, row.id);
  })();
  return getCuttingLay(db, row.id);
}

/**
 * After the order FG receipt, a lay edit must not reopen the stage chain.
 * Fabric and the lay JE still reverse-and-repost. The net WIP delta moves
 * onto the posted receipt (remaining stock → FG value, sold portion → COGS)
 * so the order stays completed and WIP residual does not grow.
 */
function absorbCoveredLayDelta(db, {
  lay, po, oldAmount, oldWaste, newAmount, newWaste, newMeters, newUnit, date, user,
}) {
  const deltaGross = Math.round(Number(newAmount) - Number(oldAmount));
  const deltaWaste = Math.round(Number(newWaste) - Number(oldWaste));
  const oldNet = Math.max(0, Math.round(Number(oldAmount)) - Math.round(Number(oldWaste)));
  const newNet = Math.max(0, Math.round(Number(newAmount)) - Math.round(Number(newWaste)));
  const deltaNet = newNet - oldNet;
  const layTag = lay.lay_no || ('#' + lay.id);
  // R13: every fg_delta JE/value row of this lay belongs to po — reverseOrder finds them through this link.
  db.prepare('UPDATE cutting_lays SET fg_delta_order_id=? WHERE id=?').run(Number(po.id), lay.id);

  const [globMid, globEnd] = layIssueNoteMatchers(lay.lay_no, lay.id);
  const mi = db.prepare(`
    SELECT id FROM production_material_issues
    WHERE order_id=? AND issue_type='cutting_lay' AND status='posted'
      AND (note GLOB ? OR note GLOB ?)
    ORDER BY id DESC LIMIT 1
  `).get(po.id, globMid, globEnd);
  if (mi) {
    db.prepare(`
      UPDATE production_material_issues SET
        qty_standard=?, qty_actual=?, unit_cost_rial=?, std_cost_rial=?,
        amount_rial=?, std_amount_rial=?
      WHERE id=?
    `).run(newMeters, newMeters, newUnit, newUnit, newAmount, newAmount, mi.id);
  }

  if (deltaGross || deltaWaste) {
    db.prepare(`
      UPDATE production_orders SET
        material_cost_rial = COALESCE(material_cost_rial,0) + ?,
        abnormal_waste_rial = COALESCE(abnormal_waste_rial,0) + ?,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(deltaGross, deltaWaste, po.id);
  }

  if (lay.stage_id && (deltaGross || deltaWaste || deltaNet)) {
    db.prepare(`
      UPDATE production_order_stages SET
        material_added_rial = COALESCE(material_added_rial,0) + ?,
        waste_abnormal_rial = COALESCE(waste_abnormal_rial,0) + ?,
        cost_out_rial = COALESCE(cost_out_rial,0) + ?
      WHERE id=?
    `).run(deltaGross, deltaWaste, deltaNet, lay.stage_id);
    const stage = db.prepare('SELECT seq, order_id FROM production_order_stages WHERE id=?').get(lay.stage_id);
    if (stage && deltaNet) {
      const later = db.prepare(`
        SELECT id FROM production_order_stages WHERE order_id=? AND seq>? ORDER BY seq
      `).all(stage.order_id, stage.seq);
      for (const s of later) {
        db.prepare(`
          UPDATE production_order_stages SET
            material_in_rial = COALESCE(material_in_rial,0) + ?,
            cost_out_rial = COALESCE(cost_out_rial,0) + ?
          WHERE id=?
        `).run(deltaNet, deltaNet, s.id);
      }
    }
  }

  const { routeReceiptValueChange } = require('./order-cost-reconcile');
  const { postToLedger } = require('../ledger');
  const valueSrc = {
    sourceType: 'cutting_lay_fg_delta',
    sourceId: lay.id,
    label: `تعدیل بهای لایه‌چینی ${layTag}`,
    date,
    userId: user.id,
    eventNote: `تعدیل بهای لایه‌چینی ${layTag} — ${po.order_no || ''}`,
  };
  if (!deltaNet) {
    // An earlier delta of this lay may still sit in an approval doc: re-route it (R13).
    const routed = routeReceiptValueChange(db, { ...valueSrc, shares: [] });
    if (routed.lines.length) {
      postToLedger(db, {
        sourceType: 'cutting_lay_fg_delta',
        sourceId: lay.id,
        srcDocNo: po.order_no || null,
        date,
        description: `تعدیل بهای محصول پس از ویرایش ${layTag} — ${po.order_no || ''}`,
        createdBy: user.id,
        costCenterId: lay.cost_center_id || null,
        lines: routed.lines,
      });
    }
    return { delta_net_rial: 0, value_approval_id: routed.approval ? routed.approval.id : null };
  }

  const receipts = db.prepare(`
    SELECT * FROM production_receipts
    WHERE order_id=? AND status='posted' AND COALESCE(amount_rial,0) > 0
    ORDER BY id
  `).all(po.id);
  if (!receipts.length) {
    throw httpErr(409, 'رسید سفارش برای انتقال اختلاف بهای لایه‌چینی پیدا نشد', 'E_CUT_NO_RECEIPT');
  }
  const totalAmt = receipts.reduce((s, r) => s + Math.round(Number(r.amount_rial) || 0), 0);
  if (!(totalAmt > 0)) {
    throw httpErr(409, 'مبلغ رسید سفارش صفر است', 'E_CUT_NO_RECEIPT');
  }

  let assigned = 0;
  const shares = receipts.map((receipt, i) => {
    const part = i === receipts.length - 1
      ? deltaNet - assigned
      : Math.round(deltaNet * (Math.round(Number(receipt.amount_rial) || 0) / totalAmt));
    assigned += part;
    return { receipt, share: part };
  });
  for (const { receipt, share } of shares) {
    const nextAmt = Math.round(Number(receipt.amount_rial) || 0) + share;
    if (nextAmt < 0) {
      throw httpErr(409, 'اختلاف بها از مبلغ رسید سفارش بیشتر است', 'E_CUT_DELTA_EXCEEDS_RECEIPT');
    }
  }

  for (const { receipt, share } of shares) {
    if (!share) continue;
    const nextAmt = Math.round(Number(receipt.amount_rial) || 0) + share;
    const qty = Number(receipt.qty) || 0;
    const nextUnit = qty > 0 ? Math.round(nextAmt / qty) : Math.round(Number(receipt.unit_cost_rial) || 0);
    db.prepare('UPDATE production_receipts SET amount_rial=?, unit_cost_rial=? WHERE id=?')
      .run(nextAmt, nextUnit, receipt.id);
  }
  // Value side: open month → FG value row + COGS; closed inventory month → clearing + approval.
  const routed = routeReceiptValueChange(db, { ...valueSrc, shares });
  const lines = routed.lines.slice();
  if (deltaNet > 0) lines.push(cr(db, 'coa_wip', deltaNet, po.coa_wip_tafsili || null));
  else lines.push(dr(db, 'coa_wip', -deltaNet, po.coa_wip_tafsili || null));

  postToLedger(db, {
    sourceType: 'cutting_lay_fg_delta',
    sourceId: lay.id,
    srcDocNo: po.order_no || null,
    date,
    description: `تعدیل بهای محصول پس از ویرایش ${layTag} — ${po.order_no || ''}`,
    createdBy: user.id,
    costCenterId: lay.cost_center_id || null,
    lines,
  });

  const sum = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) AS s FROM production_receipts
    WHERE order_id=? AND status='posted'
  `).get(po.id);
  const header = db.prepare(`
    SELECT amount_rial, qty FROM production_receipts
    WHERE order_id=? AND product_id=? AND status='posted'
    ORDER BY id DESC LIMIT 1
  `).get(po.id, po.product_id) || db.prepare(`
    SELECT amount_rial, qty FROM production_receipts
    WHERE order_id=? AND status='posted' ORDER BY id DESC LIMIT 1
  `).get(po.id);
  const unit = header && Number(header.qty) > 0
    ? Math.round(Number(header.amount_rial) / Number(header.qty))
    : 0;
  require('./order-cost-reconcile').applyDocumentCosts(db, po.id);
  db.prepare('UPDATE production_orders SET total_cost_rial=?, unit_cost_rial=? WHERE id=?')
    .run(Math.round(Number(sum && sum.s) || 0), unit, po.id);
  return { delta_net_rial: deltaNet, value_approval_id: routed.approval ? routed.approval.id : null };
}

function liveFgDeltaJeIds(db, layId) {
  return db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='cutting_lay_fg_delta' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'') NOT IN ('reversed','void')
    ORDER BY id DESC
  `).all(Number(layId)).map((r) => r.id);
}

function liveFgDeltaLedgerIds(db, layId) {
  return db.prepare(`
    SELECT id FROM inventory_ledger
    WHERE source_type='cutting_lay_fg_delta' AND source_id=?
      AND status='posted' AND reversed_of IS NULL
    ORDER BY id DESC
  `).all(Number(layId)).map((r) => r.id);
}

/**
 * Lays whose fg_delta belongs to this order. Rows written before the link column
 * are attributed only when safe: the lay is linked to the order, or it is unlinked,
 * of the same FG, and this is the only order of that FG that ever posted a receipt.
 */
function fgDeltaLaysForOrder(db, po) {
  const lays = db.prepare('SELECT * FROM cutting_lays WHERE fg_delta_order_id=?').all(Number(po.id));
  const seen = new Set(lays.map((l) => l.id));
  const legacy = db.prepare(`
    SELECT DISTINCT l.* FROM cutting_lays l
    WHERE l.fg_delta_order_id IS NULL
      AND (l.production_order_id=? OR (l.production_order_id IS NULL AND l.product_id=?))
      AND (
        EXISTS (SELECT 1 FROM journal_entries je WHERE je.ref_type='cutting_lay_fg_delta' AND je.ref_id=l.id)
        OR EXISTS (SELECT 1 FROM inventory_ledger il WHERE il.source_type='cutting_lay_fg_delta' AND il.source_id=l.id)
      )
  `).all(Number(po.id), Number(po.product_id || 0));
  let soleOrderOfProduct = null;
  for (const lay of legacy) {
    if (seen.has(lay.id)) continue;
    let mine = Number(lay.production_order_id) === Number(po.id);
    if (!mine) {
      if (soleOrderOfProduct === null) {
        const ords = db.prepare(`
          SELECT DISTINCT o.id FROM production_orders o
          JOIN production_receipts r ON r.order_id=o.id
          WHERE o.product_id=?
        `).all(Number(po.product_id || 0));
        soleOrderOfProduct = ords.length === 1 && Number(ords[0].id) === Number(po.id);
      }
      mine = soleOrderOfProduct;
    }
    if (!mine) continue;
    db.prepare('UPDATE cutting_lays SET fg_delta_order_id=? WHERE id=?').run(Number(po.id), lay.id);
    seen.add(lay.id);
    lays.push(lay);
  }
  return lays;
}

/**
 * R13 — voiding an order receipt also voids the covered-lay value deltas it absorbed:
 * the cutting_lay_fg_delta JEs, their value-only FG ledger rows and any value-approval docs.
 * Idempotent: rows already reversed are skipped. Runs inside the caller's transaction.
 */
function reverseOrderFgDeltas(db, { orderId, userId, reason = '', date } = {}) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) return { lays: 0, journals: 0, ledger_rows: 0 };
  const why = reason || `ابطال رسید ${po.order_no || ''}`;
  const when = date || todayJalali();
  const { reverseJournalEntry } = require('../void-journal');
  const { reverseInventoryMovement, softRetireLedgerRow } = require('../inventory/ledger');
  const VAP = require('../inventory/value-approval');
  let journals = 0;
  let ledgerRows = 0;
  const lays = fgDeltaLaysForOrder(db, po);
  for (const lay of lays) {
    VAP.cancelForSource(db, 'cutting_lay_fg_delta', lay.id, { id: userId }, why);
    for (const ledId of liveFgDeltaLedgerIds(db, lay.id)) {
      const note = `ابطال تعدیل بهای لایه‌چینی ${lay.lay_no || ('#' + lay.id)} — ${po.order_no || ''}`;
      const rev = reverseInventoryMovement(db, ledId, { createdBy: userId || null, date: when, note });
      if (rev && rev.id) softRetireLedgerRow(db, rev.id, { note });
      ledgerRows += 1;
    }
    for (const jeId of liveFgDeltaJeIds(db, lay.id)) {
      reverseJournalEntry(db, jeId, {
        userId, date: when, reason: why, sourceType: 'cutting_lay_fg_delta_reversal',
      });
      journals += 1;
    }
  }
  return { lays: lays.length, journals, ledger_rows: ledgerRows };
}

/**
 * R13 Edit ⇒ reverse all create effects, then re-post on the same lay_no/id.
 * Product is immutable. A posted PACK must be voided first.
 * A lay already covered by the order FG receipt stays editable: meters, rolls,
 * color, width and waste center. Piece count and the order link stay locked,
 * and the cost delta is absorbed into that receipt without reopening stages.
 */
function updateCuttingLay(db, id, body, user) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل ویرایش نیست', 'E_CUT_REVERSED');
  if (row.batch_id) {
    // W2 / ADR-006 — ویرایش اتمی برش مشترک (همان batch/lay)
    if (!Array.isArray(body.outputs) || !body.outputs.length || !Array.isArray(body.rolls)) {
      throw httpErr(400, 'ویرایش چندمحصولی را از مودال «ویرایش چندمحصول» انجام دهید (outputs + rolls)', 'E_SHARED_CUT_BODY');
    }
    const { amendSharedCut } = require('./shared-cut');
    const bodyShared = Object.assign({}, body, {
      production_order_id: body.production_order_id !== undefined
        ? body.production_order_id
        : row.production_order_id,
    });
    amendSharedCut(db, row.batch_id, bodyShared, user);
    return getCuttingLay(db, row.id);
  }
  if (postedPackForLay(db, row.id)) {
    throw httpErr(409, 'ابتدا رسید برش را ابطال کنید', 'E_CUT_HAS_PACK');
  }
  if (body.product_id != null && Number(body.product_id) !== Number(row.product_id)) {
    throw httpErr(400, 'کالای لایه‌چینی قابل تغییر نیست — ابطال و ثبت جدید کنید', 'E_CUT_PRODUCT_LOCKED');
  }
  const covered = layFgCoveredByOrder(db, row);
  const bodyForPlan = Object.assign({}, body, { product_id: row.product_id });
  if (bodyForPlan.marker_factor == null && Number(row.marker_factor) > 0) bodyForPlan.marker_factor = row.marker_factor;
  if (bodyForPlan.width_cm == null && Number(row.width_cm) > 0) bodyForPlan.width_cm = row.width_cm;
  const plan = planCutting(db, bodyForPlan);
  const date = String(body.date || row.date || todayJalali()).trim();
  assertCutPeriodOpen(db, date);
  if (covered.fg_covered_by_order) {
    const lockedPo = Number(row.production_order_id || covered.covered_order_id || 0);
    const incoming = body.production_order_id !== undefined && body.production_order_id !== '' && Number(body.production_order_id) !== 0
      ? Number(body.production_order_id)
      : lockedPo;
    if (lockedPo && incoming !== lockedPo) {
      throw httpErr(409, 'بعد از رسید سفارش، سفارش این لایه‌چینی قابل تغییر نیست', 'E_CUT_ORDER_LOCKED');
    }
    if (Math.round(Number(plan.qty_pieces) || 0) !== Math.round(Number(row.qty_pieces) || 0)) {
      throw httpErr(409, 'بعد از رسید سفارش، تعداد قطعه قابل تغییر نیست — متر، طاقه، رنگ و مرکز هزینه را اصلاح کنید', 'E_CUT_QTY_LOCKED');
    }
  }

  let stageBind = null;
  db.transaction(() => {
    if (!covered.fg_covered_by_order) {
      unbindCuttingLayFromOrderStage(db, row, user, row.date);
    }
    reverseCuttingLayEffects(db, row, user, body.reason || 'ویرایش لایه‌چینی');
    const { prepared, wh } = prepareCuttingLayRolls(db, bodyForPlan, plan);
    const amount = assertSafeRial(prepared.reduce((s, r) => s + r.amount_rial, 0), 'cut amount');
    const unitCost = plan.actual_meters > 0 ? Math.round(amount / plan.actual_meters) : 0;
    let wasteAmt = assertSafeRial(Math.round(plan.waste_abnormal_m * unitCost), 'cut waste');
    if (wasteAmt > amount) wasteAmt = amount;
    let color = String(body.color != null ? body.color : row.color || '').trim();
    const widthCm = body.width_cm != null ? Math.round(Number(body.width_cm) || 0) : (Number(row.width_cm) || 0);
    let po;
    if (covered.fg_covered_by_order) {
      const oid = Number(row.production_order_id || covered.covered_order_id || 0);
      po = oid ? db.prepare('SELECT * FROM production_orders WHERE id=?').get(oid) : null;
      if (!po) throw httpErr(409, 'سفارش پوشش‌دهندهٔ این لایه پیدا نشد', 'E_CUT_NO_RECEIPT');
      if (['cancelled', 'voided'].includes(String(po.status || ''))) {
        throw httpErr(409, 'سفارش تولید لغو شده است', 'E_PACK_ORDER_STATUS');
      }
    } else {
      po = resolveOptionalOrder(
        db,
        body.production_order_id !== undefined ? body.production_order_id : row.production_order_id,
        plan.product.id
      );
    }
    if (po && po.color) {
      const { colorsMatch } = require('../inventory/fabric-rolls');
      if (!color) color = String(po.color).trim();
      else if (!colorsMatch(po.color, color)) {
        throw httpErr(400, 'رنگ برش باید با رنگ سفارش تولید یکی باشد', 'E_CUT_PO_COLOR', {
          po_color: po.color, lay_color: color,
        });
      }
    }
    if (!color) {
      throw httpErr(400, 'رنگ برش الزامی است — از رنگ طاقه/سفارش انتخاب کنید', 'E_CUT_COLOR_REQUIRED');
    }
    assertCuttingLayColorWidth(db, prepared, color, widthCm);
    const costCenterId = resolveCuttingCostCenterId(db, {
      explicitId: body.cost_center_id != null ? body.cost_center_id : row.cost_center_id,
      bomId: plan.bom_id,
      warehouseId: wh.id,
    });

    db.prepare(`
      UPDATE cutting_lays SET
        bom_id=?, warehouse_id=?, fabric_product_id=?, color=?,
        marker_length_m=?, ply_count=?, width_cm=?,
        planned_meters=?, actual_meters=?, matrix_meters=?,
        size_breakdown=?, size_matrix=?, qty_pieces=?,
        waste_normal_m=?, waste_abnormal_m=?, waste_allowed_m=?,
        unit_cost_rial=?, amount_rial=?, waste_amount_rial=?,
        date=?, note=?, production_order_id=?, cost_center_id=?,
        qty_unit=?, marker_unit=?, marker_factor=?,
        status='posted', reversed_at=NULL, reversed_by=NULL, reversal_journal_id=NULL
      WHERE id=?
    `).run(
      plan.bom_id, wh.id, plan.fabric_product_id, color,
      plan.marker_length_m, plan.ply_count, widthCm,
      plan.planned_meters, plan.actual_meters, plan.matrix_meters,
      JSON.stringify(plan.size_breakdown), JSON.stringify(plan.size_matrix), plan.qty_pieces,
      plan.waste_normal_m, plan.waste_abnormal_m, plan.waste_allowed_m,
      unitCost, amount, wasteAmt,
      date, String(body.note != null ? body.note : row.note || '').trim(),
      po ? po.id : null,
      costCenterId,
      plan.qty_unit, plan.marker_unit, plan.marker_factor,
      row.id
    );

    postCuttingLayStockAndJe(db, {
      id: row.id,
      layNo: row.lay_no,
      prepared,
      wh,
      plan,
      amount,
      wasteAmt,
      unitCost,
      date,
      user,
      costCenterId,
    });
    if (po && covered.fg_covered_by_order) {
      absorbCoveredLayDelta(db, {
        lay: Object.assign({}, row, { cost_center_id: costCenterId }),
        po,
        oldAmount: Math.round(Number(row.amount_rial) || 0),
        oldWaste: Math.round(Number(row.waste_amount_rial) || 0),
        newAmount: amount,
        newWaste: wasteAmt,
        newMeters: plan.actual_meters,
        newUnit: unitCost,
        date,
        user,
      });
    } else if (po) {
      stageBind = bindCuttingLayToOrderStage(db, {
        orderId: po.id,
        layId: row.id,
        layNo: row.lay_no,
        fabricProductId: plan.fabric_product_id,
        amountRial: amount,
        qtyPieces: plan.qty_pieces,
        meters: plan.actual_meters,
        date,
        userId: user.id,
      });
    }
  })();
  const amendedLay = getCuttingLay(db, row.id);
  if (stageBind) amendedLay.stage_bind = stageBind;
  return amendedLay;
}

function linkCuttingLayOrder(db, id, productionOrderId, user) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل پیوند نیست', 'E_CUT_REVERSED');
  const po = resolveOptionalOrder(db, productionOrderId, row.product_id);
  if (!po) throw httpErr(400, 'شناسه سفارش الزامی است', 'E_PACK_ORDER');
  db.transaction(() => {
    if (row.production_order_id && Number(row.production_order_id) !== Number(po.id)) {
      unbindCuttingLayFromOrderStage(db, row, user, row.date);
    }
    db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(po.id, row.id);
    if (row.status === 'posted') {
      bindCuttingLayToOrderStage(db, {
        orderId: po.id,
        layId: row.id,
        layNo: row.lay_no,
        fabricProductId: row.fabric_product_id,
        amountRial: row.amount_rial,
        qtyPieces: row.qty_pieces,
        meters: row.actual_meters,
        date: row.date,
        userId: user.id,
      });
    }
  })();
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

function sharedPackRows(db, lay) {
  const outs = db.prepare(`
    SELECT product_id, size_code, planned_pieces
    FROM cutting_batch_outputs WHERE batch_id=?
  `).all(lay.batch_id);
  const alloc = db.prepare(`
    SELECT product_id, SUM(amount_rial) AS amt
    FROM cutting_batch_allocations WHERE batch_id=?
    GROUP BY product_id
  `).all(lay.batch_id);
  const amtBy = new Map(alloc.map((a) => [Number(a.product_id), Math.round(Number(a.amt) || 0)]));
  const by = new Map();
  for (const o of outs) {
    const pid = Number(o.product_id);
    if (!pid) continue;
    if (!by.has(pid)) by.set(pid, { product_id: pid, qty: 0, sizes: {} });
    const row = by.get(pid);
    const q = Math.round(Number(o.planned_pieces) || 0);
    row.qty += q;
    const sz = String(o.size_code || '');
    row.sizes[sz] = (row.sizes[sz] || 0) + q;
  }
  const rows = [...by.values()];
  const totalQty = rows.reduce((s, r) => s + r.qty, 0) || 1;
  const net = layNetWipRial(lay);
  const haveAlloc = rows.some((r) => (amtBy.get(r.product_id) || 0) > 0);
  return rows.map((r) => ({
    ...r,
    amount_rial: haveAlloc ? (amtBy.get(r.product_id) || 0) : Math.round(net * r.qty / totalQty),
  }));
}

function postSharedCuttingPacks(db, lay, body, user, key) {
  const rows = sharedPackRows(db, lay).filter((r) => r.qty > 0);
  if (!rows.length) throw httpErr(400, 'خروجی برش مشترک برای بسته‌بندی خالی است', 'E_PACK_QTY');
  const resolved = resolvePackProductionOrder(db, lay, body || {});
  const po = resolved.po;
  const postsFg = !po;
  const wh = requirePackWarehouse(db, body.warehouse_id, { linkedOrder: !!po });
  const date = String(body.date || lay.date || (po && po.date) || todayJalali()).trim();
  assertCutPeriodOpen(db, date);
  const covered = layFgCoveredByOrder(db, lay);
  if (covered.fg_covered_by_order) {
    throw httpErr(409, `این لایه با رسید سفارش ${covered.covered_order_no || covered.covered_order_id} وارد انبار محصول شده`, 'E_LAY_FG_COVERED', covered);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE cutting_packs SET status='reversed'
      WHERE lay_id=? AND status='posted' AND ledger_id IS NULL
    `).run(lay.id);
    if (po && Number(lay.production_order_id) !== Number(po.id)) {
      db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(po.id, lay.id);
      lay.production_order_id = po.id;
    }
    for (const row of rows) {
      const already = db.prepare(`
        SELECT id FROM cutting_packs
        WHERE lay_id=? AND product_id=? AND status='posted' AND ledger_id IS NOT NULL
      `).get(lay.id, row.product_id);
      if (already) continue;
      const unitCost = row.qty > 0 ? Math.round(row.amount_rial / row.qty) : 0;
      let packNo;
      try {
        const { allocateNumber } = require('../../db');
        packNo = allocateNumber(db, 'cutting_pack', 'PK');
      } catch (_) {
        packNo = 'PK-' + Date.now().toString(36).toUpperCase();
      }
      const idem = key + ':p:' + row.product_id;
      const id = db.prepare(`
        INSERT INTO cutting_packs (
          pack_no, lay_id, production_order_id, product_id, warehouse_id, qty,
          amount_rial, unit_cost_rial, size_breakdown, status, idempotency_key, date, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,'posted',?,?,?,?)
      `).run(
        packNo, lay.id, po ? po.id : null, row.product_id, wh.id, row.qty,
        row.amount_rial, unitCost, JSON.stringify(row.sizes), idem, date,
        String(body.note || 'بسته‌بندی برش مشترک').trim(), user.id
      ).lastInsertRowid;
      const led = postInventoryMovement(db, {
        eventType: postsFg ? 'production_receipt' : 'cutting_pack',
        productId: row.product_id,
        warehouseId: wh.id,
        qtyIn: row.qty,
        unitCostRial: unitCost,
        amountRial: row.amount_rial,
        sourceType: 'cutting_pack',
        sourceId: id,
        date,
        note: postsFg ? `رسید برش ${packNo}` : `بسته برش (WIP) ${packNo}`,
        createdBy: user.id,
        updateAvg: !!postsFg,
        warehouseOnly: !postsFg,
      });
      let journalId = null;
      if (postsFg && row.amount_rial > 0) {
        const je = postEvent(db, {
          event: 'PRD-07',
          sourceId: id,
          date,
          description: `رسید برش ${row.qty} عدد — ${packNo}`,
          createdBy: user.id,
          lines: [dr(db, 'coa_finished_goods', row.amount_rial), cr(db, 'coa_wip', row.amount_rial)],
        });
        journalId = je ? je.je_id : null;
      }
      db.prepare('UPDATE cutting_packs SET journal_id=?, ledger_id=? WHERE id=?').run(journalId, led.id, id);
    }
  })();
  return getCuttingLay(db, lay.id);
}

function postCuttingPack(db, layId, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_PACK_IDEMPOTENCY');
  const existing = db.prepare('SELECT * FROM cutting_packs WHERE idempotency_key=?').get(key);
  if (existing) return getCuttingPack(db, existing.id);

  const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(layId));
  if (!lay) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (lay.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل بسته‌بندی نیست', 'E_CUT_REVERSED');
  if (lay.batch_id) return postSharedCuttingPacks(db, lay, body || {}, user, key);
  const live = postedPackForLay(db, lay.id);
  if (live) throw httpErr(409, 'این لایه قبلاً رسید شده است', 'E_PACK_EXISTS');

  const covered = layFgCoveredByOrder(db, lay);
  if (covered.fg_covered_by_order) {
    throw httpErr(
      409,
      `این لایه با رسید سفارش ${covered.covered_order_no || covered.covered_order_id} وارد انبار محصول شده — PACK دوباره مجاز نیست`,
      'E_LAY_FG_COVERED',
      covered
    );
  }
  const resolved = resolvePackProductionOrder(db, lay, body || {});
  const po = resolved.po;
  // F06: linked PO → cut-bundle (no WIP→FG JE); standalone cut-to-stock → FG receipt
  const postsFg = !po;
  const wh = requirePackWarehouse(db, body.warehouse_id, { linkedOrder: !!po });
  const breakdown = parseSizeBreakdown(lay.size_breakdown);
  const qty = qtyFromBreakdown(breakdown) || Math.round(Number(lay.qty_pieces) || 0);
  if (!(qty > 0)) throw httpErr(400, 'تعداد سایز برای رسید صفر است', 'E_PACK_QTY');
  const wipNet = layNetWipRial(lay);
  const unitCost = qty > 0 ? Math.round(wipNet / qty) : 0;
  const date = String(body.date || lay.date || todayJalali()).trim();
  const color = String(lay.color || '').trim();
  assertCutPeriodOpen(db, date);

  let packId;
  try {
    packId = db.transaction(() => {
      const raced = db.prepare('SELECT id FROM cutting_packs WHERE idempotency_key=?').get(key);
      if (raced) return raced.id;
      const packProductId = lay.batch_id
        ? Number((body && body.product_id) || lay.product_id)
        : Number(lay.product_id);
      const liveNow = postedPackForLay(db, lay.id);
      if (liveNow) throw httpErr(409, 'این لایه قبلاً رسید شده است', 'E_PACK_EXISTS');
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
        packNo, lay.id, po ? po.id : null, lay.batch_id ? packProductId : lay.product_id, wh.id, qty,
        wipNet, unitCost, JSON.stringify(breakdown), key, date,
        String(body.note || '').trim(), user.id
      );
      const id = ins.lastInsertRowid;
      assertJournalIdempotent(db, 'cutting_pack', id);

      const sizes = Object.keys(breakdown);
      const apparel = require('../inventory/apparel-lines');
      const { hasActiveMatrixVariants } = require('../inventory/qty-policy');
      let fgLines = [];
      if (hasActiveMatrixVariants(db, lay.product_id)) {
        // Fail closed: resolve variants BEFORE header stock credit.
        // Prefer PO matrix variant_id when lay color matches a planned line.
        if (po && color) {
          try {
            const hasPol = db.prepare(`
              SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_order_lines'
            `).get();
            const olines = hasPol ? db.prepare(`
              SELECT l.variant_id, l.qty, c.name AS color_name
              FROM production_order_lines l
              LEFT JOIN product_colors c ON c.id = l.color_id
              WHERE l.order_id=? AND l.variant_id IS NOT NULL AND COALESCE(l.qty,0) > 0
            `).all(po.id).filter((ln) => colorsMatch(ln.color_name || '', color)) : [];
            if (olines.length === 1) {
              fgLines = [{ variantId: Number(olines[0].variant_id), qty }];
            } else if (olines.length > 1) {
              // Split pack qty by planned line weights when several sizes share the color.
              const planned = olines.reduce((s, ln) => s + (Number(ln.qty) || 0), 0) || 1;
              fgLines = olines.map((ln) => ({
                variantId: Number(ln.variant_id),
                qty: Math.round((qty * (Number(ln.qty) || 0) / planned) * 1000) / 1000,
              })).filter((ln) => ln.qty > 0);
              const sum = fgLines.reduce((s, ln) => s + ln.qty, 0);
              if (fgLines.length && Math.abs(sum - qty) > 0.001) {
                fgLines[0].qty = Math.round((fgLines[0].qty + (qty - sum)) * 1000) / 1000;
              }
            }
          } catch (_) { fgLines = []; }
        }
        if (!fgLines.length) {
          fgLines = apparel.resolveApparelLines(db, {
            productId: lay.product_id, qty, sizeBreakdown: breakdown, color,
          });
        }
        if (!fgLines.length) {
          throw httpErr(400, 'برای کالای ماتریسی تفکیک رنگ×سایز الزامی است', 'E_VARIANT_REQUIRED');
        }
      }

      const led = postInventoryMovement(db, {
        eventType: postsFg ? 'production_receipt' : 'cutting_pack',
        productId: lay.product_id,
        warehouseId: wh.id,
        qtyIn: qty,
        unitCostRial: unitCost,
        amountRial: wipNet,
        sourceType: 'cutting_pack',
        sourceId: id,
        date,
        note: postsFg ? `رسید برش ${packNo}` : `بسته برش (WIP) ${packNo}`,
        createdBy: user.id,
        updateAvg: !!postsFg,
        // Linked PO: qty stages in the WIP warehouse only — sellable products.stock
        // stays untouched until finalize posts the single WIP→FG receipt.
        warehouseOnly: !postsFg,
      });

      let journalId = null;
      if (postsFg && wipNet > 0) {
        const je = postEvent(db, {
          event: 'PRD-07',
          sourceId: id,
          date,
          description: `رسید برش ${qty} عدد — ${packNo}`,
          createdBy: user.id,
          lines: [
            dr(db, 'coa_finished_goods', wipNet),
            cr(db, 'coa_wip', wipNet),
          ],
        });
        journalId = je ? je.je_id : null;
      }
      db.prepare('UPDATE cutting_packs SET journal_id=?, ledger_id=? WHERE id=?')
        .run(journalId, led.id, id);

      // Linked PO: do NOT credit sellable variant stock here — finalize posts apparel once.
      // Bundles still keep variant_id for barcode / later FG receipt.
      if (fgLines.length && postsFg) {
        apparel.postApparelLines(db, {
          productId: lay.product_id, warehouseId: wh.id, lines: fgLines,
          docType: 'cutting_pack', docId: id, userId: user.id,
          note: `رسید برش ${packNo}`, sign: 1, allowNegative: true,
        });
      }
      const variantBySize = new Map();
      for (const line of fgLines) {
        const v = db.prepare(`
          SELECT pv.id, ps.name AS size_name FROM product_variants pv
          LEFT JOIN product_sizes ps ON ps.id = pv.size_id WHERE pv.id=?
        `).get(line.variantId);
        if (v) variantBySize.set(String(v.size_name || ''), line.variantId);
      }
      if (!sizes.length) {
        const onlyVid = fgLines.length === 1 ? fgLines[0].variantId : null;
        db.prepare(`
          INSERT INTO cutting_pack_bundles (pack_id, product_id, color, size_code, qty, amount_rial, barcode, status, variant_id)
          VALUES (?,?,?,?,?,?,?, 'posted', ?)
        `).run(id, lay.product_id, color, '', qty, wipNet, nextBundleBarcode(db, packNo, 'ALL', color), onlyVid);
      } else {
        let allocated = 0;
        sizes.forEach((sz, idx) => {
          const q = Math.round(Number(breakdown[sz]) || 0);
          if (!(q > 0)) return;
          const share = idx === sizes.length - 1
            ? Math.max(0, wipNet - allocated)
            : Math.round(wipNet * q / qty);
          allocated += share;
          const vid = variantBySize.get(String(sz)) || null;
          db.prepare(`
            INSERT INTO cutting_pack_bundles (pack_id, product_id, color, size_code, qty, amount_rial, barcode, status, variant_id)
            VALUES (?,?,?,?,?,?,?, 'posted', ?)
          `).run(id, lay.product_id, color, sz, q, share, nextBundleBarcode(db, packNo, sz, color), vid);
        });
      }
      return id;
    }).immediate();
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(String(e.message)))) {
      const again = db.prepare('SELECT id FROM cutting_packs WHERE idempotency_key=?').get(key);
      if (again) return getCuttingPack(db, again.id);
      throw httpErr(409, 'این لایه قبلاً رسید شده است', 'E_PACK_EXISTS');
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
    require('../inventory/apparel-lines').reverseApparelDoc(db, {
      docType: 'cutting_pack', docId: pack.id, userId: user.id,
      note: reason || 'ابطال رسید برش',
    });
    let revJe = null;
    if (pack.journal_id) {
      revJe = reverseJournalEntry(db, pack.journal_id, {
        userId: user.id,
        reason: reason || 'ابطال رسید برش',
        sourceType: 'production_receipt_reversal',
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
  const packs = db.prepare(`
    SELECT * FROM cutting_packs WHERE lay_id=? AND COALESCE(status,'posted')='posted' ORDER BY id DESC
  `).all(Number(layId));
  if (!packs.length) throw httpErr(404, 'رسید برش یافت نشد', 'E_PACK');
  let last = null;
  for (const pack of packs) {
    last = voidCuttingPack(db, pack.id, user, opts);
  }
  return last;
}

module.exports = {
  planCutting,
  listCuttingLays,
  getCuttingLay,
  postCuttingLay,
  updateCuttingLay,
  voidCuttingLay,
  classifyWasteMeters,
  assertFabricIssueAllowed,
  fabricIssueAllowance,
  linkCuttingLayOrder,
  postCuttingPack,
  getCuttingPack,
  voidCuttingPack,
  voidCuttingPackByLay,
  layNetWipRial,
  requireRawWarehouse,
  isRawWarehouseRow,
  requirePackWarehouse,
  isWipWarehouseRow,
  findOpenProductionOrdersForProduct,
  resolvePackProductionOrder,
  assertNoOrphanSellablePack,
  orderRequiresFabricCutting,
  cuttingQtyForOrder,
  cuttingQtyForOrderProduct,
  fabricCuttingGateInfo,
  assertFabricCuttingPathForFgReceipt,
  assertOrderCutQtyMatches,
  relieveStagedPackQty,
  reverseStagedPackRelief,
  layFgCoveredByOrder,
  reverseOrderFgDeltas,
  fgDeltaLaysForOrder,
  fabricLineFromBom,
  isMeterUnit,
  isRollFabricProduct,
  rollFabricUnitLabel,
};
