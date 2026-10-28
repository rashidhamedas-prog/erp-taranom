'use strict';
/**
 * Phase 1 — COGS / leaf-account mapping policy (v585).
 *
 * - flag `ledger_leaf_enforcement` (settings): `warn` (default) | `enforce`
 * - per-warehouse mapping: warehouses.inventory_coa_code + warehouses.cogs_coa_code
 * - NEVER auto-picks a leaf (no resolvePostableLeaf) and NEVER falls back to
 *   coa_finished_goods / 1104 when enforcing — unmapped ⇒ 422 E_WAREHOUSE_COA_UNMAPPED.
 * - Read-only helpers only; this module never writes data.
 */

const { acct, isPostableCode } = require('./coa-map');

const FLAG_KEY = 'ledger_leaf_enforcement';
const E_UNMAPPED = 'E_WAREHOUSE_COA_UNMAPPED';
const E_NOT_LEAF = 'E_ACCOUNT_NOT_LEAF';
const E_TYPE_UNSUPPORTED = 'E_WAREHOUSE_TYPE_UNSUPPORTED';

/** Non-standard warehouse type created via «نوع جدید» (warehouse 36). */
const FIXED_ASSET_TYPES = new Set(['دارایی_ثابت', 'fixed_asset', 'fixed_assets']);

function normalizeWarehouseType(t) {
  return String(t || '').trim().replace(/[\s\u200c]+/g, '_').toLowerCase();
}

function isFixedAssetWarehouseType(t) {
  return FIXED_ASSET_TYPES.has(normalizeWarehouseType(t));
}

function leafEnforcementMode(db) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG_KEY);
    return String(r && r.value).trim().toLowerCase() === 'enforce' ? 'enforce' : 'warn';
  } catch (_) {
    return 'warn';
  }
}

function leafErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/* ── structured log (in-memory ring + console; no DB writes) ── */
const RECENT_MAX = 200;
const recent = [];

function logLeafIssue(code, details) {
  const entry = { at: new Date().toISOString(), code, ...(details || {}) };
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();
  try { console.warn('[coa-leaf] ' + JSON.stringify(entry)); } catch (_) { /* ignore */ }
  return entry;
}

function recentLeafIssues() {
  return recent.slice().reverse();
}

function clearRecentLeafIssues() {
  recent.length = 0;
}

/* ── account checks ── */
function standardCoa(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
    const m = r ? String(r.value || '') : '';
    return !(m === 'extended' || m === 'mahak');
  } catch (_) {
    return true;
  }
}

/**
 * @param {'inventory'|'cogs'} kind
 * @param {{ fixedAsset?: boolean }} [opts]
 * @returns {{ ok: boolean, reason: string|null, code: string }}
 */
function checkMappedAccount(db, code, kind, opts = {}) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: 'empty', code: c };
  const row = db.prepare('SELECT code, type, is_active FROM chart_of_accounts WHERE code=?').get(c);
  if (!row || row.is_active === 0) return { ok: false, reason: 'not_found', code: c };
  if (!isPostableCode(db, c)) return { ok: false, reason: 'not_leaf', code: c };
  let groupOk;
  if (standardCoa(db)) {
    groupOk = kind === 'cogs'
      ? c.startsWith('5')
      : (c.startsWith('11') || (opts.fixedAsset && c.startsWith('12')));
  } else {
    const t = String(row.type || '').toLowerCase();
    groupOk = kind === 'cogs' ? (t === 'cogs' || t === 'expense') : t === 'asset';
  }
  if (!groupOk) return { ok: false, reason: 'wrong_group', code: c };
  return { ok: true, reason: null, code: c };
}

const REASON_FA = {
  empty: 'خالی است',
  not_found: 'در دفتر کل یافت نشد یا غیرفعال است',
  not_leaf: 'حساب برگ (قابل ثبت) نیست — زیرمجموعه دارد',
  wrong_group: 'با کاربرد این حساب نمی‌خواند',
};

function reasonFa(reason) {
  return REASON_FA[reason] || reason || '';
}

/** Perpetual = anything that is not explicitly periodic. */
function isPerpetualSystem(inventorySystem) {
  return String(inventorySystem || 'perpetual').trim().toLowerCase() !== 'periodic';
}

/**
 * Save-time validation for warehouses (API). Periodic warehouses are exempt from
 * the REQUIRED rule; codes are still validated when supplied.
 * @returns {{ status: number, code: string, error: string }|null}
 */
