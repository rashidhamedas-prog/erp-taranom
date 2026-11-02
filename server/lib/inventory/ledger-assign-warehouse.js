'use strict';
/**
 * audit-kardex K2 — تعیین انبار برای ردیف کاردکس «برگشت از فروش» که بدون انبار (warehouse_id NULL) ثبت شده.
 *
 * Scope: posted, non-reversed inventory_ledger rows with event_type='sale_return', source_type='sales_return',
 * warehouse_id NULL (open return without warehouse, or an R13 edit that dropped it). GL is already right
 * (the return JE hit the inventory control account of the NULL bucket); only the warehouse is missing.
 *
 * Append-only, one transaction per call (batch = all-or-nothing):
 *   1. reverseInventoryMovement(original, skipStock) — original ⇒ status 'reversed', reversal row (NULL bucket −).
 *   2. new 'sale_return' row, same source/qty/unit/amount, warehouse W, updateAvg:false, skipStock (W bucket +).
 *   3. stock caches: warehouse_stock(W) +q; products.stock +q only when the header does not already hold this
 *      qty (header − Σws < q). Afterwards header == Σws whenever it was before.
 *   4. variant layer (matrix product, variant from the return line): a live NULL-warehouse 'sale_return_sku'
 *      movement of this return is voided ('_void' twin — so the normal return void skips it), a new
 *      'sale_return_sku' movement at W is posted (fresh doc_line — the normal return void reverses it), and
 *      when product_variants.stock had already been healed to Σvws a pv-only heal movement restores pv == Σvws.
 * No JE: both buckets must map to the same inventory account (else 409). Evidence/plan is computed for the
 * whole batch before any write, so preview == post.
 */
const TAG = 'ledger-assign-warehouse';
const REASON_MIN = 10;
const BATCH_MAX = 200;
const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const SKU_DOC = 'sale_return_sku';
const PV_HEAL_DOC = 'ledger_assign_wh_pv';
const EPS = 1e-9;
const TAG_LIKE = `[${TAG}:%`;

function awErr(message, status, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function isConfirmed(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function given(v) { return v != null && String(v).trim() !== ''; }

function parseOverrides(raw) {
  if (raw == null || raw === '') return {};
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('{')) {
      try { obj = JSON.parse(s); } catch (_) { obj = null; }
    } else {
      obj = {};
      for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
        const [k, v] = part.split(':');
        obj[k] = v;
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw awErr('overrides باید به شکل {"شناسه ردیف": شناسه انبار} باشد', 400, 'E_ASSIGN_WH_BAD_OVERRIDES');
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const id = posInt(k);
    const wh = posInt(v);
    if (!id || !wh) throw awErr('overrides باید به شکل {"شناسه ردیف": شناسه انبار} باشد', 400, 'E_ASSIGN_WH_BAD_OVERRIDES');
    out[id] = wh;
  }
  return out;
}

function parseIds(raw) {
  let arr = raw;
  if (typeof raw === 'string') arr = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(arr) || !arr.length || arr.length > BATCH_MAX) {
    throw awErr(`فهرست شناسه‌ها (ids) باید ۱ تا ${BATCH_MAX} ردیف باشد`, 400, 'E_ASSIGN_WH_IDS');
  }
  const ids = arr.map(posInt);
  if (ids.some((x) => !x) || new Set(ids).size !== ids.length) {
    throw awErr('شناسه‌های ردیف کاردکس باید عدد مثبت و بدون تکرار باشند', 400, 'E_ASSIGN_WH_IDS');
  }
  return ids;
}

function parseWarehouseArg(v) {
  if (!given(v)) return null;
  const w = posInt(v);
  if (!w) throw awErr('شناسهٔ انبار نامعتبر است', 400, 'E_ASSIGN_WH_BAD_WAREHOUSE');
  return w;
}

/** Body validation — pure, runs before any DB read/write. */
function validateBody(body, { batch = false } = {}) {
  const b = body || {};
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (reason.length < REASON_MIN) {
    throw awErr(`علت تعیین انبار الزامی است (حداقل ${REASON_MIN} نویسه)`, 400, 'E_ASSIGN_WH_REASON_REQUIRED');
  }
  if (!isConfirmed(b.confirm)) {
    throw awErr('برای تعیین انبار تأیید صریح (confirm: true) الزامی است', 400, 'E_ASSIGN_WH_CONFIRM_REQUIRED');
  }
  let date = null;
  if (given(b.date)) {
    date = String(b.date).trim();
    if (!JALALI_RE.test(date)) throw awErr('تاریخ باید به شکل ۱۴۰۵/۰۸/۱۲ باشد', 400, 'E_ASSIGN_WH_DATE');
  }
  const ids = batch ? parseIds(b.ids) : null;
  const warehouseId = parseWarehouseArg(b.warehouse_id);
  const overrides = parseOverrides(b.overrides);
  return { reason, date, ids, warehouseId, overrides, force: isConfirmed(b.force) };
}

