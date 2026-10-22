/**
 * v521 — sub-ledger ↔ GL reconciliation + accounting-integration P0/P1 fixes.
 *  - recon checks R1–R11 return a stable shape; R1 / R4 detect + fix
 *  - closed-period void → counter-voucher (original kept); open-period void unchanged
 *  - POST /inventory/adjust posts a JE; reversing it voids the JE
 *  - kardex reverse of a document-born row → 409 E_REVERSE_VIA_SOURCE
 *  - invoice DELETE is atomic (simulated failure → no partial stock change)
 *  - PATCH /products/:id/stock posts a JE
 * Run: node server/scripts/test-subledger-recon-v521.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subledger-recon-v521-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-subledger-recon-v521-secret-32chars!';
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

// In-process auth: every request is the seeded admin.
const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
authMw.auth = (req, _res, next) => { req.user = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; next(); };

const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);
// Boot-time valuation schema (lazy first-movement bootstrap would replay that movement twice).
try { require('../lib/inventory/valuation').ensureValuationSchema(db); } catch (_) { /* optional module */ }
const { reverseJournalEntry } = require('../lib/void-journal');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');
const { postInventoryMovement, inventoryAccountForWarehouse } = require('../lib/inventory/ledger');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../routes/inventory'));
app.use('/api/invoices', require('../routes/invoices'));
app.use('/api/products', require('../routes/products'));
app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
app.use('/api/fixed-assets', require('../routes/fixed-assets'));
app.use('/api/reps', require('../routes/rep-management'));

const today = todayJalali();

function liveJe(id) {
  const r = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
  return !!r && !Number(r.deleted_at || 0) && !['reversed', 'void'].includes(String(r.status || ''));
}

