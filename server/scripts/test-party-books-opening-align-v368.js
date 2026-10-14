/**
 * Party books: opening+subledger composition + supplier_ledger SoT (SW v368).
 * Run: node server/scripts/test-party-books-opening-align-v368.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-books-v368-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-books-opening-align-v368-secret-32c';
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
const {
  partySignedBalanceDetailMap, glSignedForCoa, partyBooksMismatch,
} = require('../lib/party-books');
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');
const { postPartyOpeningBalance } = require('../lib/opening-post');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL, rialToLedger } = require('../lib/money');

function postJeOnLeaf(leaf, signedRial, date, refType, refId) {
  const abs = Math.abs(signedRial);
  const t = rialToLedger(abs);
  const jeId = db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
    VALUES (?,?,?,?,1,'posted')
  `).run(date, 'test', refType, refId).lastInsertRowid;
  if (signedRial >= 0) {
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?,?,'leaf',?,0,?,0)
    `).run(jeId, leaf, t, abs);
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?,'3102','opening',0,?,0,?)
    `).run(jeId, t, abs);
  } else {
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?,'3102','opening',?,0,?,0)
    `).run(jeId, t, abs);
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
      VALUES (?,?,'leaf',0,?,0,?)
    `).run(jeId, leaf, t, abs);
  }
  return jeId;
}

// ── 1) Opening in GL + party header, activity in person_ledger → live = open+act = GL ──
const leaf1 = allocTafsili(db, 'person', 'حامد تست v368');
const p1 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-H368','other','["employee"]','حامد تست v368','09121110001',?, 50000000, 1)
`).run(leaf1).lastInsertRowid;
const pe1 = db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code) VALUES ('حامد تست v368','09121110001',1,?,?)
`).run(p1, leaf1).lastInsertRowid;
postJeOnLeaf(leaf1, 50000000, '1405/01/01', 'opening_balance', p1);
postJeOnLeaf(leaf1, 20000000, '1405/02/01', 'manual_voucher', pe1);
createPersonLedgerEntry(db, {
  person_id: pe1, date: '1405/02/01', entry_type: 'manual',
  ref_type: 'manual_voucher', ref_id: 1,
  description: 'فعالیت', debit: 20000000, credit: 0, user_id: 1,
});

const d1 = partySignedBalanceDetailMap(db).get(Number(p1));
const gl1 = glSignedForCoa(db, leaf1);
ok(d1 && d1.balance === 70000000, 'person live = opening + ledger', d1 && d1.balance);
ok(gl1 === 70000000, 'GL = opening + activity', gl1);
ok(partyBooksMismatch(db, d1) !== true, 'no mismatch when opening folded', {
  live: d1 && d1.balance, gl: gl1,
});

// ── 2) Supplier: document formula would be wrong unit; supplier_ledger = SoT ──
const leaf2 = allocTafsili(db, 'supplier', 'ظریف تست v368');
const p2 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-Z368','supplier','["supplier"]','ظریف تست v368','09121110002',?, 0, 1)
`).run(leaf2).lastInsertRowid;
const s2 = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance) VALUES ('ظریف تست v368','09121110002',?,?,0)
`).run(leaf2, p2).lastInsertRowid;
// Fake purchase in "toman-looking" final that would poison old formula (198000000)
db.prepare(`
  INSERT INTO purchase_invoices (user_id, supplier_id, date, num, rows, subtotal, final, pay_type)
  VALUES (1, ?, '1405/03/01', 'PO-Z368', '[]', 198000000, 198000000, 'credit')
`).run(s2);
// Real AP on ledger+GL in rial
db.prepare(`
  INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/03/01','purchase','purchase',1,'خرید',0,19804530,1)
`).run(s2);
postJeOnLeaf(leaf2, -19804530, '1405/03/01', 'purchase', s2);

const d2 = partySignedBalanceDetailMap(db).get(Number(p2));
const gl2 = glSignedForCoa(db, leaf2);
ok(d2 && d2.source === 'supplier', 'supplier source', d2 && d2.source);
ok(d2 && d2.balance === -19804530, 'supplier live from ledger not formula', d2 && d2.balance);
ok(gl2 === -19804530, 'supplier GL', gl2);
ok(partyBooksMismatch(db, d2) !== true, 'supplier no mismatch', d2);

// ── 3) Supplier opening on party + activity on ledger ──
const leaf3 = allocTafsili(db, 'supplier', 'طالبی تست v368');
const p3 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-T368','supplier','["supplier"]','طالبی تست v368','09121110003',?, -38309000, 1)
`).run(leaf3).lastInsertRowid;
const s3 = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance) VALUES ('طالبی تست v368','09121110003',?,?,0)
`).run(leaf3, p3).lastInsertRowid;
db.prepare(`
  INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/04/01','purchase','purchase',2,'خرید',0,33000000,1)
`).run(s3);
postJeOnLeaf(leaf3, -38309000, '1405/01/01', 'opening_balance', p3);
postJeOnLeaf(leaf3, -33000000, '1405/04/01', 'purchase', s3);

const d3 = partySignedBalanceDetailMap(db).get(Number(p3));
const gl3 = glSignedForCoa(db, leaf3);
ok(d3 && d3.balance === -71309000, 'supplier opening+ledger', d3 && d3.balance);
ok(gl3 === -71309000, 'supplier GL opening+act', gl3);
ok(partyBooksMismatch(db, d3) !== true, 'supplier opening aligned');

// ── 4) postPartyOpeningBalance writes person_ledger via party_id link ──
const leaf4 = allocTafsili(db, 'person', 'معین تست v368');
const p4 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-M368','other','["employee"]','معین تست v368','09121110004',?, 0, 1)
`).run(leaf4).lastInsertRowid;
const pe4 = db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code) VALUES ('معین تست v368','09121110004',1,?,?)
`).run(p4, leaf4).lastInsertRowid;
db.prepare('UPDATE parties SET opening_balance=?, coa_code=? WHERE id=?').run(65000000, leaf4, p4);
const jeOpen = postPartyOpeningBalance(db, {
  partyId: p4, amountRial: 65000000, date: '1405/01/01', userId: 1,
});
ok(jeOpen > 0, 'opening JE posted', jeOpen);
const openRow = db.prepare(`
  SELECT debit, credit FROM person_ledger
  WHERE person_id=? AND ref_type='opening_balance'
`).get(pe4);
ok(openRow && Number(openRow.debit) === 65000000, 'opening mirrored to person_ledger', openRow);
createPersonLedgerEntry(db, {
  person_id: pe4, date: '1405/05/01', entry_type: 'manual',
  ref_type: 'manual_voucher', ref_id: 9,
  description: 'act', debit: 20000000, credit: 0, user_id: 1,
});
postJeOnLeaf(leaf4, 20000000, '1405/05/01', 'manual_voucher', pe4);
const d4 = partySignedBalanceDetailMap(db).get(Number(p4));
const gl4 = glSignedForCoa(db, leaf4);
ok(d4 && d4.balance === 85000000, 'after opening row in ledger, no double open', d4 && d4.balance);
ok(Math.abs(gl4 - 85000000) <= 1, 'GL after opening post', gl4);
ok(partyBooksMismatch(db, d4) !== true, 'aligned after proper opening post');

// ── 5) Dashboard KPI mismatch for intentional drift ──
const leaf5 = allocTafsili(db, 'person', 'رسولی تست v368');
const p5 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-R368','other','["employee"]','رسولی تست v368','09121110005',?, 0, 1)
`).run(leaf5).lastInsertRowid;
const pe5 = db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code) VALUES ('رسولی تست v368','09121110005',1,?,?)
`).run(p5, leaf5).lastInsertRowid;
createPersonLedgerEntry(db, {
  person_id: pe5, date: '1405/06/01', entry_type: 'manual',
  ref_type: 'manual_voucher', ref_id: 11,
  description: 'only ledger', debit: 0, credit: 200000000, user_id: 1,
});
postJeOnLeaf(leaf5, -100000000, '1405/06/01', 'manual_voucher', pe5);
const dash = buildPartyControlDashboard(db, { search: 'رسولی تست v368', balance: 'all' });
const row5 = (dash.parties || []).find((p) => p.id === p5);
ok(row5 && row5.books_mismatch === true, 'real drift still flagged', row5);

// ── 6) Static wiring ──
const booksSrc = fs.readFileSync(path.join(__dirname, '../lib/party-books.js'), 'utf8');
ok(booksSrc.includes('supplier_ledger'), 'uses supplier_ledger');
ok(booksSrc.includes('takeOpening') || booksSrc.includes('openingUsed'), 'opening once');
ok(booksSrc.includes('partyBooksMismatch'), 'exports partyBooksMismatch');
const openSrc = fs.readFileSync(path.join(__dirname, '../lib/opening-post.js'), 'utf8');
ok(openSrc.includes('SELECT id FROM persons WHERE party_id=?'), 'opening posts to linked persons');
ok(openSrc.includes('INSERT INTO supplier_ledger'), 'opening posts to supplier_ledger');
const dashSrc = fs.readFileSync(path.join(__dirname, '../lib/party-control-dashboard.js'), 'utf8');
ok(dashSrc.includes('partyBooksMismatch'), 'dashboard uses partyBooksMismatch');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
