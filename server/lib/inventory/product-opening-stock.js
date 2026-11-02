'use strict';
/**
 * موجودی اول دوره جدا از موجودی کل (product_opening_stock).
 *
 * منبع حقیقت مقدار همچنان کاردکس است؛ این جدول برای هر (سال مالی، کالا، واریانت، انبار) مشخص می‌کند
 * «کدام ردیف کاردکس، افتتاحیه است» + بها/ارزش + سند حسابداری. هیچ‌جا مقادیر جمع زده نمی‌شوند.
 *
 *   migrateProductOpeningStock  → یک‌بار: ردیف‌های افتتاحیهٔ زندهٔ کاردکس → جدول (چندتایی = needs_review)
 *   getProductOpening           → بخش «موجودی اول دوره» کارت کالا
 *   planOpeningChange           → پیش‌نمایش فقط‌خواندنی (create | correct | resolve)
 *   applyOpeningChange          → اجرای اتمیک (یک تراکنش) با علت + confirm:true + audit
 *   listOpeningIssues           → فهرست needs_review / no_je
 *
 * قواعد کاربر (الزامی):
 *   - ابطال ردیف کاردکس فقط با reverseInventoryMovement (بدون حذف/بازنویسی).
 *   - سند حسابداری اختصاصی ردیف ⇒ reverseJournalEntry؛ سند مشترک (ردیف‌های دیگر هم دارد) ⇒ هرگز
 *     برگشت داده نمی‌شود؛ سند خنثی‌ساز رسمی فقط به مبلغ همان ردیف (Dr ۳۱۰۲ / Cr موجودی انبار).
 *     ردیف بدون je_id ⇒ هیچ اقدام دفتری.
 *   - حل تکراری: ردیف‌های تعدیل هم‌ترازی (stock_reconcile / adjustment / qty_out) هم‌جفت هم ابطال
 *     می‌شوند تا مقدار کاردکس تا حد ممکن ثابت بماند (تطبیق حریصانه؛ باقیمانده گزارش می‌شود).
 */
const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

const SOURCE_TYPE = 'product_opening_stock';
const COUNTER_SOURCE = 'product_opening_stock_counter';
const PERM = 'opening_stock';
const REASON_MIN = 5;
const MIGRATE_MARKER = 'product_opening_stock_migrate_v1';
const MIGRATE_ENABLE_KEY = 'product_opening_stock_migrate_enabled';
const EPS = 1e-9;

function posErr(code, status, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  if (extra) Object.assign(e, extra);
  return e;
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const rial = (n) => Math.round(Number(n) || 0);

function hasTable(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch (_) { return false; }
}
function hasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
  catch (_) { return false; }
}
function totalChanges(db) {
  return Number(db.prepare('SELECT total_changes() AS c').get().c) || 0;
}

// ─────────────────────────── schema ───────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS product_opening_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fiscal_year_id INTEGER,
    product_id INTEGER NOT NULL,
    variant_id INTEGER,
    warehouse_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    unit_cost_rial INTEGER DEFAULT 0,
    value_rial INTEGER DEFAULT 0,
    ledger_id INTEGER,
    je_id INTEGER,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_review','no_je','void')),
    source TEXT,
    candidate_ledger_ids TEXT,
    note TEXT,
    reviewed_by INTEGER,
    reviewed_at TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_by INTEGER,
    updated_at TEXT,
    version INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_product_opening_stock_product ON product_opening_stock(product_id);
  CREATE INDEX IF NOT EXISTS idx_product_opening_stock_status ON product_opening_stock(status);
`;
const UNIQUE_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS ux_product_opening_stock
  ON product_opening_stock (COALESCE(fiscal_year_id,0), product_id, COALESCE(variant_id,0), warehouse_id)
  WHERE status<>'void'
`;

/** Idempotent DDL (db.js initDB + migration script on a DB that predates the table). */
function ensureSchema(db) {
  db.exec(SCHEMA_SQL);
  try { db.exec(UNIQUE_SQL); } catch (e) { console.warn('⚠️ ایندکس یکتای موجودی اول دوره ایجاد نشد:', e.message); }
}

// ─────────────────────────── permissions ───────────────────────────

function canDo(user, resource, action, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, resource, action, db);
}
function canEdit(user, db) { return canDo(user, PERM, 'edit', db); }
function canSeeCost(user, db) { return canDo(user, 'cost_visibility', 'view', db); }
/** GET: opening_stock:view یا دسترسی به کالا/انبار (admin/accounting همیشه). */
function canView(user, db) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'accounting') return true;
  return canDo(user, PERM, 'view', db) || canDo(user, 'products', 'view', db)
    || canDo(user, 'acc_warehouse_ops', 'view', db);
}

// ─────────────────────────── fiscal / kardex helpers ───────────────────────────

function fiscalCtx(db) {
  const { fiscalScope } = require('./opening-guard');
  const scope = fiscalScope(db, null);
  let date = '';
  try { date = require('../opening-post').fiscalOpeningDate(db); } catch (_) { date = scope.start || ''; }
  return { fiscalYearId: scope.fiscalYearId, start: scope.start, end: scope.end, date };
}

function ledgerVariantSql(db) { return hasColumn(db, 'inventory_ledger', 'variant_id'); }

/** Live kardex qty/value for one (product, warehouse, variant) combo. */
function kardexCombo(db, productId, warehouseId, variantId) {
  const hasVar = ledgerVariantSql(db);
  const params = [productId, warehouseId];
  let sql = `
    SELECT COALESCE(SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)),0) AS q,
      COALESCE(SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN ROUND(COALESCE(amount_rial,0))
        WHEN COALESCE(qty_out,0)>0 THEN -ROUND(COALESCE(amount_rial,0))
        ELSE ROUND(COALESCE(amount_rial,0)) END),0) AS v
    FROM inventory_ledger WHERE product_id=? AND warehouse_id=? AND (${LEDGER_LIVE_SQL})`;
  if (hasVar) { sql += ' AND COALESCE(variant_id,0)=COALESCE(?,0)'; params.push(variantId || null); }
  const r = db.prepare(sql).get(...params);
  return { qty: round3(r && r.q), value_rial: rial(r && r.v) };
}

/** Live kardex qty for (product, warehouse) across all variants. */
function kardexWarehouse(db, productId, warehouseId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)),0) AS q
    FROM inventory_ledger WHERE product_id=? AND warehouse_id=? AND (${LEDGER_LIVE_SQL})
  `).get(productId, warehouseId);
  return round3(r && r.q);
}

function variantLabel(db, variantId) {
  if (!variantId) return null;
  try {
    const v = db.prepare(`
      SELECT v.sku, c.name AS color_name, z.name AS size_name FROM product_variants v
      LEFT JOIN product_colors c ON c.id=v.color_id LEFT JOIN product_sizes z ON z.id=v.size_id
      WHERE v.id=?
    `).get(variantId);
    if (!v) return `#${variantId}`;
    return [v.color_name, v.size_name].filter(Boolean).join(' / ') || v.sku || `#${variantId}`;
  } catch (_) { return `#${variantId}`; }
}

function warehouseName(db, id) {
  if (!id) return null;
  const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(id);
  return w ? w.name : null;
}

