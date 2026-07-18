#!/usr/bin/env node
// One-off DB integrity checker (run on server: node scripts/check-db-integrity.js)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const serverDir = path.join(__dirname, '..', 'server');
const Database = require(path.join(serverDir, 'node_modules', 'better-sqlite3'));
process.chdir(serverDir);

function check(p) {
  const full = path.isAbsolute(p) ? p : path.join(serverDir, p);
  if (!fs.existsSync(full)) {
    console.log(`${p}: MISSING`);
    return false;
  }
  try {
    const d = new Database(full, { readonly: true });
    const r = d.pragma('integrity_check');
    const status = Array.isArray(r) ? (typeof r[0] === 'string' ? r[0] : JSON.stringify(r[0])) : JSON.stringify(r);
    console.log(`${p}: ${status}`);
    d.close();
    return status === 'ok';
  } catch (e) {
    console.log(`${p}: ERR ${e.message}`);
    return false;
  }
}

['crm.db', 'crm-pre-mahak.db', 'backups/pre-mahak-2026-07-13.db'].forEach(check);

const tmp = '/tmp/dbrestore-check';
fs.mkdirSync(tmp, { recursive: true });
for (const tar of [
  'backups/crm-latest.tar.gz',
  'backups/crm-backup-20260713-000000.tar.gz',
  'backups/crm-backup-20260712-000000.tar.gz',
  'backups/crm-backup-20260711-000000.tar.gz'
]) {
  const extracted = path.join(tmp, 'crm.db');
  try {
    if (fs.existsSync(extracted)) fs.unlinkSync(extracted);
    execSync(`tar -xzf ${path.join(serverDir, tar)} -C ${tmp} ./crm.db`, { stdio: 'pipe' });
    check(`${tar} → crm.db`);
  } catch (e) {
    console.log(`${tar}: extract fail`);
  }
}
