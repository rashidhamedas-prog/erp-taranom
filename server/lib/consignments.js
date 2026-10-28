'use strict';
/**
 * CON-01 / CON-02 — consignment create, four settle paths, R13 void.
 * Stock via inventory ledger. Money INTEGER rial; postToLedger takes toman.
 */

const { audit, allocateNumber, isDevice, createLedgerEntry } = require('../db');
const { todayJalali } = require('../jalali');
const { parseQty } = require('./round3');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const {
  postInventoryMovement,
  warehouseQty,
  inventoryAccountForWarehouse,
} = require('./inventory/ledger');
const { reverseStockBySource, assertJournalIdempotent, autoApproveNormalInvoice } = require('./sales-document');
const { salesJournalLines, voidInvoiceFully } = require('./void-invoice');
const { reverseJournalEntry } = require('./void-journal');

const SETTLE_PATHS = new Set(['return', 'sale', 'purchase', 'shortage']);
const SETTLED_STATUSES = new Set(['sold', 'settled', 'returned', 'purchased', 'shortage']);
const OPEN_STATUS = 'open';

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function unitPriceRialFrom(bodyOrRow) {
  if (!bodyOrRow) return 0;
  if (bodyOrRow.unit_price_rial != null && bodyOrRow.unit_price_rial !== '') {
    return Math.round(Number(bodyOrRow.unit_price_rial) || 0);
  }
  // Legacy REAL unit_price is treated as rial (UI label is ریال).
  return Math.round(Number(bodyOrRow.unit_price) || 0);
}

function amountRial(row) {
  const q = Number(row.qty) || 0;
  return Math.round(unitPriceRialFrom(row) * q);
}

function inventoryAcct(db, warehouseId) {
  try {
    return inventoryAccountForWarehouse(db, warehouseId);
  } catch (e) {
    // Propagate leaf/map enforcement; only swallow unexpected errors
    if (e && (e.code === 'E_WAREHOUSE_COA_UNMAPPED' || e.code === 'E_WAREHOUSE_TYPE_UNSUPPORTED')) throw e;
    return acct(db, 'coa_inventory');
  }
}

function chartRow(db, code) {
  const c = code == null ? '' : String(code).trim();
  if (!c) return null;
  return db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(c) || null;
}

/**
 * Payable leaf of the consignor (audit 7B / #77): NEVER silently fall back to the
 * payroll/misc/AP control account. Order: person leaf → linked supplier tafsili
 * (ensureSupplierTafsili) → party tafsili (non-customer parties) → throw E_NO_PAYABLE_LEAF (422).
 * `allocate:false` (preview) never writes to the chart: it returns a placeholder instead.
 */
function payableAcct(db, person, { allocate = true } = {}) {
  const noLeaf = () => httpErr(
    422,
    `برای ${(person && person.name) || 'این شخص'} حساب تفصیلی پرداختنی (تأمین‌کننده) وجود ندارد — ابتدا تأمین‌کننده/تفصیلی بسازید`,
    'E_NO_PAYABLE_LEAF',
  );
  if (!person) throw noLeaf();
  const own = chartRow(db, person.coa_code);
  if (own) return own;
  if (!person.party_id) throw noLeaf();
  const { ensureSupplierTafsili, ensurePartyTafsili, parseRoles } = require('./party-tafsili');
  const supplier = db.prepare('SELECT id, coa_code FROM suppliers WHERE party_id=? ORDER BY id LIMIT 1').get(person.party_id);
  if (supplier) {
    if (!allocate) {
      return chartRow(db, supplier.coa_code) || { code: 'AUTO-TAFSILI', name: 'تفصیلی پرداختنی (هنگام ثبت ساخته می‌شود)' };
    }
    const row = chartRow(db, ensureSupplierTafsili(db, supplier.id));
    if (row) return row;
    throw noLeaf();
  }
  const party = db.prepare('SELECT id, coa_code, party_roles, party_type FROM parties WHERE id=?').get(person.party_id);
  if (party) {
    const roles = parseRoles(party.party_roles, party.party_type);
    if (!roles.includes('customer')) {
      if (!allocate) {
        return chartRow(db, party.coa_code) || { code: 'AUTO-TAFSILI', name: 'تفصیلی پرداختنی (هنگام ثبت ساخته می‌شود)' };
      }
      const row = chartRow(db, ensurePartyTafsili(db, party.id));
      if (row) return row;
    }
  }
  throw noLeaf();
}

function consignCarryAcct(db) {
  try { return acct(db, 'coa_subcontract_inventory'); }
  catch (_) { return acct(db, 'coa_inventory'); }
}

function ensureConsignIssueJeCol(db) {
  const cols = db.prepare('PRAGMA table_info(consignments)').all().map((c) => c.name);
  if (!cols.includes('issue_je_id')) {
    db.exec('ALTER TABLE consignments ADD COLUMN issue_je_id INTEGER');
  }
}

function expenseAcct(db) {
  try { return acct(db, 'coa_inventory_loss'); } catch (_) {
    try { return acct(db, 'coa_admin_expense'); } catch (__) {
      return acct(db, 'coa_cogs');
    }
  }
}

function resolveWarehouse(db, warehouseId) {
  if (warehouseId) {
    const wh = db.prepare('SELECT * FROM warehouses WHERE id=? AND COALESCE(active,1)=1').get(Number(warehouseId));
    if (!wh) throw httpErr(400, 'انبار معتبر نیست', 'E_WH_INVALID');
    return wh;
  }
  const first = db.prepare(`
    SELECT * FROM warehouses WHERE COALESCE(active,1)=1
    ORDER BY COALESCE(is_default,0) DESC, id ASC LIMIT 1
  `).get();
  if (!first) throw httpErr(400, 'انبار فعالی تعریف نشده', 'E_WH_REQUIRED');
  return first;
}

