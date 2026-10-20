'use strict';
/**
 * v501 heal:
 * 1) Reclass production_labor JE credits that landed on a sibling supplier leaf
 *    onto persons.coa_code (current person leaf).
 * 2) Re-sync journal → party books so sibling wages (same order ref_id) are not dropped.
 * Default dry-run. Apply: node server/scripts/heal-party-labor-turnover-v501.js --apply
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const dryRun = !process.argv.includes('--apply');
const { getDB } = require('../db');
const { resolvePersonPayableAccount } = require('../lib/payroll/person-account');

const db = getDB();
const out = {
  dryRun,
  scanned: 0,
  reclassed: 0,
  synced: 0,
  skipped: 0,
  errors: [],
};

const rows = db.prepare(`
  SELECT le.id AS labor_id, le.person_id, le.amount_rial, le.je_id, le.status,
         p.coa_code AS person_coa, p.name AS person_name
  FROM production_labor_entries le
  JOIN persons p ON p.id = le.person_id
  WHERE le.status='posted'
    AND COALESCE(le.person_id,0)>0
    AND le.je_id IS NOT NULL
    AND LOWER(COALESCE(le.method,'')) IN ('piece','hourly','hours')
  ORDER BY le.id
`).all();

out.scanned = rows.length;

for (const r of rows) {
  try {
    const person = db.prepare('SELECT * FROM persons WHERE id=?').get(r.person_id);
    if (!person) { out.skipped++; continue; }
    const payable = resolvePersonPayableAccount(db, person);
    if (!payable || !payable.code) {
      out.errors.push({ labor_id: r.labor_id, code: 'E_PERSON_NO_COA' });
      continue;
    }
    const cr = db.prepare(`
      SELECT id, account_code FROM journal_lines
      WHERE entry_id=? AND COALESCE(credit,0)+COALESCE(credit_rial,0)>0
      ORDER BY id LIMIT 1
    `).get(r.je_id);
    if (!cr) { out.skipped++; continue; }
    const needsReclass = String(cr.account_code) !== String(payable.code);
    if (!needsReclass && !dryRun) {
      try {
        require('../lib/party-leaf-sync').syncJournalEntryToPartyBooks(db, r.je_id);
        out.synced++;
      } catch (_) { /* optional */ }
      continue;
    }
    if (!needsReclass) { out.skipped++; continue; }

    if (dryRun) {
      out.reclassed++;
      continue;
    }

    db.prepare(`
      UPDATE journal_lines
      SET account_code=?, account_name=?, detail_account_id=COALESCE(?, detail_account_id)
      WHERE id=?
    `).run(payable.code, payable.name, person.detail_account_id || null, cr.id);

    try {
      require('../lib/party-leaf-sync').syncJournalEntryToPartyBooks(db, r.je_id);
      out.synced++;
    } catch (_) { /* optional */ }
    out.reclassed++;
  } catch (e) {
    out.errors.push({ labor_id: r.labor_id, error: e && e.message ? e.message : String(e) });
  }
}

console.log(JSON.stringify(out, null, 2));
if (out.errors.length) process.exitCode = 2;
else if (!dryRun) console.log('applied heal-party-labor-turnover-v501');
else console.log('dry-run only — pass --apply to write');
