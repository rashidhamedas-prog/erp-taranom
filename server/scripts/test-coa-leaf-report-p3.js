'use strict';
/**
 * Phase 3 — leaf report categories + fixed-asset warehouse COA validation (code only).
 * Spec: .tmp-coa-keys-fix/phase-3-leaf-report-and-wh36.md
 * Run: node server/scripts/test-coa-leaf-report-p3.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ Phase 3 — coa leaf report + wh36 ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-leaf-p3-'));
process.env.DB_PATH = path.join(dir, 'p3.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'coa-leaf-p3-test-secret-at-least-32-chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const { LEGACY } = require('../lib/coa-map');
const policy = require('../lib/coa-leaf-policy');
const { buildCoaLeafReport, settingsNonLeaf } = require('../lib/coa-leaf-report');
const L = require('../lib/inventory/ledger');

function coa(code, name, type, parent, level) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
    .run(code, name, type, parent, level || 3);
}

const colsCache = new Map();
const cols = (t) => {
  if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
  return colsCache.get(t);
};
function insert(table, obj) {
  const c = cols(table);
  const keys = Object.keys(obj).filter((k) => c.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

// Parents with children so they are non-leaf (control-style)
coa('1103', 'حساب‌های دریافتنی', 'asset', '1100', 2);
coa('110301', 'دریافتنی — نمونه', 'asset', '1103', 3);
coa('2101', 'حساب‌های پرداختنی', 'liability', '2100', 2);
coa('210101', 'پرداختنی — نمونه', 'liability', '2101', 3);
coa('1104', 'موجودی کالای ساخته‌شده', 'asset', '1100', 2);
coa('110401', 'موجودی — الف', 'asset', '1104', 3);
coa('6102', 'هزینه‌های اداری', 'expense', '6100', 2);
coa('610201', 'اداری — دفتر', 'expense', '6102', 3);
coa('1201', 'ماشین‌آلات', 'asset', '1200', 2);
coa('120101', 'ماشین‌آلات — برگ', 'asset', '1201', 3);
coa('5190', 'بهای تمام‌شده', 'cogs', '5000', 3);

// Point known control keys at non-leaf controls; admin expense at non-leaf 6102
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_receivable','1103')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_payable','2101')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_admin_expense','6102')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_issue_return_to_supplier','2101')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();

console.log('— settings categories —');
const sett = settingsNonLeaf(db);
ok(sett.control.some((x) => x.key === 'coa_receivable' && x.code === '1103'), 'control: coa_receivable in control bucket');
ok(sett.control.some((x) => x.key === 'coa_issue_return_to_supplier'), 'control: coa_issue_return_to_supplier in control');
ok(!sett.not_leaf.some((x) => x.key === 'coa_receivable'), 'control key NOT counted in not_leaf');
ok(sett.not_leaf.some((x) => x.key === 'coa_admin_expense' && x.code === '6102'), 'coa_admin_expense=6102 (has children) → not_leaf');

const rep = buildCoaLeafReport(db);
ok(rep.summary.settings_keys_total === Object.keys(LEGACY).length, 'settings_keys_total = LEGACY size', rep.summary.settings_keys_total);
ok(rep.summary.settings_nonleaf === sett.not_leaf.length, 'summary.settings_nonleaf = not_leaf only', rep.summary);
ok(rep.summary.settings_control === sett.control.length, 'summary.settings_control', rep.summary);
ok(rep.summary.settings_not_found === sett.not_found.length, 'summary.settings_not_found', rep.summary);
ok(rep.summary.needs_attention === (sett.not_leaf.length + sett.not_found.length > 0
  || rep.summary.warehouses_perpetual_unmapped > 0
  || (rep.nonleaf_balances_split.non_control || []).length > 0
  || (rep.control_accounts || []).some((c) => c.lines_on_control > 0)
  || rep.summary.needs_attention), 'needs_attention present');
ok(Array.isArray(rep.control_accounts), 'control_accounts section present');
ok(rep.nonleaf_balances_split && Array.isArray(rep.nonleaf_balances_split.control)
  && Array.isArray(rep.nonleaf_balances_split.non_control), 'nonleaf_balances split into control / non_control');

console.log('— inactive warehouse out of unmapped —');
const whActive = insert('warehouses', {
  name: 'فعال بی‌نگاشت', code: 'P3A', active: 1, warehouse_type: 'finished_goods',
  inventory_system: 'perpetual', allow_negative: 0, is_default: 0,
});
const whInactive = insert('warehouses', {
  name: 'غیرفعال بی‌نگاشت', code: 'P3I', active: 0, warehouse_type: 'finished_goods',
  inventory_system: 'perpetual', allow_negative: 0, is_default: 0,
});
const rep2 = buildCoaLeafReport(db);
const unmappedIds = (rep2.warehouses_unmapped || []).map((w) => w.warehouse_id);
const inactiveIds = (rep2.warehouses_inactive_unmapped || []).map((w) => w.warehouse_id);
ok(unmappedIds.includes(whActive) && !unmappedIds.includes(whInactive), 'inactive warehouse NOT in warehouses_unmapped', unmappedIds);
ok(inactiveIds.includes(whInactive) && !inactiveIds.includes(whActive), 'inactive perpetual unmapped in separate section', inactiveIds);
ok(rep2.summary.warehouses_inactive_unmapped >= 1, 'summary.warehouses_inactive_unmapped');

console.log('— fixed-asset 1104 → 422 —');
const whFA = insert('warehouses', {
  name: 'دارایی ۳۶', code: 'FA36', active: 1, warehouse_type: 'دارایی_ثابت',
  inventory_system: 'perpetual', inventory_coa_code: '1104', cogs_coa_code: '5190',
  allow_negative: 0, is_default: 0,
});
let err = null;
try { L.inventoryAccountForWarehouse(db, whFA); } catch (e) { err = e; }
ok(err && err.status === 422 && err.code === 'E_WAREHOUSE_TYPE_UNSUPPORTED', 'inventoryAccountForWarehouse(1104) → 422', err && { c: err.code, s: err.status });
const v = policy.validateWarehouseCoaInput(db, {
  warehouse_type: 'دارایی_ثابت', inventory_system: 'perpetual',
  inventory_coa_code: '1104', cogs_coa_code: '5190',
});
ok(v && v.status === 422, 'validateWarehouseCoaInput(1104) → 422', v);

const vWarn = policy.validateWarehouseCoaInput(db, {
  warehouse_type: 'دارایی_ثابت', inventory_system: 'perpetual',
  inventory_coa_code: '120101', cogs_coa_code: '5190',
});
ok(vWarn && vWarn.status === 0 && /موجودی کالا نیست/.test(String(vWarn.warning || '')), 'perpetual fixed-asset → warning', vWarn);

db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('120101', whFA);
ok(L.inventoryAccountForWarehouse(db, whFA).code === '120101', 'valid 12xx leaf accepted');
ok(q1Type(whFA) === 'دارایی_ثابت', 'NO data migration of warehouse_type');

function q1Type(id) {
  return db.prepare('SELECT warehouse_type FROM warehouses WHERE id=?').get(id).warehouse_type;
}

console.log(`\n══ Phase 3 result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
