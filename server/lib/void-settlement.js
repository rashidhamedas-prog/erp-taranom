/**
 * Reverse a single settlement inside an open db.transaction (R12/R13).
 * Used by DELETE /settlements/:id and cascade from invoice void.
 */
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { acct } = require('./coa-map');
const { createLedgerEntry, resolveCashAccount, audit } = require('../db');
const { reverseCommissionAccrual, notifyRep } = require('./rep-ledger');
const { todayJalali } = require('../jalali');

function recvAcct(db, custId) {
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

function reverseSettlementInTx(db, settlement, userId) {
  if (!settlement || settlement.status === 'reversed') return null;
  let cash = resolveCashAccount(db, settlement.pay_type, settlement.bank_id, settlement.cash_box_id);
  const overrideCode = String(settlement.account_code || '').trim();
  if (overrideCode) {
    const acctRow = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(overrideCode);
    if (acctRow) cash = { code: acctRow.code, name: acctRow.name };
  }
  createLedgerEntry(db, {
    customer_id: settlement.cust_id, date: todayJalali(), entry_type: 'reversal',
    ref_type: 'settlement', ref_id: settlement.id,
    description: `ابطال تسویه شماره ${settlement.id}`,
    debit: settlement.amount, credit: 0, user_id: userId,
  });
  const reversalId = postToLedger(db, {
    sourceType: 'settlement_reversal', sourceId: settlement.id, date: todayJalali(),
    description: `ابطال تسویه شماره ${settlement.id}`, createdBy: userId,
    lines: [
      (() => { const a = recvAcct(db, settlement.cust_id); return { code: a.code, name: a.name, debit: rialToLedger(settlement.amount), credit: 0 }; })(),
      { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(settlement.amount) },
    ],
  });
  // Mark original settlement JE(s) as reversed for document lists (both stay in TB → net zero)
  try {
    db.prepare(`
      UPDATE journal_entries SET status='reversed'
      WHERE ref_type='settlement' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted')<>'reversed'
        AND id<>?
    `).run(settlement.id, reversalId);
  } catch (_) {}
  reverseCommissionAccrual(db, 'settlement', settlement.id, userId, todayJalali());

  const sub = db.prepare("SELECT * FROM rep_payment_submissions WHERE settlement_id=? AND status='approved'").get(settlement.id);
  if (sub) {
    db.prepare("UPDATE rep_payment_submissions SET status='rejected', rejection_note=?, approved_by=?, approved_at=strftime('%s','now') WHERE id=?")
      .run('تأیید اشتباه بود — تسویه توسط حسابدار ابطال شد', userId, sub.id);
    notifyRep(db, sub.rep_id,
      `❌ پرداختی که قبلاً تأیید شده بود ابطال شد\nمبلغ: ${Number(sub.amount || 0).toLocaleString('fa-IR')} ریال\nوضعیت جدید: رد شده`,
      userId);
    audit(userId, 'reject', 'rep_payment', sub.id, `ابطال تأیید پرداخت میدانی (حذف تسویه #${settlement.id})`);
  }

  db.prepare("UPDATE settlements SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
    .run(reversalId, userId, settlement.id);
  return reversalId;
}

module.exports = { reverseSettlementInTx, recvAcct };
