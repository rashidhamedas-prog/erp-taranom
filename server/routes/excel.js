const router = require('express').Router();
const { XLSX, readWorkbook } = require('../lib/excel-safe');
const { createSecureUpload } = require('../lib/upload-policy');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { getDB, audit } = require('../db');

const upload = createSecureUpload('xlsx');

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
/** Normalize Excel cell dates (serial / Date / Jalali / Gregorian string) → display string */
function excelDateCell(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial date (days since 1899-12-30)
    const epoch = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
    const dt = new Date(epoch);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  return text(value);
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
async function rowsToBook(rows, sheetName, guide) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0] || {}).map((key) => ({ wch: Math.max(14, Math.min(35, key.length + 8)) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  if (guide?.length) {
    const info = XLSX.utils.json_to_sheet(guide.map((line) => ({ راهنما: line })));
    info['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, info, 'راهنما');
  }
  return XLSX.write(wb);
}
async function sendBook(res, rows, sheetName, filename, guide) {
  res.setHeader('Content-Type', MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(await rowsToBook(rows.length ? rows : [{}], sheetName, guide));
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
function appUser(db, value) {
  return findOne(db, 'users', value, ['id', 'username', 'name', 'phone']);
}
function partyGroup(db, value) {
  return findOne(db, 'party_groups', value, ['id', 'code', 'name']);
}
function optionalRefId(db, table, value, columns, label, rowNo) {
  if (text(value) === '') return null;
  return requireRef(rowNo, label, findOne(db, table, value, columns)).id;
}
function invoice(db, value, table = 'invoices') {
  return findOne(db, table, value, ['id', 'num']);
}
function requireRef(rowNo, label, row) {
  if (!row) throw new Error(`ردیف ${rowNo}: ${label} یافت نشد`);
  return row;
}
function action(path, body, label) {
  return { method: 'POST', path, body: { ...body, from_excel: true, src_system: 'excel' }, label };
}
function lineProduct(db, row, rowNo, priceKey = 'قیمت واحد (ریال)') {
  const p = requireRef(rowNo, 'کالا', product(db, field(row, 'کد کالا*', 'کد کالا', 'نام کالا*', 'نام کالا', 'product')));
  return {
    product_id: p.id,
    name: p.name,
    qty: Math.max(1, Math.trunc(num(field(row, 'تعداد*', 'تعداد', 'qty')))),
    price: fromRial(field(row, priceKey + '*', priceKey, 'قیمت (ریال)*', 'قیمت (ریال)', 'price_rial')),
    disc: num(field(row, 'تخفیف درصد', 'disc')),
  };
}

const DEFINITIONS = {
  parties: {
    title: 'اطلاعات اشخاص',
    sample: {
      'کد شخص': '', 'نام*': 'فروشگاه نمونه', 'نوع شخصیت': 'real', 'نام شرکت': '', پیشوند: 'شرکت',
      'تلفن*': '09120000000', 'تلفن دوم': '', موبایل: '', فکس: '', ایمیل: '',
      'کد ملی': '', 'کد اقتصادی': '', شهر: 'تهران', استان: 'تهران', آدرس: '', 'کد پستی': '',
      'تاریخ تولد': '', گروه: 'مشتریان', 'سمت‌ها': 'customer|supplier', بخش‌بندی: 'C',
      'نوع فروشگاه': '', منبع: '', معرف: '', 'ماهیت حساب': '', 'سقف اعتبار (ریال)': 0,
      'مانده اول دوره (ریال)': 0, 'تاریخ مانده اول دوره': '', کارشناس: '', یادداشت: '',
    },
    guide: [
      'نام و تلفن الزامی است.',
      'سمت‌ها با | جدا شوند: customer, supplier, employee, partner, marketer, other',
      'اگر «مانده اول دوره (ریال)» غیرصفر باشد، سند حسابداری افتتاحیه (اتومات) ثبت می‌شود و در دفتر معین هم می‌نشیند.',
    ],
  },
  products: {
    title: 'کالاها',
    sample: {
      'نام کالا*': 'کالای نمونه', 'نام کامل کالا': '', 'کد کالا': 'PR-001', بارکد: '',
      دسته: 'عمومی', واحد: 'عدد', 'انبار اصلی': 'WH-01', موجودی: 0, 'هشدار موجودی': 5,
      'قیمت فروش (ریال)': 1000000, 'بهای تمام‌شده (ریال)': 700000,
      'قیمت مصرف‌کننده (ریال)': 0, 'قیمت اول دوره (ریال)': 0, 'تعداد رنگ': 1,
      'تعداد در پک': 1, 'نوع کالا': '', 'شاخص کالا': '', 'شناسه مالیاتی': '',
      'محل نگهداری': '', 'کد پیامک': '', یادداشت: '',
    },
    guide: [
      'مبالغ فقط ریال هستند.',
      'اگر ستون «موجودی» > 0 باشد و بهای تمام‌شده یا قیمت اول دوره پر باشد، سند «موجودی اول دوره» (اتومات/افتتاحیه) ثبت می‌شود.',
      'برای رسید انبار جداگانه از قالب warehouse-receipt با شرح «موجودی اول دوره» استفاده کنید.',
    ],
  },
  'opening-recv-cheques': {
    title: 'چک‌های دریافتنی اول دوره',
    sample: { 'شماره چک*': '10001', 'مبلغ (ریال)*': 50000000, 'تاریخ صدور': '1405/01/01', 'تاریخ دریافت': '', 'تاریخ سررسید': '1405/03/01', بانک: 'ملت', شعبه: '', 'شماره صیادی': '', شبا: '', 'شماره حساب': '', 'طرف حساب': 'شخص نمونه', وضعیت: 'مانده اول دوره', 'شرح وضعیت': '', شرح: '' },
  },
  'opening-pay-cheques': {
    title: 'چک‌های پرداختی اول دوره',
    sample: { 'شماره چک*': '20001', 'مبلغ (ریال)*': 50000000, 'تاریخ صدور': '1405/01/01', 'تاریخ دریافت': '', 'تاریخ سررسید': '1405/03/01', بانک: 'ملت', شعبه: '', 'شماره صیادی': '', شبا: '', 'شماره حساب': '', 'طرف حساب': 'شخص نمونه', وضعیت: 'مانده اول دوره', 'شرح وضعیت': '', شرح: '' },
  },
  'fixed-assets': {
    title: 'دارایی ثابت',
    sample: {
      'کد': 'FA-001', 'نام دارایی*': 'دستگاه برش', دسته: 'ماشین‌آلات', 'تاریخ خرید': '1405/01/01',
      'بهای تمام‌شده (ریال)*': 150000000, 'ارزش اسقاط (ریال)': 10000000, 'عمر مفید (ماه)': 60,
      'کد حساب دارایی': '1201', 'محل استقرار': 'سالن تولید', توضیحات: '',
    },
    guide: [
      'مبالغ فقط ریال هستند.',
      'ستون‌های دارای * الزامی‌اند.',
      'اگر کد خالی باشد به‌صورت خودکار ساخته می‌شود.',
    ],
  },
  settlements: {
    title: 'عملیات دریافت و پرداخت',
    sampleRows: [
      { 'جهت عملیات*': 'receive', 'طرف حساب*': 'فروشگاه نمونه', 'شماره فاکتور': '', 'مبلغ (ریال)*': 10000000, 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'بانک/شناسه بانک': '', 'صندوق/شناسه صندوق': '', 'دسته چک/شناسه': '', 'بانک چک': '', 'شماره صیادی': '', 'شماره چک': '', 'شماره حساب چک': '', 'مبلغ چک (ریال)': 0, 'صاحب چک': '', 'سررسید چک': '', 'وضعیت چک': 'pending', 'شعبه چک': '', 'شبای چک': '', شرح: 'دریافت از مشتری' },
      { 'جهت عملیات*': 'pay', 'طرف حساب*': 'تأمین‌کننده نمونه', 'شماره فاکتور': '', 'مبلغ (ریال)*': 5000000, 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'بانک/شناسه بانک': '', 'صندوق/شناسه صندوق': '', 'دسته چک/شناسه': '', 'بانک چک': '', 'شماره صیادی': '', 'شماره چک': '', 'شماره حساب چک': '', 'مبلغ چک (ریال)': 0, 'صاحب چک': '', 'سررسید چک': '', 'وضعیت چک': 'pending', 'شعبه چک': '', 'شبای چک': '', شرح: 'پرداخت به تأمین‌کننده' },
    ],
    guide: ['جهت عملیات: receive برای دریافت از مشتری، pay برای پرداخت به تأمین‌کننده', 'نوع پرداخت: cash, bank, bank_transfer, cheque', 'طرف حساب را با نام، کد حساب یا شناسه وارد کنید.'],
  },
  expenses: {
    title: 'هزینه‌ها',
    sample: { 'عنوان*': 'هزینه حمل', 'مبلغ (ریال)*': 2500000, دسته: 'admin', 'نوع پرداخت': 'cash', تاریخ: '1405/01/01', 'کد حساب هزینه': '', 'بانک/شناسه بانک': '', 'صندوق/شناسه صندوق': '', 'دسته چک/شناسه': '', 'مرکز هزینه/شناسه': '', 'شماره فاکتور خرید': '', 'سربار تولید': 'خیر', شرح: '' },
  },
  'coa-codes': {
    title: 'کدهای حسابداری',
    sample: { 'کد*': '9900', 'نام حساب*': 'گروه حساب نمونه', 'نوع*': 'asset', 'کد والد': '', سطح: 1, ماهیت: 'debit', 'نوع مانده': 'permanent', 'عنصر بهای تمام‌شده': 'خیر', 'نوع تفصیلی': '', فعال: 'بله' },
    guide: ['نوع حساب: asset, liability, equity, revenue, cogs, expense', 'والد باید قبل از فرزند در فایل یا سیستم موجود باشد.'],
  },
  'ledger-accounts': {
    title: 'حساب‌های کل',
    sample: { 'کد*': '1999', 'نام حساب*': 'حساب کل نمونه', 'نوع*': 'asset', 'کد والد*': '1000', سطح: 2, ماهیت: 'debit', 'نوع مانده': 'permanent', 'عنصر بهای تمام‌شده': 'خیر', 'نوع تفصیلی': '', فعال: 'بله' },
  },
  'subsidiary-accounts': {
    title: 'حساب‌های معین',
    sample: { 'کد*': '110199', 'نام حساب*': 'حساب معین نمونه', 'نوع*': 'asset', 'کد والد*': '1101', سطح: 3, ماهیت: 'debit', 'نوع مانده': 'permanent', 'عنصر بهای تمام‌شده': 'خیر', 'نوع تفصیلی': '', فعال: 'بله' },
  },
  'detail-accounts': {
    title: 'حساب‌های تفصیلی',
    sample: { 'کد تفصیلی*': 'T00001', 'نام*': 'تفصیلی نمونه', 'کد دسته': 'person', 'جدول مرتبط': '', 'شناسه مرتبط': '', فعال: 'بله' },
  },
  'sales-invoices': {
    title: 'فاکتورهای فروش',
    sample: { 'شماره سند*': 'S-001', 'مشتری*': 'فروشگاه نمونه', تاریخ: '1405/01/01', 'نوع فاکتور': 'final', 'نوع پرداخت': 'credit', 'کد انبار': 'WH-01', 'بانک/شناسه بانک': '', 'صندوق/شناسه صندوق': '', 'دسته چک/شناسه': '', 'مرکز هزینه/شناسه': '', 'کرایه حمل (ریال)': 0, 'نوع کرایه': '', 'معاف از مالیات': 'خیر', 'مدت چک': '', 'سررسید چک': '', 'اطلاعات چک': '', 'کانال فروش': '', 'منبع سرنخ': '', کمپین: '', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)*': 1000000, 'تخفیف درصد': 0, 'تخفیف کل درصد': 0, شرح: '' },
    guide: ['برای چند قلم یک فاکتور، شماره سند را در همه ردیف‌ها یکسان وارد کنید.', 'نوع فاکتور: final یا proforma'],
  },
  purchases: {
    title: 'فاکتورهای خرید',
    sample: { 'شماره سند*': 'P-001', 'تأمین‌کننده*': 'تأمین‌کننده نمونه', تاریخ: '1405/01/01', 'نوع پرداخت': 'credit', 'کد انبار': 'WH-01', 'بانک/شناسه بانک': '', 'صندوق/شناسه صندوق': '', 'دسته چک/شناسه': '', 'مرکز هزینه/شناسه': '', 'کرایه حمل (ریال)': 0, 'نوع کرایه': '', 'معاف از مالیات': 'خیر', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)*': 700000, 'تخفیف درصد': 0, 'تخفیف کل درصد': 0, شرح: '' },
  },
  'sales-returns': {
    title: 'برگشت از فروش',
    sample: { 'شماره سند*': 'SR-001', 'مشتری*': 'فروشگاه نمونه', 'شماره فاکتور مبنا': '', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 1, 'قیمت واحد (ریال)*': 1000000, 'تخفیف درصد': 0, شرح: '' },
  },
  'purchase-returns': {
    title: 'برگشت از خرید',
    sample: { 'شماره سند*': 'PR-001', 'تأمین‌کننده*': 'تأمین‌کننده نمونه', 'شماره فاکتور مبنا': '', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 1, 'قیمت واحد (ریال)*': 700000, 'تخفیف درصد': 0, شرح: '' },
  },
  'warehouse-receipt': {
    title: 'رسید انبار',
    sample: { 'شماره سند*': 'WR-001', 'انبار مقصد*': 'انبار مرکزی', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 10, 'بهای واحد (ریال)': 700000, 'مبلغ (ریال)': '', شرح: 'موجودی اول دوره' },
    guide: ['اگر شرح شامل «اول دوره» یا «افتتاحیه» باشد، سند به‌عنوان موجودی اول دوره (افتتاحیه) ثبت می‌شود.', 'بهای واحد یا مبلغ برای ثبت سند حسابداری الزامی است.'],
  },
  'warehouse-issue': {
    title: 'حواله انبار',
    sample: { 'شماره سند*': 'WI-001', 'انبار مبدأ*': 'انبار مرکزی', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'بهای واحد (ریال)': '', 'مبلغ (ریال)': '', شرح: '' },
  },
  'warehouse-transfer': {
    title: 'حواله بین انبار',
    sample: { 'شماره سند*': 'WT-001', 'انبار مبدأ*': 'انبار مرکزی', 'انبار مقصد*': 'انبار فروش', تاریخ: '1405/01/01', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'بهای واحد (ریال)': '', 'مبلغ (ریال)': '', شرح: '' },
  },
  'consignments-in': {
    title: 'کالاهای امانی گرفته‌شده',
    sample: { 'طرف حساب*': 'شخص نمونه', تلفن: '', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)': 1000000, تاریخ: '1405/01/01', وضعیت: 'open', شرح: '' },
  },
  'consignments-out': {
    title: 'کالاهای امانی داده‌شده',
    sample: { 'طرف حساب*': 'شخص نمونه', تلفن: '', 'کد کالا*': 'PR-001', 'تعداد*': 2, 'قیمت واحد (ریال)': 1000000, تاریخ: '1405/01/01', وضعیت: 'open', شرح: '' },
  },
  'journal-docs': {
    title: 'فهرست اسناد',
    sampleRows: [
      { 'شماره سند*': 'J-001', تاریخ: '1405/01/01', 'نوع سند': 'opening', 'شرح سند': 'سند افتتاحیه نمونه', 'مرکز هزینه/شناسه': '', 'کد حساب*': '1103', 'شناسه تفصیلی': '', 'شناسه پروژه': '', 'نوع مالیات': '', 'بدهکار (ریال)': 10000000, 'بستانکار (ریال)': 0, 'شرح ردیف': 'مانده دریافتنی' },
      { 'شماره سند*': 'J-001', تاریخ: '1405/01/01', 'نوع سند': 'opening', 'شرح سند': 'سند افتتاحیه نمونه', 'مرکز هزینه/شناسه': '', 'کد حساب*': '3102', 'شناسه تفصیلی': '', 'شناسه پروژه': '', 'نوع مالیات': '', 'بدهکار (ریال)': 0, 'بستانکار (ریال)': 10000000, 'شرح ردیف': 'تراز افتتاحیه' },
    ],
    guide: [
      'هر سند باید حداقل دو ردیف و جمع بدهکار و بستانکار برابر داشته باشد.',
      'شماره سند فقط برای گروه‌بندی ردیف‌هاست و شماره نهایی را سیستم تخصیص می‌دهد.',
      'نوع سند: opening / افتتاحیه / opening_balance / beginning_inventory / موجودی اول دوره → برچسب افتتاحیه؛ سایر مقادیر از اکسل → برچسب اتومات؛ ثبت دستی از فرم برنامه → برچسب دستی.',
    ],
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
  if (entity === 'parties') return db.prepare(`SELECT p.*,pg.name party_group_name,u.name expert_name FROM parties p LEFT JOIN party_groups pg ON pg.id=p.party_group_id LEFT JOIN users u ON u.id=p.user_id WHERE p.is_active=1 ORDER BY p.id`).all().map((r) => ({
    'کد شخص': r.person_code, نام: r.full_name || r.biz, 'نوع شخصیت': r.legal_type, 'نام شرکت': r.company_name,
    پیشوند: r.prefix, تلفن: r.phone, 'تلفن دوم': r.secondary_phone, موبایل: r.mobile, فکس: r.fax,
    ایمیل: r.email, 'کد ملی': r.national_id, 'کد اقتصادی': r.economic_code, شهر: r.city, استان: r.province,
    آدرس: r.address, 'کد پستی': r.postal_code, 'تاریخ تولد': r.birth_date, گروه: r.party_group_name,
    'سمت‌ها': (() => { try { return JSON.parse(r.party_roles || '[]').join('|'); } catch { return ''; } })(),
    بخش‌بندی: r.segment, 'نوع فروشگاه': r.store_type, منبع: r.source, معرف: r.referrer,
    'ماهیت حساب': r.account_nature, 'سقف اعتبار (ریال)': r.credit_limit, 'مانده اول دوره (ریال)': r.opening_balance,
    'تاریخ مانده اول دوره': r.opening_balance_date, کارشناس: r.expert_name, یادداشت: r.notes,
  }));
  if (entity === 'products') return db.prepare('SELECT p.*,w.name warehouse_name,w.code warehouse_code FROM products p LEFT JOIN warehouses w ON w.id=p.warehouse_id ORDER BY p.id').all().map((r) => ({
    'نام کالا': r.name, 'نام کامل کالا': r.full_name, 'کد کالا': r.code, بارکد: r.barcode,
    دسته: r.category, واحد: r.unit, 'انبار اصلی': r.warehouse_code || r.warehouse_name, موجودی: r.stock,
    'هشدار موجودی': r.stock_alert, 'قیمت فروش (ریال)': Math.round(Number(r.price) || 0), 'بهای تمام‌شده (ریال)': Math.round(Number(r.cost) || 0),
    'قیمت مصرف‌کننده (ریال)': Math.round(Number(r.consumer_price) || 0), 'قیمت اول دوره (ریال)': Math.round(Number(r.opening_price) || 0),
    'تعداد رنگ': r.colors, 'تعداد در پک': r.pack_size, 'نوع کالا': r.product_type, 'شاخص کالا': r.product_index,
    'شناسه مالیاتی': r.tax_id, 'محل نگهداری': r.location, 'کد پیامک': r.sms_code, یادداشت: r.note,
  }));
  if (entity.startsWith('opening-')) {
    const direction = entity === 'opening-recv-cheques' ? 'in' : 'out';
    return db.prepare("SELECT * FROM cheque_records WHERE direction=? AND COALESCE(record_status,'posted')<>'reversed' AND (note LIKE '%مانده اول دوره%' OR status LIKE '%اول دوره%') ORDER BY id").all(direction).map((r) => ({ 'شماره چک': r.cheque_number, 'مبلغ (ریال)': r.amount, 'تاریخ صدور': r.issue_date, 'تاریخ دریافت': r.receive_date, 'تاریخ سررسید': r.due_date, بانک: r.bank_name, شعبه: r.branch, 'شماره صیادی': r.sayadi, شبا: r.sheba, 'شماره حساب': r.account_number, 'طرف حساب': r.party_name, وضعیت: r.status, 'شرح وضعیت': r.status_note, شرح: r.note }));
  }
  if (entity === 'fixed-assets') {
    return db.prepare("SELECT * FROM fixed_assets WHERE status='active' ORDER BY code").all().map((r) => ({
      کد: r.code, نام: r.name, دسته: r.category, 'تاریخ خرید': r.purchase_date,
      'بهای تمام‌شده (ریال)': r.cost_rial, 'ارزش اسقاط (ریال)': r.salvage_rial,
      'عمر مفید (ماه)': r.useful_life_months, 'کد حساب دارایی': r.coa_asset_code,
      'محل استقرار': r.location, توضیحات: r.notes,
    }));
  }
  if (entity === 'settlements') {
    const received = db.prepare("SELECT s.*,c.biz party_name,i.num invoice_num,b.name bank_name,cb.name cash_box_name,cc.name check_category_name FROM settlements s LEFT JOIN customers c ON c.id=s.cust_id LEFT JOIN invoices i ON i.id=s.invoice_id LEFT JOIN banks b ON b.id=s.bank_id LEFT JOIN cash_boxes cb ON cb.id=s.cash_box_id LEFT JOIN check_categories cc ON cc.id=s.check_category_id WHERE COALESCE(s.status,'posted')<>'reversed' ORDER BY s.id").all().map((r) => ({ 'جهت عملیات': 'receive', 'طرف حساب': r.party_name, 'شماره فاکتور': r.invoice_num, 'مبلغ (ریال)': toFa(r.amount), 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'بانک/شناسه بانک': r.bank_name, 'صندوق/شناسه صندوق': r.cash_box_name, 'دسته چک/شناسه': r.check_category_name, 'بانک چک': r.cheque_bank, 'شماره صیادی': r.cheque_sayadi, 'شماره چک': r.cheque_number, 'شماره حساب چک': r.cheque_account, 'مبلغ چک (ریال)': toFa(r.cheque_amount), 'صاحب چک': r.cheque_owner, 'سررسید چک': r.cheque_due, 'وضعیت چک': r.cheque_status, 'شعبه چک': r.cheque_branch, 'شبای چک': r.cheque_sheba, شرح: r.note }));
    const paid = db.prepare("SELECT p.*,s.name party_name,i.num invoice_num,b.name bank_name,cb.name cash_box_name,cc.name check_category_name FROM supplier_payments p LEFT JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN purchase_invoices i ON i.id=p.purchase_invoice_id LEFT JOIN banks b ON b.id=p.bank_id LEFT JOIN cash_boxes cb ON cb.id=p.cash_box_id LEFT JOIN check_categories cc ON cc.id=p.check_category_id WHERE COALESCE(p.status,'posted')<>'reversed' ORDER BY p.id").all().map((r) => ({ 'جهت عملیات': 'pay', 'طرف حساب': r.party_name, 'شماره فاکتور': r.invoice_num, 'مبلغ (ریال)': toFa(r.amount), 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'بانک/شناسه بانک': r.bank_name, 'صندوق/شناسه صندوق': r.cash_box_name, 'دسته چک/شناسه': r.check_category_name, 'بانک چک': '', 'شماره صیادی': '', 'شماره چک': '', 'شماره حساب چک': '', 'مبلغ چک (ریال)': 0, 'صاحب چک': '', 'سررسید چک': '', 'وضعیت چک': '', 'شعبه چک': '', 'شبای چک': '', شرح: r.note }));
    return received.concat(paid);
  }
  if (entity === 'expenses') return db.prepare("SELECT e.*,b.name bank_name,cb.name cash_box_name,cc.name check_category_name,co.name cost_center_name,pi.num purchase_invoice_num FROM expense_payments e LEFT JOIN banks b ON b.id=e.bank_id LEFT JOIN cash_boxes cb ON cb.id=e.cash_box_id LEFT JOIN check_categories cc ON cc.id=e.check_category_id LEFT JOIN cost_centers co ON co.id=e.cost_center_id LEFT JOIN purchase_invoices pi ON pi.id=e.purchase_invoice_id WHERE COALESCE(e.status,'posted')<>'reversed' ORDER BY e.id").all().map((r) => ({ عنوان: r.title, 'مبلغ (ریال)': toFa(r.amount), دسته: r.category, 'نوع پرداخت': r.pay_type, تاریخ: r.date, 'کد حساب هزینه': r.account_code, 'بانک/شناسه بانک': r.bank_name, 'صندوق/شناسه صندوق': r.cash_box_name, 'دسته چک/شناسه': r.check_category_name, 'مرکز هزینه/شناسه': r.cost_center_name, 'شماره فاکتور خرید': r.purchase_invoice_num, 'سربار تولید': r.is_overhead ? 'بله' : 'خیر', شرح: r.note }));
  if (['coa-codes', 'ledger-accounts', 'subsidiary-accounts'].includes(entity)) {
    let rows = coaDepth(db.prepare('SELECT * FROM chart_of_accounts WHERE is_active=1 ORDER BY code').all());
    if (entity === 'ledger-accounts') rows = rows.filter((r) => r._depth === 1);
    if (entity === 'subsidiary-accounts') rows = rows.filter((r) => r._depth >= 2);
    return rows.map((r) => ({ کد: r.code, 'نام حساب': r.name, نوع: r.type, 'کد والد': r.parent_code || '', سطح: r.level ?? r._depth, ماهیت: r.nature, 'نوع مانده': r.balance_type, 'عنصر بهای تمام‌شده': r.is_cost_element ? 'بله' : 'خیر', 'نوع تفصیلی': r.tafsili_type, فعال: r.is_active ? 'بله' : 'خیر' }));
  }
  if (entity === 'detail-accounts') return db.prepare('SELECT d.*,c.code category_code,c.name category_name FROM detail_accounts d LEFT JOIN detail_categories c ON c.id=d.detail_category_id ORDER BY d.code').all().map((r) => ({ 'کد تفصیلی': r.code, نام: r.name, 'کد دسته': r.category_code, دسته: r.category_name, 'جدول مرتبط': r.linked_table, 'شناسه مرتبط': r.linked_id, فعال: r.is_active ? 'بله' : 'خیر' }));
  if (entity === 'sales-invoices') return explodeDocuments(db.prepare("SELECT i.*,c.biz customer_name,w.name warehouse_name,w.code warehouse_code,b.name bank_name,cb.name cash_box_name,cc.name check_category_name,co.name cost_center_name FROM invoices i LEFT JOIN customers c ON c.id=i.cust_id LEFT JOIN warehouses w ON w.id=i.warehouse_id LEFT JOIN banks b ON b.id=i.bank_id LEFT JOIN cash_boxes cb ON cb.id=i.cash_box_id LEFT JOIN check_categories cc ON cc.id=i.check_category_id LEFT JOIN cost_centers co ON co.id=i.cost_center_id WHERE COALESCE(i.deleted_at,0)=0 ORDER BY i.id").all(), 'customer_name', 'مشتری', 'num', 'قیمت واحد (ریال)');
  if (entity === 'purchases') return explodeDocuments(db.prepare("SELECT i.*,s.name supplier_name,w.name warehouse_name,w.code warehouse_code,b.name bank_name,cb.name cash_box_name,cc.name check_category_name,co.name cost_center_name FROM purchase_invoices i LEFT JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN warehouses w ON w.id=i.warehouse_id LEFT JOIN banks b ON b.id=i.bank_id LEFT JOIN cash_boxes cb ON cb.id=i.cash_box_id LEFT JOIN check_categories cc ON cc.id=i.check_category_id LEFT JOIN cost_centers co ON co.id=i.cost_center_id WHERE COALESCE(i.status,'posted')<>'reversed' ORDER BY i.id").all(), 'supplier_name', 'تأمین‌کننده', 'num', 'قیمت واحد (ریال)');
  if (entity === 'sales-returns') return explodeDocuments(db.prepare("SELECT r.*,c.biz customer_name,i.num invoice_num FROM sales_returns r LEFT JOIN customers c ON c.id=r.cust_id LEFT JOIN invoices i ON i.id=r.invoice_id WHERE COALESCE(r.status,'posted')<>'reversed' ORDER BY r.id").all(), 'customer_name', 'مشتری', 'id', 'قیمت واحد (ریال)', 'invoice_num');
  if (entity === 'purchase-returns') return explodeDocuments(db.prepare("SELECT r.*,s.name supplier_name,i.num invoice_num FROM purchase_returns r LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN purchase_invoices i ON i.id=r.purchase_invoice_id WHERE COALESCE(r.status,'posted')<>'reversed' ORDER BY r.id").all(), 'supplier_name', 'تأمین‌کننده', 'id', 'قیمت واحد (ریال)', 'invoice_num');
  if (entity.startsWith('warehouse-')) {
    const type = entity.replace('warehouse-', '');
    return db.prepare(`SELECT m.*,p.code product_code,p.name product_name,fw.name from_name,tw.name to_name FROM warehouse_moves m LEFT JOIN products p ON p.id=m.product_id LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id WHERE m.type=? ORDER BY m.id`).all(type).map((r) => ({ 'شماره سند': r.id, 'انبار مبدأ': r.from_name, 'انبار مقصد': r.to_name, تاریخ: r.date, 'کد کالا': r.product_code, 'نام کالا': r.product_name, تعداد: r.qty, 'بهای واحد (ریال)': r.unit_cost_rial, 'مبلغ (ریال)': r.amount_rial, شرح: r.note }));
  }
  if (entity.startsWith('consignments-')) {
    const direction = entity.endsWith('-in') ? 'in' : 'out';
    return db.prepare('SELECT c.*,p.code product_code,p.name product_name FROM consignments c LEFT JOIN products p ON p.id=c.product_id WHERE c.direction=? ORDER BY c.id').all(direction).map((r) => ({ 'طرف حساب': r.party_name, تلفن: r.party_phone, 'کد کالا': r.product_code, 'نام کالا': r.product_name, تعداد: r.qty, 'قیمت واحد (ریال)': toFa(r.unit_price), تاریخ: r.date, وضعیت: r.status, شرح: r.note }));
  }
  if (entity === 'journal-docs') return db.prepare(`SELECT je.id,je.entry_date,je.doc_type,je.description,je.cost_center_id AS header_cost_center_id,jl.account_code,jl.account_name,jl.debit,jl.credit,jl.debit_rial,jl.credit_rial,jl.detail_account_id,jl.cost_center_id,jl.project_id,jl.tax_type,jl.description line_description FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id WHERE COALESCE(je.deleted_at,0)=0 ORDER BY je.id,jl.id`).all().map((r) => ({ 'شماره سند': r.id, تاریخ: r.entry_date, 'نوع سند': r.doc_type, 'شرح سند': r.description, 'مرکز هزینه/شناسه': r.cost_center_id || r.header_cost_center_id || '', 'کد حساب': r.account_code, 'نام حساب': r.account_name, 'شناسه تفصیلی': r.detail_account_id || '', 'شناسه پروژه': r.project_id || '', 'نوع مالیات': r.tax_type || '', 'بدهکار (ریال)': r.debit_rial != null ? r.debit_rial : toFa(r.debit), 'بستانکار (ریال)': r.credit_rial != null ? r.credit_rial : toFa(r.credit), 'شرح ردیف': r.line_description }));
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
        تاریخ: doc.date, 'نوع فاکتور': doc.type || '', 'نوع پرداخت': doc.pay_type || '',
        'کد انبار': doc.warehouse_code || doc.warehouse_name || '', 'بانک/شناسه بانک': doc.bank_name || '',
        'صندوق/شناسه صندوق': doc.cash_box_name || '', 'دسته چک/شناسه': doc.check_category_name || '',
        'مرکز هزینه/شناسه': doc.cost_center_name || '', 'کرایه حمل (ریال)': toFa(doc.freight_amount),
        'نوع کرایه': doc.freight_type || '', 'معاف از مالیات': doc.vat_exempt ? 'بله' : 'خیر',
        'مدت چک': doc.cheque_duration || '', 'سررسید چک': doc.cheque_due_date || '',
        'اطلاعات چک': doc.cheque_info || '', 'کانال فروش': doc.sales_channel || '',
        'منبع سرنخ': doc.lead_source || '', کمپین: doc.campaign || '',
        'کد کالا': line.code || line.product_code || line.product_id, 'نام کالا': line.name,
        تعداد: line.qty, [priceLabel]: toFa(line.price), 'تخفیف درصد': line.disc || 0,
        'تخفیف کل درصد': doc.disc || 0, شرح: doc.note || '',
      });
    }
  }
  return out;
}

function isBlankExcelRow(row) {
  return Object.values(row || {}).every((v) => text(v) === '');
}

/**
 * Upsert planner: within-file duplicates are skipped; DB matches become PUT updates
 * (parties / products / coa). New rows stay POST. Returns { actions, duplicates, updates }.
 */
function dedupeExcelActions(db, entity, actions) {
  const duplicates = [];
  const updates = [];
  const kept = [];

  function skipInFile(label, reason, key) {
    duplicates.push({ label, reason, key: key || '', action: 'skip' });
  }
  function keepCreate(a) {
    kept.push(a);
  }
  function keepUpdate(a, label, reason, key) {
    a.upsert = 'update';
    updates.push({ label: label || a.label, reason, key: key || '' });
    duplicates.push({ label: label || a.label, reason: reason + ' → به‌روزرسانی', key: key || '', action: 'update' });
    kept.push(a);
  }

  if (entity === 'parties') {
    const seenPhone = new Set();
    const seenCode = new Set();
    for (const a of actions) {
      const phone = text(a.body?.phone);
      const code = text(a.body?.person_code);
      if (phone && seenPhone.has(phone)) { skipInFile(a.label || 'شخص', 'تلفن تکراری در همین فایل اکسل', phone); continue; }
      if (code && seenCode.has(code)) { skipInFile(a.label || 'شخص', 'کد شخص تکراری در همین فایل اکسل', code); continue; }
      const existing = (phone && db.prepare('SELECT id FROM parties WHERE phone=? AND is_active=1').get(phone))
        || (code && db.prepare('SELECT id FROM parties WHERE person_code=?').get(code));
      if (existing) {
        a.method = 'PUT';
        a.path = `/parties/${existing.id}`;
        a.body = { ...a.body, from_excel: true, src_system: 'excel', excel_upsert: true };
        keepUpdate(a, a.label || 'شخص', 'از قبل در سیستم — آپدیت', phone || code);
      } else {
        keepCreate(a);
      }
      if (phone) seenPhone.add(phone);
      if (code) seenCode.add(code);
    }
    return { actions: kept, duplicates, updates };
  }

  if (entity === 'products') {
    const seenCode = new Set();
    const seenBarcode = new Set();
    const seenName = new Set();
    for (const a of actions) {
      const code = text(a.body?.code);
      const barcode = text(a.body?.barcode);
      const name = text(a.body?.name);
      if (code && seenCode.has(code)) { skipInFile(a.label || name || 'کالا', 'کد کالا تکراری در همین فایل اکسل', code); continue; }
      if (barcode && seenBarcode.has(barcode)) { skipInFile(a.label || name || 'کالا', 'بارکد تکراری در همین فایل اکسل', barcode); continue; }
      if (name && seenName.has(name)) { skipInFile(a.label || name || 'کالا', 'نام کالا تکراری در همین فایل اکسل', name); continue; }

      const existing = (code && db.prepare('SELECT * FROM products WHERE code=?').get(code))
        || (barcode && db.prepare('SELECT * FROM products WHERE barcode=?').get(barcode))
        || (name && db.prepare('SELECT * FROM products WHERE name=?').get(name));

      if (existing) {
        // Preserve photo + product code unless Excel explicitly provides a new non-empty code
        const body = { ...a.body, from_excel: true, src_system: 'excel', excel_upsert: true };
        if (!text(body.code)) delete body.code;
        else body.code = existing.code || body.code; // never blank out code on upsert
        if (!text(body.barcode)) delete body.barcode;
        delete body.image;
        delete body.images;
        a.method = 'PUT';
        a.path = `/products/${existing.id}`;
        a.body = body;
        a.label = (a.label || name || 'کالا') + ' (آپدیت)';
        keepUpdate(a, a.label, 'کالای تکراری — موجودی/فیلدها آپدیت؛ عکس و کد حفظ می‌شود', code || barcode || name);
      } else {
        keepCreate(a);
      }
      if (code) seenCode.add(code);
      if (barcode) seenBarcode.add(barcode);
      if (name) seenName.add(name);
    }
    return { actions: kept, duplicates, updates };
  }

  if (['coa-codes', 'ledger-accounts', 'subsidiary-accounts'].includes(entity)) {
    const seen = new Set();
    for (const a of actions) {
      const code = text(a.body?.code);
      if (code && seen.has(code)) { skipInFile(a.label || code || 'حساب', 'کد حساب تکراری در همین فایل اکسل', code); continue; }
      const existing = code && db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(code);
      if (existing) {
        a.method = 'PUT';
        a.path = `/accounting/chart-of-accounts/${encodeURIComponent(code)}`;
        a.body = { ...a.body, from_excel: true, excel_upsert: true };
        keepUpdate(a, a.label || code, 'کد حساب موجود — نام/والد/نوع آپدیت', code);
      } else {
        keepCreate(a);
      }
      if (code) seen.add(code);
    }
    return { actions: kept, duplicates, updates };
  }

  return { actions, duplicates, updates };
}

function buildActions(db, entity, rows) {
  if (entity === 'parties') {
    const out = [];
    rows.forEach((r, i) => {
      const fullName = field(r, 'نام*', 'نام', 'full_name');
      const phone = field(r, 'تلفن*', 'تلفن', 'phone');
      if (!fullName || !phone) return;
      const groupValue = field(r, 'گروه');
      const expertValue = field(r, 'کارشناس');
      const group = groupValue ? requireRef(i + 2, 'گروه اشخاص', partyGroup(db, groupValue)) : null;
      const expert = expertValue ? requireRef(i + 2, 'کارشناس', appUser(db, expertValue)) : null;
      out.push(action('/parties', {
        person_code: field(r, 'کد شخص'), full_name: fullName,
        legal_type: field(r, 'نوع شخصیت') || 'real', company_name: field(r, 'نام شرکت'),
        prefix: field(r, 'پیشوند'), phone,
        secondary_phone: field(r, 'تلفن دوم'), mobile: field(r, 'موبایل'), fax: field(r, 'فکس'),
        email: field(r, 'ایمیل'), national_id: field(r, 'کد ملی'), economic_code: field(r, 'کد اقتصادی'),
        city: field(r, 'شهر'), province: field(r, 'استان'), address: field(r, 'آدرس'),
        postal_code: field(r, 'کد پستی'), birth_date: field(r, 'تاریخ تولد'),
        party_group_id: group?.id || null,
        party_roles: text(field(r, 'سمت‌ها')).split(/[|,،]/).map(x => x.trim()).filter(Boolean),
        segment: field(r, 'بخش‌بندی') || 'C', store_type: field(r, 'نوع فروشگاه'),
        source: field(r, 'منبع'), referrer: field(r, 'معرف'), account_nature: field(r, 'ماهیت حساب'),
        credit_limit_rial: Math.round(num(field(r, 'سقف اعتبار (ریال)'))),
        opening_balance_rial: Math.round(num(field(r, 'مانده اول دوره (ریال)'))),
        opening_balance_date: field(r, 'تاریخ مانده اول دوره'), user_id: expert?.id || undefined,
        notes: field(r, 'یادداشت', 'شرح'), biz: fullName,
      }, `شخص ردیف ${i + 2}`));
    });
    return out;
  }
  if (entity === 'products') {
    const out = [];
    rows.forEach((r, i) => {
      const name = field(r, 'نام کالا*', 'نام کالا');
      if (!name) return;
      const whValue = field(r, 'انبار اصلی');
      const wh = whValue ? requireRef(i + 2, 'انبار اصلی', warehouse(db, whValue)) : null;
      out.push(action('/products/quick', {
        name, full_name: field(r, 'نام کامل کالا'),
        code: field(r, 'کد کالا'), barcode: field(r, 'بارکد'), category: field(r, 'دسته'),
        unit: field(r, 'واحد') || 'عدد', warehouse_id: wh?.id || null,
        stock: Math.max(0, Math.trunc(num(field(r, 'موجودی')))),
        stock_alert: Math.max(0, Math.trunc(num(field(r, 'هشدار موجودی')))) || 5,
        // UI stores product money as rial identity — do not /10
        price: Math.round(num(field(r, 'قیمت فروش (ریال)'))),
        cost: Math.round(num(field(r, 'بهای تمام‌شده (ریال)', 'بهای خرید (ریال)'))),
        consumer_price: Math.round(num(field(r, 'قیمت مصرف‌کننده (ریال)'))),
        opening_price: Math.round(num(field(r, 'قیمت اول دوره (ریال)'))),
        colors: Math.max(1, Math.trunc(num(field(r, 'تعداد رنگ')))) || 1,
        pack_size: Math.max(1, Math.trunc(num(field(r, 'تعداد در پک')))) || 1,
        product_type: field(r, 'نوع کالا'), product_index: field(r, 'شاخص کالا'),
        tax_id: field(r, 'شناسه مالیاتی'), location: field(r, 'محل نگهداری'),
        sms_code: field(r, 'کد پیامک'), note: field(r, 'یادداشت', 'شرح'),
      }, `ردیف ${i + 2}`));
    });
    return out;
  }
  if (entity.startsWith('opening-')) {
    const direction = entity === 'opening-recv-cheques' ? 'in' : 'out';
    if (entity !== 'opening-recv-cheques' && entity !== 'opening-pay-cheques') {
      throw new Error(`نوع فایل چک اول دوره نامعتبر است: ${entity}`);
    }
    const out = [];
    rows.forEach((r, i) => {
      const rowNo = i + 2;
      const chequeNumber = text(field(r, 'شماره چک*', 'شماره چک', 'cheque_number'));
      const amountRial = Math.round(num(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)', 'amount', 'مبلغ')));
      if (!chequeNumber && !amountRial) return; // skip blank-ish rows
      if (!chequeNumber) throw new Error(`ردیف ${rowNo}: شماره چک الزامی است`);
      if (!amountRial || amountRial <= 0) {
        throw new Error(`ردیف ${rowNo}: مبلغ (ریال) باید عدد مثبت باشد — مقدار نامعتبر یا خالی`);
      }
      if (amountRial > 1e15) throw new Error(`ردیف ${rowNo}: مبلغ خارج از محدوده مجاز است`);
      out.push(action('/cheque-records', {
        direction, opening: true, from_excel: true,
        cheque_number: chequeNumber,
        amount: amountRial,
        issue_date: excelDateCell(field(r, 'تاریخ صدور', 'issue_date')),
        receive_date: excelDateCell(field(r, 'تاریخ دریافت', 'receive_date')),
        due_date: excelDateCell(field(r, 'تاریخ سررسید', 'due_date')),
        bank_name: text(field(r, 'بانک', 'bank_name')),
        branch: text(field(r, 'شعبه', 'branch')),
        sayadi: text(field(r, 'شماره صیادی', 'sayadi')),
        sheba: text(field(r, 'شبا', 'sheba')),
        account_number: text(field(r, 'شماره حساب', 'account_number')),
        party_name: text(field(r, 'طرف حساب', 'party_name')),
        status: text(field(r, 'وضعیت')) || 'مانده اول دوره',
        status_note: text(field(r, 'شرح وضعیت')),
        note: text(field(r, 'شرح', 'note')),
      }, `چک ردیف ${rowNo}`));
    });
    if (!out.length) throw new Error('هیچ ردیف معتبری برای چک‌های اول دوره یافت نشد — شماره چک و مبلغ (ریال) را بررسی کنید');
    return out;
  }
  if (entity === 'fixed-assets') {
    const out = [];
    rows.forEach((r, i) => {
      const rowNo = i + 2;
      const name = text(field(r, 'نام دارایی*', 'نام*', 'نام', 'name'));
      const costRial = Math.round(num(field(r, 'بهای تمام‌شده (ریال)*', 'بهای تمام‌شده (ریال)', 'cost_rial')));
      if (!name && !costRial) return;
      if (!name) throw new Error(`ردیف ${rowNo}: نام دارایی الزامی است`);
      if (!costRial || costRial <= 0) throw new Error(`ردیف ${rowNo}: بهای تمام‌شده (ریال) باید عدد مثبت باشد`);
      out.push(action('/fixed-assets', {
        code: text(field(r, 'کد', 'code')) || undefined,
        name,
        category: text(field(r, 'دسته', 'category')) || 'تجهیزات',
        purchase_date: excelDateCell(field(r, 'تاریخ خرید', 'purchase_date')),
        cost_rial: costRial,
        salvage_rial: Math.round(num(field(r, 'ارزش اسقاط (ریال)', 'salvage_rial'))),
        useful_life_months: Math.max(1, Math.trunc(num(field(r, 'عمر مفید (ماه)', 'useful_life_months')))) || 60,
        coa_asset_code: text(field(r, 'کد حساب دارایی', 'coa_asset_code')) || '1201',
        location: text(field(r, 'محل استقرار', 'location')),
        notes: text(field(r, 'توضیحات', 'notes', 'شرح')),
      }, `دارایی ردیف ${rowNo}`));
    });
    if (!out.length) throw new Error('هیچ ردیف معتبری برای دارایی ثابت یافت نشد');
    return out;
  }
  if (entity === 'settlements') return rows.map((r, i) => {
    const direction = text(field(r, 'جهت عملیات*', 'جهت عملیات')).toLowerCase() || 'receive';
    const amount = fromRial(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)'));
    const bankId = optionalRefId(db, 'banks', field(r, 'بانک/شناسه بانک'), ['id', 'name'], 'بانک', i + 2);
    const cashBoxId = optionalRefId(db, 'cash_boxes', field(r, 'صندوق/شناسه صندوق'), ['id', 'code', 'name'], 'صندوق', i + 2);
    const checkCategoryId = optionalRefId(db, 'check_categories', field(r, 'دسته چک/شناسه'), ['id', 'code', 'name'], 'دسته چک', i + 2);
    if (['pay', 'payment', 'پرداخت'].includes(direction)) {
      const s = requireRef(i + 2, 'تأمین‌کننده', supplier(db, field(r, 'طرف حساب*', 'طرف حساب')));
      const inv = field(r, 'شماره فاکتور') ? requireRef(i + 2, 'فاکتور خرید', invoice(db, field(r, 'شماره فاکتور'), 'purchase_invoices')) : null;
      return action('/purchases/payments', {
        supplier_id: s.id, purchase_invoice_id: inv?.id || null, amount,
        pay_type: field(r, 'نوع پرداخت') || 'cash', date: field(r, 'تاریخ'), note: field(r, 'شرح'),
        bank_id: bankId, cash_box_id: cashBoxId, check_category_id: checkCategoryId,
      }, `پرداخت ردیف ${i + 2}`);
    }
    const c = requireRef(i + 2, 'مشتری', customer(db, field(r, 'طرف حساب*', 'طرف حساب', 'مشتری*', 'مشتری')));
    const inv = field(r, 'شماره فاکتور') ? requireRef(i + 2, 'فاکتور فروش', invoice(db, field(r, 'شماره فاکتور'))) : null;
    return action('/accounting/settlements', {
      cust_id: c.id, invoice_id: inv?.id || null, amount,
      pay_type: field(r, 'نوع پرداخت') || 'cash', date: field(r, 'تاریخ'), note: field(r, 'شرح'),
      bank_id: bankId, cash_box_id: cashBoxId, check_category_id: checkCategoryId,
      cheque_bank: field(r, 'بانک چک'), cheque_sayadi: field(r, 'شماره صیادی'),
      cheque_number: field(r, 'شماره چک'), cheque_account: field(r, 'شماره حساب چک'),
      cheque_amount: fromRial(field(r, 'مبلغ چک (ریال)')) || amount,
      cheque_owner: field(r, 'صاحب چک'), cheque_due: field(r, 'سررسید چک'),
      cheque_status: field(r, 'وضعیت چک') || 'pending', cheque_branch: field(r, 'شعبه چک'),
      cheque_sheba: field(r, 'شبای چک'),
    }, `دریافت ردیف ${i + 2}`);
  });
  if (entity === 'expenses') return rows.map((r, i) => {
    const purchaseNo = field(r, 'شماره فاکتور خرید');
    const purchase = purchaseNo ? requireRef(i + 2, 'فاکتور خرید', invoice(db, purchaseNo, 'purchase_invoices')) : null;
    return action('/expenses', {
      title: field(r, 'عنوان*', 'عنوان'), amount: fromRial(field(r, 'مبلغ (ریال)*', 'مبلغ (ریال)')),
      category: field(r, 'دسته') || 'admin', pay_type: field(r, 'نوع پرداخت') || 'cash',
      date: field(r, 'تاریخ'), account_code: field(r, 'کد حساب هزینه') || null,
      bank_id: optionalRefId(db, 'banks', field(r, 'بانک/شناسه بانک'), ['id', 'name'], 'بانک', i + 2),
      cash_box_id: optionalRefId(db, 'cash_boxes', field(r, 'صندوق/شناسه صندوق'), ['id', 'code', 'name'], 'صندوق', i + 2),
      check_category_id: optionalRefId(db, 'check_categories', field(r, 'دسته چک/شناسه'), ['id', 'code', 'name'], 'دسته چک', i + 2),
      cost_center_id: optionalRefId(db, 'cost_centers', field(r, 'مرکز هزینه/شناسه'), ['id', 'code', 'name'], 'مرکز هزینه', i + 2),
      purchase_invoice_id: purchase?.id || null, is_overhead: bool(field(r, 'سربار تولید')),
      note: field(r, 'شرح'),
    }, `هزینه ردیف ${i + 2}`);
  });
  if (['coa-codes', 'ledger-accounts', 'subsidiary-accounts'].includes(entity)) return rows.map((r, i) => action('/accounting/chart-of-accounts', {
    code: field(r, 'کد*', 'کد'), name: field(r, 'نام حساب*', 'نام حساب'),
    type: field(r, 'نوع*', 'نوع'), parent_code: field(r, 'کد والد*', 'کد والد') || null,
    level: Math.trunc(num(field(r, 'سطح'))) || null, nature: field(r, 'ماهیت') || null,
    balance_type: field(r, 'نوع مانده') || null, is_cost_element: bool(field(r, 'عنصر بهای تمام‌شده')),
    tafsili_type: field(r, 'نوع تفصیلی') || null, is_active: field(r, 'فعال') === '' ? true : bool(field(r, 'فعال')),
  }, `حساب ردیف ${i + 2}`));
  if (entity === 'detail-accounts') return rows.map((r, i) => {
    const categoryCode = text(field(r, 'کد دسته'));
    const category = categoryCode ? db.prepare('SELECT id FROM detail_categories WHERE code=?').get(categoryCode) : null;
    if (categoryCode && !category) throw new Error(`ردیف ${i + 2}: دسته تفصیلی ${categoryCode} یافت نشد`);
    return action('/detail-accounts', {
      code: field(r, 'کد تفصیلی*', 'کد تفصیلی'), name: field(r, 'نام*', 'نام'),
      detail_category_id: category?.id || null, linked_table: field(r, 'جدول مرتبط') || null,
      linked_id: field(r, 'شناسه مرتبط') === '' ? null : Math.trunc(num(field(r, 'شناسه مرتبط'))),
      is_active: field(r, 'فعال') === '' ? true : bool(field(r, 'فعال')),
    }, `تفصیلی ردیف ${i + 2}`);
  });
  if (entity === 'sales-invoices') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const c = requireRef(number, 'مشتری', customer(db, field(first, 'مشتری*', 'مشتری')));
    const wh = field(first, 'کد انبار') ? requireRef(number, 'انبار', warehouse(db, field(first, 'کد انبار'))) : null;
    return action('/invoices', {
      cust_id: c.id, date: field(first, 'تاریخ'), type: field(first, 'نوع فاکتور') || 'final',
      pay_type: field(first, 'نوع پرداخت') || 'credit', warehouse_id: wh?.id || null,
      bank_id: optionalRefId(db, 'banks', field(first, 'بانک/شناسه بانک'), ['id', 'name'], 'بانک', number),
      cash_box_id: optionalRefId(db, 'cash_boxes', field(first, 'صندوق/شناسه صندوق'), ['id', 'code', 'name'], 'صندوق', number),
      check_category_id: optionalRefId(db, 'check_categories', field(first, 'دسته چک/شناسه'), ['id', 'code', 'name'], 'دسته چک', number),
      cost_center_id: optionalRefId(db, 'cost_centers', field(first, 'مرکز هزینه/شناسه'), ['id', 'code', 'name'], 'مرکز هزینه', number),
      freight_amount: fromRial(field(first, 'کرایه حمل (ریال)')), freight_type: field(first, 'نوع کرایه'),
      vat_exempt: bool(field(first, 'معاف از مالیات')), cheque_duration: field(first, 'مدت چک'),
      cheque_due_date: field(first, 'سررسید چک'), cheque_info: field(first, 'اطلاعات چک'),
      sales_channel: field(first, 'کانال فروش'), lead_source: field(first, 'منبع سرنخ'),
      campaign: field(first, 'کمپین'), disc: num(field(first, 'تخفیف کل درصد')), note: field(first, 'شرح'),
      rows: lines.map((r, i) => lineProduct(db, r, `${number}/${i + 1}`)),
    }, `فاکتور فروش ${number}`);
  });
  if (entity === 'purchases') return groupBy(rows).map(([number, lines]) => {
    const first = lines[0];
    const s = requireRef(number, 'تأمین‌کننده', supplier(db, field(first, 'تأمین‌کننده*', 'تأمین‌کننده')));
    const wh = field(first, 'کد انبار') ? requireRef(number, 'انبار', warehouse(db, field(first, 'کد انبار'))) : null;
    return action('/purchases', {
      supplier_id: s.id, date: field(first, 'تاریخ'), pay_type: field(first, 'نوع پرداخت') || 'credit',
      warehouse_id: wh?.id || null,
      bank_id: optionalRefId(db, 'banks', field(first, 'بانک/شناسه بانک'), ['id', 'name'], 'بانک', number),
      cash_box_id: optionalRefId(db, 'cash_boxes', field(first, 'صندوق/شناسه صندوق'), ['id', 'code', 'name'], 'صندوق', number),
      check_category_id: optionalRefId(db, 'check_categories', field(first, 'دسته چک/شناسه'), ['id', 'code', 'name'], 'دسته چک', number),
      cost_center_id: optionalRefId(db, 'cost_centers', field(first, 'مرکز هزینه/شناسه'), ['id', 'code', 'name'], 'مرکز هزینه', number),
      freight_amount: fromRial(field(first, 'کرایه حمل (ریال)')), freight_type: field(first, 'نوع کرایه'),
      vat_exempt: bool(field(first, 'معاف از مالیات')),
      disc: num(field(first, 'تخفیف کل درصد')), note: field(first, 'شرح'),
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
    const note = field(first, 'شرح') || (type === 'receipt' ? 'موجودی اول دوره' : '');
    const isOpeningReceipt = type === 'receipt' && /اول\s*دوره|افتتاحیه|موجودی\s*اول/i.test(note);
    return action('/warehouses/moves/batch', {
      type, warehouse_id: type === 'receipt' ? to?.id : from?.id, from_warehouse_id: from?.id,
      to_warehouse_id: to?.id, date: field(first, 'تاریخ'), note,
      opening: isOpeningReceipt || undefined,
      lines: lines.map((r, i) => ({
        product_id: requireRef(`${number}/${i + 1}`, 'کالا', product(db, field(r, 'کد کالا*', 'کد کالا'))).id,
        qty: Math.max(1, Math.trunc(num(field(r, 'تعداد*', 'تعداد')))),
        unit_cost_rial: Math.max(0, Math.round(num(field(r, 'بهای واحد (ریال)')))),
        amount_rial: Math.max(0, Math.round(num(field(r, 'مبلغ (ریال)')))),
      })),
    }, `${DEFINITIONS[entity].title} ${number}`);
  });
  if (entity.startsWith('consignments-')) {
    const direction = entity.endsWith('-in') ? 'in' : 'out';
    return rows.map((r, i) => {
      const p = requireRef(i + 2, 'کالا', product(db, field(r, 'کد کالا*', 'کد کالا')));
      return action('/consignments', {
        direction, party_name: field(r, 'طرف حساب*', 'طرف حساب'), party_phone: field(r, 'تلفن'),
        product_id: p.id, qty: Math.max(1, Math.trunc(num(field(r, 'تعداد*', 'تعداد')))),
        unit_price: fromRial(field(r, 'قیمت واحد (ریال)')), date: field(r, 'تاریخ'),
        status: field(r, 'وضعیت') || 'open', note: field(r, 'شرح'),
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
        // Voucher API expects INTEGER rial (then rialToLedger inside post)
        code, debit: Math.round(num(field(r, 'بدهکار (ریال)'))),
        credit: Math.round(num(field(r, 'بستانکار (ریال)'))), description: field(r, 'شرح ردیف'),
        detail_account_id: field(r, 'شناسه تفصیلی') === '' ? null : Math.trunc(num(field(r, 'شناسه تفصیلی'))),
        cost_center_id: optionalRefId(db, 'cost_centers', field(r, 'مرکز هزینه/شناسه'), ['id', 'code', 'name'], 'مرکز هزینه', `${number}/${index + 1}`),
        project_id: optionalRefId(db, 'projects', field(r, 'شناسه پروژه'), ['id', 'code', 'name'], 'پروژه', `${number}/${index + 1}`),
        tax_type: field(r, 'نوع مالیات') || null,
      };
    });
    const debit = voucherLines.reduce((sum, r) => sum + r.debit, 0);
    const credit = voucherLines.reduce((sum, r) => sum + r.credit, 0);
    if (voucherLines.length < 2 || debit !== credit || debit <= 0) {
      throw new Error(`سند ${number}: حداقل دو ردیف و جمع بدهکار/بستانکار برابر الزامی است`);
    }
    return action('/accounting/vouchers', {
      date: field(lines[0], 'تاریخ'), description: field(lines[0], 'شرح سند') || `سند وارداتی ${number}`,
      doc_type: field(lines[0], 'نوع سند') || 'manual',
      cost_center_id: optionalRefId(db, 'cost_centers', field(lines[0], 'مرکز هزینه/شناسه'), ['id', 'code', 'name'], 'مرکز هزینه', number),
      lines: voucherLines,
    }, `سند حسابداری ${number}`);
  });
  return [];
}

router.get('/:entity/template', auth, adminOrAccounting, ensureDefinition, async (req, res) => {
  await sendBook(res, req.excelDef.sampleRows || [req.excelDef.sample], req.excelDef.title, `${req.params.entity}-template.xlsx`, [
    'نام ستون‌ها را تغییر ندهید. ستون‌های دارای * الزامی هستند.',
    'همه مبالغ در قالب‌ها و خروجی‌ها فقط ریال هستند.',
    ...(req.excelDef.guide || []),
  ]);
});

router.get('/:entity/export', auth, adminOrAccounting, ensureDefinition, async (req, res) => {
  try {
    await sendBook(res, exportRows(getDB(), req.params.entity), req.excelDef.title, `${req.params.entity}.xlsx`);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:entity/prepare-import', auth, adminOrAccounting, ensureDefinition, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل اکسل انتخاب نشده است' });
  try {
    const wb = await readWorkbook(req.file.buffer, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw:true keeps Excel serial dates/numbers; excelDateCell/num coerce them
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    const rows = rawRows.filter((r) => !isBlankExcelRow(r));
    const skipped_blank = rawRows.length - rows.length;
    if (!rows.length) return res.status(400).json({ error: 'فایل اکسل فاقد ردیف داده است' });
    if (rows.length > 5000) return res.status(400).json({ error: 'حداکثر ۵۰۰۰ ردیف در هر فایل مجاز است' });
    const built = buildActions(getDB(), req.params.entity, rows);
    const { actions, duplicates, updates } = dedupeExcelActions(getDB(), req.params.entity, built);
    const updateCount = (updates || []).length;
    const skipOnly = (duplicates || []).filter((d) => d.action === 'skip').length;
    if (!actions.length && duplicates.length) {
      return res.status(400).json({
        error: `همه ردیف‌ها در فایل تکراری/نامعتبر بودند (${duplicates.length} مورد) — چیزی برای ثبت نیست`,
        skipped_duplicates: skipOnly,
        updates_count: updateCount,
        duplicates: duplicates.slice(0, 50),
      });
    }
    if (!actions.length) return res.status(400).json({ error: 'هیچ عملیات معتبری از فایل ساخته نشد' });
    const createCount = actions.filter((a) => a.upsert !== 'update').length;
    audit(req.user.id, 'prepare_excel_import', req.params.entity, null,
      `آماده‌سازی ${rows.length} ردیف: ${createCount} جدید، ${updateCount} آپدیت، ${skipOnly} رد`);
    res.json({
      ok: true, entity: req.params.entity, title: req.excelDef.title,
      row_count: rows.length, skipped_blank,
      skipped_duplicates: skipOnly,
      updates_count: updateCount,
      creates_count: createCount,
      duplicates: duplicates.slice(0, 50),
      updates: (updates || []).slice(0, 50),
      actions_count: actions.length, actions,
    });
  } catch (e) {
    res.status(400).json({ error: `خطا در اعتبارسنجی فایل: ${e.message}` });
  }
});

router._test = { DEFINITIONS, exportRows, buildActions, dedupeExcelActions };
module.exports = router;
