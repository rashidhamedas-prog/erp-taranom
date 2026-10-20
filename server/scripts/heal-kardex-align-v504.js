'use strict';
/**
 * One-shot: reverse spurious «هم‌ترازی کاردکس» openings and sync warehouse_stock.
 * Dry-run default. Apply: node server/scripts/heal-kardex-align-v504.js --apply
 */
const { getDB, initDB } = require('../db');
const { retireSpuriousKardexAlign } = require('../lib/opening-post');

const apply = process.argv.includes('--apply');
initDB();
const db = getDB();
const r = retireSpuriousKardexAlign(db, { apply });
console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  candidates: r.candidates,
  reversed: r.reversed,
  synced_wh: r.synced_wh,
  sample: (r.items || []).slice(0, 20).map((x) => ({
    ledger_id: x.ledger_id,
    tx_no: x.tx_no,
    product_id: x.product_id,
    product_name: x.product_name,
    warehouse_id: x.warehouse_id,
    qty: x.qty,
    applied: !!x.applied,
    ledger_net_after: x.ledger_net_after,
  })),
}, null, 2));
if (!apply) {
  console.log('\nRe-run with --apply to reverse + sync warehouse_stock.');
}
