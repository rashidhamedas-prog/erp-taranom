const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

/* ============================================================
   LEGACY PRODUCTION RUNS (production_runs) — F07 gate
   This module predates the advanced production module (production_orders +
   inventory_ledger + PRD-xx journal entries). It writes products.stock /
   warehouse_stock directly (now: ledger rows only): no journal entry, no WIP, no
   production-period lock. Once the advanced module is installed it must not
   create new data, otherwise stock exists that the ledger never saw.
   New writes are therefore refused with 409 E_LEGACY_PRODUCTION_DISABLED
   unless an admin sets production_legacy_runs_enabled=1 (escape hatch for
   replaying an old device outbox or finishing a half-entered month).
   Reads stay open so historical runs remain visible.
   Migrating the historical rows through the inventory ledger is a separate
   task — see docs/architecture/PROD-ACC-PA00-DISCOVERY.md (F07).
============================================================ */
const LEGACY_FLAG_KEY = 'production_legacy_runs_enabled';

function setting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row && row.value != null ? String(row.value) : fallback;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function advancedProductionAvailable(db) {
  if (setting(db, 'production_module_enabled', '1') === '0') return false;
  return tableExists(db, 'production_orders') && tableExists(db, 'production_period_close');
}

function legacyRunsEnabled(db) {
  return setting(db, LEGACY_FLAG_KEY, '0') === '1';
}

function legacyBlocked(db) {
  return advancedProductionAvailable(db) && !legacyRunsEnabled(db);
}

function legacyWriteGate(req, res, next) {
  if (!legacyBlocked(getDB())) return next();
  return res.status(409).json({
    code: 'E_LEGACY_PRODUCTION_DISABLED',
    error: 'ثبت/ابطال «اجرای تولید» قدیمی غیرفعال است — این مسیر موجودی را بدون سند حسابداری و بدون قفل دوره تغییر می‌دهد. از «سفارش‌های تولید» استفاده کنید.',
    hint: 'در صورت نیاز موقت، admin می‌تواند از تنظیمات سربار تولید گزینهٔ «اجرای تولید قدیمی» را فعال کند.',
  });
}

function jalaliPeriod(date) {
  const parts = String(date || '').split('/');
  if (parts.length < 2) return '';
  return `${parts[0]}/${parts[1].padStart(2, '0')}`;
}