/* ───────────────────────── evidence ───────────────────────── */

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function parseRows(json) {
  try {
    const r = JSON.parse(json || '[]');
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
}

/**
 * Return line of this ledger row: live/historical sale_return rows of the source (assign rows excluded)
 * map 1:1 in id order onto the product rows of the current posting generation (last N).
 */
function returnLineOf(db, row, sr) {
  const lines = parseRows(sr && sr.rows).filter((r) => r && Number(r.product_id) > 0);
  if (!sr || !lines.length) return { index: null, line: null };
  const ids = db.prepare(`
    SELECT id FROM inventory_ledger
    WHERE source_type='sales_return' AND source_id=? AND event_type='sale_return' AND reversed_of IS NULL
      AND COALESCE(note,'') NOT LIKE ?
    ORDER BY id
  `).all(sr.id, TAG_LIKE).map((r) => Number(r.id));
  const lastN = ids.slice(-lines.length);
  const idx = lastN.indexOf(Number(row.id));
  if (idx < 0 || Number(lines[idx].product_id) !== Number(row.product_id)) return { index: null, line: null };
  return { index: idx, line: lines[idx] };
}

function distinctWh(rows) {
  return [...new Set(rows.map((r) => Number(r.warehouse_id)).filter((w) => w > 0))].sort((a, b) => a - b);
}

/**
 * Warehouse evidence by priority:
 *   1 same return before edit (ledger rows / sku movements with a warehouse)   — strong
 *   2 sales_returns.rows[i].warehouse_id                                       — strong
 *   3 invoice line / header warehouse                                         — strong
 *   4 original sale ledger rows of the invoice for this product               — strong (ambiguous if >1)
 *   5 products.warehouse_id                                                    — weak (suggestion only)
 */
function deriveWarehouse(db, row, { sr, line, variantId }) {
  const evidence = [];
  const pid = Number(row.product_id);
  const srId = Number(row.source_id);
  const l1 = distinctWh([
    ...db.prepare(`
      SELECT DISTINCT warehouse_id FROM inventory_ledger
      WHERE source_type='sales_return' AND source_id=? AND product_id=? AND warehouse_id IS NOT NULL
        AND event_type='sale_return' AND COALESCE(note,'') NOT LIKE ?
    `).all(srId, pid, TAG_LIKE),
    ...(tableExists(db, 'inventory_movements') ? db.prepare(`
      SELECT DISTINCT warehouse_id FROM inventory_movements
      WHERE doc_type IN ('sale_return_sku','sale_return_sku_void') AND doc_id=? AND product_id=?
        AND warehouse_id IS NOT NULL AND COALESCE(note,'') NOT LIKE ?
        ${variantId ? 'AND COALESCE(variant_id,0)=?' : ''}
    `).all(...(variantId ? [srId, pid, TAG_LIKE, variantId] : [srId, pid, TAG_LIKE])) : []),
  ]);
  if (l1.length) evidence.push({ level: 1, source: 'same_return_history', warehouse_ids: l1 });
  const l2 = line && posInt(line.warehouse_id) ? [posInt(line.warehouse_id)] : [];
  if (l2.length) evidence.push({ level: 2, source: 'return_row', warehouse_ids: l2 });
  let inv = null;
  if (sr && sr.invoice_id) inv = db.prepare('SELECT id, rows, warehouse_id FROM invoices WHERE id=?').get(sr.invoice_id);
  if (inv) {
    const invLines = parseRows(inv.rows);
    const hit = (variantId && invLines.find((r) => Number(r.variant_id) === Number(variantId)))
      || invLines.find((r) => Number(r.product_id) === pid);
    const w = (hit && posInt(hit.warehouse_id)) || posInt(inv.warehouse_id);
    if (w) evidence.push({ level: 3, source: hit && posInt(hit.warehouse_id) ? 'invoice_line' : 'invoice_header', warehouse_ids: [w] });
    const l4 = distinctWh(db.prepare(`
      SELECT DISTINCT warehouse_id FROM inventory_ledger
      WHERE source_type='invoice' AND source_id=? AND product_id=? AND event_type='sale'
        AND reversed_of IS NULL AND COALESCE(qty_out,0)>0 AND warehouse_id IS NOT NULL
    `).all(inv.id, pid));
    if (l4.length) evidence.push({ level: 4, source: 'invoice_sale_ledger', warehouse_ids: l4 });
  }
  const prod = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(pid);
  if (prod && posInt(prod.warehouse_id)) evidence.push({ level: 5, source: 'product_home', warehouse_ids: [posInt(prod.warehouse_id)] });

  const top = evidence[0];
  let out = { warehouse_id: null, confidence: 'none', source: null, candidates: [] };
  if (top && top.level <= 4) {
    out = top.warehouse_ids.length === 1
      ? { warehouse_id: top.warehouse_ids[0], confidence: 'strong', source: top.source, candidates: top.warehouse_ids }
      : { warehouse_id: null, confidence: 'ambiguous', source: top.source, candidates: top.warehouse_ids };
  } else if (top) {
    out = { warehouse_id: top.warehouse_ids[0], confidence: 'weak', source: top.source, candidates: top.warehouse_ids };
  }
  return { ...out, evidence };
}

/* ───────────────────────── eligibility ───────────────────────── */

function assignedRowFor(db, ledgerId) {
  const r = db.prepare(`
    SELECT id, warehouse_id FROM inventory_ledger
    WHERE event_type='sale_return' AND reversed_of IS NULL AND note LIKE ? ORDER BY id DESC LIMIT 1
  `).get(`[${TAG}:ledger#${Number(ledgerId)}]%`);
  return r || null;
}

/** Throws the 404/409 that blocks assigning a warehouse to this row. */
function assertEligible(db, row, ledgerId) {
  if (!row) throw awErr('تراکنش انبار یافت نشد', 404, 'E_LEDGER_NOT_FOUND', { ledger_id: Number(ledgerId) || null });
  const et = String(row.event_type || '');
  if (String(row.status || '') === 'reversed') {
    const done = assignedRowFor(db, row.id);
    throw awErr(done
      ? `انبار این ردیف قبلاً تعیین شده است (ردیف جدید #${done.id})`
      : 'این ردیف کاردکس قبلاً ابطال شده است', 409, 'E_ALREADY_REVERSED', {
      ledger_id: row.id,
      assigned_ledger_id: done ? done.id : null,
      assigned_warehouse_id: done ? done.warehouse_id : null,
    });
  }
  if (row.reversed_of != null || et === 'reversal' || et.endsWith('_reversal')) {
    throw awErr('ردیف معکوس (برگشتی) قابل تعیین انبار نیست', 409, 'E_REVERSE_OF_REVERSAL', { ledger_id: row.id });
  }
  if (String(row.status || '') !== 'posted') {
    throw awErr('فقط ردیف ثبت‌شده قابل تعیین انبار است', 409, 'E_LEDGER_NOT_POSTED', { ledger_id: row.id, status: row.status });
  }
  if (et !== 'sale_return' || String(row.source_type || '') !== 'sales_return') {
    throw awErr('تعیین انبار فقط برای ردیف «برگشت از فروش» مجاز است', 409, 'E_ASSIGN_WH_NOT_SALE_RETURN', {
      ledger_id: row.id, event_type: et, source_type: row.source_type,
    });
  }
  if (row.warehouse_id != null) {
    throw awErr('این ردیف انبار دارد', 409, 'E_ASSIGN_WH_HAS_WAREHOUSE', { ledger_id: row.id, warehouse_id: row.warehouse_id });
  }
  if (!((Number(row.qty_in) || 0) > 0) || (Number(row.qty_out) || 0) > 0) {
    throw awErr('ردیف بدون تعداد ورودی با این مسیر اصلاح نمی‌شود', 409, 'E_REVERSE_NOT_QTY_ROW', { ledger_id: row.id });
  }
}

/* ───────────────────────── simulation ───────────────────────── */

function makeSim(db) {
  const num = new Map();
  const buckets = new Map();
  const usedMov = new Set();
  const V = require('./valuation');
  const getNum = (key, load) => {
    if (!num.has(key)) num.set(key, round3(load()));
    return num.get(key);
  };
  const addNum = (key, load, d) => { num.set(key, round3(getNum(key, load) + d)); return num.get(key); };
  const bucket = (pid, key) => {
    const k = `${pid}:${key}`;
    if (!buckets.has(k)) {
      const b = V.getBucket(db, pid, key || null);
      buckets.set(k, b ? V.newState(b.qty, b.value_rial, b.avg_rial) : V.newState());
    }
    return buckets.get(k);
  };
  const loaders = {
    header: (pid) => () => (db.prepare('SELECT stock FROM products WHERE id=?').get(pid) || {}).stock,
    sumWs: (pid) => () => (db.prepare('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock WHERE product_id=?').get(pid) || {}).s,
    ws: (pid, wh) => () => (db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid, wh) || {}).qty,
    pv: (vid) => () => (db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid) || {}).stock,
    sumVws: (vid) => () => (db.prepare('SELECT COALESCE(SUM(qty),0) s FROM variant_warehouse_stock WHERE variant_id=?').get(vid) || {}).s,
    vws: (vid, wh) => () => (db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, wh) || {}).qty,
  };
  const kardex = new Map();
  const kx = (pid, wh) => {
    const k = `${pid}:${wh || 0}`;
    if (!kardex.has(k)) kardex.set(k, require('./ledger-reverse-correction').kardexOf(db, pid, wh || null));
    return kardex.get(k);
  };
  return { getNum, addNum, loaders, bucket, usedMov, kx, V };
}

