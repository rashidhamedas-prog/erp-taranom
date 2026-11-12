'use strict';
/**
 * سند تعدیل تجمیعی موجودی (ADJ-####) — چند کالا × انبار × رنگ/سایز در یک سند، یک سند حسابداری.
 *
 *   planDoc  → پیش‌نمایش فقط‌خواندنی (بدون نوشتن): ردیف‌ها، جمع‌ها، پیش‌نمایش سند حسابداری، مسدودکننده‌ها
 *   postDoc  → یک تراکنش: هر ردیف یک ردیف کاردکس (+ لایهٔ واریانت)، یک JE تجمیعی
 *   voidDoc  → R13: برگشت کامل ردیف‌های کاردکس، لایهٔ واریانت، JE، لایه‌های بها (یک تراکنش)
 *
 * محاسبهٔ هر ردیف دقیقاً همان manual-adjust.planAdjust است (planLine) — منطق ریاضی دوم وجود ندارد.
 * حساب مقابل فقط از value-accounts (adjustCounterAccount) می‌آید؛ هرگز 5101 / 9999.
 * هر مسدودکننده → کل سند رد می‌شود (همه‌یا‌هیچ).
 */
const MA = require('./manual-adjust');
const VA = require('./value-accounts');
const { requireClientRequestId, findByClientRequestId, isUniqueClientRequestConflict } = require('../client-request-id');
const { rialToLedger } = require('../money');

const SOURCE = 'inventory_adjust_doc';
const SEQ_KEY = 'stock_adjust';
const DOC_PREFIX = 'ADJ';
const MAX_LINES = 500;
const RAW_LINES_CAP = 2000;
const REASON_MIN = 5;
const EPS = 1e-9;
const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;

