/**
 * P1 — Kardex SSOT: stock only moves through documents; colors survive adjustments; real negatives.
 *  - PUT /products ignores stock (different value → 409 E_STOCK_VIA_DOCUMENT; ledger/ws untouched)
 *  - PATCH /products/:id/stock = postAdjust(count): warehouse_id required, variant_id for matrix
 *  - POST /product-variants/stock-matrix: each CHANGED cell → one ledger row with variant_id + JE
 *  - manual adjust stamps inventory_ledger.variant_id (kardex variant filter sees it)
 *  - retireZeroStockColors: only when every size is EXACTLY 0 (S=-1,M=+1 stays); no stock=0 wipe
 *  - adjust to 0 then +2 → color active again, both ledger rows under the variant filter
 *  - allow_negative warehouse: sale to -3 → products.stock = ws = -3 (no clamp)
 *  - stockOf (Σ live kardex) = warehouse_stock = Σ variant_warehouse_stock
 * Run: node server/scripts/test-p1-kardex-ssot.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-kardex-ssot-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-p1-kardex-ssot-secret-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
authMw.auth = (req, _res, next) => { req.user = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; next(); };

try { require('../lib/inventory/valuation').ensureValuationSchema(db); } catch (_) { /* optional */ }
const L = require('../lib/inventory/ledger');
const MA = require('../lib/inventory/manual-adjust');
const PV = require('../lib/product-variants');
const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../routes/inventory'));
app.use('/api/products', require('../routes/products'));
app.use('/api/product-variants', require('../routes/product-variants'));

