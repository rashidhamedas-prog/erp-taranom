'use strict';
/**
 * P3 — پیش‌نویس‌های اصلاح دادهٔ «تطبیق موجودی» (فقط پیش‌نویس؛ هیچ سندی post نمی‌شود).
 *
 * پیش‌نویس‌ها در voucher_drafts ساخته می‌شوند (مسیر رسمی پیش‌نویس سند دستی) و هیچ ردیفی در
 * journal_entries / journal_lines نمی‌سازند؛ پس هیچ مانده/گزارش دفتری را عوض نمی‌کنند.
 * ثبت نهایی فقط با «ثبت پیش‌نویس» توسط کاربر دیگر (maker-checker) — منتظر تأیید حامد.
 *
 * هر پیش‌نویس کلید منبع یکتا دارد (wh_data_corrections: rule='p3_draft', row_key=<key>)؛
 * یک‌بار ساخته‌شده هرگز دوباره ساخته نمی‌شود (حتی اگر حذف/ثبت شده باشد).
 * هیچ DELETE و هیچ UPDATE روی ردیف موجود انجام نمی‌شود (جز مهاجرت v2 روی پیش‌نویس‌های ثبت‌نشدهٔ P3).
 *
 * P3-fix: برگشت JE1016 فقط از مسیر رسمی subledger-recon fix #1 — پیش‌نویس دستی آن ساخته نمی‌شود و ثبتش مسدود است.
 *
 * FR-P3 (تصمیم حامد): کل ماندهٔ GL موجودی روی خود 1104 است (110401 بی‌گردش با ۳۴۱ زیرحساب تفصیلی)
 * ⇒ سطرهای موجودی همهٔ پیش‌نویس‌های P3 روی 1104؛ مهاجرت v3 پیش‌نویس‌های ثبت‌نشدهٔ 110401 را به 1104
 * برمی‌گرداند و پیش‌نویس افتتاحیهٔ ledger#2021–2023 را می‌سازد. ثبت این پیش‌نویس‌ها روی 1104 حتی با
 * ledger_leaf_enforcement=enforce از معافیت محدود «حساب کنترل موجودی» (coa-leaf-policy) می‌گذرد.
 * ledger#2003 صراحتاً مستثناست (EXCLUDED_LEDGER_IDS).
 *
 * FR-P334-B (تصمیم حامد): ledger#1273 (کالا 334، WIP) با برگشت رسمی کاردکس (FR-P334-A) حل می‌شود ⇒
 * پیش‌نویس #2 فقط ledger#1978/1979 (79,655,914)؛ مهاجرت v4 سطر 1273 را از پیش‌نویس ثبت‌نشدهٔ موجود حذف می‌کند.
 *
 * FR-POS-DRAFTS-A: معافیت 1104 به «سطرها» گره خورده است نه فقط به شناسهٔ پیش‌نویس — هش کانونی سطرها
 * (canonicalLinesHash) هنگام ساخت/بازنویسی در wh_data_corrections (rule='p3_draft_hash') مهر می‌شود و
 * p3PostingOptionsForDraft فقط وقتی معافیت می‌دهد که هش سطرهای فعلی با هش مهرشده برابر باشد.
 */

const crypto = require('crypto');
const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

const RULE = 'p3_draft';
const PHASE = 'P3';
const SETTINGS_KEY = 'p3_recon_drafts_v1';
const SETTINGS_KEY_V2 = 'p3_recon_drafts_v2';
const SETTINGS_KEY_V3 = 'p3_recon_drafts_v3';
const RULE_V2 = 'p3_draft_v2';
const RULE_V3 = 'p3_draft_v3';
const JE1016_DRAFT_KEY = 'je1016_reverse';
const SUPERSEDED_PREFIX = '⛔ منسوخ — برگشت JE1016 فقط از مسیر رسمی subledger-recon fix #1';
const OFFICIAL_REVERSE_PATH = 'POST /api/accounting/subledger-recon/fixes/1/reverse';
const KARDEX_WAREHOUSES = [34, 35];

const ACC_INV = '1104';
const LEGACY_LEAF = '110401';
const ACC_OPENING = '3102';
const ACC_FY_OPENING = '3201';
const ACC_SHORTAGE = '610801';
const ACC_COGS = '5101';

const JE1016 = { id: 1016, ref_type: 'inventory_recon_adjust', amount: 1796860352 };
const UNDOC_KEY = 'undoc_adjust_146335856';
const UNDOC_ROWS = [
  { id: 1978, product_id: 115, warehouse_id: 34, amount: 66742000 },
  { id: 1979, product_id: 131, warehouse_id: 35, amount: 12913914 },
];
const UNDOC_TOTAL = 79655914;
// FR-P334-B (تصمیم حامد): ledger#1273 (کالا 334، WIP) با برگشت رسمی کاردکس (FR-P334-A) حل می‌شود، نه پیش‌نویس.
const LEDGER1273 = { id: 1273, product_id: 334, warehouse_id: 34, amount: 66679942, wip_review: true };
const OFFICIAL_KARDEX_REVERSAL_LEDGER_IDS = Object.freeze([LEDGER1273.id]);
const OFFICIAL_KARDEX_REVERSAL_ROUTE = 'FR-P334-A — برگشت رسمی کاردکس ledger#1273';
const UNDOC_LEGACY_ROWS = [...UNDOC_ROWS, LEDGER1273];
const UNDOC_LEGACY_TOTAL = 146335856;
const JE490 = { id: 490, ref_type: 'opening_inventory', amount: 71232000, ledger_id: 1230, product_id: 335, warehouse_id: 34 };
const LEDGER1977 = { id: 1977, product_id: 109, warehouse_id: 35, amount: 10759000 };
const OPENINGS_2021_2023_KEY = 'opening_ledger2021_2023';
const OPENINGS_2021_2023 = [
  { id: 2021, product_id: 183, warehouse_id: 34, qty: 1, amount: 5189000 },
  { id: 2022, product_id: 340, warehouse_id: 34, qty: 1, amount: 5051111 },
  { id: 2023, product_id: 341, warehouse_id: 34, qty: 1, amount: 4493000 },
];
const OPENINGS_2021_2023_TOTAL = 14733111;
// تصمیم حامد: ledger#2003 (کالا 334، انبار 35، ۸ عدد، 165,582,632، opening_inventory) هیچ پیش‌نویسی نمی‌گیرد.
const EXCLUDED_LEDGER_IDS = Object.freeze([2003]);
const COGS_TARGET_WH = 35;
/** گزینهٔ اعتبارسنجی/ثبت فقط برای پیش‌نویس‌های P3: معافیت محدود حساب کنترل 1104 (coa-leaf-policy). */
const P3_POSTING_OPTIONS = Object.freeze({ exemptControlCodes: Object.freeze([ACC_INV]) });
{
  const used = [...UNDOC_ROWS.map((r) => r.id), JE490.ledger_id, LEDGER1977.id, ...OPENINGS_2021_2023.map((r) => r.id)];
  const bad = used.filter((id) => EXCLUDED_LEDGER_IDS.includes(id) || OFFICIAL_KARDEX_REVERSAL_LEDGER_IDS.includes(id));
  if (bad.length) throw new Error(`P3: ledger مستثنا در پیش‌نویس: ${bad.join(',')}`);
  if (UNDOC_ROWS.reduce((t, r) => t + r.amount, 0) !== UNDOC_TOTAL
    || UNDOC_LEGACY_ROWS.reduce((t, r) => t + r.amount, 0) !== UNDOC_LEGACY_TOTAL) throw new Error('P3: جمع تعدیل بی‌سند ناسازگار');
  if (OPENINGS_2021_2023.reduce((t, r) => t + r.amount, 0) !== OPENINGS_2021_2023_TOTAL) throw new Error('P3: جمع افتتاحیه 2021–2023 ناسازگار');
}

const SQL_DR = 'COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)';
const SQL_CR = 'COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)';

function n(v) { return Number(v) || 0; }
function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function colSet(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); }
  catch (_) { return new Set(); }
}

/** فقط سندهای قطعی (approved/posted)؛ پیش‌نویس (status='draft')، معلق و برگشتی/باطل شمرده نمی‌شوند. */
function jeLiveWhere(db, alias) {
  const cols = colSet(db, 'journal_entries');
  const w = [`COALESCE(${alias}.status,'approved') IN ('approved','posted')`];
  if (cols.has('deleted_at')) w.push(`COALESCE(${alias}.deleted_at,0)=0`);
  return w.join(' AND ');
}

