'use strict';
/**
 * v285 — no reverse vouchers, multi salary rulings, periodic warehouse close.
 * Run: node server/scripts/test-payroll-wh-v285.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `erp-v285-${Date.now()}.sqlite`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-v285';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { reverseJournalEntry, purgeHistoricalReversalDocs } = require('../lib/void-journal');
const { postToLedger } = require('../lib/ledger');
const { resolveActiveRuling, assertRulingDatesAllowed, personHasPayrollInMonth } = require('../lib/payroll/rulings');
const { closePeriodicWarehouse, getWarehouseSystem } = require('../lib/inventory/periodic-close');

console.log('══ v285 payroll / void / warehouse ══');

// 1) reverseJournalEntry does not create a reverse row
const je = postToLedger(db, {
  sourceType: 'manual', sourceId: 1, date: '1405/01/15',
  description: 'تست سند', createdBy: 1,
  lines: [
    { code: '1101', name: 'صندوق', debit: 100, credit: 0 },
    { code: '4101', name: 'فروش', debit: 0, credit: 100 },
  ],
});
ok(je > 0, 'posted sample JE');
reverseJournalEntry(db, je, { userId: 1, reason: 'تست' });
const revCount = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE description LIKE 'ابطال سند #%'").get().c;
ok(revCount === 0, 'no reverse voucher created');
const orig = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(je);
ok(orig.status === 'reversed' && Number(orig.deleted_at) > 0, 'original soft-voided');

// 2) historical purge
db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, status, created_by)
  VALUES ('1405/01/20','ابطال سند #${je} — قدیمی','manual_reversal',1,'approved',1)
`).run();
const purged = purgeHistoricalReversalDocs(db);
ok(purged.purged >= 1, 'historical reverse docs purged');
ok(db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE description LIKE 'ابطال سند #%' AND COALESCE(deleted_at,0)=0").get().c === 0,
  'no live reverse docs remain');

// 3) multiple rulings + latest in range
const personId = db.prepare("INSERT INTO persons (name, active) VALUES ('تست حقوق',1)").run().lastInsertRowid;
db.prepare(`
  INSERT INTO salary_structures
    (person_id,fiscal_year,wage_basis,base_wage_rial,active,effective_from,effective_to,issue_date)
  VALUES (?,1405,'monthly',10000000,1,'1405/01/01','1405/03/31','1405/01/01')
`).run(personId);
db.prepare(`
  INSERT INTO salary_structures
    (person_id,fiscal_year,wage_basis,base_wage_rial,active,effective_from,effective_to,issue_date)
  VALUES (?,1405,'monthly',20000000,1,'1405/04/01',NULL,'1405/04/01')
`).run(personId);
const early = resolveActiveRuling(db, personId, { start_date: '1405/02/01', end_date: '1405/02/31', fiscal_year: 1405 });
const late = resolveActiveRuling(db, personId, { start_date: '1405/05/01', end_date: '1405/05/31', fiscal_year: 1405 });
ok(early && early.base_wage_rial === 10000000, 'ruling for Farvardin-Khordad');
ok(late && late.base_wage_rial === 20000000, 'latest ruling from Tir');

const periodId = db.prepare(`
  INSERT INTO payroll_periods (fiscal_year,month_no,label,start_date,end_date)
  VALUES (1405,2,'1405/02','1405/02/01','1405/02/31')
`).run().lastInsertRowid;
db.prepare(`
  INSERT INTO payroll_records (person_id, period_id, period_label, date, gross_pay, net_pay, paid, status)
  VALUES (?,?, '1405/02','1405/02/31',100,90,0,'posted')
`).run(personId, periodId);
ok(personHasPayrollInMonth(db, personId, 1405, 2), 'payroll month detected');
let blocked = false;
try {
  assertRulingDatesAllowed(db, personId, '1405/02/10', '1405/02/10', null);
} catch (e) {
  blocked = e.code === 'E_PAYROLL_MONTH_LOCKED';
}
ok(blocked, 'new ruling blocked in posted month');

// 4) periodic warehouse close
const whId = db.prepare(`
  INSERT INTO warehouses (name, inventory_system) VALUES ('انبار ادواری تست','periodic')
`).run().lastInsertRowid;
ok(getWarehouseSystem(db, whId) === 'periodic', 'warehouse system periodic');
const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
const prodId = db.prepare('INSERT INTO products (user_id, name, warehouse_id, stock) VALUES (?,?,?,0)').run(userId, 'کالای تست ادواری', whId).lastInsertRowid;
const closed = closePeriodicWarehouse(db, {
  warehouseId: whId,
  periodLabel: '1405/01',
  startDate: '1405/01/01',
  endDate: '1405/01/31',
  beginningInventoryRial: 1000000,
  purchasesRial: 500000,
  counts: [{ product_id: prodId, qty: 2, unit_cost_rial: 400000 }],
  userId,
});
ok(closed.cogs_rial === 700000, 'COGS = BI+Purchases-EI (1_000_000+500_000-800_000)');
ok(closed.journal_entry_id > 0, 'adjustment JE posted');

// 5) postToLedger(*_reversal) must soft-void, not mint a reverse voucher
const je2 = postToLedger(db, {
  sourceType: 'manual', sourceId: 99, date: '1405/02/01',
  description: 'سند برای ابطال', createdBy: 1,
  lines: [
    { code: '1101', name: 'صندوق', debit: 50, credit: 0 },
    { code: '4101', name: 'فروش', debit: 0, credit: 50 },
  ],
});
const viaPost = postToLedger(db, {
  sourceType: 'manual_reversal', sourceId: 99, date: '1405/02/02',
  description: 'درخواست ابطال', createdBy: 1,
  lines: [
    { code: '4101', name: 'فروش', debit: 50, credit: 0 },
    { code: '1101', name: 'صندوق', debit: 0, credit: 50 },
  ],
});
ok(viaPost === je2, 'postToLedger reversal soft-voids original id');
ok(db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE ref_type='manual_reversal' AND COALESCE(deleted_at,0)=0").get().c === 0,
  'no live manual_reversal voucher');
const j2 = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(je2);
ok(j2.status === 'reversed' && Number(j2.deleted_at) > 0, 'original voided via postToLedger guard');

console.log(`\nv285: ${passed} passed, ${failed} failed`);
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
process.exit(failed ? 1 : 0);
