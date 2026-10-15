/**
 * Cash-ops list helpers — voucher-backed person/account pay & receive
 * that live in journal_entries (not supplier/incentive/expense tables).
 *
 * Root gap (v389): savePersonPayment(party) → POST /vouchers, but
 * renderCashOpsTab only merged supplier + incentive + expense.
 */
'use strict';

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { DELETED_FILTER } = require('./ledger');

const FEE_CODE_SQL = `(jl.account_code = '6115' OR jl.account_code LIKE '6115%')`;

/** Cash/bank/POS leaf used as the other side of a person pay/receive voucher. */
function treasuryCreditExistsSql(alias = 'je') {
  return `
    EXISTS (
      SELECT 1 FROM journal_lines jl
      WHERE jl.entry_id = ${alias}.id
        AND ${SQL_JL_CREDIT_RIAL} > 0
        AND (
          jl.account_code IN (SELECT coa_code FROM banks WHERE IFNULL(coa_code,'') <> '')
          OR jl.account_code IN (SELECT coa_code FROM cash_boxes WHERE IFNULL(coa_code,'') <> '')
          OR jl.account_code LIKE '1101%'
          OR jl.account_code LIKE '1102%'
          OR jl.account_code LIKE '1118%'
          OR jl.account_code IN (
            SELECT value FROM settings WHERE key IN ('coa_cash','coa_bank','coa_pos_clearing')
              AND IFNULL(value,'') <> ''
          )
        )
    )`;
}

function treasuryDebitExistsSql(alias = 'je') {
  return `
    EXISTS (
      SELECT 1 FROM journal_lines jl
      WHERE jl.entry_id = ${alias}.id
        AND ${SQL_JL_DEBIT_RIAL} > 0
        AND (
          jl.account_code IN (SELECT coa_code FROM banks WHERE IFNULL(coa_code,'') <> '')
          OR jl.account_code IN (SELECT coa_code FROM cash_boxes WHERE IFNULL(coa_code,'') <> '')
          OR jl.account_code LIKE '1101%'
          OR jl.account_code LIKE '1102%'
          OR jl.account_code LIKE '1118%'
          OR jl.account_code IN (
            SELECT value FROM settings WHERE key IN ('coa_cash','coa_bank','coa_pos_clearing')
              AND IFNULL(value,'') <> ''
          )
        )
    )`;
}

function inferPayType(db, entryId, direction) {
  const row = db.prepare(`
    SELECT jl.account_code AS code
    FROM journal_lines jl
    WHERE jl.entry_id = ?
      AND ${direction === 'receipt' ? SQL_JL_DEBIT_RIAL : SQL_JL_CREDIT_RIAL} > 0
      AND NOT ${FEE_CODE_SQL}
    ORDER BY jl.id
    LIMIT 1
  `).get(entryId);
  if (!row?.code) return 'cash';
  const code = String(row.code);
  if (db.prepare('SELECT 1 FROM banks WHERE coa_code=? LIMIT 1').get(code)) return 'bank';
  if (code.startsWith('1118') || /کارتخوان|در راه/.test(code)) return 'bank';
  if (db.prepare('SELECT 1 FROM cash_boxes WHERE coa_code=? LIMIT 1').get(code)) return 'cash';
  return 'cash';
}

