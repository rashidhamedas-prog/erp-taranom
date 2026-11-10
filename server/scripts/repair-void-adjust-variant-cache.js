#!/usr/bin/env node
'use strict';
/**
 * Dry-run (default) / surgical repair of stale variant cache cells left after a void
 * while the product still has unattributed live qty (preserveZeros guard).
 *
 * Rule (same as rebuildStockCache exception):
 *   attributed ledger = 0
 *   AND cache qty ≠ 0
 *   AND ≥1 inventory_movements.doc_type ends with `_void`
 *   AND Σ qty_delta for that key == attributed ledger
 * → write ledger figure (usually 0).
 *
 * Never forceVariantLedger. Never touch JE / ledger / products.stock / warehouse_stock.
 * Excludes product id 342 and code 7217.
 *
 * Usage:
 *   node server/scripts/repair-void-adjust-variant-cache.js            # dry-run
 *   node server/scripts/repair-void-adjust-variant-cache.js --apply     # writes (requires GO from Hamed)
 *
 * Cursor must NOT run --apply. Production apply only after: GO repair-void-adjust-variant
 */
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const EXCLUDE_IDS = new Set([342]);
const EXCLUDE_CODES = new Set(['7217']);

function main() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crm.db');
  if (!fs.existsSync(dbPath) && !process.env.DB_PATH) {
    console.error('DB not found:', dbPath);
    process.exit(1);
  }
  process.env.SYNC_ROLE = process.env.SYNC_ROLE || 'central';
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const SC = require('../lib/inventory/stock-cache');

  const products = db.prepare(`
    SELECT DISTINCT p.id, p.code, p.name
    FROM products p
    JOIN product_variants v ON v.product_id=p.id AND COALESCE(v.is_default,0)=0 AND COALESCE(v.active,0)=1
    ORDER BY p.id
  `).all().filter((p) => !EXCLUDE_IDS.has(Number(p.id)) && !EXCLUDE_CODES.has(String(p.code || '')));

  const leftovers = [];
  for (const p of products) {
    const d = SC.deriveProductStock(db, p.id);
    if (!SC.hasUnattributedQty(d)) continue;
    const variants = db.prepare('SELECT id, stock FROM product_variants WHERE product_id=?').all(p.id);
    if (variants.length <= 1) continue;
    const hints = SC.loadVariantMovementHints(db, variants.map((v) => Number(v.id)));

    for (const v of variants) {
      const vid = Number(v.id);
      const fromLedger = d.variants.get(vid) || 0;
      const cur = Number(v.stock) || 0;
      const hint = hints.byVariant.get(vid) || null;
      const want = SC.variantWant(fromLedger, cur, true, hint);
      if (Math.abs(fromLedger) < 1e-9 && Math.abs(cur) > 1e-9 && Math.abs(want - fromLedger) < 1e-9) {
        leftovers.push({
          scope: 'product_variants',
          product_id: p.id,
          product_code: p.code,
          warehouse_id: null,
          variant_id: vid,
          cache_qty: cur,
          ledger_qty: fromLedger,
          delta: want - cur,
          mov_net: hint ? hint.net : null,
          has_void: !!(hint && hint.hasVoid),
        });
      }
    }

    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='variant_warehouse_stock'").get()) {
      continue;
    }
    const ids = variants.map((v) => Number(v.id));
    if (!ids.length) continue;
    const cells = db.prepare(
      `SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock WHERE variant_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    for (const r of cells) {
      const k = `${Number(r.variant_id)}:${Number(r.warehouse_id)}`;
      const fromLedger = d.variantWarehouses.get(k) || 0;
      const curQ = Number(r.qty) || 0;
      const hint = hints.byVW.get(k) || null;
      const want = SC.variantWant(fromLedger, curQ, true, hint);
      if (Math.abs(fromLedger) < 1e-9 && Math.abs(curQ) > 1e-9 && Math.abs(want - fromLedger) < 1e-9) {
        const movIds = db.prepare(`
          SELECT id, doc_type, qty_delta FROM inventory_movements
          WHERE variant_id=? AND warehouse_id=? ORDER BY id
        `).all(r.variant_id, r.warehouse_id);
        leftovers.push({
          scope: 'variant_warehouse_stock',
          product_id: p.id,
          product_code: p.code,
          warehouse_id: Number(r.warehouse_id),
          variant_id: Number(r.variant_id),
          cache_qty: curQ,
          ledger_qty: fromLedger,
          delta: want - curQ,
          mov_net: hint ? hint.net : null,
          has_void: !!(hint && hint.hasVoid),
          movement_ids: movIds.map((m) => m.id),
          movement_docs: movIds.map((m) => m.doc_type),
        });
      }
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    db: dbPath,
    leftover_count: leftovers.length,
    leftovers,
  }, null, 2));

  if (!APPLY) {
    console.log('\nDry-run only — no writes. Re-run with --apply after GO repair-void-adjust-variant.');
    process.exit(0);
  }

  const touched = new Set();
  const run = db.transaction(() => {
    for (const row of leftovers) {
      if (row.scope === 'product_variants') {
        db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(row.ledger_qty, row.variant_id);
      } else if (row.scope === 'variant_warehouse_stock') {
        db.prepare('UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?')
          .run(row.ledger_qty, row.variant_id, row.warehouse_id);
      }
      touched.add(row.product_id);
    }
  });
  run();

  for (const pid of touched) {
    // Re-apply the new rebuild rule (not forceVariantLedger) so preserved cells without void stay.
    SC.rebuildStockCache(db, pid);
    try {
      require('../lib/website-stock-sync').notifyStockChanged(db, pid);
    } catch (e) {
      console.warn('notifyStockChanged skipped:', e && e.message);
    }
  }
  console.log(`\nApplied ${leftovers.length} cell(s) across ${touched.size} product(s).`);
  process.exit(0);
}

main();
