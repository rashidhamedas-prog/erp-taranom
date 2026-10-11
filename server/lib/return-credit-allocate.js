'use strict';
/**
 * P2c — allocate unlinked return credit/debit to open invoices (no JE).
 * Linked returns already reduce balance via invoice_id / purchase_invoice_id;
 * this module only applies residual party credit from unlinked returns.
 */
const { moneyRial } = require('./cash-on-document');

const SIDE_SALES = 'sales';
const SIDE_PURCHASE = 'purchase';

const REASON_CODES = [
  { code: 'defective', label: 'معیوب / خرابی' },
  { code: 'wrong_item', label: 'کالای اشتباه' },
  { code: 'overstock', label: 'مازاد موجودی مشتری' },
  { code: 'customer_cancel', label: 'انصراف مشتری' },
  { code: 'other', label: 'سایر' },
];

function returnGrossRial(row) {
  if (!row) return 0;
  return moneyRial(Number(row.amount) || 0) + moneyRial(Number(row.vat_amount) || 0);
}

function sumAllocationsToInvoice(db, side, invoiceId) {
  if (!invoiceId) return 0;
  try {
    const r = db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) s FROM return_credit_allocations
      WHERE side=? AND invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    `).get(side, invoiceId);
    return moneyRial(r && r.s);
  } catch (_) {
    return 0;
  }
}

function sumAllocationsFromReturn(db, side, returnId) {
  if (!returnId) return 0;
  try {
    const r = db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) s FROM return_credit_allocations
      WHERE side=? AND return_id=? AND COALESCE(status,'posted')<>'reversed'
    `).get(side, returnId);
    return moneyRial(r && r.s);
  } catch (_) {
    return 0;
  }
}

function listAllocationsForReturn(db, side, returnId) {
  try {
    return db.prepare(`
      SELECT * FROM return_credit_allocations
      WHERE side=? AND return_id=? AND COALESCE(status,'posted')<>'reversed'
      ORDER BY id
    `).all(side, returnId);
  } catch (_) {
    return [];
  }
}

function unallocatedGrossRial(db, side, returnRow) {
  const gross = returnGrossRial(returnRow);
  const used = sumAllocationsFromReturn(db, side, returnRow.id);
  return Math.max(0, gross - used);
}

function settingFlag(db, key, defaultOn) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!r) return !!defaultOn;
    return String(r.value) === '1';
  } catch (_) {
    return !!defaultOn;
  }
}

/**
 * Apply one or more allocations from an unlinked return.
 * @returns {{ ids: number[], recomputed: number[] }}
 */
