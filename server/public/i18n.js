/* ERP Taranom — client i18n (fa | en)
   FA is source of truth. English via T('متن فارسی') / tt(fa,en).
   API settings tab keeps technical English by design. */
(function (global) {
  const STORAGE_KEY = 'crm_lang';
  let _lang = 'fa';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'fa') _lang = saved;
  } catch (_) {}

  /** Persian → English UI map (add as needed). Exact string match. */
  const EN = {
    // chrome / nav
    'داشبورد': 'Dashboard',
    'مشتریان': 'Customers',
    'پیگیری‌ها': 'Follow-ups',
    'فاکتور': 'Invoices',
    'کالاها': 'Products',
    'یادآورها': 'Reminders',
    'گزارشات': 'Reports',
    'گزارش‌ها': 'Reports',
    'دستیار هوشمند': 'AI Assistant',
    'سفارشات پورتال': 'Portal Orders',
    'حسابداری': 'Accounting',
    'پیام‌ها': 'Messages',
    'تنظیمات': 'Settings',
    'راهنما': 'Help',
    'کاتالوگ': 'Catalog',
    'فروش بازاریاب': 'Field Sales',
    'تنظیمات برنامه': 'App Settings',
    'پنل مدیریت': 'Admin Panel',
    'پنل حسابداری': 'Accounting Panel',
    'پنل فروش': 'Sales Panel',
    // roles
    'مدیر سیستم': 'System Admin',
    'حسابدار': 'Accountant',
    'مدیر فروش': 'Sales Manager',
    'کارشناس داخلی': 'Inside Sales',
    'کارشناس میدانی': 'Field Sales',
    'دفتر پخش': 'Distribution Office',
    'کارشناس فروش': 'Sales Rep',
    // status
    'ویژه': 'VIP',
    'فعال': 'Active',
    'پیگیری': 'Follow-up',
    'خاموش': 'Silent',
    'جدید': 'New',
    'در انتظار': 'Pending',
    'در راه': 'On the way',
    'تحویل شده': 'Delivered',
    'لغو شده': 'Cancelled',
    'باز': 'Open',
    'بالا': 'High',
    'متوسط': 'Medium',
    'پایین': 'Low',
    'پیش‌فاکتور': 'Proforma',
    'فاکتور رسمی': 'Final Invoice',
    'سرنخ': 'Lead',
    'تماس': 'Contact',
    'پیشنهاد': 'Proposal',
    'مذاکره': 'Negotiation',
    'خرید کرد': 'Won',
    'از دست رفت': 'Lost',
    'خیلی کم': 'Very low',
    'خیلی زیاد': 'Very high',
    'وصول شد': 'Cleared',
    'برگشت خورد': 'Bounced',
    'لغو شد': 'Cancelled',
    'غیرفعال': 'Inactive',
    // common actions
    'ذخیره': 'Save',
    'ذخیره شد': 'Saved',
    'انصراف': 'Cancel',
    'حذف': 'Delete',
    'حذف شد': 'Deleted',
    'ویرایش': 'Edit',
    'مشاهده': 'View',
    'جستجو': 'Search',
    'بستن': 'Close',
    'خروج': 'Logout',
    'ورود': 'Login',
    'ورود به سامانه': 'Sign in',
    'نام کاربری': 'Username',
    'رمز عبور': 'Password',
    'تغییر رمز': 'Change password',
    'امنیت': 'Security',
    'حالت تاریک': 'Dark mode',
    'حالت روشن': 'Light mode',
    'حساب کاربری': 'Account',
    'منوی حساب کاربری': 'Account menu',
    'جستجوی سریع': 'Quick search',
    'اعلان‌ها': 'Notifications',
    'بازگشت به صفحه قبل': 'Go back',
    'همگام‌سازی': 'Sync',
    'همگام با مرکز': 'Synced',
    'آفلاین': 'Offline',
    'در انتظار ارسال': 'Pending upload',
    'تعارض': 'Conflict',
    // settings tabs
    'عمومی': 'General',
    'شرکت، پول، پنجره': 'Company, currency, windows',
    'کاربران': 'Users',
    'نقش و دسترسی': 'Roles & access',
    'قالب فاکتور': 'Invoice templates',
    'رسمی، عادی، حرارتی': 'Formal, casual, thermal',
    'پیام‌رسان': 'Messaging',
    'تلگرام، روبیکا، خوش‌آمد': 'Telegram, Rubika, welcome',
    'پیامک': 'SMS',
    'سرویس و قالب‌ها': 'Provider & templates',
    'پشتیبان': 'Backup',
    'بکاپ و بازیابی': 'Backup & restore',
    'وب‌سایت': 'Website',
    'سینک موجودی ووکامرس': 'WooCommerce stock sync',
    'کدینگ، سال مالی، ماژول': 'COA, fiscal year, modules',
    'قابلیت‌ها': 'Features',
    'هوش مصنوعی و پورتال مشتریان': 'AI & customer portal',
    'ممیزی': 'Audit',
    'گزارش فعالیت کاربران': 'User activity log',
    'منطقه خطر': 'Danger zone',
    'حذف دیتای تست': 'Wipe test data',
    'اتومات': 'Auto',
    'افتتاحیه': 'Opening',
    'دستی': 'Manual',
    'زبان برنامه': 'App language',
    'زبان نمایش برنامه را انتخاب کنید. بخش API در هر دو زبان اصطلاحات فنی انگلیسی را نگه می‌دارد.':
      'Choose the display language. The API settings tab keeps technical English terms in both languages.',
    'فارسی': 'Persian',
    'انگلیسی': 'English',
    'اطلاعات شرکت': 'Company info',
    'نام شرکت': 'Company name',
    'تلفن شرکت': 'Company phone',
    'آدرس شرکت': 'Company address',
    'واحد پولی': 'Currency',
    'پنجره‌های چندگانه': 'Multi-window',
    'ذخیره تنظیمات': 'Save settings',
    'تنظیمات ذخیره شد': 'Settings saved',
    // customers
    'مشتری جدید': 'New customer',
    'نام کامل': 'Full name',
    'نام فروشگاه': 'Shop name',
    'موبایل': 'Mobile',
    'عملیات': 'Actions',
    'شهر': 'City',
    'آدرس': 'Address',
    'نوع': 'Type',
    'وضعیت': 'Status',
    'ماهیت': 'Nature',
    'مانده': 'Balance',
    'کارشناس': 'Rep',
    'قالب': 'Template',
    'اکسل': 'Excel',
    'ورودی': 'Import',
    'خروجی': 'Export',
    'پورتال': 'Portal',
    'دسترسی پورتال مشتریان فعال': 'Customer portal access enabled',
    'ریسک ریزش مشتری': 'Churn risk',
    'حذف انتخاب‌شده‌ها': 'Delete selected',
    'موردی یافت نشد': 'No items found',
    'خطای ارتباط با سرور': 'Server connection error',
    'در حال اتصال به سرور…': 'Connecting to server…',
    'در حال اتصال…': 'Connecting…',
    'سرور در حال راه‌اندازی است؛ چند ثانیه صبر کنید': 'Server is starting; wait a few seconds',
    'خطا رخ داد': 'An error occurred',
    'رمز عبور با موفقیت تغییر کرد': 'Password changed successfully',
    'رمز ذخیره شد': 'Password saved',
    'فقط مدیران دسترسی دارند': 'Admins only',
    'کاربر جدید': 'New user',
    'نام': 'Name',
    'نقش': 'Role',
    'تلفن': 'Phone',
    'آخرین ورود': 'Last login',
    'هرگز': 'Never',
    'رمز': 'Password',
    'سامانه یکپارچه ERP پوشاک ترنم': 'Taranom apparel ERP',
    'ERP ترنم': 'Taranom ERP',
    'ترنم': 'Taranom',
    'رمز عبور را فراموش کرده‌اید؟': 'Forgot password?',
    'ورود پورتال مشتریان': 'Customer portal login',
    'بازگشت به ورود کارکنان': 'Back to staff login',
    'پی‌دی‌اف': 'PDF',
    'سی‌اس‌وی': 'CSV',
    'فرمول ساخت': 'Bill of materials',
    'فرمول تولید': 'Production BOM',
    'مالیات بر ارزش افزوده فروش': 'Output VAT',
    'مالیات بر ارزش افزوده خرید': 'Input VAT',
    'نوع ۱ — کسب‌وکار به کسب‌وکار': 'Type 1 — B2B',
    'پورتال مشتریان': 'Customer portal',
    'ذخیره دسترسی پورتال': 'Save portal access',
    'دسترسی پورتال مشتریان فعال شد': 'Customer portal enabled',
    'دسترسی پورتال مشتریان غیرفعال شد': 'Customer portal disabled',
    'کلید و وب‌هوک': 'Keys & webhooks',
    'نتیجه‌ای پیدا نشد — عبارت دیگری امتحان کنید.': 'No results — try another phrase.',
    'در حال بارگذاری کاربران...': 'Loading users…',
    'در حال بارگذاری ماژول پیامک...': 'Loading SMS module…',
    'در حال بارگذاری پشتیبان‌گیری...': 'Loading backups…',
    'در حال بارگذاری API...': 'Loading API…',
    'جمع': 'Total',
    'مشتری': 'customer',
    'ماژول حسابداری': 'Accounting module',
    'دستیار فروش هوشمند': 'Smart sales assistant',
    'نرخ مالیات ارزش افزوده پیش‌فرض': 'Default VAT rate',
    'جستجو — مشتریان، کالاها، فاکتورها و همهٔ بخش‌ها': 'Search — customers, products, invoices and all sections',
    'بروزرسانی': 'Refresh',
    'در حال اجرای تحلیل هوشمند...': 'Running smart analysis…',
    'تحلیل هوشمند انجام شد': 'Smart analysis completed',
    'خطا در پی‌دی‌اف': 'PDF error',
    'شرکت، پول، پنجره، زبان': 'Company, currency, windows, language',
    'پشتیبان و بازیابی': 'Backup & restore',
    'همگام‌سازی موجودی فروشگاه': 'Store stock sync',
    'بازگشت به برنامه اصلی': 'Back to main app',
    'صفحه اصلی': 'Home',
    'اطلاعات پایه': 'Master data',
    'عملیات': 'Operations',
  };

  function getLang() { return _lang; }

  function setLang(lang, opts) {
    lang = lang === 'en' ? 'en' : 'fa';
    _lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'fa');
    // Keep RTL layout — bilingual UI without flipping the whole shell
    document.documentElement.setAttribute('data-lang', lang);
    if (opts && opts.silent) return;
    if (typeof global.applyAppLanguage === 'function') global.applyAppLanguage();
  }

  /** Translate Persian source string when lang=en. */
  function T(fa) {
    if (fa == null) return fa;
    const s = String(fa);
    if (_lang !== 'en') return s;
    if (EN[s] != null) return EN[s];
    return s;
  }

  /** Explicit bilingual pair. */
  function tt(fa, en) {
    return _lang === 'en' ? (en != null ? en : fa) : fa;
  }

  function isEn() { return _lang === 'en'; }
  function isFa() { return _lang !== 'en'; }

  /** Register / extend map at runtime. */
  function addMap(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(k => { EN[k] = obj[k]; });
  }

  global.I18N = { getLang, setLang, T, tt, isEn, isFa, addMap, EN, STORAGE_KEY };
  global.T = T;
  global.tt = tt;
  global.getAppLang = getLang;
  global.setAppLang = setLang;

  // Apply early for first paint of static bits
  document.documentElement.setAttribute('data-lang', _lang);
  document.documentElement.setAttribute('lang', _lang === 'en' ? 'en' : 'fa');
})(typeof window !== 'undefined' ? window : globalThis);
