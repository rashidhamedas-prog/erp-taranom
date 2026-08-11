# نقشه راه جامع تبدیل ERP ترنم به محصول برتر ایران

> سند اجرایی مستقیم برای Cursor  
> پروژه مرجع: `D:\soft\Claud\porje\crm-taranom\erp-taranom1`  
> تاریخ تدوین: ۱۴۰۵/۰۵/۱۰ — 2026-08-01  
> وضعیت: Master Roadmap — مبنای تحلیل، اجرا، تست و تحویل

---

## 1. مأموریت این سند

این سند باید توسط Cursor به‌عنوان نقشه راه اصلی اصلاح، تکمیل و تجاری‌سازی ERP ترنم استفاده شود. هدف، تبدیل پروژه فعلی به یک ERP تخصصی و قابل اتکای ایرانی برای تولید، پخش و عمده‌فروشی پوشاک است که CRM، حسابداری، تولید، انبار، حقوق، نمایندگان، B2B، پورتال عملیاتی و کار آفلاین را در سطح حرفه‌ای و منطبق با الزامات ایران پوشش دهد.

Cursor حق ندارد صرفاً به وجود route، جدول، دکمه یا تست سطحی استناد کند. هر قابلیت زمانی کامل است که:

1. منطق کسب‌وکار آن کامل باشد.
2. کنترل دسترسی سمت سرور داشته باشد.
3. عملیات چندجدولی آن اتمیک باشد.
4. اثر حسابداری و انبار آن صحیح و قابل ابطال باشد.
5. حالت آفلاین و sync آن تعیین تکلیف شده باشد.
6. تست واحد، یکپارچه و در مسیرهای حساس تست مرورگر داشته باشد.
7. مستندات و راهنمای داخل برنامه به‌روز شده باشد.
8. روی داده حجیم و شرایط خطا بررسی شده باشد.

---

## 2. وضعیت پایه و یافته‌های قطعی ممیزی

- بک‌اند: Node.js + Express + better-sqlite3.
- فرانت‌اند اصلی: `server/public/index.html` با حدود ۱۸٬۳۰۰ خط و حجم تقریبی ۱٫۳۳ مگابایت.
- ۶۹ فایل route و بیش از ۱۷٬۰۰۰ خط route.
- وب، Electron ویندوز و Android با Node.js embedded.
- حدود ۱۴۱ جدول در رجیستری sync.
- حداقل ۳۴۹ آزمون ماژولی و یکپارچه پاس شده‌اند.
- تست‌های schema، SMS، sync، B2B، پورتال عملیاتی، انبار، حقوق، سال مالی، مجوزهای تولید و چرخه کامل خرید/فروش/ابطال پاس شده‌اند.
- `npm run test:production` پایان نمی‌یابد.
- `test-production-bom.js` پس از T1-07 متوقف می‌شود و T1-08 به بعد اجرا نمی‌شود.
- ۴۴ فایل در `desktop/server` و ۳۵ فایل در Android embedded با `server/` اختلاف hash دارند.
- fallback ارتباط sync به HTTP وجود دارد.
- Android دارای `allowBackup=true` و `usesCleartextTraffic=true` است.
- CSP در Helmet غیرفعال است.
- CORS هنگام خالی‌بودن whitelist عملاً همه originها را می‌پذیرد.
- backup خارج از سرور و restore drill قابل اثبات نیست.
- اتصال عملیاتی کامل سامانه مودیان با محیط واقعی اثبات نشده است.
- مدل واقعی SKU بر مبنای مدل × رنگ × سایز کامل نیست.
- پورتال B2B فعلی company account، credit workflow و quote سازمانی کامل ندارد.
- سیستم license، entitlement، trial، billing و عملیات تجاری محصول کامل نیست.

---

## 3. قواعد غیرقابل‌مذاکره برای Cursor

### 3.1 قواعد مخزن

- قبل از هر تغییر، `CLAUDE.md`، `.cursorrules`، `docs/PROJECT-HANDOFF.md` و ابتدای `docs/CHANGE-LOG.md` خوانده شود.
- آرایه `SYNCABLE_TABLES` در `server/sync/tables.js` فقط append-only است.
- شماره فاکتور، خرید، BOM و اسناد فقط از `allocateNumber()` و `number_sequences` گرفته شود.
- تمام عملیات چندجدولی داخل `db.transaction()` اجرا شود.
- مبلغ مالی فقط ریال صحیح باشد و از guardهای `money.js` استفاده شود.
- حذف فیزیکی عملیات مالی ممنوع؛ ابطال باید تمام اثرهای سند، موجودی، دفتر تفصیلی و تسویه را reverse کند.
- هر قابلیت یا تغییر رفتار، Help داخل برنامه و `docs/CHANGE-LOG.md` را به‌روز کند.
- تغییرات دستگاهی باید در رجیستری sync، capture، FK mapping، backfill و file sync بررسی شود.
- هیچ secret، token، keystore password یا credential وارد Git نشود.
- هر فاز در branch مستقل با پیشوند `codex/` یا branch مورد تأیید مالک اجرا شود.
- هیچ deploy تولیدی پیش از عبور کامل gate همان فاز انجام نشود.

### 3.2 قواعد کیفیت

- رفع مشکل بدون تست regression پذیرفته نیست.
- تستی که فقط وجود string یا function را بررسی می‌کند، جایگزین تست رفتاری نیست.
- تست‌ها نباید hang کنند و هر فایل تست باید timeout کنترل‌شده و cleanup قطعی داشته باشد.
- هر endpoint مالی باید success، validation failure، permission denial، duplicate/idempotency، rollback و cancel/reverse را تست کند.
- خطاهای catch خالی در مسیرهای مالی و امنیتی ممنوع است؛ خطا باید log و در صورت لزوم rollback شود.
- تغییر schema باید دارای version، migration marker، تست DB خالی، DB موجود و اجرای دوباره باشد.
- خروجی گزارش‌ها باید با دفتر و journal قابل reconciliation باشد.

### 3.3 Definition of Done عمومی

هر task فقط وقتی Done است که:

- کد و migration کامل باشد.
- تست جدید نوشته و پاس شده باشد.
- `test-sms.js` و `test-sync.js` پاس باشند.
- suite مرتبط پاس و بدون handle باز پایان یابد.
- scriptهای inline فرانت با `new Function()` parse شوند.
- Help و CHANGE-LOG به‌روز باشند.
- سورس desktop و Android از طریق prepare رسمی همگام و hash آن تأیید شده باشد.
- smoke test روی build هدف اجرا شده باشد.

---

# بخش اول — مسیر بحرانی قبل از هر توسعه جدید

## فاز P0-A — رفع توقف BOM و قابل اعتماد کردن CI

