/**
 * ساختار منوی حسابداری — مدل A: سایدبار ماژول‌محور
 * هر ماژول سرگروه با زیرگروه‌های: اطلاعات پایه / عملیات / گزارشات
 * ACC_TAB_RESOLVE: نگاشت شناسه منو → handler داخلی loadAccTab
 */
const ACC_TAB_RESOLVE = {
  'acc-dash': 'general',
  'acc-products': 'products',
  'acc-incomes': 'incomes',
  'acc-expenses': 'expenses-list',
  'acc-opening-recv-cheques': 'opening-recv-cheques',
  'acc-opening-pay-cheques': 'opening-pay-cheques',
  'acc-coa-codes': 'coa-codes',
  'acc-account-groups': 'account-groups',
  'acc-ledger-accounts': 'ledger-accounts',
  'acc-subsidiary-accounts': 'subsidiary-accounts',
  'acc-detail-accounts': 'detail-accounts',
  'acc-detail-categories': 'detail-categories',
  'acc-other-details': 'other-details',
  'acc-equity-info': 'equity-info',
  'acc-shareholders': 'shareholders',
  'acc-currencies': 'currencies',
  'acc-fx-rates': 'fx-rates',
  'acc-pos-devices': 'pos-devices',
  'acc-pos-report': 'pos-report',
  'acc-scale-settings': 'scale-settings',
  'acc-company-profile': 'company-profile',
  'acc-units': 'units',
  'acc-incentive-plans': 'commissions',
  'acc-fiscal-period': 'fiscal-period',
  'acc-settlements': 'settlements',
  'acc-receipts': 'settlements',
  'acc-payments': 'settlements',
  'acc-cheques-recv': 'cheques',
  'acc-cheques-pay': 'cheque-register',
  'acc-sales-invoices': 'sales-invoices',
  'acc-normal-invoices': 'normal-invoices',
  'acc-final-invoices': 'final-invoices',
  'acc-proforma': 'proforma-invoices',
  'acc-purchases': 'purchases',
  'acc-sales-returns': 'sales-returns',
  'acc-purchase-returns': 'purchase-returns',
  'acc-orders-list': 'orders',
  'acc-account-transfer': 'transfers',
  'acc-warehouse-ops': 'warehouse-ops',
  'acc-warehouse-report': 'warehouse-report',
  'acc-stocktaking': 'stocktaking',
  'acc-inv-batches': 'inv-batches',
  'acc-fabric-rolls': 'fabric-rolls',
  'acc-fabric-roll-kardex': 'fabric-roll-kardex',
  'acc-cutting-lays': 'cutting-lays',
  'acc-inv-reservations': 'inv-reservations',
  'acc-inv-landed': 'inv-landed',
  'acc-moadian-hub': 'moadian',
  'acc-petty-cash-ops': 'petty-cash',
  'acc-item-kardex': 'item-kardex',
  'acc-shared-ledger': 'shared-ledger',
  'acc-consignments': 'consignments',
  'acc-trust-checks': 'trust-checks',
  'acc-cheque-register': 'cheque-register',
  'acc-journal-docs': 'journal-docs',
  'acc-journal-entry': 'vouchers',
  'acc-opening-voucher': 'vouchers',
  'acc-close-temp': 'vouchers',
  'acc-close-perm': 'vouchers',
  'acc-revaluation': 'vouchers',
  'acc-financial-statement': 'balance-sheet',
  'acc-pl-statement': 'general',
  'acc-trial-balance': 'trial-balance',
  'acc-journal-book': 'journal-docs',
  'acc-invoice-list-tax': 'moadian',
  'acc-reconciliation': 'adv-reports',
  'acc-production': 'production-dashboard',
  'acc-production-orders': 'production-orders',
  'acc-production-boms': 'production-boms',
  'acc-production-dashboard': 'production-dashboard',
  'acc-production-close': 'production-close',
  'acc-production-monthly-profit': 'production-monthly-profit',
  'acc-production-cost-sheet': 'production-cost-sheet',
  'acc-production-estimate': 'production-estimate',
  'acc-production-kanban': 'production-kanban',
  'acc-production-variance': 'production-variance',
  'acc-production-mrp': 'production-mrp',
  'acc-production-rates': 'production-rates',
  'acc-production-access': 'production-access',
  'acc-payroll': 'payroll',
  'acc-payroll-employees': 'payroll',
  'acc-payroll-structures': 'payroll',
  'acc-payroll-periods': 'payroll',
  'acc-payroll-tax': 'payroll',
  'acc-payroll-processing': 'payroll',
  'acc-payroll-year-end': 'payroll',
  'acc-payroll-reports': 'payroll',
  'acc-fixed-assets': 'fixed-assets',
  'acc-adv-reports': 'adv-reports',
  'acc-receivables': 'receivables',
  'acc-statement': 'statement',
  'acc-parties': 'parties',
  'acc-party-groups': 'party-groups',
  'acc-product-groups': 'product-groups',
  'acc-warehouses': 'warehouses',
  'acc-cash-boxes': 'cash-boxes',
  'acc-banks': 'banks',
  'acc-check-categories': 'check-categories',
  'acc-cost-centers': 'cost-centers',
  'acc-customer-groups': 'customer-groups',
  'acc-commissions': 'commissions',
  'acc-reps': 'reps',
  'acc-moadian': 'moadian',
  'acc-portal-units': 'portal-units',
  'acc-portal-my-dept': 'portal-my-dept',
  'acc-bank-recon': 'bank-recon',
  'acc-budgeting': 'budgeting',
  'acc-reserves': 'reserves',
  'acc-vat-return': 'vat-return',
  'acc-seasonal-169': 'seasonal-169',
  'acc-cash-flow-std': 'cash-flow-std',
  'acc-kpi-dashboard': 'kpi-dashboard',
  'acc-settings': 'company-settings',
  'acc-backup': 'company-settings',
  'acc-devices': 'sync-devices',
  'acc-fiscal-ops': 'fiscal-period',
  'acc-expense-categories': 'expense-categories',
  'acc-person-positions': 'person-positions',
};

