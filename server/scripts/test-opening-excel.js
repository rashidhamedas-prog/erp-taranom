#!/usr/bin/env node
/** Smoke test: party + product opening JE from excel-origin flags. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = path.join(os.tmpdir(), 'taranom-opening-' + Date.now() + '.db');
process.env.DB_PATH = tmp;
process.env.JWT_SECRET = 'test-opening-secret-32chars-min!!';
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { postPartyOpeningBalance, postProductOpeningInventory } = require('../lib/opening-post');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger } = require('../lib/money');

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL', msg); failed++; }
  else console.log('OK  ', msg);
}

const party = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, opening_balance, opening_balance_date, account_nature)
  VALUES ('T-001','customer','["customer"]','تست افتتاحیه','09120000001',150000,?, 'debit')
`).run('1405/01/01');

const je1 = postPartyOpeningBalance(db, {
  partyId: party.lastInsertRowid, amountRial: 150000, date: '1405/01/01', userId: 1, srcSystem: 'excel',
});
ok(!!je1, 'party opening JE created');
const row1 = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(je1);
ok(row1.voucher_type === 'opening', 'party voucher_type=opening');
ok(row1.ref_type === 'opening_balance', 'party ref_type=opening_balance');
ok(row1.src_system === 'excel', 'party src_system=excel');

const prod = db.prepare(`
  INSERT INTO products (user_id,name,code,price,cost,stock,stock_alert,unit)
  VALUES (1,'کالای افتتاحیه','OP-1',10000,7000,5,1,'عدد')
`).run();
const je2 = postProductOpeningInventory(db, {
  productId: prod.lastInsertRowid, qty: 5, unitCostRial: 7000, userId: 1, srcSystem: 'excel',
});
ok(!!je2, 'product opening JE created');
const row2 = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(je2);
ok(row2.voucher_type === 'opening', 'product voucher_type=opening');
ok(row2.ref_type === 'opening_inventory', 'product ref_type=opening_inventory');

const inv = acct(db, 'coa_inventory');
const open = acct(db, 'coa_opening_balance');
const je3 = postToLedger(db, {
  sourceType: 'manual_voucher', sourceId: null, date: '1405/01/01',
  description: 'سند دستی تست', createdBy: 1, voucherType: 'manual',
  lines: [
    { code: inv.code, name: inv.name, debit: rialToLedger(1000), credit: 0 },
    { code: open.code, name: open.name, debit: 0, credit: rialToLedger(1000) },
  ],
});
ok(!!je3, 'manual JE created');
ok(db.prepare('SELECT voucher_type FROM journal_entries WHERE id=?').get(je3).voucher_type === 'manual', 'manual voucher_type');

try { fs.unlinkSync(tmp); } catch (_) {}
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nAll opening/excel origin smoke tests passed');
