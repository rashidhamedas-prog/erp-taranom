/**
 * Heal invoices corrupted by convert without vat_exempt/discAmt (pre-v539):
 * vat_exempt=1 but VAT was applied on convert → final ≈ (subtotal−disc)×1.1
 *
 * Rewrites sale JE + customer ledger AR; does not touch stock or re-post receipts.
 * Dry-run: node server/scripts/heal-convert-vat-exempt-v539.js
 * Apply:   node server/scripts/heal-convert-vat-exempt-v539.js --apply
 */
'use strict';

const path = require('path');
const APPLY = process.argv.includes('--apply');

if (!process.env.DB_PATH) {
  // Prefer production crm.db next to server/; never invent an empty data/erp.db.
  const fs = require('fs');
  const cands = [
    path.join(__dirname, '..', 'crm.db'),
    path.join(__dirname, '..', 'data', 'erp.db'),
  ];
  for (const cand of cands) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).size > 10_000) {
        process.env.DB_PATH = cand;
        break;
      }
    } catch (_) { /* next */ }
  }
}
console.log('heal DB_PATH=', process.env.DB_PATH || '(db.js default)');

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { calcDocTotals } = require('../lib/vat');
const { applyFreightToDocTotals, invoiceTypeLabel } = require('../lib/sales-document');
const { salesJournalLines, updateInvoiceCustomerLedger } = require('../lib/customer-books');
const { rewriteJournalEntry } = require('../lib/ledger');
const { recomputeInvoiceSettledBalances } = require('../lib/invoice-payments');

const rows = db.prepare(`
  SELECT * FROM invoices
  WHERE COALESCE(converted,0)=1
    AND COALESCE(deleted_at,0)=0
    AND COALESCE(status,'active')<>'reversed'
    AND (
      /* classic: exempt flag kept but VAT applied on convert */
      (COALESCE(vat_exempt,0)=1 AND (COALESCE(vat_amount,0)>0 OR COALESCE(vat_amount_rial,0)>0))
      /* or final ≈ (subtotal−disc)×1.1 while disc_amt suggests exempt face */
      OR (
        ABS(COALESCE(final_rial, final)
          - ROUND((COALESCE(subtotal,0) - COALESCE(disc_amt,0)) * 1.1)) < 50
        AND COALESCE(vat_amount,0) > 0
      )
    )
`).all();

console.log(`candidates: ${rows.length} (apply=${APPLY})`);

let fixed = 0;
let skipped = 0;
const runOne = (inv) => {
  let lineRows = [];
  try { lineRows = JSON.parse(inv.rows || '[]'); } catch (_) { lineRows = []; }
  const built = { rows: lineRows, subtotal: inv.subtotal };
  const discAmt = (inv.disc_amt != null && inv.disc_amt !== '')
    ? Math.max(0, Math.round(Number(inv.disc_amt) || 0))
    : null;
  const totals = calcDocTotals(db, built, inv.disc || 0, {
    vatExempt: true,
    ...(discAmt != null ? { discAmt } : {}),
  });
  const freightAdj = applyFreightToDocTotals(totals, inv.freight_amount, inv.freight_type);
  totals.final = freightAdj.final;
  totals.netBeforeVat = freightAdj.netBeforeVat;
  const oldFinal = Math.round(Number(inv.final_rial != null ? inv.final_rial : inv.final) || 0);
  const newFinal = Math.round(totals.final);
  if (oldFinal === newFinal && !(Number(inv.vat_amount) > 0 || Number(inv.vat_amount_rial) > 0)) {
    skipped += 1;
    return { skipped: true };
  }
  console.log(`  ${inv.num || inv.id}: final ${oldFinal} → ${newFinal} (vat→0)`);
  if (!APPLY) return { dry: true, oldFinal, newFinal };

  db.prepare(`
    UPDATE invoices SET final=?, final_rial=?, vat_amount=0, vat_amount_rial=0, vat_rate=0, disc_amt=?
    WHERE id=?
  `).run(newFinal, newFinal, totals.discAmt, inv.id);

  const jeId = rewriteJournalEntry(db, {
    sourceType: 'invoice',
    sourceId: inv.id,
    date: inv.date || '',
    description: `${invoiceTypeLabel(inv.type)} ${inv.num} (ترمیم VAT تبدیل v539)`,
    createdBy: inv.user_id || null,
    costCenterId: inv.cost_center_id || null,
    warehouseId: inv.warehouse_id || null,
    lines: salesJournalLines(db, inv.cust_id, {
      subtotal: totals.subtotal, discAmt: totals.discAmt, final: newFinal,
      vatAmount: 0, netBeforeVat: totals.netBeforeVat,
    }, false, {
      payType: 'credit', // AR-only; receipts already posted separately
      rows: lineRows,
      freightRial: Math.round(inv.freight_amount || 0),
      freightType: inv.freight_type,
    }),
  });
  if (!jeId) {
    const err = new Error(`sale JE missing for invoice ${inv.id}`);
    err.code = 'E_HEAL_NO_JE';
    throw err;
  }

  updateInvoiceCustomerLedger(db, {
    customerId: inv.cust_id,
    date: inv.date || '',
    invId: inv.id,
    num: inv.num,
    invType: inv.type,
    final: newFinal,
    userId: inv.user_id,
    payType: 'credit',
    skipImmediatePayment: true,
  });
  recomputeInvoiceSettledBalances(db, inv.id);
  fixed += 1;
  return { fixed: true, oldFinal, newFinal, jeId };
};

try {
  if (APPLY) {
    db.transaction(() => {
      for (const inv of rows) runOne(inv);
    })();
  } else {
    for (const inv of rows) runOne(inv);
  }
  console.log(`done: fixed=${fixed} skipped=${skipped} dry=${!APPLY}`);
  if (!APPLY && rows.length) console.log('Re-run with --apply to write.');
  process.exit(0);
} catch (e) {
  console.error('heal failed:', e && (e.stack || e.message));
  process.exit(1);
}