function bucketView(st) { return { qty: round3(st.q), value_rial: Math.round(st.v), avg_rial: Math.round(st.avg) }; }

/** Live NULL-warehouse sku movement of this return for (product, variant, qty) with no _void twin. */
function findNullSkuMovement(db, { srId, productId, variantId, qty, lineIndex, used }) {
  if (!tableExists(db, 'inventory_movements')) return null;
  const rows = db.prepare(`
    SELECT m.* FROM inventory_movements m
    WHERE m.doc_type=? AND m.doc_id=? AND m.product_id=? AND COALESCE(m.variant_id,0)=? AND m.warehouse_id IS NULL
      AND ABS(m.qty_delta - ?) < 1e-6
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements v
        WHERE v.doc_type=? AND v.doc_id=m.doc_id AND COALESCE(v.doc_line,-1)=COALESCE(m.doc_line,-1)
          AND v.warehouse_id IS NULL AND COALESCE(v.variant_id,0)=COALESCE(m.variant_id,0)
      )
    ORDER BY m.id
  `).all(SKU_DOC, srId, productId, variantId || 0, qty, `${SKU_DOC}_void`).filter((m) => !used.has(Number(m.id)));
  return rows.find((m) => lineIndex != null && Number(m.doc_line) === Number(lineIndex)) || rows[0] || null;
}

