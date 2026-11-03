#!/usr/bin/env node
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v369 — Invoice amend must reverse+repost POS books (pos_receipt JE + customer_ledger),
 * not only patch settlements / balance_due (T-0018 class bug).
 * Run: node server/scripts/test-invoice-amend-pos-v369.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed += 1; console.log('  OK', name); }
  else { failed += 1; console.log(' FAIL', name, extra != null ? String(extra).slice(0, 200) : ''); }
}

const root = path.join(__dirname, '..');
const amendSrc = fs.readFileSync(path.join(root, 'lib', 'amend-invoice.js'), 'utf8');
const voidSrc = fs.readFileSync(path.join(root, 'lib', 'void-settlement.js'), 'utf8');
const posSrc = fs.readFileSync(path.join(root, 'lib', 'pos.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const invRoutes = fs.readFileSync(path.join(root, 'routes', 'invoices.js'), 'utf8');

console.log('\n══ Invoice amend POS books v369 ══\n');

ok(swAtLeast(swSrc, 369), 'SW v369');
ok(amendSrc.includes('touchesPos') && amendSrc.includes('reverseInvoiceTimePaymentsInTx'),
  'amend forces reverse+repost when POS involved');
ok(amendSrc.includes('voidLivePosReceiptsForInvoice'), 'amend voids orphan POS receipts');
ok(voidSrc.includes('findLivePosReceiptForSettlement') && voidSrc.includes('voidReceiptInTx'),
  'settlement reverse delegates POS to voidReceiptInTx');
ok(posSrc.includes('function voidReceiptInTx') && posSrc.includes('idempotency_key=NULL'),
  'voidReceiptInTx clears idempotency for amend recreate');
ok(appSrc.includes('invPayRowsFromLiveReceipts') && appSrc.includes('Always fetch detail'),
  'edit hydrates payments from live receipts');
ok(appSrc.includes('اصلاح پرداخت کارتخوان (v369)'), 'Help mentions POS amend');
ok(invRoutes.includes('loadInvoiceReceipts') && invRoutes.includes('pos_receipts'),
  'GET /invoices/:id returns receipts');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-invoice-amend-pos-v369-secret!!';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-amend-pos-'));
process.env.DB_PATH = path.join(tmp, 't.db');

