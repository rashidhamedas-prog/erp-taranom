'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');

function handle(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message, ...(e.extra || {}) });
  }
}

router.get('/', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const rows = getDB().prepare(`
      SELECT * FROM cost_centers
      WHERE COALESCE(active,1)=1
      ORDER BY COALESCE(seq,0), code
    `).all();
    return { rows };
  });
});

router.get('/rates', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const period = req.query.period;
    const includeInactive = req.query.all === '1';
    const statusFilter = includeInactive ? '1=1' : "COALESCE(r.status,'active')='active'";
    const rows = period
      ? getDB().prepare(`
          SELECT r.*, c.code AS cc_code, c.name AS cc_name
          FROM cost_center_rates r
          JOIN cost_centers c ON c.id = r.cost_center_id
          WHERE r.period_label=? AND ${statusFilter}
          ORDER BY c.seq
        `).all(period)
      : getDB().prepare(`
          SELECT r.*, c.code AS cc_code, c.name AS cc_name
          FROM cost_center_rates r
          JOIN cost_centers c ON c.id = r.cost_center_id
          WHERE ${statusFilter}
          ORDER BY r.period_label DESC, c.seq
        `).all();
    return { rows };
  });
});

router.post('/rates', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  try {
    const b = req.body || {};
    const db = getDB();
    const existing = db.prepare(`
      SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
    `).get(b.cost_center_id, b.period_label);
    let id;
    if (existing) {
      db.prepare(`
        UPDATE cost_center_rates SET
          driver=?, total_rate_rial=?, fixed_rate_rial=?, var_rate_rial=?,
          monthly_labor_rate_rial=?, status=?, is_estimated=?, note=?
        WHERE id=?
      `).run(
        b.driver || 'output_qty',
        Math.round(Number(b.total_rate_rial) || 0),
        Math.round(Number(b.fixed_rate_rial) || 0),
        Math.round(Number(b.var_rate_rial) || 0),
        Math.round(Number(b.monthly_labor_rate_rial) || 0),
        b.status || 'active',
        b.is_estimated ? 1 : 0,
        b.note || '',
        existing.id
      );
      id = existing.id;
    } else {
      id = db.prepare(`
        INSERT INTO cost_center_rates
          (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
           var_rate_rial, monthly_labor_rate_rial, status, is_estimated, note, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        b.cost_center_id, b.period_label, b.driver || 'output_qty',
        Math.round(Number(b.total_rate_rial) || 0),
        Math.round(Number(b.fixed_rate_rial) || 0),
        Math.round(Number(b.var_rate_rial) || 0),
        Math.round(Number(b.monthly_labor_rate_rial) || 0),
        b.status || 'active', b.is_estimated ? 1 : 0, b.note || '', req.user.id
      ).lastInsertRowid;
    }
    res.status(201).json(db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

// Soft-cancel overhead rate for a period/CC (R13 — no physical delete)
router.delete('/rates/:id', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const row = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(req.params.id);
    if (!row) {
      const e = new Error('نرخ یافت نشد');
      e.status = 404;
      throw e;
    }
    if (row.status === 'inactive' || row.status === 'reversed') {
      const e = new Error('این نرخ قبلاً غیرفعال شده');
      e.status = 400;
      throw e;
    }
    // Block if production overhead already applied for this CC+period
    try {
      const used = db.prepare(`
        SELECT COUNT(*) c FROM production_overhead_applications
        WHERE cost_center_id=? AND period_label=? AND COALESCE(status,'posted')='posted'
      `).get(row.cost_center_id, row.period_label).c;
      if (used > 0) {
        const e = new Error('این نرخ در تولید اعمال شده — ابتدا اسناد تولید مرتبط را ابطال کنید');
        e.status = 400;
        throw e;
      }
    } catch (e) {
      if (e.status) throw e;
      // table may not exist on older DBs — allow soft cancel
    }
    db.prepare("UPDATE cost_center_rates SET status='inactive' WHERE id=?").run(row.id);
    return { ok: true };
  });
});

module.exports = router;
