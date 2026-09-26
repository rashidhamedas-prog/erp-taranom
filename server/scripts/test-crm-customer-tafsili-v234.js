#!/usr/bin/env node
/**
 * Regression: CRM customer create (distribution_office path) must always get
 * a 12-digit coa_code on customers + linked CUST-* party — even when coa_mode
 * is NOT mahak (the old bug gated allocTafsili behind mahak only).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-tafsili-v234-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';
process.env.SYNC_ROLE = 'central';

const { ok, summary } = require('./lib/test-harness');

for (const rel of [
  '../db', '../lib/party-tafsili', '../lib/parties-sync', '../lib/coa-map',
  '../routes/customers', '../lib/auth-sessions',
]) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}

const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();

// Force non-mahak mode (the bug condition)
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_mode','standard')").run();

const { backfillMissingPartyTafsili, ensureCustomerTafsili } = require('../lib/party-tafsili');
const { syncCustomerToParty } = require('../lib/parties-sync');
const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');

console.log('══ CRM customer tafsili (non-mahak) ══');

const hash = bcrypt.hashSync('pass1234', 4);
const distUser = db.prepare(
  `INSERT INTO users (username,password,name,role,active,must_change_password)
   VALUES ('dist_v234',?,'دفتر پخش','distribution_office',1,0)`
).run(hash).lastInsertRowid;

// Simulate pre-fix create: customer + CUST party without coa
const custId = db.prepare(`
  INSERT INTO customers (user_id,biz,owner,phone,status,created_by,assigned_to)
  VALUES (?,'خانم معصومی تست','خانم معصومی','09151110024','new',?,?)
`).run(distUser, distUser, distUser).lastInsertRowid;
syncCustomerToParty(db, custId);
const before = db.prepare(`
  SELECT c.coa_code AS cust_coa, p.person_code, p.coa_code AS party_coa
  FROM customers c LEFT JOIN parties p ON p.id=c.party_id WHERE c.id=?
`).get(custId);
ok('fixture: CUST party without coa', before.person_code && String(before.person_code).startsWith('CUST-') && !before.party_coa && !before.cust_coa);

const code = ensureCustomerTafsili(db, custId);
ok('ensureCustomerTafsili returns 12-digit', !!code && String(code).length === 12);
const after = db.prepare(`
  SELECT c.coa_code AS cust_coa, p.coa_code AS party_coa
  FROM customers c LEFT JOIN parties p ON p.id=c.party_id WHERE c.id=?
`).get(custId);
ok('customer.coa_code set', after.cust_coa === code);
ok('party.coa_code set', after.party_coa === code);
ok('coa exists in chart', !!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=? AND level=4').get(code));

const cust2 = db.prepare(`
  INSERT INTO customers (user_id,biz,owner,phone,status,created_by,assigned_to)
  VALUES (?,'خانم صدوقی تست','خانم صدوقی','09151110025','new',?,?)
`).run(distUser, distUser, distUser).lastInsertRowid;
syncCustomerToParty(db, cust2);
db.prepare("DELETE FROM settings WHERE key='party_tafsili_backfill_v1'").run();
const bf = backfillMissingPartyTafsili(db);
ok('backfill ran', bf && !bf.skipped && bf.filled >= 1);
const c2 = db.prepare(`
  SELECT c.coa_code AS cust_coa, p.person_code, p.coa_code AS party_coa
  FROM customers c LEFT JOIN parties p ON p.id=c.party_id WHERE c.id=?
`).get(cust2);
ok('backfill set cust2 party coa', !!c2.party_coa && String(c2.party_coa).length === 12);
ok('backfill mirrored to customer', c2.cust_coa === c2.party_coa);
ok('backfill idempotent', backfillMissingPartyTafsili(db).skipped === true);

(async () => {
  let server;
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(distUser);
    const token = issueStaffSession(db, user, {
      device_kind: 'test',
      device_name: 'crm-tafsili-v234',
      device_fingerprint: 'crm-tafsili-v234-fp',
    }).token;

    const app = express();
    app.use(express.json());
    app.use('/api/customers', require('../routes/customers'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const created = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        biz: 'فروشگاه تست تفصیلی v234',
        owner: 'مالک تست',
        phone: '09151119999',
        city: 'مشهد',
      });
      const r = http.request({
        hostname: '127.0.0.1', port, path: '/api/customers', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, data: json });
        });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    ok('POST /api/customers 200', created.status === 200 && !!created.data?.id);
    const row = db.prepare(`
      SELECT c.coa_code AS cust_coa, p.person_code, p.coa_code AS party_coa
      FROM customers c LEFT JOIN parties p ON p.id=c.party_id WHERE c.id=?
    `).get(created.data.id);
    ok('API create: customer has 12-digit coa (non-mahak)', !!row.cust_coa && String(row.cust_coa).length === 12);
    ok('API create: party CUST-* has same coa', row.person_code && String(row.person_code).startsWith('CUST-') && row.party_coa === row.cust_coa);
  } catch (e) {
    ok('HTTP harness: ' + e.message, false);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { closeSessionStore(); } catch (_) {}
    try { db.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    const s = summary();
    process.exit(s.fail ? 1 : 0);
  }
})();
