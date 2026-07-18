// Representative sub-ledger + commission engine — loosely coupled to core accounting.
const EXPENSE_CATEGORIES = {
  transport: 'حمل‌ونقل', fuel: 'سوخت', hotel: 'هتل', meals: 'پذیرایی',
  gifts: 'هدایا', advertising: 'تبلیغات', entertainment: 'پذیرایی مشتری',
  office: 'اداری', other: 'سایر'
};

const REP_ROLES_SQL = "('field_sales','inside_sales')";

function isRepRole(role) {
  return role === 'field_sales' || role === 'inside_sales';
}

function addRepLedger(db, { rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by }) {
  return db.prepare(`
    INSERT INTO rep_ledger (rep_id,date,entry_type,ref_type,ref_id,description,debit,credit,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(rep_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, created_by || null);
}

function lineTotal(row) {
  const qty = row.qty || 0, price = row.price || 0, disc = row.disc || 0;
  return qty * price * (1 - disc / 100);
}

function lineProfit(db, row) {
  const lt = lineTotal(row);
  if (!row.product_id) return lt;
  const prod = db.prepare('SELECT cost FROM products WHERE id=?').get(row.product_id);
  const cost = (prod?.cost || 0) * (row.qty || 0);
  return Math.max(0, lt - cost);
}

function getTierRates(db, repId, salesTotal, payType) {
  const tiers = db.prepare(`
    SELECT * FROM rep_commission_tiers WHERE rep_id=? AND active=1
    ORDER BY from_amount ASC
  `).all(repId);
  if (!tiers.length) return null;
  const field = payType === 'cheque' ? 'rate_cheque' : 'rate_cash';
  for (const t of tiers) {
    const from = t.from_amount || 0;
    const to = t.to_amount != null ? t.to_amount : Infinity;
    if (salesTotal >= from && salesTotal <= to) return t[field] || 0;
  }
  const last = tiers[tiers.length - 1];
  return last[field] || 0;
}

function getRepRates(db, repId, productId, categoryId, brand, customerId) {
  const u = db.prepare('SELECT commission_cash, commission_cheque, commission_fixed FROM users WHERE id=?').get(repId);
  const base = { cash: u?.commission_cash || 0, cheque: u?.commission_cheque || 0, fixed: u?.commission_fixed || 0 };
  const scopes = [
    ['customer', customerId],
    ['product', productId],
    ['category', categoryId],
    ['brand', brand]
  ];
  for (const [type, sid] of scopes) {
    if (!sid && type !== 'brand') continue;
    if (type === 'brand' && brand) {
      const br = db.prepare("SELECT rate_cash, rate_cheque FROM rep_commission_rules WHERE rep_id=? AND scope_type='brand' AND scope_label=? AND active=1").get(repId, brand);
      if (br) return { cash: br.rate_cash, cheque: br.rate_cheque, fixed: 0 };
      continue;
    }
    const row = db.prepare(`SELECT rate_cash, rate_cheque FROM rep_commission_rules WHERE rep_id=? AND scope_type=? AND scope_id=? AND active=1`).get(repId, type, sid);
    if (row) return { cash: row.rate_cash, cheque: row.rate_cheque, fixed: 0 };
  }
  return base;
}

function applyLineCommission(db, repId, inv, row, customerId, basis) {
  const prod = row.product_id ? db.prepare('SELECT category, brand, cost FROM products WHERE id=?').get(row.product_id) : null;
  const rates = getRepRates(db, repId, row.product_id, prod?.category, prod?.brand, customerId);
  const lt = lineTotal(row);
  const base = basis === 'profit' ? Math.max(0, lt - (prod?.cost || 0) * (row.qty || 0)) : lt;
  const payType = inv.pay_type === 'cheque' ? 'cheque' : 'cash';
  let comm = 0;
  if (rates.fixed > 0) comm = rates.fixed;
  else comm = base * (payType === 'cheque' ? rates.cheque : rates.cash) / 100;
  return { lt, base, comm, payType };
}

function computeRepCommission(db, repId, { from, to } = {}) {
  const u = db.prepare(`
    SELECT commission_cash, commission_cheque, commission_basis, monthly_target, quarterly_target,
      annual_target, bonus_pct, commission_fixed, penalty_pct
    FROM users WHERE id=?
  `).get(repId);
  if (!u) {
    return {
      cashSales: 0, chequeSales: 0, returns: 0, cashComm: 0, chequeComm: 0, totalComm: 0,
      basis: 'invoice', monthlyTarget: 0, quarterlyTarget: 0, annualTarget: 0,
      targetPct: 0, quarterlyPct: 0, annualPct: 0, salesTotal: 0, bonusComm: 0, invoiceCount: 0
    };
  }

  const hasRules = db.prepare('SELECT 1 FROM rep_commission_rules WHERE rep_id=? AND active=1 LIMIT 1').get(repId);
  const hasTiers = db.prepare('SELECT 1 FROM rep_commission_tiers WHERE rep_id=? AND active=1 LIMIT 1').get(repId);
  const basis = u.commission_basis || 'invoice';
  let cashSales = 0, chequeSales = 0, cashComm = 0, chequeComm = 0, invoiceCount = 0;

  if (basis === 'collection') {
    let sql = `
      SELECT i.id, i.pay_type, i.cust_id, i.rows, s.amount as collected
      FROM settlements s JOIN invoices i ON s.invoice_id=i.id
      WHERE i.user_id=? AND i.type='final' AND i.approved=1`;
    const p = [repId];
    if (from) { sql += ' AND s.date>=?'; p.push(from); }
    if (to) { sql += ' AND s.date<=?'; p.push(to); }
    const rows = db.prepare(sql).all(...p);
    for (const r of rows) {
      const amt = r.collected || 0;
      if (r.pay_type === 'cheque') chequeSales += amt; else cashSales += amt;
      if (hasRules && r.rows) {
        let invRows = [];
        try { invRows = JSON.parse(r.rows || '[]'); } catch { invRows = []; }
        const invTotal = invRows.reduce((a, x) => a + lineTotal(x), 0) || 1;
        for (const row of invRows) {
          const { comm } = applyLineCommission(db, repId, r, row, r.cust_id, basis);
          const share = amt * (lineTotal(row) / invTotal);
          if (r.pay_type === 'cheque') chequeComm += comm * (share / (lineTotal(row) || 1));
          else cashComm += comm * (share / (lineTotal(row) || 1));
        }
      } else {
        const tierCash = hasTiers ? getTierRates(db, repId, cashSales + chequeSales, 'cash') : null;
        const tierCheque = hasTiers ? getTierRates(db, repId, cashSales + chequeSales, 'cheque') : null;
        if (r.pay_type === 'cheque') {
          chequeComm += amt * ((tierCheque != null ? tierCheque : u.commission_cheque) || 0) / 100;
        } else {
          cashComm += amt * ((tierCash != null ? tierCash : u.commission_cash) || 0) / 100;
        }
      }
    }
  } else {
    let sql = "SELECT * FROM invoices WHERE user_id=? AND type='final' AND approved=1";
    const p = [repId];
    if (from) { sql += ' AND date>=?'; p.push(from); }
    if (to) { sql += ' AND date<=?'; p.push(to); }
    const invs = db.prepare(sql).all(...p);
    invoiceCount = invs.length;
    for (const inv of invs) {
      if (u.commission_fixed > 0) {
        if (inv.pay_type === 'cheque') { chequeSales += inv.final || 0; chequeComm += u.commission_fixed; }
        else { cashSales += inv.final || 0; cashComm += u.commission_fixed; }
        continue;
      }
      if (hasRules) {
        let rows = [];
        try { rows = JSON.parse(inv.rows || '[]'); } catch { rows = []; }
        for (const row of rows) {
          const { lt, comm, payType } = applyLineCommission(db, repId, inv, row, inv.cust_id, basis);
          if (payType === 'cheque') { chequeSales += lt; chequeComm += comm; }
          else { cashSales += lt; cashComm += comm; }
        }
      } else {
        const lt = inv.final || 0;
        const salesSoFar = cashSales + chequeSales + lt;
        const tierRate = hasTiers ? getTierRates(db, repId, salesSoFar, inv.pay_type) : null;
        if (inv.pay_type === 'cheque') {
          chequeSales += lt;
          chequeComm += lt * ((tierRate != null ? tierRate : u.commission_cheque) || 0) / 100;
        } else {
          cashSales += lt;
          cashComm += lt * ((tierRate != null ? tierRate : u.commission_cash) || 0) / 100;
        }
      }
    }
  }

  let retWhere = 'user_id=?';
  const retParams = [repId];
  if (from) { retWhere += ' AND date>=?'; retParams.push(from); }
  if (to) { retWhere += ' AND date<=?'; retParams.push(to); }
  const returns = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM sales_returns WHERE ${retWhere}`).get(...retParams).s;
  const penaltyRate = u.penalty_pct || 0;
  const returnPenalty = returns * (penaltyRate > 0 ? penaltyRate : ((u.commission_cash || 0) + (u.commission_cheque || 0)) / 200);
  let totalComm = Math.max(0, cashComm + chequeComm - returnPenalty);
  const salesTotal = cashSales + chequeSales;

  const monthlyTarget = u.monthly_target || 0;
  const quarterlyTarget = u.quarterly_target || 0;
  const annualTarget = u.annual_target || 0;
  const targetPct = monthlyTarget > 0 ? Math.min(999, Math.round(salesTotal / monthlyTarget * 100)) : 0;
  const quarterlyPct = quarterlyTarget > 0 ? Math.min(999, Math.round(salesTotal / quarterlyTarget * 100)) : 0;
  const annualPct = annualTarget > 0 ? Math.min(999, Math.round(salesTotal / annualTarget * 100)) : 0;

  let penaltyComm = 0;
  if (penaltyRate > 0 && monthlyTarget > 0 && targetPct < 100) {
    penaltyComm = totalComm * (penaltyRate / 100);
    totalComm = Math.max(0, totalComm - penaltyComm);
  }

  let bonusComm = 0;
  if ((u.bonus_pct || 0) > 0 && targetPct >= 100) {
    bonusComm = totalComm * (u.bonus_pct / 100);
    totalComm += bonusComm;
  }

  return {
    cashSales, chequeSales, returns, cashComm, chequeComm, totalComm, bonusComm, penaltyComm,
    basis: u.commission_basis || 'invoice', monthlyTarget, quarterlyTarget, annualTarget,
    targetPct, quarterlyPct, annualPct, salesTotal, invoiceCount
  };
}

