'use strict';
/**
 * GL ↔ cheque subledger reconciliation for 1109 / 1116 / 2109 (+ bounced map).
 * Counts only record_status='posted' — reversed rows must not inflate ops.
 */

const { glBalanceOnCode } = require('./treasury-dashboard');
const { sqlIsRegistered } = require('./cheque-lifecycle');

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function postedAlive() {
  return "COALESCE(record_status,'posted')='posted'";
}

function sumPosted(db, where, params = []) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM cheque_records
    WHERE ${postedAlive()} AND ${where}
  `).get(...params);
  return { count: Number(row.count) || 0, amount: Number(row.amount) || 0 };
}

function glBalanceRial(db, code) {
  try {
    const bal = glBalanceOnCode(db, code);
    // treasury helper often returns toman*10 or rial — normalize to rial if small
    const n = Number(bal) || 0;
    return Math.round(n);
  } catch (_) {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(
          COALESCE(jl.debit_rial, jl.debit*10, 0) - COALESCE(jl.credit_rial, jl.credit*10, 0)
        ),0) AS bal
        FROM journal_lines jl
        JOIN journal_entries je ON je.id=jl.entry_id
        WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      `).get(code);
      return Math.round(Number(row && row.bal) || 0);
    } catch (e2) {
      return 0;
    }
  }
}

function buildChequeReconciliation(db) {
  const reg = sqlIsRegistered('lifecycle_status');
  const ops1109 = sumPosted(db, `direction='in' AND ${reg}`);
  const ops1116 = sumPosted(db, "direction='in' AND lifecycle_status='in_collection'");
  const ops2109 = sumPosted(db, `direction='out' AND ${reg}`);

  let bouncedCode = '1105';
  try {
    const { acct } = require('./coa-map');
    const a = acct(db, 'coa_bounced_cheques') || acct(db, 'coa_notes_dishonored');
    if (a && a.code) bouncedCode = a.code;
  } catch (_) { /* */ }
  const opsBounce = sumPosted(db, "direction='in' AND lifecycle_status='bounced'");

  const gl1109 = glBalanceRial(db, '1109');
  const gl1116 = glBalanceRial(db, '1116');
  const gl2109 = glBalanceRial(db, '2109');
  // payable GL often credit-normal → negative balance; compare abs for variance
  const accounts = [
    {
      code: '1109',
      label: 'اسناد دریافتنی نزد صندوق',
      gl_rial: gl1109,
      ops_rial: ops1109.amount,
      ops_count: ops1109.count,
      variance_rial: gl1109 - ops1109.amount,
    },
    {
      code: '1116',
      label: 'اسناد در جریان وصول',
      gl_rial: gl1116,
      ops_rial: ops1116.amount,
      ops_count: ops1116.count,
      variance_rial: gl1116 - ops1116.amount,
    },
    {
      code: '2109',
      label: 'اسناد پرداختنی',
      gl_rial: gl2109,
      ops_rial: -ops2109.amount, // credit normal
      ops_count: ops2109.count,
      ops_absolute_rial: ops2109.amount,
      variance_rial: gl2109 + ops2109.amount,
    },
    {
      code: bouncedCode,
      label: 'اسناد واخواستی / برگشتی',
      gl_rial: glBalanceRial(db, bouncedCode),
      ops_rial: opsBounce.amount,
      ops_count: opsBounce.count,
      variance_rial: glBalanceRial(db, bouncedCode) - opsBounce.amount,
    },
  ];

  const noJe = db.prepare(`
    SELECT id, direction, cheque_number, amount, party_name, lifecycle_status, sayadi
    FROM cheque_records
    WHERE ${postedAlive()}
      AND COALESCE(journal_entry_id,0)=0
      AND COALESCE(settlement_id,0)=0
    ORDER BY id DESC LIMIT 200
  `).all();

  const orphanJes = db.prepare(`
    SELECT je.id, je.ref_type, je.ref_id, je.entry_date, je.description, je.voucher_number,
           COALESCE(je.deleted_at,0) AS deleted_at
    FROM journal_entries je
    WHERE (
      je.ref_type LIKE 'cheque_%'
      OR je.ref_type LIKE 'opening_cheque%'
    )
      AND COALESCE(je.deleted_at,0)=0
      AND NOT EXISTS (
        SELECT 1 FROM cheque_records cr
        WHERE cr.id=je.ref_id AND COALESCE(cr.record_status,'posted')='posted'
      )
    ORDER BY je.id DESC LIMIT 200
  `).all();

  const deletedJeActiveCheque = db.prepare(`
    SELECT cr.id AS cheque_id, cr.cheque_number, cr.amount, je.id AS je_id, je.ref_type, je.deleted_at
    FROM cheque_records cr
    JOIN journal_entries je ON je.id=cr.journal_entry_id
    WHERE ${postedAlive().replace(/cheque_records/g, 'cr')}
      AND COALESCE(je.deleted_at,0)>0
    LIMIT 200
  `).all();

  return {
    generated_at: Date.now(),
    accounts,
    drilldown: {
      cheques_without_je: noJe,
      jes_without_cheque: orphanJes,
      deleted_je_active_cheque: deletedJeActiveCheque,
    },
  };
}

/**
 * Opening-cheque subledger vs GL on 1109 (in) / 2109 (out) from opening_cheque JEs only.
 */
function buildOpeningChequeReconciliation(db, directionRaw) {
  const direction = directionRaw === 'out' ? 'out' : 'in';
  const code = direction === 'in' ? '1109' : '2109';
  const { OPENING_NOTE } = require('./cheque-lifecycle');
  const alive = postedAlive();
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM cheque_records
    WHERE ${alive}
      AND direction=?
      AND (note LIKE ? OR status LIKE ?)
  `).get(direction, '%' + OPENING_NOTE + '%', '%اول دوره%');
  const cheques = { count: Number(row.count) || 0, amount: Number(row.amount) || 0 };

  const glRow = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(jl.debit_rial, jl.debit * 10, 0)), 0) AS debit,
      COALESCE(SUM(COALESCE(jl.credit_rial, jl.credit * 10, 0)), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN cheque_records cr ON cr.id = je.ref_id
    WHERE jl.account_code = ?
      AND je.ref_type = 'opening_cheque'
      AND cr.direction = ?
      AND COALESCE(je.deleted_at, 0) = 0
      AND ${alive.replace(/cheque_records/g, 'cr')}
  `).get(code, direction);
  const debit = Number(glRow && glRow.debit) || 0;
  const credit = Number(glRow && glRow.credit) || 0;
  const gl_rial = direction === 'in' ? debit - credit : credit - debit;

  return {
    direction,
    account_code: code,
    cheques_count: cheques.count,
    cheques_rial: cheques.amount,
    gl_opening_rial: Math.round(gl_rial),
    variance_rial: Math.round(gl_rial) - cheques.amount,
  };
}

module.exports = {
  buildChequeReconciliation,
  buildOpeningChequeReconciliation,
  sumPosted,
  glBalanceRial,
  tableHasColumn,
};
