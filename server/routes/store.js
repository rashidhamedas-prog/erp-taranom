'use strict';
/**
 * فروش سریع فروشگاهی — bootstrap + quick-sale + quick-exchange.
 */
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  prepareStoreQuickSaleBody,
  bootstrapStoreSale,
  prepareExchangeSaleBody,
  postStoreExchangeRefund,
  resolveStoreCashBoxId,
  computeExchangeSettlement,
  estimateSaleFinalRial,
  applyStoreExchangeCreditAllocation,
} = require('../lib/store-quick-sale');
const { moneyRial } = require('../lib/cash-on-document');
const {
  createSalesReturn,
  voidSalesReturn,
  getInvoiceReturnablePack,
} = require('../lib/sales-return-doc');
const { voidInvoiceFully } = require('../lib/void-invoice');
const { todayJalali } = require('../jalali');

function allowStoreRole(user) {
  if (!user) return false;
  if (user.role === 'store_retail') return true;
  return ['admin', 'accounting', 'sales_manager', 'distribution_office'].includes(user.role);
}

function invokeInvoiceCreate(req, res, next) {
  req.url = '/';
  req.method = 'POST';
  const invoicesRouter = require('./invoices');
  return invoicesRouter.handle(req, res, next);
}

/**
 * Sync invoice create (same as captureInvoiceCreate, without Promise).
 * Safe to call inside db.transaction — nested invoice txn becomes a savepoint.
 */
function createInvoiceSync(req) {
  let result = null;
  let error = null;
  const fakeRes = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      if (this.statusCode >= 400) {
        const err = new Error((payload && (payload.error || payload.message)) || 'خطای ثبت فاکتور');
        err.status = this.statusCode;
        err.code = payload && payload.code;
        err.payload = payload;
        error = err;
      } else {
        result = payload;
      }
    },
  };
  const invoicesRouter = require('./invoices');
  const fakeReq = Object.create(req);
  fakeReq.url = '/';
  fakeReq.method = 'POST';
  fakeReq.body = req.body;
  invoicesRouter.handle(fakeReq, fakeRes, (err) => {
    if (err) error = err;
  });
  if (error) throw error;
  return result;
}

/** Capture JSON from invoices router without ending the HTTP response early. */
function captureInvoiceCreate(req) {
  return Promise.resolve().then(() => createInvoiceSync(req));
}

/** Preflight: accumulate return qty per key against max_returnable. */
function assertReturnRowsWithinAvail(returnRows, availMap, codes) {
  const claimed = {};
  for (const r of returnRows) {
    const k = r.variant_id ? `v:${r.variant_id}` : `p:${r.product_id}`;
    const a = availMap[k] || availMap[`p:${r.product_id}`];
    if (!a) {
      const err = new Error(codes.lineMsg || 'کالای برگشتی در فاکتور مرجع قابل برگشت نیست');
      err.status = 400;
      err.code = codes.lineCode;
      throw err;
    }
    claimed[k] = (claimed[k] || 0) + Number(r.qty);
    if (claimed[k] > Number(a.max_returnable)) {
      const err = new Error(
        `حداکثر قابل برگشت برای ${a.name || 'کالا'}: ${a.max_returnable}`
      );
      err.status = 400;
      err.code = codes.qtyCode;
      throw err;
    }
  }
}

function rollbackExchange(db, user, { returnId, invoiceId }) {
  const notes = [];
  if (invoiceId) {
    try {
      voidInvoiceFully(db, invoiceId, user, { reason: 'store_exchange_rollback' });
      notes.push('invoice_voided');
    } catch (e) {
      notes.push('invoice_void_fail:' + (e && e.message));
    }
  }
  if (returnId) {
    try {
      voidSalesReturn(db, returnId, user);
      notes.push('return_voided');
    } catch (e) {
      notes.push('return_void_fail:' + (e && e.message));
    }
  }
  return notes;
}

router.get('/bootstrap', auth, requirePermission('invoices', 'create'), (req, res) => {
  try {
    const db = getDB();
    res.json(bootstrapStoreSale(db, req.user));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطای bootstrap فروشگاهی', code: e.code });
  }
});

/** Firm invoices for a customer — available to store roles (for exchange ref picker). */
router.get('/customer-firm-invoices/:custId', auth, requirePermission('invoices', 'create'), (req, res) => {
  try {
    if (!allowStoreRole(req.user)) {
      return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_STORE_FORBIDDEN' });
    }
    const db = getDB();
    const custId = parseInt(req.params.custId, 10);
    if (!(custId > 0)) return res.status(400).json({ error: 'مشتری نامعتبر', code: 'E_STORE_CUST' });
    const rows = db.prepare(`
      SELECT i.id, i.num, i.date, i.type, i.final, i.final_rial, i.cust_id, i.warehouse_id, i.status, i.deleted_at
      FROM invoices i
      WHERE i.cust_id=?
        AND COALESCE(i.deleted_at,0)=0
        AND COALESCE(i.status,'')<>'reversed'
        AND i.type IN ('normal','final')
      ORDER BY i.id DESC
      LIMIT 60
    `).all(custId);
    res.json(rows);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code });
  }
});

