/**
 * Balance sheet: missing COA must not unbalance; party credit reclass.
 * Run: node server/scripts/test-balance-sheet-v298.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-v298-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-balance-sheet-v298-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createJournalEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { buildBalanceSheet } = require('../lib/balance-sheet');
const { ensureMissingBaseCoa } = require('../lib/coa-map');

ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6115'").get(), '6115 seeded on boot');

function je(desc, lines) {
  return createJournalEntry(db, {
    date: '1405/01/01', description: desc, ref_type: 'test_bs', created_by: 1,
    lines,
  });
}

je('افتتاحیه', [
  { code: '1101', name: 'صندوق', debit: 10_000_000, credit: 0 },
  { code: '3102', name: 'تراز افتتاحیه', debit: 0, credit: 10_000_000 },
]);

const bs0 = buildBalanceSheet(db);
ok(bs0.balanced, 'opening BS balanced', { gap: bs0.gap, A: bs0.totalAssets, rhs: bs0.totalLiabilities + bs0.totalEquity });
ok(Math.abs(bs0.totalAssets - 100_000_000) < 1, 'cash 10M toman = 100M rial assets', bs0.totalAssets);

db.prepare("DELETE FROM chart_of_accounts WHERE code='6115'").run();
ok(!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6115'").get(), '6115 removed for gap repro');

je('کارمزد بدون کدینگ', [
  { code: '6115', name: 'کارمزد', debit: 28_070, credit: 0 },
  { code: '1101', name: 'صندوق', debit: 0, credit: 28_070 },
]);

const bs1 = buildBalanceSheet(db);
ok(bs1.balanced, 'missing 6115 still classified as expense → BS balances', { gap: bs1.gap, unmapped: bs1.unmapped });
ok(Math.abs(bs1.retainedEarnings + 280_700) < 1, 'fee reduces RE by 280700 rial', bs1.retainedEarnings);
ok(!bs1.unmapped.some((u) => u.code === '6115'), '6115 inferred, not dumped as unmapped');

const n = ensureMissingBaseCoa(db);
ok(n >= 1 && !!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6115'").get(), 'ensureMissingBaseCoa restores 6115', n);

const bs2 = buildBalanceSheet(db);
ok(bs2.balanced, 'after COA restore still balanced', bs2.gap);

db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,tafsili_type) VALUES ('110601000099','بستانکار تست','asset','110601',4,'اشخاص')").run();
je('شخص بستانکار', [
  { code: '1101', name: 'صندوق', debit: 5_000_000, credit: 0 },
  { code: '110601000099', name: 'بستانکار تست', debit: 0, credit: 5_000_000 },
]);

const bs3 = buildBalanceSheet(db);
const creditor = (bs3.liabilities || []).find((x) => x.code === '110601000099');
const stillAsset = (bs3.assets || []).find((x) => x.code === '110601000099');
ok(!!creditor && creditor.reclassified, 'party credit moved to liabilities', creditor);
ok(!stillAsset, 'party credit not listed as asset');
ok(bs3.balanced, 'reclass keeps equation', { gap: bs3.gap, A: bs3.totalAssets, L: bs3.totalLiabilities, E: bs3.totalEquity });

db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,tafsili_type) VALUES ('210101000099','تأمین بدهکار تست','liability','210101',4,'اشخاص')").run();
je('تأمین بدهکار', [
  { code: '210101000099', name: 'تأمین بدهکار تست', debit: 1_000_000, credit: 0 },
  { code: '1101', name: 'صندوق', debit: 0, credit: 1_000_000 },
]);
const bs4 = buildBalanceSheet(db);
const supp = (bs4.assets || []).find((x) => x.code === '210101000099');
ok(!!supp && supp.reclassified, 'supplier debit moved to assets', supp);
ok(bs4.balanced, 'supplier reclass balances', bs4.gap);

console.log('\n' + pass + ' passed,', fail + ' failed');
closeDB();
process.exit(fail ? 1 : 0);
