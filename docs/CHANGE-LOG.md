# لاگ تغییرات اعمال‌شده — CRM ترنم

این فایل تاریخچهٔ تغییراتی را که در Cursor / Claude Code اعمال شده نگه می‌دارد.
**قبل از شروع کار جدید، این فایل را بخوانید** تا بدانید چه چیزهایی قبلاً انجام شده است.

---

## قانون برای دستیار (Cursor / Claude Code)

بعد از **هر تسک** که کد یا تنظیمات پروژه را عوض می‌کند:

1. یک ورودی جدید در **بالای بخش «تاریخچه»** (زیر این قوانین) اضافه کن.
2. commit مربوطه را بنویس (اگر commit شده).
3. وضعیت deploy روی سرور production (`45.90.98.99`) را مشخص کن: `✅ deploy شده` / `⏳ نیاز به pull` / `❌ اعمال نشده`.

### فرمت هر ورودی

```markdown
### YYYY-MM-DD — عنوان کوتاه
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `abc1234` (یا «بدون commit»)
- **خلاصه:** ...
- **فایل‌های کلیدی:** `path/a`, `path/b`
- **Deploy:** ✅ / ⏳ / ❌
- **یادداشت:** (اختیاری — دستور deploy، نکته production، ...)
```

---

## وضعیت فعلی (آخرین به‌روزرسانی: ۱۴۰۴/۰۴/۲۷)

| مورد | مقدار |
|------|--------|
| شاخهٔ کاری | `claude/claude-md-docs-2ssrpy` |
| آخرین commit | `3866833` |
| نسخه وب/دسکتاپ | **`1.0.11`** / SW `v30` |
| اندروید | **`2.0.9`** (versionCode 11) — **توزیع محلی فقط** |
| وضعیت سرور | ⏳ نیاز به re-import با importer جدید (مشتری/تأمین‌کننده) |

---

## تاریخچه

### ۱۴۰۴/۰۴/۲۸ — [Cursor] import محک: مشتری، تأمین‌کننده، دسته‌بندی کالا
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** «در حال commit»
- **خلاصه:** تحلیل عمیق روزنامه + کدینگ؛ ایجاد **۸۵ مشتری** و **۷۰ تأمین‌کننده** از اشخاص محک با `coa_code` و مانده از گردش حساب؛ دسته‌بندی مواد اولیه/محصول نهایی؛ `mahak-analyze.js` + `mahak-import-helpers.js`.
- **فایل‌های کلیدی:** `server/scripts/import-mahak-journal.js`, `server/lib/mahak-import-helpers.js`, `server/scripts/mahak-analyze.js`
- **Deploy:** ⏳
- **یادداشت:** ۱۵۳۰ سند، ۵۹۰۵ آرتیکل، ۵۲۳ کالا، ۷۱٬۸۳۱ موجودی — تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان

### ۱۴۰۴/۰۴/۲۷ — [Cursor] go-live محک از صفر (سه فایل Excel)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3866833`
- **خلاصه:** `mahak-go-live.js` — wipe + import journal + stock. production: ۱۵۳۰ سند، ۵۹۰۵ آرتیکل، ۱٬۱۲۴ حساب، ۵۲۳ کالا، ۷۱٬۸۳۱ موجودی، `coa_mode=mahak`, تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان.
- **Deploy:** ✅ — ورود: `admin`/`admin123`
- **یادداشت:** مشتریان CRM=۰ (اشخاص محک فقط حساب تفصیلی در کدینگ)

### ۱۴۰۴/۰۴/۲۷ — [Cursor] رفع خطای داخلی سرور + تلاش بازیابی محک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b4e6d0d`
- **خلاصه:**
  - **خطای داخلی:** `notifications.js` جدول اشتباه `rep_payments` → `rep_payment_submissions` — رفع و deploy شد.
  - **کدینگ/اسناد محک نیست:** برای رفع 502 DB به pre-mahak برگشت؛ import محک (۱۵۳۰ سند) در `crm.db.corrupted-` بود، `.recover` ناموفق.
  - **DB فعلی:** integrity ok، `journal_entries=42`، `mahak=0` — اکسل محک روی سرور یافت نشد.
- **فایل‌های کلیدی:** `server/routes/notifications.js`, `server/scripts/recover-production-db.sh`
- **Deploy:** ✅ pull + pm2 restart
- **یادداشت:** `coding_hesbha.xlsx` + `daftar_roznameh.xlsx` (+ `mojodi.xlsx`) را روی سرور بگذارید → `import-mahak-journal.js`

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f5544`
- **خلاصه:**
  - **ریشه 502:** `crm.db` خراب (`SQLITE_CORRUPT: database disk image is malformed`) — PM2 بیش از ۵۱٬۰۰۰ بار restart → پورت 3000 بالا نمی‌آمد → nginx/Chrome 502.
  - **رفع production:** بازیابی DB از `crm-pre-mahak.db` (integrity ok) + `pm2 restart` → `http://45.90.98.99:3000` و `/api/system/health` هر دو **200**.
  - **APK:** فایل خراب/partial (`apk.part0`/`apk.part1` ~۶MB) و `crm-taranom.apk` از `/releases/` سرور حذف شد.
  - **سیاست جدید:** APK فقط build محلی — `release.ps1`، `finalize-android-release.ps1`، `deploy-production.sh`، `android/BUILD.md`، `CLAUDE.md` به‌روز شد؛ `manifest.json` اندروید `url: ""` + `distribution: local`؛ `app-update.js` بدون URL آپدیت اعلام نمی‌کند.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/finalize-android-release.ps1`, `scripts/deploy-production.sh`, `scripts/generate-release.js`, `scripts/check-db-integrity.js`, `server/lib/app-update.js`, `server/public/releases/manifest.json`, `android/BUILD.md`, `CLAUDE.md`
- **Deploy:** ✅ DB بازیابی + سرور آنلاین — ⏳ `git pull` برای manifest/اسکریپت‌های جدید
- **یادداشت:** مهاجرت محک (۱۶:۲۴) احتمالاً DB را خراب کرد — دادهٔ post-mahak در `crm.db.corrupted` باقی است؛ mahak را دوباره با احتیاط اجرا کنید.

### ۱۴۰۴/۰۴/۲۷ — [Cursor] رفع بنیادی اندروید 2.0.9 — بوت قابل‌اعتماد روی سامسونگ/نوکیا
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** «بدون commit»
- **خلاصه:**
  - **MainActivity:** WebView سازگار (mixed content، database، safe browsing off)، WebChromeClient/WebViewClient با نمایش خطا، اسپلش پیشرفته در استخراج assets، اعتبارسنجی projectIsValid، health poll به `/api/system/health` + `server.ready`، نمایش boot.log در صفحه خطا، Node در thread جدا.
  - **main.js:** fallback بهتر better-sqlite3 برای همه ABIها، `LISTEN_HOST=127.0.0.1`، نسخه 2.0.9.
  - **server.js:** endpoint `/api/system/health` + نوشتن `server.ready` برای اندروید.
  - **index.html:** غیرفعال‌سازی Service Worker در WebView اندروید (علت cache/hang)، راهنما به‌روز.
  - **Build:** AGP 8.5.2 + Gradle 8.7 + mirror Aliyun (دسترسی Google Maven)، NDK 25.1.8937393، prune node_modules.
  - **APK 2.0.9** (versionCode 11) ساخته و **۲۳/۲۳ assertion سبز** — 60MB SHA256 `C4C5F47E…`
- **فایل‌های کلیدی:** `MainActivity.java`, `main.js`, `server.js`, `index.html`, `android/build.gradle`, `settings.gradle`, `manifest.json`, `scripts/build-android.ps1`, `scripts/test-android-apk.ps1`
- **Commit:** `3fec142`
- **Deploy:** ✅ کد + manifest روی سرور (`git pull` + `pm2 restart`) — ⏳ APK 2.0.9 هنوز hash قدیمی روی سرور؛ scp/sftp قطع می‌شود — آپلود محلی لازم
- **یادداشت نصب:** کاربران باید **نسخه قبلی را حذف** و APK 2.0.9 را تازه نصب کنند. اولین باز کردن ۲–۵ دقیقه طول می‌کشد.

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `79a44f7` (+ debug-sign fallback در `android/app/build.gradle`)
- **خلاصه:**
  - APK **2.0.8** (کد 1.0.11) امضا و اعتبارسنجی شد — **۱۷/۱۷ assertion سبز** (`test-android-apk.ps1`).
  - manifest اندروید → `2.0.8` / versionCode `10`؛ APK روی `/releases/crm-taranom.apk` (~62MB).
  - API آپدیت: `2.0.7 → 2.0.8` فعال.
  - رگرسیون: SMS 22/22، barcode 12/12، fiscal-year 4/4.
  - `android/build.gradle`: `maven.google.com` برای AGP؛ `android/app/build.gradle`: fallback امضای debug اگر keystore نباشد.
  - **مهاجرت محک go-live:** فایل‌های Excel محلی یافت نشد — دست مالک (`docs/MAHAK-MIGRATION.md` §۵).
- **فایل‌های کلیدی:** `server/public/releases/manifest.json`, `android/build.gradle`, `android/app/build.gradle`, `server/public/index.html`
- **Deploy:** ✅ scp APK + manifest + git pull + pm2 restart

### ۱۴۰۴/۰۴/۲۶ — [Cursor] انتشار نهایی 1.0.11 — installer دسکتاپ ساخته + deploy
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc97a18`
- **خلاصه:**
  - **دسکتاپ:** `CRM-Taranom-Setup-1.0.11.exe` (~93MB) با electron-builder ساخته شد — شامل همه تغییرات 1.0.11 + Mahak phase 2 UI.
  - **manifest.json + latest.yml** به 1.0.11 به‌روز شد؛ installer روی `/releases/` آپلود شد.
  - **اندروید:** APK release با کد جدید ساخته شد (`app-release-unsigned.apk` ~62MB) — بدون `android/keystore.properties` امضا نشد؛ manifest اندروید فعلاً 2.0.7 ماند تا امضا شود.
  - **build-android.ps1:** پشتیبانی از `app-release-unsigned.apk` + امضای خودکار اگر keystore موجود باشد.
  - راهنما: بخش «به‌روزرسانی دسکتاپ 1.0.11» اضافه شد.