/** Kardex by (warehouse, variant) for a product (live rows; WIP-only events excluded like stockOf). */
function kardexByWarehouse(db, productId) {
  const hasVar = ledgerVariantSql(db);
  const rows = db.prepare(`
    SELECT warehouse_id, ${hasVar ? 'variant_id' : 'NULL AS variant_id'},
      COALESCE(SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)),0) AS q
    FROM inventory_ledger
    WHERE product_id=? AND (${LEDGER_LIVE_SQL}) AND COALESCE(event_type,'') <> 'cutting_pack'
    GROUP BY warehouse_id, ${hasVar ? 'COALESCE(variant_id,0)' : '1'}
    ORDER BY warehouse_id, ${hasVar ? 'COALESCE(variant_id,0)' : '1'}
  `).all(productId);
  return rows.map((r) => ({
    warehouse_id: r.warehouse_id,
    warehouse_name: warehouseName(db, r.warehouse_id),
    variant_id: r.variant_id || null,
    variant_label: variantLabel(db, r.variant_id),
    qty: round3(r.q),
  }));
}

function ledgerRow(db, id) {
  return db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id) || null;
}

function candidateView(r, withCost) {
  const out = {
    ledger_id: r.id,
    qty: round3(r.qty_in),
    je_id: r.je_id || null,
    source_type: r.source_type || '',
    status: r.status || null,
    date: r.date || '',
    created_at: r.created_at || null,
  };
  if (withCost) {
    out.unit_cost_rial = rial(r.unit_cost_rial);
    out.amount_rial = rial(r.amount_rial);
  }
  return out;
}

// ─────────────────────────── journal helpers ───────────────────────────

function jeLiveHead(db, jeId) {
  const h = db.prepare('SELECT id, status, deleted_at, ref_type, ref_id, entry_date FROM journal_entries WHERE id=?').get(jeId);
  if (!h) return { head: null, live: false };
  const dead = Number(h.deleted_at || 0) > 0 || ['reversed', 'void'].includes(String(h.status || ''));
  return { head: h, live: !dead };
}

function jeLinesRial(db, jeId) {
  const hasRial = hasColumn(db, 'journal_lines', 'debit_rial');
  return db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(jeId).map((l) => ({
    code: String(l.account_code),
    name: l.account_name || '',
    debit: hasRial && Number(l.debit_rial) ? rial(l.debit_rial) : rial((Number(l.debit) || 0) * 10),
    credit: hasRial && Number(l.credit_rial) ? rial(l.credit_rial) : rial((Number(l.credit) || 0) * 10),
  }));
}

function invAccount(db, warehouseId, readOnly) {
  return require('./ledger').inventoryAccountForWarehouse(db, warehouseId || null, readOnly ? { readOnly: true } : {});
}
function openingAccount(db) {
  return require('../coa-map').acct(db, 'coa_opening_balance');
}

/**
 * How to neutralise the GL effect of voiding one ledger row.
 * kind 'opening' (qty_in): counter = Dr 3102 / Cr inventory(wh).
 * kind 'adjustment' (qty_out): counter = Dr inventory(wh) / Cr the original JE's offset account.
 * Returns { je_action:'reverse'|'counter'|'none', je_id, lines, error?, warning? }.
 */
function jeActionFor(db, row, kind, { readOnly }) {
  const jeId = row.je_id ? Number(row.je_id) : null;
  const amount = rial(row.amount_rial);
  if (!jeId) return { je_action: 'none', je_id: null, lines: [], reason: 'no_je' };
  const { head, live } = jeLiveHead(db, jeId);
  if (!head) return { je_action: 'none', je_id: jeId, lines: [], reason: 'je_missing', warning: `سند حسابداری #${jeId} ردیف کاردکس #${row.id} یافت نشد — اقدام دفتری انجام نمی‌شود` };
  if (!live) return { je_action: 'none', je_id: jeId, lines: [], reason: 'je_dead', warning: `سند حسابداری #${jeId} ردیف کاردکس #${row.id} قبلاً ابطال شده است` };
  const others = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM inventory_ledger
    WHERE je_id=? AND id<>? AND reversed_of IS NULL
      AND COALESCE(event_type,'') <> 'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'
  `).get(jeId, row.id).c) || 0;
  const lines = jeLinesRial(db, jeId);
  const totalDebit = lines.reduce((a, l) => a + l.debit, 0);
  const inv = invAccount(db, row.warehouse_id, readOnly);
  const dedicated = others === 0 && Math.abs(totalDebit - amount) <= 1;
  if (dedicated) {
    return {
      je_action: 'reverse', je_id: jeId, ref_type: head.ref_type || null,
      lines: lines.map((l) => ({ code: l.code, name: l.name, debit: l.credit, credit: l.debit })),
    };
  }
  if (!amount) return { je_action: 'none', je_id: jeId, lines: [], reason: 'zero_amount' };
  if (kind === 'opening') {
    const op = openingAccount(db);
    return {
      je_action: 'counter', je_id: jeId, ref_type: head.ref_type || null, shared_with_rows: others,
      lines: [
        { code: op.code, name: op.name, debit: amount, credit: 0 },
        { code: inv.code, name: inv.name, debit: 0, credit: amount },
      ],
    };
  }
  // adjustment (outbound): find the single offset account the original JE debited
  const offsets = [...new Map(lines.filter((l) => l.debit > 0 && l.code !== String(inv.code))
    .map((l) => [l.code, l])).values()];
  if (offsets.length !== 1) {
    return {
      je_action: 'none', je_id: jeId, lines: [],
      error: {
        code: 'E_OPENING_ADJ_JE_SHARED', status: 409,
        error: `سند حسابداری #${jeId} تعدیل هم‌ترازی #${row.id} مشترک است و حساب مقابل یکتا ندارد — ابتدا آن را دستی اصلاح کنید`,
        ledger_id: row.id, je_id: jeId,
      },
    };
  }
  return {
    je_action: 'counter', je_id: jeId, ref_type: head.ref_type || null, shared_with_rows: others,
    lines: [
      { code: inv.code, name: inv.name, debit: amount, credit: 0 },
      { code: offsets[0].code, name: offsets[0].name, debit: 0, credit: amount },
    ],
  };
}

// ─────────────────────────── migration ───────────────────────────

/**
 * Group live opening kardex rows (active fiscal year) by (product, variant, warehouse) → product_opening_stock.
 * Single row → ok / no_je. Multiple → FIRST (lowest id) values + needs_review + candidate_ledger_ids. Never sums.
 * Never writes inventory_ledger / journal_*; asserts counts and sums unchanged.
 */
