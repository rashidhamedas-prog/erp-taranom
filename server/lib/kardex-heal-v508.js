'use strict';
/**
 * v508 — one stock ledger. Two historical defects are repaired with documents,
 * never by aligning one book to another:
 *  1. «هم‌ترازی» pairs: an opening seed and a later stock_reconcile of the same
 *     product/warehouse/qty that cancel each other — both reversed (R12).
 *  2. Multi-colour invoice amend (pre-v508) kept only one colour's qty in
 *     inventory_ledger and COGS while warehouse stock moved for every colour.
 *     The missing sale qty is posted (skipStock) with its COGS voucher.
 */
const { acct } = require('./coa-map');
const { rialToLedger } = require('./money');
const { todayJalali } = require('../jalali');

const SETTING_KEY = 'kardex_single_ledger_v508';

function adminId(db) {
  return db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || 1;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function findNettingAlignPairs(db) {
  const recs = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE source_type='stock_reconcile' AND status='posted' AND je_id IS NULL
      AND qty_out > 0 AND COALESCE(reversed_of,0)=0
    ORDER BY id
  `).all();
  const used = new Set();
  const pairs = [];
  for (const rec of recs) {
    const seeds = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE source_type='opening_inventory' AND status='posted' AND je_id IS NULL
        AND product_id=? AND IFNULL(warehouse_id,0)=IFNULL(?,0)
        AND ABS(qty_in - ?) < 1e-6 AND qty_out=0 AND COALESCE(reversed_of,0)=0
      ORDER BY CASE WHEN ABS(amount_rial - ?) < 1 THEN 0 ELSE 1 END, id DESC
    `).all(rec.product_id, rec.warehouse_id, rec.qty_out, rec.amount_rial);
    const seed = seeds.find((s) => !used.has(s.id));
    if (!seed) continue;
    used.add(seed.id);
    pairs.push({ seed, rec });
  }
  return pairs;
}

function stockableRow(r) {
  return !!(r && r.product_id && r.row_type !== 'income' && r.item_kind !== 'service' && !r.batch_id);
}

function findShortInvoiceLedger(db) {
  const invoices = db.prepare(`
    SELECT id, num, date, rows, warehouse_id, cost_center_id FROM invoices
    WHERE COALESCE(deleted_at,0)=0 AND COALESCE(stock_deducted,0)=1
      AND COALESCE(status,'posted') NOT IN ('reversed','void','cancelled')
    ORDER BY id
  `).all();
  const out = [];
  for (const inv of invoices) {
    let rows = [];
    try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
    const doc = new Map();
    for (const r of rows.filter(stockableRow)) {
      let wh = parseInt(r.warehouse_id, 10) || parseInt(inv.warehouse_id, 10) || 0;
      if (!wh) {
        wh = Number(db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(r.product_id)?.warehouse_id) || 0;
      }
      const k = `${Number(r.product_id)}|${wh}`;
      doc.set(k, (doc.get(k) || 0) + (Number(r.qty) || 0));
    }
    for (const [k, docQty] of doc) {
      const [pid, wh] = k.split('|').map(Number);
      const led = db.prepare(`
        SELECT COALESCE(SUM(qty_out - qty_in),0) AS q,
               MAX(CASE WHEN unit_cost_rial > 0 THEN unit_cost_rial END) AS unit
        FROM inventory_ledger
        WHERE source_type='invoice' AND source_id=? AND product_id=?
          AND IFNULL(warehouse_id,0)=? AND status='posted'
      `).get(inv.id, pid, wh);
      const ledQty = Number(led?.q) || 0;
      // Only invoices that already have ledger rows for this item: a fully
      // missing item is a different defect (periodic WH / pre-ledger era).
      if (!ledQty) continue;
      const missing = Math.round((docQty - ledQty) * 1000) / 1000;
      if (missing > 1e-6) {
        out.push({ inv, product_id: pid, warehouse_id: wh || null, missing, unit: Number(led?.unit) || 0 });
      }
    }
  }
  return out;
}

function postCogsFix(db, { inv, warehouseId, amountRial, userId }) {
  const { inventoryAccountForWarehouse } = require('./inventory/ledger');
  const { postToLedger } = require('./ledger');
  const cogs = acct(db, 'coa_cogs');
  const invAcct = inventoryAccountForWarehouse(db, warehouseId);
  const L = rialToLedger(amountRial);
  if (!(L > 0)) return null;
  const base = {
    sourceType: 'invoice_cogs_fix',
    sourceId: inv.id,
    description: `تکمیل بهای تمام‌شده فاکتور ${inv.num}`,
    createdBy: userId,
    costCenterId: inv.cost_center_id || null,
    lines: [
      { code: cogs.code, name: cogs.name, debit: L, credit: 0 },
      { code: invAcct.code, name: invAcct.name, debit: 0, credit: L },
    ],
  };
  try {
    return postToLedger(db, { ...base, date: inv.date || todayJalali() });
  } catch (e) {
    if (e && e.status === 422) return postToLedger(db, { ...base, date: todayJalali() });
    throw e;
  }
}

