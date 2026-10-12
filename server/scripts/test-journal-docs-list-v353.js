/**
 * Journal docs list: no hard 50 ceiling; search by document number (id / voucher_number).
 * Run: node server/scripts/test-journal-docs-list-v353.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-docs-v353-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-journal-docs-list-v353-secret-32ch!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user seeded');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'journal-docs-v353',
    device_fingerprint: 'journal-docs-v353-fp',
  }).token;

  const coa = db.prepare('SELECT code, name FROM chart_of_accounts WHERE is_active=1 LIMIT 2').all();
  ok(coa.length >= 2, 'coa has 2+ accounts', coa.length);

  const ids = [];
  for (let i = 0; i < 55; i++) {
    const r = db.prepare(`
      INSERT INTO journal_entries (entry_date, description, ref_type, created_by, status, voucher_number)
      VALUES (?, ?, 'manual_voucher', ?, 'posted', ?)
    `).run('1405/01/01', 'تست سند v353 #' + i, admin.id, i === 42 ? 'VN-4242' : null);
    const eid = r.lastInsertRowid;
    ids.push(eid);
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?, ?, ?, 1000, 0, 10000, 0)
    `).run(eid, coa[0].code, coa[0].name || coa[0].code);
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?, ?, ?, 0, 1000, 0, 10000)
    `).run(eid, coa[1].code, coa[1].name || coa[1].code);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = 'http://127.0.0.1:' + port;

  async function api(method, p) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token },
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  console.log('\n— journal list pagination + q —');
  const page1 = await api('GET', '/api/accounting/journal?limit=50&page=1');
  ok(page1.status === 200, 'GET /journal 200', page1.status);
  ok(Array.isArray(page1.data && page1.data.entries), 'entries array');
  ok(page1.data.limit === 50, 'limit echoed 50', page1.data && page1.data.limit);
  ok(page1.data.total >= 55, 'total >= 55 seeded', page1.data && page1.data.total);
  ok(page1.data.entries.length === 50, 'page1 has 50 when limit=50', page1.data.entries.length);

  const page2 = await api('GET', '/api/accounting/journal?limit=50&page=2');
  ok(page2.data.entries.length >= 5, 'page2 has remaining docs', page2.data.entries.length);

  const big = await api('GET', '/api/accounting/journal?limit=200&page=1');
  ok(big.data.entries.length >= 55, 'limit=200 returns all seeded on one page', big.data.entries.length);

  const targetId = ids[10];
  const byId = await api('GET', '/api/accounting/journal?q=' + targetId);
  ok(byId.data.total >= 1, 'search by id finds docs', byId.data.total);
  ok(byId.data.entries.some((e) => e.id === targetId), 'search includes exact id', targetId);

  const byHash = await api('GET', '/api/accounting/journal?q=' + encodeURIComponent('#' + targetId));
  ok(byHash.data.entries.some((e) => e.id === targetId), 'search #id works');

  const byVn = await api('GET', '/api/accounting/journal?q=VN-4242');
  ok(byVn.data.entries.some((e) => e.voucher_number === 'VN-4242'), 'search voucher_number');

  const fa = await api('GET', '/api/accounting/journal?q=' + encodeURIComponent(String(targetId).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])));
  ok(fa.status === 200 && fa.data.entries.some((e) => e.id === targetId), 'persian digits search finds id');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
