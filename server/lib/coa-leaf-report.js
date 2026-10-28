'use strict';
/**
 * Read-only leaf-mapping report (admin UI + scripts/report-coa-leaf-mapping.js).
 * Phase 3: split settings into control / not_leaf / not_found; control_accounts;
 * inactive perpetual warehouses out of the unmapped attention count.
 * Never writes to the DB.
 */

const { LEGACY, KIND_KEY, isPostableCode, acct } = require('./coa-map');
const policy = require('./coa-leaf-policy');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

/** Settings keys that intentionally map to control (non-leaf) accounts. */
function controlSettingsKeys(db) {
  const keys = new Set(Object.values(KIND_KEY));
  keys.add('coa_issue_return_to_supplier');
  // coa_inventory is a control only while product tafsili still creates COA leaves under it.
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='coa_product_tafsili_mode'").get();
    const mode = String((r && r.value) || 'legacy_leaf').trim().toLowerCase();
    if (mode === 'detail_account') keys.delete('coa_inventory');
  } catch (_) { /* settings table optional during boot */ }
  return keys;
}

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

function liveJeClause(db) {
  if (!hasTable(db, 'journal_entries')) return '1=1';
  const jeCols = new Set(db.prepare('PRAGMA table_info(journal_entries)').all().map((c) => c.name));
  return [
    jeCols.has('deleted_at') ? 'COALESCE(je.deleted_at,0)=0' : null,
    jeCols.has('status') ? "COALESCE(je.status,'approved') NOT IN ('reversed','void')" : null,
  ].filter(Boolean).join(' AND ') || '1=1';
}

/**
 * Classify every LEGACY coa_* key:
 *   control     — intentional control/non-leaf (KIND_KEY + return-to-supplier)
 *   not_leaf    — non-control and has children
 *   not_found   — code missing from chart
 *   default_unused — no settings override (value from LEGACY default); informational
 *
 * settings_nonleaf array = not_leaf only (backward-compatible name for the attention list).
 */
function settingsNonLeaf(db) {
  const empty = { control: [], not_leaf: [], not_found: [], default_unused: [] };
  if (!hasTable(db, 'settings') || !hasTable(db, 'chart_of_accounts')) return empty;
  const overrides = new Map(
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'coa\\_%' ESCAPE '\\'").all()
      .map((r) => [r.key, String(r.value || '').trim()]),
  );
  const controlKeys = controlSettingsKeys(db);
  const out = { control: [], not_leaf: [], not_found: [], default_unused: [] };
  for (const key of Object.keys(LEGACY)) {
    const fromSettings = overrides.has(key) && !!overrides.get(key);
    const code = fromSettings ? overrides.get(key) : LEGACY[key].code;
    if (!code) continue;
    const source = fromSettings ? 'settings' : 'default';
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
    let entry;
    if (!row) {
      entry = { key, code, name: null, reason: 'not_found', source, category: 'not_found' };
      out.not_found.push(entry);
    } else if (!isPostableCode(db, code)) {
      if (controlKeys.has(key)) {
        entry = { key, code, name: row.name, reason: 'control', source, category: 'control' };
        out.control.push(entry);
      } else {
        entry = { key, code, name: row.name, reason: 'not_leaf', source, category: 'not_leaf' };
        out.not_leaf.push(entry);
      }
    } else {
      continue; // leaf — ok
    }
    if (source === 'default') {
      out.default_unused.push({ ...entry, category: 'default_unused' });
    }
  }
  return out;
}

