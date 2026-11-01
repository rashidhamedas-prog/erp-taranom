/**
 * Reverse a single settlement inside an open db.transaction (R12/R13).
 * Used by DELETE /settlements/:id and cascade from invoice void.
 */
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { acct } = require('./coa-map');
const { resolveCashAccount, audit } = require('../db');
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

/**
 * R13: soft-void lifecycle JEs (واگذاری/وصول/برگشت) then mark leaf reversed.
 * Must run *before* settlement GL reverse so 1109 is restored from bank/1116 first.
 */
function reverseChequeRecordsForSettlement(db, settlementId, userId) {
  if (!settlementId) return { fixed: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM cheque_records
      WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
    `).all(settlementId);
  } catch (_) {
    return { fixed: 0 };
  }
  if (!rows.length) return { fixed: 0 };
  const { applyChequeLifecycleVoid } = require('./void-cheque');
  let fixed = 0;
  for (const row of rows) {
    applyChequeLifecycleVoid(db, row, { id: userId || 0 }, { skipSettlement: true });
    fixed += 1;
  }
  return { fixed };
}

function reverseChequeRecordsForInvoice(db, invoiceId, userId) {
  if (!invoiceId) return { fixed: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM cheque_records
      WHERE invoice_id=? AND COALESCE(record_status,'posted')<>'reversed'
    `).all(invoiceId);
  } catch (_) {
    return { fixed: 0 };
  }
  if (!rows.length) return { fixed: 0 };
  const { applyChequeLifecycleVoid } = require('./void-cheque');
  let fixed = 0;
  for (const row of rows) {
    applyChequeLifecycleVoid(db, row, { id: userId || 0 }, { skipSettlement: true });
    fixed += 1;
  }
  return { fixed };
}

function settlementHasLiveJe(db, settlementId) {
  try {
    return !!db.prepare(`
      SELECT 1 FROM journal_entries
      WHERE ref_type='settlement' AND ref_id=?
        AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
      LIMIT 1
    `).get(settlementId);
  } catch (_) {
    return false;
  }
}

function settlementAmountRial(settlement) {
  return Math.round(Number(settlement && (settlement.amount_rial != null ? settlement.amount_rial : settlement.amount)) || 0);
}

/** R13: clear customer_ledger for the settlement (v373: retire, no hollow reverse rows). */
function reverseSettlementBooks(db, settlement, userId, opts) {
  if (!settlement || !settlement.id || !settlement.cust_id) return 0;
  void userId; void opts;
  const { retireCustomerLedgerByRef } = require('./party-ledger-retire');
  return retireCustomerLedgerByRef(db, {
    refTypes: ['settlement'],
    refId: settlement.id,
    customerId: settlement.cust_id,
  });
}

/** Always mark business row reversed once books/GL work is attempted (R13). */
function markSettlementReversed(db, settlementId, userId, reversalJournalId) {
  if (!settlementId) return;
  const revJe = reversalJournalId != null && reversalJournalId !== '' ? reversalJournalId : null;
  db.prepare(`
    UPDATE settlements SET
      status='reversed',
      reversal_journal_id=COALESCE(?, reversal_journal_id),
      reversed_at=strftime('%s','now'),
      reversed_by=?
    WHERE id=? AND COALESCE(status,'posted')<>'reversed'
  `).run(revJe, userId, settlementId);
}

function reverseSettlementGlInTx(db, settlement, userId, opts) {
  const when = String((opts && opts.date) || todayJalali()).trim() || todayJalali();
  let cash = resolveCashAccount(db, settlement.pay_type, settlement.bank_id, settlement.cash_box_id);
  const overrideCode = String(settlement.account_code || '').trim();
  if (overrideCode) {
    const acctRow = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(overrideCode);
    if (acctRow) cash = { code: acctRow.code, name: acctRow.name };
  } else if (String(settlement.pay_type || '') === 'cheque') {
    // Received notes receivable — never fall back to default bank on reverse.
    try {
      const { settlementAssetAccount } = require('./invoice-payments');
      cash = settlementAssetAccount(db, { pay_type: 'cheque' });
    } catch (_) {
      try { cash = acct(db, 'coa_cheques_receivable'); } catch (__) { /* keep resolveCashAccount */ }
    }
  }
  const amt = settlementAmountRial(settlement);
  // v285+: soft-voids original settlement JE(s); null when already void / missing original.
  const reversalId = postToLedger(db, {
    sourceType: 'settlement_reversal', sourceId: settlement.id, date: when,
    description: `ابطال تسویه شماره ${settlement.id}`, createdBy: userId,
    lines: [
      (() => { const a = recvAcct(db, settlement.cust_id); return { code: a.code, name: a.name, debit: rialToLedger(amt), credit: 0 }; })(),
      { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amt) },
    ],
  });
  try {
    db.prepare(`
      UPDATE journal_entries SET status='reversed'
      WHERE ref_type='settlement' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted')<>'reversed'
        AND (? IS NULL OR id<>?)
    `).run(settlement.id, reversalId, reversalId);
  } catch (_) {}
  return reversalId;
}

