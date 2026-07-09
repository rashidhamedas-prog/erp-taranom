// Representative sub-ledger helpers — loosely coupled to core accounting.
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

function getRepRates(db, repId, productId, categoryId) {
  const u = db.prepare('SELECT commission_cash, commission_cheque FROM users WHERE id=?').get(repId);
  const base = { cash: u?.commission_cash || 0, cheque: u?.commission_cheque || 0 };
  if (productId) {
    const pr = db.prepare("SELECT rate_cash, rate_cheque FROM rep_commission_rules WHERE rep_id=? AND scope_type='product' AND scope_id=? AND active=1").get(repId, productId);
    if (pr) return { cash: pr.rate_cash, cheque: pr.rate_cheque };
  }
  if (categoryId) {
    const cr = db.prepare("SELECT rate_cash, rate_cheque FROM rep_commission_rules WHERE rep_id=? AND scope_type='category' AND scope_id=? AND active=1").get(repId, categoryId);
    if (cr) return { cash: cr.rate_cash, cheque: cr.rate_cheque };
  }
  return base;
}

function lineTotal(row) {
  const qty = row.qty || 0, price = row.price || 0, disc = row.disc || 0;
  return qty * price * (1 - disc / 100);
}

function computeRepCommission(db, repId, { from, to } = {}) {
  const u = db.prepare('SELECT commission_cash, commission_cheque, commission_basis, monthly_target FROM users WHERE id=?').get(repId);
  if (!u) return { cashSales: 0, chequeSales: 0, returns: 0, cashComm: 0, chequeComm: 0, totalComm: 0, basis: 'invoice', monthlyTarget: 0, targetPct: 0 };

  const hasRules = db.prepare('SELECT 1 FROM rep_commission_rules WHERE rep_id=? AND active=1 LIMIT 1').get(repId);
  const basis = u.commission_basis || 'invoice';

  let cashSales = 0, chequeSales = 0, cashComm = 0, chequeComm = 0;

  if (basis === 'collection') {
    let sql = `
      SELECT i.pay_type, COALESCE(SUM(s.amount),0) s
      FROM settlements s JOIN invoices i ON s.invoice_id=i.id
      WHERE i.user_id=? AND i.type='final' AND i.approved=1`;
    const p = [repId];
    if (from) { sql += ' AND s.date>=?'; p.push(from); }
    if (to) { sql += ' AND s.date<=?'; p.push(to); }
    sql += ' GROUP BY i.pay_type';
    for (const r of db.prepare(sql).all(...p)) {
      if (r.pay_type === 'cheque') chequeSales = r.s; else cashSales = r.s;
    }
    cashComm = cashSales * (u.commission_cash || 0) / 100;
    chequeComm = chequeSales * (u.commission_cheque || 0) / 100;
  } else if (hasRules) {
    let sql = "SELECT * FROM invoices WHERE user_id=? AND type='final' AND approved=1";
    const p = [repId];
    if (from) { sql += ' AND date>=?'; p.push(from); }
    if (to) { sql += ' AND date<=?'; p.push(to); }
    for (const inv of db.prepare(sql).all(...p)) {
      let rows = [];
      try { rows = JSON.parse(inv.rows || '[]'); } catch { rows = []; }
      for (const row of rows) {
        const prod = row.product_id ? db.prepare('SELECT category FROM products WHERE id=?').get(row.product_id) : null;
        const rates = getRepRates(db, repId, row.product_id, prod?.category);
        const lt = lineTotal(row);
        if (inv.pay_type === 'cheque') {
          chequeSales += lt;
          chequeComm += lt * rates.cheque / 100;
        } else {
          cashSales += lt;
          cashComm += lt * rates.cash / 100;
        }
      }
    }
  } else {
    let invWhere = "user_id=? AND type='final' AND approved=1";
    const invParams = [repId];
    if (from) { invWhere += ' AND date>=?'; invParams.push(from); }
    if (to) { invWhere += ' AND date<=?'; invParams.push(to); }
    cashSales = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere} AND pay_type='cash'`).get(...invParams).s;
    chequeSales = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere} AND pay_type='cheque'`).get(...invParams).s;
    cashComm = cashSales * (u.commission_cash || 0) / 100;
    chequeComm = chequeSales * (u.commission_cheque || 0) / 100;
  }

  let retWhere = 'user_id=?';
  const retParams = [repId];
  if (from) { retWhere += ' AND date>=?'; retParams.push(from); }
  if (to) { retWhere += ' AND date<=?'; retParams.push(to); }
  const returns = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM sales_returns WHERE ${retWhere}`).get(...retParams).s;
  const returnPenalty = returns * ((u.commission_cash || 0) + (u.commission_cheque || 0)) / 200;
  const totalComm = Math.max(0, cashComm + chequeComm - returnPenalty);
  const salesTotal = cashSales + chequeSales;
  const monthlyTarget = u.monthly_target || 0;
  const targetPct = monthlyTarget > 0 ? Math.min(100, Math.round(salesTotal / monthlyTarget * 100)) : 0;

  return {
    cashSales, chequeSales, returns, cashComm, chequeComm, totalComm,
    basis, monthlyTarget, targetPct, salesTotal
  };
}

function buildRepLedgerView(db, repId, { from, to } = {}) {
  const u = db.prepare(`
    SELECT id,name,username,role,phone,active,rep_code,rep_subtype,territory,supervisor_id,
      employment_status,bank_name,bank_account,bank_iban,contract_file,rep_opening_balance,
      commission_cash,commission_cheque,commission_basis,monthly_target
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

function notifyRep(db, repId, body, fromId) {
  try {
    db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)').run(fromId || 1, repId, body);
  } catch { /* messages table optional */ }
}

module.exports = {
  EXPENSE_CATEGORIES, isRepRole, addRepLedger, computeRepCommission, buildRepLedgerView, notifyRep, getRepRates
};