/** Even with the escape hatch on, a legacy run may not land in a closed production period. */
function assertLegacyPeriodOpen(db, date) {
  const period = jalaliPeriod(date);
  if (!period || !tableExists(db, 'production_period_close')) return;
  const closed = db.prepare(
    "SELECT 1 FROM production_period_close WHERE period_label=? AND status='closed'"
  ).get(period);
  if (closed) {
    const e = new Error('دورهٔ تولید بسته است — اجرای تولید قدیمی در این ماه مجاز نیست');
    e.code = 'E_PERIOD_CLOSED';
    e.status = 409;
    throw e;
  }
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT r.*, p.name as product_name, p.code as product_code, p.price as product_price, p.cost as product_cost,
      w.name as warehouse_name, u.name as recorder
    FROM production_runs r
    LEFT JOIN products p ON r.product_id=p.id
    LEFT JOIN warehouses w ON r.warehouse_id=w.id
    LEFT JOIN users u ON r.created_by=u.id
    ORDER BY r.created_at DESC LIMIT 300
  `).all();
  rows.forEach(r => {
    r.total_cost = (r.material_cost || 0) + (r.labor_cost || 0) + (r.overhead_cost || 0) + (r.packaging_cost || 0) + (r.waste_cost || 0);
    r.unit_cost = r.qty_produced > 0 ? r.total_cost / r.qty_produced : 0;
    r.efficiency = (r.qty_produced + (r.waste_qty || 0)) > 0 ? r.qty_produced / (r.qty_produced + (r.waste_qty || 0)) : 1;
    r.margin = (r.product_price || 0) - r.unit_cost;
  });
  res.json(rows);
});

const OVERHEAD_KEYS = ['overhead_method', 'overhead_fixed_rate', 'overhead_period_production_qty', 'overhead_auto_suggest'];
const { PRODUCTION_SETTINGS } = require('../lib/production/schema');
const PRO_SETTINGS_KEYS = [
  ...OVERHEAD_KEYS,
  ...Object.keys(PRODUCTION_SETTINGS),
  'production_wh_wip_id',
  'pricing_margin_percent',
];

function readConfig(db) {
  const obj = {
    overhead_method: 'tag', overhead_fixed_rate: '0',
    overhead_period_production_qty: '0', overhead_auto_suggest: '0',
    ...PRODUCTION_SETTINGS,
  };
  db.prepare(`SELECT key,value FROM settings WHERE key IN (${PRO_SETTINGS_KEYS.map(() => '?').join(',')})`)
    .all(...PRO_SETTINGS_KEYS).forEach(r => { obj[r.key] = r.value; });
  obj.legacy_runs_enabled = legacyRunsEnabled(db) ? '1' : '0';
  obj.advanced_available = advancedProductionAvailable(db);
  obj.legacy_blocked = legacyBlocked(db);
  return obj;
}

router.get('/config', auth, adminOrAccounting, (req, res) => {
  res.json(readConfig(getDB()));
});

const isOn = v => v === '1' || v === 1 || v === true;

const WH_KEYS = new Set([
  'production_wh_raw_id', 'production_wh_fg_id', 'production_wh_wip_id',
  'production_wh_sub_id', 'production_wh_scrap_id', 'production_wh_dist_id',
  'production_wh_remnant_id',
]);
const BOOL_KEYS = new Set([
  'production_auto_post_je', 'production_backflush_on_receipt',
  'production_allow_negative_stock', 'production_module_enabled',
  'production_period_auto_open', 'overhead_auto_suggest',
  'production_shared_cut',
]);
const NUM_KEYS = new Set([
  'overhead_fixed_rate', 'overhead_period_production_qty',
  'production_variance_threshold_pct', 'production_normal_waste_default_pct',
  'production_cost_deviation_alert_pct', 'production_cost_deviation_pct',
  'production_oh_bootstrap_months', 'production_mrp_horizon_days',
  'production_variance_reason_threshold_pct', 'production_margin_percent',
  'pricing_margin_percent',
  'production_roll_balance_tolerance_m', 'production_remnant_min_m', 'production_remnant_ratio',
]);

router.put('/config', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const body = req.body || {};
  if (body.legacy_runs_enabled != null && isOn(body.legacy_runs_enabled) !== legacyRunsEnabled(db) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'فعال/غیرفعال کردن اجرای تولید قدیمی فقط با نقش admin است', code: 'E_FORBIDDEN' });
  }
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if (body.overhead_method) stmt.run('overhead_method', body.overhead_method);
  if (body.legacy_runs_enabled != null) {
    stmt.run(LEGACY_FLAG_KEY, isOn(body.legacy_runs_enabled) ? '1' : '0');
    audit(req.user.id, 'update', 'settings', null,
      `اجرای تولید قدیمی: ${isOn(body.legacy_runs_enabled) ? 'فعال' : 'غیرفعال'}`);
  }
  for (const key of PRO_SETTINGS_KEYS) {
    if (body[key] == null || key === 'overhead_method') continue;
    if (WH_KEYS.has(key)) {
      const id = parseInt(body[key], 10);
      if (body[key] === '' || body[key] === '0') { stmt.run(key, ''); continue; }
      if (!Number.isFinite(id) || id <= 0) continue;
      const wh = db.prepare('SELECT id FROM warehouses WHERE id=? AND COALESCE(active,1)=1').get(id);
      if (!wh) return res.status(400).json({ error: `انبار تنظیم ${key} نامعتبر است`, code: 'E_WH' });
      stmt.run(key, String(id));
      continue;
    }
    if (BOOL_KEYS.has(key)) {
      stmt.run(key, isOn(body[key]) ? '1' : '0');
      continue;
    }
    if (NUM_KEYS.has(key)) {
      stmt.run(key, String(Number(body[key]) || 0));
      continue;
    }
    if (key === 'production_default_analysis') {
      const a = String(body[key] || 'fixed');
      if (!['fixed', 'variable', 'fixed_adv', 'variable_adv'].includes(a)) continue;
      stmt.run(key, a);
      continue;
    }
    stmt.run(key, String(body[key]));
  }
  // Keep alert/pct aliases aligned
  if (body.production_cost_deviation_alert_pct != null && body.production_cost_deviation_pct == null) {
    stmt.run('production_cost_deviation_pct', String(Number(body.production_cost_deviation_alert_pct) || 15));
  }
  if (body.production_margin_percent != null && body.pricing_margin_percent == null) {
    stmt.run('pricing_margin_percent', String(Number(body.production_margin_percent) || 0));
  }
  audit(req.user.id, 'update', 'settings', null, 'تنظیمات حرفه‌ای تولید');
  res.json(readConfig(db));
});

router.get('/overhead-suggest', auth, adminOrAccounting, (req, res) => {
  const qty = parseInt(req.query.qty) || 1;
  const from = req.query.from || '';
  const to = req.query.to || '';
  const db = getDB();

  const where = ["is_overhead=1", "COALESCE(status,'posted')<>'reversed'"], params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const tagged = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE ${where.join(' AND ')}`).get(...params).s;

  const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const method = getSetting('overhead_method') || 'tag';
  const fixedRate = parseFloat(getSetting('overhead_fixed_rate')) || 0;

  let periodQty = parseInt(getSetting('overhead_period_production_qty')) || 0;
  if (!periodQty) {
    const prodWhere = [], prodParams = [];
    if (from) { prodWhere.push('date>=?'); prodParams.push(from); }
    if (to) { prodWhere.push('date<=?'); prodParams.push(to); }
    const prodSql = prodWhere.length
      ? `SELECT COALESCE(SUM(qty_produced),0) s FROM production_runs WHERE COALESCE(voided,0)=0 AND ${prodWhere.join(' AND ')}`
      : 'SELECT COALESCE(SUM(qty_produced),0) s FROM production_runs WHERE COALESCE(voided,0)=0';
    periodQty = db.prepare(prodSql).get(...prodParams).s || 0;
  }

  let pool = 0;
  if (method === 'tag' || method === 'both') pool += tagged;
  if (method === 'fixed' || method === 'both') pool += fixedRate * periodQty;

  const perUnit = periodQty > 0 ? pool / periodQty : (qty > 0 ? pool / qty : 0);
  const suggested = Math.round(perUnit * qty);

  res.json({
    method, tagged_overhead: tagged, fixed_rate: fixedRate, period_production_qty: periodQty,
    overhead_pool: pool, per_unit: Math.round(perUnit), suggested_for_qty: suggested, qty
  });
});

