'use strict';
/**
 * v522 valuation accounts (created idempotently, mapped by settings keys):
 *   coa_value_change_clearing      «تعدیل بهای در انتظار تأیید» (asset, default 1120)
 *   coa_price_variance             «انحراف بها» (expense, default 6117)
 *   coa_inventory_shortage_surplus «کسری و اضافات انبار» (expense, default 6118)
 * and the manual-adjustment counter-account by reason + sign
 * (settings inventory_adjust_reason_accounts JSON: reason → COA code; empty = reason default).
 *
 * stock-adjust-fix: goods counters never use coa_cogs (5101) or coa_adjustment (9999).
 * Gain → 4205 / coa_stocktake_gain; loss → 6118 / coa_stocktake_loss; wastage/damage → leaf under 6108 (610801).
 */
const { acct, isPostableCode } = require('../coa-map');

const DEFS = {
  coa_value_change_clearing: { code: '1120', name: 'تعدیل بهای در انتظار تأیید', type: 'asset', parent: '1100' },
  coa_price_variance: { code: '6117', name: 'انحراف بها', type: 'expense', parent: '6000' },
  coa_inventory_shortage_surplus: { code: '6118', name: 'کسری و اضافات انبار', type: 'expense', parent: '6000' },
};

const ADJUST_REASONS = {
  shortage: 'کسری',
  surplus: 'اضافی',
  wastage: 'ضایعات',
  damage: 'خرابی / آسیب',
  count_correction: 'اصلاح شمارش',
  other: 'سایر',
};

const LOSS_LEAF_PREFERRED = '610801';

function setting(db, key) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r && r.value != null ? String(r.value).trim() : '';
  } catch (_) { return ''; }
}

function accountRow(db, code) {
  if (!code) return null;
  try {
    return db.prepare('SELECT code, name, type FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1').get(code) || null;
  } catch (_) { return null; }
}

/** Active leaf in P&L groups 4/5/6 — never inventory (11…) or equity suspense (9999). */
function isAdjustCounterLeaf(db, code) {
  const c = String(code || '').trim();
  if (!c || c === '9999' || c.startsWith('11') || c.startsWith('2') || c.startsWith('3') || c.startsWith('9')) {
    return false;
  }
  if (!(c.startsWith('4') || c.startsWith('5') || c.startsWith('6'))) return false;
  return isPostableCode(db, c);
}

function counterNotLeafErr(code) {
  const e = new Error(`حساب مقابل تعدیل (${code}) برگ فعال در گروه ۴/۵/۶ نیست`);
  e.code = 'E_ADJUST_COUNTER_NOT_LEAF';
  e.status = 409;
  e.account_code = code;
  return e;
}

function assertAdjustCounterLeaf(db, row) {
  if (!row || !row.code) throw counterNotLeafErr(row && row.code);
  if (!isAdjustCounterLeaf(db, row.code)) throw counterNotLeafErr(row.code);
  return { code: row.code, name: row.name };
}

/** Resolve (and create once) a v522 account; settings key wins when it points to a live account. */
function ensureAccount(db, key) {
  const def = DEFS[key];
  if (!def) throw new Error('value-accounts: unknown key ' + key);
  const mapped = accountRow(db, setting(db, key));
  if (mapped) return mapped;
  let code = def.code;
  const existing = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
  if (existing && existing.name !== def.name) {
    // Preferred code is taken by another account → next free sibling code.
    const base = Number(code);
    code = null;
    for (let i = 1; i < 80; i++) {
      const c = String(base + i);
      const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(c);
      if (!row) { code = c; break; }
      if (row.name === def.name) { code = c; break; }
    }
    if (!code) return { code: def.code, name: def.name };
  }
  if (!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(code)) {
    const cols = db.prepare('PRAGMA table_info(chart_of_accounts)').all().map((c) => c.name);
    const parent = db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(def.parent) ? def.parent : null;
    try {
      if (cols.includes('level')) {
        db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,2)').run(code, def.name, def.type, parent);
      } else {
        db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)').run(code, def.name, def.type, parent);
      }
    } catch (_) { /* race / device read-only */ }
  }
  try { db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, code); } catch (_) { /* read-only */ }
  return accountRow(db, code) || { code, name: def.name };
}

/** v525 read-only twin of ensureAccount (previews must not write): never creates the account. */
function peekAccount(db, key) {
  const def = DEFS[key];
  if (!def) throw new Error('value-accounts: unknown key ' + key);
  const mapped = accountRow(db, setting(db, key));
  if (mapped) return mapped;
  try {
    const byName = db.prepare('SELECT code, name FROM chart_of_accounts WHERE name=? AND COALESCE(is_active,1)=1 ORDER BY code LIMIT 1').get(def.name);
    if (byName) return byName;
  } catch (_) { /* old schema */ }
  return { code: def.code, name: def.name, pending: true };
}

