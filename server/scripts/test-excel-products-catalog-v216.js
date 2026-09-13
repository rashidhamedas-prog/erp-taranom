#!/usr/bin/env node
/**
 * v216: Excel product import must persist every valid row, and catalog list
 * must not silently look complete at the generic 200-row page cap.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseListQuery, MAX_PAGE_SIZE, CATALOG_MAX_PAGE_SIZE } = require('../lib/pagination');

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL', msg); failed += 1; }
  else console.log('OK  ', msg);
}

const legacyCap = parseListQuery({ limit: '500' });
ok(legacyCap.pageSize === MAX_PAGE_SIZE, `generic list still caps at ${MAX_PAGE_SIZE} (got ${legacyCap.pageSize})`);
const catalog500 = parseListQuery({ limit: '500' }, { maxPageSize: CATALOG_MAX_PAGE_SIZE });
ok(catalog500.pageSize === 500, `catalog honors limit=500 (got ${catalog500.pageSize})`);

const productsSrc = fs.readFileSync(path.join(__dirname, '../routes/products.js'), 'utf8');
const excelSrc = fs.readFileSync(path.join(__dirname, '../routes/excel.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const captureSrc = fs.readFileSync(path.join(__dirname, '../sync/capture.js'), 'utf8');
ok(productsSrc.includes('CATALOG_MAX_PAGE_SIZE'), 'products list uses catalog page cap');
ok(productsSrc.includes('createQuickProduct'), 'POST /products/quick delegates to product-quick');
ok(excelSrc.includes("router.post('/:entity/commit-import'"), 'excel commit-import route exists');
ok(excelSrc.includes('applyExcelProductAction'), 'excel commit uses shared product writer');
ok(excelSrc.includes('centralOnlyStrict'), 'commit-import is central-only');
ok(appSrc.includes('fetchCatalogList'), 'UI fetches remaining catalog pages');
ok(appSrc.includes('commit-import'), 'UI prefers server commit');
ok(appSrc.includes('pagination.total'), 'UI count uses pagination.total');
ok(captureSrc.includes("'/api/excel'"), 'sync outbox blocks /api/excel');

const desktopXlsx = 'c:/Users/surface/Desktop/erp-kala-14050503.xlsx';

async function inspectLiveWorkbook() {
  if (!fs.existsSync(desktopXlsx)) return;
  const { readWorkbook, XLSX } = require('../lib/excel-safe');
  const book = await readWorkbook(fs.readFileSync(desktopXlsx), { cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  const dataRows = rawRows.filter((r) => Object.values(r || {}).some((v) => String(v ?? '').trim() !== ''));
  ok(dataRows.length >= 300, `live workbook data rows=${dataRows.length} (>=300)`);
  const named = dataRows.filter((r) => String(r['نام کالا*'] || r['نام کالا'] || r['نام محصول'] || '').trim()).length;
  ok(named >= 300, `live workbook named rows=${named}`);
  return dataRows;
}

async function runDbTests(dataRows) {
  const tmp = path.join(os.tmpdir(), 'taranom-excel-catalog-' + Date.now() + '.db');
  process.env.DB_PATH = tmp;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-excel-catalog-secret-32chars!!';
  process.env.SYNC_ROLE = 'central';
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const excel = require('../routes/excel');
  const { planExcelImport, applyPlannedActions, buildActions } = excel._test;

  let wh;
  try {
    wh = db.prepare("INSERT INTO warehouses (name,code,active) VALUES ('انبار اصلی','WH-1',1)").run();
  } catch (_) {
    wh = db.prepare("INSERT INTO warehouses (name,active) VALUES ('انبار اصلی',1)").run();
  }
  ok(!!wh.lastInsertRowid, 'warehouse seeded');

  const N = 250;
  const rows = [];
  for (let i = 1; i <= N; i += 1) {
    rows.push({
      'نام کالا*': `کالای تست ${String(i).padStart(3, '0')}`,
      'کد کالا': `T-${String(i).padStart(4, '0')}`,
      'انبار اصلی': 'انبار اصلی',
      موجودی: 0,
      'قیمت فروش (ریال)': 20000,
    });
  }
  rows.push({ 'نام کالا*': '', 'کد کالا': 'BLANK' });
  rows.push({ 'نام کالا*': 'کالای انبار غلط', 'انبار اصلی': 'NO-SUCH-WH' });

  const planned = planExcelImport(db, 'products', rows);
  ok(planned.createCount === N, `plan creates ${N} (got ${planned.createCount})`);
  ok(planned.skipped_invalid.length === 2, `two invalid rows reported (got ${planned.skipped_invalid.length})`);
  ok(planned.actions.length === N, `actions=${planned.actions.length}`);

  const applied = applyPlannedActions(db, { id: 1 }, 'products', planned.actions);
  ok(applied.server_applied === true, 'products commit is server-applied');
  ok(applied.created.length === N, `created ${N} (got ${applied.created.length})`);
  ok(applied.failed.length === 0, `no failures (got ${JSON.stringify(applied.failed.slice(0, 3))})`);

  const persisted = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  ok(persisted === N, `persisted_count=${N} (got ${persisted})`);
  ok(persisted > MAX_PAGE_SIZE, 'catalog larger than generic 200-row cap');

  const replay = planExcelImport(db, 'products', rows.slice(0, N));
  ok(replay.createCount === 0, 'replay creates none');
  ok(replay.updateCount === N, `replay updates all ${N} (got ${replay.updateCount})`);

  const alias = buildActions(db, 'products', [{ 'نام محصول': 'از ستون نام محصول', 'انبار اصلی': 'انبار اصلی' }]);
  ok(alias.length === 1 && alias[0].body.name === 'از ستون نام محصول', 'name alias نام محصول');

  if (dataRows && dataRows.length) {
    const livePlan = planExcelImport(db, 'products', dataRows);
    ok(livePlan.actions.length + livePlan.skipped_invalid.length === dataRows.length,
      `live plan covers every row (${livePlan.actions.length} actions + ${livePlan.skipped_invalid.length} invalid)`);
  }

  try { fs.unlinkSync(tmp); } catch (_) {}
  try { fs.unlinkSync(tmp + '-wal'); } catch (_) {}
  try { fs.unlinkSync(tmp + '-shm'); } catch (_) {}
}

(async function main() {
  const dataRows = await inspectLiveWorkbook();
  try {
    await runDbTests(dataRows);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/Could not locate the bindings file|NODE_MODULE_VERSION|better_sqlite3/.test(msg)) {
      console.log('SKIP sqlite engine tests — better-sqlite3 ABI not built for this Node');
    } else {
      console.error(e);
      failed += 1;
    }
  }
  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nAll excel product catalog v216 tests passed');
})();