const adjErr = MA.adjErr;
const round3 = MA.round3;

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const schemaDone = new WeakSet();

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) { return false; }
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ensureAdjustDocSchema(db) {
  if (schemaDone.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_adjust_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT,
      date TEXT,
      mode TEXT CHECK (mode IN ('count','delta')),
      reason_code TEXT,
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
      je_id INTEGER,
      line_count INTEGER DEFAULT 0,
      qty_in_total REAL DEFAULT 0,
      qty_out_total REAL DEFAULT 0,
      gain_rial INTEGER DEFAULT 0,
      loss_rial INTEGER DEFAULT 0,
      client_request_id TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      voided_by INTEGER,
      voided_at INTEGER,
      void_reason TEXT DEFAULT '',
      sync_seq INTEGER,
      version INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_adjust_docs_doc_no ON stock_adjust_docs(doc_no);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_adjust_docs_crid
      ON stock_adjust_docs(client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stock_adjust_docs_date ON stock_adjust_docs(date);
    CREATE TABLE IF NOT EXISTS stock_adjust_doc_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      variant_id INTEGER,
      entered_qty REAL NOT NULL,
      system_qty REAL NOT NULL,
      delta_qty REAL NOT NULL,
      unit_cost_rial INTEGER DEFAULT 0,
      amount_rial INTEGER DEFAULT 0,
      reason_code TEXT,
      counter_code TEXT,
      inventory_code TEXT,
      ledger_id INTEGER,
      note TEXT DEFAULT '',
      sync_seq INTEGER,
      version INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sadl_cell
      ON stock_adjust_doc_lines(doc_id, product_id, warehouse_id, COALESCE(variant_id,0));
    CREATE INDEX IF NOT EXISTS idx_sadl_doc ON stock_adjust_doc_lines(doc_id);
    CREATE INDEX IF NOT EXISTS idx_sadl_product ON stock_adjust_doc_lines(product_id);
  `);
  // Tables created by an older build of this file may lack the sync columns.
  for (const t of ['stock_adjust_docs', 'stock_adjust_doc_lines']) {
    if (!hasColumn(db, t, 'sync_seq')) db.exec(`ALTER TABLE ${t} ADD COLUMN sync_seq INTEGER`);
    if (!hasColumn(db, t, 'version')) db.exec(`ALTER TABLE ${t} ADD COLUMN version INTEGER DEFAULT 0`);
  }
  if (tableExists(db, 'number_sequences')) {
    db.prepare('INSERT OR IGNORE INTO number_sequences (key, current_value) VALUES (?, 0)').run(SEQ_KEY);
  }
  schemaDone.add(db);
}

// ─────────────────────────────────────────────────────────────────────────────
// planLine — identical math to the single adjust
// ─────────────────────────────────────────────────────────────────────────────

function planLine(db, body, user, opts) {
  return MA.planAdjust(db, body, user, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normHeader(body) {
  const b = body || {};
  const mode = b.mode == null || b.mode === '' ? 'delta' : String(b.mode);
  if (!['count', 'delta'].includes(mode)) throw adjErr('E_ADJUST_MODE', 400, 'نوع تعدیل باید «شمارش» یا «کم و زیاد» باشد');
  const date = b.date ? String(b.date).trim() : MA.today();
  if (!JALALI_RE.test(date)) throw adjErr('E_ADJUST_DATE', 400, 'تاریخ باید به شکل ۱۴۰۵/۰۷/۳۰ باشد');
  const reasonCode = VA.normReason(b.reason_code); // throws E_ADJUST_REASON on junk
  const note = String(b.note != null ? b.note : '').trim().slice(0, 500);
  if (!Array.isArray(b.lines) || !b.lines.length) {
    throw adjErr('E_ADJUST_ARGS', 400, 'حداقل یک ردیف برای تعدیل لازم است');
  }
  if (b.lines.length > RAW_LINES_CAP) {
    throw adjErr('E_ADJUST_DOC_TOO_MANY', 409, `حداکثر ${MAX_LINES} ردیف تغییریافته در هر سند مجاز است`);
  }
  return { mode, date, reasonCode, note, lines: b.lines };
}

function normLine(l) {
  const x = l || {};
  return {
    product_id: Number(x.product_id) || 0,
    warehouse_id: Number(x.warehouse_id) || null,
    variant_id: Number(x.variant_id) || null,
    qty: x.qty,
    reason_code: x.reason_code,
    unit_cost_rial: x.unit_cost_rial,
    expected_system_qty: numOrNull(x.expected_system_qty),
    note: String(x.note != null ? x.note : '').trim().slice(0, 300),
  };
}

function warehouseCc(db, warehouseId) {
  if (!warehouseId) return null;
  try { return require('../cost-center-policy').warehouseCostCenterId(db, warehouseId) || null; } catch (_) { return null; }
}

/** Gross JE groups by (inventory acct, counter, warehouse CC, side). items: {inv,counter,cc,signed,periodic}. */
function groupJe(items) {
  const groups = new Map();
  for (const it of items) {
    if (it.periodic || !it.signed || !it.counter) continue;
    const side = it.signed > 0 ? 'gain' : 'loss';
    const key = [it.inv.code, it.counter.code, it.cc || 0, side].join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        side,
        inventory_code: it.inv.code,
        inventory_name: it.inv.name,
        counter_code: it.counter.code,
        counter_name: it.counter.name,
        cost_center_id: it.cc || null,
        amount_rial: 0,
        line_count: 0,
      };
      groups.set(key, g);
    }
    g.amount_rial += Math.abs(Math.round(it.signed));
    g.line_count += 1;
  }
  return [...groups.values()].map((g) => ({ ...g, amount: rialToLedger(g.amount_rial) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// planDoc (read-only unless called with peek:false by postDoc inside its tx)
// ─────────────────────────────────────────────────────────────────────────────

function planDocCore(db, body, user, { peek = true } = {}) {
  ensureAdjustDocSchema(db);
  const H = normHeader(body);
  const L = require('./ledger');
  const PL = require('./period-lock');
  const blocking = [];
  const block = (code, message, line) => {
    blocking.push(line != null ? { code, message, line } : { code, message });
  };
  const lines = [];
  const droppedZero = [];
  const seen = new Set();
  const unattribSeen = new Set();

  H.lines.forEach((raw, idx) => {
    const n = idx + 1;
    const l = normLine(raw);
    if (!l.product_id) { block('E_ADJUST_ARGS', 'کالا الزامی است', n); return; }
    if (!l.warehouse_id) {
      block('E_WAREHOUSE_REQUIRED', 'انبار را انتخاب کنید؛ تعدیل بدون انبار مجاز نیست', n);
      return;
    }
    const key = `${l.product_id}|${l.warehouse_id}|${l.variant_id || 0}`;
    if (seen.has(key)) {
      block('E_ADJUST_DOC_DUP_LINE', 'این کالا/انبار/رنگ‌سایز در سند تکراری است', n);
      return;
    }
    seen.add(key);
    if (MA.isAdjustMatrix(db, l.product_id) && !l.variant_id) {
      block('E_VARIANT_REQUIRED', 'برای کالای رنگ×سایز، رنگ/سایز را انتخاب کنید', n);
      return;
    }
    let reason = null;
    try {
      reason = VA.normReason(l.reason_code) || H.reasonCode;
    } catch (e) { block(e.code || 'E_ADJUST_REASON', e.message, n); return; }

    let plan;
    try {
      plan = planLine(db, {
        product_id: l.product_id,
        warehouse_id: l.warehouse_id,
        variant_id: l.variant_id,
        mode: H.mode,
        qty: l.qty,
        reason_code: reason || '',
        date: H.date,
        unit_cost_rial: l.unit_cost_rial,
      }, user, { peek });
    } catch (e) {
      if (e && e.code && (!e.status || e.status < 500)) { block(e.code, e.message, n); return; }
      throw e;
    }

    if (plan.delta_qty == null) {
      block('E_ADJUST_ARGS', 'تعداد نامعتبر است', n);
      return;
    }
    if (!plan.delta_qty) {
      droppedZero.push({
        line: n,
        product_id: plan.product_id,
        product_name: plan.product_name,
        warehouse_id: plan.warehouse_id,
        variant_id: plan.variant_id,
        system_qty: plan.current_qty,
      });
      return;
    }
    if (!reason) block('E_ADJUST_REASON_REQUIRED', 'دلیل تعدیل الزامی است', n);
    if (plan.matrix && Math.abs(Number(plan.unallocated_net) || 0) > EPS) {
      const uk = `${plan.product_id}|${plan.warehouse_id}`;
      if (!unattribSeen.has(uk)) {
        unattribSeen.add(uk);
        block(
          'E_ADJUST_UNATTRIBUTED_EXISTS',
          'در این انبار موجودی بدون رنگ/سایز مانده است؛ ابتدا «تفکیک رنگ» یا «ابطال اصلاحی با اثر موجودی» را انجام دهید، سپس تعدیل هر رنگ',
          n
        );
      }
    }
    if (plan.integer && Math.abs(plan.delta_qty - Math.round(plan.delta_qty)) > EPS) {
      block('E_QTY_NOT_INTEGER', 'موجودی کالای قطعه‌ای باید عدد صحیح باشد', n);
    }
    if (plan.new_qty != null && plan.new_qty < -EPS && !L.allowNegative(db, plan.warehouse_id)) {
      block('E_ADJUST_NEGATIVE', `موجودی بعد از تعدیل منفی می‌شود (${plan.new_qty}) و ثبت رد خواهد شد`, n);
    }
    if (plan.cost_overridden && !plan.can_override_cost) {
      block('E_ADJUST_COST_FORBIDDEN', 'تغییر بهای واحد تعدیل فقط با دسترسی «ارزش‌گذاری موجودی — ثبت» مجاز است', n);
    }
    if (reason && !plan.counter_account) {
      block('E_ADJUST_COUNTER_NOT_LEAF', 'حساب مقابل تعدیل برگ فعال نیست', n);
    }
    const stale = l.expected_system_qty != null && Math.abs(l.expected_system_qty - plan.current_qty) > EPS;
    const warnings = (plan.warnings || []).slice();
    if (stale) warnings.push('موجودی سیستم از زمان نمایش تغییر کرده است');
    lines.push({
      line: n,
      product_id: plan.product_id,
      product_name: plan.product_name,
      product_code: plan.product_code,
      unit: plan.unit,
      warehouse_id: plan.warehouse_id,
      variant_id: plan.variant_id,
      matrix: plan.matrix,
      integer: plan.integer,
      entered_qty: Number(l.qty),
      system_qty: plan.current_qty,
      new_qty: plan.new_qty,
      delta_qty: plan.delta_qty,
      unit_cost_rial: plan.unit_cost_rial,
      value_rial: plan.value_rial,
      cost_overridden: plan.cost_overridden,
      reason_code: reason,
      reason_label: reason ? VA.ADJUST_REASONS[reason] : null,
      inventory_account: plan.inventory_account,
      counter_account: plan.counter_account,
      periodic: plan.periodic,
      expected_system_qty: l.expected_system_qty,
      stale,
      note: l.note,
      warnings,
    });
  });

  if (!lines.length && !blocking.length) {
    block('E_ADJUST_NO_CHANGE', 'هیچ ردیفی تغییر نکرده است؛ تعدیلی ثبت نشد');
  }
  if (lines.length > MAX_LINES) {
    block('E_ADJUST_DOC_TOO_MANY', `حداکثر ${MAX_LINES} ردیف تغییریافته در هر سند مجاز است (${lines.length})`);
  }
  if (lines.some((x) => !x.periodic && x.value_rial) && PL.isValueLocked(db, H.date)) {
    block('E_ADJUST_DOC_PERIOD_LOCKED', 'ماه بسته است؛ برای ماه بسته از تعدیل تکی استفاده کنید');
  }
  if (lines.length) {
    try {
      require('./cycle-count').assertWarehouseNotCounting(
        db, [...new Set(lines.map((x) => x.warehouse_id))], { label: 'تعدیل موجودی' }
      );
    } catch (e) {
      if (e && e.code && (!e.status || e.status < 500)) block(e.code, e.message);
      else throw e;
    }
  }

  const totals = { gain_rial: 0, loss_rial: 0, qty_in: 0, qty_out: 0, line_count: lines.length };
  for (const x of lines) {
    if (x.value_rial > 0) totals.gain_rial += x.value_rial; else totals.loss_rial += -x.value_rial;
    if (x.delta_qty > 0) totals.qty_in = round3(totals.qty_in + x.delta_qty);
    else totals.qty_out = round3(totals.qty_out + -x.delta_qty);
  }
  const jePreview = groupJe(lines.map((x) => ({
    inv: x.inventory_account,
    counter: x.counter_account,
    cc: warehouseCc(db, x.warehouse_id),
    signed: x.value_rial,
    periodic: x.periodic,
  })));

  return {
    ok: blocking.length === 0,
    date: H.date,
    mode: H.mode,
    reason_code: H.reasonCode,
    note: H.note,
    lines,
    dropped_zero: droppedZero,
    totals,
    je_preview: jePreview,
    blocking,
    _header: H,
  };
}

/** Read-only preview. */
function planDoc(db, body, user) {
  const p = planDocCore(db, body, user, { peek: true });
  delete p._header;
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// postDoc
// ─────────────────────────────────────────────────────────────────────────────

function blockingError(blocking) {
  const first = blocking[0];
  const extra = blocking.length > 1 ? ` (+${blocking.length - 1} مورد دیگر)` : '';
  const e = adjErr(first.code, 409, (first.line ? `ردیف ${first.line}: ` : '') + first.message + extra);
  e.blocking = blocking;
  return e;
}

function postDoc(db, body, user) {
  ensureAdjustDocSchema(db);
  const key = requireClientRequestId(body, { optional: true });
  const uid = (user && user.id) || null;
  let out = null;

  const run = () => {
    if (key) {
      const hit = findByClientRequestId(db, 'stock_adjust_docs', key);
      if (hit) { out = { ...getDoc(db, hit.id), idempotent_replay: true }; return; }
    }
    const plan = planDocCore(db, body, user, { peek: false });
    if (plan.blocking.length) throw blockingError(plan.blocking);
    const H = plan._header;

    const stale = plan.lines.filter((x) => x.stale);
    if (stale.length) {
      throw adjErr('E_ADJUST_DOC_STALE', 409,
        'موجودی سیستم در چند ردیف از زمان پیش‌نمایش تغییر کرده است؛ دوباره پیش‌نمایش بگیرید', {
          lines: stale.map((x) => ({
            line: x.line,
            product_id: x.product_id,
            warehouse_id: x.warehouse_id,
            variant_id: x.variant_id,
            expected_system_qty: x.expected_system_qty,
            system_qty: x.system_qty,
          })),
        });
    }

    const { allocateNumber } = require('../../db');
    const docNo = allocateNumber(db, SEQ_KEY, DOC_PREFIX);
    const head = db.prepare(`
      INSERT INTO stock_adjust_docs
        (doc_no, date, mode, reason_code, note, status, line_count, client_request_id, created_by)
      VALUES (?,?,?,?,?, 'posted', ?, ?, ?)
    `).run(docNo, H.date, H.mode, H.reasonCode, H.note, plan.lines.length, key, uid);
    const docId = Number(head.lastInsertRowid);

    const L = require('./ledger');
    const movement = require('./movement');
    const cache = require('./stock-cache');
    const PV = require('../product-variants');
    const insLine = db.prepare(`
      INSERT INTO stock_adjust_doc_lines
        (doc_id, line_no, product_id, warehouse_id, variant_id, entered_qty, system_qty, delta_qty,
         unit_cost_rial, amount_rial, reason_code, counter_code, inventory_code, ledger_id, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const posted = [];
    const matrixProducts = new Set();
    let lineNo = 0;
    for (const pl of plan.lines) {
      lineNo += 1;
      if (pl.variant_id) PV.reactivateVariant(db, pl.variant_id);
      const delta = pl.delta_qty;
      const ledgerNote = [`تعدیل تجمیعی ${docNo}${pl.reason_label ? ' — ' + pl.reason_label : ''}`, pl.note]
        .filter(Boolean).join(' — ').slice(0, 300);
      const led = L.postInventoryMovement(db, {
        eventType: 'adjustment',
        productId: pl.product_id,
        warehouseId: pl.warehouse_id,
        variantId: pl.variant_id || undefined,
        qty: delta,
        unitCostRial: delta > 0 ? pl.unit_cost_rial : undefined,
        sourceType: SOURCE,
        sourceId: docId,
        date: H.date,
        note: ledgerNote,
        createdBy: uid,
      });
      if (pl.variant_id) {
        movement.postVariantLayer(db, {
          productId: pl.product_id,
          variantId: pl.variant_id,
          warehouseId: pl.warehouse_id,
          qtyDelta: delta,
          docType: SOURCE,
          docId,
          docLine: lineNo,
          userId: uid,
          note: ledgerNote,
          allowNegative: L.allowNegative(db, pl.warehouse_id),
        });
        cache.assertVariantCellMirrorsLedger(db, {
          productId: pl.product_id,
          variantId: pl.variant_id,
          warehouseId: pl.warehouse_id,
          mode: 'throw',
        });
        matrixProducts.add(pl.product_id);
      }
      const signed = (Number(led.qty_in) || 0) > 0
        ? Math.round(Number(led.amount_rial) || 0)
        : -Math.round(Number(led.amount_rial) || 0);
      insLine.run(
        docId, lineNo, pl.product_id, pl.warehouse_id, pl.variant_id || null,
        Number.isFinite(pl.entered_qty) ? pl.entered_qty : 0,
        pl.system_qty, delta,
        Math.round(Number(led.unit_cost_rial) || 0), signed,
        pl.reason_code, pl.counter_account ? pl.counter_account.code : null,
        pl.inventory_account ? pl.inventory_account.code : null,
        Number(led.id), pl.note
      );
      posted.push({ pl, led, signed });
    }

    // One recompute per matrix product (website sync is the caller's job).
    for (const pid of matrixProducts) {
      try { PV.afterVariantStockWrite(db, pid); } catch (_) { /* optional */ }
    }

    let qtyIn = 0;
    let qtyOut = 0;
    let gain = 0;
    let loss = 0;
    for (const p of posted) {
      qtyIn += Number(p.led.qty_in) || 0;
      qtyOut += Number(p.led.qty_out) || 0;
      if (p.signed > 0) gain += p.signed; else loss += -p.signed;
    }

    const groups = groupJe(posted.map((p) => ({
      inv: p.pl.inventory_account,
      counter: p.pl.counter_account,
      cc: warehouseCc(db, p.pl.warehouse_id),
      signed: p.signed,
      periodic: p.pl.periodic,
    })));
    let jeId = null;
    if (groups.length) {
      const jl = [];
      const tag = `تعدیل تجمیعی ${docNo}${H.reasonCode ? ' — ' + VA.ADJUST_REASONS[H.reasonCode] : ''}`;
      for (const g of groups) {
        const v = rialToLedger(g.amount_rial);
        const inv = { code: g.inventory_code, name: g.inventory_name, cost_center_id: g.cost_center_id, description: tag };
        const ctr = { code: g.counter_code, name: g.counter_name, cost_center_id: g.cost_center_id, description: tag };
        if (g.side === 'gain') {
          jl.push({ ...inv, debit: v, credit: 0 }, { ...ctr, debit: 0, credit: v });
        } else {
          jl.push({ ...ctr, debit: v, credit: 0 }, { ...inv, debit: 0, credit: v });
        }
      }
      jeId = require('../ledger').postToLedger(db, {
        sourceType: SOURCE,
        sourceId: docId,
        date: H.date,
        description: `${tag}${H.note ? ' — ' + H.note.slice(0, 120) : ''}`,
        createdBy: uid,
        lines: jl,
        skipCcPolicy: true,
      });
      // Link only the rows the JE covers (periodic warehouses get theirs at period close).
      const upd = db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=? AND source_type=? AND source_id=?');
      for (const p of posted) {
        if (!p.pl.periodic && p.signed) upd.run(jeId, Number(p.led.id), SOURCE, docId);
      }
    }
    db.prepare(`
      UPDATE stock_adjust_docs
      SET je_id=?, line_count=?, qty_in_total=?, qty_out_total=?, gain_rial=?, loss_rial=?
      WHERE id=?
    `).run(jeId, posted.length, round3(qtyIn), round3(qtyOut), gain, loss, docId);
    out = getDoc(db, docId);
  };

  try {
    db.transaction(run)();
  } catch (e) {
    if (key && isUniqueClientRequestConflict(e)) {
      const hit = findByClientRequestId(db, 'stock_adjust_docs', key);
      if (hit) return { ...getDoc(db, hit.id), idempotent_replay: true };
    }
    throw e;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// voidDoc (R13 — full reverse, one transaction)
// ─────────────────────────────────────────────────────────────────────────────

function voidDoc(db, id, opts, user) {
  ensureAdjustDocSchema(db);
  const o = opts || {};
  const reason = String(o.reason || '').trim();
  if (o.confirm !== true) throw adjErr('E_ADJUST_DOC_CONFIRM', 400, 'تأیید صریح (confirm: true) الزامی است');
  if (reason.length < REASON_MIN) {
    throw adjErr('E_ADJUST_DOC_REASON', 400, `علت ابطال الزامی است (حداقل ${REASON_MIN} نویسه)`);
  }
  const docId = Number(id) || 0;
  const uid = (user && user.id) || null;
  let out = null;

  db.transaction(() => {
    const doc = db.prepare('SELECT * FROM stock_adjust_docs WHERE id=?').get(docId);
    if (!doc) throw adjErr('E_ADJUST_DOC_NOT_FOUND', 404, 'سند تعدیل یافت نشد');
    if (doc.status !== 'posted') throw adjErr('E_ADJUST_DOC_ALREADY_VOID', 409, 'سند قبلاً ابطال شده است');
    const lines = db.prepare('SELECT * FROM stock_adjust_doc_lines WHERE doc_id=? ORDER BY line_no DESC').all(docId);
    const why = `ابطال ${doc.doc_no} — ${reason}`.slice(0, 300);

    require('./cycle-count').assertWarehouseNotCounting(
      db, [...new Set(lines.map((l) => l.warehouse_id))], { label: 'ابطال تعدیل تجمیعی' }
    );

    const L = require('./ledger');
    const movement = require('./movement');
    const cache = require('./stock-cache');
    const PV = require('../product-variants');
    const date = MA.today();

    const ledRows = new Map();
    for (const l of lines) {
      const row = l.ledger_id ? db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(l.ledger_id) : null;
      if (!row) throw adjErr('E_ADJUST_DOC_LEDGER_MISSING', 409, `ردیف کاردکس سطر ${l.line_no} یافت نشد`);
      ledRows.set(l.id, row);
      if (row.status !== 'reversed') {
        L.reverseInventoryMovement(db, row.id, { createdBy: uid, date, note: why });
      }
    }
    movement.reverseStockDocument(db, {
      docType: SOURCE, docId, userId: uid, note: why, applyHeaderStock: false,
    });
    for (const l of lines) {
      if (!l.variant_id) continue;
      cache.assertVariantCellMirrorsLedger(db, {
        productId: l.product_id, variantId: l.variant_id, warehouseId: l.warehouse_id, mode: 'throw',
      });
      // A reversal may put quantity back on a SKU retired meanwhile → bring it back.
      try {
        const v = db.prepare('SELECT * FROM product_variants WHERE id=?').get(l.variant_id);
        if (v && !Number(v.active) && PV.variantCarriesStock(db, v)) PV.reactivateVariant(db, v.id);
      } catch (_) { /* variant tables optional */ }
    }
    if (doc.je_id) {
      require('../void-journal').reverseJournalEntry(db, doc.je_id, { userId: uid, reason: why });
    }
    for (const l of lines) {
      const row = ledRows.get(l.id);
      if ((Number(row.qty_in) || 0) > 0) MA.closeCostLayersForLedger(db, row.id);
    }
    const V = require('./valuation');
    for (const pid of new Set(lines.map((l) => l.product_id))) {
      try { V.rebuildBuckets(db, { productId: pid }); } catch (_) { /* valuation optional */ }
    }
    const r = db.prepare(`
      UPDATE stock_adjust_docs
      SET status='void', voided_by=?, voided_at=strftime('%s','now'), void_reason=?, version=COALESCE(version,0)+1
      WHERE id=? AND status='posted'
    `).run(uid, reason, docId);
    if (!r.changes) throw adjErr('E_ADJUST_DOC_ALREADY_VOID', 409, 'سند قبلاً ابطال شده است');
    out = getDoc(db, docId);
  })();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read APIs
// ─────────────────────────────────────────────────────────────────────────────

function getDoc(db, id) {
  ensureAdjustDocSchema(db);
  const d = db.prepare(`
    SELECT h.*, u.name AS created_by_name, vu.name AS voided_by_name
    FROM stock_adjust_docs h
    LEFT JOIN users u ON u.id=h.created_by
    LEFT JOIN users vu ON vu.id=h.voided_by
    WHERE h.id=?
  `).get(Number(id) || 0);
  if (!d) return null;
  const lines = db.prepare(`
    SELECT l.*, p.code AS product_code, p.name AS product_name, p.unit AS unit,
      w.name AS warehouse_name, pv.sku AS sku, pc.name AS color_name, ps.name AS size_name
    FROM stock_adjust_doc_lines l
    LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    LEFT JOIN product_variants pv ON pv.id=l.variant_id
    LEFT JOIN product_colors pc ON pc.id=pv.color_id
    LEFT JOIN product_sizes ps ON ps.id=pv.size_id
    WHERE l.doc_id=? ORDER BY l.line_no
  `).all(d.id).map((l) => ({
    ...l,
    reason_label: l.reason_code ? VA.ADJUST_REASONS[l.reason_code] || null : null,
  }));
  return {
    ...d,
    reason_label: d.reason_code ? VA.ADJUST_REASONS[d.reason_code] || null : null,
    je_no: MA.voucherNo(db, d.je_id),
    lines,
  };
}

function listDocs(db, { status = null, productId = null, warehouseId = null, from = null, to = null, q = null, limit = 100, offset = 0 } = {}) {
  ensureAdjustDocSchema(db);
  const where = [];
  const args = [];
  if (status === 'posted' || status === 'void') { where.push('h.status=?'); args.push(status); }
  if (from) { where.push('h.date>=?'); args.push(String(from)); }
  if (to) { where.push('h.date<=?'); args.push(String(to)); }
  if (q) { where.push('h.doc_no LIKE ?'); args.push(`%${String(q).trim()}%`); }
  if (productId) {
    where.push('EXISTS (SELECT 1 FROM stock_adjust_doc_lines x WHERE x.doc_id=h.id AND x.product_id=?)');
    args.push(Number(productId));
  }
  if (warehouseId) {
    where.push('EXISTS (SELECT 1 FROM stock_adjust_doc_lines x WHERE x.doc_id=h.id AND x.warehouse_id=?)');
    args.push(Number(warehouseId));
  }
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return db.prepare(`
    SELECT h.*, u.name AS created_by_name
    FROM stock_adjust_docs h LEFT JOIN users u ON u.id=h.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY h.id DESC LIMIT ? OFFSET ?
  `).all(...args, lim, off).map((d) => ({
    ...d,
    reason_label: d.reason_code ? VA.ADJUST_REASONS[d.reason_code] || null : null,
    je_no: MA.voucherNo(db, d.je_id),
  }));
}

/**
 * Entry grid for one product: variants (active, or retired but still carrying stock; non-matrix → one
 * null-variant row) × warehouses, each cell = live ledger qty. Never a null-warehouse cell.
 */
function buildGrid(db, { product_id, warehouse_ids } = {}) {
  const pid = Number(product_id) || 0;
  if (!pid) throw adjErr('E_ADJUST_ARGS', 400, 'کالا الزامی است');
  const product = db.prepare('SELECT id, code, name, unit FROM products WHERE id=?').get(pid);
  if (!product) throw adjErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const matrix = MA.isAdjustMatrix(db, pid);
  const integer = !!require('./qty-policy').requiresIntegerQty(db, pid, product.unit);

  let whs = db.prepare(
    'SELECT id, code, name, COALESCE(allow_negative,0) AS allow_negative FROM warehouses ORDER BY id'
  ).all();
  const want = Array.isArray(warehouse_ids)
    ? new Set(warehouse_ids.map((x) => Number(x)).filter(Boolean)) : null;
  if (want && want.size) whs = whs.filter((w) => want.has(Number(w.id)));
  const warehouses = whs.map((w) => ({
    id: Number(w.id), code: w.code, name: w.name, allow_negative: Number(w.allow_negative) ? 1 : 0,
  }));

  const derived = require('./stock-cache').deriveProductStock(db, pid);
  const variants = [];
  const cells = [];
  if (matrix) {
    // Include EVERY non-default variant: active, retired-with-stock, and retired-at-zero.
    // Editor keeps zero-retired colors as «بدون موجودی»; hiding them here blocked re-count.
    // Default SKU stays excluded. plan/post already allow adjusting retired SKUs + reactivate.
    const rows = db.prepare(`
      SELECT pv.*, pc.name AS color_name, ps.name AS size_name
      FROM product_variants pv
      LEFT JOIN product_colors pc ON pc.id=pv.color_id
      LEFT JOIN product_sizes ps ON ps.id=pv.size_id
      WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0
      ORDER BY pc.sort_order, pc.name, ps.sort_order, ps.name, pv.id
    `).all(pid);
    for (const v of rows) {
      const active = Number(v.active) ? 1 : 0;
      variants.push({
        variant_id: Number(v.id),
        sku: v.sku || '',
        active,
        retired: !active,
        color_name: v.color_name || '',
        size_name: v.size_name || '',
        label: [v.color_name, v.size_name].filter(Boolean).join(' / ') || v.sku || `#${v.id}`,
      });
      for (const w of warehouses) {
        cells.push({
          warehouse_id: w.id,
          variant_id: Number(v.id),
          system_qty: round3(derived.variantWarehouses.get(`${v.id}:${w.id}`) || 0),
        });
      }
    }
  } else {
    variants.push({ variant_id: null, sku: '', active: 1, retired: false, color_name: '', size_name: '', label: '' });
    for (const w of warehouses) {
      cells.push({
        warehouse_id: w.id,
        variant_id: null,
        system_qty: MA.currentQty(db, { productId: pid, warehouseId: w.id, variantId: null }),
      });
    }
  }
  const unattributed = warehouses.map((w) => ({
    warehouse_id: w.id,
    qty: matrix ? round3(derived.unattributed.get(w.id) || 0) : 0,
  }));
  return {
    product: { id: Number(product.id), code: product.code || '', name: product.name, unit: product.unit || '' },
    matrix,
    integer,
    warehouses,
    variants,
    cells,
    unattributed,
    unattributed_no_warehouse: matrix ? round3(derived.unattributed.get(0) || 0) : 0,
  };
}

/** Map flat grid.cells onto each variant as cells[].qty (from system_qty). Never leave cells undefined. */
function attachCellsToVariants(variants, cells) {
  const list = Array.isArray(variants) ? variants : [];
  const flat = Array.isArray(cells) ? cells : [];
  return list.map((v) => {
    const vid = v.variant_id == null || v.variant_id === '' ? null : Number(v.variant_id);
    const vCells = flat
      .filter((c) => {
        const cid = c.variant_id == null || c.variant_id === '' ? null : Number(c.variant_id);
        return (cid == null && vid == null) || Number(cid) === Number(vid);
      })
      .map((c) => {
        const qty = Number(c.system_qty != null ? c.system_qty : c.qty) || 0;
        return {
          warehouse_id: Number(c.warehouse_id),
          variant_id: c.variant_id == null || c.variant_id === '' ? null : Number(c.variant_id),
          qty,
          system_qty: qty,
        };
      });
    return Object.assign({}, v, { cells: vCells });
  });
}

/**
 * Default selected warehouse chips: any WH with non-zero attached cell or unattributed,
 * plus product default warehouse if present in grid.warehouses. Empty raw/FA/WIP stay unselected.
 */
function defaultSelectedWarehouseIds(grid, productWarehouseId) {
  const whs = Array.isArray(grid && grid.warehouses) ? grid.warehouses : [];
  const whSet = new Set(whs.map((w) => Number(w.id)).filter(Boolean));
  const selected = new Set();
  const variants = attachCellsToVariants(grid && grid.variants, grid && grid.cells);
  for (const v of variants) {
    for (const c of v.cells || []) {
      if (Math.abs(Number(c.qty) || 0) > 1e-9 && whSet.has(Number(c.warehouse_id))) {
        selected.add(Number(c.warehouse_id));
      }
    }
  }
  for (const u of (grid && grid.unattributed) || []) {
    if (Math.abs(Number(u.qty) || 0) > 1e-9 && whSet.has(Number(u.warehouse_id))) {
      selected.add(Number(u.warehouse_id));
    }
  }
  const def = Number(productWarehouseId) || 0;
  if (def && whSet.has(def)) selected.add(def);
  return Array.from(selected);
}

module.exports = {
  SOURCE,
  SEQ_KEY,
  DOC_PREFIX,
  ensureAdjustDocSchema,
  planLine,
  planDoc,
  postDoc,
  voidDoc,
  listDocs,
  getDoc,
  buildGrid,
  attachCellsToVariants,
  defaultSelectedWarehouseIds,
};
