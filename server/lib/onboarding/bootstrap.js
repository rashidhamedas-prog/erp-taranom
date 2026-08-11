/**
 * P1-M3 onboarding MVP — ensure company workspace hooks, fiscal year,
 * default warehouse / cash box, checklist status, and import dry-run validation.
 * Idempotent; never wipes production data.
 */
const { syncCashBoxAccount } = require('../../db');
const { todayJalali } = require('../../jalali');

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
}

function currentOpenFiscalYear(db) {
  const activeId = getSetting(db, 'active_fiscal_year_id');
  if (activeId) {
    const byId = db.prepare("SELECT * FROM fiscal_years WHERE id=? AND status='open'").get(Number(activeId));
    if (byId) return byId;
  }
  return db.prepare("SELECT * FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get() || null;
}

function ensureCompanyHooks(db, opts = {}) {
  let registry = null;
  try {
    const ws = require('../company-workspace');
    registry = ws.readRegistry();
    const active = ws.getActiveCompany();
    if (opts.company_name && active) {
      try {
        ws.updateCompanyMeta(active.id, { name: opts.company_name });
      } catch (_) { /* registry update optional when default-only */ }
    }
  } catch (_) {
    registry = null;
  }

  const name = String(opts.company_name || getSetting(db, 'company_name') || '').trim();
  if (name) {
    setSetting(db, 'company_name', name);
    if (!getSetting(db, 'company_legal_name')) {
      setSetting(db, 'company_legal_name', name);
    }
  }
  return {
    company_name: getSetting(db, 'company_name'),
    registry_ok: !!(registry && Array.isArray(registry.companies) && registry.companies.length),
    active_company_id: registry?.activeCompanyId || null,
  };
}

function ensureFiscalYear(db, opts = {}) {
  let fy = currentOpenFiscalYear(db);
  if (fy) return { fiscal_year: fy, created: false };

  const start = opts.start_date || (todayJalali().slice(0, 4) + '/01/01');
  const label = opts.fiscal_label || ('سال مالی ' + start.slice(0, 4));
  const result = db.prepare(`
    INSERT INTO fiscal_years (label, start_date, status, created_by)
    VALUES (?, ?, 'open', ?)
  `).run(label, start, opts.created_by || null);
  setSetting(db, 'active_fiscal_year_id', String(result.lastInsertRowid));
  fy = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(result.lastInsertRowid);
  return { fiscal_year: fy, created: true };
}

function ensureDefaultWarehouse(db, opts = {}) {
  const existing = db.prepare(`
    SELECT * FROM warehouses
    WHERE COALESCE(active,1)=1
    ORDER BY COALESCE(is_default,0) DESC, id ASC
    LIMIT 1
  `).get();
  if (existing) {
    if (!existing.is_default) {
      try {
        db.prepare('UPDATE warehouses SET is_default=1 WHERE id=?').run(existing.id);
      } catch (_) { /* older schema without is_default */ }
    }
    // Clear intentional wipe flag so future boots keep a warehouse
    try {
      db.prepare("DELETE FROM settings WHERE key='warehouses_user_cleared'").run();
    } catch (_) { /* ignore */ }
    return { warehouse: existing, created: false };
  }

  const name = String(opts.warehouse_name || 'انبار اصلی').trim() || 'انبار اصلی';
  const code = String(opts.warehouse_code || 'WH-MAIN').trim() || 'WH-MAIN';
  const result = db.prepare(`
    INSERT INTO warehouses (name, address, code, entity, warehouse_type, is_default, active)
    VALUES (?, '', ?, 'distribution_office', 'finished_goods', 1, 1)
  `).run(name, code);
  try {
    db.prepare("DELETE FROM settings WHERE key='warehouses_user_cleared'").run();
  } catch (_) { /* ignore */ }
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(result.lastInsertRowid);
  return { warehouse, created: true };
}

function ensureDefaultCashBox(db, opts = {}) {
  const existing = db.prepare(`
    SELECT * FROM cash_boxes
    WHERE COALESCE(active,1)=1
    ORDER BY id ASC
    LIMIT 1
  `).get();
  if (existing) return { cash_box: existing, created: false };

  const name = String(opts.cash_box_name || 'صندوق اصلی').trim() || 'صندوق اصلی';
  const result = db.prepare(`
    INSERT INTO cash_boxes (name, custodian, is_petty_cash, currency, is_foreign)
    VALUES (?, '', 0, 'IRR', 0)
  `).run(name);
  let box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
  try {
    const { allocTafsili } = require('../coa-map');
    const cc = allocTafsili(db, 'cashbox', name);
    if (cc) {
      db.prepare('UPDATE cash_boxes SET coa_code=? WHERE id=?').run(cc, box.id);
      box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(box.id);
    }
  } catch (_) { /* tafsili optional during onboarding */ }
  try {
    syncCashBoxAccount(db, box);
    box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(box.id);
  } catch (_) { /* ledger sync optional */ }
  return { cash_box: box, created: true };
}

function getChecklist(db) {
  let registryOk = false;
  try {
    const ws = require('../company-workspace');
    const list = ws.listCompanies();
    registryOk = Array.isArray(list.companies) && list.companies.length > 0;
  } catch (_) {
    registryOk = false;
  }

  const companyName = String(getSetting(db, 'company_name') || '').trim();
  const fy = currentOpenFiscalYear(db);
  const coaCount = db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get()?.c || 0;
  const warehouseCount = db.prepare(
    'SELECT COUNT(*) c FROM warehouses WHERE COALESCE(active,1)=1'
  ).get()?.c || 0;
  const cashBoxCount = db.prepare(
    'SELECT COUNT(*) c FROM cash_boxes WHERE COALESCE(active,1)=1'
  ).get()?.c || 0;
  const usersCount = db.prepare(
    'SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1'
  ).get()?.c || 0;

  const flags = {
    company: !!companyName || registryOk,
    fiscal_year: !!fy,
    coa: coaCount > 0,
    warehouse: warehouseCount > 0,
    cash_box: cashBoxCount > 0,
    users: usersCount > 0,
  };

  return {
    ...flags,
    ready: !!(flags.company && flags.fiscal_year && flags.coa && flags.warehouse && flags.users),
    details: {
      company_name: companyName || null,
      fiscal_year: fy ? { id: fy.id, label: fy.label, start_date: fy.start_date, status: fy.status } : null,
      counts: {
        coa: coaCount,
        warehouses: warehouseCount,
        cash_boxes: cashBoxCount,
        users: usersCount,
      },
      registry_ok: registryOk,
    },
  };
}

/**
 * Ensure onboarding foundations for the active company DB.
 * Does not create a second company workspace unless caller uses /api/companies.
 */
function bootstrapWorkspace(db, opts = {}) {
  const created = {
    fiscal_year: false,
    warehouse: false,
    cash_box: false,
  };

  const run = () => {
    const company = ensureCompanyHooks(db, opts);
    const fy = ensureFiscalYear(db, opts);
    created.fiscal_year = fy.created;
    const wh = ensureDefaultWarehouse(db, opts);
    created.warehouse = wh.created;
    const box = ensureDefaultCashBox(db, opts);
    created.cash_box = box.created;
    return {
      ok: true,
      created,
      company,
      fiscal_year: fy.fiscal_year,
      warehouse: wh.warehouse,
      cash_box: box.cash_box,
      checklist: getChecklist(db),
    };
  };

  if (typeof db.transaction === 'function') {
    return db.transaction(run)();
  }
  return run();
}

function rowField(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

function validatePartyRow(row, index) {
  const errors = [];
  const name = rowField(row, 'full_name', 'biz', 'name', 'company_name');
  const phone = rowField(row, 'phone', 'mobile');
  if (!name) errors.push({ row: index, field: 'full_name', message: 'نام طرف‌حساب الزامی است' });
  if (!phone) errors.push({ row: index, field: 'phone', message: 'تلفن الزامی است' });
  else if (!/^[\d+\-\s()]{7,20}$/.test(phone)) {
    errors.push({ row: index, field: 'phone', message: 'فرمت تلفن نامعتبر است' });
  }
  return errors;
}

function validateProductRow(row, index) {
  const errors = [];
  const name = rowField(row, 'name', 'title', 'نام');
  const code = rowField(row, 'code', 'sku', 'کد');
  if (!name && !code) {
    errors.push({ row: index, field: 'name', message: 'نام یا کد کالا الزامی است' });
  }
  const priceRaw = row.price_rial != null ? row.price_rial : (row.price != null ? row.price : row['قیمت']);
  if (priceRaw != null && priceRaw !== '' && Number.isNaN(Number(priceRaw))) {
    errors.push({ row: index, field: 'price', message: 'قیمت باید عدد باشد' });
  }
  if (priceRaw != null && priceRaw !== '' && Number(priceRaw) < 0) {
    errors.push({ row: index, field: 'price', message: 'قیمت نمی‌تواند منفی باشد' });
  }
  return errors;
}

/**
 * Validate import rows without writing. type: parties | products
 */
function dryRunImport(payload = {}) {
  const type = String(payload.type || '').toLowerCase();
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  if (!['parties', 'products'].includes(type)) {
    return {
      ok: false,
      errors: [{ row: null, field: 'type', message: 'type باید parties یا products باشد' }],
      preview_count: 0,
    };
  }
  if (!rows) {
    return {
      ok: false,
      errors: [{ row: null, field: 'rows', message: 'آرایه rows الزامی است' }],
      preview_count: 0,
    };
  }

  const errors = [];
  let valid = 0;
  rows.forEach((row, i) => {
    const index = i + 1;
    if (!row || typeof row !== 'object') {
      errors.push({ row: index, field: null, message: 'ردیف نامعتبر است' });
      return;
    }
    const rowErrors = type === 'parties' ? validatePartyRow(row, index) : validateProductRow(row, index);
    if (rowErrors.length) errors.push(...rowErrors);
    else valid += 1;
  });

  return {
    ok: errors.length === 0,
    errors,
    preview_count: valid,
    type,
    total_rows: rows.length,
  };
}

module.exports = {
  getChecklist,
  bootstrapWorkspace,
  dryRunImport,
  ensureFiscalYear,
  ensureDefaultWarehouse,
  ensureDefaultCashBox,
  ensureCompanyHooks,
  currentOpenFiscalYear,
};
