'use strict';
/**
 * Party opening rewrite must not leave the previous customer_ledger copy.
 * Production shape: customer 67 / party 15 / JE 11 live 1,332,830,000
 * plus customer_ledger #71 opening_balance 2,048,610,000 with no journal line.
 * Run: node server/scripts/test-opening-mirror-stale-v424.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mirror-v424-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-open-mirror-v424-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const OLD_AMT = 2048610000;
const NEW_AMT = 1332830000;
let pass = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    console.error(' FAIL', label, extra != null ? JSON.stringify(extra) : '');
    try { closeDB(); } catch (_) { /* */ }
    process.exit(1);
  }
}

function openingRows(customerId) {
  return db.prepare(`
    SELECT id, ref_type, ref_id, debit, credit
    FROM customer_ledger
    WHERE customer_id=?
      AND LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
    ORDER BY id
  `).all(customerId);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user exists');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'open-mirror-v424', device_fingerprint: 'open-mirror-v424-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/parties', require('../routes/parties'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  let r = await api('POST', '/api/parties', {
    full_name: 'معزز تست v424',
    phone: '09120004241',
    party_roles: ['customer'],
    opening_balance_rial: OLD_AMT,
  });
  ok(r.status === 201 && r.data && r.data.data && r.data.data.id, 'POST party with old opening', r);
  const partyId = r.data.data.id;
  const cust = db.prepare('SELECT id, coa_code, party_id FROM customers WHERE party_id=?').get(partyId);
  ok(!!cust && cust.coa_code, 'customer tafsili exists', cust);
  const jeBefore = db.prepare(`
    SELECT id, total_debit_rial FROM journal_entries
    WHERE ref_type='opening_balance' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(partyId);
  ok(!!jeBefore && Number(jeBefore.total_debit_rial) === OLD_AMT, 'live JE is the old amount', jeBefore);

  db.prepare(`
    INSERT INTO customer_ledger
      (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    cust.id, '1405/06/31', 'opening', 'opening_balance', partyId,
    'مانده اول دوره — معزز تست v424', OLD_AMT, 0, admin.id
  );

  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'معزز تست v424',
    phone: '09120004241',
    opening_balance_rial: NEW_AMT,
  });
  ok(r.status === 200, 'PUT rewrites opening amount', r);
  const rows = openingRows(cust.id);
  ok(rows.length === 1, 'one customer opening row after rewrite', rows);
  ok(Number(rows[0].debit) === NEW_AMT && Number(rows[0].credit) === 0, 'mirror amount is the new opening', rows[0]);
  ok(String(rows[0].ref_type) === 'opening', 'replacement row is the party mirror');
  const jeAfter = db.prepare(`
    SELECT id, total_debit_rial, status, deleted_at FROM journal_entries WHERE id=?
  `).get(jeBefore.id);
  ok(jeAfter && jeAfter.id === jeBefore.id, 'opening JE id unchanged');
  ok(Number(jeAfter.total_debit_rial) === NEW_AMT, 'live JE amount rewritten, not a second voucher', jeAfter);
  ok(String(jeAfter.status) !== 'reversed' && !(Number(jeAfter.deleted_at) > 0), 'live JE still posted');

  db.prepare(`
    INSERT INTO customer_ledger
      (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    cust.id, '1405/06/31', 'opening', 'opening_balance', partyId,
    'مانده اول دوره — معزز تست v424', OLD_AMT, 0, admin.id
  );
  const { repairStaleCustomerOpeningMirrors } = require('../lib/opening-post');
  const first = repairStaleCustomerOpeningMirrors(db);
  ok(Number(first.removed) >= 1, 'heal removes the stale opening_balance copy', first);
  const afterHeal = openingRows(cust.id);
  ok(afterHeal.length === 1 && Number(afterHeal[0].debit) === NEW_AMT, 'books match live opening after heal', afterHeal);
  const jeStill = db.prepare('SELECT id, total_debit_rial, status FROM journal_entries WHERE id=?').get(jeBefore.id);
  ok(jeStill.id === jeBefore.id && Number(jeStill.total_debit_rial) === NEW_AMT, 'heal does not touch the live JE', jeStill);
  const second = repairStaleCustomerOpeningMirrors(db);
  ok(Number(second.removed) === 0, 'second heal is a no-op', second);

  db.prepare("DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").run(cust.id);
  db.prepare(`
    INSERT INTO customer_ledger
      (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(cust.id, '1405/06/31', 'opening', 'opening_balance', partyId, 'مانده اول دوره', NEW_AMT, 0, admin.id);
  const kept = repairStaleCustomerOpeningMirrors(db);
  const keptRows = openingRows(cust.id);
  ok(Number(kept.removed) === 0 && keptRows.length === 1 && Number(keptRows[0].debit) === NEW_AMT,
    'matching opening_balance copy is kept', { kept, keptRows });

  const { canonicalCustomerFold, glCustomersTafsiliBalance } = require('../lib/customer-books');
  const fold = canonicalCustomerFold(db);
  const gl = glCustomersTafsiliBalance(db);
  ok(Math.abs(Number(fold.display) - Number(gl.display)) <= 1, 'dashboard AR delta <= 1', { fold, gl });
  ok(Math.abs(Number(fold.creditor) - Number(gl.creditor)) <= 1, 'dashboard creditor delta <= 1', { fold, gl });
  const jeFinal = db.prepare('SELECT total_debit_rial FROM journal_entries WHERE id=?').get(jeBefore.id);
  ok(Number(jeFinal.total_debit_rial) === NEW_AMT, 'overview repair leaves the live opening JE');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — opening mirror stale v424`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
