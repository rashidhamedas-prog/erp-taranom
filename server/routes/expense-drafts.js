'use strict';
// P8 — فرم هزینهٔ روزانه (پیش‌نویس صندوق‌دار → تأیید حسابدار). مونت‌شده روی /api/expenses/drafts
// پیش از /api/expenses تا /:id آن مسیرها را نبلعد.
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');
const drafts = require('../lib/expense-drafts');

function fail(res, e, label) {
  const status = e.status || 500;
  if (status >= 500) console.error(label, e);
  res.status(status).json({ error: e.message || 'عملیات ناموفق بود', code: e.code });
}

function guard(label, fn) {
  return (req, res) => {
    try {
      const out = fn(getDB(), req);
      res.json(out);
    } catch (e) {
      fail(res, e, label);
    }
  };
}

router.get('/options', auth, guard('expense-draft options', (db, req) => {
  if (!drafts.canCreateDraft(req.user)) throw drafts.httpErr(403, 'دسترسی ندارید', 'E_DRAFT_FORBIDDEN');
  return drafts.draftOptions(db, req.user);
}));

router.get('/report', auth, guard('expense-draft report', (db, req) => {
  if (!drafts.isReviewer(req.user)) throw drafts.httpErr(403, 'دسترسی ندارید', 'E_DRAFT_FORBIDDEN');
  return drafts.expenseDraftReport(db, { from: req.query.from, to: req.query.to });
}));

router.get('/', auth, guard('expense-draft list', (db, req) => {
  if (!drafts.canCreateDraft(req.user)) throw drafts.httpErr(403, 'دسترسی ندارید', 'E_DRAFT_FORBIDDEN');
  return drafts.listDrafts(db, req.user, req.query || {});
}));

router.post('/categories', auth, guard('expense-draft category', (db, req) => {
  const row = drafts.addLeafCategory(db, req.user, req.body);
  audit(req.user.id, 'create', 'expense_category', row.id, `دستهٔ هزینهٔ روزانه: ${row.name}`);
  return row;
}));

router.post('/', auth, guard('expense-draft create', (db, req) => {
  const row = db.transaction(() => drafts.createDraft(db, req.user, req.body))();
  audit(req.user.id, 'create', 'expense_draft', row.id, `پیش‌نویس هزینه ${row.amount} ریال (${row.title || row.note})`);
  return { ok: true, id: row.id, draft: row };
}));

router.put('/:id', auth, guard('expense-draft edit', (db, req) => {
  const row = db.transaction(() => drafts.editDraft(db, req.user, Number(req.params.id), req.body))();
  audit(req.user.id, 'update', 'expense_draft', row.id, `ویرایش پیش‌نویس هزینه #${row.id}`);
  return { ok: true, id: row.id, draft: row };
}));

router.post('/:id/approve', auth, guard('expense-draft approve', (db, req) => {
  const row = drafts.approveDraft(db, req.user, Number(req.params.id), req.body && req.body.edits);
  audit(req.user.id, 'approve', 'expense_draft', row.id, `تأیید هزینهٔ روزانه #${row.id} — ${row.amount} ریال`);
  return { ok: true, id: row.id, journal_entry_id: row.journal_entry_id, draft: row };
}));

router.post('/:id/reject', auth, guard('expense-draft reject', (db, req) => {
  const row = drafts.rejectDraft(db, req.user, Number(req.params.id), req.body && req.body.reason);
  audit(req.user.id, 'reject', 'expense_draft', row.id, `رد هزینهٔ روزانه #${row.id}: ${row.reject_reason}`);
  return { ok: true, id: row.id, draft: row };
}));

router.post('/:id/cancel', auth, guard('expense-draft cancel', (db, req) => {
  const row = drafts.cancelDraft(db, req.user, Number(req.params.id));
  audit(req.user.id, 'cancel', 'expense_draft', row.id, `انصراف از پیش‌نویس هزینه #${row.id}`);
  return { ok: true, id: row.id, draft: row };
}));

router.post('/:id/void', auth, guard('expense-draft void', (db, req) => {
  const row = drafts.voidApprovedDraft(db, req.user, Number(req.params.id), req.body && req.body.reason);
  audit(req.user.id, 'reverse', 'expense_draft', row.id, `ابطال هزینهٔ روزانه #${row.id}`);
  return { ok: true, id: row.id, draft: row };
}));

module.exports = router;
