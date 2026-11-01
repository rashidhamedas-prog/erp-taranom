'use strict';
/**
 * v586 Phase 1 — configurable coa_* keys: SSOT from LEGACY, PUT validation
 * (leaf/type/control), clearCoaCache, ensureMissingBaseCoa guard, no data migration.
 * Run: node server/scripts/test-configurable-coa-keys-v586.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ v586 — configurable coa_* keys ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-keys-v586-'));
process.env.DB_PATH = path.join(dir, 'coa-keys.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'coa-keys-v586-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const realWarn = console.warn;
console.warn = () => {};

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const {
    LEGACY, acct, clearCoaCache, isPostableCode, ensureMissingBaseCoa, baseCoaTree,
    isControlCoaKey, listCoaKeyDescriptors, wouldCreateChildUnderMappedCoa,
    validateCoaKeyAssignment, mappedCoaTargetCodes,
  } = require('../lib/coa-map');
  const policy = require('../lib/coa-leaf-policy');
  const { ALLOWED_KEYS } = require('../routes/settings');
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');

  console.log('— SSOT —');
  const legacyKeys = Object.keys(LEGACY);
  ok(legacyKeys.length === 94, 'LEGACY has 94 keys (P8 coa_owner_current)', legacyKeys.length);
  ok(legacyKeys.every((k) => ALLOWED_KEYS.includes(k)), 'every LEGACY key is in ALLOWED_KEYS');
  ok(ALLOWED_KEYS.includes('coa_admin_expense'), 'coa_admin_expense allowed');
  ok(ALLOWED_KEYS.includes('coa_rep_commission_expense'), 'coa_rep_commission_expense allowed');
  ok(ALLOWED_KEYS.includes('coa_finished_goods'), 'coa_finished_goods allowed');
  ok(ALLOWED_KEYS.includes('coa_inventory_loss'), 'coa_inventory_loss allowed');
  ok(ALLOWED_KEYS.includes('coa_asset_disposal_loss'), 'coa_asset_disposal_loss allowed');
  ok(ALLOWED_KEYS.includes('coa_issue_internal_consume'), 'coa_issue_* allowed');
  ok(LEGACY.coa_asset_disposal_loss.code === '6105', 'disposal loss default code unchanged');
  ok(LEGACY.coa_asset_disposal_loss.suggested === '6119', 'disposal loss suggested=6119');
  const desc = listCoaKeyDescriptors();
  ok(desc.length === 94, 'listCoaKeyDescriptors count', desc.length);
  ok(desc.every((d) => d.key && d.name && d.group && typeof d.is_control === 'boolean'), 'descriptor shape');
  ok(isControlCoaKey('coa_receivable') && isControlCoaKey('coa_issue_return_to_supplier'), 'control keys flagged');
  ok(!isControlCoaKey('coa_admin_expense'), 'admin expense is non-control');

  console.log('— baseCoa / mapped-parent guard —');
  const legacyCodes = new Set(Object.values(LEGACY).map((m) => String(m.code)));
  const badParents = baseCoaTree().filter(([, , , parent]) => parent && legacyCodes.has(String(parent)));
  ok(badParents.length === 0, 'baseCoaTree has no children under LEGACY default codes', badParents.slice(0, 3));
  ok(wouldCreateChildUnderMappedCoa(db, '6102') === true, 'guard: parent 6102 is mapped');
  ok(wouldCreateChildUnderMappedCoa(db, '6000') === false, 'guard: parent 6000 not mapped');
  const beforeKids = db.prepare("SELECT COUNT(*) c FROM chart_of_accounts WHERE parent_code='6102'").get().c;
  ensureMissingBaseCoa(db);
  const afterKids = db.prepare("SELECT COUNT(*) c FROM chart_of_accounts WHERE parent_code='6102'").get().c;
  ok(afterKids === beforeKids, 'ensureMissingBaseCoa did not add children under 6102', { beforeKids, afterKids });

  // Fixture: make 6102 / 1103 / 1104 non-leaf; add leaf 610205
  const insCoa = db.prepare(
    'INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)'
  );
  insCoa.run('610201', 'زیرمجموعه آزمایشی اداری', 'expense', '6102', 3);
  insCoa.run('610205', 'هزینه اداری — برگ آزمایشی', 'expense', '6102', 3);
  insCoa.run('110301', 'تفصیلی مشتری آزمایشی', 'asset', '1103', 3);
  insCoa.run('110401', 'موجودی — برگ الف', 'asset', '1104', 3);
  ok(!isPostableCode(db, '6102'), 'fixture: 6102 non-leaf');
  ok(isPostableCode(db, '610205'), 'fixture: 610205 leaf');
  ok(!isPostableCode(db, '1103'), 'fixture: 1103 non-leaf (control)');

  console.log('— validateCoaKeyAssignment unit —');
  ok(validateCoaKeyAssignment(db, 'coa_admin_expense', '6102').code === 'E_COA_NOT_LEAF', 'unit: parent → NOT_LEAF');
  ok(validateCoaKeyAssignment(db, 'coa_admin_expense', '610205').ok === true, 'unit: leaf → ok');
  ok(validateCoaKeyAssignment(db, 'coa_cogs', '1104').code === 'E_COA_TYPE_MISMATCH', 'unit: cogs→1104 TYPE_MISMATCH');
  ok(validateCoaKeyAssignment(db, 'coa_receivable', '1103').ok === true, 'unit: control non-leaf ok');
  ok(validateCoaKeyAssignment(db, 'coa_admin_expense', '999999').code === 'E_COA_NOT_FOUND', 'unit: missing → NOT_FOUND');

  console.log('— acct non-leaf warn (no auto-fallback) —');
  policy.clearRecentLeafIssues();
  clearCoaCache();
  db.prepare("DELETE FROM settings WHERE key='coa_admin_expense'").run();
  const adminAcct = acct(db, 'coa_admin_expense');
  ok(adminAcct.code === '6102', 'acct returns legacy non-leaf 6102 (no resolvePostableLeaf)', adminAcct);
  ok(policy.recentLeafIssues().some((x) => x.code === 'E_COA_KEY_NOT_LEAF' && x.key === 'coa_admin_expense' && x.account_code === '6102'),
    'acct logs E_COA_KEY_NOT_LEAF for non-control non-leaf');

  // HTTP harness
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const adminObj = { name: 'مدیر', username: 'coa_keys_admin', password: 'x', role: 'admin', active: 1 };
  if (cols.has('must_change_password')) adminObj.must_change_password = 0;
  const uk = Object.keys(adminObj).filter((k) => cols.has(k));
  const adminId = db.prepare(`INSERT INTO users (${uk.join(',')}) VALUES (${uk.map(() => '?').join(',')})`)
    .run(...uk.map((k) => adminObj[k])).lastInsertRowid;
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v586', device_fingerprint: 'coa-keys-v586',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/settings', require('../routes/settings'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  }

  console.log('— GET /settings/coa-keys —');
  let r = await api('GET', '/api/settings/coa-keys');
  ok(r.status === 200 && r.data.count === 94, 'GET coa-keys 200 / count 94', r.data && r.data.count);
  ok(Array.isArray(r.data.keys) && r.data.keys.some((k) => k.key === 'coa_issue_scrap'), 'includes issue keys');
  ok(Array.isArray(r.data.groups) && r.data.groups.includes('حواله‌ها'), 'groups include حواله‌ها');

  console.log('— PUT validation —');
  r = await api('PUT', '/api/settings', { coa_admin_expense: '6102' });
  ok(r.status === 422 && r.data.code === 'E_COA_NOT_LEAF', 'PUT parent → 422 NOT_LEAF', r.data);
  ok(r.data.error && /coa_admin_expense|عمومی و اداری/.test(r.data.error), 'Persian error names key', r.data.error);

  r = await api('PUT', '/api/settings', { coa_admin_expense: '610205' });
  ok(r.status === 200, 'PUT leaf → 200', r.status);
  ok(String(r.data.coa_admin_expense) === '610205', 'persisted 610205', r.data.coa_admin_expense);

  console.log('— clearCoaCache after save —');
  clearCoaCache();
  // Warm cache with old value then overwrite via another path without clear — simulate:
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_admin_expense','610205')").run();
  clearCoaCache();
  const warm = acct(db, 'coa_admin_expense');
  ok(warm.code === '610205', 'cache warm at 610205');
  // Direct DB change would stale the cache; PUT must clear:
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales_expense','6103')").run();
  // First confirm stale risk exists if we don't clear (set cache then mutate DB):
  clearCoaCache();
  acct(db, 'coa_cogs'); // populate cache object
  const beforePut = acct(db, 'coa_admin_expense').code;
  r = await api('PUT', '/api/settings', { coa_admin_expense: '610205' }); // same value — may skip validation change
  // Change to a different valid leaf and ensure acct picks it up immediately (cache cleared)
  // Create another leaf under 6102
  insCoa.run('610206', 'هزینه اداری — برگ ۲', 'expense', '6102', 3);
  r = await api('PUT', '/api/settings', { coa_admin_expense: '610206' });
  ok(r.status === 200, 'PUT 610206 200');
  const afterPut = acct(db, 'coa_admin_expense');
  ok(afterPut.code === '610206', 'acct sees new value after PUT (cache cleared)', { beforePut, after: afterPut.code });

  r = await api('PUT', '/api/settings', { coa_cogs: '1104' });
  ok(r.status === 422 && r.data.code === 'E_COA_TYPE_MISMATCH', 'PUT cogs=1104 → TYPE_MISMATCH', r.data);

  r = await api('PUT', '/api/settings', { coa_receivable: '1103' });
  ok(r.status === 200, 'PUT control non-leaf receivable → 200', r.status);

  r = await api('PUT', '/api/settings', { coa_totally_unknown_xyz: '1101', company_name: 'ترنم تست' });
  ok(r.status === 200, 'unknown coa key ignored (200)', r.status);
  ok(r.data.coa_totally_unknown_xyz == null || r.data.coa_totally_unknown_xyz === undefined
    || !Object.prototype.hasOwnProperty.call(
      db.prepare("SELECT key FROM settings WHERE key='coa_totally_unknown_xyz'").get() || {},
      'key'
    ), 'unknown key not persisted');
  const unk = db.prepare("SELECT 1 FROM settings WHERE key='coa_totally_unknown_xyz'").get();
  ok(!unk, 'unknown key absent from settings table');

  // mapped targets include settings overrides
  ok(mappedCoaTargetCodes(db).has('610206'), 'mapped targets include override 610206');

  server.close();
  closeSessionStore();
  console.warn = realWarn;
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.warn = realWarn;
  console.error('TEST HARNESS ERROR:', e);
  process.exitCode = 1;
});
