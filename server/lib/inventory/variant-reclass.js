'use strict';
/**
 * سند اصلاح تفکیک واریانت (VR-####).
 *
 * یک ردیف زندهٔ کاردکس بدون variant_id روی کالای رنگ×سایز را به تفکیک واریانت دوباره ثبت می‌کند:
 *   ۱) همان رویداد / منبع / تاریخ / سند حسابداری / بها، یک ردیف برای هر واریانت (Σ تعداد و Σ مبلغ = ردیف اصلی)
 *   ۲) معکوس ردیف اصلی (reverseInventoryMovement)
 * هر دو با skipStock: میانگین، لایهٔ بها و پارک دورهٔ بسته دست نمی‌خورد؛ سطل ارزش‌گذاری خالص صفر.
 * سند حسابداری جدید ندارد (حساب موجودی و مبلغ ثابت است) و موجودی فقط از کاردکس بازسازی می‌شود.
 *   ۳) برای هر سطر یک ردیف inventory_movements (لایهٔ ممیزی واریانت×انبار، doc_type=variant_reclass،
 *      doc_id=سند، doc_line=ردیف کاردکس تفکیکی) تا Σ حرکت‌ها با vws یکی باشد؛ عدد موجودی نمی‌نویسد.
 *
 * ابطال (R13): ردیف‌های تفکیکی معکوس، معکوسِ ردیف اصلی خودش معکوس و ردیف اصلی دوباره زنده می‌شود؛
 * هر حرکت سطر با variant_reclass_void قرینه می‌شود. حذف فیزیکی نداریم.
 */
const { round3 } = require('../round3');

const DOC_PREFIX = 'VR';
const SEQ_KEY = 'variant_reclass';
const MOV_DOC_TYPE = 'variant_reclass';
const MOV_VOID_DOC_TYPE = 'variant_reclass_void';
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

function findMovement(db, { docType, docId, docLine, warehouseId, variantId }) {
  return db.prepare(`
    SELECT * FROM inventory_movements
    WHERE doc_type=? AND doc_id=? AND COALESCE(doc_line,-1)=COALESCE(?,-1)
      AND COALESCE(warehouse_id,0)=COALESCE(?,0) AND COALESCE(variant_id,0)=COALESCE(?,0)
    LIMIT 1
  `).get(docType, docId, docLine, warehouseId, variantId) || null;
}

/**
 * Audit row only (same columns as movement.postVariantLayer). Deliberately NOT postVariantLayer:
 * that path also rebuilds caches and refuses inactive variants; here the ledger rows already carry
 * the qty and the caller rebuilds once with forceVariantLedger. Idempotent on the doc key.
 */
