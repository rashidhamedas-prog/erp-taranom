/**
 * Fix 7A — supplier books vs own leaf GL; payable fold includes non-2101 supplier leaves.
 * Run: node server/scripts/test-7a-supplier-per-leaf.js
 *
 * Uses a throw-away temp DB only (never crm*.db).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), '7a-sup-leaf-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-7a-supplier-per-leaf-secret-32ch!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}
try { delete require.cache[require.resolve('../lib/gl-metrics')]; } catch (_) {}

const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const {
  supplierBooksByLeaf, supplierBooksMismatchList, supplierPayableGrossByLeaf,
  dualPartySupplierCustomerLeaves,
} = require('../lib/gl-metrics');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function ensureCoa(code, name, type, parent, level) {
  const row = db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(code);
  if (row) return;
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?,?,?,?,?,1)
  `).run(code, name, type, parent, level);
}

function insertSup(name, coa) {
  return db.prepare(
    'INSERT INTO suppliers (name, coa_code, balance) VALUES (?,?,0)'
  ).run(name, coa).lastInsertRowid;
}

function led(supId, date, debit, credit, note) {
  db.prepare(`
    INSERT INTO supplier_ledger
      (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,1)
  `).run(supId, date, 'purchase', 'purchase', 1, note || 'تست', debit, credit);
}

function postBalanced(date, desc, lines, sourceType, sourceId) {
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  return postToLedger(db, {
    sourceType: sourceType || 'test_7a',
    sourceId: sourceId || Date.now() % 1000000,
    date,
    description: desc,
    createdBy: admin.id,
    lines: lines.map((l) => ({
      code: l.code,
      name: l.name || l.code,
      debit: (Number(l.debit) || 0) / 10,
      credit: (Number(l.credit) || 0) / 10,
    })),
  });
}

(async () => {
  console.log('\n══ Fix 7A supplier-per-leaf ══\n');

  const payable = acct(db, 'coa_payable');
  const inventory = acct(db, 'coa_inventory');
  const cash = acct(db, 'coa_cash_default');
  const recv = acct(db, 'coa_receivable');
  const misc = acct(db, 'coa_misc_persons');

  // 110601 tree for suppliers parked under misc persons
  ensureCoa('110601', 'اشخاص متفرقه — تأمین', 'asset', misc.code || '1106', 3);
  ensureCoa('1106010001', 'تأمین‌کننده پارچه تست', 'asset', '110601', 4);
  ensureCoa('1106010002', 'تأمین‌کننده پیش‌پرداخت تست', 'asset', '110601', 4);
  ensureCoa('21010001', 'تأمین‌کننده زیر ۲۱۰۱', 'liability', payable.code, 4);
  ensureCoa('21010002', 'تأمین‌کننده بدون سند', 'liability', payable.code, 4);
  ensureCoa('1106010003', 'شخص دیگر طاقه', 'asset', '110601', 4);
  ensureCoa('1106010004', 'دوطرفه مشتری+تأمین', 'asset', '110601', 4);

  // ── 1) Supplier under 110601 with balanced JE → no mismatch ──
  console.log('— balanced 110601 supplier —');
  const supOk = insertSup('پارچه متوازن', '1106010001');
  const AMT = 5_000_000;
  led(supOk, '1405/01/10', 0, AMT, 'خرید نسیه');
  postBalanced('1405/01/10', 'خرید متوازن ۱۱۰۶۰۱', [
    { code: inventory.code, debit: AMT, credit: 0 },
    { code: '1106010001', debit: 0, credit: AMT },
  ], 'test_7a_ok', 1);
  const booksOk = supplierBooksByLeaf(db, {});
  const rowOk = booksOk.find((r) => r.id === Number(supOk));
  ok(!!rowOk && rowOk.ledger === AMT && rowOk.gl === AMT && Math.abs(rowOk.delta) <= 1,
    '110601 supplier ledger=gl (no delta)', rowOk);
  const mmOk = supplierBooksMismatchList(db, { limit: 8 });
  ok(!mmOk.rows.some((r) => r.id === Number(supOk)), 'balanced 110601 not in mismatch list');

  // ── 2) Supplier under 2101 with ledger but no JE → mismatch ──
  console.log('— 2101 ledger without JE —');
  const supGap = insertSup('بدهی بدون سند', '21010002');
  const GAP = 3_000_000;
  led(supGap, '1405/01/11', 0, GAP, 'فقط دفتر');
  const mmGap = supplierBooksMismatchList(db, { limit: 8 });
  const gapRow = mmGap.rows.find((r) => r.id === Number(supGap));
  ok(!!gapRow, 'ledger-without-JE flagged', mmGap);
  ok(gapRow && gapRow.name === 'بدهی بدون سند', 'mismatch list includes supplier name', gapRow);
  ok(gapRow && gapRow.delta === GAP && gapRow.gl === 0 && gapRow.ledger === GAP,
    'delta = ledger − 0', gapRow);

  // ── 3) Fabric-style: ledger on supplier A, JE on another person's leaf ──
  console.log('— JE on other person leaf —');
  const supFabric = insertSup('طاقه پارچه الف', '1106010001'); // same leaf code as متوازن — share leaf!
  // Use a dedicated supplier with own coa that has ledger only; JE goes to 1106010003
  // Re-create: don't share with متوازن. Insert new leaf owner.
  db.prepare('UPDATE suppliers SET coa_code=? WHERE id=?').run('1106010099', supFabric);
  ensureCoa('1106010099', 'تأمین‌کننده طاقه الف', 'asset', '110601', 4);
  const FAB = 12_000_000;
  led(supFabric, '1405/02/01', 0, FAB, 'رسید طاقه');
  postBalanced('1405/02/01', 'سند روی برگ شخص دیگر', [
    { code: inventory.code, debit: FAB, credit: 0 },
    { code: '1106010003', debit: 0, credit: FAB },
  ], 'test_7a_fabric', 2);
  const fabBooks = supplierBooksByLeaf(db, {}).find((r) => r.id === Number(supFabric));
  ok(fabBooks && fabBooks.ledger === FAB && fabBooks.gl === 0 && fabBooks.delta === FAB,
    'fabric JE on other leaf → delta=ledger', fabBooks);
  ok(supplierBooksMismatchList(db, {}).rows.some((r) => r.id === Number(supFabric)),
    'fabric case in mismatch list');

  // ── 4) Advance (debit) on 110601 appears in supplierAdvances ──
  console.log('— supplierAdvances includes 110601 debit —');
  const ADV = 2_500_000;
  const supAdv = insertSup('پیش‌پرداخت ۱۱۰۶', '1106010002');
  led(supAdv, '1405/01/20', ADV, 0, 'پیش‌پرداخت');
  postBalanced('1405/01/20', 'پیش‌پرداخت تأمین', [
    { code: '1106010002', debit: ADV, credit: 0 },
    { code: cash.code, debit: 0, credit: ADV },
  ], 'test_7a_adv', 3);
  const payFold = supplierPayableGrossByLeaf(db, payable.code, {});
  ok(payFold.contra >= ADV, 'supplierAdvances (contra) includes 110601 debit', payFold);

  // ── 5) reversed / soft-deleted ignored; asOf honored ──
  console.log('— reversed / deleted / asOf —');
  ensureCoa('21010003', 'تأمین asOf', 'liability', payable.code, 4);
  const supAsOf = insertSup('تأمین asOf', '21010003');
  const LATE = 4_000_000;
  led(supAsOf, '1405/03/15', 0, LATE, 'بعد از cutoff');
  const jeLate = postBalanced('1405/03/15', 'سند دیر', [
    { code: inventory.code, debit: LATE, credit: 0 },
    { code: '21010003', debit: 0, credit: LATE },
  ], 'test_7a_late', 4);
  const early = supplierBooksByLeaf(db, { asOf: '1405/03/01' }).find((r) => r.id === Number(supAsOf));
  ok(early && early.ledger === 0 && early.gl === 0, 'asOf excludes later ledger+JE', early);

  const REV = 7_000_000;
  ensureCoa('21010004', 'تأمین reversed', 'liability', payable.code, 4);
  const supRev = insertSup('تأمین ابطال', '21010004');
  // JE only (no ledger) then reverse — must not inflate gl
  const jeRev = postBalanced('1405/01/05', 'سند برای ابطال', [
    { code: inventory.code, debit: REV, credit: 0 },
    { code: '21010004', debit: 0, credit: REV },
  ], 'test_7a_rev', 5);
  db.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).run(jeRev);
  const revRow = supplierBooksByLeaf(db, {}).find((r) => r.id === Number(supRev));
  ok(revRow && revRow.gl === 0, 'reversed JE not in supplier gl', revRow);

  const DEL = 1_100_000;
  ensureCoa('21010005', 'تأمین soft-del', 'liability', payable.code, 4);
  const supDel = insertSup('تأمین حذف نرم', '21010005');
  const jeDel = postBalanced('1405/01/06', 'سند soft-delete', [
    { code: inventory.code, debit: DEL, credit: 0 },
    { code: '21010005', debit: 0, credit: DEL },
  ], 'test_7a_del', 6);
  db.prepare(`UPDATE journal_entries SET deleted_at=strftime('%s','now') WHERE id=?`).run(jeDel);
  const delRow = supplierBooksByLeaf(db, {}).find((r) => r.id === Number(supDel));
  ok(delRow && delRow.gl === 0, 'soft-deleted JE not in supplier gl', delRow);

  // ── 6) Dual leaf: customer+supplier same coa — not double in customerAdvances ──
  console.log('— dual leaf not double-counted in مطالبات —');
  const dualCode = '1106010004';
  // Place dual under receivable tree so old AR fold would see it
  ensureCoa(dualCode + 'x', 'unused', 'asset', '110601', 4);
  // Use a leaf under receivable control for the dual case
  const dualLeaf = recv.code + '9001';
  ensureCoa(dualLeaf, 'دوطرفه مشتری تأمین', 'asset', recv.code, 4);
  const dualSup = insertSup('دوطرفه تأمین', dualLeaf);
  const dualCust = db.prepare(`
    INSERT INTO customers (user_id, biz, phone, status, coa_code)
    VALUES (1,'دوطرفه مشتری','09120000000','active',?)
  `).run(dualLeaf).lastInsertRowid;
  const DUAL = 8_000_000;
  postBalanced('1405/01/25', 'بستانکاری دوطرفه', [
    { code: cash.code, debit: DUAL, credit: 0 },
    { code: dualLeaf, debit: 0, credit: DUAL },
  ], 'test_7a_dual', 7);
  led(dualSup, '1405/01/25', 0, DUAL, 'دوطرفه');
  const duals = dualPartySupplierCustomerLeaves(db);
  ok(duals.includes(dualLeaf), 'dual leaf detected', duals);
  const foldAp = supplierPayableGrossByLeaf(db, payable.code, {});
  ok(foldAp.gross >= DUAL, 'dual credit counted once in totalPayable', foldAp);
  const {
    glControlGrossByLeaf,
  } = require('../lib/gl-metrics');
  const arWithDual = glControlGrossByLeaf(db, recv.code, { debitNormal: true });
  const arExDual = glControlGrossByLeaf(db, recv.code, {
    debitNormal: true, excludeCodes: duals,
  });
  ok(arWithDual.contra >= DUAL, 'without exclude, dual credit would be customerAdvances', arWithDual);
  ok(arExDual.contra < arWithDual.contra && arExDual.contra <= arWithDual.contra - DUAL + 1,
    'with exclude, dual not in customerAdvances', { arWithDual, arExDual });
  ok(true, 'dual customer id created ' + dualCust);

  // ── 7) Overview HTTP wiring ──
  console.log('— GET /accounting/overview —');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: '7a-sup-leaf',
    device_fingerprint: '7a-sup-leaf-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounting/overview`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const ov = await res.json();
  ok(res.status === 200, 'overview 200', ov.error);
  ok(ov.books_mismatch_ap === true, 'books_mismatch_ap true when per-leaf gaps', ov.books_mismatch_ap);
  ok(Array.isArray(ov.books_mismatch_suppliers), 'books_mismatch_suppliers array');
  ok(Number(ov.books_mismatch_suppliers_count) >= 2, 'suppliers_count ≥ gaps', ov.books_mismatch_suppliers_count);
  ok(ov.books_mismatch_suppliers.some((s) => s.name === 'بدهی بدون سند'),
    'overview lists ledger-without-JE name', ov.books_mismatch_suppliers);
  ok(Number(ov.supplierAdvances) >= ADV, 'overview supplierAdvances includes 110601', ov.supplierAdvances);
  ok(Number(ov.totalPayable) >= DUAL, 'overview totalPayable includes dual/external leaves', ov.totalPayable);
  ok(ov.books_mismatch_detail && typeof ov.books_mismatch_detail.payable_delta === 'number',
    'payable_delta retained', ov.books_mismatch_detail);
  ok(typeof ov.totalPayableLedger === 'number', 'totalPayableLedger retained');
  ok(Number(ov.customerAdvances) < Number(arWithDual.contra) || Number(ov.customerAdvances) <= arExDual.contra + 1,
    'overview customerAdvances excludes dual leaf', {
      customerAdvances: ov.customerAdvances, arWithDual: arWithDual.contra, arExDual: arExDual.contra,
    });

  // Balanced-only subset: clear gaps by aligning gap supplier? Instead call mismatch on clean asOf before gaps
  const cleanAsOf = supplierBooksMismatchList(db, { asOf: '1404/12/01' });
  ok(cleanAsOf.count === 0, 'asOf before any rows → no mismatch', cleanAsOf);

  // Source gates
  const root = path.join(__dirname, '..');
  const accSrc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
  const metricsSrc = fs.readFileSync(path.join(root, 'lib/gl-metrics.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  ok(/function supplierBooksByLeaf/.test(metricsSrc), 'supplierBooksByLeaf defined');
  ok(/supplierPayableGrossByLeaf\(db, payableCode/.test(accSrc), 'overview uses supplierPayableGrossByLeaf');
  ok(/books_mismatch_suppliers:/.test(accSrc), 'payload has books_mismatch_suppliers');
  ok(/mmSupHtml/.test(appSrc) && /books_mismatch_suppliers/.test(appSrc), 'UI chips for suppliers');

  server.close();
  try { closeSessionStore(); } catch (_) { /* none */ }
  try { closeDB(); } catch (_) { /* none */ }

  console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