function reverseSettlementInTx(db, settlement, userId, opts) {
  const options = opts || {};
  if (!settlement || settlement.status === 'reversed') return null;
  const when = String(options.date || todayJalali()).trim() || todayJalali();

  // POS shadow settlements post AR credit + JE on pos_receipt — never patch/reverse as cash settlement.
  try {
    const pos = require('./pos');
    const livePos = pos.findLivePosReceiptForSettlement(db, settlement);
    if (livePos) {
      pos.voidReceiptInTx(db, livePos.id, { id: userId }, {
        reason: options.reason || 'ابطال تسویه کارتخوان',
        allowAlreadyReversed: true,
        date: when,
      });
      if (!options.skipChequeRecords) reverseChequeRecordsForSettlement(db, settlement.id, userId);
      // voidReceiptInTx already marks settlement reversed; ensure flag if orphan link.
      markSettlementReversed(db, settlement.id, userId, null);
      try {
        const { softVoidArControlReclassForSettlement } = require('./customer-books');
        softVoidArControlReclassForSettlement(db, settlement.id, `ابطال تسویه کارتخوان #${settlement.id}`);
      } catch (e) {
        if (e && e.status) throw e;
        console.error('softVoidArControlReclassForSettlement(pos):', e && e.message);
      }
      return null;
    }
  } catch (e) {
    // Only a missing POS module may fall through; any DB/void error must abort (no half-voided card JE).
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;
  }

  // Lifecycle JEs first (clear/collection) so 1109 is restored before settlement GL.
  if (!options.skipChequeRecords) {
    reverseChequeRecordsForSettlement(db, settlement.id, userId);
  }

  reverseSettlementBooks(db, settlement, userId, { date: when });

  let reversalId = null;
  if (settlementHasLiveJe(db, settlement.id)) {
    // R13: JE reverse must not be swallowed — abort the surrounding transaction.
    reversalId = reverseSettlementGlInTx(db, settlement, userId, { date: when });
    try {
      reverseCommissionAccrual(db, 'settlement', settlement.id, userId, when);
    } catch (_) { /* must not block settlement.status=reversed */ }

    try {
      const sub = db.prepare("SELECT * FROM rep_payment_submissions WHERE settlement_id=? AND status='approved'").get(settlement.id);
      if (sub) {
        db.prepare("UPDATE rep_payment_submissions SET status='rejected', rejection_note=?, approved_by=?, approved_at=strftime('%s','now') WHERE id=?")
          .run('تأیید اشتباه بود — تسویه توسط حسابدار ابطال شد', userId, sub.id);
        notifyRep(db, sub.rep_id,
          `❌ پرداختی که قبلاً تأیید شده بود ابطال شد\nمبلغ: ${Number(sub.amount || 0).toLocaleString('fa-IR')} ریال\nوضعیت جدید: رد شده`,
          userId);
        audit(userId, 'reject', 'rep_payment', sub.id, `ابطال تأیید پرداخت میدانی (حذف تسویه #${settlement.id})`);
      }
    } catch (_) { /* optional */ }
  }

  // v390: soft-void companion ar_control_reclass (control→leaf) even if settlement JE
  // was already soft-voided — otherwise leaf keeps orphan credits and dashboard AR drifts.
  try {
    const { softVoidArControlReclassForSettlement } = require('./customer-books');
    softVoidArControlReclassForSettlement(
      db, settlement.id, `ابطال تسویه #${settlement.id}`
    );
  } catch (e) {
    console.error('softVoidArControlReclassForSettlement:', e && e.message);
    throw e;
  }

  markSettlementReversed(db, settlement.id, userId, reversalId);
  return reversalId;
}

module.exports = {
  reverseSettlementInTx,
  reverseSettlementBooks,
  settlementAmountRial,
  recvAcct,
  reverseChequeRecordsForInvoice,
  reverseChequeRecordsForSettlement,
};
