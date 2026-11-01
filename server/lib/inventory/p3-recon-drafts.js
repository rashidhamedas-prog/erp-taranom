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
 * هیچ DELETE و هیچ UPDATE روی ردیف موجود انجام نمی‌شود.
 */

const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

const RULE = 'p3_draft';
const PHASE = 'P3';
const SETTINGS_KEY = 'p3_recon_drafts_v1';

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

function buildPlan(db) {
  const prefix = 'پیش‌نویس P3 — منتظر تأیید حامد —';
  const specs = [];
  specs.push({
    key: 'je1016_reverse',
    amount: JE1016.amount,
    guard: guardJe1016(db),
    guard_text: 'JE 1016 با ref_type=inventory_recon_adjust، Dr 3102/Cr 1104 = 1,796,860,352، زنده و برگشت‌نشده',
    description: `${prefix} برگشت JE #1016 (inventory_recon_adjust، ۱۴۰۵/۰۸/۰۴، Dr 3102 / Cr 1104) ${tag('je1016_reverse')}`,
    lines: [
      { code: ACC_INV, debit: JE1016.amount, credit: 0, description: 'برگشت JE #1016 — موجودی کالا' },
      { code: ACC_OPENING, debit: 0, credit: JE1016.amount, description: 'برگشت JE #1016 — تراز افتتاحیه' },
    ],
  });
  specs.push({
    key: 'undoc_adjust_146335856',
    amount: UNDOC_TOTAL,
    guard: guardUndocRows(db),
    guard_text: 'ردیف‌های کاردکس 1978 (کالا 115، wh34، 66,742,000)، 1979 (کالا 131، wh35، 12,913,914)، 1273 (کالا 334، wh34، 66,679,942) زنده و je_id IS NULL، بدون سند تعدیل زنده',
    description: `${prefix} تعدیل بی‌سند کاردکس ledger#1978، ledger#1979، ledger#1273 (کالای 334: بررسی WIP) ${tag('undoc_adjust_146335856')}`,
    lines: [
      ...UNDOC_ROWS.map((r) => ({
        code: ACC_SHORTAGE, debit: r.amount, credit: 0,
        description: `تعدیل بی‌سند ledger#${r.id} کالا ${r.product_id}${r.wip_review ? ' — «بررسی WIP»' : ''}`,
      })),
      { code: ACC_INV, debit: 0, credit: UNDOC_TOTAL, description: 'موجودی کالا — ledger#1978/1979/1273' },
    ],
  });
  specs.push({
    key: 'opening_je490_offset',
    amount: JE490.amount,
    guard: guardJe490(db),
    guard_text: 'JE 490 (opening_inventory) زنده با Dr 1104/Cr 3102 = 71,232,000 و ردیف کاردکس 1230 (کالا 335) با je_id=490',
    description: `${prefix} بازگردانی افتتاحیهٔ خنثی‌شدهٔ JE #490 / ledger#1230 (کالای 335) ${tag('opening_je490_offset')}`,
    lines: [
      { code: ACC_INV, debit: JE490.amount, credit: 0, description: 'افتتاحیه JE #490 / ledger#1230' },
      { code: ACC_OPENING, debit: 0, credit: JE490.amount, description: 'تراز افتتاحیه — JE #490' },
    ],
  });
  specs.push({
    key: 'opening_ledger1977',
    amount: LEDGER1977.amount,
    guard: guardLedger1977(db),
    guard_text: 'ردیف کاردکس 1977 (افتتاحیه، کالا 109، wh35، 10,759,000) زنده با je_id IS NULL و هیچ سطر زندهٔ 3201 با همین مبلغ',
    description: `${prefix} افتتاحیهٔ بی‌سند ledger#1977 (کالای 109، انبار 35) ${tag('opening_ledger1977')}`,
    lines: [
      { code: ACC_INV, debit: LEDGER1977.amount, credit: 0, description: 'افتتاحیه ledger#1977' },
      { code: ACC_OPENING, debit: 0, credit: LEDGER1977.amount, description: 'تراز افتتاحیه — ledger#1977' },
    ],
  });
  for (const s of specs) {
    const mark = draftMarker(db, s.key);
    s.already = mark ? { draft_id: Number(mark.new_value) || null } : null;
    s.accounts = [...new Set(s.lines.map((l) => l.code))].map((c) => accountState(db, c));
    s.effect_1104_rial = s.lines.reduce((t, l) => t + (l.code === ACC_INV ? n(l.debit) - n(l.credit) : 0), 0);
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

function gl1104ApprovedRial(db) {
  if (!tableExists(db, 'journal_lines')) return 0;
  return Math.round(n(db.prepare(`
    SELECT COALESCE(SUM(${SQL_DR}) - SUM(${SQL_CR}),0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${jeLiveWhere(db, 'je')} AND jl.account_code=?
  `).get(ACC_INV).v));
}

/** گزارش readonly: برنامهٔ پیش‌نویس‌ها + اثر فرضی روی 1104 + سهم COGS. */
function buildP3Report(db) {
  const plan = buildPlan(db);
  const gl = gl1104ApprovedRial(db);
  const eligible = plan.filter((s) => s.guard.ok || s.already);
  const effect = eligible.reduce((t, s) => t + s.effect_1104_rial, 0);
  return {
    gl_1104_live_rial: gl,
    gl_1104_if_all_drafts_posted_rial: gl + effect,
    drafts_effect_1104_rial: effect,
    plan: plan.map((s) => ({
      key: s.key, amount_rial: s.amount, description: s.description, lines: s.lines,
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

module.exports = {
  buildPlan,
  buildP3Report,
  createP3Drafts,
  runP3DraftMigration,
  computeZeroInboundCogsShare,
  gl1104ApprovedRial,
  SETTINGS_KEY,
  RULE,
};
