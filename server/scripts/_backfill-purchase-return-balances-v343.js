#!/usr/bin/env node
/** One-shot: recompute balance_due for purchase invoices with linked active purchase returns or payments. */
'use strict';
const { getDB } = require('../db');
const { recomputePurchaseInvoiceSettledBalances } = require('../lib/purchase-payments');

const db = getDB();
const ids = db.prepare(`
  SELECT DISTINCT id FROM (
    SELECT purchase_invoice_id AS id FROM purchase_returns
    WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
    UNION
    SELECT purchase_invoice_id FROM supplier_payments
    WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
    UNION
    SELECT purchase_invoice_id FROM expense_payments
    WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
  ) WHERE id IS NOT NULL
`).all();
let n = 0;
for (const r of ids) {
  if (recomputePurchaseInvoiceSettledBalances(db, r.id)) n++;
}
console.log('BACKFILL_PURCHASE_RECOMPUTE', n, 'of', ids.length);
