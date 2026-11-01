'use strict';
/**
 * FR-P3 — پیش‌نویس‌های P3 برگشت به 1104 + پیش‌نویس افتتاحیهٔ ledger#2021–2023 + اعتبار با enforce.
 * Run: node server/scripts/test-fr-p3-1104-openings.js
 *
 * Isolated temp DB in production shape (1104 → 110401 → product tafsili; whole GL balance on 1104).
 * Replays production history (v1 on 1104, v2 → 110401, JE1016 draft superseded), then covers:
 * v3 rewrites 110401→1104 only for unposted/unedited/tagged drafts, creates the 2021–2023 opening
 * draft once, leaves the JE1016 draft and user drafts untouched, posts nothing, is idempotent;
 * ledger#2003 never gets a draft; balance queries ignore status='draft' JEs; under
 * ledger_leaf_enforcement=enforce every P3 draft validates and posts on 1104 while 1104 in a
 * non-P3 draft and non-exempt parents (110401) are still rejected; exemption closes once a
 * descendant of 1104 carries a line; new install creates all 4 drafts directly on 1104.
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

console.log('\n══ FR-P3 — P3 drafts on 1104 + openings 2021–2023 + enforce-mode validity ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp3-'));
process.env.DB_PATH = path.join(dir, 'frp3.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'fr-p3-1104-openings-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const authMw = require('../middleware/auth');
let currentUser = null;
authMw.auth = (req, _res, next) => { req.user = currentUser; next(); };
const P3 = require('../lib/inventory/p3-recon-drafts');
const leafPolicy = require('../lib/coa-leaf-policy');
const { validateAndBuildVoucherLines } = require('../routes/accounting');

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
const setLeafMode = (v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('ledger_leaf_enforcement', v);

// ── seed: production-shaped chart (1104 → 110401 → product tafsili) ──
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
for (const k of [1, 2, 3]) {
  db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES (?,?,'asset','110401',1)").run(`110401000${k}`, `کالا ${k}`);
}
const tech = insert('users', { name: 'فنی', username: 'tech', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const hamed = insert('users', { name: 'حامد رشید', username: 'hamed', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
for (const id of [34, 35]) {
  insert('warehouses', { id, name: 'W' + id, code: 'W' + id, active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
}
for (const pid of [109, 115, 131, 183, 334, 335, 340, 341]) {
  insert('products', { id: pid, user_id: tech, name: 'کالا ' + pid, code: 'FR-' + pid, price: 1, cost: 0, stock: 0, warehouse_id: 34, average_cost_rial: 0, unit: 'عدد' });
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
  insert('inventory_ledger', Object.assign({ id, tx_no: 'FR-' + (++tx), status: 'posted', date: '1405/07/01', qty_in: 0, qty_out: 0, amount_rial: 0, source_type: '' }, o));
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

const OLD_KEYS = ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977'];
const NEW_KEY = P3.OPENINGS_2021_2023_KEY;
const draftRow = (id) => q1('SELECT * FROM voucher_drafts WHERE id=?', id);
const markerId = (key) => Number((q1("SELECT new_value FROM wh_data_corrections WHERE rule='p3_draft' AND row_key=? AND col='id' ORDER BY id DESC LIMIT 1", key) || {}).new_value || 0);
const linesOf = (id) => JSON.parse(draftRow(id).lines_json);
const shape = (ls) => JSON.stringify(ls.map((l) => [l.code, l.debit, l.credit]));

// ── static facts ──
ok(P3.EXCLUDED_LEDGER_IDS.includes(2003), 'EXCLUDED_LEDGER_IDS contains ledger#2003');
ok(P3.OPENINGS_2021_2023_TOTAL === 14733111 && 71232000 + 10759000 + P3.OPENINGS_2021_2023_TOTAL === 96724111, 'opening drafts total = 96,724,111');
ok(leafPolicy.CONTROL_POSTING_EXEMPT_CODES.length === 1 && leafPolicy.CONTROL_POSTING_EXEMPT_CODES[0] === '1104', 'exempt control list = [1104] only');
ok(P3.resolveInventoryLeaf(db).code === '1104', 'resolver targets 1104 (production shape)');
ok(leafPolicy.leafEnforcementMode(db) === 'warn', 'default leaf mode warn (not changed)');

// ── replay production history: v1 (1104) → v2 (110401) + JE1016 draft superseded ──
const hist = P3.createP3Drafts(db, { onlyKeys: OLD_KEYS });
ok(hist.created.length === 3, 'history: v1 created 3 drafts', hist);
const ids = Object.fromEntries(OLD_KEYS.map((k) => [k, markerId(k)]));
const je1016Desc = 'پیش‌نویس P3 — منتظر تأیید حامد — برگشت JE #1016 [p3:je1016_reverse]';
const je1016Id = Number(insert('voucher_drafts', { date: '1405/08/10', description: je1016Desc, lines_json: JSON.stringify(P3.specLines('je1016_reverse', '1104')), created_by: tech }));
insert('wh_data_corrections', { run_id: 'seed', phase: 'P3', rule: 'p3_draft', tbl: 'voucher_drafts', row_key: 'je1016_reverse', col: 'id', new_value: je1016Id, reason: je1016Desc });
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('p3_recon_drafts_v1','1')").run();
const v2 = P3.runP3DraftsV2Migration(db, { leafCode: '110401' });
ok(v2.rewritten.length === 3 && v2.superseded.length === 1, 'history: v2 → 110401 + JE1016 superseded', v2);
for (const k of OLD_KEYS) ok(shape(linesOf(ids[k])) === shape(P3.specLines(k, '110401')), `history: ${k} on 110401 (prod state)`);
const otherId = Number(insert('voucher_drafts', {
  date: '1405/08/10', description: 'پیش‌نویس دستی کاربر', lines_json: JSON.stringify([{ code: '110401', debit: 5, credit: 0 }, { code: '3102', debit: 0, credit: 5 }]), created_by: tech,
}));
const je1016Before = JSON.stringify(draftRow(je1016Id));
const otherBefore = JSON.stringify(draftRow(otherId));

// ── v3 safety branches (rolled back) ──
ok(P3.runP3DraftsV3Migration(db, { isDevice: true }).skipped === 'device', 'v3 device: skipped');
rollback(() => {
  const id = ids.opening_ledger1977;
  const desc = draftRow(id).description;
  db.prepare('DELETE FROM voucher_drafts WHERE id=?').run(id); // what «ثبت پیش‌نویس» does
  je(9001, 'manual_voucher', null, '1405/08/10', [{ code: '110401', dr: 10759000 }, { code: '3102', cr: 10759000 }], desc);
  const r = P3.runP3DraftsV3Migration(db, {});
  ok(r.skipped.some((s) => s.key === 'opening_ledger1977' && s.why === 'posted') && r.rewritten.length === 2, 'v3: posted draft skipped, others rewritten', r);
});
rollback(() => {
  const id = ids.opening_je490_offset;
  const ls = linesOf(id);
  ls[0].debit = 71232001;
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(ls), id);
  const before = draftRow(id).lines_json;
  const r = P3.runP3DraftsV3Migration(db, {});
  ok(r.skipped.some((s) => s.key === 'opening_je490_offset' && s.why === 'lines_changed') && draftRow(id).lines_json === before, 'v3: edited draft untouched (lines_changed)', r.skipped);
});
rollback(() => {
  const id = ids.undoc_adjust_146335856;
  db.prepare('UPDATE voucher_drafts SET description=? WHERE id=?').run('توضیح ویرایش‌شده بدون برچسب', id);
  const r = P3.runP3DraftsV3Migration(db, {});
  ok(r.skipped.some((s) => s.key === 'undoc_adjust_146335856' && s.why === 'tag_mismatch'), 'v3: tag removed → skipped tag_mismatch', r.skipped);
});
rollback(() => {
  db.prepare('UPDATE inventory_ledger SET amount_rial=5051112 WHERE id=2022').run();
  const r = P3.runP3DraftsV3Migration(db, {});
  ok(r.created.length === 0 && r.pending.some((s) => s.key === NEW_KEY)
    && q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_V3).value === `pending:${NEW_KEY}`, 'v3: 2022 amount mismatch → no new draft, marker pending', r);
});
ok(!q1('SELECT 1 FROM settings WHERE key=?', P3.SETTINGS_KEY_V3), 'rollback scenarios left no v3 marker');

// ── real v3 ──
const vBefore = Object.fromEntries(OLD_KEYS.map((k) => [k, Number(draftRow(ids[k]).version || 0)]));
const jeN = { je: count('journal_entries'), jl: count('journal_lines') };
const vdN = count('voucher_drafts');
const gl0 = P3.gl1104ApprovedRial(db);
const v3 = P3.runP3DraftsV3Migration(db, {});
ok(v3.rewritten.length === 3 && v3.rewritten.every((r) => r.from === '110401' && r.to === '1104'), 'v3: 3 drafts 110401 → 1104', v3);
for (const k of OLD_KEYS) {
  const d = draftRow(ids[k]);
  ok(d.id === ids[k] && shape(JSON.parse(d.lines_json)) === shape(P3.specLines(k, '1104')), `v3: ${k} same draft id, lines on 1104, amounts identical`);
  if (cols('voucher_drafts').has('version')) ok(Number(d.version || 0) === vBefore[k] + 1, `v3: ${k} version bumped`);
}
ok(v3.created.length === 1 && v3.created[0].key === NEW_KEY && v3.created[0].amount_rial === 14733111, 'v3: opening 2021–2023 draft created', v3.created);
const newId = markerId(NEW_KEY);
const nd = draftRow(newId);
const nls = JSON.parse(nd.lines_json);
ok(nd.description.includes(`[p3:${NEW_KEY}]`) && nd.created_by === tech, 'new draft tagged [p3:opening_ledger2021_2023], maker = technical user');
const dr1104 = nls.filter((l) => l.code === '1104' && l.debit > 0);
ok(dr1104.length === 3 && P3.OPENINGS_2021_2023.every((r) => dr1104.some((l) => l.debit === r.amount && l.description.includes(`ledger#${r.id}`) && l.description.includes(`کالا ${r.product_id}`))),
  'new draft: one Dr 1104 line per ledger (ledger#/product in description)', nls);
const cr3102 = nls.filter((l) => l.code === '3102');
ok(cr3102.length === 1 && cr3102[0].credit === 14733111 && nls.reduce((t, l) => t + l.debit - l.credit, 0) === 0, 'new draft: Cr 3102 14,733,111, balanced');
const openingTotal = [ids.opening_je490_offset, ids.opening_ledger1977, newId]
  .reduce((t, id) => t + linesOf(id).filter((l) => l.code === '1104').reduce((s, l) => s + l.debit, 0), 0);
ok(openingTotal === 96724111, 'opening drafts Dr 1104 total = 96,724,111', openingTotal);
ok(JSON.stringify(draftRow(je1016Id)) === je1016Before, 'JE1016 draft untouched (still superseded)');
ok(JSON.stringify(draftRow(otherId)) === otherBefore, 'unrelated user draft untouched');
ok(count('voucher_drafts') === vdN + 1, 'only the new draft added; nothing deleted');
ok(count('journal_entries') === jeN.je && count('journal_lines') === jeN.jl && P3.gl1104ApprovedRial(db) === gl0, 'v3 posts nothing; GL unchanged');
ok(count("wh_data_corrections WHERE rule='p3_draft_v3'") === 3, 'v3 rewrites logged rule=p3_draft_v3 (3 rows)');
ok(q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_V3).value === '1', 'v3 marker = 1');
ok(leafPolicy.leafEnforcementMode(db) === 'warn', 'v3 did not touch ledger_leaf_enforcement');

// ── ledger#2003 never referenced ──
const allP3 = db.prepare("SELECT description, lines_json FROM voucher_drafts WHERE description LIKE '%[p3:%'").all();
ok(allP3.length === 5 && !allP3.some((d) => /ledger#2003\b|\b2003\b/.test(d.description + d.lines_json)), 'no P3 draft references ledger#2003');
ok(!P3.buildPlan(db).some((s) => /ledger#2003\b/.test(s.description + JSON.stringify(s.lines))), 'plan never references ledger#2003');

// ── idempotent ──
const snap = () => JSON.stringify(db.prepare('SELECT id, description, lines_json, version FROM voucher_drafts ORDER BY id').all());
const s1 = snap();
ok(P3.runP3DraftsV3Migration(db, {}).skipped === 'done', 'v3 second run: done');
rollback(() => {
  db.prepare('DELETE FROM settings WHERE key=?').run(P3.SETTINGS_KEY_V3);
  const r = P3.runP3DraftsV3Migration(db, {});
  ok(r.rewritten.length === 0 && r.created.length === 0 && r.skipped.filter((s) => s.why === 'already_1104').length === 3
    && r.already.some((a) => a.key === NEW_KEY) && snap() === s1, 'v3 forced re-run: nothing changes', r);
});
dbMods.initDB();
ok(snap() === s1, 'reboot (v1+v2+v3): drafts unchanged');

// ── balance queries count only approved/posted JEs ──
rollback(() => {
  je(9100, 'manual_voucher', null, '1405/08/10', [{ code: '1104', dr: 777 }, { code: '3102', cr: 777 }], 'پیش‌نویس سند', 'draft');
  ok(P3.gl1104ApprovedRial(db) === gl0, 'status=draft JE ignored by GL 1104 subtree');
  je(9101, 'manual_voucher', null, '1405/08/10', [{ code: '1104', dr: 555 }, { code: '3102', cr: 555 }], 'سند قطعی', 'posted');
  ok(P3.gl1104ApprovedRial(db) === gl0 + 555, 'status=posted JE counted');
  db.prepare("UPDATE journal_entries SET status='draft' WHERE id=490").run();
  ok(!P3.buildPlan(db).find((s) => s.key === 'opening_je490_offset').guard.ok, 'JE490 in draft status is not live (guard false)');
});

// ── enforce mode: P3 drafts validate on 1104; others still rejected ──
const p3Ids = [...OLD_KEYS.map((k) => ids[k]), newId];
setLeafMode('enforce');
ok(leafPolicy.leafEnforcementMode(db) === 'enforce', 'test DB: leaf mode = enforce');
for (const id of p3Ids) {
  const c = P3.checkDraftPostable(db, id);
  ok(c.ok && !!c.p3_key, `enforce: P3 draft #${id} (${c.p3_key}) passes validateAndBuildVoucherLines + leaf guard`, c);
}
ok(P3.checkDraftPostable(db, je1016Id).code === 'E_P3_DRAFT_SUPERSEDED', 'JE1016 draft not postable (superseded)');
const plain1104 = validateAndBuildVoucherLines(db, [{ code: '1104', debit: 5, credit: 0 }, { code: '3102', debit: 0, credit: 5 }]);
ok(plain1104.code === 'E_COA_NOT_POSTABLE', 'non-P3 voucher on 1104 → E_COA_NOT_POSTABLE', plain1104);
ok(P3.checkDraftPostable(db, otherId).code === 'E_COA_NOT_POSTABLE', 'user draft on 110401 (non-exempt parent) → rejected');
const v110401 = validateAndBuildVoucherLines(db, [{ code: '110401', debit: 5, credit: 0 }, { code: '3102', debit: 0, credit: 5 }], { exemptControlCodes: ['110401'] });
ok(v110401.code === 'E_COA_NOT_POSTABLE', 'asking exemption for 110401 (not in list) → still rejected');
let thr = null;
try { leafPolicy.assertLinesPostable(db, [{ code: '1100' }], { exemptControlCodes: ['1100', '1104'] }); } catch (e) { thr = e; }
ok(thr && thr.code === 'E_ACCOUNT_NOT_LEAF', 'enforce: parent 1100 rejected even if caller lists it', thr && thr.code);
thr = null;
try { leafPolicy.assertLinesPostable(db, [{ code: '1104' }], {}); } catch (e) { thr = e; }
ok(thr && thr.code === 'E_ACCOUNT_NOT_LEAF', 'enforce: 1104 without opt-in rejected');
rollback(() => {
  je(9200, 'manual_voucher', null, '1405/08/10', [{ code: '1104010002', dr: 9 }, { code: '3102', cr: 9 }]);
  const c = P3.checkDraftPostable(db, newId);
  ok(!c.ok && c.code === 'E_COA_NOT_POSTABLE', 'exemption closes once a 1104 descendant carries a line', c);
});

// ── HTTP: post under enforce (test DB only) ──
currentUser = { id: hamed, role: 'admin', name: 'حامد رشید' };
const express = require('express');
const app = express();
app.use(express.json());
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
    const sup = await call('POST', `/api/accounting/vouchers/drafts/${je1016Id}/post`);
    ok(sup.status === 409 && sup.data?.code === 'E_P3_DRAFT_SUPERSEDED', 'HTTP: superseded JE1016 draft → 409', sup);
    const oth = await call('POST', `/api/accounting/vouchers/drafts/${otherId}/post`);
    ok(oth.status === 400 && oth.data?.code === 'E_COA_NOT_POSTABLE' && draftRow(otherId), 'HTTP enforce: user draft on 110401 → 400, kept', oth);
    const userOn1104 = Number(insert('voucher_drafts', {
      date: '1405/08/10', description: 'کاربر روی 1104', lines_json: JSON.stringify([{ code: '1104', debit: 5, credit: 0 }, { code: '3102', debit: 0, credit: 5 }]), created_by: tech,
    }));
    const u1104 = await call('POST', `/api/accounting/vouchers/drafts/${userOn1104}/post`);
    ok(u1104.status === 400 && u1104.data?.code === 'E_COA_NOT_POSTABLE', 'HTTP enforce: non-P3 draft on 1104 → 400', u1104);

    const glBefore = P3.gl1104ApprovedRial(db);
    const expected = p3Ids.reduce((t, id) => t + linesOf(id).filter((l) => l.code === '1104').reduce((s, l) => s + l.debit - l.credit, 0), 0);
    for (const id of p3Ids) {
      const key = P3.p3DraftKeyFor(db, id);
      const r = await call('POST', `/api/accounting/vouchers/drafts/${id}/post`);
      ok(r.status === 200 && r.data?.id, `HTTP enforce: P3 draft ${key} posted`, r);
      if (r.data?.id) {
        const jl = db.prepare('SELECT account_code FROM journal_lines WHERE entry_id=?').all(r.data.id).map((x) => x.account_code);
        ok(jl.includes('1104') && !jl.includes('110401'), `HTTP: JE #${r.data.id} lines on 1104`, jl);
        ok(!draftRow(id), `HTTP: draft ${key} consumed`);
      }
    }
    ok(P3.gl1104ApprovedRial(db) - glBefore === expected && expected === -79655914 + 71232000 + 10759000 + 14733111,
      'GL 1104 moved by exactly the drafts effect (+17,068,197; ledger#1273 not drafted)', { expected, delta: P3.gl1104ApprovedRial(db) - glBefore });
    ok(P3.runP3DraftsV3Migration(db, {}).skipped === 'done', 'v3 after posting: still done (no recreation)');
  } finally {
    server.close();
  }

  // ── new install: v1 creates all 4 drafts directly on 1104 (no warning while balance on 1104) ──
  rollback(() => {
    db.prepare("UPDATE journal_entries SET description=REPLACE(description,'[p3:','[posted-p3:') WHERE description LIKE '%[p3:%'").run();
    db.prepare("DELETE FROM wh_data_corrections WHERE rule IN ('p3_draft','p3_draft_v2','p3_draft_v3')").run();
    db.prepare("DELETE FROM voucher_drafts WHERE description LIKE '%[p3:%'").run();
    db.prepare('DELETE FROM settings WHERE key IN (?,?,?)').run(P3.SETTINGS_KEY, P3.SETTINGS_KEY_V2, P3.SETTINGS_KEY_V3);
    const r = P3.runP3DraftMigration(db, {});
    ok(r.created.length === 4 && r.created.some((c) => c.key === NEW_KEY) && !r.created.some((c) => c.key === 'je1016_reverse'), 'new install: 4 drafts incl. openings 2021–2023', r);
    const ds = db.prepare("SELECT lines_json FROM voucher_drafts WHERE description LIKE '%[p3:%'").all().map((d) => JSON.parse(d.lines_json));
    ok(ds.every((ls) => ls.some((l) => l.code === '1104') && !ls.some((l) => l.code === '110401')), 'new install: all inventory lines on 1104');
    ok(r.warnings.length === 0, 'new install: no non-postable warning (1104 exemption open)', r.warnings);
    const v2n = P3.runP3DraftsV2Migration(db, {});
    const v3n = P3.runP3DraftsV3Migration(db, {});
    ok(v2n.rewritten.length === 0 && v3n.rewritten.length === 0 && v3n.created.length === 0 && v3n.already.some((a) => a.key === NEW_KEY), 'new install + v2/v3: nothing to rewrite/create', { v2n, v3n });
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { dbMods.closeDB(); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
