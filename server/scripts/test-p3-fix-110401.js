'use strict';
/**
 * P3-fix — پیش‌نویس‌های P3 روی 110401 + منسوخ‌کردن پیش‌نویس دستی JE1016 + پیش‌نمایش برگشت رسمی fix #1.
 * Run: node server/scripts/test-p3-fix-110401.js
 *
 * FR-P3: resolver now targets 1104; v2 is exercised with { leafCode: '110401' } to replay production
 * history, and the reboot asserts v3 moves the drafts back to 1104 (details: test-fr-p3-1104-openings.js).
 *
 * Isolated temp DB. Covers: v2 migration rewrites seeded v1 drafts 1104→110401 (only unposted,
 * unchanged, tagged drafts) and marks the JE1016 draft superseded (no delete); idempotent; no leaf →
 * no marker; posted / edited drafts untouched; posting the superseded draft → 409; new install
 * creates 3 drafts on 110401 and no JE1016 draft; gap/GL includes 110401; reverse-preview makes zero
 * writes and returns the expected numbers; reverseFix refuses when the void would purge unrelated JEs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P3-fix — 110401 drafts + JE1016 official reverse preview ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3fix-'));
process.env.DB_PATH = path.join(dir, 'p3fix.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p3-fix-110401-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
// In-process auth (before routes/accounting is first required by the P3 lib).
const authMw = require('../middleware/auth');
let currentUser = null;
authMw.auth = (req, _res, next) => { req.user = currentUser; next(); };
const P3 = require('../lib/inventory/p3-recon-drafts');
const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);

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
const changes = () => q1('SELECT total_changes() c').c;
class Rb extends Error {}
function rollback(fn) {
  try { db.transaction(() => { fn(); throw new Rb(); })(); } catch (e) { if (!(e instanceof Rb)) throw e; }
}

// ── seed (production-shaped) ──
for (const [code, name, type] of [
  ['1104', 'موجودی کالا', 'asset'], ['3102', 'تراز افتتاحیه', 'equity'], ['3201', 'افتتاحیه سال مالی', 'equity'],
  ['610801', 'خالص کسری انبار', 'expense'], ['5101', 'بهای تمام‌شده کالای فروش رفته', 'expense'],
]) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)').run(code, name, type);
  db.prepare('UPDATE chart_of_accounts SET is_active=1 WHERE code=?').run(code);
}
db.prepare("DELETE FROM chart_of_accounts WHERE parent_code='1104'").run();
const tech = insert('users', { name: 'فنی', username: 'tech', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const hamed = insert('users', { name: 'حامد رشید', username: 'hamed', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
for (const id of [34, 35]) {
  insert('warehouses', { id, name: 'W' + id, code: 'W' + id, active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
}
for (const pid of [109, 115, 131, 334, 335]) {
  insert('products', { id: pid, user_id: tech, name: 'کالا ' + pid, code: 'PF-' + pid, price: 1, cost: 0, stock: 0, warehouse_id: 34, average_cost_rial: 0, unit: 'عدد' });
}
function je(id, refType, refId, date, lines, description) {
  insert('journal_entries', { id, entry_date: date, description: description || 'seed ' + refType, ref_type: refType, ref_id: refId, status: 'approved', created_by: tech });
  let ln = 1;
  for (const l of lines) {
    insert('journal_lines', { entry_id: id, account_code: l.code, account_name: l.code, debit: 0, credit: 0, debit_rial: l.dr || 0, credit_rial: l.cr || 0, line_no: ln++ });
  }
}
je(100, 'opening_inventory', 100, '1405/01/01', [{ code: '1104', dr: 5000000000 }, { code: '3102', cr: 5000000000 }]);
je(1016, 'inventory_recon_adjust', 1, '1405/08/04', [{ code: '3102', dr: 1796860352 }, { code: '1104', cr: 1796860352 }],
  'تعدیل تطبیق موجودی با دفتر کل (1104 ↔ 3102)');
je(490, 'opening_inventory', 490, '1405/07/23', [{ code: '1104', dr: 71232000 }, { code: '3102', cr: 71232000 }]);
let tx = 0;
function led(id, o) {
  insert('inventory_ledger', Object.assign({ id, tx_no: 'PF-' + (++tx), status: 'posted', date: '1405/07/01', qty_in: 0, qty_out: 0, amount_rial: 0, source_type: '' }, o));
}
led(1978, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 115, warehouse_id: 34, qty_out: 2, amount_rial: 66742000 });
led(1979, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 131, warehouse_id: 35, qty_out: 1, amount_rial: 12913914 });
led(1273, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 334, warehouse_id: 34, qty_out: 3, amount_rial: 66679942 });
led(1230, { event_type: 'opening', source_type: 'opening_inventory', product_id: 335, warehouse_id: 34, qty_in: 12, amount_rial: 71232000, je_id: 490 });
led(1977, { event_type: 'opening', source_type: 'opening_inventory', product_id: 109, warehouse_id: 35, qty_in: 2, amount_rial: 10759000 });
insert('subledger_recon_fixes', { id: 1, code: 'inventory_vs_gl', target: '1104', amount_rial: -1796860352, je_id: 1016, status: 'posted', reason: 'seed', created_by: tech });

// ── simulate production v1 state: 4 drafts on 1104 (incl. JE1016 reverse) + markers ──
P3.createP3Drafts(db, {}); // ensures wh_data_corrections; JE1016 not created anymore
const v1Ids = {};
for (const d of db.prepare("SELECT id, description FROM voucher_drafts WHERE description LIKE '%[p3:%'").all()) {
  v1Ids[d.description.match(/\[p3:([^\]]+)\]/)[1]] = d.id;
}
ok(Object.keys(v1Ids).length === 3 && !v1Ids.je1016_reverse, 'current code (no leaf): 3 drafts, no JE1016 draft', v1Ids);
const je1016Desc = 'پیش‌نویس P3 — منتظر تأیید حامد — برگشت JE #1016 (inventory_recon_adjust، ۱۴۰۵/۰۸/۰۴، Dr 3102 / Cr 1104) [p3:je1016_reverse]';
v1Ids.je1016_reverse = Number(insert('voucher_drafts', {
  date: '1405/08/10', description: je1016Desc, lines_json: JSON.stringify(P3.specLines('je1016_reverse', '1104')), created_by: tech,
}));
insert('wh_data_corrections', { run_id: 'seed-v1', phase: 'P3', rule: 'p3_draft', tbl: 'voucher_drafts', row_key: 'je1016_reverse', col: 'id', new_value: v1Ids.je1016_reverse, reason: je1016Desc });
const otherId = Number(insert('voucher_drafts', {
  date: '1405/08/10', description: 'پیش‌نویس دستی کاربر', lines_json: JSON.stringify([{ code: '1104', debit: 5, credit: 0 }, { code: '3102', debit: 0, credit: 5 }]), created_by: tech,
}));
for (const key of ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977']) {
  const d = q1('SELECT lines_json FROM voucher_drafts WHERE id=?', v1Ids[key]);
  ok(JSON.parse(d.lines_json).some((l) => l.code === '1104'), `v1 seed ${key}: lines on 1104`);
}
const draftRow = (id) => q1('SELECT * FROM voucher_drafts WHERE id=?', id);
const snapDrafts = () => db.prepare('SELECT id, description, lines_json, version FROM voucher_drafts ORDER BY id').all();

// ── FR-P3: v2 default target is now 1104 → no rewrite, only JE1016 superseded (rolled back) ──
rollback(() => {
  const v2a = P3.runP3DraftsV2Migration(db, {});
  ok(v2a.rewritten.length === 0 && v2a.skipped.filter((s) => s.why === 'already_leaf').length === 3
    && v2a.superseded.length === 1, 'v2 (FR-P3 target 1104): no rewrite, JE1016 superseded', v2a);
});
ok(!q1('SELECT 1 FROM settings WHERE key=?', P3.SETTINGS_KEY_V2), 'rolled back: no v2 marker');
ok(P3.runP3DraftsV2Migration(db, { isDevice: true }).skipped === 'device', 'v2 device: skipped');

// ── add 110401 (production shape); resolver stays on 1104 (FR-P3) ──
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('110401','موجودی کالا','asset','1104',1)").run();
const leaf = P3.resolveInventoryLeaf(db);
ok(leaf.code === '1104' && leaf.source === 'hamed_decision_1104', 'leaf resolver: 1104 even with child 110401 (FR-P3)', leaf);
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('1104010001','کالا ۱','asset','110401',1)").run();
const leafProd = P3.resolveInventoryLeaf(db);
ok(leafProd.code === '1104' && !!leafProd.warning, 'leaf resolver: 1104 with product sub-accounts (production shape)', leafProd);
db.prepare("DELETE FROM chart_of_accounts WHERE code='1104010001'").run();
// production history: P3-fix ran v2 with target 110401
const LEGACY = { leafCode: '110401' };

// ── gap calc includes 110401 ──
const gl0 = P3.gl1104ApprovedRial(db);
je(101, 'manual_voucher', 101, '1405/08/01', [{ code: '110401', dr: 1000000 }, { code: '3102', cr: 1000000 }]);
ok(P3.gl1104ApprovedRial(db) - gl0 === 1000000, 'GL 1104 subtree includes 110401 lines', { gl0, gl1: P3.gl1104ApprovedRial(db) });
ok(P3.inventorySubtreeCodes(db).has('110401'), 'subtree codes include 110401');

// ── posted draft untouched (rolled back) ──
rollback(() => {
  const id = v1Ids.opening_ledger1977;
  const desc = draftRow(id).description;
  db.prepare('DELETE FROM voucher_drafts WHERE id=?').run(id); // what «ثبت پیش‌نویس» does
  je(9001, 'manual_voucher', null, '1405/08/10', [{ code: '1104', dr: 10759000 }, { code: '3102', cr: 10759000 }], desc);
  const r = P3.runP3DraftsV2Migration(db, LEGACY);
  ok(r.skipped.some((s) => s.key === 'opening_ledger1977' && s.why === 'posted'), 'posted P3 draft → skipped posted', r.skipped);
  ok(r.rewritten.length === 2, 'others still rewritten', r.rewritten);
});
// ── user-edited draft untouched (rolled back) ──
rollback(() => {
  const id = v1Ids.opening_je490_offset;
  const lines = JSON.parse(draftRow(id).lines_json);
  lines[0].debit = 71232001;
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(lines), id);
  const before = draftRow(id).lines_json;
  const r = P3.runP3DraftsV2Migration(db, LEGACY);
  ok(r.skipped.some((s) => s.key === 'opening_je490_offset' && s.why === 'lines_changed'), 'edited lines → skipped lines_changed', r.skipped);
  ok(draftRow(id).lines_json === before, 'edited draft lines untouched');
});
ok(!q1('SELECT 1 FROM settings WHERE key=?', P3.SETTINGS_KEY_V2), 'rollback scenarios left no marker');

// ── real v2 run ──
const vBefore = Object.fromEntries(Object.entries(v1Ids).map(([k, id]) => [k, Number(draftRow(id).version || 0)]));
const otherBefore = JSON.stringify(draftRow(otherId));
const jeBefore = { je: count('journal_entries'), jl: count('journal_lines') };
const vdCount = count('voucher_drafts');
const v2 = P3.runP3DraftsV2Migration(db, LEGACY);
ok(v2.rewritten.length === 3 && v2.rewritten.every((r) => r.to === '110401'), 'v2: 3 drafts rewritten 1104 → 110401', v2);
ok(v2.superseded.length === 1 && v2.superseded[0].draft_id === v1Ids.je1016_reverse, 'v2: JE1016 draft marked superseded', v2.superseded);
ok(q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_V2)?.value === '1', 'v2 marker = 1');
for (const key of ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977']) {
  const d = draftRow(v1Ids[key]);
  const lines = JSON.parse(d.lines_json);
  ok(!lines.some((l) => l.code === '1104') && JSON.stringify(P3.specLines(key, '110401').map((l) => [l.code, l.debit, l.credit]))
    === JSON.stringify(lines.map((l) => [l.code, l.debit, l.credit])), `${key}: lines now on 110401, amounts identical`);
  if (cols('voucher_drafts').has('version')) ok(Number(d.version || 0) === vBefore[key] + 1, `${key}: version bumped`);
}
const jd = draftRow(v1Ids.je1016_reverse);
ok(jd && jd.description.startsWith(P3.SUPERSEDED_PREFIX) && jd.description.includes(je1016Desc), 'JE1016 draft kept (not deleted), description prefixed «⛔ منسوخ»');
ok(JSON.parse(jd.lines_json).some((l) => l.code === '1104'), 'JE1016 draft lines not rewritten');
ok(JSON.stringify(draftRow(otherId)) === otherBefore, 'unrelated user draft untouched');
ok(count('voucher_drafts') === vdCount, 'no draft deleted/created');
ok(count('journal_entries') === jeBefore.je && count('journal_lines') === jeBefore.jl, 'v2 posts nothing');
ok(count("wh_data_corrections WHERE rule='p3_draft_v2'") === 4, 'v2 changes logged (4 rows)');

// ── idempotent ──
const after1 = JSON.stringify(snapDrafts());
ok(P3.runP3DraftsV2Migration(db, LEGACY).skipped === 'done', 'v2 second run: done');
rollback(() => {
  db.prepare('DELETE FROM settings WHERE key=?').run(P3.SETTINGS_KEY_V2);
  const r = P3.runP3DraftsV2Migration(db, LEGACY);
  ok(r.rewritten.length === 0 && r.superseded.length === 0
    && r.skipped.filter((s) => s.why === 'already_leaf').length === 3
    && r.skipped.some((s) => s.why === 'already_superseded'), 'v2 forced re-run: nothing changes', r);
});
ok(JSON.stringify(snapDrafts()) === after1, 'v2 forced re-run left drafts unchanged');
dbMods.initDB(); // boot runs FR-P3 v3: 110401 → 1104
for (const key of ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977']) {
  const lines = JSON.parse(draftRow(v1Ids[key]).lines_json);
  ok(!lines.some((l) => l.code === '110401') && lines.some((l) => l.code === '1104'), `reboot (v3): ${key} back on 1104`);
}
ok(draftRow(v1Ids.je1016_reverse).description.startsWith(P3.SUPERSEDED_PREFIX), 'reboot: JE1016 draft still superseded');
ok(P3.createP3Drafts(db, {}).created.length === 0, 'v1 never recreates any draft');
ok(P3.isSupersededP3Draft(db, v1Ids.je1016_reverse) && !P3.isSupersededP3Draft(db, v1Ids.opening_je490_offset), 'superseded lookup by draft id');

// ── new install: 3 drafts directly on 1104, no JE1016 draft ──
rollback(() => {
  db.prepare("DELETE FROM wh_data_corrections WHERE rule IN ('p3_draft','p3_draft_v2','p3_draft_v3')").run();
  db.prepare("DELETE FROM voucher_drafts WHERE description LIKE '%[p3:%'").run();
  db.prepare('DELETE FROM settings WHERE key IN (?,?,?)').run(P3.SETTINGS_KEY, P3.SETTINGS_KEY_V2, P3.SETTINGS_KEY_V3);
  const r = P3.runP3DraftMigration(db, {});
  ok(r.created.length === 3 && !r.created.some((c) => c.key === 'je1016_reverse'), 'new install: 3 drafts, no JE1016 draft', r);
  const ds = db.prepare("SELECT lines_json FROM voucher_drafts WHERE description LIKE '%[p3:%'").all().map((d) => JSON.parse(d.lines_json));
  ok(ds.length === 3 && ds.every((ls) => ls.some((l) => l.code === '1104') && !ls.some((l) => l.code === '110401')), 'new install: inventory lines on 1104');
  // JE #101 put a line on 110401 → «whole balance on 1104» no longer holds → exemption closed → warning only
  ok(r.warnings.length === 3, 'new install: 110401 carries a line ⇒ 1104 exemption closed (warning, draft still saved)', r.warnings);
  const v = P3.runP3DraftsV2Migration(db, {});
  ok(v.rewritten.length === 0 && v.skipped.filter((s) => s.why === 'already_leaf').length === 3, 'new install + v2: nothing to rewrite', v);
});

// ── report ──
const rep = P3.buildP3Report(db);
ok(rep.inventory_leaf.code === '1104', 'report: inventory account 1104 (FR-P3)');
ok(rep.gl_1104_live_rial === P3.gl1104ApprovedRial(db) && rep.gap_gl_minus_kardex_rial === rep.gl_1104_live_rial - rep.kardex_34_35_rial, 'report: gap = GL subtree − kardex 34+35');

// ── HTTP: post guard + preview ──
currentUser = { id: hamed, role: 'admin', name: 'حامد رشید' };
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
app.use('/api/accounting', require('../routes/accounting'));

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  };
  try {
    const jeN = count('journal_entries');
    const r409 = await call('POST', `/api/accounting/vouchers/drafts/${v1Ids.je1016_reverse}/post`);
    ok(r409.status === 409 && r409.data?.code === 'E_P3_DRAFT_SUPERSEDED', 'post superseded JE1016 draft → 409 E_P3_DRAFT_SUPERSEDED', r409);
    ok(draftRow(v1Ids.je1016_reverse) && count('journal_entries') === jeN, '409: draft kept, no JE posted');

    const glBefore = P3.gl1104ApprovedRial(db);
    const kardex = P3.kardexValueRial(db, [34, 35]);
    const audits = count('audit_log');
    const c0 = changes();
    const pv = await call('GET', '/api/accounting/subledger-recon/fixes/1/reverse-preview');
    const c1 = changes();
    ok(pv.status === 200, 'preview 200', pv);
    ok(c1 === c0 && count('audit_log') === audits && count('journal_entries') === jeN, 'preview: zero writes (total_changes unchanged)', { c0, c1 });
    const p = pv.data || {};
    if (process.env.P3FIX_DUMP_PREVIEW) console.log(JSON.stringify(p, null, 2));
    ok(p.mode === 'soft_void' && p.je_id === 1016 && p.target === '1104', 'preview: soft_void of JE 1016 on target 1104', { mode: p.mode });
    ok(p.target_subtree.balance_before_rial === glBefore && p.target_subtree.effect_rial === 1796860352
      && p.target_subtree.balance_after_rial === glBefore + 1796860352, 'preview: 1104 subtree +1,796,860,352', p.target_subtree);
    ok(p.gap.kardex_rial === kardex && p.gap.before_rial === glBefore - kardex
      && p.gap.after_rial - p.gap.before_rial === 1796860352, 'preview: GL−kardex(34+35) gap shift +1,796,860,352', p.gap);
    const rl = p.reversal_lines || [];
    ok(rl.some((l) => l.account_code === '1104' && l.debit_rial === 1796860352) && rl.some((l) => l.account_code === '3102' && l.credit_rial === 1796860352),
      'preview: reversal Dr 1104 / Cr 3102 = 1,796,860,352', rl);
    const pre = Object.fromEntries((p.preconditions || []).map((x) => [x.key, x.ok]));
    ok(pre.fix_posted && pre.fix_not_reversed && pre.je_alive && pre.no_purge_collateral && pre.leaf_enforcement_not_blocking,
      'preview: preconditions fix/JE/collateral/leaf ok', p.preconditions);
    ok(typeof pre.period_open === 'boolean', 'preview: period_open reported', p.preconditions);
    const fixRow = q1('SELECT status, reversed_at FROM subledger_recon_fixes WHERE id=1');
    ok(fixRow.status === 'posted' && !fixRow.reversed_at && q1('SELECT status FROM journal_entries WHERE id=1016').status === 'approved', 'preview did not reverse fix #1 / JE1016');
    const p404 = await call('GET', '/api/accounting/subledger-recon/fixes/999/reverse-preview');
    ok(p404.status === 404, 'preview unknown fix → 404');

    // collateral: an unrelated *_reversal JE with ref_id=1 would be hard-deleted by the soft-void purge
    je(9500, 'invoice_reversal', 1, '1405/08/05', [{ code: '3102', dr: 7 }, { code: '5101', cr: 7 }]);
    const pc = await call('GET', '/api/accounting/subledger-recon/fixes/1/reverse-preview');
    const preC = Object.fromEntries((pc.data?.preconditions || []).map((x) => [x.key, x.ok]));
    ok(preC.no_purge_collateral === false && pc.data.ready === false, 'preview flags purge collateral (#9500)', pc.data?.preconditions);
    const cc0 = changes();
    let threw = null;
    try { recon.reverseFix(db, 1, { user: { id: hamed }, reason: 'test' }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'E_RECON_REVERSE_COLLATERAL' && threw.status === 409 && changes() === cc0, 'reverseFix refuses collateral purge (no writes)', threw && threw.code);
    ok(q1('SELECT 1 FROM journal_entries WHERE id=9500') && q1('SELECT status FROM subledger_recon_fixes WHERE id=1').status === 'posted', 'collateral JE + fix #1 intact');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { dbMods.closeDB(); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
