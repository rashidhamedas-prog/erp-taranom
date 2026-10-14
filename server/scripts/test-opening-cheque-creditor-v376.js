/**
 * Opening-cheque phantom credit must not inflate dashboard creditor KPI (SW v376).
 * Reproduces: credit cheque_in + hollow «اصلاح:» debit purged → fold +800M vs GL.
 * Run: node server/scripts/test-opening-cheque-creditor-v376.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-chq-v376-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-opening-cheque-v376-secret-32chars';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const {
  repairOpeningChequeLedgerMirrors,
  canonicalCustomerFold,
  hideVoidedBookRows,
  sqlCustomerLedgerLive,
} = require('../lib/customer-books');
const { purgeHollowPartyLedgerReversals } = require('../lib/party-ledger-retire');

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status)
  VALUES (1, 'بیوتی بوتیک تست v376', '09120000000', 'active')
`).run().lastInsertRowid;

const chequeId = db.prepare(`
  INSERT INTO cheque_records (
    direction, cheque_number, amount, note, status, customer_id, party_name, record_status
  ) VALUES ('in', '315110', 800000000, 'مانده اول دوره', 'مانده اول دوره', ?, 'تست', 'posted')
`).run(custId).lastInsertRowid;

createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/01/01',
  entry_type: 'cheque',
  ref_type: 'cheque_in',
  ref_id: chequeId,
  description: 'چک اول دوره 315110',
  debit: 0,
  credit: 800000000,
  user_id: 1,
});
createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/01/02',
  entry_type: 'reversal',
  ref_type: 'cheque_in',
  ref_id: chequeId,
  description: 'اصلاح: چک اول دوره دریافت از مشتری نیست',
  debit: 800000000,
  credit: 0,
  user_id: 1,
});

const beforeNet = db.prepare(
  'SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) b FROM customer_ledger WHERE customer_id=?'
).get(custId);
ok(Number(beforeNet.b) === 0, 'credit+اصلاح debit net zero before purge', beforeNet);

db.prepare("DELETE FROM settings WHERE key LIKE 'purge_hollow_party_ledger%'").run();
db.prepare("DELETE FROM settings WHERE key LIKE 'opening_cheque_ledger_mirror%'").run();

// Simulate v374: purge hollow «اصلاح:» only (old behavior left credit). Then continuous heal.
db.prepare(`
  DELETE FROM customer_ledger
  WHERE entry_type='reversal' AND description LIKE 'اصلاح:%'
`).run();
const mid = db.prepare(
  'SELECT COALESCE(SUM(credit),0) c FROM customer_ledger WHERE customer_id=?'
).get(custId);
ok(Number(mid.c) === 800000000, 'orphan opening credit after hollow debit purge', mid);

const foldOrphan = (() => {
  // Raw fold without filter would show creditor — ensure filter hides it even before heal
  const rows = db.prepare(`
    SELECT c.id AS customer_id,
      COALESCE(SUM(cl.debit),0) AS debit,
      COALESCE(SUM(cl.credit),0) AS credit
    FROM customers c
    LEFT JOIN customer_ledger cl ON cl.customer_id=c.id AND (${sqlCustomerLedgerLive('cl')})
    WHERE c.id=?
    GROUP BY c.id
  `).all(custId);
  const r = rows[0] || { debit: 0, credit: 0 };
  const signed = Number(r.debit) - Number(r.credit);
  return signed < 0 ? -signed : 0;
})();
ok(foldOrphan === 0, 'sqlCustomerLedgerLive excludes opening cheque credit', foldOrphan);

const hidden = hideVoidedBookRows(db, db.prepare(
  'SELECT * FROM customer_ledger WHERE customer_id=?'
).all(custId));
ok(hidden.every((r) => !(r.ref_type === 'cheque_in' && Number(r.credit) > 0)),
  'hideVoidedBookRows drops opening cheque_in credit');

const healed = repairOpeningChequeLedgerMirrors(db);
ok(healed.reversed >= 1, 'continuous heal retires opening cheque books', healed);
ok(healed.continuous === true, 'heal marked continuous');

const after = db.prepare(
  'SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=? AND ref_type=?'
).get(custId, 'cheque_in');
ok(Number(after.n) === 0, 'no opening cheque_in rows left in books', after);

// Re-insert orphan + purgeHollow must also clear credit (v376 purge path)
createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/01/01',
  entry_type: 'cheque',
  ref_type: 'cheque_in',
  ref_id: chequeId,
  description: 'چک اول دوره 315110',
  debit: 0,
  credit: 800000000,
  user_id: 1,
});
createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/01/02',
  entry_type: 'reversal',
  ref_type: 'cheque_in',
  ref_id: chequeId,
  description: 'اصلاح: چک اول دوره دریافت از مشتری نیست',
  debit: 800000000,
  credit: 0,
  user_id: 1,
});
db.prepare("DELETE FROM settings WHERE key LIKE 'purge_hollow_party_ledger%'").run();
const purged = purgeHollowPartyLedgerReversals(db);
ok((purged.customerDeleted || 0) >= 1, 'purgeHollow clears اصلاح + opening credit', purged);
const left = db.prepare(
  'SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=? AND ref_type=?'
).get(custId, 'cheque_in');
ok(Number(left.n) === 0, 'purge leaves no opening cheque_in books', left);

const fold = canonicalCustomerFold(db);
ok(Number(fold.creditor) === 0, 'canonicalCustomerFold creditor clear', fold);

const src = fs.readFileSync(path.join(__dirname, '../lib/customer-books.js'), 'utf8');
ok(src.includes('opening_cheque_ledger_mirror_v2'), 'v2 flag present');
ok(src.includes('sqlCustomerLedgerLive'), 'live SQL helper exported');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('بستانکار دفتر مشتری'), 'dash banner still names creditor');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v376/.test(sw), 'SW v376');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
