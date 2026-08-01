'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-auth-migration-'));
const file = path.join(dir, 'legacy.db');
process.env.DB_PATH = file;
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'migration-auth-secret-explicit';

const dbModule = require('../db');

try {
  dbModule.initDB();
  dbModule.closeDB();

  let raw = new Database(file);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE user_device_sessions;
    CREATE TABLE user_device_sessions (
      user_id INTEGER PRIMARY KEY,
      device_fingerprint TEXT NOT NULL,
      device_name TEXT,
      device_kind TEXT,
      last_seen INTEGER,
      created_at INTEGER
    );
    INSERT INTO user_device_sessions
      (user_id,device_fingerprint,device_name,device_kind,last_seen,created_at)
    SELECT id,'legacy-plaintext','Legacy browser','web',strftime('%s','now'),strftime('%s','now')
    FROM users ORDER BY id LIMIT 1;
  `);
  raw.close();

  dbModule.initDB();
  dbModule.closeDB();
  dbModule.initDB(); // re-run safety
  dbModule.closeDB();

  raw = new Database(file, { readonly: true });
  const columns = new Set(raw.prepare('PRAGMA table_info(user_device_sessions)').all().map((row) => row.name));
  for (const name of ['id', 'device_slot', 'session_id', 'expires_at', 'auth_epoch', 'revoked_at']) {
    assert(columns.has(name), `missing migrated column ${name}`);
  }
  assert.strictEqual(raw.prepare('SELECT COUNT(*) c FROM user_device_sessions').get().c, 0,
    'legacy sid-less sessions must be invalidated');
  assert.strictEqual(raw.prepare("SELECT value FROM settings WHERE key='schema_auth_sessions_v1'").get().value, '1');
  assert.strictEqual(raw.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
  raw.close();
  console.log('Auth/session migration: 9 passed, 0 failed');
} finally {
  try { dbModule.closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
