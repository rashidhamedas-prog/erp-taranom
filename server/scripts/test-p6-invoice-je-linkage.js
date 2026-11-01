/**
 * P6-fix — invoice ⇄ payment-method JE linkage + full reverse on cancel.
 * Mixed split (cash + card without coa_code → 1118 + cheque + credit):
 *   every JE linked to the invoice and balanced; Σ balanced.
 * Cancel (DELETE /invoices/:id, POST /accounting/invoices/:id/cancel, final→proforma revert):
 *   every linked JE reversed, net zero per account, receipts / cheque / customer ledger reversed.
 * Injected failure at the end / inside POS / inside cheque void → full rollback.
 * Run: node server/scripts/test-p6-invoice-je-linkage.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6fix-je-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-p6fix-je-linkage-secret-32-bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SMS_DISABLED = '1';
delete process.env.POS_INTEGRATED_STUB;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const root = path.join(__dirname, '..');
delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();
const { todayJalali, addDaysToJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { settlementAssetAccount } = require('../lib/invoice-payments');
const { collectInvoiceJeLinks, assertInvoiceVoidComplete } = require('../lib/invoice-je-links');

function leaf(code, name, type, parent) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(code, name, type || 'asset', parent || '1102', 4);
}
/** Live GL net per account (rial). */
function glSnapshot() {
  const out = {};
  for (const r of db.prepare(`
    SELECT jl.account_code code, SUM(
      COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0) - COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)
    ) n
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
    GROUP BY jl.account_code
  `).all()) if (Math.round(r.n)) out[r.code] = Math.round(r.n);
  return out;
}
function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = {};
  for (const k of keys) { const v = (b[k] || 0) - (a[k] || 0); if (v) d[k] = v; }
  return d;
}
const CL_LIVE = db.prepare('PRAGMA table_info(customer_ledger)').all().some((c) => c.name === 'deleted_at')
  ? ' AND COALESCE(deleted_at,0)=0' : '';
function custBalance(custId) {
  const r = db.prepare(`SELECT COALESCE(SUM(debit)-SUM(credit),0) b FROM customer_ledger WHERE customer_id=?${CL_LIVE}`).get(custId);
  return Math.round(Number(r.b) || 0);
}
function stockOf(pid, whId) {
  const r = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid, whId);
  return r ? Number(r.qty) : 0;
}
function receiptState(invId) {
  return {
    sett: db.prepare("SELECT COUNT(*) c FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'").get(invId).c,
    pos: db.prepare("SELECT COUNT(*) c FROM pos_receipts WHERE invoice_id=? AND COALESCE(status,'') NOT IN ('reversed','void')").get(invId).c,
    chq: db.prepare("SELECT COUNT(*) c FROM cheque_records WHERE invoice_id=? AND COALESCE(record_status,'posted')<>'reversed'").get(invId).c,
  };
}