function resolvePerson(db, personId) {
  const id = parseInt(personId, 10);
  if (!id) throw httpErr(400, 'انتخاب شخص الزامی است', 'E_PERSON_REQUIRED');
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(id);
  if (!person) throw httpErr(404, 'شخص یافت نشد', 'E_PERSON_NOT_FOUND');
  return person;
}

function getConsignment(db, id) {
  const row = db.prepare('SELECT * FROM consignments WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'یافت نشد', 'E_CONSIGNMENT_NOT_FOUND');
  return row;
}

function isSettled(row) {
  return SETTLED_STATUSES.has(row.status) || row.record_status === 'reversed' || row.status === 'reversed';
}

function assertOpen(row) {
  if (row.record_status === 'reversed' || row.status === 'reversed') {
    throw httpErr(409, 'این امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_REVERSED');
  }
  if (isSettled(row)) {
    throw httpErr(409, 'این امانی قبلاً تسویه شده است', 'E_CONSIGNMENT_SETTLED');
  }
  if (row.status !== OPEN_STATUS) {
    throw httpErr(409, 'این امانی قبلاً تسویه شده است', 'E_CONSIGNMENT_SETTLED');
  }
}

function findCustomerForPerson(db, person) {
  const viaUserParty = db.prepare(`
    SELECT c.* FROM customers c
    JOIN users u ON u.party_id = c.party_id
    WHERE u.person_id = ? AND c.party_id IS NOT NULL
    LIMIT 1
  `).get(person.id);
  if (viaUserParty) return viaUserParty;

  if (person.phone) {
    const byPhone = db.prepare(`
      SELECT c.* FROM customers c
      LEFT JOIN parties p ON p.id = c.party_id
      WHERE c.phone = ? OR p.phone = ?
      LIMIT 1
    `).get(person.phone, person.phone);
    if (byPhone) return byPhone;
  }

  const byName = db.prepare(`
    SELECT c.* FROM customers c
    LEFT JOIN parties p ON p.id = c.party_id
    WHERE c.biz = ? OR c.owner = ? OR p.full_name = ?
    LIMIT 1
  `).get(person.name, person.name, person.name);
  if (byName) return byName;

  return null;
}

function createCustomerForPerson(db, person, userId) {
  const result = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, type, status, note)
    VALUES (?,?,?,?, 'بوتیک', 'active', ?)
  `).run(userId, person.name, person.name, person.phone || '', 'consignment person#' + person.id);
  const id = result.lastInsertRowid;
  try { require('./parties-sync').syncCustomerToParty(db, id); } catch (_) { /* parties optional */ }
  return db.prepare('SELECT * FROM customers WHERE id=?').get(id);
}

function resolveCustomerForSale(db, person, userId, { createIfMissing }) {
  const found = findCustomerForPerson(db, person);
  if (found) return found;
  if (!createIfMissing) return null;
  return createCustomerForPerson(db, person, userId);
}

function customerIsConsignor(db, customer, consignor) {
  if (!customer || !consignor) return false;
  const linked = findCustomerForPerson(db, consignor);
  if (linked && linked.id === customer.id) return true;
  if (customer.note && String(customer.note).includes('consignment person#' + consignor.id)) return true;
  return false;
}

/** M1: in+sale buyer must be explicit and distinct from the consignor. */
function resolveExplicitBuyer(db, body, consignor, userId) {
  const custId = parseInt(body && body.cust_id, 10);
  const buyerPersonId = parseInt(body && body.buyer_person_id, 10);
  if (!custId && !buyerPersonId) {
    throw httpErr(400, 'برای فروش امانی دریافتی خریدار جدا از امانت‌گذار الزامی است', 'E_CONSIGNMENT_BUYER');
  }
  if (buyerPersonId && consignor && buyerPersonId === Number(consignor.id)) {
    throw httpErr(400, 'خریدار نمی‌تواند همان امانت‌گذار باشد', 'E_CONSIGNMENT_BUYER');
  }
  let customer = null;
  if (custId) {
    customer = db.prepare('SELECT * FROM customers WHERE id=?').get(custId);
    if (!customer) throw httpErr(400, 'مشتری خریدار یافت نشد', 'E_CONSIGNMENT_BUYER');
  } else {
    const buyer = resolvePerson(db, buyerPersonId);
    customer = resolveCustomerForSale(db, buyer, userId, { createIfMissing: true });
  }
  if (consignor && customerIsConsignor(db, customer, consignor)) {
    throw httpErr(400, 'خریدار نمی‌تواند همان امانت‌گذار باشد', 'E_CONSIGNMENT_BUYER');
  }
  return customer;
}

function inventoryCostRial(product, qty) {
  const q = Number(qty) || 0;
  const { productUnitCostRial } = require('./inventory/product-unit-cost');
  return Math.round(productUnitCostRial(product) * q);
}

function cogsLines(db, warehouseId, amt, { outShipped = false } = {}) {
  const L = rialToLedger(amt);
  const cogs = acct(db, 'coa_cogs');
  const inv = outShipped ? consignCarryAcct(db) : inventoryAcct(db, warehouseId);
  return [
    { code: cogs.code, name: cogs.name, debit: L, credit: 0, description: 'بهای تمام‌شده فروش امانی' },
    { code: inv.code, name: inv.name, debit: 0, credit: L, description: 'بهای تمام‌شده فروش امانی' },
  ];
}

function createSaleInvoice(db, { user, customer, row, product, date, note }) {
  const amt = amountRial(row);
  const num = isDevice()
    ? ('موقت-' + Date.now().toString(36).toUpperCase())
    : allocateNumber(db, 'invoice', 'T');
  const invRows = [{
    product_id: row.product_id,
    name: product.name,
    qty: row.qty,
    price: unitPriceRialFrom(row),
    sum: amt,
    warehouse_id: row.warehouse_id,
  }];
  const result = db.prepare(`
    INSERT INTO invoices (
      user_id, cust_id, num, type, date, note, rows,
      subtotal, disc, disc_amt, final, vat_amount, vat_rate,
      subtotal_rial, final_rial, vat_amount_rial,
      pay_type, stock_deducted, warehouse_id, party_id
    ) VALUES (?,?,?,?,?,?,?,?,0,0,?,0,0,?,?,0,'credit',0,?,?)
  `).run(
    user.id, customer.id, num, 'normal', date, note || '',
    JSON.stringify(invRows), amt, amt, amt, amt,
    row.warehouse_id || null, customer.party_id || null
  );
  const invId = result.lastInsertRowid;
  createLedgerEntry(db, {
    customer_id: customer.id, date, entry_type: 'invoice',
    ref_type: 'invoice', ref_id: invId,
    description: `فاکتور معمولی ${num} (امانی)`,
    debit: amt, credit: 0, user_id: user.id,
  });
  assertJournalIdempotent(db, 'invoice', invId);
  const jeId = postToLedger(db, {
    sourceType: 'invoice',
    sourceId: invId,
    date,
    description: `فاکتور معمولی ${num} (امانی)`,
    createdBy: user.id,
    lines: salesJournalLines(db, customer.id, {
      subtotal: amt, discAmt: 0, final: amt, vatAmount: 0, netBeforeVat: amt,
    }, false, { payType: 'credit', rows: invRows }),
  });
  autoApproveNormalInvoice(db, invId, user.id);
  return { invId, jeId, num };
}

function purchaseLines(db, warehouseId, amt, person, opts) {
  const L = rialToLedger(amt);
  const inv = inventoryAcct(db, warehouseId);
  const pay = payableAcct(db, person, opts);
  return [
    { code: inv.code, name: inv.name, debit: L, credit: 0, description: 'خرید قطعی امانی' },
    { code: pay.code, name: pay.name, debit: 0, credit: L, description: 'خرید قطعی امانی' },
  ];
}

function shortageLines(db, row, amt, person, opts) {
  const L = rialToLedger(amt);
  const exp = expenseAcct(db);
  if (row.direction === 'out') {
    // After ship reclass, carrying amount sits in subcontract/consignment inventory.
    const inv = consignCarryAcct(db);
    return [
      { code: exp.code, name: exp.name, debit: L, credit: 0, description: 'کسری کالای امانی' },
      { code: inv.code, name: inv.name, debit: 0, credit: L, description: 'کسری کالای امانی' },
    ];
  }
  const pay = payableAcct(db, person, opts);
  return [
    { code: exp.code, name: exp.name, debit: L, credit: 0, description: 'کسری امانی دریافتی' },
    { code: pay.code, name: pay.name, debit: 0, credit: L, description: 'کسری امانی دریافتی' },
  ];
}

function sketchPreview({ path, row, stockDelta, invoice, journal, nextStatus }) {
  return {
    preview: true,
    path,
    direction: row.direction,
    stock_delta: stockDelta,
    invoice: !!invoice,
    journal: journal || [],
    next_status: nextStatus,
    amount_rial: amountRial(row),
  };
}

function listConsignments(db, { direction, status, doc_id } = {}) {
  const where = [];
  const params = [];
  if (direction) { where.push('c.direction=?'); params.push(direction); }
  if (doc_id) { where.push('c.doc_id=?'); params.push(Number(doc_id)); }
  if (status === 'settled') {
    where.push("c.status IN ('settled','sold')");
  } else if (status) {
    where.push('c.status=?');
    params.push(status);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT c.*, p.name AS product_name, p.code AS product_code,
      pe.name AS person_name, pc.name AS color_name, ps.name AS size_name,
      d.num AS doc_num, d.status AS doc_status, d.line_count AS doc_line_count
    FROM consignments c
    LEFT JOIN products p ON c.product_id = p.id
    LEFT JOIN persons pe ON c.person_id = pe.id
    LEFT JOIN product_variants pv ON pv.id = c.variant_id
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    LEFT JOIN consignment_docs d ON d.id = c.doc_id
    ${whereSql}
    ORDER BY COALESCE(c.doc_id, c.id) DESC, COALESCE(c.line_no, 0) ASC, c.created_at DESC
  `).all(...params);
}

