#!/usr/bin/env node
/** One-shot: recompute balance_due for invoices with linked active sales returns. */
'use strict';
const { getDB } = require('../db');
const { recomputeInvoiceSettledBalances } = require('../lib/invoice-payments');

const db = getDB();
const ids = db.prepare(`
  SELECT DISTINCT invoice_id AS id FROM sales_returns
  WHERE invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
`).all();
let n = 0;
for (const r of ids) {
  if (recomputeInvoiceSettledBalances(db, r.id)) n++;
}
console.log('BACKFILL_RECOMPUTE', n, 'of', ids.length);