function listPersonVoucherPayments(db, limit) {
  const rows = db.prepare(`
    SELECT je.id, je.entry_date AS date, je.description AS note, je.created_at,
           je.ref_type, je.voucher_number, u.name AS recorder,
           (
             SELECT ROUND(COALESCE(SUM(pl.debit),0))
             FROM person_ledger pl
             WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.debit > 0
           ) AS amount,
           (
             SELECT p.name
             FROM person_ledger pl
             JOIN persons p ON p.id = pl.person_id
             WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.debit > 0
             ORDER BY pl.id LIMIT 1
           ) AS target
    FROM journal_entries je
    LEFT JOIN users u ON u.id = je.created_by
    WHERE ${DELETED_FILTER}
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      AND je.ref_type = 'manual_voucher'
      AND EXISTS (
        SELECT 1 FROM person_ledger pl
        WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.debit > 0
      )
      AND (
        ${treasuryCreditExistsSql('je')}
        OR EXISTS (
          SELECT 1 FROM journal_lines jl
          WHERE jl.entry_id = je.id
            AND (
              IFNULL(jl.description,'') LIKE '%پرداخت به شخص%'
              OR IFNULL(jl.description,'') LIKE '%پرداخت از صندوق%'
            )
        )
        OR IFNULL(je.description,'') LIKE '%پرداخت به شخص%'
      )
    ORDER BY je.created_at DESC
    LIMIT ?
  `).all(limit);

  return rows
    .filter((r) => Number(r.amount) > 0)
    .map((r) => ({
      id: r.id,
      kind: 'person',
      date: r.date || '',
      amount: Math.round(Number(r.amount) || 0),
      pay_type: inferPayType(db, r.id, 'payment'),
      note: r.note || '',
      target: r.target || 'شخص',
      recorder: r.recorder || '-',
      created_at: r.created_at || 0,
      ref_type: 'manual_voucher',
      ref_doc_no: r.voucher_number || String(r.id),
      ref_doc_type: 'voucher',
      amendable: false,
    }));
}

function listAccountPayments(db, limit) {
  const rows = db.prepare(`
    SELECT je.id, je.entry_date AS date, je.description AS note, je.created_at,
           je.ref_type, je.voucher_number, u.name AS recorder,
           (
             SELECT ROUND(COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0))
             FROM journal_lines jl
             WHERE jl.entry_id = je.id
               AND ${SQL_JL_DEBIT_RIAL} > 0
               AND NOT ${FEE_CODE_SQL}
           ) AS amount,
           (
             SELECT TRIM(IFNULL(jl.account_code,'') || CASE
               WHEN IFNULL(jl.account_name,'') <> '' THEN ' — ' || jl.account_name
               ELSE '' END)
             FROM journal_lines jl
             WHERE jl.entry_id = je.id
               AND ${SQL_JL_DEBIT_RIAL} > 0
               AND NOT ${FEE_CODE_SQL}
             ORDER BY jl.id LIMIT 1
           ) AS target
    FROM journal_entries je
    LEFT JOIN users u ON u.id = je.created_by
    WHERE ${DELETED_FILTER}
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      AND je.ref_type = 'account_payment'
    ORDER BY je.created_at DESC
    LIMIT ?
  `).all(limit);

  return rows
    .filter((r) => Number(r.amount) > 0)
    .map((r) => ({
      id: r.id,
      kind: 'account',
      date: r.date || '',
      amount: Math.round(Number(r.amount) || 0),
      pay_type: inferPayType(db, r.id, 'payment'),
      note: r.note || '',
      target: r.target || 'حساب',
      recorder: r.recorder || '-',
      created_at: r.created_at || 0,
      ref_type: 'account_payment',
      ref_doc_no: r.voucher_number || String(r.id),
      ref_doc_type: 'voucher',
      amendable: false,
    }));
}

