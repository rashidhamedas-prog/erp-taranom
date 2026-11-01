'use strict';
/**
 * FR-P334-B — حذف سطر ledger#1273 از پیش‌نویس P3 #2 (v4) + production health/reports بدون سند پیش‌نویس.
 * Run: node server/scripts/test-p334-draft2-trim.js
 *
 * Isolated temp DB in production shape. Replays production history (v1 4-line draft #2 → v2 on 110401,
 * exact production lines_json, version 2), then runs v3 + v4 in boot order and covers:
 * draft #2 = 3 lines / 79,655,914 balanced on 1104, version bumped, wh_data_corrections before/after,
 * idempotent re-run/reboot, posted ⇒ skip, amount mismatch ⇒ skip without write/marker, tag mismatch,
 * device, 110401 trim when v3 did not run, fresh install creates the trimmed draft directly; and
 * production health-check / wipReport / v_wip_by_order ignore status='draft' JEs but count approved ones
 * (and still work on a schema without journal_entries.status).
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

console.log('\n══ FR-P334-B — P3 draft #2 without ledger#1273 + production JE live ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p334b-'));
process.env.DB_PATH = path.join(dir, 'p334b.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p334-draft2-trim-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const P3 = require('../lib/inventory/p3-recon-drafts');
const { runHealthCheck, adr011Balance } = require('../lib/production/health-check');
const reports = require('../lib/production/reports');
const { acct } = require('../lib/coa-map');

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
class Rb extends Error {}
function rollback(fn) {
  try { db.transaction(() => { fn(); throw new Rb(); })(); } catch (e) { if (!(e instanceof Rb)) throw e; }
}
const QUIET = { silent: true };

// ── seed: production-shaped chart + source facts ──
for (const [code, name, type, parent] of [
  ['1100', 'دارایی جاری', 'asset', null], ['1104', 'موجودی کالا', 'asset', '1100'],
  ['3102', 'تراز افتتاحیه', 'equity', null], ['3201', 'افتتاحیه سال مالی', 'equity', null],
  ['610801', 'خالص کسری انبار', 'expense', null], ['5101', 'بهای تمام‌شده کالای فروش رفته', 'expense', null],
]) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)').run(code, name, type, parent);
  db.prepare('UPDATE chart_of_accounts SET is_active=1 WHERE code=?').run(code);
}
db.prepare("DELETE FROM chart_of_accounts WHERE parent_code='1104' OR code LIKE '110401%'").run();
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('110401','موجودی کالا','asset','1104',1)").run();
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('1104010001','کالا 1','asset','110401',1)").run();
const tech = insert('users', { name: 'فنی', username: 'tech', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
for (const id of [34, 35]) {
  insert('warehouses', { id, name: 'W' + id, code: 'W' + id, active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
}
for (const pid of [109, 115, 131, 183, 334, 335, 340, 341]) {
  insert('products', { id: pid, user_id: tech, name: 'کالا ' + pid, code: 'P334-' + pid, price: 1, cost: 0, stock: 0, warehouse_id: 34, average_cost_rial: 0, unit: 'عدد' });
}
function je(id, refType, refId, date, lines, description, status = 'approved') {
  insert('journal_entries', { id, entry_date: date, description: description || 'seed ' + refType, ref_type: refType, ref_id: refId, status, created_by: tech });
  let ln = 1;
  for (const l of lines) {
    insert('journal_lines', { entry_id: id, account_code: l.code, account_name: l.code, debit: 0, credit: 0, debit_rial: l.dr || 0, credit_rial: l.cr || 0, line_no: ln++ });
  }
}
je(100, 'opening_inventory', 100, '1405/01/01', [{ code: '1104', dr: 10000000000 }, { code: '3102', cr: 10000000000 }]);
je(1016, 'inventory_recon_adjust', 1, '1405/08/04', [{ code: '3102', dr: 1796860352 }, { code: '1104', cr: 1796860352 }]);
je(490, 'opening_inventory', 490, '1405/07/23', [{ code: '1104', dr: 71232000 }, { code: '3102', cr: 71232000 }]);
let tx = 0;
function led(id, o) {
  insert('inventory_ledger', Object.assign({ id, tx_no: 'P334-' + (++tx), status: 'posted', date: '1405/07/01', qty_in: 0, qty_out: 0, amount_rial: 0, source_type: '' }, o));
}
led(1978, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 115, warehouse_id: 34, qty_out: 2, amount_rial: 66742000 });
led(1979, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 131, warehouse_id: 35, qty_out: 1, amount_rial: 12913914 });
led(1273, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 334, warehouse_id: 34, qty_out: 3, amount_rial: 66679942 });
led(1230, { event_type: 'opening', source_type: 'opening_inventory', product_id: 335, warehouse_id: 34, qty_in: 12, amount_rial: 71232000, je_id: 490 });
led(1977, { event_type: 'opening', source_type: 'opening_inventory', product_id: 109, warehouse_id: 35, qty_in: 2, amount_rial: 10759000 });
for (const r of P3.OPENINGS_2021_2023) {
  led(r.id, { event_type: 'opening', source_type: 'opening_inventory', product_id: r.product_id, warehouse_id: r.warehouse_id, qty_in: r.qty, amount_rial: r.amount });
}
led(2003, { event_type: 'opening', source_type: 'opening_inventory', product_id: 334, warehouse_id: 35, qty_in: 8, amount_rial: 165582632 });

const KEY = P3.UNDOC_KEY;
const TAG = `[p3:${KEY}]`;
const OLD_KEYS = [KEY, 'opening_je490_offset', 'opening_ledger1977'];
const draftRow = (id) => q1('SELECT * FROM voucher_drafts WHERE id=?', id);
const markerId = (key) => Number((q1("SELECT new_value FROM wh_data_corrections WHERE rule='p3_draft' AND row_key=? AND col='id' ORDER BY id DESC LIMIT 1", key) || {}).new_value || 0);
const linesOf = (id) => JSON.parse(draftRow(id).lines_json);
const shape = (ls) => JSON.stringify(ls.map((l) => [l.code, l.debit, l.credit]));
const v4Marker = () => (q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_V4) || {}).value || null;
const v4Logs = () => db.prepare("SELECT * FROM wh_data_corrections WHERE rule='p3_draft_v4' ORDER BY id").all();
const hasVersion = cols('voucher_drafts').has('version');

const PROD_LINES_110401 = [
  { code: '610801', debit: 66742000, credit: 0, description: 'تعدیل بی‌سند ledger#1978 کالا 115' },
  { code: '610801', debit: 12913914, credit: 0, description: 'تعدیل بی‌سند ledger#1979 کالا 131' },
  { code: '610801', debit: 66679942, credit: 0, description: 'تعدیل بی‌سند ledger#1273 کالا 334 — «بررسی WIP»' },
  { code: '110401', debit: 0, credit: 146335856, description: 'موجودی کالا — ledger#1978/1979/1273' },
];

// ── static facts ──
ok(P3.UNDOC_TOTAL === 79655914 && 66742000 + 12913914 === P3.UNDOC_TOTAL, 'UNDOC_TOTAL = 66,742,000 + 12,913,914 = 79,655,914');
ok(P3.UNDOC_LEGACY_TOTAL === P3.UNDOC_TOTAL + 66679942, 'legacy total = 146,335,856 (incl. ledger#1273)');
ok(P3.OFFICIAL_KARDEX_REVERSAL_LEDGER_IDS.includes(1273) && P3.EXCLUDED_LEDGER_IDS.includes(2003), '1273 → official reversal list; 2003 still excluded');
ok(JSON.stringify(P3.legacyUndocLines('110401')) === JSON.stringify(PROD_LINES_110401), 'legacyUndocLines(110401) === production lines_json (byte-exact)');
const spec = P3.specLines(KEY, '1104');
ok(spec.length === 3 && shape(spec) === JSON.stringify([['610801', 66742000, 0], ['610801', 12913914, 0], ['1104', 0, 79655914]])
  && !JSON.stringify(spec).includes('ledger#1273'), 'new spec: 3 lines, Cr 1104 79,655,914, no ledger#1273');
const plan = P3.buildPlan(db).find((s) => s.key === KEY);
ok(plan.amount === 79655914 && plan.description.includes(TAG) && !plan.description.includes('ledger#1273') && plan.guard.ok, 'plan entry: 79,655,914, tagged, no ledger#1273, guard ok');

// ── replay production history: v1 (4 lines on 1104) → v2 (110401) → exact prod row, version 2 ──
const hist = P3.createP3Drafts(db, { onlyKeys: OLD_KEYS });
ok(hist.created.length === 3, 'history: v1 created 3 drafts', hist);
const ids = Object.fromEntries(OLD_KEYS.map((k) => [k, markerId(k)]));
const D2 = ids[KEY];
db.prepare('UPDATE voucher_drafts SET lines_json=?, description=? WHERE id=?')
  .run(JSON.stringify(P3.legacyUndocLines('1104')), P3.legacyUndocDescription(), D2);
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('p3_recon_drafts_v1','1')").run();
const v2 = P3.runP3DraftsV2Migration(db, { leafCode: '110401' });
ok(v2.rewritten.length === 3 && v2.rewritten.some((r) => r.key === KEY), 'history: v2 rewrote legacy 4-line draft #2 → 110401', v2);
ok(draftRow(D2).lines_json === JSON.stringify(PROD_LINES_110401), 'history: draft #2 lines_json === production (110401, 146,335,856)');
if (hasVersion) db.prepare('UPDATE voucher_drafts SET version=2 WHERE id=?').run(D2);

// ── v4 before v3 (inventory still 110401) — trims on 110401 (rolled back) ──
rollback(() => {
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  const ls = linesOf(D2);
  ok(r.state === 'trimmed' && r.inventory_code === '110401' && ls.length === 3 && ls[2].code === '110401' && ls[2].credit === 79655914,
    'v4 without v3: trims on 110401 (code kept), Cr 79,655,914', r);
});

// ── v3 (boot order) → legacy 4 lines on 1104 ──
const v3 = P3.runP3DraftsV3Migration(db, {});
ok(v3.rewritten.some((r) => r.key === KEY && r.from === '110401' && r.to === '1104'), 'v3: draft #2 110401 → 1104 (4 lines kept)', v3.rewritten);
ok(shape(linesOf(D2)) === shape(P3.legacyUndocLines('1104')), 'after v3: draft #2 = legacy 4 lines on 1104');
const otherBefore = Object.fromEntries(db.prepare("SELECT id, lines_json FROM voucher_drafts WHERE id<>?").all(D2).map((r) => [r.id, r.lines_json]));

// ── v4 safety branches (rolled back) ──
ok(P3.runP3DraftsV4Migration(db, { isDevice: true }).skipped === 'device', 'v4 device: skipped');
rollback(() => {
  const desc = draftRow(D2).description;
  db.prepare('DELETE FROM voucher_drafts WHERE id=?').run(D2); // what «ثبت پیش‌نویس» does
  je(9001, 'manual_voucher', null, '1405/08/10', P3.legacyUndocLines('1104').map((l) => ({ code: l.code, dr: l.debit, cr: l.credit })), desc);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.state === 'skipped' && r.why === 'posted' && !v4Marker() && v4Logs().length === 0, 'v4: posted draft (row consumed) → skip, no marker, no log', r);
});
rollback(() => {
  const before = draftRow(D2).lines_json;
  je(9002, 'manual_voucher', null, '1405/08/10', [{ code: '1104', dr: 1 }, { code: '3102', cr: 1 }], `سند ${TAG}`);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.why === 'posted' && draftRow(D2).lines_json === before && !v4Marker(), 'v4: JE carrying the tag exists → skip posted, untouched', r);
});
rollback(() => {
  const ls = linesOf(D2);
  ls[2].debit = 66679943; ls[3].credit = 146335857;
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(ls), D2);
  const before = JSON.stringify(draftRow(D2));
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.state === 'skipped' && r.why === 'lines_mismatch' && JSON.stringify(draftRow(D2)) === before && !v4Marker() && v4Logs().length === 0,
    'v4: 1273 amount differs → skip lines_mismatch, no write, no marker, no log', r);
});
rollback(() => {
  const ls = linesOf(D2);
  ls[3].credit = 146335855; ls[0].debit = 66741999;
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(ls), D2);
  const before = draftRow(D2).lines_json;
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.why === 'lines_mismatch' && draftRow(D2).lines_json === before && !v4Marker(), 'v4: other amount differs → skip, no write', r);
});
rollback(() => {
  const ls = linesOf(D2);
  ls[3].code = '3102';
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(ls), D2);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.why === 'lines_mismatch' && !v4Marker(), 'v4: credit not on 1104/110401 → skip', r);
});
rollback(() => {
  db.prepare('UPDATE voucher_drafts SET description=? WHERE id=?').run('توضیح ویرایش‌شده بدون برچسب', D2);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.why === 'tag_mismatch' && !v4Marker(), 'v4: tag removed → skip tag_mismatch', r);
});
rollback(() => {
  db.prepare("DELETE FROM wh_data_corrections WHERE rule='p3_draft' AND row_key=?").run(KEY);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.why === 'no_marker' && !v4Marker(), 'v4: no p3_draft marker → skip, no settings marker', r);
});
ok(!v4Marker() && v4Logs().length === 0, 'rollback scenarios left no v4 marker / log');

// ── real v4 ──
const ver0 = hasVersion ? Number(draftRow(D2).version || 0) : null;
const desc0 = draftRow(D2).description;
const lines0 = draftRow(D2).lines_json;
const jeN = { je: count('journal_entries'), jl: count('journal_lines') };
const vdN = count('voucher_drafts');
const gl0 = P3.gl1104ApprovedRial(db);
const v4 = P3.runP3DraftsV4Migration(db, QUIET);
ok(v4.state === 'trimmed' && v4.changed && v4.draft_id === D2 && v4.inventory_code === '1104', 'v4: draft #2 trimmed (1104)', v4);
const ls = linesOf(D2);
ok(ls.length === 3 && shape(ls) === shape(P3.specLines(KEY, '1104')), 'draft #2 = 3 lines: Dr 610801 66,742,000 / 12,913,914, Cr 1104 79,655,914');
ok(ls.reduce((t, l) => t + l.debit - l.credit, 0) === 0, 'draft #2 balanced');
ok(ls[0].description === PROD_LINES_110401[0].description && ls[1].description === PROD_LINES_110401[1].description, 'kept lines unchanged (descriptions)');
ok(ls[2].description === 'موجودی کالا — ledger#1978/1979' && !JSON.stringify(ls).includes('ledger#1273'), 'credit line description without ledger#1273');
const d2 = draftRow(D2);
ok(d2.description.includes(TAG) && !d2.description.includes('ledger#1273') && d2.description.includes('ledger#1978') && d2.description.includes('ledger#1979'),
  'draft description: tag kept, ledger#1273 removed', d2.description);
if (hasVersion) ok(Number(d2.version) === ver0 + 1, 'version bumped by 1', { before: ver0, after: d2.version });
const logs = v4Logs();
const logLines = logs.find((l) => l.col === 'lines_json');
const logDesc = logs.find((l) => l.col === 'description');
ok(logs.length === 2 && logs.every((l) => l.row_key === 'undoc_adjust_drop_1273' && l.tbl === 'voucher_drafts' && l.phase === 'P3'),
  'wh_data_corrections: 2 rows rule=p3_draft_v4 row_key=undoc_adjust_drop_1273', logs);
ok(logLines && logLines.old_value === lines0 && logLines.new_value === d2.lines_json, 'log lines_json before/after');
ok(logDesc && logDesc.old_value === desc0 && logDesc.new_value === d2.description, 'log description before/after');
ok(v4Marker() === '1', 'v4 marker = 1');
ok(Object.keys(otherBefore).length >= 3 && Object.entries(otherBefore).every(([id, j]) => draftRow(Number(id)).lines_json === j),
  'other drafts (#3/#4/#5) untouched');
ok(count('voucher_drafts') === vdN, 'no draft created/deleted');
ok(count('journal_entries') === jeN.je && count('journal_lines') === jeN.jl && P3.gl1104ApprovedRial(db) === gl0, 'v4 posts nothing; GL unchanged');
ok(P3.checkDraftPostable(db, D2).ok, 'trimmed draft #2 still postable (P3 1104 exemption)');
ok(P3.p3DraftKeyFor(db, D2) === KEY, 'trimmed draft #2 still recognised as P3 key');

// ── idempotent ──
const snap = () => JSON.stringify(db.prepare('SELECT id, description, lines_json, version FROM voucher_drafts ORDER BY id').all());
const s1 = snap();
ok(P3.runP3DraftsV4Migration(db, QUIET).skipped === 'done', 'v4 second run: done');
rollback(() => {
  db.prepare('DELETE FROM settings WHERE key=?').run(P3.SETTINGS_KEY_V4);
  const r = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r.state === 'already_trimmed' && snap() === s1 && v4Logs().length === 2 && v4Marker() === '1', 'v4 forced re-run: already_trimmed → marker only, no write', r);
});
dbMods.initDB();
ok(snap() === s1 && v4Logs().length === 2, 'reboot (v1..v4): drafts unchanged');

// ── report reflects official reversal ──
const rep = P3.buildP3Report(db);
ok(rep.handled_by_official_reversal.some((h) => h.ledger_id === 1273 && h.draft === null), 'report: ledger#1273 → official kardex reversal (FR-P334-A), no draft');
ok(rep.plan.find((s) => s.key === KEY).amount_rial === 79655914, 'report: draft #2 amount 79,655,914');

// ── fresh install: v1 creates trimmed draft directly (even when ledger#1273 is reversed) ──
rollback(() => {
  db.prepare("DELETE FROM wh_data_corrections WHERE rule IN ('p3_draft','p3_draft_v2','p3_draft_v3','p3_draft_v4')").run();
  db.prepare("DELETE FROM voucher_drafts WHERE description LIKE '%[p3:%'").run();
  db.prepare('DELETE FROM settings WHERE key IN (?,?,?,?)').run(P3.SETTINGS_KEY, P3.SETTINGS_KEY_V2, P3.SETTINGS_KEY_V3, P3.SETTINGS_KEY_V4);
  db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=1273").run();
  const r = P3.runP3DraftMigration(db, {});
  ok(r.created.length === 4 && r.created.some((c) => c.key === KEY && c.amount_rial === 79655914), 'fresh install: draft #2 created with 79,655,914', r);
  const nd = markerId(KEY);
  const nls = linesOf(nd);
  ok(nls.length === 3 && shape(nls) === shape(P3.specLines(KEY, '1104')) && !draftRow(nd).description.includes('ledger#1273'), 'fresh install: 3 lines on 1104, no ledger#1273');
  P3.runP3DraftsV2Migration(db, {});
  P3.runP3DraftsV3Migration(db, {});
  const r4 = P3.runP3DraftsV4Migration(db, QUIET);
  ok(r4.state === 'already_trimmed' && v4Marker() === '1' && v4Logs().length === 0 && shape(linesOf(nd)) === shape(nls), 'fresh install + v2/v3/v4: v4 marker only, no write', r4);
});

// ── production health-check / reports ignore draft JEs, count approved ──
const labor = acct(db, 'coa_labor_control').code;
const varPrice = acct(db, 'coa_var_material_price').code;
const wip = acct(db, 'coa_wip').code;
const check = (code) => runHealthCheck(db).checks.find((c) => c.code === code);
const asOf = '1499/12/29';
ok(check('H2').status === 'pass' && check('C5').status === 'pass', 'health H2/C5 pass before');
const wip0 = reports.wipReport(db, { date: asOf }).totals.ledger_rial;
const bal0 = adr011Balance(db, varPrice);
rollback(() => {
  je(9500, 'manual_voucher', null, '1405/08/10', [{ code: labor, dr: 1000 }, { code: '3102', cr: 1000 }], 'draft labor', 'draft');
  je(9501, 'manual_voucher', null, '1405/08/10', [{ code: varPrice, dr: 700 }, { code: '3102', cr: 700 }], 'draft var', 'draft');
  je(9502, 'production_wip_test', null, '1405/08/10', [{ code: wip, dr: 500 }, { code: '3102', cr: 400 }], 'draft wip unbalanced', 'draft');
  je(9503, 'stage_transfer_x', null, '1405/08/10', [{ code: '3102', dr: 1 }, { code: '3102', cr: 1 }], 'draft stage transfer', 'draft');
  ok(check('H2').status === 'pass' && check('C5').status === 'pass', 'health H2/C5: draft JE on labor control ignored');
  ok(check('C3').status === 'pass' && adr011Balance(db, varPrice) === bal0, 'health C3 + ADR-011 balance: draft JE on 5210 ignored');
  ok(check('C4').status === 'pass', 'health C4: unbalanced draft production JE ignored');
  ok(check('C2').status === 'pass', 'health C2: draft stage_transfer JE ignored');
  ok(reports.wipReport(db, { date: asOf }).totals.ledger_rial === wip0, 'wipReport ledger WIP: draft JE ignored');
  for (const id of [9500, 9501, 9502, 9503]) db.prepare("UPDATE journal_entries SET status='approved' WHERE id=?").run(id);
  ok(check('H2').status === 'fail' && check('C5').status === 'fail', 'health H2/C5: approved JE counted');
  ok(check('C3').status === 'fail' && adr011Balance(db, varPrice) === bal0 + 700, 'health C3 + ADR-011 balance: approved JE counted');
  ok(check('C4').status === 'fail', 'health C4: unbalanced approved production JE flagged');
  ok(check('C2').status === 'fail', 'health C2: approved stage_transfer JE flagged');
  ok(reports.wipReport(db, { date: asOf }).totals.ledger_rial === wip0 + 500, 'wipReport ledger WIP: approved JE counted');
  db.prepare('UPDATE journal_entries SET deleted_at=1 WHERE id IN (9500,9501,9502,9503)').run();
  ok(check('H2').status === 'pass' && adr011Balance(db, varPrice) === bal0 && reports.wipReport(db, { date: asOf }).totals.ledger_rial === wip0,
    'deleted JEs still excluded');
});
const viewSql = (q1("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_wip_by_order'") || {}).sql || '';
ok(/COALESCE\(je\.status,'approved'\)<>'draft'/.test(viewSql) && /deleted_at/.test(viewSql), 'v_wip_by_order excludes draft (+ deleted) JEs');

// ── legacy schema without journal_entries.status ──
{
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, ref_type TEXT, deleted_at INTEGER DEFAULT 0);
    CREATE TABLE journal_lines (entry_id INTEGER, account_code TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0, debit_rial INTEGER DEFAULT 0, credit_rial INTEGER DEFAULT 0);
    INSERT INTO journal_entries (id, ref_type) VALUES (1, 'manual');
    INSERT INTO journal_lines (entry_id, account_code, debit_rial) VALUES (1, '5210', 300);
  `);
  let bal = null;
  try { bal = adr011Balance(mem, '5210'); } catch (e) { bal = e.message; }
  ok(bal === 300, 'no status column: ADR-011 balance query runs (jeNotDraftFor → 1=1)', bal);
  mem.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
try { dbMods.closeDB(); } catch (_) {}
process.exit(fail ? 1 : 0);
