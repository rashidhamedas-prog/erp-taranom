const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { todayJalali } = require('../jalali');

function permit(action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
    return requirePermission('bank_reconciliation', action)(req, res, next);
  };
}

function bankAccountCode(db, bankId) {
  const bank = db.prepare('SELECT coa_code FROM banks WHERE id=?').get(bankId);
  if (bank?.coa_code) return bank.coa_code;
  return '1102-' + bankId;
}

function computeBookBalance(db, bankId, asOfDate) {
  const code = bankAccountCode(db, bankId);
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE (jl.account_code = ? OR jl.account_code LIKE ?)
      AND COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
      AND (? = '' OR je.entry_date <= ?)
  `).get(code, code + '-%', asOfDate || '', asOfDate || '');
  return Math.round(row?.bal || 0);
}

router.post('/', auth, permit('create'), (req, res) => {
  try {
    const { bank_id, statement_date, statement_balance_rial, notes } = req.body;
    const bankId = parseInt(bank_id, 10);
    const stmtDate = String(statement_date || '').trim();
    const stmtBal = Math.round(Number(statement_balance_rial) || 0);
    if (!bankId || !stmtDate) throw new Error('بانک و تاریخ صورت‌حساب الزامی است');

    const db = getDB();
    const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(bankId);
    if (!bank) throw new Error('بانک یافت نشد');

    const bookBal = computeBookBalance(db, bankId, stmtDate);
    const r = db.prepare(`
      INSERT INTO bank_reconciliations
        (bank_id, statement_date, statement_balance_rial, book_balance_rial, status, notes, created_by)
      VALUES (?,?,?,?, 'open', ?, ?)
    `).run(bankId, stmtDate, stmtBal, bookBal, notes || '', req.user.id);

    audit(req.user.id, 'create', 'bank_reconciliation', r.lastInsertRowid, `تطبیق بانک #${bankId}`);
    res.json(db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', auth, permit('view'), (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.bank_id) { where.push('r.bank_id=?'); params.push(parseInt(req.query.bank_id, 10)); }
  if (req.query.status) { where.push('r.status=?'); params.push(req.query.status); }
  const sql = `
    SELECT r.*, b.name AS bank_name
    FROM bank_reconciliations r
    JOIN banks b ON b.id = r.bank_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.id DESC LIMIT 200
  `;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', auth, permit('view'), (req, res) => {
  const db = getDB();
  const recon = db.prepare(`
    SELECT r.*, b.name AS bank_name
    FROM bank_reconciliations r
    JOIN banks b ON b.id = r.bank_id
    WHERE r.id=?
  `).get(req.params.id);
  if (!recon) return res.status(404).json({ error: 'یافت نشد' });
  const items = db.prepare(`
    SELECT * FROM bank_reconciliation_items WHERE reconciliation_id=? ORDER BY id
  `).all(recon.id);
  res.json({ ...recon, items });
});

router.post('/:id/items', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'closed') throw new Error('تطبیق بسته شده و قابل ویرایش نیست');

    const rows = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const ins = db.prepare(`
      INSERT INTO bank_reconciliation_items
        (reconciliation_id, side, ref_type, ref_id, description, amount_rial, matched, statement_line)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const created = db.transaction(() => rows.map(row => {
      const side = row.side === 'bank' ? 'bank' : 'book';
      const amt = Math.round(Number(row.amount_rial) || 0);
      if (!amt) throw new Error('مبلغ آیتم نامعتبر است');
      const r = ins.run(
        recon.id, side, row.ref_type || null, row.ref_id || null,
        row.description || '', amt, row.matched ? 1 : 0, row.statement_line ? 1 : 0
      );
      return db.prepare('SELECT * FROM bank_reconciliation_items WHERE id=?').get(r.lastInsertRowid);
    }))();

    res.json({ ok: true, items: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/match', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'closed') throw new Error('تطبیق بسته شده است');

    const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number) : [];
    if (!ids.length) throw new Error('شناسه آیتم‌ها الزامی است');

    db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE bank_reconciliation_items SET matched=1
        WHERE reconciliation_id=? AND id=?
      `);
      for (const id of ids) stmt.run(recon.id, id);
    })();

    res.json({ ok: true, matched: ids.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/close', auth, permit('approve'), (req, res) => {
  try {
    const db = getDB();
    const recon = db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'closed') throw new Error('تطبیق قبلاً بسته شده است');

    const items = db.prepare(`
      SELECT * FROM bank_reconciliation_items WHERE reconciliation_id=?
    `).all(recon.id);

    const unmatchedBook = items.filter(i => i.side === 'book' && !i.matched)
      .reduce((s, i) => s + (i.amount_rial || 0), 0);
    const unmatchedBank = items.filter(i => i.side === 'bank' && !i.matched)
      .reduce((s, i) => s + (i.amount_rial || 0), 0);
    const reconciledBook = recon.book_balance_rial - unmatchedBook + unmatchedBank;
    const diff = recon.statement_balance_rial - reconciledBook;

    const result = db.transaction(() => {
      let adjustmentJeId = recon.adjustment_je_id || null;
      if (Math.abs(diff) > 0) {
        const bankAcct = acct(db, 'coa_bank_default');
        const adjAcct = acct(db, 'coa_adjustment');
        const absRial = Math.abs(diff);
        const amt = rialToLedger(absRial);
        const lines = diff > 0
          ? [
            { code: bankAcct.code, name: bankAcct.name, debit: amt, credit: 0, debit_rial: absRial },
            { code: adjAcct.code, name: adjAcct.name, debit: 0, credit: amt, credit_rial: absRial },
          ]
          : [
            { code: adjAcct.code, name: adjAcct.name, debit: amt, credit: 0, debit_rial: absRial },
            { code: bankAcct.code, name: bankAcct.name, debit: 0, credit: amt, credit_rial: absRial },
          ];
        adjustmentJeId = postToLedger(db, {
          sourceType: 'bank_recon_adjustment', sourceId: recon.id,
          date: recon.statement_date || todayJalali(),
          description: `تعدیل تطبیق بانک #${recon.id}`,
          createdBy: req.user.id, lines,
        });
      }
      db.prepare(`
        UPDATE bank_reconciliations
        SET status='closed', adjustment_je_id=?, closed_at=strftime('%s','now')
        WHERE id=?
      `).run(adjustmentJeId, recon.id);
      return { adjustment_je_id: adjustmentJeId, difference_rial: diff, reconciled_book_rial: reconciledBook };
    })();

    audit(req.user.id, 'close', 'bank_reconciliation', recon.id, `بستن تطبیق بانک`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