router.post('/', auth, adminOrAccounting, legacyWriteGate, (req, res) => {
  const {
    product_id, qty_produced, material_cost, labor_cost, overhead_cost, packaging_cost,
    waste_qty, waste_cost, date, note, update_stock, update_cost, warehouse_id
  } = req.body;
  const qty = parseInt(qty_produced);
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'کالا و تعداد تولیدی معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });

  const matC = parseFloat(material_cost) || 0, labC = parseFloat(labor_cost) || 0, ovC = parseFloat(overhead_cost) || 0,
        pkgC = parseFloat(packaging_cost) || 0, wsC = parseFloat(waste_cost) || 0, wsQ = parseInt(waste_qty) || 0;
  const totalCost = matC + labC + ovC + pkgC + wsC;
  const unitCost = totalCost / qty;
  const whId = warehouse_id || product.warehouse_id || null;
  const runDate = date || todayJalali();
  try {
    assertLegacyPeriodOpen(db, runDate);
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message, code: e.code });
  }

  const doStock = !!update_stock, doCost = !!update_cost;
  let apparelLines = [];
  try {
    if (doStock) {
      apparelLines = require('../lib/inventory/apparel-lines').resolveApparelLines(db, {
        productId: product_id, qty,
        variantId: req.body.variant_id, variantLines: req.body.variant_lines,
      });
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_VARIANT_REQUIRED' });
  }

  let runId;
  try {
    runId = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO production_runs (product_id,qty_produced,material_cost,labor_cost,overhead_cost,packaging_cost,waste_qty,waste_cost,date,note,stock_added,cost_updated,previous_cost,warehouse_id,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(product_id, qty, matC, labC, ovC, pkgC, wsQ, wsC, runDate, note || '',
            doStock ? 1 : 0, doCost ? 1 : 0, product.cost, whId, req.user.id);
      const id = result.lastInsertRowid;
      if (doStock) {
        // Stock single-source: the receipt is ledger rows (one per colour×size line, or one for a plain
        // product) — products.stock / warehouse_stock are derived from them, never written here.
        const { postInventoryMovement } = require('../lib/inventory/ledger');
        const unitRial = Math.round(unitCost) || undefined;
        const recvLines = apparelLines.length ? apparelLines : [{ variantId: null, qty }];
        for (const ln of recvLines) {
          postInventoryMovement(db, {
            eventType: 'production_receipt',
            productId: product_id,
            warehouseId: whId || null,
            qtyIn: Number(ln.qty) || 0,
            variantId: ln.variantId || undefined,
            unitCostRial: unitRial,
            sourceType: 'production_run',
            sourceId: id,
            date: runDate,
            note: `تولید داخلی (اجرای تولید #${id})`,
            createdBy: req.user.id,
            updateAvg: false,
          });
        }
        if (whId) {
          db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(whId, product_id);
        }
        require('../lib/inventory/apparel-lines').postApparelLines(db, {
          productId: product_id, warehouseId: whId, lines: apparelLines,
          docType: 'production_run', docId: id, userId: req.user.id,
          note: `تولید داخلی #${id}`, sign: 1, allowNegative: true,
        });
        require('../lib/inventory/apparel-lines').saveDocVariantLines(
          db, 'production_runs', id, apparelLines
        );
      }
      if (doCost) {
        db.prepare('UPDATE products SET cost=? WHERE id=?').run(Math.round(unitCost), product_id);
      }
      return id;
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_PRODUCTION' });
  }
  audit(req.user.id, 'create', 'production_run', runId, `ثبت اجرای تولید: ${qty} عدد ${product.name} — بهای واحد ${Math.round(unitCost)}`);
  res.json({ id: runId, ok: true, unit_cost: unitCost, total_cost: totalCost });
});

