#!/usr/bin/env node
/**
 * Dashboard / accounting aggregate scope invariant (v271).
 * Isolated temp SQLite — proves non-admin/accounting never get company-wide folds.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-scope-v271-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';
process.env.SYNC_ROLE = 'central';

const { ok, summary } = require('./lib/test-harness');

for (const rel of [
  '../db',
  '../lib/customer-scope',
  '../lib/customer-books',
  '../lib/sales-document',
]) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}

const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();
const { scopeUserId } = require('../lib/customer-scope');
const { assignCustomerOwner } = require('../lib/customer-scope');
const { canonicalCustomerFold } = require('../lib/customer-books');
const { todayJalali } = require('../jalali');

console.log('══ Dashboard aggregate scope v271 ══');

try {
  const adminId = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('adm271','x','Admin','admin',1)`
  ).run().lastInsertRowid;
  const repA = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('rep271a','x','Aref','field_sales',1)`
  ).run().lastInsertRowid;
  const repB = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('rep271b','x','Bahram','field_sales',1)`
  ).run().lastInsertRowid;
  const mgrId = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('sm271','x','Mgr','sales_manager',1)`
  ).run().lastInsertRowid;

  ok('scopeUserId admin null', scopeUserId({ user: { id: adminId, role: 'admin' } }) == null);
  ok('scopeUserId accounting null', scopeUserId({ user: { id: 9, role: 'accounting' } }) == null);
  ok('scopeUserId field_sales id', scopeUserId({ user: { id: repA, role: 'field_sales' } }) === repA);
  ok('scopeUserId sales_manager scoped', scopeUserId({ user: { id: mgrId, role: 'sales_manager' } }) === mgrId);

  const cA = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to)
     VALUES (?,'CustA','09111111111','active',?,?)`
  ).run(adminId, adminId, null).lastInsertRowid;
  assignCustomerOwner(db, { customerId: cA, ownerUserId: repA, actorId: adminId, note: 't' });

  const cB = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to)
     VALUES (?,'CustB','09111111112','active',?,?)`
  ).run(adminId, adminId, null).lastInsertRowid;
  assignCustomerOwner(db, { customerId: cB, ownerUserId: repB, actorId: adminId, note: 't' });

  const day = todayJalali();
  db.prepare(
    `INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(cA, day, 'opening', 'manual', null, 'A debt', 5_000_000, 0, adminId);
  db.prepare(
    `INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(cB, day, 'opening', 'manual', null, 'B debt', 9_000_000, 0, adminId);

  const company = canonicalCustomerFold(db);
  const foldA = canonicalCustomerFold(db, { userId: repA });
  const foldB = canonicalCustomerFold(db, { userId: repB });
  const foldMgr = canonicalCustomerFold(db, { userId: mgrId });

  ok('company fold includes both', Number(company.display) === 14_000_000);
  ok('rep A fold only A', Number(foldA.display) === 5_000_000);
  ok('rep B fold only B', Number(foldB.display) === 9_000_000);
  ok('sales_manager fold empty (no owned cust)', Number(foldMgr.display) === 0);
  ok('scoped < company', Number(foldA.display) < Number(company.display));

  // Simulate dashboard/summary payload rules
  function summaryFor(role, id) {
    const uid = scopeUserId({ user: { id, role } });
    const companyWide = uid == null;
    const recv = canonicalCustomerFold(db, { userId: uid }).signed;
    return {
      scoped: !companyWide,
      net_receivables_toman: recv,
      cash_bank_balance_rial: companyWide ? 1 : 0,
      today_purchases_toman: companyWide ? 1 : 0,
      net_payables_toman: companyWide ? 1 : 0,
    };
  }
  const sAdmin = summaryFor('admin', adminId);
  const sRep = summaryFor('field_sales', repA);
  const sMgr = summaryFor('sales_manager', mgrId);
  ok('admin summary unscoped', sAdmin.scoped === false && sAdmin.net_receivables_toman === 14_000_000);
  ok('field summary scoped to A', sRep.scoped === true && sRep.net_receivables_toman === 5_000_000);
  ok('field cash/purchases/payables zeroed', sRep.cash_bank_balance_rial === 0 && sRep.today_purchases_toman === 0 && sRep.net_payables_toman === 0);
  ok('sales_manager summary not company', sMgr.scoped === true && sMgr.net_receivables_toman === 0);

  summary();
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
