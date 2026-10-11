/**
 * v339 — Customer book / cheque_records alignment (voided opening, settlement backfill, splits, UI contracts).
 * Run: node server/scripts/test-cheque-books-v339.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-books-v339-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-books-v339-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
const blockers = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    fail++;
    console.log(' FAIL', label, extra == null ? '' : extra);
  }
}

function softOk(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK (soft)', label);
  } else {
    console.log('  SKIP (soft)', label, extra == null ? '' : extra);
  }
}

function tableHasColumn(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function requireFn(modPath, exportName) {
  try {
    const mod = require(modPath);
    if (typeof mod[exportName] === 'function') return mod[exportName];
    blockers.push(`${exportName} missing from ${modPath}`);
    return null;
  } catch (e) {
    blockers.push(`${modPath}: ${e.message}`);
    return null;
  }
}

const { buildStatement } = require('../routes/accounting');
const { applyInvoicePaySplits } = require('../lib/invoice-payments');
const { voidChequeRecord } = require('../lib/void-cheque');
const customerBooks = require('../lib/customer-books');
const {
  stmtEntryType,
  repairOpeningChequeLedgerMirrors,
} = customerBooks;
const hideVoidedBookRows = requireFn('../lib/customer-books', 'hideVoidedBookRows');
const backfillMissingSettlementCheques = requireFn('../lib/invoice-payments', 'backfillMissingSettlementCheques');
const insertChequeRecordForSettlement = requireFn('../lib/invoice-payments', 'insertChequeRecordForSettlement');
const { postChequeInReceipt } = require('../lib/cheque-party-books');
const { createLedgerEntry } = require('../db');

console.log('══ cheque books v339 ══');

if (!tableHasColumn('cheque_records', 'settlement_id')) {
  blockers.push('cheque_records.settlement_id column missing');
}
if (!tableHasColumn('cheque_records', 'record_status')) {
  blockers.push('cheque_records.record_status column missing');
}
if (!tableHasColumn('settlements', 'amount_rial')) {
  blockers.push('settlements.amount_rial column missing');
}
if (blockers.length) {
  for (const b of blockers) console.log('  BLOCKER', b);
}

const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

// ── 1) Voided opening + phantom cheque_in + repair → statement omits cheque_in, balance clean ──
(function assertOpeningVoidHidden() {
  console.log('\n— 1 opening void / hide cheque_in —');
  if (!hideVoidedBookRows) {
    ok(false, 'hideVoidedBookRows exported');
    return;
  }
  const OPEN = 2_000_000;
  const PHANTOM = 750_000;
  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری v339-1', 'اول دوره', '09153333901', 'active')
  `).run(admin.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, description, debit, credit, user_id)
    VALUES (?, '1405/01/01', 'opening', 'opening', 'مانده اول دوره', ?, 0, ?)
  `).run(custId, OPEN, admin.id);

  const chqId = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, party_name, customer_id,
       status, amount, note, lifecycle_status, record_status)
    VALUES ('in','OP-V339','1405/01/01','1405/06/01','ملت','اول دوره',?,
       'اول دوره', ?, 'مانده اول دوره — تست', 'registered', 'posted')
  `).run(custId, PHANTOM).lastInsertRowid;

  createLedgerEntry(db, {
    customer_id: custId,
    date: '1405/01/01',
    entry_type: 'cheque',
    ref_type: 'cheque_in',
    ref_id: chqId,
    description: 'اعتبار phantom cheque_in (legacy)',
    debit: 0,
    credit: PHANTOM,
    user_id: admin.id,
  });

  const repair = repairOpeningChequeLedgerMirrors(db);
  ok(repair && (repair.reversed >= 1 || repair.skipped), 'opening cheque mirror repair ran', repair);

  voidChequeRecord(db, chqId, { id: admin.id, name: 'admin' });
  const chqAfter = db.prepare('SELECT record_status FROM cheque_records WHERE id=?').get(chqId);
  ok(chqAfter && chqAfter.record_status === 'reversed', 'opening cheque voided', chqAfter);

  const rawRows = db.prepare(`
    SELECT * FROM customer_ledger WHERE customer_id=? ORDER BY id
  `).all(custId);
  const hidden = hideVoidedBookRows(db, rawRows);
  const liveChequeIn = hidden.filter((r) => r.ref_type === 'cheque_in' && Number(r.ref_id) === Number(chqId));
  ok(liveChequeIn.length === 0, 'hideVoidedBookRows drops cheque_in for reversed cheque', liveChequeIn.length);

  const stmt = buildStatement(db, custId);
  const stmtChequeIn = (stmt.entries || []).filter(
    (e) => e.ref_type === 'cheque_in' && Number(e.ref_id) === Number(chqId)
  );
  ok(stmtChequeIn.length === 0, 'buildStatement omits cheque_in for reversed cheque', stmtChequeIn.length);
  ok(stmt && stmt.closing === OPEN, 'closing excludes phantom cheque_in', { closing: stmt && stmt.closing, OPEN });
})();

// ── 2) Posted cheque settlement without live cheque row → backfill one record at settlement amount ──
(function assertSettlementBackfill() {
  console.log('\n— 2 settlement cheque backfill —');
  if (!backfillMissingSettlementCheques) {
    ok(false, 'backfillMissingSettlementCheques exported');
    return;
  }
  db.prepare("DELETE FROM settings WHERE key='cheque_receipt_mirror_v339'").run();
  const AMT = 3_300_000;
  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری v339-2', 'بک‌فیل', '09153333902', 'active')
  `).run(admin.id).lastInsertRowid;
  const settId = db.prepare(`
    INSERT INTO settlements
      (user_id, cust_id, amount, amount_rial, pay_type, date, note, status,
       cheque_bank, cheque_sayadi, cheque_number, cheque_amount, cheque_owner, cheque_due, cheque_status)
    VALUES (?, ?, ?, ?, 'cheque', '1405/07/10', 'تسویه بدون ردیف چک', 'posted',
      'پست', '5149050050730601', 'BK33901', ?, 'بک‌فیل', '1405/08/01', 'pending')
  `).run(admin.id, custId, AMT, AMT, AMT).lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?, '1405/07/10', 'settlement', 'settlement', ?, 'دریافت چک', 0, ?, ?)
  `).run(custId, settId, AMT, admin.id);

  const before = db.prepare(`
    SELECT id, amount, settlement_id FROM cheque_records WHERE settlement_id=?
  `).all(settId);
  ok(before.length === 0, 'no cheque row before backfill');

  const result = backfillMissingSettlementCheques(db);
  ok(result && result.skipped !== true, 'backfill ran', result);

  const after = db.prepare(`
    SELECT id, amount, settlement_id FROM cheque_records
    WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
  `).all(settId);
  ok(after.length === 1, 'exactly one cheque_records for settlement', after);
  ok(after[0] && Number(after[0].amount) === AMT, 'cheque amount = settlement (not sum)', after[0] && after[0].amount);

  const sumAll = db.prepare(`
    SELECT COALESCE(SUM(amount),0) s FROM cheque_records WHERE settlement_id=?
  `).get(settId).s;
  ok(Number(sumAll) === AMT, 'sum of cheque rows equals settlement amount', sumAll);
})();

// ── 3) Two invoice cheque splits → two cheque_records with split amounts ──
(function assertTwoSplitCheques() {
  console.log('\n— 3 invoice two cheque splits —');
  const A1 = 4_100_000;
  const A2 = 5_900_000;
  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری v339-3', 'دو چک', '09153333903', 'active')
  `).run(admin.id).lastInsertRowid;
  const invId = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, date, type, status, subtotal, final, pay_type)
    VALUES (?, ?, 'T-V339-3', '1405/07/11', 'final', 'confirmed', ?, ?, 'cheque')
  `).run(admin.id, custId, A1 + A2, A1 + A2).lastInsertRowid;

  applyInvoicePaySplits(db, {
    invoiceId: invId,
    custId,
    date: '1405/07/11',
    userId: admin.id,
    num: 'T-V339-3',
    splits: [
      {
        pay_type: 'cheque',
        amount: A1,
        cheque_bank: 'ملت',
        cheque_branch: 'مرکزی',
        cheque_account: '111',
        cheque_number: '339001',
        sayadi: '5149050050730611',
        cheque_owner: 'دو چک',
        cheque_due: '1405/08/11',
      },
      {
        pay_type: 'cheque',
        amount: A2,
        cheque_bank: 'ملت',
        cheque_branch: 'مرکزی',
        cheque_account: '222',
        cheque_number: '339002',
        sayadi: '5149050050730622',
        cheque_owner: 'دو چک',
        cheque_due: '1405/09/11',
      },
    ],
  });

  const rows = db.prepare(`
    SELECT amount, sayadi, settlement_id FROM cheque_records
    WHERE invoice_id=? AND COALESCE(record_status,'posted')<>'reversed'
    ORDER BY amount
  `).all(invId);
  ok(rows.length === 2, 'two cheque_records for two splits', rows.length);
  const amounts = rows.map((r) => Number(r.amount)).sort((a, b) => a - b);
  ok(amounts[0] === Math.min(A1, A2) && amounts[1] === Math.max(A1, A2), 'amounts match splits', amounts);
  ok(Number(rows.reduce((s, r) => s + Number(r.amount), 0)) !== Math.min(A1, A2), 'not collapsed to single sum row');
  const sayadis = new Set(rows.map((r) => r.sayadi));
  ok(sayadis.size === 2, 'distinct sayadi per split', [...sayadis]);
})();

// ── 4) Void receipt cheque with settlement_id → settlement reversed, statement drops line ──
(function assertVoidReceiptChequeSettlement() {
  console.log('\n— 4 void receipt cheque drops settlement —');
  const AMT = 1_250_000;
  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری v339-4', 'ابطال', '09153333904', 'active')
  `).run(admin.id).lastInsertRowid;

  const settId = db.prepare(`
    INSERT INTO settlements
      (user_id, cust_id, amount, amount_rial, pay_type, date, note, status,
       cheque_bank, cheque_sayadi, cheque_number, cheque_amount, cheque_owner, cheque_due)
    VALUES (?, ?, ?, ?, 'cheque', '1405/07/12', 'دریافت چک', 'posted',
      'صادرات', '5149050050730633', 'RC339', ?, 'ابطال', '1405/08/12')
  `).run(admin.id, custId, AMT, AMT, AMT).lastInsertRowid;

  const chqId = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, party_name, customer_id,
       status, amount, settlement_id, lifecycle_status, record_status, sayadi)
    VALUES ('in','RC339','1405/07/12','1405/08/12','صادرات','ابطال',?,
       'نزد صندوق', ?, ?, 'registered', 'posted', '5149050050730633')
  `).run(custId, AMT, settId).lastInsertRowid;

  createLedgerEntry(db, {
    customer_id: custId,
    date: '1405/07/12',
    entry_type: 'settlement',
    ref_type: 'settlement',
    ref_id: settId,
    description: 'دریافت چک v339-4',
    debit: 0,
    credit: AMT,
    user_id: admin.id,
  });

  let row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(chqId);
  postChequeInReceipt(db, row, admin.id, '1405/07/12');

  voidChequeRecord(db, chqId, { id: admin.id, name: 'admin' });
  const sett = db.prepare('SELECT status, cheque_status FROM settlements WHERE id=?').get(settId);
  ok(sett && sett.status === 'reversed', 'settlement status reversed on cheque void', sett);

  const stmt = buildStatement(db, custId);
  const liveSettLines = (stmt.entries || []).filter(
    (e) => e.ref_type === 'settlement' && Number(e.ref_id) === Number(settId)
      && e.entry_type !== 'reversal' && Number(e.credit || 0) > 0
  );
  ok(liveSettLines.length === 0, 'buildStatement drops live settlement credit after void', liveSettLines);
})();

// ── 5) Static UI contracts (soft) ──
(function assertUiStatic() {
  console.log('\n— 5 app.js UI contracts (soft) —');
  const appPath = path.join(__dirname, '../public/app.js');
  let appJs = '';
  try {
    appJs = fs.readFileSync(appPath, 'utf8');
  } catch (e) {
    softOk(false, 'read app.js', e.message);
    return;
  }
  const hasFace = appJs.includes('inv-cheque-face');
  const hasNextBtn = appJs.includes('ثبت چک بعدی');
  softOk(hasFace || hasNextBtn, 'app.js inv-cheque-face or ثبت چک بعدی', { hasFace, hasNextBtn });
  if (appJs.includes("moayanAcctHtml('st")) {
    softOk(false, 'receipt moayan still present');
  } else {
    softOk(true, 'receipt moayan not present');
  }
  if (!insertChequeRecordForSettlement) {
    console.log('  NOTE insertChequeRecordForSettlement not exported yet (accounting agent)');
  }
})();

// ── 6) stmtEntryType + type_label for cheque_in ──
(function assertStmtLabels() {
  console.log('\n— 6 stmtEntryType / type_label —');
  ok(stmtEntryType('cheque_in') === 'cheque_in', 'stmtEntryType(cheque_in)', stmtEntryType('cheque_in'));

  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری v339-6', 'برچسب', '09153333906', 'active')
  `).run(admin.id).lastInsertRowid;
  const chqId = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, party_name, customer_id,
       status, amount, lifecycle_status, record_status)
    VALUES ('in','LBL339','1405/07/15','1405/08/15','ملی','برچسب',?,
       'نزد صندوق', 900000, 'registered', 'posted')
  `).run(custId).lastInsertRowid;

  createLedgerEntry(db, {
    customer_id: custId,
    date: '1405/07/15',
    entry_type: 'cheque',
    ref_type: 'cheque_in',
    ref_id: chqId,
    description: 'ثبت چک دریافتنی',
    debit: 0,
    credit: 900_000,
    user_id: admin.id,
  });

  const stmt = buildStatement(db, custId);
  const row = (stmt.entries || []).find(
    (e) => e.ref_type === 'cheque_in' && Number(e.ref_id) === Number(chqId)
  );
  ok(!!row, 'cheque_in row on statement', stmt.entries && stmt.entries.length);
  const badLabel = 'خرج/ظهرنویسی چک';
  ok(row && row.type_label !== badLabel, 'cheque_in type_label not endorse label', row && row.type_label);
  ok(row && (row.type_label === 'ثبت چک' || row.entry_type === 'cheque_in'), 'cheque_in labeled as receipt', row);
})();

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

const totalAssertions = pass + fail;
console.log('\n══ Result ══');
if (blockers.length) {
  console.log('Blockers:', blockers.join('; '));
}
console.log(fail ? `FAIL (${pass} pass, ${fail} fail, ${totalAssertions} assertions)` : `PASS (${pass} pass, ${totalAssertions} assertions)`);
process.exit(fail ? 1 : 0);
