'use strict';
/**
 * سند اصلاح تفکیک واریانت (VR-####).
 *
 * یک ردیف زندهٔ کاردکس بدون variant_id روی کالای رنگ×سایز را به تفکیک واریانت دوباره ثبت می‌کند:
 *   ۱) همان رویداد / منبع / تاریخ / سند حسابداری / بها، یک ردیف برای هر واریانت (Σ تعداد و Σ مبلغ = ردیف اصلی)
 *   ۲) معکوس ردیف اصلی (reverseInventoryMovement)
 * هر دو با skipStock: میانگین، لایهٔ بها و پارک دورهٔ بسته دست نمی‌خورد؛ سطل ارزش‌گذاری خالص صفر.
 * سند حسابداری جدید ندارد (حساب موجودی و مبلغ ثابت است) و موجودی فقط از کاردکس بازسازی می‌شود.
 *
 * ابطال (R13): ردیف‌های تفکیکی معکوس، معکوسِ ردیف اصلی خودش معکوس و ردیف اصلی دوباره زنده می‌شود.
 * حذف فیزیکی نداریم.
 */
const { round3 } = require('../round3');

const DOC_PREFIX = 'VR';
const SEQ_KEY = 'variant_reclass';
const REASON_MIN = 5;
const QTY_EPS = 0.001;

function vrErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ensureVariantReclassSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS variant_reclass_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT,
      date TEXT DEFAULT '',
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER,
      source_ledger_id INTEGER NOT NULL,
      reversal_ledger_id INTEGER,
      lines_json TEXT NOT NULL DEFAULT '[]',
      basis TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      voided_by INTEGER,
      voided_at INTEGER,
      void_reason TEXT DEFAULT '',
      void_ledger_ids TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_variant_reclass_product ON variant_reclass_docs(product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_variant_reclass_doc_no ON variant_reclass_docs(doc_no);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_variant_reclass_source_posted
      ON variant_reclass_docs(source_ledger_id) WHERE status='posted';
  `);
  if (tableExists(db, 'number_sequences')) {
    db.prepare('INSERT OR IGNORE INTO number_sequences (key, current_value) VALUES (?, 0)').run(SEQ_KEY);
  }
}

function isLive(row) {
  const et = String(row.event_type || '');
  return String(row.status || '') === 'posted' && row.reversed_of == null
    && et !== 'reversal' && !et.endsWith('_reversal');
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => ({
    variantId: parseInt(l && (l.variant_id != null ? l.variant_id : l.variantId), 10) || 0,
    qty: round3(Number(l && l.qty) || 0),
  }));
}

/**
 * Validate and price a reclass. Read-only.
 * @returns {{ plan: object, row: object, lines: {variantId, qty}[] }}
 */
function planReclass(db, { ledgerId, lines, basis = '' } = {}) {
  const id = parseInt(ledgerId, 10);
  if (!id) throw vrErr('E_VR_LEDGER_REQUIRED', 400, 'ردیف کاردکس مبدأ الزامی است');
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id);
  if (!row) throw vrErr('E_VR_LEDGER_NOT_FOUND', 404, 'ردیف کاردکس یافت نشد');
  if (!isLive(row)) throw vrErr('E_VR_NOT_LIVE', 409, 'فقط ردیف زندهٔ کاردکس (ثبت‌شده، معکوس‌نشده) قابل تفکیک است');
  if (Number(row.variant_id) > 0) throw vrErr('E_VR_HAS_VARIANT', 409, 'این ردیف کاردکس واریانت دارد');
  const qtyIn = Number(row.qty_in) || 0;
  const qtyOut = Number(row.qty_out) || 0;
  if ((qtyIn > 0) === (qtyOut > 0)) throw vrErr('E_VR_QTY_SHAPE', 409, 'ردیف باید فقط ورود یا فقط خروج داشته باشد');
  if (!row.warehouse_id) throw vrErr('E_VR_NO_WAREHOUSE', 409, 'ردیف کاردکس انبار ندارد');
  const { isWarehouseOnlyRow } = require('./ledger');
  if (isWarehouseOnlyRow(row)) throw vrErr('E_VR_WAREHOUSE_ONLY', 409, 'ردیف بستهٔ برش (فقط انبار) با این سند تفکیک نمی‌شود');
  const { hasActiveMatrixVariants } = require('./movement');
  if (!hasActiveMatrixVariants(db, row.product_id)) {
    throw vrErr('E_VR_NOT_MATRIX', 409, 'کالا رنگ×سایز فعال ندارد');
  }

  const list = normalizeLines(lines);
  if (!list.length) throw vrErr('E_VR_LINES_REQUIRED', 400, 'سطرهای واریانت الزامی است');
  const seen = new Set();
  const vInfo = db.prepare('SELECT id, product_id, active, COALESCE(is_default,0) AS is_default, sku FROM product_variants WHERE id=?');
  const out = [];
  for (const l of list) {
    if (!l.variantId || !(l.qty > 0)) throw vrErr('E_VR_LINE_INVALID', 400, 'هر سطر واریانت و تعداد مثبت لازم دارد');
    if (seen.has(l.variantId)) throw vrErr('E_VR_LINE_DUP', 400, `واریانت ${l.variantId} تکراری است`);
    seen.add(l.variantId);
    const v = vInfo.get(l.variantId);
    if (!v || Number(v.product_id) !== Number(row.product_id)) {
      throw vrErr('E_VARIANT_MISMATCH', 400, `واریانت ${l.variantId} متعلق به این کالا نیست`);
    }
    if (!Number(v.active) || Number(v.is_default)) {
      throw vrErr('E_VR_VARIANT_INACTIVE', 400, `واریانت ${l.variantId} فعال/رنگ×سایز نیست`);
    }
    out.push({ variantId: l.variantId, qty: l.qty, sku: v.sku || '' });
  }
  const total = round3(qtyIn || qtyOut);
  const sum = round3(out.reduce((a, l) => a + l.qty, 0));
  if (Math.abs(sum - total) > QTY_EPS) {
    throw vrErr('E_VR_QTY_SUM', 400, `جمع واریانت‌ها (${sum}) با تعداد ردیف کاردکس (${total}) یکی نیست`);
  }
  if (tableExists(db, 'variant_reclass_docs')) {
    const dup = db.prepare("SELECT id, doc_no FROM variant_reclass_docs WHERE source_ledger_id=? AND status='posted'").get(id);
    if (dup) throw vrErr('E_VR_EXISTS', 409, `برای این ردیف سند ${dup.doc_no} ثبت شده است`);
  }

  const amount = Math.round(Number(row.amount_rial) || 0);
  let left = amount;
  const priced = out.map((l, i) => {
    const last = i === out.length - 1;
    const a = last ? left : Math.round(amount * l.qty / total);
    left -= a;
    return { variant_id: l.variantId, sku: l.sku, qty: l.qty, amount_rial: a };
  });
  const plan = {
    ledger_id: id,
    tx_no: row.tx_no,
    product_id: Number(row.product_id),
    warehouse_id: Number(row.warehouse_id),
    event_type: row.event_type,
    source_type: row.source_type,
    source_id: row.source_id,
    je_id: row.je_id || null,
    date: row.date || '',
    direction: qtyIn > 0 ? 'in' : 'out',
    qty: total,
    amount_rial: amount,
    lines: priced,
    basis: String(basis || ''),
    gl_effect_rial: 0,
  };
  return { plan, row, lines: out };
}

function previewReclass(db, body) {
  return planReclass(db, { ledgerId: body.ledger_id, lines: body.lines, basis: body.basis }).plan;
}

function checkReason(body) {
  const reason = String((body && body.reason) || '').trim();
  if (reason.length < REASON_MIN) {
    throw vrErr('E_VR_REASON_REQUIRED', 400, `علت سند الزامی است (حداقل ${REASON_MIN} نویسه)`);
  }
  const c = body && body.confirm;
  if (!(c === true || c === 1 || c === '1' || c === 'true')) {
    throw vrErr('E_VR_CONFIRM_REQUIRED', 400, 'تأیید صریح (confirm: true) الزامی است');
  }
  return reason;
}

/** Post inside the caller's transaction (or its own). Returns the doc. */
function postReclass(db, body, user) {
  const reason = checkReason(body);
  const uid = (user && user.id) || null;
  const run = () => {
    ensureVariantReclassSchema(db);
    const { plan, row, lines } = planReclass(db, { ledgerId: body.ledger_id, lines: body.lines, basis: body.basis });
    require('./cycle-count').assertWarehouseNotCounting(db, [row.warehouse_id], { label: 'اصلاح تفکیک واریانت' });
    const { allocateNumber } = require('../../db');
    const docNo = allocateNumber(db, SEQ_KEY, DOC_PREFIX);
    const note = `${docNo} — اصلاح تفکیک واریانت ${row.tx_no || ('#' + row.id)}`;
    const { postLedgerByVariant } = require('./apparel-lines');
    const isIn = plan.direction === 'in';
    const posted = postLedgerByVariant(db, {
      eventType: row.event_type,
      productId: row.product_id,
      warehouseId: row.warehouse_id,
      qtyIn: isIn ? plan.qty : 0,
      qtyOut: isIn ? 0 : plan.qty,
      unitCostRial: row.unit_cost_rial,
      amountRial: plan.amount_rial,
      sourceType: row.source_type,
      sourceId: row.source_id,
      jeId: row.je_id || null,
      batchId: row.batch_id || null,
      date: row.date || '',
      note,
      createdBy: uid,
      skipStock: true,
      updateAvg: false,
      priceFixed: true,
      allowZeroCost: true,
    }, lines.map((l) => ({ variantId: l.variantId, qty: l.qty })));
    const newRows = (posted.rows || [posted]).map((r) => Number(r.id));
    const { reverseInventoryMovement } = require('./ledger');
    const rev = reverseInventoryMovement(db, row.id, { createdBy: uid, date: row.date || '', note, skipStock: true, keepDate: true });
    const byVariant = db.prepare(`SELECT id, variant_id, amount_rial FROM inventory_ledger WHERE id IN (${newRows.map(() => '?').join(',')})`).all(...newRows);
    const linesJson = plan.lines.map((l) => {
      const hit = byVariant.find((r) => Number(r.variant_id) === l.variant_id);
      return { ...l, ledger_id: hit ? Number(hit.id) : null };
    });
    const { todayJalali } = require('../../jalali');
    const info = db.prepare(`
      INSERT INTO variant_reclass_docs
        (doc_no, date, product_id, warehouse_id, source_ledger_id, reversal_ledger_id, lines_json, basis, reason, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?, 'posted', ?)
    `).run(docNo, body.date || todayJalali(), row.product_id, row.warehouse_id, row.id, Number(rev.id),
      JSON.stringify(linesJson), plan.basis, reason, uid);
    require('./stock-cache').rebuildStockCache(db, row.product_id);
    return getDoc(db, Number(info.lastInsertRowid));
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

/** R13: full reverse of a posted reclass. */
function voidReclass(db, docId, body, user) {
  const reason = checkReason(body);
  const uid = (user && user.id) || null;
  const run = () => {
    ensureVariantReclassSchema(db);
    const doc = db.prepare('SELECT * FROM variant_reclass_docs WHERE id=?').get(parseInt(docId, 10) || 0);
    if (!doc) throw vrErr('E_VR_NOT_FOUND', 404, 'سند یافت نشد');
    if (doc.status !== 'posted') throw vrErr('E_VR_ALREADY_VOID', 409, 'سند قبلاً ابطال شده است');
    require('./cycle-count').assertWarehouseNotCounting(db, [doc.warehouse_id], { label: 'ابطال اصلاح تفکیک واریانت' });
    const { reverseInventoryMovement } = require('./ledger');
    const lines = JSON.parse(doc.lines_json || '[]');
    const note = `ابطال ${doc.doc_no}`;
    const { derivedQty } = require('./stock-cache');
    const inbound = lines.length && (() => {
      const r = db.prepare('SELECT qty_in FROM inventory_ledger WHERE id=?').get(lines[0].ledger_id);
      return r && Number(r.qty_in) > 0;
    })();
    if (inbound) {
      for (const l of lines) {
        const have = derivedQty(db, { productId: doc.product_id, warehouseId: doc.warehouse_id, variantId: l.variant_id });
        if (have + QTY_EPS < Number(l.qty)) {
          throw vrErr('E_VR_VARIANT_CONSUMED', 409,
            `موجودی واریانت ${l.sku || l.variant_id} (${have}) کمتر از سطر سند (${l.qty}) است — اول گردش‌های بعدی را برگردانید`);
        }
      }
    }
    const made = [];
    for (const l of lines) {
      const r = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(l.ledger_id);
      if (!r || !isLive(r)) throw vrErr('E_VR_LINE_NOT_LIVE', 409, `ردیف ${l.ledger_id} سند دیگر زنده نیست`);
      made.push(Number(reverseInventoryMovement(db, r.id, { createdBy: uid, date: r.date || '', note, skipStock: true, keepDate: true }).id));
    }
    const src = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(doc.source_ledger_id);
    const rv = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(doc.reversal_ledger_id);
    const rvTaken = rv && db.prepare('SELECT 1 FROM inventory_ledger WHERE reversed_of=? LIMIT 1').get(rv.id);
    if (!src || src.status !== 'reversed' || !rv || Number(rv.reversed_of) !== Number(src.id) || rvTaken) {
      throw vrErr('E_VR_SOURCE_CHANGED', 409, 'ردیف مبدأ یا معکوس آن پس از سند تغییر کرده است');
    }
    // The boot heal retirePostedReversalTwins may already have set rv.status='reversed', so its
    // counter-row is posted directly (a reversal may carry no variant). It puts the source value
    // back into the valuation buckets; the source row itself is what counts again in the live set.
    const { postInventoryMovement } = require('./ledger');
    made.push(Number(postInventoryMovement(db, {
      eventType: 'reversal',
      productId: rv.product_id,
      warehouseId: rv.warehouse_id,
      qtyIn: rv.qty_out,
      qtyOut: rv.qty_in,
      unitCostRial: rv.unit_cost_rial,
      amountRial: rv.amount_rial,
      sourceType: rv.source_type,
      sourceId: rv.source_id,
      batchId: rv.batch_id || null,
      reversedOf: rv.id,
      date: rv.date || '',
      note,
      createdBy: uid,
      updateAvg: false,
      skipStock: true,
    }).id));
    db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=?").run(rv.id);
    db.prepare("UPDATE inventory_ledger SET status='posted' WHERE id=? AND status='reversed'").run(src.id);
    db.prepare(`
      UPDATE variant_reclass_docs
      SET status='void', voided_by=?, voided_at=strftime('%s','now'), void_reason=?, void_ledger_ids=?
      WHERE id=? AND status='posted'
    `).run(uid, reason, made.join(','), doc.id);
    require('./stock-cache').rebuildStockCache(db, doc.product_id);
    return getDoc(db, doc.id);
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

function getDoc(db, id) {
  const d = db.prepare('SELECT * FROM variant_reclass_docs WHERE id=?').get(id);
  if (!d) return null;
  let lines = [];
  try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = []; }
  return { ...d, lines };
}

function listDocs(db, { productId = null, limit = 100 } = {}) {
  if (!tableExists(db, 'variant_reclass_docs')) return [];
  const where = productId ? 'WHERE d.product_id=?' : '';
  const args = productId ? [Number(productId)] : [];
  return db.prepare(`
    SELECT d.*, p.code AS product_code, p.name AS product_name
    FROM variant_reclass_docs d LEFT JOIN products p ON p.id=d.product_id
    ${where} ORDER BY d.id DESC LIMIT ?
  `).all(...args, Math.min(Number(limit) || 100, 500)).map((d) => {
    let lines = [];
    try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = []; }
    return { ...d, lines };
  });
}

module.exports = {
  DOC_PREFIX,
  SEQ_KEY,
  ensureVariantReclassSchema,
  planReclass,
  previewReclass,
  postReclass,
  voidReclass,
  getDoc,
  listDocs,
};
