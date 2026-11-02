'use strict';
/**
 * P7 — حالت «اول دوره» در دریافت مواد / طاقه.
 *
 * همان سند opening_stock_docs (P2 / v609) — جدول جدید نیست:
 *   - هر کالا×انبار یک خط opening_stock_lines (کلید یکتای ux_opening_stock_active دست‌نخورده)؛
 *     طاقه‌ها/بچ‌ها تا ثبت قطعی در rolls_json همان خط می‌مانند.
 *   - مقدار خط همیشه به واحد کارت کالا است (ورود به متر/یارد/کیلو با تبدیل uom.resolveRollEntry).
 *   - post (opening-stock.postDoc): هر طاقه ⇒ یک inventory_batches (kind fabric/attr، بدون تأمین‌کننده)
 *     + یک ردیف کاردکس event=opening با batch_id؛ یک JE: Dr حساب موجودی انبار / Cr 3102.
 *   - void (opening-stock.voidDoc): برگشت همهٔ ردیف‌های کاردکس طاقه‌ها + JE + بستن بچ‌ها (R13).
 *   - ویرایش = ابطال کامل سند قبلی + پیش‌نویس جدید (amends_doc_id) در یک تراکنش.
 * فقط مدیر و حسابداری.
 */
const OS = require('./opening-stock');
const { assertNoLiveOpening } = require('./opening-guard');

const { osErr } = OS;
const MAX_ROLLS = 500;
const SOURCE = 'opening_stock_doc';

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

function isAdminOrAccounting(user) {
  const role = String((user && user.role) || '');
  return role === 'admin' || role === 'accounting';
}

function assertRole(user) {
  if (!isAdminOrAccounting(user)) {
    throw osErr('E_PERMISSION', 403, 'موجودی اول دوره مواد/طاقه فقط برای مدیر و حسابداری مجاز است');
  }
}

function hasRolls(row) {
  return !!(row && row.rolls_json && String(row.rolls_json).trim() && String(row.rolls_json).trim() !== '[]');
}