function jeHeader(db, id) {
  if (!tableExists(db, 'journal_entries')) return null;
  return db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id) || null;
}

function jeSide(db, id, code, side) {
  const expr = side === 'debit' ? SQL_DR : SQL_CR;
  return Math.round(n(db.prepare(`
    SELECT COALESCE(SUM(${expr}),0) v FROM journal_lines jl WHERE jl.entry_id=? AND jl.account_code=?
  `).get(id, code).v));
}

function jeIsLive(db, je) {
  if (!je) return false;
  if (Number(je.deleted_at || 0) > 0) return false;
  if (!['approved', 'posted'].includes(String(je.status || 'approved'))) return false;
  if (je.reversed_by_je_id) return false;
  const rev = db.prepare(`
    SELECT id FROM journal_entries je
    WHERE ${jeLiveWhere(db, 'je')} AND je.id<>? AND je.description LIKE ?
    LIMIT 1
  `).get(je.id, `ابطال سند #${je.id}%`);
  return !rev;
}

function ledgerRow(db, id) {
  if (!tableExists(db, 'inventory_ledger')) return null;
  return db.prepare(`SELECT *, (${LEDGER_LIVE_SQL}) AS live FROM inventory_ledger WHERE id=?`).get(id) || null;
}

function draftMarker(db, key) {
  if (!tableExists(db, 'wh_data_corrections')) return null;
  return db.prepare(`
    SELECT new_value FROM wh_data_corrections WHERE rule=? AND row_key=? ORDER BY id DESC LIMIT 1
  `).get(RULE, key) || null;
}

// ── هش کانونی سطرها (معافیت 1104 فقط برای همان سطرهای مهرشده) ──

const RULE_HASH = 'p3_draft_hash';
const SETTINGS_KEY_HASH = 'p3_recon_drafts_lines_hash_v1';

/** sha256 روی آرایهٔ مرتب [code, round(debit), round(credit), person_id|null]؛ شرح سطر اثری ندارد. */
function canonicalLinesHash(lines) {
  const arr = (Array.isArray(lines) ? lines : []).map((l) => {
    const x = l && typeof l === 'object' ? l : {};
    const pid = x.person_id == null || x.person_id === '' || x.person_id === 0 ? null : String(x.person_id);
    return [String(x.code == null ? '' : x.code).trim(), Math.round(n(x.debit)), Math.round(n(x.credit)), pid];
  });
  return crypto.createHash('sha256').update(JSON.stringify(arr)).digest('hex');
}

function storedLinesHash(db, key) {
  if (!key || !tableExists(db, 'wh_data_corrections')) return null;
  const r = db.prepare(`
    SELECT new_value FROM wh_data_corrections WHERE rule=? AND row_key=? AND col='lines_hash' ORDER BY id DESC LIMIT 1
  `).get(RULE_HASH, key);
  return r && r.new_value ? String(r.new_value) : null;
}

/** مهر هش سطرهای پیش‌نویس P3 (فقط وقتی تغییر کرده). opts.onlyIfMissing ⇒ هش موجود بازنویسی نمی‌شود. */
function stampLinesHash(db, key, draftId, lines, opts = {}) {
  if (!key || !tableExists(db, 'wh_data_corrections')) return null;
  const prev = storedLinesHash(db, key);
  if (prev && opts.onlyIfMissing) return prev;
  const hash = canonicalLinesHash(lines);
  if (prev === hash) return hash;
  db.prepare(`
    INSERT INTO wh_data_corrections (run_id, phase, rule, tbl, row_key, col, old_value, new_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(opts.runId || `p3hash-${new Date().toISOString().replace(/[:.]/g, '-')}`, PHASE, RULE_HASH, 'voucher_drafts',
    key, 'lines_hash', prev, hash, `${opts.reason || 'مهر هش سطرهای پیش‌نویس P3'} (draft #${draftId == null ? '-' : draftId})`);
  return hash;
}

function accountState(db, code) {
  const acc = db.prepare('SELECT code, name, is_active FROM chart_of_accounts WHERE code=?').get(code);
  if (!acc) return { code, exists: false, active: false, postable: false, name: code };
  const kid = db.prepare('SELECT 1 FROM chart_of_accounts WHERE parent_code=? AND COALESCE(is_active,1)=1 LIMIT 1').get(code);
  return { code, exists: true, active: acc.is_active !== 0, postable: acc.is_active !== 0 && !kid, name: acc.name };
}

// ── inventory subtree / leaf ─────────────────────────────────────

const SUBTREE_CTE = `WITH RECURSIVE inv_tree(code) AS (
  SELECT ? UNION SELECT c.code FROM chart_of_accounts c JOIN inv_tree t ON c.parent_code=t.code
)`;

/** کدهای 1104 و همهٔ نوادگانش (درخت parent_code + هم‌پیشوندها، هم‌سو با glBalance تطبیق). */
function inventorySubtreeCodes(db, root = ACC_INV) {
  const out = new Set([root]);
  if (!tableExists(db, 'chart_of_accounts')) return out;
  for (const r of db.prepare(`${SUBTREE_CTE} SELECT code FROM inv_tree`).all(root)) out.add(String(r.code));
  for (const r of db.prepare('SELECT code FROM chart_of_accounts WHERE code LIKE ?').all(`${root}%`)) out.add(String(r.code));
  return out;
}

/**
 * حساب موجودی سطرهای پیش‌نویس P3 — FR-P3 (تصمیم حامد): همیشه 1104 (کل ماندهٔ GL آنجاست).
 * 1104 فرزند دارد؛ ثبت از معافیت محدود حساب کنترل موجودی می‌گذرد (`p3PostingOptions`).
 */
function resolveInventoryLeaf(db) {
  const st = tableExists(db, 'chart_of_accounts') ? accountState(db, ACC_INV) : { postable: true };
  return {
    code: ACC_INV,
    source: 'hamed_decision_1104',
    warning: st.postable ? null
      : `${ACC_INV} زیرحساب دارد؛ ثبت پیش‌نویس‌های P3 فقط با معافیت حساب کنترل موجودی (تا وقتی کل مانده روی ${ACC_INV} است)`,
  };
}

/** مانده (بدهکار−بستانکار، ریال) سندهای زنده روی 1104 و همهٔ زیرحساب‌هایش. */
function glInventorySubtreeRial(db, root = ACC_INV) {
  if (!tableExists(db, 'journal_lines')) return 0;
  return Math.round(n(db.prepare(`
    ${SUBTREE_CTE}
    SELECT COALESCE(SUM(${SQL_DR}) - SUM(${SQL_CR}),0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${jeLiveWhere(db, 'je')}
      AND (jl.account_code IN (SELECT code FROM inv_tree) OR jl.account_code LIKE ?)
  `).get(root, `${root}%`).v));
}

/** ارزش کاردکس زنده (ریال) انبارهای داده‌شده — همان فرمول layer-reconcile. */
function kardexValueRial(db, warehouseIds = KARDEX_WAREHOUSES) {
  if (!tableExists(db, 'inventory_ledger') || !warehouseIds.length) return 0;
  return Math.round(n(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN COALESCE(amount_rial,0)
                             WHEN COALESCE(qty_out,0)>0 THEN -COALESCE(amount_rial,0)
                             ELSE COALESCE(amount_rial,0) END),0) v
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL} AND warehouse_id IN (${warehouseIds.map(() => '?').join(',')})
  `).get(...warehouseIds.map(Number)).v));
}

/** gap = GL(1104+زیرحساب‌ها) − کاردکس(34+35). */
function inventoryGapSnapshot(db, warehouseIds = KARDEX_WAREHOUSES) {
  const gl = glInventorySubtreeRial(db);
  const kardex = kardexValueRial(db, warehouseIds);
  return { gl_1104_subtree_rial: gl, kardex_rial: kardex, kardex_warehouses: warehouseIds.slice(), gap_rial: gl - kardex };
}

// ── guards (readonly) ─────────────────────────────────────────────

function guardJe1016(db) {
  const je = jeHeader(db, JE1016.id);
  const fail = (why) => ({ ok: false, why });
  if (!je) return fail('JE 1016 وجود ندارد');
  if (String(je.ref_type || '') !== JE1016.ref_type) return fail(`نوع JE 1016 «${je.ref_type}» است، نه ${JE1016.ref_type}`);
  if (!jeIsLive(db, je)) return fail('JE 1016 قبلاً برگشت/ابطال شده است');
  const dr = jeSide(db, je.id, ACC_OPENING, 'debit');
  const cr = jeSide(db, je.id, ACC_INV, 'credit');
  if (dr !== JE1016.amount || cr !== JE1016.amount) {
    return fail(`مبلغ JE 1016 منطبق نیست (Dr ${ACC_OPENING}=${dr}، Cr ${ACC_INV}=${cr})`);
  }
  if (tableExists(db, 'subledger_recon_fixes')) {
    const fix = db.prepare('SELECT id, status FROM subledger_recon_fixes WHERE je_id=? LIMIT 1').get(je.id);
    if (fix && ['reversed', 'void'].includes(String(fix.status || ''))) return fail(`fix #${fix.id} مربوط به JE 1016 برگشت شده است`);
  }
  return { ok: true, je_id: je.id, entry_date: je.entry_date };
}

