const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { getDB, audit } = require('../db');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const toFa = (n) => Number(n || 0) * 10; // legacy operational tables store toman
const fromRial = (n) => Math.round(num(n) / 10);

function text(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
}
function num(value) {
  const clean = text(value).replace(/[,\u066C\s]/g, '').replace(/[^\d.-]/g, '');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}
function bool(value) {
  return ['1', 'true', 'yes', 'بله', 'بلی'].includes(text(value).toLowerCase());
}
function field(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && text(row[name]) !== '') return row[name];
  }
  return '';
}
function rowsToBook(rows, sheetName, guide) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0] || {}).map((key) => ({ wch: Math.max(14, Math.min(35, key.length + 8)) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  if (guide?.length) {
    const info = XLSX.utils.json_to_sheet(guide.map((line) => ({ راهنما: line })));
    info['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, info, 'راهنما');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function sendBook(res, rows, sheetName, filename, guide) {
  res.setHeader('Content-Type', MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rowsToBook(rows.length ? rows : [{}], sheetName, guide));
}
function groupBy(rows, keyNames = ['شماره سند*', 'شماره سند', 'document_no']) {
  const map = new Map();
  rows.forEach((row, index) => {
    const key = text(field(row, ...keyNames)) || String(index + 1);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return [...map.entries()];
}
function findOne(db, table, value, columns) {
  const v = text(value);
  if (!v) return null;
  for (const col of columns) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE CAST(${col} AS TEXT)=? COLLATE NOCASE LIMIT 1`).get(v);
    if (row) return row;
  }
  return null;
}
function customer(db, value) {
  return findOne(db, 'customers', value, ['id', 'coa_code', 'biz', 'owner', 'phone']);
}
function supplier(db, value) {
  return findOne(db, 'suppliers', value, ['id', 'coa_code', 'name', 'phone']);
}
function product(db, value) {
  return findOne(db, 'products', value, ['id', 'code', 'barcode', 'name']);
}
function warehouse(db, value) {
  return findOne(db, 'warehouses', value, ['id', 'code', 'name']);
}
function invoice(db, value, table = 'invoices') {
  return findOne(db, table, value, ['id', 'num']);
}
function requireRef(rowNo, label, row) {
  if (!row) throw new Error(`ردیف ${rowNo}: ${label} یافت نشد`);
  return row;
}
function action(path, body, label) {
  return { method: 'POST', path, body, label };
}
function lineProduct(db, row, rowNo, priceKey = 'قیمت واحد (ریال)') {
  const p = requireRef(rowNo, 'کالا', product(db, field(row, 'کد کالا*', 'کد کالا', 'نام کالا*', 'نام کالا', 'product')));
  return {
    product_id: p.id,
    name: p.name,
    qty: Math.max(1, Math.trunc(num(field(row, 'تعداد', 'qty')))),
    price: fromRial(field(row, priceKey, 'قیمت (ریال)', 'price_rial')),
    disc: num(field(row, 'تخفیف درصد', 'disc')),
  };
}

const DEFINITIONS = {
  parties: {
    title: 'اطلاعات اشخاص',
    sample: { 'نام*': 'فروشگاه نمونه', 'تلفن*': '09120000000', پیشوند: 'شرکت', موبایل: '', شهر: 'تهران', گروه: 'مشتریان', 'سمت‌ها': 'customer|supplier', ایمیل: '', 'کد ملی': '' },
    guide: ['نام و تلفن الزامی است.', 'سمت‌ها با | جدا شوند: customer, supplier, employee, partner, marketer, other'],
  },
  products: {
    title: 'کالاها',
    sample: { 'نام کالا*': 'کالای نمونه', 'کد کالا': 'PR-001', دسته: 'عمومی', واحد: 'عدد', 'قیمت فروش (ریال)': 1000000, 'بهای خرید (ریال)': 700000 },
    guide: ['مبالغ فقط ریال هستند.', 'موجودی اولیه را از عملیات رسید انبار وارد کنید.'],
  },
  'opening-recv-cheques': {
    title: 'چک‌های دریافتنی اول دوره',
    sample: { 'شماره چک*': '10001', 'مبلغ (ریال)*': 50000000, 'تاریخ صدور': '1405/01/01', 'تاریخ سررسید': '1405/03/01', بانک: 'ملت', شعبه: '', 'شماره صیادی': '', 'طرف حساب': 'شخص نمونه', شرح: '' },
  },
  'opening-pay-cheques': {
    title: 'چک‌های پرداختی اول دوره',
    sample: { 'شماره چک*': '20001', 'مبلغ (ریال)*': 50000000, 'تاریخ صدور': '1405/01/01', 'تاریخ سررسید': '1405/03/01', بانک: 'ملت', شعبه: '', 'شماره صیادی': '', 'طرف حساب': 'شخص نمونه', شرح: '' },
  },
  settlements: {
    title: 'عملیات دریافت و پرداخت',
    sampleRows: [
      { 'جهت عملیات*': 'receive', 'طرف حساب*': 'فروشگاه نمونه', 'شماره فاکتور': '', 'مبلغ (ریال)*': 10000000, 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'شماره چک': '', 'سررسید چک': '', شرح: 'دریافت از مشتری' },
      { 'جهت عملیات*': 'pay', 'طرف حساب*': 'تأمین‌کننده نمونه', 'شماره فاکتور': '', 'مبلغ (ریال)*': 5000000, 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'شماره چک': '', 'سررسید چک': '', شرح: 'پرداخت به تأمین‌کننده' },
    ],
    guide: ['جهت عملیات: receive برای دریافت از مشتری، pay برای پرداخت به تأمین‌کننده', 'نوع پرداخت: cash, bank, bank_transfer, cheque', 'طرف حساب را با نام، کد حساب یا شناسه وارد کنید.'],
  },
  expenses: {
    title: 'هزینه‌ها',
    sample: { 'عنوان*': 'هزینه حمل', 'مبلغ (ریال)*': 2500000, دسته: 'admin', 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'کد حساب هزینه': '', شرح: '' },
  },
  'coa-codes': {
    title: 'کدهای حسابداری',
    sample: { 'کد*': '9900', 'نام حساب*': 'گروه حساب نمونه', 'نوع*': 'asset', 'کد والد': '' },
    guide: ['نوع حساب: asset, liability, equity, revenue, cogs, expense', 'والد باید قبل از فرزند در فایل یا سیستم موجود باشد.'],
  },
  'ledger-accounts': {
    title: 'حساب‌های کل',
    sample: { 'کد*': '1999', 'نام حساب*': 'حساب کل نمونه', 'نوع*': 'asset', 'کد والد*': '1000' },
  },
  'subsidiary-accounts': {
    title: 'حساب‌های معین',
    sample: { 'کد*': '110199', 'نام حساب*': 'حساب معین نمونه', 'نوع*': 'asset', 'کد والد*': '1101' },
  },
  'detail-accounts': {
    title: 'حساب‌های تفصیلی',
    sample: { 'کد تفصیلی*': 'T00001', 'نام*': 'تفصیلی نمونه', 'کد دسته': 'person' },
  },
  'sales-invoices': {
    title: 'فاکتورهای فروش',
    sample: { 'شماره سند*': 'S-001', 'مشتری*': 'فروشگاه نمونه', تاریخ: '1405/01/01', 'نوع فاکتور': 'final', 'نوع پرداخت': 'credit', 'کد انبار': 'WH-01', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)*': 1000000, 'تخفیف درصد': 0, 'تخفیف کل درصد': 0, شرح: '' },
    guide: ['برای چند قلم یک فاکتور، شماره سند را در همه ردیف‌ها یکسان وارد کنید.', 'نوع فاکتور: final یا proforma'],
  },
  purchases: {
    title: 'فاکتورهای خرید',
    sample: { 'شماره سند*': 'P-001', 'تأمین‌کننده*': 'تأمین‌کننده نمونه', تاریخ: '1405/01/01', 'نوع پرداخت': 'credit', 'کد انبار': 'WH-01', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)*': 700000, 'تخفیف کل درصد': 0, شرح: '' },
  },
  'sales-returns': {
    title: 'برگشت از فروش',
    sample: { 'شماره سند*': 'SR-001', 'مشتری*': 'فروشگاه نمونه', 'شماره فاکتور مبنا': '', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 1, 'قیمت واحد (ریال)*': 1000000, شرح: '' },
  },
  'purchase-returns': {
    title: 'برگشت از خرید',
    sample: { 'شماره سند*': 'PR-001', 'تأمین‌کننده*': 'تأمین‌کننده نمونه', 'شماره فاکتور مبنا': '', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 1, 'قیمت واحد (ریال)*': 700000, شرح: '' },
  },
  'warehouse-receipt': {
    title: 'رسید انبار',
    sample: { 'شماره سند*': 'WR-001', 'انبار مقصد*': 'انبار مرکزی', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 10, شرح: '' },
  },
  'warehouse-issue': {
    title: 'حواله انبار',
    sample: { 'شماره سند*': 'WI-001', 'انبار مبدأ*': 'انبار مرکزی', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 2, شرح: '' },
  },
  'warehouse-transfer': {
    title: 'حواله بین انبار',
    sample: { 'شماره سند*': 'WT-001', 'انبار مبدأ*': 'انبار مرکزی', 'انبار مقصد*': 'انبار فروش', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 2, شرح: '' },
  },
  'consignments-in': {
    title: 'کالاهای امانی گرفته‌شده',
    sample: { 'طرف حساب*': 'شخص نمونه', تلفن: '', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)': 1000000, تاریخ: '1405/01/01', شرح: '' },
  },
  'consignments-out': {
    title: 'کالاهای امانی داده‌شده',
    sample: { 'طرف حساب*': 'شخص نمونه', تلفن: '', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)': 1000000, تاریخ: '1405/01/01', شرح: '' },
  },
  'journal-docs': {
    title: 'فهرست اسناد',
    sampleRows: [
      { 'شماره سند*': 'J-001', تاریخ: '1405/01/01', 'شرح سند': 'سند نمونه', 'کد حساب*': '1101', 'بدهکار (ریال)': 10000000, 'بستانکار (ریال)': 0, 'شرح ردیف': 'ردیف بدهکار' },
      { 'شماره سند*': 'J-001', تاریخ: '1405/01/01', 'شرح سند': 'سند نمونه', 'کد حساب*': '1102', 'بدهکار (ریال)': 0, 'بستانکار (ریال)': 10000000, 'شرح ردیف': 'ردیف بستانکار' },
    ],
    guide: ['هر سند باید حداقل دو ردیف و جمع بدهکار و بستانکار برابر داشته باشد.', 'شماره سند فقط برای گروه‌بندی ردیف‌هاست و شماره نهایی را سیستم تخصیص می‌دهد.'],
  },
};

function ensureDefinition(req, res, next) {
  const def = DEFINITIONS[req.params.entity];
  if (!def) return res.status(404).json({ error: 'نوع فایل اکسل پشتیبانی نمی‌شود' });
  req.excelDef = def;
  next();
}

function coaDepth(rows) {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const depth = (row, seen = new Set()) => {
    if (!row.parent_code || seen.has(row.code)) return 0;
    seen.add(row.code);
    const parent = byCode.get(row.parent_code);
    return parent ? 1 + depth(parent, seen) : 0;
  };
  return rows.map((row) => ({ ...row, _depth: depth(row) }));
}

function exportRows(db, entity) {
  if (entity === 'parties') return db.prepare(`SELECT p.*,pg.name party_group_name FROM parties p LEFT JOIN party_groups pg ON pg.id=p.party_group_id WHERE p.is_active=1 ORDER BY p.id`).all().map((r) => ({
    کد: r.person_code, نام: r.full_name || r.biz, تلفن: r.phone, موبایل: r.mobile, شهر: r.city, گروه: r.party_group_name, 'سمت‌ها': (() => { try { return JSON.parse(r.party_roles || '[]').join('|'); } catch { return ''; } })(), ایمیل: r.email, 'کد ملی': r.national_id,
  }));
  if (entity === 'products') return db.prepare('SELECT * FROM products ORDER BY id').all().map((r) => ({ 'کد کالا': r.code, بارکد: r.barcode, 'نام کالا': r.name, دسته: r.category, واحد: r.unit, 'قیمت فروش (ریال)': toFa(r.price), 'بهای خرید (ریال)': toFa(r.cost), موجودی: r.stock }));
  if (entity.startsWith('opening-')) {
    const direction = entity === 'opening-recv-cheques' ? 'in' : 'out';
    return db.prepare("SELECT * FROM cheque_records WHERE direction=? AND (note LIKE '%مانده اول دوره%' OR status LIKE '%اول دوره%') ORDER BY id").all(direction).map((r) => ({ 'شماره چک': r.cheque_number, 'مبلغ (ریال)': r.amount, 'تاریخ صدور': r.issue_date, 'تاریخ سررسید': r.due_date, بانک: r.bank_name, شعبه: r.branch, 'شماره صیادی': r.sayadi, 'طرف حساب': r.party_name, وضعیت: r.status, شرح: r.note }));
  }
  if (entity === 'settlements') {
    const received = db.prepare('SELECT s.*,c.biz party_name,i.num invoice_num FROM settlements s LEFT JOIN customers c ON c.id=s.cust_id LEFT JOIN invoices i ON i.id=s.invoice_id ORDER BY s.id').all().map((r) => ({ 'جهت عملیات': 'receive', 'طرف حساب': r.party_name, 'شماره فاکتور': r.invoice_num, 'مبلغ (ریال)': toFa(r.amount), 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'شماره چک': r.cheque_number, 'سررسید چک': r.cheque_due, شرح: r.note }));
    const paid = db.prepare('SELECT p.*,s.name party_name,i.num invoice_num FROM supplier_payments p LEFT JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN purchase_invoices i ON i.id=p.purchase_invoice_id ORDER BY p.id').all().map((r) => ({ 'جهت عملیات': 'pay', 'طرف حساب': r.party_name, 'شماره فاکتور': r.invoice_num, 'مبلغ (ریال)': toFa(r.amount), 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'شماره چک': r.cheque_number, 'سررسید چک': r.cheque_due, شرح: r.note }));
    return received.concat(paid);
  }
  if (entity === 'expenses') return db.prepare('SELECT * FROM expense_payments ORDER BY id').all().map((r) => ({ عنوان: r.title, 'مبلغ (ریال)': toFa(r.amount), دسته: r.category, 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'کد حساب هزینه': r.account_code, شرح: r.note }));
  if (['coa-codes', 'ledger-accounts', 'subsidiary-accounts'].includes(entity)) {
    let rows = coaDepth(db.prepare('SELECT * FROM chart_of_accounts WHERE is_active=1 ORDER BY code').all());
    if (entity === 'ledger-accounts') rows = rows.filter((r) => r._depth === 1);
    if (entity === 'subsidiary-accounts') rows = rows.filter((r) => r._depth >= 2);
    return rows.map((r) => ({ کد: r.code, 'نام حساب': r.name, نوع: r.type, 'کد والد': r.parent_code || '', سطح: r._depth }));
  }
  if (entity === 'detail-accounts') return db.prepare('SELECT d.*,c.code category_code,c.name category_name FROM detail_accounts d LEFT JOIN detail_categories c ON c.id=d.detail_category_id ORDER BY d.code').all().map((r) => ({ 'کد تفصیلی': r.code, نام: r.name, 'کد دسته': r.category_code, دسته: r.category_name }));
  if (entity === 'sales-invoices') return explodeDocuments(db.prepare("SELECT i.*,c.biz customer_name,w.name warehouse_name FROM invoices i LEFT JOIN customers c ON c.id=i.cust_id LEFT JOIN warehouses w ON w.id=i.warehouse_id WHERE COALESCE(i.deleted_at,0)=0 ORDER BY i.id").all(), 'customer_name', 'مشتری', 'num', 'قیمت واحد (ریال)');
  if (entity === 'purchases') return explodeDocuments(db.prepare('SELECT i.*,s.name supplier_name,w.name warehouse_name FROM purchase_invoices i LEFT JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN warehouses w ON w.id=i.warehouse_id ORDER BY i.id').all(), 'supplier_name', 'تأمین‌کننده', 'num', 'قیمت واحد (ریال)');
  if (entity === 'sales-returns') return explodeDocuments(db.prepare('SELECT r.*,c.biz customer_name,i.num invoice_num FROM sales_returns r LEFT JOIN customers c ON c.id=r.cust_id LEFT JOIN invoices i ON i.id=r.invoice_id ORDER BY r.id').all(), 'customer_name', 'مشتری', 'id', 'قیمت واحد (ریال)', 'invoice_num');
  if (entity === 'purchase-returns') return explodeDocuments(db.prepare('SELECT r.*,s.name supplier_name,i.num invoice_num FROM purchase_returns r LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN purchase_invoices i ON i.id=r.purchase_invoice_id ORDER BY r.id').all(), 'supplier_name', 'تأمین‌کننده', 'id', 'قیمت واحد (ریال)', 'invoice_num');
  if (entity.startsWith('warehouse-')) {
    const type = entity.replace('warehouse-', '');
    return db.prepare(`SELECT m.*,p.code product_code,p.name product_name,fw.name from_name,tw.name to_name FROM warehouse_moves m LEFT JOIN products p ON p.id=m.product_id LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id WHERE m.type=? ORDER BY m.id`).all(type).map((r) => ({ 'شماره سند': r.id, 'انبار مبدأ': r.from_name, 'انبار مقصد': r.to_name, تاریخ: r.date, 'کد کالا': r.product_code, 'نام کالا': r.product_name, تعداد: r.qty, 'مبلغ (ریال)': r.amount_rial, شرح: r.note }));
  }
  if (entity.startsWith('consignments-')) {
    const direction = entity.endsWith('-in') ? 'in' : 'out';
    return db.prepare('SELECT c.*,p.code product_code,p.name product_name FROM consignments c LEFT JOIN products p ON p.id=c.product_id WHERE c.direction=? ORDER BY c.id').all(direction).map((r) => ({ 'طرف حساب': r.party_name, تلفن: r.party_phone, 'کد کالا': r.product_code, 'نام کالا': r.product_name, تعداد: r.qty, 'قیمت واحد (ریال)': toFa(r.unit_price), تاریخ: r.date, وضعیت: r.status, شرح: r.note }));
  }
  if (entity === 'journal-docs') return db.prepare(`SELECT je.id,je.entry_date,je.description,jl.account_code,jl.account_name,jl.debit,jl.credit,jl.description line_description FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id WHERE COALESCE(je.deleted_at,0)=0 ORDER BY je.id,jl.id`).all().map((r) => ({ 'شماره سند': r.id, تاریخ: r.entry_date, 'شرح سند': r.description, 'کد حساب': r.account_code, 'نام حساب': r.account_name, 'بدهکار (ریال)': toFa(r.debit), 'بستانکار (ریال)': toFa(r.credit), 'شرح ردیف': r.line_description }));
  return [];
}

function explodeDocuments(docs, partyKey, partyLabel, numberKey, priceLabel, invoiceKey) {
  const out = [];
  for (const doc of docs) {
    let lines = [];
    try { lines = JSON.parse(doc.rows || '[]'); } catch (_) { /* empty */ }
    for (const line of lines) {
      out.push({
        'شماره سند': doc[numberKey], [partyLabel]: doc[partyKey], 'شماره فاکتور مبنا': invoiceKey ? doc[invoiceKey] : '',
        تاریخ: doc.date, 'نوع پرداخت': doc.pay_type || '', 'کد انبار': doc.warehouse_name || '',
        'کد کالا': line.code || line.product_code || line.product_id, 'نام کالا': line.name,
        تعداد: line.qty, [priceLabel]: toFa(line.price), 'تخفیف درصد': line.disc || 0, شرح: doc.note || '',
      });
    }
  }
  return out;
}

function buildActions(db, entity, rows) {
  if (entity === 'parties') {
    const normalized = rows.map((r) => ({
      full_name: field(r, 'نام*', 'نام', 'full_name'), phone: field(r, 'تلفن*', 'تلفن', 'phone'),
      prefix: field(r, 'پیشوند'), mobile: field(r, 'موبایل'), city: field(r, 'شهر'),
      party_group_name: field(r, 'گروه'), party_roles: text(field(r, 'سمت‌ها')).split('|').filter(Boolean),
      email: field(r, 'ایمیل'), national_id: field(r, 'کد ملی'),
    }));
    return [action('/parties/import', { rows: normalized }, `ورود ${normalized.length} شخص`)];
  }
  if (entity === 'products') return rows.map((r, i) => action('/products/quick', {
    name: field(r, 'نام کالا*', 'نام کالا'), code: field(r, 'کد کالا'), category: field(r, 'دسته'),
    unit: field(r, 'واحد') || 'عدد', price: fromRial(field(r, 'قیمت فروش (ریال)')),
    cost: fromRial(field(r, 'بهای خرید (ریال)')),
  }, `ردیف ${i + 2}`));
  if (entity.startsWith('opening-')) {
    const direction = entity === 'opening-recv-cheques' ? 'in' : 'out';
    return rows.map((r, i) => action('/cheque-records', {
      direction, opening: true, cheque_number: field(r, 'شماره چک*', 'شماره چک'),
      amount: num(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)')), issue_date: field(r, 'تاریخ صدور'),
      due_date: field(r, 'تاریخ سررسید'), bank_name: field(r, 'بانک'), branch: field(r, 'شعبه'),
      sayadi: field(r, 'شماره صیادی'), party_name: field(r, 'طرف حساب'), note: field(r, 'شرح'),
    }, `چک ردیف ${i + 2}`));
  }
  if (entity === 'settlements') return rows.map((r, i) => {
    const direction = text(field(r, 'جهت عملیات*', 'جهت عملیات')).toLowerCase() || 'receive';
    const amount = fromRial(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)'));
    if (['pay', 'payment', 'پرداخت'].includes(direction)) {
      const s = requireRef(i + 2, 'تأمین‌کننده', supplier(db, field(r, 'طرف حساب*', 'طرف حساب')));
      const inv = field(r, 'شماره فاکتور') ? requireRef(i + 2, 'فاکتور خرید', invoice(db, field(r, 'شماره فاکتور'), 'purchase_invoices')) : null;
      return action('/purchases/payments', {
        supplier_id: s.id, purchase_invoice_id: inv?.id || null, amount,
        pay_type: field(r, 'نوع پرداخت') || 'cash', date: field(r, 'تاریخ'), note: field(r, 'شرح'),
        cheque_number: field(r, 'شماره چک'), cheque_due: field(r, 'سررسید چک'),
      }, `پرداخت ردیف ${i + 2}`);
    }
    const c = requireRef(i + 2, 'مشتری', customer(db, field(r, 'طرف حساب*', 'طرف حساب', 'مشتری*', 'مشتری')));
    const inv = field(r, 'شماره فاکتور') ? requireRef(i + 2, 'فاکتور فروش', invoice(db, field(r, 'شماره فاکتور'))) : null;
    return action('/accounting/settlements', {
      cust_id: c.id, invoice_id: inv?.id || null, amount,
      pay_type: field(r, 'نوع پرداخت') || 'cash', date: field(r, 'تاریخ'), note: field(r, 'شرح'),
      cheque_number: field(r, 'شماره چک'), cheque_due: field(r, 'سررسید چک'), cheque_amount: amount,
    }, `دریافت ردیف ${i + 2}`);
  });
  if (entity === 'expenses') return rows.map((r, i) => action('/expenses', {
    title: field(r, 'عنوان*', 'عنوان'), amount: fromRial(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)')),
    category: field(r, 'دسته') || 'admin', pay_type: field(r, 'نوع پرداخت') || 'cash',
    date: field(r, 'تاریخ'), account_code: field(r, 'کد حساب هزینه') || null, note: field(r, 'شرح'),
  }, `هزینه ردیف ${i + 2}`));
  if (['coa-codes', 'ledger-accounts', 'subsidiary-accounts'].includes(entity)) return rows.map((r, i) => action('/accounting/chart-of-accounts', {
    code: field(r, 'کد*', 'کد'), name: field(r, 'نام حساب*', 'نام حساب'),
    type: field(r, 'نوع*', 'نوع'), parent_code: field(r, 'کد والد*', 'کد والد') || null,
  }, `حساب ردیف ${i + 2}`));
  if (entity === 'detail-accounts') return rows.map((r, i) => {
    const categoryCode = text(field(r, 'کد دسته'));
    const category = categoryCode ? db.prepare('SELECT id FROM detail_categories WHERE code=?').get(categoryCode) : null;
    if (categoryCode && !category) throw new Error(`ردیف ${i + 2}: دسته تفصیلی ${categoryCode} یافت نشد`);
    return action('/detail-accounts', {
      code: field(r, 'کد تفصیلی*', 'کد تفصیلی'), name: field(r, 'نام*', 'نام'),
      detail_category_id: category?.id || null,
    }, `تفصیلی ردیف ${i + 2}`);
  });
  if (entity === 'sales-invoices') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const c = requireRef(number, 'مشتری', customer(db, field(first, 'مشتری*', 'مشتری')));
    const wh = field(first, 'کد انبار') ? requireRef(number, 'انبار', warehouse(db, field(first, 'کد انبار'))) : null;
    return action('/invoices', {
      cust_id: c.id, date: field(first, 'تاریخ'), type: field(first, 'نوع فاکتور') || 'final',
      pay_type: field(first, 'نوع پرداخت') || 'credit', warehouse_id: wh?.id || null,
      disc: num(field(first, 'تخفیف کل درصد')), note: field(first, 'شرح'),
      rows: lines.map((r, i) => lineProduct(db, r, `${number}/${i + 1}`)),
    }, `فاکتور فروش ${number}`);
  });
  if (entity === 'purchases') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const s = requireRef(number, 'تأمین‌کننده', supplier(db, field(first, 'تأمین‌کننده*', 'تأمین‌کننده')));
    const wh = field(first, 'کد انبار') ? requireRef(number, 'انبار', warehouse(db, field(first, 'کد انبار'))) : null;
    return action('/purchases', {
      supplier_id: s.id, date: field(first, 'تاریخ'), pay_type: field(first, 'نوع پرداخت') || 'credit',
      warehouse_id: wh?.id || null, disc: num(field(first, 'تخفیف کل درصد')), note: field(first, 'شرح'),
      rows: lines.map((r, i) => lineProduct(db, r, `${number}/${i + 1}`)),
    }, `فاکتور خرید ${number}`);
  });
  if (entity === 'sales-returns') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const c = requireRef(number, 'مشتری', customer(db, field(first, 'مشتری*', 'مشتری')));
    const inv = field(first, 'شماره فاکتور مبنا') ? requireRef(number, 'فاکتور مبنا', invoice(db, field(first, 'شماره فاکتور مبنا'))) : null;
    return action('/accounting/sales-returns', {
      cust_id: c.id, invoice_id: inv?.id || null, date: field(first, 'تاریخ'), note: field(first, 'شرح'),
      rows: lines.map((r, i) => lineProduct(db, r, `${number}/${i + 1}`)),
    }, `برگشت فروش ${number}`);
  });
  if (entity === 'purchase-returns') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const s = requireRef(number, 'تأمین‌کننده', supplier(db, field(first, 'تأمین‌کننده*', 'تأمین‌کننده')));
    const inv = field(first, 'شماره فاکتور مبنا') ? requireRef(number, 'فاکتور مبنا', invoice(db, field(first, 'شماره فاکتور مبنا'), 'purchase_invoices')) : null;
    return action('/purchases/returns', {
      supplier_id: s.id, purchase_invoice_id: inv?.id || null, date: field(first, 'تاریخ'), note: field(first, 'شرح'),
      rows: lines.map((r, i) => lineProduct(db, r, `${number}/${i + 1}`)),
    }, `برگشت خرید ${number}`);
  });
  if (entity.startsWith('warehouse-')) return groupBy(rows).map(([number, lines]) => {
    const first = lines[0], type = entity.replace('warehouse-', '');
    const from = field(first, 'انبار مبدأ*', 'انبار مبدأ') ? requireRef(number, 'انبار مبدأ', warehouse(db, field(first, 'انبار مبدأ*', 'انبار مبدأ'))) : null;
    const to = field(first, 'انبار مقصد*', 'انبار مقصد') ? requireRef(number, 'انبار مقصد', warehouse(db, field(first, 'انبار مقصد*', 'انبار مقصد'))) : null;
    return action('/warehouses/moves/batch', {
      type, warehouse_id: type === 'receipt' ? to?.id : from?.id, from_warehouse_id: from?.id,
      to_warehouse_id: to?.id, date: field(first, 'تاریخ'), note: field(first, 'شرح'),
      lines: lines.map((r, i) => ({ product_id: requireRef(`${number}/${i + 1}`, 'کالا', product(db, field(r, 'کد کالا*', 'کد کالا'))).id, qty: Math.max(1, Math.trunc(num(field(r, 'تعداد*', 'تعداد')))) })),
    }, `${DEFINITIONS[entity].title} ${number}`);
  });
  if (entity.startsWith('consignments-')) {
    const direction = entity.endsWith('-in') ? 'in' : 'out';
    return rows.map((r, i) => {
      const p = requireRef(i + 2, 'کالا', product(db, field(r, 'کد کالا*', 'کد کالا')));
      return action('/consignments', {
        direction, party_name: field(r, 'طرف حساب*', 'طرف حساب'), party_phone: field(r, 'تلفن'),
        product_id: p.id, qty: Math.max(1, Math.trunc(num(field(r, 'تعداد*', 'تعداد')))),
        unit_price: fromRial(field(r, 'قیمت واحد (ریال)')), date: field(r, 'تاریخ'), note: field(r, 'شرح'),
      }, `امانی ردیف ${i + 2}`);
    });
  }
  if (entity === 'journal-docs') return groupBy(rows).map(([number, lines]) => {
    const voucherLines = lines.map((r, index) => {
      const code = text(field(r, 'کد حساب*', 'کد حساب'));
      if (!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=? AND is_active=1').get(code)) {
        throw new Error(`سند ${number} ردیف ${index + 1}: کد حساب ${code || '(خالی)'} یافت نشد`);
      }
      return {
        code, debit: fromRial(field(r, 'بدهکار (ریال)')),
        credit: fromRial(field(r, 'بستانکار (ریال)')), description: field(r, 'شرح ردیف'),
      };
    });
    const debit = voucherLines.reduce((sum, r) => sum + r.debit, 0);
    const credit = voucherLines.reduce((sum, r) => sum + r.credit, 0);
    if (voucherLines.length < 2 || debit !== credit || debit <= 0) {
      throw new Error(`سند ${number}: حداقل دو ردیف و جمع بدهکار/بستانکار برابر الزامی است`);
    }
    return action('/accounting/vouchers', {
      date: field(lines[0], 'تاریخ'), description: field(lines[0], 'شرح سند') || `سند وارداتی ${number}`,
      lines: voucherLines,
    }, `سند حسابداری ${number}`);
  });
  return [];
}

router.get('/:entity/template', auth, adminOrAccounting, ensureDefinition, (req, res) => {
  sendBook(res, req.excelDef.sampleRows || [req.excelDef.sample], req.excelDef.title, `${req.params.entity}-template.xlsx`, [
    'نام ستون‌ها را تغییر ندهید. ستون‌های دارای * الزامی هستند.',
    'همه مبالغ در قالب‌ها و خروجی‌ها فقط ریال هستند.',
    ...(req.excelDef.guide || []),
  ]);
});

router.get('/:entity/export', auth, adminOrAccounting, ensureDefinition, (req, res) => {
  try {
    sendBook(res, exportRows(getDB(), req.params.entity), req.excelDef.title, `${req.params.entity}.xlsx`);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:entity/prepare-import', auth, adminOrAccounting, ensureDefinition, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل اکسل انتخاب نشده است' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rows.length) return res.status(400).json({ error: 'فایل اکسل فاقد ردیف داده است' });
    if (rows.length > 5000) return res.status(400).json({ error: 'حداکثر ۵۰۰۰ ردیف در هر فایل مجاز است' });
    const actions = buildActions(getDB(), req.params.entity, rows);
    if (!actions.length) return res.status(400).json({ error: 'هیچ عملیات معتبری از فایل ساخته نشد' });
    audit(req.user.id, 'prepare_excel_import', req.params.entity, null, `آماده‌سازی ${rows.length} ردیف و ${actions.length} عملیات`);
    res.json({ ok: true, entity: req.params.entity, title: req.excelDef.title, row_count: rows.length, actions });
  } catch (e) {
    res.status(400).json({ error: `خطا در اعتبارسنجی فایل: ${e.message}` });
  }
});

module.exports = router;
