const router = require('express').Router();
const { getDB, audit, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { acct } = require('../lib/coa-map');

function resolveExpenseAccount(db, category, account_code) {
  if (account_code) {
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=? AND is_active=1').get(account_code);
    if (row) return { code: row.code, name: row.name };
  }
  if (category) {
    const cat = db.prepare('SELECT account_code, name FROM expense_categories WHERE (code=? OR id=?) AND active=1').get(category, parseInt(category, 10) || -1);
    if (cat?.account_code) {
      const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(cat.account_code);
      if (row) return { code: row.code, name: row.name };
      return { code: cat.account_code, name: cat.name };
    }
  }
  return acct(db, category === 'sales' ? 'coa_sales_expense' : 'coa_admin_expense');
}

router.get('/categories', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM expense_categories WHERE active=1 ORDER BY id').all());
});

router.post('/categories', auth, adminOrAccounting, (req, res) => {
  const { name, code, account_code } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'نام دسته‌بندی الزامی است' });
  const db = getDB();
  const r = db.prepare('INSERT INTO expense_categories (code,name,account_code) VALUES (?,?,?)')
    .run(code || null, String(name).trim(), account_code || null);
  audit(req.user.id, 'create', 'expense_category', r.lastInsertRowid, name);
  res.json(db.prepare('SELECT * FROM expense_categories WHERE id=?').get(r.lastInsertRowid));
});

router.put('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, code, account_code, active } = req.body;
  db.prepare('UPDATE expense_categories SET name=?, code=?, account_code=?, active=? WHERE id=?').run(
    name || row.name, code ?? row.code, account_code ?? row.account_code,
    active != null ? (active ? 1 : 0) : row.active, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE expense_categories SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT e.*, u.name as recorder, cc.name as cost_center_name,
      pi.num as purchase_invoice_num
    FROM expense_payments e
    LEFT JOIN users u ON e.created_by=u.id
    LEFT JOIN cost_centers cc ON e.cost_center_id=cc.id
    LEFT JOIN purchase_invoices pi ON e.purchase_invoice_id=pi.id
    WHERE COALESCE(e.status,'posted')<>'reversed'
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
    const entryId = postToLedger(db, {
      sourceType: 'expense_payment', sourceId: expId,
      date: date || todayJalali(), description: `پرداخت هزینه: ${title || acc.name}`,
      createdBy: req.user.id, costCenterId: cost_center_id || null,
      lines: [
        { code: acc.code, name: acc.name, debit: rialToLedger(amt), credit: 0, description: title || '' },
        { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amt) }
      ]
    });
    db.prepare('UPDATE expense_payments SET journal_entry_id=? WHERE id=?').run(entryId, expId);
    return expId;
  })();

  audit(req.user.id, 'create', 'expense_payment', expId, `پرداخت هزینه ${amt} ریال (${title || acc.name})`);
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
  if (row.status === 'reversed') return res.status(400).json({ error: 'این هزینه قبلاً ابطال شده است' });
  const acc = resolveExpenseAccount(db, row.category, row.account_code);
  db.transaction(() => {
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    const reversalId = postToLedger(db, {
      sourceType: 'expense_payment_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال پرداخت هزینه #${row.id}`, createdBy: req.user.id,
      costCenterId: row.cost_center_id || null,
      lines: [
        { code: cash.code, name: cash.name, debit: rialToLedger(row.amount), credit: 0 },
        { code: acc.code, name: acc.name, debit: 0, credit: rialToLedger(row.amount) }
      ]
    });
    db.prepare("UPDATE expense_payments SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'expense_payment', req.params.id, `ابطال پرداخت هزینه #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
