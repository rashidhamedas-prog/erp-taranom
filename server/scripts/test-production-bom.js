'use strict';
/**
 * P1 — ۲۴ تست BOM (docs/Production/01-production-formulas.md §21)
 */
const bcrypt = require('bcryptjs');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const { hasPermission } = require('../lib/rbac');

console.log('\n══ P1 BOM Tests ══\n');

const { db, cleanup } = freshDb();

function seedProducts() {
  const run = (name, avg, type, mfg, stock = 1000) => {
    const id = db.prepare(`
      INSERT INTO products (user_id, name, price, stock)
      VALUES (1,?,?,?)
    `).run(name, 0, stock).lastInsertRowid;
    db.prepare(`UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=? WHERE id=?`)
      .run(avg, type, mfg, id);
    return id;
  };
  const p101 = run('مانتو کتان ترمه — سبز', 0, 'finished', 1, 0);
  const p102 = run('شومیز ساتن', 0, 'finished', 1, 0);
  const p201 = run('پارچه کتان ۱۴۰', 950000, 'raw', 0, 620);
  const p202 = run('آستر ساده', 180000, 'raw', 0, 80);
  const p203 = run('نخ دوخت', 85000, 'raw', 0, 100);
  const p204 = run('دکمه چوبی', 12000, 'raw', 0, 100);
  const p205 = run('لیبل ترنم', 6000, 'packaging', 0, 100);
  const p206 = run('نایلون', 9000, 'packaging', 0, 100);
  const pA = run('نیمه‌ساخته A', 100000, 'semi', 1, 0);
  const pB = run('نیمه‌ساخته B', 100000, 'semi', 1, 0);
  const pFab1 = run('پارچه سبز', 900000, 'raw', 0, 10);
  const pFab2 = run('پارچه یشمی', 880000, 'raw', 0, 5000);
  const pFab3 = run('پارچه آبی', 870000, 'raw', 0, 5000);
  return { p101, p102, p201, p202, p203, p204, p205, p206, pA, pB, pFab1, pFab2, pFab3 };
}

const P = seedProducts();
const adminId = 1;
const SIZE_BREAKDOWN = { '38': 30, '40': 60, '42': 80, '44': 70, '46': 40, '48': 20 };
const SIZE_MATRIX = { '38': 1.45, '40': 1.50, '42': 1.55, '44': 1.60, '46': 1.70, '48': 1.80 };

