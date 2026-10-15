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
const { dr, cr, postEvent } = require('./posting');
const { setting } = require('./costing');

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
  return db.prepare(`
    SELECT * FROM cutting_packs WHERE lay_id=? AND status='posted' ORDER BY id DESC LIMIT 1
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
    throw httpErr(400, 'سفارش باید همان کالای لایه باشد', 'E_PACK_ORDER_PRODUCT');
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
    WHERE product_id=?
      AND COALESCE(status,'') NOT IN ('cancelled','closed','completed','done','voided')
    ORDER BY id DESC
  `).all(pid);
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
 * Apparel fabric path: meter fabric in BOM that is roll-tracked (طاقه) must go
 * lay → PACK (WIP) → order receipt/finalize (FG). Never short-circuit via
 * POST /production/orders/:id/receipt alone.
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
  const fabId = Number(fabricLine.product_id);
  const prod = db.prepare('SELECT unit FROM products WHERE id=?').get(fabId);
  if (!isMeterUnit(prod && prod.unit)) return false;
  const hasRoll = db.prepare(`
    SELECT 1 AS ok FROM inventory_batches
    WHERE product_id=? AND COALESCE(kind,'generic')='fabric'
    LIMIT 1
  `).get(fabId);
  if (hasRoll) return true;
  // Already on cutting path for this order (even if rolls were voided later).
  if (po.id) {
    const lay = db.prepare(`
      SELECT 1 AS ok FROM cutting_lays
      WHERE production_order_id=? AND COALESCE(status,'posted')<>'reversed'
      LIMIT 1
    `).get(Number(po.id));
    if (lay) return true;
  }
  return false;
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
        WHERE production_order_id=? AND status='posted'
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

/**
 * Linked cutting packs stage bundle qty in a WIP warehouse (warehouseOnly).
 * Order receipt / finalize must take that qty out of WIP without a second
 * products.stock hit.
 */
