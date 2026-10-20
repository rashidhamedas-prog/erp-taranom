/**
 * SW v501 — dual-role party turnover: one opening + all piece labor wages
 * Run: node server/scripts/test-party-labor-turnover-v501.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-party-labor-turnover-v501-dummy-key-32';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ party labor turnover v501 ══\n');

const turnoverSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const leafSrc = fs.readFileSync(path.join(__dirname, '../lib/party-leaf-sync.js'), 'utf8');
const laborSrc = fs.readFileSync(path.join(__dirname, '../lib/production/labor.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

ok(turnoverSrc.includes('isOpeningTurnoverRow'), 'isOpeningTurnoverRow helper');
ok(turnoverSrc.includes('turnoverRowKey'), 'turnoverRowKey helper');
ok(/ref_type.*opening/.test(turnoverSrc) && turnoverSrc.includes('isOpeningTurnoverRow'), 'strips opening not only opening_balance');
ok(turnoverSrc.includes("personTurn") && turnoverSrc.includes("roles:"), 'multi-role merges person stream');
ok(leafSrc.includes('moneyClose(rows[i], gl)'), 'leaf-sync requires amount match on same ref');
ok(laborSrc.includes('sourceId: e.id'), 'PRD-03 sourceId = labor entry id');
ok(swSrc.includes('erp-taranom-v501'), 'SW v501');
ok(idxSrc.includes('app.js?v=501'), 'index cache bust v501');
ok(appJs.includes('v501') || appJs.includes('گردش شخص'), 'app help present');

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

const { freshDb } = (() => {
  try { return require('./lib/test-harness'); }
  catch (_) { return { freshDb: null }; }
})();

if (!freshDb) {
  console.log('\nSKIP freshDb harness');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { db, cleanup } = freshDb();
const { findUnusedMatch } = (() => {
  // exercise moneyClose path via sync of two labor JEs same order ref
  return { findUnusedMatch: null };
})();

const { absorbLaborJournal, postLabor, formatLaborJeDescription } = require('../lib/production/labor');
const { postEvent, dr, cr } = require('../lib/production/posting');
const { buildPartyTurnover } = require('../lib/party-turnover');
const { syncJournalEntryToPartyBooks } = require('../lib/party-leaf-sync');

const DATE = '1405/07/28';
const PERIOD = '1405/07';
const coaPerson = '110601009501';
const coaSup = '210101009501';

for (const [code, name, type] of [
  [coaPerson, 'شخص v501', 'asset'],
  [coaSup, 'تأمین‌کننده v501', 'liability'],
]) {
  try {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,level) VALUES (?,?,?,?)')
      .run(code, name, type, 4);
  } catch (_) {
    try {
      db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)')
        .run(code, name, type);
    } catch (__) { /* */ }
  }
}

function tableCols(name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
}

const partyCols = tableCols('parties');
{
  const cols = [];
  const vals = [];
  const push = (c, v) => { cols.push(c); vals.push(v); };
  if (partyCols.has('person_code')) push('person_code', 'P-V501');
  if (partyCols.has('party_type')) push('party_type', 'other');
  if (partyCols.has('party_roles')) push('party_roles', '["customer","supplier","employee"]');
  if (partyCols.has('full_name')) push('full_name', 'کارگر v501');
  if (partyCols.has('phone')) push('phone', '09120000501');
  if (partyCols.has('coa_code')) push('coa_code', coaPerson);
  if (partyCols.has('opening_balance')) push('opening_balance', -1000);
  if (partyCols.has('is_active')) push('is_active', 1);
  if (partyCols.has('biz')) push('biz', 'کارگر v501');
  const ph = cols.map(() => '?').join(',');
  var partyId = db.prepare(`INSERT INTO parties (${cols.join(',')}) VALUES (${ph})`).run(...vals).lastInsertRowid;
}

