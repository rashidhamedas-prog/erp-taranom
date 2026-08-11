'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-company-switch-'));
process.env.JWT_SECRET = 'company-switch-test-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(tempRoot, 'company-a.db');
process.env.COMPANIES_DIR = path.join(tempRoot, 'companies');
process.env.AUTH_SESSION_DB_PATH = path.join(tempRoot, 'sessions.db');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');

const { initDB, getDB, getDBPath, closeDB } = require('../db');
const ws = require('../lib/company-workspace');
const { requestGuard } = require('../lib/company-switch-guard');
const companiesRouter = require('../routes/companies');
const { closeSessionStore } = require('../lib/auth-sessions');

async function main() {
  initDB();
  const original = ws.getActiveCompany();
  const originalPath = path.resolve(getDBPath());
  const target = ws.createCompanyWorkspace({ name: 'شرکت ب', code: 'B', sourceDb: getDB(), createdByUserId: 1 });

  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  let slowStartedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  const app = express();
  app.use(requestGuard);
  app.get('/slow', async (_req, res) => {
    slowStartedResolve();
    await slowGate;
    res.json({ ok: true });
  });
  app.post('/activate', (_req, res) => {
    try {
      companiesRouter._test.activateCompanySafely(target.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status || 500).json({ code: error.code });
    }
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const slowRequest = fetch(base + '/slow');
    await slowStarted;
    const busy = await fetch(base + '/activate', { method: 'POST' });
    const busyBody = await busy.json();
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busyBody.code, 'COMPANY_SWITCH_BUSY');
    assert.strictEqual(ws.getActiveCompany().id, original.id);
    assert.strictEqual(path.resolve(getDBPath()), originalPath);
    console.log('  PASS concurrent in-flight request blocks switch without changing registry or DB handle');
    releaseSlow();
    await slowRequest;

    assert.throws(() => companiesRouter._test.activateCompanySafely(target.id, {
      openTarget() {
        const error = new Error('injected target open failure');
        error.code = 'INJECTED_OPEN_FAILURE';
        throw error;
      },
    }), /injected target open failure/);
    assert.strictEqual(ws.getActiveCompany().id, original.id, 'registry must roll back after target open failure');
    assert.strictEqual(path.resolve(getDBPath()), originalPath, 'live DB handle must roll back after target open failure');
    assert.ok(getDB().prepare("SELECT id FROM users WHERE username='admin'").get());
    console.log('  PASS injected open failure rolls registry and live DB handle back together');
    console.log('Company switch safety: 2 passed, 0 failed');
  } finally {
    releaseSlow();
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
