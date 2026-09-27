'use strict';
/**
 * Local backup helper for Domain Host (file copy of SQLite + meta).
 * Not the central admin dump — device-local snapshot only.
 */
const fs = require('fs');
const path = require('path');

function backupLocal(runtime, opts = {}) {
  if (!runtime?.dataRoot) {
    throw Object.assign(new Error('runtime dataRoot missing'), { code: 'E_BACKUP' });
  }
  const dbPath = path.join(runtime.dataRoot, 'erp.db');
  if (!fs.existsSync(dbPath)) {
    throw Object.assign(new Error('database not found'), { code: 'E_BACKUP_NO_DB' });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = opts.dir || path.join(runtime.dataRoot, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `erp-local-${stamp}.db`);
  fs.copyFileSync(dbPath, dest);
  // also copy WAL/SHM if present
  for (const ext of ['-wal', '-shm']) {
    const side = dbPath + ext;
    if (fs.existsSync(side)) fs.copyFileSync(side, dest + ext);
  }
  const meta = {
    at: Date.now(),
    source: dbPath,
    dest,
    bytes: fs.statSync(dest).size,
    brandId: runtime.brandId,
    syncRole: runtime.syncRole,
  };
  fs.writeFileSync(dest + '.json', JSON.stringify(meta, null, 2));
  return meta;
}

function listLocalBackups(runtime) {
  const dir = path.join(runtime.dataRoot, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { file: f, path: p, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { backupLocal, listLocalBackups };
