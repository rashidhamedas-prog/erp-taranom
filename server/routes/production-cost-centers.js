'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { bootstrapRate } = require('../lib/production/overhead');

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

// Before /rates/:id so "bootstrap" is not captured as an id.
router.post('/rates/bootstrap', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const b = req.body || {};
    const period = b.period || b.period_label;
    if (!period) {
      const e = new Error('period الزامی است');
      e.status = 400;
      e.code = 'E_PERIOD_REQUIRED';
      throw e;
    }
    const months = b.months != null ? Number(b.months) : undefined;
    const centers = db.prepare(`
      SELECT id, code, name FROM cost_centers
      WHERE COALESCE(active,1)=1 AND COALESCE(is_stage,0)=1
      ORDER BY COALESCE(seq,0), code
    `).all();
    const rows = centers.map((cc) => {
      const rate = bootstrapRate(db, cc.id, period, months);
      return {
        ...rate,
        cc_code: cc.code,
        cc_name: cc.name,
      };
    });
    return { period, months: months || null, count: rows.length, rows };
  });
});

router.put('/rates/:id', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(id);
    if (!row) {
      const e = new Error('نرخ یافت نشد');
      e.status = 404;
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    if (row.status === 'inactive' || row.status === 'reversed') {
      const e = new Error('نرخ غیرفعال/ابطال‌شده قابل ویرایش نیست');
      e.status = 400;
      e.code = 'E_RATE_INACTIVE';
      throw e;
    }
    const b = req.body || {};
    db.prepare(`
      UPDATE cost_center_rates SET
        driver=?, total_rate_rial=?, fixed_rate_rial=?, var_rate_rial=?,
        monthly_labor_rate_rial=?, status=?, note=?
      WHERE id=?
    `).run(
      b.driver != null ? b.driver : row.driver,
      b.total_rate_rial != null ? Math.round(Number(b.total_rate_rial) || 0) : row.total_rate_rial,
      b.fixed_rate_rial != null ? Math.round(Number(b.fixed_rate_rial) || 0) : row.fixed_rate_rial,
      b.var_rate_rial != null ? Math.round(Number(b.var_rate_rial) || 0) : row.var_rate_rial,
      b.monthly_labor_rate_rial != null
        ? Math.round(Number(b.monthly_labor_rate_rial) || 0)
        : row.monthly_labor_rate_rial,
      b.status != null ? b.status : row.status,
      b.note != null ? b.note : row.note,
      id
    );
    return db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(id);
  });
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
    }
    db.prepare("UPDATE cost_center_rates SET status='inactive' WHERE id=?").run(row.id);
    return { ok: true };
  });
});

// After all /rates* routes so "rates" is never captured as :id
router.put('/:id', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(id);
    if (!row) {
      const e = new Error('مرکز هزینه یافت نشد');
      e.status = 404;
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    const b = req.body || {};
    const driver = b.driver != null ? String(b.driver) : row.driver;
    const capacity = b.capacity_per_day != null
      ? Number(b.capacity_per_day)
      : row.capacity_per_day;
    const laborMethod = b.default_labor_method != null
      ? String(b.default_labor_method)
      : row.default_labor_method;
    const seq = b.seq != null ? Number(b.seq) : row.seq;
    const kind = b.kind != null ? String(b.kind) : row.kind;
    const active = b.active != null ? (b.active ? 1 : 0) : row.active;
    db.prepare(`
      UPDATE cost_centers SET
        driver=?, capacity_per_day=?, default_labor_method=?,
        seq=?, kind=?, active=?
      WHERE id=?
    `).run(driver, capacity, laborMethod, seq, kind, active, id);
    return db.prepare('SELECT * FROM cost_centers WHERE id=?').get(id);
  });
});

module.exports = router;
