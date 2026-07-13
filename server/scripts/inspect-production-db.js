// Quick production DB inspection — run on server: node scripts/inspect-production-db.js [path]
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'crm.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const stat = fs.statSync(dbPath);
console.log('file:', dbPath);
console.log('size:', (stat.size / 1024 / 1024).toFixed(2), 'MB');
console.log('mtime:', stat.mtime.toISOString());

const db = new Database(dbPath, { readonly: true });
try {
  const ic = db.pragma('integrity_check');
  console.log('integrity:', Array.isArray(ic) ? ic[0] : ic);

  const q = (sql) => {
    try { return db.prepare(sql).get(); }
    catch (e) { return { error: e.message }; }
  };

  console.log('coa_mode:', q("SELECT value FROM settings WHERE key='coa_mode'"));
  console.log('chart_of_accounts:', q('SELECT COUNT(*) c FROM chart_of_accounts').c);
  console.log('journal_entries:', q('SELECT COUNT(*) c FROM journal_entries').c);
  console.log('journal_lines:', q('SELECT COUNT(*) c FROM journal_lines').c);
  console.log('mahak_journals:', q("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak'").c);
  console.log('products:', q('SELECT COUNT(*) c FROM products').c);
  console.log('customers:', q('SELECT COUNT(*) c FROM customers').c);
} finally {
  db.close();
}
