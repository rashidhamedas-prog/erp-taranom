/**
 * پرداخت نقدی — قرارداد خالص + ناوردهای مسیر روی دیتابیس موقت.
 * اگر better-sqlite3 روی این Node لود نشود: SKIP_SQLITE و فقط قرارداد خالص، خروج ۰.
 * Run: node server/scripts/test-cash-payment-integ-v428.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  parseStrictRial,
  exclusivePaySource,
  installmentAmounts,
  assertTransferPair,
  assertOutboundPayment,
  withPaymentIdempotency,
} = require('../lib/cash-payment-contract');

let pass = 0;
let fail = 0;

function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  OK', label);
  } else {
    fail += 1;
    console.log('  FAIL', label, extra != null ? extra : '');
  }
}

function rejects(fn, code, label) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(!!err && err.code === code, label, err ? ((err.code || '') + ' ' + (err.message || '')) : 'no throw');
}

function runPureContract() {
  rejects(() => parseStrictRial(-1), 'E_AMOUNT', 'pure negative amount');
  rejects(() => parseStrictRial(1.5), 'E_AMOUNT', 'pure decimal 1.5');
  rejects(() => exclusivePaySource({ pay_type: 'cheque', bank_id: 2 }), 'E_CHEQUE_FORM_CLOSED', 'pure cheque');
  rejects(
    () => assertTransferPair({ from_type: 'cash', from_id: 1, to_type: 'cash', to_id: 1, amount: 5000 }),
    'E_TRANSFER_SAME',
    'pure same transfer sides'
  );
  rejects(() => installmentAmounts({ installments: [1000, 0] }), 'E_INSTALLMENT', 'pure zero installment');
}

function isAbi(err) {
  const text = String((err && (err.stack || err.message)) || err || '');
  return /NODE_MODULE_VERSION|was compiled against|ERR_DLOPEN|better-sqlite3|not a valid Win32|invalid ELF/i.test(text);
}

function finish(sqliteLoaded) {
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('sqlite loaded: ' + (sqliteLoaded ? 'yes' : 'no'));
  process.exit(fail ? 1 : 0);
}

runPureContract();

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.log('SKIP_SQLITE');
  console.log(String(err && err.message || err).split('\n')[0]);
  finish(false);
}

if (typeof Database !== 'function') {
  console.log('SKIP_SQLITE');
  finish(false);
}

const pureFails = fail;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-pay-integ-v428-'));
const dbFile = path.join(dir, 't.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = dbFile;
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cash-payment-integ-v428-secret-32!';
process.env.NODE_ENV = 'test';

const WATCH = [
  'journal_entries',
  'journal_lines',
  'expense_payments',
  'incentive_payments',
  'supplier_payments',
  'supplier_ledger',
  'account_transfers',
  'person_ledger',
  'rep_ledger',
  'audit_log',
  'cash_payment_idempotency',
];

(async () => {
  let server = null;
  let closeDB = () => {};
  let closeSessionStore = () => {};
  let sqliteLoaded = true;
  try {
    const tempRoot = path.resolve(dir) + path.sep;
    if (path.resolve(process.env.DB_PATH) !== path.resolve(dbFile) || !path.resolve(dbFile).startsWith(tempRoot)) {
      throw new Error('temp db path escaped isolation');
    }
    delete require.cache[require.resolve('../db')];
    const dbMod = require('../db');
    closeDB = dbMod.closeDB;
    dbMod.initDB();
    const db = dbMod.getDB();
    const live = path.resolve(dbMod.getDBPath());
    if (live !== path.resolve(dbFile)) {
      throw new Error('refusing to continue; opened ' + live);
    }
    ok(live === path.resolve(dbFile), 'temp sqlite file');

    function snapshot() {
      const out = {};
      for (const name of WATCH) {
        const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name);
        out[name] = exists ? db.prepare('SELECT COUNT(*) AS c FROM "' + name + '"').get().c : 0;
      }
      return out;
    }
    function unchanged(before, after, label) {
      const drift = WATCH.filter((name) => before[name] !== after[name])
        .map((name) => name + ' ' + before[name] + '->' + after[name]);
      ok(drift.length === 0, label + ' counts unchanged', drift.join(', '));
    }
    function expectThrow(label, fn, code) {
      const before = snapshot();
      let err = null;
      try { fn(); } catch (e) { err = e; }
      ok(!!err && err.code === code, label + ' -> ' + code, err ? ((err.code || '') + ' ' + (err.message || '')) : 'no throw');
      unchanged(before, snapshot(), label);
    }

    const { todayJalali } = require('../jalali');
    const today = todayJalali();
    const cashBoxId = db.prepare("INSERT INTO cash_boxes (name, active) VALUES ('صندوق v428', 1)").run().lastInsertRowid;

    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    ok(!!admin, 'admin seeded on temp db');
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const sessions = require('../lib/auth-sessions');
    closeSessionStore = sessions.closeSessionStore;
    const token = sessions.issueStaffSession(db, admin, {
      device_kind: 'test',
      device_name: 'cash-pay-v428',
      device_fingerprint: 'cash-pay-v428-fp',
    }).token;

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/expenses', require('../routes/expenses'));
    app.use('/api/transfers', require('../routes/transfers'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    function api(method, url, body) {
      const payload = body != null ? JSON.stringify(body) : null;
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            let data = {};
            try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { data = {}; }
            resolve({ status: res.statusCode, data });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    async function expectHttp(label, url, body, code) {
      const before = snapshot();
      const res = await api('POST', url, body);
      ok(res.status === 400 && res.data && res.data.code === code, label + ' -> ' + code, JSON.stringify(res));
      unchanged(before, snapshot(), label);
    }

    function payBody(extra) {
      return Object.assign({
        pay_type: 'cash',
        cash_box_id: cashBoxId,
        amount: 20000,
        title: 'v428',
        category: 'admin',
        date: today,
      }, extra || {});
    }

    const amountCases = [
      ['negative amount', { amount: -1 }, 'E_AMOUNT'],
      ['decimal amount', { amount: 1.5 }, 'E_AMOUNT'],
      ['text amount', { amount: 'abc' }, 'E_AMOUNT'],
    ];
    for (const [label, extra, code] of amountCases) {
      const body = payBody(extra);
      expectThrow('contract ' + label, () => assertOutboundPayment(db, body), code);
      await expectHttp('route ' + label, '/api/expenses', body, code);
    }

    const mixed = payBody({ pay_type: 'cash', cash_box_id: cashBoxId, bank_id: 9, amount: 20000 });
    expectThrow('contract cash with bank_id', () => assertOutboundPayment(db, mixed), 'E_PAY_SOURCE');
    await expectHttp('route cash with bank_id', '/api/expenses', mixed, 'E_PAY_SOURCE');

    await expectHttp(
      'route cheque',
      '/api/expenses',
      payBody({ pay_type: 'cheque', bank_id: 1, amount: 20000 }),
      'E_CHEQUE_FORM_CLOSED'
    );
    await expectHttp(
      'route zero installment',
      '/api/expenses',
      payBody({ installments: [1000, 0] }),
      'E_INSTALLMENT'
    );

    const transferCases = [
      ['missing side', { from_type: 'bank', to_type: 'cash', to_id: cashBoxId, amount: 5000, date: today }, 'E_TRANSFER_SIDE'],
      ['same side', {
        from_type: 'cash', from_id: cashBoxId, to_type: 'cash', to_id: cashBoxId, amount: 5000, date: today,
      }, 'E_TRANSFER_SAME'],
      ['fee when source is cash', {
        from_type: 'cash', from_id: cashBoxId, to_type: 'bank', to_id: 2, amount: 5000, fee_rial: 100, date: today,
      }, 'E_FEE'],
    ];
    for (const [label, body, code] of transferCases) {
      expectThrow('assertTransferPair ' + label, () => assertTransferPair(body), code);
      await expectHttp('route transfer ' + label, '/api/transfers', body, code);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS cash_pay_probe_v428 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT NOT NULL
      )
    `);
    const key = 'v428.replay.cash-1';
    const beforeWork = snapshot();
    const first = withPaymentIdempotency(db, {
      key, path: '/api/expenses', userId: admin.id,
    }, () => {
      const id = db.prepare('INSERT INTO cash_pay_probe_v428 (note) VALUES (?)').run('once').lastInsertRowid;
      return { id, ok: true, marker: 'stored-v428' };
    });
    ok(first && first.ok === true && first.replayed !== true && first.marker === 'stored-v428', 'idempotency stores first result', first);
    ok(db.prepare('SELECT COUNT(*) AS c FROM cash_pay_probe_v428').get().c === 1, 'idempotency inserted one probe row');
    const afterFirst = snapshot();
    ok(afterFirst.cash_payment_idempotency === beforeWork.cash_payment_idempotency + 1, 'idempotency inserted one key');
    const business = WATCH.filter((name) => name !== 'cash_payment_idempotency');
    const businessDrift = business.filter((name) => beforeWork[name] !== afterFirst[name]);
    ok(businessDrift.length === 0, 'idempotency work left payment tables unchanged', businessDrift.join(', '));

    const beforeReplay = snapshot();
    const probeBeforeReplay = db.prepare('SELECT COUNT(*) AS c FROM cash_pay_probe_v428').get().c;
    const second = withPaymentIdempotency(db, {
      key, path: '/api/expenses', userId: admin.id,
    }, () => {
      db.prepare('INSERT INTO cash_pay_probe_v428 (note) VALUES (?)').run('twice');
      return { id: -1, ok: false, marker: 'should-not-run' };
    });
    ok(second && second.replayed === true, 'idempotency replay flag', second);
    ok(
      second && second.id === first.id && second.marker === 'stored-v428' && second.ok === true,
      'idempotency replay returns stored result',
      second
    );
    ok(
      db.prepare('SELECT COUNT(*) AS c FROM cash_pay_probe_v428').get().c === probeBeforeReplay,
      'idempotency replay does not insert a second row'
    );
    unchanged(beforeReplay, snapshot(), 'idempotency replay');
  } catch (err) {
    if (isAbi(err)) {
      console.log('SKIP_SQLITE');
      console.log(String(err && err.message || err).split('\n')[0]);
      sqliteLoaded = false;
      fail = pureFails;
    } else {
      fail += 1;
      console.error('  FAIL harness', err && err.stack ? err.stack : err);
    }
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try { closeSessionStore(); } catch (_) { /* temp session store */ }
    try { closeDB(); } catch (_) { /* temp db */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  }
  finish(sqliteLoaded);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  process.exit(1);
});
