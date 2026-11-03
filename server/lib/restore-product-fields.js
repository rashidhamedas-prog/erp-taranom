/**
 * Restore product fields wiped by the image-only PUT bug:
 *   PUT /products/:id with FormData containing only images left stock/price/code/note
 *   as undefined → parseQty(undefined)=0 / parseFloat||0 / code||'' .
 * warehouse_stock rows were typically NOT overwritten (INSERT OR IGNORE), so stock
 * can be rebuilt from SUM(warehouse_stock.qty). pack_size/price/code/note prefer
 * the newest readable SQLite backup under server/backups when available
 * (plain .db, or crm.db inside latest non-encrypted .tar.gz / .zip).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
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
  for (const name of fs.readdirSync(backupsDir)) {
    const fp = path.join(backupsDir, name);
    let st;
    try { st = fs.statSync(fp); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (/\.db$/i.test(name) && !/\.enc$/i.test(name)) {
      out.push({ path: fp, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Newest non-encrypted archive that may contain crm.db */
function listCandidateArchives(backupsDir) {
  const out = [];
  if (!backupsDir || !fs.existsSync(backupsDir)) return out;
  for (const name of fs.readdirSync(backupsDir)) {
    if (/\.enc$/i.test(name)) continue;
    if (!/^crm-backup-.*\.(tar\.gz|zip)$/i.test(name) && !/^crm-latest\.(tar\.gz|zip)$/i.test(name)) continue;
    const fp = path.join(backupsDir, name);
    try {
      const st = fs.statSync(fp);
      if (st.isFile()) out.push({ path: fp, mtime: st.mtimeMs, kind: name.endsWith('.zip') ? 'zip' : 'tar' });
    } catch (_) {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function extractDbFromArchive(archivePath, kind) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taranom-bak-'));
  try {
    if (kind === 'zip') {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(archivePath);
      const entry = zip.getEntries().find(e => /(^|\/)crm\.db$/i.test(e.entryName) && !e.isDirectory);
      if (!entry) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
      const dest = path.join(tmp, 'crm.db');
      fs.writeFileSync(dest, entry.getData());
      return { dbPath: dest, cleanup: tmp };
    }
    try {
      execSync(`tar -xzf "${archivePath}" -C "${tmp}" crm.db`, { timeout: 180000, stdio: 'pipe' });
    } catch (_) {
      execSync(`tar -xzf "${archivePath}" -C "${tmp}"`, { timeout: 180000, stdio: 'pipe' });
    }
    const candidates = [path.join(tmp, 'crm.db'), path.join(tmp, 'server', 'crm.db')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return { dbPath: c, cleanup: tmp };
    }
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          const found = walk(p);
          if (found) return found;
        } else if (ent.name === 'crm.db') return p;
      }
      return null;
    };
    const found = walk(tmp);
    if (found) return { dbPath: found, cleanup: tmp };
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  } catch (_) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (__) {}
    return null;
  }
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
  if (!tableExists(db, 'products') || !tableExists(db, 'inventory_ledger')) {
    return { stockRestored: 0 };
  }
  const { stockCacheVsLedger, rebuildAllStockCaches } = require('./inventory/stock-cache');
  const before = stockCacheVsLedger(db, { limit: Number.MAX_SAFE_INTEGER });
  const ids = [...new Set(before.rows.map((r) => Number(r.product_id)).filter(Boolean))];
  rebuildAllStockCaches(db, { productIds: ids });
  return { stockRestored: ids.length };
}

function applyBackupProductMeta(db, bakProducts) {
  const summary = { packRestored: 0, priceRestored: 0, codeRestored: 0, noteRestored: 0, stockRestored: 0 };
  const byId = new Map(bakProducts.map(r => [r.id, r]));
  const cur = db.prepare('SELECT id, stock, pack_size, price, code, note FROM products').all();
  const updPack = db.prepare('UPDATE products SET pack_size=? WHERE id=?');
  const updPrice = db.prepare('UPDATE products SET price=? WHERE id=?');
  const updCode = db.prepare('UPDATE products SET code=? WHERE id=?');
  const updNote = db.prepare('UPDATE products SET note=? WHERE id=?');

  const tx = db.transaction(() => {
    for (const row of cur) {
      const b = byId.get(row.id);
      if (!b) continue;
      const curPack = Math.max(1, parseInt(row.pack_size, 10) || 1);
      const bakPack = Math.max(1, parseInt(b.pack_size, 10) || 1);
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
      // Backup stock is not restored: inventory_ledger is the quantity source of truth.
    }
  });
  tx();
  return summary;
}

function mergeMetaSummary(summary, part, backupName) {
  if (!part) return;
  const touched = (part.packRestored || 0) + (part.priceRestored || 0)
    + (part.codeRestored || 0) + (part.noteRestored || 0) + (part.stockRestored || 0);
  summary.packRestored += part.packRestored || 0;
  summary.priceRestored += part.priceRestored || 0;
  summary.codeRestored += part.codeRestored || 0;
  summary.noteRestored += part.noteRestored || 0;
  summary.stockRestored += part.stockRestored || 0;
  if (touched > 0) {
    if (!summary.backupUsed) summary.backupUsed = backupName;
    else if (!String(summary.backupUsed).split(',').includes(backupName)) {
      summary.backupUsed = `${summary.backupUsed},${backupName}`;
    }
  }
}

/**
 * Scan ALL readable backups (plain .db + tar.gz/zip) and fill empty wiped fields.
 * Previously returned on the first .db even when it had 0 products (e.g. empty
 * pre-prod snapshot), so newer tar.gz backups with price/code were never used.
 * applyBackupProductMeta only fills zeros/empties, so merging is safe.
 * Archives are tried oldest-first (pre-wipe data preferred).
 */
function restoreMetaFromBackup(db, backupsDir) {
  const summary = { backupUsed: null, packRestored: 0, priceRestored: 0, codeRestored: 0, noteRestored: 0, stockRestored: 0 };

  for (const c of listCandidateBackupDbs(backupsDir)) {
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
    try { bdb.close(); } catch (_) {}
    if (!bakProducts || bakProducts.length === 0) continue;
    mergeMetaSummary(summary, applyBackupProductMeta(db, bakProducts), path.basename(c.path));
  }

  // Oldest archive first → recover from pre-wipe snapshots before later partial wipes
  const archives = listCandidateArchives(backupsDir).slice().sort((a, b) => a.mtime - b.mtime);
  for (const a of archives) {
    const extracted = extractDbFromArchive(a.path, a.kind);
    if (!extracted) continue;
    const bdb = openReadonlySqlite(extracted.dbPath);
    if (!bdb) {
      try { fs.rmSync(extracted.cleanup, { recursive: true, force: true }); } catch (_) {}
      continue;
    }
    let bakProducts;
    try {
      if (!tableExists(bdb, 'products')) { bdb.close(); throw new Error('no products'); }
      bakProducts = bdb.prepare('SELECT id, stock, pack_size, price, code, note FROM products').all();
    } catch (_) {
      try { bdb.close(); } catch (__) {}
      try { fs.rmSync(extracted.cleanup, { recursive: true, force: true }); } catch (__) {}
      continue;
    }
    try { bdb.close(); } catch (_) {}
    try { fs.rmSync(extracted.cleanup, { recursive: true, force: true }); } catch (_) {}
    if (!bakProducts || bakProducts.length === 0) continue;
    mergeMetaSummary(summary, applyBackupProductMeta(db, bakProducts), path.basename(a.path));
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
