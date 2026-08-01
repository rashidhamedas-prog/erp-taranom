#!/usr/bin/env node
'use strict';
/**
 * Offline restore CLI — stop erp-taranom before running.
 * Usage:
 *   node server/scripts/restore-backup.js --file path/to/crm-backup-....zip.enc --confirm-offline
 */
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const file = flag('--file');
const confirm = args.includes('--confirm-offline');
if (!file || !confirm) {
  console.error('Usage: node server/scripts/restore-backup.js --file <archive> --confirm-offline');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('file not found');
  process.exit(1);
}
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const { restoreBackup } = require('../backup');
try {
  const result = restoreBackup(path.resolve(file), { confirmOfflineRestore: true });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
