'use strict';
/**
 * ERP3.rar — invoice pay amount/POS/splits, color×size stock, payroll tax, BOM updateOperation.
 * Run: node server/scripts/test-erp3-v201.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const payrollSrc = fs.readFileSync(path.join(__dirname, '../routes/payroll.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(__dirname, '../lib/payroll/schema.js'), 'utf8');
const bomSrc = fs.readFileSync(path.join(__dirname, '../lib/production/bom-advanced.js'), 'utf8');
const bomRouteSrc = fs.readFileSync(path.join(__dirname, '../routes/production-boms.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ ERP3 v201 ══\n');

ok(appJs.includes('id="inv-pay-amount"'), 'h1 UI مبلغ پرداخت');
ok(appJs.includes('value="pos_card"') && appJs.includes('کارتخوان'), 'h2 UI کارتخوان');
ok(appJs.includes('id="inv-multi"') && appJs.includes('pay_splits'), 'h2 UI چندمرحله‌ای');
ok(appJs.includes('p-stock-cell') && appJs.includes('/product-variants/stock-matrix'), 'h3 UI ماتریس رنگ×سایز');
ok(appJs.includes('برداشتن تیک رنگ') && appJs.includes('const pool=live;'), 'h3 پک زنده بدون برگشت مشکی');
ok(appJs.includes('salaryStructureModal((r.id))') && appJs.includes('ویرایش'), 'h4 دکمه ویرایش ساختار');
ok(appJs.includes('پلکان ماده ۸۴ اختیاری است'), 'h5 پلکان اختیاری');
ok(appJs.includes('value="tax_exempt">معاف از مالیات'), 'h6 گزینه معاف از مالیات');
ok(appJs.includes("api('PUT','/production/boms/'+id+'/operations/'+opId"), 'h7 ذخیره عملیات از API');
ok(typeof /window\.adv\.updateOperation/.test(appJs) === 'boolean', 'h7 shim adv.updateOperation');
ok(invoicesSrc.includes('persistInvoicePayPlan') && invoicesSrc.includes('paymentsFromStoredInvoice'), 'مسیر فاکتور اقساط را نگه می‌دارد');
ok(invoicesSrc.includes('adjustVariantStock'), 'کسر موجودی واریانت در deductStock');
ok(payrollSrc.includes("'tax_exempt'"), 'payroll coerce tax_exempt');
ok(schemaSrc.includes("'tax_exempt'") && schemaSrc.includes('expandTaxExemptionCheck'), 'CHECK مالیات شامل tax_exempt');
ok(bomSrc.includes('function updateOperation') && bomRouteSrc.includes('updateOperation'), 'updateOperation در دامنه و مسیر');

const {
  resolveInvoicePayments, persistInvoicePayPlan, paymentsFromStoredInvoice,
} = require('../lib/invoice-payments');

try {
  const full = resolveInvoicePayments({ pay_type: 'cash', pay_amount: 100000 }, 100000);
  ok(full.splits.length === 0 && full.skipInvoiceCash === false, 'نقد کامل = مسیر قدیمی صندوق');
} catch (e) { ok(false, 'نقد کامل', e.message); }

try {
  const part = resolveInvoicePayments({ pay_type: 'cash', pay_amount: 40000, cash_box_id: 2 }, 100000);
  ok(part.splits.length === 1 && part.splits[0].amount === 40000 && part.skipInvoiceCash, 'مبلغ جزئی یک قسط می‌سازد');
} catch (e) { ok(false, 'مبلغ جزئی', e.message); }

try {
  const pos = resolveInvoicePayments({ pay_type: 'pos_card', pos_terminal_id: 9, pay_amount: 80000 }, 80000);
  ok(pos.splits.length === 1 && pos.splits[0].pay_type === 'pos_card' && pos.splits[0].terminal_id === 9, 'کارتخوان به قسط POS');
} catch (e) { ok(false, 'کارتخوان', e.message); }

try {
  const mixed = resolveInvoicePayments({
    pay_splits: [
      { pay_type: 'cash', amount: 50000, cash_box_id: 1 },
      { pay_type: 'pos_card', amount: 50000, terminal_id: 3 },
    ],
  }, 100000);
  ok(mixed.splits.length === 2 && mixed.skipInvoiceCash, 'نقد+کارتخوان دو قسط');
} catch (e) { ok(false, 'چندمرحله‌ای', e.message); }

try {
  resolveInvoicePayments({
    pay_splits: [{ pay_type: 'cash', amount: 120000 }],
  }, 100000);
  ok(false, 'جمع بیشتر از فاکتور باید رد شود');
} catch (e) {
  ok(e.code === 'E_PAY_SPLIT_OVER', 'جمع بیشتر از فاکتور رد می‌شود', e.code);
}

try {
  resolveInvoicePayments({ pay_type: 'pos_card', pay_amount: 1000 }, 1000);
  ok(false, 'کارتخوان بدون دستگاه باید رد شود');
} catch (e) {
  ok(e.code === 'E_PAY_SPLIT_POS', 'کارتخوان بدون دستگاه رد می‌شود', e.code);
}

const stored = {
  pay_type: 'mixed',
  pay_splits_json: JSON.stringify([
    { pay_type: 'cash', amount: 30000, cash_box_id: 1 },
    { pay_type: 'bank_transfer', amount: 70000, bank_id: 4 },
  ]),
};
const fromStored = paymentsFromStoredInvoice(stored, 100000);
ok(fromStored.splits.length === 2 && fromStored.skipInvoiceCash, 'اقساط ذخیره‌شده روی تبدیل خوانده می‌شود');

const { calculatePayroll, calculateProgressiveTax } = require('../lib/payroll/engine');
ok(calculateProgressiveTax(200000000, []) === 0, 'بدون پلکان مالیات صفر است');
ok(calculateProgressiveTax(0, [{ bracket_order: 1, bracket_min_rial: 0, tax_rate_bp: 1000 }]) === 0, 'درآمد صفر مالیات صفر');

const period = {
  standard_days: 30, standard_hours_x100: 22000,
  employee_insurance_bp: 700, employer_insurance_bp: 2300,
};
const structure = {
  wage_basis: 'monthly', base_wage_rial: 190000000,
  housing_allowance_rial: 0, grocery_allowance_rial: 0, child_allowance_rial: 0,
  spouse_allowance_rial: 0, other_fixed_allowance_rial: 0, child_count: 0, marital_status: 0,
  insurance_type: 'none', tax_exemption_type: 'tax_exempt', tax_exemption_percent_bp: 0,
  overtime_factor_bp: 14000, night_shift_factor_bp: 11500,
};
const input = {
  working_days_x100: 3000, regular_hours_x100: 22000,
  overtime_hours: 0, night_shift_hours: 0,
  hardship_allowance_rial: 0, other_allowance_rial: 0,
  insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
};
const exemptCalc = calculatePayroll({
  period, structure, input,
  brackets: [{ bracket_order: 1, bracket_min_rial: 0, tax_rate_bp: 2000 }],
});
ok(exemptCalc.income_tax_rial === 0 && exemptCalc.taxable_income_rial === 0, 'معاف از مالیات مالیات را صفر می‌کند');

const noBracketCalc = calculatePayroll({
  period,
  structure: { ...structure, tax_exemption_type: 'none', insurance_type: 'none' },
  input, brackets: [],
});
ok(noBracketCalc.income_tax_rial === 0, 'کارمند غیرمعاف بدون پلکان هم مالیات صفر است');

function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/better-sqlite3',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return require('better-sqlite3');
}

let db = null;
try {
  const Database = loadBetterSqlite3();
  const dbPath = path.join(os.tmpdir(), `erp3-v201-${Date.now()}.db`);
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT, name TEXT, barcode TEXT, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
      cost REAL DEFAULT 0, stock REAL DEFAULT 0, colors INTEGER DEFAULT 1, pack_size INTEGER DEFAULT 1,
      warehouse_id INTEGER, is_style INTEGER DEFAULT 0, has_variants INTEGER DEFAULT 0, default_variant_id INTEGER
    );
    CREATE TABLE warehouse_stock (
      product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
      PRIMARY KEY (product_id, warehouse_id)
    );
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pay_splits_json TEXT, pay_amount_rial INTEGER DEFAULT 0, pos_terminal_id INTEGER
    );
  `);
  const { initProductVariantsSchema } = require('../lib/product-variants');
  const { generateMatrix, applyStockMatrix, packSizeFor, adjustVariantStock } = require('../lib/product-variants/service');
  initProductVariantsSchema(db);
  const productId = db.prepare("INSERT INTO products (code,name,price,stock,pack_size) VALUES ('STY3','مانتو',100000,0,1)").run().lastInsertRowid;
  generateMatrix(db, {
    product_id: productId,
    colors: [{ name: 'صورتی' }, { name: 'مشکی' }],
    sizes: [{ name: 'سایز 1' }, { name: 'سایز 2' }],
  });
  const colors = db.prepare('SELECT id,name FROM product_colors ORDER BY id').all();
  const sizes = db.prepare('SELECT id,name FROM product_sizes ORDER BY id').all();
  const pink = colors.find((c) => c.name === 'صورتی');
  const black = colors.find((c) => c.name === 'مشکی');
  const s1 = sizes.find((s) => s.name === 'سایز 1');
  const s2 = sizes.find((s) => s.name === 'سایز 2');
  const applied = applyStockMatrix(db, productId, [
    { color_id: pink.id, size_id: s1.id, qty: 10 },
    { color_id: pink.id, size_id: s2.id, qty: 8 },
    { color_id: black.id, size_id: s1.id, qty: 5 },
    { color_id: black.id, size_id: s2.id, qty: 0 },
  ], { warehouse_id: 1 });
  ok(applied.stock === 23, 'جمع ماتریس موجودی کالا', applied.stock);
  ok(applied.pack.pack_size_auto === 4 || applied.pack.live_colors === 2, 'پک زنده از رنگ/سایز موجود', applied.pack);
  const liveBefore = packSizeFor(db, productId);
  ok(liveBefore.live_colors === 2 && liveBefore.live_sizes === 2 && liveBefore.pack_size_auto === 4, 'پک زنده ۲×۲', liveBefore);

  const blackS1 = db.prepare('SELECT * FROM product_variants WHERE product_id=? AND color_id=? AND size_id=?').get(productId, black.id, s1.id);
  adjustVariantStock(db, blackS1.id, 0, 'set');
  const liveAfter = packSizeFor(db, productId);
  ok(liveAfter.live_colors === 1 && liveAfter.live_sizes === 2 && liveAfter.pack_size_auto === 2, 'اتمام مشکی پک را به ۱×۲ می‌کند', liveAfter);

  const afterUncheck = applyStockMatrix(db, productId, [
    { color_id: pink.id, size_id: s1.id, qty: 10 },
    { color_id: pink.id, size_id: s2.id, qty: 8 },
  ], { warehouse_id: 1 });
  const blackLeft = db.prepare(`
    SELECT COUNT(*) c FROM product_variants
    WHERE product_id=? AND color_id=? AND active=1 AND is_default=0
  `).get(productId, black.id).c;
  ok(blackLeft === 0, 'برداشتن تیک مشکی SKU را غیرفعال می‌کند', blackLeft);
  ok(afterUncheck.pack.live_colors === 1 && afterUncheck.pack.pack_size_auto === 2, 'پک زنده بعد از حذف مشکی ۱×۲ است', afterUncheck.pack);
  const readd = applyStockMatrix(db, productId, [
    { color_id: pink.id, size_id: s1.id, qty: 10 },
    { color_id: pink.id, size_id: s2.id, qty: 8 },
    { color_id: black.id, size_id: s1.id, qty: 4 },
    { color_id: black.id, size_id: s2.id, qty: 0 },
  ], { warehouse_id: 1 });
  ok(readd.pack.live_colors === 2 && readd.pack.pack_size_auto === 2, 'برگشت تیک مشکی همان SKU را زنده می‌کند', readd.pack);

  db.prepare('INSERT INTO invoices (id) VALUES (1)').run();
  persistInvoicePayPlan(db, 1, {
    splits: [{ amount: 40000, terminal_id: 7 }],
  }, { pay_amount: 40000 });
  const invRow = db.prepare('SELECT * FROM invoices WHERE id=1').get();
  ok(Number(invRow.pay_amount_rial) === 40000 && Number(invRow.pos_terminal_id) === 7, 'persist مبلغ و کارتخوان');

  const { initPayrollSchema } = require('../lib/payroll/schema');
  db.exec(`
    CREATE TABLE persons (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
  `);
  initPayrollSchema(db);
  db.prepare("INSERT INTO persons (name) VALUES ('فاطمه')").run();
  db.prepare(`
    INSERT INTO salary_structures (person_id,fiscal_year,tax_exemption_type)
    VALUES (1,1405,'tax_exempt')
  `).run();
  const saved = db.prepare('SELECT tax_exemption_type FROM salary_structures WHERE person_id=1').get();
  ok(saved && saved.tax_exemption_type === 'tax_exempt', 'ذخیره نوع معاف از مالیات در ساختار');
} catch (e) {
  const abi = /NODE_MODULE_VERSION|better-sqlite3/.test(String(e.message || e));
  if (abi) console.log('  SKIP sqlite ERP3:', String(e.message || e).split('\n')[0]);
  else ok(false, 'sqlite ERP3', e.message);
}

if (fail) {
  console.log(`\nERP3 v201 FAILED ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`\nERP3 v201 PASS ${pass}/${pass + fail}`);
