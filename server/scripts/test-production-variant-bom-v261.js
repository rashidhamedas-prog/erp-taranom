'use strict';
/**
 * Production variant BOM — harness-based (needs better-sqlite3 matching Node ABI).
 */
const bcrypt = require('bcryptjs');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const { createOrder } = require('../lib/production/engine');

console.log('\n══ Production variant BOM v261 ══\n');

const { db, cleanup } = freshDb();

db.prepare(`INSERT INTO users (id, username, password_hash, name, role) VALUES (1,'admin',?,?, 'admin')`)
  .run(bcrypt.hashSync('x', 4), 'Admin');

try {
  db.exec(`INSERT INTO product_colors (id, name, code, active, sort_order) VALUES
    (1, 'سبز', 'GRN', 1, 1), (2, 'آبی', 'BLU', 1, 2);
  INSERT INTO product_sizes (id, name, code, active, sort_order) VALUES
    (1, '38', '38', 1, 1), (2, '40', '40', 1, 2), (3, '42', '42', 1, 3);`);
} catch (e) {
  console.error('seed colors/sizes failed', e.message);
  process.exit(1);
}

const fg = db.prepare(`INSERT INTO products (user_id, name, price, stock) VALUES (1,'مانتو تست',0,0)`).run().lastInsertRowid;
db.prepare(`UPDATE products SET average_cost_rial=100000, is_manufactured=1, item_type='finished', has_variants=1, unit='عدد' WHERE id=?`).run(fg);
const fab = db.prepare(`INSERT INTO products (user_id, name, price, stock) VALUES (1,'پارچه تست',0,1000)`).run().lastInsertRowid;
db.prepare(`UPDATE products SET average_cost_rial=50000, item_type='raw', unit='متر' WHERE id=?`).run(fab);
const btn = db.prepare(`INSERT INTO products (user_id, name, price, stock) VALUES (1,'دکمه ماتریس',0,500)`).run().lastInsertRowid;
db.prepare(`UPDATE products SET average_cost_rial=1000, item_type='raw', has_variants=1, unit='عدد' WHERE id=?`).run(btn);

db.prepare(`INSERT INTO product_style_colors (product_id, color_id, sort_order) VALUES (?,?,1)`).run(fg, 1);
db.prepare(`INSERT INTO product_style_sizes (product_id, size_id, sort_order) VALUES (?,?,1)`).run(fg, 1);
db.prepare(`INSERT INTO product_style_sizes (product_id, size_id, sort_order) VALUES (?,?,2)`).run(fg, 2);
db.prepare(`INSERT INTO product_style_sizes (product_id, size_id, sort_order) VALUES (?,?,3)`).run(fg, 3);

const insV = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default, stock)
  VALUES (?,?,?,?,1,0,?)
`);
insV.run(fg, 1, 1, 'FG-GRN-38', 0);
insV.run(fg, 1, 2, 'FG-GRN-40', 0);
insV.run(fg, 1, 3, 'FG-GRN-42', 0);
insV.run(btn, 1, 1, 'BTN-GRN-38', 100);
insV.run(btn, 1, 2, 'BTN-GRN-40', 100);
insV.run(btn, 1, 3, 'BTN-GRN-42', 100);

let whRaw = null, whFg = null;
try {
  whRaw = db.prepare(`INSERT INTO warehouses (name, kind) VALUES ('مواد','raw')`).run().lastInsertRowid;
  whFg = db.prepare(`INSERT INTO warehouses (name, kind) VALUES ('محصول','fg')`).run().lastInsertRowid;
} catch (_) { /* ignore */ }

const created = bom.createBom(db, {
  product_id: fg,
  name: 'فرمول واریانت',
  base_qty: 1,
  yield_percent: 100,
  size_range: '38-42',
  color_variant: 'سبز',
  color_id: 1,
  lines: [
    {
      component_product_id: fab,
      qty_per_base: 1.5,
      scrap_percent: 0,
      line_type: 'material',
      size_matrix: { '38': 1.4, '40': 1.5, '42': 1.6 },
    },
    {
      component_product_id: btn,
      qty_per_base: 1,
      scrap_percent: 0,
      line_type: 'material',
      component_color_mode: 'inherit_fg',
    },
  ],
}, 1);
ok('createBom', !!created.id);

const got = bom.getBom(db, created.id);
ok('persists color_id', Number(got.color_id) === 1);
ok('persists size_matrix', String(got.lines[0].size_matrix || '').includes('38'));
ok('persists color_mode', got.lines[1].component_color_mode === 'inherit_fg');

throws('invalid size key', () => {
  bom.addLine(db, created.id, {
    component_product_id: fab,
    qty_per_base: 1,
    size_matrix: { '99': 2 },
  }, 1);
}, 'E_BOM_SIZE_MATRIX');

bom.activateBom(db, created.id, '1405/01/01', 1);
ok('activate', true);

const ex = bom.explodeBom(db, {
  bomId: created.id,
  qty: 3,
  sizeBreakdown: { '38': 1, '40': 1, '42': 1 },
  color: 'سبز',
  priceBasis: 'average',
});
const fabLine = ex.lines.find(l => l.product_id === fab);
const btnLine = ex.lines.find(l => l.product_id === btn);
eq('fabric from size_matrix', fabLine?.qty_final, 1.4 + 1.5 + 1.6, 1e-6);
ok('size_matrix_applied', !!fabLine?.size_matrix_applied);
ok('button variant hints', !!(btnLine && btnLine.variant_lines && btnLine.variant_lines.length === 3));

const alt = bom.createAlternative(db, created.id, 'جایگزین', 1);
const altBom = bom.getBom(db, alt.id);
ok('alt copies color_variant', altBom.color_variant === 'سبز');
ok('alt copies color_id', Number(altBom.color_id) === 1);

throws('PO matrix without color', () => {
  createOrder(db, { product_id: fg, qty_planned: 5, analysis_type: 'fixed', date: '1405/01/10' }, 1);
}, 'E_VARIANT');

const po = createOrder(db, {
  product_id: fg,
  qty_planned: 3,
  analysis_type: 'fixed',
  date: '1405/01/10',
  color: 'سبز',
  size_breakdown: { '38': 1, '40': 1, '42': 1 },
  warehouse_raw_id: whRaw,
  warehouse_fg_id: whFg,
}, 1);
eq('PO qty from breakdown', po.qty_planned, 3);
ok('PO color', po.color === 'سبز');

cleanup();
summary();