function getAdvanceBalance(db, repId, { from, to } = {}) {
  let sql = `SELECT COALESCE(SUM(amount),0) s, COALESCE(SUM(settled_amount),0) settled FROM rep_advances WHERE rep_id=?`;
  const p = [repId];
  if (from) { sql += ' AND date>=?'; p.push(from); }
  if (to) { sql += ' AND date<=?'; p.push(to); }
  const r = db.prepare(sql).get(...p);
  return { total: r.s || 0, settled: r.settled || 0, remaining: Math.max(0, (r.s || 0) - (r.settled || 0)) };
}

function computeRepPayable(db, repId, opts = {}) {
  const view = buildRepLedgerView(db, repId, opts);
  if (!view) return { payable: 0, netBalance: 0 };
  const netPayable = Math.max(0, view.commission.totalComm - view.paid - view.advancesRemaining);
  return { payable: netPayable, netBalance: view.balance, ...view };
}

function buildRepLedgerView(db, repId, { from, to } = {}) {
  const u = db.prepare(`
    SELECT id,name,username,role,phone,active,rep_code,rep_subtype,territory,supervisor_id,
      employment_status,bank_name,bank_account,bank_iban,contract_file,rep_opening_balance,
      commission_cash,commission_cheque,commission_basis,monthly_target,quarterly_target,annual_target,bonus_pct
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

  const adv = getAdvanceBalance(db, repId, { from, to });
  const opening = u.rep_opening_balance || 0;
  const balance = opening + comm.totalComm - paid - (expenses || 0) - adv.remaining;
  const payable = Math.max(0, comm.totalComm - paid - adv.remaining);

  let manSql = `SELECT * FROM rep_ledger WHERE rep_id=?`;
  const manParams = [repId];
  if (from) { manSql += ' AND date>=?'; manParams.push(from); }
  if (to) { manSql += ' AND date<=?'; manParams.push(to); }
  manSql += ' ORDER BY created_at DESC LIMIT 500';
  const manual = db.prepare(manSql).all(...manParams);

  return {
    rep: u,
    commission: comm,
    paid,
    expenses: expenses || 0,
    advances: adv.total,
    advancesSettled: adv.settled,
    advancesRemaining: adv.remaining,
    opening,
    balance,
    payable,
    manualEntries: manual
  };
}

function buildRepStatement(db, repId, { from, to } = {}) {
  const view = buildRepLedgerView(db, repId, { from, to });
  if (!view) return null;
  const entries = [];

  entries.push({
    date: from || '', type: 'summary', type_label: 'خلاصه', description: 'انگیزه محاسبه‌شده دوره',
    debit: 0, credit: view.commission.totalComm, running_balance: null
  });

  const pays = db.prepare(`SELECT * FROM incentive_payments WHERE rep_id=?${from ? ' AND date>=?' : ''}${to ? ' AND date<=?' : ''} ORDER BY date DESC, id DESC LIMIT 200`).all(repId, ...(from ? [from] : []), ...(to ? [to] : []));
  for (const p of pays) {
    entries.push({ date: p.date, type: 'payment', type_label: 'پرداخت انگیزه', description: p.note || '', debit: p.amount, credit: 0, reference: `#${p.id}` });
  }

  const exps = db.prepare(`SELECT * FROM rep_expenses WHERE rep_id=? AND status='approved'${from ? ' AND date>=?' : ''}${to ? ' AND date<=?' : ''} ORDER BY date DESC LIMIT 200`).all(repId, ...(from ? [from] : []), ...(to ? [to] : []));
  for (const e of exps) {
    entries.push({ date: e.date, type: 'expense', type_label: EXPENSE_CATEGORIES[e.category] || 'هزینه', description: e.description || '', debit: e.amount, credit: 0, reference: `#${e.id}` });
  }

  const advs = db.prepare(`SELECT * FROM rep_advances WHERE rep_id=?${from ? ' AND date>=?' : ''}${to ? ' AND date<=?' : ''} ORDER BY date DESC LIMIT 200`).all(repId, ...(from ? [from] : []), ...(to ? [to] : []));
  for (const a of advs) {
    entries.push({ date: a.date, type: 'advance', type_label: 'مساعده', description: a.note || '', debit: a.amount, credit: 0, reference: `#${a.id}` });
  }

  for (const m of view.manualEntries) {
    entries.push({ date: m.date, type: m.entry_type, type_label: m.entry_type, description: m.description || '', debit: m.debit, credit: m.credit, reference: `#${m.id}` });
  }

  return {
    rep: view.rep,
    opening: view.opening,
    closing: view.balance,
    commission: view.commission,
    payable: view.payable,
    paid: view.paid,
    expenses: view.expenses,
    advancesRemaining: view.advancesRemaining,
    entries
  };
}

