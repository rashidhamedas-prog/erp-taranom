// Pull uploaded media (product images, message attachments, voucher scans)

// from central to the local UPLOADS_DIR on device builds. DB sync alone only

// copies filenames — without this step offline apps show broken images.

const fs = require('fs');

const path = require('path');

const { UPLOADS_ROOT } = require('../paths');



const FILE_QUERIES = [

  { subdir: 'products', sql: "SELECT DISTINCT image AS name FROM products WHERE image IS NOT NULL AND image != ''" },

  { subdir: 'messages', sql: "SELECT DISTINCT image AS name FROM messages WHERE image IS NOT NULL AND image != ''" },

  { subdir: 'vouchers', sql: "SELECT DISTINCT attachment AS name FROM journal_entries WHERE attachment IS NOT NULL AND attachment != ''" },

];



const ALLOWED_SUBDIRS = new Set(['products', 'messages', 'vouchers']);



function collectNeededFiles(db) {

  const seen = new Set();

  const out = [];

  for (const q of FILE_QUERIES) {

    try {

      for (const row of db.prepare(q.sql).all()) {

        if (!row.name) continue;

        const key = q.subdir + '/' + row.name;

        if (seen.has(key)) continue;

        seen.add(key);

        out.push({ subdir: q.subdir, name: row.name });

      }

    } catch { /* column/table may be absent on older schemas */ }

  }

  return out;

}



function localFilePath(subdir, name) {

  return path.join(UPLOADS_ROOT, subdir, name);

}



function isPresent(subdir, name) {

  try {

    const p = localFilePath(subdir, name);

    return fs.existsSync(p) && fs.statSync(p).size > 0;

  } catch { return false; }

}



function countMissingFiles(db) {

  return collectNeededFiles(db).filter(f => !isPresent(f.subdir, f.name)).length;

}



async function pullOneFile(cfg, subdir, name) {

  if (!cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) return false;

  if (!ALLOWED_SUBDIRS.has(subdir) || !name || name.includes('..') || name.includes('/')) return false;

  if (isPresent(subdir, name)) return true;



  const rel = `${subdir}/${name}`;

  const headers = { Authorization: `Device ${cfg.deviceId}:${cfg.deviceToken}` };

  const r = await fetch(

    `${cfg.centralUrl.replace(/\/$/, '')}/api/sync/files?path=${encodeURIComponent(rel)}`,

    { headers }

  );

  if (!r.ok) return false;

  const dest = localFilePath(subdir, name);

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));

  return true;

}



async function pullMissingFiles(db, cfg) {

  if (!cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) return { pulled: 0, failed: 0 };

  const needed = collectNeededFiles(db);

  let pulled = 0, failed = 0;



  for (const { subdir, name } of needed) {

    if (isPresent(subdir, name)) continue;

    try {

      if (await pullOneFile(cfg, subdir, name)) pulled++;

      else failed++;

    } catch (e) {

      failed++;

      console.error('sync file pull:', subdir + '/' + name, e.message);

    }

  }

  return { pulled, failed };

}



// On-demand: when the UI requests /uploads/... and the file isn't local yet,

// fetch it from central and cache it — fixes broken product images without

// waiting for the next background sync cycle.

function uploadFallbackMiddleware(getConfig) {

  return async (req, res, next) => {

    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const rel = String(req.path || '').replace(/^\/+/, '');

    if (!rel || rel.includes('..')) return next();

    const parts = rel.split('/');

    const subdir = parts[0];

    const name = parts.slice(1).join('/');

    if (!ALLOWED_SUBDIRS.has(subdir) || !name) return next();

    if (isPresent(subdir, name)) return next();



    const cfg = getConfig();

    if (!cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) return next();



    try {

      const ok = await pullOneFile(cfg, subdir, name);

      if (!ok) return next();

      const filePath = localFilePath(subdir, name);

      if (req.method === 'HEAD') return res.end();

      return res.sendFile(filePath);

    } catch (e) {

      console.error('upload fallback:', rel, e.message);

      return next();

    }

  };

}



module.exports = {

  collectNeededFiles, pullMissingFiles, pullOneFile, countMissingFiles,

  isPresent, localFilePath, uploadFallbackMiddleware

};