function noAdjustJeFor(db, ledgerId) {
  return !db.prepare(`
    SELECT 1 FROM journal_entries je
    WHERE ${jeLiveWhere(db, 'je')} AND je.ref_type IN ('inventory_adjust','stock_adjust') AND je.ref_id=?
    LIMIT 1
  `).get(ledgerId);
}

function guardUndocRows(db) {
  for (const exp of UNDOC_ROWS) {
    const r = ledgerRow(db, exp.id);
    if (!r) return { ok: false, why: `ردیف کاردکس ${exp.id} وجود ندارد` };
    if (!r.live) return { ok: false, why: `ردیف کاردکس ${exp.id} زنده نیست` };
    if (r.je_id != null) return { ok: false, why: `ردیف کاردکس ${exp.id} سند دارد (je_id=${r.je_id})` };
    if (Number(r.product_id) !== exp.product_id || Number(r.warehouse_id) !== exp.warehouse_id) {
      return { ok: false, why: `کالا/انبار ردیف ${exp.id} منطبق نیست` };
    }
    if (Math.abs(Math.round(n(r.amount_rial))) !== exp.amount) {
      return { ok: false, why: `مبلغ ردیف ${exp.id} = ${r.amount_rial}، انتظار ${exp.amount}` };
    }
    if (!noAdjustJeFor(db, exp.id)) return { ok: false, why: `برای ردیف ${exp.id} سند تعدیل زنده موجود است` };
  }
  return { ok: true };
}

function guardJe490(db) {
  const je = jeHeader(db, JE490.id);
  if (!je) return { ok: false, why: 'JE 490 وجود ندارد' };
  if (String(je.ref_type || '') !== JE490.ref_type) return { ok: false, why: `نوع JE 490 «${je.ref_type}» است` };
  if (!jeIsLive(db, je)) return { ok: false, why: 'JE 490 برگشت/ابطال شده است' };
  const dr = jeSide(db, je.id, ACC_INV, 'debit');
  const cr = jeSide(db, je.id, ACC_OPENING, 'credit');
  if (dr !== JE490.amount || cr !== JE490.amount) return { ok: false, why: `مبلغ JE 490 منطبق نیست (Dr=${dr}، Cr=${cr})` };
  const r = ledgerRow(db, JE490.ledger_id);
  if (!r || !r.live) return { ok: false, why: 'ردیف کاردکس 1230 زنده نیست' };
  if (Number(r.je_id) !== JE490.id) return { ok: false, why: `ردیف 1230 به JE ${r.je_id} وصل است` };
  if (Number(r.product_id) !== JE490.product_id || Math.abs(Math.round(n(r.amount_rial))) !== JE490.amount) {
    return { ok: false, why: 'کالا/مبلغ ردیف 1230 منطبق نیست' };
  }
  return { ok: true };
}

function guardLedger1977(db) {
  const r = ledgerRow(db, LEDGER1977.id);
  if (!r) return { ok: false, why: 'ردیف کاردکس 1977 وجود ندارد' };
  if (!r.live) return { ok: false, why: 'ردیف کاردکس 1977 زنده نیست' };
  if (r.je_id != null) return { ok: false, why: `ردیف 1977 سند دارد (je_id=${r.je_id})` };
  const isOpening = String(r.event_type || '') === 'opening' || String(r.source_type || '') === 'opening_inventory';
  if (!isOpening) return { ok: false, why: 'ردیف 1977 افتتاحیه نیست' };
  if (Number(r.product_id) !== LEDGER1977.product_id || Number(r.warehouse_id) !== LEDGER1977.warehouse_id
    || Math.abs(Math.round(n(r.amount_rial))) !== LEDGER1977.amount) {
    return { ok: false, why: 'کالا/انبار/مبلغ ردیف 1977 منطبق نیست' };
  }
  const covered = db.prepare(`
    SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${jeLiveWhere(db, 'je')} AND jl.account_code=?
      AND (${SQL_DR}=? OR ${SQL_CR}=?)
    LIMIT 1
  `).get(ACC_FY_OPENING, LEDGER1977.amount, LEDGER1977.amount);
  if (covered) return { ok: false, why: `حساب ${ACC_FY_OPENING} سطری با مبلغ ${LEDGER1977.amount} دارد (پوشش داده شده)` };
  return { ok: true };
}

function guardOpenings2021to2023(db) {
  for (const exp of OPENINGS_2021_2023) {
    const r = ledgerRow(db, exp.id);
    if (!r) return { ok: false, why: `ردیف کاردکس ${exp.id} وجود ندارد` };
    if (!r.live) return { ok: false, why: `ردیف کاردکس ${exp.id} زنده نیست` };
    if (r.je_id != null) return { ok: false, why: `ردیف ${exp.id} سند دارد (je_id=${r.je_id})` };
    const isOpening = String(r.event_type || '') === 'opening' || String(r.source_type || '') === 'opening_inventory';
    if (!isOpening) return { ok: false, why: `ردیف ${exp.id} افتتاحیه نیست` };
    if (Number(r.product_id) !== exp.product_id || Number(r.warehouse_id) !== exp.warehouse_id
      || n(r.qty_in) !== exp.qty || Math.abs(Math.round(n(r.amount_rial))) !== exp.amount) {
      return { ok: false, why: `کالا/انبار/تعداد/مبلغ ردیف ${exp.id} منطبق نیست` };
    }
  }
  return { ok: true };
}

// ── plan ─────────────────────────────────────────────────────────

function tag(key) { return `[p3:${key}]`; }

function undocLines(rows, inv) {
  const total = rows.reduce((t, r) => t + r.amount, 0);
  return [
    ...rows.map((r) => ({
      code: ACC_SHORTAGE, debit: r.amount, credit: 0,
      description: `تعدیل بی‌سند ledger#${r.id} کالا ${r.product_id}${r.wip_review ? ' — «بررسی WIP»' : ''}`,
    })),
    { code: inv, debit: 0, credit: total, description: `موجودی کالا — ledger#${rows.map((r) => r.id).join('/')}` },
  ];
}

/** سطرهای پیش‌نویس #2 پیش از FR-P334-B (چهار سطر با ledger#1273؛ همان شکل production). */
function legacyUndocLines(inv) {
  return undocLines(UNDOC_LEGACY_ROWS, inv);
}

/** همهٔ شکل‌های معتبر سطرهای پیش‌نویس (فعلی + تاریخی) برای مهاجرت‌های v2/v3. */
function specVariants(key, inv) {
  const cur = specLines(key, inv);
  return key === UNDOC_KEY ? [cur, legacyUndocLines(inv)] : [cur];
}

