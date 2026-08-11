'use strict';
/**
 * P0 — ۱۵ تست schema ماژول تولید (docs/Production/test-cases.md §2)
 */
const path = require('path');
const fs = require('fs');
const { ok, freshDb, summary } = require('./lib/test-harness');
const { PROD_TABLES, PROD_SEQUENCES, PRODUCTION_SETTINGS } = require('../lib/production/schema');
const { SYNCABLE_TABLES } = require('../sync/tables');
const { acct, LEGACY } = require('../lib/coa-map');

console.log('\n══ P0 Schema Tests ══\n');

const EXPECTED_PREFIX = [
  'users', 'settings', 'chart_of_accounts', 'customer_groups',
  'person_categories', 'cost_centers', 'warehouses', 'banks', 'cash_boxes', 'check_categories',
];

const EXPECTED_INDEXES = [
  'ux_bom_code', 'ux_bom_prod_ver', 'ix_bom_product_status',
  'ix_bomline_bom', 'ix_bomline_comp', 'ux_bomop', 'ix_bomout', 'ix_bomlog',
  'ux_ccrate', 'ux_ohw',
  'ux_po_no', 'ix_po_status', 'ix_po_prod', 'ix_po_period', 'ix_po_so',
  'ux_pos', 'ix_pos_status',
  'ix_mi_order', 'ix_mi_prod', 'ix_mi_je',
  'ix_lab_order', 'ix_lab_person', 'ix_lab_cc',
  'ix_oh_order', 'ix_oh_cc',
  'ix_waste_order', 'ix_waste_cc',
  'ix_pr_order', 'ix_pr_prod',
  'ix_sub_order', 'ix_var_period', 'ux_ppc',
  'ux_est_code', 'ix_estline', 'ix_mrpreq', 'ix_resv', 'ix_pevt', 'ix_ucc_user',
  'ix_rpt_po_period', 'ix_rpt_pr_period', 'ix_rpt_mi_period', 'ix_rpt_ws_period', 'ix_rpt_pos_cc',
];

const EXPECTED_TRIGGERS = [
  'trg_bom_updated', 'trg_po_updated', 'trg_bom_single_default',
  'trg_bomline_lock_active', 'trg_bom_no_self', 'trg_mi_period_lock',
];

const PROD_COA_KEYS = [
  'coa_raw_materials', 'coa_packaging_materials', 'coa_wip', 'coa_finished_goods',
  'coa_scrap_inventory', 'coa_subcontract_inventory',
  'coa_labor_control', 'coa_overhead_control', 'coa_overhead_applied',
  'coa_var_material_price', 'coa_var_material_qty',
  'coa_var_labor_rate', 'coa_var_labor_eff',
  'coa_var_oh_budget', 'coa_var_oh_volume',
  'coa_abnormal_waste', 'coa_rework_cost', 'coa_subcontract_fee',
  'coa_cogs', 'coa_payroll_payable',
];

const PRODUCTION_ACCOUNT_CODES = [
  '1110', '1111', '1112', '1113', '1114',
  '5201', '5202', '5203',
  '5210', '5211', '5212', '5213', '5214', '5215',
  '5221', '5222', '5230',
];

// ── TS-01: boot empty DB ──
let ctx;
try {
  ctx = freshDb();
  ok('TS-01 بوت روی DB خالی', !!ctx.db);
} catch (e) {
  ok('TS-01 بوت روی DB خالی', false, e.message);
  summary('P0 Schema');
}

const { db, dbMod, cleanup } = ctx;

// ── TS-02: re-init on existing (same file) ──
try {
  dbMod.initDB();
  ok('TS-02 بوت روی DB موجود', true);
} catch (e) {
  ok('TS-02 بوت روی DB موجود', false, e.message);
}

// ── TS-03: idempotent third pass ──
try {
  dbMod.initDB();
  ok('TS-03 بوت دوباره (idempotent)', true);
} catch (e) {
  ok('TS-03 بوت دوباره (idempotent)', false, e.message);
}

// ── TS-04: 24 production tables ──
{
  const missing = PROD_TABLES.filter(t =>
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  ok('TS-04 جداول جدید (۲۴)', missing.length === 0, missing.join(', '));
}

// ── TS-05: indexes ──
{
  const idx = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL").all().map(r => r.name)
  );
  const missing = EXPECTED_INDEXES.filter(n => !idx.has(n));
  ok('TS-05 ایندکس‌ها', missing.length === 0, missing.slice(0, 8).join(', '));
}

// ── TS-06: triggers ──
{
  const trg = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name)
  );
  const missing = EXPECTED_TRIGGERS.filter(n => !trg.has(n));
  ok('TS-06 Trigger ها', missing.length === 0 && trg.size >= 6,
    missing.join(', ') || `count=${trg.size}`);
}

