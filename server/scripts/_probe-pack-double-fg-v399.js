'use strict';
/**
 * Read-only probe: products that have both a sellable cutting PACK (FG) and a
 * production_receipt finalize — the double-credit signature from the screenshot.
 * Usage: node scripts/_probe-pack-double-fg-v399.js [product_id|code]
 */
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const arg = process.argv[2] ? String(process.argv[2]).trim() : '';
let productFilter = '';
const params = [];
if (arg) {
  if (/^\d+$/.test(arg)) {
    productFilter = 'AND p.product_id=?';
    params.push(Number(arg));
  } else {
    productFilter = 'AND (pr.code=? OR pr.name LIKE ?)';
    params.push(arg, '%' + arg + '%');
  }
}

const rows = db.prepare(`
  SELECT
    p.id AS pack_id, p.pack_no, p.product_id, p.qty AS pack_qty,
    p.production_order_id AS pack_po,
    pr.name AS product_name, pr.code AS product_code, pr.stock AS header_stock,
    il.id AS ledger_id, il.qty_in, il.note AS pack_note, il.date AS pack_date,
    (SELECT COUNT(*) FROM production_receipts r
      WHERE r.product_id=p.product_id AND r.status='posted') AS receipt_count,
    (SELECT GROUP_CONCAT(o.order_no) FROM production_orders o
      WHERE o.product_id=p.product_id
        AND o.status IN ('completed','done','in_progress','released')) AS orders
  FROM cutting_packs p
  JOIN products pr ON pr.id=p.product_id
  JOIN inventory_ledger il
    ON il.source_type='cutting_pack' AND il.source_id=p.id
   AND il.status='posted' AND il.event_type='production_receipt' AND il.qty_in>0
  WHERE p.status='posted'
    ${productFilter}
  ORDER BY p.product_id, p.id
`).all(...params);

const suspects = rows.filter((r) => Number(r.receipt_count) > 0);
console.log(JSON.stringify({
  sellable_packs: rows.length,
  with_production_receipt: suspects.length,
  rows: suspects.slice(0, 40).map((r) => ({
    product_id: r.product_id,
    product: (r.product_code || '') + ' ' + (r.product_name || ''),
    header_stock: r.header_stock,
    pack_no: r.pack_no,
    pack_qty: r.pack_qty,
    pack_po: r.pack_po,
    pack_note: r.pack_note,
    ledger_id: r.ledger_id,
    receipt_count: r.receipt_count,
    orders: r.orders,
  })),
}, null, 2));