function writeMovement(db, m) {
  const hit = findMovement(db, m);
  if (hit) return Number(hit.id);
  return Number(db.prepare(`
    INSERT INTO inventory_movements
      (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, doc_line, user_id, note)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(m.productId, m.variantId, m.warehouseId, round3(m.qtyDelta), m.docType, m.docId, m.docLine,
    m.userId, m.note || '').lastInsertRowid);
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

/** Variant split changes the matrix the site shows — tell website sync (lazy, best-effort, no warehouseId). */
function notifyWebsiteStock(db, productId) {
  if (!productId) return;
  try {
    require('../website-stock-sync').notifyStockChanged(db, productId);
  } catch (_) { /* best-effort */ }
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
    const docId = Number(info.lastInsertRowid);
    if (tableExists(db, 'inventory_movements')) {
      const sign = isIn ? 1 : -1;
      for (const l of linesJson) {
        if (!l.ledger_id) continue;
        l.movement_id = writeMovement(db, {
          productId: row.product_id,
          variantId: l.variant_id,
          warehouseId: row.warehouse_id,
          qtyDelta: sign * l.qty,
          docType: MOV_DOC_TYPE,
          docId,
          docLine: l.ledger_id,
          userId: uid,
          note,
        });
      }
      db.prepare('UPDATE variant_reclass_docs SET lines_json=? WHERE id=?').run(JSON.stringify(linesJson), docId);
    }
    require('./stock-cache').rebuildStockCache(db, row.product_id, { forceVariantLedger: true });
    return getDoc(db, docId);
  };
  const doc = db.inTransaction ? run() : db.transaction(run)();
  notifyWebsiteStock(db, doc && doc.product_id);
  return doc;
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
    // Counter only the movements this doc actually wrote (docs posted before the movement layer have none).
    let linesOut = lines;
    if (tableExists(db, 'inventory_movements')) {
      linesOut = lines.map((l) => {
        const key = { docId: doc.id, docLine: l.ledger_id, warehouseId: doc.warehouse_id, variantId: l.variant_id };
        const m = (l.movement_id && db.prepare('SELECT * FROM inventory_movements WHERE id=? AND doc_type=?').get(l.movement_id, MOV_DOC_TYPE))
          || findMovement(db, { ...key, docType: MOV_DOC_TYPE });
        if (!m) return l;
        const voidId = writeMovement(db, {
          ...key,
          productId: m.product_id,
          variantId: m.variant_id,
          warehouseId: m.warehouse_id,
          qtyDelta: -(Number(m.qty_delta) || 0),
          docType: MOV_VOID_DOC_TYPE,
          docLine: m.doc_line,
          userId: uid,
          note,
        });
        return { ...l, movement_id: Number(m.id), void_movement_id: voidId };
      });
    }
    db.prepare(`
      UPDATE variant_reclass_docs
      SET status='void', voided_by=?, voided_at=strftime('%s','now'), void_reason=?, void_ledger_ids=?, lines_json=?
      WHERE id=? AND status='posted'
    `).run(uid, reason, made.join(','), JSON.stringify(linesOut), doc.id);
    require('./stock-cache').rebuildStockCache(db, doc.product_id, { forceVariantLedger: true });
    return getDoc(db, doc.id);
  };
  const voided = db.inTransaction ? run() : db.transaction(run)();
  notifyWebsiteStock(db, voided && voided.product_id);
  return voided;
}

function getDoc(db, id) {
  const d = db.prepare('SELECT * FROM variant_reclass_docs WHERE id=?').get(id);
  if (!d) return null;
  let lines = [];
  try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = []; }
  return { ...d, lines };
}

/**
 * Colour split on the other side of a transfer (for guided remainder).
 * Prefer a posted VR on the peer source row (even if that peer is now reversed);
 * else sum live attributed peer rows. Skip qty-0 / *revalue* peers.
 * @returns {{ doc_no, vr_doc_no, lines:[{variant_id,qty}], exact:boolean }|null}
 */
function resolveCounterpart(db, row, productId, warehouseId, sourceQty) {
  const st = String(row.source_type || '');
  const et = String(row.event_type || '');
  if (!(et === 'transfer_out' || et === 'transfer_in' || st === 'warehouse_move') || !row.source_id) {
    return null;
  }
  const peers = db.prepare(`
    SELECT l.id, l.tx_no, l.warehouse_id, l.event_type, l.source_type, l.source_id,
      l.variant_id, l.status, l.reversed_of, l.qty_in, l.qty_out
    FROM inventory_ledger l
    WHERE l.product_id=? AND l.source_id=? AND COALESCE(l.source_type,'')=?
      AND l.id<>? AND COALESCE(l.warehouse_id,0)<>COALESCE(?,0)
      AND COALESCE(l.event_type,'') NOT IN ('reversal')
      AND COALESCE(l.event_type,'') NOT GLOB '*_reversal'
      AND LOWER(COALESCE(l.event_type,'')) NOT GLOB '*revalue*'
    ORDER BY l.id ASC
  `).all(productId, row.source_id, st, row.id, warehouseId);

  const withQty = peers.filter((p) => {
    const q = Math.abs(Number(p.qty_in) || 0) + Math.abs(Number(p.qty_out) || 0);
    return q > QTY_EPS;
  });
  if (!withQty.length) return null;

  if (tableExists(db, 'variant_reclass_docs')) {
    for (const p of withQty) {
      const vr = db.prepare(
        "SELECT id, doc_no, lines_json FROM variant_reclass_docs WHERE source_ledger_id=? AND status='posted'"
      ).get(p.id);
      if (!vr) continue;
      let raw = [];
      try { raw = JSON.parse(vr.lines_json || '[]'); } catch (_) { raw = []; }
      const lines = [];
      const seen = new Set();
      for (const l of raw) {
        const vid = Number(l && (l.variant_id != null ? l.variant_id : l.variantId)) || 0;
        const q = round3(Number(l && l.qty) || 0);
        if (!vid || !(q > 0) || seen.has(vid)) continue;
        seen.add(vid);
        lines.push({ variant_id: vid, qty: q });
      }
      const sum = round3(lines.reduce((a, l) => a + l.qty, 0));
      return {
        doc_no: p.tx_no || '',
        vr_doc_no: vr.doc_no || null,
        lines,
        exact: Math.abs(sum - sourceQty) <= QTY_EPS,
      };
    }
  }

  const attributed = withQty.filter((p) => isLive(p) && Number(p.variant_id) > 0);
  if (!attributed.length) return null;
  const byVar = new Map();
  for (const p of attributed) {
    const vid = Number(p.variant_id);
    const q = round3(Number(p.qty_in) || Number(p.qty_out) || 0);
    byVar.set(vid, round3((byVar.get(vid) || 0) + q));
  }
  const lines = [...byVar.entries()]
    .filter(([, q]) => q > QTY_EPS)
    .map(([variant_id, qty]) => ({ variant_id, qty }))
    .sort((a, b) => a.variant_id - b.variant_id);
  const sum = round3(lines.reduce((a, l) => a + l.qty, 0));
  return {
    doc_no: attributed[0].tx_no || '',
    vr_doc_no: null,
    lines,
    exact: Math.abs(sum - sourceQty) <= QTY_EPS,
  };
}

/**
 * Guided remainder (net mode): leftover per colour + exact transfer counterpart lines.
 * Outbound steps use counterpart.lines; inbound = leftover + Σ outbound counterpart per colour.
 * @returns {{ ok:boolean, error?:string, blocked?:boolean, steps?:object[] }}
 */
function planGuidedRemainder({ candidates, leftoverLines } = {}) {
  const elig = (candidates || []).filter((c) => c && c.eligible !== false);
  const transfers = elig.filter((c) => {
    const et = String(c.event_type || '');
    const st = String(c.source_type || '');
    return et === 'transfer_out' || et === 'transfer_in' || st === 'warehouse_move';
  });
  if (transfers.some((c) => !c.counterpart || c.counterpart.exact !== true
    || !Array.isArray(c.counterpart.lines) || !c.counterpart.lines.length)) {
    return {
      ok: false,
      blocked: true,
      error: 'برای این کالا تفکیک خودکار ممکن نیست؛ هر ردیف را جدا تفکیک کنید.',
      steps: [],
    };
  }

  const leftover = new Map();
  for (const l of leftoverLines || []) {
    const vid = Number(l.variant_id || l.variantId) || 0;
    const q = round3(Number(l.qty) || 0);
    if (!vid) continue;
    leftover.set(vid, round3((leftover.get(vid) || 0) + q));
  }

  const inRows = elig.filter((c) => c.direction === 'in').sort((a, b) => Number(a.ledger_id) - Number(b.ledger_id));
  const outRows = elig.filter((c) => c.direction === 'out').sort((a, b) => Number(a.ledger_id) - Number(b.ledger_id));
  const counterpartByVar = new Map();
  const steps = [];

  for (const r of outRows) {
    const lines = (r.counterpart.lines || []).map((l) => ({
      variant_id: Number(l.variant_id),
      qty: round3(Number(l.qty) || 0),
    })).filter((l) => l.variant_id && l.qty > 0);
    const sum = round3(lines.reduce((a, l) => a + l.qty, 0));
    if (Math.abs(sum - Number(r.qty)) > QTY_EPS) {
      return {
        ok: false,
        blocked: true,
        error: `تفکیک طرف مقابل خروج (${r.tx_no || r.ledger_id}) با تعداد ردیف یکی نیست (اختلاف ${round3(sum - Number(r.qty))}).`,
        steps: [],
      };
    }
    for (const l of lines) {
      counterpartByVar.set(l.variant_id, round3((counterpartByVar.get(l.variant_id) || 0) + l.qty));
    }
    steps.push({
      ledger_id: Number(r.ledger_id),
      tx_no: r.tx_no || '',
      direction: 'out',
      qty: Number(r.qty),
      lines,
    });
  }

  const inByVar = new Map();
  const allVids = new Set([...leftover.keys(), ...counterpartByVar.keys()]);
  for (const vid of allVids) {
    const q = round3((leftover.get(vid) || 0) + (counterpartByVar.get(vid) || 0));
    if (q > QTY_EPS) inByVar.set(vid, q);
  }
  const inTotal = round3([...inByVar.values()].reduce((a, q) => a + q, 0));
  const inNeed = round3(inRows.reduce((a, r) => a + Number(r.qty), 0));
  if (inRows.length && Math.abs(inTotal - inNeed) > QTY_EPS) {
    return {
      ok: false,
      error: `جمع برنامهٔ ورود (${inTotal}) با تعداد ردیف‌های ورود (${inNeed}) یکی نیست (اختلاف ${round3(inTotal - inNeed)}). ماندهٔ شمارش‌شده + تفکیک طرف مقابل باید دقیقاً برابر ردیف ورود باشد.`,
      steps: [],
    };
  }

  // Inbound first: greedy fill by ledger id order.
  const inSteps = [];
  let remaining = new Map(inByVar);
  for (const r of inRows) {
    let need = round3(Number(r.qty));
    const lines = [];
    for (const [vid, left] of [...remaining.entries()]) {
      if (need <= QTY_EPS) break;
      if (!(left > QTY_EPS)) continue;
      const take = round3(Math.min(need, left));
      lines.push({ variant_id: vid, qty: take });
      remaining.set(vid, round3(left - take));
      need = round3(need - take);
    }
    if (need > QTY_EPS) {
      return {
        ok: false,
        error: `پخش ردیف ورود ${r.tx_no || r.ledger_id} کامل نشد (کمبود ${need}).`,
        steps: [],
      };
    }
    const sum = round3(lines.reduce((a, l) => a + l.qty, 0));
    if (Math.abs(sum - Number(r.qty)) > QTY_EPS) {
      return {
        ok: false,
        error: `جمع تفکیک ورود (${sum}) با تعداد ردیف (${r.qty}) یکی نیست (اختلاف ${round3(sum - Number(r.qty))}).`,
        steps: [],
      };
    }
    inSteps.push({
      ledger_id: Number(r.ledger_id),
      tx_no: r.tx_no || '',
      direction: 'in',
      qty: Number(r.qty),
      lines,
    });
  }

  return { ok: true, steps: inSteps.concat(steps) };
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

/**
 * Read-only eligibility list for the VR UI. Same predicates as planReclass (without lines).
 * @returns {{ product_id, warehouse_id, product, warehouse, integer, allow_negative,
 *   kardex_qty, attributed_qty, unallocated_net, variants, candidates }}
 */
function listCandidates(db, { productId = null, warehouseId = null } = {}) {
  const pid = parseInt(productId, 10) || 0;
  const wid = parseInt(warehouseId, 10) || 0;
  if (!pid) throw vrErr('E_VR_PRODUCT_REQUIRED', 400, 'کالا الزامی است');
  if (!wid) throw vrErr('E_VR_WAREHOUSE_REQUIRED', 400, 'انبار الزامی است');

  const product = db.prepare('SELECT id, code, name, unit, stock FROM products WHERE id=?').get(pid);
  if (!product) throw vrErr('E_VR_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const warehouse = db.prepare(
    'SELECT id, code, name, COALESCE(allow_negative,0) AS allow_negative FROM warehouses WHERE id=?'
  ).get(wid);
  if (!warehouse) throw vrErr('E_VR_WAREHOUSE_NOT_FOUND', 404, 'انبار یافت نشد');

  const { hasActiveMatrixVariants } = require('./movement');
  if (!hasActiveMatrixVariants(db, pid)) {
    throw vrErr('E_VR_NOT_MATRIX', 409, 'کالا رنگ×سایز فعال ندارد');
  }

  const { requiresIntegerQty } = require('./qty-policy');
  const integer = !!requiresIntegerQty(db, pid, product.unit);

  const variants = db.prepare(`
    SELECT v.id AS variant_id, v.sku, v.active, COALESCE(v.is_default,0) AS is_default,
      c.name AS color_name, s.name AS size_name,
      COALESCE(vws.qty, 0) AS qty
    FROM product_variants v
    LEFT JOIN product_colors c ON c.id=v.color_id
    LEFT JOIN product_sizes s ON s.id=v.size_id
    LEFT JOIN variant_warehouse_stock vws ON vws.variant_id=v.id AND vws.warehouse_id=?
    WHERE v.product_id=? AND COALESCE(v.is_default,0)=0 AND COALESCE(v.active,0)=1
    ORDER BY c.sort_order, c.name, s.sort_order, s.name, v.id
  `).all(wid, pid);

  const { deriveProductStock } = require('./stock-cache');
  const derived = deriveProductStock(db, pid);
  const kardexQty = round3(derived.warehouses.get(wid) || 0);
  let attributedQty = 0;
  for (const [k, q] of derived.variantWarehouses) {
    if (k.endsWith(`:${wid}`)) attributedQty = round3(attributedQty + (Number(q) || 0));
  }
  const unallocatedNet = round3(derived.unattributed.get(wid) || 0);

  const { isWarehouseOnlyRow } = require('./ledger');
  const postedVr = tableExists(db, 'variant_reclass_docs')
    ? new Set(db.prepare(
      "SELECT source_ledger_id FROM variant_reclass_docs WHERE status='posted' AND product_id=?"
    ).all(pid).map((r) => Number(r.source_ledger_id)))
    : new Set();

  const rows = db.prepare(`
    SELECT id, tx_no, date, event_type, source_type, source_id, warehouse_id,
      variant_id, status, reversed_of, qty_in, qty_out, amount_rial, je_id, note
    FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=?
    ORDER BY id ASC
  `).all(pid, wid);

  const candidates = [];
  for (const row of rows) {
    if (!isLive(row)) continue;
    if (Number(row.variant_id) > 0) continue;
    const qtyIn = Number(row.qty_in) || 0;
    const qtyOut = Number(row.qty_out) || 0;
    if ((qtyIn > 0) === (qtyOut > 0)) continue;
    if (isWarehouseOnlyRow(row)) continue;
    if (postedVr.has(Number(row.id))) continue;
    const direction = qtyIn > 0 ? 'in' : 'out';
    const qty = round3(qtyIn || qtyOut);
    const counterpart = resolveCounterpart(db, row, pid, wid, qty);
    candidates.push({
      ledger_id: Number(row.id),
      tx_no: row.tx_no || '',
      date: row.date || '',
      event_type: row.event_type || '',
      source_type: row.source_type || '',
      source_id: row.source_id,
      warehouse_id: wid,
      direction,
      qty,
      qty_in: qtyIn,
      qty_out: qtyOut,
      amount_rial: Math.round(Number(row.amount_rial) || 0),
      je_id: row.je_id || null,
      note: row.note || '',
      eligible: true,
      counterpart,
    });
  }

  return {
    product_id: pid,
    warehouse_id: wid,
    product: { id: product.id, code: product.code, name: product.name, unit: product.unit || '' },
    warehouse: {
      id: warehouse.id,
      code: warehouse.code,
      name: warehouse.name,
      allow_negative: Number(warehouse.allow_negative) ? 1 : 0,
    },
    integer,
    allow_negative: Number(warehouse.allow_negative) ? 1 : 0,
    kardex_qty: kardexQty,
    attributed_qty: attributedQty,
    unallocated_net: unallocatedNet,
    variants,
    candidates,
  };
}

module.exports = {
  DOC_PREFIX,
  SEQ_KEY,
  MOV_DOC_TYPE,
  MOV_VOID_DOC_TYPE,
  ensureVariantReclassSchema,
  planReclass,
  previewReclass,
  postReclass,
  voidReclass,
  getDoc,
  listDocs,
  listCandidates,
  resolveCounterpart,
  planGuidedRemainder,
};