const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const ledgerRows = (pid, extra = '') => db.prepare(
  `SELECT * FROM inventory_ledger WHERE product_id=? ${extra} ORDER BY id`
).all(pid);
const ws = (pid, wh) => Number((q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wh) || {}).qty) || 0;
const vws = (vid, wh) => Number((q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh) || {}).qty) || 0;
const pstock = (pid) => Number((q1('SELECT stock FROM products WHERE id=?', pid) || {}).stock) || 0;

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };

  try {
    // ── fixtures ──
    const W1 = Number(db.prepare("INSERT INTO warehouses (name, allow_negative) VALUES ('انبار یک', 0)").run().lastInsertRowid);
    const W2 = Number(db.prepare("INSERT INTO warehouses (name, allow_negative) VALUES ('انبار منفی‌پذیر', 1)").run().lastInsertRowid);
    const mkProduct = (name, code, extra = '') => Number(db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, warehouse_id)
      VALUES (?, ?, ?, 1000000, 0, 'عدد', 50000, 5000, ?)
    `).run(ADMIN.id, name, code, W1).lastInsertRowid);
    const plain = mkProduct('کالای ساده P1', 'P1-PLAIN');
    const matrix = mkProduct('کالای ماتریسی P1', 'P1-MTX');
    const negP = mkProduct('کالای منفی P1', 'P1-NEG');

    // ── 1. PUT ignores stock / 409 on a different value ──
    console.log('\n[PUT /products — stock only via document]');
    const seed = await call('POST', '/api/inventory/adjust', { product_id: plain, warehouse_id: W1, qty: 10, mode: 'delta', reason_code: 'count_correction', note: 'افتتاحیه تست' });
    ok(seed.status === 200, 'seed 10 via /inventory/adjust', seed.body);
    const ledBefore = ledgerRows(plain).length;
    const wsBefore = ws(plain, W1);
    const put409 = await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1', stock: 99 });
    ok(put409.status === 409 && put409.body && put409.body.code === 'E_STOCK_VIA_DOCUMENT', 'PUT with different stock → 409 E_STOCK_VIA_DOCUMENT', put409);
    ok(ledgerRows(plain).length === ledBefore && ws(plain, W1) === wsBefore && pstock(plain) === 10, 'ledger / ws / products.stock unchanged after 409');
    const putSame = await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1 ویرایش', stock: 10, note: 'x' });
    ok(putSame.status === 200, 'PUT echoing the same stock is accepted', putSame.body);
    const putNone = await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1', note: 'بدون stock' });
    ok(putNone.status === 200 && pstock(plain) === 10 && ws(plain, W1) === 10, 'PUT without stock leaves stock + ws alone');
    const putWh = await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1', warehouse_id: W2, stock: 10 });
    ok(putWh.status === 200 && !q1('SELECT 1 x FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', plain, W2),
      'PUT changing primary warehouse does not seed a phantom warehouse_stock row');
    await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1', warehouse_id: W1 });

    // Excel upsert: the one absolute caller → goes through postAdjust(count) → kardex row
    const excel = await call('PUT', `/api/products/${plain}`, { name: 'کالای ساده P1', stock: 12, excel_upsert: 1, warehouse_id: W1 });
    const exLed = ledgerRows(plain).filter((r) => r.source_type === 'inventory_adjust').pop();
    ok(excel.status === 200 && pstock(plain) === 12 && ws(plain, W1) === 12 && exLed && Number(exLed.qty_in) === 2,
      'Excel upsert stock=12 → +2 via postAdjust (kardex row), not a raw write', { st: excel.status, ex: exLed && exLed.note });
    ok(Number(exLed && exLed.je_id) > 0, 'Excel adjustment carries a JE');

    // ── 2. PATCH /:id/stock → wrapper over postAdjust(count) ──
    console.log('\n[PATCH /products/:id/stock]');
    const noWh = await call('PATCH', `/api/products/${plain}/stock`, { stock: 20 });
    ok(noWh.status === 422 && noWh.body.code === 'E_STOCK_WAREHOUSE_REQUIRED', 'warehouse_id required', noWh);
    const n0 = ledgerRows(plain).length;
    const patch = await call('PATCH', `/api/products/${plain}/stock`, { stock: 20, warehouse_id: W1, note: 'شمارش' });
    const pLed = ledgerRows(plain).slice(n0);
    ok(patch.status === 200 && pLed.length === 1 && pLed[0].event_type === 'adjustment' && Number(pLed[0].qty_in) === 8,
      'exactly ONE adjustment ledger row (+8)', { st: patch.status, rows: pLed.length });
    ok(Number(pLed[0] && pLed[0].je_id) > 0, 'PATCH row has a JE');
    ok(ws(plain, W1) === 20 && L.stockOf(db, { productId: plain, warehouseId: W1 }) === 20, 'ws = Σledger = 20');
    ok(L.stockOf(db, { productId: plain }) === pstock(plain), 'stockOf(company) = products.stock', { s: L.stockOf(db, { productId: plain }), p: pstock(plain) });
    const same = await call('PATCH', `/api/products/${plain}/stock`, { stock: 20, warehouse_id: W1 });
    ok(same.status === 200 && ledgerRows(plain).length === n0 + 1, 'PATCH to the same qty = no-op (no extra row)');

    // ── 3. matrix product: build + PATCH needs variant_id ──
    console.log('\n[matrix: PATCH + stock-matrix + variant_id on ledger]');
    PV.generateMatrix(db, {
      product_id: matrix,
      colors: [{ name: 'مشکی' }, { name: 'سفید' }],
      sizes: [{ name: 'S' }, { name: 'M' }],
    });
    const cId = (n) => q1('SELECT id FROM product_colors WHERE name=?', n).id;
    const sId = (n) => q1('SELECT id FROM product_sizes WHERE name=?', n).id;
    const vOf = (color, size) => q1(
      'SELECT * FROM product_variants WHERE product_id=? AND color_id=? AND size_id=? AND is_default=0',
      matrix, cId(color), sId(size));
    const BS = vOf('مشکی', 'S'); const BM = vOf('مشکی', 'M');
    const WS_ = vOf('سفید', 'S'); const WM = vOf('سفید', 'M');

    const mNoVar = await call('PATCH', `/api/products/${matrix}/stock`, { stock: 5, warehouse_id: W1 });
    ok(mNoVar.status === 422 && mNoVar.body.code === 'E_VARIANT_REQUIRED', 'matrix product PATCH without variant_id → 422', mNoVar);
    const mVar = await call('PATCH', `/api/products/${matrix}/stock`, { stock: 5, warehouse_id: W1, variant_id: BS.id });
    const bsRows = ledgerRows(matrix, `AND variant_id=${BS.id}`);
    ok(mVar.status === 200 && bsRows.length === 1 && Number(bsRows[0].qty_in) === 5, 'PATCH with variant_id → one ledger row stamped with variant_id', mVar.body);
    ok(Number(bsRows[0] && bsRows[0].je_id) > 0 || Number(bsRows[0].amount_rial) === 0, 'variant adjustment has JE', bsRows[0]);
    ok(vws(BS.id, W1) === 5 && L.stockOf(db, { productId: matrix, warehouseId: W1, variantId: BS.id }) === 5, 'vws = Σ ledger(variant)=5');

    // stock-matrix route: one changed cell → one ledger row w/ variant_id
    const cells = (bs, bm, ws_, wm) => [
      { color_id: cId('مشکی'), size_id: sId('S'), qty: bs },
      { color_id: cId('مشکی'), size_id: sId('M'), qty: bm },
      { color_id: cId('سفید'), size_id: sId('S'), qty: ws_ },
      { color_id: cId('سفید'), size_id: sId('M'), qty: wm },
    ];
    const m0 = ledgerRows(matrix).length;
    const mx1 = await call('POST', '/api/product-variants/stock-matrix', { product_id: matrix, warehouse_id: W1, cells: cells(5, 3, 0, 0) });
    const mx1Rows = ledgerRows(matrix).slice(m0);
    ok(mx1.status === 200 && mx1Rows.length === 1 && Number(mx1Rows[0].variant_id) === BM.id && Number(mx1Rows[0].qty_in) === 3,
      'matrix save: only the CHANGED cell (مشکی/M) posts → 1 ledger row with variant_id', { st: mx1.status, rows: mx1Rows.length, body: mx1.body });
    ok(vws(BM.id, W1) === 3 && vws(BS.id, W1) === 5, 'vws matches the changed cell and leaves the other alone');
    const mx2 = await call('POST', '/api/product-variants/stock-matrix', { product_id: matrix, warehouse_id: W1, cells: cells(5, 3, 0, 0) });
    ok(mx2.status === 200 && ledgerRows(matrix).length === m0 + 1, 'saving the unchanged matrix posts nothing');
    const mx3 = await call('POST', '/api/product-variants/stock-matrix', { product_id: matrix, warehouse_id: W1, cells: cells(9, 9, 9, 9), structure_only: true });
    ok(mx3.status === 200 && ledgerRows(matrix).length === m0 + 1 && vws(BS.id, W1) === 5, 'structure_only never writes qty');
    // applyStockMatrix (lib) must not write qty either
    PV.applyStockMatrix(db, matrix, cells(7, 7, 7, 7), { warehouse_id: W1 });
    ok(vws(BS.id, W1) === 5 && ledgerRows(matrix).length === m0 + 1, 'applyStockMatrix() builds structure only (no qty, no ledger)');

    // ── 4. adjust to 0 then +2 → color survives, kardex variant filter sees both rows ──
    console.log('\n[color retire / re-activate]');
    const mx4 = await call('POST', '/api/product-variants/stock-matrix', { product_id: matrix, warehouse_id: W1, cells: cells(5, 3, 3, 0) });
    ok(mx4.status === 200 && vws(WS_.id, W1) === 3, 'سفید/S = 3');
    const toZero = await call('POST', '/api/inventory/adjust', {
      product_id: matrix, warehouse_id: W1, variant_id: WS_.id, mode: 'count', qty: 0, reason_code: 'count_correction', note: 'به صفر',
    });
    ok(toZero.status === 200, 'count سفید/S → 0', toZero.body);
    const whiteAfterZero = db.prepare('SELECT active FROM product_variants WHERE product_id=? AND color_id=?').all(matrix, cId('سفید'));
    ok(whiteAfterZero.every((r) => Number(r.active) === 0), 'all sizes exactly 0 → white retired (soft)', whiteAfterZero);
    ok(Number(q1('SELECT stock FROM product_variants WHERE id=?', WS_.id).stock) === 0, 'retire did not need a stock=0 wipe (already 0)');
    ok(!!q1('SELECT 1 x FROM product_style_colors WHERE product_id=? AND color_id=?', matrix, cId('سفید')), 'product_style_colors NOT deleted (soft)');
    const plus2 = await call('POST', '/api/inventory/adjust', {
      product_id: matrix, warehouse_id: W1, variant_id: WS_.id, mode: 'delta', qty: 2, reason_code: 'count_correction', note: 'برگشت رنگ',
    });
    ok(plus2.status === 200, 'second adjust +2 on the retired color is accepted (no E_VARIANT_INACTIVE)', plus2.body);
    const whiteActive = q1('SELECT active FROM product_variants WHERE id=?', WS_.id);
    ok(Number(whiteActive.active) === 1 && vws(WS_.id, W1) === 2, 'color active again, vws=2');
    const kd = L.getKardex(db, matrix, { variantId: WS_.id, warehouseId: W1 });
    ok(kd.variant_filter_applied && kd.rows.length === 3, 'kardex variant filter shows all 3 rows (+3, −3, +2)', kd.rows.length);
    ok(kd.closing_qty === 2, 'kardex closing for the variant = 2', kd.closing_qty);
    const revPlus2 = await call('POST', `/api/inventory/ledger/${plus2.body.id}/reverse`, {});
    ok(revPlus2.status === 200 && vws(WS_.id, W1) === 0, 'reverse of the +2 adjust restores the variant layer', revPlus2.body);
    const revRow = q1("SELECT * FROM inventory_ledger WHERE reversed_of=?", plus2.body.id);
    ok(revRow && Number(revRow.variant_id) === WS_.id, 'reversal row keeps variant_id (R13 consistent)');

    // ── 5. S=-1, M=+1 → color NOT retired, S stays -1 ──
    console.log('\n[Σ=0 with negatives]');
    const negM = mkProduct('کالای ماتریسی منفی P1', 'P1-MTX2');
    PV.generateMatrix(db, { product_id: negM, colors: [{ name: 'قرمز' }], sizes: [{ name: 'S' }, { name: 'M' }] });
    const rS = q1('SELECT * FROM product_variants WHERE product_id=? AND is_default=0 ORDER BY id LIMIT 1', negM);
    const rM = q1('SELECT * FROM product_variants WHERE product_id=? AND is_default=0 ORDER BY id DESC LIMIT 1', negM);
    const a1 = await call('POST', '/api/inventory/adjust', { product_id: negM, warehouse_id: W2, variant_id: rS.id, mode: 'delta', qty: -1, reason_code: 'count_correction' });
    const a2 = await call('POST', '/api/inventory/adjust', { product_id: negM, warehouse_id: W2, variant_id: rM.id, mode: 'delta', qty: 1, reason_code: 'count_correction' });
    ok(a1.status === 200 && a2.status === 200, 'S −1 / M +1 posted in the allow_negative warehouse', [a1.body, a2.body]);
    const redRows = db.prepare('SELECT id, active, stock FROM product_variants WHERE product_id=? AND is_default=0 ORDER BY id').all(negM);
    ok(redRows.every((r) => Number(r.active) === 1), 'color NOT retired when Σ=0 but sizes are −1/+1', redRows);
    ok(Number(redRows[0].stock) === -1 && vws(rS.id, W2) === -1, 'S stays −1 (no clamp, no stock=0 wipe)', redRows[0]);
    ok(PV.retireZeroStockColors(db, negM).retired.length === 0, 'retireZeroStockColors() explicit call also keeps it');

    // ledger-only protection: pv=0/vws=0 but kardex Σ≠0 for the SKU → not retired
    const ghostM = mkProduct('کالای ماتریسی شبح P1', 'P1-MTX3');
    PV.generateMatrix(db, { product_id: ghostM, colors: [{ name: 'آبی' }], sizes: [{ name: 'S' }] });
    const gV = q1('SELECT * FROM product_variants WHERE product_id=? AND is_default=0', ghostM);
    db.prepare(`INSERT INTO inventory_ledger (tx_no,event_type,product_id,warehouse_id,variant_id,qty_in,qty_out,qty_balance,unit_cost_rial,amount_rial,status,date)
      VALUES ('GHOST-1','adjustment',?,?,?,4,0,4,1000,4000,'posted','1405/08/08')`).run(ghostM, W1, gV.id);
    ok(PV.retireZeroStockColors(db, ghostM).retired.length === 0, 'kardex Σ≠0 for the SKU blocks retirement even when pv/vws are 0');

    // ── 6. allow_negative: sale to -3 ──
    console.log('\n[allow_negative warehouse]');
    const sale = L.postInventoryMovement(db, {
      eventType: 'sale', productId: negP, warehouseId: W2, qty: -3, sourceType: 'invoice', sourceId: 777001, date: '1405/08/08', createdBy: ADMIN.id,
    });
    ok(sale && sale.qty_out === 3, 'sale of 3 with 0 on hand allowed in allow_negative warehouse', sale);
    ok(pstock(negP) === -3 && ws(negP, W2) === -3, 'products.stock = −3 and ws = −3 (no Math.max(0) clamp)', { p: pstock(negP), w: ws(negP, W2) });
    ok(L.stockOf(db, { productId: negP, warehouseId: W2 }) === -3, 'stockOf = −3');
    let blocked = false;
    try { L.postInventoryMovement(db, { eventType: 'sale', productId: plain, warehouseId: W1, qty: -999, sourceType: 'invoice', sourceId: 777002, date: '1405/08/08' }); } catch (e) { blocked = e.code === 'E_NEGATIVE_STOCK'; }
    ok(blocked, 'a normal warehouse still rejects overselling (E_NEGATIVE_STOCK)');

    // ── 7. SSOT: stockOf = ws = Σvws; layer reconcile shows no drift for new movements ──
    console.log('\n[SSOT reconciliation]');
    for (const wh of [W1, W2]) {
      const vSum = Number((q1(`SELECT COALESCE(SUM(v.qty),0) s FROM variant_warehouse_stock v JOIN product_variants pv ON pv.id=v.variant_id
        WHERE pv.product_id=? AND v.warehouse_id=? AND pv.is_default=0`, matrix, wh) || {}).s) || 0;
      ok(L.stockOf(db, { productId: matrix, warehouseId: wh }) === ws(matrix, wh) && ws(matrix, wh) === vSum,
        `matrix product @W${wh}: stockOf = ws = Σvws`, { s: L.stockOf(db, { productId: matrix, warehouseId: wh }), w: ws(matrix, wh), v: vSum });
    }
    ok(L.stockOf(db, { productId: matrix }) === pstock(matrix), 'matrix product: stockOf(company) = products.stock');
    ok(L.stockOf(db, { productId: negM, warehouseId: W2 }) === ws(negM, W2) && ws(negM, W2) === 0, 'negM: Σ(−1,+1) = ws = 0');
    const rec = computeLayerReconcile(db, { onlyDrift: true });
    const mine = rec.rows.filter((r) => r.drift_any && [plain, matrix, negP, negM].includes(r.product_id));
    ok(mine.length === 0, 'تطبیق موجودی: no warehouse≠kardex / variant≠vws drift for P1 movements', mine.map((r) => ({ p: r.product_id, w: r.warehouse_id, f: r.flags })));
    ok(rec.summary.pv_vs_vws_variants === 0, 'variant (pv) ≠ vws mismatches = 0', rec.exceptions.variant_mismatches);

    // ── 8. manual-adjust unit-level: variant_id on the ledger row ──
    const direct = MA.postAdjust(db, { product_id: matrix, variant_id: BM.id, warehouse_id: W1, mode: 'delta', qty: 1, reason_code: 'count_correction' }, ADMIN);
    ok(Number(q1('SELECT variant_id v FROM inventory_ledger WHERE id=?', direct.id).v) === BM.id, 'postAdjust stamps variant_id on the ledger row');

    // ── 9. static: UI contract ──
    console.log('\n[UI contract]');
    const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
    ok(/\.neg-qty\s*\{/.test(css), 'app.css defines .neg-qty');
    ok(appJs.includes('neg-qty'), 'app.js renders negatives with neg-qty');
    ok(/id="p-stock"[^>]*\$\{p\.id\?'readonly'/.test(appJs) || appJs.includes('pfv2-stock-adjust-btn'), 'p-stock is read-only on edit + adjust button');
    ok(/structure_only:\s*true/.test(appJs) && !appJs.includes('structure_only:!!id'), 'product form save always sends structure_only matrix (no qty)');
    ok(!/fd\.append\('stock'/.test(appJs), 'product form never sends stock (opening via opening stock table)');
    ok(!/Math\.max\(0, Math\.round\(parseQty\(inp\.value, 0\)\)\)/.test(appJs), 'matrix collector no longer clamps negatives to 0');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