function validateWarehouseCoaInput(db, input) {
  const type = input.warehouse_type;
  const fixedAsset = isFixedAssetWarehouseType(type);
  const perpetual = isPerpetualSystem(input.inventory_system);
  const inv = String(input.inventory_coa_code || '').trim();
  const cogs = String(input.cogs_coa_code || '').trim();

  if (perpetual && !inv) {
    return { status: 400, code: 'E_WH_INV_COA_REQUIRED', error: 'برای انبار دائمی، حساب برگ موجودی الزامی است' };
  }
  if (perpetual && !cogs) {
    return { status: 400, code: 'E_WH_COGS_COA_REQUIRED', error: 'برای انبار دائمی، حساب برگ بهای تمام‌شده الزامی است' };
  }
  if (inv) {
    const r = checkMappedAccount(db, inv, 'inventory', { fixedAsset });
    if (!r.ok) {
      return {
        status: 400, code: 'E_WH_INV_COA_INVALID',
        error: `حساب موجودی انبار (${inv}): ${reasonFa(r.reason)}${r.reason === 'wrong_group' ? ' — حساب موجودی باید زیر گروه ۱۱ (موجودی کالا) باشد' : ''}`,
      };
    }
  }
  if (cogs) {
    const r = checkMappedAccount(db, cogs, 'cogs');
    if (!r.ok) {
      return {
        status: 400, code: 'E_WH_COGS_COA_INVALID',
        error: `حساب بهای تمام‌شده انبار (${cogs}): ${reasonFa(r.reason)}${r.reason === 'wrong_group' ? ' — باید زیر گروه ۵ (بهای تمام‌شده) باشد' : ''}`,
      };
    }
  }
  return null;
}

/** Mapping status of one warehouse row (no throwing, no fallback). */
function warehouseMappingStatus(db, wh) {
  const fixedAsset = isFixedAssetWarehouseType(wh.warehouse_type);
  const perpetual = isPerpetualSystem(wh.inventory_system);
  const inv = checkMappedAccount(db, wh.inventory_coa_code, 'inventory', { fixedAsset });
  const cogs = checkMappedAccount(db, wh.cogs_coa_code, 'cogs');
  return {
    warehouse_id: wh.id,
    name: wh.name,
    code: wh.code || null,
    warehouse_type: wh.warehouse_type || null,
    fixed_asset_type: fixedAsset,
    perpetual,
    active: Number(wh.active) === 1,
    inventory_coa_code: wh.inventory_coa_code || null,
    cogs_coa_code: wh.cogs_coa_code || null,
    inventory_ok: inv.ok,
    inventory_reason: inv.reason,
    cogs_ok: cogs.ok,
    cogs_reason: cogs.reason,
    mapped: inv.ok && cogs.ok,
  };
}

function warehouseRow(db, warehouseId) {
  if (!warehouseId) return null;
  try {
    return db.prepare(
      'SELECT id, name, code, warehouse_type, inventory_system, inventory_coa_code, cogs_coa_code, active FROM warehouses WHERE id=?'
    ).get(warehouseId) || null;
  } catch (_) {
    // pre-migration DB without cogs_coa_code
    return db.prepare(
      'SELECT id, name, code, warehouse_type, inventory_system, inventory_coa_code, NULL AS cogs_coa_code, active FROM warehouses WHERE id=?'
    ).get(warehouseId) || null;
  }
}

/**
 * Resolve inventory + COGS accounts for ONE warehouse on the sale (COGS) posting path.
 *  enforce → mapping must be present + leaf, else 422 E_WAREHOUSE_COA_UNMAPPED (no fallback).
 *  warn    → previous behaviour (type map / coa_cogs) + structured log.
 * Fixed-asset type (`دارایی_ثابت`) never falls back silently: valid map or a clear error.
 */