function insertJe({ date, refType, refId, lines, description }) {
  const id = Number(db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
    VALUES (?,?,?,?,?, 'approved')
  `).run(date, description || 'test', refType, refId, ADMIN.id).lastInsertRowid);
  let n = 1;
  for (const l of lines) {
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial, line_no)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, l.code, l.name || l.code, (l.debit_rial || 0) / 10, (l.credit_rial || 0) / 10, l.debit_rial || 0, l.credit_rial || 0, n++);
  }
  return id;
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

  try {
    // ── fixtures ──
    let whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
    if (!whId) whId = Number(db.prepare("INSERT INTO warehouses (name) VALUES ('انبار تست')").run().lastInsertRowid);
    const prodId = Number(db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit) VALUES (?, 'کالای تست v521', 'V521-1', 1000000, 0, 'عدد')
    `).run(ADMIN.id).lastInsertRowid);
    try { db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(whId, prodId); } catch (_) {}
    const invAcct = inventoryAccountForWarehouse(db, whId);

    // ── 1. shape of every check ──
    console.log('\n[shape]');
    const run = recon.runRecon(db, {});
    ok(run && run.as_of && run.ran_at && run.summary, 'runRecon returns as_of/ran_at/summary');
    ok(Array.isArray(run.checks) && run.checks.length === recon.CHECKS.length, 'all checks returned', run.checks.length);
    const keys = ['code', 'name', 'status', 'gl_rial', 'sub_rial', 'diff_rial', 'rows_count', 'sample', 'fixable', 'note'];
    for (const c of run.checks) {
      ok(keys.every((k) => k in c), `check ${c.code} has full shape`);
      ok(['ok', 'warn', 'error', 'info', 'rounding'].includes(c.status), `check ${c.code} status valid (${c.status})`, c.note);
      ok(c.status !== 'error', `check ${c.code} did not throw`, c.note);
      ok(Array.isArray(c.sample) && c.sample.length <= 20, `check ${c.code} sample ≤ 20`);
    }
    const apiRun = await call('GET', '/api/accounting/subledger-recon?checks=inventory_vs_gl,grni');
    ok(apiRun.status === 200 && apiRun.body.checks.length === 2, 'GET / with checks filter', apiRun.body);
    const apiLast = await call('GET', '/api/accounting/subledger-recon/last');
    ok(apiLast.status === 200 && apiLast.body.run_id, 'GET /last returns persisted run', apiLast.body && apiLast.body.run_id);
    const apiRows = await call('GET', '/api/accounting/subledger-recon/inventory_vs_gl/rows?limit=5');
    ok(apiRows.status === 200 && apiRows.body.code === 'inventory_vs_gl' && Array.isArray(apiRows.body.rows)
      && typeof apiRows.body.total === 'number', 'GET /:code/rows shape', apiRows.body);
    const unknown = await call('GET', '/api/accounting/subledger-recon/nope/rows');
    ok(unknown.status === 404, 'unknown check → 404');

    // ── 2. inventory/adjust posts JE; reverse voids it ──
    console.log('\n[inventory adjust]');
    const adj = await call('POST', '/api/inventory/adjust', {
      product_id: prodId, warehouse_id: whId, qty: 10, unit_cost_rial: 50000, reason: 'شمارش اولیه تست',
    });
    ok(adj.status === 200 && adj.body.je_id, 'adjust returns je_id', adj.body);
    const adjLed = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(adj.body.id);
    ok(adjLed && adjLed.source_type === 'inventory_adjust' && Number(adjLed.je_id) === Number(adj.body.je_id),
      'ledger row source_type inventory_adjust + je link', adjLed);
    const adjJe = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(adj.body.je_id);
    ok(adjJe && adjJe.ref_type === 'inventory_adjust' && Number(adjJe.ref_id) === Number(adj.body.id), 'JE ref inventory_adjust/ledger id', adjJe);
    const invLine = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? AND account_code=?').get(adj.body.je_id, invAcct.code);
    ok(invLine && Number(invLine.debit_rial) === 500000, 'Dr inventory 500,000 rial', invLine);

    const r1base = recon.runRecon(db, { checks: ['inventory_vs_gl', 'movements_without_je'], persist: false });
    ok(r1base.checks[0].status === 'ok', 'R1 ok after JE-backed adjustment', r1base.checks[0]);
    ok(r1base.checks[1].rows_count === 0, 'R2 no movement without JE', r1base.checks[1].sample);

    // second adjustment, then reverse it from the kardex
    const adj2 = await call('POST', '/api/inventory/adjust', {
      product_id: prodId, warehouse_id: whId, qty: 2, unit_cost_rial: 50000, reason: 'تعدیل دوم تست',
    });
    ok(adj2.status === 200 && adj2.body.je_id, 'second adjust posts JE', adj2.body);
    const rev = await call('POST', `/api/inventory/ledger/${adj2.body.id}/reverse`, {});
    ok(rev.status === 200, 'kardex reverse of manual adjustment allowed', rev.body);
    ok(!liveJe(adj2.body.je_id), 'reversing manual adjustment voids its JE');
    const r1after = recon.runRecon(db, { checks: ['inventory_vs_gl'], persist: false });
    ok(r1after.checks[0].status === 'ok', 'R1 still ok after reverse', r1after.checks[0]);

    // ── 3. kardex reverse of a document row → 409 ──
    console.log('\n[kardex reverse via source]');
    const docRow = db.transaction(() => postInventoryMovement(db, {
      eventType: 'sale', productId: prodId, warehouseId: whId, qty: -1, sourceType: 'invoice', sourceId: 999001,
      date: today, note: 'فروش تست', createdBy: ADMIN.id,
    }))();
    const rev409 = await call('POST', `/api/inventory/ledger/${docRow.id}/reverse`, {});
    ok(rev409.status === 409 && rev409.body.code === 'E_REVERSE_VIA_SOURCE'
      && rev409.body.source_type === 'invoice' && Number(rev409.body.source_id) === 999001, 'invoice row → 409 E_REVERSE_VIA_SOURCE', rev409.body);
    // undo the fake sale so later valuation checks stay clean
    db.transaction(() => require('../lib/inventory/ledger').reverseInventoryMovement(db, docRow.id, { createdBy: ADMIN.id, date: today }))();

    // ── 4. R1 detects injected diff, fix reconciles it, fix is voidable ──
    console.log('\n[R1 inject + fix]');
    const adjA = acct(db, 'coa_adjustment');
    postToLedger(db, {
      sourceType: 'manual_test', sourceId: 1, date: today, description: 'تزریق اختلاف', createdBy: ADMIN.id,
      lines: [
        { code: invAcct.code, name: invAcct.name, debit: rialToLedger(70000), credit: 0 },
        { code: adjA.code, name: adjA.name, debit: 0, credit: rialToLedger(70000) },
      ],
    });
    const r1diff = recon.runRecon(db, { checks: ['inventory_vs_gl'], persist: false }).checks[0];
    ok(r1diff.status === 'warn' && Math.abs(r1diff.diff_rial) === 70000, 'R1 detects 70,000 rial diff', r1diff);
    const dry = await call('POST', '/api/accounting/subledger-recon/inventory_vs_gl/fix', {});
    ok(dry.status === 200 && dry.body.dry_run === true && dry.body.plan.length >= 1, 'fix defaults to dry run', dry.body);
    const noConfirm = await call('POST', '/api/accounting/subledger-recon/inventory_vs_gl/fix', { dry_run: false });
    ok(noConfirm.status === 400 && noConfirm.body.code === 'E_RECON_CONFIRM_REQUIRED', 'real fix requires confirm+reason', noConfirm.body);
    const fixed = await call('POST', '/api/accounting/subledger-recon/inventory_vs_gl/fix', {
      dry_run: false, confirm: true, reason: 'اصلاح اختلاف تست', counter_account: acct(db, 'coa_opening_balance').code,
    });
    ok(fixed.status === 200 && fixed.body.applied.length >= 1 && fixed.body.applied[0].je_id, 'fix posts adjustment JE', fixed.body);
    const fixJe = fixed.body.applied && fixed.body.applied[0] && db.prepare('SELECT * FROM journal_entries WHERE id=?').get(fixed.body.applied[0].je_id);
    ok(fixJe && fixJe.ref_type === 'inventory_recon_adjust', 'fix JE ref_type inventory_recon_adjust', fixJe);
    const r1fixed = recon.runRecon(db, { checks: ['inventory_vs_gl'], persist: false }).checks[0];
    ok(r1fixed.status === 'ok', 'R1 ok after fix', r1fixed);
    const audited = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='recon_fix'").get().c;
    ok(audited >= 1, 'fix audited');
    const fixId = fixed.body.applied[0].fix_id;
    const revFix = await call('POST', `/api/accounting/subledger-recon/fixes/${fixId}/reverse`, { reason: 'تست ابطال' });
    ok(revFix.status === 200 && revFix.body.fix.status === 'reversed', 'recon fix is voidable', revFix.body);
    ok(!liveJe(fixed.body.applied[0].je_id), 'voided fix JE is no longer live');
    const revFix2 = await call('POST', `/api/accounting/subledger-recon/fixes/${fixId}/reverse`, {});
    ok(revFix2.status === 409, 'double reverse → 409');
    // R1 is back to the injected diff; neutralise the injection for later checks
    const inj = db.prepare("SELECT id FROM journal_entries WHERE ref_type='manual_test' ORDER BY id DESC LIMIT 1").get();
    reverseJournalEntry(db, inj.id, { userId: ADMIN.id });

    // ── 5. R4: live JE on voided invoice → fix reverses it ──
    console.log('\n[R4 je on dead document]');
    const custId = Number(db.prepare(`
      INSERT INTO customers (user_id, biz, phone, status) VALUES (?, 'مشتری تست v521', '09150000521', 'active')
    `).run(ADMIN.id).lastInsertRowid);
    const deadInv = Number(db.prepare(`
      INSERT INTO invoices (user_id, cust_id, num, type, date, final, status) VALUES (?,?, 'T-V521-1', 'final', ?, 300000, 'posted')
    `).run(ADMIN.id, custId, today).lastInsertRowid);
    const ar = acct(db, 'coa_receivable');
    const sales = acct(db, 'coa_sales');
    const deadJe = postToLedger(db, {
      sourceType: 'invoice', sourceId: deadInv, date: today, description: 'فاکتور تست', createdBy: ADMIN.id,
      lines: [
        { code: ar.code, name: ar.name, debit: rialToLedger(300000), credit: 0 },
        { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(300000) },
      ],
    });
    db.prepare("UPDATE invoices SET status='reversed', deleted_at=strftime('%s','now') WHERE id=?").run(deadInv);
    const r4 = recon.checkRows(db, 'je_on_dead_document', {});
    ok(r4.rows.some((r) => Number(r.je_id) === Number(deadJe)), 'R4 detects live JE on voided invoice', r4.rows);
    const r4fix = recon.applyFix(db, 'je_on_dead_document', { ids: [deadJe], dryRun: false, user: { id: ADMIN.id } });
    ok(r4fix.applied.length === 1 && r4fix.applied[0].result === 'reversed', 'R4 fix reverses the JE', r4fix);
    ok(!liveJe(deadJe), 'R4 JE no longer live');
    ok(!recon.checkRows(db, 'je_on_dead_document', {}).rows.some((r) => Number(r.je_id) === Number(deadJe)), 'R4 clean after fix');

    // ── 6. closed-period void → counter-voucher; open-period void unchanged ──
    console.log('\n[closed-period void]');
    db.prepare("INSERT INTO fiscal_years (label, start_date, end_date, status) VALUES ('سال ۱۴۰۰ تست', '1400/01/01', '1400/12/29', 'closed')").run();
    const cash = acct(db, 'coa_cash_default');
    const closedJe = insertJe({
      date: '1400/05/01', refType: 'manual_closed_test', refId: 77,
      lines: [
        { code: cash.code, name: cash.name, debit_rial: 120000 },
        { code: sales.code, name: sales.name, credit_rial: 120000 },
      ],
    });
    const before = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
    reverseJournalEntry(db, closedJe, { userId: ADMIN.id, reason: 'ابطال دوره بسته' });
    const orig = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(closedJe);
    ok(liveJe(closedJe), 'closed-period original stays live (not soft-voided)', orig);
    ok(orig.reversed_by_je_id, 'original linked to counter-voucher', orig);
    const cv = orig.reversed_by_je_id && db.prepare('SELECT * FROM journal_entries WHERE id=?').get(orig.reversed_by_je_id);
    ok(cv && liveJe(cv.id) && cv.entry_date >= '1405/01/01' && Number(cv.reverses_je_id) === closedJe, 'counter-voucher dated in open period', cv);
    ok(db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === before + 1, 'exactly one new JE');
    const cvLines = cv ? db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(cv.id) : [];
    ok(cvLines.some((l) => l.account_code === cash.code && Number(l.credit_rial) === 120000)
      && cvLines.some((l) => l.account_code === sales.code && Number(l.debit_rial) === 120000), 'counter-voucher swaps sides', cvLines);
    const again = reverseJournalEntry(db, closedJe, { userId: ADMIN.id });
    ok(again === null && db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === before + 1, 'second void is idempotent');
    const closedCheck = recon.runRecon(db, { checks: ['je_on_dead_document'], persist: false }).checks[0];
    ok(closedCheck.status !== 'error', 'recon tolerates counter-vouchered JE');

    console.log('\n[open-period void]');
    const openJe = postToLedger(db, {
      sourceType: 'manual_open_test', sourceId: 78, date: today, description: 'سند باز', createdBy: ADMIN.id,
      lines: [
        { code: cash.code, name: cash.name, debit: rialToLedger(50000), credit: 0 },
        { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(50000) },
      ],
    });
    const beforeOpen = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
    reverseJournalEntry(db, openJe, { userId: ADMIN.id });
    const openRow = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(openJe);
    ok(!liveJe(openJe) && !openRow.reversed_by_je_id, 'open-period void soft-voids original', openRow);
    ok(db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === beforeOpen, 'open-period void mints no new JE');

    // rewrite of an entry dated in a closed period is blocked
    const { rewriteJournalEntry } = require('../lib/ledger');
    if (typeof rewriteJournalEntry === 'function') {
      let code = null;
      try {
        rewriteJournalEntry(db, {
          sourceType: 'manual_closed_test', sourceId: 77, date: today, description: 'x', createdBy: ADMIN.id,
          lines: [
            { code: cash.code, name: cash.name, debit: rialToLedger(1000), credit: 0 },
            { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(1000) },
          ],
        });
      } catch (e) { code = e.code; }
      ok(code === 'E_CLOSED_PERIOD', 'rewriteJournalEntry blocks old date in closed period', code);
    }

    // ── 7. invoice DELETE atomic ──
    console.log('\n[invoice delete atomic]');
    const { postStockMovement } = require('../lib/inventory/movement');
    const delInv = Number(db.prepare(`
      INSERT INTO invoices (user_id, cust_id, num, type, date, final, status, stock_deducted, rows)
      VALUES (?,?, 'T-V521-2', 'final', ?, 0, 'posted', 1, '[]')
    `).run(ADMIN.id, custId, today).lastInsertRowid);
    db.transaction(() => postStockMovement(db, {
      productId: prodId, warehouseId: whId, qtyDelta: -3, docType: 'invoice', docId: delInv, docLine: 0, userId: ADMIN.id,
    }))();
    const qtyOf = () => Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, whId)?.qty) || 0;
    const movCount = () => db.prepare("SELECT COUNT(*) c FROM inventory_movements WHERE doc_id=? AND doc_type LIKE 'invoice%'").get(delInv).c;
    const qtyBefore = qtyOf();
    const movBefore = movCount();
    db.exec(`
      CREATE TRIGGER t_v521_fail BEFORE UPDATE OF status ON invoices
      WHEN NEW.status='reversed' AND NEW.num='T-V521-2'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
    `);
    const delFail = await call('DELETE', `/api/invoices/${delInv}`);
    ok(delFail.status >= 400, 'simulated failure surfaces as error', delFail);
    ok(qtyOf() === qtyBefore, 'no partial stock change after failure', { before: qtyBefore, after: qtyOf() });
    ok(movCount() === movBefore, 'no void movement left behind', { before: movBefore, after: movCount() });
    const stillDeducted = db.prepare('SELECT stock_deducted, status FROM invoices WHERE id=?').get(delInv);
    ok(Number(stillDeducted.stock_deducted) === 1 && stillDeducted.status !== 'reversed', 'invoice untouched after failure', stillDeducted);
    db.exec('DROP TRIGGER t_v521_fail');
    const delOk = await call('DELETE', `/api/invoices/${delInv}`);
    ok(delOk.status === 200 && delOk.body.ok, 'DELETE succeeds without the failure', delOk.body);
    ok(qtyOf() === qtyBefore + 3, 'stock restored on successful delete', { before: qtyBefore, after: qtyOf() });
    const delAgain = await call('DELETE', `/api/invoices/${delInv}`);
    ok(delAgain.status === 404 || delAgain.status === 400, 'second delete rejected before any write', delAgain.status);

    // ── 8. PATCH /products/:id/stock posts JE ──
    console.log('\n[products stock patch]');
    db.prepare('UPDATE products SET average_cost_rial=50000 WHERE id=?').run(prodId);
    const curStock = Number(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock) || 0;
    const patch = await call('PATCH', `/api/products/${prodId}/stock`, { stock: curStock + 4, note: 'تعدیل تست' });
    ok(patch.status === 200, 'stock patch accepted', patch.body);
    const saLed = db.prepare("SELECT * FROM inventory_ledger WHERE source_type='stock_adjust' AND product_id=? ORDER BY id DESC LIMIT 1").get(prodId);
    ok(saLed && saLed.je_id && liveJe(saLed.je_id), 'stock_adjust ledger row linked to live JE', saLed);
    const saJe = saLed && saLed.je_id && db.prepare('SELECT * FROM journal_entries WHERE id=?').get(saLed.je_id);
    ok(saJe && saJe.ref_type === 'stock_adjust' && Number(saJe.ref_id) === Number(saLed.id), 'JE ref stock_adjust/ledger id', saJe);
    const saLine = saJe && db.prepare('SELECT * FROM journal_lines WHERE entry_id=? AND account_code=?').get(saJe.id, invAcct.code);
    ok(saLine && Number(saLine.debit_rial) === Math.round(Number(saLed.amount_rial)), 'Dr inventory = qtyΔ × avg', { saLine, amount: saLed && saLed.amount_rial });

    // ── 9. fixed assets: acquisition JE, revalue reverse, deactivate voids JE ──
    console.log('\n[fixed assets]');
    const fa = await call('POST', '/api/fixed-assets', { name: 'دستگاه برش تست', cost_rial: 9000000, purchase_date: today });
    ok(fa.status === 200 && fa.body.acq_je_id && fa.body.acq_funding === 'opening', 'asset create posts acquisition JE (opening)', fa.body);
    const faLines = fa.body.acq_je_id ? db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(fa.body.acq_je_id) : [];
    ok(faLines.some((l) => l.account_code === '1201' && Number(l.debit_rial) === 9000000)
      && faLines.some((l) => l.account_code === acct(db, 'coa_opening_balance').code && Number(l.credit_rial) === 9000000), 'Dr 1201 / Cr opening equity', faLines);
    const faBad = await call('POST', '/api/fixed-assets', { name: 'x', cost_rial: 1000, funding: 'ap' });
    ok(faBad.status === 400 && faBad.body.code === 'E_FA_SUPPLIER_REQUIRED', 'ap funding requires supplier', faBad.body);
    const faCheck = recon.runRecon(db, { checks: ['fixed_assets'], persist: false }).checks[0];
    ok(faCheck.status === 'ok', 'R9 fixed assets ok after acquisition JE', faCheck);
    const reval = await call('POST', `/api/fixed-assets/${fa.body.id}/revalue`, { new_cost_rial: 11000000 });
    ok(reval.status === 200 && reval.body.revaluation_id && reval.body.surplus_rial === 2000000, 'revalue records revaluation', reval.body);
    const delBlocked = await call('DELETE', `/api/fixed-assets/${fa.body.id}`);
    ok(delBlocked.status === 400 && delBlocked.body.code === 'E_FA_ACTIVE_REVALUATION', 'deactivate blocked while revaluation active', delBlocked.body);
    const revalJe = db.prepare('SELECT je_id FROM fixed_asset_revaluations WHERE id=?').get(reval.body.revaluation_id).je_id;
    const revRev = await call('POST', `/api/fixed-assets/${fa.body.id}/revalue/${reval.body.revaluation_id}/reverse`, {});
    ok(revRev.status === 200 && !liveJe(revalJe), 'revaluation reverse voids its JE', revRev.body);
    const faRow = db.prepare('SELECT cost_rial, revaluation_surplus_rial FROM fixed_assets WHERE id=?').get(fa.body.id);
    ok(Number(faRow.cost_rial) === 9000000 && Number(faRow.revaluation_surplus_rial || 0) === 0, 'cost + surplus restored', faRow);
    const faDel = await call('DELETE', `/api/fixed-assets/${fa.body.id}`);
    ok(faDel.status === 200 && !liveJe(fa.body.acq_je_id), 'deactivate voids acquisition JE', faDel.body);

    // ── 10. rep expense / advance void ──
    console.log('\n[rep void]');
    const repId = Number(db.prepare(`
      INSERT INTO users (name, username, password, role, active) VALUES ('نماینده تست', 'rep_v521', 'x', 'field_sales', 1)
    `).run().lastInsertRowid);
    const adv = await call('POST', `/api/reps/${repId}/advances`, { amount: 400000, pay_type: 'cash', note: 'مساعده تست' });
    ok(adv.status === 200 && adv.body.id, 'advance created', adv.body);
    const advJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='rep_advance' AND ref_id=?").get(adv.body.id);
    const advVoid = await call('POST', `/api/reps/${repId}/advances/${adv.body.id}/void`, { reason: 'ثبت اشتباه' });
    ok(advVoid.status === 200 && advJe && !liveJe(advJe.id), 'advance void reverses JE', advVoid.body);
    const advRow = db.prepare('SELECT status, settled_amount, amount FROM rep_advances WHERE id=?').get(adv.body.id);
    ok(advRow.status === 'reversed' && Number(advRow.settled_amount) === Number(advRow.amount), 'advance marked reversed (no open balance)', advRow);
    const repRows = db.prepare("SELECT debit, credit FROM rep_ledger WHERE ref_type='rep_advance' AND ref_id=?").all(adv.body.id);
    ok(repRows.length === 2 && repRows.reduce((s, r) => s + r.debit - r.credit, 0) === 0, 'rep ledger offset by reverse row (not deleted)', repRows);
    const advVoid2 = await call('POST', `/api/reps/${repId}/advances/${adv.body.id}/void`, {});
    ok(advVoid2.status === 409, 'double advance void → 409');

    const expId = Number(db.prepare(`
      INSERT INTO rep_expenses (rep_id, date, category, amount, description, status) VALUES (?, ?, 'fuel', 150000, 'سوخت', 'pending')
    `).run(repId, today).lastInsertRowid);
    const appr = await call('POST', `/api/reps/expenses/${expId}/approve`, { pay_type: 'cash' });
    ok(appr.status === 200, 'expense approved', appr.body);
    const expJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='rep_expense' AND ref_id=?").get(expId);
    const expVoid = await call('POST', `/api/reps/expenses/${expId}/void`, { reason: 'تکراری' });
    ok(expVoid.status === 200 && expJe && !liveJe(expJe.id), 'expense void reverses JE', expVoid.body);
    ok(db.prepare('SELECT status FROM rep_expenses WHERE id=?').get(expId).status === 'reversed', 'expense marked reversed');
    const r4rep = recon.checkRows(db, 'je_on_dead_document', {});
    ok(!r4rep.rows.some((r) => ['rep_expense', 'rep_advance', 'fixed_asset_acquisition'].includes(r.ref_type)), 'R4 clean after rep/asset voids', r4rep.rows);

    const finalRun = recon.runRecon(db, { persist: false });
    ok(finalRun.summary.error === 0, 'final full run has no erroring checks', finalRun.summary);
    for (const c of finalRun.checks) console.log(`   · ${c.code}: ${c.status} gl=${c.gl_rial} sub=${c.sub_rial} diff=${c.diff_rial} rows=${c.rows_count}`);
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
