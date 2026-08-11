#!/usr/bin/env node
'use strict';
/**
 * Verify a backup package without mutating production.
 *   node server/scripts/verify-backup.js --file path/to/crm-backup-....zip.enc
 */
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const file = flag('--file');
if (!file) {
  console.error('Usage: node server/scripts/verify-backup.js --file <archive>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('file not found');
  process.exit(1);
}
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const { verifyBackupPackage } = require('../backup');
try {
  const result = verifyBackupPackage(path.resolve(file));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
