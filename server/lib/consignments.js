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
  } catch (_) {
    return acct(db, 'coa_inventory');
  }
}

function payableAcct(db) {
  try { return acct(db, 'coa_payable'); } catch (_) { return acct(db, 'coa_misc_persons'); }
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
  const avg = Math.round(Number(product && product.average_cost_rial) || 0);
  if (avg > 0) return Math.round(avg * q);
  const costToman = Number(product && product.cost) || 0;
  return Math.round(costToman * 10 * q);
}

function cogsLines(db, warehouseId, amt) {
  const L = rialToLedger(amt);
  const cogs = acct(db, 'coa_cogs');
  const inv = inventoryAcct(db, warehouseId);
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

function purchaseLines(db, warehouseId, amt) {
  const L = rialToLedger(amt);
  const inv = inventoryAcct(db, warehouseId);
  const pay = payableAcct(db);
  return [
    { code: inv.code, name: inv.name, debit: L, credit: 0, description: 'خرید قطعی امانی' },
    { code: pay.code, name: pay.name, debit: 0, credit: L, description: 'خرید قطعی امانی' },
  ];
}

function shortageLines(db, row, amt) {
  const L = rialToLedger(amt);
  const exp = expenseAcct(db);
  if (row.direction === 'out') {
    const inv = inventoryAcct(db, row.warehouse_id);
    return [
      { code: exp.code, name: exp.name, debit: L, credit: 0, description: 'کسری کالای امانی' },
      { code: inv.code, name: inv.name, debit: 0, credit: L, description: 'کسری کالای امانی' },
    ];
  }
  const pay = payableAcct(db);
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

function listConsignments(db, { direction, status } = {}) {
  const where = [];
  const params = [];
  if (direction) { where.push('c.direction=?'); params.push(direction); }
  if (status === 'settled') {
    where.push("c.status IN ('settled','sold')");
  } else if (status) {
    where.push('c.status=?');
    params.push(status);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT c.*, p.name AS product_name, p.code AS product_code,
      pe.name AS person_name
    FROM consignments c
    LEFT JOIN products p ON c.product_id = p.id
    LEFT JOIN persons pe ON c.person_id = pe.id
    ${whereSql}
    ORDER BY c.created_at DESC
  `).all(...params);
}

function createConsignment(db, body, user) {
  const direction = body.direction;
  if (!direction || !['in', 'out'].includes(direction)) {
    throw httpErr(400, 'جهت امانت (نزد ما/نزد دیگری) الزامی است', 'E_DIRECTION');
  }
  const person = resolvePerson(db, body.person_id);
  const q = parseQty(body.qty);
  if (!body.product_id || !q || q <= 0) {
    throw httpErr(400, 'کالا و تعداد معتبر الزامی است', 'E_QTY');
  }
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(body.product_id);
  if (!product) throw httpErr(404, 'کالا یافت نشد', 'E_PRODUCT_NOT_FOUND');
  const warehouse = resolveWarehouse(db, body.warehouse_id);
  const priceRial = unitPriceRialFrom(body);
  const date = body.date || todayJalali();
  const partyName = person.name;
  const partyPhone = person.phone || '';

  return db.transaction(() => {
    let issueLedgerId = null;
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
        qtyOut: q,
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
        person_id, warehouse_id, unit_price_rial, issue_ledger_id, record_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      direction, partyName, partyPhone, product.id, q, priceRial,
      date, body.note || '', OPEN_STATUS, user.id,
      person.id, warehouse.id, priceRial, issueLedgerId, 'active'
    );
    const id = result.lastInsertRowid;
    if (issueLedgerId) {
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(id, issueLedgerId);
    }
    audit(user.id, 'create', 'consignment', id,
      `کالای امانی ${direction === 'out' ? 'ارسالی به' : 'دریافتی از'} ${partyName}: ${q} عدد ${product.name}`);
    return db.prepare(`
      SELECT c.*, p.name AS product_name, p.code AS product_code, pe.name AS person_name
      FROM consignments c
      LEFT JOIN products p ON c.product_id=p.id
      LEFT JOIN persons pe ON c.person_id=pe.id
      WHERE c.id=?
    `).get(id);
  })();
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
    if (cogsAmt > 0) journal.push(...cogsLines(db, row.warehouse_id, cogsAmt));
    return { stockDelta: null, invoice: true, journal, nextStatus: 'sold', product, amt, customer, person, cogsAmt };
  }
  if (path === 'purchase') {
    if (row.direction === 'out') {
      throw httpErr(400, 'خرید قطعی برای امانی ارسالی معنا ندارد', 'E_CONSIGNMENT_PATH');
    }
    return {
      stockDelta: { product_id: row.product_id, warehouse_id: row.warehouse_id, qty: row.qty, eventType: 'receipt' },
      invoice: false,
      journal: purchaseLines(db, row.warehouse_id, amt),
      nextStatus: 'purchased',
      product,
      amt,
    };
  }
  if (path === 'shortage') {
    return {
      stockDelta: null,
      invoice: false,
      journal: shortageLines(db, row, amt),
      nextStatus: 'shortage',
      product,
      amt,
    };
  }
  throw httpErr(400, 'مسیر تسویه نامعتبر است', 'E_CONSIGNMENT_PATH');
}

function applySettle(db, row, path, { date, note, user, body }) {
  const effects = settleEffects(db, row, path, body, user);
  let invoiceId = null;
  let settleJeId = null;
  const person = row.person_id
    ? db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id)
    : { id: null, name: row.party_name, phone: row.party_phone };

  if (path === 'return' && row.direction === 'out') {
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
          lines: cogsLines(db, row.warehouse_id, cogsAmt),
        });
      }
    } else {
      const buyer = resolveExplicitBuyer(db, body || {}, person, user.id);
      const inv = createSaleInvoice(db, {
        user, customer: buyer, row, product: effects.product, date, note: note || `فروش قطعی امانی #${row.id}`,
      });
      invoiceId = inv.invId;
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
    if (effects.amt > 0) {
      assertJournalIdempotent(db, 'consignment_purchase', row.id);
      settleJeId = postToLedger(db, {
        sourceType: 'consignment_purchase',
        sourceId: row.id,
        date,
        description: note || `خرید قطعی امانی #${row.id}`,
        createdBy: user.id,
        lines: purchaseLines(db, row.warehouse_id, effects.amt),
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
      lines: shortageLines(db, row, effects.amt),
    });
  }

  db.prepare(`
    UPDATE consignments
    SET status=?, settle_path=?, invoice_id=?, settle_je_id=?, note=CASE WHEN ?!='' THEN ? ELSE note END
    WHERE id=?
  `).run(effects.nextStatus, path, invoiceId, settleJeId, note || '', note || row.note, row.id);

  audit(user.id, 'update', 'consignment', row.id, `تسویه امانی مسیر ${path} → ${effects.nextStatus}`);
  return {
    ok: true,
    id: row.id,
    status: effects.nextStatus,
    settle_path: path,
    invoice_id: invoiceId,
    settle_je_id: settleJeId,
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

function voidConsignment(db, id, user, { reason } = {}) {
  const row = getConsignment(db, id);
  if (row.record_status === 'reversed' || row.status === 'reversed') {
    throw httpErr(409, 'این امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_REVERSED');
  }
  const date = todayJalali();
  return db.transaction(() => {
    const fresh = getConsignment(db, id);
    if (fresh.record_status === 'reversed' || fresh.status === 'reversed') {
      throw httpErr(409, 'این امانی قبلاً ابطال شده است', 'E_CONSIGNMENT_REVERSED');
    }
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
    reverseStockBySource(db, 'consignment', fresh.id, {
      createdBy: user.id, date, note: `ابطال امانی #${fresh.id}`,
    });
    db.prepare(`
      UPDATE consignments SET status='reversed', record_status='reversed' WHERE id=?
    `).run(fresh.id);
    audit(user.id, 'void', 'consignment', fresh.id, `ابطال کالای امانی #${fresh.id}`);
    return { ok: true, id: fresh.id, status: 'reversed', record_status: 'reversed' };
  })();
}

module.exports = {
  listConsignments,
  createConsignment,
  settleConsignment,
  voidConsignment,
  warehouseQty,
  unitPriceRialFrom,
  SETTLE_PATHS,
};