router.delete('/:id', auth, adminOrAccounting, legacyWriteGate, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM production_runs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.voided) return res.status(409).json({ error: 'این اجرا قبلاً ابطال شده است' });
  try {
    assertLegacyPeriodOpen(db, row.date);
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message, code: e.code });
  }
  try {
    db.transaction(() => {
      if (row.stock_added) {
        require('../lib/inventory/apparel-lines').reverseApparelDoc(db, {
          docType: 'production_run', docId: row.id, userId: req.user.id,
          note: `ابطال اجرای تولید #${row.id}`,
        });
        // Stock single-source: void = reversal of the run's ledger rows (caches re-derive).
        // Legacy runs from before this change have no ledger rows → nothing to take back.
        require('../lib/sales-document').reverseStockBySource(db, 'production_run', row.id, {
          createdBy: req.user.id, date: todayJalali(), note: `ابطال اجرای تولید #${row.id}`,
        });
      }
      if (row.cost_updated && row.previous_cost != null) {
        db.prepare('UPDATE products SET cost=? WHERE id=?').run(row.previous_cost, row.product_id);
      }
      db.prepare('UPDATE production_runs SET voided=1, stock_added=0 WHERE id=?').run(row.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_PRODUCTION' });
  }
  audit(req.user.id, 'void', 'production_run', req.params.id, `ابطال اجرای تولید #${req.params.id}`);
  res.json({ ok: true, voided: true });
});

module.exports = router;
// F07 gate internals — exported for server/scripts/test-prod-acc-legacy-gate-v279.js
module.exports._legacy = {
  LEGACY_FLAG_KEY,
  advancedProductionAvailable,
  legacyRunsEnabled,
  legacyBlocked,
  legacyWriteGate,
  assertLegacyPeriodOpen,
  jalaliPeriod,
};