function migrateProductOpeningStock(db, { dryRun = true, userId = null, ensureTable = false } = {}) {
  const SENTINEL = { dryRunRollback: true };
  let report = null;
  const snap = () => ({
    ledger: Number(db.prepare('SELECT COUNT(*) AS c FROM inventory_ledger').get().c) || 0,
    ledgerSum: rial(db.prepare('SELECT COALESCE(SUM(amount_rial),0) AS s FROM inventory_ledger').get().s),
    ledgerLive: Number(db.prepare(`SELECT COUNT(*) AS c FROM inventory_ledger WHERE ${LEDGER_LIVE_SQL}`).get().c) || 0,
    je: Number(db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c) || 0,
    jl: Number(db.prepare('SELECT COUNT(*) AS c FROM journal_lines').get().c) || 0,
    jlSum: rial(db.prepare('SELECT COALESCE(SUM(debit),0)*10 AS s FROM journal_lines').get().s),
  });
  const run = () => {
    if (!hasTable(db, 'product_opening_stock')) {
      if (!ensureTable) throw posErr('E_OPENING_SCHEMA_MISSING', 409, 'جدول product_opening_stock وجود ندارد — ابتدا نسخهٔ جدید را مستقر کنید');
      ensureSchema(db);
    }
    const before = snap();
    const fy = fiscalCtx(db);
    const hasVar = ledgerVariantSql(db);
    const params = [];
    let sql = `SELECT id, product_id, warehouse_id, ${hasVar ? 'variant_id' : 'NULL AS variant_id'},
        qty_in, unit_cost_rial, amount_rial, je_id, source_type, source_id, date, created_at
      FROM inventory_ledger WHERE event_type='opening' AND ${LEDGER_LIVE_SQL} AND warehouse_id IS NOT NULL`;
    if (fy.start) { sql += " AND COALESCE(date,'') >= ?"; params.push(fy.start); }
    if (fy.end) { sql += " AND COALESCE(date,'') <= ?"; params.push(fy.end); }
    sql += ' ORDER BY product_id, warehouse_id, COALESCE(variant_id,0), id';
    const all = db.prepare(sql).all(...params);
    const groups = new Map();
    for (const r of all) {
      const k = `${r.product_id}|${r.variant_id || 0}|${r.warehouse_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const exists = db.prepare(`
      SELECT id FROM product_opening_stock
      WHERE COALESCE(fiscal_year_id,0)=COALESCE(?,0) AND product_id=? AND COALESCE(variant_id,0)=COALESCE(?,0)
        AND warehouse_id=? AND status<>'void' LIMIT 1
    `);
    const ins = db.prepare(`
      INSERT INTO product_opening_stock (fiscal_year_id, product_id, variant_id, warehouse_id, qty, unit_cost_rial,
        value_rial, ledger_id, je_id, status, source, candidate_ledger_ids, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const out = {
      dry_run: !!dryRun,
      fiscal_year_id: fy.fiscalYearId,
      combos_total: groups.size,
      created: { ok: 0, no_je: 0, needs_review: 0 },
      skipped_existing: 0,
      rows: [],
      totals: { all_rows_rial: 0, extra_rows_rial: 0, extra_rows_count: 0, combos_multi: 0 },
      ledger_count_before: before.ledger,
      ledger_count_after: null,
      je_count_before: before.je,
      je_count_after: null,
    };
    for (const rows of groups.values()) {
      const first = rows[0];
      for (const r of rows) out.totals.all_rows_rial += rial(r.amount_rial);
      if (rows.length > 1) {
        out.totals.combos_multi += 1;
        for (const r of rows.slice(1)) { out.totals.extra_rows_rial += rial(r.amount_rial); out.totals.extra_rows_count += 1; }
      }
      let status = rows.length > 1 ? 'needs_review' : (first.je_id ? 'ok' : 'no_je');
      const row = {
        product_id: first.product_id,
        variant_id: first.variant_id || null,
        warehouse_id: first.warehouse_id,
        status,
        chosen_ledger_id: first.id,
        qty: round3(first.qty_in),
        unit_cost_rial: rial(first.unit_cost_rial),
        value_rial: rial(first.amount_rial),
        je_id: first.je_id || null,
        candidates: rows.map((r) => ({
          ledger_id: r.id, qty: round3(r.qty_in), unit_cost_rial: rial(r.unit_cost_rial),
          amount_rial: rial(r.amount_rial), je_id: r.je_id || null, source_type: r.source_type || '', created_at: r.created_at || null,
        })),
      };
      if (exists.get(fy.fiscalYearId, first.product_id, first.variant_id || null, first.warehouse_id)) {
        out.skipped_existing += 1;
        row.status = 'skipped_existing';
        out.rows.push(row);
        continue;
      }
      const src = rows.length === 1 && String(first.source_type || '') === 'opening_stock_doc' ? 'opening_doc' : 'migration';
      ins.run(fy.fiscalYearId, first.product_id, first.variant_id || null, first.warehouse_id, round3(first.qty_in),
        rial(first.unit_cost_rial), rial(first.amount_rial), first.id, first.je_id || null, status, src,
        rows.length > 1 ? JSON.stringify(rows.map((r) => r.id)) : null,
        rows.length > 1 ? `${rows.length} ردیف افتتاحیهٔ زنده — نیاز به بررسی` : null, userId || null);
      out.created[status] += 1;
      out.rows.push(row);
    }
    const after = snap();
    out.ledger_count_after = after.ledger;
    out.je_count_after = after.je;
    if (after.ledger !== before.ledger || after.ledgerSum !== before.ledgerSum || after.ledgerLive !== before.ledgerLive
      || after.je !== before.je || after.jl !== before.jl || after.jlSum !== before.jlSum) {
      throw posErr('E_OPENING_MIGRATE_TOUCHED_BOOKS', 500, 'مهاجرت نباید کاردکس یا دفتر کل را تغییر دهد', { before, after });
    }
    if (!dryRun) {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MIGRATE_MARKER, JSON.stringify({
        at: new Date().toISOString(), counts: { combos_total: out.combos_total, created: out.created, skipped_existing: out.skipped_existing },
      }));
    }
    report = out;
    if (dryRun) throw SENTINEL;
  };
  try {
    db.transaction(run)();
  } catch (e) {
    if (e !== SENTINEL) throw e;
  }
  return report;
}

function bootMigrationWanted(db) {
  try {
    if (require('../../db').isDevice()) return false;
  } catch (_) { /* boot-time require cycle: fall through to env */ }
  if (process.env.SYNC_ROLE === 'device') return false;
  if (!hasTable(db, 'product_opening_stock')) return false;
  const get = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
  if (get(MIGRATE_MARKER)) return false;
  return process.env.PRODUCT_OPENING_STOCK_MIGRATE === '1' || get(MIGRATE_ENABLE_KEY) === '1';
}

// ─────────────────────────── P2 hooks ───────────────────────────

/** After a P2 opening document line posts: one ok row per combo (caller already passed the guard). */
function recordFromOpeningDoc(db, { fiscalYearId, productId, variantId, warehouseId, qty, unitCostRial, valueRial, ledgerId, jeId, userId }) {
  if (!hasTable(db, 'product_opening_stock')) return null;
  return db.prepare(`
    INSERT INTO product_opening_stock (fiscal_year_id, product_id, variant_id, warehouse_id, qty, unit_cost_rial,
      value_rial, ledger_id, je_id, status, source, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,'ok','opening_doc',?)
  `).run(fiscalYearId || null, productId, variantId || null, warehouseId, round3(qty), rial(unitCostRial),
    rial(valueRial), ledgerId || null, jeId || null, userId || null).lastInsertRowid;
}

/** P2 voidDoc: mark rows backed by the voided ledger ids as void. */
function voidFromOpeningDoc(db, ledgerIds, userId) {
  if (!hasTable(db, 'product_opening_stock')) return 0;
  const ids = (ledgerIds || []).map(Number).filter((x) => x > 0);
  if (!ids.length) return 0;
  return db.prepare(`
    UPDATE product_opening_stock
    SET status='void', updated_by=?, updated_at=datetime('now'), version=COALESCE(version,1)+1
    WHERE status<>'void' AND ledger_id IN (${ids.map(() => '?').join(',')})
  `).run(userId || null, ...ids).changes;
}

// ─────────────────────────── read ───────────────────────────

function posRowView(db, r, withCost) {
  const out = {
    id: r.id,
    fiscal_year_id: r.fiscal_year_id || null,
    warehouse_id: r.warehouse_id,
    warehouse_name: warehouseName(db, r.warehouse_id),
    variant_id: r.variant_id || null,
    variant_label: variantLabel(db, r.variant_id),
    qty: round3(r.qty),
    ledger_id: r.ledger_id || null,
    je_id: r.je_id || null,
    status: r.status,
    source: r.source || null,
    note: r.note || null,
    reviewed_by: r.reviewed_by || null,
    reviewed_at: r.reviewed_at || null,
    version: r.version || 1,
  };
  if (withCost) {
    out.unit_cost_rial = rial(r.unit_cost_rial);
    out.value_rial = rial(r.value_rial);
  }
  if (r.status === 'needs_review') {
    let ids = [];
    try { ids = JSON.parse(r.candidate_ledger_ids || '[]'); } catch (_) { ids = []; }
    out.candidates = ids.map((id) => ledgerRow(db, id)).filter(Boolean).map((x) => candidateView(x, withCost));
  }
  return out;
}

function getProductOpening(db, productId, user) {
  const pid = Number(productId) || 0;
  const p = db.prepare('SELECT id, name, code FROM products WHERE id=?').get(pid);
  if (!p) throw posErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const withCost = canSeeCost(user, db);
  const fy = fiscalCtx(db);
  const stock = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)),0) AS q FROM inventory_ledger
    WHERE product_id=? AND (${LEDGER_LIVE_SQL}) AND COALESCE(event_type,'') <> 'cutting_pack'
  `).get(pid);
  const rows = hasTable(db, 'product_opening_stock') ? db.prepare(`
    SELECT * FROM product_opening_stock
    WHERE product_id=? AND COALESCE(fiscal_year_id,0)=COALESCE(?,0) AND status<>'void'
    ORDER BY warehouse_id, COALESCE(variant_id,0), id
  `).all(pid, fy.fiscalYearId) : [];
  let pending = [];
  if (hasTable(db, 'opening_stock_lines')) {
    pending = db.prepare(`
      SELECT s.id AS line_id, s.doc_id, d.doc_no, d.created_by, s.warehouse_id, s.variant_id, s.qty, s.unit_cost_rial
      FROM opening_stock_lines s JOIN opening_stock_docs d ON d.id=s.doc_id
      WHERE s.product_id=? AND d.status='draft' ORDER BY s.id
    `).all(pid).map((r) => {
      const o = {
        line_id: r.line_id, doc_id: r.doc_id, doc_no: r.doc_no, created_by: r.created_by,
        warehouse_id: r.warehouse_id, warehouse_name: warehouseName(db, r.warehouse_id),
        variant_id: r.variant_id || null, variant_label: variantLabel(db, r.variant_id), qty: round3(r.qty),
      };
      if (withCost) { o.unit_cost_rial = rial(r.unit_cost_rial); o.amount_rial = rial(Number(r.qty) * Number(r.unit_cost_rial)); }
      return o;
    });
  }
  const whs = db.prepare('SELECT id, name FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id').all();
  return {
    product_id: pid,
    product_name: p.name,
    product_code: p.code,
    fiscal_year_id: fy.fiscalYearId,
    opening_date: fy.date || null,
    can_edit: canEdit(user, db),
    can_see_cost: withCost,
    stock_total: round3(stock && stock.q),
    by_warehouse: kardexByWarehouse(db, pid),
    rows: rows.map((r) => posRowView(db, r, withCost)),
    warehouses: whs.map((w) => ({ id: w.id, name: w.name })),
    pending_docs: pending,
  };
}

function listOpeningIssues(db, user) {
  const withCost = canSeeCost(user, db);
  if (!hasTable(db, 'product_opening_stock')) {
    return { needs_review: [], no_je: [], totals: { needs_review_count: 0, no_je_count: 0, extra_rows_rial: withCost ? 0 : undefined } };
  }
  const rows = db.prepare(`
    SELECT s.*, p.name AS product_name, p.code AS product_code FROM product_opening_stock s
    LEFT JOIN products p ON p.id=s.product_id
    WHERE s.status IN ('needs_review','no_je') ORDER BY s.product_id, s.warehouse_id, s.id
  `).all();
  const view = (r) => Object.assign({ product_id: r.product_id, product_name: r.product_name, product_code: r.product_code }, posRowView(db, r, withCost));
  const needs = rows.filter((r) => r.status === 'needs_review').map(view);
  const noJe = rows.filter((r) => r.status === 'no_je').map(view);
  let extra = 0;
  for (const n of needs) {
    const live = (n.candidates || []).filter((c) => c.status === 'posted');
    for (const c of live.slice(1)) extra += rial(c.amount_rial);
  }
  const totals = { needs_review_count: needs.length, no_je_count: noJe.length };
  if (withCost) totals.extra_rows_rial = extra;
  return { needs_review: needs, no_je: noJe, totals };
}

// ─────────────────────────── plan ───────────────────────────

function parseBody(db, body) {
  const b = body || {};
  const productId = Number(b.product_id) || 0;
  const warehouseId = Number(b.warehouse_id) || 0;
  const variantId = b.variant_id != null && b.variant_id !== '' && Number(b.variant_id) > 0 ? Math.trunc(Number(b.variant_id)) : null;
  if (!productId) throw posErr('E_OPENING_LINE', 400, 'کالا الزامی است');
  if (!warehouseId) throw posErr('E_OPENING_LINE', 400, 'انبار الزامی است');
  const product = db.prepare('SELECT id, name, unit FROM products WHERE id=?').get(productId);
  if (!product) throw posErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  if (!db.prepare('SELECT 1 FROM warehouses WHERE id=?').get(warehouseId)) throw posErr('E_WAREHOUSE_NOT_FOUND', 404, 'انبار یافت نشد');
  if (variantId) {
    const v = db.prepare('SELECT product_id FROM product_variants WHERE id=?').get(variantId);
    if (!v) throw posErr('E_VARIANT_NOT_FOUND', 404, 'واریانت یافت نشد');
    if (Number(v.product_id) !== productId) throw posErr('E_VARIANT_MISMATCH', 400, 'واریانت متعلق به این کالا نیست');
  }
  const has = (k) => b[k] != null && b[k] !== '';
  const qty = has('qty') ? round3(b.qty) : null;
  const unitCost = has('unit_cost_rial') ? rial(b.unit_cost_rial) : null;
  const keepLedgerId = has('keep_ledger_id') ? Number(b.keep_ledger_id) : null;
  return { productId, warehouseId, variantId, qty, unitCost, keepLedgerId, product };
}

/** Greedy pairing: exact qty match per extra first, then largest-first while it fits. */
function pairAdjustments(db, { productId, warehouseId, variantId }, extras) {
  const hasVar = ledgerVariantSql(db);
  const params = [productId, warehouseId];
  let sql = `SELECT * FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND event_type='adjustment' AND source_type='stock_reconcile'
      AND COALESCE(qty_out,0)>0 AND (${LEDGER_LIVE_SQL})`;
  if (hasVar) { sql += ' AND COALESCE(variant_id,0)=COALESCE(?,0)'; params.push(variantId || null); }
  sql += ' ORDER BY id';
  const pool = db.prepare(sql).all(...params);
  const used = new Set();
  const picked = [];
  for (const x of extras) {
    const hit = pool.find((a) => !used.has(a.id) && Math.abs(round3(a.qty_out) - round3(x.qty_in)) < 1e-6);
    if (hit) { used.add(hit.id); picked.push(hit); }
  }
  let remaining = round3(extras.reduce((a, x) => a + (Number(x.qty_in) || 0), 0) - picked.reduce((a, x) => a + (Number(x.qty_out) || 0), 0));
  const rest = pool.filter((a) => !used.has(a.id)).sort((a, b) => (Number(b.qty_out) - Number(a.qty_out)) || (a.id - b.id));
  for (const a of rest) {
    if (remaining <= EPS) break;
    if (Number(a.qty_out) <= remaining + 1e-6) {
      used.add(a.id); picked.push(a);
      remaining = round3(remaining - Number(a.qty_out));
    }
  }
  return { picked: picked.sort((a, b) => a.id - b.id), residual: Math.max(0, remaining) };
}

function addGl(map, lines, sign) {
  for (const l of lines) {
    const k = String(l.code);
    map.set(k, (map.get(k) || 0) + sign * (rial(l.debit) - rial(l.credit)));
  }
}

/**
 * Build the plan. Internal: returns { plan, ctx } (ctx = raw rows for apply). Never writes.
 * `readOnly` → inventory account lookup never throws on unmapped warehouses (preview).
 */
function buildPlan(db, body, user, { readOnly = true } = {}) {
  const p = parseBody(db, body);
  const fy = fiscalCtx(db);
  const { findLiveOpenings } = require('./opening-guard');
  const found = findLiveOpenings(db, { productId: p.productId, warehouseId: p.warehouseId, variantId: p.variantId, fiscalYearId: fy.fiscalYearId });
  const errors = [];
  const warnings = [];
  const addErr = (code, status, error, extra) => errors.push(Object.assign({ code, status, error }, extra || {}));
  const ledger = found.ledger.map((r) => ledgerRow(db, r.id)).filter(Boolean);
  const pos = found.pos;
  if (found.p2.length) {
    addErr('E_OPENING_USE_DOC_VOID', 409, `این موجودی اول دوره با سند افتتاحیه #${found.p2[0].doc_id} ثبت شده است — برای تغییر، آن سند را ابطال و سند جدید ثبت کنید`, { doc_id: found.p2[0].doc_id });
  }
  if (found.receipts.length) {
    addErr('E_OPENING_RECEIPT_EXISTS', 409, `موجودی اول دوره با رسید انبار ${found.receipts[0].num || found.receipts[0].id} ثبت شده است — از ابطال همان رسید استفاده کنید`);
  }

  let mode;
  if (!ledger.length) mode = pos ? 'correct' : 'create';
  else if (ledger.length === 1) mode = 'correct';
  else mode = 'resolve';

  const hasDraft = hasTable(db, 'opening_stock_lines') && !!db.prepare(`
    SELECT 1 FROM opening_stock_lines s JOIN opening_stock_docs d ON d.id=s.doc_id
    WHERE d.status='draft' AND s.product_id=? AND s.warehouse_id=? AND COALESCE(s.variant_id,0)=COALESCE(?,0) LIMIT 1
  `).get(p.productId, p.warehouseId, p.variantId);
  if (hasDraft) warnings.push('برای همین کالا/انبار/واریانت سند افتتاحیهٔ پیش‌نویس وجود دارد؛ پس از این اصلاح، ثبت قطعی آن رد خواهد شد');

  const intQty = (q) => {
    try { return !require('./qty-policy').requiresIntegerQty(db, p.productId, p.product.unit) || Math.abs(q - Math.round(q)) < EPS; }
    catch (_) { return true; }
  };

  const plan = {
    mode,
    fiscal_year_id: fy.fiscalYearId,
    opening_date: fy.date || null,
    product_id: p.productId,
    warehouse_id: p.warehouseId,
    variant_id: p.variantId,
    current: {
      pos: pos ? posRowView(db, pos, true) : null,
      ledger: ledger.map((r) => candidateView(r, true)),
    },
    target: null,
    voids: [],
    paired_adjustments: [],
    residual_qty: 0,
    new_ledger: null,
    draft_lines: [],
    journal: [],
    kardex_before: kardexCombo(db, p.productId, p.warehouseId, p.variantId),
    kardex_after: null,
    stock_after_by_warehouse: [],
    gl_effect_by_account: [],
    kardex_value_delta_rial: 0,
    gl_inventory_delta_rial: 0,
    warnings,
    errors,
    ready: false,
  };
  const ctx = { p, fy, pos, ledger, voidRows: [], adjRows: [], keep: null, newRow: null, jeActions: new Map() };

  if (mode === 'create') {
    if (!(p.qty > 0)) addErr('E_OPENING_QTY', 400, 'تعداد باید بزرگ‌تر از صفر باشد');
    if (!(p.unitCost > 0)) addErr('E_OPENING_COST_REQUIRED', 422, 'بهای واحد (ریال) باید بزرگ‌تر از صفر باشد');
    if (!errors.length) {
      try {
        require('./opening-stock').validateLine(db, { product_id: p.productId, warehouse_id: p.warehouseId, variant_id: p.variantId, qty: p.qty, unit_cost_rial: p.unitCost }, 0);
      } catch (e) { addErr(e.code || 'E_OPENING_LINE', e.status || 400, e.message); }
    }
    plan.target = { qty: p.qty, unit_cost_rial: p.unitCost, value_rial: rial((p.qty || 0) * (p.unitCost || 0)) };
    plan.draft_lines = [{ product_id: p.productId, warehouse_id: p.warehouseId, variant_id: p.variantId, qty: p.qty, unit_cost_rial: p.unitCost, amount_rial: plan.target.value_rial }];
    warnings.push('سند افتتاحیهٔ پیش‌نویس ساخته می‌شود؛ ثبت قطعی آن (اثر روی موجودی و دفتر) با کاربر دیگر است (maker-checker)');
    plan.kardex_after = plan.kardex_before;
    plan.stock_after_by_warehouse = kardexByWarehouse(db, p.productId);
    plan.ready = errors.length === 0;
    return { plan, ctx };
  }

  // correct / resolve
  let keep = null;
  let extras = [];
  if (mode === 'resolve') {
    keep = p.keepLedgerId ? ledger.find((r) => Number(r.id) === p.keepLedgerId) : ledger[0];
    if (!keep) {
      addErr('E_OPENING_KEEP_INVALID', 400, 'ردیف انتخاب‌شده برای نگه‌داشتن جزو ردیف‌های افتتاحیهٔ زندهٔ این ترکیب نیست', { keep_ledger_id: p.keepLedgerId });
      keep = ledger[0];
    }
    extras = ledger.filter((r) => r.id !== keep.id);
  } else {
    keep = ledger[0] || null;
  }

  // target values
  let tQty;
  let tUnit;
  if (mode === 'correct') {
    if (p.qty == null) addErr('E_OPENING_QTY', 400, 'تعداد جدید موجودی اول دوره الزامی است');
    tQty = p.qty != null ? p.qty : (keep ? round3(keep.qty_in) : 0);
    tUnit = p.unitCost != null ? p.unitCost : (keep ? rial(keep.unit_cost_rial) : (pos ? rial(pos.unit_cost_rial) : 0));
  } else {
    tQty = p.qty != null ? p.qty : round3(keep.qty_in);
    tUnit = p.unitCost != null ? p.unitCost : rial(keep.unit_cost_rial);
  }
  if (!(tQty >= 0) || !Number.isFinite(tQty)) addErr('E_OPENING_QTY', 400, 'تعداد نمی‌تواند منفی باشد');
  if (tQty > 0 && !(tUnit > 0)) addErr('E_OPENING_COST_REQUIRED', 422, 'بهای واحد (ریال) باید بزرگ‌تر از صفر باشد');
  if (tQty > 0 && !intQty(tQty)) addErr('E_QTY_NOT_INTEGER', 400, 'موجودی کالای قطعه‌ای باید عدد صحیح باشد');
  const tValue = rial(tQty * tUnit);
  plan.target = { qty: tQty, unit_cost_rial: tUnit, value_rial: tValue, keep_ledger_id: mode === 'resolve' && keep ? keep.id : undefined };

  const keepChanged = !keep
    ? tQty > 0
    : (Math.abs(round3(keep.qty_in) - tQty) > EPS || rial(keep.unit_cost_rial) !== tUnit || rial(keep.amount_rial) !== tValue);
  if (mode === 'correct' && keep && !keepChanged) {
    addErr('E_OPENING_NO_CHANGE', 400, 'مقدار و بهای جدید با موجودی اول دورهٔ فعلی یکسان است');
  }
  if (mode === 'correct' && !keep && pos && !(tQty > 0)) {
    addErr('E_OPENING_NO_CHANGE', 400, 'ردیف کاردکسی برای ابطال وجود ندارد و تعداد جدید صفر است');
  }

  const voidRows = [...extras];
  if (keep && keepChanged) voidRows.push(keep);
  voidRows.sort((a, b) => a.id - b.id);
  ctx.voidRows = voidRows;
  ctx.keep = keep;

  for (const r of voidRows) {
    const ja = jeActionFor(db, r, 'opening', { readOnly });
    ctx.jeActions.set(r.id, ja);
    if (ja.warning) warnings.push(ja.warning);
    if (ja.error) errors.push(ja.error);
    plan.voids.push({
      ledger_id: r.id, qty: round3(r.qty_in), unit_cost_rial: rial(r.unit_cost_rial), amount_rial: rial(r.amount_rial),
      je_id: r.je_id || null, je_action: ja.je_action, role: keep && r.id === keep.id ? 'kept_corrected' : (mode === 'resolve' ? 'extra' : 'current'),
      source_type: r.source_type || '',
    });
    if (ja.je_action === 'reverse') plan.journal.push({ kind: 'reverse', je_id: ja.je_id, for_ledger_id: r.id, lines: ja.lines });
    if (ja.je_action === 'counter') plan.journal.push({ kind: 'counter', je_id: ja.je_id, for_ledger_id: r.id, lines: ja.lines });
    if (ja.je_action === 'none' && ja.reason === 'no_je') warnings.push(`ردیف کاردکس #${r.id} سند حسابداری ندارد — ابطال آن اثری بر دفتر کل ندارد`);
  }
  // a JE shared by two rows that are BOTH voided is countered twice (= its full share), never reversed.

  if (mode === 'resolve' && extras.length) {
    const pair = pairAdjustments(db, p, extras);
    ctx.adjRows = pair.picked;
    plan.residual_qty = pair.residual;
    for (const a of pair.picked) {
      const ja = jeActionFor(db, a, 'adjustment', { readOnly });
      ctx.jeActions.set(a.id, ja);
      if (ja.warning) warnings.push(ja.warning);
      if (ja.error) { errors.push(ja.error); warnings.push(ja.error.error); }
      plan.paired_adjustments.push({
        ledger_id: a.id, qty: round3(a.qty_out), amount_rial: rial(a.amount_rial), je_id: a.je_id || null,
        je_action: ja.je_action, date: a.date || '',
      });
      if (ja.je_action === 'reverse') plan.journal.push({ kind: 'reverse', je_id: ja.je_id, for_ledger_id: a.id, lines: ja.lines });
      if (ja.je_action === 'counter') plan.journal.push({ kind: 'counter', je_id: ja.je_id, for_ledger_id: a.id, lines: ja.lines });
    }
    if (pair.residual > EPS) warnings.push(`باقیماندهٔ بدون تعدیل هم‌جفت: ${pair.residual} — مقدار کاردکس به همین اندازه کم می‌شود`);
  }

  if (tQty > 0 && keepChanged) {
    const inv = invAccount(db, p.warehouseId, readOnly);
    const op = openingAccount(db);
    plan.new_ledger = { qty: tQty, unit_cost_rial: tUnit, amount_rial: tValue, event_type: 'opening', source_type: SOURCE_TYPE, date: fy.date || null };
    plan.journal.push({
      kind: 'new_opening',
      lines: [
        { code: inv.code, name: inv.name, debit: tValue, credit: 0 },
        { code: op.code, name: op.name, debit: 0, credit: tValue },
      ],
    });
    ctx.newRow = plan.new_ledger;
  }

  // quantities / values
  const qtyDelta = round3(-voidRows.reduce((a, r) => a + (Number(r.qty_in) || 0), 0)
    + ctx.adjRows.reduce((a, r) => a + (Number(r.qty_out) || 0), 0)
    + (ctx.newRow ? tQty : 0));
  const valueDelta = -voidRows.reduce((a, r) => a + rial(r.amount_rial), 0)
    + ctx.adjRows.reduce((a, r) => a + rial(r.amount_rial), 0)
    + (ctx.newRow ? tValue : 0);
  plan.qty_delta = qtyDelta;
  plan.kardex_value_delta_rial = valueDelta;
  plan.kardex_after = { qty: round3(plan.kardex_before.qty + qtyDelta), value_rial: plan.kardex_before.value_rial + valueDelta };
  const whAfter = round3(kardexWarehouse(db, p.productId, p.warehouseId) + qtyDelta);
  const L = require('./ledger');
  const negAllowed = L.allowNegative(db, p.warehouseId);
  if (!negAllowed && (plan.kardex_after.qty < -EPS || whAfter < -EPS)) {
    addErr('E_NEGATIVE_STOCK', 409, `با این تغییر موجودی کاردکس منفی می‌شود (${Math.min(plan.kardex_after.qty, whAfter)})`, {
      product_id: p.productId, warehouse_id: p.warehouseId, available: plan.kardex_before.qty, needed: Math.abs(qtyDelta),
    });
  }
  const ws = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(p.productId, p.warehouseId);
  const wsBefore = round3(ws && ws.qty);
  plan.warehouse_stock = { before: wsBefore, after: round3(wsBefore + qtyDelta) };
  if (!negAllowed && qtyDelta < 0 && plan.warehouse_stock.after < -EPS && !errors.some((e) => e.code === 'E_NEGATIVE_STOCK')) {
    addErr('E_NEGATIVE_STOCK', 409, `با این تغییر موجودی انبار منفی می‌شود (${plan.warehouse_stock.after})`, {
      product_id: p.productId, warehouse_id: p.warehouseId, available: wsBefore, needed: Math.abs(qtyDelta),
    });
  }
  plan.stock_after_by_warehouse = kardexByWarehouse(db, p.productId).map((r) => (
    Number(r.warehouse_id) === p.warehouseId && Number(r.variant_id || 0) === Number(p.variantId || 0)
      ? { ...r, qty: round3(r.qty + qtyDelta) } : r));
  if (!plan.stock_after_by_warehouse.some((r) => Number(r.warehouse_id) === p.warehouseId && Number(r.variant_id || 0) === Number(p.variantId || 0)) && qtyDelta) {
    plan.stock_after_by_warehouse.push({
      warehouse_id: p.warehouseId, warehouse_name: warehouseName(db, p.warehouseId),
      variant_id: p.variantId, variant_label: variantLabel(db, p.variantId), qty: qtyDelta,
    });
  }

  // GL effect
  const gl = new Map();
  for (const j of plan.journal) addGl(gl, j.lines, 1);
  plan.gl_effect_by_account = [...gl.entries()].filter(([, v]) => v !== 0).map(([code, net]) => ({ code, net_debit_rial: net }));
  const invCode = String(invAccount(db, p.warehouseId, readOnly).code);
  plan.gl_inventory_delta_rial = gl.get(invCode) || 0;
  if (plan.gl_inventory_delta_rial !== plan.kardex_value_delta_rial) {
    warnings.push(`تغییر حساب موجودی (${plan.gl_inventory_delta_rial}) با تغییر ارزش کاردکس (${plan.kardex_value_delta_rial}) برابر نیست — ردیف‌های بدون سند/سند ابطال‌شده`);
  }

  try {
    if (fy.date && (voidRows.length || ctx.newRow)) require('./period-lock').assertPeriodOpen(db, fy.date, 'موجودی اول دوره');
  } catch (e) { addErr(e.code || 'E_INV_PERIOD_LOCKED', e.status || 422, e.message); }

  if (mode === 'resolve' && pos && pos.status !== 'needs_review') warnings.push('ردیف موجودی اول دوره وضعیت needs_review ندارد ولی چند ردیف کاردکس زنده دارد');
  plan.ready = errors.length === 0;
  return { plan, ctx };
}

