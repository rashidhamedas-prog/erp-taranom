/**
 * skipJournal without invoice cash-pair must still post leaf JE (مد روز / 76.8M gap).
 * Continuous repairSettlementsMissingLeafJe heals historical books-only settlements.
 * Run: node server/scripts/test-settlement-leaf-je-v351.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sett-leaf-v351-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-settlement-leaf-je-v351-secret-32ch';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { allocTafsili, acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const {
  applyInvoicePaySplits, invoiceHasCashPairOnJe,
} = require('../lib/invoice-payments');
const {
  repairSettlementsMissingLeafJe, canonicalCustomerFold, glCustomersTafsiliBalance,
} = require('../lib/customer-books');

const AMT = 76800000;
const code = allocTafsili(db, 'customer', 'مد روز تست v351');
const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'مد روز تست v351', '09152149435', 'active', ?)
`).run(code).lastInsertRowid;

const bankCode = '1102-v351';
try {
  db.prepare(`
    INSERT INTO chart_of_accounts (code, name, type, parent_code, level, is_active)
    VALUES (?, 'بانک تست v351', 'asset', '1102', 4, 1)
  `).run(bankCode);
} catch (_) { /* may exist */ }
const bankId = db.prepare(`
  INSERT INTO banks (name, account_number, active, coa_code)
  VALUES ('بانک تست v351', '000351', 1, ?)
`).run(bankCode).lastInsertRowid;
const bank = { id: bankId };
ok(!!bank.id, 'bank fixture exists', bank);

const invId = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, final, final_rial, pay_type, bank_id, approved)
  VALUES (1, ?, 'T-V351', 'normal', '1405/07/02', ?, ?, 'bank_transfer', ?, 1)
`).run(custId, AMT, AMT, bank.id).lastInsertRowid;

// Modern invoice JE: Dr leaf / Cr sales — NO cash pair on sale voucher
const sales = acct(db, 'coa_sales');
const leaf = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(code);
postToLedger(db, {
  sourceType: 'invoice', sourceId: invId, date: '1405/07/02',
  description: 'فاکتور معمولی T-V351', createdBy: 1,
  lines: [
    { code: leaf.code, name: leaf.name, debit: rialToLedger(AMT), credit: 0 },
    { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(AMT) },
  ],
});
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/02', entry_type: 'invoice',
  ref_type: 'invoice', ref_id: invId, description: 'فاکتور معمولی T-V351',
  debit: AMT, credit: 0, user_id: 1,
});

ok(!invoiceHasCashPairOnJe(db, invId), 'invoice has no cash-pair lines');

// Even with skipJournal:true, settlement must post leaf JE
applyInvoicePaySplits(db, {
  invoiceId: invId, custId, date: '1405/07/02',
  splits: [{ pay_type: 'bank_transfer', amount: AMT, bank_id: bank.id }],
  userId: 1, num: 'T-V351', skipJournal: true,
});

const sett = db.prepare(`
  SELECT id FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
`).get(invId);
ok(!!sett, 'settlement created', sett);

const je = db.prepare(`
  SELECT je.id, jl.account_code, jl.debit_rial, jl.credit_rial, jl.debit, jl.credit
  FROM journal_entries je
  JOIN journal_lines jl ON jl.entry_id=je.id
  WHERE je.ref_type='settlement' AND je.ref_id=?
    AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
`).all(sett.id);
ok(je.length >= 2, 'skipJournal ignored → settlement JE posted', je);

const crLeaf = je.find((r) => String(r.account_code) === String(code)
  && Math.round(Number(r.credit_rial != null ? r.credit_rial : r.credit) || 0) > 0);
ok(!!crLeaf, 'settlement credits customer leaf not control', crLeaf);

const fold1 = canonicalCustomerFold(db);
const gl1 = glCustomersTafsiliBalance(db);
ok(Math.abs(Number(fold1.display) - Number(gl1.display)) <= 1,
  'fold matches leaf GL after forced JE', { fold1, gl1 });

// Historical hole: books credit, no JE (simulate old repair)
const settGhost = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, note, bank_id, status)
  VALUES (1, ?, ?, ?, ?, 'bank_transfer', '1405/07/03', 'سایه بدون سند', ?, 'posted')
`).run(custId, invId, AMT, AMT, bank.id).lastInsertRowid;
// wipe JE if any and insert books-only
try {
  db.prepare("UPDATE journal_entries SET status='void' WHERE ref_type='settlement' AND ref_id=?").run(settGhost);
} catch (_) {}
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/03', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: settGhost, description: 'سایه',
  debit: 0, credit: AMT, user_id: 1,
});
// Extra invoice debit so books aren't negative before repair posts Cr on leaf
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/03', entry_type: 'invoice',
  ref_type: 'invoice', ref_id: invId + 9000, description: 'فاکتور مجازی برای تست سایه',
  debit: AMT, credit: 0, user_id: 1,
});
postToLedger(db, {
  sourceType: 'invoice', sourceId: invId + 9000, date: '1405/07/03',
  description: 'فاکتور مجازی سایه', createdBy: 1,
  lines: [
    { code: leaf.code, name: leaf.name, debit: rialToLedger(AMT), credit: 0 },
    { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(AMT) },
  ],
});

const before = {
  fold: canonicalCustomerFold(db).display,
  gl: glCustomersTafsiliBalance(db).display,
};
ok(Math.abs(Number(before.fold) - Number(before.gl)) > 1,
  'ghost books-only creates mismatch before repair', before);

const repaired = repairSettlementsMissingLeafJe(db);
ok(repaired.posted >= 1, 'repair posts missing leaf JE', repaired);

const after = {
  fold: canonicalCustomerFold(db).display,
  gl: glCustomersTafsiliBalance(db).display,
};
ok(Math.abs(Number(after.fold) - Number(after.gl)) <= 1,
  'repair clears fold vs leaf mismatch', after);

const paySrc = fs.readFileSync(path.join(__dirname, '../lib/invoice-payments.js'), 'utf8');
ok(paySrc.includes('invoiceHasCashPairOnJe'), 'guard exported in invoice-payments');
ok(paySrc.includes('skipGl'), 'skipJournal hardened');

const booksSrc = fs.readFileSync(path.join(__dirname, '../lib/customer-books.js'), 'utf8');
ok(booksSrc.includes('repairSettlementsMissingLeafJe'), 'continuous leaf JE repair');

const voidSrc = fs.readFileSync(path.join(__dirname, '../lib/void-settlement.js'), 'utf8');
ok(!voidSrc.includes('reversalId = null;\n    }'), 'void no longer swallows JE errors');
ok(voidSrc.includes('if (already) return 0'), 'multi-row books reverse uses early return');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(sw.includes('erp-taranom-v351'), 'SW v351');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
