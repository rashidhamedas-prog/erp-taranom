'use strict';
/**
 * Party opening balance upsert (SW v405).
 * JE date = active FY start; amount change rewrites same JE (no reverse+new).
 * Run: node server/scripts/test-party-opening-edit-v405.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-open-v405-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-open-v405-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_receivable', '1103');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_payable', '2101');

const { getActiveFiscalYear } = require('../lib/fiscal-period');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

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

function jeDebitRial(jeId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d
    FROM journal_lines jl WHERE jl.entry_id=?
  `).get(jeId);
  return Math.round(Number(row && row.d) || 0);
}

function liveOpeningJe(partyId) {
  return db.prepare(`
    SELECT id, entry_date, voucher_number, status, deleted_at, total_debit_rial
    FROM journal_entries
    WHERE ref_type='opening_balance' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC LIMIT 1
  `).get(partyId);
}

function openingSideCredit(jeId) {
  const open = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c,
           COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d
    FROM journal_lines jl WHERE jl.entry_id=? AND jl.account_code='3102'
  `).get(jeId);
  return { c: Math.round(Number(open && open.c) || 0), d: Math.round(Number(open && open.d) || 0) };
}

(async () => {
  const fy = getActiveFiscalYear(db);
  ok(fy && fy.start_date, 'active fiscal year has start_date', fy);
  const fyStart = fy.start_date;

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user exists');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'party-open-v405', device_fingerprint: 'party-open-v405-fp',
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

  // 1) Create party with debit opening
  let r = await api('POST', '/api/parties', {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    party_roles: ['customer'],
    opening_balance_rial: 14_520_000,
  });
  ok(r.status === 201 && r.data && r.data.data && r.data.data.id, 'POST party with opening', r);
  const partyId = r.data.data.id;
  let party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  ok(Number(party.opening_balance) === 14_520_000, 'master opening = 14.52M');
  ok(String(party.opening_balance_date) === fyStart, 'party opening_balance_date = FY start');
  let je = liveOpeningJe(partyId);
  ok(!!je, 'opening JE live');
  const je1 = je.id;
  const voucher1 = je.voucher_number;
  ok(je.entry_date === fyStart, 'opening JE date = FY start (create)');
  ok(jeDebitRial(je1) === 14_520_000, 'JE debit = 14.52M rial');
  ok(openingSideCredit(je1).c === 14_520_000, 'debit opening → 3102 credit');

  // 2) PUT same amount — same JE id
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: 14_520_000,
  });
  ok(r.status === 200, 'PUT same amount', r);
  je = liveOpeningJe(partyId);
  ok(je && je.id === je1, 'JE id unchanged on same amt');

  // 3) PUT higher amount — rewrite same JE
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: 20_000_000,
  });
  ok(r.status === 200, 'PUT higher opening', r);
  party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  je = liveOpeningJe(partyId);
  ok(je && je.id === je1, 'rewrite keeps same JE id');
  ok(je.voucher_number === voucher1, 'voucher_number unchanged');
  ok(Number(party.opening_balance) === 20_000_000, 'master = 20M');
  ok(jeDebitRial(je1) === 20_000_000, 'JE debit rewritten to 20M');
  ok(je.entry_date === fyStart, 'date still FY start after rewrite');

  // Count live opening JEs — must stay 1 (no reverse+new clutter)
  const liveCount = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE ref_type='opening_balance' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(partyId).c;
  ok(liveCount === 1, 'exactly one live opening JE after rewrite', liveCount);

  // 4) Corrupt date mid-year then PUT same amount — snap back to FY start
  db.prepare('UPDATE journal_entries SET entry_date=? WHERE id=?').run('1405/07/04', je1);
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: 20_000_000,
  });
  ok(r.status === 200, 'PUT after mid-year date corruption (same amt)', r);
  je = liveOpeningJe(partyId);
  ok(je && je.id === je1 && je.entry_date === fyStart, 'date repaired to FY start on same-amt save');
  ok(jeDebitRial(je1) === 20_000_000, 'amount unchanged after date repair');

  // 5) Flip to credit (negative) — rewrite same JE, side flips
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: -8_000_000,
  });
  ok(r.status === 200, 'PUT credit opening', r);
  je = liveOpeningJe(partyId);
  ok(je && je.id === je1, 'sign flip keeps same JE id');
  ok(jeDebitRial(je1) === 8_000_000, 'JE abs debit = 8M');
  ok(openingSideCredit(je1).d === 8_000_000, 'credit opening → 3102 debit');
  party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  ok(Number(party.opening_balance) === -8_000_000, 'master = -8M');

  // 6) PUT amt=0 — void
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: 0,
  });
  ok(r.status === 200, 'PUT opening to 0', r);
  party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  ok(Number(party.opening_balance) === 0, 'master cleared');
  ok(!liveOpeningJe(partyId), 'no live opening JE');
  const voided = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(je1);
  ok(voided.status === 'reversed' || Number(voided.deleted_at) > 0, 'old JE soft-voided', voided);

  // 7) PUT amt>0 after void — new JE at FY start
  r = await api('PUT', `/api/parties/${partyId}`, {
    full_name: 'شخص تست v405',
    phone: '09120004051',
    opening_balance_rial: 5_000_000,
  });
  ok(r.status === 200, 'PUT reopen opening', r);
  je = liveOpeningJe(partyId);
  ok(je && je.id !== je1, 'new JE after void');
  ok(je.entry_date === fyStart, 'reopen date = FY start');
  ok(jeDebitRial(je.id) === 5_000_000, 'reopen JE debit = 5M');

  // 8) Help + cache stamp
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  ok(/مانده اول دوره اشخاص/.test(appJs) && /شروع سال مالی/.test(appJs), 'admin help mentions party opening FY date');
  ok(/erp-taranom-v424/.test(sw), 'SW cache v424');
  ok(/app\.js\?v=424/.test(idx), 'index app.js?v=424');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — party opening edit v405`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
