/**
 * v468 — void a cutting lay already covered by an order FG receipt.
 * Fabric, lay JE, material issue and that lay's share of the receipt reverse.
 * FG quantity and the completed order stay. A live PACK still blocks the void.
 * Run: node server/scripts/test-cutting-lay-covered-void-v468.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-covered-void-v468-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cut-covered-void-v468-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function gl(code) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS b
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(code);
  return Math.round(Number(row && row.b) || 0);
}

(async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(appJs.includes('voidCuttingLayRow(r.id,'), 'covered rows can void');
  ok(appJs.includes('فقط سهم بهای همین لایه از رسید سفارش کم می‌شود'), 'void confirm names the receipt');
  ok(/erp-taranom-v\d+/.test(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8')), 'sw cache name');
  new Function(appJs);
  ok(true, 'app.js parses');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cut-covered', device_fingerprint: 'cut-covered-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
  ok(!!raw && !!fgWh, 'warehouses');

  const fgId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو پوشش', 'COV-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const fabId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ پوشش', 'COV-FAB', 0, 0, 'متر', 200000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی پوشش')`).run().lastInsertRowid;

  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 50,
    unit: 'متر', unit_cost_rial: 200000, supplier_id: supId, roll_no: 'R-COV-1',
    date: '1405/07/10', idempotency_key: 'cov-roll-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive roll', rec.data && rec.data.error);

  const bomLib = require('../lib/production/bom');
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM covered', base_qty: 1, yield_percent: 100,
  }, admin.id);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.5, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify({ '38': 1.5, '40': 1.5 }),
  }, admin.id);
  db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('38','38',1,1)").run();
  db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('40','40',1,2)").run();
  bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);

  const breakdown = { '38': 2, '40': 2 };
  const posted = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
    marker_length_m: 2, ply_count: 3, actual_meters: 6, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 6 }],
    date: '1405/07/10',
    idempotency_key: 'cov-lay-1',
  });
  ok(posted.status === 200 && posted.data && posted.data.id, 'post lay', posted.data && posted.data.error);
  const layId = posted.data.id;
  const layNo = posted.data.lay_no;
  const oldAmount = Math.round(Number(posted.data.amount_rial) || 0);
  const oldWaste = Math.round(Number(posted.data.waste_amount_rial) || 0);
  const oldNet = Math.max(0, oldAmount - oldWaste);

  const poId = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, bom_id, analysis_type, qty_planned, qty_produced,
       date, status, material_cost_rial, total_cost_rial, unit_cost_rial, abnormal_waste_rial)
    VALUES ('PO-COV-466', ?, ?, 'fixed', 4, 4, '1405/07/10', 'completed', ?, ?, ?, ?)
  `).run(fgId, bom.id, oldAmount, oldNet, oldNet > 0 ? Math.round(oldNet / 4) : 0, oldWaste).lastInsertRowid;
  const receiptId = db.prepare(`
    INSERT INTO production_receipts
      (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
       warehouse_id, date, status, created_by)
    VALUES ('PR-COV-466', ?, ?, 'main', 4, ?, ?, ?, '1405/07/10', 'posted', ?)
  `).run(
    poId, fgId,
    oldNet > 0 ? Math.round(oldNet / 4) : 0,
    oldNet, fgWh.id, admin.id
  ).lastInsertRowid;
  db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(poId, layId);
  db.prepare(`
    INSERT INTO production_material_issues
      (doc_no, order_id, product_id, issue_type, qty_actual, qty_standard,
       unit_cost_rial, std_cost_rial, amount_rial, std_amount_rial,
       warehouse_id, date, status, note, created_by)
    VALUES (?, ?, ?, 'cutting_lay', 6, 6, ?, ?, ?, ?, ?, '1405/07/10', 'posted', ?, ?)
  `).run(
    layNo, poId, fabId,
    oldAmount > 0 ? Math.round(oldAmount / 6) : 0,
    oldAmount > 0 ? Math.round(oldAmount / 6) : 0,
    oldAmount, oldAmount, raw.id,
    `لایه‌چینی ${layNo} — مصرف پارچه مرحله برش`,
    admin.id
  );
  const { postEvent, dr, cr } = require('../lib/production/posting');
  if (oldNet > 0) {
    postEvent(db, {
      event: 'PRD-07',
      sourceId: receiptId,
      date: '1405/07/10',
      description: `رسید تست ${layNo}`,
      createdBy: admin.id,
      lines: [
        dr(db, 'coa_finished_goods', oldNet),
        cr(db, 'coa_wip', oldNet),
      ],
    });
  }
  db.prepare('UPDATE products SET stock=4, average_cost_rial=? WHERE id=?')
    .run(oldNet > 0 ? Math.round(oldNet / 4) : 0, fgId);
  ok(gl('1111') === 0, 'WIP zero before void', gl('1111'));

  db.prepare(`
    INSERT INTO cutting_packs
      (pack_no, lay_id, product_id, warehouse_id, qty, amount_rial, status, date)
    VALUES ('PK-BLOCK-468', ?, ?, ?, 4, 0, 'posted', '1405/07/10')
  `).run(layId, fgId, fgWh.id);
  const blocked = await api('POST', `/api/production/cutting-lays/${layId}/void`, { reason: 'نباید با PACK' });
  ok(blocked.status === 409 && blocked.data && blocked.data.code === 'E_CUT_HAS_PACK', 'live pack blocks void', blocked.data);
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 44, 'roll unchanged while blocked');
  db.prepare("DELETE FROM cutting_packs WHERE pack_no='PK-BLOCK-468'").run();

  const voided = await api('POST', `/api/production/cutting-lays/${layId}/void`, { reason: 'ابطال بعد از رسید' });
  ok(voided.status === 200 && voided.data && voided.data.status === 'reversed', 'covered void', voided.data && (voided.data.error || voided.data.code));
  ok(voided.data && voided.data.lay_no === layNo, 'same lay_no kept');
  const poRow = db.prepare('SELECT status, material_cost_rial FROM production_orders WHERE id=?').get(poId);
  ok(poRow && poRow.status === 'completed', 'order stays completed', poRow && poRow.status);
  ok(poRow && Math.round(Number(poRow.material_cost_rial) || 0) === 0, 'order material cleared', poRow && poRow.material_cost_rial);
  const receipt = db.prepare('SELECT amount_rial, qty, status FROM production_receipts WHERE id=?').get(receiptId);
  ok(Math.round(Number(receipt.amount_rial)) === 0, 'receipt value cleared', receipt.amount_rial);
  ok(Number(receipt.qty) === 4 && receipt.status === 'posted', 'receipt qty stays');
  const stock = db.prepare('SELECT stock FROM products WHERE id=?').get(fgId);
  ok(Number(stock.stock) === 4, 'FG qty unchanged', stock.stock);
  ok(gl('1111') === 0, 'WIP still zero', gl('1111'));
  ok(gl('1104') === 0, 'FG GL cleared', gl('1104'));
  ok(gl('1110') === 50 * 200000, 'raw restored', gl('1110'));
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 50, 'roll restored');
  const mi = db.prepare(`
    SELECT status FROM production_material_issues
    WHERE order_id=? AND issue_type='cutting_lay'
    ORDER BY id DESC LIMIT 1
  `).get(poId);
  ok(mi && mi.status === 'reversed', 'issue reversed', mi && mi.status);
  const again = await api('POST', `/api/production/cutting-lays/${layId}/void`, { reason: 'دوباره' });
  ok(again.status === 409 && again.data && again.data.code === 'E_CUT_REVERSED', 'second void blocked', again.data);
  const listed = await api('GET', '/api/production/cutting-lays');
  const row = ((listed.data && listed.data.rows) || []).find((r) => r.id === layId);
  ok(!row, 'reversed lay leaves the active list');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
