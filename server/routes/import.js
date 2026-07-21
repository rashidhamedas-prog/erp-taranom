/**
 * Mahak import HTTP API — CANCELLED.
 * Endpoints remain mounted so old clients get a clear 410 instead of crashing the server.
 */
const router = require('express').Router();
const { auth, adminOnly, centralOnly } = require('../middleware/auth');

const MSG = 'واردات محک لغو شده است و دیگر پشتیبانی نمی‌شود.';

function gone(req, res) {
  res.status(410).json({ error: MSG, cancelled: true });
}

router.post('/mahak/upload', auth, adminOnly, centralOnly, gone);
router.get('/mahak/status', auth, adminOnly, centralOnly, (req, res) => {
  res.json({ cancelled: true, mssql_configured: false, hint: MSG });
});
router.post('/mahak/run', auth, adminOnly, centralOnly, gone);

module.exports = router;
