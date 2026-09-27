#!/usr/bin/env node
'use strict';
/**
 * Create a fresh SQLite via initDBOn and write schema dump + SHA-256.
 *
 * Requires Node ABI matching better-sqlite3 (Node 20 / MODULE_VERSION 115).
 * Prefer: .tools/node20/.../node.exe  OR  nvm use 20
 *
 * Usage:
 *   node scripts/native/schema-hash.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const OUT_DIR = path.join(ROOT, 'docs', 'native');
const OUT_SQL = path.join(OUT_DIR, 'schema.v1.sql');
const OUT_HASH = path.join(OUT_DIR, 'schema.v1.sha256');
const EXPECTED_MODULE = 115; // Node 20.x

function findNode20() {
  const candidates = [
    path.join(ROOT, '.tools', 'node20', 'node-v20.18.1-win-x64', 'node.exe'),
    path.join(ROOT, '.tools', 'node20', 'node.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

if (Number(process.versions.modules) !== EXPECTED_MODULE) {
  const node20 = findNode20();
  if (node20) {
    const r = spawnSync(node20, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: SERVER,
      env: process.env,
    });
    process.exit(r.status == null ? 1 : r.status);
  }
  console.error(
    `schema-hash: need Node MODULE_VERSION ${EXPECTED_MODULE} (Node 20); got ${process.versions.modules}.`
  );
  process.exit(1);
}

process.chdir(SERVER);
const Database = require(path.join(SERVER, 'node_modules', 'better-sqlite3'));

process.env.ERP_TEST_ISOLATION = '1';
process.env.SYNC_ROLE = process.env.SYNC_ROLE || 'device';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-schema-'));
const dbPath = path.join(tmpDir, 'schema.db');
process.env.DB_PATH = dbPath;

const { initDBOn, applyConnectionPragmas, closeDB } = require(path.join(SERVER, 'db.js'));

const db = new Database(dbPath);
applyConnectionPragmas(db);
initDBOn(db, {});

const tables = db.prepare(
  `SELECT name, sql FROM sqlite_master
   WHERE type='table' AND name NOT LIKE 'sqlite_%'
   ORDER BY name`
).all();
const indexes = db.prepare(
  `SELECT name, tbl_name, sql FROM sqlite_master
   WHERE type='index' AND sql IS NOT NULL
   ORDER BY name`
).all();
const triggers = db.prepare(
  `SELECT name, tbl_name, sql FROM sqlite_master
   WHERE type='trigger'
   ORDER BY name`
).all();

const lines = [];
lines.push('-- ERP Taranom schema dump (generated — do not edit by hand)');
lines.push('-- SYNC_ROLE: device');
lines.push(`-- tables: ${tables.length} indexes: ${indexes.length} triggers: ${triggers.length}`);
lines.push('');
for (const t of tables) {
  lines.push(t.sql + ';');
  lines.push('');
}
for (const i of indexes) {
  lines.push(i.sql + ';');
  lines.push('');
}
for (const tr of triggers) {
  lines.push(tr.sql + ';');
  lines.push('');
}

const sqlBody = lines.join('\n');
const hash = crypto.createHash('sha256').update(sqlBody).digest('hex');

// Deterministic file for CI (no wall-clock timestamp in body)
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_SQL, sqlBody);
fs.writeFileSync(OUT_HASH, hash + '\n');
fs.writeFileSync(
  path.join(OUT_DIR, 'schema.v1.meta.json'),
  JSON.stringify({
    schema_sha256: hash,
    tables: tables.length,
    indexes: indexes.length,
    triggers: triggers.length,
    SYNC_ROLE: process.env.SYNC_ROLE,
  }, null, 2) + '\n'
);

db.close();
try { closeDB(); } catch { /* */ }
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* windows file lock */ }

console.log('OK', OUT_SQL);
console.log('OK', OUT_HASH);
console.log('sha256', hash);
console.log('tables', tables.length, 'indexes', indexes.length, 'triggers', triggers.length);