function warehouseInfo(db, wh) {
  if (!wh) return null;
  return db.prepare('SELECT id, name, active FROM warehouses WHERE id=?').get(wh) || null;
}

function accountCode(db, wh) {
  try {
    return require('./ledger').inventoryAccountForWarehouse(db, wh || null, { readOnly: true }).code || null;
  } catch (_) { return null; }
}

/**
 * Read-only plan for one row inside a batch simulation. Never throws for business blockers; the blocker is
 * returned so preview can show it and post can refuse it.
 */
function planRow(db, ledgerId, { explicitWh, force }, sim) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(Number(ledgerId) || 0);
  const out = { ledger_id: Number(ledgerId) || null, eligible: true, blocker: null, ready: false, gl_effect_rial: 0 };
  const block = (e) => {
    if (!out.blocker) out.blocker = { status: e.status || 409, code: e.code, error: e.message, ...(e.assigned_ledger_id ? { assigned_ledger_id: e.assigned_ledger_id } : {}) };
  };
  try { assertEligible(db, row, ledgerId); } catch (e) {
    out.eligible = false;
    block(e);
    if (!row) return out;
  }
  const pid = Number(row.product_id);
  const qty = round3(row.qty_in);
  const amount = Math.round(Number(row.amount_rial) || 0);
  const prod = db.prepare('SELECT id, name, code, unit FROM products WHERE id=?').get(pid) || {};
  const sr = row.source_id ? db.prepare('SELECT id, invoice_id, rows, status, warehouse_id FROM sales_returns WHERE id=?').get(row.source_id) : null;
  const { index: lineIndex, line } = returnLineOf(db, row, sr);
  const variantId = posInt(row.variant_id) || (line && posInt(line.variant_id)) || null;
  Object.assign(out, {
    tx_no: row.tx_no || null,
    date: row.date || '',
    product_id: pid,
    product_name: prod.name || '',
    product_code: prod.code || '',
    unit: prod.unit || '',
    sales_return_id: row.source_id != null ? Number(row.source_id) : null,
    invoice_id: sr && sr.invoice_id ? Number(sr.invoice_id) : null,
    qty,
    unit_cost_rial: Math.round(Number(row.unit_cost_rial) || 0),
    amount_rial: amount,
    line_index: lineIndex,
    variant_id: variantId,
  });
  if (out.eligible && !sr) block(awErr('سند برگشت از فروش این ردیف یافت نشد', 409, 'E_ASSIGN_WH_SOURCE_MISSING', {}));

  const derived = deriveWarehouse(db, row, { sr, line, variantId });
  out.derived = derived;
  const explicit = explicitWh || null;
  let wh = null;
  let choice = null;
  if (explicit) {
    wh = explicit;
    choice = 'explicit';
    if (derived.confidence === 'strong' && derived.warehouse_id !== explicit) {
      if (force) out.forced = true;
      else {
        block(awErr(`انبار انتخابی (${explicit}) با شواهد قطعی (${derived.warehouse_id}) نمی‌خواند؛ برای ثبت با وجود این تناقض force: true بفرستید`,
          409, 'E_ASSIGN_WH_CONFLICT', {}));
      }
    }
  } else if (derived.confidence === 'strong') {
    wh = derived.warehouse_id;
    choice = 'derived';
  } else {
    block(awErr(derived.confidence === 'weak'
      ? `انبار پیشنهادی (${derived.warehouse_id}) فقط حدس است؛ انبار را صریحاً انتخاب کنید (warehouse_id)`
      : 'انبار این ردیف از شواهد قابل تشخیص قطعی نیست؛ انبار را صریحاً انتخاب کنید (warehouse_id)',
    409, 'E_ASSIGN_WH_EXPLICIT_REQUIRED', {}));
  }
  out.explicit_warehouse_id = explicit;
  out.warehouse_id = wh;
  out.choice = choice;
  out.forced = !!out.forced;
  const whRow = warehouseInfo(db, wh);
  out.warehouse_name = whRow ? whRow.name || '' : '';
  if (wh && (!whRow || Number(whRow.active) === 0)) {
    block(awErr(`انبار #${wh} وجود ندارد یا غیرفعال است`, 409, 'E_ASSIGN_WH_INVALID', {}));
  }
  let periodic = false;
  if (wh && whRow) {
    try { periodic = require('./periodic-close').isPeriodicWarehouse(db, wh); } catch (_) { periodic = false; }
    if (periodic) block(awErr('انبار ادواری (periodic) برای این اصلاح مجاز نیست', 409, 'E_ASSIGN_WH_PERIODIC', {}));
  }
  const glNull = accountCode(db, null);
  const glWh = wh ? accountCode(db, wh) : null;
  out.gl_account = { null_bucket: glNull, warehouse: glWh };
  if (wh && whRow && !periodic && glNull !== glWh) {
    block(awErr(`حساب موجودی انبار #${wh} (${glWh || '—'}) با حساب ردیف بی‌انبار (${glNull || '—'}) فرق دارد؛ این اصلاح بدون سند حسابداری ممکن نیست`,
      409, 'E_ASSIGN_WH_GL_MISMATCH', {}));
  }
  let approvals = 0;
  try {
    approvals = db.prepare("SELECT COUNT(*) c FROM inventory_value_approval_lines WHERE ledger_ref_id=? AND COALESCE(status,'active')='active'").get(row.id).c;
  } catch (_) { approvals = 0; }
  if (approvals) {
    block(awErr('این ردیف سند تأیید تغییر بهای فعال (قفل دوره) دارد؛ ابطال آن سند حسابداری را جابه‌جا می‌کند', 409, 'E_ASSIGN_WH_VALUE_APPROVAL', {}));
  }
  let matrix = false;
  try { matrix = require('./movement').hasActiveMatrixVariants(db, pid); } catch (_) { matrix = false; }
  if (matrix && !variantId) {
    block(awErr('کالای رنگ×سایز: واریانت این ردیف از سطر برگشت قابل تشخیص نیست', 409, 'E_ASSIGN_WH_VARIANT_UNKNOWN', {}));
  }

  // ── stock caches (simulated across the batch) ──
  const L = sim.loaders;
  const header = sim.getNum(`h:${pid}`, L.header(pid));
  const sumWs = sim.getNum(`sw:${pid}`, L.sumWs(pid));
  const includes = header - sumWs >= qty - EPS;
  out.header_stock = { before: header, after: header, includes_row: includes };
  out.warehouse_stock_sum = { before: sumWs, after: sumWs };
  out.warehouse_stock = { before: wh ? sim.getNum(`w:${pid}:${wh}`, L.ws(pid, wh)) : null, after: null };
  out.variant = null;
  if (variantId) {
    const pv = sim.getNum(`pv:${variantId}`, L.pv(variantId));
    const sumVws = sim.getNum(`sv:${variantId}`, L.sumVws(variantId));
    const mov = findNullSkuMovement(db, {
      srId: Number(row.source_id), productId: pid, variantId, qty, lineIndex, used: sim.usedMov,
    });
    const mq = mov ? qty : 0;
    const drift = round3(pv - sumVws);
    let mode = null;
    if (Math.abs(drift) < 1e-6) mode = 'pv_eq_vws';
    else if (mov && Math.abs(drift - qty) < 1e-6) mode = 'pv_includes_row';
    if (!mode) {
      block(awErr(`لایهٔ رنگ×سایز واریانت ${variantId} ناهمخوان است (موجودی واریانت ${pv} / جمع انبارها ${sumVws})؛ اول اختلاف را بررسی کنید`,
        409, 'E_ASSIGN_WH_VARIANT_DRIFT', {}));
    }
    out.variant = {
      variant_id: variantId,
      mode,
      null_movement_id: mov ? Number(mov.id) : null,
      pv_heal_qty: mode === 'pv_eq_vws' ? mq : 0,
      pv: { before: pv, after: null },
      vws_sum: { before: sumVws, after: null },
      vws: { before: wh ? sim.getNum(`vw:${variantId}:${wh}`, L.vws(variantId, wh)) : null, after: null },
      _mov: mov,
    };
  }
  const kNull = sim.kx(pid, null);
  out.kardex = { null_bucket: { before: { ...kNull }, after: null }, warehouse: { before: wh ? { ...sim.kx(pid, wh) } : null, after: null } };
  const bNull = sim.bucket(pid, 0);
  out.valuation_buckets = { null_bucket: { before: bucketView(bNull), after: null }, warehouse: { before: wh ? bucketView(sim.bucket(pid, wh)) : null, after: null } };

  out.ready = !out.blocker;
  if (!out.ready) return out;

  // ── apply plan to the simulation (only for ready rows) ──
  if (!includes) out.header_stock.after = sim.addNum(`h:${pid}`, L.header(pid), qty);
  out.warehouse_stock_sum.after = sim.addNum(`sw:${pid}`, L.sumWs(pid), qty);
  out.warehouse_stock.after = sim.addNum(`w:${pid}:${wh}`, L.ws(pid, wh), qty);
  if (out.variant) {
    const v = out.variant;
    if (v._mov) sim.usedMov.add(Number(v._mov.id));
    const pvDelta = (v._mov ? -qty : 0) + qty + v.pv_heal_qty;
    v.pv.after = sim.addNum(`pv:${variantId}`, L.pv(variantId), pvDelta);
    v.vws_sum.after = sim.addNum(`sv:${variantId}`, L.sumVws(variantId), qty);
    v.vws.after = sim.addNum(`vw:${variantId}:${wh}`, L.vws(variantId, wh), qty);
  }
  kNull.qty = round3(kNull.qty - qty);
  kNull.value_rial -= amount;
  out.kardex.null_bucket.after = { ...kNull };
  const kW = sim.kx(pid, wh);
  kW.qty = round3(kW.qty + qty);
  kW.value_rial += amount;
  out.kardex.warehouse.after = { ...kW };
  sim.V.stOut(bNull, qty, amount);
  const bW = sim.bucket(pid, wh);
  sim.V.stIn(bW, qty, amount);
  out.valuation_buckets.null_bucket.after = bucketView(bNull);
  out.valuation_buckets.warehouse.after = bucketView(bW);
  return out;
}

