/**
 * T-0042: face healed to 197M but POS receipt stayed ~59.2M.
 * Re-post invoice-time کارتخوان for full final (user: full POS at convert time).
 * Run: node server/scripts/heal-t0042-full-pos-v539.js [--apply]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const APPLY = process.argv.includes('--apply');

if (!process.env.DB_PATH) {
  const cand = path.join(__dirname, '..', 'crm.db');
  if (fs.existsSync(cand) && fs.statSync(cand).size > 10_000) process.env.DB_PATH = cand;
}
console.log('DB_PATH=', process.env.DB_PATH || '(default)');

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { rewriteInvoiceTimeSettlements } = require('../lib/amend-invoice');
const { persistInvoicePayPlan, recomputeInvoiceSettledBalances } = require('../lib/invoice-payments');

const inv = db.prepare("SELECT * FROM invoices WHERE num='T-0042'").get();
if (!inv) {
  console.log('T-0042 not found');
  process.exit(1);
}
const finalAmt = Math.round(Number(inv.final_rial != null ? inv.final_rial : inv.final) || 0);
const paid = Math.round(Number(inv.pay_amount_rial) || 0);
console.log({
  id: inv.id, final: finalAmt, pay_amount_rial: paid,
  settled_amount: inv.settled_amount, balance_due: inv.balance_due,
});

if (paid === finalAmt && Number(inv.balance_due) === 0) {
  console.log('already fully settled');
  process.exit(0);
}

let termId = inv.pos_terminal_id;
try {
  const splits = JSON.parse(inv.pay_splits_json || '[]');
  if (!termId && splits[0]) termId = splits[0].terminal_id || splits[0].pos_terminal_id;
} catch (_) {}
if (!termId) {
  try {
    termId = db.prepare(
      "SELECT terminal_id FROM pos_receipts WHERE invoice_id=? ORDER BY id DESC LIMIT 1"
    ).get(inv.id)?.terminal_id;
  } catch (_) {}
}
if (!termId) {
  termId = db.prepare('SELECT id FROM pos_terminals ORDER BY id LIMIT 1').get()?.id;
}
if (!termId) {
  console.error('no POS terminal');
  process.exit(1);
}

const payPlan = {
  splits: [{ pay_type: 'pos_card', amount: finalAmt, terminal_id: Number(termId) }],
  skipInvoiceCash: true,
};
console.log('plan', payPlan, 'apply=', APPLY);
if (!APPLY) {
  console.log('Re-run with --apply to write.');
  process.exit(0);
}

db.transaction(() => {
  rewriteInvoiceTimeSettlements(db, {
    row: inv,
    payPlan,
    custId: inv.cust_id,
    date: inv.date || '',
    userId: inv.user_id,
    num: inv.num,
    body: { pay_type: 'pos_card', pos_terminal_id: termId, pay_amount: finalAmt },
  });
  persistInvoicePayPlan(db, inv.id, payPlan, {
    pay_type: 'pos_card',
    pos_terminal_id: termId,
    pay_amount: finalAmt,
  });
  db.prepare('UPDATE invoices SET pay_type=? WHERE id=?').run('pos_card', inv.id);
  recomputeInvoiceSettledBalances(db, inv.id);
})();

const after = db.prepare(
  'SELECT final,final_rial,pay_amount_rial,settled_amount,balance_due,pay_splits_json FROM invoices WHERE id=?'
).get(inv.id);
console.log('after', {
  final: after.final,
  pay_amount_rial: after.pay_amount_rial,
  settled_amount: after.settled_amount,
  balance_due: after.balance_due,
  splits: after.pay_splits_json,
});
process.exit(Number(after.balance_due) === 0 && Number(after.pay_amount_rial) === finalAmt ? 0 : 1);
