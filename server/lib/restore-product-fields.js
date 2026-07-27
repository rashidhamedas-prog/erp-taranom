/**
 * Restore product fields wiped by the image-only PUT bug:
 *   PUT /products/:id with FormData containing only images left stock/price/code/note
 *   as undefined → parseQty(undefined)=0 / parseFloat||0 / code||'' .
 * warehouse_stock rows were typically NOT overwritten (INSERT OR IGNORE), so stock
 * can be rebuilt from SUM(warehouse_stock.qty). pack_size/price/code/note prefer
 * the newest readable SQLite backup under server/backups when available.
 */
const fs = require('fs');
const path = require('path');
const { parseQty } = require('./round3');

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function listCandidateBackupDbs(backupsDir) {
  const out = [];
  if (!backupsDir || !fs.existsSync(backupsDir)) return out;
  const entries = fs.readdirSync(backupsDir);
  for (const name of entries) {
    const fp = path.join(backupsDir, name);
    let st;
    try { st = fs.statSync(fp); } catch (_) { continue; }
    if (!st.isFile()) continue;
    // Plain sqlite copies (pre-mahak / manual) — skip encrypted/archives
    if (/\.db$/i.test(name) && !/\.enc$/i.test(name)) {
      out.push({ path: fp, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function openReadonlySqlite(filePath) {
  try {
    const Database = require('better-sqlite3');
    return new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (_) {
    return null;
  }
}

function restoreStockFromWarehouse(db) {
  if (!tableExists(db, 'products') || !tableExists(db, 'warehouse_stock')) {
    return { stockRestored: 0 };
  }
  const rows = db.prepare(`
    SELECT p.id AS id,
           COALESCE(p.stock, 0) AS stock,
           COALESCE((SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.product_id=p.id), 0) AS wh_qty
    FROM products p
  `).all();
  const upd = db.prepare('UPDATE products SET stock=? WHERE id=?');
  let stockRestored = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const stock = parseQty(r.stock);
      const wh = parseQty(r.wh_qty);
      // Only fill when header was wiped/zeroed but warehouse still holds qty
      if (stock === 0 && wh > 0) {
        upd.run(wh, r.id);
        stockRestored++;
      }
    }
  });
  tx();
  return { stockRestored };
}

function restoreMetaFromBackup(db, backupsDir) {
  const summary = { backupUsed: null, packRestored: 0, priceRestored: 0, codeRestored: 0, noteRestored: 0 };
  const candidates = listCandidateBackupDbs(backupsDir);
  for (const c of candidates) {
    const bdb = openReadonlySqlite(c.path);
    if (!bdb) continue;
    let bakProducts;
    try {
      if (!tableExists(bdb, 'products')) { bdb.close(); continue; }
      bakProducts = bdb.prepare('SELECT id, stock, pack_size, price, code, note FROM products').all();
    } catch (_) {
      try { bdb.close(); } catch (__) {}
      continue;
    }
    const byId = new Map(bakProducts.map(r => [r.id, r]));
    const cur = db.prepare('SELECT id, stock, pack_size, price, code, note FROM products').all();
    const updPack = db.prepare('UPDATE products SET pack_size=? WHERE id=?');
    const updPrice = db.prepare('UPDATE products SET price=? WHERE id=?');
    const updCode = db.prepare('UPDATE products SET code=? WHERE id=?');
    const updNote = db.prepare('UPDATE products SET note=? WHERE id=?');
    const updStock = db.prepare('UPDATE products SET stock=? WHERE id=?');

    const tx = db.transaction(() => {
      for (const row of cur) {
        const b = byId.get(row.id);
        if (!b) continue;
        const curPack = Math.max(1, parseInt(row.pack_size, 10) || 1);
        const bakPack = Math.max(1, parseInt(b.pack_size, 10) || 1);
        // pack wiped to default 1 while backup had a real pack size
        if (curPack === 1 && bakPack > 1) {
          updPack.run(bakPack, row.id);
          summary.packRestored++;
        }
        const curPrice = Number(row.price) || 0;
        const bakPrice = Number(b.price) || 0;
        if (curPrice === 0 && bakPrice > 0) {
          updPrice.run(bakPrice, row.id);
          summary.priceRestored++;
        }
        const curCode = (row.code || '').trim();
        const bakCode = (b.code || '').trim();
        if (!curCode && bakCode) {
          updCode.run(bakCode, row.id);
          summary.codeRestored++;
        }
        const curNote = (row.note || '').trim();
        const bakNote = (b.note || '').trim();
        if (!curNote && bakNote) {
          updNote.run(bakNote, row.id);
          summary.noteRestored++;
        }
        // Fallback stock from backup when warehouse also empty
        const curStock = parseQty(row.stock);
        const bakStock = parseQty(b.stock);
        if (curStock === 0 && bakStock > 0) {
          const wh = tableExists(db, 'warehouse_stock')
            ? parseQty(db.prepare('SELECT COALESCE(SUM(qty),0) q FROM warehouse_stock WHERE product_id=?').get(row.id).q)
            : 0;
          if (wh === 0) {
            updStock.run(bakStock, row.id);
            // seed home warehouse if product has warehouse_id
            try {
              const p = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(row.id);
              if (p && p.warehouse_id) {
                db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
                  .run(row.id, p.warehouse_id, bakStock);
                // if row already exists with 0, fix it
                db.prepare(`UPDATE warehouse_stock SET qty=?
                  WHERE product_id=? AND warehouse_id=? AND COALESCE(qty,0)=0`).run(bakStock, row.id, p.warehouse_id);
              }
            } catch (_) {}
            summary.stockRestored = (summary.stockRestored || 0) + 1;
          }
        }
      }
    });
    tx();
    try { bdb.close(); } catch (_) {}
    summary.backupUsed = path.basename(c.path);
    break; // newest usable backup only
  }
  return summary;
}

function restoreProductFieldsAfterImageWipe(db, opts = {}) {
  const backupsDir = opts.backupsDir || path.join(__dirname, '..', 'backups');
  const fromWh = restoreStockFromWarehouse(db);
  const fromBak = restoreMetaFromBackup(db, backupsDir);
  return {
    stockFromWarehouse: fromWh.stockRestored,
    stockFromBackup: fromBak.stockRestored || 0,
    packRestored: fromBak.packRestored,
    priceRestored: fromBak.priceRestored,
    codeRestored: fromBak.codeRestored,
    noteRestored: fromBak.noteRestored,
    backupUsed: fromBak.backupUsed,
  };
}

module.exports = {
  restoreProductFieldsAfterImageWipe,
  restoreStockFromWarehouse,
  restoreMetaFromBackup,
};