- **فایل‌های کلیدی:** `desktop/package.json`, `desktop/dist/`, `server/public/releases/{manifest.json,latest.yml}`, `scripts/build-android.ps1`, `server/public/index.html`
- **Deploy:** ✅ installer آپلود + git pull + pm2 restart — API آپدیت: 1.0.10→1.0.11
- **یادداشت اندروید:** `android/keystore.properties` بسازید → `scripts/build-android.ps1` → scp `crm-taranom.apk` → manifest android را 2.0.8/10 کنید.

### ۱۴۰۴/۰۴/۲۶ — [Cursor] تکمیل UI فاز ۲ محک + deploy production
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3218acd`
- **خلاصه:**
  - **پنل «⚙️ نگاشت کدینگ»** در تنظیمات: ویرایش ۱۲ کلید coa_* + checkbox سند COGS؛ `saveSettings()` ذخیره می‌کند؛ `clearCoaCache()` بعد از PUT.
  - **فرم‌ها:** نمایش readonly کد تفصیلی + دکمه «🔗 اتصال به حساب موجود» برای مشتری/محصول/تأمین‌کننده/بانک/صندوق؛ API جدید `PATCH /accounting/link-coa`.
  - **کدینگ:** ستون‌های سطح/ماهیت/نوع تفصیلی در جدول COA.
  - **سال مالی:** Factory Reset در `coa_mode=mahak` یا با اسناد `src_system=mahak` مسدود شد.
  - **`coa_mode`** در `/settings/modules` برای کاربران حسابداری (بدون دسترسی کامل تنظیمات).
  - **`test-mahak-phase2.js`:** handle `must_change_password` بعد از login.
  - SW → **v30**؛ راهنما به‌روز.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/routes/{settings,accounting,fiscal-year}.js`, `server/scripts/test-mahak-phase2.js`
- **Deploy:** ✅ pull + pm2 restart (`3218acd` روی `45.90.98.99`)
- **یادداشت:** go-live دیتابیس محک (importer روی سرور) هنوز دست مالک — طبق `docs/MAHAK-MIGRATION.md` بخش ۵.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] ✅ فاز ۲ مهاجرت محک کامل شد — عملیات جاری روی کدینگ محک + COGS خودکار (۱۴/۱۴ تست E2E سبز)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **تزریق coa-map به عملیات جاری:** فاکتور (دریافتنی/فروش/تخفیف + ابطال + تبدیل)، دریافت‌ها (۴ سایت 1103 در accounting.js → تفصیلی مشتری)، خرید (پرداختنی تأمین‌کننده/موجودی، ۷ سایت)، حقوق (۷۰۱/۲۰۴/501)، و `resolveCashAccount` → اول `coa_code` بانک/صندوق. همه backward-compatible: بدون coa_mode=mahak رفتار قدیمی عیناً حفظ (fallback به 1103/2101/...).
  - **سند COGS خودکار (تصمیم ۸):** `postCogsVoucher` در invoices.js — فاکتور رسمی: Dr بهای تمام‌شده (801) / Cr تفصیلی هر کالا؛ در ابطال و تبدیل پیش‌فاکتور هم دقیقاً معکوس/ثبت. فقط mahak-mode + `feature_cogs_voucher=1`.
  - **تفصیلی‌ساز خودکار (`allocTafsili` در coa-map):** مشتری/تأمین‌کننده/محصول (هر دو مسیر ساخت)/بانک/صندوق جدید → حساب تفصیلی ۱۲رقمی زیر معین نگاشت‌شده (شماره از MAX سراسری+1).
  - کلیدهای `coa_*` و `feature_cogs_voucher` به ALLOWED_KEYS تنظیمات اضافه شد.
  - **تست:** `scripts/test-mahak-phase2.js` جدید — E2E روی کپی DB واقعی محک: **۱۴/۱۴ سبز** (تفصیلی مشتری 203004960031، سند فروش روی 601، COGS با مبلغ cost×qty، دریافت به تفصیلی صندوق 206003500001، ابطال معکوس، تراز متوازن در هر مرحله). رگرسیون: SMS **22/22** + Sync **33/33** سبز. راهنمای ادمین بخش «حالت کدینگ محک» + SW → `v29`.
  - نکته باز (cosmetic): نام حساب‌های سطح ۳ ساخته‌شده توسط importer گاهی از شیت معینِ هم‌کد اشتباه برداشته می‌شود (کد درست است، فقط برچسب) — اصلاح در اجرای بعدی importer.
- **فایل‌های کلیدی:** `server/lib/coa-map.js`, `server/routes/{invoices,accounting,purchases,payroll,customers,suppliers,products,banks,cash-boxes,settings}.js`, `server/db.js`, `server/scripts/test-mahak-phase2.js`, `server/public/{index.html,sw.js}`
- **Deploy:** ⏳ pull + pm2 restart (کد)؛ **go-live دیتابیس محک** طبق MAHAK-MIGRATION.md بخش ۵ — دستورها در پیام Claude به مالک.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] ورود موجودی محک (فاز ۱ تکمیل) + 📋 گزارش کامل تحویل به Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **`scripts/import-mahak-stock.js` جدید:** ورود تعداد موجودی از فایل mojodi.xlsx محک (join با «کد عملیاتی» شیت تفصیلی، فقط نوع کالاها). اجرای واقعی: **۳۵۲/۳۵۲ قلم تطبیق، صفر بدون تطبیق**؛ ۱۷۱ کالای خارج از فایل → موجودی صفر؛ بهای واحد ۲۸۷ قلم از ارزش افتتاحیه ÷ تعداد؛ جمع موجودی ۷۱٬۸۳۱ عدد؛ `needs_qty` همه پاک شد. گزارش: mahak-stock-report.md کنار DB.
- **فایل‌های کلیدی:** `server/scripts/import-mahak-stock.js`
- **Deploy:** طبق runbook پایین — نه خودکار.

#### 📋 وضعیت کامل مهاجرت محک برای Cursor (اگر Claude در دسترس نبود از اینجا ادامه بده)

**✅ انجام‌شده و تست‌شده (فاز ۱):**
1. تصمیمات ۸گانهٔ مالک در `docs/MAHAK-MIGRATION.md` بخش ۲ — **غیرقابل تغییر بدون تأیید مجدد**.
2. Schema (db.js): coa_code ×۶ جدول، needs_qty، src_system/src_doc_no/src_atf، level/nature/tafsili_type.
3. `lib/coa-map.js`: نگاشت حساب‌های کنترلی از settings با fallback به کدهای قدیمی (کش ۱۵ثانیه‌ای — بعد از تغییر settings، `clearCoaCache()`).
4. `scripts/import-mahak-journal.js` — نتیجهٔ اجرای واقعی: ۱٬۵۳۰ سند/۵٬۹۰۵ آرتیکل، تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹=۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان، ۴۳ تعدیل به 906001، کدینگ ۱٬۱۲۴ حساب، ۵۲۳ محصول/۱۳ بانک/۲ صندوق/۱۵ انبار، settings کلیدهای coa_* + coa_mode=mahak + feature_cogs_voucher=1 ست می‌شود. راستی‌آزمایی داخل تراکنش (خطا=rollback کامل).
5. `scripts/import-mahak-stock.js` — بالا.
6. DB تست‌شده در scratchpad جلسهٔ Claude است؛ **روی سرور باید از نو با فایل‌های مالک اجرا شود** (فایل‌های اکسل عمداً در git نیستند — حاوی اطلاعات مالی؛ مالک محلی دارد).

**✅ انجام‌شده (فاز ۲ — backend Claude + UI Cursor):**
1. تزریق `coa-map.acct()` به routeها + COGS خودکار + allocTafsili (commit `41d3bab`).
2. UI: پنل نگاشت کدینگ + کد تفصیلی در فرم‌ها + link-coa + ستون‌های COA + SW v30.
3. **Go-live:** runbook بخش ۵ — بک‌آپ DB فعلی، اجرای دو importer روی سرور، سوییچ DB_PATH، چک‌لیست پذیرش حسابدار (بخش ۶).

**⏳ مانده (دست مالک / ops):**
- اجرای importerها روی production با فایل‌های Excel محلی
- rebuild اندروید برای 1.0.11+Mahak

**~~⏳ ماندهٔ فاز ۲ (قدیمی — انجام شد)~~**

