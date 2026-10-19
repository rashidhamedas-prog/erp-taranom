/**
 * v486 — measurement catalog: dimension, UNECE factor, product link, no cross-dimension convert.
 * Run: node server/scripts/test-uom-v486.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uom-v486-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-uom-v486-secret-32bytes-minimum';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const uom = require('../lib/uom');
const { requiresIntegerQty } = require('../lib/inventory/qty-policy');
const cutting = require('../lib/production/cutting');
const { isMeterProductUnit, resolveReceiptProfile } = require('../lib/inventory/fabric-rolls');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const yd = db.prepare("SELECT * FROM units_of_measure WHERE code='YD'").get();
const m = db.prepare("SELECT * FROM units_of_measure WHERE code='M'").get();
const pcs = db.prepare("SELECT * FROM units_of_measure WHERE code='PCS'").get();
const set = db.prepare("SELECT * FROM units_of_measure WHERE code='SET'").get();
const pair = db.prepare("SELECT * FROM units_of_measure WHERE code='PAIR'").get();

ok(!!yd && yd.unece_code === 'YRD' && yd.dimension === 'length', 'yard seeded as length YRD');
ok(Math.abs(Number(yd.factor_to_ref) - 0.9144) < 1e-9, '1 yard = 0.9144 metre');
ok(m && m.is_reference === 1 && m.unece_code === 'MTR', 'metre is length reference');
ok(pcs && pcs.decimal_places === 0 && pcs.unece_code === 'H87', 'piece is integer H87');
ok(set && set.factor_to_ref == null && pair && pair.factor_to_ref == null, 'set and pair have no global factor');

ok(uom.convertBetween(yd, m, 1) === 0.9144, 'convert 1 yd to m');
let blocked = false;
try { uom.convertBetween(pcs, m, 1); } catch (e) { blocked = e.code === 'E_UOM_DIMENSION'; }
ok(blocked, 'piece to metre is rejected');
blocked = false;
try { uom.convertBetween(set, pcs, 1); } catch (e) { blocked = e.code === 'E_UOM_NOT_CONVERTIBLE'; }
ok(blocked, 'set does not convert to piece');

const linked = db.prepare(`
  SELECT p.unit_id, u.code FROM products p
  JOIN units_of_measure u ON u.id=p.unit_id
  WHERE TRIM(COALESCE(p.unit,'')) != ''
  LIMIT 1
`).get();
ok(!linked || !!linked.code, 'linked products point at a catalog row');

const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
const meterId = db.prepare(`
  INSERT INTO products (user_id,name,code,unit,price,cost,stock)
  VALUES (?,?,?,?,0,0,0)
`).run(admin.id, 'پارچه تست یارد', 'UOM-YD-1', 'یارد').lastInsertRowid;
uom.bootstrap(db);
const again = db.prepare('SELECT unit_id, unit FROM products WHERE id=?').get(meterId);
ok(Number(again.unit_id) === Number(yd.id) && again.unit === 'یارد', 'free-text یارد links without renaming', again);

ok(requiresIntegerQty(db, meterId) === false, 'yard product allows decimals');
ok(requiresIntegerQty(db, null, 'عدد') === true, 'عدد stays integer');
ok(cutting.isMeterUnit('یارد') && cutting.isMeterUnit('متر') && !cutting.isMeterUnit('عدد'), 'cutting treats yard as length');
ok(isMeterProductUnit('یارد') && resolveReceiptProfile({ unit: 'یارد' }, {}) === 'fabric', 'fabric receipt accepts yard');
ok(resolveReceiptProfile({ unit: 'عدد' }, {}) === 'attr', 'piece stays attributed material');

const input = uom.normalizeUnitInput({ code: 'CM', name: 'سانتی‌متر', dimension: 'length', factor_to_ref: 0.01, decimal_places: 3 }, null);
ok(input.unece_code == null && input.factor_to_ref === 0.01, 'custom centimetre keeps its factor', input);

console.log(fail ? `FAIL ${fail}/${pass + fail}` : `OK ${pass}`);
process.exit(fail ? 1 : 0);
