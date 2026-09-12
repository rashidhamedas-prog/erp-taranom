/**
 * One-shot: purge detail/tafsili codes on the active company workspace.
 * Safe to re-run (idempotent). Does not wipe invoices — only detail coding.
 *
 * Usage (on server, from server/):
 *   node scripts/_purge-live-tafsili-v214.js
 *   node scripts/_purge-live-tafsili-v214.js --dry-run
 *   node scripts/_purge-live-tafsili-v214.js --all-companies
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || process.env[m[1]] != null) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch { /* optional */ }

const Database = require('better-sqlite3');
const { countTafsiliCoa, purgeDetailCoding, snapshotTxnCounts } = require('../lib/clean-slate');
const ws = require('../lib/company-workspace');

const dry = process.argv.includes('--dry-run');
const allCompanies = process.argv.includes('--all-companies');

function listTargets() {
  if (allCompanies) {
    try {
      const regPath = path.join(
        process.env.COMPANIES_DIR
          || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'crm.db')), 'data', 'companies'),
        'registry.json'
      );
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      return (reg.companies || [])
        .map((c) => ({ id: c.id, name: c.name, dbPath: c.dbPath }))
        .filter((c) => c.dbPath && fs.existsSync(c.dbPath));
    } catch {
      return [{ id: 'active', name: 'active', dbPath: ws.resolveActiveDbPath() }];
    }
  }
  return [{ id: 'active', name: 'active', dbPath: ws.resolveActiveDbPath() }];
}

function purgeOne(dbPath) {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    const hasDa = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='detail_accounts'").get();
    const hasDc = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='detail_categories'").get();
    const before = {
      dbPath,
      detail_accounts: hasDa ? db.prepare('SELECT COUNT(*) c FROM detail_accounts').get().c : 0,
      detail_categories: hasDc ? db.prepare('SELECT COUNT(*) c FROM detail_categories').get().c : 0,
      tafsili_coa: countTafsiliCoa(db),
      coa_total: db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c,
      journals: snapshotTxnCounts(db).journal_entries || 0,
    };
    console.log(JSON.stringify({ phase: 'before', ...before }, null, 2));
    if (dry) {
      console.log(JSON.stringify({ phase: 'dry-run', skipped: true, dbPath }));
      return before;
    }
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    let result;
    try {
      result = db.transaction(() => purgeDetailCoding(db))();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
    const after = {
      detail_accounts: hasDa ? db.prepare('SELECT COUNT(*) c FROM detail_accounts').get().c : 0,
      detail_categories: hasDc ? db.prepare('SELECT COUNT(*) c FROM detail_categories').get().c : 0,
      tafsili_coa: countTafsiliCoa(db),
      coa_total: db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c,
    };
    console.log(JSON.stringify({ phase: 'after', result, ...after }, null, 2));
    return after;
  } finally {
    db.close();
  }
}

function main() {
  const targets = listTargets();
  if (!targets.length) throw new Error('no company DB found');
  for (const t of targets) {
    console.log(JSON.stringify({ phase: 'target', id: t.id, name: t.name, dbPath: t.dbPath }));
    purgeOne(t.dbPath);
  }
}

main();
