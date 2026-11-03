'use strict';
/**
 * Cycle count / stocktaking with accounting integrity (R9 acct, R1 rial, R8 txn).
 *
 * v578 Phase 5 (audit O8):
 *  - system_qty = KARDEX snapshot (Σ live inventory_ledger — same source as Phase 3 kardex closing and
 *    Phase 4 valuation) frozen when the session starts, per product × warehouse × variant.
 *    Apply NEVER re-snaps from live stock: variance = counted − frozen snapshot.
 *  - While a session is open (draft/completed) warehouse docs on that warehouse are locked
 *    (setting `stocktake_move_lock`: lock (default) | warn | off).
 *  - Apply posts a «مغایرت انبارگردانی» adjustment: cycle_count ledger rows (one per variant),
 *    variant layer, and a balanced JE with its OWN accounts (coa_stocktake_loss 6120 /
 *    coa_stocktake_gain 4205) — not the scrap/shortage account 6108.
 *  - Void (R13) reverses ledger rows + variant layer + JE in one transaction.
 */
const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const {
  postInventoryMovement, reverseInventoryMovement, inventoryAccountForWarehouse,
  invErr, allowNegative,
} = require('./ledger');
const { round3, parseQty } = require('../round3');
const { reverseJournalEntry } = require('../void-journal');
const { todayJalali } = require('../../jalali');

/** Adjustment document type created by apply (kardex/JE/ledger wording). */
const STOCKTAKE_DOC_TYPE = 'stocktake_variance';
const STOCKTAKE_DOC_LABEL = 'مغایرت انبارگردانی';
const OPEN_STATUSES = ['draft', 'completed'];
const SNAP_EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Kardex snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frozen-snapshot lines for ONE matrix product in a warehouse, from a kardex snapshot entry
 * (lib/ledgers.kardexSnapshotByProduct). Non-matrix products return [].
 *
 * Per-variant kardex is used when the ledger attributes the whole product quantity to the listed
 * variants (inventory_ledger.variant_id, Phase 2 — new rows only). When legacy header-level rows
 * leave a remainder, per-variant kardex cannot be known: the variant layer value AT SNAPSHOT TIME is
 * frozen instead and flagged snapshot_source='vws_fallback' (never re-read at apply).
 */
function variantSnapshotForProduct(db, productId, warehouseId, snap) {
  const { hasActiveMatrixVariants, variantWarehouseQty } = require('./movement');
  if (!hasActiveMatrixVariants(db, productId)) return [];
  const variants = db.prepare(`
    SELECT pv.id
    FROM product_variants pv
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    WHERE pv.product_id=? AND pv.active=1 AND COALESCE(pv.is_default,0)=0
    ORDER BY pc.sort_order, ps.sort_order, pv.id
  `).all(productId);
  const s = snap || { qty: 0, by_variant: new Map(), unattributed_qty: 0 };
  const listedSum = variants.reduce((acc, v) => acc + (s.by_variant.get(v.id) || 0), 0);
  const attributed = Math.abs((Number(s.qty) || 0) - listedSum) < SNAP_EPS;
  return variants.map((v) => (attributed
    ? { variant_id: v.id, system_qty: round3(s.by_variant.get(v.id) || 0), snapshot_source: 'kardex' }
    : { variant_id: v.id, system_qty: round3(variantWarehouseQty(db, v.id, warehouseId)), snapshot_source: 'vws_fallback' }));
}

/** Back-compat name (used by tests / routes): variant lines with their frozen snapshot. */
function variantLinesForProduct(db, productId, warehouseId, snap) {
  let s = snap;
  if (!s) {
    const { kardexSnapshotByProduct } = require('../ledgers');
    s = kardexSnapshotByProduct(db, { warehouseId, productIds: [productId] }).get(productId);
  }
  return variantSnapshotForProduct(db, productId, warehouseId, s);
}

/**
 * Every product × variant line a count of `warehouseId` must cover, with its kardex snapshot.
 * Candidates = products homed in the warehouse ∪ warehouse_stock rows ≠ 0 ∪ kardex Σ ≠ 0.
 * Read-only.
 */