(async () => {
  let server;
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const { issueStaffSession } = require('../lib/auth-sessions');
    const tokenFor = (u, tag) => issueStaffSession(db, u, {
      device_kind: 'test', device_name: 'p6fix-' + tag, device_fingerprint: 'p6fix-fp-' + tag,
    }).token;
    const adminTok = tokenFor(admin, 'admin');
    const mkUser = (username, role) => {
      const id = db.prepare(`
        INSERT INTO users (name, username, password, role, active, must_change_password)
        VALUES (?,?,?,?,1,0)
      `).run('کاربر ' + role, username, bcrypt.hashSync('P6fix-9aZ', 10), role).lastInsertRowid;
      return db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(id);
    };
    const accTok = tokenFor(mkUser('p6fix.acc', 'accounting'), 'acc');
    const fieldTok = tokenFor(mkUser('p6fix.field', 'field_sales'), 'field');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/store', require('../routes/store'));
    app.use('/api/invoices', require('../routes/invoices'));
    app.use('/api/pos', require('../routes/pos'));
    app.use('/api/accounting', require('../routes/accounting'));
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

    // ───────── fixtures ─────────
    leaf('110297', 'بانک P6-fix', 'asset', '1102');
    const bankId = db.prepare("INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک P6-fix','0202',1,'110297')").run().lastInsertRowid;
    leaf('110102', 'صندوق P6-fix', 'asset', '1101');
    const cashBoxId = db.prepare("INSERT INTO cash_boxes (name, active, coa_code) VALUES ('صندوق P6-fix',1,'110102')").run().lastInsertRowid;
    const whId = db.prepare(`
      INSERT INTO warehouses (code, name, warehouse_type, active, allow_negative)
      VALUES ('WH-P6FX','انبار P6-fix','finished_goods',1,0)
    `).run().lastInsertRowid;
    const arLeaf = '110301000611';
    leaf(arLeaf, 'مشتری P6-fix', 'asset', '1103');
    const custId = db.prepare(`
      INSERT INTO customers (user_id, biz, owner, phone, status, type, coa_code)
      VALUES (?, 'مشتری P6-fix', 'مالک', '0912000611', 'active', 'عمده‌فروش', ?)
    `).run(admin.id, arLeaf).lastInsertRowid;
    const prodId = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, vat_class, average_cost_rial, cost, warehouse_id)
      VALUES (?, 'کالای P6-fix', 'SKU-P6FX', 10000000, 100, 'exempt', 1000000, 1000000, ?)
    `).run(admin.id, whId).lastInsertRowid;
    db.prepare('INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)').run(whId, prodId, 100);

    const term = await api('POST', '/api/pos/terminals', { name: 'کارتخوان بدون coa', terminal_id: 'P6FX-T0', bank_id: bankId });
    ok(term.status === 200 && term.data.coa_code == null, 'terminal without coa_code', term.data);
    const termId = term.data && term.data.id;

    const today = todayJalali();
    const due = addDaysToJalali(today, 30);
    const FINAL = 10000000;
    const cashAcct = settlementAssetAccount(db, { pay_type: 'cash', cash_box_id: cashBoxId }).code;
    const chequeAcct = acct(db, 'coa_cheques_receivable').code;
    let sayadSeq = 0;
    const nextSayad = () => String(5100000000000000 + (++sayadSeq));
    const mixedSplits = () => [
      { method: 'cash', amount: 3000000, cash_box_id: cashBoxId },
      { method: 'card', amount: 2000000, terminal_id: termId },
      { method: 'cheque', amount: 2500000, cheque: { sayad_id: nextSayad(), bank_name: 'ملی', due_date: due } },
      { method: 'credit', amount: 2500000 },
    ];
    const saleBody = (extra) => Object.assign({
      cust_id: custId, type: 'normal', date: today, warehouse_id: whId,
      rows: [{ product_id: prodId, name: 'کالای P6-fix', qty: 1, price: FINAL, unit_price: FINAL, sum: FINAL, warehouse_id: whId }],
      client_request_id: 'p6fix-' + Math.random().toString(36).slice(2, 10),
      pay_splits: mixedSplits(),
    }, extra || {});

    // ───────── 1. linkage + balance ─────────
    console.log('\n— 1. mixed split: every JE linked to the invoice + balanced —');
    const g0 = glSnapshot();
    const ar0 = custBalance(custId);
    const st0 = stockOf(prodId, whId);
    const saleA = await api('POST', '/api/store/quick-sale', saleBody());
    ok(saleA.status === 200 && saleA.data.id, 'quick-sale (cash+card+cheque+credit) 200', saleA.data);
    const invA = saleA.data && saleA.data.id;
    const LA = collectInvoiceJeLinks(db, invA);
    const kinds = new Set(LA.entries.filter((e) => e.live).map((e) => e.link));
    ok(kinds.has('invoice'), 'invoice JE linked (ref_type=invoice)');
    const settLinked = LA.entries.filter((e) => e.live && e.link === 'settlement');
    ok(settLinked.length === 2, 'cash + cheque settlement JEs linked via settlements.invoice_id', settLinked.length);
    const posLinked = LA.entries.filter((e) => e.live && e.link === 'pos_receipt');
    ok(posLinked.length === 1, 'card JE linked via pos_receipts.invoice_id', posLinked.length);
    const posLines = posLinked[0] ? db.prepare('SELECT account_code, debit_rial FROM journal_lines WHERE entry_id=? AND debit_rial>0').all(posLinked[0].id) : [];
    ok(posLines.length === 1 && posLines[0].account_code === '1118' && Number(posLines[0].debit_rial) === 2000000,
      'card without coa_code → Dr 1118 (in transit) 2,000,000', posLines);
    ok(LA.entries.length >= 4 && LA.all_balanced, 'every linked JE balanced (Dr = Cr)', LA.entries.map((e) => [e.link, e.debit_rial, e.credit_rial]));
    ok(LA.live.balanced && LA.live.debit_rial > 0, 'Σ across all invoice-linked JEs balanced', LA.live);
    ok(LA.receipts_without_je.length === 0, 'no receipt without a linked JE', LA.receipts_without_je);
    const dA = diffSnap(g0, glSnapshot());
    ok(dA[cashAcct] === 3000000, 'GL cash +3,000,000', dA);
    ok(dA['1118'] === 2000000, 'GL 1118 +2,000,000');
    ok(dA[chequeAcct] === 2500000, 'GL cheques receivable +2,500,000');
    ok(dA[arLeaf] === 2500000, 'GL customer AR leaf +2,500,000 (credit part only)');
    ok(Object.values(dA).reduce((a, v) => a + v, 0) === 0, 'GL delta of the sale sums to zero');
    const netLinked = LA.net_by_account;
    ok(Object.keys(dA).every((k) => netLinked[k] === dA[k]) && Object.keys(netLinked).every((k) => dA[k] === netLinked[k]),
      'GL delta == net of invoice-linked JEs (nothing posted outside the link set)', { dA, netLinked });
    ok(custBalance(custId) - ar0 === 2500000, 'customer ledger +2,500,000');

    // endpoint
    const ep = await api('GET', `/api/invoices/${invA}/je-links`, undefined, accTok);
    ok(ep.status === 200 && ep.data && ep.data.all_balanced === true && ep.data.live && ep.data.live.balanced === true
      && Array.isArray(ep.data.entries) && ep.data.entries.length === LA.entries.length, 'GET /invoices/:id/je-links (accounting) 200', ep.data && ep.data.live);
    const epField = await api('GET', `/api/invoices/${invA}/je-links`, undefined, fieldTok);
    ok(epField.status === 403, 'je-links forbidden for field_sales', epField.status);
    let threw = null;
    try { assertInvoiceVoidComplete(db, invA); } catch (e) { threw = e; }
    ok(threw && threw.code === 'E_INVOICE_VOID_INCOMPLETE', 'guard flags a live invoice as not voided');

    // ───────── 2. injected failure at the end → full rollback ─────────
    console.log('\n— 2. rollback: failure after every reverse step —');
    const gBefore = glSnapshot();
    const arBefore = custBalance(custId);
    const stBefore = stockOf(prodId, whId);
    db.exec(`CREATE TEMP TRIGGER p6fix_fail_inv BEFORE UPDATE OF status ON main.invoices
             WHEN NEW.status='reversed' BEGIN SELECT RAISE(ABORT,'P6FIX_INJECTED_INVOICE'); END`);
    const failA = await api('DELETE', '/api/invoices/' + invA);
    db.exec('DROP TRIGGER p6fix_fail_inv');
    ok(failA.status >= 400, 'DELETE fails on injected error', failA);
    ok(JSON.stringify(diffSnap(gBefore, glSnapshot())) === '{}', 'GL untouched after rollback', diffSnap(gBefore, glSnapshot()));
    ok(custBalance(custId) === arBefore, 'customer ledger untouched');
    ok(stockOf(prodId, whId) === stBefore, 'stock untouched');
    const rsA = receiptState(invA);
    ok(rsA.sett >= 2 && rsA.pos === 1 && rsA.chq === 1, 'receipts / card / cheque still live', rsA);
    ok(collectInvoiceJeLinks(db, invA).live.count === LA.live.count, 'all linked JEs still live');

    // ───────── 3. injected failure inside the card void → full rollback ─────────
    console.log('\n— 3. rollback: failure inside card (POS) void must not be swallowed —');
    db.exec(`CREATE TEMP TRIGGER p6fix_fail_pos BEFORE UPDATE OF status ON main.pos_receipts
             WHEN NEW.status='reversed' BEGIN SELECT RAISE(ABORT,'P6FIX_INJECTED_POS'); END`);
    const failPos = await api('DELETE', '/api/invoices/' + invA);
    db.exec('DROP TRIGGER p6fix_fail_pos');
    ok(failPos.status >= 400, 'DELETE fails when card receipt cannot be reversed', failPos);
    const invAfterPos = db.prepare('SELECT status, deleted_at FROM invoices WHERE id=?').get(invA);
    ok(invAfterPos.status !== 'reversed' && !Number(invAfterPos.deleted_at), 'invoice not reversed', invAfterPos);
    ok(JSON.stringify(diffSnap(gBefore, glSnapshot())) === '{}', 'GL untouched (no orphan 1118 / AR)', diffSnap(gBefore, glSnapshot()));
    const rsP = receiptState(invA);
    ok(rsP.sett >= 2 && rsP.pos === 1 && rsP.chq === 1, 'settlements / card / cheque still live', rsP);
    ok(custBalance(custId) === arBefore, 'customer ledger untouched');

    // ───────── 4. injected failure inside the cheque void → full rollback ─────────
    console.log('\n— 4. rollback: failure inside cheque void —');
    db.exec(`CREATE TEMP TRIGGER p6fix_fail_chq BEFORE UPDATE OF record_status ON main.cheque_records
             WHEN NEW.record_status='reversed' BEGIN SELECT RAISE(ABORT,'P6FIX_INJECTED_CHEQUE'); END`);
    const failChq = await api('DELETE', '/api/invoices/' + invA);
    db.exec('DROP TRIGGER p6fix_fail_chq');
    ok(failChq.status >= 400, 'DELETE fails when cheque cannot be reversed', failChq);
    ok(JSON.stringify(diffSnap(gBefore, glSnapshot())) === '{}', 'GL untouched', diffSnap(gBefore, glSnapshot()));
    const rsC = receiptState(invA);
    ok(rsC.sett >= 2 && rsC.pos === 1 && rsC.chq === 1, 'settlements / card / cheque still live', rsC);

    // ───────── 5. DELETE /invoices/:id → full reverse ─────────
    console.log('\n— 5. cancel (DELETE /invoices/:id) reverses every linked JE —');
    const vA = await api('DELETE', '/api/invoices/' + invA);
    ok(vA.status === 200, 'DELETE 200', vA.data);
    const LA2 = collectInvoiceJeLinks(db, invA);
    ok(LA2.entries.length >= LA.entries.length && LA2.live.count === 0, 'no live JE left among invoice-linked JEs', LA2.entries.map((e) => [e.link, e.live]));
    ok(Object.keys(LA2.net_by_account).length === 0, 'net zero on every account of the link set', LA2.net_by_account);
    ok(JSON.stringify(diffSnap(g0, glSnapshot())) === '{}', 'GL back to pre-sale on every account', diffSnap(g0, glSnapshot()));
    ok(custBalance(custId) === ar0, 'customer ledger back to pre-sale', { was: ar0, now: custBalance(custId) });
    ok(stockOf(prodId, whId) === st0, 'stock restored', { was: st0, now: stockOf(prodId, whId) });
    const rsV = receiptState(invA);
    ok(rsV.sett === 0 && rsV.pos === 0 && rsV.chq === 0, 'cash / card / cheque receipts all reversed', rsV);
    ok(db.prepare('SELECT status FROM invoices WHERE id=?').get(invA).status === 'reversed', 'invoice soft-reversed (not deleted)');
    ok(!!db.prepare('SELECT id FROM invoices WHERE id=?').get(invA), 'no physical delete');

    // ───────── 6. accounting cancel path ─────────
    console.log('\n— 6. cancel (POST /accounting/invoices/:id/cancel) —');
    const g6 = glSnapshot();
    const ar6 = custBalance(custId);
    const saleB = await api('POST', '/api/store/quick-sale', saleBody({ type: 'final' }));
    ok(saleB.status === 200 && saleB.data.id, 'final quick-sale 200', saleB.data);
    const invB = saleB.data && saleB.data.id;
    const LB = collectInvoiceJeLinks(db, invB);
    ok(LB.live.count >= 4 && LB.all_balanced && LB.live.balanced, 'final invoice: linked + balanced', LB.live);
    const cB = await api('POST', `/api/accounting/invoices/${invB}/cancel`, {}, accTok);
    ok(cB.status === 200, 'accounting cancel 200', cB.data);
    const LB2 = collectInvoiceJeLinks(db, invB);
    ok(LB2.live.count === 0 && Object.keys(LB2.net_by_account).length === 0, 'all linked JEs reversed', LB2.net_by_account);
    ok(JSON.stringify(diffSnap(g6, glSnapshot())) === '{}', 'GL net zero on every account', diffSnap(g6, glSnapshot()));
    ok(custBalance(custId) === ar6, 'customer ledger net zero');
    const rsB = receiptState(invB);
    ok(rsB.sett === 0 && rsB.pos === 0 && rsB.chq === 0, 'receipts / card / cheque reversed', rsB);

    // ───────── 7. proforma → final (convert) → cancel = back to active proforma ─────────
    console.log('\n— 7. final→proforma revert reverses every payment JE —');
    const g7 = glSnapshot();
    const ar7 = custBalance(custId);
    const st7 = stockOf(prodId, whId);
    const pf = await api('POST', '/api/invoices', saleBody({ type: 'proforma' }));
    ok(pf.status === 200 && pf.data.id && pf.data.type === 'proforma', 'proforma with pay_splits 200', pf.data);
    const invC = pf.data && pf.data.id;
    ok(collectInvoiceJeLinks(db, invC).entries.length === 0, 'proforma has no JE');
    const conv = await api('POST', `/api/invoices/${invC}/convert`, { target_type: 'final' });
    ok(conv.status === 200, 'convert → final 200', conv.data);
    const LC = collectInvoiceJeLinks(db, invC);
    const kindsC = new Set(LC.entries.filter((e) => e.live).map((e) => e.link));
    ok(kindsC.has('invoice') && kindsC.has('settlement') && kindsC.has('pos_receipt'), 'converted: invoice + settlement + card JEs linked', [...kindsC]);
    ok(LC.all_balanced && LC.live.balanced, 'converted: every JE balanced, Σ balanced', LC.live);
    const vC = await api('DELETE', '/api/invoices/' + invC);
    ok(vC.status === 200 && vC.data.restoredToProforma === true, 'cancel converted final → restoredToProforma', vC.data);
    const rowC = db.prepare('SELECT type, converted, status, deleted_at FROM invoices WHERE id=?').get(invC);
    ok(rowC.type === 'proforma' && !rowC.converted && rowC.status !== 'reversed' && !Number(rowC.deleted_at), 'active proforma again', rowC);
    const LC2 = collectInvoiceJeLinks(db, invC);
    ok(LC2.live.count === 0 && Object.keys(LC2.net_by_account).length === 0, 'every linked JE reversed', LC2.net_by_account);
    ok(JSON.stringify(diffSnap(g7, glSnapshot())) === '{}', 'GL net zero on every account', diffSnap(g7, glSnapshot()));
    ok(custBalance(custId) === ar7, 'customer ledger net zero');
    ok(stockOf(prodId, whId) === st7, 'stock restored');
    const rsCv = receiptState(invC);
    ok(rsCv.sett === 0 && rsCv.pos === 0 && rsCv.chq === 0, 'receipts / card / cheque reversed', rsCv);

    // ───────── 8. companion JE keyed on the invoice (legacy cash→AR reclass) ─────────
    console.log('\n— 8. companion invoice_ar_reclass JE is reversed with the invoice —');
    const g8 = glSnapshot();
    const saleD = await api('POST', '/api/store/quick-sale', saleBody({
      pay_splits: [{ method: 'cash', amount: FINAL, cash_box_id: cashBoxId }],
    }));
    ok(saleD.status === 200 && saleD.data.id, 'cash quick-sale 200', saleD.data);
    const invD = saleD.data && saleD.data.id;
    require('../lib/ledger').postToLedger(db, {
      sourceType: 'invoice_ar_reclass', sourceId: invD, date: today, description: 'reclass P6-fix', createdBy: admin.id,
      lines: [
        { code: arLeaf, name: 'AR', debit: 100000, credit: 0 },
        { code: cashAcct, name: 'cash', debit: 0, credit: 100000 },
      ],
    });
    ok(collectInvoiceJeLinks(db, invD).entries.some((e) => e.live && e.link === 'invoice_ar_reclass'), 'reclass JE linked to invoice');
    const vD = await api('DELETE', '/api/invoices/' + invD);
    ok(vD.status === 200, 'DELETE 200', vD.data);
    const LD = collectInvoiceJeLinks(db, invD);
    ok(LD.live.count === 0 && JSON.stringify(diffSnap(g8, glSnapshot())) === '{}', 'reclass reversed too; GL net zero', diffSnap(g8, glSnapshot()));

    // ───────── 9. wiring (help + package) ─────────
    console.log('\n— 8. wiring —');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    ok(pkg.scripts && /test-p6-invoice-je-linkage/.test(pkg.scripts['test:p6-invoice-je-linkage'] || ''), 'package.json test:p6-invoice-je-linkage');
    ok(/test:p6-invoice-je-linkage/.test(pkg.scripts.test || ''), 'npm test chain includes it');
    const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
    ok(/P6-fix/.test(appSrc) && /je-links/.test(appSrc), 'admin help mentions P6-fix + je-links');
  } catch (e) {
    ok(false, 'suite threw', e && (e.stack || e.message));
  } finally {
    try { if (server) server.close(); } catch (_) { /* */ }
    try { require('../lib/auth-sessions').closeSessionStore(); } catch (_) { /* */ }
    try { closeDB(); } catch (_) { /* */ }
    console.log('\nP6-fix invoice JE linkage: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
    process.exit(fail ? 1 : 0);
  }
})();
