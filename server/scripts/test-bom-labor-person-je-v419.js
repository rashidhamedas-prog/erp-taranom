/**
 * SW v419 — BOM wage op with person → PRD-03 credits person + JE narration
 * Run: node server/scripts/test-bom-labor-person-je-v419.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-labor-person-v419-dummy-key-32chars';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ BOM labor → person JE v419 ══\n');

const laborSrc = fs.readFileSync(path.join(__dirname, '../lib/production/labor.js'), 'utf8');
const engAdvSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
const engSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const accSrc = fs.readFileSync(path.join(__dirname, '../../docs/Production/accounting-events.md'), 'utf8');

ok(laborSrc.includes('absorbLaborJournal'), 'labor.absorbLaborJournal');
ok(laborSrc.includes('formatLaborJeDescription'), 'labor.formatLaborJeDescription');
ok(laborSrc.includes('writePersonLaborLedger'), 'labor.writePersonLaborLedger');
ok(laborSrc.includes('retirePersonLaborForEntries'), 'labor.retirePersonLaborForEntries');
ok(laborSrc.includes('resolvePersonPayableAccount'), 'uses person payable resolver');
ok(engAdvSrc.includes('absorbLaborJournal'), 'engine-advanced uses absorbLaborJournal');
ok(engAdvSrc.includes('retirePersonLaborForEntries'), 'engine-advanced retires person ledger');
ok(engSrc.includes('absorbLaborJournal'), 'engine uses absorbLaborJournal');
ok(engSrc.includes('retirePersonLaborForEntries'), 'engine retires person ledger');
ok(appJs.includes('شخص (بستانکار دستمزد)'), 'UI label person creditor');
ok(appJs.includes('بستانکار حساب شخص'), 'Help mentions person credit');
ok(swSrc.includes('erp-taranom-v419'), 'SW v419');
ok(idxSrc.includes('app.js?v=419'), 'index cache bust v419');
ok(accSrc.includes('با `person_id`'), 'accounting-events PRD-03 person variant');

const desc = (() => {
  try {
    const { formatLaborJeDescription } = require('../lib/production/labor');
    return formatLaborJeDescription({
      orderNo: 'PO-T419',
      productCode: 'P-419',
      productName: 'مانتو',
      opName: 'دوخت',
      qty: 10,
      method: 'piece',
      personName: 'کارگر تست',
      amountRial: 1_800_000,
    });
  } catch (e) {
    return '';
  }
})();
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
  formatLaborJeDescription,
  retirePersonLaborForEntries,
} = require('../lib/production/labor');
const { postEvent, dr, cr } = require('../lib/production/posting');

const DATE = '1405/07/23';
const PERIOD = '1405/07';

const coa = '110601009419';
try {
  db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,level) VALUES (?,?,?,?)`)
    .run(coa, 'شخص تست v419', 'asset', 4);
} catch (_) {
  try {
    db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)`)
      .run(coa, 'شخص تست v419', 'asset');
  } catch (__) { /* ignore */ }
}

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
  VALUES ('EMP-V419','other','["employee"]','کارگر v419','09120000419',?,0,1,'کارگر v419')
`).run(coa).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, party_id, active, coa_code)
  VALUES ('کارگر v419','09120000419',?,1,?)
`).run(partyId, coa).lastInsertRowid;

const productId = db.prepare(
  "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'مانتو v419','P-V419',0,0,1)"
).run().lastInsertRowid;

let ccId = db.prepare(`SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1`).get()?.id;
if (!ccId) {
  ccId = db.prepare(`
    INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-V419','دوخت تست',1,'production')
  `).run().lastInsertRowid;
}

const orderNo = 'PO-V419';
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
  productCode: 'P-V419',
  productName: 'مانتو v419',
  opName: 'دوخت',
  qty,
  method: 'piece',
  personName: 'کارگر v419',
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
ok(String(je.description || '').includes('P-V419') || String(je.description || '').includes('مانتو'), 'JE description has product', je?.description);
ok(String(je.description || '').includes('کارگر'), 'JE description has person', je?.description);

const lines = db.prepare(`
  SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id
`).all(jeId);
const crLine = lines.find((l) => Number(l.credit) > 0);
const drLine = lines.find((l) => Number(l.debit) > 0);
ok(drLine && Number(drLine.debit) > 0, 'Dr WIP line');
ok(crLine && String(crLine.account_code) === coa, 'Cr person COA', crLine?.account_code);
ok(!(lines.some((l) => String(l.account_code) === '5201' && Number(l.credit) > 0)), 'no Cr 5201 when person set');

const pl = db.prepare(`
  SELECT * FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).get(personId, laborRow.id);
ok(pl && Math.round(Number(pl.credit) || 0) === amount, 'person_ledger credit = amount', pl?.credit);

const linked = db.prepare('SELECT je_id FROM production_labor_entries WHERE id=?').get(laborRow.id);
ok(Number(linked.je_id) === Number(jeId), 'labor entry linked to JE');

retirePersonLaborForEntries(db, [entry]);
const plAfter = db.prepare(`
  SELECT * FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
`).get(personId, laborRow.id);
ok(!plAfter, 'retire removes person_ledger');

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

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
if (typeof summary === 'function') summary();
process.exit(failed ? 1 : 0);
