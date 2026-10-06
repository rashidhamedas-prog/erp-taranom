'use strict';

/**
 * Cost-center ownership repair.
 * A document center is copied onto journal lines that have none.
 * Overhead-tagged payments that hit period expense (61xx, except bank fee)
 * are moved to overhead control 5202. Warehouse rows without a center
 * take the unit default. Safe to re-run the warehouse fill; the journal
 * repair itself is one-shot.
 */

const CODE_BY_WAREHOUSE = {
  'WH-RAW': 'CC-WORKSHOP',
  'WH-FG': 'CC-90',
  'WH-WORKSHOP': 'CC-WORKSHOP',
  'WH-DIST': 'CC-DISTRIBUTION',
  'WH-DIST-FG': 'CC-DISTRIBUTION',
  'WH-SUB': 'CC-WORKSHOP',
  'WH-SCRAP': 'CC-WORKSHOP',
};

const DOC_SOURCES = [
  ['expense_payment', 'expense_payments'],
  ['invoice', 'invoices'],
  ['invoice_cogs', 'invoices'],
  ['purchase', 'purchase_invoices'],
  ['rep_expense', 'rep_expenses'],
  ['commission_accrual_invoice', 'invoices'],
];

const ORDER_REF_TYPES = [
  'production_material_issue',
  'production_material_return',
  'production_labor',
  'production_labor_actual',
  'production_overhead',
  'production_overhead_actual',
  'production_receipt',
  'production_rework',
  'production_byproduct',
  'production_subcontract_out',
  'production_subcontract_in',
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function activeCenterId(db, code) {
  if (!code || !tableExists(db, 'cost_centers')) return null;
  return db.prepare(
    'SELECT id FROM cost_centers WHERE code=? AND COALESCE(active,1)=1'
  ).get(code)?.id || null;
}

function defaultCostCenterId(db, { entity, code } = {}) {
  let ccCode = code && CODE_BY_WAREHOUSE[code];
  if (!ccCode) {
    const ent = String(entity || '');
    if (ent === 'distribution_office' || ent === 'sales') ccCode = 'CC-DISTRIBUTION';
    else if (ent === 'workshop' || ent === 'production' || ent === 'admin') ccCode = 'CC-WORKSHOP';
  }
  return activeCenterId(db, ccCode);
}

function fillNullWarehouseCostCenters(db) {
  if (!hasColumn(db, 'warehouses', 'cost_center_id')) return 0;
  const rows = db.prepare(
    'SELECT id, code, entity FROM warehouses WHERE cost_center_id IS NULL'
  ).all();
  const upd = db.prepare('UPDATE warehouses SET cost_center_id=? WHERE id=? AND cost_center_id IS NULL');
  let n = 0;
  for (const row of rows) {
    const cc = defaultCostCenterId(db, row);
    if (cc) n += upd.run(cc, row.id).changes;
  }
  return n;
}

function requireCostCenter(db, costCenterId) {
  const id = parseInt(costCenterId, 10);
  if (!id) return null;
  const row = db.prepare('SELECT id FROM cost_centers WHERE id=? AND COALESCE(active,1)=1').get(id);
  if (!row) {
    const err = new Error('مرکز هزینه یافت نشد یا غیرفعال است');
    err.status = 400;
    throw err;
  }
  return id;
}

function resolveWarehouseCostCenter(db, { cost_center_id, entity, code } = {}) {
  if (cost_center_id) return requireCostCenter(db, cost_center_id);
  return defaultCostCenterId(db, { entity, code });
}

function stampFromTable(db, refType, table) {
  if (!hasColumn(db, table, 'cost_center_id') || !tableExists(db, 'journal_lines')) {
    return { lines: 0, headers: 0 };
  }
  const lines = db.prepare(`
    UPDATE journal_lines
    SET cost_center_id = (
      SELECT src.cost_center_id
      FROM journal_entries je
      JOIN ${table} src ON src.id = je.ref_id
      WHERE je.id = journal_lines.entry_id AND je.ref_type = ?
        AND src.cost_center_id IS NOT NULL
    )
    WHERE cost_center_id IS NULL
      AND EXISTS (
        SELECT 1 FROM journal_entries je
        JOIN ${table} src ON src.id = je.ref_id
        WHERE je.id = journal_lines.entry_id AND je.ref_type = ?
          AND src.cost_center_id IS NOT NULL
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).run(refType, refType).changes;
  const headers = db.prepare(`
    UPDATE journal_entries
    SET cost_center_id = (
      SELECT src.cost_center_id FROM ${table} src WHERE src.id = journal_entries.ref_id
    )
    WHERE cost_center_id IS NULL AND ref_type = ?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
      AND EXISTS (
        SELECT 1 FROM ${table} src
        WHERE src.id = journal_entries.ref_id AND src.cost_center_id IS NOT NULL
      )
  `).run(refType).changes;
  return { lines, headers };
}

function stampOrderEvents(db) {
  if (!tableExists(db, 'production_orders') || !hasColumn(db, 'production_orders', 'cost_center_id')) {
    return 0;
  }
  let n = 0;
  for (const refType of ORDER_REF_TYPES) {
    n += stampFromTable(db, refType, 'production_orders').lines;
    n += stampFromTable(db, refType, 'production_orders').headers;
  }
  if (tableExists(db, 'production_waste')) {
    const waste = stampFromTable(db, 'production_waste', 'production_waste');
    n += waste.lines + waste.headers;
  }
  return n;
}

function stampWarehouseJournals(db) {
  if (!tableExists(db, 'warehouse_moves') || !hasColumn(db, 'warehouses', 'cost_center_id')) return 0;
  if (!hasColumn(db, 'journal_lines', 'cost_center_id')) return 0;
  let n = 0;
  n += db.prepare(`
    UPDATE journal_lines SET cost_center_id = (
      SELECT w.cost_center_id FROM journal_entries je
      JOIN warehouse_moves m ON m.id = je.ref_id
      JOIN warehouses w ON w.id = m.to_warehouse_id
      WHERE je.id = journal_lines.entry_id
    )
    WHERE cost_center_id IS NULL
      AND EXISTS (
        SELECT 1 FROM journal_entries je
        JOIN warehouse_moves m ON m.id = je.ref_id
        JOIN warehouses w ON w.id = m.to_warehouse_id
        WHERE je.id = journal_lines.entry_id
          AND w.cost_center_id IS NOT NULL
          AND je.ref_type IN ('warehouse_receipt_batch','opening_inventory')
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).run().changes;
  n += db.prepare(`
    UPDATE journal_lines SET cost_center_id = (
      SELECT w.cost_center_id FROM journal_entries je
      JOIN warehouse_moves m ON m.id = je.ref_id
      JOIN warehouses w ON w.id = m.from_warehouse_id
      WHERE je.id = journal_lines.entry_id
    )
    WHERE cost_center_id IS NULL
      AND EXISTS (
        SELECT 1 FROM journal_entries je
        JOIN warehouse_moves m ON m.id = je.ref_id
        JOIN warehouses w ON w.id = m.from_warehouse_id
        WHERE je.id = journal_lines.entry_id
          AND w.cost_center_id IS NOT NULL
          AND je.ref_type = 'warehouse_issue_batch'
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).run().changes;
  n += db.prepare(`
    UPDATE journal_lines SET cost_center_id = (
      SELECT w.cost_center_id FROM journal_entries je
      JOIN warehouse_moves m ON m.id = je.ref_id
      JOIN warehouses w ON w.id = CASE WHEN journal_lines.debit > 0 THEN m.to_warehouse_id ELSE m.from_warehouse_id END
      WHERE je.id = journal_lines.entry_id
    )
    WHERE cost_center_id IS NULL
      AND EXISTS (
        SELECT 1 FROM journal_entries je
        JOIN warehouse_moves m ON m.id = je.ref_id
        JOIN warehouses w ON w.id = CASE WHEN journal_lines.debit > 0 THEN m.to_warehouse_id ELSE m.from_warehouse_id END
        WHERE je.id = journal_lines.entry_id
          AND w.cost_center_id IS NOT NULL
          AND je.ref_type = 'warehouse_transfer_batch'
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).run().changes;
  return n;
}

function reclassOverheadPayments(db) {
  if (!tableExists(db, 'expense_payments') || !hasColumn(db, 'expense_payments', 'is_overhead')) return 0;
  const acct = db.prepare("SELECT code, name FROM chart_of_accounts WHERE code='5202'").get()
    || { code: '5202', name: 'کنترل سربار ساخت' };
  const lines = db.prepare(`
    UPDATE journal_lines
    SET account_code=?, account_name=?
    WHERE id IN (
      SELECT jl.id FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN expense_payments ep ON je.ref_type='expense_payment' AND je.ref_id=ep.id
      WHERE COALESCE(ep.is_overhead,0)=1
        AND COALESCE(ep.status,'posted')<>'reversed'
        AND COALESCE(je.deleted_at,0)=0
        AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        AND jl.debit > 0
        AND jl.account_code LIKE '61%'
        AND jl.account_code <> '6115'
    )
  `).run(acct.code, acct.name).changes;
  db.prepare(`
    UPDATE expense_payments SET account_code=?
    WHERE COALESCE(is_overhead,0)=1
      AND COALESCE(status,'posted')<>'reversed'
      AND account_code LIKE '61%'
      AND account_code <> '6115'
  `).run(acct.code);
  return lines;
}

function fillSiblingCenters(db) {
  if (!tableExists(db, 'journal_lines')) return 0;
  return db.prepare(`
    UPDATE journal_lines
    SET cost_center_id = (
      SELECT MIN(jl2.cost_center_id) FROM journal_lines jl2
      WHERE jl2.entry_id = journal_lines.entry_id AND jl2.cost_center_id IS NOT NULL
    )
    WHERE cost_center_id IS NULL
      AND (
        SELECT COUNT(DISTINCT jl3.cost_center_id) FROM journal_lines jl3
        WHERE jl3.entry_id = journal_lines.entry_id AND jl3.cost_center_id IS NOT NULL
      ) = 1
      AND EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.id = journal_lines.entry_id
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).run().changes;
}

function repairHistoricalCostLinks(db) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='cost_center_journal_repair_v317'").get();
  const warehouses = fillNullWarehouseCostCenters(db);
  if (flag && flag.value === '1') return { skipped: true, warehouses };
  let lines = 0;
  let headers = 0;
  for (const [refType, table] of DOC_SOURCES) {
    const stamped = stampFromTable(db, refType, table);
    lines += stamped.lines;
    headers += stamped.headers;
  }
  lines += stampOrderEvents(db);
  lines += stampWarehouseJournals(db);
  const overhead = reclassOverheadPayments(db);
  lines += fillSiblingCenters(db);
  headers += db.prepare(`
    UPDATE journal_entries
    SET cost_center_id = (
      SELECT MIN(jl.cost_center_id) FROM journal_lines jl
      WHERE jl.entry_id = journal_entries.id AND jl.cost_center_id IS NOT NULL
    )
    WHERE cost_center_id IS NULL
      AND COALESCE(deleted_at,0)=0
      AND (
        SELECT COUNT(DISTINCT jl.cost_center_id) FROM journal_lines jl
        WHERE jl.entry_id = journal_entries.id AND jl.cost_center_id IS NOT NULL
      ) = 1
  `).run().changes;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('cost_center_journal_repair_v317','1')").run();
  return { skipped: false, warehouses, lines, headers, overhead };
}

module.exports = {
  defaultCostCenterId,
  resolveWarehouseCostCenter,
  requireCostCenter,
  fillNullWarehouseCostCenters,
  repairHistoricalCostLinks,
};