/** Read-only preview. Throws only for malformed input (400/404); business blockers go to plan.errors. */
function planOpeningChange(db, body, user) {
  const before = totalChanges(db);
  const { plan } = buildPlan(db, body, user, { readOnly: true });
  const after = totalChanges(db);
  if (after !== before) throw posErr('E_OPENING_PREVIEW_WROTE', 500, 'پیش‌نمایش نباید چیزی بنویسد', { before, after });
  if (!canSeeCost(user, db)) stripCost(plan);
  return plan;
}

function stripCost(plan) {
  const strip = (o) => { if (o && typeof o === 'object') { delete o.unit_cost_rial; delete o.amount_rial; delete o.value_rial; } };
  (plan.voids || []).forEach(strip);
  (plan.paired_adjustments || []).forEach(strip);
  (plan.draft_lines || []).forEach(strip);
  strip(plan.target); strip(plan.new_ledger);
  if (plan.current) { strip(plan.current.pos); (plan.current.ledger || []).forEach(strip); }
  plan.journal = [];
  plan.gl_effect_by_account = [];
  delete plan.kardex_value_delta_rial;
  delete plan.gl_inventory_delta_rial;
  if (plan.kardex_before) delete plan.kardex_before.value_rial;
  if (plan.kardex_after) delete plan.kardex_after.value_rial;
}

