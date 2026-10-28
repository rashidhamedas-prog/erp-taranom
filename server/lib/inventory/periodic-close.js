'use strict';
/**
 * Per-warehouse inventory registration method: perpetual | periodic.
 * Periodic close: physical count → ending inventory JE + COGS (BI+Purchases−EI).
 * Reopen (R13): soft-void JE + restore prior_qty from counts_json.
 */

function ensureColumn(db, table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function initWarehouseInventorySystem(db) {
  ensureColumn(db, 'warehouses', 'inventory_system', "TEXT DEFAULT 'perpetual'");
  ensureColumn(db, 'warehouses', 'allow_negative', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'warehouses', 'costing_method', 'TEXT');
  ensureColumn(db, 'warehouses', 'inventory_coa_code', 'TEXT');
  // v585 Phase 1 — leaf COGS account per warehouse (additive, NULL by default; no data UPDATE).
  ensureColumn(db, 'warehouses', 'cogs_coa_code', 'TEXT');
  // v585 — leaf enforcement flag: warn (default) | enforce. INSERT OR IGNORE only.
  try {
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
  } catch (e) {
    console.error('ledger_leaf_enforcement default', e.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_period_closes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL,
      period_label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      beginning_inventory_rial INTEGER NOT NULL DEFAULT 0,
      purchases_rial INTEGER NOT NULL DEFAULT 0,
      ending_inventory_rial INTEGER NOT NULL DEFAULT 0,
      cogs_rial INTEGER NOT NULL DEFAULT 0,
      adjustment_journal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'closed' CHECK(status IN ('draft','closed','reopened')),
      counts_json TEXT,
      note TEXT DEFAULT '',
      closed_by INTEGER,
      closed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(warehouse_id, period_label),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wh_period_closes_wh
      ON warehouse_period_closes(warehouse_id, period_label);
  `);
}

function getWarehouseSystem(db, warehouseId) {
  if (!warehouseId) return 'perpetual';
  const row = db.prepare('SELECT inventory_system FROM warehouses WHERE id=?').get(warehouseId);
  const v = String(row?.inventory_system || 'perpetual').toLowerCase();
  return v === 'periodic' ? 'periodic' : 'perpetual';
}

function isPeriodicWarehouse(db, warehouseId) {
  return getWarehouseSystem(db, warehouseId) === 'periodic';
}

function priorQtyForProduct(db, productId, warehouseId) {
  const ws = db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(productId, warehouseId);
  if (ws && ws.qty != null) return Number(ws.qty) || 0;
  const p = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(productId);
  if (p && Number(p.warehouse_id) === Number(warehouseId)) return Number(p.stock) || 0;
  return 0;
}

/**
 * Close a periodic warehouse period.
 * counts: [{product_id, qty, unit_cost_rial?}]
 * COGS = beginning + purchases − ending.
 */
function closePeriodicWarehouse(db, {
  warehouseId, periodLabel, startDate, endDate, counts, purchasesRial,
  beginningInventoryRial, note, userId, date,
}) {
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouseId);
  if (!wh) throw Object.assign(new Error('انبار یافت نشد'), { status: 404 });
  if (getWarehouseSystem(db, warehouseId) !== 'periodic') {
    throw Object.assign(new Error('این انبار ادواری نیست'), { status: 409, code: 'E_NOT_PERIODIC' });
  }
  const existing = db.prepare(`
    SELECT id FROM warehouse_period_closes
    WHERE warehouse_id=? AND period_label=? AND status='closed'
  `).get(warehouseId, periodLabel);
  if (existing) {
    throw Object.assign(new Error('این دوره قبلاً بسته شده است'), { status: 409, code: 'E_PERIOD_CLOSED' });
  }

  const { postToLedger } = require('../ledger');
  const { acct } = require('../coa-map');
  const { todayJalali } = require('../../jalali');

  let endingRial = 0;
  const normalizedCounts = (counts || []).map(c => {
    const productId = Number(c.product_id);
    const qty = Number(c.qty) || 0;
    const unit = Math.max(0, Math.round(Number(c.unit_cost_rial) || 0));
    const amount = Math.round(qty * unit);
    endingRial += amount;
    return {
      product_id: productId,
      qty,
      unit_cost_rial: unit,
      amount_rial: amount,
      prior_qty: productId ? priorQtyForProduct(db, productId, warehouseId) : 0,
    };
  });

  const beginRial = Math.max(0, Math.round(Number(beginningInventoryRial) || 0));
  const purchRial = Math.max(0, Math.round(Number(purchasesRial) || 0));
  const cogsRial = Math.max(0, beginRial + purchRial - endingRial);

  const { inventoryAccountForWarehouse } = require('./ledger');
  const inv = inventoryAccountForWarehouse(db, warehouseId);
  const cogs = acct(db, 'coa_cogs');
  const gain = acct(db, 'coa_inventory_gain');
  const adj = acct(db, 'coa_adjustment');

  return db.transaction(() => {
    const lines = [];
    if (cogsRial > 0) {
      lines.push({ code: cogs.code, name: cogs.name, debit: cogsRial / 10, credit: 0 });
      lines.push({ code: inv.code, name: inv.name, debit: 0, credit: cogsRial / 10 });
    } else if (endingRial > beginRial + purchRial) {
      const surplus = endingRial - beginRial - purchRial;
      lines.push({ code: inv.code, name: inv.name, debit: surplus / 10, credit: 0 });
      lines.push({ code: gain.code, name: gain.name, debit: 0, credit: surplus / 10 });
    } else if (endingRial !== beginRial && purchRial === 0 && cogsRial === 0) {
      const delta = endingRial - beginRial;
      if (delta > 0) {
        lines.push({ code: inv.code, name: inv.name, debit: delta / 10, credit: 0 });
        lines.push({ code: adj.code, name: adj.name, debit: 0, credit: delta / 10 });
      } else if (delta < 0) {
        lines.push({ code: adj.code, name: adj.name, debit: (-delta) / 10, credit: 0 });
        lines.push({ code: inv.code, name: inv.name, debit: 0, credit: (-delta) / 10 });
      }
    }

    let jeId = null;
    if (lines.length) {
      jeId = postToLedger(db, {
        sourceType: 'warehouse_period_close',
        sourceId: warehouseId,
        date: date || endDate || todayJalali(),
        description: `بستن دوره ادواری انبار ${wh.name} — ${periodLabel}`,
        createdBy: userId,
        lines,
        status: 'approved',
        docType: 'warehouse_period_close',
      });
    }

    for (const c of normalizedCounts) {
      if (!c.product_id) continue;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty)
        VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(c.product_id, warehouseId, c.qty);
      try {
        db.prepare('UPDATE products SET stock=? WHERE id=? AND warehouse_id=?')
          .run(c.qty, c.product_id, warehouseId);
      } catch (_) {}
    }

    const id = db.prepare(`
      INSERT INTO warehouse_period_closes
        (warehouse_id,period_label,start_date,end_date,beginning_inventory_rial,purchases_rial,
         ending_inventory_rial,cogs_rial,adjustment_journal_id,status,counts_json,note,closed_by,closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,'closed',?,?,?,strftime('%s','now'))
      ON CONFLICT(warehouse_id, period_label) DO UPDATE SET
        beginning_inventory_rial=excluded.beginning_inventory_rial,
        purchases_rial=excluded.purchases_rial,
        ending_inventory_rial=excluded.ending_inventory_rial,
        cogs_rial=excluded.cogs_rial,
        adjustment_journal_id=excluded.adjustment_journal_id,
        status='closed',
        counts_json=excluded.counts_json,
        note=excluded.note,
        closed_by=excluded.closed_by,
        closed_at=strftime('%s','now')
    `).run(
      warehouseId, periodLabel, startDate, endDate,
      beginRial, purchRial, endingRial, cogsRial, jeId,
      JSON.stringify(normalizedCounts), note || '', userId
    ).lastInsertRowid;

    return {
      id,
      journal_entry_id: jeId,
      beginning_inventory_rial: beginRial,
      purchases_rial: purchRial,
      ending_inventory_rial: endingRial,
      cogs_rial: cogsRial,
    };
  })();
}

/**
 * R13 reopen: soft-void close JE and restore warehouse_stock from prior_qty.
 */
function reopenPeriodicWarehouse(db, { closeId, reason, userId, date } = {}) {
  const row = db.prepare('SELECT * FROM warehouse_period_closes WHERE id=?').get(closeId);
  if (!row) throw Object.assign(new Error('سند بستن دوره یافت نشد'), { status: 404, code: 'E_CLOSE_NOT_FOUND' });
  if (row.status !== 'closed') {
    throw Object.assign(new Error('فقط دوره بسته‌شده قابل بازگشایی است'), {
      status: 409, code: 'E_NOT_CLOSED',
    });
  }
  if (!String(reason || '').trim()) {
    throw Object.assign(new Error('علت بازگشایی الزامی است'), { status: 422, code: 'E_REASON_REQUIRED' });
  }

  const { reverseJournalEntry } = require('../void-journal');
  const { todayJalali } = require('../../jalali');

  return db.transaction(() => {
    if (row.adjustment_journal_id) {
      reverseJournalEntry(db, row.adjustment_journal_id, {
        userId,
        date: date || todayJalali(),
        reason: String(reason).slice(0, 200),
        sourceType: 'warehouse_period_close',
      });
    }

    let counts = [];
    try { counts = JSON.parse(row.counts_json || '[]') || []; } catch (_) { counts = []; }
    for (const c of counts) {
      const productId = Number(c.product_id);
      if (!productId) continue;
      if (c.prior_qty == null) {
        throw Object.assign(new Error('این بستن دوره prior_qty ندارد و قابل بازگشایی امن نیست'), {
          status: 409, code: 'E_CLOSE_NO_PRIOR_QTY', productId,
        });
      }
      const prior = Number(c.prior_qty) || 0;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty)
        VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(productId, row.warehouse_id, prior);
      try {
        db.prepare('UPDATE products SET stock=? WHERE id=? AND warehouse_id=?')
          .run(prior, productId, row.warehouse_id);
      } catch (_) {}
    }

    const note = `${row.note || ''} [بازگشایی: ${String(reason).slice(0, 120)}]`.trim();
    db.prepare(`
      UPDATE warehouse_period_closes
      SET status='reopened', note=?, adjustment_journal_id=NULL
      WHERE id=?
    `).run(note, closeId);

    return { id: closeId, status: 'reopened', journal_entry_id: row.adjustment_journal_id || null };
  })();
}

module.exports = {
  initWarehouseInventorySystem,
  getWarehouseSystem,
  isPeriodicWarehouse,
  closePeriodicWarehouse,
  reopenPeriodicWarehouse,
};