function publicRow(p) {
  if (!p.variant) return p;
  const { _mov, ...v } = p.variant;
  void _mov;
  return { ...p, variant: v };
}

/** Eligible candidates: posted, live sale_return rows without a warehouse. */
function candidateIds(db, limit = BATCH_MAX) {
  return db.prepare(`
    SELECT id FROM inventory_ledger
    WHERE event_type='sale_return' AND source_type='sales_return' AND warehouse_id IS NULL
      AND status='posted' AND reversed_of IS NULL AND COALESCE(qty_in,0)>0
    ORDER BY id LIMIT ?
  `).all(limit).map((r) => Number(r.id));
}

/**
 * Shared compute for preview and post. Read-only.
 * @param {number[]} ids
 * @param {{warehouseId?:number|null, overrides?:object, force?:boolean}} opts
 */
function planBatch(db, ids, { warehouseId = null, overrides = {}, force = false } = {}) {
  const sim = makeSim(db);
  const rows = ids.map((id) => planRow(db, id, { explicitWh: overrides[id] || warehouseId || null, force }, sim));
  const blockers = rows.filter((r) => r.blocker).map((r) => ({ ledger_id: r.ledger_id, ...r.blocker }));
  const byWh = {};
  for (const r of rows) {
    if (!r.ready) continue;
    const k = String(r.warehouse_id);
    byWh[k] = byWh[k] || { warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name, rows: 0, qty: 0, amount_rial: 0 };
    byWh[k].rows += 1;
    byWh[k].qty = round3(byWh[k].qty + r.qty);
    byWh[k].amount_rial += r.amount_rial;
  }
  return {
    ids,
    count: rows.length,
    ready: rows.length > 0 && !blockers.length,
    blockers,
    rows,
    totals: {
      qty: round3(rows.reduce((a, r) => a + (r.qty || 0), 0)),
      amount_rial: rows.reduce((a, r) => a + (r.amount_rial || 0), 0),
      by_warehouse: Object.values(byWh),
    },
    gl_effect_rial: 0,
    warehouse_id: warehouseId || null,
    overrides,
    force: !!force,
  };
}

