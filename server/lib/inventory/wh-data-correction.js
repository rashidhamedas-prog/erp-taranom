'use strict';
/**
 * اصلاح دادهٔ انبار (فازهای B/C/D) — کاردکس منبع حقیقت مقدار است.
 * هیچ DELETE روی inventory_ledger و هیچ UPDATE روی journal_entries/journal_lines انجام نمی‌شود.
 * ارزش سرستون (average_cost_rial) و مبلغ ردیف‌های موجود کاردکس عوض نمی‌شود.
 * سند حسابداری فقط به‌صورت پیش‌نویس در voucher_drafts ساخته می‌شود.
 */

const { computeLayerReconcile, LEDGER_LIVE_SQL, QTY_EPS, VALUE_TOL_RIAL } = require('./layer-reconcile');

const SYNC_ASSESSMENT = [
  'همگام‌سازی مقدار قدیمی را روی warehouse_stock / variant_warehouse_stock بازنویسی نمی‌کند.',
  'routes/sync.js ردیف جدول را از کلاینت نمی‌پذیرد؛ push فقط بازپخش API است و pull از مرکز به دستگاه است.',
  'قفل نسخه فقط برای مسیرهایی است که شناسهٔ عددی تکی دارند. موجودی انبار کلید مرکب product_id:warehouse_id دارد و از این مسیر آپدیت مطلق نمی‌گیرد.',
  'تنها باقی‌مانده: اگر دستگاه عملیات کاربریِ در صف (مثلاً ویرایش کالا از اکسل با موجودی مطلق) داشته باشد، همان عملیات مثل هر سند دیگری بازپخش می‌شود. این بازنویسی خاموشِ ردیف موجودی نیست.',
].join(' ');

const WH_MOVE_DOC_TYPES = ['wh_receipt', 'wh_issue', 'wh_transfer_out', 'wh_transfer_in'];
const INVENTORY_COA_KEYS = [
  'coa_inventory', 'coa_finished_goods', 'coa_raw_materials', 'coa_packaging_materials',
  'coa_wip', 'coa_scrap_inventory', 'coa_subcontract_inventory', 'coa_inventory_in_transit',
];

function ensureWhDataCorrections(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wh_data_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      rule TEXT NOT NULL,
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      col TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_whfix_run ON wh_data_corrections(run_id);
    CREATE INDEX IF NOT EXISTS idx_whfix_row ON wh_data_corrections(tbl, row_key, col);
  `);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function colSet(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); }
  catch (_) { return new Set(); }
}
function n(v) { return Number(v) || 0; }
function near(a, b) { return Math.abs(n(a) - n(b)) <= QTY_EPS; }
function nearInt(v) { return Math.abs(n(v) - Math.round(n(v))) <= 1e-6; }
function qtyKey(v) { return String(Math.round(n(v) * 1e6) / 1e6); }
function stop(msg) {
  const e = new Error(msg);
  e.code = 'WHFIX_STOP';
  return e;
}

function journalFingerprint(db) {
  const parts = [];
  for (const tbl of ['journal_entries', 'journal_lines']) {
    if (!tableExists(db, tbl)) { parts.push(tbl + ':missing'); continue; }
    const cols = colSet(db, tbl);
    const seq = cols.has('sync_seq') ? 'COALESCE(MAX(sync_seq),0)' : '0';
    const row = db.prepare(`SELECT COUNT(*) c, COALESCE(MAX(id),0) m, ${seq} s FROM ${tbl}`).get();
    parts.push(`${tbl}:${row.c}:${row.m}:${row.s}`);
  }
  return parts.join('|');
}

function snapshotAvgs(db) {
  if (!colSet(db, 'products').has('average_cost_rial')) return new Map();
  return new Map(db.prepare('SELECT id, average_cost_rial FROM products').all().map((p) => [p.id, p.average_cost_rial]));
}
function restoreAvgs(db, snap) {
  if (!snap || !snap.size) return;
  const upd = db.prepare('UPDATE products SET average_cost_rial=? WHERE id=? AND average_cost_rial IS NOT ?');
  for (const [id, avg] of snap) upd.run(avg, id, avg);
}

function ledgerTombstones(db) {
  if (!tableExists(db, 'sync_tombstones')) return 0;
  return db.prepare("SELECT COUNT(*) c FROM sync_tombstones WHERE tbl='inventory_ledger'").get().c;
}

class DryRollback extends Error {
  constructor() { super('dry-run rollback'); this.code = 'DRY_ROLLBACK'; }
}

function runCorrection(db, opts) {
  ensureWhDataCorrections(db);
  const mode = opts.mode || 'dry-run';
  let out;
  const txn = db.transaction(() => {
    const fp0 = journalFingerprint(db);
    const tombs0 = ledgerTombstones(db);
    const avgs = snapshotAvgs(db);
    out = execute(db, opts);
    restoreAvgs(db, avgs);
    if (journalFingerprint(db) !== fp0) throw stop('STOP: سند حسابداری (journal) در این اجرا تغییر کرد');
    if (ledgerTombstones(db) !== tombs0) throw stop('STOP: tombstone کاردکس ساخته شد — حذف ممنوع است');
    if (opts.expectMaxChanges != null && out.changes.length > Number(opts.expectMaxChanges)) {
      throw stop(`STOP: تعداد تغییر ${out.changes.length} از آستانه ${opts.expectMaxChanges} بیشتر است`);
    }
    if (opts.expectSummary) {
      const bad = summaryMismatch(out.summaryAfter, opts.expectSummary);
      if (bad) throw stop('STOP: خلاصهٔ پس از اصلاح با sandbox یکی نیست: ' + bad);
    }
    if (mode === 'dry-run') throw new DryRollback();
  });
  try { txn.immediate(); }
  catch (e) {
    if (e && e.code === 'DRY_ROLLBACK') return out;
    throw e;
  }
  return out;
}

function summaryMismatch(after, expected) {
  const a = after || {};
  const b = expected.summary || expected;
  const keys = Object.keys(b).filter((k) => typeof b[k] === 'number');
  for (const k of keys) {
    if (Number(a[k]) !== Number(b[k])) return `${k}: after=${a[k]} expected=${b[k]}`;
  }
  return '';
}

function execute(db, opts) {
  const phase = String(opts.phase || '').toUpperCase();
  if (!['B', 'C', 'D'].includes(phase)) throw stop('STOP: فاز باید B یا C یا D باشد');
  const ctx = {
    db,
    phase,
    runId: opts.runId || `whfix-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    userId: opts.createdBy || null,
    changes: [],
    ambiguous: [],
    negativeAfter: [],
    pendingPhaseC: [],
    drafts: [],
    revaluation: [],
    xwhNote: '',
  };
  const before = computeLayerReconcile(db, {});
  const extraBefore = extraCounts(db);
  if (phase === 'B') {
    neutralizeExactOpenings(ctx);
    rebuildQuantities(ctx, null);
  } else if (phase === 'C') {
    const pending = productsWithNullWarehouse(db);
    fillLedgerWarehouses(ctx);
    fillMoveVariants(ctx);
    if (pending.length) rebuildQuantities(ctx, new Set(pending));
  } else {
    buildRevaluation(ctx);
    buildVoucherDrafts(ctx, opts);
  }
  const after = computeLayerReconcile(db, {});
  const extraAfter = extraCounts(db);
  if (ctx.changes.length) writeAudit(ctx);
  return {
    runId: ctx.runId,
    phase,
    changes: ctx.changes,
    ambiguous: ctx.ambiguous,
    negativeAfter: ctx.negativeAfter,
    pendingPhaseC: ctx.pendingPhaseC,
    drafts: ctx.drafts,
    revaluation: ctx.revaluation,
    summaryBefore: Object.assign({}, before.summary, extraBefore),
    summaryAfter: Object.assign({}, after.summary, extraAfter),
    xwhNote: ctx.xwhNote,
    syncAssessment: SYNC_ASSESSMENT,
  };
}

