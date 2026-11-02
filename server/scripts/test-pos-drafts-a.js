'use strict';
/**
 * FR-POS-DRAFTS (بخش A) — ویرایش/مشاهده/حذف پیش‌نویس سند + معافیت 1104 گره‌خورده به هش سطرهای P3.
 * Run: node server/scripts/test-pos-drafts-a.js
 *
 * Isolated temp DB (production-shaped chart: 1104 → 110401 → product tafsili; P3 drafts created on 1104).
 * Covers: PUT success + version bump + audit diff, stale/missing version 409, unbalanced / non-leaf 400 with
 * no write, superseded (JE1016) 409 for PUT/POST/DELETE, P3 lines change rejected (E_COA_NOT_POSTABLE) and
 * restore → postable, description-only edit keeps [p3:key] tag + exemption, direct DB lines change → check/post
 * reject, boot backfill stamps only known-spec lines, DELETE maker-checker / admin / P3 admin-only + audit
 * snapshot, GET fields, check endpoint, 404s, tbl-enhance paths, capture mapping, frontend wiring strings.
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

console.log('\n══ FR-POS-DRAFTS-A — voucher draft edit/view/delete + P3 lines-hash exemption ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posdrafts-a-'));
process.env.DB_PATH = path.join(dir, 'posdrafts.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'pos-drafts-a-test-secret-at-least-32-chars-long!!';
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
const { tableForPath } = require('../sync/capture');

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

// ── seed: production-shaped chart + P3 source facts ──
for (const [code, name, type, parent] of [
  ['1100', 'دارایی جاری', 'asset', null], ['1104', 'موجودی کالا', 'asset', '1100'],
  ['3102', 'تراز افتتاحیه', 'equity', null], ['3201', 'افتتاحیه سال مالی', 'equity', null],
  ['610801', 'خالص کسری انبار', 'expense', null], ['5101', 'بهای تمام‌شده کالای فروش رفته', 'expense', null],
]) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)').run(code, name, type, parent);
  db.prepare('UPDATE chart_of_accounts SET is_active=1, parent_code=? WHERE code=?').run(parent, code);
}
db.prepare("DELETE FROM chart_of_accounts WHERE parent_code='1104' OR code LIKE '110401%'").run();
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('110401','موجودی کالا','asset','1104',1)").run();
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('1104010001','کالا ۱','asset','110401',1)").run();

const tech = Number(insert('users', { name: 'فنی', username: 'tech', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
const hamed = Number(insert('users', { name: 'حامد رشید', username: 'hamed', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
const acc1 = Number(insert('users', { name: 'حسابدار ۱', username: 'acc1', password: 'x', role: 'accounting', active: 1, must_change_password: 0 }));
const acc2 = Number(insert('users', { name: 'حسابدار ۲', username: 'acc2', password: 'x', role: 'accounting', active: 1, must_change_password: 0 }));
const U = {
  tech: { id: tech, role: 'admin', name: 'فنی' },
  hamed: { id: hamed, role: 'admin', name: 'حامد رشید' },
  acc1: { id: acc1, role: 'accounting', name: 'حسابدار ۱' },
  acc2: { id: acc2, role: 'accounting', name: 'حسابدار ۲' },
};
for (const id of [34, 35]) {
  insert('warehouses', { id, name: 'W' + id, code: 'W' + id, active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
}
for (const pid of [109, 115, 131, 183, 334, 335, 340, 341]) {
  insert('products', { id: pid, user_id: tech, name: 'کالا ' + pid, code: 'PD-' + pid, price: 1, cost: 0, stock: 0, warehouse_id: 34, average_cost_rial: 0, unit: 'عدد' });
}
function je(id, refType, refId, date, lines, description) {
  insert('journal_entries', { id, entry_date: date, description: description || 'seed ' + refType, ref_type: refType, ref_id: refId, status: 'approved', created_by: tech });
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
  insert('inventory_ledger', Object.assign({ id, tx_no: 'PD-' + (++tx), status: 'posted', date: '1405/07/01', qty_in: 0, qty_out: 0, amount_rial: 0, source_type: '' }, o));
}
led(1978, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 115, warehouse_id: 34, qty_out: 2, amount_rial: 66742000 });
led(1979, { event_type: 'adjustment', source_type: 'stock_adjust', product_id: 131, warehouse_id: 35, qty_out: 1, amount_rial: 12913914 });
led(1230, { event_type: 'opening', source_type: 'opening_inventory', product_id: 335, warehouse_id: 34, qty_in: 12, amount_rial: 71232000, je_id: 490 });
led(1977, { event_type: 'opening', source_type: 'opening_inventory', product_id: 109, warehouse_id: 35, qty_in: 2, amount_rial: 10759000 });
for (const r of P3.OPENINGS_2021_2023) {
  led(r.id, { event_type: 'opening', source_type: 'opening_inventory', product_id: r.product_id, warehouse_id: r.warehouse_id, qty_in: r.qty, amount_rial: r.amount });
}

// ── static: canonical hash ──
const base = [{ code: '1104', debit: 5, credit: 0, description: 'a' }, { code: '3102', debit: 0, credit: 5, description: 'b' }];
const h0 = P3.canonicalLinesHash(base);
ok(/^[0-9a-f]{64}$/.test(h0), 'canonicalLinesHash = sha256 hex');
ok(P3.canonicalLinesHash(base.map((l) => ({ ...l, description: 'x' }))) === h0, 'hash ignores line description');
ok(P3.canonicalLinesHash([{ ...base[0], debit: 5.2 }, base[1]]) === h0, 'hash rounds amounts');
ok(P3.canonicalLinesHash([{ ...base[0], debit: 6 }, { ...base[1], credit: 6 }]) !== h0, 'hash sensitive to amounts');
ok(P3.canonicalLinesHash([base[1], base[0]]) !== h0, 'hash sensitive to order');
ok(P3.canonicalLinesHash([{ ...base[0], code: '110401' }, base[1]]) !== h0, 'hash sensitive to code');
ok(P3.canonicalLinesHash([{ ...base[0], person_id: 7 }, base[1]]) !== h0, 'hash sensitive to person_id');

// ── create P3 drafts (new install path) + superseded JE1016 draft ──
const made = P3.createP3Drafts(db, {});
ok(made.created.length === 4, 'createP3Drafts: 4 P3 drafts on 1104', made);
const markerId = (key) => Number((q1("SELECT new_value FROM wh_data_corrections WHERE rule='p3_draft' AND row_key=? AND col='id' ORDER BY id DESC LIMIT 1", key) || {}).new_value || 0);
const UNDOC = P3.UNDOC_KEY;
const idUndoc = markerId(UNDOC);
const id490 = markerId('opening_je490_offset');
const id1977 = markerId('opening_ledger1977');
for (const c of made.created) {
  ok(P3.storedLinesHash(db, c.key) === P3.canonicalLinesHash(P3.specLines(c.key, '1104')), `hash stamped at creation: ${c.key}`);
}
const je1016Desc = `${P3.SUPERSEDED_PREFIX} — پیش‌نویس P3 — برگشت JE #1016 [p3:je1016_reverse]`;
const je1016Id = Number(insert('voucher_drafts', { date: '1405/08/10', description: je1016Desc, lines_json: JSON.stringify(P3.specLines('je1016_reverse', '1104')), created_by: tech }));
insert('wh_data_corrections', { run_id: 'seed', phase: 'P3', rule: 'p3_draft', tbl: 'voucher_drafts', row_key: 'je1016_reverse', col: 'id', new_value: je1016Id, reason: je1016Desc });
ok(P3.isSupersededP3Draft(db, je1016Id), 'JE1016 draft superseded');

const draftRow = (id) => q1('SELECT * FROM voucher_drafts WHERE id=?', id);
const linesOf = (id) => JSON.parse(draftRow(id).lines_json);
const lastAudit = (action, id) => q1('SELECT * FROM audit_log WHERE action=? AND entity_id=? ORDER BY id DESC LIMIT 1', action, id);
const LEAF_LINES = (amt) => [{ code: '1104010001', debit: amt, credit: 0, description: 'کالا' }, { code: '3102', debit: 0, credit: amt, description: 'افتتاحیه' }];

// ── backfill (boot) — rolled back scenarios ──
ok(P3.runP3DraftsLinesHashBackfill(db, { isDevice: true }).skipped === 'device', 'backfill device: skipped');
rollback(() => {
  db.prepare("DELETE FROM wh_data_corrections WHERE rule='p3_draft_hash'").run();
  db.prepare('DELETE FROM settings WHERE key=?').run(P3.SETTINGS_KEY_HASH);
  const ls = linesOf(id1977);
  ls[0].debit += 1; ls[1].credit += 1;
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(ls), id1977);
  ok(!P3.p3PostingOptionsForDraft(db, draftRow(idUndoc)), 'no stored hash → no exemption');
  const r = P3.runP3DraftsLinesHashBackfill(db, { silent: true });
  ok(r.stamped.length === 3 && r.unmatched.length === 1 && r.unmatched[0].key === 'opening_ledger1977', 'backfill: 3 spec drafts stamped, edited draft unmatched', r);
  ok(!P3.storedLinesHash(db, 'opening_ledger1977'), 'backfill: edited draft NOT stamped');
  ok(!!P3.p3PostingOptionsForDraft(db, draftRow(idUndoc)), 'backfill: spec draft exemption restored');
  ok(!P3.p3PostingOptionsForDraft(db, draftRow(id1977)), 'backfill: edited draft has no exemption');
  ok(q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_HASH).value === '1', 'backfill flag = 1');
  ok(P3.runP3DraftsLinesHashBackfill(db, {}).skipped === 'done', 'backfill second run: done');
});
rollback(() => {
  db.prepare("DELETE FROM wh_data_corrections WHERE rule='p3_draft_hash'").run();
  db.prepare('DELETE FROM settings WHERE key=?').run(P3.SETTINGS_KEY_HASH);
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(P3.specLines(UNDOC, '110401')), idUndoc);
  const r = P3.runP3DraftsLinesHashBackfill(db, { silent: true });
  ok(r.stamped.some((s) => s.key === UNDOC), 'backfill: legacy 110401 spec variant also recognised', r);
  db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(P3.legacyUndocLines('1104')), idUndoc);
  ok(!P3.p3PostingOptionsForDraft(db, draftRow(idUndoc)), 'hash bound to stamped lines: other variant ≠ exempt');
});
dbMods.initDB();
ok(q1('SELECT value FROM settings WHERE key=?', P3.SETTINGS_KEY_HASH)?.value === '1', 'boot: backfill wired in db.js (flag set)');
ok(count("wh_data_corrections WHERE rule='p3_draft_hash'") === 4, 'boot: no duplicate hash rows');

// ── HTTP ──
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/accounting', require('../routes/accounting'));

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, url, body) => {
    currentUser = user;
    const res = await fetch(baseUrl + '/api/accounting' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  };
  try {
    // GET fields
    const list = await call(U.acc1, 'GET', '/vouchers/drafts');
    const g = (id) => (list.data || []).find((d) => d.id === id);
    ok(list.status === 200 && Array.isArray(list.data), 'GET drafts 200');
    ok(g(idUndoc) && g(idUndoc).total_debit === P3.UNDOC_TOTAL && g(idUndoc).p3_key === UNDOC && g(idUndoc).p3_exempt === true
      && g(idUndoc).superseded === false && Number.isInteger(g(idUndoc).version), 'GET: P3 draft total_debit/p3_key/p3_exempt/superseded/version', g(idUndoc));
    ok(g(je1016Id) && g(je1016Id).superseded === true && g(je1016Id).p3_key === null, 'GET: JE1016 draft superseded=true', g(je1016Id));

    // user draft: create, edit OK
    const created = await call(U.acc1, 'POST', '/vouchers/drafts', { date: '1405/08/10', description: 'پیش‌نویس کاربر', lines: LEAF_LINES(1000) });
    const uid = created.data && created.data.id;
    ok(created.status === 200 && uid, 'POST draft (acc1)', created);
    const v0 = Number(draftRow(uid).version || 0);
    const put1 = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { date: '1405/08/11', description: 'پیش‌نویس ویرایش‌شده', lines: LEAF_LINES(2500), version: v0 });
    ok(put1.status === 200 && put1.data.version === v0 + 1 && Number(draftRow(uid).version) === v0 + 1, 'PUT ok: version bumped by exactly 1 (trigger)', { put1, v0 });
    ok(linesOf(uid)[0].debit === 2500 && draftRow(uid).description === 'پیش‌نویس ویرایش‌شده' && draftRow(uid).date === '1405/08/11', 'PUT ok: row updated');
    ok(put1.data.total_debit === 2500, 'PUT response total_debit');
    const au = lastAudit('voucher_draft_update', uid);
    let aud = null;
    try { aud = JSON.parse(au.detail); } catch (_) { aud = null; }
    ok(au && aud && aud.changed.lines && aud.changed.lines.before[0].debit === 1000 && aud.changed.lines.after[0].debit === 2500
      && aud.changed.description && aud.changed.date && !aud.changed.cost_center_id && aud.version_before === v0 && aud.version_after === v0 + 1,
    'audit voucher_draft_update with before/after diff', aud);

    // stale / missing version
    const snapU = JSON.stringify(draftRow(uid));
    const stale = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', lines: LEAF_LINES(9), version: v0 });
    ok(stale.status === 409 && stale.data.code === 'E_DRAFT_VERSION_CONFLICT' && /تغییر کرده/.test(stale.data.error) && stale.data.current_version === v0 + 1,
      'stale version → 409 E_DRAFT_VERSION_CONFLICT (Persian)', stale);
    const nover = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', lines: LEAF_LINES(9) });
    ok(nover.status === 409 && nover.data.code === 'E_DRAFT_VERSION_CONFLICT', 'missing version → 409', nover);
    ok(JSON.stringify(draftRow(uid)) === snapU, 'conflicts: no write');

    // unbalanced / non-leaf / unknown code → 400, no write
    const unb = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', version: v0 + 1, lines: [{ code: '1104010001', debit: 10, credit: 0 }, { code: '3102', debit: 0, credit: 9 }] });
    ok(unb.status === 400 && unb.data.code && /نامتوازن/.test(unb.data.error), 'unbalanced → 400 with code', unb);
    const nonLeaf = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', version: v0 + 1, lines: [{ code: '110401', debit: 10, credit: 0 }, { code: '3102', debit: 0, credit: 10 }] });
    ok(nonLeaf.status === 400 && nonLeaf.data.code === 'E_COA_NOT_POSTABLE' && /سطح پست نیست/.test(nonLeaf.data.hint || ''), 'non-leaf (110401) → 400 E_COA_NOT_POSTABLE + Persian hint', nonLeaf);
    const user1104 = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', version: v0 + 1, lines: [{ code: '1104', debit: 10, credit: 0 }, { code: '3102', debit: 0, credit: 10 }] });
    ok(user1104.status === 400 && user1104.data.code === 'E_COA_NOT_POSTABLE', 'non-P3 draft on 1104 → 400 (no exemption)', user1104);
    const unknown = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', version: v0 + 1, lines: [{ code: '999999', debit: 10, credit: 0 }, { code: '3102', debit: 0, credit: 10 }] });
    ok(unknown.status === 400 && unknown.data.code, 'unknown account → 400 with code', unknown);
    const empty = await call(U.acc2, 'PUT', `/vouchers/drafts/${uid}`, { description: 'x', version: v0 + 1, lines: [] });
    ok(empty.status === 400 && empty.data.code === 'E_VOUCHER_INVALID', 'empty lines → 400', empty);
    ok(JSON.stringify(draftRow(uid)) === snapU, 'validation errors: no write');
    ok((await call(U.acc2, 'PUT', '/vouchers/drafts/999999', { version: 0, lines: LEAF_LINES(1) })).status === 404, 'PUT missing → 404');

    // superseded → 409 everywhere
    const snapJ = JSON.stringify(draftRow(je1016Id));
    const sPut = await call(U.hamed, 'PUT', `/vouchers/drafts/${je1016Id}`, { version: Number(draftRow(je1016Id).version || 0), description: 'x', lines: P3.specLines('je1016_reverse', '1104') });
    const sPost = await call(U.hamed, 'POST', `/vouchers/drafts/${je1016Id}/post`);
    const sDel = await call(U.hamed, 'DELETE', `/vouchers/drafts/${je1016Id}`);
    const sChk = await call(U.hamed, 'GET', `/vouchers/drafts/${je1016Id}/check`);
    ok(sPut.status === 409 && sPut.data.code === 'E_P3_DRAFT_SUPERSEDED', 'superseded: PUT → 409', sPut);
    ok(sPost.status === 409 && sPost.data.code === 'E_P3_DRAFT_SUPERSEDED', 'superseded: POST post → 409', sPost);
    ok(sDel.status === 409 && sDel.data.code === 'E_P3_DRAFT_SUPERSEDED', 'superseded: DELETE → 409', sDel);
    ok(sChk.status === 200 && sChk.data.ok === false && sChk.data.code === 'E_P3_DRAFT_SUPERSEDED' && /منسوخ/.test(sChk.data.error), 'superseded: check → E_P3_DRAFT_SUPERSEDED', sChk);
    ok(JSON.stringify(draftRow(je1016Id)) === snapJ && P3.isSupersededP3Draft(db, je1016Id), 'JE1016 draft untouched and still superseded');

    // P3: lines change via PUT rejected
    const origUndoc = linesOf(idUndoc);
    const snapP = JSON.stringify(draftRow(idUndoc));
    const vu = Number(draftRow(idUndoc).version || 0);
    const changed = origUndoc.map((l, i) => (i === 0 ? { ...l, debit: l.debit + 1 } : (l.code === '1104' ? { ...l, credit: l.credit + 1 } : l)));
    const p3bad = await call(U.hamed, 'PUT', `/vouchers/drafts/${idUndoc}`, { description: draftRow(idUndoc).description, lines: changed, version: vu });
    ok(p3bad.status === 400 && p3bad.data.code === 'E_COA_NOT_POSTABLE' && /برای اصلاح P3 از 1104 با خطوط اصلی/.test(p3bad.data.hint || ''),
      'P3 lines change on 1104 → PUT 400 E_COA_NOT_POSTABLE + guidance', p3bad);
    ok(JSON.stringify(draftRow(idUndoc)) === snapP, 'P3 rejected PUT: no write');

    // P3: description-only edit keeps tag + exemption
    const p3desc = await call(U.hamed, 'PUT', `/vouchers/drafts/${idUndoc}`, { description: 'شرح جدید بدون برچسب', lines: origUndoc, version: vu });
    const dAfter = draftRow(idUndoc);
    ok(p3desc.status === 200 && dAfter.description.startsWith('شرح جدید بدون برچسب') && dAfter.description.includes(`[p3:${UNDOC}]`),
      'P3 description edit: tag re-appended server-side', { p3desc, desc: dAfter.description });
    ok(p3desc.data.p3_key === UNDOC && p3desc.data.p3_exempt === true && P3.p3DraftKeyFor(db, idUndoc) === UNDOC, 'P3 description edit: key + exemption kept');
    ok(P3.checkDraftPostable(db, idUndoc).ok === true, 'P3 description edit: still postable');
    const keepTag = await call(U.hamed, 'PUT', `/vouchers/drafts/${idUndoc}`, { description: `شرح دوم [p3:${UNDOC}]`, lines: origUndoc, version: Number(dAfter.version) });
    ok(keepTag.status === 200 && (draftRow(idUndoc).description.match(/\[p3:/g) || []).length === 1, 'P3 description with tag: not duplicated', draftRow(idUndoc).description);

    // P3: direct DB lines change → check/post reject; restore → postable
    db.prepare('UPDATE voucher_drafts SET lines_json=? WHERE id=?').run(JSON.stringify(changed), idUndoc);
    const c1 = P3.checkDraftPostable(db, idUndoc);
    ok(!c1.ok && c1.code === 'E_COA_NOT_POSTABLE', 'direct DB lines change → checkDraftPostable E_COA_NOT_POSTABLE', c1);
    const hc1 = await call(U.hamed, 'GET', `/vouchers/drafts/${idUndoc}/check`);
    ok(hc1.status === 200 && hc1.data.ok === false && hc1.data.code === 'E_COA_NOT_POSTABLE' && /سطح پست نیست/.test(hc1.data.hint || ''), 'check endpoint: E_COA_NOT_POSTABLE + hint', hc1);
    const jeBefore = count('journal_entries');
    const pBad = await call(U.hamed, 'POST', `/vouchers/drafts/${idUndoc}/post`);
    ok(pBad.status === 400 && pBad.data.code === 'E_COA_NOT_POSTABLE' && pBad.data.hint && draftRow(idUndoc) && count('journal_entries') === jeBefore,
      'post with changed lines → 400 + hint, no JE, draft kept', pBad);
    const lst2 = await call(U.acc1, 'GET', '/vouchers/drafts');
    ok((lst2.data || []).find((d) => d.id === idUndoc).p3_exempt === false, 'GET: p3_exempt=false after lines change');
    const vNow = Number(draftRow(idUndoc).version);
    const restore = await call(U.hamed, 'PUT', `/vouchers/drafts/${idUndoc}`, { description: draftRow(idUndoc).description, lines: origUndoc, version: vNow });
    ok(restore.status === 200 && restore.data.p3_exempt === true, 'PUT restoring original lines → 200, exempt again', restore);
    ok(P3.checkDraftPostable(db, idUndoc).ok === true, 'restored lines → postable again');
    const hc2 = await call(U.hamed, 'GET', `/vouchers/drafts/${idUndoc}/check`);
    ok(hc2.status === 200 && hc2.data.ok === true && hc2.data.p3_key === UNDOC, 'check endpoint ok after restore', hc2);
    ok((await call(U.hamed, 'GET', '/vouchers/drafts/999999/check')).status === 404, 'check missing → 404');

    // P3 post end-to-end on temp DB (exemption via hash)
    const post490 = await call(U.hamed, 'POST', `/vouchers/drafts/${id490}/post`);
    ok(post490.status === 200 && post490.data.id && !draftRow(id490), 'P3 draft (spec lines) posts on 1104 via hash exemption (temp DB)', post490);

    // DELETE rules
    const del404 = await call(U.hamed, 'DELETE', '/vouchers/drafts/999999');
    ok(del404.status === 404, 'DELETE missing → 404');
    const delSelf = await call(U.acc1, 'DELETE', `/vouchers/drafts/${uid}`);
    ok(delSelf.status === 403 && delSelf.data.code === 'E_SOD_MAKER_CHECKER' && draftRow(uid), 'DELETE by creator (non-admin) → 403 maker-checker, kept', delSelf);
    const vDel = Number(draftRow(uid).version || 0);
    const delOther = await call(U.acc2, 'DELETE', `/vouchers/drafts/${uid}`);
    ok(delOther.status === 200 && !draftRow(uid), 'DELETE by other accountant → 200', delOther);
    const ad = lastAudit('voucher_draft_delete', uid);
    let snap = null;
    try { snap = JSON.parse(ad.detail); } catch (_) { snap = null; }
    ok(ad && Number(ad.user_id) === acc2 && snap && snap.description === 'پیش‌نویس ویرایش‌شده' && snap.date === '1405/08/11'
      && Array.isArray(snap.lines) && snap.lines[0].debit === 2500 && snap.created_by === acc1 && snap.version === vDel && 'cost_center_id' in snap,
    'audit voucher_draft_delete with full snapshot', snap);
    const own = await call(U.hamed, 'POST', '/vouchers/drafts', { date: '1405/08/10', description: 'پیش‌نویس مدیر', lines: LEAF_LINES(7) });
    const delAdminOwn = await call(U.hamed, 'DELETE', `/vouchers/drafts/${own.data.id}`);
    ok(delAdminOwn.status === 200 && !draftRow(own.data.id), 'DELETE by admin creator → 200 (admin exempt)', delAdminOwn);
    const p3DelAcc = await call(U.acc2, 'DELETE', `/vouchers/drafts/${id1977}`);
    ok(p3DelAcc.status === 403 && p3DelAcc.data.code === 'E_P3_DRAFT_ADMIN_ONLY' && draftRow(id1977), 'P3 DELETE by accountant → 403 E_P3_DRAFT_ADMIN_ONLY', p3DelAcc);
    const p3DelAdmin = await call(U.hamed, 'DELETE', `/vouchers/drafts/${id1977}`);
    const ad2 = lastAudit('voucher_draft_delete', id1977);
    ok(p3DelAdmin.status === 200 && !draftRow(id1977) && ad2 && JSON.parse(ad2.detail).p3_key === 'opening_ledger1977', 'P3 DELETE by admin → 200 + audit p3_key', p3DelAdmin);
  } finally {
    server.close();
  }

  // ── static: tbl-enhance paths, capture mapping, frontend wiring ──
  const tbl = fs.readFileSync(path.join(__dirname, '..', 'public', 'tbl-enhance.js'), 'utf8');
  ok(tbl.includes("'/accounting/vouchers/drafts/' + id") && !tbl.includes('/accounting/voucher-drafts/'), 'tbl-enhance: deleteVoucherDraft path fixed');
  ok(tbl.includes("'/accounting/vouchers/templates/' + id") && !tbl.includes('/accounting/voucher-templates/'), 'tbl-enhance: deleteVoucherTemplate path fixed');
  ok(tableForPath('/api/accounting/vouchers/drafts/12') === 'voucher_drafts' && tableForPath('/api/accounting/vouchers/drafts/12/post') === 'voucher_drafts',
    'capture: PUT/DELETE/post draft paths → voucher_drafts');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok(appJs.includes("'/accounting/vouchers/drafts/'+id+'/check'") && appJs.includes("api('PUT','/accounting/vouchers/drafts/'+ed.id"), 'frontend: check-before-post + PUT wired');
  ok(appJs.includes('حساب انتخاب‌شده سطح پست نیست — یک حساب برگ (معین/تفصیلی) انتخاب کنید یا برای اصلاح P3 از 1104 با خطوط اصلی استفاده کنید'), 'frontend: E_COA_NOT_POSTABLE guidance text');
  ok(appJs.includes('مشاهده، ویرایش و حذف پیش‌نویس سند (FR-POS-DRAFTS)'), 'frontend: admin help section added');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { dbMods.closeDB(); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
