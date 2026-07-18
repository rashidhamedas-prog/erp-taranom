// Unified ledger posting — spec §0.5 postToLedger → wraps createJournalEntry.

const { createJournalEntry, allocateNumber } = require('../db');
const { assertFiscalYearWritable, resolveFiscalYearForDate } = require('./fiscal-period');
const { tomanToRial } = require('./money');

const DELETED_FILTER = 'COALESCE(je.deleted_at,0)=0';

function validateBalancedLines(lines) {
  let debit = 0, credit = 0;
  for (const line of lines || []) {
    const d = Number(line.debit) || 0;
    const c = Number(line.credit) || 0;
    if (d > 0 && c > 0) return { ok: false, error: 'هر سطر فقط بدهکار یا بستانکار باشد' };
    debit += d;
    credit += c;
  }
  if (Math.abs(debit - credit) > 0.5) {
    return { ok: false, error: `سند تراز نیست (بدهکار ${debit} ≠ بستانکار ${credit})`, debit, credit };
  }
  return { ok: true, totalDebit: Math.round(debit), totalCredit: Math.round(credit) };
}

/**
 * Post a balanced journal entry (auto or manual).
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.sourceType  ref_type / source_type
 * @param {number} opts.sourceId    ref_id
 * @param {string} opts.date        entry_date (Jalali string)
 * @param {string} opts.description
 * @param {number} opts.createdBy
 * @param {Array}  opts.lines       [{code,name,debit,credit,description,detail_account_id?}]
 * @param {string} [opts.voucherType] normal|opening|closing_temp|closing_permanent|auto
 * @param {string} [opts.status]      approved|draft|pending_approval
 */
function postToLedger(db, opts) {
  const {
    sourceType, sourceId, date, description, createdBy, lines,
    voucherType = 'auto', status = 'approved',
  } = opts;

  const fyCheck = assertFiscalYearWritable(db, date);
  if (!fyCheck.ok) throw new Error(fyCheck.error);

  const normalized = (lines || []).map(l => ({
    code: l.code,
    name: l.name,
    debit: tomanToRial(l.debit_toman != null ? l.debit_toman : l.debit),
    credit: tomanToRial(l.credit_toman != null ? l.credit_toman : l.credit),
    description: l.description || '',
    detail_account_id: l.detail_account_id || null,
  }));

  const bal = validateBalancedLines(normalized);
  if (!bal.ok) {
    const err = new Error(bal.error);
    err.status = 409;
    throw err;
  }

  const fiscalYearId = resolveFiscalYearForDate(db, date);
  let voucherNumber = null;
  try {
    voucherNumber = allocateNumber(db, 'journal_voucher', 'JV');
  } catch (_) {
    voucherNumber = null;
  }

  const entryId = createJournalEntry(db, {
    date,
    description,
    ref_type: sourceType,
    ref_id: sourceId,
    created_by: createdBy,
    lines: normalized.map(l => ({
      code: l.code,
      name: l.name,
      debit: l.debit / 10,
      credit: l.credit / 10,
      debit_rial: l.debit,
      credit_rial: l.credit,
      description: l.description,
      detail_account_id: l.detail_account_id,
    })),
    fiscal_year_id: fiscalYearId,
    voucher_type: voucherType,
    status,
    voucher_number: voucherNumber,
    total_debit_rial: bal.totalDebit,
    total_credit_rial: bal.totalCredit,
  });

  if (!entryId) throw new Error('ثبت سند حسابداری ناموفق بود');
  return entryId;
}

module.exports = { postToLedger, validateBalancedLines, DELETED_FILTER };