**هدف:** همه suiteهای تولید در زمان محدود پایان یابند و تست‌های BOM واقعاً اجرا شوند.

### وظایف

- [ ] محل دقیق توقف بین T1-07 و T1-08 در `server/scripts/test-production-bom.js` با log مرحله‌ای و active-handle inspection مشخص شود.
- [ ] `createBom`، `activateBom`، `validateBom`، `detectCircular`، `resolveSubstitutes` و `explodeBom` در `server/lib/production/bom.js` برای loop، recursion، transaction lock و query کند بررسی شوند.
- [ ] cycle detection از visited-set مسیرمحور استفاده کند؛ depth limit به‌تنهایی کافی نیست.
- [ ] تمام recursionهای BOM دارای مسیر خطا و تست cycle یک‌سطحی، چندسطحی و گراف الماسی باشند.
- [ ] `test-production-bom.js` در پایان DB، timer، server و handleها را قطعی ببندد.
- [ ] برای هر تست production timeout مستقل تعریف شود تا یک فایل کل suite را معطل نکند.
- [ ] workflow تولید روی timeout منطقی شکست بخورد و artifact لاگ را نگه دارد.
- [ ] `npm run test:production` حداقل سه بار پیاپی بدون hang پاس شود.

### معیار پذیرش

- T1-01 تا آخرین تست BOM اجرا شوند.
- process حداکثر ۵ ثانیه پس از summary پایان یابد.
- suite کامل تولید روی Node 20 و نسخه Node مورد استفاده توسعه پاس شود.
- هیچ open handle ناشناخته باقی نماند.

### آزمون

```powershell
cd server
npm.cmd run test:production
node scripts/test-production-bom.js
```

---

## فاز P0-B — حذف اختلاف نسخه وب، دسکتاپ و اندروید

**هدف:** هیچ build دستگاهی با منطق قدیمی منتشر نشود.

### وظایف

- [ ] `server/` تنها source of truth اعلام و enforce شود.
- [ ] اسکریپت prepare مشترک برای desktop و Android ساخته یا یکپارچه شود.
- [ ] فایل‌های DB، uploads، backup، log و node_modules از کپی حذف شوند.
- [ ] script مقایسه SHA-256 فایل‌های runtime پس از prepare اضافه شود.
- [ ] CI در صورت اختلاف `db.js`، routeها، libها، sync، UI یا service worker شکست بخورد.
- [ ] version برنامه، manifest، service worker، Electron و Android از یک release manifest تولید شوند.
- [ ] buildهای موجود stale علامت‌گذاری و release قدیمی از کانال انتشار جدا شود.
- [ ] smoke test روی exe و APK آماده‌شده اجرا شود.

### معیار پذیرش

- اختلاف hash فایل‌های runtime پس از prepare برابر صفر باشد.
- نسخه UI، API، desktop و Android در `/api/system/app-info` یک release id مشترک نشان دهند.
- APK و desktop installer دقیقاً همان migration و routeهای central را داشته باشند، به‌جز محدودیت‌های platform.

---

## فاز P0-C — backup، restore و بازیابی بحران

**هدف:** خرابی VPS، ransomware، حذف اشتباه یا DB corruption باعث توقف کسب‌وکار نشود.

### وظایف

- [ ] سیاست RPO و RTO تعریف شود؛ پیشنهاد اولیه RPO≤15 دقیقه و RTO≤4 ساعت.
- [ ] backup محلی SQLite با روش سازگار با WAL و snapshot صحیح انجام شود.
- [ ] backupها قبل از خروج از سرور با کلید مستقل رمزنگاری شوند.
- [ ] مقصد دوم خارج از VPS و ترجیحاً object storage سازگار با S3 اضافه شود.
- [ ] retention روزانه، هفتگی، ماهانه و immutable تعریف شود.
- [ ] checksum و `PRAGMA integrity_check` برای هر backup ثبت شود.
- [ ] restore خودکار در محیط ایزوله به‌صورت هفتگی انجام و نتیجه alert شود.
- [ ] تصاویر/uploads، registry شرکت‌ها، secretهای لازم و DB همه در DR plan باشند.
- [ ] runbook بازیابی کامل سرور، شرکت واحد و یک فایل ضمیمه نوشته شود.
- [ ] مانیتور شکست backup و کمبود disk اضافه شود.

### معیار پذیرش

- یک VPS/ماشین خالی با آخرین backup در کمتر از RTO راه‌اندازی شود.
- تراز آزمایشی، تعداد فاکتورها و checksum فایل‌ها قبل و بعد restore یکسان باشد.
- کلید رمزنگاری backup روی همان VPS تنها نگهداری نشود.

---

# بخش دوم — امنیت و حریم داده

## فاز P0-S1 — اجباری کردن TLS و امن‌سازی sync

### وظایف

- [ ] HTTP fallback برای هر host غیر از `127.0.0.1` و `localhost` حذف شود.
- [ ] `normalizeCentralUrl` آدرس HTTP غیرمحلی را reject کند.
- [ ] URLهای قدیمی HTTP هنگام migration به HTTPS تبدیل شوند؛ در صورت نبود TLS اتصال متوقف شود.
- [ ] پیام خطا دیگر استفاده از HTTP را پیشنهاد نکند.
- [ ] device token rotation، revoke و expiry تعریف شود.
- [ ] tokenها در log، UI و پاسخ خطا mask شوند.
- [ ] replay request دارای nonce/idempotency و محدودیت زمانی باشد.
- [ ] certificate failure به‌عنوان خطای امنیتی ثبت شود.

### معیار پذیرش

- تست نشان دهد HTTP remote رد و HTTPS پذیرفته می‌شود.
- MITM با certificate نامعتبر نتواند داده sync دریافت کند.
- revoke دستگاه در مرکز، push و pull بعدی را فوراً مسدود کند.

---

## فاز P0-S2 — سخت‌سازی Android و Electron

### Android

- [ ] `allowBackup=false` یا data extraction rules دقیق برای حذف DB، token و secret تنظیم شود.
- [ ] `usesCleartextTraffic` عمومی خاموش شود و فقط loopback در network config مجاز باشد.
- [ ] WebView debugging در release خاموش باشد.
- [ ] mixed content، file access و universal file access غیرفعال شوند.
- [ ] APK update با checksum و امضای معتبر قبل از نصب تأیید شود.
- [ ] token و secret محلی با Android Keystore محافظت شوند.
- [ ] root/debuggable build warning تعریف شود.

### Electron

