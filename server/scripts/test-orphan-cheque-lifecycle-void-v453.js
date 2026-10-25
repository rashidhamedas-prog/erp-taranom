'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v453: settlement/amend reverse must soft-void cheque send-to-bank + clear JEs (R13).
 * Reproduces صدوقی / چک 655099: leaf reversed, bank JE still live.
 * Run: node server/scripts/test-orphan-cheque-lifecycle-void-v453.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Orphan cheque lifecycle void v453 ══\n');

const voidChequeSrc = fs.readFileSync(path.join(__dirname, '../lib/void-cheque.js'), 'utf8');
const voidSettSrc = fs.readFileSync(path.join(__dirname, '../lib/void-settlement.js'), 'utf8');
const amendSrc = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

ok(voidChequeSrc.includes('applyChequeLifecycleVoid'), 'void-cheque exports applyChequeLifecycleVoid');
ok(voidChequeSrc.includes('healOrphanReversedChequeLifecycleJes'), 'heal helper present');
ok(voidChequeSrc.includes('orphan_cheque_lifecycle_void_v453'), 'heal flag v453');
ok(voidSettSrc.includes('applyChequeLifecycleVoid'), 'void-settlement uses full lifecycle void');
ok(voidSettSrc.indexOf('reverseChequeRecordsForSettlement') < voidSettSrc.indexOf('reverseSettlementBooks'),
  'cheque lifecycle void before settlement books (source order)');
ok(!/UPDATE cheque_records\s+SET record_status='reversed'\s+WHERE settlement_id=\?/.test(voidSettSrc),
  'void-settlement no bare record_status UPDATE');
ok(amendSrc.includes('reverseChequeRecordsForSettlement'), 'amend uses reverseChequeRecordsForSettlement');
ok(dbSrc.includes('healOrphanReversedChequeLifecycleJes'), 'db boot wires heal');
ok(swAtLeast(swSrc, 454), 'SW v454');
ok(appSrc.includes('R13 v454') && appSrc.includes('واگذاری') && /دفتر چک/.test(appSrc),
  'Help mentions R13 v454 cheque void');

// Isolated DB integration (skip if better-sqlite3 native binding missing)
let sqliteOk = false;
try {
  const Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
  sqliteOk = true;
} catch (_) {
  ok(true, 'SKIP sqlite integration (no better-sqlite3 binding)');
}

