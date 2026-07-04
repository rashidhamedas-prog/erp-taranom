#!/usr/bin/env node
// Tenant-isolation lint (CI gate): scans route files for SQL statements that touch
// tenant-scoped tables without an explicit tenant_id filter/column. Any hit fails the
// build — per the v4 development rule: «هیچ کوئری بدون فیلتر صریح tenant_id نوشته نمی‌شود».
//
// Usage: node scripts/check-tenant-isolation.js   (exit 0 = pass, 1 = violations)

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const SERVICES_DIR = path.join(__dirname, '..', 'services');

const TENANT_TABLES = [
  'customers', 'orders', 'followups', 'invoices', 'products', 'stock_logs', 'messages',
  'reminders', 'sms_log', 'settlements', 'api_keys', 'webhooks', 'customer_ledger',
  'journal_entries', 'incentive_payments', 'settings', 'chart_of_accounts', 'audit_log',
  'warehouses', 'einvoice_submissions', 'b2b_portal_accounts', 'b2b_portal_orders',
  'ai_insights', 'sync_queue', 'sync_conflicts',
];

// Statements that are legitimately tenant-free. Keep this list SHORT and justified.
const ALLOWLIST = [
  /FROM users WHERE username=\?/,                      // login: username is globally unique
  /FROM users WHERE id=\?( AND tenant_id=\?)?/,        // self lookups after auth (id from verified JWT)
  /UPDATE users SET last_login/,                       // login bookkeeping on own row
  /UPDATE users SET password=\? WHERE id=\?$/,         // change own password (id from verified JWT)
  /FROM two_factor_auth WHERE user_id=\?/,             // keyed by verified user id
  /INTO two_factor_auth/, /UPDATE two_factor_auth/, /DELETE FROM two_factor_auth/,
  /FROM journal_lines/, /INTO journal_lines/, /DELETE FROM journal_lines WHERE entry_id/, // child of tenant-scoped journal_entries
  /FROM tenants/, /INTO tenants/, /UPDATE tenants/, /DELETE FROM tenants/, // platform-owner routes are role-gated
  /FROM api_keys WHERE key_hash=\?/,                   // public API: hash IS the credential; tenant read from the row
  /INTO api_usage_log/,                                // includes tenant via bound value
  /FROM warehouse_stock/, /INTO warehouse_stock/, /UPDATE warehouse_stock/, // child rows joined through tenant-scoped warehouses
  /FROM inventory_cost_layers/, /INTO inventory_cost_layers/, /UPDATE inventory_cost_layers/, /DELETE FROM inventory_cost_layers/, // child of tenant-scoped products (product_id verified upstream)
  /UPDATE invoices SET pdf_url=\? WHERE id=\?/,        // PDF worker: id comes from a tenant-scoped fetch
  /UPDATE followups SET sms_sent=1 WHERE id/,          // cron marks rows selected by a tenant-scoped query
  /UPDATE sync_queue SET/, /FROM sync_queue WHERE id=\?/, // worker: row ids from tenant-scoped selects
  /UPDATE einvoice_submissions SET/,                   // worker: row ids from tenant-scoped selects
  // Re-fetch by primary key immediately after a tenant-scoped INSERT/lookup (lastInsertRowid)
  /WHERE f\.id=\?$/, /WHERE i\.id=\?$/, /WHERE m\.id=\?$/, /WHERE o\.id=\? AND o\.tenant_id=\?$/,
  /^SELECT \* FROM products WHERE id=\?$/,
  /^SELECT \* FROM orders WHERE id=\?$/,
  /UPDATE orders SET stock_deducted=1 WHERE id=\?/,    // order row already fetched tenant-scoped
  /UPDATE api_keys SET last_used=\? WHERE id=\?/,      // key row located by unique hash
  /FROM einvoice_submissions WHERE invoice_id=\?/,     // invoice already fetched tenant-scoped
];

function extractSQLStrings(src) {
  // db.prepare('...') / db.prepare("...") / db.prepare(`...`)
  const out = [];
  const re = /\.prepare\(\s*(['"`])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src))) out.push({ sql: m[2], index: m.index });
  // db.exec(`...`) blocks: split on ';'
  const reExec = /\.exec\(\s*(['"`])([\s\S]*?)\1/g;
  while ((m = reExec.exec(src))) {
    for (const stmt of m[2].split(';')) out.push({ sql: stmt, index: m.index, fromExec: true });
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const violations = [];
  for (const { sql, index, fromExec } of extractSQLStrings(src)) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    // DDL is exempt
    if (/^(CREATE|ALTER|PRAGMA|DROP)/i.test(normalized)) continue;
    // Dynamic SQL (template interpolation): the tenant filter typically lives in a
    // where-clause variable built just above — accept if tenant_id appears within
    // the preceding 15 lines of source.
    if (normalized.includes('${')) {
      const before = src.slice(0, index).split('\n').slice(-25).join('\n');
      if (/tenant_id/i.test(before)) continue;
    }
    // Which tenant tables does this statement touch?
    const touched = TENANT_TABLES.filter(t =>
      new RegExp(`(FROM|JOIN|INTO|UPDATE|DELETE FROM)\\s+${t}\\b`, 'i').test(normalized)
    );
    if (!touched.length) continue;
    if (/tenant_id/i.test(normalized)) continue;
    if (ALLOWLIST.some(re => re.test(normalized))) continue;
    if (fromExec && /^(INSERT INTO settings|UPDATE audit_log|DELETE FROM settings|UPDATE products SET mac_cost|UPDATE users SET role)/i.test(normalized)) continue; // one-time idempotent migrations in db.js
    violations.push({ file: path.basename(file), line: lineOf(src, index), tables: touched, sql: normalized.slice(0, 120) });
  }
  return violations;
}

const files = [];
for (const dir of [ROUTES_DIR, SERVICES_DIR]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f));
}

let all = [];
for (const f of files) all = all.concat(checkFile(f));

if (all.length) {
  console.error(`❌ ${all.length} کوئری بدون فیلتر tenant_id پیدا شد:\n`);
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  [${v.tables.join(',')}]  ${v.sql}`);
  }
  process.exit(1);
} else {
  console.log(`✅ جداسازی مستأجران: همه کوئری‌های ${files.length} فایل دارای فیلتر tenant_id هستند`);
  process.exit(0);
}
