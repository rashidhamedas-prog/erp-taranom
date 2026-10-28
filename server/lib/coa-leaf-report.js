'use strict';
/**
 * Phase 1 — read-only leaf-mapping report (used by the admin UI and
 * scripts/report-coa-leaf-mapping.js). Never writes to the DB.
 */

const { LEGACY, isPostableCode } = require('./coa-map');
const policy = require('./coa-leaf-policy');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function hasCol(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function warehouseRows(db) {
  if (!hasTable(db, 'warehouses')) return [];
  const cogsCol = hasCol(db, 'warehouses', 'cogs_coa_code') ? 'cogs_coa_code' : 'NULL AS cogs_coa_code';
  const sysCol = hasCol(db, 'warehouses', 'inventory_system') ? 'inventory_system' : "'perpetual' AS inventory_system";
  const invCol = hasCol(db, 'warehouses', 'inventory_coa_code') ? 'inventory_coa_code' : 'NULL AS inventory_coa_code';
  return db.prepare(
    `SELECT id, name, code, warehouse_type, ${sysCol}, ${invCol}, ${cogsCol}, active FROM warehouses ORDER BY id`,
  ).all();
}

function settingsNonLeaf(db) {
  if (!hasTable(db, 'settings') || !hasTable(db, 'chart_of_accounts')) return [];
  const overrides = new Map(
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'coa\\_%' ESCAPE '\\'").all()
      .map((r) => [r.key, String(r.value || '').trim()]),
  );
  const out = [];
  for (const key of Object.keys(LEGACY)) {
    const code = overrides.get(key) || LEGACY[key].code;
    if (!code) continue;
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
    if (!row) {
      out.push({ key, code, name: null, reason: 'not_found', source: overrides.get(key) ? 'settings' : 'default' });
    } else if (!isPostableCode(db, code)) {
      out.push({ key, code, name: row.name, reason: 'not_leaf', source: overrides.get(key) ? 'settings' : 'default' });
    }
  }
  return out;
}

function nonLeafBalances(db) {
  if (!hasTable(db, 'journal_lines') || !hasTable(db, 'journal_entries') || !hasTable(db, 'chart_of_accounts')) return [];
  const jeCols = new Set(db.prepare('PRAGMA table_info(journal_entries)').all().map((c) => c.name));
  const live = [
    jeCols.has('deleted_at') ? 'COALESCE(je.deleted_at,0)=0' : null,
    jeCols.has('status') ? "COALESCE(je.status,'approved') NOT IN ('reversed','void')" : null,
  ].filter(Boolean).join(' AND ') || '1=1';
  const rows = db.prepare(`
    SELECT jl.account_code AS code, COUNT(*) AS line_count,
           COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS debit_rial,
           COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit_rial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${live}
    GROUP BY jl.account_code
  `).all();
  const out = [];
  for (const r of rows) {
    if (isPostableCode(db, r.code)) continue;
    const acc = db.prepare('SELECT name FROM chart_of_accounts WHERE code=?').get(r.code);
    out.push({
      code: r.code,
      name: acc ? acc.name : null,
      line_count: r.line_count,
      debit_rial: Math.round(r.debit_rial),
      credit_rial: Math.round(r.credit_rial),
      balance_rial: Math.round(r.debit_rial - r.credit_rial),
    });
  }
  out.sort((a, b) => Math.abs(b.balance_rial) - Math.abs(a.balance_rial));
  return out;
}

function buildCoaLeafReport(db) {
  const mode = policy.leafEnforcementMode(db);
  const whs = warehouseRows(db).map((w) => ({
    ...policy.warehouseMappingStatus(db, w),
  }));
  const needing = whs.filter((w) => w.perpetual && !w.mapped);
  const fixedAssetUnmapped = whs.filter((w) => w.fixed_asset_type && !w.inventory_ok);
  const sett = settingsNonLeaf(db);
  const bal = nonLeafBalances(db);
  return {
    generated_at: new Date().toISOString(),
    flag: { key: policy.FLAG_KEY, value: mode },
    warehouses: whs,
    warehouses_unmapped: needing,
    fixed_asset_unmapped: fixedAssetUnmapped,
    settings_nonleaf: sett,
    nonleaf_balances: bal,
    recent_warnings: policy.recentLeafIssues().slice(0, 50),
    summary: {
      warehouses_total: whs.length,
      warehouses_perpetual_unmapped: needing.length,
      settings_nonleaf: sett.length,
      nonleaf_accounts_with_lines: bal.length,
      nonleaf_lines_total: bal.reduce((a, b) => a + b.line_count, 0),
      needs_attention: needing.length > 0 || sett.length > 0 || bal.length > 0,
    },
  };
}

module.exports = { buildCoaLeafReport, warehouseRows, settingsNonLeaf, nonLeafBalances };
