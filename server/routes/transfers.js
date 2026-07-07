const router = require('express').Router();
const { getDB, audit, createJournalEntry, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Internal account transfers: cash<->cash, cash<->bank, bank<->bank.
// A transfer never touches a person's ledger — it's a pure movement between the
// company's own asset accounts, posted as a single balanced journal entry
// (Dr destination / Cr source).

const TYPES = ['cash', 'bank'];

function resolveSide(db, type, id) {
  if (type === 'bank') return resolveCashAccount(db, 'bank', id, null);
  return resolveCashAccount(db, 'cash', null, id);
}

function sideName(db, type, id) {
  if (!id) return type === 'bank' ? 'بانک (عمومی)' : 'صندوق (عمومی)';
  const row = type === 'bank'
    ? db.prepare('SELECT name FROM banks WHERE id=?').get(id)
    : db.prepare('SELECT name FROM cash_boxes WHERE id=?').get(id);
  return row ? row.name : '-';
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT t.*, u.name as recorder FROM account_transfers t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 300').all();
  rows.forEach(r => {
    r.from_name = sideName(db, r.from_type, r.from_id);
    r.to_name = sideName(db, r.to_type, r.to_id);
  });
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { date, from_type, from_id, to_type, to_id, amount, note } = req.body;
  if (!TYPES.includes(from_type) || !TYPES.includes(to_type)) return res.status(400).json({ error: 'نوع حساب مبدأ/مقصد نامعتبر است' });
  const amt = parseFloat(amount) || 0;
  if (amt <= 0) return res.status(400).json({ error: 'مبلغ باید بزرگ‌تر از صفر باشد' });
  if (from_type === to_type && (from_id || null) === (to_id || null)) {
    return res.status(400).json({ error: 'حساب مبدأ و مقصد نمی‌تواند یکسان باشد' });
  }
  const db = getDB();
  const transferId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO account_transfers (date,from_type,from_id,to_type,to_id,amount,note,user_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run(date || todayJalali(), from_type, from_id || null, to_type, to_id || null, amt, note || '', req.user.id);
    const transferId = result.lastInsertRowid;

    const src = resolveSide(db, from_type, from_id);
    const dst = resolveSide(db, to_type, to_id);
    createJournalEntry(db, {
      date: date || todayJalali(), description: `انتقال وجه: ${sideName(db, from_type, from_id)} ← ${sideName(db, to_type, to_id)}`,
      ref_type: 'transfer', ref_id: transferId, created_by: req.user.id,
      lines: [
        { code: dst.code, name: dst.name, debit: amt, credit: 0 },
        { code: src.code, name: src.name, debit: 0, credit: amt }
      ]
    });
    return transferId;
  })();

  audit(req.user.id, 'create', 'transfer', transferId, `انتقال ${amt} تومان بین حساب‌های داخلی`);
  res.json({ id: transferId, ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM account_transfers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });

  db.transaction(() => {
    const src = resolveSide(db, row.from_type, row.from_id);
    const dst = resolveSide(db, row.to_type, row.to_id);
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال انتقال وجه #${row.id}`,
      ref_type: 'transfer_reversal', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: src.code, name: src.name, debit: row.amount, credit: 0 },
        { code: dst.code, name: dst.name, debit: 0, credit: row.amount }
      ]
    });

    db.prepare('DELETE FROM account_transfers WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'transfer', req.params.id, `حذف انتقال وجه #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
