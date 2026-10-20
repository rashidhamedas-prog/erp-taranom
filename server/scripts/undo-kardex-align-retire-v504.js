'use strict';
/**
 * Undo aggressive v504 retire: restore openings reversed with
 * note «ابطال هم‌ترازی نادرست کاردکس…» and resync warehouse_stock to ledger net.
 * Dry-run default. Apply: node server/scripts/undo-kardex-align-retire-v504.js --apply
 */
const { getDB, initDB } = require('../db');

const apply = process.argv.includes('--apply');
initDB();
const db = getDB();

const revs = db.prepare(`
  SELECT id, reversed_of, product_id, warehouse_id, note, tx_no
  FROM inventory_ledger
  WHERE event_type='reversal'
    AND replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%ابطال همترازی نادرست کاردکس%'
  ORDER BY id
`).all();

const out = { mode: apply ? 'apply' : 'dry-run', reversals: revs.length, restored: 0, synced_wh: 0, errors: [] };

const run = db.transaction(() => {
  for (const rev of revs) {
    if (!apply) continue;
    try {
      db.prepare('DELETE FROM inventory_ledger WHERE id=?').run(rev.id);
      if (rev.reversed_of) {
        db.prepare("UPDATE inventory_ledger SET status='posted' WHERE id=?").run(rev.reversed_of);
      }
      out.restored += 1;
      const net = Number(db.prepare(`
        SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
        WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
      `).get(rev.product_id, rev.warehouse_id)?.q) || 0;
      try {
        const ws = db.prepare(
          'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
        ).get(rev.product_id, rev.warehouse_id);
        if (ws) {
          db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
            .run(net, rev.product_id, rev.warehouse_id);
        } else {
          db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
            .run(rev.product_id, rev.warehouse_id, net);
        }
        const header = db.prepare(
          'SELECT COALESCE(SUM(qty),0) q FROM warehouse_stock WHERE product_id=?'
        ).get(rev.product_id);
        db.prepare('UPDATE products SET stock=? WHERE id=?')
          .run(Number(header?.q) || 0, rev.product_id);
        out.synced_wh += 1;
      } catch (e) {
        out.errors.push({ product_id: rev.product_id, warehouse_id: rev.warehouse_id, err: e.message });
      }
    } catch (e) {
      out.errors.push({ rev_id: rev.id, err: e.message });
    }
  }
});

if (apply) run();
out.sample = revs.slice(0, 15).map((r) => ({
  rev_id: r.id, original_id: r.reversed_of, product_id: r.product_id, warehouse_id: r.warehouse_id, tx_no: r.tx_no,
}));
console.log(JSON.stringify(out, null, 2));
if (!apply) console.log('\nRe-run with --apply to restore.');
