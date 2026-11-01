/**
 * v525 — recon false positives found on production + safe inventory fix:
 *  - inventory_vs_gl fix requires an explicit, postable, non-suspense counter account (never 9999)
 *  - documents_without_je: POS settlement (pos_receipts.journal_id) and payroll payment
 *    (journal_id / ref = payroll_record_id) are matched
 *  - movements_without_je: inbound transfer leg found via source_id = move id; same-account
 *    transfers OK; net-zero pairs (incl. id-collision soft matches) are info; phantoms still warn
 *  - document_amount_vs_je: invoice on control 1103 + ar_control_reclass to the leaf matches
 *  - cash_bank: negative cash box → sub_status «صندوق منفی», diff 0
 * Run: node server/scripts/test-subledger-recon-v525.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subledger-recon-v525-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-subledger-recon-v525-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
authMw.auth = (req, _res, next) => { req.user = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; next(); };

const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);
try { require('../lib/inventory/valuation').ensureValuationSchema(db); } catch (_) { /* optional module */ }
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { inventoryAccountForWarehouse } = require('../lib/inventory/ledger');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));

const today = todayJalali();
const check = (code) => ({
  ...recon.runRecon(db, { checks: [code], persist: false }).checks[0],
  rows: recon.checkRows(db, code, { limit: 2000 }).rows,
});

function liveJe(id) {
  const r = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
  return !!r && !Number(r.deleted_at || 0) && !['reversed', 'void'].includes(String(r.status || ''));
}

/** Raw balanced JE (bypasses postToLedger so leaf/control combos are allowed). */
function rawJe(refType, refId, lines) {
  const id = Number(db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
    VALUES (?, 'test v525', ?, ?, ?, 'approved')
  `).run(today, refType, refId, ADMIN.id).lastInsertRowid);
  const lineIds = [];
  let n = 1;
  for (const l of lines) {
    lineIds.push(Number(db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial, line_no)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, l.code, l.code, (l.d || 0) / 10, (l.c || 0) / 10, l.d || 0, l.c || 0, n++).lastInsertRowid));
  }
  return { id, lineIds };
}

let txn = 0;
function ledgerRow({ event, product, wh, qty, amount, st, sid }) {
  txn++;
  return Number(db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, unit_cost_rial, amount_rial,
      source_type, source_id, status, date, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'posted', ?, ?)
  `).run(`V525-${txn}`, event, product, wh, qty > 0 ? qty : 0, qty < 0 ? -qty : 0, Math.round(amount / Math.abs(qty)), amount,
    st, sid, today, ADMIN.id).lastInsertRowid);
}