function logChange(ctx, rec) {
  ctx.changes.push(rec);
  ctx.db.prepare(`
    INSERT INTO wh_data_corrections (run_id, phase, rule, tbl, row_key, col, old_value, new_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    ctx.runId, ctx.phase, rec.rule, rec.tbl, String(rec.row_key), rec.col,
    rec.old_value == null ? null : String(rec.old_value),
    rec.new_value == null ? null : String(rec.new_value),
    rec.reason || ''
  );
}
function alreadyDone(db, rule, rowKey) {
  return !!db.prepare('SELECT 1 FROM wh_data_corrections WHERE rule=? AND row_key=? LIMIT 1').get(rule, String(rowKey));
}
function writeAudit(ctx) {
  if (!tableExists(ctx.db, 'audit_log')) return;
  ctx.db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
    VALUES (?,?,?,?,?)
  `).run(
    ctx.userId || null, 'wh_data_correction', 'wh_data_corrections', null,
    JSON.stringify({ run_id: ctx.runId, phase: ctx.phase, changes: ctx.changes.length })
  );
}

function liveOpenings(db) {
  return db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL}
      AND (event_type='opening' OR source_type='opening_inventory')
    ORDER BY id
  `).all();
}

function neutralizeExactOpenings(ctx) {
  const db = ctx.db;
  const groups = new Map();
  for (const row of liveOpenings(db)) {
    const key = [
      row.product_id,
      row.warehouse_id == null ? '∅' : row.warehouse_id,
      qtyKey(row.qty_in),
      Math.round(n(row.unit_cost_rial)),
      Math.round(n(row.amount_rial)),
      String(row.date || ''),
      row.je_id == null ? '∅' : row.je_id,
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const { reverseInventoryMovement } = require('./ledger');
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.id - b.id);
    for (const row of rows.slice(1)) {
      if (alreadyDone(db, 'dup_opening_exact', row.id)) continue;
      if (tableExists(db, 'inventory_value_approval_lines')) {
        const hit = db.prepare('SELECT 1 FROM inventory_value_approval_lines WHERE ledger_ref_id=? LIMIT 1').get(row.id);
        if (hit) {
          ctx.ambiguous.push({
            rule: 'dup_opening_has_value_approval', product_id: row.product_id,
            warehouse_id: row.warehouse_id, row_key: row.id,
            detail: 'opening به تأیید بها وصل است؛ خنثی‌سازی خودکار متوقف شد',
          });
          continue;
        }
      }
      const note = `خنثی‌سازی opening تکراری دقیق — run ${ctx.runId} — ledger#${row.id}`;
      const rev = reverseInventoryMovement(db, row.id, { createdBy: ctx.userId, note, date: row.date });
      db.prepare("UPDATE inventory_ledger SET source_type='wh_data_correction' WHERE id=?").run(rev.id);
      logChange(ctx, {
        rule: 'dup_opening_exact', tbl: 'inventory_ledger', row_key: row.id, col: 'status',
        old_value: 'posted', new_value: `reversed+ledger#${rev.id}`,
        reason: 'opening تکراری دقیق؛ کوچک‌ترین id ماند و این ردیف با برگشت سند خنثی شد',
      });
    }
  }
  const left = new Map();
  for (const row of liveOpenings(db)) {
    const k = `${row.product_id}:${row.warehouse_id == null ? '∅' : row.warehouse_id}`;
    if (!left.has(k)) left.set(k, []);
    left.get(k).push(row);
  }
  for (const [k, rows] of left) {
    if (rows.length < 2) continue;
    ctx.ambiguous.push({
      rule: 'dup_opening_nonidentical',
      product_id: rows[0].product_id,
      warehouse_id: rows[0].warehouse_id,
      row_key: k,
      detail: rows.map((r) => `#${r.id} qty=${r.qty_in} amount=${r.amount_rial} je=${r.je_id}`).join(' | '),
    });
  }
}

function productsWithNullWarehouse(db) {
  const rows = db.prepare(`
    SELECT DISTINCT product_id FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL} AND warehouse_id IS NULL
      AND (ABS(COALESCE(qty_in,0))+ABS(COALESCE(qty_out,0))>${QTY_EPS} OR ABS(COALESCE(amount_rial,0))>${VALUE_TOL_RIAL})
  `).all();
  return rows.map((r) => r.product_id);
}

