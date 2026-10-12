'use strict';
/**
 * داشبورد فروش و خرید + سود خالص — SW v357
 * Run: node server/scripts/test-sales-purchase-dashboard-v357.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dash-v357-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-sales-purchase-dashboard-v357-secret-32b';
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

try {
  db.prepare('UPDATE products SET cost=?, average_cost_rial=? WHERE id=?')
    .run(4000000, 4000000, productId);
} catch (_) {
  db.prepare('UPDATE products SET cost=? WHERE id=?').run(4000000, productId);
}

const salesRows = JSON.stringify([{
  product_id: productId, name: 'مانتو تست', qty: 2, price: 1000000, sum: 2000000,
  unit_cost_rial: 4000000,
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

ok(dash.profit && typeof dash.profit.net_profit_rial === 'number', 'profit block present');
ok(dash.kpis.cogs_rial === 8000000, 'COGS = qty × unit_cost_rial (2×4M)');
ok(dash.kpis.gross_profit_rial === 11900000, 'gross = sales_net − COGS');
ok(dash.kpis.commission_rial === 0, 'commission zero without rates');
ok(dash.kpis.net_profit_rial === 11900000, 'net = gross − commission');
ok(dash.kpis.gross_margin_pct > 0 && dash.kpis.net_margin_pct > 0, 'margins positive');
ok(dash.kpis.net_profit_rial === dash.profit.net_profit_rial, 'kpi mirrors profit block');
ok(typeof dash.comparison.net_profit_delta_pct === 'number', 'comparison has net_profit_delta');
ok(dash.comparison.prior_net_profit_rial === 0, 'prior profit zero outside range');

const month = (dash.monthly || []).find((m) => m.month === '1405/07');
ok(month && month.net_profit_rial === 12000000, 'monthly approx profit = sales − cogs (no commission)');

ok(Array.isArray(dash.alerts), 'alerts array');
ok(typeof dash.health_score === 'number', 'health_score');
ok(dash.unit_note && /سود خالص/.test(dash.unit_note), 'unit_note mentions net profit');

console.log(`\nPASS ${passed} assertions — sales-purchase-dashboard v357`);
