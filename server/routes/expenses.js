const router = require('express').Router();
const { getDB, audit, createJournalEntry, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

const EXPENSE_ACCOUNTS = {
  admin: { code: '6102', name: 'هزینه‌های عمومی و اداری' },
  sales: { code: '6103', name: 'هزینه‌های توزیع و فروش' }
};

function resolveExpenseAccount(db, category, account_code) {
  if (account_code) {
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=? AND is_active=1').get(account_code);
    if (row) return { code: row.code, name: row.name };
  }
  return EXPENSE_ACCOUNTS[category] || EXPENSE_ACCOUNTS.admin;
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT e.*, u.name as recorder, cc.name as cost_center_name,
      pi.num as purchase_invoice_num
    FROM expense_payments e
    LEFT JOIN users u ON e.created_by=u.id
    LEFT JOIN cost_centers cc ON e.cost_center_id=cc.id
    LEFT JOIN purchase_invoices pi ON e.purchase_invoice_id=pi.id
    ORDER BY e.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    category, title, amount, pay_type, date, note, bank_id, cash_box_id,
    check_category_id, cost_center_id, account_code, purchase_invoice_id, is_overhead
  } = req.body;
  const amt = parseFloat(amount) || 0;
  if (!amt) return res.status(400).json({ error: 'مبلغ الزامی است' });
  const db = getDB();
  const acc = resolveExpenseAccount(db, category, account_code);
  const expId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO expense_payments (category,title,amount,pay_type,bank_id,cash_box_id,check_category_id,cost_center_id,date,note,created_by,account_code,purchase_invoice_id,is_overhead)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(category || 'admin', title || '', amt, pay_type || 'cash', bank_id || null, cash_box_id || null,
          check_category_id || null, cost_center_id || null, date || todayJalali(), note || '',
          req.user.id, acc.code, purchase_invoice_id || null, is_overhead ? 1 : 0);
    const expId = result.lastInsertRowid;

    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    const entryId = createJournalEntry(db, {
      date: date || todayJalali(), description: `پرداخت هزینه: ${title || acc.name}`,
      ref_type: 'expense_payment', ref_id: expId, created_by: req.user.id,
      lines: [
        { code: acc.code, name: acc.name, debit: amt, credit: 0, description: title || '' },
        { code: cash.code, name: cash.name, debit: 0, credit: amt }
      ]
    });
    if (cost_center_id) db.prepare('UPDATE journal_entries SET cost_center_id=? WHERE id=?').run(cost_center_id, entryId);
    return expId;
  })();

  audit(req.user.id, 'create', 'expense_payment', expId, `پرداخت هزینه ${amt} تومان (${title || acc.name})`);
  res.json({ id: expId, ok: true });
});

router.get('/overhead-pool', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const where = ["is_overhead=1"], params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const tagged = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE ${where.join(' AND ')}`).get(...params).s;

  const settings = {};
  db.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?)').all(
    'overhead_method', 'overhead_fixed_rate', 'overhead_period_production_qty'
  ).forEach(r => { settings[r.key] = r.value; });

  const method = settings.overhead_method || 'tag';
  const fixedRate = parseFloat(settings.overhead_fixed_rate) || 0;
  const periodQty = parseInt(settings.overhead_period_production_qty) || 0;
  const fixedPool = fixedRate * periodQty;

  res.json({
    method,
    tagged_overhead: tagged,
    fixed_rate: fixedRate,
    period_production_qty: periodQty,
    fixed_pool: fixedPool,
    total_pool: method === 'fixed' ? fixedPool : (method === 'both' ? tagged + fixedPool : tagged)
  });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const acc = resolveExpenseAccount(db, row.category, row.account_code);
  db.transaction(() => {
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال پرداخت هزینه #${row.id}`,
      ref_type: 'expense_payment_reversal', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: cash.code, name: cash.name, debit: row.amount, credit: 0 },
        { code: acc.code, name: acc.name, debit: 0, credit: row.amount }
      ]
    });
    db.prepare('DELETE FROM expense_payments WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'expense_payment', req.params.id, `حذف پرداخت هزینه #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
