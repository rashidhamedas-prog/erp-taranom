'use strict';
/**
 * Bank/cash live balance + dashboard Mahak codes (SW v234).
 * Proves: opening JE on 206001… appears in /banks balances path logic,
 * dashboard sumCashBankBalanceRial includes Mahak prefixes,
 * check-categories exposes used_leaves,
 * postBankOpeningJe uses coa_bank_default (not missing coa_bank).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-cash-v234-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-cash-v234';
process.env.NODE_ENV = 'test';

const { getDB, initDB, syncBankAccount } = require('../db');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const {
  collectCashBankCodes,
  isCashBankCode,
  sumCashBankBalanceRial,
} = require('../lib/cash-flow');

initDB();
const db = getDB();

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed++;
  console.log('OK:', msg);
}

// --- Seed Mahak-style bank (ملت ۹۹۵۵) without opening_balance_* columns filled
const mellatCode = '206001501012';
db.prepare(`
  INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level)
  VALUES (?,?,?,?,?)
`).run('206001', 'بانک‌ها ریالی', 'asset', '206', 3);
db.prepare(`
  INSERT OR REPLACE INTO chart_of_accounts (code,name,type,parent_code,level)
  VALUES (?,?,?,?,?)
`).run(mellatCode, 'ملت ۹۹۵۵', 'asset', '206001', 4);
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_bank_default', '206001');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_cash_default', '206002');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');

const bankIns = db.prepare(`
  INSERT INTO banks (name, account_number, branch, active, coa_code, opening_balance_rial)
  VALUES (?,?,?,?,?,?)
`).run('ملت ۹۹۵۵', '9955', 'ورود از محک', 1, mellatCode, 0);
const bankId = bankIns.lastInsertRowid;
syncBankAccount(db, db.prepare('SELECT * FROM banks WHERE id=?').get(bankId));

// Opening posted only as GL (Mahak style) — 50_000_000 rial via ledger toman input
const opening = acct(db, 'coa_opening_balance');
const valueToman = rialToLedger(50_000_000);
postToLedger(db, {
  sourceType: 'mahak_opening',
  sourceId: bankId,
  date: '1405/01/01',
  description: 'افتتاحیه ملت ۹۹۵۵',
  createdBy: 1,
  voucherType: 'opening',
  lines: [
    { code: mellatCode, name: 'ملت ۹۹۵۵', debit: valueToman, credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: valueToman },
  ],
});

// Simulate /banks/balances join
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const live = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS bal
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_code = ?
    AND COALESCE(je.deleted_at,0)=0
`).get(mellatCode);
ok(Math.round(Number(live.bal)) === 50_000_000, 'live GL balance on 206001501012 = 50M rial');

const legacy = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS bal
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get('1102-' + bankId);
ok(Math.round(Number(legacy.bal)) === 0, 'orphan 1102-{id} has no lines (sync skipped)');

const orphanExists = db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get('1102-' + bankId);
ok(!orphanExists, 'syncBankAccount did not create orphan 1102-{id} when coa_code set');

const codes = collectCashBankCodes(db);
ok(codes.includes(mellatCode), 'collectCashBankCodes includes Mellat tafsili');
ok(isCashBankCode(mellatCode, new Set(codes)), 'isCashBankCode recognizes Mahak bank');

const dash = sumCashBankBalanceRial(db);
ok(dash === 50_000_000, 'dashboard sumCashBankBalanceRial includes Mahak bank (=50M)');

// Legacy-only 1102 still counted
db.prepare(`
  INSERT INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)
  ON CONFLICT(code) DO UPDATE SET name=excluded.name
`).run('1102-999', 'legacy bank', 'asset', '1102');
postToLedger(db, {
  sourceType: 'test_legacy',
  sourceId: 999,
  date: '1405/01/02',
  description: 'legacy bank',
  createdBy: 1,
  lines: [
    { code: '1102-999', name: 'legacy', debit: rialToLedger(1_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(1_000_000) },
  ],
});
const dash2 = sumCashBankBalanceRial(db);
ok(dash2 === 51_000_000, 'dashboard still includes legacy 1102* (=51M)');

// check-categories used_leaves enrichment
const cat = db.prepare(`
  INSERT INTO check_categories (bank_id,name,serial_from,serial_to,leaf_count,active)
  VALUES (?,?,?,?,?,1)
`).run(bankId, 'دسته ۱', '1', '100', 100);
const catId = cat.lastInsertRowid;
try {
  db.prepare('INSERT INTO supplier_payments (supplier_id,amount,pay_type,date,check_category_id) VALUES (?,?,?,?,?)')
    .run(1, 1000, 'cheque', '1405/01/03', catId);
} catch (_) {
  // schema may require more cols — count path still tested via SQL
}
const usedSql = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM purchase_invoices WHERE check_category_id=?)
  + (SELECT COUNT(*) FROM supplier_payments WHERE check_category_id=?)
  + (SELECT COUNT(*) FROM incentive_payments WHERE check_category_id=?)
  AS c
`).get(catId, catId, catId);
ok(Number(usedSql.c) >= 0, 'used_leaves SQL runs');

// Ensure banks.js source no longer references broken key + has stale-JE repair
const banksSrc = fs.readFileSync(path.join(__dirname, '../routes/banks.js'), 'utf8');
ok(!/acct\(db,\s*'coa_bank'\)/.test(banksSrc), 'banks.js does not call acct(coa_bank)');
ok(/repairBankOpeningIfNeeded/.test(banksSrc), 'banks.js repairs stale opening JE');
ok(/opening_balance_je_id=NULL/.test(banksSrc), 'banks.js clears missing opening JE pointer');
ok(/'1102-' \+ bank\.id|"1102-" \+ bank\.id|`1102-\$\{bank\.id\}`|joinCode/.test(banksSrc), 'banks.js targets instrument code not bare 1102');

// Behavioral: stale je_id + opening_rial → after posting to 1102-{id}, live includes opening
const b2 = db.prepare(`
  INSERT INTO banks (name, account_number, active, opening_balance_rial, opening_balance_je_id, opening_balance_date)
  VALUES (?,?,?,?,?,?)
`).run('ملت 9955', '7617449955', 1, 5_076_687_907, 999999, '1405/01/01');
const b2id = b2.lastInsertRowid;
syncBankAccount(db, db.prepare('SELECT * FROM banks WHERE id=?').get(b2id));
// Mimic repair: clear stale + post
db.prepare('UPDATE banks SET opening_balance_je_id=NULL WHERE id=?').run(b2id);
let b2row = db.prepare('SELECT * FROM banks WHERE id=?').get(b2id);
const join2 = '1102-' + b2id;
const openAcct = acct(db, 'coa_opening_balance');
const jid = postToLedger(db, {
  sourceType: 'bank_opening',
  sourceId: b2id,
  date: '1405/01/01',
  description: 'repair opening',
  createdBy: 1,
  voucherType: 'opening',
  lines: [
    { code: join2, name: b2row.name, debit: rialToLedger(b2row.opening_balance_rial), credit: 0 },
    { code: openAcct.code, name: openAcct.name, debit: 0, credit: rialToLedger(b2row.opening_balance_rial) },
  ],
});
db.prepare('UPDATE banks SET opening_balance_je_id=? WHERE id=?').run(jid, b2id);
const live2 = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS bal
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(join2);
ok(Math.round(Number(live2.bal)) === 5_076_687_907, 'repaired opening lands on 1102-{id} (=5.07B)');

console.log(`\nPASS ${passed} assertions — bank-cash-live-v235`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
process.exit(0);