function previewBatch(db, ids, opts) {
  const plan = planBatch(db, ids, opts);
  return { ...plan, rows: plan.rows.map(publicRow) };
}

function nextDocLine(db, docType, docId) {
  const r = db.prepare('SELECT MAX(doc_line) m FROM inventory_movements WHERE doc_type=? AND doc_id=?').get(docType, docId);
  return r && r.m != null ? Number(r.m) + 1 : 0;
}

function verify(label, got, want) {
  if (want == null) return;
  if (Math.abs(round3(got) - round3(want)) > 1e-6) {
    throw awErr(`ناهمخوانی اجرای تعیین انبار با پیش‌نمایش (${label}: ${got} ≠ ${want})`, 500, 'E_ASSIGN_WH_PLAN_DRIFT', { field: label, got, want });
  }
}

function applyRow(db, p, { reason, date, user }) {
  const L = require('./ledger');
  const M = require('./movement');
  const userId = (user && user.id) || null;
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(p.ledger_id);
  const wh = p.warehouse_id;
  const qty = p.qty;
  const note = `[${TAG}:ledger#${row.id}] تعیین انبار «${p.warehouse_name || wh}» برای برگشت از فروش #${row.source_id} — ${reason}`.slice(0, 300);
  const rev = L.reverseInventoryMovement(db, row.id, { createdBy: userId, date, note, skipStock: true });
  const mv = L.postInventoryMovement(db, {
    eventType: 'sale_return',
    productId: p.product_id,
    warehouseId: wh,
    qtyIn: qty,
    unitCostRial: row.unit_cost_rial,
    amountRial: Math.round(Number(row.amount_rial) || 0),
    sourceType: row.source_type,
    sourceId: row.source_id,
    batchId: row.batch_id || undefined,
    variantId: row.variant_id || null,
    date,
    note,
    createdBy: userId,
    updateAvg: false,
    skipStock: true,
  });
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)').run(p.product_id, wh);
  db.prepare('UPDATE warehouse_stock SET qty=ROUND(qty+?,3) WHERE product_id=? AND warehouse_id=?').run(qty, p.product_id, wh);
  if (!p.header_stock.includes_row) {
    db.prepare('UPDATE products SET stock=ROUND(COALESCE(stock,0)+?,3) WHERE id=?').run(qty, p.product_id);
    try {
      db.prepare('INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)').run(p.product_id, userId || 0, qty, note);
    } catch (_) { /* legacy stock_logs optional */ }
  }
  let skuVoidId = null;
  let skuId = null;
  let healId = null;
  if (p.variant) {
    const v = p.variant;
    if (v._mov) {
      skuVoidId = Number(M.postStockMovement(db, {
        productId: p.product_id, variantId: v.variant_id, warehouseId: null, qtyDelta: -qty,
        docType: `${SKU_DOC}_void`, docId: v._mov.doc_id, docLine: v._mov.doc_line,
        userId, note: `${note} / ابطال لایهٔ بی‌انبار`.slice(0, 300), allowNegative: true, applyHeaderStock: false, writeStockLog: false,
      }).id);
    }
    skuId = Number(M.postVariantLayer(db, {
      productId: p.product_id, variantId: v.variant_id, warehouseId: wh, qtyDelta: qty,
      docType: SKU_DOC, docId: Number(row.source_id), docLine: nextDocLine(db, SKU_DOC, Number(row.source_id)),
      userId, note: `${note} / رنگ×سایز`.slice(0, 300), allowNegative: true,
    }).id);
    if (v.pv_heal_qty > 0) {
      healId = Number(M.postStockMovement(db, {
        productId: p.product_id, variantId: v.variant_id, warehouseId: null, qtyDelta: v.pv_heal_qty,
        docType: PV_HEAL_DOC, docId: Number(mv.id), docLine: 0,
        userId, note: `${note} / هم‌ترازی موجودی واریانت با جمع انبارها`.slice(0, 300),
        allowNegative: true, applyHeaderStock: false, writeStockLog: false,
      }).id);
    }
  }
  const prodNow = db.prepare('SELECT stock FROM products WHERE id=?').get(p.product_id);
  verify('header', prodNow && prodNow.stock, p.header_stock.after);
  const wsNow = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(p.product_id, wh);
  verify('warehouse_stock', wsNow && wsNow.qty, p.warehouse_stock.after);
  if (p.variant) {
    const pvNow = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(p.variant.variant_id);
    verify('variant_stock', pvNow && pvNow.stock, p.variant.pv.after);
    const vwsNow = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(p.variant.variant_id, wh);
    verify('variant_warehouse_stock', vwsNow && vwsNow.qty, p.variant.vws.after);
  }
  return {
    ledger_id: p.ledger_id,
    reversal_id: Number(rev.id),
    reversal_tx_no: rev.tx_no,
    new_ledger_id: Number(mv.id),
    new_tx_no: mv.tx_no,
    sku_void_movement_id: skuVoidId,
    sku_movement_id: skuId,
    pv_heal_movement_id: healId,
  };
}