function healKardexSingleLedger(db, { apply = false, force = false } = {}) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  if (!hasTable(db, 'inventory_ledger') || !hasTable(db, 'invoices')) return { skipped: true };
  if (apply && !force) {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING_KEY);
    if (done && done.value) return { skipped: true, reason: 'done' };
  }
  const pairs = findNettingAlignPairs(db);
  const short = findShortInvoiceLedger(db);
  const report = {
    align_pairs: pairs.length,
    invoice_lines: short.length,
    invoice_qty: short.reduce((s, x) => s + x.missing, 0),
    cogs_vouchers: 0,
    cogs_rial: 0,
  };
  if (!apply) return { ...report, pairs, short };

  const { reverseInventoryMovement, postInventoryMovement } = require('./inventory/ledger');
  const { rebuildAllStockCaches } = require('./inventory/stock-cache');
  const { warehouseUsesPerpetualValuation } = require('./sales-document');
  const uid = adminId(db);
  db.transaction(() => {
    const touchedProducts = new Set();
    for (const { seed, rec } of pairs) {
      touchedProducts.add(Number(seed.product_id));
      reverseInventoryMovement(db, rec.id, {
        createdBy: uid, date: rec.date, note: `ابطال جفت تعدیل خنثی (${rec.tx_no})`,
      });
      reverseInventoryMovement(db, seed.id, {
        createdBy: uid, date: seed.date, note: `ابطال جفت تعدیل خنثی (${seed.tx_no})`,
      });
    }
    const perInvWh = new Map();
    for (const s of short) {
      touchedProducts.add(Number(s.product_id));
      const mv = postInventoryMovement(db, {
        eventType: 'sale',
        productId: s.product_id,
        warehouseId: s.warehouse_id,
        qtyOut: s.missing,
        unitCostRial: s.unit || undefined,
        sourceType: 'invoice',
        sourceId: s.inv.id,
        date: s.inv.date || '',
        note: `فروش ${s.inv.num}`,
        createdBy: uid,
        skipStock: true,
        updateAvg: false,
      });
      const k = `${s.inv.id}|${s.warehouse_id || 0}`;
      const prev = perInvWh.get(k) || { inv: s.inv, warehouseId: s.warehouse_id, amount: 0 };
      prev.amount += Math.round(Number(mv.amount_rial) || 0);
      perInvWh.set(k, prev);
    }
    for (const g of perInvWh.values()) {
      if (g.amount <= 0) continue;
      if (!warehouseUsesPerpetualValuation(db, g.warehouseId)) continue;
      const hadCogs = db.prepare(`
        SELECT 1 FROM journal_entries
        WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0 LIMIT 1
      `).get(g.inv.id);
      if (!hadCogs) continue;
      if (postCogsFix(db, { inv: g.inv, warehouseId: g.warehouseId, amountRial: g.amount, userId: uid })) {
        report.cogs_vouchers += 1;
        report.cogs_rial += g.amount;
      }
    }
    rebuildAllStockCaches(db, { productIds: [...touchedProducts] });
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run(SETTING_KEY, JSON.stringify({ ok: 1, ...report, at: new Date().toISOString() }));
  })();
  return report;
}

const AGREE_KEY = 'kardex_books_agree_v508b';

function wipWarehouseSet(db) {
  return new Set(db.prepare(
    "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
  ).all().map((w) => Number(w.id)));
}

const eq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-6;

/**
 * Old boot «هم‌ترازی» posted opening seeds / stock_reconcile rows (no voucher)
 * to chase a wrong warehouse_stock. Where the variant book — kept independently
 * by every document — agrees with the ledger's document rows, those align rows
 * are reversed and warehouse_stock is corrected to the agreed quantity. Items
 * where the books disagree are left for a stock count (book_gap_qty warning).
 */