**⚠️ دام‌هایی که Claude به آن‌ها خورد (تکرار نکن):** (۱) فایل‌های page-script حتماً IIFE — barcode-input شما کل صفحه را کشته بود، فیکس شد؛ (۲) ÷۱۰ ریال→تومان فقط در سطح آرتیکل، هرگز روی جمع؛ (۳) «کد عملیاتی» تفصیلی محک per-type است نه یکتا — همیشه با نوع فیلتر کن؛ (۴) gate تغییر رمز اجباری 1.0.11 روی DB تازه فعال است (admin/admin123 → مودال تغییر رمز).

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] 🚨 هات‌فیکس ورود (barcode-input) + اجرای فاز ۱ مهاجرت محک (importer تأییدشده)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **🚨 باگ بحرانی 1.0.11:** `lib/barcode-input.js` در سطح global صفحه `const api` اعلان می‌کرد → تصادم با تابع `api()` برنامه → «Identifier api has already been declared» → **کل JS صفحه می‌مرد و ورود کار نمی‌کرد** (تست Node سبز بود چون فقط در مرورگر رخ می‌دهد). فیکس: کل فایل در IIFE پیچیده شد؛ ۱۲/۱۲ تست بارکد سبز. **⚠️ اگر production روی 516a088 است الان صفحه ورود مرده است — فوراً pull+restart کنید.**
  - **مهاجرت محک — فاز ۱ اجرا و تأیید شد:**
    - schema: `coa_code` روی customers/suppliers/products/banks/cash_boxes/persons + `needs_qty` + `src_system/src_doc_no/src_atf` روی journal_entries + `level/nature/tafsili_type` روی chart_of_accounts.
    - `lib/coa-map.js`: لایهٔ نگاشت حساب‌های کنترلی (settings-driven، fallback به کدهای قدیمی — backward compatible).
    - `scripts/import-mahak-journal.js`: ورود کامل در یک تراکنش + راستی‌آزمایی داخلی (rollback خودکار در خطا) + گزارش md.
    - **اجرای واقعی موفق روی فایل‌های مالک:** ۱٬۵۳۰ سند / ۵٬۹۰۵ آرتیکل (۴۳ تعدیل کسری به ۹۰۶) — **بدهکار=بستانکار=۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان** ✅؛ کدینگ ۱٬۱۲۴ حساب ۴سطحی، ۵۲۳ محصول (needs_qty)، ۱۳ بانک، ۲ صندوق، ۱۵ انبار. گردش هر ۱۴ حساب کل == منبع. UI تست شد: «متوازن ✓».
- **فایل‌های کلیدی:** `server/lib/barcode-input.js`, `server/db.js`, `server/lib/coa-map.js`, `server/scripts/import-mahak-journal.js`
- **Deploy:** ⏳ **هات‌فیکس فوری لازم** (pull + pm2 restart). مهاجرت محک طبق بخش ۵ سند اجرا می‌شود، نه خودکار.
- **یادداشت برای Cursor:** فاز ۲ مهاجرت مانده: تزریق coa-map به routeها + سند COGS خودکار در فاکتور + تفصیلی‌ساز + پنل نگاشت — طبق MAHAK-MIGRATION.md بخش ۳.۲ تا ۳.۵. قانون: فایل‌های page-script حتماً IIFE.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] سند اجرایی مهاجرت کامل حسابداری محک → ترنم (docs/MAHAK-MIGRATION.md)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت (فقط سند — کد بعد از این سند پیاده می‌شود)
- **خلاصه:** کاربر کدینگ کامل محک (۴۸ کل/۱۵۰ معین/۷۹۵ تفصیلی) + دفتر روزنامه (۱٬۵۳۰ سند/۵٬۸۶۴ آرتیکل از ۱۴۰۵/۰۱/۰۱) را داد. تحلیل کامل انجام و ۸ تصمیم کلیدی با AskUserQuestion از مالک گرفته شد: ریال÷۱۰، **کدینگ محک مبنا**، دیتابیس تازه، تعدیل خودکار ۳۷ سند نامتراز به ۹۰۶، اشخاص فقط تفصیلی، کالاها محصول کامل (تعداد بعداً)، سند ۱۴۰۴ وارد شود، **COGS خودکار مثل محک از این به بعد**. سند شامل: schema جدید (coa_code روی ۶ جدول + src_doc_no + درخت COA)، لایهٔ `lib/coa-map.js` (نگاشت حساب‌های کنترلی، backward-compatible)، تفصیلی‌ساز خودکار، سند COGS در فاکتور، الگوریتم کامل importer با راستی‌آزمایی/rollback، ترتیب اجرا و چک‌لیست پذیرش حسابدار.
- **فایل‌های کلیدی:** `docs/MAHAK-MIGRATION.md`
- **Deploy:** ❌ (سند). ⚠️ فایل‌های اکسل مالی **در git قرار نمی‌گیرند** — مسیر محلی به importer داده می‌شود.
- **یادداشت برای Cursor:** پیاده‌سازی طبق سند، بخش ۳ و ۴. ⚠️ با تغییرات 1.0.11 شما (soft-delete سند، سال مالی) باید هماهنگ شود — importer اسناد `src_system='mahak'` می‌سازد و rollover سال مالی نباید آن‌ها را دستکاری کند.

### ۱۴۰۴/۰۴/۲۶ — [Cursor] نسخه 1.0.11 کامل (فاز ۱–۴)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `516a088`
- **خلاصه:**
  - **فاز ۱:** debounce بارکد + wedge؛ backup فقط central.
  - **فاز ۲:** حذف API/UI گردش حساب (ledger)؛ soft-delete فاکتور/سند دستی؛ سال مالی rollover + factory reset؛ انبارگردانی به منوی حسابداری + سند GL.
  - **فاز ۳:** Command Palette Ctrl+K؛ ویجت اقدامات + اعلان‌ها؛ ساخت سریع محصول در فاکتور.
  - **فاز ۴:** RBAC ماتریس per-user؛ مشاور AI فقط مدیر (admin/sales_manager).
  - تست: barcode 12/12، fiscal 4/4، SMS 22/22. SW → v28.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/lib/rbac.js`, `server/routes/{notifications,search,fiscal-year,rbac}.js`, `server/services/ai.js`, `server/db.js`, `server/scripts/test-fiscal-year.js`
- **Deploy:** ✅ pull + pm2 restart سرور production

### ۱۴۰۵/۰۴/۲۲ — اسکریپت deploy خودکار + keystore example
- **شاخه:** `cursor/deploy-automation-605f`
- **Commit:** `80ee40b`
- **خلاصه:** `scripts/deploy-production.sh` (git pull + jwt-secret + npm + pm2 + health check)، به‌روزرسانی `.github/workflows/deploy.yml` با bootstrap inline، `android/keystore.properties.example`
- **فایل‌های کلیدی:** `scripts/deploy-production.sh`, `.github/workflows/deploy.yml`, `android/keystore.properties.example`, `docs/PROJECT-HANDOFF.md`
- **Deploy:** ⏳ نیاز به merge + اجرای workflow یا SSH
- **یادداشت:** `bash scripts/deploy-production.sh` روی سرور یا GitHub Actions «Deploy CRM ترنم»

### ۱۴۰۵/۰۴/۲۲ — سخت‌سازی امنیتی (بند «ب» handoff) + merge با v4
- **شاخه:** `cursor/security-hardening-605f` → `claude/claude-md-docs-2ssrpy`
- **Commit:** `f8ba6f4` (merge به `claude/claude-md-docs-2ssrpy`)
- **خلاصه:**
  - تغییر اجباری رمز پیش‌فرض/موقت در اولین ورود (سازگار با 2FA v4): ستون `users.must_change_password`، گیت 403 در `auth` (فقط مرکزی)، مودال فرانت؛ پرچم قبل از مرحله 2FA برای رمز `admin123`
  - رمزنگاری بکاپ AES-256-GCM + `server/scripts/decrypt-backup.js`
  - حذف اسرار از مخزن (keystore، JWT هاردکد) + `docs/SECURITY-HARDENING.md`
  - merge با v4: 2FA/TOTP، پورتال B2B، انبارگردانی، audit log، …
  - `test-v4-features.js` با تغییر اجباری رمز سازگار شد (`loginAdmin` helper)
- **فایل‌های کلیدی:** `server/middleware/auth.js`, `server/routes/{auth,twofa,admin}.js`, `server/backup.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`, `docs/SECURITY-HARDENING.md`
- **Deploy:** ❌ اعمال نشده — `jwt-secret.txt` قبل از restart الزامی
- **یادداشت:** بعد از deploy، admin مودال تغییر رمز می‌بیند؛ همه با تغییر JWT یک‌بار re-login

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] نسخه دمو برای پرزنت — seed کامل + دموی آنلاین (:3001) + دموی لپ‌تاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** به درخواست کاربر، نسخه دمو «دقیقاً همان برنامه» — همان کد، دیتابیس جدا با داده نمایشی غنی:
  - **`server/scripts/seed-demo.js`:** سرور واقعی را روی DB خالی بوت می‌کند و از **APIهای واقعی** داده می‌سازد (دفاتر تراز می‌ماند — تست شد: بدهکار=بستانکار=۱۹٫۸ میلیارد ✅): ۴ کاربر (demo/sara/reza/maryam — رمز همه `demo1234`)، ۲ بانک + ۲ صندوق (تنخواه)، ۲ انبار، ۵ تأمین‌کننده، ۶ دسته محصول + ۶۰ محصول، ۱۵ فاکتور خرید (شارژ موجودی)، ۴۰ مشتری، ۶۰ پیگیری/پایپ‌لاین، **۱۲۵ فاکتور رسمی + ۲۵ پیش‌فاکتور** در بازه ۳ ماه، ۹۲ دریافت (نقد/بانک/چک با سررسید)، ۸ هزینه، ۶ سری تولید، ۵ کارمند + حقوق (بعضی پرداخت‌شده)، یادآورها. تصادفی‌سازی deterministic (seed ثابت) — هر بار همان دمو.
  - **`scripts/demo-online.sh`:** روی سرور production یک instance دوم PM2 با نام `crm-taranom-demo` روی پورت **3001** بالا می‌آورد (DB/uploads جدا — برنامه اصلی دست‌نخورده). اجرای مجدد = ریست دمو؛ مناسب cron شبانه.
  - **`scripts/demo-laptop.ps1`:** دموی آفلاین روی لپ‌تاپ ویندوزی — حالت central (همه ماژول‌ها از جمله تنظیمات/کاربران دیده می‌شود، برخلاف build دسکتاپ که device است) روی `http://127.0.0.1:3002`.
