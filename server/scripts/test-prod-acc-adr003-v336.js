'use strict';
/**
 * ADR-003 / v336 — static + DB smoke (run on Iran when local sqlite ABI missing).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('OK', msg);
}

const { appliedOverheadRial } = require('../lib/production/overhead');
const postingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/posting.js'), 'utf8');
const cuttingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/cutting.js'), 'utf8');
const expensesSrc = fs.readFileSync(path.join(__dirname, '../routes/expenses.js'), 'utf8');
const closeSrc = fs.readFileSync(path.join(__dirname, '../lib/production/close.js'), 'utf8');
const engAdvSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
const bomSrc = fs.readFileSync(path.join(__dirname, '../lib/production/bom-advanced.js'), 'utf8');
const prodRouteSrc = fs.readFileSync(path.join(__dirname, '../routes/production.js'), 'utf8');

ok(appliedOverheadRial({ total_rate_rial: 1000, absorb_pct: 50 }, 10) === 5000, 'absorb 50%');
ok(appliedOverheadRial({ total_rate_rial: 1000, absorb_pct: 100 }, 2) === 2000, 'absorb 100%');
ok(/production_overhead_actual/.test(expensesSrc), 'expense PRD-06 sourceType');
ok(/event:\s*'PRD-01'/.test(cuttingSrc) && /event:\s*'PRD-09'/.test(cuttingSrc) && /event:\s*'PRD-07'/.test(cuttingSrc), 'cutting PRD tags');
ok(/assertPeriodOpen\(db,\s*period\)/.test(engAdvSrc) && /issueStageMaterials/.test(engAdvSrc), 'stage issue period gate');
ok(/coa_var_oh_budget/.test(postingSrc) && /budgetRial/.test(postingSrc), '5214 budget close');
ok(/appliedOverheadRial\(rate,\s*driverQty\)/.test(bomSrc), 'rollup absorb');
ok(/coa_finished_goods/.test(engAdvSrc) && /output_type === 'scrap'/.test(engAdvSrc), 'PRD-16 by→1104 scrap→1113');
ok(/production_wh_wip_id/.test(prodRouteSrc) && /PRO_SETTINGS_KEYS/.test(prodRouteSrc), 'production settings API');
ok(/ref_type IN \('production_labor_actual','payroll'\)/.test(closeSrc), 'PRD-04 precheck payroll');
ok(/budgetRial:\s*budgetRial/.test(closeSrc), 'close passes budgetRial');

let dbOk = false;
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-adr003-'));
  process.env.DB_PATH = path.join(tmp, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-adr003-v336';
  const { getDB, initDB } = require('../db');
  const { postCloseOverhead } = require('../lib/production/posting');
  initDB();
  const db = getDB();
  const out = postCloseOverhead(db, {
    closeId: 9001, date: '1405/07/29', userId: 1,
    appliedRial: 100000, varianceRial: 40000, budgetRial: 120000,
  });
  ok(Array.isArray(out) && out.length >= 2, `DB close OH events ${out.length}`);
  const descs = db.prepare(`SELECT description FROM journal_entries WHERE ref_type='production_close_overhead' AND ref_id=9001`).all();
  ok(descs.some(d => /بودجه|حجم|جذب/.test(d.description || '')), 'budget/volume/transfer descriptions');
  dbOk = true;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
} catch (e) {
  if (/bindings|better-sqlite3/i.test(String(e.message))) {
    console.log('SKIP DB suite (sqlite ABI):', e.message.split('\n')[0]);
  } else {
    throw e;
  }
}

console.log(`\nPASS ${passed}${dbOk ? ' (with DB)' : ' (static only)'}`);
process.exit(0);