function findAgreedBookFixes(db) {
  if (!hasTable(db, 'variant_warehouse_stock') || !hasTable(db, 'product_variants')) return [];
  const wip = wipWarehouseSet(db);
  const groups = db.prepare(`
    SELECT product_id, warehouse_id, SUM(qty_in - qty_out) AS led
    FROM inventory_ledger WHERE status='posted' AND warehouse_id IS NOT NULL
    GROUP BY product_id, warehouse_id
  `).all();
  const out = [];
  for (const g of groups) {
    if (wip.has(Number(g.warehouse_id))) continue;
    const hasVar = db.prepare('SELECT 1 FROM product_variants WHERE product_id=? LIMIT 1').get(g.product_id);
    if (!hasVar) continue;
    const ws = Number(db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(g.product_id, g.warehouse_id)?.qty) || 0;
    if (eq(g.led, ws)) continue;
    const vws = Number(db.prepare(`
      SELECT COALESCE(SUM(vw.qty),0) AS q FROM variant_warehouse_stock vw
      JOIN product_variants pv ON pv.id=vw.variant_id
      WHERE pv.product_id=? AND vw.warehouse_id=?
    `).get(g.product_id, g.warehouse_id)?.q) || 0;
    const alignRows = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND warehouse_id=? AND status='posted' AND je_id IS NULL
        AND COALESCE(reversed_of,0)=0
        AND (source_type='stock_reconcile'
             OR (source_type='opening_inventory' AND event_type='opening'))
      ORDER BY id
    `).all(g.product_id, g.warehouse_id);
    const alignNet = alignRows.reduce((s, r) => s + (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0), 0);
    const docs = (Number(g.led) || 0) - alignNet;
    if (alignRows.length && eq(docs, vws)) {
      out.push({ product_id: g.product_id, warehouse_id: g.warehouse_id, ws, target: vws, alignRows });
    } else if (eq(g.led, vws)) {
      out.push({ product_id: g.product_id, warehouse_id: g.warehouse_id, ws, target: vws, alignRows: [] });
    }
  }
  return out;
}

function healAgreedBooks(db, { apply = false, force = false } = {}) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  if (!hasTable(db, 'inventory_ledger') || !hasTable(db, 'warehouse_stock')) return { skipped: true };
  if (apply && !force) {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(AGREE_KEY);
    if (done && done.value) return { skipped: true, reason: 'done' };
  }
  const fixes = findAgreedBookFixes(db);
  const report = {
    items: fixes.length,
    align_rows: fixes.reduce((s, f) => s + f.alignRows.length, 0),
    ws_delta: fixes.reduce((s, f) => s + (f.target - f.ws), 0),
  };
  if (!apply) return { ...report, fixes };
  const { reverseInventoryMovement } = require('./inventory/ledger');
  const { rebuildAllStockCaches } = require('./inventory/stock-cache');
  const uid = adminId(db);
  db.transaction(() => {
    const productIds = new Set();
    for (const f of fixes) {
      productIds.add(Number(f.product_id));
      for (const r of f.alignRows) {
        reverseInventoryMovement(db, r.id, {
          createdBy: uid, date: r.date, note: `ابطال تعدیل بی‌سند (${r.tx_no})`,
        });
      }
    }
    rebuildAllStockCaches(db, { productIds: [...productIds] });
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run(AGREE_KEY, JSON.stringify({ ok: 1, ...report, at: new Date().toISOString() }));
  })();
  return report;
}

/** Ledger closing vs warehouse_stock per physical (non-WIP) product/warehouse. */
function ledgerWarehouseDrift(db) {
  const wip = new Set(db.prepare(
    "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
  ).all().map((w) => Number(w.id)));
  const led = db.prepare(`
    SELECT product_id, warehouse_id, SUM(qty_in - qty_out) AS q FROM inventory_ledger
    WHERE status='posted' GROUP BY product_id, warehouse_id
  `).all();
  const ws = db.prepare('SELECT product_id, warehouse_id, qty FROM warehouse_stock').all();
  const m = new Map();
  for (const r of led) {
    if (wip.has(Number(r.warehouse_id))) continue;
    m.set(`${r.product_id}:${r.warehouse_id}`, { product_id: r.product_id, warehouse_id: r.warehouse_id, ledger: Number(r.q) || 0, ws: 0 });
  }
  for (const r of ws) {
    if (wip.has(Number(r.warehouse_id))) continue;
    const k = `${r.product_id}:${r.warehouse_id}`;
    const e = m.get(k) || { product_id: r.product_id, warehouse_id: r.warehouse_id, ledger: 0, ws: 0 };
    e.ws = Number(r.qty) || 0;
    m.set(k, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e, gap: Math.round((e.ledger - e.ws) * 1000) / 1000 }))
    .filter((e) => Math.abs(e.gap) > 1e-6);
}

module.exports = {
  healKardexSingleLedger,
  findNettingAlignPairs,
  findShortInvoiceLedger,
  findAgreedBookFixes,
  healAgreedBooks,
  ledgerWarehouseDrift,
  SETTING_KEY,
  AGREE_KEY,
};