try {
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const { applyInvoicePaySplits, recomputeInvoiceSettledBalances } = require('../lib/invoice-payments');
  const { rewriteInvoiceTimeSettlements } = require('../lib/amend-invoice');
  const pos = require('../lib/pos');

  const uid = db.prepare(
    "INSERT INTO users(username,password,name,role) VALUES('t369','x','t','admin')"
  ).run().lastInsertRowid;
  const cid = db.prepare(
    "INSERT INTO customers(biz,owner,user_id) VALUES('کیمیا عمومی','O',?)"
  ).run(uid).lastInsertRowid;

  const bankCoa = '1102-v369-pos';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک تست v369', 'asset', '1102', 4);
  const bankId = db.prepare(
    "INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت v369','369',1,?)"
  ).run(bankCoa).lastInsertRowid;
  const termId = db.prepare(
    "INSERT INTO pos_terminals (name, terminal_id, bank_id, active) VALUES ('ترمینال v369','POS-V369',?,1)"
  ).run(bankId).lastInsertRowid;

  // Reproduce T-0018 shape: final 33M, partial POS 600k, then amend to full 33M POS.
  const FINAL = 33_000_000;
  const PARTIAL = 600_000;
  const invId = db.prepare(`
    INSERT INTO invoices(user_id,cust_id,num,date,type,status,final,final_rial,pay_type,settled_amount,balance_due)
    VALUES(?,?,'T-0018','1405/07/20','normal','confirmed',?,?, 'pos_card',?,?)
  `).run(uid, cid, FINAL, FINAL, PARTIAL, FINAL - PARTIAL).lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_ledger(customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES(?,?, 'invoice','invoice',?, 'فاکتور فروش T-0018', ?,0,?)
  `).run(cid, '1405/07/20', invId, FINAL, uid);

  applyInvoicePaySplits(db, {
    invoiceId: invId, custId: cid, date: '1405/07/20', userId: uid, num: 'T-0018',
    splits: [{ pay_type: 'pos_card', amount: PARTIAL, terminal_id: termId }],
  });

  const clAfterPartial = db.prepare(`
    SELECT
      COALESCE(SUM(debit),0) AS d,
      COALESCE(SUM(credit),0) AS c
    FROM customer_ledger WHERE customer_id=?
  `).get(cid);
  ok(Number(clAfterPartial.d) === FINAL, 'invoice debit = final', clAfterPartial.d);
  ok(Number(clAfterPartial.c) === PARTIAL, 'partial POS credit on books', clAfterPartial.c);

  const livePos1 = db.prepare(`
    SELECT id, amount_rial, status FROM pos_receipts
    WHERE invoice_id=? AND COALESCE(status,'open') NOT IN ('reversed','void')
  `).all(invId);
  ok(livePos1.length === 1 && Number(livePos1[0].amount_rial) === PARTIAL, 'one live partial POS', livePos1);

  // Simulate the OLD bug path: settlement amount patched to FINAL while POS stays PARTIAL.
  const sett = db.prepare(`
    SELECT * FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
  `).get(invId);
  db.prepare('UPDATE settlements SET amount=?, amount_rial=? WHERE id=?')
    .run(FINAL, FINAL, sett.id);
  db.prepare('UPDATE invoices SET settled_amount=?, balance_due=? WHERE id=?')
    .run(FINAL, 0, invId);

  const balUi = db.prepare('SELECT settled_amount, balance_due FROM invoices WHERE id=?').get(invId);
  ok(Number(balUi.balance_due) === 0 && Number(balUi.settled_amount) === FINAL,
    'UI/balance_due looks fully paid after stale settlement patch', balUi);
  const clStale = db.prepare(`
    SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS bal FROM customer_ledger WHERE customer_id=?
  `).get(cid);
  ok(Number(clStale.bal) === FINAL - PARTIAL, 'customer books still open by FINAL-PARTIAL', clStale.bal);

  // Correct amend path: rewriteInvoiceTimeSettlements with full POS split.
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(invId);
  db.transaction(() => {
    rewriteInvoiceTimeSettlements(db, {
      row,
      payPlan: {
        splits: [{ pay_type: 'pos_card', amount: FINAL, terminal_id: termId }],
        skipInvoiceCash: true,
      },
      custId: cid,
      date: '1405/07/20',
      userId: uid,
      num: 'T-0018',
      body: { pos_terminal_id: termId },
    });
  })();

  const livePos2 = db.prepare(`
    SELECT id, amount_rial, status FROM pos_receipts
    WHERE invoice_id=? AND COALESCE(status,'open') NOT IN ('reversed','void')
  `).all(invId);
  ok(livePos2.length === 1 && Number(livePos2[0].amount_rial) === FINAL,
    'after amend: one live POS = FINAL', livePos2);

  const reversedPos = db.prepare(`
    SELECT COUNT(*) AS c FROM pos_receipts WHERE invoice_id=? AND status='reversed'
  `).get(invId);
  ok(Number(reversedPos.c) >= 1, 'old POS reversed (audit trail)', reversedPos.c);

  const clAfter = db.prepare(`
    SELECT
      COALESCE(SUM(debit),0) AS d,
      COALESCE(SUM(credit),0) AS c,
      COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS bal
    FROM customer_ledger WHERE customer_id=?
  `).get(cid);
  // Void posts a reversal debit (PARTIAL) then new credit (FINAL); raw sums keep history.
  ok(Number(clAfter.bal) === 0, 'customer net balance 0 after reverse+repost', clAfter);
  ok(Number(clAfter.d) >= FINAL && Number(clAfter.c) >= FINAL,
    'ledger keeps audit trail (debit/credit >= FINAL)', clAfter);

  const posCl = db.prepare(`
    SELECT credit FROM customer_ledger
    WHERE customer_id=? AND ref_type='pos_receipt' AND COALESCE(entry_type,'')<>'reversal'
    ORDER BY id DESC LIMIT 1
  `).get(cid);
  ok(posCl && Number(posCl.credit) === FINAL, 'latest live pos_receipt credit = FINAL', posCl);

  recomputeInvoiceSettledBalances(db, invId);
  const invBal = db.prepare('SELECT settled_amount, balance_due FROM invoices WHERE id=?').get(invId);
  ok(Number(invBal.balance_due) === 0 && Number(invBal.settled_amount) === FINAL,
    'invoice balance_due 0 after recompute', invBal);

  // Idempotency: amend again same amount should still work (key released on void).
  db.transaction(() => {
    rewriteInvoiceTimeSettlements(db, {
      row: db.prepare('SELECT * FROM invoices WHERE id=?').get(invId),
      payPlan: {
        splits: [{ pay_type: 'pos_card', amount: FINAL, terminal_id: termId }],
        skipInvoiceCash: true,
      },
      custId: cid,
      date: '1405/07/20',
      userId: uid,
      num: 'T-0018',
      body: { pos_terminal_id: termId },
    });
  })();
  const livePos3 = db.prepare(`
    SELECT COUNT(*) AS c FROM pos_receipts
    WHERE invoice_id=? AND COALESCE(status,'open') NOT IN ('reversed','void')
  `).get(invId);
  ok(Number(livePos3.c) === 1, 'second amend still one live POS', livePos3.c);
  const cl2 = db.prepare(`
    SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS bal FROM customer_ledger WHERE customer_id=?
  `).get(cid);
  ok(Number(cl2.bal) === 0, 'balance still 0 after second amend', cl2.bal);

  ok(typeof pos.voidReceiptInTx === 'function', 'voidReceiptInTx exported');
} catch (e) {
  ok(false, 'DB scenario', e && (e.stack || e.message));
}

try {
  new Function(appSrc.replace(/^\uFEFF/, ''));
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log(`\n══ Result: ${passed} pass, ${failed} fail ══\n`);
process.exit(failed ? 1 : 0);
