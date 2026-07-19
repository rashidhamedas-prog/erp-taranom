'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'excel-user-integration-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB } = require('../db');
const { ensureUserParty } = require('../lib/user-party');

initDB();
const db = getDB();

const columns = (table) => new Map(db.prepare(`PRAGMA table_info(${table})`).all().map(c => [c.name, c.type]));
for (const name of ['is_shared', 'created_by']) assert(columns('product_categories').has(name), `product_categories.${name} missing`);
for (const name of ['party_id']) assert(columns('users').has(name), `users.${name} missing`);
for (const name of ['status', 'reversal_journal_id', 'reversed_at', 'reversed_by']) {
  assert(columns('account_transfers').has(name), `account_transfers.${name} missing`);
}

const userResult = db.prepare(
  "INSERT INTO users (name,username,password,role,phone) VALUES (?,?,?,?,?)"
).run('کارشناس آزمایشی', 'excel-user-test', 'not-used', 'field_sales', '09120000000');
const party = ensureUserParty(db, userResult.lastInsertRowid, {
  person: { legal_type: 'real', national_id: '0012345678', city: 'تهران' },
});
const linkedUser = db.prepare('SELECT party_id FROM users WHERE id=?').get(userResult.lastInsertRowid);
assert.strictEqual(linkedUser.party_id, party.id);
assert.strictEqual(party.national_id, '0012345678');
assert.strictEqual(party.city, 'تهران');
assert(JSON.parse(party.party_roles).includes('employee'));
assert(JSON.parse(party.party_roles).includes('marketer'));

const excelRouter = require('../routes/excel');
const { DEFINITIONS, exportRows } = excelRouter._test;
const expectedEntities = [
  'parties', 'products', 'opening-recv-cheques', 'opening-pay-cheques', 'settlements', 'expenses',
  'coa-codes', 'ledger-accounts', 'subsidiary-accounts', 'detail-accounts', 'sales-invoices',
  'purchases', 'sales-returns', 'purchase-returns', 'warehouse-receipt', 'warehouse-issue',
  'warehouse-transfer', 'consignments-in', 'consignments-out', 'journal-docs',
];
assert.deepStrictEqual(Object.keys(DEFINITIONS).sort(), expectedEntities.sort());
for (const entity of expectedEntities) {
  const definition = DEFINITIONS[entity];
  const samples = definition.sampleRows || [definition.sample];
  assert(samples.length && samples.every(row => row && Object.keys(row).length > 0), `${entity} template is empty`);
  assert(Array.isArray(exportRows(db, entity)), `${entity} export failed`);
}

const ui = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const productRoute = fs.readFileSync(path.join(__dirname, '../routes/products.js'), 'utf8');
assert(ui.includes('.btn.excel-btn svg{width:12px;height:12px'), 'minimal Excel icon sizing missing');
for (const label of ['ورودی</button>', 'قالب</button>', 'خروجی</button>']) {
  assert(ui.includes(label), `minimal Excel label missing: ${label}`);
}
assert(productRoute.includes('${categoryAlias}.is_shared=1 OR ${categoryAlias}.created_by=?'), 'product-group visibility filter missing');
assert(ui.includes('id="pc-new-shared"') && ui.includes('id="prg-shared"'), 'product-group sharing control missing');

const routeSources = [
  'accounting.js', 'cheque-records.js', 'expenses.js', 'fixed-assets.js', 'fiscal-year.js',
  'invoices.js', 'payroll.js', 'purchases.js', 'rep-management.js', 'transfers.js', 'warehouses.js',
].map(name => fs.readFileSync(path.join(__dirname, '../routes', name), 'utf8')).join('\n');
assert(!routeSources.includes('createJournalEntry'), 'operational route bypasses postToLedger');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
console.log('✅ Excel, product visibility, user-party and accounting integration tests passed');
