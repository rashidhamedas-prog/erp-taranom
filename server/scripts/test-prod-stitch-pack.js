/**
 * PROD-STITCH-P5C — PACK FG from cutting lay + fabric re-issue lock + R13 void.
 * Run: node server/scripts/test-prod-stitch-pack.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-pack-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prod-stitch-pack-secret-32-bytes-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
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
  `).get(code);
  return Math.round(Number(row && row.b) || 0);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'prod-pack', device_fingerprint: 'prod-pack-fp',
  }).token;
  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده پک','sales.pack',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesPk9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test', device_name: 'prod-pack-sales', device_fingerprint: 'prod-pack-sales-fp',
  }).token;
  const pmId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('مدیر تولید پک','pm.pack',?, 'production_manager', 1, 0)
  `).run(bcrypt.hashSync('PmPack9x', 10)).lastInsertRowid;
  const pmUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(pmId);
  const pmTok = issueStaffSession(db, pmUser, {
    device_kind: 'test', device_name: 'prod-pack-pm', device_fingerprint: 'prod-pack-pm-fp',
  }).token;
  const opId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('اپراتور پک','op.pack',?, 'production_operator', 1, 0)
  `).run(bcrypt.hashSync('OpPack9x', 10)).lastInsertRowid;
  const opUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(opId);
  const opTok = issueStaffSession(db, opUser, {
    device_kind: 'test', device_name: 'prod-pack-op', device_fingerprint: 'prod-pack-op-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
  app.use('/api/production/orders', require('../routes/production-orders'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
  ok(!!raw && !!raw.id, 'WH-RAW exists');
  ok(!!fgWh && !!fgWh.id, 'WH-FG exists');
  ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cutting_packs'").get(), 'cutting_packs table');
  ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cutting_pack_bundles'").get(), 'bundles table');

  const fgId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو تست پک', 'PACK-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const fabId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ مشکی پک', 'PACK-FAB', 0, 0, 'متر', 250000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی پک')`).run().lastInsertRowid;

  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 40,
    unit: 'متر', unit_cost_rial: 250000, supplier_id: supId, roll_no: 'R-PACK-1',
    date: '1405/05/29', idempotency_key: 'pack-roll-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive roll 200', rec.data && rec.data.error);

  const bomLib = require('../lib/production/bom');
  const SIZE_MATRIX = { '38': 1.45, '40': 1.50 };
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM پک', base_qty: 1, yield_percent: 100,
  }, admin.id);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.50, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify(SIZE_MATRIX),
  }, admin.id);
  bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);

  const breakdown = { '38': 2, '40': 2 };
  const posted = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
    marker_length_m: 2, ply_count: 3, actual_meters: 7, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 7 }],
    date: '1405/05/29',
    idempotency_key: 'pack-cut-1',
  });
  ok(posted.status === 200 && posted.data && posted.data.id, 'post lay 200', posted.data && posted.data.error);
  const wipAfterCut = gl('1111');
  const wasteAfterCut = gl('5221');
  const rawAfterCut = gl('1110');
  const rollAfterCut = Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand);
  ok(rollAfterCut === 33, 'roll 33m after cut');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 0, 'FG 0 before PACK');

  const engine = require('../lib/production/engine');
  let po;
  try {
    po = engine.createOrder(db, {
      product_id: fgId, qty_planned: 4, analysis_type: 'variable',
      date: '1405/05/29', warehouse_raw_id: raw.id, warehouse_fg_id: fgWh.id,
      size_breakdown: breakdown, bom_id: bom.id,
    }, admin.id);
    engine.releaseOrder(db, po.id, admin.id);
    ok(true, 'PO created+released');
  } catch (e) {
    ok(false, 'PO create/release', e && e.message);
  }
  if (po) {
    let issueCode = null;
    try {
      engine.issueMaterialsVariable(db, {
        orderId: po.id,
        body: {
          date: '1405/05/29', qty_started: 4,
          materials: [{ product_id: fabId, qty_actual: 7, batch_id: rec.data.id, reason: 'تست قفل' }],
        },
        userId: admin.id,
      });
    } catch (e) {
      issueCode = e.code || e.message;
    }
    ok(issueCode === 'E_FABRIC_ALREADY_CUT', 'issue same 7m → 409 E_FABRIC_ALREADY_CUT', issueCode);
    const linked = await api('POST', `/api/production/cutting-lays/${posted.data.id}/link-order`, {
      production_order_id: po.id,
    });
    ok(linked.status === 200 && Number(linked.data.production_order_id) === Number(po.id), 'link optional production_order_id');
  }

  const salesPack = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    idempotency_key: 'pack-sales',
  }, salesTok);
  ok(salesPack.status === 403, 'field_sales pack 403');

  const noKey = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {});
  ok(noKey.status === 400, 'pack missing key 400');

  const packed = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    warehouse_id: fgWh.id,
    date: '1405/05/29',
    idempotency_key: 'pack-1',
  }, opTok);
  ok(packed.status === 200 && packed.data && packed.data.id, 'PACK 200', packed.data && packed.data.error);
  ok(packed.data && packed.data.status === 'posted', 'pack posted');
  ok(!(packed.data && (packed.data.amount_rial != null || packed.data.unit_cost_rial != null || packed.data.wip_net_rial != null)),
    'operator pack JSON has no *_rial', packed.data);
  ok(!JSON.stringify(packed.data || {}).includes('_rial'), 'operator pack nested JSON has no *_rial');
  const pmSee = await api('GET', `/api/production/cutting-lays/${posted.data.id}/pack`, null, pmTok);
  ok(pmSee.status === 200 && pmSee.data && pmSee.data.amount_rial != null, 'production_manager pack JSON keeps amount_rial');
  ok(Array.isArray(packed.data && packed.data.bundles) && packed.data.bundles.length >= 2, 'bundles per size');
  ok((packed.data.bundles || []).every((b) => b.barcode && b.status === 'posted'), 'bundle barcodes posted');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 4, 'FG stock 4 after PACK');
  const rollAfterPack = Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand);
  ok(rollAfterPack === 33, 'PACK does not consume more roll', rollAfterPack);
  const fgLed = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE source_type='cutting_pack' AND event_type='production_receipt' AND status='posted'
    ORDER BY id DESC LIMIT 1
  `).get();
  ok(!!fgLed && Number(fgLed.qty_in) === 4, 'FG ledger qty 4');
  ok(fgLed && (fgLed.batch_id == null || fgLed.batch_id === 0) && (fgLed.serial_id == null || fgLed.serial_id === 0),
    'FG ledger has no batch/serial', fgLed);
  ok(fgLed && Number(fgLed.warehouse_id) === Number(fgWh.id), 'FG ledger WH-FG');
  ok(gl('1111') === 0, 'lay WIP 0 after PACK', gl('1111'));
  const fgGl = gl('1104');
  ok(fgGl === wipAfterCut, 'FG GL = prior lay WIP net', { fgGl, wipAfterCut });
  ok(gl('5221') === wasteAfterCut, 'abnormal waste GL unchanged by PACK');
  ok(gl('1110') === rawAfterCut, 'RAW GL unchanged by PACK');

  const dup = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    idempotency_key: 'pack-1',
  });
  ok(dup.status === 200 && dup.data && dup.data.id === packed.data.id, 'pack idempotent same id');

  const twice = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    idempotency_key: 'pack-2',
  });
  ok(twice.status === 409, 'second pack 409', twice.data);

  const voidLayBlocked = await api('POST', `/api/production/cutting-lays/${posted.data.id}/void`, { reason: 'تست' });
  ok(voidLayBlocked.status === 409, 'void lay while packed 409');

  const adminGet = await api('GET', `/api/production/cutting-lays/${posted.data.id}/pack`);
  ok(adminGet.status === 200 && adminGet.data && adminGet.data.amount_rial != null, 'admin pack has amount_rial');

  const voided = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack/void`, { reason: 'تست' }, pmTok);
  ok(voided.status === 200 && voided.data && voided.data.status === 'reversed', 'void pack reversed');
  ok((voided.data.bundles || []).every((b) => b.status === 'reversed'), 'barcodes reversed');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 0, 'FG restored 0');
  ok(gl('1111') === wipAfterCut, 'lay WIP restored after void PACK', gl('1111'));
  ok(gl('1104') === 0, 'FG GL 0 after void PACK', gl('1104'));
  const void2 = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack/void`, {});
  ok(void2.status === 409, 'second void pack 409');

  const packed2 = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    warehouse_id: fgWh.id,
    date: '1405/05/29',
    idempotency_key: 'pack-repack',
  });
  ok(packed2.status === 200 && packed2.data && packed2.data.status === 'posted', 'repack after void');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 4, 'FG 4 after repack');
  ok(gl('1111') === 0, 'WIP 0 after repack');

  const rawPack = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack/void`, { reason: 'برای تست انبار' });
  ok(rawPack.status === 200, 'void for WH-RAW test');
  const onRaw = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    warehouse_id: raw.id, idempotency_key: 'pack-raw',
  });
  ok(onRaw.status === 400, 'PACK on WH-RAW 400', onRaw.data);

  const packed3 = await api('POST', `/api/production/cutting-lays/${posted.data.id}/pack`, {
    warehouse_id: fgWh.id, idempotency_key: 'pack-final',
  });
  ok(packed3.status === 200, 'final pack 200');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nPROD PACK: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
