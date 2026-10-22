'use strict';
/** Usage: node scripts/_sqlite-backup.js <src.db> <dest.db> */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const srcPath = process.argv[2] || 'crm.db';
const destPath = process.argv[3];
if (!destPath) {
  console.error('usage: node _sqlite-backup.js <src> <dest>');
  process.exit(2);
}
fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
const src = new Database(srcPath, { readonly: true, fileMustExist: true });
src.backup(destPath)
  .then(() => { src.close(); console.log('ok', destPath); })
  .catch((e) => { console.error(e); process.exit(1); });
