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
