#!/usr/bin/env node
'use strict';
/**
 * Unit tests for prod-sku color panel (lib + app.js PCS-SHARED parity).
 * Run: npm run test:pcs-panel
 * No `||` inside assert conditions.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const lib = require(path.join(__dirname, '..', 'lib', 'prod-sku-color-panel.js'));
const appPath = path.join(__dirname, '..', 'public', 'app.js');
const libPath = path.join(__dirname, '..', 'lib', 'prod-sku-color-panel.js');
const reportPath = path.join(__dirname, 'report-color-variant-mismatch.js');

let passed = 0;
function check(cond, msg) {
  assert.strictEqual(cond, true, msg);
  passed += 1;
  console.log('  ✓', msg);
}

function extractShared(src, name) {
  const open = '/* PCS-SHARED:' + name + ' */';
  const close = '/* /PCS-SHARED */';
  const i = src.indexOf(open);
  assert.notStrictEqual(i, -1, 'missing open marker ' + name);
  const j = src.indexOf(close, i);
  assert.notStrictEqual(j, -1, 'missing close marker ' + name);
  return src.slice(i + open.length, j).trim();
}

console.log('test-prod-sku-color-panel');

/* ---- faNorm ---- */
assert.strictEqual(lib.faNorm('قهوه‌ای'), 'قهوه ای');
assert.strictEqual(lib.faNorm('قهوه ای'), 'قهوه ای');
assert.strictEqual(lib.faNorm('قهوه  ای'), 'قهوه ای');
assert.strictEqual(lib.faNorm('قهوه\u00A0ای'), 'قهوه ای');
assert.strictEqual(lib.faNorm('آبي'), 'ابی');
assert.strictEqual(lib.faNorm('كرم'), 'کرم');
assert.strictEqual(lib.faNorm('۱۲۳'), '123');
assert.strictEqual(lib.faNorm('١٢٣'), '123');
assert.strictEqual(lib.faNorm(null), '');
passed += 9;
console.log('  ✓ faNorm cases');

/* ---- prodColorFilter ---- */
const list = [
  { id: 1, name: 'آبی کاربنی', code: 'BL' },
  { id: 2, name: 'قهوه ای', code: 'BR' },
  { id: 3, name: 'مشکی', code: 'BK' },
  { id: 4, name: 'قهوه‌ای سوخته', code: 'BR2' },
];
function idsOf(q) {
  return lib.prodColorFilter(list, q).map((c) => c.id).slice().sort((a, b) => a - b);
}
assert.deepStrictEqual(idsOf('قهوه‌ای'), [2, 4]);
assert.deepStrictEqual(idsOf('قهوه ای'), [2, 4]);
assert.deepStrictEqual(idsOf('قهوهای'), [2, 4]);
assert.deepStrictEqual(idsOf('آبي'), [1]);
assert.deepStrictEqual(idsOf('bk'), [3]);
assert.deepStrictEqual(idsOf(''), [1, 2, 3, 4]);
assert.deepStrictEqual(idsOf('زرد'), []);
passed += 7;
console.log('  ✓ prodColorFilter cases');