/** سطرهای اصلی پیش‌نویس‌های P3 با حساب موجودی داده‌شده (v1 روی 1104؛ v2 روی 110401؛ v3 دوباره 1104). */
function specLines(key, inv) {
  switch (key) {
    case JE1016_DRAFT_KEY:
      return [
        { code: inv, debit: JE1016.amount, credit: 0, description: 'برگشت JE #1016 — موجودی کالا' },
        { code: ACC_OPENING, debit: 0, credit: JE1016.amount, description: 'برگشت JE #1016 — تراز افتتاحیه' },
      ];
    case UNDOC_KEY:
      return undocLines(UNDOC_ROWS, inv);
    case 'opening_je490_offset':
      return [
        { code: inv, debit: JE490.amount, credit: 0, description: 'افتتاحیه JE #490 / ledger#1230' },
        { code: ACC_OPENING, debit: 0, credit: JE490.amount, description: 'تراز افتتاحیه — JE #490' },
      ];
    case 'opening_ledger1977':
      return [
        { code: inv, debit: LEDGER1977.amount, credit: 0, description: 'افتتاحیه ledger#1977' },
        { code: ACC_OPENING, debit: 0, credit: LEDGER1977.amount, description: 'تراز افتتاحیه — ledger#1977' },
      ];
    case OPENINGS_2021_2023_KEY:
      return [
        ...OPENINGS_2021_2023.map((r) => ({
          code: inv, debit: r.amount, credit: 0,
          description: `افتتاحیه ledger#${r.id} کالا ${r.product_id} (انبار ${r.warehouse_id}، ${r.qty} عدد)`,
        })),
        {
          code: ACC_OPENING, debit: 0, credit: OPENINGS_2021_2023_TOTAL,
          description: `تراز افتتاحیه — ${OPENINGS_2021_2023.map((r) => `ledger#${r.id}`).join('/')}`,
        },
      ];
    default:
      return null;
  }
}

const DRAFT_PREFIX = 'پیش‌نویس P3 — منتظر تأیید حامد —';

function undocDescription(prefix = DRAFT_PREFIX) {
  return `${prefix} تعدیل بی‌سند کاردکس ledger#1978، ledger#1979 ${tag(UNDOC_KEY)}`;
}

/** شرح پیش‌نویس #2 پیش از FR-P334-B (همان متن v1 در production). */
function legacyUndocDescription(prefix = DRAFT_PREFIX) {
  return `${prefix} تعدیل بی‌سند کاردکس ledger#1978، ledger#1979، ledger#1273 (کالای 334: بررسی WIP) ${tag(UNDOC_KEY)}`;
}

function buildPlan(db) {
  const prefix = DRAFT_PREFIX;
  const leaf = resolveInventoryLeaf(db);
  const inv = leaf.code;
  const subtree = inventorySubtreeCodes(db);
  const specs = [];
  specs.push({
    key: JE1016_DRAFT_KEY,
    amount: JE1016.amount,
    superseded: true,
    official_route: OFFICIAL_REVERSE_PATH,
    guard: guardJe1016(db),
    guard_text: 'JE 1016 با ref_type=inventory_recon_adjust، Dr 3102/Cr 1104 = 1,796,860,352، زنده و برگشت‌نشده',
    description: `${SUPERSEDED_PREFIX} — پیش‌نویس دستی ساخته نمی‌شود ${tag(JE1016_DRAFT_KEY)}`,
    lines: specLines(JE1016_DRAFT_KEY, inv),
  });
  specs.push({
    key: UNDOC_KEY,
    amount: UNDOC_TOTAL,
    guard: guardUndocRows(db),
    guard_text: 'ردیف‌های کاردکس 1978 (کالا 115، wh34، 66,742,000)، 1979 (کالا 131، wh35، 12,913,914) زنده و je_id IS NULL، بدون سند تعدیل زنده (ledger#1273 → برگشت رسمی کاردکس FR-P334-A)',
    description: undocDescription(prefix),
    lines: specLines(UNDOC_KEY, inv),
  });
  specs.push({
    key: 'opening_je490_offset',
    amount: JE490.amount,
    guard: guardJe490(db),
    guard_text: 'JE 490 (opening_inventory) زنده با Dr 1104/Cr 3102 = 71,232,000 و ردیف کاردکس 1230 (کالا 335) با je_id=490',
    description: `${prefix} بازگردانی افتتاحیهٔ خنثی‌شدهٔ JE #490 / ledger#1230 (کالای 335) ${tag('opening_je490_offset')}`,
    lines: specLines('opening_je490_offset', inv),
  });
  specs.push({
    key: 'opening_ledger1977',
    amount: LEDGER1977.amount,
    guard: guardLedger1977(db),
    guard_text: 'ردیف کاردکس 1977 (افتتاحیه، کالا 109، wh35، 10,759,000) زنده با je_id IS NULL و هیچ سطر زندهٔ 3201 با همین مبلغ',
    description: `${prefix} افتتاحیهٔ بی‌سند ledger#1977 (کالای 109، انبار 35) ${tag('opening_ledger1977')}`,
    lines: specLines('opening_ledger1977', inv),
  });
  specs.push({
    key: OPENINGS_2021_2023_KEY,
    amount: OPENINGS_2021_2023_TOTAL,
    guard: guardOpenings2021to2023(db),
    guard_text: 'ردیف‌های کاردکس 2021 (کالا 183، 5,189,000)، 2022 (کالا 340، 5,051,111)، 2023 (کالا 341، 4,493,000) — همه افتتاحیه، انبار 34، ۱ عدد، زنده با je_id IS NULL (ledger#2003 مستثنا)',
    description: `${prefix} افتتاحیهٔ بی‌سند ledger#2021، ledger#2022، ledger#2023 (کالاهای 183/340/341، انبار 34) ${tag(OPENINGS_2021_2023_KEY)}`,
    lines: specLines(OPENINGS_2021_2023_KEY, inv),
  });
  for (const s of specs) {
    const mark = draftMarker(db, s.key);
    s.already = mark ? { draft_id: Number(mark.new_value) || null } : null;
    s.inventory_leaf = leaf;
    s.accounts = [...new Set(s.lines.map((l) => l.code))].map((c) => accountState(db, c));
    s.effect_1104_rial = s.lines.reduce((t, l) => t + (subtree.has(String(l.code)) ? n(l.debit) - n(l.credit) : 0), 0);
  }
  return specs;
}

// ── COGS share of zero-inbound transfers (report only) ───────────

function computeZeroInboundCogsShare(db, opts = {}) {
  const wh = Number(opts.warehouseId || COGS_TARGET_WH);
  if (!tableExists(db, 'inventory_ledger')) return { warehouse_id: wh, pairs: 0, products: [], totals: {} };
  const pairs = db.prepare(`
    SELECT o.id AS out_id, i.id AS in_id, i.product_id, o.amount_rial AS out_amount
    FROM inventory_ledger o
    JOIN inventory_ledger i
      ON i.source_id=o.source_id AND i.source_type=o.source_type
     AND i.event_type='transfer_in' AND i.status='posted' AND i.product_id=o.product_id
    WHERE o.status='posted' AND o.source_type='warehouse_transfer' AND o.event_type='transfer_out'
      AND i.warehouse_id=? AND COALESCE(i.amount_rial,0)=0 AND COALESCE(o.amount_rial,0)<>0
  `).all(wh);
  const restore = new Map(pairs.map((p) => [p.in_id, Math.abs(Math.round(n(p.out_amount)))]));
  const byProduct = new Map();
  for (const p of pairs) byProduct.set(p.product_id, (byProduct.get(p.product_id) || 0) + 1);
  const rowsStmt = db.prepare(`
    SELECT id, event_type, qty_in, qty_out, amount_rial FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND ${LEDGER_LIVE_SQL}
    ORDER BY id
  `);
  const products = [];
  const totals = { restored_inbound_rial: 0, delta_cogs_sales_rial: 0, delta_other_out_rial: 0, remaining_in_stock_rial: 0 };
  for (const [pid, cnt] of byProduct) {
    let qty = 0;
    let valCorr = 0;
    let valAct = 0;
    let restored = 0;
    let dSales = 0;
    let dOther = 0;
    for (const r of rowsStmt.all(pid, wh)) {
      const qIn = n(r.qty_in);
      const qOut = n(r.qty_out);
      const amt = Math.abs(Math.round(n(r.amount_rial)));
      if (qIn > 0) {
        const add = restore.has(r.id) ? restore.get(r.id) : amt;
        if (restore.has(r.id)) restored += add;
        qty += qIn; valCorr += add; valAct += amt;
      }
      if (qOut > 0) {
        const avg = qty > 0 ? valCorr / qty : 0;
        const corr = Math.round(avg * qOut);
        const d = corr - amt;
        if (String(r.event_type || '') === 'sale') dSales += d; else dOther += d;
        qty -= qOut; valCorr -= corr; valAct -= amt;
      }
    }
    const remaining = Math.round(valCorr - valAct);
    products.push({
      product_id: pid, pairs: cnt, restored_inbound_rial: restored,
      delta_cogs_sales_rial: dSales, delta_other_out_rial: dOther, remaining_in_stock_rial: remaining,
    });
    totals.restored_inbound_rial += restored;
    totals.delta_cogs_sales_rial += dSales;
    totals.delta_other_out_rial += dOther;
    totals.remaining_in_stock_rial += remaining;
  }
  products.sort((a, b) => a.product_id - b.product_id);
  return {
    warehouse_id: wh,
    pairs: pairs.length,
    products,
    totals,
    draft: null,
    note: 'فقط گزارش: بازپخش میانگین موزون مدل‌محور است (برگشت‌ها/ترتیب تاریخ اثر دارند) و از سند مبدأ قطعی نیست؛ پیش‌نویس Dr 5101 / Cr 1104 ساخته نمی‌شود تا حسابدار عدد را تأیید کند.',
  };
}