- [ ] `sandbox:true` در صورت سازگاری فعال شود.
- [ ] navigation و window-open فقط loopback معتبر را داخل app باز کنند.
- [ ] `shell.openExternal` فقط `https:` و allowlist دامنه را بپذیرد.
- [ ] permission request handler همه دسترسی‌های غیرلازم را رد کند.
- [ ] CSP برای renderer اعمال شود.
- [ ] updater قبل از نصب signature/checksum را بررسی کند.
- [ ] secret محلی با DPAPI/credential vault محافظت شود.

### معیار پذیرش

- تست deep-link مخرب، `file:`, `javascript:`, `data:` و custom scheme رد شود.
- backup سیستم‌عامل شامل DB یا device token نباشد.

---

## فاز P0-S3 — امنیت وب و API

### وظایف

- [ ] CSP واقعی با nonce/hash و بدون `unsafe-eval` طراحی شود.
- [ ] همه مسیرهای `innerHTML` inventory و داده کاربر بررسی و sanitizer مرکزی اعمال شود.
- [ ] CORS در production بدون `ALLOWED_ORIGINS` معتبر fail-fast شود.
- [ ] uploadها بر اساس MIME واقعی، signature، حجم، dimension و extension بررسی شوند.
- [ ] فایل upload شده با `Content-Disposition` و `X-Content-Type-Options` امن ارائه شود.
- [ ] SSRF در URLهای AI، update، sync، email یا webhook بررسی شود.
- [ ] rate-limit جدا برای OTP، forgot password، pairing، upload، reports و export اضافه شود.
- [ ] refresh token/rotation یا session strategy رسمی تعریف شود.
- [ ] logout all devices و session revocation اضافه شود.
- [ ] 2FA recovery codeها hash و one-time شوند.
- [ ] audit امنیتی تغییر نقش، permission، API key، backup، restore و login ثبت شود.
- [ ] secret fallback توسعه از middleware حذف و secret provider مشترک استفاده شود.
- [ ] dependency audit آنلاین در CI و Dependabot/Renovate فعال شود.

### معیار پذیرش

- مجموعه تست OWASP برای XSS، IDOR، auth bypass، upload و rate-limit پاس شود.
- کاربر یک شرکت/نقش نتواند داده خارج از scope خود بخواند یا تغییر دهد.

---

# بخش سوم — معماری، نگهداری و کارایی

## فاز P1-A — شکستن تدریجی فرانت تک‌فایلی

**اصل:** بازنویسی یک‌باره ممنوع؛ مهاجرت تدریجی بدون شکستن قابلیت‌ها.

### گام‌های فازبندی

#### فاز A1 — هسته مشترک

- [ ] API client، auth state، router، modal، toast، formatter و permissions از `index.html` خارج شوند.
- [ ] هر فایل جدا IIFE/ES module سازگار با محیط‌های فعلی باشد.
- [ ] globalهای مجاز مستند و globalهای تصادفی حذف شوند.

#### فاز A2 — حوزه‌های کسب‌وکار

- [ ] CRM و مشتریان.
- [ ] فروش، فاکتور و وصول.
- [ ] حسابداری و گزارش‌ها.
- [ ] کالا و انبار.
- [ ] تولید.
- [ ] نمایندگان و بازاریابی.
- [ ] B2B و پورتال عملیاتی.

#### فاز A3 — component و state

- [ ] table، pagination، filter، form، validation و loading/error state مشترک شوند.
- [ ] cache invalidation و request cancellation استاندارد شود.
- [ ] event listener و interval هنگام خروج صفحه cleanup شوند.

### معیار پذیرش

- حجم inline script به کمتر از ۲۰٪ مقدار فعلی برسد.
- هیچ behavior regression در Playwright رخ ندهد.
- هر حوزه مالک فایل و تست مستقل داشته باشد.

---

## فاز P1-B — migration framework رسمی

### وظایف

- [ ] جدول `schema_migrations` با version، checksum، applied_at و app_version اضافه شود.
- [ ] migrationهای جدید شماره‌دار و immutable باشند.
- [ ] startup فقط migrationهای اجرا نشده را اعمال کند.
- [ ] backup پیش از migration پرریسک گرفته شود.
- [ ] migration روی DB خالی، نسخه قبلی، DB بزرگ و اجرای دوباره تست شود.
- [ ] migration failure DB را نیمه‌کاره رها نکند.
- [ ] سازگاری نسخه قدیمی دستگاه با central جدید تعریف شود.
- [ ] حداقل نسخه مجاز sync و پیام upgrade-required اضافه شود.

### معیار پذیرش

- نسخه schema هر شرکت قابل مشاهده باشد.
- migration history قابل audit و checksum آن ثابت باشد.

---

## فاز P1-C — pagination، query performance و ظرفیت

### وظایف

- [ ] همه list endpointها pagination server-side استاندارد داشته باشند.
- [ ] قرارداد مشترک `page`, `pageSize`, `sort`, `filters`, `total` تعریف شود.
- [ ] limit حداکثر برای API تعیین شود.
- [ ] queryهای dashboard و گزارش با `EXPLAIN QUERY PLAN` بررسی شوند.
- [ ] indexهای ترکیبی بر اساس query واقعی اضافه شوند.
- [ ] N+1 queryها حذف شوند.
- [ ] export بزرگ stream یا job شود و memory را اشباع نکند.
- [ ] report cache با invalidation صحیح برای گزارش‌های سنگین اضافه شود.
- [ ] تست داده ۵۰هزار، ۵۰۰هزار و ۱میلیون سند طراحی شود.
- [ ] قفل نوشتن SQLite و busy timeout زیر بار همزمان اندازه‌گیری شود.

### آستانه پیشنهادی

- لیست معمولی p95 کمتر از ۵۰۰ms.
- dashboard p95 کمتر از ۲s.
- گزارش سنگین استاندارد کمتر از ۱۰s یا async job.
- startup معمول کمتر از ۵s پس از نبود migration جدید.

---

## فاز P1-D — PostgreSQL و مقیاس سازمانی

### وظایف

- [ ] ابتدا data access و SQL helperها از routeها تفکیک شوند.
- [ ] dialect-sensitive SQL فهرست شود.
- [ ] PostgreSQL برای central بزرگ طراحی شود؛ SQLite دستگاه‌ها حفظ شود.
- [ ] sync مرکزی با PK، sequence و transaction PostgreSQL سازگار شود.
- [ ] migration و import از SQLite به PostgreSQL نوشته شود.
- [ ] تست parity گزارش و حسابداری بین دو DB اجرا شود.

### زمان اجرا

این فاز فقط پس از پایدارشدن مشتریان و اثبات نیاز بیش از حدود ۱۵ تا ۲۰ کاربر همزمان اجرا شود.

---

# بخش چهارم — حسابداری و انطباق ایران

## فاز P0-F1 — سامانه مودیان عملیاتی

### مدل داده لازم