function parseRolls(row) {
  if (!hasRolls(row)) return [];
  try {
    const arr = JSON.parse(row.rolls_json);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function docHasRolls(db, docId) {
  return !!db.prepare(`
    SELECT 1 FROM opening_stock_lines
    WHERE doc_id=? AND rolls_json IS NOT NULL AND TRIM(rolls_json) NOT IN ('','[]') LIMIT 1
  `).get(docId);
}

/**
 * یک خط کالا×انبار با چند طاقه را اعتبارسنجی و به واحد کالا تبدیل می‌کند (بدون نوشتن).
 * raw: { product_id, warehouse_id, profile?, entry_unit_id?, entry_factor?, unit_cost_rial (به ازای واحد ورود),
 *        rolls:[{ roll_no, color, pattern, width_cm, entry_qty|length|qty, weight_kg }] }
 */
function normalizeLine(db, raw, idx = 0) {
  const FR = require('./fabric-rolls');
  const n = idx + 1;
  const productId = Number(raw && raw.product_id) || 0;
  if (!productId) throw osErr('E_OPENING_LINE', 400, `ردیف ${n}: کالا الزامی است`);
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!prod) throw osErr('E_PRODUCT_NOT_FOUND', 404, `ردیف ${n}: کالا یافت نشد`);
  if (raw.variant_id != null && raw.variant_id !== '' && Number(raw.variant_id) > 0) {
    throw osErr('E_OPENING_LINE', 400, `ردیف ${n}: طاقه/بچ اول دوره روی واریانت ثبت نمی‌شود`);
  }
  const wh = FR.requireRawWarehouse(db, raw.warehouse_id);
  const profile = FR.resolveReceiptProfile(prod, raw, db) === 'fabric' ? 'fabric' : 'attr';
  const rollsIn = Array.isArray(raw.rolls) ? raw.rolls : [];
  if (!rollsIn.length) throw osErr('E_OPENING_ROLLS_EMPTY', 400, `ردیف ${n}: حداقل یک طاقه/بچ لازم است`);
  if (rollsIn.length > MAX_ROLLS) throw osErr('E_OPENING_TOO_MANY', 400, `ردیف ${n}: حداکثر ${MAX_ROLLS} طاقه در هر خط`);

  const entryCost = Math.round(Number(raw.unit_cost_rial));
  if (!Number.isFinite(entryCost) || !(entryCost > 0)) {
    throw osErr('E_OPENING_COST_REQUIRED', 422, `ردیف ${n}: بهای واحد (ریال) باید بزرگ‌تر از صفر باشد`);
  }

  const uom = require('../uom');
  let entryUnitId = null;
  let entryFactor = null;
  const seenNo = new Set();
  const rolls = rollsIn.map((r, j) => {
    const m = `ردیف ${n} / طاقه ${j + 1}`;
    const rollNo = String((r && (r.roll_no || r.batch_no)) || '').trim().slice(0, 60);
    if (rollNo) {
      if (seenNo.has(rollNo)) throw osErr('E_FABRIC_DUP_ROLL', 409, `${m}: شمارهٔ «${rollNo}» تکراری است`);
      seenNo.add(rollNo);
      const clash = db.prepare('SELECT id FROM inventory_batches WHERE product_id=? AND batch_no=?').get(productId, rollNo);
      if (clash) throw osErr('E_FABRIC_DUP_ROLL', 409, `${m}: شمارهٔ «${rollNo}» برای این کالا قبلاً ثبت شده است`);
    }
    let color = String((r && r.color) || '').trim().slice(0, 80);
    const pattern = String((r && (r.pattern || r.design)) || '').trim().slice(0, 120);
    const widthCm = Math.round(Number(r && r.width_cm) || 0);
    if (widthCm < 0) throw osErr('E_FABRIC_WIDTH', 400, `${m}: عرض نامعتبر است`);
    const weightRaw = r && r.weight_kg != null && r.weight_kg !== '' ? Number(r.weight_kg) : null;
    if (weightRaw != null && (!Number.isFinite(weightRaw) || weightRaw < 0)) {
      throw osErr('E_FABRIC_WEIGHT', 400, `${m}: وزن نامعتبر است`);
    }
    const qtyRaw = r && (r.entry_qty != null ? r.entry_qty : (r.length != null ? r.length : (r.meters != null ? r.meters : r.qty)));
    let entryQty;
    let stockQty;
    let factor = 1;
    let token = String(prod.unit || '').trim();
    if (profile === 'fabric') {
      if (!color) throw osErr('E_FABRIC_COLOR', 400, `${m}: رنگ طاقه الزامی است`);
      let entry;
      try {
        entry = uom.resolveRollEntry(db, prod, {
          entry_unit_id: raw.entry_unit_id, unit: raw.unit, entry_qty: qtyRaw, entry_factor: raw.entry_factor,
        });
      } catch (e) {
        e.message = `${m}: ${e.message}`;
        throw e;
      }
      entryUnitId = entry.entry.id;
      entryFactor = entry.factor;
      entryQty = entry.entryQty;
      // کاتالوگ ضریب را ۶ رقمی گرد می‌کند (۹٫۱۴۴ متر → ۹٫۹۹۹۹۹۷ یارد)؛ مقدار انبار مثل سند v609 سه رقمی است.
      stockQty = round3(entry.stockQty);
      if (!(stockQty > 0)) throw osErr('E_FABRIC_METERS', 400, `${m}: مقدار تبدیل‌شده صفر شد`);
      factor = entry.factor;
      token = entry.token;
    } else {
      if (!color) color = '—';
      entryQty = Number(qtyRaw);
      if (!(entryQty > 0) || !Number.isFinite(entryQty)) {
        throw osErr('E_FABRIC_METERS', 400, `${m}: مقدار باید بزرگ‌تر از صفر باشد`);
      }
      // P9: مادهٔ واردشده به واحد دیگر (هم‌بعد) به واحد کالا تبدیل می‌شود؛ ناهم‌بعد رد می‌شود.
      let mat;
      try {
        mat = uom.resolveMaterialEntry(db, prod, { entry_unit_id: raw.entry_unit_id, unit: raw.unit }, entryQty);
      } catch (e) {
        e.message = `${m}: ${e.message}`;
        throw e;
      }
      stockQty = round3(mat.qty);
      factor = mat.factor;
      if (mat.converted) { entryUnitId = mat.entry.id; entryFactor = mat.factor; }
      if (!(stockQty > 0)) throw osErr('E_FABRIC_METERS', 400, `${m}: مقدار باید بزرگ‌تر از صفر باشد`);
    }
    try {
      uom.assertRollUnitMatchesProduct(db, prod, token);
    } catch (e) {
      e.message = `${m}: ${e.message}`;
      throw e;
    }
    const amount = Math.round(entryCost * entryQty);
    if (!(amount > 0)) throw osErr('E_OPENING_COST_REQUIRED', 422, `${m}: مبلغ طاقه صفر شد`);
    return {
      roll_no: rollNo, color, pattern, width_cm: widthCm,
      weight_kg: weightRaw == null ? null : Math.round(weightRaw * 1000) / 1000,
      entry_qty: round6(entryQty), stock_qty: stockQty, factor, unit: token,
      amount_rial: amount,
    };
  });

  const qty = round3(rolls.reduce((a, r) => a + r.stock_qty, 0));
  const amountRial = rolls.reduce((a, r) => a + r.amount_rial, 0);
  require('../money').assertSafeRial(amountRial, 'opening rolls amount');
  const unitCost = Math.max(1, Math.round(amountRial / qty));
  // همان اعتبارسنجی خط v609 (کالای ماتریسی، qty-policy، انبار فعال، ...)
  const base = OS.validateLine(db, { product_id: productId, warehouse_id: wh.id, variant_id: null, qty, unit_cost_rial: unitCost }, idx);
  return {
    ...base,
    qty,
    unit_cost_rial: unitCost,
    amount_rial: amountRial,
    profile,
    entry_unit_id: entryUnitId,
    entry_factor: entryFactor,
    entry_unit_cost_rial: entryCost,
    rolls,
  };
}

function insertDoc(db, ctx, { note, amendsDocId, user, lines }) {
  const { allocateNumber, isDevice } = require('../../db');
  const docNo = isDevice()
    ? ('موقت-OP-' + Date.now().toString(36).toUpperCase())
    : allocateNumber(db, 'opening_stock', 'OP');
  const docId = db.prepare(`
    INSERT INTO opening_stock_docs (doc_no, fiscal_year_id, date, status, created_by, note, amends_doc_id)
    VALUES (?,?,?,'draft',?,?,?)
  `).run(docNo, ctx.fiscalYearId, ctx.date, user ? user.id : null, note, amendsDocId || null).lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO opening_stock_lines (doc_id, fiscal_year_id, product_id, warehouse_id, variant_id, qty, unit_cost_rial, active,
      profile, rolls_json, entry_unit_id, entry_factor, entry_unit_cost_rial, amount_rial)
    VALUES (?,?,?,?,NULL,?,?,0,?,?,?,?,?,?)
  `);
  for (const l of lines) {
    ins.run(docId, ctx.fiscalYearId, l.product_id, l.warehouse_id, l.qty, l.unit_cost_rial,
      l.profile, JSON.stringify(l.rolls), l.entry_unit_id, l.entry_factor, l.entry_unit_cost_rial, l.amount_rial);
  }
  return docId;
}

/** پیش‌نویس سند اول دورهٔ طاقه/مواد. هیچ اثری روی موجودی/کاردکس/دفتر ندارد. */
function createRollsDraft(db, body, user, { amendsDocId = null } = {}) {
  assertRole(user);
  const rawLines = Array.isArray(body && body.lines) ? body.lines : [];
  if (!rawLines.length) throw osErr('E_OPENING_EMPTY', 400, 'سند افتتاحیه حداقل یک ردیف می‌خواهد');
  if (rawLines.length > 200) throw osErr('E_OPENING_TOO_MANY', 400, 'حداکثر ۲۰۰ ردیف کالا×انبار در هر سند');
  let docId;
  db.transaction(() => {
    const { getActiveFiscalYear } = require('../fiscal-period');
    const { fiscalOpeningDate } = require('../opening-post');
    const fy = getActiveFiscalYear(db);
    const ctx = { fiscalYearId: fy ? fy.id : null, date: fiscalOpeningDate(db) };
    const seen = new Set();
    const allNos = new Set();
    const lines = rawLines.map((r, i) => {
      const l = normalizeLine(db, r, i);
      const k = `${l.product_id}|${l.warehouse_id}`;
      if (seen.has(k)) throw osErr('E_OPENING_DUP_LINE', 400, `ردیف ${i + 1}: کالا/انبار تکراری در همین سند — همهٔ طاقه‌های یک کالا×انبار زیر یک ردیف`);
      seen.add(k);
      for (const roll of l.rolls) {
        if (!roll.roll_no) continue;
        const nk = `${l.product_id}|${roll.roll_no}`;
        if (allNos.has(nk)) throw osErr('E_FABRIC_DUP_ROLL', 409, `شمارهٔ طاقه «${roll.roll_no}» در این سند تکراری است`);
        allNos.add(nk);
      }
      return l;
    });
    for (const l of lines) {
      // یک افتتاحیهٔ زنده برای هر کالا×انبار: کاردکس opening / product_opening_stock / سند P2 / رسید افتتاحیه
      assertNoLiveOpening(db, { productId: l.product_id, warehouseId: l.warehouse_id, variantId: null, fiscalYearId: ctx.fiscalYearId });
    }
    const note = String((body && body.note) || '').trim().slice(0, 300) || 'موجودی اول دوره مواد/طاقه';
    docId = insertDoc(db, ctx, { note, amendsDocId, user, lines });
  })();
  return OS.getDoc(db, docId);
}

/**
 * ویرایش (R13): سند قبلی (پیش‌نویس یا ثبت‌شده) کامل ابطال می‌شود — کاردکس طاقه‌ها، بچ‌ها، JE —
 * و سند پیش‌نویس جدید با amends_doc_id ساخته می‌شود؛ همه در یک تراکنش. ثبت قطعی سند جدید با کاربر دیگر.
 */
function amendRollsDoc(db, id, body, user) {
  assertRole(user);
  const reason = String((body && body.reason) || '').trim();
  if (reason.length < 3) throw osErr('E_REASON_REQUIRED', 400, 'دلیل ویرایش الزامی است');
  let out;
  db.transaction(() => {
    const doc = db.prepare('SELECT * FROM opening_stock_docs WHERE id=?').get(id);
    if (!doc) throw osErr('E_OPENING_NOT_FOUND', 404, 'سند افتتاحیه یافت نشد');
    if (doc.status === 'void') throw osErr('E_OPENING_ALREADY_VOID', 409, 'سند ابطال‌شده قابل ویرایش نیست');
    if (!docHasRolls(db, doc.id)) throw osErr('E_OPENING_NOT_ROLLS', 409, 'این سند طاقه/مواد ندارد — از ابطال و سند جدید استفاده کنید');
    const voided = OS.voidDoc(db, doc.id, user, { reason: `ویرایش — ${reason}` });
    // شمارهٔ طاقهٔ فیزیکی در سند اصلاحی دوباره استفاده می‌شود؛ بچ ابطال‌شدهٔ قبلی برچسب آرشیوی می‌گیرد
    // (کاردکس با batch_id وصل است، نه شماره).
    const reuse = new Set();
    for (const ln of (Array.isArray(body && body.lines) ? body.lines : [])) {
      for (const r of (Array.isArray(ln && ln.rolls) ? ln.rolls : [])) {
        const no = String((r && (r.roll_no || r.batch_no)) || '').trim();
        if (no) reuse.add(`${Number(ln.product_id) || 0}|${no}`);
      }
    }
    if (reuse.size) {
      const old = db.prepare(`SELECT id, product_id, batch_no FROM inventory_batches
        WHERE source_type=? AND source_id=? AND status='reversed'`).all(SOURCE, doc.id);
      const ren = db.prepare('UPDATE inventory_batches SET batch_no=? WHERE id=?');
      for (const b of old) {
        if (reuse.has(`${b.product_id}|${b.batch_no}`)) ren.run(`${b.batch_no}~${doc.doc_no || ('X' + doc.id)}`, b.id);
      }
    }
    const fresh = createRollsDraft(db, { note: (body && body.note) != null ? body.note : doc.note, lines: body && body.lines }, user, { amendsDocId: doc.id });
    out = { voided, doc: fresh };
  })();
  return out;
}

/**
 * از opening-stock.postDoc صدا زده می‌شود (داخل همان تراکنش). هر طاقه ⇒ بچ + ردیف کاردکس opening.
 * خروجی: [{ warehouseId, amountRial, ledgerId }] برای JE + firstLedgerId برای خط.
 */
function postRollsLine(db, { doc, row, l, date, user, source }) {
  const L = require('./ledger');
  const { createBatch } = require('./batch-serial');
  const FR = require('./fabric-rolls');
  const rolls = parseRolls(row);
  if (!rolls.length) throw osErr('E_OPENING_ROLLS_EMPTY', 400, 'ردیف طاقه ندارد');
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(l.product_id);
  FR.requireRawWarehouse(db, l.warehouse_id);
  const kind = row.profile === 'attr' ? 'attr' : 'fabric';
  const label = kind === 'fabric' ? 'طاقه' : 'بچ مواد';
  const entryCost = Number(row.entry_unit_cost_rial) || 0;
  const uom = require('../uom');
  const out = [];
  for (const r of rolls) {
    // P9: کارت کالا ممکن است بعد از پیش‌نویس عوض شده باشد؛ مقدار ذخیره‌شده باید به واحد فعلی کالا باشد.
    uom.assertRollUnitMatchesProduct(db, prod, r.unit || String(prod && prod.unit || ''), `سند ${doc.doc_no} — ${label} ${r.roll_no || ''}`.trim());
    const stockQty = round3(r.stock_qty);
    const amount = Math.round(Number(r.amount_rial) || 0);
    const unitCost = stockQty > 0 ? Math.round(amount / stockQty) : 0;
    let batch;
    try {
      batch = createBatch(db, {
        productId: l.product_id,
        warehouseId: l.warehouse_id,
        batchNo: r.roll_no || undefined,
        qty: 0,
        note: `موجودی اول دوره — سند ${doc.doc_no}`,
        createdBy: user ? user.id : null,
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        throw osErr('E_FABRIC_DUP_ROLL', 409, `شمارهٔ ${label} «${r.roll_no}» برای این کالا قبلاً ثبت شده است`);
      }
      throw e;
    }
    db.prepare(`
      UPDATE inventory_batches
      SET kind=?, color=?, pattern=?, width_cm=?, unit=?, unit_cost_rial=?, supplier_id=NULL,
          qty_received=?, qty_on_hand=?, source_type=?, source_id=?, weight_kg=?
      WHERE id=?
    `).run(kind, r.color || (kind === 'fabric' ? 'نامشخص' : '—'), r.pattern || '', Math.round(Number(r.width_cm) || 0),
      r.unit || String(prod && prod.unit || ''), unitCost, stockQty, stockQty, source, doc.id,
      r.weight_kg == null ? null : Number(r.weight_kg), batch.id);
    if (row.entry_unit_id) {
      db.prepare(`
        UPDATE inventory_batches SET entry_unit_id=?, entry_qty=?, entry_factor=?, entry_unit_cost_rial=? WHERE id=?
      `).run(row.entry_unit_id, Number(r.entry_qty) || stockQty, Number(r.factor) || Number(row.entry_factor) || 1,
        entryCost ? Math.round(entryCost) : null, batch.id);
    }
    const led = L.postInventoryMovement(db, {
      eventType: 'opening',
      productId: l.product_id,
      warehouseId: l.warehouse_id,
      qtyIn: stockQty,
      unitCostRial: unitCost,
      amountRial: amount,
      sourceType: source,
      sourceId: doc.id,
      batchId: batch.id,
      date,
      note: `سند افتتاحیه انبار ${doc.doc_no} — ${label} ${batch.batch_no} — ${r.color || ''}`.slice(0, 300),
      createdBy: user ? user.id : null,
    });
    db.prepare('UPDATE inventory_batches SET ledger_id=? WHERE id=?').run(led.id, batch.id);
    out.push({ warehouseId: l.warehouse_id, amountRial: Math.round(Number(led.amount_rial) || amount), ledgerId: led.id, batchId: batch.id });
  }
  return out;
}

/** بچ‌های زندهٔ سند؛ اگر هر کدام مصرف شده باشد ⇒ 409 (هیچ چیز تغییر نمی‌کند). */
function assertDocRollsUnused(db, docId, source) {
  const FR = require('./fabric-rolls');
  const rows = db.prepare(`
    SELECT * FROM inventory_batches WHERE source_type=? AND source_id=? AND COALESCE(status,'')<>'reversed' ORDER BY id
  `).all(source, docId);
  for (const b of rows) {
    FR.applyLiveRollQty(db, b);
    if (!FR.rollUnused(b)) {
      throw osErr('E_FABRIC_CONSUMED', 409, `طاقه/بچ ${b.batch_no} مصرف شده است؛ ابتدا مصرف را برگردانید`);
    }
  }
  return rows;
}

/** از voidDoc (داخل تراکنش): کاردکس هر طاقه برمی‌گردد و بچ بسته می‌شود. */
function reverseDocRolls(db, { doc, batches, user, reversalJeId, note }) {
  const L = require('./ledger');
  for (const b of batches) {
    if (b.ledger_id) {
      const led = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(b.ledger_id);
      if (led && led.status !== 'reversed') {
        L.reverseInventoryMovement(db, b.ledger_id, { createdBy: user ? user.id : null, note });
      }
    }
    db.prepare(`
      UPDATE inventory_batches
      SET status='reversed', qty_on_hand=0, reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user ? user.id : null, reversalJeId || null, b.id);
  }
  return batches.length;
}

module.exports = {
  isAdminOrAccounting,
  assertRole,
  hasRolls,
  parseRolls,
  docHasRolls,
  normalizeLine,
  createRollsDraft,
  amendRollsDoc,
  postRollsLine,
  assertDocRollsUnused,
  reverseDocRolls,
};