/** مانده زندهٔ 1104 + همهٔ زیرحساب‌ها (110401 و …) — کنترل اختلاف روی کل درخت. */
function gl1104ApprovedRial(db) {
  return glInventorySubtreeRial(db, ACC_INV);
}

/** گزارش readonly: برنامهٔ پیش‌نویس‌ها + اثر فرضی روی درخت 1104 + سهم COGS. */
function buildP3Report(db) {
  const plan = buildPlan(db);
  const gl = gl1104ApprovedRial(db);
  const eligible = plan.filter((s) => !s.superseded && (s.guard.ok || s.already));
  const effect = eligible.reduce((t, s) => t + s.effect_1104_rial, 0);
  const gap = inventoryGapSnapshot(db);
  return {
    inventory_leaf: plan[0].inventory_leaf,
    gl_1104_live_rial: gl,
    gl_1104_if_all_drafts_posted_rial: gl + effect,
    drafts_effect_1104_rial: effect,
    gap_gl_minus_kardex_rial: gap.gap_rial,
    kardex_34_35_rial: gap.kardex_rial,
    gap_if_all_drafts_posted_rial: gap.gap_rial + effect,
    plan: plan.map((s) => ({
      key: s.key, amount_rial: s.amount, description: s.description, lines: s.lines,
      superseded: !!s.superseded, official_route: s.official_route || null,
      guard_ok: !!s.guard.ok, guard_reason: s.guard.ok ? null : s.guard.why, guard_text: s.guard_text,
      already_created: s.already, accounts: s.accounts, effect_1104_rial: s.effect_1104_rial,
    })),
    cogs_zero_inbound: computeZeroInboundCogsShare(db, {}),
    excluded_ledger_ids: EXCLUDED_LEDGER_IDS.slice(),
    handled_by_official_reversal: [{
      ledger_id: LEDGER1273.id, product_id: LEDGER1273.product_id, warehouse_id: LEDGER1273.warehouse_id,
      amount_rial: LEDGER1273.amount, route: OFFICIAL_KARDEX_REVERSAL_ROUTE, draft: null,
    }],
  };
}

function wrapValidate(warnings, key) {
  const { validateAndBuildVoucherLines } = require('../../routes/accounting');
  return (db, lines) => {
    const built = validateAndBuildVoucherLines(db, lines, P3_POSTING_OPTIONS);
    if (built && built.code === 'E_COA_NOT_POSTABLE') {
      warnings.push({ key, warning: built.error });
      return { cleanLines: lines, personPostings: [] };
    }
    return built;
  };
}

/**
 * پیش‌نویس‌های P3 را می‌سازد (فقط voucher_drafts). باید داخل تراکنش فراخوانده شود
 * یا خودش یک تراکنش باز می‌کند. هرگز DELETE/UPDATE روی ردیف موجود انجام نمی‌دهد.
 * @returns {{created:object[], skipped:object[], already:object[], warnings:object[]}}
 */
