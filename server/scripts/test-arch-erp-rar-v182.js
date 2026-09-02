'use strict';
/**
 * ARCH-ERP-RAR v182: invoice print totals, orders warehouse columns,
 * party↔employee projection, purchase-return line key, frontend contracts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'arch-erp-rar-v182-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'arch-erp-rar-v182-secret-32chars!!';

const { computePrintTotals, renderInvoicePrintHtml } = require('../lib/invoice-print');
const { purchaseLineKey } = require('../routes/purchases');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

const t1 = computePrintTotals({
  subtotal: 100000, disc: 0, disc_amt: 0, final: 115000,
  freight_amount: 10000, vat_amount: 5000, vat_rate: 10, type: 'normal',
}, [{ qty: 2, price: 50000, disc: 0, sum: 100000 }]);
ok('print rowsNet from lines', t1.rowsNet === 100000);
ok('print freight+vat in totals', t1.freight === 10000 && t1.vat === 5000);
ok('print payable from header final', t1.payable === 115000);
ok('print no false mismatch', t1.mismatch === false);

const t2 = computePrintTotals({
  subtotal: 999999, disc_amt: 0, final: 200,
}, [{ qty: 1, price: 200, sum: 200 }]);
ok('print mismatch when header≠rows', t2.mismatch === true);

const html = renderInvoicePrintHtml({
  inv: {
    num: 'T-1', type: 'normal', date: '1405/01/01',
    subtotal: 1000, disc: 0, disc_amt: 0, final: 1300,
    freight_amount: 200, vat_amount: 100, cust_biz: 'آزمایش',
  },
  rows: [{ name: 'کالا', qty: 1, price: 1000, sum: 1000 }],
  settings: { company_name: 'ترنم', invoice_paper_size: 'A5' },
  paper: 'A5',
});
ok('print A5 empty colspan 6', html.includes('colspan="6"') || html.includes('جمع اقلام'));
ok('print shows freight line', html.includes('کرایه حمل'));
ok('print shows VAT line', html.includes('ارزش افزوده'));
ok('print labels normal as فاکتور فروش', html.includes('فاکتور فروش'));

ok('line key batch', purchaseLineKey({ product_id: 9, batch_id: 44, color: 'قرمز' }) === 'b44');
ok('line key color', purchaseLineKey({ product_id: 9, color: 'آبی' }) === 'p9:cآبی');
ok('line key product', purchaseLineKey({ product_id: 9 }) === 'p9');

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
ok('orders.warehouse_id column', orderCols.includes('warehouse_id'));
ok('orders.reservation_id column', orderCols.includes('reservation_id'));
const personCols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
const partyCols = db.prepare('PRAGMA table_info(parties)').all().map((c) => c.name);
ok('persons.party_id column', personCols.includes('party_id'));
ok('parties.position_id column', partyCols.includes('position_id'));

const { syncPartyToPerson, ensurePersonParty } = require('../lib/party-employee-sync');
const pos = db.prepare("INSERT INTO person_positions (name) VALUES (?)").run('مدیر تولید-آرچ');
const existingGrp = db.prepare("SELECT id FROM party_groups WHERE name='پرسنل'").get();
const grp = existingGrp || { id: db.prepare("INSERT INTO party_groups (code,name,entity_type) VALUES (99,'پرسنل','person')").run().lastInsertRowid };
const partyIns = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, party_group_id, position_id, is_active)
  VALUES (?,?,?,?,?,?,?,1)
`).run('P-ARCH1', 'other', JSON.stringify(['employee']), 'علی تولید', '09121111111', grp.id, pos.lastInsertRowid);
const personId = syncPartyToPerson(db, partyIns.lastInsertRowid);
const linked = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
ok('party→person projection', !!linked && linked.party_id === partyIns.lastInsertRowid);
ok('party position copied', Number(linked.position_id) === Number(pos.lastInsertRowid));

const emp = db.prepare(`
  INSERT INTO persons (name, phone, personnel_code, employee_no, party_group_id, active)
  VALUES (?,?,?,?,?,1)
`).run('زهرا دوخت', '09122222222', 'EMP-9', 'EMP-9', grp.id);
const backParty = ensurePersonParty(db, emp.lastInsertRowid);
const empRow = db.prepare('SELECT party_id FROM persons WHERE id=?').get(emp.lastInsertRowid);
ok('person→party projection', !!backParty && Number(empRow.party_id) === Number(backParty));

const { runPersonPartyUnifyV1 } = require('../lib/party-employee-sync');
db.prepare("DELETE FROM settings WHERE key='person_party_unify_v1'").run();
const orphan = db.prepare(`
  INSERT INTO persons (name, phone, personnel_code, employee_no, active) VALUES (?,?,?,?,1)
`).run('یتییم آرچ', '09123333333', 'ORPH-1', 'ORPH-1');
const unify1 = runPersonPartyUnifyV1(db);
ok('unify backfill ran', unify1 && unify1.skipped === false);
const orphanLinked = db.prepare('SELECT party_id FROM persons WHERE id=?').get(orphan.lastInsertRowid);
ok('unify linked orphan employee', !!orphanLinked && !!orphanLinked.party_id);
const unify2 = runPersonPartyUnifyV1(db);
ok('unify is idempotent', unify2 && unify2.skipped === true);

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok('convert button in acc invoices tab', appJs.includes('renderSalesInvoicesTab') && appJs.includes('convertProforma((i.id))'));
ok('header warehouse does not wipe lines', appJs.includes('if(force || !r.warehouse_id)'));
ok('picker no longer drops cart', !appJs.includes('با تغییر انبار، اقلام ناسازگار از سبد حذف شدند'));
ok('receipt XOR bank/cash', appJs.includes("(isBank||isCheque)?'flex':'none'") && appJs.includes("isCash?'flex':'none'"));
ok('installment dest forwarded', appJs.includes('bank_id:+r.bank_id||null, cash_box_id:+r.cash_box_id||null'));
ok('party form has organizational position', appJs.includes('pty-position') && appJs.includes('سمت سازمانی'));
ok('purchase return shows color', appJs.includes('رنگ / طاقه') && appJs.includes('data-key='));

try {
  new Function(appJs);
  ok('app.js parses', true);
} catch (e) {
  ok('app.js parses', false, e.message);
}

const { FK_COLUMNS } = require('../sync/tables');
ok('FK persons.party_id appended', FK_COLUMNS.some((x) => x[0] === 'persons' && x[1] === 'party_id'));
ok('FK parties.position_id appended', FK_COLUMNS.some((x) => x[0] === 'parties' && x[1] === 'position_id'));

try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}

console.log(`\narch-erp-rar-v182: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
