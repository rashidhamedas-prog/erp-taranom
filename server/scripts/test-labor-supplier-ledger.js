/**
 * PRD-03 contractor wage on the linked supplier's AP leaf (2101xx) must reach
 * supplier_ledger too — not only person_ledger — so 7A (supplierBooksMismatchList)
 * stays green on the first posting into an empty supplier book.
 * Run: node server/scripts/test-labor-supplier-ledger.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-labor-supplier-ledger-32chars';

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? JSON.stringify(detail) : ''); }
}

console.log('\n══ production labor → supplier_ledger on contractor AP leaf ══\n');

try {
  const probe = new (require('better-sqlite3'))(':memory:');
  probe.close();
} catch (e) {
  console.log('SKIP SQLite ABI:', e.message);
  process.exit(1);
}

const { freshDb } = require('./lib/test-harness');
const { db, cleanup } = freshDb();
const { acct } = require('../lib/coa-map');
const {
  postLabor, absorbLaborJournal, retirePersonLaborForEntries, writeSupplierLaborLedger,
} = require('../lib/production/labor');
const { postEvent, dr, cr } = require('../lib/production/posting');
const { reverseJournalEntry } = require('../lib/void-journal');
const { supplierBooksMismatchList } = require('../lib/gl-metrics');
const { reconcileLeaf } = require('../lib/party-leaf-sync');

const DATE = '1405/08/12';
const PERIOD = '1405/08';
const apControl = String(acct(db, 'coa_payable').code);

function addCoa(code, name, type) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,4)')
    .run(code, name, type, null);
}
let seq = 0;
function addParty(name, roles, coa) {
  seq += 1;
  return db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
    VALUES (?,?,?,?,?,?,0,1,?)
  `).run(`LSL-${seq}`, 'other', JSON.stringify(roles), name, `0913000${String(seq).padStart(4, '0')}`, coa, name)
    .lastInsertRowid;
}
function addSupplier(name, partyId, coa) {
  return db.prepare('INSERT INTO suppliers (name, party_id, coa_code) VALUES (?,?,?)')
    .run(name, partyId, coa).lastInsertRowid;
}
function addPerson(name, partyId, coa) {
  return db.prepare(`
    INSERT INTO persons (name, phone, party_id, active, coa_code, employment_type)
    VALUES (?,?,?,1,?,'contractor')
  `).run(name, '', partyId, coa).lastInsertRowid;
}

const productId = db.prepare(
  "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'مانتو LSL','P-LSL',0,0,1)"
).run().lastInsertRowid;
let ccId = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1').get()?.id;
if (!ccId) {
  ccId = db.prepare("INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-LSL','دوخت LSL',1,'production')")
    .run().lastInsertRowid;
}
const orderId = db.prepare(`
  INSERT INTO production_orders (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date)
  VALUES ('PO-LSL',?,100,'in_progress','fixed',?,?)
`).run(productId, ccId, DATE).lastInsertRowid;

function postPiece(personId, qty, rate) {
  const r = postLabor(db, {
    orderId, costCenterId: ccId, personId, method: 'piece', qty, rateRial: rate,
    date: DATE, period: PERIOD, userId: 1, note: `دستمزد LSL شخص ${personId}`,
  });
  const entry = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(r.id);
  const jes = absorbLaborJournal(db, {
    orderId, date: DATE, userId: 1, costCenterId: ccId, wipTafsili: null,
    entries: [entry], descriptionFallback: entry.note, postEvent, dr, cr,
  });
  const jeId = jes[0] && jes[0].je_id;
  const crLine = jeId
    ? db.prepare('SELECT account_code, credit FROM journal_lines WHERE entry_id=? AND credit>0').get(jeId)
    : null;
  return { entry, jeId, crLine, amount: r.amount_rial };
}
const supRows = (supId, lid) => db.prepare(`
  SELECT id, debit, credit FROM supplier_ledger
  WHERE supplier_id=? AND ref_type='production_labor' AND ref_id=?
`).all(supId, lid);
const personRows = (pid, lid) => db.prepare(`
  SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).all(pid, lid);
const inMismatch = (supId) => supplierBooksMismatchList(db, { limit: 1000 }).rows.some((r) => r.id === Number(supId));

console.log('— contractor: person on 1106, supplier owns empty 2101xx book —');
const leafA = `${apControl}009601`;
addCoa(leafA, 'پیمانکار LSL الف', 'liability');
addCoa('110601009601', 'پیمانکار LSL الف (اشخاص)', 'asset');
const partyA = addParty('پیمانکار LSL الف', ['supplier', 'employee'], '110601009601');
const supA = addSupplier('پیمانکار LSL الف', partyA, leafA);
const pA = addPerson('پیمانکار LSL الف', partyA, '110601009601');
ok(supRows(supA, 0).length === 0 && !inMismatch(supA), 'precondition: empty supplier book, 7A green');

const postA = postPiece(pA, 10, 300000);
ok(postA.crLine && String(postA.crLine.account_code) === leafA, 'Cr = supplier AP leaf', postA.crLine);
ok(personRows(pA, postA.entry.id).length === 1, 'person_ledger credit written');
const rowsA = supRows(supA, postA.entry.id);
ok(rowsA.length === 1 && Math.round(rowsA[0].credit) === postA.amount && !Number(rowsA[0].debit),
  'supplier_ledger credit written with the same rial amount', { rowsA, amount: postA.amount });
ok(!inMismatch(supA), '7A supplierBooksMismatchList green after first posting');

ok(writeSupplierLaborLedger(db, {
  leafCode: leafA, partyId: partyA, laborEntryId: postA.entry.id, date: DATE, amountRial: postA.amount,
}) === 0 && supRows(supA, postA.entry.id).length === 1, 'idempotent: second write is a no-op');

const recon = reconcileLeaf(db, leafA, { insert: 'siblings' });
ok(recon.inserted === 0 && recon.retired === 0, 'leaf reconcile keeps the row (matched to the live GL line)', recon);

const postA2 = postPiece(pA, 4, 300000);
ok(supRows(supA, postA2.entry.id).length === 1 && !inMismatch(supA), 'second posting also mirrored; 7A green');

console.log('— regression guard: without the supplier row 7A is red —');
const saved = supRows(supA, postA2.entry.id)[0];
db.prepare('DELETE FROM supplier_ledger WHERE id=?').run(saved.id);
ok(inMismatch(supA), 'missing supplier row → supplier listed in 7A');
writeSupplierLaborLedger(db, {
  leafCode: leafA, partyId: partyA, laborEntryId: postA2.entry.id, date: DATE, amountRial: postA2.amount,
});
ok(!inMismatch(supA), 'restored → 7A green');

console.log('— person and supplier on the same leaf: no duplicates —');
const leafB = `${apControl}009602`;
addCoa(leafB, 'پیمانکار LSL ب', 'liability');
const partyB = addParty('پیمانکار LSL ب', ['supplier', 'employee'], leafB);
const supB = addSupplier('پیمانکار LSL ب', partyB, leafB);
const pB = addPerson('پیمانکار LSL ب', partyB, leafB);
const postB = postPiece(pB, 5, 200000);
ok(String(postB.crLine?.account_code) === leafB, 'Cr = shared leaf', postB.crLine);
ok(personRows(pB, postB.entry.id).length === 1, 'one person_ledger row');
ok(supRows(supB, postB.entry.id).length === 1, 'one supplier_ledger row');
const reconB = reconcileLeaf(db, leafB, { insert: 'siblings' });
ok(reconB.inserted === 0 && supRows(supB, postB.entry.id).length === 1, 'sibling reconcile adds no copy', reconB);
ok(!inMismatch(supB), '7A green on shared leaf');

console.log('— cancel (R13): JE soft-void + both books retired —');
const revId = reverseJournalEntry(db, postA.jeId, { userId: 1, date: DATE, reason: 'LSL test' });
retirePersonLaborForEntries(db, [postA.entry]);
ok(revId === postA.jeId, 'PRD-03 JE soft-voided', revId);
ok(personRows(pA, postA.entry.id).length === 0, 'person_ledger row retired');
ok(supRows(supA, postA.entry.id).length === 0, 'supplier_ledger row retired');
ok(supRows(supA, postA2.entry.id).length === 1, 'other posting untouched');
ok(!inMismatch(supA), '7A green after cancel');

console.log('— supplier without party link still retired on cancel —');
const leafC = `${apControl}009603`;
addCoa(leafC, 'پیمانکار LSL ج', 'liability');
const supC = addSupplier('پیمانکار LSL ج', null, leafC);
const pC = addPerson('پیمانکار LSL ج', null, leafC);
const postC = postPiece(pC, 2, 500000);
ok(supRows(supC, postC.entry.id).length === 1 && !inMismatch(supC), 'unlinked supplier on the leaf mirrored');
reverseJournalEntry(db, postC.jeId, { userId: 1, date: DATE, reason: 'LSL test' });
retirePersonLaborForEntries(db, [postC.entry]);
ok(supRows(supC, postC.entry.id).length === 0 && !inMismatch(supC), 'unlinked supplier row retired on cancel');

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
