const { swAtLeast } = require('./lib/sw-at-least');
#!/usr/bin/env node
/**
 * v371 — Invoice amend reverse/repost books use invoice date, not today.
 * Run: node server/scripts/test-invoice-amend-date-v371.js
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
const voidSrc = fs.readFileSync(path.join(root, 'lib', 'void-settlement.js'), 'utf8');
const posSrc = fs.readFileSync(path.join(root, 'lib', 'pos.js'), 'utf8');
const amendSrc = fs.readFileSync(path.join(root, 'lib', 'amend-invoice.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

console.log('\n══ Invoice amend books date = invoice date v371 ══\n');

ok(swAtLeast(swSrc, 371), 'SW v371');
ok(voidSrc.includes('opts.date') || voidSrc.includes('options.date'), 'void-settlement accepts date');
ok(posSrc.includes('date: when') && posSrc.includes('String(date || todayJalali())'), 'voidReceiptInTx uses caller date');
ok(amendSrc.includes('reverseInvoiceTimePaymentsInTx(db, invoiceTime, row.id, userId, date)'),
  'amend passes invoice date into reverse');
ok(amendSrc.includes('updateMovementQty(db, mvs[0], newQty, date)'), 'stock qty update keeps invoice date');
ok(appSrc.includes('تاریخ فاکتور') && appSrc.includes('v371'), 'Help mentions invoice-date amend');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-invoice-amend-date-v371-secret!!';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-amend-date-'));
process.env.DB_PATH = path.join(tmp, 't.db');

try {
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const { applyInvoicePaySplits } = require('../lib/invoice-payments');
  const { rewriteInvoiceTimeSettlements } = require('../lib/amend-invoice');
  const { todayJalali } = require('../jalali');

  const today = todayJalali();
  const invDate = '1405/06/01';
  ok(invDate !== today, 'fixture date differs from today', `${invDate} vs ${today}`);

  const uid = db.prepare(
    "INSERT INTO users(username,password,name,role) VALUES('t371','x','t','admin')"
  ).run().lastInsertRowid;
  const cid = db.prepare(
    "INSERT INTO customers(biz,owner,user_id) VALUES('C371','O',?)"
  ).run(uid).lastInsertRowid;

  const bankCoa = '1102-v371-pos';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک تست v371', 'asset', '1102', 4);
  const bankId = db.prepare(
    "INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت v371','371',1,?)"
  ).run(bankCoa).lastInsertRowid;
  const termId = db.prepare(
    "INSERT INTO pos_terminals (name, terminal_id, bank_id, active) VALUES ('ترمینال v371','POS-V371',?,1)"
  ).run(bankId).lastInsertRowid;

  const FINAL = 10_000_000;
  const PARTIAL = 1_000_000;
  const invId = db.prepare(`
    INSERT INTO invoices(user_id,cust_id,num,date,type,status,final,final_rial,pay_type)
    VALUES(?,?,'T-DATE','${invDate}','normal','confirmed',?,?, 'pos_card')
  `).run(uid, cid, FINAL, FINAL).lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_ledger(customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES(?,?, 'invoice','invoice',?, 'فاکتور', ?,0,?)
  `).run(cid, invDate, invId, FINAL, uid);

  applyInvoicePaySplits(db, {
    invoiceId: invId, custId: cid, date: invDate, userId: uid, num: 'T-DATE',
    splits: [{ pay_type: 'pos_card', amount: PARTIAL, terminal_id: termId }],
  });

  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(invId);
  db.transaction(() => {
    rewriteInvoiceTimeSettlements(db, {
      row,
      payPlan: {
        splits: [{ pay_type: 'pos_card', amount: FINAL, terminal_id: termId }],
        skipInvoiceCash: true,
      },
      custId: cid,
      date: invDate,
      userId: uid,
      num: 'T-DATE',
      body: { pos_terminal_id: termId },
    });
  })();

  const rev = db.prepare(`
    SELECT date, debit, credit, entry_type FROM customer_ledger
    WHERE customer_id=? AND ref_type='pos_receipt' AND entry_type='reversal'
    ORDER BY id DESC LIMIT 1
  `).get(cid);
  ok(rev && rev.date === invDate, 'POS void reversal dated as invoice', rev);

  const live = db.prepare(`
    SELECT date, credit FROM customer_ledger
    WHERE customer_id=? AND ref_type='pos_receipt' AND COALESCE(entry_type,'')<>'reversal'
    ORDER BY id DESC LIMIT 1
  `).get(cid);
  ok(live && live.date === invDate && Number(live.credit) === FINAL,
    'new POS credit dated as invoice', live);

  const badToday = db.prepare(`
    SELECT COUNT(*) AS c FROM customer_ledger
    WHERE customer_id=? AND date=? AND ref_type='pos_receipt'
  `).get(cid, today);
  ok(Number(badToday.c) === 0, 'no POS ledger rows stamped with today', badToday);
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
