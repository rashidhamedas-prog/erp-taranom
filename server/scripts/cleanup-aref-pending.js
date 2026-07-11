#!/usr/bin/env node
/**
 * One-time cleanup (spec 1.0.9 §5): delete pending field-rep payment submissions
 * for the user named "aref" (matches name or username, case-insensitive).
 *
 * Usage:
 *   DB_PATH=/path/to/crm.db node server/scripts/cleanup-aref-pending.js
 *   node server/scripts/cleanup-aref-pending.js --dry-run
 *
 * Default DB_PATH: server/crm.db (same as production app when run from server/).
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
const dry = process.argv.includes('--dry-run');

const db = new Database(DB_PATH);
const users = db.prepare(`
  SELECT id, name, username FROM users
  WHERE LOWER(name) LIKE '%aref%' OR LOWER(username) LIKE '%aref%'
`).all();

if (!users.length) {
  console.log('No user matching "aref" found in', DB_PATH);
  process.exit(0);
}

console.log('Matched users:', users.map(u => `#${u.id} ${u.name} (${u.username})`).join(', '));

const ids = users.map(u => u.id);
const placeholders = ids.map(() => '?').join(',');
const pending = db.prepare(`
  SELECT p.id, p.rep_id, p.amount, p.status, p.date, c.biz
  FROM rep_payment_submissions p
  LEFT JOIN customers c ON p.cust_id = c.id
  WHERE p.rep_id IN (${placeholders}) AND p.status = 'pending'
`).all(...ids);

if (!pending.length) {
  console.log('No pending rep_payment_submissions for matched users.');
  process.exit(0);
}

console.log(`Found ${pending.length} pending submission(s):`);
for (const p of pending) {
  console.log(`  #${p.id} rep=${p.rep_id} ${p.amount} ت ${p.date || ''} — ${p.biz || '?'}`);
}

if (dry) {
  console.log('--dry-run: nothing deleted');
  process.exit(0);
}

const del = db.prepare(`
  DELETE FROM rep_payment_submissions
  WHERE rep_id IN (${placeholders}) AND status = 'pending'
`).run(...ids);
console.log(`Deleted ${del.changes} pending row(s).`);
