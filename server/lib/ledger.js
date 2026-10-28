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
 * v285+: requests with sourceType ending in `_reversal` do NOT create a separate
 * «سند ابطالی». They soft-void the matching original JE instead (same policy as
 * reverseJournalEntry). Callers that previously stored reversal_journal_id get
 * null when there is nothing left to void.
 */
function softVoidInsteadOfReversalVoucher(db, opts) {
  const sourceType = String(opts.sourceType || '');
  const sourceId = opts.sourceId;
  const baseType = sourceType.replace(/_reversal$/, '');
  const { reverseJournalEntry, hardDeleteJournalEntry } = require('./void-journal');

  const { closedFiscalYearForDate } = require('./void-journal');
  // Drop any leftover reverse vouchers for this source (legacy pairs) — never inside a closed year.
  if (sourceId != null) {
    const leftover = db.prepare(`
      SELECT id, entry_date FROM journal_entries
      WHERE ref_type=? AND ref_id=? AND COALESCE(deleted_at,0)=0
    `).all(sourceType, sourceId);
    for (const row of leftover) {
      if (closedFiscalYearForDate(db, row.entry_date)) continue;
      hardDeleteJournalEntry(db, row.id);
    }
  }

  if (sourceId == null || !baseType) return null;

  const originals = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type=? AND ref_id=?
      AND COALESCE(deleted_at,0)=0
    ORDER BY id
  `).all(baseType, sourceId);

  let last = null;
  for (const row of originals) {
    reverseJournalEntry(db, row.id, {
      userId: opts.createdBy,
      date: opts.date,
      reason: opts.description || '',
      sourceType,
    });
    last = row.id;
  }
  return last;
}

/** Fill empty line cost centers from the document so the voucher stays balanced by center. */
function stampCostCenter(lines, costCenterId) {
  const cc = parseInt(costCenterId, 10);
  if (!cc) return lines || [];
  return (lines || []).map((l) => ({
    ...l,
    cost_center_id: l.cost_center_id || cc,
  }));
}

/** Leaf guard — never swallows E_ACCOUNT_NOT_LEAF; tolerates a missing chart table on stub DBs. */
function assertLeafLines(db, lines, ctx) {
  try {
    require('./coa-leaf-policy').assertLinesPostable(db, lines, ctx);
  } catch (e) {
    if (e && e.code === 'E_ACCOUNT_NOT_LEAF') throw e;
    if (/no such table|no such column/i.test(String(e && e.message))) return;
    throw e;
  }
}

function postToLedger(db, opts) {
  const {
    sourceType, sourceId, date, description, createdBy, lines,
    voucherType = 'auto', status = 'approved',
    srcSystem = null, srcDocNo = null, docType = null,
    costCenterId = null,
  } = opts;

  // Never mint a standalone reverse voucher — soft-void the original instead.
  if (sourceType && String(sourceType).endsWith('_reversal')) {
    return softVoidInsteadOfReversalVoucher(db, opts);
  }

  let resolvedSrc = srcSystem;
  if (!resolvedSrc) {
    try {
      if (require('./excel-origin').isExcelOrigin()) resolvedSrc = 'excel';
    } catch (_) {}
  }

  const fyCheck = assertFiscalYearWritable(db, date);
  if (!fyCheck.ok) {
    // Validation, not a server fault — surface the real message to the client
    const err = new Error(fyCheck.error);
    err.status = 422;
    throw err;
  }

  const stamped = stampCostCenter(lines, costCenterId);
  try {
    const { assertExpenseLinesHaveCostCenter } = require('./cost-center-policy');
    assertExpenseLinesHaveCostCenter(db, stamped, {
      sourceType, costCenterId, warehouseId: opts.warehouseId,
      deriveCostCenterId: opts.deriveCostCenterId, skipCcPolicy: opts.skipCcPolicy,
    });
  } catch (e) {
    if (e && e.code === 'CC_REQUIRED_ON_EXPENSE') throw e;
    if (e && e.status === 422) throw e;
    throw e;
  }
  const normalized = stamped.map(l => ({
    code: l.code,
    name: l.name,
    debit: Math.round(tomanToRial(l.debit_toman != null ? l.debit_toman : l.debit)),
    credit: Math.round(tomanToRial(l.credit_toman != null ? l.credit_toman : l.credit)),
    description: l.description || '',
    detail_account_id: l.detail_account_id || null,
    cost_center_id: l.cost_center_id || null,
    project_id: l.project_id || null,
    tax_type: l.tax_type || null,
    tafsili2_code: l.tafsili2_code || null,
  }));

  const bal = validateBalancedLines(normalized);
  if (!bal.ok) {
    const err = new Error(bal.error);
    err.status = 409;
    throw err;
  }

  // v585 Phase 1: every line must be a postable leaf. warn → log + banner; enforce → throw (rollback).
  assertLeafLines(db, normalized, { sourceType, sourceId });

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
      cost_center_id: l.cost_center_id,
      project_id: l.project_id,
      tax_type: l.tax_type,
      tafsili2_code: l.tafsili2_code || null,
    })),
    fiscal_year_id: fiscalYearId,
    voucher_type: voucherType,
    status,
    voucher_number: voucherNumber,
    total_debit_rial: bal.totalDebit,
    total_credit_rial: bal.totalCredit,
    src_system: resolvedSrc || null,
    src_doc_no: srcDocNo || null,
    doc_type: docType || null,
  });

  if (!entryId) throw new Error('ثبت سند حسابداری ناموفق بود');
  const headerCc = parseInt(costCenterId, 10);
  if (headerCc) {
    db.prepare('UPDATE journal_entries SET cost_center_id=? WHERE id=?').run(headerCc, entryId);
  }
  try {
    require('./party-leaf-sync').syncJournalEntryToPartyBooks(db, entryId);
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('party leaf sync:', e.message);
  }
  return entryId;
}

/**
 * Rewrite an existing live journal in place (same id + voucher_number).
 * Used for invoice amend — does not post a reversal or allocate a new voucher.
 * @returns {number|null} existing entry id, or null if no live JE found
 */
function rewriteJournalEntry(db, opts) {
  const {
    sourceType, sourceId, date, description, lines, costCenterId = null,
  } = opts;

  const existing = db.prepare(`
    SELECT id, entry_date FROM journal_entries
    WHERE ref_type=? AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC
    LIMIT 1
  `).get(sourceType, sourceId);
  if (!existing) return null;

  const closedOld = require('./void-journal').closedFiscalYearForDate(db, existing.entry_date);
  if (closedOld) {
    const err = new Error(
      `سند #${existing.id} در سال مالی بسته (${closedOld.label || closedOld.id}) است — ویرایش مجاز نیست؛ سند را ابطال و دوباره ثبت کنید`
    );
    err.status = 422;
    err.code = 'E_CLOSED_PERIOD';
    throw err;
  }

  const fyCheck = assertFiscalYearWritable(db, date);
  if (!fyCheck.ok) {
    const err = new Error(fyCheck.error);
    err.status = 422;
    throw err;
  }

  const stamped = stampCostCenter(lines, costCenterId);
  try {
    const { assertExpenseLinesHaveCostCenter } = require('./cost-center-policy');
    assertExpenseLinesHaveCostCenter(db, stamped, {
      sourceType, costCenterId, warehouseId: opts.warehouseId,
      deriveCostCenterId: opts.deriveCostCenterId, skipCcPolicy: opts.skipCcPolicy,
    });
  } catch (e) {
    if (e && (e.code === 'CC_REQUIRED_ON_EXPENSE' || e.status === 422)) throw e;
    throw e;
  }
  const normalized = stamped.map(l => ({
    code: l.code,
    name: l.name,
    debit: Math.round(tomanToRial(l.debit_toman != null ? l.debit_toman : l.debit)),
    credit: Math.round(tomanToRial(l.credit_toman != null ? l.credit_toman : l.credit)),
    description: l.description || '',
    detail_account_id: l.detail_account_id || null,
    cost_center_id: l.cost_center_id || null,
    project_id: l.project_id || null,
    tax_type: l.tax_type || null,
    tafsili2_code: l.tafsili2_code || null,
  }));

  const bal = validateBalancedLines(normalized);
  if (!bal.ok) {
    const err = new Error(bal.error);
    err.status = 409;
    throw err;
  }

  assertLeafLines(db, normalized, { sourceType, sourceId });

  db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(existing.id);

  const lineStmt = db.prepare(`
    INSERT INTO journal_lines (
      entry_id,account_code,account_name,debit,credit,description,line_no,detail_account_id,
      debit_rial,credit_rial,cost_center_id,project_id,tax_type,tafsili2_code
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let lineNo = 0;
  for (const l of normalized) {
    lineNo++;
    lineStmt.run(
      existing.id, l.code, l.name,
      l.debit / 10, l.credit / 10,
      l.description, lineNo,
      l.detail_account_id,
      l.debit, l.credit,
      l.cost_center_id, l.project_id, l.tax_type,
      l.tafsili2_code
    );
  }

  const fiscalYearId = resolveFiscalYearForDate(db, date);
  const headerCc = parseInt(costCenterId, 10) || null;
  db.prepare(`
    UPDATE journal_entries
    SET entry_date=?, description=?, total_debit_rial=?, total_credit_rial=?, fiscal_year_id=?,
        cost_center_id=COALESCE(?, cost_center_id)
    WHERE id=?
  `).run(date || '', description || '', bal.totalDebit, bal.totalCredit, fiscalYearId, headerCc, existing.id);

  try {
    require('./party-leaf-sync').syncJournalEntryToPartyBooks(db, existing.id);
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('party leaf sync:', e.message);
  }
  return existing.id;
}

module.exports = { postToLedger, rewriteJournalEntry, validateBalancedLines, stampCostCenter, DELETED_FILTER };
