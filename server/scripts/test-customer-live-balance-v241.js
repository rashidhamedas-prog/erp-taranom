/**
 * A new tafsili plus one receipt must not replace the customer book.
 * Reproduces صدوقی: history lives on customer_ledger; only 380,000 is on the tafsili.
 * Run: node server/scripts/test-customer-live-balance-v241.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-bal-v241-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cust-bal-v241-secret-at-least-32b';
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

const { ensureCustomerBooksRepaired, customerSignedBalanceMap } = require('../lib/customer-books');
const { partySignedBalanceMap } = require('../lib/party-books');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { buildStatement } = require('../routes/accounting');
const { acct } = require('../lib/coa-map');

ensureCustomerBooksRepaired(db);

const TAF = '110301000241';
const receivable = acct(db, 'coa_receivable');
const cash = acct(db, 'coa_cash_default');
db.prepare(`
  INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
  VALUES (?,?, 'asset', ?, 4, 1)
`).run(TAF, 'تفصیلی صدوقی تست', receivable.code);

const HISTORY = 1_000_000;
const RECEIPT = 380_000;
const EXPECT = HISTORY - RECEIPT;

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, full_name, phone, coa_code, opening_balance)
  VALUES ('P-V241','customer','خانم صدوقی زاده','09120002410', ?, 0)
`).run(TAF).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, owner, phone, status, coa_code, party_id)
  VALUES (1, 'صدوقی', 'خانم صدوقی زاده', '09120002410', 'active', ?, ?)
`).run(TAF, partyId).lastInsertRowid;

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, description, debit, credit, user_id)
  VALUES (?, '1405/01/01', 'opening', 'opening', 'مانده قبل از تفصیلی', ?, 0, 1)
`).run(custId, HISTORY);
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/04', 'settlement', 'settlement', 241, 'دریافت', 0, ?, 1)
`).run(custId, RECEIPT);

postToLedger(db, {
  sourceType: 'settlement',
  sourceId: 241,
  date: '1405/07/04',
  description: 'دریافت ۳۸۰هزار',
  createdBy: 1,
  lines: [
    { code: cash.code, name: cash.name, debit: rialToLedger(RECEIPT), credit: 0 },
    { code: TAF, name: 'تفصیلی صدوقی تست', debit: 0, credit: rialToLedger(RECEIPT) },
  ],
});

const map = customerSignedBalanceMap(db);
ok(map.get(Number(custId)) === EXPECT, 'list/home balance stays on the customer book', map.get(Number(custId)));
ok(map._source.get(Number(custId)) === 'customer_ledger', 'source is customer_ledger', map._source.get(Number(custId)));

const stmt = buildStatement(db, custId);
ok(stmt && stmt.closing === EXPECT, 'statement closing is the customer book', stmt && stmt.closing);
ok(stmt.ledger_closing === EXPECT, 'ledger_closing matches', stmt.ledger_closing);
ok(stmt.gl_closing_rial === -RECEIPT, 'GL tafsili is only the receipt', stmt.gl_closing_rial);
ok(stmt.books_mismatch === true, 'mismatch stays visible');
ok(stmt.source === 'customer_ledger', 'statement source is the customer book', stmt.source);
ok((stmt.entries || []).some(e => e.entry_type === 'opening' && e.debit === HISTORY), 'history row is on the statement');
ok((stmt.entries || []).some(e => e.credit === RECEIPT), 'receipt row is on the statement');
const last = stmt.entries[stmt.entries.length - 1];
ok(last && last.running_balance === EXPECT, 'running balance ends on the customer book', last && last.running_balance);

const partyMap = partySignedBalanceMap(db);
ok(partyMap.get(Number(partyId)) === EXPECT, 'party card keeps the customer book', partyMap.get(Number(partyId)));

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
