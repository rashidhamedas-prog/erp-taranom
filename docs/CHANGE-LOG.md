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

## وضعیت فعلی (آخرین به‌روزرسانی: ۱۴۰۴/۰۴/۲۳)

| مورد | مقدار |
|------|--------|
| شاخهٔ کاری | `claude/claude-md-docs-2ssrpy` |
| آخرین commit | `66e3c56` |
| نسخه وب/دسکتاپ | **`1.0.8`** / SW `v19` |
| اندروید | **`2.0.3`** (versionCode 5) |
| وضعیت سرور | ✅ deploy (وب + manifest دسکتاپ 1.0.8) |

---

## تاریخچه

### ۱۴۰۴/۰۴/۲۴ — پورتال مشتریان B2B (انتقال از CRM v4 — فقط مرکزی)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (در ورودی بعدی ثبت می‌شود)
- **خلاصه:** پورتال سفارش آنلاین مشتریان عمده — کاملاً افزودنی، بدون دست زدن به جریان‌های موجود:
  - **Backend:** جداول `b2b_portal_accounts` + `b2b_portal_orders` (خارج از SYNCABLE_TABLES — فقط مرکزی)؛ ستون `customers.b2b_enabled` (از طریق sync معمولی مشتری به دستگاه‌ها می‌رسد، فقط برای نمایش برچسب)؛ route جدید `routes/b2b.js` با `centralOnly` روی کل router: ورود با موبایل+رمز یا OTP پیامکی (پاسخ uniform — بدون افشای وجود شماره)، کاتالوگ، ثبت سفارش، تاریخچه سفارش/فاکتور، صورتحساب زنده (همان `buildStatement` حسابداری — export شد).
  - **جداسازی توکن:** توکن پورتال `scope:'b2b'` دارد؛ middleware داخلی `auth` هر توکن دارای scope را رد می‌کند (توکن‌های staff موجود بدون scope هستند → backward compatible) و `b2bAuth` فقط scope='b2b' می‌پذیرد — تست دوطرفه دارد.
  - **گردش سفارش:** سفارش پورتال → پیش‌فاکتور با شماره اتمیک (`allocateNumber` — نه COUNT+1 مثل v4) به نام کارشناسِ مشتری + پیام داخلی به او؛ قیمت همیشه server-side از جدول محصولات (قیمت کلاینت نادیده گرفته می‌شود — تست دارد)؛ تأیید = تبدیل همان پیش‌فاکتور به رسمی از مسیر موجود (موجودی/دفتر/سند همان‌جا).
  - **Frontend:** صفحه پورتال `#portal` (ورود، کاتالوگ با تصویر و سبد با +/−، سفارشات من، صورتحساب با مانده بدهکار/بستانکار)؛ لینک «ورود پورتال مشتریان» در صفحه ورود (فقط وقتی feature روشن است — از `app-info` که فیلد بولین `b2b_portal` گرفت)؛ بخش «🛒 پورتال B2B» در فرم ویرایش مشتری (ادمین، غیر device)؛ منوی ادمین «🛒 سفارشات B2B»؛ برچسب آبی B2B در لیست مشتریان؛ پنل تنظیمات با کلید `feature_b2b_portal`.
  - **ایمنی:** rate-limit روی `/api/b2b/auth/*`؛ `/api/b2b` در BLOCKLIST سینک؛ کلیدهای `feature_*`/`ai_*` به ALLOWED_KEYS تنظیمات اضافه شد (قبلاً ذخیره AI هم silently drop می‌شد — رفع شد)؛ روی device build همه endpointها 403 و منو/لینک مخفی.
  - **تست:** `scripts/test-b2b.js` جدید (۲۹ assertion: فلگ، provisioning، ورود/OTP، جداسازی توکن دوطرفه، قیمت server-side، صف ادمین، لغو دسترسی). هر ۴ suite سبز: 22 sms + 25 sync + 24 v4 + 29 b2b. راهنمای ادمین/فروش به‌روز شد؛ SW → `v22`.
- **فایل‌های کلیدی:** `server/routes/b2b.js`, `server/db.js`, `server/middleware/auth.js`, `server/server.js`, `server/routes/settings.js`, `server/routes/accounting.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-b2b.js`
- **Deploy:** ⏳ نیاز به pull
- **یادداشت:** بعد از deploy، ادمین باید در تنظیمات «پورتال B2B» را روشن کند و برای هر مشتری از فرم ویرایش، دسترسی بدهد. آدرس پورتال: `/#portal`.

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

- [ ] `git pull` روی production برای `391fd66`
- [ ] آپلود `CRM-Taranom-Setup-1.0.1.exe` + `latest.yml` + `crm-taranom.apk` به `server/public/releases/`
- [ ] rebuild و توزیع APK/EXE جدید به کاربران (یک‌بار دستی، بعد auto-update)
- [ ] فایل‌های Farankenou (`server/lib/farankenou.js`, payroll, persons) — تغییرات uncommitted جداگانه
- [ ] pagination برای لیست‌های بزرگ
- [ ] merge شاخه به `main`

---

## دستور deploy استاندارد (سرور)

```bash
cd /home/taranom-admin/crm-taranom
git fetch origin
git checkout claude/claude-md-docs-2ssrpy
git pull origin claude/claude-md-docs-2ssrpy
cd server && pm2 restart crm-taranom
curl -I http://127.0.0.1:3000/
```

**هرگز** `git reset --hard` روی production نزنید مگر برای rollback آگاهانه.
