/**
 * Party turnover fallthrough + GL/person dedup + same-leaf books_mismatch (SW v362).
 * Run: node server/scripts/test-party-books-turnover-v362.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-books-v362-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-books-turnover-v362-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createPersonLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { allocTafsili } = require('../lib/coa-map');
const { buildPartyTurnover, personLedgerCoveredByGl } = require('../lib/party-turnover');
const { partySignedBalanceDetailMap, glSignedForCoa } = require('../lib/party-books');
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');

// ── 1) Dual-role: empty customer_ledger must fall through to supplier/GL ──
const custLeaf = allocTafsili(db, 'customer', 'جعفریان تست AR');
const supLeaf = allocTafsili(db, 'supplier', 'جعفریان تست AP');

const partyDual = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active)
  VALUES ('P-JAF','both','["customer","supplier","other"]','جعفریان تست','09365002991',?,1)
`).run(custLeaf).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code, party_id)
  VALUES (1,'جعفریان تست','09365002991','active',?,?)
`).run(custLeaf, partyDual).lastInsertRowid;

const supId = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance)
  VALUES ('جعفریان تست','09365002991',?, ?, 0)
`).run(supLeaf, partyDual).lastInsertRowid;

db.prepare(`
  INSERT INTO purchase_invoices (user_id, supplier_id, date, num, rows, subtotal, final, pay_type)
  VALUES (1, ?, '1405/07/01', 'PO-T1', '[]', 1149875000, 1149875000, 'credit')
`).run(supId);

db.prepare(`
  INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/07/01','purchase','purchase',1,'خرید اعتباری',0,1149875000,1)
`).run(supId);

const turnDual = buildPartyTurnover(db, partyDual);
ok(turnDual && turnDual.entries && turnDual.entries.length >= 1, 'dual-role falls through empty customer to supplier', {
  kind: turnDual && turnDual.kind,
  n: turnDual && turnDual.entries && turnDual.entries.length,
});
ok(turnDual.kind === 'supplier', 'dual-role turnover kind=supplier', turnDual.kind);
ok(turnDual.entries.some((e) => e.credit === 1149875000), 'supplier credit visible');

// ── 2) Person payment: JE + person_ledger must NOT double in turnover ──
const personLeaf = allocTafsili(db, 'person', 'حامد تست');
const partyEmp = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active)
  VALUES ('P-HR','other','["employee"]','حامد تست','09120001111',?,1)
`).run(personLeaf).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code)
  VALUES ('حامد تست','09120001111',1,?,?)
`).run(partyEmp, personLeaf).lastInsertRowid;

const jeId = db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
  VALUES ('1405/07/10','پرداخت به شخص','manual_voucher',NULL,1,'posted')
`).run().lastInsertRowid;
// Historical bug: ref_id left NULL (pre-v362). Dedup must still work via journal_id.
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, ?, 'شخص', 1, 0, 100000000, 0)
`).run(jeId, personLeaf);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, '1101', 'صندوق', 0, 1, 0, 100000000)
`).run(jeId);

createPersonLedgerEntry(db, {
  person_id: personId,
  date: '1405/07/10',
  entry_type: 'manual_voucher',
  ref_type: 'manual_voucher',
  ref_id: jeId,
  description: 'پرداخت به شخص',
  debit: 100000000,
  credit: 0,
  user_id: 1,
});

const turnEmp = buildPartyTurnover(db, partyEmp);
const payRows = (turnEmp.entries || []).filter((e) => Math.abs(e.debit) === 100000000 || Math.abs(e.credit) === 100000000);
ok(payRows.length === 1, 'no double GL+person_ledger for same voucher', {
  n: payRows.length,
  sources: payRows.map((e) => e.source),
});
ok(payRows[0] && payRows[0].source === 'gl', 'prefer GL row after dedup', payRows[0] && payRows[0].source);

const covered = personLedgerCoveredByGl(
  [{ source: 'gl', journal_id: jeId, ref_type: 'manual_voucher', ref_id: null, date: '1405/07/10', debit: 100000000, credit: 0 }],
  { ref_type: 'manual_voucher', ref_id: jeId, date: '1405/07/10', description: 'پرداخت به شخص' },
  { debit: 100000000, credit: 0 }
);
ok(covered === true, 'personLedgerCoveredByGl matches journal_id');

// ── 3) Same-leaf mismatch: dual-role AP leaf vs party header AR must not false-flag ──
const detail = partySignedBalanceDetailMap(db);
const dualInfo = detail.get(Number(partyDual));
ok(dualInfo && dualInfo.source === 'supplier', 'dual balance source=supplier', dualInfo);
ok(dualInfo && dualInfo.coa_code === supLeaf, 'dual balance leaf=supplier coa', dualInfo);

// Put GL only on customer leaf (wrong leaf for AP balance) — must NOT count as mismatch
db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
  VALUES ('1405/07/01','noise AR','manual_voucher',?,1,'posted')
`).run(partyDual);
const noiseJe = db.prepare('SELECT last_insert_rowid() id').get().id;
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, ?, 'AR', 1, 0, 5000, 0)
`).run(noiseJe, custLeaf);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, '1101', 'صندوق', 0, 1, 0, 5000)
`).run(noiseJe);

const dash = buildPartyControlDashboard(db, { search: 'جعفریان', balance: 'all' });
const dualRow = (dash.parties || []).find((p) => p.id === partyDual);
ok(dualRow, 'dual party in control dash');
ok(dualRow.books_mismatch !== true, 'no false mismatch when GL on other leaf', {
  mismatch: dualRow && dualRow.books_mismatch,
  bal: dualRow && dualRow.balance_rial,
  gl: dualRow && dualRow.gl_balance_rial,
  leaf: dualRow && dualRow.balance_coa_code,
});

// Real mismatch: supplier leaf GL disagrees with payable
db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
  VALUES ('1405/07/01','AP partial','manual_voucher',?,1,'posted')
`).run(supId);
const apJe = db.prepare('SELECT last_insert_rowid() id').get().id;
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, ?, 'AP', 0, 1, 0, 100000)
`).run(apJe, supLeaf);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, '1101', 'صندوق', 1, 0, 100000, 0)
`).run(apJe);

const glSup = glSignedForCoa(db, supLeaf);
ok(glSup != null && Math.abs(glSup - (-1149875000)) > 1, 'supplier leaf GL differs from payable', glSup);

const dash2 = buildPartyControlDashboard(db, { search: 'جعفریان', balance: 'all' });
const dualRow2 = (dash2.parties || []).find((p) => p.id === partyDual);
ok(dualRow2 && dualRow2.books_mismatch === true, 'real same-leaf mismatch flagged', dualRow2);

// ── 4) Static wiring ──
const turnSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
ok(turnSrc.includes('journal_id'), 'turnover stores journal_id');
ok(turnSrc.includes('personLedgerCoveredByGl'), 'dedup helper exported');

const booksSrc = fs.readFileSync(path.join(__dirname, '../lib/party-books.js'), 'utf8');
ok(booksSrc.includes('partySignedBalanceDetailMap'), 'detail map exported');
ok(booksSrc.includes('glSignedForCoa'), 'glSignedForCoa exported');

const accSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(accSrc.includes('UPDATE journal_entries SET ref_id=? WHERE id=? AND (ref_id IS NULL OR ref_id=0)'), 'vouchers stamp self ref_id');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('هنوز ردیف گردشی برای این شخص ثبت نشده است'), 'empty turnover modal not error toast');
ok(!appSrc.includes('دفتر گردش برای این شخص یافت نشد — سند حسابداری یا سمت مشتری/تأمین‌کننده لازم است'),
  'old empty-ledger toast removed');

const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swSrc.includes('erp-taranom-v362'), 'SW v362');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
