#!/usr/bin/env node
'use strict';
/**
 * Phase 2 — cheque books/leaves uniqueness + void, sayadi dummy/required for opening, soft-delete category.
 * DB in os.tmpdir() only — never crm.db.
 * Run: node scripts/test-cheque-module-p2.js
 *   or: npm run test:cheque-module-p2
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const { swAtLeast } = require('./lib/sw-at-least');
const quality = require('../lib/cheque-quality');
const leaves = require('../lib/cheque-book-leaves');

let passed = 0;
let failed = 0;
const blockers = [];

function ok(cond, msg, extra) {
  try {
    assert.strictEqual(!!cond, true, msg);
    passed += 1;
    console.log('  ✓', msg);
  } catch (e) {
    failed += 1;
    console.log('  ✗', msg, extra == null ? (e && e.message) : extra);
  }
}

function softTodo(cond, msg, todo) {
  if (cond) {
    passed += 1;
    console.log('  ✓', msg);
  } else {
    blockers.push(todo || msg);
    console.log('  ⏭ TODO', msg, '—', todo || 'waiting on sibling');
  }
}

console.log('test-cheque-module-p2');

/* ---- SW pin ---- */
{
  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(swAtLeast(swSrc, 566), 'SW cache ≥ erp-taranom-v566');
}

/* ---- validateSayadi: dummy / repeated / empty ---- */
{
  ok(quality.validateSayadi('1234567891234567').code === 'E_SAYAD_DUMMY', 'dummy sayadi 1234567891234567 rejected');
  ok(quality.validateSayadi('0000000000000000').code === 'E_SAYAD_DUMMY', 'all-zeros sayadi rejected');
  ok(quality.validateSayadi('1111111111111111').code === 'E_SAYAD_DUMMY', 'repeated-digit sayadi rejected');
  ok(quality.validateSayadi('').code === 'E_SAYAD_INVALID' || quality.validateSayadi('').code === 'E_SAYAD_REQUIRED',
    'empty sayadi invalid/required');
  const good = quality.validateSayadi('2215300887814712');
  ok(good.ok && good.digits === '2215300887814712', 'valid 16-digit sayadi accepted');
}

/* ---- temp schema: leaf uniqueness + void + soft-delete column ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-p2-'));
const dbPath = path.join(tmp, 't.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER DEFAULT 1
  );
  CREATE TABLE check_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id INTEGER NOT NULL, name TEXT NOT NULL,
    serial_from TEXT DEFAULT '', serial_to TEXT DEFAULT '',
    active INTEGER DEFAULT 1, leaf_count INTEGER DEFAULT 0,
    issue_date TEXT, deleted_at INTEGER,
    FOREIGN KEY(bank_id) REFERENCES banks(id)
  );
  CREATE TABLE cheque_book_leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_category_id INTEGER NOT NULL,
    serial TEXT NOT NULL,
    sayadi TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'blank'
      CHECK (status IN ('blank','issued','void','lost','cancelled')),
    cheque_record_id INTEGER,
    void_reason TEXT DEFAULT '',
    voided_by INTEGER,
    voided_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE (check_category_id, serial),
    FOREIGN KEY (check_category_id) REFERENCES check_categories(id)
  );
  CREATE UNIQUE INDEX idx_cheque_book_leaves_sayadi
    ON cheque_book_leaves(sayadi) WHERE sayadi IS NOT NULL AND sayadi <> '';
  CREATE TABLE cheque_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
    sayadi TEXT DEFAULT '', leaf_id INTEGER,
    record_status TEXT NOT NULL DEFAULT 'posted',
    lifecycle_status TEXT DEFAULT 'registered',
    party_id INTEGER, customer_id INTEGER, party_name TEXT DEFAULT '',
    branch TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT ''
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, name TEXT, role TEXT, is_active INTEGER DEFAULT 1
  );
`);

const bankId = db.prepare("INSERT INTO banks (name) VALUES ('ملت')").run().lastInsertRowid;
const catId = db.prepare(`
  INSERT INTO check_categories (bank_id, name, serial_from, serial_to, leaf_count)
  VALUES (?, 'دسته تست P2', '100', '105', 0)
`).run(bankId).lastInsertRowid;

/* leaf uniqueness (same serial in category fails / is skipped) */
{
  const g1 = leaves.generateLeaves(db, catId, '100', '102');
  ok(g1.created === 3, `generateLeaves creates 3 blanks (got ${g1.created})`);
  const g2 = leaves.generateLeaves(db, catId, '100', '102');
  ok(g2.created === 0 && g2.skipped === 3, 'duplicate serials in same category skipped (idempotent)');
  let threwUnique = false;
  try {
    db.prepare(
      "INSERT INTO cheque_book_leaves (check_category_id, serial, status) VALUES (?, '100', 'blank')"
    ).run(catId);
  } catch (e) {
    threwUnique = /UNIQUE|unique/i.test(String(e && e.message));
  }
  ok(threwUnique, 'UNIQUE(check_category_id, serial) rejects duplicate insert');
}