// ── TS-07: no REAL money columns ──
{
  const money = db.prepare(`
    SELECT m.name AS tbl, p.name AS col, p.type AS type
    FROM sqlite_master m, pragma_table_info(m.name) p
    WHERE m.type='table' AND p.name LIKE '%_rial' AND upper(p.type) <> 'INTEGER'
  `).all();
  ok('TS-07 هیچ ستون پولی REAL نیست', money.length === 0,
    money.map(r => `${r.tbl}.${r.col}=${r.type}`).join(', '));
}

// ── TS-08: sync append-only ──
{
  const actual = SYNCABLE_TABLES.map(t => t.name);
  ok('TS-08a ترتیب قبلی دست‌نخورده',
    EXPECTED_PREFIX.every((n, i) => actual[i] === n));
  const prodStart = actual.indexOf('bom_headers');
  const prodEnd = actual.indexOf('production_reservations');
  const invStart = actual.indexOf('inventory_ledger');
  ok('TS-08b جداول تولید در انتها',
    prodStart > 0 && prodEnd > prodStart
    && actual.slice(prodStart, prodEnd + 1).includes('mrp_runs')
    && (invStart < 0 || invStart === prodEnd + 1));
}

// ── TS-09: sequences ──
{
  const keys = PROD_SEQUENCES.map(s => s.key);
  const missing = keys.filter(k => !db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get(k));
  ok('TS-09 PROD_SEQUENCES (۱۱)', missing.length === 0, missing.join(', '));
}

// ── TS-10: 7 cost centers ──
{
  const codes = ['CC-10', 'CC-20', 'CC-30', 'CC-40', 'CC-50', 'CC-60', 'CC-90'];
  const found = codes.filter(c => db.prepare('SELECT 1 FROM cost_centers WHERE code=?').get(c));
  ok('TS-10 Seed مراکز (۷)', found.length === 7, `found=${found.length}`);
}

// ── TS-11: 5 warehouses ──
{
  const codes = ['WH-RAW', 'WH-FG', 'WH-DIST-FG', 'WH-SUB', 'WH-SCRAP'];
  const found = codes.filter(c => db.prepare('SELECT 1 FROM warehouses WHERE code=?').get(c));
  ok('TS-11 Seed انبارها (۵)', found.length === 5, `found=${found.length}`);
}

// ── TS-12: 18 production accounts (17 listed + parent is ok; require the 17 leaf codes) ──
{
  // Spec lists 18 accounts including control accounts — count codes from PRODUCTION_ACCOUNTS
  // We seeded 17 leaf + 5200 parent. TS expects 18 production accounts in chart.
  const codes = [
    '1110', '1111', '1112', '1113', '1114',
    '5201', '5202', '5203',
    '5210', '5211', '5212', '5213', '5214', '5215',
    '5221', '5222', '5230', '5200',
  ];
  const found = codes.filter(c => db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(c));
  ok('TS-12 Seed حساب‌ها (۱۸)', found.length === 18, `found=${found.length}`);
}

// ── TS-13: coa-map 20 keys ──
{
  let allOk = true;
  const bad = [];
  for (const key of PROD_COA_KEYS) {
    try {
      const a = acct(db, key);
      if (!a || !a.code) { allOk = false; bad.push(key); }
      if (!LEGACY[key]) { allOk = false; bad.push(key + '(no LEGACY)'); }
    } catch (e) {
      allOk = false;
      bad.push(key + ':' + e.message);
    }
  }
  ok('TS-13 coa-map ۲۰ کلید', allOk && PROD_COA_KEYS.length === 20, bad.join(', '));
}

// ── TS-14: 23 settings ──
{
  const keys = Object.keys(PRODUCTION_SETTINGS);
  const found = keys.filter(k => db.prepare('SELECT 1 FROM settings WHERE key=?').get(k));
  ok('TS-14 Settings (۲۳)', found.length === 23 && keys.length === 23,
    `expected 23 · found ${found.length} · defined ${keys.length}`);
}

// ── TS-15: views ──
{
  const views = ['v_wip_by_order', 'v_order_cost_summary', 'v_variance_summary'];
  const missing = views.filter(v =>
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?").get(v));
  let queryOk = true;
  if (!missing.length) {
    try {
      db.prepare('SELECT * FROM v_wip_by_order LIMIT 1').all();
      db.prepare('SELECT * FROM v_order_cost_summary LIMIT 1').all();
      db.prepare('SELECT * FROM v_variance_summary LIMIT 1').all();
    } catch (e) {
      queryOk = false;
      missing.push(e.message);
    }
  }
  ok('TS-15 VIEW ها', missing.length === 0 && queryOk, missing.join(', '));
}

cleanup();
summary('P0 Schema');