- [ ] taxpayer profile، شناسه حافظه مالیاتی و تنظیمات شرکت.
- [ ] tax product/service id و unit id برای هر کالا.
- [ ] invoice pattern/type، subject و settlement method.
- [ ] unique tax number، reference tax number و UID.
- [ ] payload version، hash، signature و raw request/response امن.
- [ ] status history، retry count، last error و next retry.
- [ ] original، corrective، cancellation و return relationship.

### منطق

- [ ] تولید payload مطابق آخرین specification رسمی.
- [ ] امضای دیجیتال و نگهداری امن private key.
- [ ] ارسال مستقیم یا adapter شرکت معتمد.
- [ ] queue، idempotency، retry با backoff و dead-letter.
- [ ] polling وضعیت و reconciliation روزانه.
- [ ] جلوگیری از ویرایش فاکتور ارسال‌شده؛ فقط سند اصلاحی/ابطالی.
- [ ] fallback عملیاتی هنگام قطعی سامانه و ارسال پس از اتصال.
- [ ] dashboard وضعیت و گزارش خطا قابل اقدام.

### تست و تأیید

- [ ] fixture رسمی برای انواع صورتحساب.
- [ ] sandbox/محیط آزمون واقعی.
- [ ] تأیید کتبی حسابدار رسمی یا مشاور مالیاتی.
- [ ] تست گردش اصلی، اصلاح، ابطال، برگشت، خطای اعتبارسنجی و duplicate.

---

## فاز P0-F2 — خروجی‌ها و تکالیف قانونی

- [ ] اظهارنامه ارزش افزوده از دفتر و اسناد زنده، نه صرفاً جمع فاکتورها.
- [ ] reconciliation فروش/خرید، مالیات و journal.
- [ ] خروجی معاملات فصلی یا قالب قانونی جاری.
- [ ] دفاتر الکترونیکی/خروجی دفتر روزنامه و کل مطابق الزامات روز.
- [ ] کنترل توالی و تاریخ سند در سال مالی.
- [ ] گزارش مغایرت فاکتور، مودیان، دفتر و VAT.
- [ ] قفل دوره پس از ارسال اظهارنامه با فرآیند reopen مجاز.
- [ ] نگهداری نسخه پارامترهای قانونی بر اساس تاریخ اثر.

---

## فاز P1-F3 — صورت‌های مالی استاندارد و پایان دوره

- [ ] صورت وضعیت مالی/ترازنامه با mapping قابل تنظیم.
- [ ] صورت سود و زیان و سود و زیان جامع.
- [ ] صورت جریان وجوه نقد سه‌بخشی.
- [ ] صورت تغییرات حقوق مالکانه.
- [ ] یادداشت‌های صورت مالی و comparative period.
- [ ] بستن حساب‌های موقت، سود انباشته و سند اختتامیه/افتتاحیه.
- [ ] اصلاحات سنواتی با audit کامل.
- [ ] اندوخته قانونی ۵٪ با سقف قانونی و workflow تصویب.
- [ ] سود قابل تقسیم و ثبت مصوبه.
- [ ] consolidation پایه برای چند شرکت در فاز بعدی.

---

## فاز P1-F4 — ذخایر و برآوردهای حسابداری

- [ ] aging مطالبات و مدل ذخیره مشکوک‌الوصول.
- [ ] ثبت، تعدیل و برگشت ذخیره با سند خودکار.
- [ ] NRV موجودی بر مبنای کالا/گروه و ذخیره کاهش ارزش.
- [ ] کالای راکد، کم‌گردش، ناباب و منقضی.
- [ ] ذخیره عیدی، سنوات و مرخصی استفاده‌نشده.
- [ ] هزینه‌های تحقق‌یافته پرداخت‌نشده و پیش‌پرداخت‌ها.
- [ ] provision register با creator/approver/date/evidence.

---

## فاز P1-F5 — خزانه، بانک و چک

### مغایرت بانکی

- [ ] import استاندارد CSV/Excel برای بانک‌های رایج.
- [ ] normalization شرح، شناسه و مبلغ.
- [ ] matching خودکار one-to-one، one-to-many و many-to-one.
- [ ] ruleهای قابل تنظیم و confidence score.
- [ ] ثبت کارمزد، سود، مغایرت و سند اصلاحی.
- [ ] workflow تهیه، بررسی و تأیید مغایرت.

### چک

- [ ] دریافت، نزد صندوق، واگذاری، در جریان وصول، وصول، برگشت، تعویض و استرداد.
- [ ] چک پرداختی: صادرشده، تحویل، پاس، برگشت/ابطال.
- [ ] تاریخچه کامل وضعیت و اثر حسابداری هر transition.
- [ ] صیادی، شناسه ۱۶ رقمی، بانک/شعبه و مالک.
- [ ] هشدار سررسید و dashboard تعهدات.
- [ ] ابطال هر transition با reverse صحیح.

---

## فاز P1-F6 — دارایی ثابت

- [ ] componentization دارایی و محل/مسئول نگهدارنده.
- [ ] روش خط مستقیم، نزولی و مبتنی بر کارکرد.
- [ ] آغاز بهره‌برداری، توقف و تغییر برآورد.
- [ ] انتقال، تعمیر اساسی و افزایش بها.
- [ ] فروش، اسقاط و سود/زیان واگذاری.
- [ ] impairment و reversal مجاز.
- [ ] تجدید ارزیابی با مازاد و استهلاک جدید.
- [ ] register دارایی، پلاک و barcode.
- [ ] reconciliation دفتر دارایی با GL.

---

## فاز P2-F7 — بودجه و گزارش مدیریتی

- [ ] بودجه فروش، تولید، مواد، دستمزد، سربار، OPEX و CAPEX.
- [ ] بودجه نقدی با الگوی وصول و پرداخت.
- [ ] سناریو optimistic/base/pessimistic.
- [ ] workflow تهیه، تصویب، اصلاح و version.
- [ ] واقعی در برابر بودجه و سال قبل.
- [ ] flexible budget و variance.
- [ ] CVP، نقطه سربه‌سر و حاشیه اطمینان.
- [ ] KPIهای DSO، DIO، DPO، CCC، GMROI، current ratio و cash runway.
- [ ] management pack ماهانه قابل PDF/Excel.

---

# بخش پنجم — حقوق، منابع انسانی و الزامات کار

## فاز P0-HR1 — موتور پارامتریک سالانه حقوق

- [ ] جدول نسخه‌دار قوانین حقوق برای هر سال و تاریخ اثر.
- [ ] حداقل مزد، پایه سنوات، حق مسکن، بن، اولاد، تأهل و سایر مزایا.
- [ ] سقف بیمه و اقلام مشمول/غیرمشمول.
- [ ] جدول مالیات حقوق و معافیت سالانه/ماهانه.
- [ ] ضریب اضافه‌کاری، شب‌کاری، جمعه‌کاری و نوبت‌کاری.
- [ ] عیدی، سنوات، مرخصی، مأموریت و کسورات.
- [ ] retroactive calculation با ثبت مابه‌التفاوت.
- [ ] snapshot پارامترها در payroll period برای جلوگیری از تغییر گذشته.

