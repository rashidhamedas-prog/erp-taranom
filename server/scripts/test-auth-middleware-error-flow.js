'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-auth-next-'));
process.env.JWT_SECRET = 'auth-next-test-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(tempRoot, 'business.db');
process.env.AUTH_SESSION_DB_PATH = path.join(tempRoot, 'sessions.db');
process.env.COMPANIES_DIR = path.join(tempRoot, 'companies');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');

const { initDB, getDB, closeDB } = require('../db');
const { auth } = require('../middleware/auth');
const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');

async function main() {
  initDB();
  const db = getDB();
  db.prepare("UPDATE users SET must_change_password=0,auth_epoch=0 WHERE username='admin'").run();
  const user = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const issued = issueStaffSession(db, user, {
    device_fingerprint: 'error-flow-test', device_name: 'Error Flow', device_kind: 'web',
  });

  const app = express();
  app.set('internalReplayToken', 'not-used-by-this-test');
  app.get('/boom', auth, () => {
    const error = new Error('downstream boom');
    error.code = 'EXPECTED_DOWNSTREAM_ERROR';
    throw error;
  });
  app.use((error, _req, res, _next) => {
    res.status(500).json({ code: error.code });
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/boom`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    const body = await response.json();
    assert.strictEqual(response.status, 500, 'downstream exception must reach Express error middleware');
    assert.strictEqual(body.code, 'EXPECTED_DOWNSTREAM_ERROR');
    console.log('Auth middleware error flow: 1 passed, 0 failed');
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