function makeLines(fabricId) {
  return [
    { component_product_id: fabricId || P.p201, qty_per_base: 1.60, scrap_percent: 4, line_type: 'material',
      size_matrix: JSON.stringify(SIZE_MATRIX) },
    { component_product_id: P.p202, qty_per_base: 0.35, scrap_percent: 3, line_type: 'material' },
    { component_product_id: P.p203, qty_per_base: 0.08, scrap_percent: 0, line_type: 'material' },
    { component_product_id: P.p204, qty_per_base: 6, scrap_percent: 2, line_type: 'material' },
    { component_product_id: P.p205, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging' },
    { component_product_id: P.p206, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging' },
  ];
}

// T1-01
let bom1;
try {
  bom1 = bom.createBom(db, {
    product_id: P.p101, name: 'BOM ترمه', yield_percent: 97, base_qty: 1, lines: makeLines(),
  }, adminId);
  ok('T1-01 ایجاد BOM ساده', bom1.status === 'draft' && bom1.id);
} catch (e) {
  ok('T1-01 ایجاد BOM ساده', false, e.message);
}

// T1-02
try {
  const r = bom.activateBom(db, bom1.id, '1405/01/01', adminId);
  const row = db.prepare('SELECT status, default_bom_id FROM bom_headers bh JOIN products p ON p.id=bh.product_id WHERE bh.id=?').get(bom1.id);
  const prod = db.prepare('SELECT default_bom_id FROM products WHERE id=?').get(P.p101);
  ok('T1-02 فعال‌سازی', r.ok && db.prepare('SELECT status FROM bom_headers WHERE id=?').get(bom1.id).status === 'active'
    && prod.default_bom_id === bom1.id);
} catch (e) {
  ok('T1-02 فعال‌سازی', false, e.message);
}

// T1-03
throws('T1-03 ویرایش فعال ممنوع', () => {
  const line = db.prepare('SELECT id FROM bom_lines WHERE bom_id=? LIMIT 1').get(bom1.id);
  bom.updateLine(db, bom1.id, line.id, { qty_per_base: 2 }, adminId);
}, 'E_BOM_LOCKED');

// T1-04
let bom2;
try {
  bom2 = bom.versionUpBom(db, bom1.id, 'اصلاح مصرف', adminId);
  const lines = db.prepare('SELECT COUNT(*) c FROM bom_lines WHERE bom_id=?').get(bom2.id).c;
  ok('T1-04 نسخه جدید', bom2 && bom2.id && Number(lines) === 6 && Number(bom2.version) >= 2);
} catch (e) {
  ok('T1-04 نسخه جدید', false, e.message);
}

// T1-05
try {
  bom.activateBom(db, bom2.id, '1405/05/01', adminId);
  const v1 = db.prepare('SELECT status, valid_to FROM bom_headers WHERE id=?').get(bom1.id);
  const v2 = db.prepare('SELECT status FROM bom_headers WHERE id=?').get(bom2.id);
  ok('T1-05 فعال‌سازی v2', v1.status === 'archived' && v1.valid_to === '1405/04/31' && v2.status === 'active');
} catch (e) {
  ok('T1-05 فعال‌سازی v2', false, e.message);
}

// T1-06 / T1-07
try {
  const r1 = bom.resolveBom(db, { productId: P.p101, date: '1405/03/10' });
  ok('T1-06 حل نسخه تاریخی', r1.id === bom1.id);
} catch (e) {
  ok('T1-06 حل نسخه تاریخی', false, e.message);
}
try {
  const r2 = bom.resolveBom(db, { productId: P.p101, date: '1405/05/10' });
  ok('T1-07 حل نسخه جاری', r2.id === bom2.id);
} catch (e) {
  ok('T1-07 حل نسخه جاری', false, e.message);
}

// T1-08 explode without matrix — use a line without size_matrix
try {
  // Create dedicated BOM without matrix for fabric
  const plain = bom.createBom(db, {
    product_id: P.p102, name: 'plain', yield_percent: 97, lines: [
      { component_product_id: P.p201, qty_per_base: 1.60, scrap_percent: 4, line_type: 'material' },
    ],
  }, adminId);
  bom.activateBom(db, plain.id, '1405/01/01', adminId);
  const ex = bom.explodeBom(db, { bomId: plain.id, qty: 300 });
  const fabric = ex.lines.find(l => l.product_id === P.p201);
  eq('T1-08 Explode بدون ماتریس', fabric.qty_final, 515.46, 0.01);
} catch (e) {
  ok('T1-08 Explode بدون ماتریس', false, e.message);
}

// T1-09 with matrix — use bom2 (active) which has size_matrix on fabric line
try {
  const ex = bom.explodeBom(db, { bomId: bom2.id, qty: 300, sizeBreakdown: SIZE_BREAKDOWN });
  const fabric = ex.lines.find(l => l.product_id === P.p201);
  eq('T1-09 Explode با ماتریس', fabric.qty_final, 508.48, 0.01);
} catch (e) {
  ok('T1-09 Explode با ماتریس', false, e.message);
}

// T1-10 self-ref
throws('T1-10 خودارجاعی', () => {
  const d = bom.createBom(db, { product_id: P.p101, name: 'self' }, adminId);
  bom.addLine(db, d.id, { component_product_id: P.p101, qty_per_base: 1 }, adminId);
}, 'E_BOM_SELF_REF');

// T1-11 circular
try {
  const ba = bom.createBom(db, {
    product_id: P.pA, name: 'A', lines: [{ component_product_id: P.pB, qty_per_base: 1, line_type: 'material' }],
  }, adminId);
  const bb = bom.createBom(db, {
    product_id: P.pB, name: 'B', lines: [{ component_product_id: P.pA, qty_per_base: 1, line_type: 'material' }],
  }, adminId);
  throws('T1-11 حلقه دو سطحی', () => bom.validateBom(db, ba.id), 'E_BOM_CIRCULAR');
} catch (e) {
  ok('T1-11 حلقه دو سطحی', false, e.message);
}

// T1-12 scrap 100
throws('T1-12 ضایعات ۱۰۰٪', () => {
  const d = bom.createBom(db, { product_id: P.p101, name: 'scrap' }, adminId);
  bom.addLine(db, d.id, { component_product_id: P.p201, qty_per_base: 1, scrap_percent: 100 }, adminId);
}, 'E_BOM_SCRAP_RANGE');

// T1-13 overlap
try {
  const v3 = bom.versionUpBom(db, bom2.id, 'overlap test', adminId);
  throws('T1-13 هم‌پوشانی بازه', () => bom.activateBom(db, v3.id, '1405/04/15', adminId), 'E_BOM_OVERLAP');
} catch (e) {
  ok('T1-13 هم‌پوشانی بازه', false, e.message);
}

// T1-14 where-used
try {
  const rows = bom.whereUsed(db, P.p201);
  ok('T1-14 Where-Used', rows.some(r => r.id === bom1.id || r.id === bom2.id));
} catch (e) {
  ok('T1-14 Where-Used', false, e.message);
}

// T1-15 empty activate
throws('T1-15 فرمول بدون قلم', () => {
  const d = bom.createBom(db, { product_id: P.p101, name: 'empty' }, adminId);
  bom.activateBom(db, d.id, '1405/06/01', adminId);
}, 'E_BOM_EMPTY');

// T1-16 archive in use
try {
  db.prepare(`
    INSERT INTO production_orders (order_no, product_id, bom_id, analysis_type, qty_planned, date, status)
    VALUES ('PO-TEST-1', ?, ?, 'fixed', 10, '1405/05/15', 'in_progress')
  `).run(P.p101, bom2.id);
  throws('T1-16 archive با سفارش باز', () => bom.archiveBom(db, bom2.id, 'test', adminId), 'E_BOM_IN_USE');
} catch (e) {
  ok('T1-16 archive با سفارش باز', false, e.message);
}

// T1-17 concurrent version-up
try {
  // close open order first so version-up from active works — bom2 still active
  db.prepare("UPDATE production_orders SET status='closed' WHERE order_no='PO-TEST-1'").run();
  const a = bom.versionUpBom(db, bom2.id, 'parallel-a', adminId);
  const b = bom.versionUpBom(db, bom2.id, 'parallel-b', adminId);
  ok('T1-17 نسخه همزمان', a.id !== b.id && a.version !== b.version);
} catch (e) {
  ok('T1-17 نسخه همزمان', false, e.message);
}

// T1-18 substitute group
try {
  const d = bom.createBom(db, {
    product_id: P.pA, name: 'sub', yield_percent: 100, lines: [
      { component_product_id: P.pFab1, qty_per_base: 1, scrap_percent: 0, line_type: 'material',
        substitute_group: 'fabric', substitute_priority: 1 },
      { component_product_id: P.pFab2, qty_per_base: 1, scrap_percent: 0, line_type: 'material',
        substitute_group: 'fabric', substitute_priority: 2 },
      { component_product_id: P.pFab3, qty_per_base: 1, scrap_percent: 0, line_type: 'material',
        substitute_group: 'fabric', substitute_priority: 3 },
    ],
  }, adminId);
  bom.activateBom(db, d.id, '1405/01/01', adminId);
  const ex = bom.explodeBom(db, { bomId: d.id, qty: 100 });
  // pFab1 stock=10, need=100 → should pick pFab2 (stock 5000)
  ok('T1-18 گروه جایگزین', ex.lines.length === 1 && ex.lines[0].product_id === P.pFab2);
} catch (e) {
  ok('T1-18 گروه جایگزین', false, e.message);
}

// T1-19 no active bom
throws('T1-19 بدون BOM فعال', () => bom.resolveBom(db, { productId: 99999, date: '1405/01/01' }), 'E_NO_ACTIVE_BOM');

// T1-20 permission
{
  const hash = bcrypt.hashSync('OpTest1234', 10);
  const opId = db.prepare(
    "INSERT INTO users (name,username,password,role,active) VALUES ('اپراتور','prod_op',?,'production_operator',1)"
  ).run(hash).lastInsertRowid;
  const allowed = hasPermission(db, { id: opId, role: 'production_operator' }, 'production_bom', 'approve');
  ok('T1-20 مجوز', allowed === false);
}

// T1-21 std cost
try {
  const sc = bom.stdCost(db, bom2.id, { qty: 1, priceBasis: 'average' });
  const manual = bom.explodeBom(db, { bomId: bom2.id, qty: 1, priceBasis: 'average' });
  eq('T1-21 بهای استاندارد', sc.total_rial, manual.totals.total_rial, 0);
} catch (e) {
  ok('T1-21 بهای استاندارد', false, e.message);
}

// T1-22 clone
try {
  const c = bom.cloneBom(db, bom2.id, { product_id: P.p102, name: 'cloned' }, adminId);
  const lines = db.prepare('SELECT COUNT(*) c FROM bom_lines WHERE bom_id=?').get(c.id).c;
  const hdr = db.prepare('SELECT product_id, status FROM bom_headers WHERE id=?').get(c.id);
  ok('T1-22 Clone', c.status === 'draft' && lines === 6 && hdr.product_id === P.p102);
} catch (e) {
  ok('T1-22 Clone', false, e.message);
}

// T1-23 product in bom
throws('T1-23 حذف کالای درگیر', () => bom.assertProductNotInBom(db, P.p201), 'E_PRODUCT_IN_BOM');

// T1-24 sync tables include bom
{
  const { SYNCABLE_TABLES } = require('../sync/tables');
  const names = SYNCABLE_TABLES.map(t => t.name);
  ok('T1-24 Sync', names.includes('bom_headers') && names.includes('bom_lines'));
}

// T1-25 yield range
throws('T1-25 yield صفر', () => {
  const d = bom.createBom(db, { product_id: P.p102, name: 'yield0', yield_percent: 0 }, adminId);
  bom.addLine(db, d.id, { component_product_id: P.p201, qty_per_base: 1, line_type: 'material' }, adminId);
  bom.activateBom(db, d.id, '1405/06/01', adminId);
}, 'E_BOM_YIELD_RANGE');

// T1-26 duplicate line
throws('T1-26 قلم تکراری', () => {
  const d = bom.createBom(db, {
    product_id: P.p102, name: 'dup', yield_percent: 100,
    lines: [
      { component_product_id: P.p201, qty_per_base: 1, line_type: 'material' },
      { component_product_id: P.p201, qty_per_base: 2, line_type: 'material' },
    ],
  }, adminId);
  bom.activateBom(db, d.id, '1405/06/01', adminId);
}, 'E_BOM_DUP_LINE');

// T1-27 qty zero
throws('T1-27 مقدار صفر', () => {
  const d = bom.createBom(db, {
    product_id: P.p102, name: 'qty0', yield_percent: 100,
    lines: [{ component_product_id: P.p201, qty_per_base: 0, line_type: 'material' }],
  }, adminId);
  bom.activateBom(db, d.id, '1405/06/01', adminId);
}, 'E_BOM_QTY_ZERO');

cleanup();
summary('P1 BOM');
