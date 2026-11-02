'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission, centralOnlyStrict } = require('../middleware/auth');
const {
  bootstrapRate,
  normalizeDriver,
  coerceDriver,
  validatePeriodLabel,
  computePredeterminedRates,
  looksLikePoolNotRate,
  isRialDriver,
  normalizeRatePct,
  pctFromRatePerMillion,
  ratePerMillionFromPct,
  DEFAULT_RATE_PCT,
} = require('../lib/production/overhead');
const {
  listMaps,
  replaceMaps,
  softDeactivateMap,
  previewAbsorbForCenter,
  listAbsorbPostings,
  runAbsorb,
  reverseAbsorb,
  BASE_TYPES,
} = require('../lib/production/cc-account-absorb');

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

/**
 * P3 — محرک ریالی: درصد صریح (rate_pct) منبع است و total_rate_rial (ریال/میلیون) هم‌گام می‌ماند.
 * بدون درصد صریح: از نرخ کل مشتق می‌شود؛ ردیف تازهٔ بدون نرخ ⇒ پیش‌فرض ۲۰٪.
 */
function resolveRatePctBody(body, driver, { pctExplicit, isNew }) {
  if (!isRialDriver(driver)) return { ...body, rate_pct: null };
  const explicit = pctExplicit ? normalizeRatePct(body.rate_pct) : null;
  if (explicit != null) {
    const t = ratePerMillionFromPct(explicit);
    return {
      ...body,
      rate_pct: explicit,
      rate_touch: 'total',
      total_rate_rial: t,
      fixed_rate_rial: t,
      var_rate_rial: 0,
    };
  }
  return { ...body, rate_pct: undefined, _defaultPct: isNew ? DEFAULT_RATE_PCT : null };
}