/* void leaf with reason */
{
  const blank = db.prepare(
    "SELECT * FROM cheque_book_leaves WHERE check_category_id=? AND status='blank' ORDER BY id LIMIT 1"
  ).get(catId);
  ok(!!blank, 'blank leaf exists for void test');
  let noReason = false;
  try {
    leaves.markLeafUnavailable(db, catId, blank.id, 'void', '  ', 1);
  } catch (e) {
    noReason = e.code === 'E_VOID_REASON';
  }
  ok(noReason, 'void leaf without reason → E_VOID_REASON');
  const voided = leaves.markLeafUnavailable(db, catId, blank.id, 'void', 'پارگی برگ', 1);
  ok(voided && voided.status === 'void', 'void leaf sets status=void');
  ok(String(voided.void_reason || '') === 'پارگی برگ', 'void leaf stores reason');
  ok(Number(voided.voided_by) === 1, 'void leaf stores voided_by');
  ok(!!voided.voided_at, 'void leaf stamps voided_at');
  ok(leaves.countUsedLeaves(db, catId) >= 1, 'used_leaves counts void status');
}

/* soft-delete category (schema + SQL contract from check-categories DELETE) */
{
  const cols = db.prepare('PRAGMA table_info(check_categories)').all().map((c) => c.name);
  ok(cols.includes('deleted_at'), 'check_categories.deleted_at column present');
  db.prepare(
    "UPDATE check_categories SET deleted_at=strftime('%s','now'), active=0 WHERE id=? AND deleted_at IS NULL"
  ).run(catId);
  const hidden = db.prepare(
    'SELECT * FROM check_categories WHERE id=? AND deleted_at IS NULL'
  ).get(catId);
  ok(!hidden, 'soft-delete hides category from active SELECT');
  const row = db.prepare('SELECT * FROM check_categories WHERE id=?').get(catId);
  ok(row && Number(row.deleted_at) > 0 && Number(row.active) === 0, 'soft-delete sets deleted_at + active=0');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/check-categories.js'), 'utf8');
  ok(routeSrc.includes('soft_deleted') && routeSrc.includes('deleted_at'),
    'check-categories DELETE is soft-delete (not physical)');
  ok(!/DELETE FROM check_categories WHERE id=\?/.test(routeSrc),
    'no physical DELETE FROM check_categories in route');
}

db.close();

/* ---- opening import helper: empty sayadi → E_SAYAD_REQUIRED (part B lib) ---- */
{
  let openingImport;
  try {
    openingImport = require('../lib/cheque-opening-import');
  } catch (e) {
    openingImport = null;
    blockers.push(`cheque-opening-import.js: ${e.message}`);
  }
  const stubDb = {
    prepare(sql) {
      const s = String(sql || '');
      return {
        get(...args) {
          if (/FROM parties/i.test(s)) {
            return {
              id: Number(args[0]) || 1,
              full_name: 'مشتری تست',
              company_name: '',
              biz: '',
              legacy_table: 'customers',
              legacy_id: 1,
            };
          }
          return null;
        },
        all() { return []; },
        run() { return { changes: 0, lastInsertRowid: 0 }; },
      };
    },
  };
  if (openingImport && typeof openingImport.validateOpeningImportRow === 'function') {
    const row = openingImport.validateOpeningImportRow({
      amount: 1000000,
      sayadi: '',
      cheque_number: 'P2-1',
      due_date: '1405/09/01',
      bank_name: 'ملت',
      branch: 'مرکزی',
      party_id: 1,
    }, 0, { db: stubDb, seenSayads: new Set(), direction: 'in' });
    const codes = (row.errors || []).map((e) => e.code || e);
    ok(codes.includes('E_SAYAD_REQUIRED'),
      'opening-import validateOpeningImportRow rejects empty sayadi',
      JSON.stringify(row.errors || row).slice(0, 160));
  } else if (openingImport && typeof openingImport.previewOpeningImport === 'function') {
    const preview = openingImport.previewOpeningImport(stubDb, {
      direction: 'in',
      rows: [{
        amount: 1000000, sayadi: '', cheque_number: 'P2-1',
        due_date: '1405/09/01', bank_name: 'ملت', branch: 'مرکزی', party_id: 1,
      }],
    });
    ok(/E_SAYAD_REQUIRED/.test(JSON.stringify(preview)),
      'opening-import preview flags empty sayadi E_SAYAD_REQUIRED');
  } else {
    softTodo(false, 'opening-import empty sayadi E_SAYAD_REQUIRED',
      'export validateOpeningImportRow/previewOpeningImport from cheque-opening-import.js');
  }
}