## فاز P1-HR2 — عملیات منابع انسانی

- [ ] پرونده پرسنلی، قرارداد و الحاقیه.
- [ ] حکم حقوقی versioned.
- [ ] حضور و غیاب، شیفت، تعطیل، مرخصی و مأموریت.
- [ ] وام، مساعده، اقساط و کسورات.
- [ ] تسویه پایان کار و خروج.
- [ ] محرمانگی فیش و دسترسی مدیر/پرسنل.
- [ ] خروجی بانک برای پرداخت گروهی.

## فاز P1-HR3 — خروجی قانونی

- [ ] خروجی/فایل سازگار با آخرین سامانه مالیات حقوق.
- [ ] خروجی لیست بیمه تأمین اجتماعی.
- [ ] گزارش مغایرت payroll با GL و پرداخت بانک.
- [ ] کنترل جمع بیمه کارگر، کارفرما و بیکاری.
- [ ] تأیید نمونه خروجی توسط متخصص حقوق و دستمزد.

---

# بخش ششم — انبار، خرید و زنجیره تأمین

## فاز P1-I1 — تکمیل کنترل موجودی

- [ ] موجودی authoritative در سطح warehouse/SKU/batch تعیین شود؛ ستون summary فقط مشتق باشد.
- [ ] negative stock policy در سطح شرکت/انبار/کالا.
- [ ] unit conversion و مقادیر تا حداقل سه رقم اعشار.
- [ ] serial/lot/batch و تاریخ انقضا.
- [ ] FIFO، moving average و policy قابل انتخاب با قفل پس از استفاده.
- [ ] کالا در راه، رسید موقت، quarantine و QC hold.
- [ ] three-count stocktaking و blind count.
- [ ] recount، approval و سند کسری/اضافه.
- [ ] dead stock، aging، turnover، ABC و reorder point.
- [ ] landed cost allocation بر اساس مبلغ، تعداد، وزن یا حجم.

## فاز P1-I2 — خرید حرفه‌ای

- [ ] درخواست خرید، استعلام، مقایسه تأمین‌کنندگان و approval.
- [ ] purchase order و partial receipt.
- [ ] سه‌طرفه PO/receipt/invoice matching.
- [ ] tolerance مقدار و قیمت.
- [ ] برگشت خرید و debit note.
- [ ] vendor scorecard برای قیمت، کیفیت و زمان تحویل.
- [ ] قرارداد خرید، حداقل سفارش و lead time.
- [ ] برنامه‌ریزی تأمین بر مبنای MRP.

---

# بخش هفتم — تولید تخصصی پوشاک

## فاز P0-APP1 — مدل واقعی محصول، رنگ و سایز

**این مهم‌ترین قابلیت تخصصی برای بازار پوشاک است.**

### مدل داده

- [ ] Product Style/Model به‌عنوان والد.
- [ ] Color و Size به‌عنوان موجودیت، نه متن آزاد.
- [ ] Variant/SKU برای ترکیب مدل × رنگ × سایز.
- [ ] barcode، قیمت، موجودی، وزن و وضعیت مستقل variant.
- [ ] size range و matrix تعریف‌پذیر.
- [ ] migration محصولات فعلی بدون از دست‌رفتن شناسه و دفتر.

### عملیات

- [ ] فاکتور، سفارش، B2B، انبار، تولید و گزارش در سطح variant.
- [ ] matrix entry سریع برای سفارش عمده.
- [ ] رزرو و available-to-promise در سطح SKU.
- [ ] تصویر والد و تصویر رنگ.
- [ ] گزارش sell-through و موجودی مدل/رنگ/سایز.

### معیار پذیرش

- یک مدل با ۴ رنگ و ۶ سایز، ۲۴ SKU مستقل داشته باشد.
- خرید/تولید/فروش یک SKU روی سایر SKUها اثر نگذارد.
- سفارش ماتریسی یک سند واحد با خطوط variant صحیح بسازد.

---

## فاز P1-APP2 — پارچه، طاقه و برش

- [ ] lot/roll پارچه با متر اولیه، عرض، رنگ و shade.
- [ ] ورود، مصرف و باقی‌مانده هر طاقه.
- [ ] marker و نسبت سایزبندی.
- [ ] lay planning و برنامه برش.
- [ ] planned/actual fabric consumption.
- [ ] پرت عادی و غیرعادی برش.
- [ ] bundle generation و barcode بسته برش.
- [ ] traceability از طاقه تا محصول نهایی.
- [ ] گزارش yield پارچه و variance برش.

## فاز P1-APP3 — عملیات خط و کنترل کیفیت

- [ ] routing استاندارد هر مدل.
- [ ] skill matrix و ظرفیت اپراتور/خط.
- [ ] bundle tracking بین مراحل.
- [ ] ثبت تعداد سالم، معیوب، دوباره‌کاری و ضایعات.
- [ ] defect code، محل عیب، علت و مسئول.
- [ ] inline QC، end-line QC و final inspection.
- [ ] AQL در صورت نیاز.
- [ ] توقف خط و علت downtime.
- [ ] OEE/efficiency خط و WIP aging.

## فاز P2-APP4 — PLM سبک و کالکشن

- [ ] season/collection.
- [ ] tech pack، measurement spec و فایل الگو.
- [ ] sample stages و approval.
- [ ] costing اولیه و target margin.
- [ ] version مواد، رنگ، سایز و artwork.
- [ ] تقویم توسعه محصول.
- [ ] approval تامین‌کننده و پارچه.

## فاز P2-APP5 — پیمانکار و محصول فرعی

- [ ] ارسال/دریافت پیمانکاری با مالکیت موجودی.
- [ ] مواد امانی نزد پیمانکار.
- [ ] SLA، نرخ ضایعات و scorecard.
- [ ] هزینه عملیات و کسورات کیفیت.
- [ ] محصول درجه دو، ضایعات قابل فروش و by-product.
- [ ] joint/by-product costing با روش مناسب و تأیید حسابداری.

---

# بخش هشتم — CRM، فروش و بازاریابی

## فاز P1-C1 — CRM قابل پیکربندی