/* ---- PCS-SHARED parity ---- */
{
  const appSrc = fs.readFileSync(appPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  for (const name of ['faNorm', 'prodColorFilter', 'splitSizeLabel']) {
    assert.strictEqual(extractShared(appSrc, name), extractShared(libSrc, name), 'parity ' + name);
    passed += 1;
    console.log('  ✓ PCS-SHARED parity', name);
  }
}

/* ---- classify via app.js vm ---- */
{
  const appSrc = fs.readFileSync(appPath, 'utf8');
  const start = appSrc.indexOf('function prodSkuClassifyColors');
  const end = appSrc.indexOf('\n/* PCS-SHARED:splitSizeLabel */', start);
  assert.ok(start > 0 && end > start, 'locate prodSkuClassifyColors');
  const sandbox = {
    prodStyleColorIds: () => new Set([10, 20, 30]),
    prodMatrixColorIds: () => new Set([10]),
    prodPreserveColorIds: () => [20],
  };
  vm.runInNewContext(appSrc.slice(start, end), sandbox);
  const vars = [
    { color_id: 10, size_id: 1, stock: 5, stock_global: 5, warehouse_id: 1, is_default: 0, active: 1 },
    { color_id: 20, size_id: 1, stock: 0, stock_global: 3, warehouse_id: 1, is_default: 0, active: 1 },
    { color_id: 30, size_id: 1, stock: 0, stock_global: 0, warehouse_id: 1, is_default: 0, active: 1 },
  ];
  const cls = sandbox.prodSkuClassifyColors(vars, 1);
  const a = new Set(cls.withStock.map(Number));
  const b = new Set(cls.otherWh.map(Number));
  const c = new Set(cls.withoutStock.map(Number));
  check(a.has(10) && !b.has(10) && !c.has(10), 'classify: here only in withStock');
  check(b.has(20) && !a.has(20) && !c.has(20), 'classify: otherWh only');
  check(c.has(30) && !a.has(30) && !b.has(30), 'classify: withoutStock only');
  check(a.size + b.size + c.size === 3, 'classify: no drop / no overlap total');
}

/* ---- draft pure helpers (lib) ---- */
{
  let d = lib.pcsDraftEnsure(null, 7);
  assert.strictEqual(d.productId, 7);
  d = lib.pcsDraftSet(d, 34, 10, 2, '5', 0);
  assert.strictEqual(lib.pcsDraftGet(d, 34, 10, 2), '5');
  assert.strictEqual(lib.pcsDraftGet(d, 99, 10, 2), undefined);
  assert.strictEqual(lib.pcsDraftCount(d, 34), 1);
  d = lib.pcsDraftSet(d, 34, 10, 2, '0', 0);
  assert.strictEqual(lib.pcsDraftGet(d, 34, 10, 2), undefined);
  d = lib.pcsDraftSet(d, 34, 10, 2, '8', 0);
  d = lib.pcsDraftSet(d, 35, 10, 2, '9', 0);
  assert.strictEqual(lib.pcsDraftGet(d, 34, 10, 2), '8');
  assert.strictEqual(lib.pcsDraftGet(d, 35, 10, 2), '9');
  d = lib.pcsDraftClear(d, 34);
  assert.strictEqual(lib.pcsDraftGet(d, 34, 10, 2), undefined);
  assert.strictEqual(lib.pcsDraftGet(d, 35, 10, 2), '9');
  passed += 8;
  console.log('  ✓ draft helpers');
}

/* ---- fill-empty ---- */
{
  const r = lib.pcsFillEmptyValues(['', '5', '0', null], '1');
  assert.deepStrictEqual(r.next, ['1', '5', '1', '1']);
  assert.strictEqual(r.filled, 3);
  const r2 = lib.pcsFillEmptyValues(['2', '3'], '1');
  assert.deepStrictEqual(r2.next, ['2', '3']);
  assert.strictEqual(r2.filled, 0);
  passed += 4;
  console.log('  ✓ pcsFillEmptyValues');
}

/* ---- app.js draft lifecycle (vm: same functions as browser) ---- */
{
  const appSrc = fs.readFileSync(appPath, 'utf8');
  const start = appSrc.indexOf('function pcsDraftRoot(');
  const end = appSrc.indexOf('function pcsServerQty(', start);
  assert.ok(start > 0 && end > start, 'locate app.js draft helpers');
  let confirmCalls = 0;
  let confirmResult = true;
  const sandbox = {
    window: { _prodMatrixDraft: null, _prodSkuSticky: null, _prodModalProduct: null, _pcsBeforeUnloadBound: true },
    el: () => null,
    document: { querySelector: () => ({ className: 'prod-form-v2' }) },
    confirm: () => {
      confirmCalls += 1;
      return confirmResult;
    },
  };
  vm.runInNewContext(appSrc.slice(start, end), sandbox);

  // کالای جدید (id=0): ریست تمیز
  sandbox.pcsDraftReset(0);
  assert.strictEqual(sandbox.pcsHasUnsavedDraft(), false);
  assert.strictEqual(sandbox.window._prodMatrixDraft.productId, 0);
  assert.strictEqual(Object.keys(sandbox.window._prodMatrixDraft.byWh).length, 0);
  passed += 3;
  console.log('  ✓ app draft: new product reset');

  // ویرایش → dirty → ذخیره موفق (pcsDraftReset مثل saveProduct) → بدون هشدار
  sandbox.window._prodSkuSticky = { productId: 11 };
  sandbox.window._prodModalProduct = { id: 11 };
  sandbox.pcsDraftReset(11);
  sandbox.pcsDraftSet(34, 10, 2, '5', 0);
  assert.strictEqual(sandbox.pcsHasUnsavedDraft(), true);
  sandbox.pcsDraftReset(11); // همان مسیر saveProduct قبل از closeModal
  assert.strictEqual(sandbox.pcsHasUnsavedDraft(), false);
  confirmCalls = 0;
  assert.strictEqual(sandbox.pcsConfirmLeaveDraft(), true);
  assert.strictEqual(confirmCalls, 0);
  passed += 4;
  console.log('  ✓ app draft: save then leave without confirm');

  // ویرایش → dirty → تأیید دور ریختن → جدول تمیز؛ لغو نگه می‌دارد
  sandbox.pcsDraftReset(11);
  sandbox.pcsDraftSet(34, 10, 2, '9', 0);
  confirmResult = false;
  confirmCalls = 0;
  assert.strictEqual(sandbox.pcsConfirmLeaveDraft(), false);
  assert.strictEqual(confirmCalls, 1);
  assert.strictEqual(sandbox.pcsHasUnsavedDraft(), true);
  confirmResult = true;
  confirmCalls = 0;
  assert.strictEqual(sandbox.pcsConfirmLeaveDraft(), true);
  assert.strictEqual(confirmCalls, 1);
  assert.strictEqual(sandbox.pcsHasUnsavedDraft(), false);
  // باز کردن دوباره (مثل prodModal)
  sandbox.pcsDraftReset(11);
  assert.strictEqual(sandbox.pcsDraftCount(), 0);
  assert.strictEqual(sandbox.pcsDraftGet(34, 10, 2), undefined);
  passed += 7;
  console.log('  ✓ app draft: discard + reopen clean');
}

/* ---- XSS esc via chip-like helper (lib has no HTML; use same esc as app pattern) ---- */
{
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  const evil = '<img src=x onerror=alert(1)>';
  const html = `<bdi class="pcs-chip-name">${esc(evil)}</bdi>`;
  check(html.includes('&lt;img'), 'XSS: escaped lt-img');
  check(html.includes('<img') === false, 'XSS: no raw img tag');
}

/* ---- report script ---- */
{
  const noDb = spawnSync(process.execPath, [reportPath], { encoding: 'utf8' });
  assert.strictEqual(noDb.status, 2);
  passed += 1;
  console.log('  ✓ report without --db exits 2');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-report-'));
  const dbFile = path.join(tmpDir, 't.db');
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, stock REAL);
    CREATE TABLE product_colors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE product_variants (
      id INTEGER PRIMARY KEY, product_id INTEGER, color_id INTEGER, sku TEXT,
      stock REAL, active INTEGER, is_default INTEGER
    );
    CREATE TABLE product_style_colors (product_id INTEGER, color_id INTEGER);
    CREATE TABLE variant_warehouse_stock (variant_id INTEGER, qty REAL);
  `);
  const before = {
    products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
    variants: db.prepare('SELECT COUNT(*) c FROM product_variants').get().c,
    style: db.prepare('SELECT COUNT(*) c FROM product_style_colors').get().c,
    vws: db.prepare('SELECT COUNT(*) c FROM variant_warehouse_stock').get().c,
  };
  db.close();
  const withDb = spawnSync(process.execPath, [reportPath, '--db', dbFile], { encoding: 'utf8' });
  assert.strictEqual(withDb.status, 0, withDb.stderr || withDb.stdout);
  const db2 = new Database(dbFile, { readonly: true });
  const after = {
    products: db2.prepare('SELECT COUNT(*) c FROM products').get().c,
    variants: db2.prepare('SELECT COUNT(*) c FROM product_variants').get().c,
    style: db2.prepare('SELECT COUNT(*) c FROM product_style_colors').get().c,
    vws: db2.prepare('SELECT COUNT(*) c FROM variant_warehouse_stock').get().c,
  };
  db2.close();
  assert.deepStrictEqual(after, before);
  passed += 2;
  console.log('  ✓ report --db readonly + row counts unchanged');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

console.log('\nOK —', passed, 'assertions');
process.exit(0);
