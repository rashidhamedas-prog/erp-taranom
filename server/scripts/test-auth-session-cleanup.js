'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-auth-cleanup-'));
const storePath = path.join(tempRoot, 'auth-sessions.db');
process.env.JWT_SECRET = 'auth-cleanup-test-secret-at-least-32-bytes';
process.env.AUTH_SESSION_DB_PATH = storePath;

const {
  consumeRateLimit,
  cleanupAuthSessionStore,
  closeSessionStore,
} = require('../lib/auth-sessions');

let passed = 0;
function ok(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log('  PASS', label);
}

try {
  // Initialize the schema and keep the library connection open. A second WAL
  // connection seeds deterministic old/fresh rows for the cleanup proof.
  consumeRateLimit('init', 'init', { max: 2, windowSec: 60 });
  const db = new Database(storePath);
  const now = Math.floor(Date.now() / 1000);
  const old = now - (3 * 24 * 60 * 60);
  const future = now + 3600;

  db.prepare(`INSERT INTO staff_sessions
    (sid_hash,user_id,device_slot,fingerprint_hash,auth_epoch,expires_at,created_at,last_seen,revoked_at)
    VALUES ('staff-expired',1,'web','f',0,?,?,?,NULL)`).run(old, old, old);
  db.prepare(`INSERT INTO staff_sessions
    (sid_hash,user_id,device_slot,fingerprint_hash,auth_epoch,expires_at,created_at,last_seen,revoked_at)
    VALUES ('staff-revoked',1,'desktop','f',0,?,?,?,?)`).run(future, old, old, old);
  db.prepare(`INSERT INTO staff_sessions
    (sid_hash,user_id,device_slot,fingerprint_hash,auth_epoch,expires_at,created_at,last_seen,revoked_at)
    VALUES ('staff-fresh',2,'web','f',0,?,?,?,NULL)`).run(future, now, now);

  db.prepare(`INSERT INTO b2b_sessions
    (sid_hash,account_id,customer_id,auth_epoch,expires_at,created_at,last_seen,revoked_at)
    VALUES ('b2b-expired',1,1,0,?,?,?,NULL)`).run(old, old, old);
  db.prepare(`INSERT INTO b2b_sessions
    (sid_hash,account_id,customer_id,auth_epoch,expires_at,created_at,last_seen,revoked_at)
    VALUES ('b2b-fresh',2,2,0,?,?,?,NULL)`).run(future, now, now);

  db.prepare(`INSERT INTO login_challenges
    (jti_hash,user_id,auth_epoch,attempts,expires_at,used_at,created_at)
    VALUES ('challenge-used',1,0,0,?,?,?)`).run(future, old, old);
  db.prepare(`INSERT INTO login_challenges
    (jti_hash,user_id,auth_epoch,attempts,expires_at,used_at,created_at)
    VALUES ('challenge-fresh',2,0,0,?,NULL,?)`).run(future, now);

  db.prepare(`INSERT INTO auth_rate_limits
    (action,subject_hash,window_started,attempts,blocked_until)
    VALUES ('old','old',?,1,NULL)`).run(old);
  db.prepare(`INSERT INTO auth_rate_limits
    (action,subject_hash,window_started,attempts,blocked_until)
    VALUES ('fresh','fresh',?,1,NULL)`).run(now);
  db.close();

  const result = cleanupAuthSessionStore({ force: true, now });
  ok(result.staff === 2, 'expired and old-revoked staff sessions are removed');
  ok(result.b2b === 1, 'expired B2B sessions are removed');
  ok(result.challenges === 1, 'old used challenges are removed');
  ok(result.rateLimits >= 1, 'stale rate-limit buckets are removed');

  const check = new Database(storePath, { readonly: true });
  ok(check.prepare("SELECT COUNT(*) c FROM staff_sessions WHERE sid_hash='staff-fresh'").get().c === 1,
    'active staff session is retained');
  ok(check.prepare("SELECT COUNT(*) c FROM b2b_sessions WHERE sid_hash='b2b-fresh'").get().c === 1,
    'active B2B session is retained');
  ok(check.prepare("SELECT COUNT(*) c FROM login_challenges WHERE jti_hash='challenge-fresh'").get().c === 1,
    'fresh challenge is retained');
  ok(check.prepare("SELECT COUNT(*) c FROM auth_rate_limits WHERE action='fresh'").get().c === 1,
    'fresh rate-limit bucket is retained');
  check.close();

  console.log(`Auth/session cleanup: ${passed} passed, 0 failed`);
} finally {
  closeSessionStore();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact temporary test root */ }
}
