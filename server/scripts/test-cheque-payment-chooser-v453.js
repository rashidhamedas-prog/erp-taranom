/**
 * v453 — «پرداخت چک» in payment chooser + party-aware cheque_pay books.
 * Static contract always; SQLite integration when better-sqlite3 loads.
 * Run: node server/scripts/test-cheque-payment-chooser-v453.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    fail++;
    console.log('  FAIL', label, extra == null ? '' : extra);
  }
}

function skipSqlite(reason) {
  console.log('SKIP_SQLITE');
  console.log(reason);
  console.log(`STATIC ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
const voidSrc = fs.readFileSync(path.join(__dirname, '../lib/void-cheque.js'), 'utf8');
const books = fs.readFileSync(path.join(__dirname, '../lib/cheque-party-books.js'), 'utf8');
const contract = fs.readFileSync(path.join(__dirname, '../lib/cash-payment-contract.js'), 'utf8');

console.log('══ v453 cheque payment chooser ══');

ok(appSrc.includes('پرداخت چک'), 'chooser / UI mentions پرداخت چک');
ok(appSrc.includes('function chequePaymentModal'), 'chequePaymentModal defined');
ok(appSrc.includes('function saveChequePayment'), 'saveChequePayment defined');
const chooserSlice = appSrc.slice(appSrc.indexOf('function paymentOpChooser'), appSrc.indexOf('function chequePaymentModal'));
ok(chooserSlice.includes('chequePaymentModal'), 'chooser wires to chequePaymentModal');
ok(appSrc.includes("direction:'out'") && appSrc.includes("/cheque-records/'+id+'/pay"), 'save registers out then pay');
ok(appSrc.includes("/cheque-records/'+id+'/expense"), 'expense path available from modal');
ok(sw.includes('erp-taranom-v453'), 'SW cache v453');

ok(contract.includes("'E_CHEQUE_FORM_CLOSED'"), 'five cash forms still reject cheque');
ok(routes.includes("sourceType === 'cheque_pay'") && routes.includes('resolveEndorseDebit'),
  'pay resolves debit from party when no account_key');
ok(routes.includes("refType: 'cheque_pay'"), 'pay mirrors books with cheque_pay ref');
ok(routes.includes('postPersonChequePayLedger'), 'person ledger mirror for pay');
ok(routes.includes("creditAcct: acct(db, 'coa_cheques_payable')"), 'credit stays notes payable');
ok(voidSrc.includes("'cheque_pay'"), 'void retires cheque_pay ledgers');
ok(books.includes('retireSupplierLedgerByRef'), 'void path retires supplier books');

if (fail) {
  console.log(`STATIC ${pass} passed, ${fail} failed`);
  process.exit(1);
}

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  skipSqlite(String(e && e.message || e).split('\n')[0]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-pay-v453-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-payment-v453-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

(async () => {
  let server;
  let closeSessionStore = () => {};
  try {
    delete require.cache[require.resolve('../db')];
    const { initDB, getDB } = require('../db');
    initDB();
    const db = getDB();
    const { acct } = require('../lib/coa-map');
    const notesPay = acct(db, 'coa_cheques_payable');
    const payable = acct(db, 'coa_payable');
    const AMT = 5_000_000;

    function openLines(refType, refId) {
      return db.prepare(`
        SELECT jl.account_code,
               COALESCE(jl.debit_rial,0) AS debit_rial,
               COALESCE(jl.credit_rial,0) AS credit_rial,
               COALESCE(jl.debit,0) AS debit,
               COALESCE(jl.credit,0) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id=jl.entry_id
        WHERE je.ref_type=? AND je.ref_id=?
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted')<>'reversed'
      `).all(refType, refId);
    }
    function creditRial(line) {
      if (Number(line.credit_rial) > 0) return Number(line.credit_rial);
      return Math.round(Number(line.credit) || 0) * 10;
    }
    function debitRial(line) {
      if (Number(line.debit_rial) > 0) return Number(line.debit_rial);
      return Math.round(Number(line.debit) || 0) * 10;
    }

    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    ok(!!admin, 'temp db has admin');
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const sessions = require('../lib/auth-sessions');
    closeSessionStore = sessions.closeSessionStore;
    const token = sessions.issueStaffSession(db, admin, {
      device_kind: 'test',
      device_name: 'cheque-payment-v453',
      device_fingerprint: 'cheque-payment-v453-fp',
    }).token;

    const app = express();
    app.use(express.json());
    app.use('/api/cheque-records', require('../routes/cheque-records'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    async function api(method, p, body) {
      const res = await fetch(`http://127.0.0.1:${port}` + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { status: res.status, data };
    }

    const partyId = db.prepare(`
      INSERT INTO parties (person_code, party_type, full_name, phone, is_active)
      VALUES ('P-V453','supplier','تأمین چک v453','09150000453',1)
    `).run().lastInsertRowid;

    let supplierId = null;
    try {
      supplierId = db.prepare(`
        INSERT INTO suppliers (name, party_id, coa_code, active)
        VALUES ('تأمین چک v453', ?, ?, 1)
      `).run(partyId, payable.code).lastInsertRowid;
      db.prepare(`UPDATE parties SET legacy_table='suppliers', legacy_id=? WHERE id=?`)
        .run(supplierId, partyId);
    } catch (e) {
      console.log('  note supplier seed', e.message);
    }

    console.log('\n— temp db: register + pay + supplier books + void —');
    let r = await api('POST', '/api/cheque-records', {
      direction: 'out',
      cheque_number: 'OUT-453',
      amount: AMT,
      party_id: partyId,
      due_date: '1405/08/01',
      note: 'پرداخت چک',
    });
    ok(r.status === 200 && r.data && r.data.id, 'register out cheque', r.data && r.data.error);
    const id = r.data && r.data.id;
    ok(openLines('cheque_pay', id).length === 0, 'register posts no pay journal');

    r = await api('POST', `/api/cheque-records/${id}/pay`, { date: '1405/07/26' });
    ok(r.status === 200 && r.data && r.data.lifecycle_status === 'issued', 'pay issues the cheque', r.data && r.data.error);
    const payLines = openLines('cheque_pay', id);
    const payDr = payLines.find((l) => l.account_code === payable.code);
    const payCr = payLines.find((l) => l.account_code === notesPay.code);
    ok(payDr && debitRial(payDr) === AMT, 'pay debits payable / party COA', JSON.stringify(payDr));
    ok(payCr && creditRial(payCr) === AMT, 'pay credits notes payable', JSON.stringify(payCr));

    if (supplierId) {
      const sl = db.prepare(`
        SELECT debit, credit FROM supplier_ledger
        WHERE ref_type='cheque_pay' AND ref_id=? AND supplier_id=?
      `).get(id, supplierId);
      ok(sl && Number(sl.debit) === AMT, 'supplier_ledger debit mirror', sl);
    } else {
      ok(true, 'supplier seed skipped');
    }

    r = await api('POST', `/api/cheque-records/${id}/void`);
    ok(r.status === 200 && r.data && r.data.ok, 'void issued cheque', r.data && r.data.error);
    ok(openLines('cheque_pay', id).length === 0, 'void reverses the pay journal');
    if (supplierId) {
      const sl2 = db.prepare(`
        SELECT COUNT(*) AS n FROM supplier_ledger WHERE ref_type='cheque_pay' AND ref_id=?
      `).get(id);
      ok(sl2.n === 0, 'void retires supplier cheque_pay rows', sl2);
    }

    console.log('SQLITE party-aware pay + void OK');
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/ABI|NODE_MODULE_VERSION|better_sqlite3|ERR_DLOPEN|was compiled against a different Node/i.test(msg)) {
      skipSqlite(msg.split('\n')[0]);
    }
    fail++;
    console.log('  FAIL temp db', msg);
    console.error(e);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { closeSessionStore(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log();
  if (fail) {
    console.log(`CHEQUE-PAYMENT-V453: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`CHEQUE-PAYMENT-V453: ${pass} passed`);
  process.exit(0);
})().catch((err) => {
  const msg = String(err && err.message || err);
  if (/ABI|NODE_MODULE_VERSION|better_sqlite3|ERR_DLOPEN|was compiled against a different Node/i.test(msg)) {
    skipSqlite(msg.split('\n')[0]);
  }
  console.error(err);
  process.exit(1);
});