function coaLeaf(code, name, parent, type) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code, name, type, parent_code) VALUES (?,?,?,?)').run(code, name, type, parent);
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };
  const FIX = '/api/accounting/subledger-recon/inventory_vs_gl/fix';

  try {
    let whA = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
    if (!whA) whA = Number(db.prepare("INSERT INTO warehouses (name) VALUES ('انبار محصول تست')").run().lastInsertRowid);
    const whB = Number(db.prepare("INSERT INTO warehouses (name) VALUES ('انبار فروشگاه تست')").run().lastInsertRowid);
    try { db.prepare('UPDATE warehouses SET warehouse_type=? WHERE id=?').run(db.prepare('SELECT warehouse_type FROM warehouses WHERE id=?').get(whA).warehouse_type, whB); } catch (_) {}
    const invAcct = inventoryAccountForWarehouse(db, whA);
    const opening = acct(db, 'coa_opening_balance');

    // ── 1. inventory_vs_gl counter account ──
    console.log('\n[counter account]');
    postToLedger(db, {
      sourceType: 'manual_test', sourceId: 525, date: today, description: 'تزریق اختلاف موجودی', createdBy: ADMIN.id,
      lines: [
        { code: invAcct.code, name: invAcct.name, debit: rialToLedger(70000), credit: 0 },
        { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(70000) },
      ],
    });
    const r1 = check('inventory_vs_gl');
    ok(r1.status === 'warn' && r1.diff_rial === 70000, 'GL-only injection → R1 warn 70,000', r1);
    const dry = await call('POST', FIX, {});
    const p0 = dry.body && dry.body.plan && dry.body.plan.find((p) => p.account_code === invAcct.code);
    ok(dry.status === 200 && dry.body.dry_run === true && dry.body.counter_required === true && p0 && p0.counter_account === null,
      'dry run without counter: plan has no counter, counter_required', dry.body);
    ok(p0 && p0.adjust_rial === -70000 && p0.lines.every((l) => l.code !== '9999' && l.code !== acct(db, 'coa_adjustment').code),
      'dry run never proposes 9999', p0 && p0.lines);
    const sugg = (dry.body.counter_suggestions || []).map((s) => s.code);
    ok(sugg.includes(opening.code) && !sugg.includes('9999') && !sugg.includes(invAcct.code), 'suggestions include 3102, exclude 9999 + target', sugg);
    const base0 = { dry_run: false, confirm: true, reason: 'اصلاح تست v525' };
    const noCounter = await call('POST', FIX, base0);
    ok(noCounter.status === 400 && noCounter.body.code === 'E_RECON_COUNTER_REQUIRED', 'apply without counter → 400', noCounter.body);
    for (const [code, expect, label] of [
      ['9999', 'E_RECON_COUNTER_FORBIDDEN', '9999'],
      [acct(db, 'coa_labor_control').code, 'E_RECON_COUNTER_FORBIDDEN', 'labor control 5201'],
      [invAcct.code, 'E_RECON_COUNTER_FORBIDDEN', 'same inventory account'],
      ['1100', 'E_RECON_COUNTER_INVALID', 'non-postable parent 1100'],
      ['8877', 'E_RECON_COUNTER_INVALID', 'unknown code'],
    ]) {
      const r = await call('POST', FIX, { ...base0, counter_account: code });
      ok(r.status === 400 && r.body.code === expect, `counter ${label} → ${expect}`, r.body);
    }
    ok(db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE ref_type='inventory_recon_adjust'").get().c === 0, 'rejected applies post nothing');
    const dry2 = await call('POST', FIX, { counter_account: opening.code });
    const p2 = dry2.body.plan.find((p) => p.account_code === invAcct.code);
    ok(p2 && p2.counter_account === opening.code && p2.lines[0].code === opening.code && p2.lines[0].side === 'debit'
      && p2.lines[0].amount_rial === 70000 && p2.lines[1].code === invAcct.code, 'dry run with counter: Dr 3102 / Cr inventory 70,000', p2);
    const perAcct = await call('POST', FIX, { counter_accounts: { [invAcct.code]: '9999' } });
    const pe = perAcct.body.plan.find((p) => p.account_code === invAcct.code);
    ok(pe && pe.counter_error && pe.counter_error.code === 'E_RECON_COUNTER_FORBIDDEN', 'per-account counter validated in plan', pe);
    const applied = await call('POST', FIX, { ...base0, counter_account: opening.code });
    ok(applied.status === 200 && applied.body.applied.length === 1, 'apply with 3102', applied.body);
    const jeId = applied.body.applied && applied.body.applied[0].je_id;
    const jl = jeId ? db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(jeId) : [];
    ok(jl.some((l) => l.account_code === opening.code && Number(l.debit_rial) === 70000)
      && jl.some((l) => l.account_code === invAcct.code && Number(l.credit_rial) === 70000)
      && !jl.some((l) => l.account_code === '9999'), 'JE: Dr 3102 / Cr inventory, no 9999', jl);
    ok(check('inventory_vs_gl').status === 'ok', 'R1 ok after fix');
    const sus = check('suspense_accounts');
    ok(sus.status === 'ok', 'suspense check untouched (nothing on 9999)', sus);
    const rev = await call('POST', `/api/accounting/subledger-recon/fixes/${applied.body.applied[0].fix_id}/reverse`, { reason: 'پاکسازی تست', confirm: true });
    ok(rev.status === 200 && !liveJe(jeId), 'fix reversible');
    const inj = db.prepare("SELECT id FROM journal_entries WHERE ref_type='manual_test' AND ref_id=525").get();
    require('../lib/void-journal').reverseJournalEntry(db, inj.id, { userId: ADMIN.id });

    // ── 2. documents_without_je ──
    console.log('\n[documents without je]');
    db.pragma('foreign_keys = OFF');
    const custId = Number(db.prepare("INSERT INTO customers (user_id, biz, phone, status) VALUES (?, 'مشتری v525', '09150000525', 'active')").run(ADMIN.id).lastInsertRowid);
    const stl = Number(db.prepare("INSERT INTO settlements (user_id, cust_id, amount, pay_type, date) VALUES (?,?,?, 'pos', ?)").run(ADMIN.id, custId, 4300000, today).lastInsertRowid);
    try { db.prepare('UPDATE settlements SET amount_rial=? WHERE id=?').run(43000000, stl); } catch (_) {}
    ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pos_receipts'").get(), 'pos_receipts table present');
    const termId = (() => {
      try { return Number(db.prepare("INSERT INTO pos_terminals (name) VALUES ('کارتخوان تست')").run().lastInsertRowid); } catch (_) { return 1; }
    })();
    const recId = Number(db.prepare(`
      INSERT INTO pos_receipts (terminal_id, date, amount_rial, settlement_id, status) VALUES (?, ?, 43000000, ?, 'open')
    `).run(termId, today, stl).lastInsertRowid);
    const posJe = rawJe('pos_receipt', recId, [{ code: '1118', d: 43000000 }, { code: acct(db, 'coa_receivable').code, c: 43000000 }]);
    db.prepare('UPDATE pos_receipts SET journal_id=? WHERE id=?').run(posJe.id, recId);
    const stlBare = Number(db.prepare("INSERT INTO settlements (user_id, cust_id, amount, pay_type, date) VALUES (?,?,?, 'cash', ?)").run(ADMIN.id, custId, 1000, today).lastInsertRowid);

    const rec1 = Number(db.prepare("INSERT INTO payroll_records (person_id, period_label, net_pay, date) VALUES (1, '1405/06', 10000000, ?)").run(today).lastInsertRowid);
    const rec2 = Number(db.prepare("INSERT INTO payroll_records (person_id, period_label, net_pay, date) VALUES (2, '1405/06', 7820316, ?)").run(today).lastInsertRowid);
    const pay = (rec, amt, journalId) => Number(db.prepare(`
      INSERT INTO payroll_payments (payroll_record_id, amount_rial, pay_type, date, journal_id, status) VALUES (?,?, 'bank', ?, ?, 'posted')
    `).run(rec, amt, today, journalId).lastInsertRowid);
    const bank = opening.code;
    const payJe1 = rawJe('payroll_payment', rec1, [{ code: '2105', d: 100000000 }, { code: bank, c: 100000000 }]);
    const pay1 = pay(rec1, 100000000, payJe1.id);
    rawJe('payroll_payment', rec2, [{ code: '2105', d: 78203160 }, { code: bank, c: 78203160 }]);
    const pay2 = pay(rec2, 78203160, null);
    const deadJe = rawJe('payroll_payment', 999, [{ code: '2105', d: 5000 }, { code: bank, c: 5000 }]);
    db.prepare("UPDATE journal_entries SET status='reversed' WHERE id=?").run(deadJe.id);
    const pay3 = pay(rec1, 5000, deadJe.id);
    db.pragma('foreign_keys = ON');
    const d = check('documents_without_je');
    const ids = new Set(d.rows.map((r) => r.id));
    ok(!ids.has(`settlement:${stl}`), 'POS settlement matched via pos_receipts.journal_id', d.rows);
    ok(ids.has(`settlement:${stlBare}`), 'settlement without any voucher still flagged');
    ok(!ids.has(`payroll_payment:${pay1}`), 'payroll payment matched via journal_id');
    ok(!ids.has(`payroll_payment:${pay2}`), 'payroll payment matched via ref = payroll_record_id');
    ok(ids.has(`payroll_payment:${pay3}`), 'payroll payment whose stored JE is dead still flagged');

    // ── 3. movements_without_je ──
    console.log('\n[movements without je]');
    const mkProd = (code) => Number(db.prepare("INSERT INTO products (user_id, name, code, price, stock, unit) VALUES (?, ?, ?, 0, 0, 'عدد')").run(ADMIN.id, `کالا ${code}`, code).lastInsertRowid);
    const P1 = mkProd('V525-P1'), P2 = mkProd('V525-P2'), P3 = mkProd('V525-P3'), P4 = mkProd('V525-P4'), P5 = mkProd('V525-P5');
    ok(inventoryAccountForWarehouse(db, whA).code === inventoryAccountForWarehouse(db, whB).code, 'both warehouses on the same inventory account');
    // intra-account transfer: move linked to the out leg only; in leg carries source_id = move id
    const outId = ledgerRow({ event: 'transfer_out', product: P1, wh: whA, qty: -3, amount: 900000, st: 'warehouse_transfer', sid: null });
    const moveId = Number(db.prepare(`
      INSERT INTO warehouse_moves (type, product_id, from_warehouse_id, to_warehouse_id, qty, date, ledger_id, status)
      VALUES ('transfer', ?, ?, ?, 3, ?, ?, 'posted')
    `).run(P1, whA, whB, today, outId).lastInsertRowid);
    db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(moveId, outId);
    const inId = ledgerRow({ event: 'transfer_in', product: P1, wh: whB, qty: 3, amount: 900000, st: 'warehouse_transfer', sid: moveId });
    // transfer legs without a move row (legacy), same account, net zero
    const o2 = ledgerRow({ event: 'transfer_out', product: P5, wh: whA, qty: -1, amount: 100000, st: 'warehouse_transfer', sid: 777777 });
    const i2 = ledgerRow({ event: 'transfer_in', product: P5, wh: whB, qty: 1, amount: 100000, st: 'warehouse_transfer', sid: 777777 });
    // net-zero pair, both without vouchers (production issue + its return)
    const iss = ledgerRow({ event: 'production_issue', product: P2, wh: whA, qty: -5, amount: 500000, st: 'production_material_issue', sid: 9 });
    const ret = ledgerRow({ event: 'production_receipt', product: P2, wh: whA, qty: 5, amount: 500000, st: 'production_material_return', sid: 13 });
    // id collision: the return is soft-matched by another order's production JE; the issue is not
    rawJe('production_labor', 14, [{ code: '1111', d: 1000 }, { code: '6104', c: 1000 }]);
    const iss2 = ledgerRow({ event: 'production_issue', product: P3, wh: whA, qty: -2, amount: 300000, st: 'production_material_issue', sid: 10 });
    const ret2 = ledgerRow({ event: 'production_receipt', product: P3, wh: whA, qty: 2, amount: 300000, st: 'production_material_return', sid: 14 });
    // genuine phantom return (original issue retired)
    const phantom = ledgerRow({ event: 'production_receipt', product: P4, wh: whA, qty: 4, amount: 1224000, st: 'production_material_return', sid: 1 });
    const m = check('movements_without_je');
    const byId = new Map(m.rows.map((r) => [r.id, r]));
    ok(!byId.has(outId) && !byId.has(inId), 'intra-account transfer (in leg via source_id) not flagged', m.rows.filter((r) => [outId, inId].includes(r.id)));
    ok(!byId.has(o2) && !byId.has(i2), 'move-less transfer legs netting to zero on one account not flagged');
    ok(/انتقال بین انبارهای هم‌حساب/.test(m.note), 'note mentions same-account transfers', m.note);
    ok(byId.get(iss)?.status === 'info' && byId.get(ret)?.status === 'info' && byId.get(iss)?.reason === 'net_zero_pair', 'net-zero pair shown as info', [byId.get(iss), byId.get(ret)]);
    ok(byId.get(iss2)?.status === 'info' && Number(byId.get(iss2)?.pair_ledger_id) === ret2, 'id-collision: issue paired with soft-matched return', byId.get(iss2));
    ok(byId.get(phantom)?.status === 'warn' && byId.get(phantom)?.amount_rial === 1224000, 'phantom return still flagged warn', byId.get(phantom));
    ok(m.status === 'warn' && m.sub_rial === 1224000, 'check total = phantom only', { status: m.status, sub: m.sub_rial });
    db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=?").run(phantom);
    const m2 = check('movements_without_je');
    ok(m2.status === 'info' && m2.sub_rial === 0, 'only net-zero pairs left → info, total 0', m2);

    // ── 4. document_amount_vs_je with ar_control_reclass ──
    console.log('\n[reclassed invoice]');
    const ctl = acct(db, 'coa_receivable').code;
    const sales = acct(db, 'coa_sales').code;
    const leaf = `${ctl}010000099`;
    coaLeaf(leaf, 'صدوقی تست', ctl, 'asset');
    db.prepare('UPDATE customers SET coa_code=? WHERE id=?').run(leaf, custId);
    const mkInv = (num, final) => Number(db.prepare(`
      INSERT INTO invoices (user_id, cust_id, num, type, date, final, status) VALUES (?,?,?, 'final', ?, ?, 'posted')
    `).run(ADMIN.id, custId, num, today, final).lastInsertRowid);
    const inv = mkInv('T-V525-2', 152380000);
    try { db.prepare('UPDATE invoices SET final_rial=? WHERE id=?').run(152380000, inv); } catch (_) {}
    const invJe = rawJe('invoice', inv, [{ code: ctl, d: 152380000 }, { code: sales, c: 152380000 }]);
    let dav = check('document_amount_vs_je');
    ok(dav.rows.some((r) => r.id === `invoice:${inv}` && r.diff_rial === -152380000), 'control-only invoice flagged before reclass', dav.rows);
    const reclass = rawJe('ar_control_reclass', invJe.lineIds[0], [{ code: leaf, d: 152380000 }, { code: ctl, c: 152380000 }]);
    dav = check('document_amount_vs_je');
    ok(!dav.rows.some((r) => r.id === `invoice:${inv}`), 'invoice + linked reclass JE matches', dav.rows);
    db.prepare("UPDATE journal_entries SET status='reversed' WHERE id=?").run(reclass.id);
    dav = check('document_amount_vs_je');
    ok(dav.rows.some((r) => r.id === `invoice:${inv}`), 'voided reclass no longer counts');
    db.prepare("UPDATE journal_entries SET status='approved' WHERE id=?").run(reclass.id);

    // ── 5. negative cash box ──
    console.log('\n[negative cash]');
    const cashCtl = acct(db, 'coa_cash_default').code;
    const boxLeaf = `${cashCtl}01000099`;
    coaLeaf(boxLeaf, 'صندوق کیمیا تست', cashCtl, 'asset');
    const boxId = Number(db.prepare("INSERT INTO cash_boxes (name, coa_code) VALUES ('کیمیا', ?)").run(boxLeaf).lastInsertRowid);
    rawJe('manual_cash_test', 1, [{ code: '6104', d: 30200000 }, { code: boxLeaf, c: 30200000 }]);
    const cb = check('cash_bank');
    const boxRow = cb.rows.find((r) => r.id === `cash:${boxId}`);
    ok(cb.sub_status === 'negative_cash' && cb.status === 'warn', 'cash_bank sub_status negative_cash', { s: cb.status, sub: cb.sub_status });
    ok(cb.diff_rial === 0, 'reconciliation diff stays 0', cb.diff_rial);
    ok(boxRow && boxRow.label === 'صندوق منفی' && boxRow.balance_rial === -30200000 && boxRow.name === 'کیمیا', 'row: label, name, amount', boxRow);
    ok(/صندوق منفی: کیمیا/.test(cb.note) && /اختلاف تطبیق صفر/.test(cb.note), 'note names the box', cb.note);
    const night = recon.runNightlyRecon(db, { date: today });
    ok(night.failing.some((f) => /صندوق منفی/.test(f)), 'nightly failing list labels negative cash', night.failing);

    // ── 6. rounding still classified ──
    console.log('\n[rounding]');
    ok(recon.classifyDiff(5, 5) === 'rounding' && recon.classifyDiff(1, 0) === 'real', 'classifyDiff unchanged');
    const adj = acct(db, 'coa_adjustment').code;
    rawJe('manual_round_test', 1, []);
    db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial, line_no)
      SELECT MAX(id), ?, ?, 1234, 0, 12345, 0, 1 FROM journal_entries`).run(adj, adj);
    db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial, line_no)
      SELECT MAX(id), ?, ?, 0, 1234, 0, 12340, 2 FROM journal_entries`).run(adj, adj);
    const s2 = check('suspense_accounts');
    ok(s2.status === 'rounding' && s2.rounding_rial === 5, 'suspense 5 rial → rounding', s2);

    const full = recon.runRecon(db, { persist: false });
    ok(full.summary.error === 0, 'full run has no erroring checks', full.summary);
    for (const c of full.checks) console.log(`   · ${c.code}: ${c.status}${c.sub_status ? `/${c.sub_status}` : ''} diff=${c.diff_rial} rows=${c.rows_count}`);
  } catch (e) {
    fail++;
    console.log(' FAIL unexpected exception', e && e.stack);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
