/**
 * مستر بدون کد، یا کد بدون ردیف دفترکل، زیر معین درست دیده می‌شود.
 * Run: node server/scripts/test-coa-live-v324.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-live-v324-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-coa-live-v324-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const { syncLiveTafsili } = require('../lib/coa-live');
const { tafsiliUnderMoin } = require('../lib/coa-browse');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

function codesUnder(moin) {
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE COALESCE(is_active,1)=1').all();
  return tafsiliUnderMoin(accounts, moin);
}

db.prepare('INSERT INTO suppliers (name, phone) VALUES (?,?)').run('پارچه مشهد', '09120000000');
const first = syncLiveTafsili(db);
ok(first.filled >= 1, 'blank supplier gets a tafsili', JSON.stringify(first));
const supplier = db.prepare('SELECT coa_code FROM suppliers WHERE name=?').get('پارچه مشهد');
ok(supplier && String(supplier.coa_code).length === 12 && String(supplier.coa_code).startsWith('210101'),
  'supplier code is 12-digit under 210101', supplier && supplier.coa_code);
const shown = codesUnder('2101');
ok(shown.some((a) => a.code === supplier.coa_code && a.name === 'پارچه مشهد'),
  'payable column lists the supplier, not only the shell', shown.map((a) => a.code).join(','));
ok(!shown.some((a) => a.code === '210101'), 'shell stays out of the payable تفصیلی');

const again = syncLiveTafsili(db);
ok(again.filled === 0, 'second open does not allocate another supplier code', JSON.stringify(again));
const n = db.prepare("SELECT COUNT(*) c FROM suppliers WHERE name='پارچه مشهد'").get().c;
ok(n === 1, 'still one supplier');
const codes = db.prepare("SELECT COUNT(*) c FROM chart_of_accounts WHERE code LIKE '210101%' AND length(code)=12").get().c;
ok(codes === 1, 'still one 12-digit payable tafsili', codes);

db.prepare("UPDATE suppliers SET coa_code='210101000099' WHERE name='پارچه مشهد'").run();
db.prepare("DELETE FROM chart_of_accounts WHERE code='210101000099'").run();
const repaired = syncLiveTafsili(db);
ok(repaired.repaired >= 1, 'missing chart row is inserted for an existing code', JSON.stringify(repaired));
ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='210101000099' AND parent_code='210101'").get(),
  'repaired row parents to the shell');
ok(codesUnder('2101').some((a) => a.code === '210101000099'), 'repaired supplier shows under 2101');

db.prepare('INSERT INTO banks (name, account_number, active) VALUES (?,?,1)').run('ملت تست', '9955');
syncLiveTafsili(db);
const bank = db.prepare("SELECT coa_code FROM banks WHERE name='ملت تست'").get();
ok(bank && String(bank.coa_code).startsWith('110201') && String(bank.coa_code).length === 12,
  'bank gets a tafsili under 1102', bank && bank.coa_code);
ok(codesUnder('1102').some((a) => a.code === bank.coa_code), 'bank shows under موجودی بانک');

db.prepare("INSERT INTO banks (name, account_number, active, coa_code) VALUES ('قدیمی', '1', 1, NULL)").run();
const oldId = db.prepare("SELECT id FROM banks WHERE name='قدیمی'").get().id;
db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,0)')
  .run('1102-' + oldId, 'قدیمی', 'asset', '1102');
syncLiveTafsili(db);
const old = db.prepare("SELECT coa_code FROM banks WHERE name='قدیمی'").get();
ok(old && old.coa_code === '1102-' + oldId, 'legacy bank keeps 1102-id instead of a second code', old && old.coa_code);
ok(codesUnder('1102').some((a) => a.code === '1102-' + oldId), 'legacy bank shows under 1102');

try { closeDB(); } catch (_) {}
console.log(fail ? `\n${fail} failed, ${pass} passed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
