'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  bootstrapRate,
  normalizeDriver,
  coerceDriver,
  validatePeriodLabel,
  computePredeterminedRates,
  looksLikePoolNotRate,
} = require('../lib/production/overhead');

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
          SELECT r.*, c.code AS cc_code, c.name AS cc_name, c.driver AS cc_default_driver
          FROM cost_center_rates r
          JOIN cost_centers c ON c.id = r.cost_center_id
          WHERE r.period_label=? AND ${statusFilter}
          ORDER BY c.seq
        `).all(period)
      : getDB().prepare(`
          SELECT r.*, c.code AS cc_code, c.name AS cc_name, c.driver AS cc_default_driver
          FROM cost_center_rates r
          JOIN cost_centers c ON c.id = r.cost_center_id
          WHERE ${statusFilter}
          ORDER BY r.period_label DESC, c.seq
        `).all();
    rows.forEach((r) => { r.driver = coerceDriver(r.driver); });
    return { rows };
  });
});

function persistRate(db, body, userId, existingId) {
  const ccId = Number(body.cost_center_id);
  if (!ccId) throw rateHttp('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const cc = db.prepare('SELECT id FROM cost_centers WHERE id=?').get(ccId);
  if (!cc) throw rateHttp('E_CC_NOT_FOUND', 404, 'مرکز هزینه یافت نشد');
  const period = validatePeriodLabel(body.period_label);
  const driver = normalizeDriver(body.driver);
  const computed = computePredeterminedRates(body);
  const status = ['active', 'draft', 'estimated', 'inactive'].includes(String(body.status || 'active'))
    ? String(body.status || 'active')
    : 'active';
  const isEstimated = body.is_estimated ? 1 : 0;
  const note = String(body.note || '');
  const warning = (!computed.from_budget && looksLikePoolNotRate(driver, computed.total_rate_rial))
    ? 'این مبلغ شبیه بودجهٔ دوره است نه نرخ جذب. بهتر است بودجه و مقدار محرک را وارد کنید تا نرخ از روی IAS 2 محاسبه شود.'
    : '';

  if (existingId) {
    db.prepare(`
      UPDATE cost_center_rates SET
        cost_center_id=?, period_label=?, driver=?,
        budget_fixed_oh_rial=?, budget_var_oh_rial=?, budget_driver_qty=?,
        total_rate_rial=?, fixed_rate_rial=?, var_rate_rial=?,
        monthly_labor_rate_rial=?, absorb_pct=?, status=?, is_estimated=?, note=?
      WHERE id=?
    `).run(
      ccId, period, driver,
      computed.budget_fixed_oh_rial, computed.budget_var_oh_rial, computed.budget_driver_qty,
      computed.total_rate_rial, computed.fixed_rate_rial, computed.var_rate_rial,
      computed.monthly_labor_rate_rial, computed.absorb_pct, status, isEstimated, note, existingId
    );
    return { id: existingId, warning };
  }

  const info = db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver,
       budget_fixed_oh_rial, budget_var_oh_rial, budget_driver_qty,
       total_rate_rial, fixed_rate_rial, var_rate_rial,
       monthly_labor_rate_rial, absorb_pct, status, is_estimated, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    ccId, period, driver,
    computed.budget_fixed_oh_rial, computed.budget_var_oh_rial, computed.budget_driver_qty,
    computed.total_rate_rial, computed.fixed_rate_rial, computed.var_rate_rial,
    computed.monthly_labor_rate_rial, computed.absorb_pct, status, isEstimated, note, userId
  );
  return { id: info.lastInsertRowid, warning };
}

function rateHttp(code, status, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

router.post('/rates', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  try {
    const b = req.body || {};
    const db = getDB();
    const period = b.period_label ? validatePeriodLabel(b.period_label) : '';
    const existing = (b.cost_center_id && period)
      ? db.prepare(`
          SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
        `).get(Number(b.cost_center_id), period)
      : null;
    const saved = persistRate(db, b, req.user.id, existing?.id || null);
    const row = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(saved.id);
    if (row) row.driver = coerceDriver(row.driver);
    res.status(existing ? 200 : 201).json({ ...row, warning: saved.warning || undefined });
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
    const periodLabel = validatePeriodLabel(period);
    const months = b.months != null ? Number(b.months) : undefined;
    const centers = db.prepare(`
      SELECT id, code, name FROM cost_centers
      WHERE COALESCE(active,1)=1 AND COALESCE(is_stage,0)=1
      ORDER BY COALESCE(seq,0), code
    `).all();
    const rows = centers.map((cc) => {
      const rate = bootstrapRate(db, cc.id, periodLabel, months);
      return {
        ...rate,
        driver: coerceDriver(rate?.driver),
        cc_code: cc.code,
        cc_name: cc.name,
      };
    });
    return { period: periodLabel, months: months || null, count: rows.length, rows };
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
    const b = { ...row, ...(req.body || {}) };
    b.cost_center_id = row.cost_center_id;
    b.period_label = req.body?.period_label != null ? req.body.period_label : row.period_label;
    const saved = persistRate(db, b, req.user?.id, id);
    const out = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(id);
    if (out) out.driver = coerceDriver(out.driver);
    if (saved.warning) out.warning = saved.warning;
    return out;
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