function buildSnapshotLines(db, warehouseId) {
  const wid = parseInt(warehouseId, 10);
  const { hasActiveMatrixVariants } = require('./movement');
  const { kardexSnapshotByProduct } = require('../ledgers');
  const kmap = kardexSnapshotByProduct(db, { warehouseId: wid });

  const cand = new Set();
  for (const r of db.prepare('SELECT id FROM products WHERE warehouse_id=?').all(wid)) cand.add(r.id);
  for (const r of db.prepare('SELECT product_id FROM warehouse_stock WHERE warehouse_id=? AND COALESCE(qty,0)<>0').all(wid)) cand.add(r.product_id);
  for (const [pid, a] of kmap) {
    if (Math.abs(a.qty) > SNAP_EPS || [...a.by_variant.values()].some((q) => Math.abs(q) > SNAP_EPS)) cand.add(pid);
  }
  if (!cand.size) return [];
  const prods = db.prepare('SELECT id, code, name, unit FROM products ORDER BY name').all().filter((p) => cand.has(p.id));

  const out = [];
  for (const p of prods) {
    const snap = kmap.get(p.id) || { qty: 0, by_variant: new Map(), unattributed_qty: 0 };
    if (hasActiveMatrixVariants(db, p.id)) {
      const vl = variantSnapshotForProduct(db, p.id, wid, snap);
      const names = new Map(db.prepare(`
        SELECT pv.id, pc.name AS color_name, ps.name AS size_name
        FROM product_variants pv
        LEFT JOIN product_colors pc ON pc.id = pv.color_id
        LEFT JOIN product_sizes ps ON ps.id = pv.size_id
        WHERE pv.product_id=?
      `).all(p.id).map((r) => [r.id, r]));
      for (const v of vl) {
        const nm = names.get(v.variant_id) || {};
        out.push({
          product_id: p.id, variant_id: v.variant_id, code: p.code, name: p.name, unit: p.unit,
          color_name: nm.color_name || '', size_name: nm.size_name || '',
          system_qty: v.system_qty, snapshot_source: v.snapshot_source,
        });
      }
      continue;
    }
    out.push({
      product_id: p.id, variant_id: null, code: p.code, name: p.name, unit: p.unit,
      system_qty: round3(snap.qty), snapshot_source: 'kardex',
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle + movement lock
// ─────────────────────────────────────────────────────────────────────────────

function lockMode(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='stocktake_move_lock'").get();
    const v = String((r && r.value) || '').trim().toLowerCase();
    if (v === 'warn' || v === 'off' || v === 'lock') return v;
  } catch (_) { /* settings not ready */ }
  return 'lock';
}

function openSessionsForWarehouse(db, warehouseId) {
  const wid = parseInt(warehouseId, 10);
  if (!wid) return [];
  try {
    return db.prepare(`
      SELECT id, warehouse_id, status, date, snapshot_at FROM stocktaking_sessions
      WHERE warehouse_id=? AND status IN ('draft','completed') ORDER BY id
    `).all(wid);
  } catch (_) { return []; }
}

/**
 * Guard for anything that moves stock in a warehouse. mode lock → 409 E_STOCKTAKE_LOCKED;
 * mode warn → returns { warned:true, sessions } (caller surfaces it, no throw); off → no-op.
 */
function assertWarehouseNotCounting(db, warehouseIds, { label } = {}) {
  const mode = lockMode(db);
  const hits = [];
  if (mode === 'off') return { locked: false, warned: false, mode, sessions: hits };
  for (const w of [...new Set((warehouseIds || []).map((x) => parseInt(x, 10)).filter(Boolean))]) {
    for (const s of openSessionsForWarehouse(db, w)) hits.push(s);
  }
  if (!hits.length) return { locked: false, warned: false, mode, sessions: hits };
  if (mode === 'lock') {
    const ids = hits.map((s) => '#' + s.id).join('، ');
    throw invErr('E_STOCKTAKE_LOCKED', 409, {
      message: `انبار در حال انبارگردانی است (${ids}) — ${label || 'حرکت موجودی'} تا اعمال یا ابطال شمارش مجاز نیست`,
      sessions: hits.map((s) => s.id),
      warehouse_ids: [...new Set(hits.map((s) => s.warehouse_id))],
    });
  }
  return { locked: false, warned: true, mode, sessions: hits };
}

/** Start a count: freeze the kardex snapshot for every product × warehouse × variant line. */
function createSession(db, { warehouseId, date, responsibleUserId, note, createdBy } = {}) {
  const whId = parseInt(warehouseId, 10);
  if (!whId) throw invErr('E_STK_WAREHOUSE_REQUIRED', 400, { message: 'انبار الزامی است' });
  const wh = db.prepare('SELECT id FROM warehouses WHERE id=?').get(whId);
  if (!wh) throw invErr('E_STK_WAREHOUSE_NOT_FOUND', 404, { message: 'انبار یافت نشد' });
  let out;
  db.transaction(() => {
    const open = openSessionsForWarehouse(db, whId);
    if (open.length) {
      throw invErr('E_STK_OPEN_EXISTS', 409, {
        message: `برای این انبار انبارگردانی باز وجود دارد (#${open[0].id}) — ابتدا آن را اعمال یا حذف کنید`,
        session_id: open[0].id,
      });
    }
    const lines = buildSnapshotLines(db, whId);
    const snapAt = new Date().toISOString();
    const res = db.prepare(`
      INSERT INTO stocktaking_sessions
        (warehouse_id,date,responsible_user_id,note,status,created_by,snapshot_at,snapshot_source)
      VALUES (?,?,?,?,'draft',?,?,'kardex')
    `).run(whId, date || todayJalali(), responsibleUserId || createdBy || null, note || '', createdBy || null, snapAt);
    const sessionId = Number(res.lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO stocktaking_items
        (session_id,product_id,variant_id,system_qty,counted_qty,count1_qty,confirmed_count,snapshot_qty,snapshot_source)
      VALUES (?,?,?,?,?,?,1,?,?)
    `);
    for (const l of lines) {
      const sys = round3(l.system_qty || 0);
      ins.run(sessionId, l.product_id, l.variant_id || null, sys, sys, sys, sys, l.snapshot_source);
    }
    out = { id: sessionId, item_count: lines.length, snapshot_at: snapAt, snapshot_source: 'kardex' };
  })();
  return out;
}

/** Frozen snapshot of an item: snapshot_qty when present, else the legacy system_qty (never live). */
function frozenQty(it) {
  if (it.snapshot_qty != null && it.snapshot_qty !== '') return Number(it.snapshot_qty) || 0;
  return Number(it.system_qty) || 0;
}

/**
 * Open sessions must count each color×size.
 * A header-only line on a matrix product is replaced.
 * New lines start counted = snapshot so an untouched sheet does not move stock.
 * (Lines already in the session keep their frozen snapshot untouched.)
 */
function syncSessionVariantLines(db, sessionId) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session || session.status === 'adjusted') return { replaced: 0, added: 0 };
  const { hasActiveMatrixVariants } = require('./movement');
  let replaced = 0;
  let added = 0;
  const run = db.transaction(() => {
    const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=?').all(session.id);
    const byProduct = new Map();
    for (const it of items) {
      if (!byProduct.has(it.product_id)) byProduct.set(it.product_id, []);
      byProduct.get(it.product_id).push(it);
    }
    const ins = db.prepare(`
      INSERT INTO stocktaking_items
        (session_id, product_id, variant_id, system_qty, counted_qty, count1_qty, confirmed_count, snapshot_qty, snapshot_source)
      VALUES (?,?,?,?,?,?,1,?,?)
    `);
    for (const [productId, rows] of byProduct) {
      if (!hasActiveMatrixVariants(db, productId)) continue;
      const wanted = variantLinesForProduct(db, productId, session.warehouse_id);
      const have = new Set(rows.filter((r) => r.variant_id).map((r) => r.variant_id));
      for (const line of wanted) {
        if (have.has(line.variant_id)) continue;
        const sys = round3(line.system_qty);
        ins.run(session.id, productId, line.variant_id, sys, sys, sys, sys, line.snapshot_source);
        added += 1;
      }
      for (const row of rows) {
        if (row.variant_id) continue;
        db.prepare('DELETE FROM stocktaking_items WHERE id=?').run(row.id);
        replaced += 1;
      }
    }
  });
  run();
  return { replaced, added };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply / void
// ─────────────────────────────────────────────────────────────────────────────

function stocktakeAccounts(db) {
  const gain = (() => {
    try { return acct(db, 'coa_stocktake_gain'); } catch { return { code: '4205', name: 'اضافی انبارگردانی' }; }
  })();
  const loss = (() => {
    try { return acct(db, 'coa_stocktake_loss'); } catch { return { code: '6120', name: 'کسری انبارگردانی' }; }
  })();
  return { gain, loss };
}

function applyCycleCount(db, sessionId, { createdBy } = {}) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session) throw invErr('E_STK_NOT_FOUND', 404);
  if (session.status === 'adjusted') throw invErr('E_STK_ALREADY', 409);

  syncSessionVariantLines(db, session.id);
  const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=?').all(session.id);
  let totalGainRial = 0;
  let totalLossRial = 0;
  let movedSinceSnapshot = 0;
  const lineBuckets = new Map(); // acctCode -> {gain, loss, name}

  function bucket(whId) {
    const a = inventoryAccountForWarehouse(db, whId);
    const key = a.code;
    if (!lineBuckets.has(key)) lineBuckets.set(key, { code: a.code, name: a.name, gain: 0, loss: 0 });
    return lineBuckets.get(key);
  }

  db.transaction(() => {
    // Claim apply inside TX — concurrent second apply loses the race.
    const claimed = db.prepare(`
      UPDATE stocktaking_sessions SET status='adjusted'
      WHERE id=? AND COALESCE(status,'')<>'adjusted'
    `).run(session.id);
    if (!claimed.changes) throw invErr('E_STK_ALREADY', 409);
    try {
      const { assertJournalIdempotent } = require('../sales-document');
      assertJournalIdempotent(db, 'stocktaking', session.id);
    } catch (e) {
      if (e && e.code === 'E_JE_DUPLICATE') throw invErr('E_STK_ALREADY', 409);
      throw e;
    }

    const { postApparelLines } = require('./apparel-lines');
    const negOk = allowNegative(db, session.warehouse_id);

    function bookHeader(productId, diff, note, variantId) {
      if (!diff) return null;
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
      if (!prod) return null;
      const { productUnitCostRial } = require('./product-unit-cost');
      const unit = productUnitCostRial(prod);
      if (!unit) {
        throw invErr('E_STK_ZERO_COST', 422, {
          productId,
          message: 'برای اختلاف انبارگردانی باید بهای واحد کالا صفر نباشد',
        });
      }
      const amount = Math.round(Math.abs(diff) * unit);
      const led = postInventoryMovement(db, {
        eventType: 'cycle_count',
        productId,
        warehouseId: session.warehouse_id,
        variantId: variantId || undefined,
        qty: diff,
        unitCostRial: unit,
        amountRial: amount,
        sourceType: 'stocktaking',
        sourceId: session.id,
        date: session.date || '',
        note,
        createdBy,
        updateAvg: diff > 0,
      });
      const b = bucket(session.warehouse_id);
      if (diff > 0) {
        totalGainRial += amount;
        b.gain += amount;
      } else {
        totalLossRial += amount;
        b.loss += amount;
      }
      return { led, unit, amount };
    }

    // How far did the kardex move since the frozen snapshot? (information only — never re-snaps)
    try {
      const { kardexSnapshotByProduct } = require('../ledgers');
      const now = kardexSnapshotByProduct(db, { warehouseId: session.warehouse_id });
      for (const it of items) {
        const cur = now.get(it.product_id);
        if (it.snapshot_source === 'vws_fallback') continue;
        const curQty = !cur ? 0 : (it.variant_id ? (cur.by_variant.get(it.variant_id) || 0) : cur.qty);
        if (Math.abs(curQty - frozenQty(it)) > 0.001) movedSinceSnapshot += 1;
      }
    } catch (_) { movedSinceSnapshot = 0; }

    const tag = `${STOCKTAKE_DOC_LABEL} #${session.id}`;
    for (const it of items) {
      const counted = Math.max(0, parseQty(it.counted_qty));
      const system = frozenQty(it);
      const diff = round3(counted - system);
      if (!diff) continue;
      if (it.variant_id) {
        // Matrix: ledger row carries the variant (kardex per variant) + variant layer.
        const booked = bookHeader(it.product_id, diff, `${tag} — رنگ×سایز`, it.variant_id);
        postApparelLines(db, {
          productId: it.product_id,
          warehouseId: session.warehouse_id,
          lines: [{ variantId: it.variant_id, qty: Math.abs(diff) }],
          docType: 'stocktaking_sku',
          docId: session.id,
          docLineStart: it.id,
          userId: createdBy,
          note: tag,
          sign: diff > 0 ? 1 : -1,
          allowNegative: negOk,
        });
        if (booked) {
          db.prepare(`
            UPDATE stocktaking_items SET unit_cost_rial=?, amount_rial=?, ledger_id=? WHERE id=?
          `).run(booked.unit, booked.amount * Math.sign(diff), booked.led.id, it.id);
        }
        continue;
      }
      const booked = bookHeader(it.product_id, diff, tag);
      if (!booked) continue;
      db.prepare(`
        UPDATE stocktaking_items SET unit_cost_rial=?, amount_rial=?, ledger_id=? WHERE id=?
      `).run(booked.unit, booked.amount * Math.sign(diff), booked.led.id, it.id);
    }

    let jeId = null;
    if (totalGainRial > 0 || totalLossRial > 0) {
      const { gain: gainAcct, loss: lossAcct } = stocktakeAccounts(db);
      const lines = [];
      for (const b of lineBuckets.values()) {
        if (b.gain > 0) {
          lines.push({ code: b.code, name: b.name, debit: b.gain / 10, credit: 0, description: `اضافی ${STOCKTAKE_DOC_LABEL}` });
          lines.push({ code: gainAcct.code, name: gainAcct.name, debit: 0, credit: b.gain / 10, description: `اضافی ${STOCKTAKE_DOC_LABEL}` });
        }
        if (b.loss > 0) {
          lines.push({ code: lossAcct.code, name: lossAcct.name, debit: b.loss / 10, credit: 0, description: `کسری ${STOCKTAKE_DOC_LABEL}` });
          lines.push({ code: b.code, name: b.name, debit: 0, credit: b.loss / 10, description: `کسری ${STOCKTAKE_DOC_LABEL}` });
        }
      }

      if (lines.length) {
        let whCc = null;
        try {
          const { warehouseCostCenterId } = require('../cost-center-policy');
          whCc = warehouseCostCenterId(db, session.warehouse_id);
        } catch (_) { whCc = null; }
        jeId = postToLedger(db, {
          sourceType: 'stocktaking',
          sourceId: session.id,
          date: session.date || '',
          description: `سند ${tag}`,
          createdBy,
          costCenterId: whCc,
          warehouseId: session.warehouse_id,
          lines,
        });
        db.prepare('UPDATE inventory_ledger SET je_id=? WHERE source_type=? AND source_id=?')
          .run(jeId, 'stocktaking', session.id);
      }
    }

    db.prepare(`
      UPDATE stocktaking_sessions
      SET status='adjusted', approved_by=?, approved_at=strftime('%s','now'),
          je_id=?, total_gain_rial=?, total_loss_rial=?
      WHERE id=?
    `).run(createdBy, jeId, totalGainRial, totalLossRial, session.id);
  })();

  return {
    ok: true,
    doc_type: STOCKTAKE_DOC_TYPE,
    doc_label: STOCKTAKE_DOC_LABEL,
    total_gain_rial: totalGainRial,
    total_loss_rial: totalLossRial,
    moved_since_snapshot: movedSinceSnapshot,
  };
}

/** Full reverse of an applied stocktaking (R13): inventory ledgers + JE + session → completed. */
function voidCycleCount(db, sessionId, { createdBy } = {}) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session) throw invErr('E_STK_NOT_FOUND', 404);
  if (session.status !== 'adjusted') {
    const err = new Error('فقط انبارگردانی اعمال‌شده قابل ابطال است');
    err.status = 400;
    throw err;
  }

  db.transaction(() => {
    const leds = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type='stocktaking' AND source_id=? AND COALESCE(status,'posted')='posted'
        AND reversed_of IS NULL AND COALESCE(event_type,'') <> 'reversal'
      ORDER BY id DESC
    `).all(session.id);
    for (const l of leds) {
      reverseInventoryMovement(db, l.id, {
        createdBy,
        date: todayJalali(),
        note: `ابطال ${STOCKTAKE_DOC_LABEL} #${session.id}`,
      });
    }
    require('./apparel-lines').reverseApparelDoc(db, {
      docType: 'stocktaking_sku',
      docId: session.id,
      userId: createdBy,
      note: `ابطال ${STOCKTAKE_DOC_LABEL} #${session.id}`,
    });
    if (session.je_id) {
      reverseJournalEntry(db, session.je_id, {
        userId: createdBy,
        reason: `ابطال ${STOCKTAKE_DOC_LABEL} #${session.id}`,
        sourceType: 'stocktaking_reversal',
      });
    }
    db.prepare(`
      UPDATE stocktaking_items SET ledger_id=NULL, unit_cost_rial=NULL, amount_rial=NULL WHERE session_id=?
    `).run(session.id);
    db.prepare(`
      UPDATE stocktaking_sessions
      SET status='completed', je_id=NULL, total_gain_rial=0, total_loss_rial=0,
          approved_by=NULL, approved_at=NULL
      WHERE id=?
    `).run(session.id);
  })();

  return { ok: true };
}

module.exports = {
  STOCKTAKE_DOC_TYPE,
  STOCKTAKE_DOC_LABEL,
  OPEN_STATUSES,
  applyCycleCount,
  voidCycleCount,
  createSession,
  buildSnapshotLines,
  syncSessionVariantLines,
  variantLinesForProduct,
  variantSnapshotForProduct,
  frozenQty,
  lockMode,
  openSessionsForWarehouse,
  assertWarehouseNotCounting,
  stocktakeAccounts,
};
