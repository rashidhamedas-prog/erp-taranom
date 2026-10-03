/**
 * Party turnover + person voucher party_id + settlement books backfill.
 * Run: node server/scripts/test-party-turnover-books-v295.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-turn-v295-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-turnover-v295-secret-32chars!!';
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

const { buildPartyTurnover, resolvePersonIdFromVoucherLine, ensurePersonForParty } = require('../lib/party-turnover');
const { repairSettlementsMissingBooks } = require('../lib/customer-books');
const { allocTafsili } = require('../lib/coa-map');

const taf = allocTafsili(db, 'customer', 'اکبری تست');

const partyCust = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, legacy_table, legacy_id, is_active)
  VALUES ('P-AKB','customer','["customer"]','حامد اکبری تست','09121110001',?, 'customers', NULL, 1)
`).run(taf).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code, party_id)
  VALUES (1, 'حامد اکبری تست', '09121110001', 'active', ?, ?)
`).run(taf, partyCust).lastInsertRowid;
db.prepare('UPDATE parties SET legacy_id=? WHERE id=?').run(custId, partyCust);

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, description, debit, credit, user_id)
  VALUES (?, '', 'opening', 'opening', 'مانده اولیه حساب', 0, 100000000, 1)
`).run(custId);
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/09', 'settlement', 'settlement', 9001, 'تسویه واریز بانکی', 0, 24500000, 1)
`).run(custId);

const turnCust = buildPartyTurnover(db, partyCust);
ok(turnCust && turnCust.kind === 'customer', 'customer kind');
ok(turnCust.entries.length >= 2, 'customer entries include settlement', turnCust.entries.length);
ok(turnCust.entries.some((e) => e.credit === 24500000), 'settlement credit visible');

const partyOther = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active)
  VALUES ('P-OTH','other','["other"]','شخص تست پرداخت','09121110002',1)
`).run().lastInsertRowid;

const personId = resolvePersonIdFromVoucherLine(db, { party_id: partyOther });
ok(!!personId, 'party_id resolves to person', personId);
ok(ensurePersonForParty(db, partyOther) === personId, 'ensurePerson idempotent');

const wrongPerson = db.prepare(`
  INSERT INTO persons (name, phone, active) VALUES ('شخص اشتباه','09120000000',1)
`).run().lastInsertRowid;
const resolved = resolvePersonIdFromVoucherLine(db, { party_id: partyOther, person_id: wrongPerson });
ok(resolved === personId, 'party_id preferred when both sent', { resolved, personId, wrongPerson });

const partyAref = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active)
  VALUES ('P-ARF','other','["other"]','عارف تست','09121110003',1)
`).run().lastInsertRowid;
const userAref = db.prepare(`
  INSERT INTO users (username, password, name, role, active, party_id)
  VALUES ('aref_test','x','عارف تست','field_sales',1,?)
`).run(partyAref).lastInsertRowid;
db.prepare(`
  INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
  VALUES (?, '1405/07/03', 'commission_paid', 'incentive_payment', 1, 'پرداخت انگیزه فروش', 100000000, 0, 1)
`).run(userAref);

const turnAref = buildPartyTurnover(db, partyAref);
ok(turnAref && turnAref.kind === 'person', 'aref person kind');
ok(turnAref.entries.some((e) => e.source === 'rep_ledger' && e.debit === 100000000), 'incentive on turnover');

const settId = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, amount, amount_rial, pay_type, date, note, status)
  VALUES (1, ?, 5000000, 5000000, 'cash', '1405/07/10', 'بدون کتاب', 'posted')
`).run(custId).lastInsertRowid;
ok(db.prepare("SELECT COUNT(*) c FROM customer_ledger WHERE ref_type='settlement' AND ref_id=?").get(settId).c === 0,
  'settlement starts without books');

db.prepare("DELETE FROM settings WHERE key='settlement_books_backfill_v295'").run();
const repaired = repairSettlementsMissingBooks(db);
ok(repaired.inserted >= 1, 'repair inserts settlement books', repaired);
ok(db.prepare("SELECT COUNT(*) c FROM customer_ledger WHERE ref_type='settlement' AND ref_id=?").get(settId).c === 1,
  'settlement now has books');

// voucher builder accepts party_id
const accountingSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(accountingSrc.includes('resolvePersonIdFromVoucherLine'), 'accounting uses party resolver');
ok(accountingSrc.includes('l.party_id'), 'accounting accepts party_id');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes("/parties/'+id+'/turnover"), 'UI uses unified turnover API');
ok(appSrc.includes("party_id:target"), 'person payment posts party_id voucher');
ok(!/await api\('POST','\/expenses',\{\.\.\.payload, category:'admin', title:'پرداخت به شخص/.test(appSrc),
  'person payment no longer silent expense');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
