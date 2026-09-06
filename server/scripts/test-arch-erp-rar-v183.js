'use strict';
/**
 * ARCH-ERP-RAR v183: cheque_in hits party books; live pack = colors × sizes;
 * invoice rows keep variant_id; UI contracts for color picker + cheque help.
 */
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'arch-erp-rar-v183-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'arch-erp-rar-v183-secret-32chars!!';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { packSizeFor, generateMatrix, adjustVariantStock } = require('../lib/product-variants');
const prod = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, pack_size, unit)
  VALUES (1, 'مانتو تست', 'STY-V183', 100000, 20, 1, 'عدد')
`).run();
const matrix = generateMatrix(db, {
  product_id: prod.lastInsertRowid,
  colors: [{ name: 'مشکی', code: 'BLK' }, { name: 'سفید', code: 'WHT' }],
  sizes: [{ name: 'M', code: 'M' }, { name: 'L', code: 'L' }],
  stock: 5,
  auto_barcode: true,
});
ok('matrix 4 SKUs', matrix.created.length === 4);
const packAll = packSizeFor(db, prod.lastInsertRowid);
ok('live pack 2×2=4', packAll.pack_size_auto === 4 && packAll.live_colors === 2 && packAll.live_sizes === 2);

const one = db.prepare(`
  SELECT id FROM product_variants WHERE product_id=? AND is_default=0 AND active=1 LIMIT 1
`).get(prod.lastInsertRowid);
adjustVariantStock(db, one.id, 0, 'set');
const packLive = packSizeFor(db, prod.lastInsertRowid);
ok('zero-stock SKU still counted if siblings live', packLive.pack_size_auto >= 1);

const { postChequeInReceipt, isOpeningCheque } = require('../lib/cheque-party-books');
const { acct } = require('../lib/coa-map');
const recv = acct(db, 'coa_receivable');
const notes = acct(db, 'coa_cheques_receivable');
ok('COA notes+AR exist', !!(recv && notes));

const tafsili = '1103v183';
try {
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?,?,?,?,?,1)
  `).run(tafsili, 'تفصیلی چک v183', 'asset', recv.code, 4);
} catch (_) { /* may exist */ }

const custId = db.prepare(`
  INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (1,?,?,?,0)
`).run('مشتری چک v183', '09120001830', tafsili).lastInsertRowid;
const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, full_name, phone, is_active, legacy_table, legacy_id, coa_code)
  VALUES ('P-V183','customer','مشتری چک v183','09120001830',1,'customers',?,?)
`).run(custId, tafsili).lastInsertRowid;
db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(partyId, custId);

const amount = 2_500_000;
const chequeId = db.prepare(`
  INSERT INTO cheque_records (
    direction, cheque_number, issue_date, receive_date, due_date,
    party_name, party_id, customer_id, amount, status, note, created_by_name
  ) VALUES ('in','CH-183','1405/01/01','1405/01/02','1405/02/01',?,?,?,?, 'ثبت‌شده','','test')
`).run('مشتری چک v183', partyId, custId, amount).lastInsertRowid;

const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(chequeId);
ok('not opening', isOpeningCheque(row) === false);
const jeId = postChequeInReceipt(db, row, 1, '1405/01/02');
ok('cheque_in JE posted', !!jeId);
const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(jeId);
ok('JE ref cheque_in', je && je.ref_type === 'cheque_in');
const crLine = db.prepare(`
  SELECT * FROM journal_lines WHERE entry_id=? AND account_code=?
`).get(jeId, tafsili);
ok('JE credits customer tafsili', !!crLine && Number(crLine.credit_rial || crLine.credit || 0) > 0);

const led = db.prepare(`
  SELECT * FROM customer_ledger WHERE ref_type='cheque_in' AND ref_id=? AND customer_id=?
`).get(chequeId, custId);
ok('customer_ledger credit at register', !!led && Number(led.credit) === amount && Number(led.debit) === 0);

const je2 = postChequeInReceipt(db, db.prepare('SELECT * FROM cheque_records WHERE id=?').get(chequeId), 1, '1405/01/02');
ok('cheque_in idempotent', Number(je2) === Number(jeId));
const ledCount = db.prepare(`
  SELECT COUNT(*) c FROM customer_ledger WHERE ref_type='cheque_in' AND ref_id=? AND entry_type<>'reversal'
`).get(chequeId).c;
ok('ledger not doubled', ledCount === 1);

const { voidChequeRecord } = require('../lib/void-cheque');
voidChequeRecord(db, chequeId, { id: 1, name: 'admin' });
const rev = db.prepare(`
  SELECT * FROM customer_ledger WHERE ref_type='cheque_in' AND ref_id=? AND entry_type='reversal'
`).get(chequeId);
ok('void reverses customer_ledger', !!rev && Number(rev.debit) === amount);

const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
ok('buildRows keeps variant_id', invoicesSrc.includes('variant_id: variantId || null') && invoicesSrc.includes('color_name: colorName'));

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok('invoice color split modal', appJs.includes('openInvVariantSplitModal') && appJs.includes('inv-var-qty'));
ok('product color chips', appJs.includes('p-chip-color') && appJs.includes('loadProdSkuChips'));
ok('saveInvoice sends variant_id', appJs.includes('variant_id:r.variant_id||null'));
ok('help cheque at register', appJs.includes('ثبت چک دریافتنی همان لحظه'));
ok('help live pack', appJs.includes('پک = رنگ موجود × سایز موجود') || appJs.includes('پک فروش زنده'));

try {
  new Function(appJs);
  ok('app.js parses', true);
} catch (e) {
  ok('app.js parses', false, e.message);
}

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok('SW v183', sw.includes('erp-taranom-v183'));

try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}

console.log(`\narch-erp-rar-v183: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