function allocateReturnCredit(db, {
  side, returnId, allocations, userId, note,
}) {
  if (side !== SIDE_SALES && side !== SIDE_PURCHASE) {
    const e = new Error('side نامعتبر');
    e.status = 400;
    e.code = 'E_ALLOC_SIDE';
    throw e;
  }
  const isSales = side === SIDE_SALES;
  const ret = isSales
    ? db.prepare('SELECT * FROM sales_returns WHERE id=?').get(returnId)
    : db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(returnId);
  if (!ret) {
    const e = new Error('برگشت یافت نشد');
    e.status = 404;
    e.code = 'E_ALLOC_RETURN';
    throw e;
  }
  if (String(ret.status || 'posted') === 'reversed') {
    const e = new Error('برگشت ابطال‌شده قابل تخصیص نیست');
    e.status = 400;
    e.code = 'E_ALLOC_REVERSED';
    throw e;
  }
  const linkedId = isSales ? ret.invoice_id : ret.purchase_invoice_id;
  if (linkedId) {
    const e = new Error('برگشت لینک‌شده به فاکتور؛ تخصیص جدا لازم نیست (مانده از قبل کم شده)');
    e.status = 400;
    e.code = 'E_ALLOC_ALREADY_LINKED';
    throw e;
  }

  const partyId = isSales ? ret.cust_id : ret.supplier_id;
  const list = Array.isArray(allocations) ? allocations : [];
  if (!list.length) {
    const e = new Error('حداقل یک تخصیص لازم است');
    e.status = 400;
    e.code = 'E_ALLOC_EMPTY';
    throw e;
  }

  let remaining = unallocatedGrossRial(db, side, ret);
  const ids = [];
  const recomputed = [];

  const run = db.transaction(() => {
    for (const a of list) {
      const invId = parseInt(a.invoice_id || a.purchase_invoice_id, 10);
      let amt = moneyRial(Number(a.amount_rial != null ? a.amount_rial : a.amount) || 0);
      if (!invId || amt <= 0) {
        const e = new Error('فاکتور و مبلغ تخصیص نامعتبر');
        e.status = 400;
        e.code = 'E_ALLOC_LINE';
        throw e;
      }
      if (amt > remaining + 0.0001) {
        const e = new Error(`مبلغ تخصیص بیش از اعتبار باقی‌مانده برگشت (${remaining})`);
        e.status = 400;
        e.code = 'E_ALLOC_OVER_RETURN';
        throw e;
      }

      let inv;
      let balanceDue;
      if (isSales) {
        inv = db.prepare(`
          SELECT id, cust_id, final, final_rial, settled_amount, balance_due, status, deleted_at, type
          FROM invoices WHERE id=?
        `).get(invId);
        if (!inv || inv.deleted_at || String(inv.status || 'posted') === 'reversed') {
          const e = new Error('فاکتور فروش یافت نشد یا ابطال شده');
          e.status = 400;
          e.code = 'E_ALLOC_INV';
          throw e;
        }
        if (Number(inv.cust_id) !== Number(partyId)) {
          const e = new Error('فاکتور متعلق به همین مشتری نیست');
          e.status = 400;
          e.code = 'E_ALLOC_PARTY';
          throw e;
        }
        const { recomputeInvoiceSettledBalances } = require('./invoice-payments');
        const before = recomputeInvoiceSettledBalances(db, invId);
        balanceDue = before ? before.balance_due : moneyRial(inv.balance_due);
      } else {
        inv = db.prepare(`
          SELECT id, supplier_id, final, settled_amount, balance_due, status
          FROM purchase_invoices WHERE id=?
        `).get(invId);
        if (!inv || String(inv.status || 'posted') === 'reversed') {
          const e = new Error('فاکتور خرید یافت نشد یا ابطال شده');
          e.status = 400;
          e.code = 'E_ALLOC_INV';
          throw e;
        }
        if (Number(inv.supplier_id) !== Number(partyId)) {
          const e = new Error('فاکتور متعلق به همین تأمین‌کننده نیست');
          e.status = 400;
          e.code = 'E_ALLOC_PARTY';
          throw e;
        }
        const { recomputePurchaseInvoiceSettledBalances } = require('./purchase-payments');
        const before = recomputePurchaseInvoiceSettledBalances(db, invId);
        balanceDue = before ? before.balance_due : moneyRial(inv.balance_due);
      }

      if (amt > balanceDue + 0.0001) {
        const e = new Error(`مبلغ تخصیص بیش از مانده فاکتور (${balanceDue})`);
        e.status = 400;
        e.code = 'E_ALLOC_OVER_BAL';
        throw e;
      }

      const ins = db.prepare(`
        INSERT INTO return_credit_allocations
          (side, return_id, invoice_id, amount_rial, status, note, user_id)
        VALUES (?,?,?,?, 'posted', ?, ?)
      `).run(side, returnId, invId, amt, note || a.note || '', userId || null);
      ids.push(ins.lastInsertRowid);
      remaining -= amt;
      recomputed.push(invId);

      if (isSales) {
        require('./invoice-payments').recomputeInvoiceSettledBalances(db, invId);
      } else {
        require('./purchase-payments').recomputePurchaseInvoiceSettledBalances(db, invId);
      }
    }
  });
  run();

  return { ids, recomputed: [...new Set(recomputed)], remaining };
}

