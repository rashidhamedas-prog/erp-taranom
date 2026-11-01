'use strict';
/**
 * P3 — پیش‌نویس‌های اصلاح 1104 (فقط voucher_drafts؛ هیچ post).
 * Run: node server/scripts/test-p3-recon-drafts.js
 *
 * Isolated temp DB. Covers: boot migration without facts = no-op; guard skips mismatched facts;
 * drafts only in voucher_drafts (no journal row, GL1104 unchanged); idempotent (second run/boot
 * creates nothing); no DELETE; device skip; script report readonly + apply refuses live path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P3 — recon drafts (drafts only) ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-recon-'));
const dbFile = path.join(dir, 'p3.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p3-recon-drafts-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const P3 = require('../lib/inventory/p3-recon-drafts');

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
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const count = (t) => q1(`SELECT COUNT(*) AS c FROM ${t}`).c;
const p3Drafts = () => db.prepare("SELECT * FROM voucher_drafts WHERE description LIKE '%[p3:%' ORDER BY id").all();
const tombs = () => (cols('sync_tombstones').size ? count('sync_tombstones') : 0);
function snap() {
  return {
    je: count('journal_entries'), jl: count('journal_lines'), jeMax: q1('SELECT COALESCE(MAX(id),0) m FROM journal_entries').m,
    led: count('inventory_ledger'), tombs: tombs(), gl: P3.gl1104ApprovedRial(db),
  };
}

// ── migration on empty DB ──
ok(!q1("SELECT 1 FROM settings WHERE key=?", P3.SETTINGS_KEY), 'boot without facts: no marker');
ok(p3Drafts().length === 0, 'boot without facts: no drafts');

// ── seed facts (mirror production ids) ──
for (const [code, name, type, parent] of [
  ['1104', 'موجودی کالا', 'asset', null], ['3102', 'تراز افتتاحیه', 'equity', null],
  ['3201', 'افتتاحیه سال مالی', 'equity', null], ['610801', 'خالص کسری انبار', 'expense', null],
  ['5101', 'بهای تمام‌شده کالای فروش رفته', 'expense', null],
]) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)').run(code, name, type, parent);
  db.prepare('UPDATE chart_of_accounts SET is_active=1 WHERE code=?').run(code);
}
const tech = insert('users', { name: 'فنی', username: 'tech', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
insert('users', { name: 'حامد رشید', username: 'hamed', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
for (const [id, name] of [[34, 'محصول'], [35, 'کیمیا']]) {
  insert('warehouses', { id, name, code: 'W' + id, active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
}
for (const pid of [109, 115, 131, 183, 334, 335, 340, 341, 500]) {
  insert('products', { id: pid, user_id: tech, name: 'کالا ' + pid, code: 'P3-' + pid, price: 1, cost: 0, stock: 0, warehouse_id: 34, average_cost_rial: 0, unit: 'عدد' });
}
function je(id, refType, date, lines, status = 'approved') {
  insert('journal_entries', { id, entry_date: date, description: 'seed ' + refType, ref_type: refType, ref_id: id, status, created_by: tech });
  for (const l of lines) {
    insert('journal_lines', { entry_id: id, account_code: l.code, account_name: l.code, debit: 0, credit: 0, debit_rial: l.dr || 0, credit_rial: l.cr || 0 });
  }
}
// background GL so 1104 has a balance
je(100, 'opening_inventory', '1405/01/01', [{ code: '1104', dr: 5000000000 }, { code: '3102', cr: 5000000000 }]);
je(1016, 'inventory_recon_adjust', '1405/08/04', [{ code: '3102', dr: 1000 }, { code: '1104', cr: 1000 }]); // wrong amount first
je(490, 'opening_inventory', '1405/07/23', [{ code: '1104', dr: 71232000 }, { code: '3102', cr: 71232000 }]);
let tx = 0;
function led(id, o) {
  insert('inventory_ledger', Object.assign({
    id, tx_no: 'P3T-' + (++tx), status: 'posted', date: '1405/07/01', qty_in: 0, qty_out: 0, amount_rial: 0, source_type: '',
  }, o));
}
led(1978, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 115, warehouse_id: 34, qty_out: 2, amount_rial: 66742000 });
led(1979, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 131, warehouse_id: 35, qty_out: 1, amount_rial: 12913914 });
led(1273, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 334, warehouse_id: 34, qty_out: 3, amount_rial: 66679942 });
led(1230, { event_type: 'opening', source_type: 'opening_inventory', product_id: 335, warehouse_id: 34, qty_in: 12, amount_rial: 71232000, je_id: 490 });
led(1977, { event_type: 'opening', source_type: 'opening_inventory', product_id: 109, warehouse_id: 35, qty_in: 2, amount_rial: 10759000 });
for (const r of P3.OPENINGS_2021_2023) {
  led(r.id, { event_type: 'opening', source_type: 'opening_inventory', product_id: r.product_id, warehouse_id: r.warehouse_id, qty_in: r.qty, amount_rial: r.amount });
}
// zero-inbound transfer 34→35 then a sale in 35 (report-only COGS share)
led(2001, { event_type: 'opening', source_type: 'opening_inventory', product_id: 500, warehouse_id: 34, qty_in: 2, amount_rial: 20000, je_id: 100 });
led(2002, { event_type: 'transfer_out', source_type: 'warehouse_transfer', source_id: 77, product_id: 500, warehouse_id: 34, qty_out: 2, amount_rial: 20000 });
led(2003, { event_type: 'transfer_in', source_type: 'warehouse_transfer', source_id: 77, product_id: 500, warehouse_id: 35, qty_in: 2, amount_rial: 0 });
led(2004, { event_type: 'sale', source_type: 'invoice', source_id: 9, product_id: 500, warehouse_id: 35, qty_out: 1, amount_rial: 0 });

const base = snap();

// ── JE1016 manual draft is superseded (official subledger-recon reverse) — never created ──
let r1 = P3.runP3DraftMigration(db, {});
ok(!r1.skipped.some((s) => s.key === 'je1016_reverse') && !r1.created.some((s) => s.key === 'je1016_reverse'),
  'JE1016 reverse draft: superseded, neither created nor skipped', r1);
ok(r1.created.length === 4, '4 other drafts created (incl. openings 2021–2023)', r1.created);
ok(q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY)?.value === '1', 'marker done (4 drafts)');

// ── device skip ──
ok(P3.runP3DraftMigration(db, { isDevice: true }).skipped === 'device', 'device role: skipped');

// ── reversed JE / linked ledger row → guard false (rolled back) ──
db.prepare("UPDATE journal_lines SET debit_rial=1796860352 WHERE entry_id=1016 AND account_code='3102'").run();
db.prepare("UPDATE journal_lines SET credit_rial=1796860352 WHERE entry_id=1016 AND account_code='1104'").run();
class Rb extends Error {}
try {
  db.transaction(() => {
    db.prepare("UPDATE journal_entries SET status='reversed' WHERE id=1016").run();
    db.prepare('UPDATE inventory_ledger SET je_id=100 WHERE id=1978').run();
    const plan = P3.buildPlan(db);
    ok(!plan.find((s) => s.key === 'je1016_reverse').guard.ok, 'reversed JE 1016 → guard false');
    ok(!plan.find((s) => s.key === 'undoc_adjust_146335856').guard.ok, 'ledger row with je_id → guard false');
    throw new Rb();
  })();
} catch (e) { if (!(e instanceof Rb)) throw e; }

const beforeSecond = snap();
const r2 = P3.runP3DraftMigration(db, {});
ok(r2.skipped === 'done', 'second migration run: done marker → no-op', r2);
const r2b = P3.createP3Drafts(db, {});
ok(r2b.created.length === 0, 'JE1016 facts valid → still no JE1016 manual draft', r2b);
ok(r2b.already.length === 4, 'previous drafts not recreated (idempotent)', r2b.already);

const drafts = p3Drafts();
ok(drafts.length === 4, '4 P3 drafts in voucher_drafts', drafts.length);
const byKey = new Map(drafts.map((d) => [d.description.match(/\[p3:([^\]]+)\]/)[1], { ...d, lines: JSON.parse(d.lines_json) }]));
const sideSum = (d, code, side) => d.lines.filter((l) => l.code === code).reduce((t, l) => t + Number(l[side] || 0), 0);
ok(!byKey.has('je1016_reverse'), 'no JE1016 reverse draft');
const und = byKey.get('undoc_adjust_146335856');
ok(und && sideSum(und, '610801', 'debit') === 146335856 && sideSum(und, '1104', 'credit') === 146335856, 'undoc: Dr 610801 / Cr 1104 = 146,335,856');
ok(und && /ledger#1273/.test(und.description) && und.lines.some((l) => /بررسی WIP/.test(l.description || '')), 'row 1273 flagged «بررسی WIP»');
const o490 = byKey.get('opening_je490_offset');
ok(o490 && sideSum(o490, '1104', 'debit') === 71232000 && sideSum(o490, '3102', 'credit') === 71232000, 'JE490: Dr 1104 / Cr 3102 = 71,232,000');
const o1977 = byKey.get('opening_ledger1977');
ok(o1977 && sideSum(o1977, '1104', 'debit') === 10759000 && sideSum(o1977, '3102', 'credit') === 10759000, 'ledger1977: Dr 1104 / Cr 3102 = 10,759,000');
const o2021 = byKey.get('opening_ledger2021_2023');
ok(o2021 && sideSum(o2021, '1104', 'debit') === 14733111 && sideSum(o2021, '3102', 'credit') === 14733111
  && o2021.lines.filter((l) => l.code === '1104').length === 3, 'ledger2021–2023: 3× Dr 1104 / Cr 3102 = 14,733,111');
ok(!drafts.some((d) => /ledger#2003\b/.test(d.description + d.lines_json)), 'ledger#2003 never referenced');
ok(drafts.every((d) => d.created_by === tech), 'maker = technical user (not Hamed)');

const after = snap();
ok(after.je === beforeSecond.je && after.jl === beforeSecond.jl && after.jeMax === beforeSecond.jeMax, 'no journal_entries/lines created');
ok(after.gl === beforeSecond.gl, 'GL1104 (approved) unchanged by drafts', { before: beforeSecond.gl, after: after.gl });
ok(after.led === base.led && after.tombs === base.tombs, 'no DELETE/tombstone; kardex rows unchanged');
ok(!q1("SELECT 1 FROM journal_entries WHERE description LIKE '%[p3:%'"), 'no journal entry carries a P3 tag');

const rep = P3.buildP3Report(db);
ok(rep.gl_1104_if_all_drafts_posted_rial - rep.gl_1104_live_rial === -146335856 + 71232000 + 10759000 + 14733111, 'hypothetical GL1104 effect = −49,611,745 (JE1016 excluded)', rep.drafts_effect_1104_rial);
ok(rep.plan.find((s) => s.key === 'je1016_reverse').superseded === true, 'report: JE1016 plan entry superseded → official route');
ok(rep.cogs_zero_inbound.pairs === 1 && rep.cogs_zero_inbound.totals.delta_cogs_sales_rial === 10000, 'COGS share (report only) computed', rep.cogs_zero_inbound.totals);
ok(rep.cogs_zero_inbound.draft === null, 'COGS share: no draft');

// ── 3201 coverage guard ──
try {
  db.transaction(() => {
    je(3000, 'manual_voucher', '1405/06/31', [{ code: '1104', dr: 10759000 }, { code: '3201', cr: 10759000 }]);
    ok(!P3.buildPlan(db).find((s) => s.key === 'opening_ledger1977').guard.ok, '3201 line with 10,759,000 → guard false');
    throw new Rb();
  })();
} catch (e) { if (!(e instanceof Rb)) throw e; }

// ── second boot creates nothing ──
const vd0 = count('voucher_drafts');
dbMods.initDB();
ok(count('voucher_drafts') === vd0 && p3Drafts().length === 4, 'second boot creates nothing');

// ── script: report readonly, apply refuses live path ──
db.pragma('wal_checkpoint(TRUNCATE)');
const script = path.join(__dirname, 'inventory-recon-fix.js');
const env = Object.assign({}, process.env);
delete env.DB_PATH;
const repRun = spawnSync(process.execPath, [script, '--mode=report', '--db', dbFile, '--out', path.join(dir, 'out', 'p3')], { encoding: 'utf8', env });
ok(repRun.status === 0 && /mode=report/.test(repRun.stdout), 'script report exit 0', repRun.stderr || repRun.stdout);
ok(fs.existsSync(path.join(dir, 'out', 'p3-report.json')), 'report JSON written');
const liveDir = path.join(dir, 'crm-taranom', 'server');
fs.mkdirSync(liveDir, { recursive: true });
fs.copyFileSync(dbFile, path.join(liveDir, 'crm.db'));
const applyRun = spawnSync(process.execPath, [script, '--mode=apply', '--db', path.join(liveDir, 'crm.db')], { encoding: 'utf8', env });
ok(applyRun.status === 2 && /i-have-p3-approval/.test(applyRun.stderr), 'apply refuses live production path', applyRun.stderr);
const dryRun = spawnSync(process.execPath, [script, '--mode=dry-run', '--db', dbFile], { encoding: 'utf8', env });
ok(dryRun.status === 0 && /already=4/.test(dryRun.stdout), 'dry-run on sandbox: nothing new (already=4)', dryRun.stderr || dryRun.stdout);

console.log(`\n${pass} passed, ${fail} failed\n`);
try { dbMods.closeDB(); } catch (_) {}
process.exit(fail ? 1 : 0);