function rebuildQuantities(ctx, onlyProductIds) {
  const db = ctx.db;
  const allow = (pid) => !onlyProductIds || onlyProductIds.has(pid);
  const pending = new Set(productsWithNullWarehouse(db));
  for (const pid of pending) {
    if (allow(pid)) ctx.pendingPhaseC.push(pid);
  }

  const ledgerPairs = new Map();
  for (const r of db.prepare(`
    SELECT product_id, warehouse_id,
           SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)) qty
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL} AND warehouse_id IS NOT NULL
    GROUP BY product_id, warehouse_id
  `).all()) {
    if (!allow(r.product_id)) continue;
    ledgerPairs.set(`${r.product_id}:${r.warehouse_id}`, { product_id: r.product_id, warehouse_id: r.warehouse_id, qty: n(r.qty) });
  }

  const ambiguousPairs = new Set();
  const ambiguousProducts = new Set();
  if (tableExists(db, 'warehouse_stock')) {
    for (const r of db.prepare('SELECT product_id, warehouse_id, qty FROM warehouse_stock').all()) {
      if (!allow(r.product_id)) continue;
      const k = `${r.product_id}:${r.warehouse_id}`;
      if (!ledgerPairs.has(k) && Math.abs(n(r.qty)) > QTY_EPS) {
        ambiguousPairs.add(k);
        ambiguousProducts.add(r.product_id);
        ctx.ambiguous.push({
          rule: 'ws_without_kardex', product_id: r.product_id, warehouse_id: r.warehouse_id,
          row_key: k, detail: `ws=${r.qty} بدون ردیف کاردکس؛ صفر نشد`,
        });
      }
    }
  }

  for (const pair of ledgerPairs.values()) {
    const k = `${pair.product_id}:${pair.warehouse_id}`;
    if (ambiguousPairs.has(k)) continue;
    if (!nearInt(pair.qty)) {
      ambiguousPairs.add(k);
      ambiguousProducts.add(pair.product_id);
      ctx.ambiguous.push({
        rule: 'non_integer_ledger_qty', product_id: pair.product_id, warehouse_id: pair.warehouse_id,
        row_key: k, detail: `جمع کاردکس ${pair.qty} عدد صحیح نیست`,
      });
      continue;
    }
    setWs(ctx, pair.product_id, pair.warehouse_id, Math.round(pair.qty));
    if (pair.qty < -QTY_EPS) {
      ctx.negativeAfter.push({
        product_id: pair.product_id, warehouse_id: pair.warehouse_id, qty: Math.round(pair.qty),
        detail: 'کاردکس منفی است؛ مقدار منفی ماند',
      });
    }
  }

  applyVws(ctx, ledgerPairs, ambiguousPairs, ambiguousProducts, allow);
  listDefaultVariantOnMatrix(ctx, allow);
  applyVariantStock(ctx, ambiguousPairs, allow);
  applyHeaderStock(ctx, pending, ambiguousProducts, allow);
}

function setWs(ctx, productId, warehouseId, qty) {
  const db = ctx.db;
  const row = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId);
  const old = row ? n(row.qty) : null;
  if (old != null && near(old, qty)) return;
  if (old == null && Math.abs(qty) <= QTY_EPS) return;
  if (row) db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?').run(qty, productId, warehouseId);
  else db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(productId, warehouseId, qty);
  logChange(ctx, {
    rule: 'ws_from_ledger', tbl: 'warehouse_stock', row_key: `${productId}:${warehouseId}`, col: 'qty',
    old_value: old, new_value: qty, reason: 'موجودی انبار = جمع کاردکس زنده',
  });
}

function variantMeta(db, productId) {
  if (!tableExists(db, 'product_variants')) return { matrix: false, defaultId: null };
  const cols = colSet(db, 'product_variants');
  const active = cols.has('active') ? 'AND COALESCE(active,1)=1' : '';
  const rows = db.prepare(`SELECT id FROM product_variants WHERE product_id=? ${active}`).all(productId);
  let defaults = [];
  if (cols.has('is_default')) {
    defaults = db.prepare(`SELECT id FROM product_variants WHERE product_id=? ${active} AND COALESCE(is_default,0)=1`).all(productId);
  }
  const matrixN = cols.has('is_default')
    ? db.prepare(`SELECT COUNT(*) c FROM product_variants WHERE product_id=? ${active} AND COALESCE(is_default,0)=0`).get(productId).c
    : (rows.length > 1 ? rows.length : 0);
  let defaultId = null;
  if (!matrixN) {
    if (defaults.length === 1) defaultId = defaults[0].id;
    else if (rows.length === 1) defaultId = rows[0].id;
  }
  return { matrix: matrixN > 0, defaultId, defaultIds: defaults.map((d) => d.id) };
}

function vwsQtyMap(db, productId, warehouseId) {
  if (!tableExists(db, 'variant_warehouse_stock') || !tableExists(db, 'product_variants')) return new Map();
  const rows = db.prepare(`
    SELECT v.variant_id, v.qty
    FROM variant_warehouse_stock v
    JOIN product_variants pv ON pv.id=v.variant_id
    WHERE pv.product_id=? AND v.warehouse_id=?
  `).all(productId, warehouseId);
  return new Map(rows.map((r) => [r.variant_id, n(r.qty)]));
}

function setVws(ctx, variantId, warehouseId, qty, rule, reason) {
  const db = ctx.db;
  const row = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(variantId, warehouseId);
  const old = row ? n(row.qty) : null;
  if (old != null && near(old, qty)) return;
  if (old == null && Math.abs(qty) <= QTY_EPS) return;
  if (!nearInt(qty)) {
    ctx.ambiguous.push({
      rule: 'non_integer_vws', row_key: `${variantId}:${warehouseId}`, detail: `هدف ${qty}`,
    });
    return;
  }
  const q = Math.round(qty);
  if (row) db.prepare('UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?').run(q, variantId, warehouseId);
  else db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(variantId, warehouseId, q);
  logChange(ctx, {
    rule, tbl: 'variant_warehouse_stock', row_key: `${variantId}:${warehouseId}`, col: 'qty',
    old_value: old, new_value: q, reason,
  });
}

function ledgerVariantSplit(db, productId, warehouseId) {
  const cols = colSet(db, 'inventory_ledger');
  if (!cols.has('variant_id')) return { complete: false, byVariant: new Map() };
  const rows = db.prepare(`
    SELECT variant_id,
           SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)) qty,
           SUM(CASE WHEN variant_id IS NULL AND (ABS(COALESCE(qty_in,0))+ABS(COALESCE(qty_out,0))>${QTY_EPS}) THEN 1 ELSE 0 END) missing
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL} AND product_id=? AND warehouse_id=?
    GROUP BY variant_id
  `).all(productId, warehouseId);
  let missing = 0;
  const byVariant = new Map();
  for (const r of rows) {
    missing += n(r.missing);
    if (r.variant_id != null) byVariant.set(r.variant_id, n(r.qty));
  }
  return { complete: missing === 0 && byVariant.size > 0, byVariant };
}