function relieveStagedPackQty(db, { orderId, productId, qtyGood, userId, date, receiptId }) {
  const has = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cutting_packs'"
  ).get();
  if (!has) return;
  const packs = db.prepare(`
    SELECT id, warehouse_id, qty FROM cutting_packs
    WHERE production_order_id=? AND product_id=? AND status='posted' AND COALESCE(qty,0)>0
    ORDER BY id
  `).all(orderId, productId);
  let left = Number(qtyGood) || 0;
  for (const p of packs) {
    if (!(left > 0)) break;
    const wh = Number(p.warehouse_id) || 0;
    if (!wh) continue;
    const take = Math.min(left, Number(p.qty) || 0);
    if (!(take > 0)) continue;
    postInventoryMovement(db, {
      eventType: 'cutting_pack',
      productId,
      warehouseId: wh,
      qtyOut: take,
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
  };
  if (!lay || String(lay.status || '') === 'reversed') return out;
  let po = null;
  if (lay.production_order_id) {
    po = db.prepare(`
      SELECT id, order_no, status, qty_produced, product_id
      FROM production_orders WHERE id=?
    `).get(Number(lay.production_order_id));
  }
  if (!po && lay.product_id) {
    // Legacy unlinked lays: exactly one completed/closed order for this FG
    // with posted receipt covering the lay qty.
    const candidates = db.prepare(`
      SELECT id, order_no, status, qty_produced, product_id
      FROM production_orders
      WHERE product_id=? AND status IN ('completed','closed')
      ORDER BY id DESC
    `).all(Number(lay.product_id));
    if (candidates.length === 1) po = candidates[0];
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
    row.pack_posted = pack ? 1 : 0;
    row.pack_no = pack ? pack.pack_no : null;
    Object.assign(row, layFgCoveredByOrder(db, row));
    // Covered-by-order counts as "done" for pending-pack queues (F06 already posted).
    if (row.fg_covered_by_order && !row.pack_posted) {
      row.pack_posted = 1;
      row.pack_via_order_fg = 1;
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
  if (covered.fg_covered_by_order) {
    row.pack_posted = 1;
    row.pack_via_order_fg = 1;
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
      postCuttingLayStockAndJe(db, {
        id, layNo, prepared, wh, plan, amount, wasteAmt, unitCost, date, user,
      });
      if (po) {
        bindCuttingLayToOrderStage(db, {
          orderId: po.id,
          layId: id,
          layNo,
          fabricProductId: plan.fabric_product_id,
          amountRial: amount,
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
  return getCuttingLay(db, layId);
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
    if (!batchId || !(meters > 0)) throw httpErr(400, 'طاقه یا متر نامعتبر است', 'E_CUT_ROLL');
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
      throw httpErr(409, 'متر طاقه کافی نیست', 'E_CUT_ROLL_QTY', {
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
    throw httpErr(400, 'جمع متر طاقه‌ها باید با مصرف واقعی برابر باشد', 'E_CUT_ROLL_SUM', {
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
  id, layNo, prepared, wh, plan, amount, wasteAmt, unitCost, date, user,
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
      description: `ضایعات غیرعادی برش ${layNo} — ${plan.waste_abnormal_m} متر`,
      createdBy: user.id,
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

function voidCuttingLay(db, id, user, { reason } = {}) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'این لایه قبلاً ابطال شده است', 'E_CUT_REVERSED');
  if (postedPackForLay(db, row.id)) {
    throw httpErr(409, 'ابتدا رسید برش را ابطال کنید', 'E_CUT_HAS_PACK');
  }
  db.transaction(() => {
    unbindCuttingLayFromOrderStage(db, row, user, row.date);
    const { revJe } = reverseCuttingLayEffects(db, row, user, reason || 'ابطال لایه‌چینی');
    db.prepare(`
      UPDATE cutting_lays
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?, stage_id=NULL
      WHERE id=?
    `).run(user.id, revJe, row.id);
  })();
  return getCuttingLay(db, row.id);
}

/**
 * R13 Edit ⇒ reverse all create effects, then re-post on the same lay_no/id.
 * Product is immutable. Pack must be voided first.
 */
function updateCuttingLay(db, id, body, user) {
  const row = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'لایه یافت نشد', 'E_CUT_LAY');
  if (row.status === 'reversed') throw httpErr(409, 'لایه ابطال‌شده قابل ویرایش نیست', 'E_CUT_REVERSED');
  if (postedPackForLay(db, row.id)) {
    throw httpErr(409, 'ابتدا رسید برش را ابطال کنید', 'E_CUT_HAS_PACK');
  }
  if (body.product_id != null && Number(body.product_id) !== Number(row.product_id)) {
    throw httpErr(400, 'کالای لایه‌چینی قابل تغییر نیست — ابطال و ثبت جدید کنید', 'E_CUT_PRODUCT_LOCKED');
  }
  const bodyForPlan = Object.assign({}, body, { product_id: row.product_id });
  const plan = planCutting(db, bodyForPlan);
  const date = String(body.date || row.date || todayJalali()).trim();
  assertCutPeriodOpen(db, date);

  db.transaction(() => {
    unbindCuttingLayFromOrderStage(db, row, user, row.date);
    reverseCuttingLayEffects(db, row, user, body.reason || 'ویرایش لایه‌چینی');
    const { prepared, wh } = prepareCuttingLayRolls(db, bodyForPlan, plan);
    const amount = assertSafeRial(prepared.reduce((s, r) => s + r.amount_rial, 0), 'cut amount');
    const unitCost = plan.actual_meters > 0 ? Math.round(amount / plan.actual_meters) : 0;
    let wasteAmt = assertSafeRial(Math.round(plan.waste_abnormal_m * unitCost), 'cut waste');
    if (wasteAmt > amount) wasteAmt = amount;
    let color = String(body.color != null ? body.color : row.color || '').trim();
    const widthCm = body.width_cm != null ? Math.round(Number(body.width_cm) || 0) : (Number(row.width_cm) || 0);
    const po = resolveOptionalOrder(
      db,
      body.production_order_id !== undefined ? body.production_order_id : row.production_order_id,
      plan.product.id
    );
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

    db.prepare(`
      UPDATE cutting_lays SET
        bom_id=?, warehouse_id=?, fabric_product_id=?, color=?,
        marker_length_m=?, ply_count=?, width_cm=?,
        planned_meters=?, actual_meters=?, matrix_meters=?,
        size_breakdown=?, size_matrix=?, qty_pieces=?,
        waste_normal_m=?, waste_abnormal_m=?, waste_allowed_m=?,
        unit_cost_rial=?, amount_rial=?, waste_amount_rial=?,
        date=?, note=?, production_order_id=?,
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
    });
    if (po) {
      bindCuttingLayToOrderStage(db, {
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
  return getCuttingLay(db, row.id);
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
        packNo, lay.id, po ? po.id : null, lay.product_id, wh.id, qty,
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
  fabricCuttingGateInfo,
  assertFabricCuttingPathForFgReceipt,
  relieveStagedPackQty,
  layFgCoveredByOrder,
  fabricLineFromBom,
  isMeterUnit,
};
