'use strict';
/**
 * v522 valuation accounts (created idempotently, mapped by settings keys):
 *   coa_value_change_clearing      «تعدیل بهای در انتظار تأیید» (asset, default 1120)
 *   coa_price_variance             «انحراف بها» (expense, default 6117)
 *   coa_inventory_shortage_surplus «کسری و اضافات انبار» (expense, default 6118)
 * and the manual-adjustment counter-account by stage + reason
 * (settings inventory_adjust_reason_accounts JSON: reason → COA code; empty = stage default).
 */
const { acct } = require('../coa-map');

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

function setting(db, key) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r && r.value != null ? String(r.value).trim() : '';
  } catch (_) { return ''; }
}

function accountRow(db, code) {
  if (!code) return null;
  try {
    return db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1').get(code) || null;
  } catch (_) { return null; }
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

function stageDefaultAccount(db, stage, peek = false) {
  if (stage === 'wip') return acct(db, 'coa_overhead_control');
  if (stage === 'materials') return peek ? peekAccount(db, 'coa_inventory_shortage_surplus') : shortageSurplusAccount(db);
  return acct(db, 'coa_cogs');
}

/**
 * Counter-account for a manual inventory adjustment.
 * reason mapped in settings → that account; else stage default by the inventory account.
 * Returns { code, name, stage, reason_code, source: 'reason'|'stage' }.
 */
function adjustCounterAccount(db, { inventoryCode, reasonCode, peek = false } = {}) {
  const stage = stageOfInventoryCode(db, inventoryCode);
  const reason = ADJUST_REASONS[reasonCode] ? reasonCode : null;
  if (reason) {
    const mapped = accountRow(db, getReasonAccounts(db)[reason]);
    if (mapped) return { ...mapped, stage, reason_code: reason, source: 'reason' };
  }
  const a = stageDefaultAccount(db, stage, peek);
  return { code: a.code, name: a.name, stage, reason_code: reason, source: 'stage' };
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
  normReason,
  ADJUST_REASONS,
};
