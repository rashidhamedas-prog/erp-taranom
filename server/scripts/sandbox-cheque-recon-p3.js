#!/usr/bin/env node
'use strict';
/**
 * Phase 3 gate helper — read-only cheque GL ↔ ops reconciliation on a DB copy.
 *
 * Usage:
 *   node scripts/sandbox-cheque-recon-p3.js --db /path/to/crm.copy.db
 *   node scripts/sandbox-cheque-recon-p3.js --db /path/to/crm.copy.db --json
 *
 * NEVER writes to the database (opens better-sqlite3 readonly).
 * Prefer a filesystem copy of production, not the live crm.db path.
 *
 * Related quality report:
 *   node scripts/report-cheque-quality.js --db /path/to/crm.copy.db [--out report.md]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildChequeReconciliation, buildOpeningChequeReconciliation } = require('../lib/cheque-reconciliation');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

const dbPath = arg('--db');
if (!dbPath) {
  console.error('Usage: node scripts/sandbox-cheque-recon-p3.js --db <path-to-copy.db> [--json]');
  console.error('Also: node scripts/report-cheque-quality.js --db <path> [--out report.md]');
  process.exit(2);
}
const abs = path.resolve(dbPath);
if (!fs.existsSync(abs)) {
  console.error('DB not found:', abs);
  process.exit(2);
}

const db = new Database(abs, { readonly: true, fileMustExist: true });
const recon = buildChequeReconciliation(db);
const openingIn = buildOpeningChequeReconciliation(db, 'in');
const openingOut = buildOpeningChequeReconciliation(db, 'out');

const maxVar = Math.max(
  0,
  ...(recon.accounts || []).map((a) => Math.abs(Number(a.variance_rial) || 0))
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    db: abs,
    max_abs_variance_rial: maxVar,
    accounts: recon.accounts,
    drilldown_counts: {
      cheques_without_je: (recon.drilldown && recon.drilldown.cheques_without_je || []).length,
      jes_without_cheque: (recon.drilldown && recon.drilldown.jes_without_cheque || []).length,
      deleted_je_active_cheque: (recon.drilldown && recon.drilldown.deleted_je_active_cheque || []).length,
    },
    opening_in: openingIn,
    opening_out: openingOut,
  }, null, 2));
} else {
  console.log('# sandbox cheque reconciliation (read-only)');
  console.log('db:', abs);
  console.log('max |variance| rial:', maxVar);
  console.log('');
  console.log('| code | label | gl | ops | variance |');
  console.log('|---|---|---:|---:|---:|');
  for (const a of recon.accounts || []) {
    console.log(`| ${a.code} | ${a.label} | ${a.gl_rial} | ${a.ops_rial} | ${a.variance_rial} |`);
  }
  console.log('');
  console.log('opening in variance:', openingIn && openingIn.variance_rial);
  console.log('opening out variance:', openingOut && openingOut.variance_rial);
  console.log('');
  console.log('gate hint: Phase 3 accepts when core 1109/1116/2109 variance is 0 after ops on a clean sandbox.');
}

db.close();
process.exit(maxVar === 0 ? 0 : 1);