function settleAdvancesAgainstPayment(db, repId, amount, paymentId, userId) {
  let remaining = amount;
  const rows = db.prepare(`
    SELECT id, amount, settled_amount FROM rep_advances
    WHERE rep_id=? AND (amount - COALESCE(settled_amount,0)) > 0.01
    ORDER BY created_at ASC
  `).all(repId);
  let totalSettled = 0;
  for (const a of rows) {
    if (remaining <= 0) break;
    const open = a.amount - (a.settled_amount || 0);
    const take = Math.min(open, remaining);
    db.prepare('UPDATE rep_advances SET settled_amount=COALESCE(settled_amount,0)+? WHERE id=?').run(take, a.id);
    addRepLedger(db, {
      rep_id: repId, date: '', entry_type: 'advance_settle', ref_type: 'incentive_payment', ref_id: paymentId,
      description: `تسویه مساعده #${a.id}`, debit: 0, credit: take, created_by: userId
    });
    remaining -= take;
    totalSettled += take;
  }
  return totalSettled;
}

function recordIncentivePaymentLedger(db, { rep_id, amount, date, payment_id, created_by }) {
  addRepLedger(db, {
    rep_id, date, entry_type: 'commission_paid', ref_type: 'incentive_payment', ref_id: payment_id,
    description: 'پرداخت انگیزه فروش', debit: amount, credit: 0, created_by
  });
}

