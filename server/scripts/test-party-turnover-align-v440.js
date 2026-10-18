/**
 * Party turnover closing must match party-books (opening fold + all linked ids).
 * Run: node server/scripts/test-party-turnover-align-v440.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-turnover-v440-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-turnover-align-v440-secret-32chars!';
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

const { allocTafsili } = require('../lib/coa-map');
const { buildPartyTurnover } = require('../lib/party-turnover');
const { partySignedBalanceDetailMap } = require('../lib/party-books');
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');

// ── 1) Supplier: ledger has only payment; opening on parties header → turnover shows both, closing = books ──
const supLeaf = allocTafsili(db, 'supplier', 'کاظم تست AP');
const openBal = -1816870000; // بستانکار (we owe)
const payAmt = 330000000;
const expectBal = openBal + payAmt; // -1,486,870,000

const partySup = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-KZ','supplier','["supplier"]','کاظم تست','09121112233',?,?,1)
`).run(supLeaf, openBal).lastInsertRowid;

const supId = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance)
  VALUES ('کاظم تست','09121112233',?, ?, 0)
`).run(supLeaf, partySup).lastInsertRowid;

db.prepare(`
  INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/07/19','payment','supplier_payment',1,'پرداخت به تأمین‌کننده',?,0,1)
`).run(supId, payAmt);

const books1 = partySignedBalanceDetailMap(db).get(Number(partySup));
ok(books1 && Math.abs(books1.balance - expectBal) <= 1, 'books balance = opening+payment', books1 && books1.balance);

const turn1 = buildPartyTurnover(db, partySup);
ok(turn1 && turn1.entries && turn1.entries.length >= 2, 'turnover has opening fold + payment', turn1 && turn1.entries && turn1.entries.length);
ok(turn1 && Math.abs(turn1.closing - expectBal) <= 1, 'turnover closing = books', turn1 && turn1.closing);
ok(turn1.entries.some((e) => e.source === 'opening_fold' || e.ref_type === 'opening_balance'), 'synthetic opening present');
ok(turn1.entries.some((e) => Math.abs(e.debit - payAmt) <= 1), 'payment visible');

const dash1 = buildPartyControlDashboard(db, { search: 'کاظم', balance: 'all' });
const row1 = (dash1.parties || []).find((p) => p.id === partySup);
ok(row1 && Math.abs(row1.balance_rial - turn1.closing) <= 1, 'dashboard مانده = گردش closing', {
  dash: row1 && row1.balance_rial,
  turn: turn1 && turn1.closing,
});

// ── 2) Empty supplier_ledger + docs payment + header opening → still align to books ──
const supLeaf2 = allocTafsili(db, 'supplier', 'تأمین تست۲');
const open2 = -500000000;
const party2 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-S2','supplier','["supplier"]','تأمین تست۲','09120000002',?,?,1)
`).run(supLeaf2, open2).lastInsertRowid;
const sup2 = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance)
  VALUES ('تأمین تست۲','09120000002',?, ?, 0)
`).run(supLeaf2, party2).lastInsertRowid;
db.prepare(`
  INSERT INTO supplier_payments (supplier_id, date, amount, note, user_id)
  VALUES (?, '1405/07/01', 100000000, 'پرداخت بدون دفتر', 1)
`).run(sup2);

const books2 = partySignedBalanceDetailMap(db).get(Number(party2));
// books: opening only (payments not in supplier_ledger) → open2
ok(books2 && Math.abs(books2.balance - open2) <= 1, 'books ignores orphan payment doc', books2 && books2.balance);
const turn2 = buildPartyTurnover(db, party2);
ok(turn2 && Math.abs(turn2.closing - books2.balance) <= 1, 'empty ledger closes to books opening', {
  closing: turn2 && turn2.closing,
  books: books2 && books2.balance,
});
ok(!(turn2.entries || []).some((e) => e.source === 'supplier_payment'), 'orphan payment not mixed into SoT stream');

// ── 3) role=supplier vs default for dual-role ──
const custLeaf = allocTafsili(db, 'customer', 'دوگانه AR');
const apLeaf = allocTafsili(db, 'supplier', 'دوگانه AP');
const partyD = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active)
  VALUES ('P-DU','both','["customer","supplier"]','دوگانه تست','09123334455',?,1)
`).run(custLeaf).lastInsertRowid;
db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code, party_id)
  VALUES (1,'دوگانه تست','09123334455','active',?,?)
`).run(custLeaf, partyD);
const supD = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance)
  VALUES ('دوگانه تست','09123334455',?, ?, 0)
`).run(apLeaf, partyD).lastInsertRowid;
db.prepare(`
  INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/07/01','purchase','purchase',9,'خرید',0,200000000,1)
`).run(supD);
db.prepare(`
  INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  SELECT id, '1405/07/02','invoice','invoice',9,'فاکتور',50000000,0,1 FROM customers WHERE party_id=?
`).run(partyD);

const booksD = partySignedBalanceDetailMap(db).get(Number(partyD));
const turnNet = buildPartyTurnover(db, partyD);
ok(turnNet && Math.abs(turnNet.closing - booksD.balance) <= 1, 'dual default closing = net books', {
  closing: turnNet && turnNet.closing,
  books: booksD && booksD.balance,
});
const turnSupOnly = buildPartyTurnover(db, partyD, { role: 'supplier' });
const leafSup = (booksD.leaves || []).find((l) => l.source === 'supplier');
ok(turnSupOnly && leafSup && Math.abs(turnSupOnly.closing - leafSup.balance) <= 1, 'role=supplier closes to AP leaf', {
  closing: turnSupOnly && turnSupOnly.closing,
  leaf: leafSup && leafSup.balance,
});

// ── 4) Static wiring ──
const turnSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
ok(turnSrc.includes('alignEntriesToTarget'), 'align helper present');
ok(turnSrc.includes('opening_fold'), 'opening_fold source');
ok(turnSrc.includes('partySignedBalanceDetailMap'), 'uses party-books SoT');

const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/parties.js'), 'utf8');
ok(routeSrc.includes('req.query.role'), 'turnover accepts ?role=');

const portalSrc = fs.readFileSync(path.join(__dirname, '../public/portal-ui.js'), 'utf8');
ok(portalSrc.includes('footBal'), 'page footer sums balance_rial');

const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v(44[2-9]|4[5-9]\d|[5-9]\d{2})/.test(swSrc), 'SW >= v442', swSrc.slice(0, 80));

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