function createP3Drafts(db, opts = {}) {
  const WH = require('./wh-data-correction');
  const { todayJalali } = require('../../jalali');
  WH.ensureWhDataCorrections(db);
  const out = { created: [], skipped: [], already: [], warnings: [] };
  const run = () => {
    const plan = buildPlan(db);
    let user;
    try { user = WH.pickServiceUser(db, opts.createdBy || null); }
    catch (e) {
      for (const s of plan) {
        if (s.superseded || (Array.isArray(opts.onlyKeys) && !opts.onlyKeys.includes(s.key))) continue;
        out.skipped.push({ key: s.key, why: e.message });
      }
      return;
    }
    const ctx = {
      db, phase: PHASE, runId: opts.runId || `p3-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      userId: user.id, changes: [], drafts: [],
    };
    const date = opts.date || todayJalali();
    const only = Array.isArray(opts.onlyKeys) ? new Set(opts.onlyKeys) : null;
    for (const s of plan) {
      if (only && !only.has(s.key)) continue;
      if (s.superseded) {
        if (s.already) out.already.push({ key: s.key, draft_id: s.already.draft_id, superseded: true });
        continue;
      }
      if (s.already) { out.already.push({ key: s.key, draft_id: s.already.draft_id }); continue; }
      if (!s.guard.ok) { out.skipped.push({ key: s.key, why: s.guard.why }); continue; }
      const missing = s.accounts.filter((a) => !a.exists || !a.active);
      if (missing.length) {
        out.skipped.push({ key: s.key, why: `حساب ${missing.map((a) => a.code).join(',')} موجود/فعال نیست` });
        continue;
      }
      WH.insertDraft(ctx, wrapValidate(out.warnings, s.key), {
        rule: RULE, ref: s.key, date, userId: user.id, costCenterId: null,
        description: s.description, lines: s.lines, amount: s.amount,
      });
      const d = ctx.drafts[ctx.drafts.length - 1];
      stampLinesHash(db, s.key, Number(d.id), s.lines, { runId: ctx.runId, reason: 'ساخت پیش‌نویس P3' });
      out.created.push({ key: s.key, draft_id: Number(d.id), amount_rial: s.amount });
    }
  };
  if (db.inTransaction) run(); else db.transaction(run)();
  return out;
}

/** مهاجرت بوت (فقط مرکز). نشانگر settings فقط وقتی '1' می‌شود که همهٔ پیش‌نویس‌ها ساخته/موجود باشند. */
function runP3DraftMigration(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'journal_entries') || !tableExists(db, 'inventory_ledger')) {
    return { skipped: 'schema' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY);
  if (flag && flag.value === '1') return { skipped: 'done' };
  if (!jeHeader(db, JE1016.id)) return { skipped: 'no_source_facts' };
  let res;
  db.transaction(() => {
    res = createP3Drafts(db, opts);
    const value = res.skipped.length
      ? 'pending:' + res.skipped.map((s) => s.key).sort().join(',')
      : '1';
    res.changed = !flag || flag.value !== value;
    if (res.changed) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SETTINGS_KEY, value);
  })();
  return res;
}

// ── v2: 1104 → برگ موجودی + منسوخ‌کردن پیش‌نویس JE1016 ───────────

const V2_REWRITE_KEYS = ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977'];

function normLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => [String(l.code || ''), Math.round(n(l.debit)), Math.round(n(l.credit))]);
}
function sameLines(a, b) {
  const x = normLines(a);
  const y = normLines(b);
  return x.length === y.length && x.every((r, i) => r[0] === y[i][0] && r[1] === y[i][1] && r[2] === y[i][2]);
}

/** همهٔ شکل‌های شناخته‌شدهٔ سطرهای یک کلید P3 روی 1104 و برگ قدیمی 110401. */
function knownSpecVariants(key) {
  return [ACC_INV, LEGACY_LEAF].flatMap((c) => specVariants(key, c) || []).filter(Boolean);
}

/** سطرها دقیقاً (با هش کانونی، شامل person_id) یکی از شکل‌های شناخته‌شده‌اند؟ */
function matchesKnownSpec(key, lines) {
  const h = canonicalLinesHash(lines);
  return knownSpecVariants(key).some((s) => canonicalLinesHash(s) === h);
}

/** مهر هش فقط وقتی هشی نیست و سطرها دقیقاً شکل شناخته‌شده‌اند. */
function stampIfSpec(db, key, draftId, lines, runId) {
  if (storedLinesHash(db, key) || !matchesKnownSpec(key, lines)) return null;
  return stampLinesHash(db, key, draftId, lines, { runId, reason: 'مهر هش سطرهای شناخته‌شدهٔ P3' });
}

function markerDraftId(db, key) {
  const m = draftMarker(db, key);
  const id = m ? Number(m.new_value) : 0;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** پیش‌نویسی با همین برچسب P3 قبلاً به سند تبدیل شده؟ (ثبت پیش‌نویس، ردیف را حذف و توضیح را نگه می‌دارد.) */
function postedAsJournal(db, key) {
  return !!db.prepare('SELECT 1 FROM journal_entries WHERE description LIKE ? LIMIT 1').get(`%${tag(key)}%`);
}

function logV2(db, runId, key, col, oldValue, newValue, reason) {
  db.prepare(`
    INSERT INTO wh_data_corrections (run_id, phase, rule, tbl, row_key, col, old_value, new_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(runId, PHASE, RULE_V2, 'voucher_drafts', key, col, oldValue, newValue, reason);
}

/**
 * مهاجرت بوت (فقط مرکز، یک تراکنش، idempotent با نشانگر settings).
 * - سه پیش‌نویس P3 (undoc/JE490/ledger1977): اگر ردیف هنوز هست، ثبت نشده، برچسب [p3:key] دارد و
 *   سطرهایش دقیقاً همان سطرهای اصلی v1 روی 1104 است → حساب 1104 به برگ موجودی بازنویسی + version+1.
 * - پیش‌نویس JE1016: حذف نمی‌شود؛ پیشوند «⛔ منسوخ …» به توضیح افزوده می‌شود (ثبتش در مسیر post مسدود است).
 * هیچ پیش‌نویس دیگری لمس نمی‌شود. بدون ردیف P3 → بدون نشانگر (دوباره بررسی در بوت بعد).
 * (production v2 را با هدف 110401 اجرا کرده است؛ v3 آن را به 1104 برمی‌گرداند.)
 */
function runP3DraftsV2Migration(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'wh_data_corrections') || !tableExists(db, 'chart_of_accounts')) {
    return { skipped: 'schema' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY_V2);
  if (flag && flag.value === '1') return { skipped: 'done' };
  if (!db.prepare('SELECT 1 FROM wh_data_corrections WHERE rule=? LIMIT 1').get(RULE)) return { skipped: 'no_p3_drafts' };
  // FR-P3: هدف فعلی 1104 است ⇒ بدون opts.leafCode بازنویسی نمی‌شود (already_leaf)؛ فقط منسوخ‌کردن JE1016.
  // opts.leafCode فقط برای بازسازی تاریخچهٔ production (1104→110401) در تست.
  const leaf = opts.leafCode ? { code: String(opts.leafCode) } : resolveInventoryLeaf(db);
  const hasVersion = colSet(db, 'voucher_drafts').has('version');
  const bump = hasVersion ? ', version=COALESCE(version,0)+1' : '';
  const runId = opts.runId || `p3v2-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const res = { leaf: leaf.code, rewritten: [], superseded: [], skipped: [] };
  db.transaction(() => {
    for (const key of V2_REWRITE_KEYS) {
      const id = markerDraftId(db, key);
      if (!id) { res.skipped.push({ key, why: 'no_marker' }); continue; }
      const d = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(id);
      if (!d) { res.skipped.push({ key, draft_id: id, why: postedAsJournal(db, key) ? 'posted' : 'missing' }); continue; }
      if (!String(d.description || '').includes(tag(key))) { res.skipped.push({ key, draft_id: id, why: 'tag_mismatch' }); continue; }
      if (postedAsJournal(db, key)) { res.skipped.push({ key, draft_id: id, why: 'posted' }); continue; }
      let lines;
      try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = null; }
      if (specVariants(key, leaf.code).some((s) => sameLines(lines, s))) {
        stampIfSpec(db, key, id, lines, runId);
        res.skipped.push({ key, draft_id: id, why: 'already_leaf' });
        continue;
      }
      if (!specVariants(key, ACC_INV).some((s) => sameLines(lines, s))) { res.skipped.push({ key, draft_id: id, why: 'lines_changed' }); continue; }
      const next = lines.map((l) => (String(l.code) === ACC_INV ? { ...l, code: leaf.code } : l));
      const nextJson = JSON.stringify(next);
      db.prepare(`UPDATE voucher_drafts SET lines_json=?${bump} WHERE id=?`).run(nextJson, id);
      logV2(db, runId, key, 'lines_json', d.lines_json, nextJson, `P3-fix: ${ACC_INV} → ${leaf.code}`);
      stampLinesHash(db, key, id, next, { runId, reason: `P3-fix v2: ${ACC_INV} → ${leaf.code}` });
      res.rewritten.push({ key, draft_id: id, from: ACC_INV, to: leaf.code });
    }
    const jid = markerDraftId(db, JE1016_DRAFT_KEY);
    const jd = jid ? db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(jid) : null;
    if (!jd) {
      res.skipped.push({ key: JE1016_DRAFT_KEY, draft_id: jid, why: jid ? 'missing' : 'no_marker' });
    } else if (String(jd.description || '').startsWith(SUPERSEDED_PREFIX)) {
      res.skipped.push({ key: JE1016_DRAFT_KEY, draft_id: jid, why: 'already_superseded' });
    } else {
      const desc = `${SUPERSEDED_PREFIX} — ${jd.description || ''}`;
      db.prepare(`UPDATE voucher_drafts SET description=?${bump} WHERE id=?`).run(desc, jid);
      logV2(db, runId, JE1016_DRAFT_KEY, 'description', jd.description, desc, 'P3-fix: superseded by official subledger-recon fix #1 reverse');
      res.superseded.push({ key: JE1016_DRAFT_KEY, draft_id: jid });
    }
    res.changed = true;
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SETTINGS_KEY_V2, '1');
  })();
  return res;
}

/** پیش‌نویس دستی برگشت JE1016 (منسوخ) — ثبتش مجاز نیست. */
function isSupersededP3Draft(db, draftId) {
  const id = Number(draftId);
  if (!Number.isFinite(id) || id <= 0 || !tableExists(db, 'wh_data_corrections')) return false;
  return !!db.prepare(`
    SELECT 1 FROM wh_data_corrections
    WHERE rule=? AND row_key=? AND col='id' AND CAST(new_value AS INTEGER)=? LIMIT 1
  `).get(RULE, JE1016_DRAFT_KEY, id);
}

/** کلید P3 پیش‌نویس (marker rule=p3_draft + برچسب [p3:key] در شرح)؛ JE1016 منسوخ ⇒ null. */
function p3DraftKeyFor(db, draft) {
  const d = draft && typeof draft === 'object' ? draft
    : (tableExists(db, 'voucher_drafts') ? db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(Number(draft)) : null);
  if (!d || !tableExists(db, 'wh_data_corrections')) return null;
  const rows = db.prepare(`
    SELECT row_key FROM wh_data_corrections WHERE rule=? AND col='id' AND CAST(new_value AS INTEGER)=?
  `).all(RULE, Number(d.id));
  for (const r of rows) {
    const key = String(r.row_key || '');
    if (!key || key === JE1016_DRAFT_KEY) continue;
    if (String(d.description || '').includes(tag(key))) return key;
  }
  return null;
}

function parseDraftLines(d) {
  try { const v = JSON.parse((d && d.lines_json) || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

/**
 * وضعیت معافیت P3 برای سطرهای داده‌شده (پیش‌فرض: سطرهای فعلی پیش‌نویس).
 * معافیت فقط وقتی برقرار است که کلید P3 معتبر باشد و هش سطرها = هش مهرشده.
 */
function p3ExemptionStatus(db, draft, lines) {
  const d = draft && typeof draft === 'object' ? draft
    : (tableExists(db, 'voucher_drafts') ? db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(Number(draft)) : null);
  const key = d ? p3DraftKeyFor(db, d) : null;
  if (!key) return { key: null, stored: null, current: null, exempt: false };
  const stored = storedLinesHash(db, key);
  const current = canonicalLinesHash(Array.isArray(lines) ? lines : parseDraftLines(d));
  return { key, stored, current, exempt: !!stored && stored === current };
}

/** گزینهٔ ثبت برای مسیر «ثبت پیش‌نویس»: فقط پیش‌نویس P3 با سطرهای دست‌نخورده (هش برابر) معافیت 1104 می‌گیرد. */
function p3PostingOptionsForDraft(db, draft) {
  return p3ExemptionStatus(db, draft).exempt ? P3_POSTING_OPTIONS : null;
}

/** همان گزینه برای سطرهای جدید (ویرایش PUT) — معافیت فقط اگر سطرهای جدید همان سطرهای مهرشده باشند. */
function p3PostingOptionsForLines(db, draft, lines) {
  return p3ExemptionStatus(db, draft, lines).exempt ? P3_POSTING_OPTIONS : null;
}

/**
 * بررسی «قابل ثبت بودن» پیش‌نویس با همان توابع مسیر POST /vouchers/drafts/:id/post
 * (validateAndBuildVoucherLines + گارد برگ postToLedger) — بدون هیچ نوشتن.
 */
function checkDraftPostable(db, draftId) {
  const d = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(Number(draftId));
  if (!d) return { ok: false, code: 'E_NOT_FOUND', error: 'پیش‌نویس یافت نشد' };
  if (isSupersededP3Draft(db, d.id)) return { ok: false, code: 'E_P3_DRAFT_SUPERSEDED', error: 'منسوخ' };
  const { validateAndBuildVoucherLines } = require('../../routes/accounting');
  const opts = p3PostingOptionsForDraft(db, d) || {};
  let lines;
  try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = []; }
  const built = validateAndBuildVoucherLines(db, lines, opts);
  if (built.error) return { ok: false, code: built.code || null, error: built.error, p3_key: p3DraftKeyFor(db, d) };
  try {
    require('../coa-leaf-policy').assertLinesPostable(db, built.cleanLines, { sourceType: 'manual_voucher', ...opts });
  } catch (e) {
    return { ok: false, code: e.code || null, error: e.message, p3_key: p3DraftKeyFor(db, d) };
  }
  return { ok: true, p3_key: p3DraftKeyFor(db, d) };
}

// ── v3 (FR-P3): 110401 → 1104 + پیش‌نویس افتتاحیهٔ ledger#2021–2023 ─────

const V3_REWRITE_KEYS = ['undoc_adjust_146335856', 'opening_je490_offset', 'opening_ledger1977'];

function logV3(db, runId, key, col, oldValue, newValue, reason) {
  db.prepare(`
    INSERT INTO wh_data_corrections (run_id, phase, rule, tbl, row_key, col, old_value, new_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(runId, PHASE, RULE_V3, 'voucher_drafts', key, col, oldValue, newValue, reason);
}

/**
 * مهاجرت بوت FR-P3 (فقط مرکز، یک تراکنش، idempotent، نشانگر settings `p3_recon_drafts_v3`).
 * - پیش‌نویس‌های undoc/JE490/ledger1977: اگر ردیف هست، برچسب [p3:key] دارد، به سند تبدیل نشده و
 *   سطرهایش دقیقاً سطرهای اصلی روی 110401 است ⇒ 110401→1104 + version+1 + لاگ rule=p3_draft_v3.
 *   روی 1104 ⇒ already_1104؛ هر تفاوت دیگر ⇒ lines_changed (دست‌نخورده).
 * - پیش‌نویس افتتاحیهٔ ledger#2021–2023 اگر نیست ساخته می‌شود (همان مسیر v1؛ marker rule=p3_draft).
 * - پیش‌نویس JE1016 (منسوخ) و هر پیش‌نویس دیگری لمس نمی‌شود؛ هیچ post / DELETE.
 * نشانگر '1' فقط وقتی پیش‌نویس جدید ساخته/موجود باشد؛ وگرنه 'pending:<key>' (بوت بعد دوباره).
 */
function runP3DraftsV3Migration(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'wh_data_corrections') || !tableExists(db, 'chart_of_accounts')
    || !tableExists(db, 'journal_entries') || !tableExists(db, 'inventory_ledger')) {
    return { skipped: 'schema' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY_V3);
  if (flag && flag.value === '1') return { skipped: 'done' };
  if (!db.prepare('SELECT 1 FROM wh_data_corrections WHERE rule=? LIMIT 1').get(RULE)) return { skipped: 'no_p3_drafts' };
  const hasVersion = colSet(db, 'voucher_drafts').has('version');
  const bump = hasVersion ? ', version=COALESCE(version,0)+1' : '';
  const runId = opts.runId || `p3v3-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const res = { target: ACC_INV, rewritten: [], skipped: [], created: [], already: [], pending: [] };
  db.transaction(() => {
    for (const key of V3_REWRITE_KEYS) {
      const id = markerDraftId(db, key);
      if (!id) { res.skipped.push({ key, why: 'no_marker' }); continue; }
      const d = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(id);
      if (!d) { res.skipped.push({ key, draft_id: id, why: postedAsJournal(db, key) ? 'posted' : 'missing' }); continue; }
      if (!String(d.description || '').includes(tag(key))) { res.skipped.push({ key, draft_id: id, why: 'tag_mismatch' }); continue; }
      if (postedAsJournal(db, key)) { res.skipped.push({ key, draft_id: id, why: 'posted' }); continue; }
      let lines;
      try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = null; }
      if (specVariants(key, ACC_INV).some((s) => sameLines(lines, s))) {
        stampIfSpec(db, key, id, lines, runId);
        res.skipped.push({ key, draft_id: id, why: 'already_1104' });
        continue;
      }
      if (!specVariants(key, LEGACY_LEAF).some((s) => sameLines(lines, s))) { res.skipped.push({ key, draft_id: id, why: 'lines_changed' }); continue; }
      const next = lines.map((l) => (String(l.code) === LEGACY_LEAF ? { ...l, code: ACC_INV } : l));
      const nextJson = JSON.stringify(next);
      db.prepare(`UPDATE voucher_drafts SET lines_json=?${bump} WHERE id=?`).run(nextJson, id);
      logV3(db, runId, key, 'lines_json', d.lines_json, nextJson, `FR-P3: ${LEGACY_LEAF} → ${ACC_INV} (تصمیم حامد)`);
      stampLinesHash(db, key, id, next, { runId, reason: `FR-P3 v3: ${LEGACY_LEAF} → ${ACC_INV}` });
      res.rewritten.push({ key, draft_id: id, from: LEGACY_LEAF, to: ACC_INV });
    }
    const made = createP3Drafts(db, { ...opts, onlyKeys: [OPENINGS_2021_2023_KEY] });
    res.created = made.created;
    res.already = made.already;
    res.pending = made.skipped;
    res.warnings = made.warnings;
    const value = made.skipped.length ? 'pending:' + made.skipped.map((s) => s.key).sort().join(',') : '1';
    res.changed = !flag || flag.value !== value || res.rewritten.length > 0;
    if (!flag || flag.value !== value) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SETTINGS_KEY_V3, value);
  })();
  return res;
}

// ── v4 (FR-P334-B): حذف سطر ledger#1273 از پیش‌نویس #2 ──────────

const SETTINGS_KEY_V4 = 'p3_recon_drafts_v4';
const RULE_V4 = 'p3_draft_v4';
const V4_ROW_KEY = 'undoc_adjust_drop_1273';
const V4_INV_CODES = [ACC_INV, LEGACY_LEAF];

function stripLedger1273(desc) {
  return String(desc || '')
    .replace(/\s*[،,]\s*ledger#1273(?:\s*\([^)]*\))?/g, '')
    .replace(/ledger#1273(?:\s*\([^)]*\))?\s*/g, '');
}

function logV4(db, runId, col, oldValue, newValue, reason) {
  db.prepare(`
    INSERT INTO wh_data_corrections (run_id, phase, rule, tbl, row_key, col, old_value, new_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(runId, PHASE, RULE_V4, 'voucher_drafts', V4_ROW_KEY, col, oldValue, newValue, reason);
}

/**
 * مهاجرت بوت FR-P334-B (فقط مرکز، یک تراکنش، نشانگر settings `p3_recon_drafts_v4`؛ بعد از v3).
 * پیش‌نویس #2 (marker p3_draft/undoc_adjust_146335856 + برچسب) اگر ثبت نشده و سطرهایش دقیقاً همان
 * چهار سطر قدیمی است (موجودی روی 1104 یا 110401 = 146,335,856؛ سطر ledger#1273 = 66,679,942) ⇒
 * سطر 1273 حذف، بستانکار موجودی 79,655,914، ذکر ledger#1273 از شرح حذف (برچسب می‌ماند)، version+1،
 * لاگ rule=p3_draft_v4 / row_key=undoc_adjust_drop_1273 (قبل/بعد). فقط voucher_drafts + wh_data_corrections.
 * حالت سه‌سطری 79,655,914 ⇒ فقط نشانگر. هر عدم‌انطباق/ثبت‌شده ⇒ بدون نوشتن و بدون نشانگر (هشدار).
 */
function runP3DraftsV4Migration(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'wh_data_corrections') || !tableExists(db, 'journal_entries')) {
    return { skipped: 'schema' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY_V4);
  if (flag && flag.value === '1') return { skipped: 'done' };
  const runId = opts.runId || `p3v4-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const res = { key: UNDOC_KEY, draft_id: null, state: null, why: null, changed: false };
  const skip = (why, extra, quiet) => {
    Object.assign(res, { state: 'skipped', why }, extra || {});
    if (!quiet && !opts.silent) console.warn(`p3_recon_drafts_v4: پیش‌نویس #2 دست‌نخورده — ${why}`);
  };
  const mark = () => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SETTINGS_KEY_V4, '1');
  db.transaction(() => {
    const id = markerDraftId(db, UNDOC_KEY);
    if (!id) { skip('no_marker', null, true); return; }
    res.draft_id = id;
    const d = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(id);
    if (!d) { skip(postedAsJournal(db, UNDOC_KEY) ? 'posted' : 'missing'); return; }
    if (!String(d.description || '').includes(tag(UNDOC_KEY))) { skip('tag_mismatch'); return; }
    if (postedAsJournal(db, UNDOC_KEY)) { skip('posted'); return; }
    let lines;
    try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = null; }
    if (V4_INV_CODES.some((c) => sameLines(lines, specLines(UNDOC_KEY, c)))) {
      stampIfSpec(db, UNDOC_KEY, id, lines, runId);
      res.state = 'already_trimmed';
      mark();
      return;
    }
    const inv = V4_INV_CODES.find((c) => sameLines(lines, legacyUndocLines(c)));
    const idx = Array.isArray(lines) ? lines.findIndex((l) => String(l.code) === ACC_SHORTAGE
      && Math.round(n(l.debit)) === LEDGER1273.amount && String(l.description || '').includes(`ledger#${LEDGER1273.id}`)) : -1;
    if (!inv || idx !== 2) { skip('lines_mismatch', { lines_seen: normLines(lines) }); return; }
    const target = specLines(UNDOC_KEY, inv);
    const next = lines.filter((_, i) => i !== idx)
      .map((l) => (String(l.code) === inv ? { ...l, credit: UNDOC_TOTAL, description: target[target.length - 1].description } : l));
    const bal = next.reduce((t, l) => t + Math.round(n(l.debit)) - Math.round(n(l.credit)), 0);
    if (!sameLines(next, target) || bal !== 0) { skip('trim_unbalanced'); return; }
    const nextDesc = stripLedger1273(d.description);
    if (!nextDesc.includes(tag(UNDOC_KEY)) || nextDesc.includes(`ledger#${LEDGER1273.id}`)) { skip('description_unparseable'); return; }
    const nextJson = JSON.stringify(next);
    const bump = colSet(db, 'voucher_drafts').has('version') ? ', version=COALESCE(version,0)+1' : '';
    db.prepare(`UPDATE voucher_drafts SET lines_json=?, description=?${bump} WHERE id=?`).run(nextJson, nextDesc, id);
    const why = `FR-P334-B: حذف ledger#1273 (${LEDGER1273.amount}) از پیش‌نویس #${id}؛ موجودی ${inv} ${UNDOC_LEGACY_TOTAL} → ${UNDOC_TOTAL} (برگشت رسمی کاردکس FR-P334-A، تصمیم حامد)`;
    logV4(db, runId, 'lines_json', d.lines_json, nextJson, why);
    logV4(db, runId, 'description', d.description, nextDesc, why);
    stampLinesHash(db, UNDOC_KEY, id, next, { runId, reason: 'FR-P334-B v4: حذف ledger#1273' });
    mark();
    Object.assign(res, {
      state: 'trimmed', changed: true, inventory_code: inv,
      before: { lines: lines.length, credit_rial: UNDOC_LEGACY_TOTAL },
      after: { lines: next.length, credit_rial: UNDOC_TOTAL },
    });
  })();
  return res;
}

