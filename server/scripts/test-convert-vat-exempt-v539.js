/**
 * v539 — convert proforma→firm must preserve vat_exempt + disc_amt;
 * edit UI must hydrate payment amounts without forcing multi-stage.
 * Run: node server/scripts/test-convert-vat-exempt-v539.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const convertSlice = invoicesSrc.slice(
  invoicesSrc.indexOf("router.post('/:id/convert'"),
  invoicesSrc.indexOf("router.get('/:id/print'")
);
ok(convertSlice.includes('convertVatExempt') && convertSlice.includes('vatExempt: convertVatExempt'), 'convert passes vatExempt');
ok(convertSlice.includes('convertDiscAmt') && convertSlice.includes('discAmt: convertDiscAmt'), 'convert passes discAmt');
ok(convertSlice.includes('disc_amt=?') && convertSlice.includes('totals.discAmt'), 'convert UPDATE writes disc_amt');
ok(appJs.includes('function finalizeInvPayHydrate'), 'finalizeInvPayHydrate exists');
ok(appJs.includes('multiNeeded'), 'hydrate uses multiNeeded');
ok(appJs.includes('finalizeInvPayHydrate(inv)'), 'openInvBuilder calls finalizeInvPayHydrate');
ok(!/On edit, always expose multi-stage UI/.test(appJs), 'old force-multi comment removed');
try { new Function(appJs); ok(true, 'app.js parses'); }
catch (e) { ok(false, 'app.js parses', e.message); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-vat-v539-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-convert-vat-v539-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SMS_DISABLED = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

let db;
try {
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB, closeDB } = require('../db');
  initDB();
  db = getDB();
  module.exports._closeDB = closeDB;
} catch (e) {
  console.log('  SKIP sqlite suite (no better-sqlite3 on this Node):', e.message.split('\n')[0]);
  console.log('\nconvert-vat-exempt v539: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد (static-only; full suite on Iran)');
  process.exit(fail ? 1 : 0);
}

const { calcDocTotals } = require('../lib/vat');
const SUB = 197_600_000;
const DISC_PCT = 0.3;
const DISC_AMT = 600_000;
const built = {
  subtotal: SUB,
  rows: [{ product_id: 1, sum: SUB, qty: 1, price: SUB }],
};
const bad = calcDocTotals(db, built, DISC_PCT, {});
ok(bad.final === 216_707_920, 'bug repro: % disc + default VAT → 216707920', bad.final);
const good = calcDocTotals(db, built, DISC_PCT, { vatExempt: true, discAmt: DISC_AMT });
ok(good.final === 197_000_000 && good.vatAmount === 0, 'fix path: exempt+discAmt → 197000000', good);

(async () => {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('vat_rate','10')").run();

    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

    const whId = db.prepare(`
      INSERT INTO warehouses (code, name, warehouse_type, active, allow_negative)
      VALUES ('WH-V539', 'انبار تست v539', 'finished_goods', 1, 1)
    `).run().lastInsertRowid;

    const leaf = '110301000539';
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
      .run(leaf, 'مشتری تست v539', 'asset', '1103', 4);

    const custId = db.prepare(`
      INSERT INTO customers (user_id, biz, owner, phone, status, type, coa_code)
      VALUES (?, 'مشتری v539', 'مالک', '09120000539', 'active', 'عمده‌فروش', ?)
    `).run(admin.id, leaf).lastInsertRowid;

    const prodId = db.prepare(`
      INSERT INTO products (name, code, price, stock, active, vat_class)
      VALUES ('کالای v539', 'SKU-V539', 25500000, 100, 1, 'exempt')
    `).run().lastInsertRowid;

    try {
      db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)')
        .run(whId, prodId, 100);
    } catch (_) {
      db.prepare(`
        INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)
        ON CONFLICT(warehouse_id, product_id) DO UPDATE SET qty=excluded.qty
      `).run(whId, prodId, 100);
    }

    const bankCoa = '1102-v539';
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
      .run(bankCoa, 'بانک v539', 'asset', '1102', 4);
    const bankId = db.prepare(`
      INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک v539','010539',1,?)
    `).run(bankCoa).lastInsertRowid;

    const termId = db.prepare(`
      INSERT INTO pos_terminals (name, terminal_id, bank_id, active) VALUES ('POS v539','TERM-V539',?,1)
    `).run(bankId).lastInsertRowid;

    const rows = [{
      product_id: prodId, name: 'کالای v539', qty: 4, price: 25_500_000,
      sum: 102_000_000, warehouse_id: whId, disc: 0, disc_amount: 0,
    }, {
      product_id: prodId, name: 'کالای v539ب', qty: 4, price: 23_900_000,
      sum: 95_600_000, warehouse_id: whId, disc: 0, disc_amount: 0,
    }];

    const invId = db.prepare(`
      INSERT INTO invoices (
        user_id, cust_id, num, type, date, note, rows,
        subtotal, disc, disc_amt, final, vat_amount, vat_rate,
        subtotal_rial, final_rial, vat_amount_rial,
        pay_type, warehouse_id, vat_exempt, stock_deducted, converted,
        pay_amount_rial, pos_terminal_id, cash_box_id, bank_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      admin.id, custId, 'T-V539-PF', 'proforma', '1405/08/02', 'test v539',
      JSON.stringify(rows),
      SUB, DISC_PCT, DISC_AMT, 197_000_000, 0, 0,
      SUB, 197_000_000, 0,
      'pos_card', whId, 1, 1, 0,
      197_000_000, termId, null, null
    ).lastInsertRowid;

    db.prepare('UPDATE invoices SET pay_splits_json=? WHERE id=?').run(
      JSON.stringify([{ pay_type: 'pos_card', amount: 197_000_000, terminal_id: termId }]),
      invId
    );

    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const token = issueStaffSession(db, admin, {
      device_kind: 'test', device_name: 'convert-vat-v539', device_fingerprint: 'convert-vat-v539-fp',
    }).token;

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/invoices', require('../routes/invoices'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/invoices/${invId}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ target_type: 'normal' }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    ok(res.status === 200, 'convert 200', { status: res.status, data });

    const row = db.prepare('SELECT type, converted, final, final_rial, vat_amount, vat_amount_rial, disc_amt, vat_exempt FROM invoices WHERE id=?').get(invId);
    ok(row && row.type === 'normal' && Number(row.converted) === 1, 'type normal + converted');
    ok(Number(row.final) === 197_000_000 && Number(row.final_rial) === 197_000_000, 'final stays 197000000', row);
    ok(Number(row.vat_amount) === 0 && Number(row.vat_amount_rial) === 0, 'vat stays 0', row);
    ok(Number(row.disc_amt) === DISC_AMT, 'disc_amt preserved', row);
    ok(Number(row.vat_exempt) === 1, 'vat_exempt flag kept');
    ok(Number(row.final) !== 216_707_920, 'not the corrupted VAT total');

    server.close();
    try { closeSessionStore(); } catch (_) {}
  } catch (e) {
    ok(false, 'suite threw', e && (e.stack || e.message));
  } finally {
    try { if (module.exports._closeDB) module.exports._closeDB(); } catch (_) {}
    console.log('\nconvert-vat-exempt v539: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
    process.exit(fail ? 1 : 0);
  }
})();