function movementSplit(db, productId, warehouseId) {
  if (!tableExists(db, 'inventory_movements')) return null;
  const rows = db.prepare(`
    SELECT variant_id, SUM(qty_delta) qty
    FROM inventory_movements
    WHERE product_id=? AND warehouse_id=? AND variant_id IS NOT NULL
    GROUP BY variant_id
  `).all(productId, warehouseId);
  if (!rows.length) return null;
  const byVariant = new Map(rows.map((r) => [r.variant_id, n(r.qty)]));
  let sum = 0;
  for (const q of byVariant.values()) sum += q;
  return { byVariant, sum };
}

function applyTargets(ctx, warehouseId, byVariant, current, rule, reason) {
  const seen = new Set();
  for (const [vid, qty] of byVariant) {
    seen.add(vid);
    setVws(ctx, vid, warehouseId, qty, rule, reason);
  }
  for (const [vid, qty] of current) {
    if (!seen.has(vid) && Math.abs(qty) > QTY_EPS) setVws(ctx, vid, warehouseId, 0, rule, reason);
  }
}

function applyVws(ctx, ledgerPairs, ambiguousPairs, ambiguousProducts, allow) {
  const db = ctx.db;
  if (!tableExists(db, 'variant_warehouse_stock')) return;
  for (const pair of ledgerPairs.values()) {
    if (!allow(pair.product_id)) continue;
    const k = `${pair.product_id}:${pair.warehouse_id}`;
    if (ambiguousPairs.has(k)) continue;
    const meta = variantMeta(db, pair.product_id);
    const current = vwsQtyMap(db, pair.product_id, pair.warehouse_id);
    const split = ledgerVariantSplit(db, pair.product_id, pair.warehouse_id);
    if (split.complete) {
      applyTargets(ctx, pair.warehouse_id, split.byVariant, current, 'vws_from_ledger_variant', 'تفکیک واریانت از کاردکس کامل است');
      continue;
    }
    if (!meta.matrix) {
      if (!meta.defaultId) {
        if (current.size) {
          ambiguousPairs.add(k);
          ambiguousProducts.add(pair.product_id);
          ctx.ambiguous.push({ rule: 'vws_no_default_variant', product_id: pair.product_id, warehouse_id: pair.warehouse_id, row_key: k, detail: 'کالای غیرماتریسی واریانت پیش‌فرض یکتا ندارد' });
        }
        continue;
      }
      const others = [...current.entries()].filter(([vid, qty]) => vid !== meta.defaultId && Math.abs(qty) > QTY_EPS);
      if (others.length) {
        ambiguousPairs.add(k);
        ambiguousProducts.add(pair.product_id);
        ctx.ambiguous.push({ rule: 'vws_extra_variant', product_id: pair.product_id, warehouse_id: pair.warehouse_id, row_key: k, detail: 'واریانت غیرپیش‌فرض موجودی دارد' });
        continue;
      }
      setVws(ctx, meta.defaultId, pair.warehouse_id, pair.qty, 'vws_default_variant', 'کالای غیرماتریسی: واریانت پیش‌فرض = کاردکس');
      continue;
    }
    let curSum = 0;
    for (const q of current.values()) curSum += q;
    if (near(curSum, pair.qty)) continue;
    const mov = movementSplit(db, pair.product_id, pair.warehouse_id);
    if (mov && near(mov.sum, pair.qty)) {
      applyTargets(ctx, pair.warehouse_id, mov.byVariant, current, 'vws_from_movements', 'جمع حرکات واریانت با کاردکس برابر است');
      continue;
    }
    ambiguousPairs.add(k);
    ambiguousProducts.add(pair.product_id);
    ctx.ambiguous.push({
      rule: 'vws_ambiguous', product_id: pair.product_id, warehouse_id: pair.warehouse_id, row_key: k,
      detail: `ws کاردکس=${pair.qty} جمع vws=${curSum}؛ تفکیک قطعی نیست`,
    });
    if (meta.defaultIds && meta.defaultIds.length) {
      ctx.ambiguous.push({
        rule: 'default_variant_with_stock', product_id: pair.product_id, warehouse_id: pair.warehouse_id, row_key: k,
        detail: 'انتقال موجودی واریانت پیش‌فرض روی کالای ماتریسی حدس زده نشد',
      });
    }
  }
}

function listDefaultVariantOnMatrix(ctx, allow) {
  const db = ctx.db;
  if (!tableExists(db, 'product_variants')) return;
  const cols = colSet(db, 'product_variants');
  if (!cols.has('is_default')) return;
  const rows = db.prepare(`
    SELECT pv.product_id, pv.id,
           COALESCE(pv.stock,0) stock,
           ${tableExists(db, 'variant_warehouse_stock')
             ? '(SELECT COALESCE(SUM(v.qty),0) FROM variant_warehouse_stock v WHERE v.variant_id=pv.id)'
             : '0'} vws
    FROM product_variants pv
    WHERE COALESCE(pv.is_default,0)=1
      AND EXISTS (
        SELECT 1 FROM product_variants m
        WHERE m.product_id=pv.product_id AND COALESCE(m.is_default,0)=0
      )
  `).all();
  for (const r of rows) {
    if (!allow(r.product_id)) continue;
    if (Math.abs(n(r.stock)) <= QTY_EPS && Math.abs(n(r.vws)) <= QTY_EPS) continue;
    ctx.ambiguous.push({
      rule: 'default_variant_with_stock', product_id: r.product_id, row_key: r.id,
      detail: `واریانت پیش‌فرض stock=${r.stock} vws=${r.vws}؛ انتقال به ماتریس حدس زده نشد`,
    });
  }
}

