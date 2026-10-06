/**
 * In-place edit of receipt/payment documents (cash ops).
 * Run: node server/scripts/test-amend-cash-ops-v322.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-cash-v322-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-amend-cash-ops-v322-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

function jeOf(refType, refId) {
  return db.prepare(`
    SELECT id, entry_date, status, COALESCE(deleted_at,0) AS deleted_at
    FROM journal_entries
    WHERE ref_type=? AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC LIMIT 1
  `).get(refType, refId);
}

function linesOf(refType, refId) {
  const je = jeOf(refType, refId);
  if (!je) return [];
  return db.prepare('SELECT account_code, debit, credit, debit_rial, credit_rial FROM journal_lines WHERE entry_id=? ORDER BY line_no').all(je.id);
}

(async () => {
  const { rialToLedger } = require('../lib/money');
  const { acct } = require('../lib/coa-map');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'amend-v322', device_fingerprint: 'amend-v322-fp',
  }).token;

  const boxCoa = '11013220';
  const bankCoa = '11023220';
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?, 'صندوق تست اصلاح', 'asset', '1101', 3, 1)`).run(boxCoa);
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?, 'بانک تست اصلاح', 'asset', '1102', 3, 1)`).run(bankCoa);
  const boxId = db.prepare(`INSERT INTO cash_boxes (name, active, coa_code, currency, is_foreign) VALUES ('صندوق اصلاح',1,?, 'IRR', 0)`).run(boxCoa).lastInsertRowid;
  const bankId = db.prepare(`INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign) VALUES ('بانک اصلاح','3220','مرکزی',1,?, 'IRR', 0)`).run(bankCoa).lastInsertRowid;
  const custA = db.prepare(`INSERT INTO customers (user_id, biz, phone, status) VALUES (?,?,?,?)`).run(admin.id, 'مشتری الف', '09120000001', 'active').lastInsertRowid;
  const custB = db.prepare(`INSERT INTO customers (user_id, biz, phone, status) VALUES (?,?,?,?)`).run(admin.id, 'مشتری ب', '09120000002', 'active').lastInsertRowid;
  const supA = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی الف')`).run().lastInsertRowid;
  const supB = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی ب')`).run().lastInsertRowid;
  const repId = db.prepare(`
    INSERT INTO users (username,password,name,role,active,commission_basis,commission_cash,commission_cheque)
    VALUES ('rep322','x','نماینده اصلاح','field_sales',1,'collection',10,5)
  `).run().lastInsertRowid;
  const invId = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, type, date, final, pay_type, approved, rows)
    VALUES (?,?,?,?,?,?,?,1,'[]')
  `).run(repId, custA, 'T-322', 'final', '1405/07/14', 1_000_000, 'cash').lastInsertRowid;
  const poId = db.prepare(`
    INSERT INTO purchase_invoices (user_id, supplier_id, num, date, subtotal, final, rows)
    VALUES (?,?,?,?,?,?,?)
  `).run(admin.id, supA, 'PO-322', '1405/07/14', 800_000, 800_000, '[]').lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/purchases', require('../routes/purchases'));
  app.use('/api/expenses', require('../routes/expenses'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const recv = acct(db, 'coa_receivable');
  const created = await api('POST', '/api/accounting/settlements', {
    cust_id: custA, amount: 400_000, pay_type: 'cash', cash_box_id: boxId,
    invoice_id: invId, date: '1405/07/14', note: 'دریافت تست',
  });
  ok(created.status === 200 && created.data.id, 'POST settlement', created.data);
  const sid = created.data.id;
  const jeBefore = jeOf('settlement', sid);
  ok(!!jeBefore, 'settlement has a live journal');

  const other = await api('POST', '/api/accounting/settlements', {
    cust_id: custA, amount: 500_000, pay_type: 'cash', cash_box_id: boxId,
    invoice_id: invId, date: '1405/07/14', note: 'دریافت دوم',
  });
  ok(other.status === 200, 'second settlement on same invoice', other.data);

  const over = await api('PUT', '/api/accounting/settlements/' + sid, {
    cust_id: custA, amount: 600_000, pay_type: 'cash', cash_box_id: boxId,
    invoice_id: invId, date: '1405/07/14', note: 'بیش از سقف',
  });
  ok(over.status === 409, 'over-allocation blocked', over.data);

  const moved = await api('PUT', '/api/accounting/settlements/' + sid, {
    cust_id: custB, amount: 250_000, pay_type: 'bank_transfer', bank_id: bankId,
    invoice_id: null, date: '1405/07/13', note: 'اصلاح طرف و مبلغ',
  });
  ok(moved.status === 200, 'PUT settlement', moved.data);
  const jeAfter = jeOf('settlement', sid);
  ok(jeAfter && jeAfter.id === jeBefore.id, 'journal id unchanged', { before: jeBefore && jeBefore.id, after: jeAfter && jeAfter.id });
  ok(jeAfter && jeAfter.entry_date === '1405/07/13', 'journal date rewritten', jeAfter);
  const jl = linesOf('settlement', sid);
  ok(jl.some((l) => l.account_code === bankCoa && Number(l.debit) === rialToLedger(250_000)), 'bank debit is new amount', jl);
  ok(jl.some((l) => l.account_code === recv.code && Number(l.credit) === rialToLedger(250_000)), 'receivable credit is new amount', jl);
  const led = db.prepare(`
    SELECT * FROM customer_ledger
    WHERE ref_type='settlement' AND ref_id=? AND entry_type='settlement'
  `).all(sid);
  ok(led.length === 1 && Number(led[0].customer_id) === Number(custB) && Math.round(Number(led[0].credit)) === 250_000, 'customer ledger moved', led);
  const row = db.prepare('SELECT * FROM settlements WHERE id=?').get(sid);
  ok(Number(row.cust_id) === Number(custB) && Math.round(Number(row.amount)) === 250_000 && !row.invoice_id, 'settlement row updated', row);
  const bal = db.prepare('SELECT settled_amount, balance_due FROM invoices WHERE id=?').get(invId);
  ok(bal && Math.round(Number(bal.settled_amount)) === 500_000, 'invoice balance dropped the moved receipt', bal);

  const fyBlock = await api('PUT', '/api/accounting/settlements/' + sid, {
    cust_id: custB, amount: 250_000, pay_type: 'bank_transfer', bank_id: bankId,
    date: '1300/01/01', note: 'تاریخ بسته',
  });
  ok(fyBlock.status === 422, 'closed/out-of-year date blocked', fyBlock.data);

  db.prepare(`UPDATE settlements SET note=? WHERE id=?`).run('دریافت هنگام فاکتور — تست', other.data.id);
  const origin = await api('PUT', '/api/accounting/settlements/' + other.data.id, {
    cust_id: custA, amount: 100_000, pay_type: 'cash', cash_box_id: boxId, date: '1405/07/14',
  });
  ok(origin.status === 409, 'invoice-time receipt blocked', origin.data);
  ok(Math.round(Number(db.prepare('SELECT amount FROM settlements WHERE id=?').get(other.data.id).amount)) === 500_000, 'blocked edit did not change amount');

  const chq = await api('POST', '/api/accounting/settlements', {
    cust_id: custA, amount: 120_000, pay_type: 'cheque', bank_id: bankId,
    date: '1405/07/14', note: 'چک',
    cheque_bank: 'ملی', cheque_sayadi: '99887766', cheque_due: '1405/08/01', cheque_number: '12',
  });
  ok(chq.status === 200 && chq.data.id, 'POST cheque receipt', chq.data);
  const chq2 = await api('POST', '/api/accounting/settlements', {
    cust_id: custA, amount: 80_000, pay_type: 'cheque', bank_id: bankId,
    date: '1405/07/14', note: 'چک ۲',
    cheque_bank: 'ملت', cheque_sayadi: '11223344', cheque_due: '1405/08/02',
  });
  ok(chq2.status === 200, 'second cheque', chq2.data);
  const dup = await api('PUT', '/api/accounting/settlements/' + chq2.data.id, {
    cust_id: custA, amount: 80_000, pay_type: 'cheque', bank_id: bankId,
    date: '1405/07/14', cheque_bank: 'ملت', cheque_sayadi: '99887766', cheque_due: '1405/08/02',
  });
  ok(dup.status === 409, 'duplicate sayadi blocked', dup.data);
  db.prepare(`
    INSERT INTO cheque_records (direction, settlement_id, sayadi, amount, lifecycle_status, record_status)
    VALUES ('in', ?, '99887766', 120000, 'deposited', 'posted')
  `).run(chq.data.id);
  const life = await api('PUT', '/api/accounting/settlements/' + chq.data.id, {
    cust_id: custA, amount: 130_000, pay_type: 'cheque', bank_id: bankId,
    date: '1405/07/14', cheque_bank: 'ملی', cheque_sayadi: '99887766', cheque_due: '1405/08/01',
  });
  ok(life.status === 409, 'cheque in collection blocked', life.data);

  const commInv = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, type, date, final, pay_type, approved, rows)
    VALUES (?,?,?,?,?,?,?,1,'[]')
  `).run(repId, custA, 'T-322C', 'final', '1405/07/14', 5_000_000, 'cash').lastInsertRowid;
  const comm = await api('POST', '/api/accounting/settlements', {
    cust_id: custA, amount: 1_000_000, pay_type: 'cash', cash_box_id: boxId,
    invoice_id: commInv, date: '1405/07/14', note: 'وصول پورسانت',
  });
  ok(comm.status === 200, 'collection settlement', comm.data);
  const acc1 = db.prepare(`
    SELECT credit FROM rep_ledger
    WHERE ref_type='settlement' AND ref_id=? AND entry_type='commission_accrual'
  `).get(comm.data.id);
  ok(acc1 && Math.round(Number(acc1.credit)) === 100_000, '10% collection commission', acc1);
  const commPut = await api('PUT', '/api/accounting/settlements/' + comm.data.id, {
    cust_id: custA, amount: 2_000_000, pay_type: 'cash', cash_box_id: boxId,
    invoice_id: commInv, date: '1405/07/14', note: 'وصول پورسانت',
  });
  ok(commPut.status === 200, 'amend collection amount', commPut.data);
  const accLive = db.prepare(`
    SELECT credit FROM rep_ledger
    WHERE ref_type='settlement' AND ref_id=? AND entry_type='commission_accrual'
  `).all(comm.data.id);
  ok(accLive.length === 1 && Math.round(Number(accLive[0].credit)) === 200_000, 'commission rewritten to 20%', accLive);
  const commJe = linesOf('commission_accrual_settlement', comm.data.id);
  ok(commJe.some((l) => Number(l.credit) === rialToLedger(200_000)), 'commission journal matches', commJe);

  const exp = await api('POST', '/api/expenses', {
    category: 'admin', title: 'اجاره', amount: 2_000_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 15_000, date: '1405/07/14', note: 'قبل',
  });
  ok(exp.status === 200 && exp.data.id, 'POST expense', exp.data);
  const expJe = jeOf('expense_payment', exp.data.id);
  const expPut = await api('PUT', '/api/expenses/' + exp.data.id, {
    category: 'admin', title: 'اجاره دفتر', amount: 1_000_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 10_000, date: '1405/07/12', note: 'بعد',
  });
  ok(expPut.status === 200, 'PUT expense', expPut.data);
  const expJe2 = jeOf('expense_payment', exp.data.id);
  ok(expJe2 && expJe.id === expJe2.id, 'expense journal id unchanged');
  const expLines = linesOf('expense_payment', exp.data.id);
  const feeAcct = acct(db, 'coa_bank_fee');
  ok(expLines.some((l) => l.account_code === feeAcct.code && Number(l.debit) === rialToLedger(10_000)), 'fee rewritten', expLines);
  ok(expLines.some((l) => l.account_code === bankCoa && Number(l.credit) === rialToLedger(1_010_000)), 'bank credits amount+fee', expLines);
  ok(expJe2.entry_date === '1405/07/12', 'expense date rewritten', expJe2);

  const supPay = await api('POST', '/api/purchases/payments', {
    supplier_id: supA, amount: 300_000, pay_type: 'cash', cash_box_id: boxId,
    purchase_invoice_id: poId, date: '1405/07/14', note: 'پرداخت',
  });
  ok(supPay.status === 200 && supPay.data.id, 'POST supplier payment', supPay.data);
  const supJe = jeOf('supplier_payment', supPay.data.id);
  const supOver = await api('PUT', '/api/purchases/payments/' + supPay.data.id, {
    supplier_id: supA, amount: 900_000, pay_type: 'cash', cash_box_id: boxId,
    purchase_invoice_id: poId, date: '1405/07/14',
  });
  ok(supOver.status === 409, 'supplier over purchase invoice blocked', supOver.data);
  const supPut = await api('PUT', '/api/purchases/payments/' + supPay.data.id, {
    supplier_id: supB, amount: 180_000, pay_type: 'bank', bank_id: bankId,
    purchase_invoice_id: null, date: '1405/07/14', note: 'انتقال طرف', fee_rial: 0,
  });
  ok(supPut.status === 200, 'PUT supplier payment', supPut.data);
  const supJe2 = jeOf('supplier_payment', supPay.data.id);
  ok(supJe && supJe2 && supJe.id === supJe2.id, 'supplier journal id unchanged');
  const sled = db.prepare(`
    SELECT supplier_id, debit FROM supplier_ledger
    WHERE ref_type='supplier_payment' AND ref_id=? AND entry_type='payment'
  `).get(supPay.data.id);
  ok(sled && Number(sled.supplier_id) === Number(supB) && Math.round(Number(sled.debit)) === 180_000, 'supplier ledger moved', sled);
  const payable = acct(db, 'coa_payable');
  const supLines = linesOf('supplier_payment', supPay.data.id);
  ok(supLines.some((l) => l.account_code === payable.code && Number(l.debit) === rialToLedger(180_000)), 'payable debit rewritten', supLines);
  ok(supLines.some((l) => l.account_code === bankCoa && Number(l.credit) === rialToLedger(180_000)), 'supplier bank credit rewritten', supLines);

  db.prepare(`INSERT INTO rep_advances (rep_id, amount, settled_amount, date, note) VALUES (?,?,0,'1405/07/01','مساعده')`).run(repId, 300_000);
  const inc = await api('POST', '/api/accounting/incentive-payments', {
    rep_id: repId, amount: 500_000, pay_type: 'cash', cash_box_id: boxId, date: '1405/07/14', note: 'انگیزه',
  });
  ok(inc.status === 200 && inc.data.id, 'POST incentive', inc.data);
  const adv1 = db.prepare('SELECT settled_amount FROM rep_advances WHERE rep_id=?').get(repId);
  ok(adv1 && Math.round(Number(adv1.settled_amount)) === 300_000, 'advance settled on create', adv1);
  const incJe = jeOf('incentive_payment', inc.data.id);
  const incPut = await api('PUT', '/api/accounting/incentive-payments/' + inc.data.id, {
    rep_id: repId, amount: 100_000, pay_type: 'bank', bank_id: bankId, fee_rial: 2_000,
    date: '1405/07/14', note: 'اصلاح انگیزه',
  });
  ok(incPut.status === 200, 'PUT incentive', incPut.data);
  const incJe2 = jeOf('incentive_payment', inc.data.id);
  ok(incJe && incJe2 && incJe.id === incJe2.id, 'incentive journal id unchanged');
  const adv2 = db.prepare('SELECT settled_amount FROM rep_advances WHERE rep_id=?').get(repId);
  ok(adv2 && Math.round(Number(adv2.settled_amount)) === 100_000, 'advance re-settled to new amount', adv2);
  const paid = db.prepare(`
    SELECT debit FROM rep_ledger
    WHERE ref_type='incentive_payment' AND ref_id=? AND entry_type='commission_paid'
  `).all(inc.data.id);
  ok(paid.length === 1 && Math.round(Number(paid[0].debit)) === 100_000, 'one commission_paid row', paid);
  const incLines = linesOf('incentive_payment', inc.data.id);
  ok(incLines.some((l) => l.account_code === bankCoa && Number(l.credit) === rialToLedger(102_000)), 'incentive bank is amount+fee', incLines);

  const gone = await api('DELETE', '/api/accounting/settlements/' + sid);
  ok(gone.status === 200, 'void settlement');
  const again = await api('PUT', '/api/accounting/settlements/' + sid, {
    cust_id: custB, amount: 10_000, pay_type: 'cash', cash_box_id: boxId, date: '1405/07/14',
  });
  ok(again.status === 400, 'reversed settlement cannot be edited', again.data);

  db.prepare(`UPDATE journal_entries SET status='reversed', deleted_at=1 WHERE ref_type='expense_payment' AND ref_id=?`).run(exp.data.id);
  const noJe = await api('PUT', '/api/expenses/' + exp.data.id, {
    category: 'admin', title: 'اجاره دفتر', amount: 1_000_000, pay_type: 'bank', bank_id: bankId, date: '1405/07/12',
  });
  ok(noJe.status === 409, 'missing journal blocks edit', noJe.data);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