/**
 * Execute (own transaction, all-or-nothing). Body validated BEFORE any read/write.
 * @param {number[]|null} ids  null ⇒ single-row call with ledgerId
 */
function assignWarehouse(db, { ledgerId = null, body, user, audit, batch = false } = {}) {
  const v = validateBody(body, { batch });
  const ids = batch ? v.ids : [Number(ledgerId) || 0];
  let out;
  db.transaction(() => {
    const plan = planBatch(db, ids, { warehouseId: v.warehouseId, overrides: v.overrides, force: v.force });
    if (plan.blockers.length) {
      const b = plan.blockers[0];
      throw awErr(b.error, b.status || 409, b.code, {
        ledger_id: b.ledger_id,
        assigned_ledger_id: b.assigned_ledger_id || null,
        blockers: plan.blockers,
      });
    }
    const date = v.date || require('../../jalali').todayJalali();
    const results = [];
    for (const p of plan.rows) {
      const r = applyRow(db, p, { reason: v.reason, date, user });
      const pub = publicRow(p);
      results.push({ ...pub, ...r });
      if (typeof audit === 'function') {
        audit((user && user.id) || null, 'ledger_assign_warehouse', 'inventory_ledger', p.ledger_id, JSON.stringify({
          reason: v.reason,
          confirm: true,
          force: !!p.forced,
          batch_ids: ids,
          warehouse_id: p.warehouse_id,
          choice: p.choice,
          derived: { warehouse_id: p.derived.warehouse_id, confidence: p.derived.confidence, source: p.derived.source },
          sales_return_id: p.sales_return_id,
          product_id: p.product_id,
          variant_id: p.variant_id,
          qty: p.qty,
          amount_rial: p.amount_rial,
          reversal_id: r.reversal_id,
          new_ledger_id: r.new_ledger_id,
          header_stock: p.header_stock,
          warehouse_stock: p.warehouse_stock,
          variant: pub.variant,
          kardex: p.kardex,
          valuation_buckets: p.valuation_buckets,
          date,
        }));
      }
    }
    out = {
      ok: true,
      count: results.length,
      date,
      reason: v.reason,
      rows: results,
      totals: plan.totals,
      gl_effect_rial: 0,
      je_posted: false,
    };
  })();
  return out;
}

module.exports = {
  TAG,
  REASON_MIN,
  BATCH_MAX,
  validateBody,
  parseIds,
  parseOverrides,
  parseWarehouseArg,
  deriveWarehouse,
  assertEligible,
  candidateIds,
  planBatch,
  previewBatch,
  assignWarehouse,
};
