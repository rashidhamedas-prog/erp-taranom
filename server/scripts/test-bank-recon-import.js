/**
 * W2-F5 bank recon: import statement lines + 1:1 auto-match MVP
 * Run: node server/scripts/test-bank-recon-import.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-recon-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-recon-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra || ''); }
}

(async () => {
  console.log('\n— schema —');
  ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bank_statement_lines'").get(),
    'bank_statement_lines table');
  const cols = db.prepare('PRAGMA table_info(bank_statement_lines)').all().map(c => c.name);
  ok(cols.includes('amount_rial') && cols.includes('match_confidence'), 'statement line money+confidence cols');
  ok(db.prepare('PRAGMA table_info(bank_reconciliation_items)').all().some(c => c.name === 'match_confidence'),
    'items.match_confidence');

  const { SYNCABLE_TABLES } = require('../sync/tables');
  ok(SYNCABLE_TABLES.some(t => t.name === 'bank_statement_lines'), 'sync registry append');
  ok(SYNCABLE_TABLES[SYNCABLE_TABLES.length - 1].name === 'bank_statement_lines',
    'bank_statement_lines is last sync table');

  const {
    parseBankStatementCsv,
    normalizeAmountRial,
    dateWithinOneDay,
  } = require('../routes/bank-reconciliation');

  console.log('\n— helpers —');
  ok(normalizeAmountRial('1,250,000') === 1250000, 'normalizeAmountRial commas');
  ok(dateWithinOneDay('1405/01/10', '1405/01/11') === true, 'date ±1 day');
  ok(dateWithinOneDay('1405/01/10', '1405/01/13') === false, 'date beyond ±1');
  const csvRows = parseBankStatementCsv('date,amount_rial,description,ref\n1405/01/10,1000,a,r1\n1405/01/11,2000,b,r2');
  ok(csvRows.length === 2 && Number(csvRows[0].amount_rial) === 1000, 'CSV helper parses 2 rows');

  console.log('\n— HTTP import + auto-match —');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'bank-recon-e2e',
    device_fingerprint: 'bank-recon-e2e-fp',
  }).token;

  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active) VALUES ('بانک تست تطبیق','1010','مرکزی',1)
  `).run().lastInsertRowid;

  const custId = db.prepare(`
    INSERT INTO customers (user_id,biz,status) VALUES (1,'مشتری تطبیق','active')
  `).run().lastInsertRowid;

  // Exact match candidate (same amount + same date as line 1)
  db.prepare(`
    INSERT INTO settlements (user_id, cust_id, amount, amount_rial, pay_type, date, note, bank_id)
    VALUES (1, ?, 0, 5000000, 'card', '1405/02/15', 'واریز تست', ?)
  `).run(custId, bankId);

  // Non-matching settlement (different amount)
  db.prepare(`
    INSERT INTO settlements (user_id, cust_id, amount, amount_rial, pay_type, date, note, bank_id)
    VALUES (1, ?, 0, 999, 'card', '1405/02/15', 'نامرتبط', ?)
  `).run(custId, bankId);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/bank-reconciliation', require('../routes/bank-reconciliation'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}/api/bank-reconciliation`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
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

  const created = await api('POST', '/', {
    bank_id: bankId,
    statement_date: '1405/02/15',
    statement_balance_rial: 10000000,
    notes: 'W2-F5 test',
  });
  ok(created.status === 200 && created.data?.id, 'create recon', created.data?.error);
  const reconId = created.data.id;

  const imported = await api('POST', `/${reconId}/import-lines`, {
    lines: [
      { date: '1405/02/15', amount_rial: 5000000, description: 'واریز مشتری', ref: 'TRX-1' },
      { date: '1405/02/16', amount_rial: 750000, description: 'کارمزد', ref: 'FEE-1' },
    ],
  });
  ok(imported.status === 200 && imported.data?.imported === 2, 'import 2 lines', imported.data?.error);
  ok(imported.data?.unmatched === 2, 'imported lines start unmatched');
  ok(Array.isArray(imported.data?.lines) && imported.data.lines.every(l => Number.isInteger(l.amount_rial)),
    'amounts stored as INTEGER rial');

  const lineCount = db.prepare(
    'SELECT COUNT(*) AS c FROM bank_statement_lines WHERE reconciliation_id=?'
  ).get(reconId).c;
  ok(lineCount === 2, 'DB has 2 statement lines');

  const matched = await api('POST', `/${reconId}/auto-match-1to1`, {});
  ok(matched.status === 200, 'auto-match endpoint ok', matched.data?.error);
  ok(matched.data?.matched === 1, 'exactly one 1:1 match', JSON.stringify(matched.data));
  ok(matched.data?.unmatched === 1, 'one line remains unmatched', JSON.stringify(matched.data));
  ok(matched.data?.matches?.[0]?.confidence === 100, 'exact match confidence=100');

  const detail = await api('GET', `/${reconId}`);
  ok(detail.status === 200 && detail.data?.statement_lines?.length === 2, 'GET includes statement_lines');
  const matchedLine = detail.data.statement_lines.find(l => l.matched);
  const unmatchedLine = detail.data.statement_lines.find(l => !l.matched);
  ok(matchedLine && matchedLine.amount_rial === 5000000 && matchedLine.match_confidence === 100,
    'matched line is the 5_000_000 settlement');
  ok(unmatchedLine && unmatchedLine.amount_rial === 750000 && unmatchedLine.match_confidence === 0,
    'fee line stays unmatched');

  // R13: void unmatched line — soft status, no physical delete
  const voided = await api('POST', `/${reconId}/void-lines`, { line_ids: [unmatchedLine.id] });
  ok(voided.status === 200 && voided.data?.voided === 1, 'void unmatched line');
  const stillThere = db.prepare('SELECT status, deleted_at FROM bank_statement_lines WHERE id=?')
    .get(unmatchedLine.id);
  ok(stillThere.status === 'void' && stillThere.deleted_at > 0, 'void is soft (row remains)');
  const physical = db.prepare('SELECT COUNT(*) AS c FROM bank_statement_lines WHERE reconciliation_id=?')
    .get(reconId).c;
  ok(physical === 2, 'no physical DELETE after void');

  await new Promise(resolve => server.close(resolve));
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
