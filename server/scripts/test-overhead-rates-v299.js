'use strict';
/**
 * Overhead rate formulas + pricing markup (SW v299)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-overhead-rates-v299-dummy-key-32ch';

const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const oh = require('../lib/production/overhead');
const pricing = require('../routes/pricing-rules');
const adv = require('../lib/production/bom-advanced');

console.log('\n══ Overhead rates + pricing v299 ══\n');

ok('normalizeDriver labor_rial alias', oh.normalizeDriver('labor_rial') === 'direct_labor_rial');
ok('normalizeDriver hours alias', oh.normalizeDriver('hours') === 'direct_labor_hours');
throws('normalizeDriver junk', () => oh.normalizeDriver('pieces'), 'E_BAD_DRIVER');
ok('validatePeriod 1405/7 → 1405/07', oh.validatePeriodLabel('1405/7') === '1405/07');
throws('validatePeriod bad', () => oh.validatePeriodLabel('1405-07'), 'E_PERIOD_FORMAT');

const fromBudget = oh.computePredeterminedRates({
  budget_fixed_oh_rial: 200_000_000,
  budget_var_oh_rial: 100_000_000,
  budget_driver_qty: 1000,
});
eq('IAS2 fixed rate 200M/1000', fromBudget.fixed_rate_rial, 200_000, 0);
eq('IAS2 var rate 100M/1000', fromBudget.var_rate_rial, 100_000, 0);
eq('IAS2 total 300k', fromBudget.total_rate_rial, 300_000, 0);
ok('from_budget true', fromBudget.from_budget === true);

const direct = oh.computePredeterminedRates({ total_rate_rial: 9000 });
eq('direct total copies to fixed', direct.fixed_rate_rial, 9000, 0);
eq('direct var 0', direct.var_rate_rial, 0, 0);
ok('from_budget false', direct.from_budget === false);

const split = oh.computePredeterminedRates({ fixed_rate_rial: 4000, var_rate_rial: 5000 });
eq('split total = fixed+var', split.total_rate_rial, 9000, 0);

throws('negative budget', () => oh.computePredeterminedRates({ budget_fixed_oh_rial: -1, budget_driver_qty: 1 }), 'E_NEGATIVE_RATE');
ok('looksLikePool 300M labor', oh.looksLikePoolNotRate('direct_labor_rial', 300_000_000) === true);
ok('looksLikePool 9000 material false', oh.looksLikePoolNotRate('material_rial', 9000) === false);

const dq = oh.computeDriverQty(null, {
  driver: 'labor_rial', qtyStarted: 10, laborRial: 2_000_000, matRial: 0,
});
eq('alias driver qty labor/1e6', dq, 2, 1e-9);

const sew = { overhead_driver: 'labor_rial', seq: 30, setup_minutes: 0, run_minutes_per_unit: 0, crew_size: 1 };
const dq2 = adv.stageDriverQty(null, sew, { driver: 'labor_rial' }, { qty: 1, labor: 55_389_600, material: 0 });
eq('stageDriverQty alias', dq2, 55_389_600 / 1e6, 1e-9);
eq('applied OH = rate × driver qty', Math.round(350000 * dq), 700_000, 0);

ok('parseMarkup 25', pricing.parseMarkupPct(25, 'عمده') === 25);
throws('markup -1', () => pricing.parseMarkupPct(-1, 'عمده'), 'E_MARKUP_RANGE');
throws('markup 501', () => pricing.parseMarkupPct(501, 'تک'), 'E_MARKUP_RANGE');

const p = pricing.pricesFromCost(1_000_000, { wholesale_markup_pct: 25, retail_markup_pct: 35 });
eq('wholesale 1.25×', p.wholesale, 1_250_000, 0);
eq('retail 1.35×', p.retail, 1_350_000, 0);
eq('cost echo', p.cost_rial, 1_000_000, 0);

eq('absorb 80% of 1000×10', oh.appliedOverheadRial({ total_rate_rial: 1000, absorb_pct: 80 }, 10), 8000, 0);
eq('absorb default 100%', oh.appliedOverheadRial({ total_rate_rial: 1000 }, 10), 10000, 0);
eq('labor absorb 50%', oh.appliedMonthlyLaborRial({ monthly_labor_rate_rial: 100, absorb_pct: 50 }, 3), 150, 0);
throws('absorb 101', () => oh.clampAbsorbPct(101), 'E_ABSORB_PCT');
ok('computeRates keeps absorb', oh.computePredeterminedRates({ total_rate_rial: 1, absorb_pct: 80 }).absorb_pct === 80);

const cut = oh.estimateCuttingCapacity({
  wage_rial: 300_000_000, days: 22, hours_per_day: 8, efficiency_pct: 80, minutes_per_unit: 1.2, setup_minutes_per_day: 30,
});
eq('cut hours 22×8×0.8', cut.available_hours, 140.8, 1e-9);
eq('cut qty ≈6490', cut.normal_qty, 6490, 1);
eq('cut labor ≈46k rial/pc', cut.monthly_labor_rate_rial, Math.round(300_000_000 / cut.normal_qty), 0);
ok('absorb 0 persists', oh.computePredeterminedRates({ total_rate_rial: 1, absorb_pct: 0 }).absorb_pct === 0);
ok('cut per-piece < wage', cut.monthly_labor_rate_rial > 0 && cut.monthly_labor_rate_rial < 300_000_000);

try {
  const { db, cleanup } = freshDb();
  const PERIOD = '1405/07';
  const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
  ok('seed CC-10', !!cc10);
  db.prepare(`
    INSERT INTO cost_center_rates (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial, status)
    VALUES (?,?, 'labor_rial', 350000, 350000, 'active')
  `).run(cc10, PERIOD);
  const rate = oh.getOverheadRate(db, cc10, PERIOD);
  ok('getOverheadRate coerces labor_rial', rate.driver === 'direct_labor_rial');
  cleanup();
} catch (e) {
  if (/bindings|better-sqlite3/i.test(String(e.message || e))) {
    ok('sqlite ABI skip (Node24 host) — run on Iran', true);
  } else {
    ok('sqlite rate lookup', false, e.stack || e.message);
  }
}

summary();