function applyVariantStock(ctx, ambiguousPairs, allow) {
  const db = ctx.db;
  if (!tableExists(db, 'product_variants') || !tableExists(db, 'variant_warehouse_stock')) return;
  const ambProducts = new Set();
  for (const k of ambiguousPairs) ambProducts.add(Number(k.split(':')[0]));
  const rows = db.prepare(`
    SELECT pv.id, pv.product_id, COALESCE(pv.stock,0) stock,
           (SELECT COALESCE(SUM(v.qty),0) FROM variant_warehouse_stock v WHERE v.variant_id=pv.id) vws
    FROM product_variants pv
  `).all();
  for (const r of rows) {
    if (!allow(r.product_id)) continue;
    if (ambProducts.has(r.product_id)) continue;
    if (!nearInt(r.vws)) continue;
    const q = Math.round(n(r.vws));
    if (near(r.stock, q)) continue;
    db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(q, r.id);
    logChange(ctx, {
      rule: 'pv_from_vws', tbl: 'product_variants', row_key: r.id, col: 'stock',
      old_value: r.stock, new_value: q, reason: 'موجودی واریانت = جمع انبارهای همان واریانت',
    });
  }
}

function applyHeaderStock(ctx, pending, ambiguousProducts, allow) {
  const db = ctx.db;
  if (!colSet(db, 'products').has('stock') || !tableExists(db, 'warehouse_stock')) return;
  const sums = new Map();
  for (const r of db.prepare('SELECT product_id, SUM(qty) qty FROM warehouse_stock GROUP BY product_id').all()) {
    sums.set(r.product_id, n(r.qty));
  }
  for (const p of db.prepare('SELECT id, stock FROM products').all()) {
    if (!allow(p.id)) continue;
    if (pending.has(p.id) || ambiguousProducts.has(p.id)) continue;
    if (!sums.has(p.id)) continue;
    const qRaw = sums.get(p.id);
    if (!nearInt(qRaw)) continue;
    const q = Math.round(qRaw);
    if (near(p.stock, q)) continue;
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(q, p.id);
    logChange(ctx, {
      rule: 'header_from_ws', tbl: 'products', row_key: p.id, col: 'stock',
      old_value: p.stock, new_value: q, reason: 'سرستون کالا = جمع موجودی انبارها',
    });
  }
}

