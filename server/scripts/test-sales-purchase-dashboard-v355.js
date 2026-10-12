'use strict';
/**
 * داشبورد فروش و خرید — SW v355
 * Run: node server/scripts/test-sales-purchase-dashboard-v355.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dash-v355-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-sales-purchase-dashboard-v355-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { buildSalesPurchaseDashboard } = require('../lib/sales-purchase-dashboard');

initDB();
const db = getDB();

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed++;
  console.log('OK:', msg);
}

db.prepare(`
  INSERT INTO customers (user_id, biz, owner, city, phone, type, status)
  VALUES (?,?,?,?,?,?,?)
`).run(1, 'فروشگاه تست', 'مالک', 'مشهد', '09120000000', 'بوتیک', 'active');
const custId = db.prepare('SELECT id FROM customers ORDER BY id DESC LIMIT 1').get().id;

db.prepare(`INSERT INTO suppliers (name, phone) VALUES (?,?)`).run('تأمین‌کننده تست', '09121111111');
const supId = db.prepare('SELECT id FROM suppliers ORDER BY id DESC LIMIT 1').get().id;

const productId = db.prepare(`
  INSERT INTO products (user_id, code, name, price, stock, unit)
  VALUES (?,?,?,?,?,?)
`).run(1, 'K-SP-1', 'مانتو تست', 1000000, 10, 'عدد').lastInsertRowid;

const salesRows = JSON.stringify([{
  product_id: productId, name: 'مانتو تست', qty: 2, price: 1000000, sum: 2000000,
}]);

db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, rows, subtotal, disc_amt, final, final_rial, approved, deleted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)
`).run(1, custId, 'normal', '1405/07/10', salesRows, 2000000, 0, 2000000, 20000000, 1);

db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, rows, subtotal, disc_amt, final, final_rial, approved, deleted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)
`).run(1, custId, 'proforma', '1405/07/11', salesRows, 2000000, 0, 2000000, 20000000, 0);

const purRows = JSON.stringify([{
  product_id: productId, name: 'مانتو تست', qty: 5, price: 400000, sum: 2000000,
}]);
db.prepare(`
  INSERT INTO purchase_invoices (user_id, supplier_id, date, rows, subtotal, final, status)
  VALUES (?,?,?,?,?,?,?)
`).run(1, supId, '1405/07/12', purRows, 2000000, 2000000, 'posted');

db.prepare(`
  INSERT INTO sales_returns (user_id, cust_id, date, rows, amount)
  VALUES (?,?,?,?,?)
`).run(1, custId, '1405/07/13', '[]', 100000);

const dash = buildSalesPurchaseDashboard(db, { from: '1405/07/01', to: '1405/07/31' });
ok(dash && dash.kpis, 'payload has kpis');
ok(dash.kpis.sales_count === 1, 'only firm sales counted (proforma excluded)');
ok(dash.kpis.sales_gross_rial === 20000000, 'sales gross uses final_rial');
ok(dash.kpis.returns_sales_rial === 100000, 'sales return amount present');
ok(dash.kpis.sales_net_rial === 19900000, 'net sales = gross - return');
ok(dash.kpis.purchase_count === 1, 'purchase counted');
ok(dash.kpis.purchase_gross_rial === 2000000, 'purchase gross');
ok(Array.isArray(dash.monthly) && dash.monthly.length >= 1, 'monthly series');
ok(Array.isArray(dash.by_customer) && dash.by_customer.length === 1, 'top customer');
ok(Array.isArray(dash.by_supplier) && dash.by_supplier.length === 1, 'top supplier');
ok(Array.isArray(dash.by_product) && dash.by_product.length >= 1, 'top product');
ok(Array.isArray(dash.alerts), 'alerts array');
ok(typeof dash.health_score === 'number', 'health_score');
ok(dash.comparison && typeof dash.comparison.sales_delta_pct === 'number', 'comparison delta');

const filtered = buildSalesPurchaseDashboard(db, {
  from: '1405/07/01', to: '1405/07/31', cust_id: custId, supplier_id: 999999,
});
ok(filtered.kpis.sales_count === 1, 'cust filter keeps sales');
ok(filtered.kpis.purchase_count === 0, 'supplier filter excludes purchases');

console.log(`\nPASS ${passed} assertions — sales-purchase-dashboard v355`);