const custCols = tableCols('customers');
{
  const cols = ['user_id', 'biz', 'owner', 'phone'];
  const vals = [1, 'کارگر v501', 'کارگر', '09120000501'];
  if (custCols.has('party_id')) { cols.push('party_id'); vals.push(partyId); }
  if (custCols.has('coa_code')) { cols.push('coa_code'); vals.push(coaPerson); }
  if (custCols.has('status')) { cols.push('status'); vals.push('active'); }
  db.prepare(`INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
const custId = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyId).id;

const supCols = tableCols('suppliers');
{
  const cols = ['name'];
  const vals = ['کارگر v501'];
  if (supCols.has('phone')) { cols.push('phone'); vals.push('09120000501'); }
  if (supCols.has('party_id')) { cols.push('party_id'); vals.push(partyId); }
  if (supCols.has('coa_code')) { cols.push('coa_code'); vals.push(coaSup); }
  if (supCols.has('active')) { cols.push('active'); vals.push(1); }
  if (supCols.has('balance')) { cols.push('balance'); vals.push(0); }
  db.prepare(`INSERT INTO suppliers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
const supId = db.prepare('SELECT id FROM suppliers WHERE party_id=?').get(partyId).id;

const personCols = tableCols('persons');
{
  const cols = ['name'];
  const vals = ['کارگر v501'];
  if (personCols.has('phone')) { cols.push('phone'); vals.push('09120000501'); }
  if (personCols.has('party_id')) { cols.push('party_id'); vals.push(partyId); }
  if (personCols.has('coa_code')) { cols.push('coa_code'); vals.push(coaPerson); }
  if (personCols.has('active')) { cols.push('active'); vals.push(1); }
  var personId = db.prepare(`INSERT INTO persons (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
}

// Customer opening with ref_type=opening (the token multi-role used to keep)
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, ?, 'opening', 'opening', 1, 'مانده اولیه حساب', 0, 1000, 1)
`).run(custId, DATE);

const productId = db.prepare(
  "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'کالا v501','P-V501',0,0,1)"
).run().lastInsertRowid;

let ccId = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1').get()?.id;
if (!ccId) {
  ccId = db.prepare(`
    INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-V501','دوخت',1,'production')
  `).run().lastInsertRowid;
}

const orderId = db.prepare(`
  INSERT INTO production_orders
    (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date, created_by)
  VALUES ('PO-V501',?,?, 'in_progress','fixed',?,?,1)
`).run(productId, 10, ccId, DATE).lastInsertRowid;

const l1 = postLabor(db, {
  orderId, costCenterId: ccId, personId, method: 'piece', qty: 96, rateRial: 2000000,
  date: DATE, period: PERIOD, userId: 1,
  note: formatLaborJeDescription({ orderNo: 'PO-V501', opName: 'دوخت', productName: 'یلدا', qty: 96, method: 'piece', personName: 'کارگر v501', amountRial: 192000000 }),
});
const l2 = postLabor(db, {
  orderId, costCenterId: ccId, personId, method: 'piece', qty: 96, rateRial: 2200000,
  date: DATE, period: PERIOD, userId: 1,
  note: formatLaborJeDescription({ orderNo: 'PO-V501', opName: 'دوخت', productName: 'آبان', qty: 96, method: 'piece', personName: 'کارگر v501', amountRial: 211200000 }),
});

const e1 = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(l1.id);
const e2 = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(l2.id);
const jes = absorbLaborJournal(db, {
  orderId, date: DATE, userId: 1, costCenterId: ccId, wipTafsili: null,
  entries: [e1, e2], descriptionFallback: 'labor', postEvent, dr, cr,
});
ok(jes.length === 2, 'two PRD-03 JEs (one per labor entry)', jes.length);
ok(Number(jes[0].je_id) !== Number(jes[1].je_id), 'distinct JE ids');

const je1 = db.prepare('SELECT ref_id FROM journal_entries WHERE id=?').get(jes[0].je_id);
const je2 = db.prepare('SELECT ref_id FROM journal_entries WHERE id=?').get(jes[1].je_id);
ok(Number(je1.ref_id) === Number(l1.id), 'JE1 ref_id = labor entry 1', je1.ref_id);
ok(Number(je2.ref_id) === Number(l2.id), 'JE2 ref_id = labor entry 2', je2.ref_id);

// Simulate old bump: both JEs wrongly share order ref_id on supplier leaf, sync once
db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(orderId, jes[0].je_id);
db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(orderId, jes[1].je_id);
// Reclass credit to supplier leaf to mimic live bug
for (const jid of [jes[0].je_id, jes[1].je_id]) {
  db.prepare(`
    UPDATE journal_lines SET account_code=?, account_name=?
    WHERE entry_id=? AND COALESCE(credit,0)+COALESCE(credit_rial,0)>0
  `).run(coaSup, 'تأمین‌کننده v501', jid);
  syncJournalEntryToPartyBooks(db, jid);
}
const slCount = db.prepare(`
  SELECT COUNT(*) c FROM supplier_ledger
  WHERE supplier_id=? AND ref_type='production_labor' AND ref_id=?
`).get(supId, orderId).c;
ok(slCount === 2, 'leaf-sync keeps both wages on same order ref_id', slCount);

const turn = buildPartyTurnover(db, partyId);
ok(!!turn && Array.isArray(turn.entries), 'unified turnover built');
const openings = (turn.entries || []).filter((e) =>
  e.source === 'opening_fold' || String(e.ref_type || '').includes('opening')
  || /مانده\s*اول\s*دوره/.test(String(e.description || ''))
);
ok(openings.length <= 1, 'at most one opening row in unified turnover', openings.length);
const laborCredits = (turn.entries || []).filter((e) =>
  String(e.ref_type || '') === 'production_labor' || /دستمزد/.test(String(e.description || ''))
);
const laborCreditSum = laborCredits.reduce((s, e) => s + Math.round(Number(e.credit) || 0), 0);
ok(laborCreditSum >= 192000000 + 211200000 - 1, 'both piece wages visible in unified turnover', laborCreditSum);

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
