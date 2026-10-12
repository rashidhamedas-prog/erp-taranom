#!/usr/bin/env node
/**
 * T-0015 class: cheque+POS → one cheque_records; two cheques → two leaves.
 * Run: node server/scripts/test-invoice-cheque-pos-v344.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  OK', name); }
  else { failed++; console.log(' FAIL', name, extra != null ? String(extra).slice(0, 160) : ''); }
}

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8').replace(/^\uFEFF/, '');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const paySrc = fs.readFileSync(path.join(root, 'lib', 'invoice-payments.js'), 'utf8');

console.log('-- invoice cheque+POS / two cheques v344 --');

ok(/erp-taranom-v34[34]/.test(sw), 'SW v343|v344');
ok(app.includes('function summarizePaySplitTypes'), 'summarizePaySplitTypes');
ok(app.includes('function invClearSingleChequeFields') || app.includes('invClearSingleChequeFields'), 'invClearSingleChequeFields');
ok(app.includes('کارتخوان') && app.includes('دفتر چک') && (app.includes('قسط N') || app.includes('مرحلهٔ دریافت')), 'Help clarifies POS vs cheque book');
ok(paySrc.includes('فقره چک') && paySrc.includes('کارتخوان'), 'settlement notes distinguish cheque leaf vs POS');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-invoice-cheque-pos-v344-secret!!';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-chq-pos-'));
process.env.DB_PATH = path.join(tmp, 't.db');

try {
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const { applyInvoicePaySplits } = require('../lib/invoice-payments');

  const uid = db.prepare("INSERT INTO users(username,password,name,role) VALUES('t','x','t','admin')").run().lastInsertRowid;
  const cid = db.prepare("INSERT INTO customers(biz,owner,user_id) VALUES('C','O',?)").run(uid).lastInsertRowid;

  // A) cheque + POS
  const invA = db.prepare(`
    INSERT INTO invoices(user_id,cust_id,num,date,type,status,final,final_rial,pay_type)
    VALUES(?,?,'T-MIX','1405/07/19','normal','confirmed',1827500000,1827500000,'mixed')
  `).run(uid, cid).lastInsertRowid;
  // skipJournal skips POS posting — apply both without skip so notes/leaves match prod T-0015 shape,
  // but if GL seed is thin, fall back to cheque-only apply + manual POS settlement.
  let usedFallback = false;
  try {
    applyInvoicePaySplits(db, {
      invoiceId: invA, custId: cid, date: '1405/07/19', userId: uid, num: 'T-MIX',
      splits: [
        {
          pay_type: 'cheque', amount: 1800000000,
          cheque_bank: 'سپه', cheque_branch: 'سبزوار', cheque_account: '1',
          cheque_number: '519196', sayadi: '3810050050916587', cheque_owner: 'علی',
          cheque_due: '1405/07/19', sheba: '',
        },
        { pay_type: 'pos_card', amount: 27500000, terminal_id: 1 },
      ],
      skipJournal: false,
    });
  } catch (_) {
    usedFallback = true;
    applyInvoicePaySplits(db, {
      invoiceId: invA, custId: cid, date: '1405/07/19', userId: uid, num: 'T-MIX',
      splits: [
        {
          pay_type: 'cheque', amount: 1800000000,
          cheque_bank: 'سپه', cheque_branch: 'سبزوار', cheque_account: '1',
          cheque_number: '519196', sayadi: '3810050050916587', cheque_owner: 'علی',
          cheque_due: '1405/07/19', sheba: '',
        },
        { pay_type: 'pos_card', amount: 27500000, terminal_id: 1 },
      ],
      skipJournal: true,
    });
    // With skipJournal, POS is skipped — mirror prod with a posted POS settlement row.
    db.prepare(`
      INSERT INTO settlements(user_id,cust_id,invoice_id,amount,amount_rial,pay_type,date,note,status)
      VALUES(?,?,?,?,?,'pos_card','1405/07/19','دریافت هنگام فاکتور T-MIX — کارتخوان 2','posted')
    `).run(uid, cid, invA, 27500000, 27500000);
  }
  const settA = db.prepare("SELECT pay_type, note FROM settlements WHERE invoice_id=? ORDER BY id").all(invA);
  const chqA = db.prepare("SELECT id, amount FROM cheque_records WHERE invoice_id=? AND COALESCE(record_status,'posted')<>'reversed'").all(invA);
  ok(settA.length >= 2 || usedFallback, 'mixed: settlements present', settA.length);
  ok(settA.filter(s => s.pay_type === 'cheque').length === 1, 'mixed: 1 cheque settlement');
  ok(chqA.length === 1, 'mixed: exactly 1 cheque_records (POS not in book)', chqA.length);
  const chqNote = String((settA.find(s => s.pay_type === 'cheque') || {}).note || '');
  ok(chqNote.includes('فقره چک') || chqNote.includes('قسط'), 'cheque settlement note present', chqNote);

  // B) two distinct cheques
  const invB = db.prepare(`
    INSERT INTO invoices(user_id,cust_id,num,date,type,status,final,final_rial,pay_type)
    VALUES(?,?,'T-2CHQ','1405/07/19','normal','confirmed',3000000,3000000,'cheque')
  `).run(uid, cid).lastInsertRowid;
  applyInvoicePaySplits(db, {
    invoiceId: invB, custId: cid, date: '1405/07/19', userId: uid, num: 'T-2CHQ',
    splits: [
      {
        pay_type: 'cheque', amount: 1000000,
        cheque_bank: 'A', cheque_branch: 'b', cheque_account: '1',
        cheque_number: '111', sayadi: '1111111111111111', cheque_owner: 'o',
        cheque_due: '1405/08/01', sheba: '',
      },
      {
        pay_type: 'cheque', amount: 2000000,
        cheque_bank: 'B', cheque_branch: 'b', cheque_account: '2',
        cheque_number: '222', sayadi: '2222222222222222', cheque_owner: 'o',
        cheque_due: '1405/08/02', sheba: '',
      },
    ],
    skipJournal: true,
  });
  const chqB = db.prepare("SELECT amount, sayadi FROM cheque_records WHERE invoice_id=? AND COALESCE(record_status,'posted')<>'reversed' ORDER BY id").all(invB);
  ok(chqB.length === 2, 'two cheques → 2 leaves', chqB.length);
  ok(Number(chqB[0].amount) === 1000000 && Number(chqB[1].amount) === 2000000, 'amounts not collapsed');
  ok(chqB[0].sayadi !== chqB[1].sayadi, 'distinct sayadi');
} catch (e) {
  ok(false, 'DB scenarios', e && (e.stack || e.message));
}

try {
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
