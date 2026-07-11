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

## وضعیت فعلی (آخرین به‌روزرسانی: ۱۴۰۴/۰۴/۲۴)

| مورد | مقدار |
|------|--------|
| شاخهٔ کاری | `claude/claude-md-docs-2ssrpy` |
| آخرین commit | `d5e079b` |
| نسخه وب/دسکتاپ | **`1.0.9`** / SW `v24` |
| اندروید | **`2.0.4`** (versionCode 6) |
| وضعیت سرور | ✅ deploy + APK 2.0.4 آپلود شده |

---

## تاریخچه

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
- **Deploy:** ⏳ نیاز به pull + pm2 restart (فرانت/manifest). دسکتاپ و اندروید در build بعدی.
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