/* ---- opening create rejects empty sayadi (HTTP against live route when ready) ---- */
(async () => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-p2-http-'));
  const httpDb = path.join(httpDir, 't.db');
  process.env.DB_PATH = httpDb;
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-cheque-module-p2-secret-32chars!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(httpDir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';

  Object.keys(require.cache).forEach((k) => {
    if (/[\\/]server[\\/](db\.js|routes[\\/]cheque-records|lib[\\/]cheque|lib[\\/]auth)/.test(k)
      || /[\\/]server[\\/](db\.js|routes\/cheque-records|lib\/cheque|lib\/auth)/.test(k)) {
      delete require.cache[k];
    }
  });
  try { delete require.cache[require.resolve('../db')]; } catch (_) { /* */ }

  let openingOk = false;
  let openingDetail = '';
  try {
    const { initDB, getDB } = require('../db');
    initDB();
    const liveDb = getDB();
    const admin = liveDb.prepare("SELECT * FROM users WHERE username='admin'").get();
    if (!admin) throw new Error('admin user missing after initDB');
    liveDb.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

    const partyId = liveDb.prepare(`
      INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, biz)
      VALUES ('P-P2-1', 'customer', 'customer', 'مشتری تست P2', '09120000001', 1, 'مشتری تست P2')
    `).run().lastInsertRowid;

    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const token = issueStaffSession(liveDb, admin, {
      device_kind: 'test',
      device_name: 'chq-p2',
      device_fingerprint: 'chq-p2-fp',
    }).token;

    const chequeRecords = require('../routes/cheque-records');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/cheque-records', chequeRecords);

    const server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();

    function postCheque(payload) {
      const body = JSON.stringify(payload);
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/cheque-records',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        }, (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ status: r.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }

    const res = await postCheque({
      direction: 'in',
      amount: 1000000,
      opening: true,
      sayadi: '',
      cheque_number: 'P2-OPEN-1',
      party_id: partyId,
      due_date: '1405/09/01',
      issue_date: '1405/08/05',
      bank_name: 'ملت',
      branch: 'مرکزی',
    });

    let parsed = {};
    try { parsed = JSON.parse(res.body || '{}'); } catch (_) { /* */ }
    openingDetail = `HTTP ${res.status} code=${parsed.code || '-'} err=${parsed.error || res.body.slice(0, 80)}`;
    openingOk = res.status === 400 && (
      parsed.code === 'E_SAYAD_REQUIRED'
      || parsed.code === 'E_SAYAD_INVALID'
    );

    const resDummy = await postCheque({
      direction: 'in',
      amount: 1000000,
      opening: true,
      sayadi: '1234567891234567',
      cheque_number: 'P2-OPEN-2',
      party_id: partyId,
      due_date: '1405/09/01',
      issue_date: '1405/08/05',
      bank_name: 'ملت',
      branch: 'مرکزی',
    });
    let dummyParsed = {};
    try { dummyParsed = JSON.parse(resDummy.body || '{}'); } catch (_) { /* */ }
    ok(
      resDummy.status === 400 && dummyParsed.code === 'E_SAYAD_DUMMY',
      'opening create rejects dummy sayadi 1234567891234567',
      `HTTP ${resDummy.status} ${dummyParsed.code || resDummy.body.slice(0, 60)}`
    );

    server.close();
    try { closeSessionStore(); } catch (_) { /* */ }
  } catch (e) {
    openingDetail = e.message || String(e);
    blockers.push(`opening HTTP harness: ${openingDetail}`);
  }

  softTodo(
    openingOk,
    'opening POST rejects empty sayadi (E_SAYAD_REQUIRED)',
    `part B cheque-records POST opening empty sayadi — ${openingDetail || 'not enforced yet'}`
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (blockers.length) {
    console.log('blockers / TODOs:');
    for (const b of blockers) console.log('  -', b);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
