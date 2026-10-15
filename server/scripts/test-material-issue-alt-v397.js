'use strict';
/**
 * v397 — partial stock shortage covered by alternate material on variable issue.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const engine = require('../lib/production/engine');
const fs = require('fs');
const path = require('path');

console.log('\n══ v397 Material Issue Alternate Cover ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/07/23';

function seedProduct(name, avg, stock, std) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, 0, stock).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type='raw', is_manufactured=0, std_cost_rial=?
    WHERE id=?
  `).run(avg, std != null ? std : avg, id);
  return id;
}

const pFg = (() => {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run('مانتو تست', 0, 0).lastInsertRowid;
  db.prepare(`UPDATE products SET average_cost_rial=0, item_type='finished', is_manufactured=1 WHERE id=?`).run(id);
  return id;
})();
const pZip = seedProduct('زیپ کلاه', 50000, 70, 48000);
const pAlt = seedProduct('زیپ ساده', 45000, 100, 45000);
const pOther = seedProduct('آستر', 180000, 5000, 175000);

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
ok(!!whRaw, 'WH-RAW exists');

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_reason_pct',?)").run('5');

for (const [pid, qty] of [[pZip, 70], [pAlt, 100], [pOther, 5000]]) {
  db.prepare(`
    INSERT INTO warehouse_stock (warehouse_id, product_id, qty)
    VALUES (?,?,?)
    ON CONFLICT(warehouse_id, product_id) DO UPDATE SET qty=excluded.qty
  `).run(whRaw, pid, qty);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(qty, pid);
}

const b = bom.createBom(db, {
  product_id: pFg,
  name: 'BOM alt cover',
  yield_percent: 100,
  base_qty: 1,
  lines: [
    { component_product_id: pZip, qty_per_base: 96, scrap_percent: 0, line_type: 'material', std_cost_rial: 48000 },
    { component_product_id: pOther, qty_per_base: 1, scrap_percent: 0, line_type: 'material', std_cost_rial: 175000 },
  ],
}, adminId);
bom.activateBom(db, b.id, '1405/01/01', adminId);

const po = engine.createOrder(db, {
  product_id: pFg, qty_planned: 1, analysis_type: 'variable',
  bom_id: b.id, date: DATE,
}, adminId);
engine.releaseOrder(db, po.id, adminId);

// Without alternate → stock block
throws('بدون جایگزین → E_NEGATIVE_STOCK', () => {
  engine.issueMaterialsVariable(db, {
    orderId: po.id,
    body: {
      date: DATE,
      materials: [{ product_id: pZip, qty_actual: 96, reason: 'نیاز کامل' }],
    },
    userId: adminId,
  });
}, 'E_NEGATIVE_STOCK');

// Partial cover via alternate_product_id
const iss = engine.issueMaterialsVariable(db, {
  orderId: po.id,
  body: {
    date: DATE,
    materials: [{
      product_id: pZip,
      qty_actual: 96,
      alternate_product_id: pAlt,
      alternate_qty: 26,
      // reason omitted — engine auto-fills from expand
    }],
  },
  userId: adminId,
});
ok(iss.ok === true, 'issue with alternate ok');

const rows = db.prepare(`
  SELECT product_id, issue_type, qty_actual, qty_standard, substitute_of_product_id, note
  FROM production_material_issues
  WHERE order_id=? AND status='posted'
  ORDER BY id
`).all(po.id);

const prim = rows.find((r) => Number(r.product_id) === pZip);
const sub = rows.find((r) => Number(r.product_id) === pAlt);
ok(!!prim && Number(prim.qty_actual) === 70, 'primary issued 70', prim);
ok(!!sub && sub.issue_type === 'substitute', 'alternate issue_type=substitute', sub);
eq('alternate qty 26', Number(sub?.qty_actual), 26);
eq('substitute_of primary', Number(sub?.substitute_of_product_id), pZip);
eq('partial sub SQ=0', Number(sub?.qty_standard), 0);
ok(String(prim?.note || '').includes('جایگزین') || String(sub?.note || '').includes('جایگزین'),
  'reason mentions جایگزین', prim?.note || sub?.note);

const zipStock = db.prepare('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?')
  .get(whRaw, pZip);
const altStock = db.prepare('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?')
  .get(whRaw, pAlt);
eq('zip stock after', Number(zipStock?.qty), 0);
eq('alt stock after', Number(altStock?.qty), 74);

// Full substitute (no primary stock) still gets SQ from BOM (T3-21 style)
const po2 = engine.createOrder(db, {
  product_id: pFg, qty_planned: 1, analysis_type: 'variable',
  bom_id: b.id, date: DATE,
}, adminId);
engine.releaseOrder(db, po2.id, adminId);
db.prepare('UPDATE warehouse_stock SET qty=0 WHERE warehouse_id=? AND product_id=?').run(whRaw, pZip);
db.prepare('UPDATE products SET stock=0 WHERE id=?').run(pZip);
db.prepare('UPDATE warehouse_stock SET qty=200 WHERE warehouse_id=? AND product_id=?').run(whRaw, pAlt);
db.prepare('UPDATE products SET stock=200 WHERE id=?').run(pAlt);

engine.issueMaterialsVariable(db, {
  orderId: po2.id,
  body: {
    date: DATE,
    materials: [{
      product_id: pAlt,
      qty_actual: 96,
      substitute_of_product_id: pZip,
      reason: 'جایگزین کامل',
    }],
  },
  userId: adminId,
});
const full = db.prepare(`
  SELECT qty_standard, issue_type FROM production_material_issues
  WHERE order_id=? AND product_id=? AND status='posted'
`).get(po2.id, pAlt);
ok(full?.issue_type === 'substitute' && Number(full.qty_standard) > 0, 'full substitute keeps SQ', full);

// Invalid substitute_of
const po3 = engine.createOrder(db, {
  product_id: pFg, qty_planned: 1, analysis_type: 'variable',
  bom_id: b.id, date: DATE,
}, adminId);
engine.releaseOrder(db, po3.id, adminId);
throws('E_SUBSTITUTE_INVALID', () => {
  engine.issueMaterialsVariable(db, {
    orderId: po3.id,
    body: {
      date: DATE,
      materials: [{
        product_id: pAlt,
        qty_actual: 1,
        substitute_of_product_id: 999999,
        reason: 'bad',
      }],
    },
    userId: adminId,
  });
}, 'E_SUBSTITUTE_INVALID');

// Static UI markers
const appPath = path.join(__dirname, '../public/app.js');
const app = fs.readFileSync(appPath, 'utf8');
ok(app.includes('prodIssueAltSearch'), 'UI alt search');
ok(app.includes('alternate_product_id'), 'UI sends alternate_product_id');
ok(app.includes('تأمین کسری از کالای جایگزین'), 'UI auto reason text');
ok(app.includes('E_SUBSTITUTE_INVALID'), 'UI error map');

cleanup();
summary();
