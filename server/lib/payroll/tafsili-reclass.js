'use strict';
/**
 * Historical payroll JEs credited 2104/1106 *control* instead of the employee leaf.
 * In-place account_code correction (same amounts, same JE) so R13 void still
 * reverses the original voucher. Idempotent via settings flag.
 */
const { jlDebitRial, jlCreditRial } = require('../money');
const { netPayRial } = require('./payments');
const { resolvePersonPayableAccount, controlPayableCodes } = require('./person-account');

const FLAG = 'payroll_person_tafsili_reclass_v300';

function lineMatchesExpected(line, expectedRial) {
  const mag = Math.max(Math.abs(jlDebitRial(line)), Math.abs(jlCreditRial(line)));
  return Math.abs(mag - Math.round(Number(expectedRial) || 0)) <= 1;
}

function moveMatchingControlLines(db, jeId, personId, expectedRial, controls) {
  if (!jeId || !personId || !expectedRial) return 0;
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  const dest = resolvePersonPayableAccount(db, person);
  if (!dest || !dest.code || controls.has(String(dest.code))) return 0;

  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(jeId);
  const upd = db.prepare(
    'UPDATE journal_lines SET account_code=?, account_name=? WHERE id=? AND account_code=?'
  );
  let n = 0;
  for (const line of lines) {
    const code = String(line.account_code || '');
    if (!controls.has(code) || code === dest.code) continue;
    if (!lineMatchesExpected(line, expectedRial)) continue;
    n += upd.run(dest.code, dest.name, line.id, line.account_code).changes;
  }
  return n;
}

function reclassPayrollPayableToPersonTafsili(db) {
  const existing = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (existing && existing.value === '1') return { skipped: true, moved: 0 };

  const controls = controlPayableCodes(db);
  let moved = 0;
  const run = db.transaction(() => {
    const records = db.prepare(`
      SELECT * FROM payroll_records
      WHERE COALESCE(status,'') <> 'reversed' AND journal_entry_id IS NOT NULL
    `).all();
    for (const rec of records) {
      const exp = netPayRial(rec) + Math.round(Number(rec.arrears_rial) || 0);
      moved += moveMatchingControlLines(db, rec.journal_entry_id, rec.person_id, exp, controls);
    }

    try {
      const pays = db.prepare(`
        SELECT p.journal_id, p.amount_rial, r.person_id
        FROM payroll_payments p
        JOIN payroll_records r ON r.id = p.payroll_record_id
        WHERE COALESCE(p.status,'posted') <> 'reversed' AND p.journal_id IS NOT NULL
      `).all();
      for (const p of pays) {
        moved += moveMatchingControlLines(db, p.journal_id, p.person_id, p.amount_rial, controls);
      }
    } catch (_) { /* payroll_payments optional */ }

    try {
      const ye = db.prepare(`
        SELECT id, person_id, journal_entry_id, net_pay_rial
        FROM payroll_year_end_bonuses
        WHERE status IN ('posted','paid') AND journal_entry_id IS NOT NULL
      `).all();
      for (const y of ye) {
        moved += moveMatchingControlLines(db, y.journal_entry_id, y.person_id, y.net_pay_rial, controls);
      }
    } catch (_) { /* year-end optional */ }

    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
  });
  run();
  return { skipped: false, moved };
}

module.exports = { reclassPayrollPayableToPersonTafsili, FLAG };