function nonLeafBalances(db) {
  if (!hasTable(db, 'journal_lines') || !hasTable(db, 'journal_entries') || !hasTable(db, 'chart_of_accounts')) return [];
  const live = liveJeClause(db);
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

/** Resolve control-account codes currently pointed at by control settings keys. */
function controlAccountCodes(db) {
  const codes = new Map(); // code → { keys: [] }
  if (!hasTable(db, 'chart_of_accounts')) return codes;
  const controlKeys = controlSettingsKeys(db);
  for (const key of controlKeys) {
    let code;
    try {
      code = String(acct(db, key).code || '').trim();
    } catch (_) {
      code = String((LEGACY[key] && LEGACY[key].code) || '').trim();
    }
    if (!code) continue;
    const slot = codes.get(code) || { code, keys: [] };
    slot.keys.push(key);
    codes.set(code, slot);
  }
  return codes;
}

/**
 * Per control account: active child (تفصیلی/معین) count + lines posted on the
 * control code itself (attention — should usually be on details).
 */
function controlAccounts(db) {
  const map = controlAccountCodes(db);
  if (!map.size) return [];
  const live = liveJeClause(db);
  const out = [];
  for (const { code, keys } of map.values()) {
    const acc = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
    let active_detail_count = 0;
    try {
      active_detail_count = db.prepare(
        'SELECT COUNT(*) AS c FROM chart_of_accounts WHERE parent_code=? AND COALESCE(is_active,1)=1',
      ).get(code).c;
    } catch (_) { /* ignore */ }
    let lines_on_control = 0;
    if (hasTable(db, 'journal_lines') && hasTable(db, 'journal_entries')) {
      try {
        lines_on_control = db.prepare(`
          SELECT COUNT(*) AS c FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_code=? AND ${live}
        `).get(code).c;
      } catch (_) { /* ignore */ }
    }
    out.push({
      code,
      name: acc ? acc.name : null,
      keys,
      active_detail_count,
      lines_on_control,
      needs_attention: lines_on_control > 0,
    });
  }
  out.sort((a, b) => b.lines_on_control - a.lines_on_control || String(a.code).localeCompare(String(b.code)));
  return out;
}

function buildCoaLeafReport(db) {
  const mode = policy.leafEnforcementMode(db);
  const whs = warehouseRows(db).map((w) => ({
    ...policy.warehouseMappingStatus(db, w),
  }));
  // Active perpetual unmapped only — inactive go to a separate section.
  const needing = whs.filter((w) => w.perpetual && !w.mapped && w.active);
  const inactiveUnmapped = whs.filter((w) => w.perpetual && !w.mapped && !w.active);
  const fixedAssetUnmapped = whs.filter((w) => w.fixed_asset_type && !w.inventory_ok);
  const sett = settingsNonLeaf(db);
  const bal = nonLeafBalances(db);
  const ctrlCodes = controlAccountCodes(db);
  const balControl = bal.filter((b) => ctrlCodes.has(b.code)).map((b) => ({ ...b, is_control: true }));
  const balNonControl = bal.filter((b) => !ctrlCodes.has(b.code)).map((b) => ({ ...b, is_control: false }));
  const ctrlAccts = controlAccounts(db);
  const notLeafCount = sett.not_leaf.length;
  const notFoundCount = sett.not_found.length;
  return {
    generated_at: new Date().toISOString(),
    flag: { key: policy.FLAG_KEY, value: mode },
    warehouses: whs,
    warehouses_unmapped: needing,
    warehouses_inactive_unmapped: inactiveUnmapped,
    fixed_asset_unmapped: fixedAssetUnmapped,
    settings_nonleaf: sett.not_leaf,
    settings_control: sett.control,
    settings_not_found: sett.not_found,
    settings_default_unused: sett.default_unused,
    settings_categories: sett,
    control_accounts: ctrlAccts,
    nonleaf_balances: bal,
    nonleaf_balances_split: {
      control: balControl,
      non_control: balNonControl,
    },
    recent_warnings: policy.recentLeafIssues().slice(0, 50),
    summary: {
      warehouses_total: whs.length,
      warehouses_perpetual_unmapped: needing.length,
      warehouses_inactive_unmapped: inactiveUnmapped.length,
      settings_keys_total: Object.keys(LEGACY).length,
      settings_nonleaf: notLeafCount,
      settings_not_found: notFoundCount,
      settings_control: sett.control.length,
      settings_default_unused: sett.default_unused.length,
      control_accounts: ctrlAccts.length,
      control_accounts_with_lines: ctrlAccts.filter((c) => c.lines_on_control > 0).length,
      nonleaf_accounts_with_lines: bal.length,
      nonleaf_lines_total: bal.reduce((a, b) => a + b.line_count, 0),
      nonleaf_control_accounts: balControl.length,
      nonleaf_noncontrol_accounts: balNonControl.length,
      needs_attention: needing.length > 0 || notLeafCount > 0 || notFoundCount > 0
        || balNonControl.length > 0
        || ctrlAccts.some((c) => c.lines_on_control > 0),
    },
  };
}

module.exports = {
  buildCoaLeafReport,
  warehouseRows,
  settingsNonLeaf,
  nonLeafBalances,
  controlAccounts,
  controlSettingsKeys,
  controlAccountCodes,
};