function listPersonVoucherReceipts(db, limit) {
  const rows = db.prepare(`
    SELECT je.id, je.entry_date AS date, je.description AS note, je.created_at,
           je.ref_type, je.voucher_number, u.name AS recorder,
           (
             SELECT ROUND(COALESCE(SUM(pl.credit),0))
             FROM person_ledger pl
             WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.credit > 0
           ) AS amount,
           (
             SELECT p.name
             FROM person_ledger pl
             JOIN persons p ON p.id = pl.person_id
             WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.credit > 0
             ORDER BY pl.id LIMIT 1
           ) AS target
    FROM journal_entries je
    LEFT JOIN users u ON u.id = je.created_by
    WHERE ${DELETED_FILTER}
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      AND je.ref_type = 'manual_voucher'
      AND EXISTS (
        SELECT 1 FROM person_ledger pl
        WHERE pl.ref_type = 'manual_voucher' AND pl.ref_id = je.id AND pl.credit > 0
      )
      AND (
        ${treasuryDebitExistsSql('je')}
        OR EXISTS (
          SELECT 1 FROM journal_lines jl
          WHERE jl.entry_id = je.id
            AND (
              IFNULL(jl.description,'') LIKE '%دریافت از شخص%'
              OR IFNULL(jl.description,'') LIKE '%بستانکار شخص%'
            )
        )
        OR IFNULL(je.description,'') LIKE '%دریافت از شخص%'
      )
    ORDER BY je.created_at DESC
    LIMIT ?
  `).all(limit);

  return rows
    .filter((r) => Number(r.amount) > 0)
    .map((r) => ({
      id: r.id,
      kind: 'person_receipt',
      date: r.date || '',
      amount: Math.round(Number(r.amount) || 0),
      pay_type: inferPayType(db, r.id, 'receipt'),
      note: r.note || '',
      cust_biz: r.target || 'شخص',
      target: r.target || 'شخص',
      recorder_name: r.recorder || '-',
      recorder: r.recorder || '-',
      created_at: r.created_at || 0,
      ref_type: 'manual_voucher',
      ref_doc_no: r.voucher_number || String(r.id),
      ref_doc_type: 'voucher',
      amendable: false,
    }));
}

function listAccountReceipts(db, limit) {
  const rows = db.prepare(`
    SELECT je.id, je.entry_date AS date, je.description AS note, je.created_at,
           je.ref_type, je.voucher_number, u.name AS recorder,
           (
             SELECT ROUND(COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0))
             FROM journal_lines jl
             WHERE jl.entry_id = je.id
               AND ${SQL_JL_CREDIT_RIAL} > 0
               AND NOT ${FEE_CODE_SQL}
           ) AS amount,
           (
             SELECT TRIM(IFNULL(jl.account_code,'') || CASE
               WHEN IFNULL(jl.account_name,'') <> '' THEN ' — ' || jl.account_name
               ELSE '' END)
             FROM journal_lines jl
             WHERE jl.entry_id = je.id
               AND ${SQL_JL_CREDIT_RIAL} > 0
               AND NOT ${FEE_CODE_SQL}
             ORDER BY jl.id LIMIT 1
           ) AS target
    FROM journal_entries je
    LEFT JOIN users u ON u.id = je.created_by
    WHERE ${DELETED_FILTER}
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      AND je.ref_type = 'account_receipt'
    ORDER BY je.created_at DESC
    LIMIT ?
  `).all(limit);

  return rows
    .filter((r) => Number(r.amount) > 0)
    .map((r) => ({
      id: r.id,
      kind: 'account_receipt',
      date: r.date || '',
      amount: Math.round(Number(r.amount) || 0),
      pay_type: inferPayType(db, r.id, 'receipt'),
      note: r.note || '',
      cust_biz: r.target || 'حساب',
      target: r.target || 'حساب',
      recorder_name: r.recorder || '-',
      recorder: r.recorder || '-',
      created_at: r.created_at || 0,
      ref_type: 'account_receipt',
      ref_doc_no: r.voucher_number || String(r.id),
      ref_doc_type: 'voucher',
      amendable: false,
    }));
}

function listCashOpsOutgoing(db, { limit = 300 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 300));
  const rows = [
    ...listPersonVoucherPayments(db, lim),
    ...listAccountPayments(db, lim),
  ];
  rows.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  return rows.slice(0, lim);
}

function listCashOpsIncomingExtra(db, { limit = 300 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 300));
  const rows = [
    ...listPersonVoucherReceipts(db, lim),
    ...listAccountReceipts(db, lim),
  ];
  rows.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  return rows.slice(0, lim);
}

module.exports = {
  listCashOpsOutgoing,
  listCashOpsIncomingExtra,
  listPersonVoucherPayments,
  listAccountPayments,
  listPersonVoucherReceipts,
  listAccountReceipts,
};
