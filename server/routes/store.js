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
  isStoreQuickRequest,
  prepareExchangeSaleBody,
  postStoreExchangeRefund,
  resolveStoreCashBoxId,
} = require('../lib/store-quick-sale');
const { moneyRial } = require('../lib/cash-on-document');
const { createSalesReturn } = require('../lib/sales-return-doc');
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

/** Capture JSON from invoices router without ending the HTTP response early. */
function captureInvoiceCreate(req) {
  return new Promise((resolve, reject) => {
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
          reject(err);
        } else {
          resolve(payload);
        }
      },
    };
    const invoicesRouter = require('./invoices');
    const fakeReq = Object.create(req);
    fakeReq.url = '/';
    fakeReq.method = 'POST';
    fakeReq.body = req.body;
    invoicesRouter.handle(fakeReq, fakeRes, (err) => {
      if (err) reject(err);
    });
  });
}

router.get('/bootstrap', auth, requirePermission('invoices', 'create'), (req, res) => {
  try {
    const db = getDB();
    res.json(bootstrapStoreSale(db, req.user));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطای bootstrap فروشگاهی', code: e.code });
  }
});

router.post('/quick-sale', auth, requirePermission('invoices', 'create'), (req, res, next) => {
  const db = getDB();
  try {
    if (!isStoreQuickRequest(req.body, req.user.role) && !allowStoreRole(req.user)) {
      return res.status(403).json({ error: 'دسترسی به فروش سریع فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
    }
    req.body = prepareStoreQuickSaleBody(db, req.user, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  return invokeInvoiceCreate(req, res, next);
});

/**
 * تعویض اتمیک: برگشت از فاکتور قبلی + فاکتور جایگزین + تسویه خالص / استرداد.
 * Body: {
 *   cust_id, invoice_id, return_rows, return_note?, reason_code?,
 *   sale: { rows, disc, pay_type, pay_splits, warehouse_id, cash_box_id, ... },
 *   refund_cash_box_id?
 * }
 */
router.post('/quick-exchange', auth, requirePermission('invoices', 'create'), async (req, res) => {
  const db = getDB();
  if (!allowStoreRole(req.user) && !isStoreQuickRequest(req.body, req.user.role)) {
    return res.status(403).json({ error: 'دسترسی به تعویض فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
  }
  const body = req.body || {};
  const custId = parseInt(body.cust_id, 10);
  const invoiceId = parseInt(body.invoice_id, 10);
  const returnRows = body.return_rows || body.returnRows || [];
  const saleIn = body.sale || body.sale_body || {};
  if (!(custId > 0)) {
    return res.status(400).json({ error: 'مشتری الزامی است', code: 'E_STORE_CUST_REQUIRED' });
  }
  if (!(invoiceId > 0)) {
    return res.status(400).json({ error: 'فاکتور مرجع برای برگشت الزامی است', code: 'E_STORE_EXCHANGE_INV' });
  }
  if (!Array.isArray(returnRows) || !returnRows.length) {
    return res.status(400).json({ error: 'حداقل یک سطر برگشت لازم است', code: 'E_STORE_EXCHANGE_RETURN' });
  }
  if (!Array.isArray(saleIn.rows) || !saleIn.rows.length) {
    return res.status(400).json({ error: 'سبد فروش جایگزین خالی است', code: 'E_STORE_EXCHANGE_SALE' });
  }

  let retOut;
  try {
    retOut = createSalesReturn(db, {
      cust_id: custId,
      invoice_id: invoiceId,
      date: body.date || saleIn.date || todayJalali(),
      note: body.return_note || body.note || 'تعویض فروشگاهی',
      reason_code: body.reason_code || 'exchange',
      rows: returnRows,
      warehouse_id: body.warehouse_id || saleIn.warehouse_id,
    }, req.user);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const retRow = db.prepare(
    'SELECT id, amount, vat_amount, cust_id FROM sales_returns WHERE id=?'
  ).get(retOut.id);
  const returnGross = moneyRial(retRow.amount) + moneyRial(retRow.vat_amount);

  let prepared;
  try {
    prepared = prepareExchangeSaleBody(db, req.user, {
      ...saleIn,
      cust_id: custId,
      store_quick: true,
      sales_channel: 'store_quick',
      type: saleIn.type || 'normal',
      date: saleIn.date || body.date || todayJalali(),
    }, returnGross);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  req.body = prepared.body;
  let inv;
  try {
    inv = await captureInvoiceCreate(req);
  } catch (e) {
    return res.status(e.status || 400).json({
      error: e.message || 'خطا در ثبت فاکتور جایگزین',
      code: e.code || 'E_STORE_EXCHANGE_SALE_FAIL',
      return_id: retOut.id,
    });
  }

  let refund = null;
  if (prepared.refundRial > 0) {
    try {
      const cashBoxId = resolveStoreCashBoxId(db, req.user, {
        cash_box_id: body.refund_cash_box_id || saleIn.cash_box_id || prepared.body.cash_box_id,
      });
      refund = postStoreExchangeRefund(db, {
        custId,
        amountRial: prepared.refundRial,
        cashBoxId,
        userId: req.user.id,
        date: body.date || todayJalali(),
        note: `استرداد تعویض — برگشت #${retOut.id} / فاکتور ${inv.num || inv.id}`,
        exchangeKey: `ex-${retOut.id}-${inv.id}`,
      });
    } catch (e) {
      return res.status(e.status || 400).json({
        error: e.message,
        code: e.code,
        return_id: retOut.id,
        invoice: inv,
      });
    }
  }

  res.json({
    ok: true,
    return_id: retOut.id,
    return_gross: returnGross,
    invoice: inv,
    net_collect: prepared.netCollect,
    refund_rial: prepared.refundRial,
    refund,
    exchange: prepared.body._store_exchange || null,
  });
});

module.exports = router;