// ─────────────────────────── apply ───────────────────────────

function isConfirmed(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

function postCounterJe(db, { row, ja, date, user, reason }) {
  const { postToLedger } = require('../ledger');
  const { rialToLedger } = require('../money');
  return postToLedger(db, {
    sourceType: COUNTER_SOURCE,
    sourceId: row.id,
    date,
    description: `اصلاحیهٔ موجودی اول دوره — خنثی‌سازی ردیف کاردکس #${row.id} از سند مشترک #${ja.je_id} — ${reason}`.slice(0, 500),
    createdBy: user ? user.id : null,
    voucherType: 'opening',
    skipCcPolicy: true,
    lines: ja.lines.map((l) => ({ code: l.code, name: l.name, debit: rialToLedger(l.debit), credit: rialToLedger(l.credit) })),
  });
}

/**
 * Execute a correction / resolution / create. One transaction; plan recomputed inside it.
 * @param {{audit?:Function}} [opts] audit(userId, action, entity, entityId, detail) — called inside the tx.
 */
function applyOpeningChange(db, body, user, { audit } = {}) {
  if (!canEdit(user, db)) throw posErr('E_PERMISSION', 403, 'برای اصلاح موجودی اول دوره مجوز «موجودی اول دوره: ویرایش» لازم است');
  const b = body || {};
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (reason.length < REASON_MIN) throw posErr('E_OPENING_REASON_REQUIRED', 400, `علت اصلاح الزامی است (حداقل ${REASON_MIN} نویسه)`);
  if (!isConfirmed(b.confirm)) throw posErr('E_OPENING_CONFIRM_REQUIRED', 400, 'برای ثبت اصلاحیه تأیید صریح (confirm: true) الزامی است');
  const L = require('./ledger');
  const uid = user ? user.id : null;
  let out;
  db.transaction(() => {
    const { plan, ctx } = buildPlan(db, b, user, { readOnly: false });
    if (!plan.ready) {
      const e0 = plan.errors[0] || { code: 'E_OPENING_NOT_READY', status: 409, error: 'اصلاحیه قابل اجرا نیست' };
      throw posErr(e0.code, e0.status || 409, e0.error, { errors: plan.errors, warnings: plan.warnings });
    }
    const { p, fy } = ctx;

    if (plan.mode === 'create') {
      require('./opening-guard').assertNoLiveOpening(db, { productId: p.productId, warehouseId: p.warehouseId, variantId: p.variantId, fiscalYearId: fy.fiscalYearId });
      const doc = require('./opening-stock').createDraft(db, {
        note: `موجودی اول دوره از کارت کالا — ${reason}`.slice(0, 300),
        lines: [{ product_id: p.productId, warehouse_id: p.warehouseId, variant_id: p.variantId, qty: p.qty, unit_cost_rial: p.unitCost }],
      }, user);
      out = { ok: true, mode: 'create', draft_doc: { id: doc.id, doc_no: doc.doc_no, status: doc.status }, plan };
      if (typeof audit === 'function') {
        audit(uid, 'opening_stock_create_draft', 'opening_stock_doc', doc.id, JSON.stringify({
          reason, product_id: p.productId, warehouse_id: p.warehouseId, variant_id: p.variantId, qty: p.qty, unit_cost_rial: p.unitCost, doc_no: doc.doc_no,
        }));
      }
      return;
    }

    const now = "datetime('now')";
    // ensure the product_opening_stock row (source_id of the new kardex row)
    let pos = ctx.pos;
    const oldPos = pos ? { ...pos } : null;
    if (!pos) {
      const k = ctx.keep;
      const id = db.prepare(`
        INSERT INTO product_opening_stock (fiscal_year_id, product_id, variant_id, warehouse_id, qty, unit_cost_rial, value_rial,
          ledger_id, je_id, status, source, candidate_ledger_ids, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,'correction',?,?)
      `).run(fy.fiscalYearId, p.productId, p.variantId, p.warehouseId,
        k ? round3(k.qty_in) : 0, k ? rial(k.unit_cost_rial) : 0, k ? rial(k.amount_rial) : 0,
        k ? k.id : null, k ? (k.je_id || null) : null,
        ctx.ledger.length > 1 ? 'needs_review' : (k && k.je_id ? 'ok' : 'no_je'),
        ctx.ledger.length > 1 ? JSON.stringify(ctx.ledger.map((r) => r.id)) : null, uid).lastInsertRowid;
      pos = db.prepare('SELECT * FROM product_opening_stock WHERE id=?').get(id);
    }
    const note = `اصلاحیهٔ موجودی اول دوره #${pos.id} — ${reason}`.slice(0, 300);
    const voided = [];
    const reversedJe = [];
    const counterJe = [];
    let docLine = 0;
    const handleJe = (row) => {
      const ja = ctx.jeActions.get(row.id);
      if (!ja || ja.je_action === 'none') return;
      if (ja.je_action === 'reverse') {
        require('../void-journal').reverseJournalEntry(db, ja.je_id, { userId: uid, reason: note });
        reversedJe.push({ je_id: ja.je_id, for_ledger_id: row.id });
      } else {
        const cid = postCounterJe(db, { row, ja, date: row.date || fy.date || require('../../jalali').todayJalali(), user, reason });
        counterJe.push({ je_id: cid, counters_je_id: ja.je_id, for_ledger_id: row.id, amount_rial: rial(row.amount_rial) });
      }
    };
    for (const r of ctx.voidRows) {
      const rev = L.reverseInventoryMovement(db, r.id, { createdBy: uid, note, skipStock: true });
      docLine = Math.max(docLine, Number(rev.id) || 0);
      voided.push({ ledger_id: r.id, reversal_id: Number(rev.id), qty: round3(r.qty_in), amount_rial: rial(r.amount_rial), je_id: r.je_id || null, kind: 'opening' });
      handleJe(r);
    }
    for (const a of ctx.adjRows) {
      const rev = L.reverseInventoryMovement(db, a.id, { createdBy: uid, note, skipStock: true });
      docLine = Math.max(docLine, Number(rev.id) || 0);
      voided.push({ ledger_id: a.id, reversal_id: Number(rev.id), qty: round3(a.qty_out), amount_rial: rial(a.amount_rial), je_id: a.je_id || null, kind: 'stock_reconcile' });
      handleJe(a);
    }

    let newLedgerId = null;
    let newJeId = null;
    if (ctx.newRow) {
      const date = fy.date || require('../../jalali').todayJalali();
      require('./period-lock').assertPeriodOpen(db, date, 'موجودی اول دوره');
      const led = L.postInventoryMovement(db, {
        eventType: 'opening',
        productId: p.productId,
        warehouseId: p.warehouseId,
        variantId: p.variantId,
        qtyIn: plan.target.qty,
        unitCostRial: plan.target.unit_cost_rial,
        amountRial: plan.target.value_rial,
        sourceType: SOURCE_TYPE,
        sourceId: pos.id,
        date,
        note,
        createdBy: uid,
        skipStock: true,
      });
      newLedgerId = Number(led.id);
      docLine = Math.max(docLine, newLedgerId);
      const inv = invAccount(db, p.warehouseId, false);
      const op = openingAccount(db);
      const { postToLedger } = require('../ledger');
      const { rialToLedger } = require('../money');
      const amt = rial(led.amount_rial);
      newJeId = postToLedger(db, {
        sourceType: SOURCE_TYPE,
        sourceId: pos.id,
        date,
        description: `موجودی اول دوره (اصلاحیه) — ${p.product.name} — ${reason}`.slice(0, 500),
        createdBy: uid,
        voucherType: 'opening',
        skipCcPolicy: true,
        lines: [
          { code: inv.code, name: inv.name, debit: rialToLedger(amt), credit: 0 },
          { code: op.code, name: op.name, debit: 0, credit: rialToLedger(amt) },
        ],
      });
      db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=?').run(newJeId, newLedgerId);
    }

    // stock caches follow the net kardex delta (all kardex rows above are ledger-only)
    const qtyDelta = plan.qty_delta;
    if (Math.abs(qtyDelta) > EPS) {
      L.applyStockDelta(db, { productId: p.productId, warehouseId: p.warehouseId, qtyDelta });
      try {
        db.prepare('INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)').run(p.productId, uid || 0, qtyDelta, note);
      } catch (_) { /* legacy stock_logs optional */ }
      if (p.variantId) {
        require('./movement').postVariantLayer(db, {
          productId: p.productId, variantId: p.variantId, warehouseId: p.warehouseId, qtyDelta,
          docType: SOURCE_TYPE, docId: pos.id, docLine, userId: uid, note,
        });
      }
    }

    // product_opening_stock row
    const kept = !ctx.newRow && ctx.keep && !ctx.voidRows.some((r) => r.id === ctx.keep.id) ? ctx.keep : null;
    let status;
    let fields;
    if (ctx.newRow) {
      status = 'ok';
      fields = { qty: plan.target.qty, unit: plan.target.unit_cost_rial, value: plan.target.value_rial, ledger: newLedgerId, je: newJeId };
    } else if (kept) {
      status = kept.je_id ? 'ok' : 'no_je';
      fields = { qty: round3(kept.qty_in), unit: rial(kept.unit_cost_rial), value: rial(kept.amount_rial), ledger: kept.id, je: kept.je_id || null };
    } else {
      status = 'void';
      fields = { qty: 0, unit: 0, value: 0, ledger: null, je: null };
    }
    const resolved = plan.mode === 'resolve';
    db.prepare(`
      UPDATE product_opening_stock SET qty=?, unit_cost_rial=?, value_rial=?, ledger_id=?, je_id=?, status=?,
        candidate_ledger_ids=NULL, note=?, updated_by=?, updated_at=${now}, version=COALESCE(version,1)+1
        ${resolved ? `, reviewed_by=?, reviewed_at=${now}` : ''}
      WHERE id=?
    `).run(fields.qty, fields.unit, fields.value, fields.ledger, fields.je, status, note.slice(0, 300), uid,
      ...(resolved ? [uid] : []), pos.id);
    const newPos = db.prepare('SELECT * FROM product_opening_stock WHERE id=?').get(pos.id);

    // invariant: kardex combo moved exactly as planned
    const kAfter = kardexCombo(db, p.productId, p.warehouseId, p.variantId);
    if (Math.abs(kAfter.qty - plan.kardex_after.qty) > 1e-6) {
      throw posErr('E_OPENING_INVARIANT', 500, 'مقدار کاردکس پس از اصلاحیه با پیش‌نمایش برابر نیست', { expected: plan.kardex_after, actual: kAfter });
    }

    out = {
      ok: true,
      mode: plan.mode,
      reason,
      product_opening_stock: posRowView(db, newPos, true),
      voided_ledger: voided,
      reversed_je: reversedJe,
      counter_je: counterJe,
      new_ledger_id: newLedgerId,
      new_je_id: newJeId,
      qty_delta: qtyDelta,
      residual_qty: plan.residual_qty,
      kardex: { before: plan.kardex_before, after: kAfter },
      warehouse_stock: plan.warehouse_stock,
      warnings: plan.warnings,
    };
    if (typeof audit === 'function') {
      audit(uid, plan.mode === 'resolve' ? 'opening_stock_resolve' : 'opening_stock_correct', 'product_opening_stock', pos.id, JSON.stringify({
        reason,
        confirm: true,
        product_id: p.productId, warehouse_id: p.warehouseId, variant_id: p.variantId,
        old: oldPos ? { qty: oldPos.qty, unit_cost_rial: oldPos.unit_cost_rial, value_rial: oldPos.value_rial, ledger_id: oldPos.ledger_id, je_id: oldPos.je_id, status: oldPos.status, candidate_ledger_ids: oldPos.candidate_ledger_ids } : null,
        new: { qty: newPos.qty, unit_cost_rial: newPos.unit_cost_rial, value_rial: newPos.value_rial, ledger_id: newPos.ledger_id, je_id: newPos.je_id, status: newPos.status },
        voided_ledger: voided,
        reversed_je: reversedJe,
        counter_je: counterJe,
        new_ledger_id: newLedgerId,
        new_je_id: newJeId,
        qty_delta: qtyDelta,
        residual_qty: plan.residual_qty,
        kardex_before: plan.kardex_before,
        kardex_after: kAfter,
      }));
    }
  })();
  return out;
}

module.exports = {
  SOURCE_TYPE,
  COUNTER_SOURCE,
  PERM,
  REASON_MIN,
  MIGRATE_MARKER,
  MIGRATE_ENABLE_KEY,
  SCHEMA_SQL,
  ensureSchema,
  canView,
  canEdit,
  canSeeCost,
  migrateProductOpeningStock,
  bootMigrationWanted,
  recordFromOpeningDoc,
  voidFromOpeningDoc,
  getProductOpening,
  listOpeningIssues,
  planOpeningChange,
  applyOpeningChange,
  kardexCombo,
};
