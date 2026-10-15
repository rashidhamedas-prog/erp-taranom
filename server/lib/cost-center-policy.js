'use strict';

/**
 * Policy: require cost center on period-expense journal lines (when amount > 0).
 * Setting key: require_cc_on_expense = '1' | '0' (default OFF when missing).
 *
 * Scope (hard require): type=expense or code 6xxx with debit > 0.
 * Out of hard scope: inventory COGS (type=cogs / 5xxx COGS) — soft-stamp from
 * warehouse/header when available, never block sales/inventory docs for missing CC.
 * Soft-void / *_reversal never creates new expense lines — gate skips those.
 * Production overhead stays required even when the flag is OFF.
 */

const SETTING_KEY = 'require_cc_on_expense';

function readSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? String(row.value == null ? '' : row.value) : '';
  } catch (_) {
    return '';
  }
}

function isRequireExpenseCostCenter(db) {
  return readSetting(db, SETTING_KEY) === '1';
}

/** Broad coding helper (expense + COGS + 5/6) — used by expense pickers, not the hard CC gate. */
function isExpenseCodingAccount(row) {
  if (!row) return false;
  const type = String(row.type || '').toLowerCase();
  if (type === 'expense' || type === 'cogs') return true;
  const code = String(row.code || '');
  return code.startsWith('5') || code.startsWith('6');
}

/**
 * Period P&L expense that must carry a cost center when the setting is ON and debit > 0.
 * Inventory COGS (type=cogs) is excluded — it is automatic costing, not a filled expense field.
 */
function isPeriodExpenseForCcPolicy(row) {
  if (!row) return false;
  const type = String(row.type || '').toLowerCase();
  if (type === 'cogs') return false;
  if (type === 'expense') return true;
  const code = String(row.code || '');
  return code.startsWith('6');
}

function accountByCode(db, code) {
  if (!code) return null;
  return db.prepare(
    'SELECT code, name, type, is_active FROM chart_of_accounts WHERE code=?'
  ).get(String(code)) || null;
}

function isActiveCostCenter(db, id) {
  const cc = parseInt(id, 10);
  if (!cc) return false;
  const row = db.prepare(
    'SELECT id FROM cost_centers WHERE id=? AND COALESCE(active,1)=1'
  ).get(cc);
  return !!row;
}

function warehouseCostCenterId(db, warehouseId) {
  const wid = parseInt(warehouseId, 10);
  if (!wid) return null;
  try {
    const row = db.prepare(
      'SELECT cost_center_id FROM warehouses WHERE id=?'
    ).get(wid);
    const cc = parseInt(row?.cost_center_id, 10);
    return cc || null;
  } catch (_) {
    return null;
  }
}

function lineAmountFilled(line) {
  const debit = Number(line?.debit) || 0;
  const credit = Number(line?.credit) || 0;
  // Primary cost charge is normally debit; skip pure credit (liability/income) sides.
  if (debit <= 0 && credit > 0) return false;
  return debit > 0;
}

/**
 * After stampCostCenter: ensure every in-scope period-expense charge line has an active CC.
 * Mutates lines in place when deriving from opts.costCenterId / warehouseId.
 * Zero/empty amounts never require CC. COGS lines may soft-stamp but never throw.
 */
function isPayrollSourceType(sourceType) {
  // Monthly payroll accrual only. Year-end (عیدی/سنوات) stays on the global
  // require_cc_on_expense flag until that form is wired with a CC field.
  return String(sourceType || '') === 'payroll';
}

function assertExpenseLinesHaveCostCenter(db, lines, opts = {}) {
  const sourceType = String(opts.sourceType || '');
  if (sourceType.endsWith('_reversal') || opts.skipCcPolicy) return lines || [];

  // Payroll accrual always needs CC on period-expense debits (like production OH).
  const alwaysRequire = isPayrollSourceType(sourceType);
  if (!alwaysRequire && !isRequireExpenseCostCenter(db)) return lines || [];

  const headerCc = parseInt(opts.costCenterId, 10) || null;
  const whCc = warehouseCostCenterId(db, opts.warehouseId);
  const deriveCc = headerCc || whCc || parseInt(opts.deriveCostCenterId, 10) || null;

  const out = lines || [];
  for (const line of out) {
    if (!lineAmountFilled(line)) continue;

    const acct = accountByCode(db, line.code);
    if (!acct) continue;

    let cc = parseInt(line.cost_center_id, 10) || null;
    if (!cc && deriveCc) {
      cc = deriveCc;
      line.cost_center_id = cc;
    }

    // Inventory COGS: enrich when possible, never block the document.
    if (!isPeriodExpenseForCcPolicy(acct)) continue;

    if (!cc || !isActiveCostCenter(db, cc)) {
      const err = new Error(
        alwaysRequire
          ? `مرکز هزینه برای ثبت حقوق (حساب ${line.code || ''}) الزامی است`
          : `مرکز هزینه برای حساب هزینه ${line.code || ''} الزامی است (تنظیمات → الزام مرکز هزینه روی هزینه‌ها)`
      );
      err.status = 422;
      err.code = alwaysRequire ? 'E_CC_REQUIRED_PAYROLL' : 'CC_REQUIRED_ON_EXPENSE';
      err.account = line.code || null;
      err.sourceType = sourceType || null;
      throw err;
    }
  }
  return out;
}

/**
 * Used by expense payment / cheque expense before ledger post.
 * OH and payroll always require CC; when policy ON, require CC only if amount is filled (>0).
 */
function assertExpenseDocumentCostCenter(db, { cost_center_id, is_overhead, section, amount }) {
  const ccId = cost_center_id ? parseInt(cost_center_id, 10) : null;
  if (ccId) {
    if (!isActiveCostCenter(db, ccId)) {
      const err = new Error('مرکز هزینه یافت نشد یا غیرفعال است');
      err.status = 400;
      err.code = 'E_CC_NOT_FOUND';
      throw err;
    }
    return ccId;
  }
  const oh = !!(is_overhead || section === 'production_overhead');
  if (oh) {
    const err = new Error('سربار تولید بدون مرکز هزینه ثبت نمی‌شود');
    err.status = 400;
    err.code = 'E_CC_REQUIRED_OH';
    throw err;
  }
  if (section === 'payroll') {
    const err = new Error('مرکز هزینه برای پردازش حقوق الزامی است');
    err.status = 400;
    err.code = 'E_CC_REQUIRED_PAYROLL';
    throw err;
  }
  const amt = amount == null ? null : Number(amount);
  if (amt != null && !(amt > 0)) return null;
  if (isRequireExpenseCostCenter(db)) {
    const err = new Error('مرکز هزینه برای ثبت هزینه الزامی است');
    err.status = 422;
    err.code = 'CC_REQUIRED_ON_EXPENSE';
    throw err;
  }
  return null;
}

module.exports = {
  SETTING_KEY,
  isRequireExpenseCostCenter,
  isExpenseCodingAccount,
  isPeriodExpenseForCcPolicy,
  isPayrollSourceType,
  warehouseCostCenterId,
  assertExpenseLinesHaveCostCenter,
  assertExpenseDocumentCostCenter,
  isActiveCostCenter,
  lineAmountFilled,
};
