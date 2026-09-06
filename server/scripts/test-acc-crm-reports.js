#!/usr/bin/env node
/**
 * ACC-CRM-UNIFY Phase 5 — firm-sale report reconciliation.
 * normal + final both count in revenue/AR; Moadian/pending-approval stay final-only.
 */
'use strict';
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const {
  firmSaleTypeSql, commissionEligibleSql, autoApproveNormalInvoice, FIRM_SALE_TYPE_SQL,
} = require('../lib/sales-document');

console.log('══ ACC-CRM reports firm-sale consistency ══');

ok('FIRM_SALE_TYPE_SQL constant', FIRM_SALE_TYPE_SQL === "type IN ('normal','final')");
ok('firmSaleTypeSql bare', firmSaleTypeSql() === "type IN ('normal','final')");
ok('firmSaleTypeSql alias', firmSaleTypeSql('i') === "i.type IN ('normal','final')");
ok('commissionEligibleSql', commissionEligibleSql().includes("IN ('normal','final')")
  && commissionEligibleSql().includes('approved'));

const { db, cleanup } = freshDb();
try {
  const u = db.prepare(`
    INSERT INTO users (username,password,name,role,active)
    VALUES ('rep_r','x','Rep R','field_sales',1)
  `).run();
  const uid = u.lastInsertRowid;
  const c = db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status)
    VALUES (?,'مشتری گزارش','09151112233','مشهد','active')
  `).run(uid);
  const custId = c.lastInsertRowid;

  const ins = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,vat_amount,approved)
    VALUES (?,?,?,?,?,'[]',?,?,?,?,?,?)
  `);

  // proforma — must NOT enter firm revenue
  ins.run(uid, custId, 'PF-1', 'proforma', '1405/01/01', 100000, 0, 0, 100000, 0, 0);
  // normal 400k — firm + auto-approve
  const n = ins.run(uid, custId, 'N-1', 'normal', '1405/01/02', 400000, 0, 0, 400000, 40000, 0);
  autoApproveNormalInvoice(db, n.lastInsertRowid, uid);
  // final approved 600k — firm
  ins.run(uid, custId, 'F-1', 'final', '1405/01/03', 600000, 0, 0, 600000, 60000, 1);
  // final pending 50k — firm revenue YES, commission NO, pending-approval YES
  ins.run(uid, custId, 'F-P', 'final', '1405/01/04', 50000, 0, 0, 50000, 5000, 0);

  const firmRev = db.prepare(`
    SELECT COALESCE(SUM(final),0) s, COUNT(*) c FROM invoices
    WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
  `).get();
  eq('firm revenue sum', firmRev.s, 400000 + 600000 + 50000);
  eq('firm invoice count', firmRev.c, 3);

  const finalOnlyRev = db.prepare(`
    SELECT COALESCE(SUM(final),0) s FROM invoices
    WHERE type='final' AND COALESCE(deleted_at,0)=0
  `).get().s;
  eq('final-only would miss normal', finalOnlyRev, 600000 + 50000);
  ok('normal included vs final-only gap', firmRev.s - finalOnlyRev === 400000);

  const comm = db.prepare(`
    SELECT COALESCE(SUM(final),0) s, COUNT(*) c FROM invoices
    WHERE ${commissionEligibleSql()} AND COALESCE(deleted_at,0)=0
  `).get();
  eq('commission sum (normal auto + final approved)', comm.s, 400000 + 600000);
  eq('commission count', comm.c, 2);

  const pending = db.prepare(`
    SELECT COUNT(*) c FROM invoices
    WHERE type='final' AND COALESCE(approved,0)=0 AND COALESCE(deleted_at,0)=0
  `).get().c;
  eq('pending official approval stays final-only', pending, 1);

  const seasonal169 = db.prepare(`
    SELECT COALESCE(SUM(final),0) s FROM invoices
    WHERE type='final' AND COALESCE(deleted_at,0)=0
  `).get().s;
  eq('seasonal-169 / Moadian base excludes normal', seasonal169, 650000);

  const normalRow = db.prepare("SELECT approved FROM invoices WHERE num='N-1'").get();
  eq('normal auto-approved', normalRow.approved, 1);

  // Simulate reports/summary + accounting overview shape
  const overviewInvoiced = db.prepare(`
    SELECT COALESCE(SUM(final),0) s FROM invoices
    WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
  `).get().s;
  eq('overview totalInvoiced uses firm', overviewInvoiced, firmRev.s);

  const openInv = db.prepare(`
    SELECT COUNT(*) c FROM invoices i
    WHERE i.cust_id=? AND ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0
  `).get(custId).c;
  eq('open invoices include normal+final', openInv, 3);
} finally {
  cleanup();
}

summary();