- [ ] pipeline و stage قابل تعریف برای هر نوع فروش.
- [ ] custom fields با type، validation و permission.
- [ ] lead، account، contact و opportunity از هم تفکیک شوند.
- [ ] duplicate detection بر اساس موبایل، شناسه ملی و شباهت نام.
- [ ] merge مشتری با انتقال سفارش، دفتر و پیگیری به‌صورت امن.
- [ ] lead scoring و qualification.
- [ ] probability، expected close date و weighted forecast.
- [ ] SLA پیگیری و escalation.
- [ ] activity timeline واحد.

## فاز P1-C2 — کمپین و اتوماسیون

- [ ] campaign، audience، cost و هدف.
- [ ] source، UTM، referral و attribution.
- [ ] template پیام و متغیرهای امن.
- [ ] automation trigger/action با محدودیت و audit.
- [ ] opt-in/opt-out و blacklist پیامکی.
- [ ] birthday، win-back، abandoned quote و overdue reminders.
- [ ] A/B campaign و conversion report.
- [ ] frequency cap برای جلوگیری از مزاحمت.

## فاز P2-C3 — ارتباطات یکپارچه

- [ ] SMS provider adapter چندگانه.
- [ ] email SMTP/OAuth و template.
- [ ] VoIP click-to-call و call log.
- [ ] WhatsApp فقط از API رسمی/مجاز در صورت امکان حقوقی.
- [ ] inbox یکپارچه و assignment.
- [ ] ticket، SLA، CSAT و NPS.
- [ ] رضایت ضبط تماس و سیاست نگهداری داده.

## فاز P2-C4 — تحلیل مشتری

- [ ] RFM واقعی و segment پویا.
- [ ] cohort retention.
- [ ] churn signals و reactivation list.
- [ ] CLV و contribution margin.
- [ ] next-best-product بر مبنای داده واقعی، نه placeholder.
- [ ] concentration risk و مشتریان در معرض ریزش.

---

# بخش نهم — نمایندگان، پخش و فروش میدانی

## فاز P1-R1 — عملیات نماینده

- [ ] ساختار نماینده، سرپرست، منطقه و route.
- [ ] جلوگیری از overlap منطقه با exception مجاز.
- [ ] برنامه ویزیت و check-in/check-out با رضایت و سیاست حریم خصوصی.
- [ ] ثبت سفارش آفلاین با price list و اعتبار معتبر.
- [ ] ثبت دریافت میدانی و workflow تأیید مالی.
- [ ] موجودی خودرو/انبارک در صورت نیاز پخش.
- [ ] برگشت از فروش و کالای مرجوعی میدانی.
- [ ] گزارش productive call، strike rate و average order.

## فاز P1-R2 — پورسانت و انگیزش

- [ ] rule engine نسخه‌دار برای پورسانت.
- [ ] مبنا: فروش، فروش خالص، وصول، حاشیه سود یا ترکیب.
- [ ] برگشت، ابطال و عدم وصول پورسانت را reverse کند.
- [ ] tier، bonus، penalty و supervisor override.
- [ ] statement پورسانت قابل توضیح برای نماینده.
- [ ] approval و lock دوره پورسانت.
- [ ] تست مثال‌های عددی مرزی و تغییر قانون میان‌دوره.

---

# بخش دهم — پورتال B2B سازمانی

## فاز P1-B2B1 — حساب شرکتی و کاربران خریدار

- [ ] Company Account مستقل از customer/contact.
- [ ] چند location و billing/shipping address.
- [ ] چند buyer با نقش admin، buyer، approver و viewer.
- [ ] invite، revoke و reset امن.
- [ ] scope تمام queryها با company id سمت سرور.
- [ ] تست جلوگیری از مشاهده قیمت و سفارش شرکت دیگر.

## فاز P1-B2B2 — catalog، قیمت و شرایط فروش

- [ ] catalog و assortment اختصاصی شرکت.
- [ ] price list اختصاصی، تاریخ اثر و اولویت ruleها.
- [ ] MOQ، multiple، pack size و حداقل مبلغ سفارش.
- [ ] تخفیف مقداری و قرارداد قیمت.
- [ ] نمایش موجودی/زمان تأمین بر اساس policy.
- [ ] matrix ordering رنگ/سایز.
- [ ] server-authoritative pricing در همه مسیرها.

## فاز P1-B2B3 — اعتبار، سفارش و quote

- [ ] credit limit، used، reserved و available.
- [ ] consume/release اعتبار در transaction اتمیک.
- [ ] payment terms مانند prepay و net days.
- [ ] PO number مشتری روی سفارش و فاکتور.
- [ ] request for quote، مذاکره، version و expiry.
- [ ] approval داخلی مشتری و approval فروشنده.
- [ ] تبدیل quote به order بدون محاسبه قیمت منقضی.
- [ ] partial shipment، backorder و cancellation.
- [ ] release اعتبار پس از پرداخت، لغو یا کاهش سفارش.
- [ ] تست دو سفارش همزمان روی اعتبار محدود.

## فاز P2-B2B4 — تجربه و خدمات

- [ ] reorder، saved list و order template.
- [ ] statement، invoice، payment و aging.
- [ ] tracking ارسال و تحویل.
- [ ] return/RMA و claim.
- [ ] notification و webhook.
- [ ] API برای مشتریان بزرگ.

---

# بخش یازدهم — پورتال عملیاتی و تولید

## فاز P1-OP1 — پایداری workflow

- [ ] state machine رسمی برای unit/department/parameter.
- [ ] transitionها در یک registry مرکزی تعریف شوند.
- [ ] transition نامعتبر سمت سرور رد شود.
- [ ] retry هر عملیات idempotent باشد.
- [ ] timeout، delegation و escalation ثبت شوند.
- [ ] reassignment مسئول بدون از بین‌رفتن audit.
- [ ] cancellation فرآیند تمام اثرهای انبار و مالی را reverse کند.
- [ ] hard-delete عملیات فعال ممنوع؛ archive یا cancel استفاده شود.
- [ ] KPI زمان انتظار، زمان کار و bottleneck.

## فاز P1-OP2 — UX اپراتوری

- [ ] حالت kiosk/mobile برای کارگر خط.
- [ ] اسکن barcode برای پارامتر و bundle.
- [ ] دکمه‌های بزرگ، کم‌خطا و مناسب دستکش/کارگاه.
- [ ] offline queue و وضعیت sync واضح.
- [ ] جلوگیری از double submit.
- [ ] accessibility و کنتراست.
- [ ] راهنمای کوتاه در همان صفحه عملیات.

---

# بخش دوازدهم — گزارش، هوش تجاری و AI

## فاز P2-BI1 — گزارش‌ساز و داشبورد

- [ ] semantic layer محدود برای منابع مجاز.
- [ ] انتخاب ستون، filter، group، sort و aggregate.
- [ ] saved report و share با permission.
- [ ] dashboard widget و layout شخصی.
- [ ] export job برای گزارش بزرگ.
- [ ] scheduled report با email/SMS link امن.
- [ ] row-level security در گزارش‌ساز.
- [ ] lineage هر عدد تا سند و journal.

