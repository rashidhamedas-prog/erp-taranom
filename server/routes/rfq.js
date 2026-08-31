'use strict';
const router = require('express').Router();
const { getDB, audit, allocateNumber, isDevice } = require('../db');
const { auth } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { assertMakerChecker, assertBranchScope, applyBranchScopeSql } = require('../lib/rbac');

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function parseRows(input) {
  const rows = [];
  for (const r of input || []) {
    const productId = parseInt(r.product_id, 10);
    const qty = Number(r.qty) || 0;
    if (!productId || qty <= 0) continue;
    rows.push({
      product_id: productId,
      qty,
      price: Number(r.price) || 0,
      note: String(r.note || ''),
    });
  }
  if (!rows.length) throw httpErr(400, 'حداقل یک ردیف کالا لازم است', 'E_RFQ_ROWS');
  return rows;
}

function sendErr(res, e) {
  res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = applyBranchScopeSql(req.user, 'r');
  const kind = req.query.kind ? String(req.query.kind) : '';
  const extra = kind ? ' AND r.kind=?' : '';
  const params = kind ? [kind, ...scope.params] : scope.params;
  const rows = db.prepare(`
    SELECT r.* FROM rfqs r
    WHERE COALESCE(r.status,'')<>'cancelled' ${extra} ${scope.sql}
    ORDER BY r.id DESC LIMIT 200
  `).all(...params);
  res.json(rows.map((r) => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

router.get('/:id', auth, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    assertBranchScope(req.user, row.branch_id);
    res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
  } catch (e) { sendErr(res, e); }
});

router.post('/', auth, (req, res) => {
  try {
    const kind = req.body.kind === 'purchase' ? 'purchase' : 'sales';
    if (kind === 'purchase' && req.user.role !== 'admin' && req.user.role !== 'accounting') {
      return res.status(403).json({ error: 'دسترسی ندارید' });
    }
    const rows = parseRows(req.body.rows);
    const db = getDB();
    const branchId = req.body.branch_id != null ? parseInt(req.body.branch_id, 10) : (req.user.branch_id || 1);
    assertBranchScope(req.user, branchId);
    const date = req.body.date || todayJalali();
    const seqKey = kind === 'purchase' ? 'rfq_purchase' : 'rfq_sales';
    const prefix = kind === 'purchase' ? 'RFQP' : 'RFQS';
    const created = db.transaction(() => {
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, seqKey, prefix);
      const r = db.prepare(`
        INSERT INTO rfqs (num,kind,party_id,supplier_id,cust_id,date,status,branch_id,rows,note,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        num, kind,
        req.body.party_id || null,
        req.body.supplier_id || null,
        req.body.cust_id || null,
        date, 'pending', branchId, JSON.stringify(rows),
        String(req.body.note || ''), req.user.id
      );
      return db.prepare('SELECT * FROM rfqs WHERE id=?').get(r.lastInsertRowid);
    })();
    audit(req.user.id, 'create', 'rfq', created.id, created.num);
    res.json({ ...created, rows: JSON.parse(created.rows || '[]') });
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/approve', auth, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    assertBranchScope(req.user, row.branch_id);
    if (row.status !== 'pending' && row.status !== 'draft') {
      return res.status(409).json({ error: 'این استعلام در وضعیت قابل تأیید نیست' });
    }
    assertMakerChecker(req.user, row.created_by);
    db.prepare("UPDATE rfqs SET status='approved', approved_by=? WHERE id=?").run(req.user.id, row.id);
    audit(req.user.id, 'approve', 'rfq', row.id, row.num);
    res.json(db.prepare('SELECT * FROM rfqs WHERE id=?').get(row.id));
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/award', auth, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    assertBranchScope(req.user, row.branch_id);
    if (row.status !== 'approved' && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'ابتدا استعلام باید تأیید شود' });
    }
    db.prepare("UPDATE rfqs SET status='awarded', awarded_at=strftime('%s','now') WHERE id=?").run(row.id);
    audit(req.user.id, 'update', 'rfq', row.id, 'award ' + row.num);
    res.json(db.prepare('SELECT * FROM rfqs WHERE id=?').get(row.id));
  } catch (e) { sendErr(res, e); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    assertBranchScope(req.user, row.branch_id);
    if (row.status === 'cancelled') return res.status(400).json({ error: 'قبلاً ابطال شده' });
    db.prepare("UPDATE rfqs SET status='cancelled', status_reason=? WHERE id=?")
      .run(String(req.body?.reason || 'ابطال'), row.id);
    audit(req.user.id, 'reverse', 'rfq', row.id, row.num);
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
