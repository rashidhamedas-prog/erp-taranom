const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const leaves = require('../lib/cheque-book-leaves');

// "دسته چک" — one of our own checkbooks, always tied to a specific bank.
// Used when WE issue a cheque (supplier payments, incentive payments,
// cash-basis purchase invoices) so each cheque leaf can be traced back to
// its bank and serial range.

function loadCategory(db, id, { includeDeleted } = {}) {
  const row = db.prepare('SELECT * FROM check_categories WHERE id=?').get(id);
  if (!row) return null;
  if (!includeDeleted && row.deleted_at) return null;
  return row;
}

function enrichCategory(db, r) {
  const used = leaves.countUsedLeaves(db, r.id);
  const leafTotal = leaves.countAllLeaves(db, r.id);
  const leafCount = leafTotal > 0 ? leafTotal : (Number(r.leaf_count) || 0);
  const remaining = leafCount > 0 ? Math.max(0, leafCount - used) : null;
  return {
    ...r,
    used_leaves: used,
    remaining_leaves: remaining,
    blank_leaves: leaves.countBlankLeaves(db, r.id),
    leaf_total: leafTotal,
  };
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { bank_id, include_deleted } = req.query;
  const includeDeleted = include_deleted === '1' || include_deleted === 'true';
  const deletedClause = includeDeleted ? '' : ' AND cc.deleted_at IS NULL';
  const rows = bank_id
    ? db.prepare(`
        SELECT cc.*, b.name as bank_name
        FROM check_categories cc LEFT JOIN banks b ON cc.bank_id=b.id
        WHERE cc.bank_id=?${deletedClause}
        ORDER BY cc.id DESC
      `).all(bank_id)
    : db.prepare(`
        SELECT cc.*, b.name as bank_name
        FROM check_categories cc LEFT JOIN banks b ON cc.bank_id=b.id
        WHERE 1=1${deletedClause}
        ORDER BY cc.id DESC
      `).all();
  res.json(rows.map((r) => enrichCategory(db, r)));
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    bank_id, name, serial_from, serial_to, holder_name, leaf_count, current_leaf, note,
    issue_date, auto_generate_leaves,
  } = req.body;
  if (!bank_id) return res.status(400).json({ error: 'بانک الزامی است' });
  if (!name) return res.status(400).json({ error: 'نام دسته چک الزامی است' });
  const db = getDB();
  const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(bank_id);
  if (!bank) return res.status(404).json({ error: 'بانک یافت نشد' });
  const fromS = serial_from || '';
  const toS = serial_to || '';
  const result = db.prepare(
    `INSERT INTO check_categories
      (bank_id,name,serial_from,serial_to,holder_name,leaf_count,current_leaf,note,issue_date)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    bank_id, name, fromS, toS, holder_name || '',
    parseInt(leaf_count, 10) || 0, current_leaf || '', note || '',
    issue_date || null
  );
  const catId = result.lastInsertRowid;
  let gen = null;
  const shouldGen = auto_generate_leaves !== false && fromS && toS;
  if (shouldGen) {
    try {
      gen = leaves.generateLeaves(db, catId, fromS, toS);
    } catch (e) {
      // دسته ساخته شد؛ تولید برگ اختیاری — خطا را گزارش می‌کنیم ولی دسته را نگه می‌داریم
      gen = { error: e.message || 'خطا در تولید برگ', code: e.code || null };
    }
  }
  audit(req.user.id, 'create', 'check_category', catId, `ساخت دسته چک ${name}`);
  const saved = db.prepare('SELECT * FROM check_categories WHERE id=?').get(catId);
  res.json({ ...enrichCategory(db, saved), generate: gen });
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const {
    bank_id, name, serial_from, serial_to, active, holder_name, leaf_count, current_leaf, note, issue_date,
  } = req.body;
  db.prepare(`UPDATE check_categories SET bank_id=?,name=?,serial_from=?,serial_to=?,active=?,
    holder_name=?,leaf_count=?,current_leaf=?,note=?,issue_date=? WHERE id=?`)
    .run(
      bank_id || row.bank_id,
      name || row.name,
      serial_from ?? row.serial_from,
      serial_to ?? row.serial_to,
      active != null ? (active ? 1 : 0) : row.active,
      holder_name ?? row.holder_name ?? '',
      leaf_count != null ? parseInt(leaf_count, 10) : (row.leaf_count || 0),
      current_leaf ?? row.current_leaf ?? '',
      note ?? row.note ?? '',
      issue_date !== undefined ? (issue_date || null) : (row.issue_date || null),
      req.params.id
    );
  audit(req.user.id, 'update', 'check_category', req.params.id, 'ویرایش دسته چک');
  res.json({ ok: true });
});

// soft-delete — حذف فیزیکی ممنوع
router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare(
    "UPDATE check_categories SET deleted_at=strftime('%s','now'), active=0 WHERE id=? AND deleted_at IS NULL"
  ).run(req.params.id);
  audit(req.user.id, 'soft_delete', 'check_category', req.params.id, 'حذف نرم دسته چک');
  res.json({ ok: true, soft_deleted: true });
});

// ---- برگ‌ها ----

router.get('/:id/leaves', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json(leaves.listLeaves(db, row.id, { status: req.query.status }));
});

router.post('/:id/generate-leaves', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const fromS = req.body.serial_from != null ? req.body.serial_from : row.serial_from;
  const toS = req.body.serial_to != null ? req.body.serial_to : row.serial_to;
  try {
    const result = leaves.generateLeaves(db, row.id, fromS, toS);
    if (req.body.serial_from != null || req.body.serial_to != null) {
      db.prepare('UPDATE check_categories SET serial_from=?, serial_to=? WHERE id=?')
        .run(String(fromS || ''), String(toS || ''), row.id);
    }
    audit(
      req.user.id, 'generate_leaves', 'check_category', row.id,
      `تولید ${result.created} برگ (${fromS}–${toS})`
    );
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code || null });
  }
});

router.post('/:id/leaves/:leafId/void', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  try {
    const leaf = leaves.markLeafUnavailable(
      db, row.id, Number(req.params.leafId), 'void', req.body.reason, req.user.id
    );
    audit(req.user.id, 'void_leaf', 'cheque_book_leaf', leaf.id, `باطل برگ ${leaf.serial}: ${req.body.reason || ''}`);
    res.json(leaf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code || null });
  }
});

router.post('/:id/leaves/:leafId/lost', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  try {
    const leaf = leaves.markLeafUnavailable(
      db, row.id, Number(req.params.leafId), 'lost', req.body.reason, req.user.id
    );
    audit(req.user.id, 'lost_leaf', 'cheque_book_leaf', leaf.id, `مفقود برگ ${leaf.serial}: ${req.body.reason || ''}`);
    res.json(leaf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code || null });
  }
});

/** اتصال برگ به رکورد چک out هنگام صدور */
router.post('/:id/leaves/:leafId/issue', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  try {
    const leaf = leaves.issueLeafForCheque(
      db, row.id, Number(req.params.leafId), req.body.cheque_record_id
    );
    audit(
      req.user.id, 'issue_leaf', 'cheque_book_leaf', leaf.id,
      `صدور برگ ${leaf.serial} → چک ${req.body.cheque_record_id}`
    );
    res.json(leaf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code || null });
  }
});

router.patch('/:id/leaves/:leafId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = loadCategory(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.body.sayadi === undefined) {
    return res.status(400).json({ error: 'فیلدی برای به‌روزرسانی ارسال نشده' });
  }
  try {
    const leaf = leaves.updateLeafSayadi(db, row.id, Number(req.params.leafId), req.body.sayadi);
    audit(req.user.id, 'update_leaf', 'cheque_book_leaf', leaf.id, `صیاد برگ ${leaf.serial}`);
    res.json(leaf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code || null });
  }
});

module.exports = router;