- **فایل‌های کلیدی:** `server/scripts/seed-demo.js`, `scripts/demo-online.sh`, `scripts/demo-laptop.ps1`
- **Deploy:** ⏳ برای دموی آنلاین: `bash scripts/demo-online.sh` روی سرور (+ باز بودن پورت 3001)
- **یادداشت:** SMS در دمو به‌طور طبیعی خاموش است (تنظیمات پیامک خالی) — به مشتری واقعی چیزی ارسال نمی‌شود.

### ۱۴۰۴/۰۴/۲۴ — [Cursor] رفع کرش فوری اندروید 2.0.7 — APK تودرتو ۲۹۴MB حذف شد
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (همین session)
- **خلاصه:**
  - **ریشهٔ کرش فوری:** `copyServerSources` فایل `crm-taranom.apk` (۲۹۴MB) را داخل assets بسته‌بندی می‌کرد → اولین استخراج OOM/کرش → برنامه فوراً بسته می‌شد.
  - **رفع:** exclude کل `public/releases/**`؛ قبل از build جابجایی APK از پوشه server؛ `MainActivity` با کپی iterative + catch خطا (بدون RuntimeException روی thread)؛ `largeHeap` + `extractNativeLibs`؛ `main.js` با boot.log و throw اگر sqlite نباشد.
  - **تست:** `scripts/test-android-apk.ps1` (۱۴ assertion: بدون nested apk، ELF libnode+sqlite، نسخه 2.0.7، حجم <250MB) — همه سبز. SMS 22/22 سبز. APK جدید **۶۲MB** SHA256 `265EDC4B…`.
- **فایل‌های کلیدی:** `android/app/build.gradle`, `MainActivity.java`, `main.js`, `AndroidManifest.xml`, `scripts/test-android-apk.ps1`, `scripts/build-android.ps1`
- **Deploy:** ✅ APK 2.0.7 آپلود (`SHA256=265EDC4B…`, 62MB) + commit `72118af` + pm2

### ۱۴۰۴/۰۴/۲۴ — [Cursor] انتشار اندروید 2.0.6 — رفع بوت SQLite (better-sqlite3 path)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (همین session)
- **خلاصه:**
  - **باگ 2.0.5:** APK دارای `prebuilt/android/*/better_sqlite3.node` بود ولی `bindings()` فقط `build/Release/` را می‌خواند → سرور Node کرش → اپ اجرا نمی‌شد.
  - **رفع:** `main.js` در runtime باینری ABI درست را کپی می‌کند؛ rebuild با prebuilt هر ۳ ABI؛ نسخه **2.0.6 (vc8)**.
  - **APK جدید:** SHA256 `6247752D…`, ~۳۴۱MB — ELF سبز (libnode + ۳ prebuilt + fix در main.js).
  - راهنمای داخل برنامه: یادآوری «اولین اجرای اندروید چند دقیقه طول می‌کشد».
- **فایل‌های کلیدی:** `android/.../main.js`, `android/app/build.gradle`, `scripts/build-android.ps1`, `scripts/build-better-sqlite3-android.ps1`, `server/public/releases/manifest.json`, `server/public/index.html`
- **Deploy:** ✅ APK 2.0.6 آپلود شد (`SHA256=6247752D…`) + commit `2696eda` + pull/pm2 سرور

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] انتشار 1.0.10 انجام شد: exe + APK ساخته و آپلود شد — فقط pull سرور مانده
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f25f9` (متادیتا — توسط release.ps1 روی سیستم کاربر) + همین کامیت (fix)
- **خلاصه:**
  - کاربر `release.ps1` را اجرا کرد: **دسکتاپ `CRM-Taranom-Setup-1.0.10.exe` (۹۳MB) ساخته شد** ✅ و **APK اندروید 2.0.5 (۲۲۰MB) ساخته شد** ✅ — بازرسی ELF سبز (۳ ماژول better_sqlite3 + libnode هر ۳ ABI؛ SHA256 `61856EB8...`). هر دو با scp روی `/releases/` سرور آپلود شدند.
  - دو باگ build حین راه رفع شد: (۱) اسکریپت‌های ps1 باید ASCII خالص باشند (PS 5.1 + بدون BOM → em-dash بایت نقل‌قول هوشمند دارد و parser می‌شکند)؛ (۲) فایل‌های `.gz` داخل node_modules (bcryptjs) با AAPT تداخل «Duplicate resources» می‌دهند → قبل از build حذف می‌شوند.
  - **قدم آخر (deploy وب) خطا داد:** روی production فایل `manifest.json` تغییر محلی دستی داشت و pull را بلاک کرد. `release.ps1` اصلاح شد: قبل از pull، فقط دو فایل متادیتای releases را `git checkout --` می‌کند (git منبع حقیقت آن‌هاست). دستور یک‌خطی رفع به کاربر داده شد.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/build-android.ps1`, `server/public/releases/{manifest.json,latest.yml}`
- **Deploy:** ⏳ فقط `git pull` سرور مانده (exe/apk از قبل روی سرور هستند)
- **یادداشت برای Cursor:** روی production فایل‌های releases را دیگر دستی ویرایش نکنید — همیشه از مسیر git + release.ps1.

### ۱۴۰۴/۰۴/۲۴ — [Cursor] تشخیص باگ بحرانی بوت اندروید: better-sqlite3 در مسیر اشتباه (2.0.5)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **خلاصه:** APK 2.0.5 (`SHA256=61856eb8…`) ELF معتبر داشت ولی `build/Release/better_sqlite3.node` نداشت — رفع در 2.0.6 بالا.
- **فایل‌های کلیدی:** `android/.../nodejs-project/main.js`
- **Deploy:** ❌ → جایگزین با 2.0.6

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] رفع «برنامه اندروید بالا نمی‌آید»: صبر بوت از ~۳۰ ثانیه به ۱۰ دقیقه + اسپلش
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - ریشهٔ احتمالی گزارش کاربر پیدا شد: اولین اجرای APK هزاران فایل nodejs-project را استخراج می‌کند (چند دقیقه روی حافظه کند)، ولی `loadWhenReady` قدیمی فقط ۲۰×۱.۵ثانیه (~۳۰s) تلاش می‌کرد و بعد **برای همیشه صفحه خالی** می‌ماند.
  - حالا: اسپلش فارسی «در حال آماده‌سازی... اولین اجرا ممکن است چند دقیقه طول بکشد» فوراً نمایش داده می‌شود؛ یک thread پس‌زمینه تا ۱۰ دقیقه سرور داخلی را poll می‌کند (HttpURLConnection، هر ۱ ثانیه) و به‌محض HTTP 200 برنامه را load می‌کند؛ اگر هرگز بالا نیامد صفحه خطای صادقانه.
  - hash کاربر (`43563CC8...`) نشان داد APK محلی همان build مردهٔ قبلی **نیست** — پس این سناریوی بوتِ کند محتمل‌ترین علت است. Play Protect هم نصب را بلاک می‌کرد (راهنمایی شد: More details → Install anyway).
  - `git pull` کاربر به‌خاطر تغییرات uncommitted شما (Cursor) رد شد: `android/app/build.gradle`, `docs/CHANGE-LOG.md`, `scripts/build-android.ps1`, `manifest.json` — به کاربر گفته شد stash کند (`git stash push -m cursor-wip-before-1.0.10`). ⚠️ **Cursor:** stash را بررسی/ادغام کن و لطفاً کارها را commit کن.
