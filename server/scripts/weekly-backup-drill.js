#!/usr/bin/env node
'use strict';
/**
 * Weekly isolated restore drill from offsite copy (does not touch production DB).
 *
 *   node server/scripts/weekly-backup-drill.js
 *   node server/scripts/weekly-backup-drill.js --file /path/to/offsite.zip.enc
 *
 * Uses BACKUP_OFFSITE_DIR (latest) or --file. Restores into a temp dir, compares
 * fingerprints to the package verify result, records last_drill in backup-status.json.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const started = Date.now();
const explicit = flag('--file');
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

const {
  verifyBackupPackage,
  restoreBackup,
  fingerprintDb,
  compareFingerprints,
  recordDrillResult,
  BACKUP_DIR,
} = require('../backup');

function pickOffsiteFile() {
  if (explicit) return path.resolve(explicit);
  const dir = process.env.BACKUP_OFFSITE_DIR;
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('set BACKUP_OFFSITE_DIR or pass --file <archive>');
  }
  const files = fs.readdirSync(dir)
    .filter((f) => /^crm-backup-.*\.(zip|tar\.gz)(\.enc)?$/i.test(f))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('no crm-backup-* files in BACKUP_OFFSITE_DIR');
  return path.join(dir, files[0].name);
}

(async () => {
  const source = pickOffsiteFile();
  console.log('drill source:', source);
  const verified = verifyBackupPackage(source);
  if (!verified.ok) throw new Error('verify failed');

  const isolate = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-weekly-drill-'));
  const targetDb = path.join(isolate, 'restored.db');
  try {
    const restored = restoreBackup(source, {
      confirmOfflineRestore: true,
      dbPath: targetDb,
      targetDir: path.join(isolate, 'stage'),
      restoreUploads: false,
      restorePrivate: false,
      keepStaging: false,
    });
    const liveFp = fingerprintDb(targetDb);
    const pkgFp = (verified.fingerprints || [])[0] || null;
    const cmp = compareFingerprints(liveFp, pkgFp);
    if (!cmp.ok) throw new Error(cmp.reason || 'fingerprint mismatch');

    const duration_ms = Date.now() - started;
    recordDrillResult({
      ok: true,
      source,
      duration_ms,
      rto_estimate_sec: Math.round(duration_ms / 1000),
      fingerprints: { package: pkgFp, restored: liveFp },
    });
    console.log(JSON.stringify({
      ok: true,
      source,
      duration_ms,
      rto_estimate_sec: Math.round(duration_ms / 1000),
      fingerprints_match: true,
      pre_restore_db: restored.pre_restore_db || null,
      status_file: path.join(BACKUP_DIR, 'backup-status.json'),
    }, null, 2));
  } finally {
    try { fs.rmSync(isolate, { recursive: true, force: true }); } catch { /* */ }
  }
})().catch((e) => {
  try {
    recordDrillResult({ ok: false, error: String(e.message || e), source: explicit || process.env.BACKUP_OFFSITE_DIR || null });
  } catch { /* */ }
  console.error(e.message || e);
  process.exit(1);
});