## فاز P2-BI2 — AI امن و قابل اعتماد

- [ ] AI فقط ابزار پیشنهاد باشد و سند مالی را بدون تأیید ثبت نکند.
- [ ] PII و داده مالی قبل از ارسال به provider خارجی policy داشته باشد.
- [ ] tenant/company isolation رعایت شود.
- [ ] prompt injection در اسناد و پیام‌ها مدیریت شود.
- [ ] پاسخ دارای منبع داخلی/گزارش مبنا باشد.
- [ ] cost limit، rate-limit و audit query.
- [ ] قابلیت خاموش‌کردن کامل AI برای مشتری حساس.
- [ ] قرارداد و رضایت پردازش داده تعریف شود.

---

# بخش سیزدهم — تست، QA و انتشار

## فاز P0-Q1 — هرم تست استاندارد

### Unit

- [ ] پول، تاریخ جلالی، مالیات، پورسانت، حقوق، costing و state transition.

### Integration

- [ ] هر route مالی با DB موقت و rollback.
- [ ] auth/RBAC/IDOR.
- [ ] sync و conflict.
- [ ] migration.

### Browser E2E با Playwright

- [ ] ورود، تغییر رمز و 2FA.
- [ ] ساخت مشتری و merge duplicate.
- [ ] خرید و پرداخت تأمین‌کننده.
- [ ] فروش، وصول، برگشت و ابطال.
- [ ] انبارگردانی.
- [ ] BOM، دستور تولید و بستن تولید.
- [ ] payroll و سند.
- [ ] B2B order و quote.
- [ ] پورتال عملیاتی.
- [ ] نقش‌ها و منع دسترسی.

### Mobile/Desktop

- [ ] نصب، upgrade، rollback و حفظ DB.
- [ ] آفلاین واقعی با قطع شبکه.
- [ ] sync پس از اتصال.
- [ ] update verification.

## فاز P0-Q2 — CI/CD

- [ ] lint و syntax check.
- [ ] unit/integration suites parallel با timeout.
- [ ] dependency/security scan.
- [ ] migration test.
- [ ] source drift check.
- [ ] build web/desktop/Android بر اساس release policy.
- [ ] staging deploy.
- [ ] smoke test بعد deploy.
- [ ] production approval gate و rollback خودکار.
- [ ] artifact نسخه‌دار و checksum.

## فاز P1-Q3 — کارایی و تاب‌آوری

- [ ] load test API و گزارش.
- [ ] concurrent invoice numbering.
- [ ] concurrent credit/stock reservation.
- [ ] disk-full، DB busy و process crash.
- [ ] sync interruption وسط push/pull.
- [ ] corrupted attachment و missing upload.
- [ ] clock skew دستگاه.
- [ ] chaos test قطع مرکز و بازگشت.

---

# بخش چهاردهم — مشاهده‌پذیری و عملیات

## فاز P1-O1 — logging و monitoring

- [ ] structured JSON log با request id.
- [ ] correlation id برای sync و عملیات مالی.
- [ ] redaction secret و PII.
- [ ] metrics: latency، error، DB busy، queue، sync conflict، backup و disk.
- [ ] health، readiness و liveness جدا.
- [ ] alert بر اساس severity و runbook.
- [ ] dashboard عملیات و SLA.
- [ ] crash reporting desktop/Android با رضایت.

## فاز P1-O2 — مدیریت release

- [ ] semantic version و release manifest واحد.
- [ ] کانال stable/beta.
- [ ] changelog مشتری‌محور.
- [ ] database compatibility range.
- [ ] staged rollout و pause.
- [ ] rollback app بدون rollback ناسازگار DB.
- [ ] release signing و checksum.

---

# بخش پانزدهم — تجاری‌سازی محصول

## فاز P1-M1 — license و entitlement

- [ ] license امضاشده آفلاین با Ed25519.
- [ ] customer، edition، max users/devices، expiry support و feature flags.
- [ ] activation و deactivate کنترل‌شده.
- [ ] grace period بدون قفل‌کردن دسترسی به داده مشتری.
- [ ] read-only safe mode پس از انقضا به‌جای حذف یا گروگان‌گیری داده.
- [ ] audit activation و جلوگیری از clock rollback ساده.
- [ ] trial و conversion.

## فاز P1-M2 — بسته‌بندی محصول

- [ ] نسخه کارگاهی: حسابداری، فروش، انبار، CRM پایه.
- [ ] نسخه تولید و پخش: تولید، نماینده، حقوق، B2B و موبایل.
- [ ] نسخه سازمانی: چندشرکتی، SLA، API، سفارشی‌سازی و PostgreSQL.
- [ ] feature matrix شفاف.
- [ ] هزینه استقرار، مهاجرت، آموزش و پشتیبانی جدا.
- [ ] قرارداد پشتیبانی سالانه و SLA.

## فاز P1-M3 — onboarding و مهاجرت

- [ ] wizard ساخت شرکت، سال مالی، کدینگ، انبار و کاربران.
- [ ] template صنفی پوشاک.
- [ ] import از Excel و حداقل رقبا/محک با validation و dry-run.
- [ ] reconciliation پس از import.
- [ ] checklist go-live و sign-off مشتری.
- [ ] demo data جدا از production.
- [ ] آموزش نقش‌محور مدیر، حسابدار، انباردار، تولید و فروشنده.

## فاز P2-M4 — پشتیبانی و اکوسیستم

- [ ] ticketing، SLA و escalation.
- [ ] knowledge base، ویدئو و release notes.
- [ ] remote support با رضایت و audit.
- [ ] certification نماینده نصب/آموزش.
- [ ] شبکه حسابداران رسمی و مشاوران مالیاتی.
- [ ] partner API و marketplace کنترل‌شده در آینده.

---

# بخش شانزدهم — حریم خصوصی، حقوق مشتری و حاکمیت داده

## فاز P1-G1

- [ ] مالکیت داده در قرارداد صریحاً برای مشتری باشد.
- [ ] export کامل داده در فرمت قابل استفاده فراهم شود.
- [ ] retention و deletion policy تعریف شود.
- [ ] دسترسی پشتیبانی فقط با مجوز، زمان محدود و audit باشد.
- [ ] اطلاعات حساس پرسنل و حقوق field-level permission داشته باشد.
- [ ] شماره ملی، موبایل، آدرس، حساب بانکی و فیش حقوق در log نیاید.
- [ ] consent پیام تبلیغاتی و opt-out نگهداری شود.
- [ ] incident response و اطلاع‌رسانی نشت داده نوشته شود.
- [ ] قرارداد providerهای SMS، email، AI و backup بررسی شود.

