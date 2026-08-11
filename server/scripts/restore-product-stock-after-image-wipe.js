#!/usr/bin/env node
/**
 * Manual restore of product stock/pack/price wiped by image-only PUT.
 * Usage:
 *   DB_PATH=/path/to/crm.db node server/scripts/restore-product-stock-after-image-wipe.js
 *   DRY_RUN=1 ...  (report only)
 */
const path = require('path');
const Database = require('better-sqlite3');
const { restoreProductFieldsAfterImageWipe } = require('../lib/restore-product-fields');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
const backupsDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const dry = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

if (!require('fs').existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (dry) {
  const zeroStock = db.prepare(`
    SELECT COUNT(*) c FROM products p
    WHERE COALESCE(p.stock,0)=0
      AND EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND COALESCE(ws.qty,0)>0)
  `).get().c;
  const packOne = db.prepare(`SELECT COUNT(*) c FROM products WHERE COALESCE(pack_size,1)=1`).get().c;
  console.log(JSON.stringify({ dry_run: true, dbPath, zeroStockWithWhQty: zeroStock, packSizeOne: packOne }, null, 2));
  db.close();
  process.exit(0);
}

const summary = restoreProductFieldsAfterImageWipe(db, { backupsDir });
console.log(JSON.stringify({ ok: true, dbPath, ...summary }, null, 2));
db.close();
