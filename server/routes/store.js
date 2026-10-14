'use strict';
/**
 * فروش سریع فروشگاهی — bootstrap + thin create that delegates to invoice POST.
 */
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  prepareStoreQuickSaleBody,
  bootstrapStoreSale,
  isStoreQuickRequest,
} = require('../lib/store-quick-sale');

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
    if (!isStoreQuickRequest(req.body, req.user.role) && req.user.role !== 'store_retail'
      && !['admin', 'accounting', 'sales_manager', 'distribution_office'].includes(req.user.role)) {
      return res.status(403).json({ error: 'دسترسی به فروش سریع فروشگاهی ندارید', code: 'E_STORE_FORBIDDEN' });
    }
    req.body = prepareStoreQuickSaleBody(db, req.user, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  // Delegate to invoices router create (same auth already applied).
  req.url = '/';
  req.method = 'POST';
  const invoicesRouter = require('./invoices');
  return invoicesRouter.handle(req, res, next);
});

module.exports = router;
