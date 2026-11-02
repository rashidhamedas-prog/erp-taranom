/**
 * P5 — piece/hourly production wage credit by person role (never an asset account).
 *   employee   → coa_payroll_payable (2104) or own leaf under it
 *   contractor → own AP leaf (person / party / linked supplier / new leaf under coa_payable)
 *   reverse    → mirror of the PRD-03 lines
 * Run: node server/scripts/test-prodcycle-p5-labor-credit.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-prodcycle-p5-labor-credit-32chars';

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? JSON.stringify(detail) : ''); }
}

console.log('\n══ P5 production labor credit by person role ══\n');

try {
  const probe = new (require('better-sqlite3'))(':memory:');
  probe.close();
} catch (e) {
  console.log('SKIP SQLite ABI:', e.message);
  process.exit(1);
}

const { freshDb } = require('./lib/test-harness');
const { db, cleanup } = freshDb();
const { acct, clearCoaCache } = require('../lib/coa-map');
const {
  wageAccountClass, classifyLaborPersonRole, resolveLaborPayableForPerson,
} = require('../lib/payroll/person-account');
const { postLabor, absorbLaborJournal, retirePersonLaborForEntries } = require('../lib/production/labor');
const { postEvent, dr, cr } = require('../lib/production/posting');
const { reverseJournalEntry } = require('../lib/void-journal');

const DATE = '1405/08/11';
const PERIOD = '1405/08';
const payrollPayable = String(acct(db, 'coa_payroll_payable').code);
const apControl = String(acct(db, 'coa_payable').code);

function addCoa(code, name, type, parent) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,4)')
    .run(code, name, type, parent || null);
}
let seq = 0;
function addParty(name, roles, coa) {
  seq += 1;
  return db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
    VALUES (?,?,?,?,?,?,0,1,?)
  `).run(`P5-${seq}`, 'other', JSON.stringify(roles), name, `0912000${String(seq).padStart(4, '0')}`, coa, name)
    .lastInsertRowid;
}
function addPerson(name, { partyId = null, coa = null, employmentType = null } = {}) {
  return db.prepare(`
    INSERT INTO persons (name, phone, party_id, active, coa_code, employment_type)
    VALUES (?,?,?,1,?,?)
  `).run(name, '', partyId, coa, employmentType).lastInsertRowid;
}
const personRow = (id) => db.prepare('SELECT * FROM persons WHERE id=?').get(id);

const productId = db.prepare(
  "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'مانتو P5','P-P5',0,0,1)"
).run().lastInsertRowid;
let ccId = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1').get()?.id;
if (!ccId) {
  ccId = db.prepare("INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-P5','دوخت P5',1,'production')")
    .run().lastInsertRowid;
}
const orderId = db.prepare(`
  INSERT INTO production_orders (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date)
  VALUES ('PO-P5',?,100,'in_progress','fixed',?,?)
`).run(productId, ccId, DATE).lastInsertRowid;

function postPiece(personId, qty, rate) {
  const r = postLabor(db, {
    orderId, costCenterId: ccId, personId, method: 'piece', qty, rateRial: rate,
    date: DATE, period: PERIOD, userId: 1, note: `دستمزد P5 شخص ${personId}`,
  });
  const entry = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(r.id);
  const jes = absorbLaborJournal(db, {
    orderId, date: DATE, userId: 1, costCenterId: ccId, wipTafsili: null,
    entries: [entry], descriptionFallback: entry.note, postEvent, dr, cr,
  });
  const jeId = jes[0] && jes[0].je_id;
  const lines = jeId
    ? db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id').all(jeId)
    : [];
  return { entry, jeId, crLine: lines.find((l) => Number(l.credit) > 0), lines };
}
const coaRow = (code) => db.prepare('SELECT code, name, type FROM chart_of_accounts WHERE code=?').get(String(code));

console.log('— account class guard —');
ok(wageAccountClass({ code: '110301000015', type: 'asset' }) === 'asset', '1103 leaf is asset');
ok(wageAccountClass({ code: '110601000102', type: '' }) === 'asset', '1106 leaf (no type) is asset');
ok(wageAccountClass({ code: '210101000001', type: 'liability' }) === 'payable', '2101 leaf is payable');

console.log('— role classification —');
const pEmp = addPerson('کارمند P5', { coa: null, employmentType: 'monthly' });
ok(classifyLaborPersonRole(db, personRow(pEmp)).role === 'employee', 'employment_type monthly → employee');
const pCtr = addPerson('پیمانکار P5', { employmentType: 'contractor' });
ok(classifyLaborPersonRole(db, personRow(pCtr)).role === 'contractor', 'employment_type contractor → contractor');
const pPay = addPerson('حقوق‌بگیر P5');
db.prepare("INSERT INTO payroll_records (person_id, period_label) VALUES (?, '1405/07')").run(pPay);
const payCls = classifyLaborPersonRole(db, personRow(pPay));
ok(payCls.role === 'employee' && payCls.reason === 'payroll_history', 'payroll_records → employee', payCls);
const pUnk = addPerson('نامشخص P5');
const unkCls = classifyLaborPersonRole(db, personRow(pUnk));
ok(unkCls.role === 'contractor' && unkCls.flagged === true, 'no evidence → contractor (flagged)', unkCls);

console.log('— employee → salaries payable —');
addCoa('110601009501', 'کارمند P5 (اشخاص متفرقه)', 'asset', null);
db.prepare('UPDATE persons SET coa_code=? WHERE id=?').run('110601009501', pEmp);
const empPost = postPiece(pEmp, 10, 100000);
ok(empPost.crLine && String(empPost.crLine.account_code) === payrollPayable,
  `employee piece wage → Cr ${payrollPayable}`, empPost.crLine);
ok(!!db.prepare("SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?")
  .get(pEmp, empPost.entry.id), 'employee person_ledger credit written');

console.log('— contractor with asset coa (1103, dual-role party, no supplier) —');
addCoa('110301009502', 'مهدیه تست P5', 'asset', null);
const partyDual = addParty('مهدیه تست P5', ['customer', 'supplier', 'employee'], '110301009502');
const pAsset = addPerson('مهدیه تست P5', { partyId: partyDual, coa: '110301009502' });
const preview = resolveLaborPayableForPerson(db, personRow(pAsset), { allocate: false });
ok(preview.account_code === apControl && preview.reason === 'contractor_payable_control',
  'preview (allocate:false) never writes the chart', preview);
ok(!personRow(pAsset).labor_payable_coa_code, 'preview did not store a leaf');
const assetPost = postPiece(pAsset, 20, 150000);
const storedLeaf = personRow(pAsset).labor_payable_coa_code;
const leafRow = storedLeaf ? coaRow(storedLeaf) : null;
ok(assetPost.crLine && String(assetPost.crLine.account_code) !== '110301009502', 'contractor wage NOT credited to 1103 asset', assetPost.crLine);
ok(leafRow && String(leafRow.code).startsWith(apControl) && wageAccountClass(leafRow) === 'payable',
  `contractor AP leaf allocated under ${apControl}`, leafRow);
ok(assetPost.crLine && String(assetPost.crLine.account_code) === String(storedLeaf), 'Cr = stored contractor leaf', { cr: assetPost.crLine, storedLeaf });
ok(personRow(pAsset).coa_code === '110301009502', 'persons.coa_code untouched (no data rewrite)');
const assetPost2 = postPiece(pAsset, 5, 150000);
ok(String(assetPost2.crLine?.account_code) === String(storedLeaf), 'second posting reuses the same leaf');
ok(!!db.prepare("SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?")
  .get(pAsset, assetPost.entry.id), 'contractor person_ledger credit written');

console.log('— contractor with linked supplier → supplier AP leaf —');
addCoa('110301009503', 'تأمین‌کننده‌کارگر P5', 'asset', null);
const partySup = addParty('تأمین‌کننده‌کارگر P5', ['customer', 'supplier'], '110301009503');
const supId = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('تأمین‌کننده‌کارگر P5').lastInsertRowid;
db.prepare('UPDATE suppliers SET party_id=? WHERE id=?').run(partySup, supId);
const pSup = addPerson('تأمین‌کننده‌کارگر P5', { partyId: partySup, coa: '110301009503' });
const supPost = postPiece(pSup, 4, 200000);
const supCoa = db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supId)?.coa_code;
ok(supCoa && String(supPost.crLine?.account_code) === String(supCoa) && String(supCoa).startsWith(apControl),
  'Cr = linked supplier AP leaf', { cr: supPost.crLine, supCoa });

console.log('— contractor with proper payable coa —');
addCoa('210101009504', 'پیمانکار درست P5', 'liability', null);
const pGood = addPerson('پیمانکار درست P5', { coa: '210101009504', employmentType: 'contractor' });
const goodPost = postPiece(pGood, 3, 120000);
ok(String(goodPost.crLine?.account_code) === '210101009504', 'Cr = person own payable leaf', goodPost.crLine);

console.log('— reverse mirrors the labor JE —');
function liveNet(code) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(jl.credit),0) - COALESCE(SUM(jl.debit),0) AS net
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'approved') NOT IN ('reversed','void')
  `).get(String(code));
  return Math.round(Number(r && r.net) || 0);
}
const wipCode = String(acct(db, 'coa_wip').code);
const leafBefore = liveNet(storedLeaf);
const wipBefore = liveNet(wipCode);
ok(leafBefore === Math.round(Number(assetPost.crLine.credit) + Number(assetPost2.crLine.credit)),
  'leaf live credit = both postings', { leafBefore });
const revId = reverseJournalEntry(db, assetPost.jeId, { userId: 1, date: DATE, reason: 'P5 test' });
retirePersonLaborForEntries(db, [assetPost.entry]);
ok(revId === assetPost.jeId, 'reverse voids the PRD-03 JE (R13 soft-void)', revId);
ok(liveNet(storedLeaf) === leafBefore - Math.round(Number(assetPost.crLine.credit)),
  'contractor leaf credit removed by exactly the reversed amount', { after: liveNet(storedLeaf) });
ok(liveNet(wipCode) === wipBefore + Math.round(Number(assetPost.crLine.credit)),
  'WIP debit removed by the same amount', { wipBefore, after: liveNet(wipCode) });
ok(!db.prepare(`SELECT id FROM person_ledger WHERE person_id=? AND ref_type='production_labor' AND ref_id=?
  AND COALESCE(deleted_at,0)=0`).get(pAsset, assetPost.entry.id), 'person_ledger row retired with the reverse');
ok(liveNet('110301009502') === 0, 'asset 1103 leaf never touched');

console.log('— misconfigured payroll key to an asset → refused —');
const prevPayrollKey = db.prepare("SELECT value FROM settings WHERE key='coa_payroll_payable'").get();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_payroll_payable','1101')").run();
clearCoaCache();
let threw = null;
try { resolveLaborPayableForPerson(db, personRow(pEmp)); } catch (e) { threw = e.code; }
ok(threw === 'E_LABOR_PAYABLE_ASSET', 'asset payroll mapping → E_LABOR_PAYABLE_ASSET', threw);
if (prevPayrollKey) {
  db.prepare("UPDATE settings SET value=? WHERE key='coa_payroll_payable'").run(prevPayrollKey.value);
} else {
  db.prepare("DELETE FROM settings WHERE key='coa_payroll_payable'").run();
}
clearCoaCache();

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