function parseJson(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function uniqueIds(ids) {
  return [...new Set(ids.map((x) => Number(x)).filter((x) => x > 0))];
}

function returnWarehouses(db, sourceId, productId) {
  if (!tableExists(db, 'sales_returns') || !sourceId) return [];
  const sr = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(sourceId);
  if (!sr) return [];
  if (sr.warehouse_id) return [Number(sr.warehouse_id)];
  const rows = parseJson(sr.rows).filter((r) => !productId || Number(r.product_id) === Number(productId));
  return uniqueIds(rows.map((r) => r.warehouse_id));
}
function invoiceWarehouses(db, invoiceId, productId) {
  if (!invoiceId || !tableExists(db, 'invoices')) return { lines: [], header: null };
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  if (!inv) return { lines: [], header: null };
  const rows = parseJson(inv.rows).filter((r) => !productId || Number(r.product_id) === Number(productId));
  return { lines: uniqueIds(rows.map((r) => r.warehouse_id)), header: inv.warehouse_id ? Number(inv.warehouse_id) : null };
}

function fillLedgerWarehouses(ctx) {
  const db = ctx.db;
  const rows = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL} AND warehouse_id IS NULL
    ORDER BY CASE WHEN COALESCE(event_type,'')='reversal' OR COALESCE(event_type,'') GLOB '*_reversal' THEN 1 ELSE 0 END, id
  `).all();
  for (const row of rows) {
    if (alreadyDone(db, 'ledger_warehouse_fill', row.id)) continue;
    const wh = resolveLedgerWarehouse(db, row);
    if (!wh || wh.length !== 1) {
      ctx.ambiguous.push({
        rule: 'ledger_warehouse_ambiguous', product_id: row.product_id, row_key: row.id,
        detail: !wh || !wh.length ? 'هیچ انبار قطعی' : `چند انبار: ${wh.join(',')}`,
      });
      continue;
    }
    db.prepare('UPDATE inventory_ledger SET warehouse_id=? WHERE id=? AND warehouse_id IS NULL').run(wh[0], row.id);
    logChange(ctx, {
      rule: 'ledger_warehouse_fill', tbl: 'inventory_ledger', row_key: row.id, col: 'warehouse_id',
      old_value: null, new_value: wh[0], reason: 'انبار قطعی برگشت فروش / فاکتور / ردیف معکوس‌شده',
    });
  }
}

function resolveLedgerWarehouse(db, row) {
  const src = String(row.source_type || '');
  const isReversal = String(row.event_type || '') === 'reversal' || String(row.event_type || '').endsWith('_reversal');
  if (!isReversal && src === 'sales_return') {
    const fromRet = returnWarehouses(db, row.source_id, row.product_id);
    if (fromRet.length === 1) return fromRet;
    if (fromRet.length > 1) return fromRet;
    const sr = tableExists(db, 'sales_returns') && row.source_id
      ? db.prepare('SELECT invoice_id FROM sales_returns WHERE id=?').get(row.source_id) : null;
    const inv = invoiceWarehouses(db, sr && sr.invoice_id, row.product_id);
    if (inv.lines.length === 1) return inv.lines;
    if (inv.header) return [inv.header];
    return [];
  }
  if (isReversal && row.reversed_of) {
    const orig = db.prepare('SELECT warehouse_id FROM inventory_ledger WHERE id=?').get(row.reversed_of);
    if (orig && orig.warehouse_id) return [Number(orig.warehouse_id)];
  }
  if (src === 'sales_return') {
    const fromRet = returnWarehouses(db, row.source_id, row.product_id);
    if (fromRet.length === 1) return fromRet;
  }
  return [];
}

function fillMoveVariants(ctx) {
  const db = ctx.db;
  if (!tableExists(db, 'warehouse_moves')) return;
  const cols = colSet(db, 'warehouse_moves');
  if (!cols.has('variant_id')) return;
  const rows = db.prepare(`
    SELECT * FROM warehouse_moves
    WHERE variant_id IS NULL OR variant_id=0
  `).all();
  for (const move of rows) {
    if (alreadyDone(db, 'move_variant_fill', move.id)) continue;
    const found = resolveMoveVariant(db, move);
    if (!found || found.ambiguous) {
      ctx.ambiguous.push({
        rule: 'move_variant_ambiguous', product_id: move.product_id, row_key: move.id,
        detail: (found && found.detail) || 'واریانت قطعی نیست',
      });
      continue;
    }
    db.prepare('UPDATE warehouse_moves SET variant_id=? WHERE id=? AND (variant_id IS NULL OR variant_id=0)').run(found.variantId, move.id);
    logChange(ctx, {
      rule: 'move_variant_fill', tbl: 'warehouse_moves', row_key: move.id, col: 'variant_id',
      old_value: null, new_value: found.variantId, reason: found.reason,
    });
  }
}

function resolveMoveVariant(db, move) {
  const meta = variantMeta(db, move.product_id);
  if (!meta.matrix && meta.defaultId) {
    return { variantId: meta.defaultId, reason: 'کالای تک‌واریانت/غیرماتریسی — واریانت پیش‌فرض' };
  }
  if (tableExists(db, 'inventory_movements')) {
    const types = WH_MOVE_DOC_TYPES.map(() => '?').join(',');
    const movs = db.prepare(`
      SELECT variant_id, qty_delta FROM inventory_movements
      WHERE variant_id IS NOT NULL AND (
        (doc_id=? AND doc_type IN (${types}))
        OR (doc_id=? AND doc_line=? AND doc_type IN (${types}))
      )
    `).all(move.id, ...WH_MOVE_DOC_TYPES, move.doc_id || 0, move.line_no || 0, ...WH_MOVE_DOC_TYPES);
    const matched = movs.filter((m) => near(Math.abs(n(m.qty_delta)), n(move.qty)));
    const ids = uniqueIds(matched.map((m) => m.variant_id));
    if (ids.length === 1) return { variantId: ids[0], reason: 'حرکت انبار همان سند با تعداد برابر' };
    if (ids.length > 1) return { ambiguous: true, detail: 'چند واریانت در حرکات' };
  }
  const ledCols = colSet(db, 'inventory_ledger');
  if (move.ledger_id && ledCols.has('variant_id')) {
    const led = db.prepare('SELECT variant_id, qty_in, qty_out FROM inventory_ledger WHERE id=?').get(move.ledger_id);
    const q = Math.max(n(led && led.qty_in), n(led && led.qty_out));
    if (led && led.variant_id && near(q, n(move.qty))) {
      return { variantId: Number(led.variant_id), reason: 'واریانت ردیف کاردکس متصل به انتقال (فقط خواندن)' };
    }
  }
  return { ambiguous: true, detail: 'قاعدهٔ قطعی واریانت پیدا نشد' };
}

function cogsCodeSet(db) {
  const { acct } = require('../coa-map');
  const root = acct(db, 'coa_cogs');
  const codes = new Set([root.code]);
  if (tableExists(db, 'chart_of_accounts')) {
    for (const r of db.prepare('SELECT code FROM chart_of_accounts WHERE parent_code=?').all(root.code)) codes.add(r.code);
  }
  return { root, codes };
}

function postableAccount(db, code) {
  const acc = db.prepare('SELECT code, name, is_active FROM chart_of_accounts WHERE code=?').get(code);
  if (!acc || acc.is_active === 0) return null;
  const kids = db.prepare(`
    SELECT code, name FROM chart_of_accounts
    WHERE parent_code=? AND COALESCE(is_active,1)=1
  `).all(code);
  if (!kids.length) return { code: acc.code, name: acc.name };
  if (kids.length === 1) return kids[0];
  return null;
}

function invoiceCogsDiffs(db) {
  if (!tableExists(db, 'invoices') || !tableExists(db, 'journal_entries')) return [];
  const { codes } = cogsCodeSet(db);
  const jeCols = colSet(db, 'journal_entries');
  const jlCols = colSet(db, 'journal_lines');
  const acctCol = jlCols.has('account_code') ? 'account_code' : 'code';
  const jeWhere = ["ref_type IN ('invoice','invoice_cogs','sales_invoice')"];
  if (jeCols.has('deleted_at')) jeWhere.push('COALESCE(deleted_at,0)=0');
  if (jeCols.has('status')) jeWhere.push("COALESCE(status,'approved') NOT IN ('reversed','void')");
  const kardex = new Map();
  for (const r of db.prepare(`
    SELECT source_id, SUM(COALESCE(amount_rial,0)) amt
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL}
      AND source_type IN ('invoice','sale','sales_invoice')
      AND COALESCE(qty_out,0)>0
    GROUP BY source_id
  `).all()) kardex.set(r.source_id, Math.round(n(r.amt)));

  const cogs = new Map();
  const lines = db.prepare(`
    SELECT e.ref_id, l.${acctCol} AS code, l.debit, l.credit
           ${jlCols.has('debit_rial') ? ', l.debit_rial' : ', NULL AS debit_rial'}
           ${jlCols.has('credit_rial') ? ', l.credit_rial' : ', NULL AS credit_rial'}
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id=e.id
    WHERE ${jeWhere.join(' AND ')}
  `).all();
  const { jlDebitRial, jlCreditRial } = require('../money');
  for (const l of lines) {
    if (!codes.has(String(l.code || ''))) continue;
    const net = jlDebitRial(l) - jlCreditRial(l);
    cogs.set(l.ref_id, (cogs.get(l.ref_id) || 0) + net);
  }
  const ids = new Set([...kardex.keys(), ...cogs.keys()]);
  const out = [];
  for (const id of ids) {
    if (!id) continue;
    const ic = colSet(db, 'invoices');
    const inv = db.prepare(`
      SELECT id, num, date,
             ${ic.has('warehouse_id') ? 'warehouse_id' : 'NULL AS warehouse_id'},
             ${ic.has('cost_center_id') ? 'cost_center_id' : 'NULL AS cost_center_id'}
      FROM invoices WHERE id=?
    `).get(id);
    if (!inv) continue;
    const k = kardex.get(id) || 0;
    const c = Math.round(cogs.get(id) || 0);
    const diff = k - c;
    if (diff === 0) continue;
    out.push({
      invoice_id: inv.id, num: inv.num || '', date: inv.date || '',
      warehouse_id: inv.warehouse_id || null, cost_center_id: inv.cost_center_id || null,
      kardex_rial: k, cogs_rial: c, diff_rial: diff,
    });
  }
  out.sort((a, b) => a.invoice_id - b.invoice_id);
  return out;
}

function extraCounts(db) {
  let moves = 0;
  if (tableExists(db, 'warehouse_moves') && colSet(db, 'warehouse_moves').has('variant_id')) {
    moves = db.prepare('SELECT COUNT(*) c FROM warehouse_moves WHERE variant_id IS NULL OR variant_id=0').get().c;
  }
  let cogs = 0;
  try { cogs = invoiceCogsDiffs(db).length; } catch (_) { cogs = 0; }
  return { warehouse_moves_without_variant: moves, cogs_vs_kardex_invoices: cogs };
}

function inventoryCodes(db) {
  const { acct } = require('../coa-map');
  const set = new Set();
  for (const k of INVENTORY_COA_KEYS) {
    try { set.add(acct(db, k).code); } catch (_) { /* unknown on old DB */ }
  }
  return set;
}

function isHamed(user) {
  const s = `${user.username || ''} ${user.name || ''}`;
  return /hamed|rashid|حامد|رشید/i.test(s);
}
function pickServiceUser(db, explicit) {
  if (explicit) {
    const u = db.prepare('SELECT * FROM users WHERE id=? AND COALESCE(active,1)=1').get(explicit);
    if (!u) throw stop('STOP: کاربر سازندهٔ پیش‌نویس پیدا نشد');
    if (isHamed(u)) throw stop('STOP: پیش‌نویس نباید با کاربر حامد ساخته شود (maker-checker)');
    return u;
  }
  const users = db.prepare("SELECT * FROM users WHERE COALESCE(active,1)=1 AND role IN ('admin','accounting')").all();
  const named = users.find((u) => /^(service|system|tech|whfix)$/i.test(String(u.username || '')) && !isHamed(u));
  if (named) return named;
  const other = users.find((u) => !isHamed(u));
  if (!other) throw stop('STOP: کاربر فنی غیر از حامد برای ساخت پیش‌نویس پیدا نشد');
  return other;
}

function assertOpenFiscalYear(db, date) {
  if (!tableExists(db, 'fiscal_years')) throw stop('STOP: جدول سال مالی نیست');
  const open = db.prepare("SELECT * FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if (!open) throw stop('STOP: سال مالی باز پیدا نشد');
  const { assertFiscalYearWritable } = require('../fiscal-period');
  const chk = assertFiscalYearWritable(db, date);
  if (!chk.ok) throw stop('STOP: ' + chk.error);
  return open;
}

function parseXwhDiff(text) {
  const mark = '=== Summary JSON ===';
  const i = text.indexOf(mark);
  if (i < 0) return { found: false };
  let parsed;
  try { parsed = JSON.parse(text.slice(i + mark.length).trim()); }
  catch (_) { return { found: false }; }
  const inv = (parsed.cogs || []).find((r) => r.num === 'T-0015' || Number(r.invoice_id) === 15);
  if (!inv) return { found: false };
  let diff = 0;
  for (const m of inv.credit_mismatches || []) {
    diff += Math.round(n(m.expected_credit_rial)) - Math.round(n(m.actual_credit_rial));
  }
  return { found: true, diff };
}

function buildVoucherDrafts(ctx, opts) {
  const db = ctx.db;
  const { todayJalali } = require('../../jalali');
  const date = todayJalali();
  assertOpenFiscalYear(db, date);
  const user = pickServiceUser(db, opts.createdBy);
  ctx.userId = user.id;
  if (opts.xwhReport) {
    const fs = require('fs');
    const text = fs.readFileSync(opts.xwhReport, 'utf8');
    const parsed = parseXwhDiff(text);
    const row = invoiceCogsDiffs(db).find((r) => r.num === 'T-0015' || r.invoice_id === 15);
    const ours = row ? row.diff_rial : 0;
    ctx.xwhNote = `T-0015 محاسبه=${ours} گزارش=${parsed.found ? parsed.diff : 'نیست'}`;
    if (!parsed.found) throw stop('STOP: فاکتور T-0015 در گزارش xwh پیدا نشد');
    if (ours !== parsed.diff) throw stop(`STOP: اختلاف T-0015 محاسبه ${ours} با گزارش ${parsed.diff} یکی نیست`);
  }
  const { acct } = require('../coa-map');
  const { validateAndBuildVoucherLines } = require('../../routes/accounting');
  const { inventoryAccountForWarehouse } = require('./ledger');
  for (const diff of invoiceCogsDiffs(db)) {
    const key = `cogs:${diff.invoice_id}`;
    if (skipPostedDraft(ctx, 'cogs_vs_kardex', key, diff.diff_rial)) continue;
    const cogs = postableAccount(db, acct(db, 'coa_cogs').code);
    const invAcct = postableAccount(db, (diff.warehouse_id
      ? inventoryAccountForWarehouse(db, diff.warehouse_id).code
      : acct(db, 'coa_inventory').code));
    if (!cogs || !invAcct) {
      throw stop(`STOP: حساب بهای تمام‌شده یا موجودی برای فاکتور ${diff.num || diff.invoice_id} سطح پست یکتا نیست`);
    }
    const amt = Math.abs(diff.diff_rial);
    const lines = diff.diff_rial > 0
      ? [
        { code: cogs.code, debit: amt, credit: 0, description: 'بهای تمام‌شده', cost_center_id: diff.cost_center_id || null },
        { code: invAcct.code, debit: 0, credit: amt, description: 'موجودی کالا' },
      ]
      : [
        { code: invAcct.code, debit: amt, credit: 0, description: 'موجودی کالا' },
        { code: cogs.code, debit: 0, credit: amt, description: 'بهای تمام‌شده', cost_center_id: diff.cost_center_id || null },
      ];
    insertDraft(ctx, validateAndBuildVoucherLines, {
      rule: 'cogs_vs_kardex', ref: key, date, userId: user.id,
      costCenterId: diff.cost_center_id || null,
      description: `سند اصلاحی داده انبار — cogs_vs_kardex — مرجع ${diff.num || ('invoice#' + diff.invoice_id)} — run ${ctx.runId} — تأیید حامد رشید`,
      lines,
      amount: amt,
    });
  }
  for (const rev of openingReversals(db)) {
    const key = `opening:${rev.original_id}`;
    const amt = Math.round(n(rev.amount_rial));
    if (amt === 0) continue;
    if (skipPostedDraft(ctx, 'opening_reversal', key, openingRemaining(db, rev.original_id, amt))) continue;
    const built = openingDraftLines(db, rev, amt);
    if (!built) {
      ctx.ambiguous.push({
        rule: 'opening_counter_account', row_key: key,
        detail: `حساب طرف سند opening #${rev.je_id} یکتا نیست`,
      });
      continue;
    }
    insertDraft(ctx, validateAndBuildVoucherLines, {
      rule: 'opening_reversal', ref: key, date, userId: user.id,
      costCenterId: built.costCenterId,
      description: `سند اصلاحی داده انبار — opening_reversal — مرجع ledger#${rev.original_id} — run ${ctx.runId} — تأیید حامد رشید`,
      lines: built.lines,
      amount: amt,
    });
  }
}

