// Representative sub-ledger helpers — loosely coupled to core accounting.
// Journal entries are created only for explicit cash movements (expense pay, advance).
const { createJournalEntry } = require('../db');

const REP_ROLES = "('field_sales','inside_sales')";
const EXPENSE_CATEGORIES = {
  transport: 'حمل‌ونقل', fuel: 'سوخت', hotel: 'هتل', meals: 'پذیرایی',
  gifts: 'هدایا', advertising: 'تبلیغات', entertainment: 'پذیرایی مشتری',
  office: 'اداری', other: 'سایر'
};

function isRepRole(role) {
  return role === 'field_sales' || role === 'inside_sales';
}

function addRepLedger(db, { rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by }) {
  return db.prepare(`
    INSERT INTO rep_ledger (rep_id,date,entry_type,ref_type,ref_id,description,debit,credit,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(rep_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, created_by || null);
}

function computeRepCommission(db, repId, { from, to } = {}) {
  const u = db.prepare('SELECT commission_cash, commission_cheque FROM users WHERE id=?').get(repId);
  if (!u) return { cashSales: 0, chequeSales: 0, returns: 0, cashComm: 0, chequeComm: 0, totalComm: 0 };
  let invWhere = "user_id=? AND type='final' AND approved=1";
  const invParams = [repId];
  if (from) { invWhere += ' AND date>=?'; invParams.push(from); }
  if (to) { invWhere += ' AND date<=?'; invParams.push(to); }
  const cashSales = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere} AND pay_type='cash'`).get(...invParams).s;
  const chequeSales = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere} AND pay_type='cheque'`).get(...invParams).s;
  let retWhere = 'user_id=?';
  const retParams = [repId];
  if (from) { retWhere += ' AND date>=?'; retParams.push(from); }
  if (to) { retWhere += ' AND date<=?'; retParams.push(to); }
  const returns = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM sales_returns WHERE ${retWhere}`).get(...retParams).s;
  const netCash = Math.max(0, cashSales);
  const netCheque = Math.max(0, chequeSales);
  const cashComm = netCash * (u.commission_cash || 0) / 100;
  const chequeComm = netCheque * (u.commission_cheque || 0) / 100;
  const returnPenalty = returns * ((u.commission_cash || 0) + (u.commission_cheque || 0)) / 200;
  const totalComm = Math.max(0, cashComm + chequeComm - returnPenalty);
  return { cashSales: netCash, chequeSales: netCheque, returns, cashComm, chequeComm, totalComm };
}

function buildRepLedgerView(db, repId, { from, to } = {}) {
  const u = db.prepare(`
    SELECT id,name,username,role,phone,active,rep_code,rep_subtype,territory,supervisor_id,
      employment_status,bank_name,bank_account,bank_iban,contract_file,rep_opening_balance,
      commission_cash,commission_cheque
    FROM users WHERE id=?
  `).get(repId);
  if (!u) return null;

  const comm = computeRepCommission(db, repId, { from, to });
  let paidWhere = 'rep_id=?';
  const paidParams = [repId];
  if (from) { paidWhere += ' AND date>=?'; paidParams.push(from); }
  if (to) { paidWhere += ' AND date<=?'; paidParams.push(to); }
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE ${paidWhere}`).get(...paidParams).s;

  let expSql = `SELECT COALESCE(SUM(amount),0) s FROM rep_expenses WHERE rep_id=? AND status='approved'`;
  const expParams = [repId];
  if (from) { expSql += ' AND date>=?'; expParams.push(from); }
  if (to) { expSql += ' AND date<=?'; expParams.push(to); }
  const expenses = db.prepare(expSql).get(...expParams).s;

  let advSql = `SELECT COALESCE(SUM(amount),0) s, COALESCE(SUM(settled_amount),0) settled FROM rep_advances WHERE rep_id=?`;
  const advParams = [repId];
  if (from) { advSql += ' AND date>=?'; advParams.push(from); }
  if (to) { advSql += ' AND date<=?'; advParams.push(to); }
  const advances = db.prepare(advSql).get(...advParams);

  let manSql = `SELECT * FROM rep_ledger WHERE rep_id=?`;
  const manParams = [repId];
  if (from) { manSql += ' AND date>=?'; manParams.push(from); }
  if (to) { manSql += ' AND date<=?'; manParams.push(to); }
  manSql += ' ORDER BY created_at DESC LIMIT 200';
  const manual = db.prepare(manSql).all(...manParams);

  const opening = u.rep_opening_balance || 0;
  const balance = opening + comm.totalComm - paid - (expenses || 0) - ((advances.s || 0) - (advances.settled || 0));

  return {
    rep: u,
    commission: comm,
    paid,
    expenses: expenses || 0,
    advances: advances.s || 0,
    advancesSettled: advances.settled || 0,
    opening,
    balance,
    payable: Math.max(0, comm.totalComm - paid),
    manualEntries: manual
  };
}

module.exports = {
  REP_ROLES, EXPENSE_CATEGORIES, isRepRole, addRepLedger, computeRepCommission, buildRepLedgerView
};