function getRepRanking(db, { from, to } = {}) {
  const reps = db.prepare(`SELECT id,name,role,territory,monthly_target FROM users WHERE active=1 AND role IN ${REP_ROLES_SQL}`).all();
  return reps.map(r => {
    const comm = computeRepCommission(db, r.id, { from, to });
    const view = buildRepLedgerView(db, r.id, { from, to });
    const collected = db.prepare(`
      SELECT COALESCE(SUM(s.amount),0) s FROM settlements s
      JOIN invoices i ON s.invoice_id=i.id WHERE i.user_id=?
      ${from ? ' AND s.date>=?' : ''}${to ? ' AND s.date<=?' : ''}
    `).get(r.id, ...(from ? [from] : []), ...(to ? [to] : [])).s;
    const customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE user_id=?').get(r.id).c;
    return {
      id: r.id, name: r.name, role: r.role, territory: r.territory,
      roleLabel: r.role === 'inside_sales' ? 'تلفنی' : 'میدانی',
      salesTotal: comm.salesTotal, totalComm: comm.totalComm, collected,
      customers, targetPct: comm.targetPct, payable: view?.payable || 0, balance: view?.balance || 0
    };
  }).sort((a, b) => b.salesTotal - a.salesTotal);
}

function getRepAgingReceivables(db, repId) {
  const today = require('../jalali').todayJalali();
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner,
      COALESCE(lb.balance,0) AS balance
    FROM customers c
    LEFT JOIN (SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance FROM customer_ledger GROUP BY customer_id) lb ON lb.customer_id=c.id
    WHERE c.user_id=? AND COALESCE(lb.balance,0) > 0
    ORDER BY balance DESC
  `).all(repId);
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  for (const r of rows) {
    const lastInv = db.prepare("SELECT date FROM invoices WHERE cust_id=? AND type='final' ORDER BY date DESC LIMIT 1").get(r.id);
    buckets.current += r.balance;
    if (lastInv?.date && lastInv.date < today) buckets.d30 += r.balance * 0.3;
  }
  return { rows, buckets, total: rows.reduce((a, r) => a + r.balance, 0) };
}

function getTeamRollup(db, supervisorId, opts = {}) {
  const supervisor = db.prepare('SELECT id,name,supervisor_commission_pct FROM users WHERE id=?').get(supervisorId);
  const overridePct = supervisor?.supervisor_commission_pct || 0;
  const team = db.prepare(`SELECT id,name,role FROM users WHERE active=1 AND supervisor_id=? AND role IN ${REP_ROLES_SQL}`).all(supervisorId);
  const members = team.map(m => {
    const comm = computeRepCommission(db, m.id, opts);
    const view = buildRepLedgerView(db, m.id, opts);
    const overrideComm = (comm.totalComm || 0) * overridePct / 100;
    return { ...m, ...comm, payable: view?.payable || 0, balance: view?.balance || 0, overrideComm };
  });
  const supervisorComm = members.reduce((a, m) => a + (m.overrideComm || 0), 0);
  return {
    supervisor_id: supervisorId,
    supervisor_name: supervisor?.name || '',
    overridePct,
    teamSize: members.length,
    salesTotal: members.reduce((a, m) => a + (m.salesTotal || 0), 0),
    totalComm: members.reduce((a, m) => a + (m.totalComm || 0), 0),
    supervisorComm,
    payable: members.reduce((a, m) => a + (m.payable || 0), 0),
    members
  };
}

function canAccessRep(db, user, repId) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'accounting' || user.role === 'sales_manager') return true;
  if (user.id === repId) return true;
  const rep = db.prepare('SELECT supervisor_id FROM users WHERE id=?').get(repId);
  return rep && rep.supervisor_id === user.id;
}

function computeSingleInvoiceCommission(db, inv) {
  const repId = inv.user_id;
  const u = db.prepare(`SELECT id, role, commission_basis, commission_fixed, commission_cash, commission_cheque FROM users WHERE id=?`).get(repId);
  if (!u || !isRepRole(u.role)) return 0;
  const basis = u.commission_basis || 'invoice';
  if (basis === 'collection') return 0;
  if (u.commission_fixed > 0) return u.commission_fixed;
  let comm = 0;
  let rows = [];
  try { rows = JSON.parse(inv.rows || '[]'); } catch { rows = []; }
  for (const row of rows) {
    const { comm: c } = applyLineCommission(db, repId, inv, row, inv.cust_id, basis);
    comm += c;
  }
  if (!rows.length) {
    const lt = basis === 'profit' ? lineProfit(db, { product_id: null, qty: 1, price: inv.final || 0, disc: 0 }) : (inv.final || 0);
    const payType = inv.pay_type === 'cheque' ? 'cheque' : 'cash';
    comm = lt * ((payType === 'cheque' ? u.commission_cheque : u.commission_cash) || 0) / 100;
  }
  return Math.round(comm * 100) / 100;
}

function recordCommissionAccrual(db, inv, userId, createJournalEntry) {
  const amount = computeSingleInvoiceCommission(db, inv);
  if (amount <= 0) return null;
  const rep = db.prepare('SELECT name FROM users WHERE id=?').get(inv.user_id);
  const existing = db.prepare("SELECT id FROM rep_ledger WHERE rep_id=? AND ref_type='invoice' AND ref_id=? AND entry_type='commission_accrual'").get(inv.user_id, inv.id);
  if (existing) return amount;
  createJournalEntry(db, {
    date: inv.date || '', description: `تعهد انگیزه فروش — فاکتور ${inv.num} — ${rep?.name || ''}`,
    ref_type: 'commission_accrual', ref_id: inv.id, created_by: userId,
    lines: [
      { code: '6101', name: 'هزینه انگیزه فروش', debit: amount, credit: 0 },
      { code: '2107', name: 'بستانکاران انگیزه نمایندگان', debit: 0, credit: amount }
    ]
  });
  addRepLedger(db, {
    rep_id: inv.user_id, date: inv.date || '', entry_type: 'commission_accrual', ref_type: 'invoice', ref_id: inv.id,
    description: `تعهد انگیزه فاکتور ${inv.num}`, debit: 0, credit: amount, created_by: userId
  });
  notifyRep(db, inv.user_id, `🎯 انگیزه فاکتور ${inv.num} تأیید شد: ${amount.toLocaleString('fa-IR')} تومان`, userId, { sms: true });
  return amount;
}

function computeSettlementCommission(db, settlement, inv) {
  if (!inv || !inv.approved) return 0;
  const repId = inv.user_id;
  const u = db.prepare(`SELECT id, role, commission_basis, commission_fixed, commission_cash, commission_cheque FROM users WHERE id=?`).get(repId);
  if (!u || !isRepRole(u.role) || u.commission_basis !== 'collection') return 0;
  const amt = settlement.amount || 0;
  if (amt <= 0) return 0;
  const hasRules = db.prepare('SELECT 1 FROM rep_commission_rules WHERE rep_id=? AND active=1 LIMIT 1').get(repId);
  let comm = 0;
  if (u.commission_fixed > 0) {
    comm = u.commission_fixed * (amt / (inv.final || amt || 1));
  } else if (hasRules && inv.rows) {
    let invRows = [];
    try { invRows = JSON.parse(inv.rows || '[]'); } catch { invRows = []; }
    const invTotal = invRows.reduce((a, x) => a + lineTotal(x), 0) || 1;
    for (const row of invRows) {
      const { comm: c, lt } = applyLineCommission(db, repId, inv, row, inv.cust_id, 'collection');
      const share = amt * (lineTotal(row) / invTotal);
      comm += c * (share / (lt || 1));
    }
  } else {
    const payType = inv.pay_type === 'cheque' ? 'cheque' : 'cash';
    comm = amt * ((payType === 'cheque' ? u.commission_cheque : u.commission_cash) || 0) / 100;
  }
  return Math.round(comm * 100) / 100;
}

function recordSettlementCommissionAccrual(db, settlement, inv, userId, createJournalEntry) {
  const amount = computeSettlementCommission(db, settlement, inv);
  if (amount <= 0) return null;
  const repId = inv.user_id;
  const existing = db.prepare("SELECT id FROM rep_ledger WHERE rep_id=? AND ref_type='settlement' AND ref_id=? AND entry_type='commission_accrual'").get(repId, settlement.id);
  if (existing) return amount;
  const rep = db.prepare('SELECT name FROM users WHERE id=?').get(repId);
  createJournalEntry(db, {
    date: settlement.date || '', description: `تعهد انگیزه وصول — فاکتور ${inv.num} — ${rep?.name || ''}`,
    ref_type: 'commission_accrual', ref_id: settlement.id, created_by: userId,
    lines: [
      { code: '6101', name: 'هزینه انگیزه فروش', debit: amount, credit: 0 },
      { code: '2107', name: 'بستانکاران انگیزه نمایندگان', debit: 0, credit: amount }
    ]
  });
  addRepLedger(db, {
    rep_id: repId, date: settlement.date || '', entry_type: 'commission_accrual', ref_type: 'settlement', ref_id: settlement.id,
    description: `تعهد انگیزه وصول فاکتور ${inv.num}`, debit: 0, credit: amount, created_by: userId
  });
  notifyRep(db, repId, `💰 انگیزه وصول ${amount.toLocaleString('fa-IR')} تومان ثبت شد (فاکتور ${inv.num})`, userId, { sms: true });
  return amount;
}

function getRepProfitReport(db, repId, { from, to } = {}) {
  let sql = "SELECT id,num,date,rows,final,cust_id FROM invoices WHERE user_id=? AND type='final' AND approved=1";
  const p = [repId];
  if (from) { sql += ' AND date>=?'; p.push(from); }
  if (to) { sql += ' AND date<=?'; p.push(to); }
  const invs = db.prepare(sql).all(...p);
  const costMap = Object.fromEntries(db.prepare('SELECT id,cost FROM products').all().map(x => [x.id, x.cost || 0]));
  const custMap = Object.fromEntries(db.prepare('SELECT id,biz FROM customers').all().map(x => [x.id, x.biz]));
  let revenue = 0, cogs = 0;
  const rows = [];
  for (const inv of invs) {
    let parsed = [];
    try { parsed = JSON.parse(inv.rows || '[]'); } catch { parsed = []; }
    let invRev = 0, invCost = 0;
    for (const r of parsed) {
      const lt = lineTotal(r);
      invRev += lt;
      invCost += (r.qty || 0) * (costMap[r.product_id] || 0);
    }
    if (!parsed.length) { invRev = inv.final || 0; }
    revenue += invRev;
    cogs += invCost;
    rows.push({
      id: inv.id, num: inv.num, date: inv.date, cust_biz: custMap[inv.cust_id] || '-',
      revenue: invRev, cost: invCost, profit: invRev - invCost
    });
  }
  return { revenue, cogs, profit: revenue - cogs, rows };
}

function runRepDailyAlerts(db) {
  const reps = db.prepare(`SELECT id,name,monthly_target FROM users WHERE active=1 AND role IN ${REP_ROLES_SQL}`).all();
  const today = require('../jalali').todayJalali();
  let n = 0;
  for (const r of reps) {
    const aging = getRepAgingReceivables(db, r.id);
    if (aging.total > 100000) {
      const key = `rep_alert_receivable_${r.id}_${today.slice(0, 7)}`;
      const sent = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      if (!sent) {
        notifyRep(db, r.id, `⚠️ مطالبات مشتریان شما: ${Math.round(aging.total).toLocaleString('fa-IR')} تومان`, 1, { sms: true });
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, '1');
        n++;
      }
    }
    const comm = computeRepCommission(db, r.id, {});
    if (comm.targetPct >= 100 && comm.monthlyTarget > 0) {
      const key = `rep_alert_target_${r.id}_${today.slice(0, 7)}`;
      const sent = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      if (!sent) {
        notifyRep(db, r.id, `🎉 تبریک! هدف فروش ماه (${comm.targetPct}٪) محقق شد.`, 1, { sms: true });
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, '1');
        n++;
      }
    }
  }
  return n;
}

function assignCustomerByTerritory(db, customerId, city, province, createdBy) {
  const normalizedCity = (city || province || '').trim();
  if (!normalizedCity) return null;
  const territories = db.prepare('SELECT * FROM rep_territories WHERE active=1 AND rep_id IS NOT NULL').all();
  for (const t of territories) {
    const cities = (t.cities || '').split(/[,،]/).map(s => s.trim()).filter(Boolean);
    const matchName = t.name && (normalizedCity.includes(t.name) || t.name.includes(normalizedCity));
    const matchCity = cities.some(c => normalizedCity.includes(c) || c.includes(normalizedCity));
    if (!matchName && !matchCity) continue;
    const rep = db.prepare(`SELECT id FROM users WHERE id=? AND active=1 AND role IN ${REP_ROLES_SQL}`).get(t.rep_id);
    if (!rep) continue;
    const cust = db.prepare('SELECT user_id FROM customers WHERE id=?').get(customerId);
    if (cust && cust.user_id === t.rep_id) return t.rep_id;
    db.prepare('UPDATE customers SET user_id=?, assigned_to=?, rep_territory=? WHERE id=?').run(t.rep_id, t.rep_id, t.name, customerId);
    db.prepare(`INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by) VALUES (?,?,?,?,?,?)`)
      .run(customerId, cust?.user_id || null, t.rep_id, require('../jalali').todayJalali(), `انتساب خودکار منطقه ${t.name}`, createdBy || 1);
    notifyRep(db, t.rep_id, `📌 مشتری جدید به منطقه «${t.name}» اختصاص یافت.`, createdBy || 1);
    return t.rep_id;
  }
  return null;
}

function notifyRep(db, repId, body, fromId, opts = {}) {
  try {
    db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)').run(fromId || 1, repId, body);
  } catch { /* optional */ }
  if (!opts.sms) return;
  try {
    const flag = db.prepare("SELECT value FROM settings WHERE key='rep_sms_notify'").get();
    if (flag && flag.value === '0') return;
    const rep = db.prepare('SELECT phone FROM users WHERE id=?').get(repId);
    if (!rep?.phone) return;
    const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from')").all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!settings.sms_api_key) return;
    const { sendSMS } = require('../sms');
    sendSMS(settings, rep.phone, body).catch(() => {});
  } catch { /* optional */ }
}

module.exports = {
  EXPENSE_CATEGORIES, REP_ROLES_SQL, isRepRole, addRepLedger, computeRepCommission, buildRepLedgerView,
  buildRepStatement, settleAdvancesAgainstPayment, recordIncentivePaymentLedger, getRepRanking,
  getRepAgingReceivables, getTeamRollup, canAccessRep, notifyRep, getRepRates, getAdvanceBalance,
  computeRepPayable, computeSingleInvoiceCommission, recordCommissionAccrual, recordSettlementCommissionAccrual,
  assignCustomerByTerritory, getRepProfitReport, runRepDailyAlerts, lineProfit
};
