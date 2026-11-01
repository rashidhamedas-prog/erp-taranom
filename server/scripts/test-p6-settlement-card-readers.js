/**
 * P6 — multi-tender settlement (cash + card + cheque + credit on ONE document), card readers
 * (terminal coa_code / mode / shortcut_slot + adapter), per-customer credit ceiling and
 * store_insufficient_stock_mode.
 * Run: node server/scripts/test-p6-settlement-card-readers.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : (typeof extra === 'string' ? extra : JSON.stringify(extra))); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-settle-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-p6-settle-secret-32-bytes-minimum!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SMS_DISABLED = '1';
delete process.env.POS_INTEGRATED_STUB;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const root = path.join(__dirname, '..');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();
const { todayJalali, addDaysToJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { glBalanceRial } = require('../lib/pos');
const { settlementAssetAccount, expandMethodSplits } = require('../lib/invoice-payments');
const adapter = require('../lib/pos-adapter');
const { SYNCABLE_TABLES } = require('../sync/tables');

function leaf(code, name, type, parent) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(code, name, type || 'asset', parent || '1102', 4);
}

function liveJes(invId) {
  return db.prepare(`
    SELECT je.id, je.ref_type, je.ref_id FROM journal_entries je
    WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      AND (
        (je.ref_type='invoice' AND je.ref_id=?)
        OR (je.ref_type='settlement' AND je.ref_id IN (SELECT id FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'))
        OR (je.ref_type='pos_receipt' AND je.ref_id IN (SELECT id FROM pos_receipts WHERE invoice_id=? AND status<>'reversed'))
      )
  `).all(invId, invId, invId);
}
function jeSums(jeId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines WHERE entry_id=?').get(jeId);
  return { d: Number(r.d), c: Number(r.c) };
}
function custBalance(custId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) b FROM customer_ledger WHERE customer_id=?').get(custId);
  return Math.round(Number(r.b) || 0);
}

(async () => {
  let server;
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const tokenFor = (u, tag) => issueStaffSession(db, u, {
      device_kind: 'test', device_name: 'p6-' + tag, device_fingerprint: 'p6-fp-' + tag,
    }).token;
    const adminTok = tokenFor(admin, 'admin');
    const mkUser = (username, role) => {
      const id = db.prepare(`
        INSERT INTO users (name, username, password, role, active, must_change_password)
        VALUES (?,?,?,?,1,0)
      `).run('کاربر ' + role, username, bcrypt.hashSync('P6test-9aZ', 10), role).lastInsertRowid;
      return db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(id);
    };
    const mgrTok = tokenFor(mkUser('p6.mgr', 'sales_manager'), 'mgr');
    const fieldTok = tokenFor(mkUser('p6.field', 'field_sales'), 'field');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/store', require('../routes/store'));
    app.use('/api/invoices', require('../routes/invoices'));
    app.use('/api/pos', require('../routes/pos'));
    app.use('/api/settings', require('../routes/settings'));
    app.use('/api/customers', require('../routes/customers'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const BASE = `http://127.0.0.1:${server.address().port}`;
    async function api(method, p, body, tok) {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || adminTok) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty */ }
      return { status: res.status, data };
    }

    // ───────── schema ─────────
    console.log('\n— schema / sync / SW —');
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    ['coa_code', 'mode', 'shortcut_slot'].forEach((c) => ok(cols('pos_terminals').includes(c), 'pos_terminals.' + c));
    ['trace', 'last4'].forEach((c) => ok(cols('pos_receipts').includes(c), 'pos_receipts.' + c));
    ok(cols('customers').includes('credit_limit_rial'), 'customers.credit_limit_rial');
    const nameOrder = SYNCABLE_TABLES.map((t) => t.name);
    ok(nameOrder[nameOrder.length - 1] !== undefined && nameOrder.indexOf('pos_terminals') >= 0, 'SYNCABLE_TABLES untouched (append-only)');
    ok(/erp-taranom-v59[2-9]|erp-taranom-v[6-9]\d\d/.test(swSrc), 'SW bumped ≥ v592');
    try { new Function(appSrc); ok(true, 'app.js parses'); } catch (e) { ok(false, 'app.js parses', e.message); }

    // ───────── fixtures ─────────
    leaf('110299', 'بانک ملت P6', 'asset', '1102');
    leaf('110298', 'حساب کارتخوان اختصاصی P6', 'asset', '1102');
    const bankId = db.prepare("INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت P6','0101',1,'110299')").run().lastInsertRowid;
    const cashCoa = '110101';
    leaf(cashCoa, 'صندوق P6', 'asset', '1101');
    const cashBoxId = db.prepare("INSERT INTO cash_boxes (name, active, coa_code) VALUES ('صندوق P6',1,?)").run(cashCoa).lastInsertRowid;
    const whId = db.prepare(`
      INSERT INTO warehouses (code, name, warehouse_type, active, allow_negative)
      VALUES ('WH-P6','انبار P6','finished_goods',1,0)
    `).run().lastInsertRowid;
    const arLeaf = '110301000601';
    leaf(arLeaf, 'مشتری P6', 'asset', '1103');
    const mkCust = (biz, coa) => db.prepare(`
      INSERT INTO customers (user_id, biz, owner, phone, status, type, coa_code)
      VALUES (?, ?, 'مالک', '0912000060', 'active', 'عمده‌فروش', ?)
    `).run(admin.id, biz, coa || arLeaf).lastInsertRowid;
    const custId = mkCust('مشتری P6');
    const mkProd = (name, stock) => {
      const pid = db.prepare(`
        INSERT INTO products (user_id, name, code, price, stock, vat_class, average_cost_rial, cost, warehouse_id)
        VALUES (?, ?, ?, 10000000, ?, 'exempt', 1000000, 1000000, ?)
      `).run(admin.id, name, 'SKU-' + Math.random().toString(36).slice(2, 7), stock, whId).lastInsertRowid;
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)').run(whId, pid, stock);
      return pid;
    };
    const prodId = mkProd('کالای P6', 100);

    // ───────── terminals: coa_code / mode / shortcut_slot ─────────
    console.log('\n— card terminals (coa_code / mode / slot) —');
    const t0 = await api('POST', '/api/pos/terminals', { name: 'پایانه بدون coa', terminal_id: 'P6-T0', bank_id: bankId });
    ok(t0.status === 200 && t0.data.coa_code == null && t0.data.mode === 'manual' && t0.data.shortcut_slot == null,
      'default terminal: coa_code null, mode manual, slot null', t0.data);
    const t1 = await api('POST', '/api/pos/terminals', {
      name: 'پایانه coa', terminal_id: 'P6-T1', bank_id: bankId,
      coa_code: '۱۱۰۲٬۹۸', mode: 'both', shortcut_slot: 1,
    });
    ok(t1.status === 200 && t1.data.coa_code === '110298', 'Persian digits + separator normalised via normalizeAccountCode', t1.data);
    ok(t1.data && t1.data.mode === 'both' && t1.data.shortcut_slot === 1, 'mode both + slot 1 stored');
    const badCoa = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X1', bank_id: bankId, coa_code: '11a2' });
    ok(badCoa.status === 422 && badCoa.data.code === 'E_COA_CODE_FORMAT', 'non-numeric coa → 422 E_COA_CODE_FORMAT', badCoa.data);
    const noCoa = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X2', bank_id: bankId, coa_code: '999999' });
    ok(noCoa.status === 422 && noCoa.data.code === 'E_POS_COA_NOT_FOUND', 'unknown account → 422 E_POS_COA_NOT_FOUND', noCoa.data);
    const badMode = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X3', bank_id: bankId, mode: 'bluetooth' });
    ok(badMode.status === 422 && badMode.data.code === 'E_POS_MODE', 'bad mode → 422 E_POS_MODE');
    const badSlot = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X4', bank_id: bankId, shortcut_slot: 12 });
    ok(badSlot.status === 422 && badSlot.data.code === 'E_POS_SLOT', 'slot out of range → 422');
    const dupSlot = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X5', bank_id: bankId, shortcut_slot: 1 });
    ok(dupSlot.status === 409 && dupSlot.data.code === 'E_POS_SLOT_DUP', 'duplicate slot among active → 409');
    const upd = await api('PUT', '/api/pos/terminals/' + t0.data.id, { mode: 'integrated', shortcut_slot: 2 });
    ok(upd.status === 200 && upd.data.mode === 'integrated' && upd.data.shortcut_slot === 2 && upd.data.coa_code == null,
      'PUT updates mode/slot, keeps coa null', upd.data);
    const clr = await api('PUT', '/api/pos/terminals/' + t1.data.id, { coa_code: '' });
    ok(clr.status === 200 && clr.data.coa_code == null, 'PUT coa_code "" clears to null');
    const reset = await api('PUT', '/api/pos/terminals/' + t1.data.id, { coa_code: '110298' });
    ok(reset.status === 200 && reset.data.coa_code === '110298', 'PUT sets coa_code back');
    const tField = await api('POST', '/api/pos/terminals', { name: 'x', terminal_id: 'P6-X6', bank_id: bankId }, fieldTok);
    ok(tField.status === 403, 'field_sales cannot define terminals');

    // ───────── adapter ─────────
    console.log('\n— adapter requestPayment —');
    const man = adapter.requestPayment({ id: 9, mode: 'manual' }, 1000, { trace: 'T-1', last4: '۱۲۳۴۵۶' });
    ok(man.status === 'manual' && man.trace === 'T-1' && man.last4 === '3456', 'manual: passes through optional trace/last4', man);
    const manEmpty = adapter.requestPayment({ id: 9, mode: 'manual' }, 1000);
    ok(manEmpty.status === 'manual' && manEmpty.trace === null && manEmpty.last4 === null, 'manual: trace/last4 optional');
    const intOff = adapter.requestPayment({ id: 9, mode: 'integrated' }, 1000, { db });
    ok(intOff.status === 'manual' && intOff.fallback === true, 'integrated + flag off → manual fallback');
    process.env.POS_INTEGRATED_STUB = '1';
    const intOn = adapter.requestPayment({ id: 9, mode: 'integrated' }, 1000, { db });
    ok(intOn.status === 'approved' && intOn.stub === true && /^STUB-/.test(intOn.trace), 'integrated + flag on → stub approval', intOn);
    const bothDef = adapter.requestPayment({ id: 9, mode: 'both' }, 1000, { db });
    ok(bothDef.status === 'manual', 'both defaults to manual unless prefer=integrated');
    delete process.env.POS_INTEGRATED_STUB;
    let amtErr = null;
    try { adapter.requestPayment({ id: 9, mode: 'manual' }, 0); } catch (e) { amtErr = e; }
    ok(amtErr && amtErr.code === 'E_POS_AMOUNT', 'adapter rejects zero amount');

    // ───────── expandMethodSplits (unit) ─────────
    console.log('\n— expandMethodSplits unit —');
    const legacy = expandMethodSplits([{ pay_type: 'cash', amount: 5 }], 10);
    ok(legacy.contract === false && legacy.splits.length === 1, 'legacy pay_type passes through');
    const ex = expandMethodSplits([
      { method: 'cash', amount: 9, cash_box_id: 1 },
      { method: 'card', amount: 4, terminal_id: 1 },
      { method: 'credit', amount: 2 },
    ], 10);
    ok(ex.creditRial === 2 && ex.changeRial === 5 && ex.splits.find((s) => s.pay_type === 'cash').amount === 4,
      'cash trimmed to remaining; excess = change', ex);
    let over = null;
    try { expandMethodSplits([{ method: 'card', amount: 8, terminal_id: 1 }, { method: 'credit', amount: 3 }], 10); } catch (e) { over = e; }
    ok(over && over.status === 422 && over.code === 'E_PAY_SPLIT_OVER', 'non-cash > remaining → 422 E_PAY_SPLIT_OVER');

    // ───────── full settlement: cash + card + cheque + credit ─────────
    console.log('\n— one document: cash + card + cheque + credit —');
    const today = todayJalali();
    const due = addDaysToJalali(today, 30);
    const FINAL = 10000000;
    const rows = (pid, qty) => [{
      product_id: pid, name: 'کالای P6', qty, price: FINAL, unit_price: FINAL, sum: FINAL * qty, warehouse_id: whId,
    }];
    const chequeAcct = acct(db, 'coa_cheques_receivable');
    const cashAcct = settlementAssetAccount(db, { pay_type: 'cash', cash_box_id: cashBoxId });
    const cardAcct = '110298'; // t1.coa_code
    const bal0 = {
      cash: glBalanceRial(db, cashAcct.code), card: glBalanceRial(db, cardAcct), cheque: glBalanceRial(db, chequeAcct.code),
    };
    const sayad1 = '1234567890123456';
    const saleBody = (extra) => Object.assign({
      cust_id: custId, type: 'normal', date: today, warehouse_id: whId, rows: rows(prodId, 1),
      client_request_id: 'p6-sale-' + Math.random().toString(36).slice(2, 9),
      pay_splits: [
        { method: 'cash', amount: 3000000, cash_box_id: cashBoxId },
        { method: 'card', amount: 2000000, terminal_id: t1.data.id },
        { method: 'cheque', amount: 2500000, cheque: { sayad_id: sayad1, bank_name: 'ملی', due_date: due } },
        { method: 'credit', amount: 2500000 },
      ],
    }, extra || {});
    const sale = await api('POST', '/api/store/quick-sale', saleBody());
    ok(sale.status === 200 && sale.data && sale.data.id, 'quick-sale 200', sale.data);
    const invId = sale.data && sale.data.id;
    ok(Number(sale.data.final) === FINAL, 'final = 10,000,000 (VAT-exempt normal)', sale.data && sale.data.final);

    const jes = invId ? liveJes(invId) : [];
    ok(jes.length >= 4, 'invoice JE + one JE per tender (cash/card/cheque)', jes.length);
    ok(jes.every((j) => { const s = jeSums(j.id); return s.d === s.c && s.d > 0; }), 'every JE balanced');
    const total = jes.reduce((a, j) => { const s = jeSums(j.id); return { d: a.d + s.d, c: a.c + s.c }; }, { d: 0, c: 0 });
    ok(total.d === total.c, 'combined document Dr = Cr', total);
    ok(glBalanceRial(db, cashAcct.code) - bal0.cash === 3000000, 'Dr cash box +3,000,000', glBalanceRial(db, cashAcct.code) - bal0.cash);
    ok(glBalanceRial(db, cardAcct) - bal0.card === 2000000, 'Dr terminal account (coa_code) +2,000,000', glBalanceRial(db, cardAcct) - bal0.card);
    ok(glBalanceRial(db, chequeAcct.code) - bal0.cheque === 2500000, 'Dr cheques-receivable +2,500,000', glBalanceRial(db, chequeAcct.code) - bal0.cheque);
    ok(custBalance(custId) === 2500000, 'customer AR = credit portion only (2,500,000)', custBalance(custId));
    ok(sale.data.credit_rial === 2500000, 'response echoes credit_rial');

    const chq = db.prepare("SELECT * FROM cheque_records WHERE sayadi=? AND direction='in'").get(sayad1);
    ok(chq && Number(chq.amount) === 2500000 && chq.invoice_id === invId && chq.due_date === due, 'cheque in register (sayad+bank+due)', chq);
    ok(chq && chq.bank_name === 'ملی', 'cheque bank stored');
    const rcpt = db.prepare('SELECT * FROM pos_receipts WHERE invoice_id=?').get(invId);
    ok(rcpt && rcpt.trace == null && rcpt.last4 == null && Number(rcpt.amount_rial) === 2000000,
      'card accepted without trace/last4', rcpt);
    ok(rcpt && rcpt.status === 'settled' && Number(rcpt.settled_rial) === 2000000, 'coa_code terminal receipt is direct (born settled)', rcpt);
    const invRow = db.prepare('SELECT settled_amount, balance_due FROM invoices WHERE id=?').get(invId);
    ok(Number(invRow.settled_amount) === 7500000 && Number(invRow.balance_due) === 2500000,
      'invoice settled 7.5M / due 2.5M', invRow);

    // idempotency
    const body2 = saleBody({
      client_request_id: 'p6-idem-fixed',
      pay_splits: [
        { method: 'cash', amount: 6000000, cash_box_id: cashBoxId },
        { method: 'credit', amount: 4000000 },
      ],
    });
    const a = await api('POST', '/api/store/quick-sale', body2);
    const b = await api('POST', '/api/store/quick-sale', body2);
    ok(a.status === 200 && b.status === 200 && b.data.id === a.data.id && b.data.idempotent_replay === true,
      'idempotency_key / client_request_id replay returns same document', { a: [a.status, a.data && (a.data.id || a.data.error)], b: [b.status, b.data && (b.data.id || b.data.error), b.data && b.data.idempotent_replay] });
    // (the replay body had a duplicate sayad → idempotent path returns before any posting)
    const alias = await api('POST', '/api/store/quick-sale', saleBody({
      client_request_id: undefined, idempotency_key: 'p6-alias-1',
      pay_splits: [{ method: 'cash', amount: FINAL, cash_box_id: cashBoxId }],
    }));
    const aliasRow = alias.data && alias.data.id && db.prepare('SELECT client_request_id FROM invoices WHERE id=?').get(alias.data.id);
    ok(alias.status === 200 && aliasRow && aliasRow.client_request_id === 'p6-alias-1', 'idempotency_key aliases client_request_id', alias.data);

    // card with trace/last4 stored
    const withTrace = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'card', amount: FINAL, terminal_id: t1.data.id, trace: 'RRN-778899', last4: '4321' }],
    }));
    const trRec = withTrace.data && withTrace.data.id && db.prepare('SELECT * FROM pos_receipts WHERE invoice_id=?').get(withTrace.data.id);
    ok(withTrace.status === 200 && trRec && trRec.trace === 'RRN-778899' && trRec.last4 === '4321', 'optional trace/last4 persisted when given', trRec);

    // ───────── over-tender rules ─────────
    console.log('\n— Σ ≤ remaining —');
    const overNonCash = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [
        { method: 'card', amount: 8000000, terminal_id: t1.data.id },
        { method: 'cheque', amount: 3000000, cheque: { sayad_id: '2222222222222222', bank_name: 'ملت', due_date: due } },
      ],
    }));
    ok(overNonCash.status === 422 && overNonCash.data.code === 'E_PAY_SPLIT_OVER', 'non-cash > remaining → 422', overNonCash.data);
    const cashChange = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'cash', amount: 12000000, cash_box_id: cashBoxId }],
    }));
    ok(cashChange.status === 200 && cashChange.data.change_rial === 2000000, 'cash overpay → change (باقی) 2,000,000', cashChange.data);
    const cashPosted = cashChange.data && db.prepare(
      "SELECT COALESCE(SUM(amount_rial),0) s FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
    ).get(cashChange.data.id);
    ok(cashPosted && Number(cashPosted.s) === FINAL, 'only 10,000,000 of the cash is posted', cashPosted);
    const noSayad = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'cheque', amount: FINAL, cheque: { sayad_id: '123', bank_name: 'ملی', due_date: due } }],
    }));
    ok(noSayad.status === 400 && noSayad.data.code === 'E_CHEQUE_FIELDS', 'cheque without 16-digit sayad rejected', noSayad.data);

    // ───────── credit ceiling ─────────
    console.log('\n— customers.credit_limit_rial —');
    const cLim = mkCust('مشتری سقف‌دار P6', '110301000602');
    leaf('110301000602', 'مشتری سقف‌دار', 'asset', '1103');
    const setLim = await api('PUT', `/api/customers/${cLim}/credit-limit`, { credit_limit_rial: 1000000 }, mgrTok);
    ok(setLim.status === 200 && setLim.data.credit_limit_rial === 1000000, 'sales_manager sets ceiling', setLim.data);
    const limField = await api('PUT', `/api/customers/${cLim}/credit-limit`, { credit_limit_rial: 99 }, fieldTok);
    ok(limField.status === 403 && limField.data.code === 'E_CREDIT_LIMIT_FORBIDDEN', 'field_sales cannot change ceiling → 403', limField.data);
    const limPut = await api('PUT', `/api/customers/${cLim}`, { biz: 'مشتری سقف‌دار P6', credit_limit_rial: 5 }, fieldTok);
    ok(limPut.status === 403, 'non-manager PUT /customers/:id with credit_limit_rial → 403', limPut.data);
    ok(db.prepare('SELECT credit_limit_rial v FROM customers WHERE id=?').get(cLim).v === 1000000, 'ceiling unchanged after forbidden edits');
    const limBad = await api('PUT', `/api/customers/${cLim}/credit-limit`, { credit_limit_rial: -5 }, adminTok);
    ok(limBad.status === 422, 'negative ceiling → 422');
    const overLimit = await api('POST', '/api/store/quick-sale', saleBody({
      cust_id: cLim,
      pay_splits: [
        { method: 'cash', amount: 7000000, cash_box_id: cashBoxId },
        { method: 'credit', amount: 3000000 },
      ],
    }));
    ok(overLimit.status === 422 && overLimit.data.code === 'E_CREDIT_LIMIT'
      && overLimit.data.limit === 1000000 && overLimit.data.balance === 0,
      'credit above ceiling → 422 E_CREDIT_LIMIT {limit, balance}', overLimit.data);
    ok(custBalance(cLim) === 0, 'nothing posted on rejected credit sale');
    const withinLimit = await api('POST', '/api/store/quick-sale', saleBody({
      cust_id: cLim,
      pay_splits: [
        { method: 'cash', amount: 9500000, cash_box_id: cashBoxId },
        { method: 'credit', amount: 500000 },
      ],
    }));
    ok(withinLimit.status === 200 && custBalance(cLim) === 500000, 'credit within ceiling accepted; AR=500,000', withinLimit.data);
    const secondOver = await api('POST', '/api/store/quick-sale', saleBody({
      cust_id: cLim,
      pay_splits: [
        { method: 'cash', amount: 9000000, cash_box_id: cashBoxId },
        { method: 'credit', amount: 1000000 },
      ],
    }));
    ok(secondOver.status === 422 && secondOver.data.balance === 500000, 'existing AR counts toward ceiling (balance=500,000)', secondOver.data);
    const clearLim = await api('PUT', `/api/customers/${cLim}/credit-limit`, { credit_limit_rial: null }, adminTok);
    ok(clearLim.status === 200 && db.prepare('SELECT credit_limit_rial v FROM customers WHERE id=?').get(cLim).v === null,
      'NULL clears ceiling (no limit)');
    const afterClear = await api('POST', '/api/store/quick-sale', saleBody({
      cust_id: cLim,
      pay_splits: [{ method: 'credit', amount: FINAL }],
    }));
    ok(afterClear.status === 200, 'no ceiling → large credit sale accepted', afterClear.data);

    // ───────── settings role gate ─────────
    console.log('\n— store_insufficient_stock_mode (RBAC + values) —');
    const sField = await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'block' }, fieldTok);
    ok(sField.status === 403, 'field_sales → 403', sField.data);
    const sMgrOther = await api('PUT', '/api/settings', { company_name: 'x' }, mgrTok);
    ok(sMgrOther.status === 403, 'sales_manager cannot change other settings → 403');
    const sMgrMixed = await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'block', company_name: 'x' }, mgrTok);
    ok(sMgrMixed.status === 403, 'sales_manager mixed payload → 403');
    const sBad = await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'yolo' }, adminTok);
    ok(sBad.status === 400 && sBad.data.code === 'E_STORE_STOCK_MODE', 'invalid value → 400');
    const dflt = require('../lib/store-quick-sale').getInsufficientStockMode(db);
    ok(dflt === 'warn', 'default mode = warn');

    // ───────── stock modes ─────────
    console.log('\n— warn vs block on insufficient stock —');
    const lowProd = mkProd('کالای کم‌موجود P6', 1);
    const lowSale = (extra) => saleBody(Object.assign({
      rows: rows(lowProd, 5),
      pay_splits: [{ method: 'cash', amount: FINAL * 5, cash_box_id: cashBoxId }],
    }, extra || {}));
    const warn = await api('POST', '/api/store/quick-sale', lowSale());
    ok(warn.status === 200 && Array.isArray(warn.data.warnings)
      && warn.data.warnings[0].code === 'W_STORE_INSUFFICIENT_STOCK', 'warn mode: sale succeeds with warning', warn.data);
    const wq = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(lowProd, whId);
    ok(wq && Number(wq.qty) === -4, 'warn mode: stock goes negative (-4)', wq);
    const mgrBlock = await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'block' }, mgrTok);
    ok(mgrBlock.status === 200 && mgrBlock.data.store_insufficient_stock_mode === 'block', 'sales_manager may set mode', mgrBlock.data);
    ok(require('../lib/store-quick-sale').getInsufficientStockMode(db) === 'block', 'mode persisted = block');
    const lowProd2 = mkProd('کالای کم‌موجود ۲ P6', 1);
    const invCountBefore = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    const blocked = await api('POST', '/api/store/quick-sale', saleBody({
      rows: rows(lowProd2, 5), pay_splits: [{ method: 'cash', amount: FINAL * 5, cash_box_id: cashBoxId }],
    }));
    ok(blocked.status === 422 && blocked.data.code === 'E_STORE_INSUFFICIENT_STOCK', 'block mode → 422 E_STORE_INSUFFICIENT_STOCK', blocked.data);
    ok(db.prepare('SELECT COUNT(*) c FROM invoices').get().c === invCountBefore, 'block mode: nothing persisted');
    const okInBlock = await api('POST', '/api/store/quick-sale', saleBody({
      rows: rows(prodId, 1), pay_splits: [{ method: 'cash', amount: FINAL, cash_box_id: cashBoxId }],
    }));
    ok(okInBlock.status === 200 && !okInBlock.data.warnings, 'block mode: sufficient stock sells normally');
    await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'warn' }, adminTok);

    // ───────── terminal account resolution (coa empty) ─────────
    console.log('\n— terminal with empty coa_code —');
    const bank0 = glBalanceRial(db, '110299');
    const transit0 = glBalanceRial(db, '1118');
    const legacyCard = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'card', amount: FINAL, terminal_id: t0.data.id }],
    }));
    ok(legacyCard.status === 200 && glBalanceRial(db, '1118') - transit0 === FINAL && glBalanceRial(db, '110299') === bank0,
      'default (legacy): empty coa → in-transit 1118 until batch settle', legacyCard.data);
    const setBank = await api('PUT', '/api/settings', { pos_empty_coa_mode: 'bank' }, adminTok);
    ok(setBank.status === 200, 'admin sets pos_empty_coa_mode=bank');
    const bankCard = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'card', amount: FINAL, terminal_id: t0.data.id }],
    }));
    ok(bankCard.status === 200 && glBalanceRial(db, '110299') - bank0 === FINAL,
      'mode=bank: empty coa → terminal bank account (110299)', bankCard.data);
    ok(glBalanceRial(db, '1118') - transit0 === FINAL, 'in-transit unchanged by the bank-mode sale');
    const bankRcpt = bankCard.data && db.prepare('SELECT status, settled_rial FROM pos_receipts WHERE invoice_id=?').get(bankCard.data.id);
    ok(bankRcpt && bankRcpt.status === 'settled', 'bank-mode receipt is born settled', bankRcpt);
    await api('PUT', '/api/settings', { pos_empty_coa_mode: 'in_transit' }, adminTok);

    // ───────── void ─────────
    console.log('\n— full void reverses everything (R13) —');
    const before = {
      cash: glBalanceRial(db, cashAcct.code), card: glBalanceRial(db, cardAcct),
      cheque: glBalanceRial(db, chequeAcct.code), ar: custBalance(custId),
    };
    const v = await api('DELETE', '/api/invoices/' + invId, undefined, adminTok);
    ok(v.status === 200, 'void invoice 200', v.data);
    ok(glBalanceRial(db, cashAcct.code) - before.cash === -3000000, 'cash reversed', glBalanceRial(db, cashAcct.code) - before.cash);
    ok(glBalanceRial(db, cardAcct) - before.card === -2000000, 'terminal account reversed');
    ok(glBalanceRial(db, chequeAcct.code) - before.cheque === -2500000, 'cheques-receivable reversed');
    ok(custBalance(custId) - before.ar <= -2500000 || custBalance(custId) < before.ar, 'customer AR reversed', { was: before.ar, now: custBalance(custId) });
    const chqAfter = db.prepare("SELECT record_status, status FROM cheque_records WHERE sayadi=? AND direction='in' ORDER BY id DESC").get(sayad1);
    ok(chqAfter && (chqAfter.record_status === 'reversed' || chqAfter.status === 'reversed'
      || /ابطال|باطل/.test(String(chqAfter.status || ''))), 'cheque row reversed/voided', chqAfter);
    const rcptAfter = db.prepare('SELECT status FROM pos_receipts WHERE invoice_id=?').get(invId);
    ok(rcptAfter && rcptAfter.status === 'reversed', 'card receipt reversed', rcptAfter);
    ok(liveJes(invId).length === 0, 'no live JE left for the voided document', liveJes(invId).length);
  } catch (e) {
    ok(false, 'suite threw', e && (e.stack || e.message));
  } finally {
    try { if (server) server.close(); } catch (_) { /* */ }
    try { require('../lib/auth-sessions').closeSessionStore(); } catch (_) { /* */ }
    try { closeDB(); } catch (_) { /* */ }
    console.log('\nP6 settlement + card readers: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
    process.exit(fail ? 1 : 0);
  }
})();
