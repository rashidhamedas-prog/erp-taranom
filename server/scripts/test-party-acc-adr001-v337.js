/**
 * ADR-PARTY-001 P0: credit_limit enforce, cheque XOR books, dual-role separate leaves.
 * Run: node server/scripts/test-party-acc-adr001-v337.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-adr001-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-acc-adr001-v337-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

(async () => {
  const {
    assertPartyCreditLimitOk, invoiceArDeltaRial, customerArExposureRial,
  } = require('../lib/party-credit');
  const {
    resolveChequeInCredit, postChequePartyBooks, xorChequeBookTargets,
  } = require('../lib/cheque-party-books');
  const { ensureDualRoleSeparateLeaves, parseRoles } = require('../lib/party-tafsili');
  const { syncPartyToLegacy } = require('../lib/parties-sync');
  const { allocTafsili } = require('../lib/coa-map');
  const { todayJalali } = require('../jalali');

  // --- credit limit ---
  ok(invoiceArDeltaRial(1_000_000, { splits: [] }, 'credit') === 1_000_000, 'AR delta credit full');
  ok(invoiceArDeltaRial(1_000_000, { splits: [] }, 'cash') === 0, 'AR delta cash header = 0');
  ok(invoiceArDeltaRial(1_000_000, { splits: [{ amount: 400_000 }] }, 'credit') === 600_000, 'AR delta partial splits');

  const custId = db.prepare(`
    INSERT INTO customers (user_id,biz,owner,phone,type,status,balance)
    VALUES (1,'حد اعتباری','مالک','09120000001','بوتیک','active',0)
  `).run().lastInsertRowid;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, is_active)
    VALUES ('P-ADR337','customer','["customer"]','حد اعتباری','09120000001',500000,1)
  `).run().lastInsertRowid;
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(partyId, custId);

  let blocked = false;
  try {
    assertPartyCreditLimitOk(db, custId, 600_000);
  } catch (e) {
    blocked = e.code === 'E_CREDIT_LIMIT';
  }
  ok(blocked, 'credit limit blocks over-limit AR');

  let okUnder = true;
  try { assertPartyCreditLimitOk(db, custId, 400_000); } catch (_) { okUnder = false; }
  ok(okUnder, 'credit limit allows under-limit AR');

  db.prepare(`
    INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,'invoice','invoice',1,'seed',400000,0,1)
  `).run(custId, todayJalali());
  ok(customerArExposureRial(db, custId) === 400_000, 'exposure from ledger');
  blocked = false;
  try { assertPartyCreditLimitOk(db, custId, 200_000); } catch (e) { blocked = e.code === 'E_CREDIT_LIMIT'; }
  ok(blocked, 'limit considers existing AR');

  db.prepare('UPDATE parties SET credit_limit=0 WHERE id=?').run(partyId);
  let unlimited = true;
  try { assertPartyCreditLimitOk(db, custId, 9_999_999_999); } catch (_) { unlimited = false; }
  ok(unlimited, 'limit 0 = unlimited');

  // --- cheque XOR ---
  const xor = xorChequeBookTargets(7, 9);
  ok(xor.customerId === 7 && xor.personId == null, 'xor prefers customer');
  const xorP = xorChequeBookTargets(null, 9);
  ok(xorP.customerId == null && xorP.personId === 9, 'xor person alone');

  const personId = db.prepare(`
    INSERT INTO persons (name,phone,party_id,active) VALUES ('شخص چک','09120000002',?,1)
  `).run(partyId).lastInsertRowid;
  const credit = resolveChequeInCredit(db, { partyId, customerId: custId });
  ok(credit.customerId === custId && credit.personId == null, 'resolveChequeInCredit customer XOR');

  const chequeId = 337001;
  postChequePartyBooks(db, {
    chequeId, customerId: custId, personId, date: todayJalali(),
    description: 'test xor', amountRial: 100_000, userId: 1, refType: 'cheque_in',
  });
  const cl = db.prepare(`SELECT COUNT(*) c FROM customer_ledger WHERE ref_type='cheque_in' AND ref_id=?`).get(chequeId).c;
  const pl = db.prepare(`SELECT COUNT(*) c FROM person_ledger WHERE ref_type='cheque_in' AND ref_id=?`).get(chequeId).c;
  ok(cl === 1 && pl === 0, 'postChequePartyBooks writes customer only', { cl, pl });

  // --- dual-role leaves ---
  const dualParty = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active)
    VALUES ('P-DUAL337','both','["customer","supplier"]','دو نقش','09120000003',1)
  `).run().lastInsertRowid;
  const arLeaf = allocTafsili(db, 'customer', 'دو نقش AR');
  db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(arLeaf, dualParty);
  syncPartyToLegacy(db, dualParty);
  ensureDualRoleSeparateLeaves(db, dualParty);
  const custRow = db.prepare('SELECT coa_code FROM customers WHERE party_id=?').get(dualParty);
  const supRow = db.prepare('SELECT coa_code FROM suppliers WHERE party_id=?').get(dualParty);
  ok(!!custRow?.coa_code, 'dual customer leaf exists');
  ok(!!supRow?.coa_code, 'dual supplier leaf exists');
  ok(String(custRow.coa_code) !== String(supRow.coa_code), 'dual AR ≠ AP leaf', {
    ar: custRow?.coa_code, ap: supRow?.coa_code,
  });
  ok(parseRoles('["customer","supplier"]', 'both').includes('supplier'), 'parseRoles both');

  console.log(`\nparty-acc-adr001-v337: ${pass} pass, ${fail} fail`);
  try { closeDB(); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
