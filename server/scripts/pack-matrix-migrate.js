#!/usr/bin/env node
/**
 * CLI: pack-matrix schema up | down | status
 * Usage: node scripts/pack-matrix-migrate.js up|down|status [--db <path>]
 * Never point --db at live crm.db unless Step 8 preconditions are met.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const cmd = String(args[0] || 'status').toLowerCase();
let dbPath = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--db' && args[i + 1]) {
    dbPath = args[++i];
  }
}

if (!dbPath) {
  console.error('Usage: node scripts/pack-matrix-migrate.js up|down|status --db <path>');
  process.exit(2);
}

const abs = path.resolve(dbPath);
if (!fs.existsSync(abs) && cmd !== 'up') {
  console.error('DB not found:', abs);
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(abs);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 8000');

const {
  up, down, status,
} = require('../lib/inventory/pack-matrix-schema');

try {
  if (cmd === 'up') {
    const r = up(db);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'down') {
    const r = down(db);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify(status(db), null, 2));
  process.exit(0);
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
} finally {
  try { db.close(); } catch (_) {}
}