function skipPostedDraft(ctx, rule, key, diff) {
  const prev = ctx.db.prepare(`
    SELECT new_value FROM wh_data_corrections WHERE rule=? AND row_key=? ORDER BY id DESC LIMIT 1
  `).get(rule, key);
  if (!prev) return false;
  const id = Number(prev.new_value);
  const still = id && ctx.db.prepare('SELECT id FROM voucher_drafts WHERE id=?').get(id);
  if (still) return true;
  if (Math.round(n(diff)) === 0) return true;
  throw stop(`STOP: پیش‌نویس ${key} دیگر در فهرست نیست ولی اختلاف هنوز ${diff} است`);
}

function openingRemaining(db, originalId, amt) {
  if (!tableExists(db, 'journal_entries')) return amt;
  const cols = colSet(db, 'journal_entries');
  const where = ["description LIKE ?"];
  if (cols.has('deleted_at')) where.push('COALESCE(deleted_at,0)=0');
  if (cols.has('status')) where.push("COALESCE(status,'approved') NOT IN ('reversed','void')");
  const hit = db.prepare(`SELECT id FROM journal_entries WHERE ${where.join(' AND ')} LIMIT 1`).get(`%ledger#${originalId}%`);
  return hit ? 0 : amt;
}

function openingReversals(db) {
  return db.prepare(`
    SELECT r.id AS reversal_id, o.id AS original_id, o.je_id, o.amount_rial, o.product_id, o.warehouse_id
    FROM inventory_ledger r
    JOIN inventory_ledger o ON o.id = r.reversed_of
    WHERE r.source_type='wh_data_correction' AND r.event_type='reversal'
      AND (o.event_type='opening' OR o.source_type='opening_inventory')
    ORDER BY o.id
  `).all();
}