// ── backfill هش سطرها (FR-POS-DRAFTS-A) ─────────────────────────

/**
 * مهاجرت بوت (فقط مرکز، یک تراکنش، نشانگر settings `p3_recon_drafts_lines_hash_v1`؛ بعد از v4).
 * برای هر پیش‌نویس P3 موجود (marker + برچسب، غیر از JE1016 منسوخ) که هش ندارد: اگر سطرهای فعلی دقیقاً
 * یکی از شکل‌های شناخته‌شده (specVariants روی 1104/110401) باشد ⇒ هش مهر می‌شود؛ وگرنه مهر نمی‌شود
 * (معافیت 1104 از دست می‌رود) و هشدار چاپ می‌شود. بدون پیش‌نویس P3 ⇒ بدون نشانگر.
 */
function runP3DraftsLinesHashBackfill(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'wh_data_corrections')) return { skipped: 'schema' };
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY_HASH);
  if (flag && flag.value === '1') return { skipped: 'done' };
  const keys = db.prepare("SELECT DISTINCT row_key FROM wh_data_corrections WHERE rule=? AND col='id'").all(RULE)
    .map((r) => String(r.row_key || '')).filter((k) => k && k !== JE1016_DRAFT_KEY);
  if (!keys.length) return { skipped: 'no_p3_drafts' };
  const runId = opts.runId || `p3hash-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const res = { stamped: [], already: [], unmatched: [], skipped: [], changed: false };
  db.transaction(() => {
    for (const key of keys) {
      const id = markerDraftId(db, key);
      const d = id ? db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(id) : null;
      if (!d) { res.skipped.push({ key, draft_id: id, why: 'missing' }); continue; }
      if (!String(d.description || '').includes(tag(key))) { res.skipped.push({ key, draft_id: id, why: 'tag_mismatch' }); continue; }
      if (storedLinesHash(db, key)) { res.already.push({ key, draft_id: id }); continue; }
      const lines = parseDraftLines(d);
      if (!matchesKnownSpec(key, lines)) {
        res.unmatched.push({ key, draft_id: id });
        if (!opts.silent) console.warn(`p3_recon_drafts_lines_hash_v1: سطرهای پیش‌نویس #${id} (${key}) با شکل شناخته‌شده منطبق نیست — هش مهر نشد و معافیت 1104 برقرار نیست`);
        continue;
      }
      stampLinesHash(db, key, id, lines, { runId, reason: 'backfill هش سطرهای P3' });
      res.stamped.push({ key, draft_id: id });
    }
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SETTINGS_KEY_HASH, '1');
    res.changed = res.stamped.length > 0 || !flag;
  })();
  return res;
}

