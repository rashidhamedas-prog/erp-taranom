'use strict';
/**
 * Production go-live readiness (Week 1 ops checklist).
 * Read-only by default. Use --fix to fill empty production_wh_* from seeded warehouses.
 *
 *   node scripts/production-go-live-check.js
 *   node scripts/production-go-live-check.js --fix
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { getDB, initDB } = require('../db');

const FIX = process.argv.includes('--fix');

initDB();
const db = getDB();

const checks = [];
function add(code, ok, detail) {
  checks.push({ code, ok: !!ok, detail: detail || '' });
  const mark = ok ? '✅' : '🔴';
  console.log(`  ${mark} ${code}${detail ? ' — ' + detail : ''}`);
}

console.log('\n══ Production Go-Live Readiness ══\n');

const ccs = db.prepare(`
  SELECT code, name, is_stage, driver FROM cost_centers
  WHERE code LIKE 'CC-%' ORDER BY seq, code
`).all();
add('CC_SEED', ccs.length >= 7, `${ccs.length} مرکز (نیاز ≥۷)`);

const whs = db.prepare(`
  SELECT code, name, id FROM warehouses
  WHERE code IN ('WH-RAW','WH-FG','WH-SUB','WH-SCRAP','WH-DIST-FG')
`).all();
add('WH_SEED', whs.length >= 5, `${whs.length}/5 انبار تولید`);

const whKeys = [
  'production_wh_raw_id', 'production_wh_fg_id', 'production_wh_sub_id',
  'production_wh_scrap_id', 'production_wh_dist_id',
];
for (const k of whKeys) {
  let v = db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  if (FIX && !v) {
    const map = {
      production_wh_raw_id: 'WH-RAW',
      production_wh_fg_id: 'WH-FG',
      production_wh_sub_id: 'WH-SUB',
      production_wh_scrap_id: 'WH-SCRAP',
      production_wh_dist_id: 'WH-DIST-FG',
    };
    const id = db.prepare('SELECT id FROM warehouses WHERE code=?').get(map[k])?.id;
    if (id) {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, String(id));
      v = String(id);
    }
  }
  add(k.toUpperCase(), !!v && Number(v) > 0, v ? `id=${v}` : 'خالی');
}

const coaKeys = ['coa_wip', 'coa_finished_goods', 'coa_labor_control', 'coa_overhead_control', 'coa_overhead_applied'];
for (const k of coaKeys) {
  const v = db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  add(k.toUpperCase(), !!v, v || 'missing');
}

const mfg = db.prepare(`
  SELECT COUNT(*) c FROM products WHERE COALESCE(is_manufactured,0)=1 OR item_type='finished'
`).get()?.c || 0;
const raw = db.prepare(`
  SELECT COUNT(*) c FROM products WHERE item_type IN ('raw','packaging','material')
`).get()?.c || 0;
add('PRODUCTS_MFG', true, `${mfg} ساخته‌شده / ${raw} مواد (دستی علامت بزنید)`);

const boms = db.prepare(`SELECT COUNT(*) c FROM bom_headers WHERE status='active'`).get()?.c || 0;
add('BOM_ACTIVE', true, `${boms} فرمول فعال (هفته ۲)`);

const rates = db.prepare(`SELECT COUNT(*) c FROM cost_center_rates`).get()?.c || 0;
add('OH_RATES', true, `${rates} نرخ سربار (هفته ۱/۲)`);

const avgZero = db.prepare(`
  SELECT COUNT(*) c FROM products
  WHERE item_type IN ('raw','packaging','material')
    AND COALESCE(average_cost_rial,0)=0 AND COALESCE(stock,0)>0
`).get()?.c || 0;
add('AVG_COST', avgZero === 0, avgZero ? `${avgZero} ماده با موجودی و میانگین صفر` : 'OK');

const bad5210 = db.prepare(`
  SELECT COUNT(*) c FROM journal_lines WHERE account_code IN ('5210','5211')
`).get()?.c || 0;
add('ADR011', bad5210 === 0, bad5210 ? `${bad5210} سند انحراف مواد` : 'بدون سند 5210/5211');

const fail = checks.filter(c => !c.ok);
console.log('\n────────────────────────────────────────');
if (fail.length) {
  console.log(`نتیجه: ${fail.length} مورد قرمز — قبل از تولید واقعی رفع کنید.`);
  process.exitCode = 1;
} else {
  console.log('نتیجه: زیرساخت آماده. ادامه: علامت‌گذاری کالا → BOM → نرخ سربار → سفارش آزمایشی.');
}