function reverseAllocation(db, { side, allocId, userId }) {
  const row = db.prepare('SELECT * FROM return_credit_allocations WHERE id=? AND side=?').get(allocId, side);
  if (!row) {
    const e = new Error('تخصیص یافت نشد');
    e.status = 404;
    throw e;
  }
  if (String(row.status || 'posted') === 'reversed') {
    const e = new Error('این تخصیص قبلاً ابطال شده');
    e.status = 400;
    throw e;
  }
  db.prepare(`
    UPDATE return_credit_allocations
    SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(userId || null, allocId);
  if (side === SIDE_SALES) {
    require('./invoice-payments').recomputeInvoiceSettledBalances(db, row.invoice_id);
  } else {
    require('./purchase-payments').recomputePurchaseInvoiceSettledBalances(db, row.invoice_id);
  }
  return { ok: true, invoice_id: row.invoice_id };
}

/** Soft-void every active allocation for a return (call inside return void tx). */
function reverseAllocationsForReturn(db, side, returnId, userId) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, invoice_id FROM return_credit_allocations
      WHERE side=? AND return_id=? AND COALESCE(status,'posted')<>'reversed'
    `).all(side, returnId);
  } catch (_) {
    return [];
  }
  const invIds = [];
  for (const r of rows) {
    db.prepare(`
      UPDATE return_credit_allocations
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
      WHERE id=?
    `).run(userId || null, r.id);
    invIds.push(r.invoice_id);
  }
  return [...new Set(invIds)];
}

/**
 * FIFO auto-allocate remaining credit to oldest open invoices (same party).
 * Only when settings returns_auto_allocate_credit=1.
 */
function autoAllocateIfEnabled(db, { side, returnId, userId }) {
  if (!settingFlag(db, 'returns_auto_allocate_credit', false)) {
    return { skipped: true, ids: [] };
  }
  const isSales = side === SIDE_SALES;
  const ret = isSales
    ? db.prepare('SELECT * FROM sales_returns WHERE id=?').get(returnId)
    : db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(returnId);
  if (!ret || (isSales ? ret.invoice_id : ret.purchase_invoice_id)) {
    return { skipped: true, ids: [] };
  }
  let remaining = unallocatedGrossRial(db, side, ret);
  if (remaining <= 0) return { skipped: true, ids: [] };

  let open = [];
  if (isSales) {
    open = db.prepare(`
      SELECT id, balance_due FROM invoices
      WHERE cust_id=? AND COALESCE(status,'posted')<>'reversed' AND deleted_at IS NULL
        AND type IN ('normal','final')
        AND COALESCE(balance_due, final) > 0
      ORDER BY date ASC, id ASC
    `).all(ret.cust_id);
  } else {
    open = db.prepare(`
      SELECT id, balance_due FROM purchase_invoices
      WHERE supplier_id=? AND COALESCE(status,'posted')<>'reversed'
        AND COALESCE(balance_due, final) > 0
      ORDER BY date ASC, id ASC
    `).all(ret.supplier_id);
  }

  const allocations = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    // Refresh balance via recompute so we don't over-allocate
    let bal = moneyRial(inv.balance_due);
    if (isSales) {
      const r = require('./invoice-payments').recomputeInvoiceSettledBalances(db, inv.id);
      if (r) bal = r.balance_due;
    } else {
      const r = require('./purchase-payments').recomputePurchaseInvoiceSettledBalances(db, inv.id);
      if (r) bal = r.balance_due;
    }
    if (bal <= 0) continue;
    const take = Math.min(remaining, bal);
    allocations.push({ invoice_id: inv.id, amount_rial: take });
    remaining -= take;
  }
  if (!allocations.length) return { skipped: true, ids: [] };
  return allocateReturnCredit(db, {
    side, returnId, allocations, userId, note: 'تخصیص خودکار اعتبار برگشت',
  });
}

module.exports = {
  SIDE_SALES,
  SIDE_PURCHASE,
  REASON_CODES,
  returnGrossRial,
  sumAllocationsToInvoice,
  sumAllocationsFromReturn,
  listAllocationsForReturn,
  unallocatedGrossRial,
  allocateReturnCredit,
  reverseAllocation,
  reverseAllocationsForReturn,
  autoAllocateIfEnabled,
  settingFlag,
};