function resolveWarehouseCogsAccounts(db, warehouseId, ctx = {}) {
  const { inventoryAccountForWarehouse } = require('./inventory/ledger');
  const mode = leafEnforcementMode(db);
  const wh = warehouseRow(db, warehouseId);
  const ref = ctx.ref || null;

  if (!wh) {
    if (mode === 'enforce') {
      throw leafErr(E_UNMAPPED, 422,
        'برای ثبت بهای تمام‌شده، انبار مشخص و دارای نگاشت حساب برگ لازم است (E_WAREHOUSE_COA_UNMAPPED)',
        { warehouse_id: warehouseId || null });
    }
    logLeafIssue(E_UNMAPPED, { warehouse_id: warehouseId || null, ref, reason: 'no_warehouse', mode });
    return { inventory: inventoryAccountForWarehouse(db, null), cogs: acct(db, 'coa_cogs'), mapped: false };
  }

  const st = warehouseMappingStatus(db, wh);
  if (!st.mapped) {
    if (mode === 'enforce') {
      const why = [
        st.inventory_ok ? null : `حساب موجودی: ${reasonFa(st.inventory_reason)}`,
        st.cogs_ok ? null : `حساب بهای تمام‌شده: ${reasonFa(st.cogs_reason)}`,
      ].filter(Boolean).join('؛ ');
      throw leafErr(E_UNMAPPED, 422,
        `انبار «${wh.name}» نگاشت حساب برگ ندارد (${why}) — در اطلاعات پایه ← انبارها تکمیل کنید (E_WAREHOUSE_COA_UNMAPPED)`,
        { warehouse_id: wh.id, inventory_reason: st.inventory_reason, cogs_reason: st.cogs_reason });
    }
    logLeafIssue(E_UNMAPPED, {
      warehouse_id: wh.id, ref, mode,
      inventory_reason: st.inventory_reason, cogs_reason: st.cogs_reason,
    });
  }

  // inventory: explicit leaf map wins; otherwise legacy resolution (throws for unmapped fixed-asset type)
  const inventory = st.inventory_ok
    ? (db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(String(wh.inventory_coa_code).trim()))
    : inventoryAccountForWarehouse(db, wh.id);
  const cogs = st.cogs_ok
    ? (db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(String(wh.cogs_coa_code).trim()))
    : acct(db, 'coa_cogs');
  return { inventory, cogs, mapped: st.mapped };
}

/**
 * Group sale amounts by inventory account (credit) and COGS account (debit).
 * @param {{ warehouseId?: number|null, amountRial: number }[]} items
 * @returns {{ invParts: object[], cogsParts: object[], totalRial: number }}
 */
function cogsPartsByWarehouse(db, items, ctx = {}) {
  const inv = new Map();
  const cogs = new Map();
  let total = 0;
  for (const it of items || []) {
    const amt = Math.round(Number(it.amountRial) || 0);
    if (amt <= 0) continue;
    const r = resolveWarehouseCogsAccounts(db, it.warehouseId || null, ctx);
    const i = inv.get(r.inventory.code) || { code: r.inventory.code, name: r.inventory.name, amountRial: 0 };
    i.amountRial += amt;
    inv.set(i.code, i);
    const c = cogs.get(r.cogs.code) || { code: r.cogs.code, name: r.cogs.name, amountRial: 0 };
    c.amountRial += amt;
    cogs.set(c.code, c);
    total += amt;
  }
  return { invParts: [...inv.values()], cogsParts: [...cogs.values()], totalRial: total };
}

/**
 * postToLedger / rewrite hook: every line account must be a postable leaf.
 *  warn → log E_ACCOUNT_NOT_LEAF per line account (caller still posts)
 *  enforce → throw E_ACCOUNT_NOT_LEAF (caller's transaction rolls back)
 */
function assertLinesPostable(db, lines, ctx = {}) {
  const mode = leafEnforcementMode(db);
  const seen = new Set();
  for (const l of lines || []) {
    const code = String((l && l.code) || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    if (isPostableCode(db, code)) continue;
    const ref = ctx.sourceType ? `${ctx.sourceType}:${ctx.sourceId == null ? '' : ctx.sourceId}` : null;
    if (mode === 'enforce') {
      throw leafErr(E_NOT_LEAF, 422,
        `حساب ${code} حساب برگ (قابل ثبت) نیست یا یافت نشد — سند رد شد (E_ACCOUNT_NOT_LEAF)`,
        { account_code: code, ref });
    }
    logLeafIssue(E_NOT_LEAF, { account_code: code, ref, mode });
  }
}

module.exports = {
  FLAG_KEY,
  E_UNMAPPED,
  E_NOT_LEAF,
  E_TYPE_UNSUPPORTED,
  normalizeWarehouseType,
  isFixedAssetWarehouseType,
  leafEnforcementMode,
  leafErr,
  logLeafIssue,
  recentLeafIssues,
  clearRecentLeafIssues,
  checkMappedAccount,
  reasonFa,
  isPerpetualSystem,
  validateWarehouseCoaInput,
  warehouseMappingStatus,
  warehouseRow,
  resolveWarehouseCogsAccounts,
  cogsPartsByWarehouse,
  assertLinesPostable,
};