const clearingAccount = (db) => ensureAccount(db, 'coa_value_change_clearing');
const priceVarianceAccount = (db) => ensureAccount(db, 'coa_price_variance');
const shortageSurplusAccount = (db) => ensureAccount(db, 'coa_inventory_shortage_surplus');

function getReasonAccounts(db) {
  try {
    const j = JSON.parse(setting(db, 'inventory_adjust_reason_accounts') || '{}');
    const out = {};
    for (const k of Object.keys(ADJUST_REASONS)) if (j && j[k]) out[k] = String(j[k]).trim();
    return out;
  } catch (_) { return {}; }
}

function setReasonAccounts(db, map) {
  const out = {};
  const src = map && typeof map === 'object' ? map : {};
  for (const [k, v] of Object.entries(src)) {
    if (!ADJUST_REASONS[k]) {
      const e = new Error(`دلیل تعدیل نامعتبر: ${k}`); e.code = 'E_ADJUST_REASON'; e.status = 400; throw e;
    }
    const code = String(v || '').trim();
    if (!code) continue;
    if (!accountRow(db, code)) {
      const e = new Error(`حساب ${code} در دفتر کل یافت نشد`); e.code = 'E_ADJUST_REASON_COA'; e.status = 400; throw e;
    }
    out[k] = code;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('inventory_adjust_reason_accounts', JSON.stringify(out));
  return out;
}

/** Stage of an inventory account: materials | wip | goods. */
function stageOfInventoryCode(db, code) {
  const c = String(code || '');
  const is = (k) => { try { return acct(db, k).code === c; } catch (_) { return false; } };
  if (is('coa_wip')) return 'wip';
  if (is('coa_raw_materials') || is('coa_packaging_materials')) return 'materials';
  return 'goods';
}

/**
 * Legacy stage default — goods must NEVER return coa_cogs (5101).
 * Kept for WIP/materials callers and tests that still reference stage defaults.
 */
function stageDefaultAccount(db, stage, peek = false) {
  if (stage === 'wip') return acct(db, 'coa_overhead_control');
  if (stage === 'materials') return peek ? peekAccount(db, 'coa_inventory_shortage_surplus') : shortageSurplusAccount(db);
  // goods: stock-count difference → shortage/surplus expense (never COGS)
  return peek ? peekAccount(db, 'coa_inventory_shortage_surplus') : shortageSurplusAccount(db);
}

function stocktakeOverride(db, gain) {
  const key = gain ? 'coa_stocktake_gain' : 'coa_stocktake_loss';
  const code = setting(db, key);
  if (!code) return null;
  const row = accountRow(db, code);
  if (row && isAdjustCounterLeaf(db, row.code)) return row;
  return null;
}

/** Ensure leaf 610801 under 6108 exists (settings.coa_inventory_loss stays 6108). */
function ensureLossLeaf801(db) {
  const parent = '6108';
  if (!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(parent)) {
    try {
      db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)")
        .run(parent, 'کسری و ضایعات انبار', 'expense', '6000');
    } catch (_) { /* */ }
  }
  if (db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(LOSS_LEAF_PREFERRED)) {
    return accountRow(db, LOSS_LEAF_PREFERRED);
  }
  try {
    const cols = db.prepare('PRAGMA table_info(chart_of_accounts)').all().map((c) => c.name);
    if (cols.includes('level')) {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
        .run(LOSS_LEAF_PREFERRED, 'خالص کسری انبار', 'expense', parent, 3);
    } else {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES (?,?,?,?,1)')
        .run(LOSS_LEAF_PREFERRED, 'خالص کسری انبار', 'expense', parent);
    }
  } catch (_) { /* race */ }
  return accountRow(db, LOSS_LEAF_PREFERRED);
}

