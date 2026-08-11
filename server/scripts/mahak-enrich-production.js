#!/usr/bin/env node
/**
 * Enrich existing Mahak DB without full re-import:
 *   1) fix-mahak-placement (subgroups + journal relink)
 *   2) import-mahak-full-data.js if full data.xlsx is found
 *
 *   node server/scripts/mahak-enrich-production.js [target.db] [full-data.xlsx]
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const dbPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'crm.db'));
const fullDataArg = process.argv[3] ? path.resolve(process.argv[3]) : null;

if (!fs.existsSync(dbPath)) {
  console.error('ERROR: DB not found:', dbPath);
  process.exit(1);
}

const scriptsDir = __dirname;
const serverDir = path.join(scriptsDir, '..');

function run(script, scriptArgs) {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, script), ...scriptArgs], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, DB_PATH: dbPath },
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

console.log('==> phase 1: fix-mahak-placement...');
run('fix-mahak-placement.js', [dbPath]);

const candidates = [
  fullDataArg,
  path.join(path.dirname(dbPath), 'full data.xlsx'),
  path.join(serverDir, 'uploads', 'mahak', 'full data.xlsx'),
  'd:/soft/Claud/porje/CursorCrm/full data.xlsx',
].filter(Boolean);
const fullData = candidates.find(p => fs.existsSync(p)) || null;

if (fullData) {
  console.log('\n==> phase 2: import-mahak-full-data from', fullData);
  run('import-mahak-full-data.js', [fullData, dbPath, '--force']);
} else {
  console.log('\n==> phase 2: skipped (full data.xlsx not found)');
}

const db = require('better-sqlite3')(dbPath, { readonly: true });
const summary = {
  party_groups: db.prepare('SELECT COUNT(*) c FROM party_groups').get().c,
  product_categories: db.prepare('SELECT COUNT(*) c FROM product_categories').get().c,
  cheque_records: db.prepare('SELECT COUNT(*) c FROM cheque_records').get().c,
  linked_journals: db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type!='mahak_import'").get().c,
  remaining_mahak_import: db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak' AND ref_type='mahak_import'").get().c,
  mahak_full_data: db.prepare("SELECT value FROM settings WHERE key='mahak_full_data_import_v1'").get()?.value,
};
db.close();

console.log('\n==> ENRICH SUMMARY');
console.log(JSON.stringify(summary, null, 2));
