const { swAtLeast } = require('./lib/sw-at-least');
/**
 * SW v499 — piece/hourly with person → PRD-03 credits person payable + person_ledger
 * Monthly / no person → Cr 5201. Heal is idempotent.
 * Run: node server/scripts/test-bom-labor-person-je-v499.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-labor-person-v499-dummy-key-32chars';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ BOM labor → person JE v499 ══\n');

const laborSrc = fs.readFileSync(path.join(__dirname, '../lib/production/labor.js'), 'utf8');
const engAdvSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
const engSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const adrSrc = fs.readFileSync(path.join(__dirname, '../../docs/architecture/PROD-CUT-ADR-005-shared-cut.md'), 'utf8');
const accSrc = fs.readFileSync(path.join(__dirname, '../../docs/Production/accounting-events.md'), 'utf8');

ok(laborSrc.includes('absorbLaborJournal'), 'labor.absorbLaborJournal');
ok(laborSrc.includes('writePersonLaborLedger'), 'labor.writePersonLaborLedger');
ok(laborSrc.includes('healPieceLaborPersonPayable'), 'labor.healPieceLaborPersonPayable');
ok(laborSrc.includes('laborCreditsPerson'), 'labor.laborCreditsPerson');
ok(laborSrc.includes('resolvePersonPayableAccount'), 'uses person payable resolver');
ok(/side\.mode === 'person'/.test(laborSrc) || laborSrc.includes("mode: 'person'"), 'person credit mode used in absorb');
ok(engAdvSrc.includes('absorbLaborJournal'), 'engine-advanced uses absorbLaborJournal');
ok(engAdvSrc.includes('retirePersonLaborForEntries'), 'engine-advanced retires person ledger');
ok(engSrc.includes('absorbLaborJournal'), 'engine uses absorbLaborJournal');
ok(engSrc.includes('retirePersonLaborForEntries'), 'engine retires person ledger');
ok(appJs.includes('شخص (بستانکار دستمزد)'), 'UI label person creditor');
ok(appJs.includes('قطعه‌ای یا ساعتی') && appJs.includes('حساب همان شخص'), 'Help: piece/hourly → person');
ok(swAtLeast(swSrc, 499), 'SW v499');
ok(idxSrc.includes('app.js?v=499'), 'index cache bust v499');
ok(adrSrc.includes('قطعه‌ای/ساعتی') || adrSrc.includes('piece'), 'ADR-005 carve-out documented');
ok(accSrc.includes('با `person_id`'), 'accounting-events PRD-03 person variant');

const {
  formatLaborJeDescription,
  laborCreditsPerson,
} = require('../lib/production/labor');

ok(laborCreditsPerson({ method: 'piece', person_id: 1 }), 'piece+person credits person');
ok(!laborCreditsPerson({ method: 'monthly', person_id: 1 }), 'monthly+person stays control');
ok(!laborCreditsPerson({ method: 'piece', person_id: null }), 'piece without person → control');

const desc = formatLaborJeDescription({
  orderNo: 'PO-T499',
  productCode: 'P-499',
  productName: 'مانتو',
  opName: 'دوخت',
  qty: 10,
  method: 'piece',
  personName: 'کارگر تست',
  amountRial: 1_800_000,
});
ok(desc.includes('دوخت') && desc.includes('مانتو') && desc.includes('×10') && desc.includes('کارگر'), 'narration template', desc);

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb, summary } = (() => {
  try {
    return require('./lib/test-harness');
  } catch (_) {
    return { freshDb: null, summary: null };
  }
})();

if (!freshDb) {
  console.log('\nSKIP freshDb harness');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { db, cleanup } = freshDb();
const {
  absorbLaborJournal,
  postLabor,
  healPieceLaborPersonPayable,
  retirePersonLaborForEntries,
} = require('../lib/production/labor');
const { postEvent, dr, cr, acct } = (() => {
  const posting = require('../lib/production/posting');
  return { ...posting, acct: require('../lib/coa-map').acct };
})();

const DATE = '1405/07/28';
const PERIOD = '1405/07';

const coa = '110601009499';
try {
  db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,level) VALUES (?,?,?,?)`)
    .run(coa, 'شخص تست v499', 'asset', 4);
} catch (_) {
  try {
    db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)`)
      .run(coa, 'شخص تست v499', 'asset');
  } catch (__) { /* ignore */ }
}

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
  VALUES ('EMP-V499','other','["employee"]','کارگر v499','09120000499',?,0,1,'کارگر v499')
`).run(coa).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, party_id, active, coa_code)
  VALUES ('کارگر v499','09120000499',?,1,?)
`).run(partyId, coa).lastInsertRowid;

const productId = db.prepare(
  "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'مانتو v499','P-V499',0,0,1)"
).run().lastInsertRowid;

let ccId = db.prepare(`SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1`).get()?.id;
if (!ccId) {
  ccId = db.prepare(`
    INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-V499','دوخت تست',1,'production')
  `).run().lastInsertRowid;
}

const orderNo = 'PO-V499';
let orderId;
try {
  orderId = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date, created_by)
    VALUES (?,?,?,?,?,?,?,1)
  `).run(orderNo, productId, 10, 'in_progress', 'fixed', ccId, DATE).lastInsertRowid;
} catch (_) {
  orderId = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date)
    VALUES (?,?,?,?,?,?,?)
  `).run(orderNo, productId, 10, 'in_progress', 'fixed', ccId, DATE).lastInsertRowid;
}

