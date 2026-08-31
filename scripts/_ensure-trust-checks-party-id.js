'use strict';
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || '/home/taranom/crm-taranom/server/crm.db';
const db = new Database(dbPath);
const cols = db.prepare('PRAGMA table_info(trust_checks)').all().map((c) => c.name);
if (!cols.includes('party_id')) {
  db.exec('ALTER TABLE trust_checks ADD COLUMN party_id INTEGER');
  console.log('added party_id');
} else {
  console.log('party_id exists');
}
db.close();