function openingDraftLines(db, rev, amt) {
  const { jlCreditRial, jlDebitRial } = require('../money');
  const { acct } = require('../coa-map');
  const { inventoryAccountForWarehouse } = require('./ledger');
  const invCodes = inventoryCodes(db);
  if (!rev.je_id) return null;
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(rev.je_id);
  const acctCol = (l) => l.account_code || l.code;
  const credits = [];
  const debitedInv = [];
  for (const l of lines) {
    const code = String(acctCol(l) || '');
    if (jlCreditRial(l) > 0 && !invCodes.has(code)) credits.push({ code, name: l.account_name || l.name || code, cc: l.cost_center_id || null });
    if (jlDebitRial(l) > 0 && invCodes.has(code)) debitedInv.push({ code, name: l.account_name || l.name || code });
  }
  const creditCodes = [...new Set(credits.map((c) => c.code))];
  if (creditCodes.length !== 1) return null;
  const inv = debitedInv.length === 1
    ? postableAccount(db, debitedInv[0].code)
    : postableAccount(db, inventoryAccountForWarehouse(db, rev.warehouse_id).code || acct(db, 'coa_inventory').code);
  const counter = postableAccount(db, creditCodes[0]);
  if (!inv || !counter) return null;
  return {
    costCenterId: credits[0].cc || null,
    lines: [
      { code: counter.code, debit: amt, credit: 0, description: counter.name, cost_center_id: credits[0].cc || null },
      { code: inv.code, debit: 0, credit: amt, description: inv.name },
    ],
  };
}

function insertDraft(ctx, validate, spec) {
  const built = validate(ctx.db, spec.lines);
  if (built.error) throw stop(`STOP: پیش‌نویس ${spec.ref} معتبر نیست: ${built.error}`);
  const res = ctx.db.prepare(`
    INSERT INTO voucher_drafts (date, description, lines_json, cost_center_id, created_by)
    VALUES (?,?,?,?,?)
  `).run(spec.date, spec.description, JSON.stringify(spec.lines), spec.costCenterId || null, spec.userId);
  logChange(ctx, {
    rule: spec.rule, tbl: 'voucher_drafts', row_key: spec.ref, col: 'id',
    old_value: null, new_value: res.lastInsertRowid, reason: spec.description,
  });
  ctx.drafts.push({
    id: res.lastInsertRowid, date: spec.date, description: spec.description,
    lines: spec.lines, amount_rial: spec.amount, rule: spec.rule, ref: spec.ref,
  });
}

function buildRevaluation(ctx) {
  const db = ctx.db;
  let rows = [];
  try { rows = computeLayerReconcile(db, {}).rows || []; } catch (_) { rows = []; }
  const { acct } = require('../coa-map');
  let acctName = 'موجودی کالا';
  try { acctName = acct(db, 'coa_inventory_writedown_exp').code + ' / ' + acct(db, 'coa_inventory').code; } catch (_) {}
  for (const r of rows) {
    const qty = n(r.ledger_qty);
    const val = Math.round(n(r.ledger_value_rial));
    const neg = val < -VALUE_TOL_RIAL;
    const zero = Math.abs(qty) <= QTY_EPS && Math.abs(val) > VALUE_TOL_RIAL;
    if (!neg && !zero) continue;
    const avg = Math.round(n(r.average_cost_rial));
    const proposed = Math.round(qty * avg);
    ctx.revaluation.push({
      product_id: r.product_id, product_code: r.product_code, warehouse_id: r.warehouse_id,
      qty, ledger_value_rial: val, average_cost_rial: avg,
      proposed_value_rial: proposed, diff_rial: proposed - val, suggested_accounts: acctName,
    });
  }
}

module.exports = {
  ensureWhDataCorrections,
  runCorrection,
  extraCounts,
  invoiceCogsDiffs,
  SYNC_ASSESSMENT,
  parseXwhDiff,
};
