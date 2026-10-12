'use strict';
/**
 * One-shot: firm invoices that posted cash/bank inside the sale JE (legacy path)
 * get a matching settlements row for outstanding/print — without a second JE
 * (amounts already live on the invoice voucher).
 */
const { moneyRial } = require('./cash-on-document');
const { firmSaleTypeSql } = require('./sales-document');

const FLAG = 'invoice_settlement_unify_v1';
const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;

function invoiceHasLiveSettlement(db, invId) {
  const s = db.prepare(
    "SELECT 1 FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed' LIMIT 1"
  ).get(invId);
  if (s) return true;
  try {
    const p = db.prepare(
      "SELECT 1 FROM pos_receipts WHERE invoice_id=? AND COALESCE(status,'posted') NOT IN ('reversed','void') LIMIT 1"
    ).get(invId);
    if (p) return true;
  } catch (_) { /* no pos table */ }
  return false;
}

function cashPairAmountOnInvoiceJe(db, invId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN COALESCE(jl.debit_rial,0)>0 THEN jl.debit_rial
           WHEN COALESCE(jl.debit,0)>0 THEN ROUND(jl.debit)
           ELSE 0 END
    ),0) AS amt
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.ref_type='invoice' AND je.ref_id=?
      AND ${JE_ALIVE}
      AND (
        jl.description LIKE '%دریافت هنگام فاکتور%'
        OR jl.description LIKE '%تسویه هنگام فاکتور%'
      )
      AND COALESCE(jl.debit_rial, jl.debit, 0) > 0
  `).get(invId);
  return moneyRial(row && row.amt);
}

function repairMissingInvoiceSettlements(db, opts = {}) {
  const force = !!(opts && opts.force);
  if (!force) {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
    if (done && done.value === '1') return { skipped: true, created: 0 };
  }

  const invs = db.prepare(`
    SELECT id, user_id, cust_id, num, date, pay_type, bank_id, cash_box_id,
           final, final_rial, pay_amount_rial, cheque_info, cheque_due_date
    FROM invoices
    WHERE ${firmSaleTypeSql()}
      AND COALESCE(status,'posted') NOT IN ('reversed','void','cancelled')
      AND COALESCE(pay_type,'credit') IN ('cash','bank','bank_transfer','cheque','pos_card','mixed')
  `).all();

  let created = 0;
  const { applyInvoicePaySplits } = require('./invoice-payments');

  const run = db.transaction(() => {
    for (const inv of invs) {
      if (invoiceHasLiveSettlement(db, inv.id)) {
        refreshSettledAmounts(db, inv.id);
        continue;
      }
      const finalAmt = moneyRial(inv.final_rial != null ? inv.final_rial : inv.final);
      // Only invent a books-only settlement when cash already sits on the sale JE.
      // Fallback to full final without a cash pair created ghost credits (مد روز / 76.8M).
      const paid = cashPairAmountOnInvoiceJe(db, inv.id);
      if (paid <= 0) continue;

      const pt = inv.pay_type === 'bank' ? 'bank_transfer' : inv.pay_type;
      if (pt === 'mixed' || pt === 'pos_card') {
        // cannot safely invent destination; skip
        continue;
      }
      if (pt === 'cash' && !inv.cash_box_id) continue;
      if ((pt === 'bank_transfer' || pt === 'bank') && !inv.bank_id) continue;

      const split = {
        pay_type: pt === 'bank' ? 'bank_transfer' : pt,
        amount: Math.min(paid, finalAmt),
        bank_id: inv.bank_id || null,
        cash_box_id: inv.cash_box_id || null,
        cheque_info: inv.cheque_info || '',
        cheque_due: inv.cheque_due_date || '',
        note: `بک‌فیل دریافت هنگام فاکتور ${inv.num} (مبلغ در سند فاکتور — بدون سند مجدد)`,
      };
      try {
        applyInvoicePaySplits(db, {
          invoiceId: inv.id,
          custId: inv.cust_id,
          date: inv.date,
          splits: [split],
          userId: inv.user_id || 1,
          num: inv.num,
          chequeHeader: { cheque_info: inv.cheque_info, cheque_due_date: inv.cheque_due_date },
          skipJournal: true,
        });
        created += 1;
      } catch (e) {
        console.warn(`repair-invoice-settlements #${inv.id}:`, e.message);
      }
      refreshSettledAmounts(db, inv.id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?, '1')").run(FLAG);
  });
  run();
  return { skipped: false, created, scanned: invs.length };
}

function refreshSettledAmounts(db, invId) {
  try {
    const paidRow = db.prepare(`
      SELECT COALESCE((
        SELECT SUM(amount) FROM settlements
        WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
      ),0) + COALESCE((
        SELECT SUM(amount_rial) FROM pos_receipts
        WHERE invoice_id=? AND COALESCE(status,'posted') NOT IN ('reversed','void')
      ),0) AS paid
    `).get(invId, invId);
    const inv = db.prepare('SELECT final, final_rial FROM invoices WHERE id=?').get(invId);
    const finalAmt = moneyRial(inv && (inv.final_rial != null ? inv.final_rial : inv.final));
    const paid = moneyRial(paidRow && paidRow.paid);
    db.prepare('UPDATE invoices SET settled_amount=?, balance_due=? WHERE id=?')
      .run(paid, Math.max(0, finalAmt - paid), invId);
  } catch (_) { /* optional columns / pos */ }
}

module.exports = { repairMissingInvoiceSettlements, FLAG, refreshSettledAmounts };
