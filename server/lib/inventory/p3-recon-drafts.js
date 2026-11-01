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
 * P3-fix (تصمیم حامد): سطرهای پیش‌نویس روی حساب برگ موجودی (110401، فرزند 1104) می‌نشینند؛
 * کنترل اختلاف روی جمع 1104 و همهٔ زیرحساب‌هایش. برگشت JE1016 فقط از مسیر رسمی
 * subledger-recon fix #1 — پیش‌نویس دستی آن دیگر ساخته نمی‌شود و ثبتش مسدود است.
 */

const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

const RULE = 'p3_draft';
const PHASE = 'P3';
const SETTINGS_KEY = 'p3_recon_drafts_v1';
const SETTINGS_KEY_V2 = 'p3_recon_drafts_v2';
const LEAF_SETTING_KEY = 'p3_inventory_leaf_code';
const RULE_V2 = 'p3_draft_v2';
const JE1016_DRAFT_KEY = 'je1016_reverse';
const SUPERSEDED_PREFIX = '⛔ منسوخ — برگشت JE1016 فقط از مسیر رسمی subledger-recon fix #1';
const OFFICIAL_REVERSE_PATH = 'POST /api/accounting/subledger-recon/fixes/1/reverse';
const KARDEX_WAREHOUSES = [34, 35];

const ACC_INV = '1104';
const ACC_OPENING = '3102';
const ACC_FY_OPENING = '3201';
const ACC_SHORTAGE = '610801';
const ACC_COGS = '5101';

const JE1016 = { id: 1016, ref_type: 'inventory_recon_adjust', amount: 1796860352 };
const UNDOC_ROWS = [
  { id: 1978, product_id: 115, warehouse_id: 34, amount: 66742000 },
  { id: 1979, product_id: 131, warehouse_id: 35, amount: 12913914 },
  { id: 1273, product_id: 334, warehouse_id: 34, amount: 66679942, wip_review: true },
];
const UNDOC_TOTAL = 146335856;
const JE490 = { id: 490, ref_type: 'opening_inventory', amount: 71232000, ledger_id: 1230, product_id: 335, warehouse_id: 34 };
const LEDGER1977 = { id: 1977, product_id: 109, warehouse_id: 35, amount: 10759000 };
const COGS_TARGET_WH = 35;

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