module.exports = {
  buildPlan,
  buildP3Report,
  createP3Drafts,
  runP3DraftMigration,
  runP3DraftsV2Migration,
  runP3DraftsV3Migration,
  runP3DraftsV4Migration,
  isSupersededP3Draft,
  p3DraftKeyFor,
  p3PostingOptionsForDraft,
  p3PostingOptionsForLines,
  p3ExemptionStatus,
  canonicalLinesHash,
  storedLinesHash,
  stampLinesHash,
  matchesKnownSpec,
  runP3DraftsLinesHashBackfill,
  RULE_HASH,
  SETTINGS_KEY_HASH,
  checkDraftPostable,
  resolveInventoryLeaf,
  inventorySubtreeCodes,
  glInventorySubtreeRial,
  kardexValueRial,
  inventoryGapSnapshot,
  computeZeroInboundCogsShare,
  gl1104ApprovedRial,
  specLines,
  legacyUndocLines,
  legacyUndocDescription,
  SETTINGS_KEY,
  SETTINGS_KEY_V2,
  SETTINGS_KEY_V3,
  SETTINGS_KEY_V4,
  RULE_V3,
  RULE_V4,
  V4_ROW_KEY,
  UNDOC_KEY,
  UNDOC_TOTAL,
  UNDOC_LEGACY_TOTAL,
  LEDGER1273,
  OFFICIAL_KARDEX_REVERSAL_LEDGER_IDS,
  OPENINGS_2021_2023_KEY,
  OPENINGS_2021_2023,
  OPENINGS_2021_2023_TOTAL,
  EXCLUDED_LEDGER_IDS,
  P3_POSTING_OPTIONS,
  SUPERSEDED_PREFIX,
  OFFICIAL_REVERSE_PATH,
  JE1016_DRAFT_KEY,
  KARDEX_WAREHOUSES,
  RULE,
};