/** Returnable lines for exchange (price-locked, max qty). */
router.get('/exchange-available/:invoiceId', auth, requirePermission('invoices', 'create'), (req, res) => {
  try {
    if (!allowStoreRole(req.user)) {
      return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_STORE_FORBIDDEN' });
    }
    const db = getDB();
    const custId = req.query.cust_id ? parseInt(req.query.cust_id, 10) : null;
    const pack = getInvoiceReturnablePack(db, req.params.invoiceId, {
      custId: custId > 0 ? custId : null,
      requireFirm: true,
    });
    res.json(pack);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code });
  }
});

router.post('/quick-sale', auth, requirePermission('invoices', 'create'), (req, res, next) => {
  const db = getDB();
  try {
    // L2: body.store_quick must NOT grant access — role only
    if (!allowStoreRole(req.user)) {
      return res.status(403).json({ error: 'دسترسی به فروش سریع فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
    }
    req.body = prepareStoreQuickSaleBody(db, req.user, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  return invokeInvoiceCreate(req, res, next);
});

/**
 * برگشت کامل فروشگاهی (بدون فروش جایگزین) + استرداد وجه از صندوق.
 * Body: { cust_id, invoice_id, return_rows, refund_cash_box_id?, return_note?, reason_code?, warehouse_id?, date? }
 */
router.post('/quick-return', auth, requirePermission('invoices', 'create'), (req, res) => {
  const db = getDB();
  if (!allowStoreRole(req.user)) {
    return res.status(403).json({ error: 'دسترسی به برگشت فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
  }
  const body = req.body || {};
  const custId = parseInt(body.cust_id, 10);
  const invoiceId = parseInt(body.invoice_id, 10);
  const returnRowsRaw = body.return_rows || body.returnRows || [];
  if (!(custId > 0)) {
    return res.status(400).json({ error: 'مشتری الزامی است', code: 'E_STORE_CUST_REQUIRED' });
  }
  if (!(invoiceId > 0)) {
    return res.status(400).json({ error: 'فاکتور مرجع برای برگشت الزامی است', code: 'E_STORE_RETURN_INV' });
  }
  const returnRows = (Array.isArray(returnRowsRaw) ? returnRowsRaw : [])
    .filter((r) => r && Number(r.qty) > 0);
  if (!returnRows.length) {
    return res.status(400).json({ error: 'حداقل یک سطر برگشت با تعداد > ۰ لازم است', code: 'E_STORE_RETURN_ROWS' });
  }

  let avail;
  try {
    avail = getInvoiceReturnablePack(db, invoiceId, { custId, requireFirm: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const availMap = {};
  for (const r of avail.rows || []) {
    const k = r.variant_id ? `v:${r.variant_id}` : `p:${r.product_id}`;
    availMap[k] = r;
  }
  try {
    assertReturnRowsWithinAvail(returnRows, availMap, {
      lineCode: 'E_STORE_RETURN_LINE',
      qtyCode: 'E_STORE_RETURN_QTY',
      lineMsg: 'کالای برگشتی در فاکتور مرجع قابل برگشت نیست',
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  let refundCashBoxId = null;
  try {
    refundCashBoxId = resolveStoreCashBoxId(db, req.user, {
      cash_box_id: body.refund_cash_box_id || body.cash_box_id,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  try {
    const out = db.transaction(() => {
      const retOut = createSalesReturn(db, {
        cust_id: custId,
        invoice_id: invoiceId,
        date: body.date || todayJalali(),
        note: body.return_note || body.note || 'برگشت کامل فروشگاهی',
        reason_code: body.reason_code || 'store_full_return',
        rows: returnRows,
        warehouse_id: body.warehouse_id || null,
      }, req.user);

      const retRow = db.prepare(
        'SELECT id, amount, vat_amount, cust_id FROM sales_returns WHERE id=?'
      ).get(retOut.id);
      const returnGross = moneyRial(retRow.amount) + moneyRial(retRow.vat_amount);

      let refund = null;
      const doRefund = body.refund !== false && body.refund !== 0 && body.refund !== '0';
      if (doRefund && returnGross > 0) {
        refund = postStoreExchangeRefund(db, {
          custId,
          amountRial: returnGross,
          cashBoxId: refundCashBoxId,
          userId: req.user.id,
          date: body.date || todayJalali(),
          note: `استرداد برگشت کامل فروشگاهی — برگشت #${retOut.id}`,
          returnId: retOut.id,
          exchangeKey: `ret-${retOut.id}`,
        });
      }
      return {
        ok: true,
        return_id: retOut.id,
        return_gross: returnGross,
        refund_rial: refund ? refund.amount_rial : 0,
        settlement_case: 'return_only',
        invoice: null,
        refund,
      };
    })();
    return res.json(out);
  } catch (e) {
    return res.status(e.status || 400).json({
      error: e.message || 'خطا در ثبت برگشت کامل',
      code: e.code || 'E_STORE_RETURN_FAIL',
    });
  }
});

/**
 * تعویض اتمیک (با جبران): برگشت از فاکتور قبلی + فاکتور جایگزین + تسویه خالص / استرداد.
 * سناریوها: collect (فروش>برگشت) | refund (برگشت>فروش) | even (برابر).
 * Body: {
 *   cust_id, invoice_id, return_rows, return_note?, reason_code?,
 *   sale: { rows, disc, pay_type, pay_splits, warehouse_id, cash_box_id, ... },
 *   refund_cash_box_id?
 * }
 */
router.post('/quick-exchange', auth, requirePermission('invoices', 'create'), (req, res) => {
  const db = getDB();
  if (!allowStoreRole(req.user)) {
    return res.status(403).json({ error: 'دسترسی به تعویض فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
  }
  const body = req.body || {};
  const custId = parseInt(body.cust_id, 10);
  const invoiceId = parseInt(body.invoice_id, 10);
  const returnRowsRaw = body.return_rows || body.returnRows || [];
  const saleIn = body.sale || body.sale_body || {};
  if (!(custId > 0)) {
    return res.status(400).json({ error: 'مشتری الزامی است', code: 'E_STORE_CUST_REQUIRED' });
  }
  if (!(invoiceId > 0)) {
    return res.status(400).json({ error: 'فاکتور مرجع برای برگشت الزامی است', code: 'E_STORE_EXCHANGE_INV' });
  }
  const returnRows = (Array.isArray(returnRowsRaw) ? returnRowsRaw : [])
    .filter((r) => r && Number(r.qty) > 0);
  if (!returnRows.length) {
    return res.status(400).json({ error: 'حداقل یک سطر برگشت با تعداد > ۰ لازم است', code: 'E_STORE_EXCHANGE_RETURN' });
  }
  if (!Array.isArray(saleIn.rows) || !saleIn.rows.length) {
    return res.status(400).json({ error: 'سبد فروش جایگزین خالی است', code: 'E_STORE_EXCHANGE_SALE' });
  }

  // Preflight: ownership + returnable caps + settlement cash box
  let avail;
  try {
    avail = getInvoiceReturnablePack(db, invoiceId, { custId, requireFirm: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const availMap = {};
  for (const r of avail.rows || []) {
    const k = r.variant_id ? `v:${r.variant_id}` : `p:${r.product_id}`;
    availMap[k] = r;
  }
  try {
    assertReturnRowsWithinAvail(returnRows, availMap, {
      lineCode: 'E_STORE_EXCHANGE_LINE',
      qtyCode: 'E_STORE_EXCHANGE_QTY',
      lineMsg: 'کالای برگشتی در فاکتور مرجع قابل برگشت نیست',
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const salePrepPreview = prepareStoreQuickSaleBody(db, req.user, {
    ...saleIn,
    cust_id: custId,
    store_quick: true,
    sales_channel: 'store_quick',
  });
  const saleFinalEst = estimateSaleFinalRial(salePrepPreview.rows, salePrepPreview.disc);
  // Rough return estimate for cash-box preflight (exact after create)
  let returnEst = 0;
  for (const r of returnRows) {
    const k = r.variant_id ? `v:${r.variant_id}` : `p:${r.product_id}`;
    const a = availMap[k] || availMap[`p:${r.product_id}`];
    const net = Number(a && a.net_unit) || Number(a && a.price) || 0;
    returnEst += Math.round(Number(r.qty) * net);
  }
  const settleEst = computeExchangeSettlement(saleFinalEst, returnEst);
  let refundCashBoxId = null;
  try {
    if (settleEst.refundRial > 0 || settleEst.netCollect > 0) {
      const needsCash = settleEst.refundRial > 0
        || String(saleIn.pay_type || '').toLowerCase() === 'cash'
        || String(saleIn.pay_type || '').toLowerCase() === 'mixed'
        || (Array.isArray(saleIn.pay_splits) && saleIn.pay_splits.some((s) => s && s.pay_type === 'cash'));
      if (settleEst.refundRial > 0 || needsCash) {
        refundCashBoxId = resolveStoreCashBoxId(db, req.user, {
          cash_box_id: body.refund_cash_box_id || saleIn.cash_box_id || salePrepPreview.cash_box_id,
        });
      }
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  try {
    const out = db.transaction(() => {
      const retOut = createSalesReturn(db, {
        cust_id: custId,
        invoice_id: invoiceId,
        date: body.date || saleIn.date || todayJalali(),
        note: body.return_note || body.note || 'تعویض فروشگاهی',
        reason_code: body.reason_code || 'exchange',
        rows: returnRows,
        warehouse_id: body.warehouse_id || null,
      }, req.user);

      const retRow = db.prepare(
        'SELECT id, amount, vat_amount, cust_id FROM sales_returns WHERE id=?'
      ).get(retOut.id);
      const returnGross = moneyRial(retRow.amount) + moneyRial(retRow.vat_amount);

      const prepared = prepareExchangeSaleBody(db, req.user, {
        ...saleIn,
        cust_id: custId,
        store_quick: true,
        sales_channel: 'store_quick',
        type: saleIn.type || 'normal',
        date: saleIn.date || body.date || todayJalali(),
        note: (saleIn.note || '') || `تعویض فروشگاهی ← برگشت #${retOut.id}`,
      }, returnGross);

      let cashId = refundCashBoxId;
      if (prepared.refundRial > 0 && !(cashId > 0)) {
        cashId = resolveStoreCashBoxId(db, req.user, {
          cash_box_id: body.refund_cash_box_id || saleIn.cash_box_id || prepared.body.cash_box_id,
        });
      }

      req.body = prepared.body;
      // M4: sync create inside this transaction (not async router hop)
      const inv = createInvoiceSync(req);

      const actualFinal = moneyRial(
        inv && (inv.final_rial != null ? inv.final_rial : inv.final)
      );
      const actualSettle = computeExchangeSettlement(actualFinal, returnGross);
      prepared.netCollect = actualSettle.netCollect;
      prepared.refundRial = actualSettle.refundRial;
      prepared.exchangeCreditRial = actualSettle.exchangeCreditRial;
      prepared.saleFinal = actualSettle.saleFinal;
      prepared.settlementCase = actualSettle.settlementCase;
      prepared.returnGross = returnGross;
      if (prepared.body && prepared.body._store_exchange) {
        prepared.body._store_exchange = {
          ...prepared.body._store_exchange,
          sale_final: actualSettle.saleFinal,
          net_collect: actualSettle.netCollect,
          refund_rial: actualSettle.refundRial,
          exchange_credit_rial: actualSettle.exchangeCreditRial,
          settlement_case: actualSettle.settlementCase,
        };
      }

      let creditAlloc = null;
      if (actualSettle.exchangeCreditRial > 0 && inv && inv.id) {
        creditAlloc = applyStoreExchangeCreditAllocation(db, {
          returnId: retOut.id,
          invoiceId: inv.id,
          amountRial: actualSettle.exchangeCreditRial,
          userId: req.user.id,
          note: `اعتبار تعویض — برگشت #${retOut.id} → فاکتور ${inv.num || inv.id}`,
        });
        if (creditAlloc && inv) {
          inv.balance_due = creditAlloc.balance_due;
          inv.settled_amount = creditAlloc.settled_amount;
        }
      }

      let refund = null;
      if (actualSettle.refundRial > 0) {
        if (!(cashId > 0)) {
          cashId = resolveStoreCashBoxId(db, req.user, {
            cash_box_id: body.refund_cash_box_id || saleIn.cash_box_id || prepared.body.cash_box_id,
          });
        }
        refund = postStoreExchangeRefund(db, {
          custId,
          amountRial: actualSettle.refundRial,
          cashBoxId: cashId || prepared.body.cash_box_id,
          userId: req.user.id,
          date: body.date || todayJalali(),
          note: `استرداد تعویض — برگشت #${retOut.id} / فاکتور ${inv.num || inv.id}`,
          returnId: retOut.id,
          exchangeKey: `ex-${retOut.id}-${inv.id}`,
        });
      }

      return {
        ok: true,
        return_id: retOut.id,
        return_gross: prepared.returnGross,
        invoice: inv,
        net_collect: prepared.netCollect,
        refund_rial: prepared.refundRial,
        settlement_case: prepared.settlementCase,
        exchange_credit_rial: prepared.exchangeCreditRial,
        credit_allocation: creditAlloc || null,
        refund,
        exchange: prepared.body._store_exchange || null,
      };
    })();
    return res.json(out);
  } catch (e) {
    return res.status(e.status || 400).json({
      error: e.message || 'خطا در ثبت تعویض',
      code: e.code || 'E_STORE_EXCHANGE_FAIL',
    });
  }
});

module.exports = router;
module.exports._test = {
  allowStoreRole,
  assertReturnRowsWithinAvail,
  createInvoiceSync,
};
