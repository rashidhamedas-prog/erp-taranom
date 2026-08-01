#!/usr/bin/env node
/**
 * Enrich Mahak DB from full data.xlsx — fields, subgroups, cheques, invoice metadata.
 * Run AFTER import-mahak-journal + stock + documents + fix-mahak-placement.
 *
 *   node server/scripts/import-mahak-full-data.js <full-data.xlsx> <target.db> [--force]
 */
const path = require('path');
const fs = require('fs');
const { XLSX, readWorkbook } = require('../lib/excel-safe');
const { fa, parsePersonName } = require('../lib/mahak-import-helpers');
const { storeRial, seedMahakSubgroups } = require('../lib/currency');

const args = process.argv.slice(2);
const force = args.includes('--force');
const xlsxPath = args.find(a => !a.startsWith('--'));
const dbPath = args.filter(a => !a.startsWith('--'))[1];
if (!xlsxPath || !dbPath) {
  console.error('usage: node import-mahak-full-data.js <full-data.xlsx> <target.db> [--force]');
  process.exit(1);
}
if (!fs.existsSync(xlsxPath)) {
  console.error('ERROR: file not found:', xlsxPath);
  process.exit(1);
}

process.env.DB_PATH = path.resolve(dbPath);
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const done = db.prepare("SELECT value FROM settings WHERE key='mahak_full_data_import_v1'").get();
if (done?.value === '1' && !force) {
  console.log('mahak full-data already imported — use --force to re-run');
  process.exit(0);
}


(async () => {
const wb = await readWorkbook(require("fs").readFileSync(path.resolve(xlsxPath)));
const sheet = (name) => {
  const n = wb.SheetNames.find(s => fa(s) === fa(name) || s.trim() === name.trim());
  return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }) : [];
};