function jeLiveWhere(db, alias) {
  const cols = colSet(db, 'journal_entries');
  const w = [`COALESCE(${alias}.status,'approved') NOT IN ('reversed','void')`];
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
  if (['reversed', 'void'].includes(String(je.status || ''))) return false;
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
 * حساب برگ موجودی برای سطرهای پیش‌نویس: تنها فرزند فعال و قابل‌ثبت 1104 ← کلید settings
 * `p3_inventory_leaf_code` (باید زیرشاخهٔ 1104 و قابل‌ثبت باشد) ← fail-safe همان 1104 با هشدار.
 */
function resolveInventoryLeaf(db) {
  if (!tableExists(db, 'chart_of_accounts')) {
    return { code: ACC_INV, source: 'fallback', warning: 'جدول سرفصل‌ها نیست؛ 1104 نگه داشته شد' };
  }
  const kids = db.prepare(
    'SELECT code FROM chart_of_accounts WHERE parent_code=? AND COALESCE(is_active,1)=1 ORDER BY code'
  ).all(ACC_INV);
  if (kids.length === 1 && accountState(db, String(kids[0].code)).postable) {
    return { code: String(kids[0].code), source: 'single_child', warning: null };
  }
  let cfg = '';
  try { cfg = String((db.prepare('SELECT value FROM settings WHERE key=?').get(LEAF_SETTING_KEY) || {}).value || '').trim(); }
  catch (_) { cfg = ''; }
  if (cfg && cfg !== ACC_INV && inventorySubtreeCodes(db).has(cfg) && accountState(db, cfg).postable) {
    return { code: cfg, source: 'setting', warning: null };
  }
  return {
    code: ACC_INV,
    source: 'fallback',
    warning: `حساب برگ یکتای زیر ${ACC_INV} پیدا نشد (فرزندان فعال: ${kids.length})؛ ${ACC_INV} نگه داشته شد — ${LEAF_SETTING_KEY} را تنظیم کنید`,
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

// ── plan ─────────────────────────────────────────────────────────

function tag(key) { return `[p3:${key}]`; }

/** سطرهای اصلی پیش‌نویس‌های P3 با حساب موجودی داده‌شده (v1 روی 1104 ساخته شد). */
function specLines(key, inv) {
  switch (key) {
    case JE1016_DRAFT_KEY:
      return [
        { code: inv, debit: JE1016.amount, credit: 0, description: 'برگشت JE #1016 — موجودی کالا' },
        { code: ACC_OPENING, debit: 0, credit: JE1016.amount, description: 'برگشت JE #1016 — تراز افتتاحیه' },
      ];
    case 'undoc_adjust_146335856':
      return [
        ...UNDOC_ROWS.map((r) => ({
          code: ACC_SHORTAGE, debit: r.amount, credit: 0,
          description: `تعدیل بی‌سند ledger#${r.id} کالا ${r.product_id}${r.wip_review ? ' — «بررسی WIP»' : ''}`,
        })),
        { code: inv, debit: 0, credit: UNDOC_TOTAL, description: 'موجودی کالا — ledger#1978/1979/1273' },
      ];
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
    default:
      return null;
  }
}

function buildPlan(db) {
  const prefix = 'پیش‌نویس P3 — منتظر تأیید حامد —';
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
    key: 'undoc_adjust_146335856',
    amount: UNDOC_TOTAL,
    guard: guardUndocRows(db),
    guard_text: 'ردیف‌های کاردکس 1978 (کالا 115، wh34، 66,742,000)، 1979 (کالا 131، wh35، 12,913,914)، 1273 (کالا 334، wh34، 66,679,942) زنده و je_id IS NULL، بدون سند تعدیل زنده',
    description: `${prefix} تعدیل بی‌سند کاردکس ledger#1978، ledger#1979، ledger#1273 (کالای 334: بررسی WIP) ${tag('undoc_adjust_146335856')}`,
    lines: specLines('undoc_adjust_146335856', inv),
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
  };
}

function wrapValidate(warnings, key) {
  const { validateAndBuildVoucherLines } = require('../../routes/accounting');
  return (db, lines) => {
    const built = validateAndBuildVoucherLines(db, lines);
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
      for (const s of plan) out.skipped.push({ key: s.key, why: e.message });
      return;
    }
    const ctx = {
      db, phase: PHASE, runId: opts.runId || `p3-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      userId: user.id, changes: [], drafts: [],
    };
    const date = opts.date || todayJalali();
    for (const s of plan) {
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
 * هیچ پیش‌نویس دیگری لمس نمی‌شود. بدون برگ یکتا یا بدون ردیف P3 → بدون نشانگر (دوباره بررسی در بوت بعد).
 */
function runP3DraftsV2Migration(db, opts = {}) {
  if (opts.isDevice) return { skipped: 'device' };
  if (!tableExists(db, 'voucher_drafts') || !tableExists(db, 'wh_data_corrections') || !tableExists(db, 'chart_of_accounts')) {
    return { skipped: 'schema' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY_V2);
  if (flag && flag.value === '1') return { skipped: 'done' };
  if (!db.prepare('SELECT 1 FROM wh_data_corrections WHERE rule=? LIMIT 1').get(RULE)) return { skipped: 'no_p3_drafts' };
  const leaf = resolveInventoryLeaf(db);
  if (leaf.code === ACC_INV) return { skipped: 'no_leaf', warning: leaf.warning };
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
      if (sameLines(lines, specLines(key, leaf.code))) { res.skipped.push({ key, draft_id: id, why: 'already_leaf' }); continue; }
      if (!sameLines(lines, specLines(key, ACC_INV))) { res.skipped.push({ key, draft_id: id, why: 'lines_changed' }); continue; }
      const next = lines.map((l) => (String(l.code) === ACC_INV ? { ...l, code: leaf.code } : l));
      const nextJson = JSON.stringify(next);
      db.prepare(`UPDATE voucher_drafts SET lines_json=?${bump} WHERE id=?`).run(nextJson, id);
      logV2(db, runId, key, 'lines_json', d.lines_json, nextJson, `P3-fix: ${ACC_INV} → ${leaf.code}`);
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

module.exports = {
  buildPlan,
  buildP3Report,
  createP3Drafts,
  runP3DraftMigration,
  runP3DraftsV2Migration,
  isSupersededP3Draft,
  resolveInventoryLeaf,
  inventorySubtreeCodes,
  glInventorySubtreeRial,
  kardexValueRial,
  inventoryGapSnapshot,
  computeZeroInboundCogsShare,
  gl1104ApprovedRial,
  specLines,
  SETTINGS_KEY,
  SETTINGS_KEY_V2,
  LEAF_SETTING_KEY,
  SUPERSEDED_PREFIX,
  OFFICIAL_REVERSE_PATH,
  JE1016_DRAFT_KEY,
  KARDEX_WAREHOUSES,
  RULE,
};