if (sqliteOk) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-v453-'));
  const dbPath = path.join(tmp, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.SYNC_ROLE = 'central';
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();

  // Minimal COA + bank + customer
  const ensureAcct = (code, name, type) => {
    const ex = db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(code);
    if (!ex) {
      try {
        db.prepare(`
          INSERT INTO chart_of_accounts (code, name, type, is_active)
          VALUES (?,?,?,1)
        `).run(code, name, type || 'asset');
      } catch (_) {
        try {
          db.prepare(`
            INSERT INTO chart_of_accounts (code, name, account_type)
            VALUES (?,?,?)
          `).run(code, name, type || 'asset');
        } catch (__) { /* schema variance */ }
      }
    }
  };
  ensureAcct('1103', 'دریافتنی', 'asset');
  ensureAcct('1109', 'اسناد دریافتنی', 'asset');
  ensureAcct('1116', 'اسناد در جریان وصول', 'asset');
  ensureAcct('1102-99', 'بانک تست v453', 'asset');

  let bankId = null;
  try {
    const b = db.prepare(`INSERT INTO banks (name, coa_code) VALUES ('بانک تست v453','1102-99')`).run();
    bankId = b.lastInsertRowid;
  } catch (_) {
    try {
      const b = db.prepare(`INSERT INTO banks (name, account_code) VALUES ('بانک تست v453','1102-99')`).run();
      bankId = b.lastInsertRowid;
      db.prepare('UPDATE banks SET coa_code=? WHERE id=?').run('1102-99', bankId);
    } catch (e) {
      ok(false, 'create bank', e.message);
    }
  }

  let custId = null;
  try {
    const c = db.prepare(`
      INSERT INTO customers (user_id, biz, owner, phone, status)
      VALUES (1,'مشتری v453','مالک','09120004530','active')
    `).run();
    custId = c.lastInsertRowid;
  } catch (e) {
    try {
      const c = db.prepare(`
        INSERT INTO customers (biz, owner, phone, status) VALUES ('مشتری v453','مالک','09120004530','active')
      `).run();
      custId = c.lastInsertRowid;
    } catch (e2) {
      ok(false, 'create customer', e2.message);
    }
  }
  if (!custId) {
    console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  }

  // Settings for COA map keys if used
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_receivable','1103')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_cheques_receivable','1109')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_cheques_in_collection','1116')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_bank_default','1102-99')").run();
  } catch (_) { /* optional */ }

  const { postToLedger } = require('../lib/ledger');
  const amountRial = 74000000;
  const amt = amountRial / 10;

  // Settlement JE: Dr 1109 / Cr 1103
  const settJe = postToLedger(db, {
    sourceType: 'settlement', sourceId: 9001,
    date: '1405/07/02', description: 'تسویه چک تست v453', createdBy: 1,
    lines: [
      { code: '1109', name: 'اسناد', debit: amt, credit: 0, debit_rial: amountRial },
      { code: '1103', name: 'دریافتنی', debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });
  ok(!!settJe, 'settlement JE posted');

  const sett = db.prepare(`
    INSERT INTO settlements
      (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, note,
       cheque_number, cheque_sayadi, cheque_status, status, account_code)
    VALUES (1,?,?,?,?, 'cheque','1405/07/02','تست',
            '655099','5149050050730598','pending','posted','1109')
  `).run(custId, null, amountRial, amountRial);
  const settlementId = sett.lastInsertRowid;

  // Point settlement JE ref
  try {
    db.prepare("UPDATE journal_entries SET ref_type='settlement', ref_id=? WHERE id=?")
      .run(settlementId, settJe);
  } catch (_) { /* optional */ }

  const chq = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, sayadi, party_name,
       customer_id, status, amount, note, settlement_id, lifecycle_status, record_status)
    VALUES ('in','655099','1405/07/02','1405/07/07','پست بانک','5149050050730598','مشتری v453',
            ?,'نزد صندوق',?,'تست',?,'registered','posted')
  `).run(custId, amountRial, settlementId);
  const chequeId = chq.lastInsertRowid;

  // send-to-bank
  const collJe = postToLedger(db, {
    sourceType: 'cheque_send_to_bank', sourceId: chequeId,
    date: '1405/07/13', description: `واگذاری چک 655099 به بانک`, createdBy: 1,
    lines: [
      { code: '1116', name: 'جریان', debit: amt, credit: 0, debit_rial: amountRial },
      { code: '1109', name: 'اسناد', debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });
  db.prepare(`
    UPDATE cheque_records SET lifecycle_status='in_collection', collection_je_id=?, collection_bank_id=?, status='واگذارشده'
    WHERE id=?
  `).run(collJe, bankId, chequeId);

  // clear
  const clearJe = postToLedger(db, {
    sourceType: 'cheque_clear', sourceId: chequeId,
    date: '1405/07/13', description: `وصول چک 655099`, createdBy: 1,
    lines: [
      { code: '1102-99', name: 'بانک', debit: amt, credit: 0, debit_rial: amountRial },
      { code: '1116', name: 'جریان', debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });
  db.prepare(`
    UPDATE cheque_records SET lifecycle_status='cleared', cleared_je_id=?, status='وصول‌شده'
    WHERE id=?
  `).run(clearJe, chequeId);

  const beforeClear = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(clearJe);
  ok(beforeClear && !beforeClear.deleted_at && beforeClear.status !== 'reversed', 'clear JE live before void');

  const settlementRow = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  const { reverseSettlementInTx } = require('../lib/void-settlement');
  db.transaction(() => {
    reverseSettlementInTx(db, settlementRow, 1);
  })();

  const afterChq = db.prepare('SELECT record_status, lifecycle_status FROM cheque_records WHERE id=?').get(chequeId);
  const afterColl = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(collJe);
  const afterClear = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(clearJe);
  const afterSett = db.prepare('SELECT status FROM settlements WHERE id=?').get(settlementId);

  ok(afterSett && afterSett.status === 'reversed', 'settlement marked reversed');
  ok(afterChq && afterChq.record_status === 'reversed', 'cheque leaf reversed');
  ok(afterChq && afterChq.lifecycle_status === 'reversed', 'cheque lifecycle_status=reversed');
  ok(afterColl && (afterColl.status === 'reversed' || Number(afterColl.deleted_at) > 0), 'collection JE soft-voided');
  ok(afterClear && (afterClear.status === 'reversed' || Number(afterClear.deleted_at) > 0), 'clear JE soft-voided');

  // Heal path: recreate orphan pattern then heal
  db.prepare("DELETE FROM settings WHERE key='orphan_cheque_lifecycle_void_v453'").run();
  const orphanChq = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, amount, status, lifecycle_status, record_status,
       collection_je_id, cleared_je_id, customer_id, party_name)
    VALUES ('in','ORPHAN','1405/07/01',1000,'وصول‌شده','cleared','reversed',?,?,?,'یتیم')
  `);
  // Fresh live JEs for heal
  const oColl = postToLedger(db, {
    sourceType: 'cheque_send_to_bank', sourceId: 99901,
    date: '1405/07/01', description: 'واگذاری یتیم', createdBy: 1,
    lines: [
      { code: '1116', name: 'جریان', debit: 100, credit: 0, debit_rial: 1000 },
      { code: '1109', name: 'اسناد', debit: 0, credit: 100, credit_rial: 1000 },
    ],
  });
  const oClear = postToLedger(db, {
    sourceType: 'cheque_clear', sourceId: 99901,
    date: '1405/07/01', description: 'وصول یتیم', createdBy: 1,
    lines: [
      { code: '1102-99', name: 'بانک', debit: 100, credit: 0, debit_rial: 1000 },
      { code: '1116', name: 'جریان', debit: 0, credit: 100, credit_rial: 1000 },
    ],
  });
  const oId = orphanChq.run(oColl, oClear, custId).lastInsertRowid;

  const { healOrphanReversedChequeLifecycleJes } = require('../lib/void-cheque');
  const heal = healOrphanReversedChequeLifecycleJes(db);
  ok(heal && !heal.skipped && heal.fixed >= 1, 'heal fixed orphan', heal);

  const oClearAfter = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(oClear);
  const oChqAfter = db.prepare('SELECT lifecycle_status FROM cheque_records WHERE id=?').get(oId);
  ok(oClearAfter && (oClearAfter.status === 'reversed' || Number(oClearAfter.deleted_at) > 0), 'heal soft-voided clear JE');
  ok(oChqAfter && oChqAfter.lifecycle_status === 'reversed', 'heal set lifecycle_status=reversed');

  const heal2 = healOrphanReversedChequeLifecycleJes(db);
  ok(heal2 && heal2.skipped, 'heal idempotent');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