- **فایل‌های کلیدی:** `android/app/src/main/java/ir/taranom/crm/MainActivity.java`
- **Deploy:** ❌ در build اندروید 2.0.5 (از طریق `scripts/release.ps1`) اعمال می‌شود

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] زیرساخت انتشار 1.0.10 — اسکریپت یک‌دستوری release.ps1 + bump نسخه‌ها
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **نسخه‌ها bump شد:** دسکتاپ `1.0.10` (desktop/package.json)، اندروید `2.0.5` / versionCode `7` (build.gradle). محتوای 1.0.10: تم زمرد/شب مخملی، اعداد انگلیسی خودکار، UX جدید آپدیت (پیشرفت دانلود+نصب خودکار اندروید)، آیکون واقعی لوگو، SW v26.
  - **`scripts/release.ps1` جدید:** انتشار کامل با یک دستور روی سیستم ویندوز: git pull → build دسکتاپ → build اندروید → **راستی‌آزمایی ELF داخل APK** (libnode هر ۳ ABI + ماژول‌های better_sqlite3 — jلوگیری از تکرار فاجعه APK مرده) → تولید manifest/latest.yml (generate-release) → commit+push متادیتا → scp نصب‌کننده‌ها به سرور → ssh deploy وب (pull+npm install+pm2 restart) + health-check. هر مرحله exit code چک می‌کند.
  - `generate-release.js`: notes نسخه از آرگومان/پیش‌فرض ۱.۰.۱۰.
  - **تشخیص مشکل «برنامه بالا نمی‌آید» روی گوشی کاربر:** عکس نشان داد Google Play Protect نصب را بلاک کرده («developer ناشناس») — مشکل کد نیست؛ راه عبور به کاربر داده شد. مشکوک دوم: APK روی سرور ممکن است همان build مردهٔ ELF-MISSING باشد — منتظر SHA256 از کاربر.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/generate-release.js`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** ⏳ اجرای `scripts/release.ps1` روی سیستم کاربر = انتشار کامل 1.0.10 (وب+دسکتاپ+اندروید)
- **یادداشت برای Cursor:** از این به بعد انتشار فقط با `release.ps1` انجام شود — manifest/latest.yml/exe/apk را دیگر دستی و جدا از هم به‌روز نکنید (ریشهٔ حلقهٔ آپدیت کاذب و APK مرده همین ناهماهنگی دستی بود).

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] آیکون اندروید از لوگوی واقعی ترنم (گزارش کاربر: آیکون لوگو نبود)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - آیکون لانچر اندروید یک وکتور عمومی دستی بود، نه لوگوی برند. از `server/public/logo.png` (۳۰۰۰×۳۰۰۰ شفاف) با sharp آیکون واقعی ساخته شد: `ic_launcher.png` + `ic_launcher_round.png` برای ۵ چگالی (mdpi تا xxxhdpi، زمینه سفید گرد) + `ic_launcher_foreground.png` برای adaptive icon (اندروید ۸+، زمینه سفید `@color/iconBackground`).
  - گزارش دیگر کاربر: APK نصب می‌شود ولی **برنامه اصلاً بالا نمی‌آید** — مشکوک به آپلود همان APK کهنه‌ای که ELF هر ۳ ABI آن MISSING بود (`SHA256=5341B460...`, ۲۲۲MB). دستور تشخیص به کاربر داده شد؛ سرور از این محیط قابل دسترسی نیست (پروکسی).
- **فایل‌های کلیدی:** `android/app/src/main/res/mipmap-*/ic_launcher*.png`, `mipmap-anydpi-v26/*.xml`, `values/colors.xml`
- **Deploy:** ❌ نیاز به build اندروید بعدی (2.0.5)
- **یادداشت برای Cursor:** قبل از build بعدی حتماً `git pull` — آیکون‌ها + تغییرات MainActivity (پیشرفت دانلود/نصب خودکار) + fix های `build-android.ps1` (BOM/exit-code) همه در git هستند. اگر APK روی سرور همان فایل ۲۳۲٬۷۴۷٬۱۹۹ بایتی است، خراب است و باید rebuild+re-upload شود.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] پیاده‌سازی کامل تم: «زمرد مدرن» (روشن، پیش‌فرض) + «شب مخملی» (دارک‌مود)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** اجرای کامل `docs/design/THEME-IMPLEMENTATION.md` (اسپکی که برای Cursor نوشته شده بود — چون کاربر خواست خود Claude اجرا کند):
  - **توکن‌ها:** بلوک `:root` بازنویسی شد (پالت زمرد مدرن) + بلوک `html[data-theme=dark]` (شب مخملی: سبز نئونی `#3DDC8C`، طلایی `#E7C876`، زمینه `#0D1512`) + توکن‌های جدید: `--on-accent`, `--side-bg`, `--shadow-card`, `--input-bg`, `--th-bg`, `--row-hover`, `--well`, `--chat-bg`, `--bub-me` و ۵ خانواده چیپ معنایی (`--ok/bad/amber/info/violet-bg/fg`).
  - **جاروی هاردکد:** همه سطح‌های `#fff`/پاستلی بلوک `<style>` به توکن تبدیل شد (مودال‌ها، فرم‌ها، جدول‌ها، دیت‌پیکر، کانبان، چت تلگرامی، پورتال B2B، تایم‌لاین...). متن روی دکمه‌های accent → `var(--on-accent)` (در دارک تیره می‌شود چون سبز نئونی روشن است).
  - **سوییچ:** دکمه «🌙/☀️» در foot سایدبار + گوشه صفحه ورود؛ ذخیره در `localStorage['crm_theme']`؛ اسکریپت ضد-FOUC اول `<head>`؛ `meta theme-color` همگام.
  - **امضاها:** کارت آمار اول گرادیان برند (هر دو تم)؛ در دارک: هالهٔ سبز radial روی body، گرادیان کارت‌ها، درخشش لوگو.
  - **نمودار:** `drawChart` تم‌آگاه شد (بنفش هاردکد قدیمی `#7C3AED` حذف!) + `rebuildChartsForTheme()` هنگام سوییچ.
  - **چاپ:** در `@media print` توکن‌های دارک به روشن برمی‌گردند — فاکتور/گزارش همیشه روشن چاپ می‌شود.
  - **تست:** اسکرین‌شات Playwright از ورود/داشبورد/مشتریان/فاکتور/مودال/شل حسابداری/گزارشات در هر دو تم — بدون لکه سفید یا متن کم‌کنتراست؛ تم بعد از reload حفظ می‌شود (anti-FOUC)؛ parse اسکریپت سبز. راهنما به‌روز شد؛ SW → `v26`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ pull + pm2 restart سرور production restart
- **یادداشت برای Cursor:** تم token-محور است — از این به بعد **هیچ رنگ سطحی را هاردکد نکنید**؛ از توکن‌های `:root` استفاده کنید وگرنه در دارک‌مود لکه می‌شود. برای رنگ متن روی دکمه سبز از `var(--on-accent)` استفاده کنید نه `#fff`.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] اعداد انگلیسی خودکار + UX جدید آپدیت (دکمه تبدیل‌شونده + پیشرفت دانلود) + رفع حلقه آپدیت کاذب دسکتاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **اعداد انگلیسی خودکار:** listener سراسری — در فیلدهای عددی (type number/tel، inputmode numeric/decimal، class money، data-jdate، idهای phone/qty/price/barcode/...) رقم فارسی/عربی همان لحظه تایپ به انگلیسی تبدیل می‌شود (با حفظ caret). متن آزاد (textarea/یادداشت) دست نمی‌خورد. قبلاً فیلد money رقم فارسی را کلاً حذف می‌کرد — حالا می‌پذیرد.
  - **UX آپدیت دسکتاپ:** پنل به‌روزرسانی حالا **یک دکمه تبدیل‌شونده** دارد: «🔄 بررسی» → (در حال دانلود + نوار پیشرفت با «X از Y مگابایت — حدود N ثانیه/دقیقه مانده») → «🚀 نصب نسخه X و راه‌اندازی مجدد». `desktop/main.js` هم transferred/total/bps را از electron-updater به UI می‌فرستد (**نیاز به build دسکتاپ جدید برای ETA؛ UI با buildهای قدیمی هم سازگار است — فقط درصد نشان می‌دهد**).
  - **UX آپدیت اندروید:** `MainActivity` دانلود APK را از DownloadManager رصد و پیشرفت را به `window.onApkDownloadProgress` می‌فرستد (مگابایت/درصد/زمان باقی‌مانده در بنر) و پس از پایان دانلود، پنجره نصب **خودکار** باز می‌شود (permission جدید `REQUEST_INSTALL_PACKAGES` در manifest). **نیاز به build اندروید بعدی.**
  - **رفع حلقه آپدیت کاذب:** `manifest.json` ادعای desktop=1.0.9 داشت ولی url به exe نسخه 1.0.8 اشاره می‌کرد (installer 1.0.9 هرگز ساخته نشده) → کاربر آپدیت می‌زد، 1.0.8 نصب می‌شد و دوباره پیام آپدیت می‌گرفت. نسخه به `1.0.8` صادقانه شد.
  - **تست:** curl روی `/api/system/app-update` (سه سناریو) + ۱۶ assertion جدید Playwright (state machine دکمه، برچسب MB/ETA، callback اندروید، تبدیل ارقام money/jdate/tel و مصون ماندن textarea) + ۲۲ تست SMS سبز + parse اسکریپت. راهنمای ادمین/فروش به‌روز شد؛ SW → `v25`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/public/releases/manifest.json`, `desktop/main.js`, `android/.../MainActivity.java`, `android/app/src/main/AndroidManifest.xml`
- **Deploy:** ✅ pull + pm2 restart سرور production restart (فرانت/manifest). دسکتاپ و اندروید در build بعدی.
- **یادداشت برای Cursor:** ⚠️ installer دسکتاپ **1.0.9 هنوز ساخته نشده** — بعد از build حتماً manifest+latest.yml را با هم bump کنید (ریشه حلقه آپدیت کاذب همین ناهماهنگی بود). در build بعدی اندروید، تغییرات MainActivity/manifest من هم سوار می‌شود.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] رفع شکست build اندروید روی سیستم کاربر (SDK location + گزارش succes کاذب)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** کاربر `finalize-android-release.ps1` را اجرا کرد و build با `SDK location not found` شکست خورد ولی اسکریپت APK کهنه را `BUILD=SUCCESS` گزارش کرد (چک ELF جلوی آپلود را گرفت — هر ۳ ABI MISSING). ریشه‌ها و اصلاح در `scripts/build-android.ps1`:
  - `local.properties` با `Set-Content -Encoding UTF8` نوشته می‌شد → در PowerShell 5 **BOM** دارد و Gradle کلید `sdk.dir` را نمی‌بیند. حالا با `[IO.File]::WriteAllText` بدون BOM و با `/` نوشته می‌شود.
  - `$env:ANDROID_HOME` هم صریحاً ست می‌شود (مسیر دوم تشخیص SDK برای Gradle).
  - exit code گریدل چک می‌شود (`$LASTEXITCODE`) و APK قدیمی **قبل از** build حذف می‌شود → دیگر success کاذب ممکن نیست.
- **فایل‌های کلیدی:** `scripts/build-android.ps1`
- **Deploy:** ❌ ربطی به سرور ندارد (اسکریپت build ویندوز)
- **یادداشت برای Cursor:** ⚠️ `scripts/finalize-android-release.ps1` و نسخهٔ محلی `build-android.ps1` شما (پیام «better-sqlite3 Android ELF modules present» دارد) **در git نیستند** — لطفاً طبق قانون CLAUDE.md commit کنید و همین دو fix (BOM + exit code) را اگر نسخهٔ محلی‌تان جداست اعمال/merge کنید. ضمن اینکه ELF سه ABI در APK کهنه MISSING بود — بعد از build موفق حتماً خروجی چک ELF بررسی شود.

### ۱۴۰۴/۰۴/۲۴ — رفع اسکرول پیام‌ها + build اندروید 2.0.4
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d5e079b`
- **خلاصه:**
  - **پیام‌ها:** اسکرول عمودی در پنجره مکالمه (`min-height:0` + `overflow-y:auto`)؛ حباب پیام `fit-content`؛ حفظ موقعیت اسکرول هنگام polling؛ SW → `v24`.
  - **اندروید 2.0.4:** Gradle wrapper + JDK 17 + libnode از zip رسمی nodejs-mobile؛ `buildConfig` فعال؛ exclude فایل‌های `.exe` دسکتاپ از assets (رفع OOM ۲GB)؛ APK release ساخته و آپلود به `/releases/crm-taranom.apk` (~148MB).
  - **اسکریپت:** `scripts/build-android.ps1` برای buildهای بعدی.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `android/app/build.gradle`, `android/gradle.properties`, `android/gradlew*`, `scripts/build-android.ps1`, `server/public/releases/manifest.json`
- **Deploy:** ✅ وب (pull+pm2) + APK روی سرور

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] اسپک کامل تم «زمرد مدرن + شب مخملی» برای اجرا توسط Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc602ed` (فقط docs — کد برنامه دست نخورده)
- **خلاصه:**
  - کاربر ترکیب تأییدشده را انتخاب کرد: **بورد ۱ (زمرد مدرن) تم اصلی روشن + بورد ۲ (شب مخملی) دارک‌مود**.
  - سند اجرایی کامل برای Cursor نوشته شد: `docs/design/THEME-IMPLEMENTATION.md` — شامل توکن‌های کامل CSS هر دو تم، بلوک `html[data-theme=dark]`، اسکریپت ضد-FOUC، سوییچ 🌙 (localStorage `crm_theme`)، جدول پاک‌سازی رنگ‌های هاردکد، helper تم‌آگاه Chart.js، چاپِ همیشه‌روشن، bump SW، و چک‌لیست QA.
  - فایل‌های مرجع گرافیکی در repo: `docs/design/board1-modern-emerald.png`, `docs/design/board2-velvet-night.png`, `docs/design/design-boards-reference.html`.
- **فایل‌های کلیدی:** `docs/design/THEME-IMPLEMENTATION.md`, `docs/design/*.png`, `docs/design/design-boards-reference.html`
- **Deploy:** ❌ لازم نیست (اجرا با Cursor است)


### ۱۴۰۴/۰۴/۲۴ — نسخه 1.0.9 (فاکتور، کاتالوگ، پیام‌ها، AI کاربر، آیکون‌ها)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `843ecd2`
- **خلاصه:** پیاده‌سازی کامل `update1.0.9.md`:
  - **§1 فاکتور:** حذف فیلد کانال فروش از UI؛ `resolveSalesChannel()` در backend از نقش کاربر (میدانی→field، تلفنی→phone)؛ حذف «ساخت محصول» از فاکتورساز؛ `/products/quick` فقط admin.
  - **§2 کاتالوگ:** `GET /warehouses` برای همه کاربران auth؛ ترتیب routeهای محصولات (`/categories`، `/by-barcode` قبل از `/:id`).
  - **§3 پیام‌ها:** API `/messages/threads`، `/thread/:peer`، `/thread/:peer/read`؛ UI تلگرامی با polling، حباب، تیک دوبل.
  - **§4 حساب من:** `clamp()` + `fitStatNums()` برای اعداد بزرگ در کارت‌های آمار.
  - **§5 پرداخت معلق:** اسکریپت `cleanup-aref-pending.js`؛ حذف تسویه تأییدشده → وضعیت `rep_payment_submissions` به rejected.
  - **§6 AI کاربر:** `GET /api/ai/my-summary` + `buildMySummary()` فقط دادهٔ `user_id` خود کاربر.
  - **§7 آیکون‌ها:** Lucide SVG در منو و کارت‌های آمار (`lucide()` + `EMO_LU`).
  - **تست:** `scripts/test-1.0.9.js` (۲۱ assertion). راهنمای ادمین/فروش به‌روز شد؛ SW → `v23`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/invoices.js`, `server/routes/products.js`, `server/routes/warehouses.js`, `server/routes/messages.js`, `server/routes/accounting.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/scripts/test-1.0.9.js`, `server/scripts/cleanup-aref-pending.js`, `server/public/sw.js`
- **Deploy:** ✅ deploy شده (pull + pm2 restart — aref: کاربر #3 یافت شد، رکورد pending نداشت)

### ۱۴۰۴/۰۴/۲۴ — پورتال مشتریان B2B (انتقال از CRM v4 — فقط مرکزی)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3acd305`
- **خلاصه:** پورتال سفارش آنلاین مشتریان عمده — کاملاً افزودنی، بدون دست زدن به جریان‌های موجود:
  - **Backend:** جداول `b2b_portal_accounts` + `b2b_portal_orders` (خارج از SYNCABLE_TABLES — فقط مرکزی)؛ ستون `customers.b2b_enabled` (از طریق sync معمولی مشتری به دستگاه‌ها می‌رسد، فقط برای نمایش برچسب)؛ route جدید `routes/b2b.js` با `centralOnly` روی کل router: ورود با موبایل+رمز یا OTP پیامکی (پاسخ uniform — بدون افشای وجود شماره)، کاتالوگ، ثبت سفارش، تاریخچه سفارش/فاکتور، صورتحساب زنده (همان `buildStatement` حسابداری — export شد).
  - **جداسازی توکن:** توکن پورتال `scope:'b2b'` دارد؛ middleware داخلی `auth` هر توکن دارای scope را رد می‌کند (توکن‌های staff موجود بدون scope هستند → backward compatible) و `b2bAuth` فقط scope='b2b' می‌پذیرد — تست دوطرفه دارد.
  - **گردش سفارش:** سفارش پورتال → پیش‌فاکتور با شماره اتمیک (`allocateNumber` — نه COUNT+1 مثل v4) به نام کارشناسِ مشتری + پیام داخلی به او؛ قیمت همیشه server-side از جدول محصولات (قیمت کلاینت نادیده گرفته می‌شود — تست دارد)؛ تأیید = تبدیل همان پیش‌فاکتور به رسمی از مسیر موجود (موجودی/دفتر/سند همان‌جا).
  - **Frontend:** صفحه پورتال `#portal` (ورود، کاتالوگ با تصویر و سبد با +/−، سفارشات من، صورتحساب با مانده بدهکار/بستانکار)؛ لینک «ورود پورتال مشتریان» در صفحه ورود (فقط وقتی feature روشن است — از `app-info` که فیلد بولین `b2b_portal` گرفت)؛ بخش «🛒 پورتال B2B» در فرم ویرایش مشتری (ادمین، غیر device)؛ منوی ادمین «🛒 سفارشات B2B»؛ برچسب آبی B2B در لیست مشتریان؛ پنل تنظیمات با کلید `feature_b2b_portal`.
  - **ایمنی:** rate-limit روی `/api/b2b/auth/*`؛ `/api/b2b` در BLOCKLIST سینک؛ کلیدهای `feature_*`/`ai_*` به ALLOWED_KEYS تنظیمات اضافه شد (قبلاً ذخیره AI هم silently drop می‌شد — رفع شد)؛ روی device build همه endpointها 403 و منو/لینک مخفی.
  - **تست:** `scripts/test-b2b.js` جدید (۲۹ assertion: فلگ، provisioning، ورود/OTP، جداسازی توکن دوطرفه، قیمت server-side، صف ادمین، لغو دسترسی). هر ۴ suite سبز: 22 sms + 25 sync + 24 v4 + 29 b2b. راهنمای ادمین/فروش به‌روز شد؛ SW → `v22`.
- **فایل‌های کلیدی:** `server/routes/b2b.js`, `server/db.js`, `server/middleware/auth.js`, `server/server.js`, `server/routes/settings.js`, `server/routes/accounting.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-b2b.js`
- **Deploy:** ✅ deploy شده (pull + pm2 restart — جداول ساخته شدند، endpoint ها verify شدند: login بدون فلگ → 403 صحیح، admin/orders بدون توکن → 401، app-info فیلد `b2b_portal` برمی‌گرداند. dependency جدیدی ندارد.)
- **یادداشت:** پورتال هنوز **خاموش** است — برای فعال‌سازی: تنظیمات → «پورتال مشتریان B2B» → فعال‌سازی + ذخیره، سپس برای هر مشتری از فرم ویرایش او دسترسی و رمز تعیین کنید. آدرس پورتال: `/#portal`.

### ۱۴۰۴/۰۴/۲۳ — انتقال مزیت‌های CRM v4: امنیت 2FA + دستیار AI + بارکد محصولات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `87a6469`
- **خلاصه:** آنالیز کامل پروژه `crm v4` و انتقال ۳ مزیت اصلی آن (بدون multi-tenancy/B2B/مودیان/puppeteer که به معماری آسیب می‌زدند):
  - **2FA (TOTP):** جدول `two_factor_auth` (خارج از sync — فقط مرکزی)، route جدید `/api/auth/2fa/*` (setup/verify/recovery-code/disable/status/admin-reset/admin-status)، رمزنگاری اسرار با AES-256-GCM (`services/crypto.js`)، مرحله کد ۶ رقمی در ورود + کدهای بازیابی یک‌بارمصرف، پنل «🔐 امنیت» در سایدبار، rate-limit روی verify. دستگاه‌های آفلاین: ورود بدون 2FA (جدول خالی)، مدیریت 2FA فقط از وب (`centralOnly`).
  - **دستیار فروش AI:** ستون `customers.churn_score` + جدول `ai_insights`؛ سرویس heuristic (ریسک ریزش ۰-۱۰۰، فرصت فروش مجدد بر اساس الگوی خرید، اقدام روزانه هر کارشناس، خلاصه هفتگی مدیر) بدون نیاز به API خارجی؛ لایه اختیاری Claude API (تنظیمات: `feature_ai_assistant`, `ai_api_key`, `ai_model`)؛ cron شبانه ۰۲:۰۰ فقط مرکزی؛ صفحه «🤖 دستیار AI» در منوی ادمین و فروش؛ برچسب قرمز ریسک در لیست مشتریان.
  - **بارکد محصولات:** ستون `products.barcode`؛ تولید EAN-13 استاندارد (deterministic → سازگار با replay سینک)؛ `/by-barcode/:code`؛ صفحه چاپ برچسب 58×40mm (توکن از query)؛ اسکنر دوربین (html5-qrcode با lazy-load CDN و ورود دستی جایگزین) در فاکتورساز (افزودن مستقیم به سبد) و صفحه محصولات؛ پشتیبانی بارکد در جستجو/اکسل.
  - **سایر:** audit ورود موفق/ناموفق؛ `/api/ai` در BLOCKLIST سینک؛ راهنمای ادمین و فروش (۳ بخش جدید هرکدام)؛ SW bump به `v21`؛ وابستگی جدید `otplib@12` (هر ۳ package.json).
  - **تست:** `scripts/test-v4-features.js` جدید (۲۴ assertion end-to-end روی سرور واقعی: چرخه کامل 2FA، اعتبار check-digit بارکد، تحلیل AI). هر ۳ suite سبز: 22 sms + 25 sync + 24 v4.
- **فایل‌های کلیدی:** `server/routes/twofa.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/services/crypto.js`, `server/routes/auth.js`, `server/routes/products.js`, `server/db.js`, `server/server.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`
- **Deploy:** ✅ deploy شده (pull + npm install + pm2 restart — HTTP 200، endpointهای 2fa/ai روی production mount شدند، SW v21 سرو می‌شود)
- **یادداشت:** روی سرور بعد از pull حتماً `npm install` اجرا شود (otplib جدید است).
### ۱۴۰۴/۰۴/۲۳ — [Claude Code] هماهنگی با Cursor + قانون یادداشت‌گذاری مشترک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت (فقط مستندات — بدون تغییر کد)
- **خلاصه:**
  - Claude Code به آخرین کار Cursor همگام شد (rebase روی `0919817` — شامل 1.0.7، 1.0.8، انبارگردانی، آکاردئون سایدبار).
  - شاخهٔ محلی زائد `spec1000-phaseG-backup` (پیاده‌سازی موازی فراننکو توسط Claude) حذف شد — نسخهٔ Cursor در `server/lib/farankenou.js` معتبر است.
  - قانون جدید در `CLAUDE.md`: هماهنگی دوطرفهٔ Cursor ⇄ Claude Code — بعد از هر تسک، ورودی در همین فایل + commit/push اجباری. git تنها کانال مشترک است.
  - خارج از repo: ۴ بورد طراحی UI (زمرد مدرن، شب مخملی، کاغذ و مرکب، کوارتز صنعتی) به‌صورت Artifact به کاربر تحویل شد. توصیهٔ Claude: «زمرد مدرن» تم اصلی + «شب مخملی» دارک‌مود. هنوز هیچ‌کدام پیاده نشده — منتظر تصمیم کاربر.
- **فایل‌های کلیدی:** `CLAUDE.md`, `docs/CHANGE-LOG.md`
- **Deploy:** ❌ لازم نیست (فقط مستندات)
- **یادداشت برای Cursor:** اگر کار uncommitted دارید، قبل از تسک بعدی Claude حتماً push کنید — Claude فقط git را می‌بیند. (این rebase وسط push شما اتفاق افتاد — هر دو ورودی حفظ شد.)

### ۱۴۰۴/۰۴/۲۳ — بازطراحی تیترهای سرفصل منوی حسابداری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `927ef3b`
- **خلاصه:**
  - سرفصل‌های آکاردئون منوی حسابداری از 10px خاکستری uppercase به کارت‌های مدرن تبدیل شد: فونت 13.5px وزن 800، رنگ سفید با کنتراست بالا روی سایدبار تیره، پس‌زمینه شیشه‌ای گرد (border-radius 11px)
  - حالت باز: گرادیان طلایی + متن کرم؛ hover روشن‌تر؛ فلش `▾` با چرخش انیمیشنی (rotate 90° در حالت بسته)
  - رفع hover نامرئی قبلی (`var(--purple)` سبز تیره روی پس‌زمینه سبز تیره)
  - راهنمای ادمین به‌روز شد؛ SW bump به `v20`
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ⏳

### ۱۴۰۴/۰۴/۲۳ — نسخه 1.0.8 (وب + دسکتاپ) و 2.0.3 (اندروید)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `66e3c56`
- **خلاصه:**
  - **UI:** اعداد کامل داشبورد + فونت adaptive؛ accordion منوی حسابداری (پیش‌فرض بسته)؛ عنوان «ثبت دریافت از مشتری»
  - **باگ:** lightbox رسید نماینده (مسیر upload)؛ جستجوی مشتری نام+فروشگاه؛ dropdown GL هزینه؛ followups sub-group (`_fupCustGroups`)
  - **ویژگی:** widget تسویه‌های منتظر تأیید؛ فیلتر ممیزی (تاریخ امروز + کاربر)؛ مرتب‌سازی followups نزولی؛ sync خودکار debounced 2s
  - **ماژول جدید:** انبارگردانی (`stocktaking_sessions` + `stocktaking_items` + UI + API)
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/stocktaking.js`, `server/db.js`, `server/sync/tables.js`, `server/public/sw.js`
- **Deploy:** ✅ وب + installer دسکتاپ 1.0.8 (~97MB) روی production — ⏳ APK اندروید 2.0.3 (نیاز Android Studio + libnode)

### ۱۴۰۴/۰۴/۲۱ — انتشار دسکتاپ 1.0.7 (build + deploy)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `eb50d4b`
- **خلاصه:**
  - build: `CRM Taranom Setup 1.0.7.exe` (~93MB)
  - manifest + latest.yml به‌روز — دانلود از `/releases/` سرور production
  - رفع crash `rep_territories` در initDB
- **فایل‌های کلیدی:** `desktop/dist/`, `server/public/releases/manifest.json`, `server/public/releases/latest.yml`
- **Deploy:** ✅ کامل — metadata + exe روی production (97082265 bytes)
- **یادداشت:** نصب تازه یا جایگزینی 1.0.6

### ۱۴۰۴/۰۴/۲۱ — رفع خطای دسکتاپ: no such table rep_territories
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5158586`
- **خلاصه:**
  - `ensureColumn` روی `rep_territories` **قبل از** `CREATE TABLE` اجرا می‌شد → initDB روی DB تازه دسکتاپ crash
  - ستون‌های `rep_id` و `cities` به تعریف جدول منتقل شد؛ migration بعد از CREATE
- **فایل‌های کلیدی:** `server/db.js`
- **Deploy:** ⏳ وب + **نیاز به rebuild دسکتاپ 1.0.7**
- **یادداشت:** نسخه دسکتاپ فعلی 1.0.6 این باگ را دارد — installer جدید لازم است

### ۱۴۰۴/۰۴/۲۱ — رفع 502 + بهینه‌سازی بنیادی سرعت وب و حسابداری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b921b73`
- **خلاصه:**
  - **رفع 502:** import گم‌شده `adminOnly` در `invoices.js` — PM2 در crash loop بود (۴۵۰k+ restart)
  - **حسابداری:** داشبورد acc-dash دیگر trial-balance و suppliers/list را بلوک نمی‌کند؛ overview غنی‌شده با `trialBalanced` + `totalPayable`
  - **SQL:** query تأمین‌کنندگان از correlated subquery به JOIN تبدیل شد
  - **boot admin:** `/settings` به‌صورت lazy load (مسدود نکردن login)
  - SW bump به `v18`
- **فایل‌های کلیدی:** `server/routes/invoices.js`, `server/routes/accounting.js`, `server/routes/suppliers.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ production (`6350292` — PM2 stable, HTTP 200)
- **یادداشت:** `git pull origin claude/claude-md-docs-2ssrpy && cd server && pm2 restart crm-taranom`

### ۱۴۰۴/۰۴/۲۰ — زیرساخت به‌روزرسانی دسکتاپ (GitHub Releases، بدون SCP)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a69f5d8`
- **خلاصه:**
  - رفع installer bloated: حذف exeهای قدیمی از بسته نصب (۹۳MB به‌جای ۱.۱GB)
  - exe دیگر روی سرور production آپلود نمی‌شود — فقط manifest + latest.yml
  - لینک دانلود از GitHub Releases در manifest.desktop.url
  - `update-feed` از feed_url خارجی پشتیبانی می‌کند
- **فایل‌های کلیدی:** `desktop/scripts/prepare-server.js`, `scripts/publish-desktop.js`, `docs/DESKTOP-UPDATE.md`, `server/server.js`
- **Deploy:** ✅ production (`a69f5d8`)
- **یادداشت:** `gh release create v1.0.6 ...` — راهنما در docs/DESKTOP-UPDATE.md

### ۱۴۰۴/۰۴/۲۰ — به‌روزرسانی 1.0.6 (update1.0.6.md — ۱۴ مورد)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `41be9d1`
- **خلاصه:**
  - دسکتاپ: تأیید خروج؛ پشتیبان محلی بدون خطای centralOnly
  - UX: fmtCompact در statCard؛ ستون‌های استاندارد مشتری + tel: موبایل
  - پیگیری: مانده حساب در مرحله؛ kanban ستون سرنخ؛ لیست accordion مشتری
  - اکسل فقط admin؛ گزارش top10؛ فاکتور با نام کامل؛ نقش دفتر پخش
  - پیام‌ها: checkbox + پوشه کاربر؛ تنظیمات module_reps؛ ACC_NAV دسته‌بندی
  - پرداخت میدانی: rep_payment_submissions + تأیید حسابدار
- **فایل‌های کلیدی:** `server/public/index.html`, `server/db.js`, `server/routes/rep-management.js`, `desktop/main.js`
- **Deploy:** ✅ production (`41be9d1`)
- **یادداشت:** `git pull && cd server && pm2 restart crm-taranom`

### ۱۴۰۴/۰۴/۱۹ — بهینه‌سازی سرعت ناوبری و بارگذاری صفحات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc95426`
- **خلاصه:**
  - فرانت: لایه cache برای API و HTML داشبورد/گزارشات؛ reuse پنل حسابداری بین تب‌ها؛ debounce جستجو؛ fetch یک‌باره پیام‌ها/یادآورها
  - بک‌اند: indexهای جدید SQLite؛ cache وضعیت کاربر فعال در auth (۳۰ثانیه)؛ رفع N+1 در `/reports/salesperson`؛ `seedWarehouseStock` فقط یک‌بار
  - Service Worker: bump به `crm-taranom-v8`
- **فایل‌های کلیدی:** `server/public/index.html`, `server/db.js`, `server/middleware/auth.js`, `server/routes/reports.js`, `server/public/sw.js`
- **Deploy:** ✅ production (`dc95426` — HTTP 200)
- **یادداشت:** سرور API از قبل سریع بود (~۵ms)؛ گلوگاه اصلی فرانت و queryهای تکراری بود

---

### ۱۴۰۴/۰۴/۱۸ — امنیت، فراموشی رمز، بک‌آپ پیشرفته، واردات محک، رفع build دسکتاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f322106`
- **خلاصه:**
  - رفع build دسکتاپ: `better-sqlite3` v11 + `electron-updater`
  - امنیت: `JWT_SECRET` اجباری در production، سیاست رمز ۸+ حرف و عدد (`lib/security.js`)
  - فراموشی رمز: OTP پیامکی از صفحه ورود
  - بک‌آپ: چرخشی (۱۴ نسخه)، ZIP روی ویندوز / tar.gz روی لینوکس، شامل DB + uploads
  - واردات محک: آپلود FullBackup.zip، تحلیل .bak، import از SQL Server
  - راهنمای داخل برنامه به‌روز شد
- **فایل‌های کلیدی:** `server/lib/security.js`, `server/backup.js`, `server/routes/auth.js`, `server/routes/import.js`, `server/lib/mahak-import.js`, `desktop/package.json`, `docs/MAHAK-IMPORT.md`
- **Deploy:** ⏳
- **یادداشت:** واردات کامل محک نیاز به SQL Server + restore فایل‌های .bak دارد

---

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `391fd66`
- **خلاصه:**
  - عکس محصولات در نسخهٔ آفلاین (دسکتاپ/موبایل) از سرور مرکزی pull می‌شود (`server/sync/files.js`)
  - درخواست `/uploads/...` اگر فایل محلی نباشد، از مرکز دانلود می‌کند (middleware در `server.js`)
  - UI: retry عکس، دکمه «دریافت تصاویر» در پنل sync، badge «X تصویر در انتظار»
  - Service Worker دیگر `/uploads/` را cache نمی‌کند (`sw.js` v7)
  - auto-update دسکتاپ با `electron-updater` (`desktop/main.js`)
  - اعلان نسخهٔ جدید اندروید + دانلود APK در Downloads (`MainActivity.java`)
  - manifest نسخه‌ها: `server/public/releases/manifest.json` + اسکریپت `scripts/generate-release.js`
- **فایل‌های کلیدی:** `server/sync/files.js`, `server/sync/client.js`, `server/server.js`, `server/routes/sync.js`, `server/public/index.html`, `desktop/main.js`, `android/.../MainActivity.java`, `server/lib/app-update.js`
- **Deploy:** ⏳ روی GitHub push شد — سرور باید `git pull` بزند
- **یادداشت:** برای auto-update دسکتاپ، فایل‌های `.exe` و `latest.yml` را در `server/public/releases/` آپلود کنید

---

### ۱۴۰۴/۰۴/۱۸ — بهینه‌سازی عملکرد + رفع crash بوت production
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5d797cb` (و `abe33d1`, `8119a5d`)
- **خلاصه:**
  - SQLite tuning (WAL, cache, mmap)، indexهای جدید، batch query به‌جای N+1
  - لیست فاکتورها بدون `rows` سنگین؛ جزئیات با `GET /invoices/:id`
  - `seedWarehouseStock()` امن با JS loop (بدون SQL شکسته روی `warehouses` قدیمی)
  - `repairWarehousesSchema()` / `repairProductCategoriesSchema()` برای DB legacy
  - sync trigger درست برای `warehouse_stock` (کلید composite)
  - فرانت: cache/debounce، `loadInitial` سبک‌تر برای نقش accounting
- **فایل‌های کلیدی:** `server/db.js`, `server/routes/{customers,invoices,accounting,admin,warehouses,cash-boxes}.js`, `server/public/index.html`
- **Deploy:** ✅ روی production pull شد (`6a9f240` → `5d797cb`)
- **یادداشت:** خطای قدیمی `SqliteError: no such column: id` در لاگ PM2 مربوط به restartهای قبل بود؛ بعد از repair دستی، `warehouses` ستون `id` دارد

---

### ۱۴۰۴/۰۴/۱۷ — فازهای B تا F (update1000)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6a9f240`
- **خلاصه:** درخت COA، مطالبات به تفکیک فاکتور، UX خرید/انبار، سربار تولید خودکار
- **Deploy:** ✅ پایدار روی production (rollback قبلی به این commit)

---

### ۱۴۰۴/۰۴/۱۷ — بهینه‌سازی اولیهٔ سرعت بارگذاری
- **Commit:** `7228ce6`
- **خلاصه:** JOIN balance مشتری، receivables batch، `/cash-boxes/balances`, indexها، cache فرانت
- **Deploy:** ✅ (داخل شاخهٔ فعلی)

---

## کارهای انجام‌نشده / در صف

- [ ] **deploy production** برای `d4c4d8d` (امنیت): `bash scripts/deploy-production.sh` روی سرور — Cloud Agent به SSH دسترسی ندارد (publickey)
- [ ] پس از deploy: رمزنگاری بکاپ از پنل «پشتیبان» + چرخش keystore اندروید (`keystore.properties.example`)
- [ ] HTTPS طبق `docs/SECURITY-HARDENING.md` بخش «د»
- [ ] pagination برای لیست‌های بزرگ
- [ ] merge شاخه به `main`

---

## دستور deploy استاندارد (سرور)

```bash
# یک‌خطی (توصیه‌شده — شامل jwt-secret و health check):
bash /home/taranom-admin/crm-taranom/scripts/deploy-production.sh

# یا دستی:
cd /home/taranom-admin/crm-taranom
git fetch origin
git checkout claude/claude-md-docs-2ssrpy
git pull origin claude/claude-md-docs-2ssrpy
cd server
# فقط اگر jwt-secret.txt ندارید:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > jwt-secret.txt && chmod 600 jwt-secret.txt
npm install --omit=dev
pm2 restart crm-taranom --update-env
curl -s http://127.0.0.1:3000/api/system/time
```

**هرگز** `git reset --hard` روی production نزنید مگر برای rollback آگاهانه.
