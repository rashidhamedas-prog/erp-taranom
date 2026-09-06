'use strict';
const fs = require('fs');
const p = '/home/taranom/crm-taranom/server/db.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("CREATE TABLE IF NOT EXISTS user_invitations")) {
  if (!s.includes("user_invitations', 'intended_role'")) {
    const needle = "ensureColumn(db, 'users', 'person_id', 'INTEGER');";
    if (!s.includes(needle)) {
      console.log('DB_INVITE_PERSON_ID_NEEDLE_MISSING');
      process.exit(2);
    }
    const block = `${needle}
  if (tableExists(db, 'user_invitations')) {
    ensureColumn(db, 'user_invitations', 'person_id', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'token_hash', 'TEXT');
    ensureColumn(db, 'user_invitations', 'expires_at', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'used_at', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'invited_email', 'TEXT');
    ensureColumn(db, 'user_invitations', 'intended_role', 'TEXT');
    ensureColumn(db, 'user_invitations', 'created_by', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'created_at', "INTEGER DEFAULT (strftime('%s','now'))");
  }`;
    s = s.replace(needle, block);
    fs.writeFileSync(p, s);
    console.log('DB_INVITE_COLUMNS_PATCHED');
    process.exit(0);
  }
  console.log('DB_INVITE_ALREADY');
  process.exit(0);
}
const needle = "CREATE INDEX IF NOT EXISTS idx_reset_otp_user ON password_reset_otps(user_id);";
if (!s.includes(needle)) {
  console.log('DB_INVITE_NEEDLE_MISSING');
  process.exit(2);
}
const table = `
    ${needle}

    -- Staff invite tokens: central-only — NOT in SYNCABLE_TABLES
    CREATE TABLE IF NOT EXISTS user_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      invited_email TEXT,
      intended_role TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_invitations_person ON user_invitations(person_id);
    CREATE INDEX IF NOT EXISTS idx_user_invitations_hash ON user_invitations(token_hash);`;
s = s.replace(needle, table);
const colNeedle = "ensureColumn(db, 'users', 'person_id', 'INTEGER');";
if (!s.includes(colNeedle)) {
  fs.writeFileSync(p, s);
  console.log('DB_INVITE_TABLE_PATCHED_NO_COLUMNS');
  process.exit(0);
}
if (!s.includes("user_invitations', 'intended_role'")) {
  const block = `${colNeedle}
  if (tableExists(db, 'user_invitations')) {
    ensureColumn(db, 'user_invitations', 'person_id', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'token_hash', 'TEXT');
    ensureColumn(db, 'user_invitations', 'expires_at', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'used_at', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'invited_email', 'TEXT');
    ensureColumn(db, 'user_invitations', 'intended_role', 'TEXT');
    ensureColumn(db, 'user_invitations', 'created_by', 'INTEGER');
    ensureColumn(db, 'user_invitations', 'created_at', "INTEGER DEFAULT (strftime('%s','now'))");
  }`;
  s = s.replace(colNeedle, block);
}
fs.writeFileSync(p, s);
console.log('DB_INVITE_PATCHED');