/** Map wastage/damage to leaf 610801; never post to parent 6108 even if it has no children yet. */
function inventoryLossLeaf(db, { peek = false } = {}) {
  const preferred = accountRow(db, LOSS_LEAF_PREFERRED);
  if (preferred && isAdjustCounterLeaf(db, preferred.code)) return preferred;
  if (!peek) {
    const created = ensureLossLeaf801(db);
    if (created && isAdjustCounterLeaf(db, created.code)) return created;
  }
  let mapped = setting(db, 'coa_inventory_loss');
  if (!mapped) {
    try { mapped = acct(db, 'coa_inventory_loss').code; } catch (_) { mapped = '6108'; }
  }
  // Never accept bare 6108 as the wastage counter.
  if (mapped && mapped !== '6108' && isAdjustCounterLeaf(db, mapped)) {
    return accountRow(db, mapped);
  }
  try {
    const kids = db.prepare(`
      SELECT code, name FROM chart_of_accounts
      WHERE parent_code=? AND COALESCE(is_active,1)=1 ORDER BY code
    `).all(mapped || '6108');
    for (const k of kids) {
      if (isAdjustCounterLeaf(db, k.code)) return k;
    }
  } catch (_) { /* */ }
  if (peek) return { code: LOSS_LEAF_PREFERRED, name: 'خالص کسری انبار', pending: true };
  throw counterNotLeafErr(mapped || '6108');
}

function gainAccount(db, { peek = false } = {}) {
  const ovr = stocktakeOverride(db, true);
  if (ovr) return ovr;
  try {
    const a = acct(db, 'coa_inventory_gain');
    if (a && isAdjustCounterLeaf(db, a.code)) return { code: a.code, name: a.name };
  } catch (_) { /* */ }
  const row = accountRow(db, '4205');
  if (row && isAdjustCounterLeaf(db, row.code)) return row;
  if (peek) return { code: '4205', name: 'اضافی انبارگردانی', pending: true };
  throw counterNotLeafErr('4205');
}

function lossAccount(db, { peek = false } = {}) {
  const ovr = stocktakeOverride(db, false);
  if (ovr) return ovr;
  return peek ? peekAccount(db, 'coa_inventory_shortage_surplus') : shortageSurplusAccount(db);
}

/**
 * Counter-account for a manual inventory adjustment (same for count and delta modes).
 * reason mapped in settings (must be P&L leaf) → that account;
 * else by reason + sign of delta (never 5101, never 9999, never parent 6108/1104).
 * Returns { code, name, stage, reason_code, source } or throws E_ADJUST_COUNTER_NOT_LEAF.
 * When reasonCode is missing, returns null (preview must not invent 9999).
 */
function adjustCounterAccount(db, { inventoryCode, reasonCode, deltaQty = 0, peek = false } = {}) {
  const stage = stageOfInventoryCode(db, inventoryCode);
  const reason = ADJUST_REASONS[reasonCode] ? reasonCode : null;
  if (!reason) return null;

  const mappedCode = getReasonAccounts(db)[reason];
  if (mappedCode) {
    const mapped = accountRow(db, mappedCode);
    if (!mapped) {
      const e = new Error(`حساب مقابل دلیل (${mappedCode}) یافت نشد`);
      e.code = 'E_ADJUST_REASON_COA'; e.status = 400; throw e;
    }
    const leaf = assertAdjustCounterLeaf(db, mapped);
    return { ...leaf, stage, reason_code: reason, source: 'reason' };
  }

  // WIP keeps overhead as stage default (except wastage/damage → loss leaf).
  if (stage === 'wip' && reason !== 'wastage' && reason !== 'damage') {
    const a = acct(db, 'coa_overhead_control');
    return { code: a.code, name: a.name, stage, reason_code: reason, source: 'stage' };
  }

  let row;
  let source = 'reason_default';
  if (reason === 'wastage' || reason === 'damage') {
    row = inventoryLossLeaf(db, { peek });
    source = 'loss_leaf';
  } else if (reason === 'surplus' || (reason === 'count_correction' && Number(deltaQty) > 0)) {
    row = gainAccount(db, { peek });
    source = 'gain';
  } else {
    // shortage | count_correction (loss / zero) | other
    row = lossAccount(db, { peek });
    source = 'loss';
  }
  // Preview may return a pending default before the account row exists — still show the code, never 9999/5101.
  if (peek && row && row.pending) {
    return { code: row.code, name: row.name, stage, reason_code: reason, source };
  }
  const leaf = assertAdjustCounterLeaf(db, row);
  return { ...leaf, stage, reason_code: reason, source };
}

function normReason(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (!ADJUST_REASONS[s]) {
    const e = new Error('دلیل تعدیل نامعتبر است'); e.code = 'E_ADJUST_REASON'; e.status = 400; throw e;
  }
  return s;
}

module.exports = {
  ensureAccount,
  peekAccount,
  clearingAccount,
  priceVarianceAccount,
  shortageSurplusAccount,
  getReasonAccounts,
  setReasonAccounts,
  adjustCounterAccount,
  stageOfInventoryCode,
  stageDefaultAccount,
  isAdjustCounterLeaf,
  inventoryLossLeaf,
  normReason,
  ADJUST_REASONS,
};
