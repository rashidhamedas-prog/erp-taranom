#!/usr/bin/env node
/**
 * Fresh Mahak go-live: wipe target DB and import coding + journal + stock.
 * Usage (from repo root):
 *   node server/scripts/mahak-go-live.js <coding.xlsx> <roznameh.xlsx> <mojodi.xlsx> [target.db]
 *
 * Default target: server/crm.db (set DB_PATH for PM2 production).
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('usage: node mahak-go-live.js <coding.xlsx> <roznameh.xlsx> <mojodi.xlsx> [target.db]');
  process.exit(1);
}

const [coding, journal, mojodi, targetArg] = args;
const codingPath = path.resolve(coding);
const journalPath = path.resolve(journal);
const mojodiPath = path.resolve(mojodi);
const dbPath = path.resolve(targetArg || path.join(__dirname, '..', 'crm.db'));

for (const [label, p] of [['coding', codingPath], ['journal', journalPath], ['mojodi', mojodiPath]]) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: ${label} file not found: ${p}`);
    process.exit(1);
  }
}

const scriptsDir = __dirname;
const serverDir = path.join(scriptsDir, '..');
const backupsDir = path.join(serverDir, 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

if (fs.existsSync(dbPath)) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(backupsDir, `pre-mahak-go-live-${ts}.db`);
  fs.copyFileSync(dbPath, backup);
  console.log(`==> backed up existing DB → ${backup}`);
  for (const ext of ['-wal', '-shm']) {
    const side = dbPath + ext;
    if (fs.existsSync(side)) fs.unlinkSync(side);
  }
  fs.unlinkSync(dbPath);
}

console.log('==> creating fresh database schema...');
process.env.DB_PATH = dbPath;
const { initDB, getDB } = require('../db');
initDB();
getDB().close();

function run(script, scriptArgs) {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, script), ...scriptArgs], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, DB_PATH: dbPath },
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

console.log('\n==> phase 1/2: journal + coding import...');
run('import-mahak-journal.js', [codingPath, journalPath, dbPath]);

console.log('\n==> phase 2/2: stock import...');
run('import-mahak-stock.js', [codingPath, mojodiPath, dbPath]);

const db = require('better-sqlite3')(dbPath, { readonly: true });
const summary = {
  integrity: db.pragma('integrity_check'),
  coa_mode: db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get()?.value,
  chart_of_accounts: db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c,
  journal_entries: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
  journal_lines: db.prepare('SELECT COUNT(*) c FROM journal_lines').get().c,
  mahak_entries: db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak'").get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  product_stock: db.prepare('SELECT SUM(stock) s FROM products').get().s,
  banks: db.prepare('SELECT COUNT(*) c FROM banks').get().c,
  cash_boxes: db.prepare('SELECT COUNT(*) c FROM cash_boxes').get().c,
};
db.close();

console.log('\n==> GO-LIVE SUMMARY');
console.log(JSON.stringify(summary, null, 2));
console.log(`\n✅ Mahak import complete → ${dbPath}`);
console.log('   Restart server: pm2 restart crm-taranom');