function persistRate(db, rawBody, userId, existingId, opts = {}) {
  const ccId = Number(rawBody.cost_center_id);
  if (!ccId) throw rateHttp('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const cc = db.prepare('SELECT id FROM cost_centers WHERE id=?').get(ccId);
  if (!cc) throw rateHttp('E_CC_NOT_FOUND', 404, 'مرکز هزینه یافت نشد');
  const period = validatePeriodLabel(rawBody.period_label);
  const driver = normalizeDriver(rawBody.driver);
  const pctExplicit = opts.pctExplicit != null
    ? !!opts.pctExplicit
    : (rawBody.rate_pct != null && rawBody.rate_pct !== '');
  const body = resolveRatePctBody(rawBody, driver, { pctExplicit, isNew: !existingId });
  let computed = computePredeterminedRates(body);
  let ratePct = null;
  if (isRialDriver(driver)) {
    if (body.rate_pct != null) ratePct = body.rate_pct;
    else if (computed.total_rate_rial > 0) ratePct = pctFromRatePerMillion(computed.total_rate_rial);
    else if (body._defaultPct != null) {
      ratePct = body._defaultPct;
      const t = ratePerMillionFromPct(ratePct);
      computed = { ...computed, total_rate_rial: t, fixed_rate_rial: t, var_rate_rial: 0 };
    }
  }
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
        monthly_labor_rate_rial=?, absorb_pct=?, rate_pct=?, status=?, is_estimated=?, note=?
      WHERE id=?
    `).run(
      ccId, period, driver,
      computed.budget_fixed_oh_rial, computed.budget_var_oh_rial, computed.budget_driver_qty,
      computed.total_rate_rial, computed.fixed_rate_rial, computed.var_rate_rial,
      computed.monthly_labor_rate_rial, computed.absorb_pct, ratePct, status, isEstimated, note, existingId
    );
    return { id: existingId, warning };
  }

  const info = db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver,
       budget_fixed_oh_rial, budget_var_oh_rial, budget_driver_qty,
       total_rate_rial, fixed_rate_rial, var_rate_rial,
       monthly_labor_rate_rial, absorb_pct, rate_pct, status, is_estimated, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    ccId, period, driver,
    computed.budget_fixed_oh_rial, computed.budget_var_oh_rial, computed.budget_driver_qty,
    computed.total_rate_rial, computed.fixed_rate_rial, computed.var_rate_rial,
    computed.monthly_labor_rate_rial, computed.absorb_pct, ratePct, status, isEstimated, note, userId
  );
  return { id: info.lastInsertRowid, warning };
}

/** P3 — ویرایش نرخ سربار فقط مدیر و حسابداری (نه دسترسی تفویضی). */
function adminOrAccountingStrict(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'accounting')) return next();
  return res.status(403).json({ error: 'ویرایش نرخ سربار فقط برای مدیر و حسابداری مجاز است', code: 'E_FORBIDDEN' });
}

function rateAuditDetail(before, after) {
  const keys = ['driver', 'rate_pct', 'total_rate_rial', 'fixed_rate_rial', 'var_rate_rial',
    'budget_fixed_oh_rial', 'budget_var_oh_rial', 'budget_driver_qty', 'absorb_pct',
    'monthly_labor_rate_rial', 'status'];
  const pick = (r) => (r ? Object.fromEntries(keys.map((k) => [k, r[k] == null ? null : r[k]])) : null);
  return JSON.stringify({
    cost_center_id: (after || before)?.cost_center_id,
    period_label: (after || before)?.period_label,
    before: pick(before),
    after: pick(after),
  });
}

function rateHttp(code, status, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

router.post('/rates', auth, requirePermission('production_cost', 'edit'), adminOrAccountingStrict, (req, res) => {
  try {
    const b = req.body || {};
    const db = getDB();
    const period = b.period_label ? validatePeriodLabel(b.period_label) : '';
    const existing = (b.cost_center_id && period)
      ? db.prepare(`
          SELECT * FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
        `).get(Number(b.cost_center_id), period)
      : null;
    const saved = persistRate(db, b, req.user.id, existing?.id || null);
    const row = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(saved.id);
    audit(req.user.id, existing ? 'update' : 'create', 'cost_center_rate', saved.id,
      rateAuditDetail(existing, row), req);
    if (row) row.driver = coerceDriver(row.driver);
    res.status(existing ? 200 : 201).json({ ...row, warning: saved.warning || undefined });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

// Before /rates/:id so "bootstrap" is not captured as an id.
router.post('/rates/bootstrap', auth, requirePermission('production_cost', 'edit'), adminOrAccountingStrict, (req, res) => {
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
    audit(req.user?.id, 'update', 'cost_center_rate', null,
      JSON.stringify({ action: 'bootstrap', period: periodLabel, months: months || null, count: rows.length }), req);
    return { period: periodLabel, months: months || null, count: rows.length, rows };
  });
});

router.put('/rates/:id', auth, requirePermission('production_cost', 'edit'), adminOrAccountingStrict, (req, res) => {
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
    const pctExplicit = req.body?.rate_pct !== undefined && req.body?.rate_pct !== null && req.body?.rate_pct !== '';
    const saved = persistRate(db, b, req.user?.id, id, { pctExplicit });
    const out = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(id);
    audit(req.user?.id, 'update', 'cost_center_rate', id, rateAuditDetail(row, out), req);
    if (out) out.driver = coerceDriver(out.driver);
    if (saved.warning) out.warning = saved.warning;
    return out;
  });
});

/* ── Selective معین → cost-center absorption maps (ADR-004) ── */

router.get('/account-maps', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const ccId = Number(req.query.cost_center_id);
    if (!ccId) {
      const e = new Error('مرکز هزینه الزامی است');
      e.status = 400;
      e.code = 'E_CC_REQUIRED';
      throw e;
    }
    return {
      base_types: BASE_TYPES,
      rows: listMaps(getDB(), ccId, { includeInactive: req.query.all === '1' }),
    };
  });
});

router.put('/account-maps/:costCenterId', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => {
    const rows = replaceMaps(getDB(), req.params.costCenterId, req.body?.maps || req.body?.rows || [], req.user?.id);
    return { rows, base_types: BASE_TYPES };
  });
});

router.delete('/account-maps/:id', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => softDeactivateMap(getDB(), req.params.id));
});

router.post('/account-maps/preview', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const b = req.body || {};
    const ccId = Number(b.cost_center_id);
    const period = validatePeriodLabel(b.period_label || b.period);
    return previewAbsorbForCenter(getDB(), ccId, period);
  });
});

router.post('/account-maps/apply-budget', auth, requirePermission('production_cost', 'edit'), adminOrAccountingStrict, (req, res) => {
  handle(res, () => {
    const db = getDB();
    const b = req.body || {};
    const ccId = Number(b.cost_center_id);
    const period = validatePeriodLabel(b.period_label || b.period);
    const preview = previewAbsorbForCenter(db, ccId, period);
    if (!preview.pool_rial) {
      const e = new Error('مبلغ جذبی از معین‌ها صفر است');
      e.status = 400;
      e.code = 'E_POOL_ZERO';
      throw e;
    }
    const existing = db.prepare(`
      SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
    `).get(ccId, period);
    const body = {
      cost_center_id: ccId,
      period_label: period,
      driver: b.driver
        || (existing
          ? db.prepare('SELECT driver FROM cost_center_rates WHERE id=?').get(existing.id)?.driver
          : null)
        || 'output_qty',
      budget_fixed_oh_rial: preview.pool_rial,
      budget_var_oh_rial: Number(b.budget_var_oh_rial) || 0,
      budget_driver_qty: Number(b.budget_driver_qty) || (existing
        ? Number(db.prepare('SELECT budget_driver_qty FROM cost_center_rates WHERE id=?').get(existing.id)?.budget_driver_qty) || 0
        : 0),
      monthly_labor_rate_rial: Number(b.monthly_labor_rate_rial) || 0,
      absorb_pct: b.absorb_pct != null ? b.absorb_pct : 100,
      note: b.note || `بودجه از جذب معین (${preview.lines.length} حساب)`,
      status: 'active',
      is_estimated: 0,
    };
    if (!body.budget_driver_qty) {
      // Keep pool as budget; rates stay 0 until driver qty filled — still persist budget.
      body.total_rate_rial = 0;
      body.fixed_rate_rial = 0;
      body.var_rate_rial = 0;
    }
    const before = existing ? db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(existing.id) : null;
    const saved = persistRate(db, body, req.user?.id, existing?.id || null);
    const row = db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(saved.id);
    audit(req.user?.id, existing ? 'update' : 'create', 'cost_center_rate', saved.id, rateAuditDetail(before, row), req);
    if (row) row.driver = coerceDriver(row.driver);
    return { rate: row, preview, warning: saved.warning || undefined };
  });
});

/* ── P3: اجرای واقعی جذب معین‌ها (61030x → 5202) — فقط سرور مرکزی ── */

router.get('/absorb-postings', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => ({
    rows: listAbsorbPostings(getDB(), {
      period: req.query.period ? validatePeriodLabel(req.query.period) : null,
      costCenterId: req.query.cost_center_id ? Number(req.query.cost_center_id) : null,
    }),
  }));
});

router.post('/absorb-postings/run', auth, centralOnlyStrict, requirePermission('production_cost', 'edit'),
  adminOrAccountingStrict, (req, res) => {
    handle(res, () => {
      const b = req.body || {};
      return runAbsorb(getDB(), {
        costCenterId: Number(b.cost_center_id),
        period: validatePeriodLabel(b.period_label || b.period),
        date: b.date || null,
        userId: req.user.id,
      });
    });
  });

router.post('/absorb-postings/:docNo/reverse', auth, centralOnlyStrict, requirePermission('production_cost', 'edit'),
  adminOrAccountingStrict, (req, res) => {
    handle(res, () => reverseAbsorb(getDB(), {
      docNo: req.params.docNo,
      reason: req.body?.reason,
      userId: req.user.id,
    }));
  });

// Soft-cancel overhead rate for a period/CC (R13 — no physical delete)
router.delete('/rates/:id', auth, requirePermission('production_cost', 'edit'), adminOrAccountingStrict, (req, res) => {
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
    audit(req.user?.id, 'delete', 'cost_center_rate', row.id,
      rateAuditDetail(row, { ...row, status: 'inactive' }), req);
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