const qty = 10;
const rate = 180000;
const amount = rate * qty;
const note = formatLaborJeDescription({
  orderNo,
  productCode: 'P-V499',
  productName: 'مانتو v499',
  opName: 'دوخت',
  qty,
  method: 'piece',
  personName: 'کارگر v499',
  amountRial: amount,
});

const laborRow = postLabor(db, {
  orderId,
  costCenterId: ccId,
  personId,
  method: 'piece',
  qty,
  rateRial: rate,
  date: DATE,
  period: PERIOD,
  userId: 1,
  note,
});
ok(laborRow.amount_rial === amount, 'piece amount = rate×qty', laborRow.amount_rial);

const entry = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(laborRow.id);
const jes = absorbLaborJournal(db, {
  orderId,
  date: DATE,
  userId: 1,
  costCenterId: ccId,
  wipTafsili: null,
  entries: [entry],
  descriptionFallback: note,
  postEvent,
  dr,
  cr,
});
ok(jes.length === 1, 'one PRD-03 JE', jes.length);

const jeId = jes[0].je_id;
const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(jeId);
ok(je && String(je.description || '').includes('دوخت'), 'JE description has operation', je?.description);

const lines = db.prepare(`
  SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id
`).all(jeId);
const crLine = lines.find((l) => Number(l.credit) > 0);
const drLine = lines.find((l) => Number(l.debit) > 0);
ok(drLine && Number(drLine.debit) > 0, 'Dr WIP line');
ok(crLine && String(crLine.account_code) === coa, 'Cr person payable leaf', crLine?.account_code);
ok(!!db.prepare(`
  SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).get(personId, laborRow.id), 'person_ledger credit written');

retirePersonLaborForEntries(db, [entry]);
ok(!db.prepare(`
  SELECT id FROM person_ledger
  WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
    AND COALESCE(deleted_at,0)=0
`).get(personId, laborRow.id), 'retire clears live person_ledger');

// Control path (no person)
const labor2 = postLabor(db, {
  orderId,
  costCenterId: ccId,
  personId: null,
  method: 'piece',
  qty: 2,
  rateRial: 50000,
  date: DATE,
  period: PERIOD,
  userId: 1,
  note: 'بدون شخص',
});
const e2 = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(labor2.id);
const jes2 = absorbLaborJournal(db, {
  orderId,
  date: DATE,
  userId: 1,
  costCenterId: ccId,
  wipTafsili: null,
  entries: [e2],
  descriptionFallback: 'بدون شخص',
  postEvent,
  dr,
  cr,
});
const lines2 = db.prepare(`
  SELECT account_code, credit FROM journal_lines WHERE entry_id=?
`).all(jes2[0].je_id);
ok(lines2.some((l) => String(l.account_code) === '5201' && Number(l.credit) > 0), 'no-person → Cr 5201');

// Monthly with person still → 5201
const labor3 = postLabor(db, {
  orderId,
  costCenterId: ccId,
  personId,
  method: 'monthly',
  qty: 1,
  rateRial: 40000,
  date: DATE,
  period: PERIOD,
  userId: 1,
  note: 'ماهانه با شخص',
});
const e3 = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(labor3.id);
const jes3 = absorbLaborJournal(db, {
  orderId,
  date: DATE,
  userId: 1,
  costCenterId: ccId,
  wipTafsili: null,
  entries: [e3],
  descriptionFallback: 'ماهانه با شخص',
  postEvent,
  dr,
  cr,
});
const lines3 = db.prepare(`
  SELECT account_code, credit FROM journal_lines WHERE entry_id=?
`).all(jes3[0].je_id);
ok(lines3.some((l) => String(l.account_code) === '5201' && Number(l.credit) > 0), 'monthly+person → Cr 5201');
ok(!db.prepare(`
  SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).get(personId, labor3.id), 'monthly does not write person_ledger');

// Heal: fabricate ADR-005 style 5201 credit with person_id
const labor4 = postLabor(db, {
  orderId,
  costCenterId: ccId,
  personId,
  method: 'piece',
  qty: 3,
  rateRial: 100000,
  date: DATE,
  period: PERIOD,
  userId: 1,
  note: 'heal target',
});
const e4 = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(labor4.id);
const fakeJe = postEvent(db, {
  event: 'PRD-03',
  sourceId: orderId,
  date: DATE,
  description: 'fake 5201',
  createdBy: 1,
  costCenterId: ccId,
  lines: [
    dr(db, 'coa_wip', e4.amount_rial),
    cr(db, 'coa_labor_control', e4.amount_rial),
  ],
});
db.prepare('UPDATE production_labor_entries SET je_id=? WHERE id=?').run(fakeJe.je_id, e4.id);
const dry = healPieceLaborPersonPayable(db, { dryRun: true, laborEntryIds: [e4.id] });
ok(dry.healed === 1, 'heal dry-run finds one', dry);
const applied = healPieceLaborPersonPayable(db, { dryRun: false, laborEntryIds: [e4.id] });
ok(applied.healed === 1, 'heal apply one', applied);
const healedCr = db.prepare(`
  SELECT account_code FROM journal_lines WHERE entry_id=? AND COALESCE(credit,0)>0
`).get(fakeJe.je_id);
ok(String(healedCr?.account_code) === coa, 'heal reclassed credit to person', healedCr?.account_code);
ok(!!db.prepare(`
  SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).get(personId, e4.id), 'heal wrote person_ledger');
const again = healPieceLaborPersonPayable(db, { dryRun: false, laborEntryIds: [e4.id] });
ok(again.skipped === 1 && again.healed === 0, 'heal idempotent', again);

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
if (typeof summary === 'function') summary();
process.exit(failed ? 1 : 0);
