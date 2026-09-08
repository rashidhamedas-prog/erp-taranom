/**
 * SW v206 — BOM op person_id + parties live balance
 * Run: node server/scripts/test-bom-person-party-balance-v206.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ BOM person + party balance v206 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const partiesSrc = fs.readFileSync(path.join(__dirname, '../routes/parties.js'), 'utf8');
const partyBooksSrc = fs.readFileSync(path.join(__dirname, '../lib/party-books.js'), 'utf8');
const bomSrc = fs.readFileSync(path.join(__dirname, '../lib/production/bom-advanced.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8');
const laborSrc = fs.readFileSync(path.join(__dirname, '../lib/production/labor.js'), 'utf8');
const fkSrc = fs.readFileSync(path.join(__dirname, '../sync/tables.js'), 'utf8');

ok(appJs.includes("personSelect('pbe-op-person'"), 'UI فیلد شخص در مسیر BOM');
ok(appJs.includes('person_id: personRaw'), 'UI ذخیره person_id عملیات');
ok(appJs.includes('p.balance!=null?p.balance'), 'UI مانده زنده اشخاص');
ok(appJs.includes("entity_type=person&entity_id="), 'گردش شخص غیرمشتری از دفتر مالی');
ok(partiesSrc.includes('applyPartyBalances'), 'GET /parties مانده زنده');
ok(partyBooksSrc.includes('partySignedBalanceMap'), 'party-books map');
ok(schemaSrc.includes("ensureColumn(db, 'bom_operations', 'person_id'"), 'ensureColumn person_id');
ok(bomSrc.includes('person_id') && bomSrc.includes('E_PERSON_NOT_FOUND'), 'add/updateOperation person_id');
ok(laborSrc.includes('personId: op.person_id || null'), 'autoPostLabor person از عملیات');
ok(fkSrc.includes("['bom_operations', 'person_id']"), 'FK_COLUMNS person_id');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-v206-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'test-v206';
process.env.SYNC_ROLE = 'central';

let initDB, getDB;
try {
  ({ initDB, getDB } = require('../db'));
  initDB();
} catch (e) {
  console.log('\nSKIP DB init —', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
const db = getDB();

const { applyPartyBalances, partySignedBalanceMap } = require('../lib/party-books');
const adv = require('../lib/production/bom-advanced');
const bom = require('../lib/production/bom');

const coa = '110601009999';
try {
  db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,level) VALUES (?,?,?,?)`)
    .run(coa, 'تست شخص v206', 'asset', 4);
} catch (_) {
  try {
    db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)`)
      .run(coa, 'تست شخص v206', 'asset');
  } catch (__) { /* schema variants */ }
}

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
  VALUES ('EMP-V206','other','["employee"]','کارگر تست','09120000001',?,0,1,'کارگر تست')
`).run(coa).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, party_id, active, coa_code)
  VALUES ('کارگر تست','09120000001',?,1,?)
`).run(partyId, coa).lastInsertRowid;

db.prepare(`
  INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?, '1405/01/01','manual','manual',1,'بدهی تست',1500000,0,1)
`).run(personId);

const map1 = partySignedBalanceMap(db);
ok(map1.get(Number(partyId)) === 1500000, 'party balance from person_ledger', map1.get(Number(partyId)));

const rows = applyPartyBalances(db, [{ id: partyId, opening_balance: 0 }]);
ok(Number(rows[0].balance) === 1500000, 'applyPartyBalances sets live balance', rows[0].balance);

const cols = db.prepare(`PRAGMA table_info(bom_operations)`).all().map((c) => c.name);
ok(cols.includes('person_id'), 'bom_operations.person_id column exists');

const adminId = 1;
let productId;
try {
  productId = db.prepare(`
    INSERT INTO products (name, code, item_type, is_manufactured, stock, price)
    VALUES ('محصول v206','P-V206','finished',1,0,0)
  `).run().lastInsertRowid;
} catch (_) {
  productId = db.prepare(`INSERT INTO products (name, code) VALUES ('محصول v206','P-V206')`).run().lastInsertRowid;
}

let ccId = db.prepare(`SELECT id FROM cost_centers WHERE is_stage=1 LIMIT 1`).get()?.id;
if (!ccId) {
  ccId = db.prepare(`
    INSERT INTO cost_centers (code, name, is_stage, kind) VALUES ('CC-V206','برش تست',1,'production')
  `).run().lastInsertRowid;
}

const draft = bom.createBom(db, {
  product_id: productId,
  name: 'BOM v206',
  yield_percent: 100,
  has_routing: 1,
  lines: [{ component_product_id: productId, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
}, adminId);

const op = adv.addOperation(db, draft.id, {
  seq: 10,
  cost_center_id: ccId,
  operation_name: 'برش',
  labor_method: 'piece',
  labor_rate_rial: 50000,
  person_id: personId,
}, adminId);
ok(Number(op.person_id) === Number(personId), 'addOperation stores person_id', op.person_id);

const updated = adv.updateOperation(db, draft.id, op.id, { person_id: null });
ok(updated.person_id == null, 'updateOperation clears person_id');

const again = adv.updateOperation(db, draft.id, op.id, { person_id: personId, labor_rate_rial: 60000 });
ok(Number(again.person_id) === Number(personId) && Number(again.labor_rate_rial) === 60000, 'updateOperation sets person_id');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