const num = v => storeRial(parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0);
const str = v => fa(v);
const opCode = v => String(v == null ? '' : v).replace(/\D/g, '').padStart(6, '0').slice(-6);
const normName = s => fa(s).replace(/\*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

seedMahakSubgroups(db);

const stats = {
  product_categories: 0, party_groups: 0, products: 0, banks: 0,
  customers: 0, suppliers: 0, persons: 0, invoices: 0, settlements: 0,
  purchases: 0, supplier_payments: 0, cheques_in: 0, cheques_out: 0, production: 0,
};

// ── 1) Sync subgroups from Excel ───────────────────────────────────────────
for (const row of sheet('گروه کالا')) {
  const code = parseInt(row['کد '] ?? row['کد']) || 0;
  const name = str(row['عنوان '] ?? row['عنوان']);
  if (!name) continue;
  db.prepare('INSERT OR IGNORE INTO product_categories (name,code,sort_order,description) VALUES (?,?,?,?)')
    .run(name, code, code, 'ورود از full data.xlsx');
  db.prepare('UPDATE product_categories SET code=?,sort_order=? WHERE name=?').run(code, code, name);
  stats.product_categories++;
}
for (const row of sheet('گروه اشخاص')) {
  const code = parseInt(row['کد '] ?? row['کد']) || 0;
  const name = str(row['نام گروه '] ?? row['نام گروه']);
  if (!name) continue;
  const entity = code === 1 || code === 7 ? 'customer' : code === 2 ? 'supplier' : code >= 3 ? 'person' : 'all';
  db.prepare('INSERT OR IGNORE INTO party_groups (code,name,entity_type,description) VALUES (?,?,?,?)')
    .run(code, name, entity, 'ورود از full data.xlsx');
  db.prepare('UPDATE party_groups SET code=?,entity_type=? WHERE name=?').run(code, entity, name);
  stats.party_groups++;
}

const pgByName = new Map(db.prepare('SELECT id,name FROM party_groups').all().map(r => [normName(r.name), r.id]));
const catByName = new Map(db.prepare('SELECT id,name FROM product_categories').all().map(r => [normName(r.name), r.id]));

// Build lookup indexes
const prodByCode = new Map();
const prodByName = new Map();
for (const p of db.prepare('SELECT id,code,name,mahak_op_code FROM products').all()) {
  if (p.code) prodByCode.set(opCode(p.code), p.id);
  if (p.mahak_op_code) prodByCode.set(opCode(p.mahak_op_code), p.id);
  prodByName.set(normName(p.name), p.id);
}

const custByName = new Map();
for (const c of db.prepare('SELECT id,biz,owner,mahak_op_code FROM customers').all()) {
  custByName.set(normName(c.biz), c.id);
  if (c.owner) custByName.set(normName(c.owner), c.id);
  if (c.biz && c.owner) custByName.set(normName(`${c.owner} ${c.biz}`), c.id);
}

const supByName = new Map();
for (const s of db.prepare('SELECT id,name,mahak_op_code FROM suppliers').all()) {
  supByName.set(normName(s.name), s.id);
}

const bankByName = new Map();
for (const b of db.prepare('SELECT id,name,mahak_op_code FROM banks').all()) {
  bankByName.set(normName(b.name), b.id);
}

const personByName = new Map();
for (const p of db.prepare('SELECT id,name,mahak_op_code FROM persons').all()) {
  personByName.set(normName(p.name), p.id);
}

function findCustomer(name) {
  const n = normName(name);
  if (custByName.has(n)) return custByName.get(n);
  const parsed = parsePersonName(name);
  if (custByName.has(normName(parsed.biz))) return custByName.get(normName(parsed.biz));
  for (const [k, id] of custByName) {
    if (k.includes(n.slice(0, 12)) || n.includes(k.slice(0, 12))) return id;
  }
  return null;
}

function findProduct(row) {
  const op = opCode(row['کد حساب تفصیلی']);
  if (prodByCode.has(op)) return prodByCode.get(op);
  const nm = normName(row['نام کالا'] || row['نام کامل کالا']);
  return prodByName.get(nm) || null;
}

function findBank(name) {
  const n = normName(name);
  if (bankByName.has(n)) return bankByName.get(n);
  for (const [k, id] of bankByName) {
    if (k.includes(n) || n.includes(k)) return id;
  }
  return null;
}

// ── 2) Products ────────────────────────────────────────────────────────────
const updProd = db.prepare(`UPDATE products SET
  mahak_op_code=?, full_name=?, product_type=?, product_index=?, tax_id=?, barcode=COALESCE(NULLIF(?,''),barcode),
  consumer_price=?, location=?, opening_price=?, sms_code=?, stock_alert=COALESCE(?,stock_alert),
  unit=COALESCE(NULLIF(?,''),unit), note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('کلیه کالاها ')) {
  const id = findProduct(row);
  if (!id) continue;
  const alert = parseInt(row['حداقل موجودی']) || null;
  updProd.run(
    opCode(row['کد حساب تفصیلی']),
    str(row['نام کامل کالا']), str(row['نوع کالا']), str(row['شاخص کالا']),
    str(row['شناسه مالیاتی']), str(row['بارکد '] ?? row['بارکد']),
    num(row['فی مصرف کننده']), str(row['مکان کالا']), num(row['فی اول دوره']),
    str(row['کد پیامکی']), alert, str(row['واحد']),
    str(row['توضیحات']), id
  );
  stats.products++;
}

// ── 3) Banks ─────────────────────────────────────────────────────────────────
const updBank = db.prepare(`UPDATE banks SET
  mahak_op_code=?, account_type=?, phone=?, card_number=?, card_expiry=?, sheba=?,
  note=COALESCE(NULLIF(?,''),note), account_number=COALESCE(NULLIF(?,''),account_number),
  branch=COALESCE(NULLIF(?,''),branch)
  WHERE id=?`);

for (const row of sheet('بانک ها')) {
  const id = findBank(row['نام بانک']);
  if (!id) continue;
  updBank.run(
    opCode(row['کد حساب تفصیلی']), str(row['نوع حساب']), str(row['تلفن']),
    str(row['شماره کارت']), str(row['تاریخ انقضاء']), str(row['شبا']),
    str(row['توضیحات']), str(row['شماره حساب']), str(row['نام شعبه']), id
  );
  stats.banks++;
}

// ── 4) Persons → customers / suppliers / persons ───────────────────────────
const updCust = db.prepare(`UPDATE customers SET
  mahak_op_code=?, prefix=?, owner=COALESCE(NULLIF(?,''),owner), phone=COALESCE(NULLIF(?,''),phone),
  phone2=?, fax=?, mobile=COALESCE(NULLIF(?,''),phone), address=COALESCE(NULLIF(?,''),address),
  email=?, economic_code=?, postal_code=?, national_id=?, referrer=?, birth_date=?,
  company_name=?, account_nature=?, note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

const updSup = db.prepare(`UPDATE suppliers SET
  mahak_op_code=?, prefix=?, phone=COALESCE(NULLIF(?,''),phone), phone2=?, fax=?, mobile=?,
  address=COALESCE(NULLIF(?,''),address), email=?, economic_code=?, postal_code=?,
  national_id=?, referrer=?, company_name=?, account_nature=?, note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

const updPerson = db.prepare(`UPDATE persons SET
  mahak_op_code=?, prefix=?, phone=COALESCE(NULLIF(?,''),phone), phone2=?, fax=?, mobile=?,
  address=COALESCE(NULLIF(?,''),address), email=?, economic_code=?, postal_code=?,
  national_id=?, referrer=?, birth_date=?, company_name=?, account_nature=?,
  note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('کلیه اشخاص')) {
  const fullName = str(row['نام و نام خانوادگی'] || `${row['پیشوند']} ${row['نام ']} ${row['نام خانوادگی']}`);
  if (!fullName) continue;
  const op = opCode(row['کد حساب تفصیلی']);
  const nature = str(row['ماهیت فعلی']);
  const fields = [
    op, str(row['پیشوند']),
    str(row['نام '] && row['نام خانوادگی'] ? `${row['پیشوند']} ${row['نام ']} ${row['نام خانوادگی']}` : ''),
    str(row['تلفن']), str(row['تلفن 2']), str(row['فکس']), str(row['تلفن همراه']),
    str(row['آدرس اصلی']), str(row['پست الکترونیک']), str(row['شماره اقتصادی']),
    str(row['کدپستی']), str(row['کد ملی / شناسه ملی']), str(row['معرف']),
    str(row['تاریخ تولد']), str(row['نام شرکت']), nature, str(row['توضیحات']),
  ];

  const custId = findCustomer(fullName);
  if (custId) { updCust.run(...fields, custId); stats.customers++; continue; }

  const supId = supByName.get(normName(fullName)) || supByName.get(normName(row['نام شرکت']));
  if (supId) { updSup.run(...fields.slice(0, 2), ...fields.slice(3), supId); stats.suppliers++; continue; }

  const persId = personByName.get(normName(fullName));
  if (persId) { updPerson.run(...fields, persId); stats.persons++; }
}

// ── 5) Sales invoices metadata ───────────────────────────────────────────────
const updInv = db.prepare(`UPDATE invoices SET
  mahak_invoice_code=?, mahak_doc_no=COALESCE(mahak_doc_no,?), atf_no=?, settlement_date=?,
  visitor=?, seller_name=COALESCE(NULLIF(?,''),seller_name), freight_amount=?, freight_type=?,
  settled_amount=?, balance_due=?, driver=?, entry_method=?, delivery_date=?,
  delivered=?, settlement_status=?, settlement_type=?, invoice_address=?, note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('لیست فاکتور های فروش ')) {
  const docNo = String(row['شماره سند حسابداری'] || '').trim();
  const invCode = String(row['کد'] || '').trim();
  let inv = docNo
    ? db.prepare('SELECT id FROM invoices WHERE mahak_doc_no=? OR mahak_invoice_code=? LIMIT 1').get(docNo, invCode)
    : null;
  if (!inv && invCode) inv = db.prepare('SELECT id FROM invoices WHERE mahak_invoice_code=? LIMIT 1').get(invCode);
  if (!inv) {
    const custId = findCustomer(row['خریدار']);
    if (custId && docNo) {
      inv = db.prepare(`SELECT id FROM invoices WHERE cust_id=? AND date=? AND ABS(final-?)<1000 LIMIT 1`)
        .get(custId, str(row['تاریخ']), num(row['مبلغ نهایی']));
    }
  }
  if (!inv) continue;
  const delivered = String(row['تحویل']).toLowerCase() === 'true' ? 1 : 0;
  const noteExtra = [str(row['فاکتور شامل']), str(row['توضیحات'])].filter(Boolean).join(' — ');
  updInv.run(
    invCode, docNo, str(row['شماره عطف فاکتور']), str(row['تاریخ تسویه']),
    str(row['ویزیتور']), str(row['ویزیتور']),
    num(row['مبلغ حمل']), str(row['نوع مبلغ حمل']),
    num(row['مبلغ تسویه شده']), num(row['مانده قابل تسویه']),
    str(row['راننده']), str(row['نحوه ثبت']), str(row['تاریخ تحویل']),
    delivered, str(row['وضعیت تسویه']), str(row['نوع تسویه']),
    str(row['آدرس']), noteExtra, inv.id
  );
  stats.invoices++;
}

// ── 6) Receipts metadata ───────────────────────────────────────────────────
const updStl = db.prepare(`UPDATE settlements SET
  mahak_receipt_code=?, mahak_doc_no=COALESCE(mahak_doc_no,?), atf_no=?, invoice_ref=?,
  visitor=?, purpose=?, cash_amount=?, cheque_total=?, transfer_total=?,
  note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('لیست دریافت ها ')) {
  const docNo = String(row['شماره سند حسابداری'] || '').trim();
  const rcptCode = String(row['کد دریافت'] || '').trim();
  let stl = docNo
    ? db.prepare('SELECT id FROM settlements WHERE mahak_doc_no=? OR mahak_receipt_code=? LIMIT 1').get(docNo, rcptCode)
    : null;
  if (!stl && rcptCode) stl = db.prepare('SELECT id FROM settlements WHERE mahak_receipt_code=? LIMIT 1').get(rcptCode);
  if (!stl && docNo) {
    stl = db.prepare('SELECT id FROM settlements WHERE date=? AND ABS(amount-?)<1000 LIMIT 1')
      .get(str(row['تاریخ']), num(row['مبلغ']));
  }
  if (!stl) continue;
  updStl.run(
    rcptCode, docNo, str(row['شماره عطف']), String(row['شماره فاکتور'] || ''),
    str(row['نام ویزیتور']), str(row['بابت']),
    num(row['مبلغ نقدی']), num(row['جمع چکها']), num(row['جمع حواله ها']),
    str(row['بابت']), stl.id
  );
  stats.settlements++;
}

// ── 7) Purchase invoices metadata ────────────────────────────────────────────
const updPur = db.prepare(`UPDATE purchase_invoices SET
  mahak_doc_no=COALESCE(mahak_doc_no,?), atf_no=?, settled_amount=?, balance_due=?, settlement_status=?,
  note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('لیست فاکتور های خرید ')) {
  const docNo = String(row['شماره سند حسابداری'] || '').trim();
  const invNo = String(row['شماره فاکتور'] || '').trim();
  let pur = docNo
    ? db.prepare('SELECT id FROM purchase_invoices WHERE mahak_doc_no=? LIMIT 1').get(docNo)
    : null;
  if (!pur && invNo) pur = db.prepare('SELECT id FROM purchase_invoices WHERE num=? LIMIT 1').get(invNo);
  if (!pur) continue;
  updPur.run(
    docNo, str(row['شماره عطف']),
    num(row['مبلغ تسویه شده']), num(row['مانده قابل تسویه']),
    str(row['مانده قابل تسویه']) === '0' ? 'تسویه شده' : 'تسویه نشده',
    str(row['توضیحات']), pur.id
  );
  stats.purchases++;
}

// ── 8) Supplier payments from لیست عملیات پرداخت ───────────────────────────
const updPay = db.prepare(`UPDATE supplier_payments SET
  mahak_doc_no=COALESCE(mahak_doc_no,?), atf_no=?, purpose=?, cash_amount=?, cheque_total=?, transfer_total=?,
  note=COALESCE(NULLIF(?,''),note)
  WHERE id=?`);

for (const row of sheet('لیست عملیات پرداخت')) {
  const docNo = String(row['شماره سند حسابداری'] || '').trim();
  if (!docNo) continue;
  const pay = db.prepare('SELECT id FROM supplier_payments WHERE mahak_doc_no=? LIMIT 1').get(docNo)
    || db.prepare('SELECT id FROM expense_payments WHERE mahak_doc_no=? LIMIT 1').get(docNo);
  if (!pay) continue;
  const tbl = db.prepare('SELECT id FROM supplier_payments WHERE id=?').get(pay.id) ? 'supplier_payments' : null;
  if (!tbl) continue;
  db.prepare(`UPDATE supplier_payments SET
    mahak_doc_no=COALESCE(mahak_doc_no,?), atf_no=?, purpose=?, cash_amount=?, cheque_total=?, transfer_total=?,
    note=COALESCE(NULLIF(?,''),note) WHERE id=?`).run(
    docNo, str(row['شماره عطف']), str(row['بابت']),
    num(row['مبلغ نقدی']), num(row['جمع چکها']), num(row['جمع حواله ها']),
    str(row['بابت']), pay.id
  );
  stats.supplier_payments++;
}

// ── 9) Cheque registry ───────────────────────────────────────────────────────
if (force) db.prepare('DELETE FROM cheque_records').run();

const insChq = db.prepare(`INSERT INTO cheque_records
  (direction,cheque_number,issue_date,receive_date,due_date,bank_name,branch,sayadi,sheba,
   account_number,party_name,status,status_note,amount,mahak_row_id,mahak_reg_id,note,created_by_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const chqExists = db.prepare('SELECT id FROM cheque_records WHERE direction=? AND cheque_number=? AND amount=? LIMIT 1');

for (const row of sheet('لیست چک های دریافتی')) {
  const amt = num(row['مبلغ']);
  if (!amt) continue;
  const exists = chqExists.get('in', str(row['شماره چک']), amt);
  if (exists) continue;
  insChq.run(
    'in', str(row['شماره چک']), '', str(row['تاریخ دریافت']), str(row['تاریخ سررسید']),
    str(row['بانک']), str(row['شعبه']), str(row['شناسه صیاد']), str(row['شماره شبا']),
    str(row['شماره حساب']), str(row['پرداخت کننده']), str(row['وضعیت']),
    str(row['شرح وضعیت']), amt, str(row['ردیف چک']), str(row['شناسه ثبت']),
    str(row['شرح']), str(row['کاربر ایجاد کننده'])
  );
  stats.cheques_in++;
}

for (const row of sheet('لیست چک های پرداختی ')) {
  const amt = num(row['مبلغ']);
  if (!amt) continue;
  const exists = chqExists.get('out', str(row['شماره چک']), amt);
  if (exists) continue;
  insChq.run(
    'out', str(row['شماره چک']), str(row['تاریخ صدور']), '', str(row['تاریخ سررسید']),
    str(row['بانک']), str(row['شعبه']), '', '',
    str(row['شماره حساب']), str(row['در یافت کننده']), str(row['وضعیت']),
    '', amt, str(row['ردیف چک']), str(row['شناسه ثبت']),
    str(row['شرح']), str(row['کاربر ایجاد کننده'])
  );
  stats.cheques_out++;
}

// ── 10) Production metadata ──────────────────────────────────────────────────
for (const row of sheet('عملیات تولیدات - آنالیز متغیر ')) {
  const code = String(row['کد تولید'] || '').trim();
  const date = str(row['تاریخ']);
  const amt = num(row['مبلغ کل تولید']);
  const run = db.prepare(`SELECT id FROM production_runs WHERE date=? AND ABS(material_cost+overhead_cost-?)<50000 LIMIT 1`)
    .get(date, amt)
    || (code ? db.prepare("SELECT id FROM production_runs WHERE note LIKE ? LIMIT 1").get(`%${code}%`) : null);
  if (!run) continue;
  db.prepare(`UPDATE production_runs SET note=COALESCE(note,'')||? WHERE id=?`)
    .run(` [محک:${code}] ${str(row['توضیحات'])}`, run.id);
  stats.production++;
}

db.prepare("INSERT INTO settings (key,value) VALUES ('mahak_full_data_import_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();

const report = [
  '# گزارش ورود full data.xlsx',
  '',
  `تاریخ: ${new Date().toISOString()}`,
  '',
  '## آمار',
  ...Object.entries(stats).map(([k, v]) => `- ${k}: ${v}`),
  '',
  `## چک‌های ثبت‌شده: ${db.prepare('SELECT COUNT(*) c FROM cheque_records').get().c}`,
].join('\n');

const repPath = path.join(path.dirname(path.resolve(dbPath)), 'mahak-full-data-report.md');
fs.writeFileSync(repPath, report, 'utf8');

console.log('import-mahak-full-data:', JSON.stringify(stats, null, 2));
console.log('report →', repPath);

})().catch((e) => {
  console.error(e);
  process.exit(1);
});