---

# بخش هفدهم — ترتیب اجرایی کلان و وابستگی‌ها

## موج صفر — توقف توسعه فیچرهای غیرضروری

مدت پیشنهادی: ۲ تا ۴ هفته

1. P0-A رفع BOM/CI.
2. P0-B حذف source drift.
3. P0-S1/S2/S3 امنیت بحرانی.
4. P0-C backup و restore.
5. P0-Q1/Q2 تست و CI پایه.

**Gate خروج:** suite کامل سبز، ارتباط remote فقط TLS، backup خارج سرور و restore موفق.

## موج یک — انطباق و بازار پوشاک

مدت پیشنهادی: ۶ تا ۱۰ هفته

1. P0-F1/F2 سامانه مودیان و خروجی قانونی.
2. P0-HR1 پارامترهای حقوق.
3. P0-APP1 رنگ/سایز/SKU.
4. pagination مسیرهای اصلی.
5. Playwright مسیرهای پولی.

**Gate خروج:** تأیید مشاور مالیاتی، سفارش/انبار variant واقعی، عدم regression چرخه مالی.

## موج دو — آماده فروش کنترل‌شده

مدت پیشنهادی: ۸ تا ۱۲ هفته

1. license و entitlement.
2. onboarding و migration.
3. B2B شرکتی، اعتبار و quote.
4. خزانه، چک و مغایرت بانک.
5. HR و خروجی قانونی.
6. observability، release و support.

**Gate خروج:** سه pilot پولی، restore drill، update/rollback موفق و SLA پشتیبانی.

## موج سه — تمایز تخصصی

مدت پیشنهادی: ۳ تا ۶ ماه

1. طاقه، برش و bundle.
2. QC و ظرفیت خط.
3. CRM automation و campaign.
4. B2B پیشرفته و API.
5. بودجه و BI.
6. PLM سبک.

**Gate خروج:** KPI اثبات‌شده مشتری شامل کاهش خطای موجودی، کاهش زمان سفارش و بهبود وصول.

## موج چهار — مقیاس سازمانی

مدت پیشنهادی: پس از اثبات بازار

1. PostgreSQL central.
2. گزارش‌ساز پیشرفته.
3. multi-company consolidation.
4. API ecosystem.
5. high availability و orchestration نصب‌ها.

---

# بخش هجدهم — KPI موفقیت محصول

## فنی

- suite pass rate: 100٪.
- escaped critical defect: صفر در هر release.
- API p95 معمولی زیر ۵۰۰ms.
- sync success بالای ۹۹٪ پس از اتصال پایدار.
- backup success بالای ۹۹٫۵٪ و restore drill ماهانه موفق.
- crash-free session بالای ۹۹٫۵٪.

## مالی و عملیاتی

- اختلاف تراز: صفر.
- اسناد بدون reference معتبر: صفر.
- مغایرت موجودی حل‌نشده بیش از SLA: کمتر از ۱٪.
- صورتحساب مودیان ردشده حل‌نشده: صفر در پایان دوره.
- payroll-to-GL mismatch: صفر.

## محصول و بازار

- زمان go-live مشتری استاندارد کمتر از ۱۴ روز.
- نرخ موفقیت migration بالای ۹۵٪ بدون اصلاح دستی سنگین.
- تمدید سالانه بالای ۸۵٪.
- CSAT پشتیبانی بالای ۸۵٪.
- حداقل سه reference customer واقعی در پوشاک پیش از تبلیغ گسترده.

---

# بخش نوزدهم — قالب اجرای هر Task توسط Cursor

برای هر task، Cursor باید قبل از کدنویسی این اطلاعات را در پاسخ خود ثبت کند:

1. مشکل و شواهد فعلی.
2. فایل‌ها و جداول درگیر.
3. اثر روی حسابداری، انبار، sync، RBAC و UI.
4. migration لازم.
5. تست‌های قبل و بعد.
6. خطر rollback و روش بازیابی.
7. معیار پذیرش عددی.

پس از اجرا باید گزارش دهد:

- چه چیزی تغییر کرد.
- چه تست‌هایی با تعداد pass/fail اجرا شد.
- schema version و migration.
- وضعیت desktop/Android source sync.
- وضعیت Help و CHANGE-LOG.
- commit، branch و deploy فقط در صورت مجاز بودن.

---

# بخش بیستم — موارد ممنوع

- ممنوع: اعلام «کامل شد» صرفاً به دلیل وجود UI یا route.
- ممنوع: catch خالی در عملیات مالی.
- ممنوع: تغییر موجودی فقط در `products.stock` بدون ledger/warehouse source.
- ممنوع: محاسبه شماره با `COUNT(*)+1`.
- ممنوع: حذف فیزیکی سند مالی.
- ممنوع: اعتماد به قیمت، نقش، company id یا مبلغ ارسال‌شده از client.
- ممنوع: اعمال اعتبار شرکت در دو query جدا و غیراتمیک.
- ممنوع: نگهداری private key مودیان یا token در متن ساده/log.
- ممنوع: remote HTTP sync.
- ممنوع: build APK/desktop از embedded source تأییدنشده.
- ممنوع: migration بدون تست DB موجود و اجرای دوباره.
- ممنوع: deploy مستقیم بدون backup، test gate و rollback plan.
- ممنوع: بازنویسی کامل فرانت در یک مرحله.
- ممنوع: فروش با ادعای انطباق قانونی پیش از تأیید متخصص و تست واقعی.

---

## نتیجه نهایی مورد انتظار

پس از پایان موج‌های صفر تا سه، ERP ترنم باید محصولی باشد که:

- حسابداری و گزارش‌های آن قابل دفاع نزد حسابدار و حسابرس باشد.
- مودیان، مالیات، حقوق و بیمه بر اساس نسخه قانونی و تاریخ اثر مدیریت شوند.
- موجودی پوشاک را در سطح مدل، رنگ، سایز، طاقه، bundle و مرحله تولید کنترل کند.
- فروشنده و نماینده بدون اینترنت کار کند و conflict قابل مدیریت باشد.
- مشتری عمده با حساب شرکتی، اعتبار، قیمت اختصاصی و quote سفارش دهد.
- تمام عملیات حساس قابل audit، ابطال و reconciliation باشند.
- backup، restore، update و rollback آن عملیاتی و آزموده باشند.
- بتوان آن را با license، onboarding، SLA و پشتیبانی استاندارد به مشتریان متعدد فروخت.

این سند باید به‌عنوان backlog مادر نگهداری شود؛ اجرای هر موج باید به planهای کوتاه‌تر، مستقل و قابل آزمون شکسته شود و هیچ موجی بدون عبور از Gate تعریف‌شده بسته نشود.
