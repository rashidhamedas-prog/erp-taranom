'use strict';
/**
 * Heal: void sellable (FG) cutting packs that coexist with a posted production_receipt
 * for the same product — keeps finalize as the single FG owner (F06).
 *
 * Usage:
 *   node scripts/_heal-pack-double-fg-v399.js            # dry-run
 *   node scripts/_heal-pack-double-fg-v399.js --apply    # void packs
 *   node scripts/_heal-pack-double-fg-v399.js --apply 332
 */
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const cutting = require('../lib/production/cutting');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pidArg = args.find((a) => /^\d+$/.test(a));
const productId = pidArg ? Number(pidArg) : null;

const admin = db.prepare(`
  SELECT id FROM users WHERE role='admin' OR username='admin' ORDER BY id LIMIT 1
`).get() || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
if (!admin) throw new Error('no user for void');

const params = [];
let filter = '';
if (productId) {
  filter = 'AND p.product_id=?';
  params.push(productId);
}

const rows = db.prepare(`
  SELECT p.id, p.pack_no, p.product_id, p.qty, pr.code, pr.name, pr.stock AS stock_before
  FROM cutting_packs p
  JOIN products pr ON pr.id=p.product_id
  WHERE p.status='posted'
    ${filter}
    AND EXISTS (
      SELECT 1 FROM inventory_ledger il
      WHERE il.source_type='cutting_pack' AND il.source_id=p.id
        AND il.status='posted' AND il.event_type='production_receipt' AND il.qty_in>0
    )
    AND EXISTS (
      SELECT 1 FROM production_receipts r
      WHERE r.product_id=p.product_id AND r.status='posted'
    )
  ORDER BY p.product_id, p.id
`).all(...params);

const plan = rows.map((r) => ({
  pack_id: r.id,
  pack_no: r.pack_no,
  product_id: r.product_id,
  product: `${r.code || ''} ${r.name || ''}`.trim(),
  qty: r.qty,
  stock_before: r.stock_before,
}));

console.log(JSON.stringify({ apply, count: plan.length, plan }, null, 2));

if (!apply) {
  console.log('dry-run only — pass --apply to void these packs');
  process.exit(0);
}

const results = [];
for (const item of plan) {
  try {
    const before = db.prepare('SELECT stock FROM products WHERE id=?').get(item.product_id).stock;
    cutting.voidCuttingPack(db, item.pack_id, { id: admin.id }, {
      reason: 'heal v399: حذف ورود دوبل PACK فروش‌پذیر در کنار رسید تولید',
    });
    const after = db.prepare('SELECT stock FROM products WHERE id=?').get(item.product_id).stock;
    results.push({
      ok: true, pack_id: item.pack_id, pack_no: item.pack_no,
      product_id: item.product_id, stock_before: before, stock_after: after,
    });
  } catch (e) {
    results.push({
      ok: false, pack_id: item.pack_id, pack_no: item.pack_no,
      error: e.message, code: e.code,
    });
  }
}
console.log(JSON.stringify({ healed: results }, null, 2));
