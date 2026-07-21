const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

function permit(action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
    return requirePermission('budgeting', action)(req, res, next);
  };
}

router.get('/', auth, permit('view'), (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.year_label) { where.push('year_label=?'); params.push(req.query.year_label); }
  res.json(db.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM budget_lines bl WHERE bl.budget_id=b.id) line_count
    FROM budgets b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.id DESC
  `).all(...params));
});

router.get('/:id', auth, permit('view'), (req, res) => {
  const db = getDB();
  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!budget) return res.status(404).json({ error: 'یافت نشد' });
  const lines = db.prepare('SELECT * FROM budget_lines WHERE budget_id=? ORDER BY month, account_code').all(budget.id);
  res.json({ ...budget, lines });
});

router.post('/', auth, permit('create'), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) throw new Error('نام بودجه الزامی است');
    const db = getDB();
    const r = db.prepare(`
      INSERT INTO budgets (name, fiscal_year_id, year_label, status, notes, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(
      b.name, b.fiscal_year_id || null, b.year_label || '', b.status || 'draft',
      b.notes || '', req.user.id
    );
    audit(req.user.id, 'create', 'budget', r.lastInsertRowid, b.name);
    res.json(db.prepare('SELECT * FROM budgets WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    const b = req.body || {};
    db.prepare(`
      UPDATE budgets SET name=?, fiscal_year_id=?, year_label=?, status=?, notes=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(
      b.name ?? row.name, b.fiscal_year_id ?? row.fiscal_year_id,
      b.year_label ?? row.year_label, b.status ?? row.status,
      b.notes ?? row.notes, req.params.id
    );
    if (Array.isArray(b.lines)) {
      db.prepare('DELETE FROM budget_lines WHERE budget_id=?').run(req.params.id);
      const ins = db.prepare(`
        INSERT INTO budget_lines (budget_id, account_code, cost_center_id, month, amount_rial, category, notes)
        VALUES (?,?,?,?,?,?,?)
      `);
      db.transaction(() => {
        for (const line of b.lines) {
          ins.run(
            req.params.id, line.account_code || '', line.cost_center_id || null,
            parseInt(line.month, 10) || 1, Math.round(Number(line.amount_rial) || 0),
            line.category || 'opex', line.notes || ''
          );
        }
      })();
    }
    audit(req.user.id, 'update', 'budget', req.params.id, b.name || row.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', auth, permit('delete'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.transaction(() => {
    db.prepare('DELETE FROM budget_lines WHERE budget_id=?').run(req.params.id);
    db.prepare('DELETE FROM budgets WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'budget', req.params.id, row.name);
  res.json({ ok: true });
});

router.get('/:id/variance', auth, permit('view'), (req, res) => {
  const db = getDB();
  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!budget) return res.status(404).json({ error: 'یافت نشد' });

  const lines = db.prepare(`
    SELECT account_code, month, SUM(amount_rial) budget_rial
    FROM budget_lines WHERE budget_id=?
    GROUP BY account_code, month
    ORDER BY month, account_code
  `).all(budget.id);

  const yearPrefix = String(budget.year_label || '').replace(/\/.*/, '') || String(new Date().getFullYear() + 621);
  const actualRows = db.prepare(`
    SELECT jl.account_code,
           CAST(substr(je.entry_date, 6, 2) AS INTEGER) AS month,
           SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}) actual_rial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
      AND substr(je.entry_date, 1, 4) = ?
    GROUP BY jl.account_code, month
  `).all(yearPrefix);

  const actualMap = {};
  for (const a of actualRows) {
    actualMap[`${a.account_code}:${a.month}`] = a.actual_rial || 0;
  }

  const rows = lines.map(l => {
    const key = `${l.account_code}:${l.month}`;
    const actual = actualMap[key] || 0;
    return {
      account_code: l.account_code,
      month: l.month,
      budget_rial: l.budget_rial,
      actual_rial: actual,
      variance_rial: (l.budget_rial || 0) - actual,
    };
  });

  const totals = rows.reduce((s, r) => ({
    budget_rial: s.budget_rial + r.budget_rial,
    actual_rial: s.actual_rial + r.actual_rial,
    variance_rial: s.variance_rial + r.variance_rial,
  }), { budget_rial: 0, actual_rial: 0, variance_rial: 0 });

  res.json({ budget_id: budget.id, year_label: budget.year_label, rows, totals });
});

module.exports = router;