/** Model A: module → subgroups (اطلاعات پایه / عملیات / گزارشات) */
const ACC_NAV_SECTIONS = [
  { title: 'صفحه اصلی', items: [
    { id: 'exit-acc-shell', icon: '🔙', label: 'بازگشت به برنامه اصلی' },
    { id: 'acc-dash', icon: '📊', label: 'داشبورد' },
  ]},
  { title: 'اشخاص', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-parties', icon: '👥', label: 'اطلاعات اشخاص' },
      { id: 'acc-party-groups', icon: '📂', label: 'گروه‌های اشخاص' },
      { id: 'acc-person-positions', icon: '🏷️', label: 'سمت و جایگاه' },
      { id: 'acc-customer-groups', icon: '📂', label: 'گروه‌های مشتری' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-receivables', icon: '🧾', label: 'مطالبات مشتریان' },
      { id: 'acc-statement', icon: '📄', label: 'صورت‌حساب مشتری' },
    ]},
  ]},
  { title: 'کالا', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-products', icon: '📦', label: 'کالاها' },
      { id: 'acc-product-groups', icon: '🏷️', label: 'گروه‌های کالا' },
      { id: 'acc-product-colors', icon: '🎨', label: 'رنگ‌های کالا (SKU)' },
      { id: 'acc-product-sizes', icon: '📐', label: 'سایزهای کالا (SKU)' },
      { id: 'acc-units', icon: '📏', label: 'واحدهای اندازه‌گیری' },
    ]},
    { title: 'گزارشات', items: [
      /* کاردکس canonical فقط زیر انبار — از تکرار در کالا اجتناب شود */
    ]},
  ]},
  { title: 'انبار', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-warehouses', icon: '🏭', label: 'انبارها' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-warehouse-ops', icon: '📦', label: 'رسید، حواله و انتقال' },
      { id: 'acc-stocktaking', icon: '📋', label: 'انبارگردانی' },
      { id: 'acc-inv-batches', icon: '🏷️', label: 'بچ / سریال' },
      { id: 'acc-fabric-rolls', icon: '🧵', label: 'دریافت طاقه' },
      { id: 'acc-inv-reservations', icon: '🔒', label: 'رزرو موجودی' },
      { id: 'acc-inv-landed', icon: '🚢', label: 'هزینه حمل (Landed Cost)' },
      { id: 'acc-consignments', icon: '🔄', label: 'کالای امانی' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-warehouse-report', icon: '📊', label: 'گزارش جامع انبار' },
      { id: 'acc-item-kardex', icon: '🗃️', label: 'کاردکس کالا' },
      { id: 'acc-fabric-roll-kardex', icon: '🧵', label: 'گردش طاقه' },
    ]},
  ]},
  { title: 'بانک و صندوق', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-banks', icon: '🏦', label: 'بانک‌ها' },
      { id: 'acc-cash-boxes', icon: '💰', label: 'صندوق' },
      { id: 'acc-check-categories', icon: '📑', label: 'دسته چک‌ها' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-account-transfer', icon: '🔄', label: 'انتقال بین بانک و صندوق' },
      { id: 'acc-petty-cash-ops', icon: '👛', label: 'تنخواه‌گردان' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-bank-recon', icon: '🏦', label: 'تطبیق بانک' },
      { id: 'acc-pos-report', icon: '💳', label: 'گزارش کارتخوان' },
      { id: 'acc-cash-flow-std', icon: '💧', label: 'صورت جریان وجوه نقد' },
    ]},
  ]},
  { title: 'فروش و خرید', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-incomes', icon: '📈', label: 'درآمدها' },
      { id: 'acc-expenses', icon: '📉', label: 'هزینه‌ها' },
      { id: 'acc-expense-categories', icon: '🗂️', label: 'دسته‌بندی هزینه‌ها' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-sales-invoices', icon: '🧾', label: 'فاکتورهای فروش' },
      { id: 'acc-purchases', icon: '📦', label: 'فاکتورهای خرید' },
      { id: 'acc-sales-returns', icon: '↪️', label: 'برگشت از فروش' },
      { id: 'acc-purchase-returns', icon: '↩️', label: 'برگشت از خرید' },
      { id: 'acc-orders-list', icon: '🛒', label: 'لیست سفارشات' },
      { id: 'acc-settlements', icon: '💵', label: 'عملیات دریافت و پرداخت' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-pl-statement', icon: '📈', label: 'صورت سود و زیان' },
      { id: 'acc-invoice-list-tax', icon: '🧾', label: 'ارزش افزوده و صورتحساب مالیاتی' },
    ]},
  ]},
  { title: 'چک', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-opening-recv-cheques', icon: '📥', label: 'چک‌های دریافتنی اول دوره' },
      { id: 'acc-opening-pay-cheques', icon: '📤', label: 'چک‌های پرداختنی اول دوره' },
      { id: 'acc-check-categories', icon: '📑', label: 'دسته چک‌ها' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-cheques-recv', icon: '📥', label: 'چک‌های دریافتی' },
      { id: 'acc-cheques-pay', icon: '📤', label: 'چک‌های پرداختی' },
      { id: 'acc-trust-checks', icon: '🔖', label: 'چک‌های امانی' },
      { id: 'acc-cheque-register', icon: '📒', label: 'دفتر چک' },
    ]},
  ]},
  { title: 'حسابداری', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-coa-codes', icon: '🔢', label: 'کدهای حسابداری' },
      { id: 'acc-account-groups', icon: '🗂️', label: 'گروه‌های حساب' },
      { id: 'acc-ledger-accounts', icon: '📒', label: 'حساب‌های کل' },
      { id: 'acc-subsidiary-accounts', icon: '📗', label: 'حساب‌های معین' },
      { id: 'acc-detail-accounts', icon: '📘', label: 'حساب‌های تفصیلی' },
      { id: 'acc-detail-categories', icon: '🏷️', label: 'دسته‌بندی‌های تفصیلی' },
      { id: 'acc-other-details', icon: '📋', label: 'سایر حساب‌های تفصیلی' },
      { id: 'acc-equity-info', icon: '💼', label: 'اطلاعات سهام' },
      { id: 'acc-shareholders', icon: '🤝', label: 'سهامداران' },
      { id: 'acc-cost-centers', icon: '🎯', label: 'مراکز هزینه' },
      { id: 'acc-fiscal-period', icon: '📅', label: 'دوره مالی' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-journal-docs', icon: '📝', label: 'فهرست اسناد' },
      { id: 'acc-journal-entry', icon: '✍️', label: 'سند حسابداری' },
      { id: 'acc-opening-voucher', icon: '🟢', label: 'سند افتتاحیه' },
      { id: 'acc-close-temp', icon: '🟡', label: 'اختتامیه حساب‌های موقت' },
      { id: 'acc-close-perm', icon: '🔴', label: 'اختتامیه حساب‌های دائم' },
      { id: 'acc-revaluation', icon: '💱', label: 'سند تسعیر' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-adv-reports', icon: '📊', label: 'داشبورد گزارشات' },
      { id: 'acc-shared-ledger', icon: '📒', label: 'دفتر مالی مشترک' },
      { id: 'acc-trial-balance', icon: '⚖️', label: 'تراز آزمایشی' },
      { id: 'acc-financial-statement', icon: '🏛️', label: 'ترازنامه' },
      { id: 'acc-pl-statement', icon: '📈', label: 'صورت سود و زیان' },
      { id: 'acc-reconciliation', icon: '🔍', label: 'مغایرت‌گیری گردش حساب‌ها' },
      { id: 'acc-vat-return', icon: '🧾', label: 'اظهارنامه ارزش افزوده' },
      { id: 'acc-seasonal-169', icon: '📋', label: 'فصلی ماده ۱۶۹' },
      { id: 'acc-kpi-dashboard', icon: '📈', label: 'داشبورد KPI مالی' },
      { id: 'acc-reserves', icon: '🏦', label: 'اندوخته و ذخایر' },
      { id: 'acc-budgeting', icon: '📊', label: 'بودجه‌بندی' },
    ]},
  ]},
  { title: 'پورتال عملیاتی', subgroups: [
    { title: 'عملیات', items: [
      { id: 'acc-portal-units', icon: '🏢', label: 'واحدهای عملیاتی' },
      { id: 'acc-portal-my-dept', icon: '🏭', label: 'بخش من (کف کارگاه)' },
    ]},
  ]},
  { title: 'تولید', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-production-boms', icon: '📐', label: 'فرمول تولید (BOM)' },
      { id: 'acc-production-rates', icon: '⚙️', label: 'نرخ سربار مراکز' },
      { id: 'acc-production-access', icon: '🔐', label: 'دسترسی تولید' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-production-dashboard', icon: '📊', label: 'داشبورد تولید' },
      { id: 'acc-production-orders', icon: '🏭', label: 'سفارش‌های تولید' },
      { id: 'acc-cutting-lays', icon: '✂️', label: 'لایه‌چینی / رسید برش' },
      { id: 'acc-production-kanban', icon: '📋', label: 'تابلوی خط' },
      { id: 'acc-production-estimate', icon: '🧮', label: 'برآورد سریع' },
      { id: 'acc-production-mrp', icon: '📦', label: 'برنامه‌ریزی مواد (MRP)' },
      { id: 'acc-production-close', icon: '🔒', label: 'بستن دوره' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-production-variance', icon: '🔍', label: 'ماتریس انحراف' },
      { id: 'acc-production-monthly-profit', icon: '💰', label: 'سود ماهانه تولید' },
      { id: 'acc-production-cost-sheet', icon: '📄', label: 'برگه بهای تمام‌شده' },
    ]},
  ]},
  { title: 'حقوق و دستمزد', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-payroll-employees', icon: '👥', label: 'پرونده کارکنان' },
      { id: 'acc-payroll-structures', icon: '🧾', label: 'ساختار حقوق و مزایا' },
      { id: 'acc-payroll-tax', icon: '％', label: 'پلکان مالیات ماده ۸۴' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-payroll-periods', icon: '📅', label: 'دوره‌های حقوق' },
      { id: 'acc-payroll-processing', icon: '🧮', label: 'محاسبه و پردازش حقوق' },
      { id: 'acc-payroll', icon: '💳', label: 'سوابق و پرداخت حقوق' },
      { id: 'acc-payroll-year-end', icon: '🎁', label: 'عیدی و سنوات' },
    ]},
    { title: 'گزارشات', items: [
      { id: 'acc-payroll-reports', icon: '📋', label: 'گزارش بیمه و مالیات' },
    ]},
  ]},
  { title: 'دارایی ثابت', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-fixed-assets', icon: '🏢', label: 'مدیریت دارایی ثابت' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-fixed-assets', icon: '📉', label: 'استهلاک و عملیات دارایی' },
    ]},
  ]},
  { title: 'امکانات', subgroups: [
    { title: 'اطلاعات پایه', items: [
      { id: 'acc-currencies', icon: '💱', label: 'فهرست ارزها' },
      { id: 'acc-fx-rates', icon: '📊', label: 'تغییرات نرخ ارز' },
      { id: 'acc-pos-devices', icon: '💳', label: 'دستگاه‌های کارت‌خوان' },
      { id: 'acc-scale-settings', icon: '⚖️', label: 'تنظیمات ترازو' },
      { id: 'acc-company-profile', icon: '🏢', label: 'مشخصات شرکت' },
    ]},
    { title: 'عملیات', items: [
      { id: 'acc-settings', icon: '⚙️', label: 'تنظیمات سیستم' },
      { id: 'acc-devices', icon: '📱', label: 'مدیریت دستگاه‌ها' },
      { id: 'acc-backup', icon: '💾', label: 'پشتیبان‌گیری' },
      { id: 'acc-fiscal-ops', icon: '📅', label: 'عملیات سال مالی' },
      { id: 'acc-moadian', icon: '📡', label: 'سامانه مودیان' },
      { id: 'acc-commissions', icon: '🎯', label: 'انگیزه فروش' },
      { id: 'acc-reps', icon: '👔', label: 'نمایندگان فروش' },
      { id: 'help', icon: '📖', label: 'راهنما' },
    ]},
  ]},
];

function accNavFlat() {
  const out = [];
  for (const sec of ACC_NAV_SECTIONS) {
    if (sec.items) out.push(...sec.items);
    if (sec.subgroups) {
      for (const sg of sec.subgroups) out.push(...(sg.items || []));
    }
  }
  return out;
}

function resolveAccTab(navId) {
  const mapped = ACC_TAB_RESOLVE[navId];
  if (mapped) return mapped;
  if (navId && navId.startsWith('acc-')) return navId.slice(4);
  return navId;
}

function registerAccNavRoutes(ROUTES, renderAccPage) {
  for (const it of accNavFlat()) {
    if (!it.id.startsWith('acc-') || ROUTES[it.id]) continue;
    const tab = resolveAccTab(it.id);
    ROUTES[it.id] = () => renderAccPage(tab, it.icon, it.label, it.id);
  }
}