function listConsignmentDocs(db, { direction, status } = {}) {
  const where = [];
  const params = [];
  if (direction) { where.push('d.direction=?'); params.push(direction); }
  if (status) { where.push('d.status=?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT d.*, pe.name AS person_name, w.name AS warehouse_name
    FROM consignment_docs d
    LEFT JOIN persons pe ON pe.id = d.person_id
    LEFT JOIN warehouses w ON w.id = d.warehouse_id
    ${whereSql}
    ORDER BY d.date DESC, d.id DESC
  `).all(...params);
}

function getConsignmentDoc(db, id) {
  const doc = db.prepare(`
    SELECT d.*, pe.name AS person_name, w.name AS warehouse_name
    FROM consignment_docs d
    LEFT JOIN persons pe ON pe.id = d.person_id
    LEFT JOIN warehouses w ON w.id = d.warehouse_id
    WHERE d.id=?
  `).get(id);
  if (!doc) throw httpErr(404, 'سند امانی یافت نشد', 'E_CONSIGNMENT_DOC_NOT_FOUND');
  return doc;
}

function loadDocLines(db, docId) {
  return listConsignments(db, { doc_id: docId });
}

function deriveDocStatus(lines) {
  if (!lines || !lines.length) return 'open';
  const statuses = lines.map((l) => l.status);
  if (statuses.every((s) => s === 'reversed')) return 'reversed';
  const open = statuses.filter((s) => s === OPEN_STATUS).length;
  const settledLike = statuses.filter((s) => SETTLED_STATUSES.has(s)).length;
  if (open === statuses.length) return 'open';
  if (settledLike === statuses.length) return 'settled';
  if (open === 0 && statuses.every((s) => SETTLED_STATUSES.has(s) || s === 'reversed')) return 'settled';
  return 'partial';
}

function refreshDocStatus(db, docId) {
  if (!docId) return null;
  const lines = db.prepare('SELECT status, qty FROM consignments WHERE doc_id=?').all(docId);
  if (!lines.length) return null;
  const status = deriveDocStatus(lines);
  const recordStatus = status === 'reversed' ? 'reversed' : 'active';
  const qtyTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  db.prepare(`
    UPDATE consignment_docs
    SET status=?, record_status=?, line_count=?, qty_total=?
    WHERE id=?
  `).run(status, recordStatus, lines.length, qtyTotal, docId);
  return status;
}

function normalizeCreateLines(body) {
  if (Array.isArray(body.lines) && body.lines.length) {
    return body.lines.map((l, i) => ({
      product_id: l.product_id,
      variant_id: l.variant_id,
      variant_lines: l.variant_lines,
      qty: l.qty,
      unit_price: l.unit_price,
      unit_price_rial: l.unit_price_rial != null ? l.unit_price_rial : l.unit_price,
      note: l.note || '',
      _idx: i + 1,
    }));
  }
  if (body.product_id) {
    return [{
      product_id: body.product_id,
      variant_id: body.variant_id,
      variant_lines: body.variant_lines,
      qty: body.qty,
      unit_price: body.unit_price,
      unit_price_rial: body.unit_price_rial != null ? body.unit_price_rial : body.unit_price,
      note: '',
      _idx: 1,
    }];
  }
  return [];
}

function assertUniqueLineKeys(lines) {
  const seen = new Set();
  for (const l of lines) {
    const key = String(l.product_id) + ':' + String(l.variant_id || 0);
    if (seen.has(key)) {
      throw httpErr(400, 'در یک سند امانی نمی‌توان دو ردیف یکسان (کالا+رنگ/سایز) داشت', 'E_CONSIGNMENT_DUP_LINE');
    }
    seen.add(key);
  }
}

function hydrateLineProduct(db, line) {
  const q = parseQty(line.qty);
  if (!line.product_id || !q || q <= 0) {
    throw httpErr(400, 'کالا و تعداد معتبر برای هر ردیف الزامی است', 'E_QTY');
  }
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(line.product_id);
  if (!product) throw httpErr(404, 'کالا یافت نشد', 'E_PRODUCT_NOT_FOUND');
  const { resolveApparelLines } = require('./inventory/apparel-lines');
  const apparelLines = resolveApparelLines(db, {
    productId: product.id, qty: q, variantId: line.variant_id, variantLines: line.variant_lines,
  });
  if (apparelLines.length > 1) {
    throw httpErr(400, 'امانی را برای هر رنگ و سایز جدا ثبت کنید', 'E_VARIANT_REQUIRED');
  }
  const variantId = apparelLines.length ? apparelLines[0].variantId : null;
  return {
    product,
    qty: q,
    priceRial: unitPriceRialFrom(line),
    variantId,
    apparelLines,
    note: line.note || '',
    lineNo: line._idx || 1,
  };
}

/** Insert one line inside an open transaction (no nested db.transaction). */
function insertConsignmentLine(db, {
  direction, person, warehouse, date, headerNote, user,
  hydrated, docId, lineNo,
}) {
  const { product, qty, priceRial, variantId, apparelLines, note } = hydrated;
  const partyName = person.name;
  const partyPhone = person.phone || '';
  ensureConsignIssueJeCol(db);
  let issueLedgerId = null;
  let issueJeId = null;
  if (direction === 'out') {
    const seedQty = product.warehouse_id === warehouse.id ? (Number(product.stock) || 0) : 0;
    db.prepare(`
      INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO NOTHING
    `).run(product.id, warehouse.id, seedQty);
    const mv = postInventoryMovement(db, {
      eventType: 'issue',
      productId: product.id,
      warehouseId: warehouse.id,
      qtyOut: qty,
      sourceType: 'consignment',
      sourceId: 0,
      date,
      note: `ارسال امانی به ${partyName}`,
      createdBy: user.id,
      updateAvg: false,
    });
    issueLedgerId = mv.id;
  }
  const result = db.prepare(`
    INSERT INTO consignments (
      direction, party_name, party_phone, product_id, qty, unit_price,
      date, note, status, created_by,
      person_id, warehouse_id, unit_price_rial, issue_ledger_id, record_status, variant_id,
      doc_id, line_no
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    direction, partyName, partyPhone, product.id, qty, priceRial,
    date, note || headerNote || '', OPEN_STATUS, user.id,
    person.id, warehouse.id, priceRial, issueLedgerId, 'active', variantId,
    docId || null, lineNo
  );
  const id = result.lastInsertRowid;
  if (direction === 'out' && apparelLines.length) {
    require('./inventory/apparel-lines').postApparelLines(db, {
      productId: product.id, warehouseId: warehouse.id, lines: apparelLines,
      docType: 'consignment_issue', docId: id, userId: user.id,
      note: `ارسال امانی به ${partyName}`, sign: -1, allowNegative: false,
    });
  }
  if (issueLedgerId) {
    db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(id, issueLedgerId);
  }
  // Keep qty in source WH books for ops reports, but reclass GL to consignment inventory (1114).
  if (direction === 'out') {
    const costRial = inventoryCostRial(product, qty);
    const fromAcct = inventoryAcct(db, warehouse.id);
    const toAcct = consignCarryAcct(db);
    if (costRial > 0 && fromAcct.code !== toAcct.code) {
      assertJournalIdempotent(db, 'consignment_ship', id);
      const L = rialToLedger(costRial);
      issueJeId = postToLedger(db, {
        sourceType: 'consignment_ship',
        sourceId: id,
        date,
        description: `ارسال امانی به ${partyName} #${id}`,
        createdBy: user.id,
        lines: [
          { code: toAcct.code, name: toAcct.name, debit: L, credit: 0, description: 'موجودی امانی نزد دیگری' },
          { code: fromAcct.code, name: fromAcct.name, debit: 0, credit: L, description: 'خروج به امانی' },
        ],
      });
      db.prepare('UPDATE consignments SET issue_je_id=? WHERE id=?').run(issueJeId, id);
    }
  }
  audit(user.id, 'create', 'consignment', id,
    `کالای امانی ${direction === 'out' ? 'ارسالی به' : 'دریافتی از'} ${partyName}: ${qty} عدد ${product.name}`
    + (docId ? ` (سند #${docId} خط ${lineNo})` : ''));
  return db.prepare(`
    SELECT c.*, p.name AS product_name, p.code AS product_code, pe.name AS person_name,
      d.num AS doc_num
    FROM consignments c
    LEFT JOIN products p ON c.product_id=p.id
    LEFT JOIN persons pe ON c.person_id=pe.id
    LEFT JOIN consignment_docs d ON d.id=c.doc_id
    WHERE c.id=?
  `).get(id);
}

function createConsignmentDoc(db, body, user) {
  const direction = body.direction;
  if (!direction || !['in', 'out'].includes(direction)) {
    throw httpErr(400, 'جهت امانت (نزد ما/نزد دیگری) الزامی است', 'E_DIRECTION');
  }
  const person = resolvePerson(db, body.person_id);
  const warehouse = resolveWarehouse(db, body.warehouse_id);
  const date = body.date || todayJalali();
  const headerNote = body.note || '';
  const rawLines = normalizeCreateLines(body);
  if (!rawLines.length) {
    throw httpErr(400, 'حداقل یک ردیف کالا الزامی است', 'E_CONSIGNMENT_LINES');
  }
  if (rawLines.length > 200) {
    throw httpErr(400, 'حداکثر ۲۰۰ ردیف در یک سند امانی مجاز است', 'E_CONSIGNMENT_LINES_MAX');
  }
  assertUniqueLineKeys(rawLines);
  const hydrated = rawLines.map((l) => hydrateLineProduct(db, l));
  const seenHydrated = new Set();
  for (const h of hydrated) {
    const key = String(h.product.id) + ':' + String(h.variantId || 0);
    if (seenHydrated.has(key)) {
      throw httpErr(400, 'در یک سند امانی نمی‌توان دو ردیف یکسان (کالا+رنگ/سایز) داشت', 'E_CONSIGNMENT_DUP_LINE');
    }
    seenHydrated.add(key);
  }

  return db.transaction(() => {
    const num = isDevice()
      ? ('موقت-CS-' + Date.now().toString(36).toUpperCase())
      : allocateNumber(db, 'consignment', 'CS');
    const qtyTotal = hydrated.reduce((s, h) => s + h.qty, 0);
    const docIns = db.prepare(`
      INSERT INTO consignment_docs (
        num, direction, person_id, party_name, party_phone, warehouse_id,
        date, note, status, record_status, line_count, qty_total, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      num, direction, person.id, person.name, person.phone || '', warehouse.id,
      date, headerNote, OPEN_STATUS, 'active', hydrated.length, qtyTotal, user.id
    );
    const docId = docIns.lastInsertRowid;
    const lines = [];
    for (let i = 0; i < hydrated.length; i++) {
      lines.push(insertConsignmentLine(db, {
        direction, person, warehouse, date, headerNote, user,
        hydrated: hydrated[i], docId, lineNo: i + 1,
      }));
    }
    audit(user.id, 'create', 'consignment_doc', docId,
      `سند امانی ${num}: ${hydrated.length} ردیف / ${qtyTotal} عدد — ${direction === 'out' ? 'ارسالی به' : 'دریافتی از'} ${person.name}`);
    const doc = getConsignmentDoc(db, docId);
    // Backward-compatible shape: single-line callers still get line fields at top level.
    const first = lines[0];
    return {
      ...first,
      doc_id: docId,
      doc_num: num,
      num,
      count: lines.length,
      doc,
      lines,
    };
  })();
}

function createConsignment(db, body, user) {
  return createConsignmentDoc(db, body, user);
}

function settleEffects(db, row, path, body, user) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(row.product_id) || { name: '' };
  const amt = amountRial(row);
  if (path === 'return') {
    const stockDelta = row.direction === 'out'
      ? { product_id: row.product_id, warehouse_id: row.warehouse_id, qty: row.qty, eventType: 'receipt' }
      : null;
    return { stockDelta, invoice: false, journal: [], nextStatus: 'returned', product, amt };
  }
  if (path === 'sale') {
    const person = row.person_id ? db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id) : null;
    if (row.direction === 'in') {
      const buyer = resolveExplicitBuyer(db, body || {}, person, user && user.id);
      const journal = salesJournalLines(db, buyer.id, {
        subtotal: amt, discAmt: 0, final: amt, vatAmount: 0, netBeforeVat: amt,
      }, false, { payType: 'credit' });
      return { stockDelta: null, invoice: true, journal, nextStatus: 'sold', product, amt, customer: buyer, person };
    }
    const customer = person ? findCustomerForPerson(db, person) : null;
    const journal = [];
    if (customer) {
      journal.push(...salesJournalLines(db, customer.id, {
        subtotal: amt, discAmt: 0, final: amt, vatAmount: 0, netBeforeVat: amt,
      }, false, { payType: 'credit' }));
    }
    const cogsAmt = inventoryCostRial(product, row.qty);
    if (cogsAmt > 0) journal.push(...cogsLines(db, row.warehouse_id, cogsAmt, { outShipped: true }));
    return { stockDelta: null, invoice: true, journal, nextStatus: 'sold', product, amt, customer, person, cogsAmt };
  }
  if (path === 'purchase') {
    if (row.direction === 'out') {
      throw httpErr(400, 'خرید قطعی برای امانی ارسالی معنا ندارد', 'E_CONSIGNMENT_PATH');
    }
    const person = row.person_id ? db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id) : null;
    return {
      stockDelta: { product_id: row.product_id, warehouse_id: row.warehouse_id, qty: row.qty, eventType: 'receipt' },
      invoice: false,
      journal: purchaseLines(db, row.warehouse_id, amt, person, { allocate: !(body && body.preview) }),
      nextStatus: 'purchased',
      product,
      amt,
      person,
    };
  }
  if (path === 'shortage') {
    // OUT shortage must credit inventory at carrying cost, not selling price.
    const lossAmt = row.direction === 'out'
      ? (inventoryCostRial(product, row.qty) || amt)
      : amt;
    const person = row.person_id ? db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id) : null;
    return {
      stockDelta: null,
      invoice: false,
      journal: shortageLines(db, row, lossAmt, person, { allocate: !(body && body.preview) }),
      nextStatus: 'shortage',
      product,
      amt: lossAmt,
      person,
    };
  }
  throw httpErr(400, 'مسیر تسویه نامعتبر است', 'E_CONSIGNMENT_PATH');
}

function postConsignmentVariant(db, row, user, docType, note, sign) {
  if (!row.variant_id) {
    const { resolveApparelLines } = require('./inventory/apparel-lines');
    resolveApparelLines(db, { productId: row.product_id, qty: row.qty });
    return;
  }
  require('./inventory/apparel-lines').postApparelLines(db, {
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    lines: [{ variantId: row.variant_id, qty: row.qty }],
    docType,
    docId: row.id,
    userId: user.id,
    note,
    sign,
    allowNegative: false,
  });
}

function applySettle(db, row, path, { date, note, user, body }) {
  const effects = settleEffects(db, row, path, body, user);
  let invoiceId = null;
  let settleJeId = null;
  const person = row.person_id
    ? db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id)
    : { id: null, name: row.party_name, phone: row.party_phone };

  if (path === 'return' && row.direction === 'out') {
    if (row.issue_je_id) {
      reverseJournalEntry(db, row.issue_je_id, {
        userId: user.id, date, reason: note || 'برگشت امانی',
      });
      db.prepare('UPDATE consignments SET issue_je_id=NULL WHERE id=?').run(row.id);
    }
    postInventoryMovement(db, {
      eventType: 'receipt',
      productId: row.product_id,
      warehouseId: row.warehouse_id,
      qtyIn: row.qty,
      sourceType: 'consignment',
      sourceId: row.id,
      date,
      note: note || `برگشت امانی از ${row.party_name}`,
      createdBy: user.id,
      updateAvg: true,
    });
    postConsignmentVariant(db, row, user, 'consignment_return', note || `برگشت امانی از ${row.party_name}`, 1);
  }

  if (path === 'sale') {
    if (row.direction === 'out') {
      const customer = resolveCustomerForSale(db, person, user.id, { createIfMissing: true });
      if (!customer) throw httpErr(400, 'مشتری برای صدور فاکتور امانی یافت نشد', 'E_CONSIGNMENT_CUSTOMER');
      const inv = createSaleInvoice(db, {
        user, customer, row, product: effects.product, date, note: note || `فروش قطعی امانی #${row.id}`,
      });
      invoiceId = inv.invId;
      const cogsAmt = inventoryCostRial(effects.product, row.qty);
      if (cogsAmt > 0) {
        assertJournalIdempotent(db, 'consignment_cogs', row.id);
        settleJeId = postToLedger(db, {
          sourceType: 'consignment_cogs',
          sourceId: row.id,
          date,
          description: note || `بهای تمام‌شده فروش امانی #${row.id}`,
          createdBy: user.id,
          lines: cogsLines(db, row.warehouse_id, cogsAmt, { outShipped: true }),
        });
      }
    } else {
      // IN consignment: buy-then-sell — ownership transfers before revenue.
      const buyer = resolveExplicitBuyer(db, body || {}, person, user.id);
      const purchaseAmt = effects.amt;
      if (purchaseAmt > 0) {
        assertJournalIdempotent(db, 'consignment_purchase', row.id);
        settleJeId = postToLedger(db, {
          sourceType: 'consignment_purchase',
          sourceId: row.id,
          date,
          description: note || `خرید از امانت‌گذار پیش از فروش امانی #${row.id}`,
          createdBy: user.id,
          lines: purchaseLines(db, row.warehouse_id, purchaseAmt, person),
        });
      }
      postInventoryMovement(db, {
        eventType: 'receipt',
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        qtyIn: row.qty,
        unitCostRial: unitPriceRialFrom(row),
        amountRial: purchaseAmt,
        sourceType: 'consignment',
        sourceId: row.id,
        date,
        note: note || `ورود برای فروش امانی دریافتی #${row.id}`,
        createdBy: user.id,
        updateAvg: true,
      });
      postConsignmentVariant(db, row, user, 'consignment_purchase', note || `ورود فروش امانی #${row.id}`, 1);
      const inv = createSaleInvoice(db, {
        user, customer: buyer, row, product: effects.product, date, note: note || `فروش قطعی امانی #${row.id}`,
      });
      invoiceId = inv.invId;
      const {
        postSaleStockMovements, postCogsFromMovements, warehouseUsesPerpetualValuation,
      } = require('./sales-document');
      const stocked = postSaleStockMovements(db, {
        rows: [{
          product_id: row.product_id,
          name: effects.product.name,
          qty: row.qty,
          warehouse_id: row.warehouse_id,
          variant_id: row.variant_id || null,
        }],
        warehouseId: row.warehouse_id,
        sourceType: 'invoice',
        sourceId: inv.invId,
        userId: user.id,
        date,
        note: note || `فروش امانی دریافتی #${row.id}`,
      });
      db.prepare('UPDATE invoices SET stock_deducted=1 WHERE id=?').run(inv.invId);
      const cogsAmt = stocked.cogsRial || purchaseAmt;
      // Periodic warehouse: qty moved above; valuation JE only at period-close.
      if (cogsAmt > 0 && warehouseUsesPerpetualValuation(db, row.warehouse_id)) {
        const invCoa = inventoryAccountForWarehouse(db, row.warehouse_id);
        const cogsJe = postCogsFromMovements(db, {
          invId: inv.invId, num: inv.num, date, userId: user.id, cogsRial: cogsAmt,
          inventoryCoaCode: invCoa.code,
        });
        if (!settleJeId) settleJeId = cogsJe;
      }
    }
  }

  if (path === 'purchase') {
    postInventoryMovement(db, {
      eventType: 'receipt',
      productId: row.product_id,
      warehouseId: row.warehouse_id,
      qtyIn: row.qty,
      unitCostRial: unitPriceRialFrom(row),
      amountRial: effects.amt,
      sourceType: 'consignment',
      sourceId: row.id,
      date,
      note: note || `خرید قطعی امانی #${row.id}`,
      createdBy: user.id,
      updateAvg: true,
    });
    postConsignmentVariant(db, row, user, 'consignment_purchase', note || `خرید قطعی امانی #${row.id}`, 1);
    if (effects.amt > 0) {
      assertJournalIdempotent(db, 'consignment_purchase', row.id);
      settleJeId = postToLedger(db, {
        sourceType: 'consignment_purchase',
        sourceId: row.id,
        date,
        description: note || `خرید قطعی امانی #${row.id}`,
        createdBy: user.id,
        lines: purchaseLines(db, row.warehouse_id, effects.amt, person),
      });
    }
  }

  if (path === 'shortage' && effects.amt > 0) {
    assertJournalIdempotent(db, 'consignment_shortage', row.id);
    settleJeId = postToLedger(db, {
      sourceType: 'consignment_shortage',
      sourceId: row.id,
      date,
      description: note || `کسری امانی #${row.id}`,
      createdBy: user.id,
      lines: shortageLines(db, row, effects.amt, person),
    });
  }

  db.prepare(`
    UPDATE consignments
    SET status=?, settle_path=?, invoice_id=?, settle_je_id=?, note=CASE WHEN ?!='' THEN ? ELSE note END
    WHERE id=?
  `).run(effects.nextStatus, path, invoiceId, settleJeId, note || '', note || row.note, row.id);

  if (row.doc_id) refreshDocStatus(db, row.doc_id);

  audit(user.id, 'update', 'consignment', row.id, `تسویه امانی مسیر ${path} → ${effects.nextStatus}`);
  return {
    ok: true,
    id: row.id,
    status: effects.nextStatus,
    settle_path: path,
    invoice_id: invoiceId,
    settle_je_id: settleJeId,
    doc_id: row.doc_id || null,
  };
}

function settleConsignment(db, id, body, user) {
  const path = String(body.path || '').trim();
  if (!SETTLE_PATHS.has(path)) {
    throw httpErr(400, 'مسیر تسویه نامعتبر است (return|sale|purchase|shortage)', 'E_CONSIGNMENT_PATH');
  }
  const row = getConsignment(db, id);
  assertOpen(row);
  const date = body.date || todayJalali();
  const note = body.note || '';
  if (body.preview) {
    const effects = settleEffects(db, row, path, body, user);
    return sketchPreview({
      path, row,
      stockDelta: effects.stockDelta,
      invoice: effects.invoice,
      journal: effects.journal,
      nextStatus: effects.nextStatus,
    });
  }
  return db.transaction(() => {
    const fresh = getConsignment(db, id);
    assertOpen(fresh);
    return applySettle(db, fresh, path, { date, note, user, body });
  })();
}

function voidConsignmentLineCore(db, fresh, user, { reason } = {}) {
  const date = todayJalali();
  if (fresh.invoice_id) {
    try {
      db.prepare('UPDATE invoices SET stock_deducted=0 WHERE id=?').run(fresh.invoice_id);
      voidInvoiceFully(db, fresh.invoice_id, user, { reason: reason || 'consignment_cancel' });
    } catch (e) {
      if (e.status === 404 || (e.message && e.message.includes('ابطال شده'))) {
        /* already voided */
      } else {
        throw e;
      }
    }
  }
  if (fresh.settle_je_id) {
    const je = db.prepare('SELECT ref_type FROM journal_entries WHERE id=?').get(fresh.settle_je_id);
    if (je && je.ref_type !== 'invoice') {
      reverseJournalEntry(db, fresh.settle_je_id, {
        userId: user.id, date, reason: reason || 'ابطال امانی',
      });
    }
  }
  if (fresh.issue_je_id) {
    reverseJournalEntry(db, fresh.issue_je_id, {
      userId: user.id, date, reason: reason || 'ابطال ارسال امانی',
    });
  }
  reverseStockBySource(db, 'consignment', fresh.id, {
    createdBy: user.id, date, note: `ابطال امانی #${fresh.id}`,
  });
  const { reverseApparelDoc } = require('./inventory/apparel-lines');
  for (const docType of ['consignment_issue', 'consignment_return', 'consignment_purchase']) {
    reverseApparelDoc(db, {
      docType, docId: fresh.id, userId: user.id, note: `ابطال امانی #${fresh.id}`,
    });
  }
  db.prepare(`
    UPDATE consignments SET status='reversed', record_status='reversed' WHERE id=?
  `).run(fresh.id);
  audit(user.id, 'void', 'consignment', fresh.id, `ابطال کالای امانی #${fresh.id}`);
  return { ok: true, id: fresh.id, status: 'reversed', record_status: 'reversed', doc_id: fresh.doc_id || null };
}

function voidConsignment(db, id, user, { reason } = {}) {
  const row = getConsignment(db, id);
  if (row.record_status === 'reversed' || row.status === 'reversed') {
    throw httpErr(409, 'این امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_REVERSED');
  }
  return db.transaction(() => {
    const fresh = getConsignment(db, id);
    if (fresh.record_status === 'reversed' || fresh.status === 'reversed') {
      throw httpErr(409, 'این امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_REVERSED');
    }
    const result = voidConsignmentLineCore(db, fresh, user, { reason });
    if (fresh.doc_id) refreshDocStatus(db, fresh.doc_id);
    return result;
  })();
}

/** R13: void every line of a consignment document (no physical delete). */
function voidConsignmentDoc(db, docId, user, { reason } = {}) {
  const doc = getConsignmentDoc(db, docId);
  if (doc.record_status === 'reversed' || doc.status === 'reversed') {
    throw httpErr(409, 'این سند امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_DOC_REVERSED');
  }
  return db.transaction(() => {
    const freshDoc = getConsignmentDoc(db, docId);
    if (freshDoc.record_status === 'reversed' || freshDoc.status === 'reversed') {
      throw httpErr(409, 'این سند امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_DOC_REVERSED');
    }
    const lines = db.prepare('SELECT * FROM consignments WHERE doc_id=? ORDER BY line_no ASC, id ASC').all(docId);
    const voided = [];
    for (const line of lines) {
      if (line.record_status === 'reversed' || line.status === 'reversed') continue;
      voided.push(voidConsignmentLineCore(db, line, user, { reason: reason || 'consignment_doc_cancel' }));
    }
    const status = refreshDocStatus(db, docId) || 'reversed';
    db.prepare(`UPDATE consignment_docs SET status=?, record_status='reversed' WHERE id=?`)
      .run(status === 'reversed' ? 'reversed' : status, docId);
    // If any line was already settled+voided, derive may be settled; force reversed when all lines reversed.
    const allRev = db.prepare(`
      SELECT COUNT(*) AS c FROM consignments
      WHERE doc_id=? AND status!='reversed'
    `).get(docId).c === 0;
    if (allRev) {
      db.prepare(`UPDATE consignment_docs SET status='reversed', record_status='reversed' WHERE id=?`).run(docId);
    }
    audit(user.id, 'void', 'consignment_doc', docId,
      `ابطال سند امانی ${freshDoc.num || '#' + docId}: ${voided.length} ردیف`);
    return {
      ok: true,
      id: docId,
      doc_id: docId,
      num: freshDoc.num,
      status: allRev ? 'reversed' : (refreshDocStatus(db, docId) || 'reversed'),
      record_status: 'reversed',
      voided_count: voided.length,
      lines: voided,
    };
  })();
}

module.exports = {
  listConsignments,
  listConsignmentDocs,
  getConsignmentDoc,
  loadDocLines,
  createConsignment,
  createConsignmentDoc,
  settleConsignment,
  voidConsignment,
  voidConsignmentDoc,
  warehouseQty,
  unitPriceRialFrom,
  SETTLE_PATHS,
  // audit 7B — consignor payable leaf (throws E_NO_PAYABLE_LEAF; no silent misc/AP fallback)
  payableAcct,
};
