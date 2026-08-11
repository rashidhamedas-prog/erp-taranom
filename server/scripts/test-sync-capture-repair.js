'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sync-capture-'));
process.env.SYNC_ROLE = 'device';
process.env.JWT_SECRET = 'sync-capture-repair-test-secret-32-bytes';
process.env.DB_PATH = path.join(tempRoot, 'device.db');
process.env.AUTH_SESSION_DB_PATH = path.join(tempRoot, 'sessions.db');
process.env.COMPANIES_DIR = path.join(tempRoot, 'companies');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.PRIVATE_UPLOADS_DIR = path.join(tempRoot, 'private');

const { initDB, getDB, closeDB } = require('../db');
const { captureMiddleware } = require('../sync/capture');
const { setSecret } = require('../sync/secure-kv');
const { reconcileCaptureFailures } = require('../sync/client');
const {
  generateReplaySigningKeyPair,
  verifyReplayEnvelope,
} = require('../sync/device-auth');
const { closeSessionStore } = require('../lib/auth-sessions');

async function main() {
  initDB();
  const db = getDB();
  db.prepare("INSERT OR REPLACE INTO sync_local_kv (key,value) VALUES ('central_url','http://127.0.0.1:5999')").run();
  db.prepare("INSERT OR REPLACE INTO sync_local_kv (key,value) VALUES ('device_id','7')").run();
  setSecret(db, 'device_token', 'a'.repeat(64));
  // Encrypted storage is healthy, but the key material itself is malformed so
  // signing fails only after the local route has committed.
  setSecret(db, 'device_signing_private_key', 'malformed-private-key');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use(captureMiddleware);
  app.post('/api/test-capture', (req, res) => {
    const inserted = db.prepare('INSERT INTO customers (user_id,biz) VALUES (?,?)').run(1, req.body.biz);
    res.json({ id: Number(inserted.lastInsertRowid), ok: true });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/test-capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ biz: 'repair-me' }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 503);
    assert.strictEqual(body.code, 'SYNC_CAPTURE_REPAIR_QUEUED');
    assert.strictEqual(body.local_change_applied, true);
    assert.strictEqual(body.queued_for_repair, true);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM customers WHERE biz='repair-me'").get().c, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM sync_outbox').get().c, 0,
      'failed signing must not leave an unsigned outbox success');
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM sync_capture_failures WHERE status='pending'").get().c, 1);
    console.log('  PASS capture failure is explicit and durably queued after the local commit');

    const keys = generateReplaySigningKeyPair();
    setSecret(db, 'device_signing_private_key', keys.privateKey);
    assert.strictEqual(reconcileCaptureFailures(db, { deviceId: 7 }), 1);
    const outbox = db.prepare('SELECT * FROM sync_outbox').get();
    assert.ok(outbox.replay_proof, 'reconciled outbox row must have a proof');
    assert.ok(verifyReplayEnvelope(keys.publicKey, outbox.replay_proof, {
      deviceId: 7,
      seq: outbox.id,
      method: outbox.method,
      path: outbox.path,
      userId: outbox.user_id,
      body: JSON.parse(outbox.body_json),
      fileHash: outbox.replay_file_hash || '',
      fileField: outbox.replay_file_field || '',
    }));
    assert.strictEqual(db.prepare("SELECT status FROM sync_capture_failures").get().status, 'reconciled');
    console.log('  PASS repair queue recreates a fully signed outbox operation exactly once');
    console.log('Sync capture repair: 2 passed, 0 failed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main()
  .finally(() => {
    closeSessionStore();
    closeDB();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact test root */ }
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
