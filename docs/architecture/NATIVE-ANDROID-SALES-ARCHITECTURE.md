# معماری اپلیکیشن بومی Android فروشندگان — ERP ترنم

> وضعیت: **سند معماری قابل‌اجرا (Wave 0)** — اسکلت کد در موج بعد  
> تاریخ پیش‌نویس: ۱۴۰۵/۰۷/۰۵ · دستور مالک: مأموریت قطعی اپ بومی فروشندگان  
> اولویت این سند بر معماری فعلی `android/` (nodejs-mobile + WebView + `http://127.0.0.1:3210`) است.  
> نسخهٔ فعلی تا آماده‌شدن مسیر مهاجرت **حفظ** می‌شود؛ محصول نهایی آن نیست.  
> هم‌ترازی پروتکل: [`NATIVE-WINDOWS-SYNC-GAPS.md`](./NATIVE-WINDOWS-SYNC-GAPS.md) · [`docs/OFFLINE-SYNC.md`](../OFFLINE-SYNC.md)  
> Claim تسک: [`NATIVE-ANDROID-TASK-CLAIM.md`](./NATIVE-ANDROID-TASK-CLAIM.md)

---

## ۰) حکم معماری (یک پاراگراف)

محصول هدف یک **اپلیکیشن بومی Android (Kotlin + Jetpack Compose)** با **منطق دامنهٔ فروش روی دستگاه**، **دیتابیس SQLite محلی تراکنشی متعلق به نصب**، **صف outbox پایدار**، **موتور sync سازگار با مرکز/دسکتاپ**، **فعال‌سازی/ورود محلی مستقل از پاسخ روزانۀ سرور**، و **updater جدا از sync داده** است. رابط اصلی فروش (فرم‌ها، کاتالوگ، سبد، اسناد، وصول، گزارش شخصی) **نه WebView، نه PWA، نه سایت مرکز، نه اجرای اجباری Node روی localhost** است. دامنهٔ موبایل = نقش‌های فروش (`field_sales` / `inside_sales` / در صورت مجوز `sales_manager` محدود)؛ نه کل ERP دسکتاپ. سرور فقط برای تبادل دادهٔ مشترک، سیاست سازمانی، و بستهٔ به‌روزرسانی است. قطع اینترنت/DNS/مرکز/sync نباید اجرای محلی را متوقف کند.

---

## ۱) اهداف، غیر اهداف، فرضیات، قیود، معیار موفقیت

### ۱.۱ اهداف
- استقلال اجرایی آفلاین پس از فعال‌سازی (آزمون air-gap §۱۵ مأموریت).
- پوشش کامل گردش‌های مجاز فروش طبق ماتریس قابلیت.
- برابری محاسبات مالی فروش با سرور از طریق fixture طلایی مشترک.
- قرارداد sync یکسان با مرکز و دسکتاپ بومی/Electron فعلی (پروتکل ناسازگار ممنوع).
- مهاجرت داده و outbox از APK فعلی بدون wipe بی‌صدا.
- APK release امضاشده، قابل ارتقا روی نصب قبلی (همان `applicationId` + همان زنجیرهٔ امضا).

### ۱.۲ غیر اهداف (این محصول)
- بازسازی کل ماژول‌های حسابداری/تولید/حقوق دسکتاپ روی گوشی.
- معرفی WebView به‌عنوان UI اصلی (حتی با نام «بومی»).
- Node.js / Express روی دستگاه به‌عنوان پیش‌نیاز محصول نهایی.
- پروتکل sync جدا برای Android.
- ضبط مکالمه، خواندن تاریخچهٔ تماس سیستم، ردیابی دائمی موقعیت مگر دستور صریح بعدی.
- انتشار Google Play یا آپلود به Iran VPS بدون مجوز مالک.
- حذف APK فعلی قبل از مسیر مهاجرت تأییدشده.

### ۱.۳ فرضیات (برچسب‌دار)

| شناسه | فرض | تأیید؟ |
|---|---|---|
| A1 | کاربران هدف: فروشندگان میدانی/حضوری/تلفنی روی Android تلفن/تبلت | خیر |
| A2 | `minSdk 24` فعلی حفظ می‌شود مگر دلیل امنیتی/ابزاری مستند | خیر (کد: `android/app/build.gradle`) |
| A3 | `applicationId` = `ir.taranom.crm` برای ارتقا بدون uninstall | **بله** (مالک) |
| A4 | کانال اصلی توزیع = APK مستقیم sideload (+ MDM سازمانی اختیاری) | **بله** |
| A5 | keystore release محلی موجود است؛ چرخش به‌خاطر افشای تاریخی در git ممکن است لازم شود | **بله** (ops) |
| A6 | فروش قطعی نامحدود آفلاین با تضمین عدم oversell وعده داده نمی‌شود؛ سهمیه یا «محلی+تأیید مرکز» | **بله** (سیاست) |
| A7 | محیط محلی کاملاً جدا (بدون دادهٔ سازمانی) برای دمو/آموزش اختیاری است | **بله** |

### ۱.۴ قیود قطعی (از مأموریت)
- UI اصلی بومی؛ WebView فقط برای سند/راهنمای کمکی در صورت نیاز اثبات‌شده.
- DB محلی = منبع حقیقت دستگاه؛ cache قابل‌حذف نیست.
- domain write + outbox در یک تراکنش (شکاف فعلی sync باید در کلاینت بومی بسته شود).
- رد مرکز ≠ حذف بی‌صدا سند محلی.
- تعارض مالی ≠ LWW.
- بدون Node به‌عنوان پیش‌نیاز اجرای نهایی.
- بدون fallback امضای debug برای کانال انتشار.
- فایل‌های claimشدهٔ `DESKTOP-EXE-DELIVER` در این موج ویرایش نمی‌شوند.

### ۱.۵ معیارهای موفقیت قابل اندازه‌گیری
1. **Air-gap:** پس از pairing/provision + seed، قطع کامل شبکه + reboot + force-stop → ورود محلی، ثبت مشتری/پیگیری/سفارش/پیوست، گزارش محلی، حفظ داده؛ سپس reconnect بدون گم‌شدن/تکرار اثر.
2. **ماتریس فروش:** ۱۰۰٪ ردیف‌های فروش در وضعیت `done` یا `deferred-with-owner-signoff`.
3. **Parity محاسباتی:** fixtureهای مشترک (قیمت، تخفیف، VAT، گردکردن، qty اعشاری، variant) روی Node مرجع و Kotlin نتیجهٔ بایتی/عددی یکسان.
4. **Interop:** اسناد پذیرفته‌شده روی وب/دسکتاپ دیده می‌شوند؛ `test-sync.js` مرکزی بدون رگرسیون قرارداد.
5. **Update:** ارتقا روی نصب قبلی با outbox پر؛ امضای نادرست رد؛ بدون wipe پیش‌نویس.

---

## ۲) فاصله با واقعیت امروز (شکاف محصول)

| واقعیت کد فعلی (`android/`) | حکم مأموریت جدید |
|---|---|
| `MainActivity` = WebView → `http://127.0.0.1:3210/` | **رد** به‌عنوان محصول نهایی |
| runtime = nodejs-mobile + کل `server/` embedded | **رد** به‌عنوان پیش‌نیاز نهایی؛ منطق قابل استخراج برای fixture |
| UI = همان وب RTL داخل WebView | باید Compose بومی |
| DB = SQLite بهتر-sqlite3 داخل Node | باید SQLite متعلق به اپ بومی (Room/SQLDelight + بررسی SQLCipher) |
| sync = همان موتور Node دستگاه | کلاینت Kotlin باید **همان wire protocol** را بزند |
| `minSdk 24`, `targetSdk 34`, `compileSdk 36`, `versionCode 35` / `2.0.33` | مبنا؛ تغییر فقط با ADR |
| ABI: arm64-v8a, armeabi-v7a, x86_64 + libnode | بومی: حذف libnode؛ native فقط در صورت SQLCipher/crypto |
| release بدون keystore → **debug sign fallback** | **ممنوع** برای کانال انتشار |
| `useLegacyPackaging true` برای JNI node | با حذف Node، سیاست ۱۶KB صفحه بازبینی می‌شود |

**شواهد:** `android/app/src/main/java/ir/taranom/crm/MainActivity.java`, `android/app/build.gradle`, `android/BUILD.md`.

---

## ۳) زمینه سیستم (C4 L1)

```
┌──────────────┐   UI بومی Compose    ┌─────────────────────────────────────┐
│ فروشنده     │ ───────────────────▶ │  ERP Taranom Sales (Android)        │
└──────────────┘                      │  ├─ Presentation (Compose RTL)      │
                                      │  ├─ Application (use-cases فروش)    │
                                      │  ├─ Domain (Kotlin + parity)        │
                                      │  ├─ Local SQLite + files            │
                                      │  ├─ SecureStore (Keystore)          │
                                      │  ├─ Outbox + SyncEngine             │
                                      │  ├─ WorkManager Sync / Update       │
                                      │  └─ Crash/Recovery + Backup export  │
                                      └───────────────┬─────────────────────┘
                           فقط وقتی آنلاین            │
                    ┌─────────────────────────────────┼──────────────┐
                    ▼                                 ▼              │
           ┌────────────────┐               ┌─────────────────┐      │
           │ مرکز ایران     │               │ Update feed HTTPS│      │
           │ sync push/pull │               │ (امضا+checksum)  │      │
           └───────┬────────┘               └─────────────────┘      │
                   │ همان قرارداد                                      │
           ┌───────┴────────┐                                         │
           │ Desktop / Web  │                                         │
           └────────────────┘                                         │
```

**مرز اعتماد:** sandbox اپ + Keystore دستگاه. مرکز = حقیقت سازمانی برای دادهٔ پذیرفته‌شده. هویت دستگاه ≠ هویت کاربر. مدیر محلی روی گوشی مجوز مرکز نمی‌گیرد.

---

## ۴) انتخاب فناوری — ADR-AND-001

### ۴.۱ گزینه‌های بررسی‌شده

| گزینه | UI بومی RTL | DB تراکنشی | بدون Node | همخوانی Now in Android | ریسک |
|---|---|---|---|---|---|
| **Kotlin + Compose + Room/SQLDelight** | عالی | عالی | بله | مستقیم | پورت منطق |
| Flutter | خوب | خوب | بله | ضعیف‌تر در اکوسیستم فعلی تیم | دو stack |
| React Native / Capacitor | متوسط | متوسط | بله | — | خطر WebView-ish |
| نگه داشتن nodejs-mobile + «native shell» | خیر (UI وب) | بله داخل Node | **خیر** | — | **رد مأموریت** |
| Kotlin UI + Node sidecar اجباری | بله | دو منبع | **خیر نهایی** | — | فقط پل مهاجرت کوتاه |

### ۴.۲ تصمیم (پیشنهاد قفل با تأیید مالک)

**Primary:**
- **زبان/UI:** Kotlin، Jetpack Compose، Navigation، Material 3 با تم فارسی/RTL.
- **معماری ماژولار:** الگوی Now in Android (app / core / feature / sync) بدون کپی کور پروژهٔ نمونه.
- **DB:** SQLDelight یا Room روی SQLite؛ migrations نسخه‌دار. **SQLCipher فقط پس از** ADR جدا برای binding، migration، و مدیریت کلید Keystore (هنوز انتخاب نشده — بررسی اجباری قبل از GA).
- **دامنه (ADR-AND-003 — قفل پیشنهادی):** موتور فعلی sync = **بازپخش HTTP روی هندلرهای واقعی Express**. کلاینت Room بدون موتور دامنه نمی‌تواند همان اثر آفلاین (JE/موجودی/شماره موقت) را بسازد مگر یکی از این‌ها:
  1. **گزینه A (هدف مأموریت):** پورت منطق فروش به Kotlin Domain + ثبت outbox با همان شکل `{method,path,body,user_id,base_version,replay_proof,…}`؛ مرکز همچنان از طریق هندلرهای Express بازپخش می‌کند. برابری فقط با **golden parity fixtures** پذیرفته است.
  2. **گزینه B (موقت مهاجرت، غیرنهایی):** Domain Host محلی بدون UI وب — صریحاً خلاف «Node پیش‌نیاز محصول نهایی» است و فقط اگر مالک پل کوتاه بخواهد؛ محصول GA باید به A برسد.
  3. **گزینه C (رد):** صف آنلاین‌only برای نوشتن مالی — استقلال آفلاین مأموریت را نقض می‌کند.
- **Sync:** کلاینت Kotlin سازگار با `docs/OFFLINE-SYNC.md` (headers Device+HMAC+nonce، Ed25519 `replay_proof` با `stableJson` بایتی‌یکسان، push/pull، provisional IDs یخ‌زده، files multipart).
- **پس‌زمینه:** WorkManager + محدودیت‌های Doze مستند؛ بدون تضمین اجرا پس از force-stop.
- **DI:** Hilt یا Koin (انتخاب در اسکلت؛ ترجیح Hilt هم‌راستا با Now in Android).

**Compose/Kotlin (مرجع رسمی، حدس زده نشده):**
- برای Kotlin **2.0+** از **Compose Compiler Gradle Plugin** استفاده شود (صفحهٔ رسمی Compose–Kotlin compatibility، به‌روز ۲۰۲۵-۱۰-۲۹).
- اگر تیم موقتاً روی Kotlin 1.9.x بماند: جفت سازگار رسمی مثلاً Compose Compiler **1.5.15** ↔ Kotlin **1.9.25**.

**SDK (از کد فعلی + سیاست):**
- `minSdk = 24` (حفظ مگر ADR خلاف).
- `targetSdk` / `compileSdk`: از ۳۴/۳۶ فعلی؛ ارتقا به ۳۵+ فقط با چک‌لیست ۱۶KB و رفتار مجوزها.
- ABI هدف محصول بومی: `arm64-v8a` الزامی؛ `armeabi-v7a` تا وقتی فروشندگان روی ۳۲بیت دارند؛ `x86_64` برای امولاتور.

**۱۶KB page size (مرجع رسمی Android Developers):**
- هر `.so` (از جمله SQLCipher/crypto) باید با alignment ۱۶KB ساخته/تأمین شود.
- اپ فقط-Kotlin بدون native از قبل سازگار است؛ افزودن native ⇒ آزمون emulators ۱۶KB الزامی.
- Google Play از ۱ فوریه ۲۰۲۷ برای به‌روزرسانی‌های target 35+ این را اجباری می‌کند — حتی اگر کانال ما sideload باشد، همان استاندارد را رعایت می‌کنیم.

**رد صریح:** WebView-as-product، PWA داخل APK، Capacitor/Cordova، Node روی دستگاه به‌عنوان runtime نهایی، debug-sign fallback انتشار، پروتکل sync انشعابی.

### ۴.۳ پل مهاجرت از APK فعلی (nodejs-mobile)

1. نصب بومی با همان `applicationId` و امضا ⇒ ارتقا in-place.
2. Migrator یک‌بار: خواندن SQLite دستگاه قدیمی از مسیر data فعلی Node، نگاشت به schema بومی، **حفظ outbox**، صدور `device_id` جدید **ممنوع** مگر re-pair آگاهانه.
3. تا سبز شدن migrator + air-gap، APK قدیمی در `android/` باقی می‌ماند (legacy).
4. کد محصول جدید در `android-native/` (جدا) تا اسکلت پایدار شود؛ سپس جایگزینی تدریجی یا ادغام Gradle با flavor `legacy`/`native`.

---

## ۵) نقشهٔ ماژول / مالکیت داده

| ماژول | مسئولیت | مالک داده |
|---|---|---|
| `core:model` | DTO، شناسه‌ها، وضعیت سند | — |
| `core:database` | SQLite، migration، DAO تراکنشی | DB فایل اپ |
| `core:datastore` | تنظیمات غیرحساس | DataStore |
| `core:secure` | JWT محلی، device key، Keystore | Encrypted prefs / Keystore |
| `core:network` | HTTP مرکزی، timeout/backoff | — |
| `feature:auth` | pairing، ورود محلی، انقضای مجوز | sessions |
| `feature:customers` | جستجو/CRUD محدودهٔ مالک | customers* |
| `feature:crm-activity` | سرنخ، یادداشت، پیگیری، برنامهٔ روزانه، ویزیت/تماس | followups, crm_activities* |
| `feature:catalog` | کالا، تصویر، قیمت، موجودی as-of، variant | products* |
| `feature:cart-order` | سبد، پیش‌فاکتور، سفارش | orders, drafts |
| `feature:invoice` | فاکتور/برگشت در صورت مجوز نقش | invoices* |
| `feature:receipts` | وصول/رسید در صورت مجوز | settlements* |
| `feature:files` | پیوست محلی + آپلود قابل ادامه | app files dir |
| `feature:reports` | عملکرد شخصی محلی | read models |
| `feature:sync-ui` | صف، تعارض، وضعیت ارسال | sync_* |
| `sync:engine` | push/pull/files/conflict | outbox+cursor |
| `update:engine` | بررسی/دانلود/Verify/Install | update state |

`*` = زیرمجموعهٔ scoped؛ نه کل جداول ERP.

**مالکیت مشترک با سرور:** هر تغییر `server/sync/**` نیاز به claim جدا و بازبینی مستقل دارد. کلاینت بومی ابتدا مصرف‌کنندهٔ قرارداد فعلی است؛ بستن شکاف‌های اتمیسیتهٔ outbox در سمت دستگاه بومی اولویت دارد و در صورت نیاز به تغییر مرکز، تسک جدا ثبت می‌شود.

---

## ۶) مدل داده و چرخهٔ سند

### ۶.۱ وضعیت‌های عملیات/سند
`draft` → `local_committed` → `pending_push` → `accepted_central` | `needs_attention` | `rejected(reason)` → `amended` | `voided`

### ۶.۲ شناسه‌ها
- شناسهٔ پایدار محلی (UUID یا همان فرمول بازهٔ دستگاه طبق `sync/tables.js`) قبل از پذیرش مرکز.
- شمارهٔ رسمی فقط پس از replay موفق مرکز (`allocateNumber`)؛ نمایش/چاپ موقت با برچسب واضح.
- نگاشت local↔central در جدول mapping؛ برخورد ممنوع.

### ۶.۳ تراکنش
هر use-case نوشتنی: `BEGIN` → تغییر دامنه + ردیف outbox (+ فایل متا) → `COMMIT`. Kill وسط ⇒ یا همه یا هیچ؛ بدون «سند بدون outbox».

### ۶.۴ Backup / restore
- Export رمزنگاری‌شدهٔ دادهٔ حیاتی + صف.
- Restore روی دستگاه جدید: **هویت دستگاه جدید**، حذف/بازنشانی کلیدهای ارسال، dedupe idempotency، ممنوعیت replay دوبارهٔ عملیات پذیرفته‌شده.
- خروج از حساب / repair: wipe بی‌صدای pending ممنوع.

---

## ۷) فعال‌سازی و هویت

### ۷.۱ محیط سازمانی
- Pairing آنلاین (Ed25519 + token دستگاه طبق sync فعلی) **یا** بستهٔ provisioning امضاشده.
- پس از فعال‌سازی: ورود محلی با اعتبار ذخیره‌شدهٔ امن؛ بدون نیاز به پاسخ روزانهٔ سرور.

### ۷.۲ محیط محلی مستقل (در صورت تأیید A7)
- ساخت کاربر/سازمان محلی بدون دادهٔ سازمانی.
- این هویت **هرگز** خودبه‌خود به مجوز سرور تبدیل نمی‌شود.

### ۷.۳ انقضای مجوز سازمانی
- حالت‌ها جدا: `usable_offline` / `auth_expired_view_only` / `revoked_on_reconnect`.
- انقضا ≠ قفل کامل یا حذف داده.
- ابطال فوری روی دستگاه کاملاً آفلاین فرض نمی‌شود؛ در reconnect سیاست دوباره ارزیابی می‌شود.

### ۷.۴ تعویض کاربر
- صف outbox کاربر قبلی با هویت کاربر جدید ارسال نمی‌شود.
- Device identity مستقل می‌ماند.

---

## ۸) Sync (سازگاری سه‌طرفه)

### ۸.۱ ثابت‌ها (از sync gaps دسکتاپ — الزام Android هم)
- `SYNCABLE_TABLES` append-only
- outbox مرتب + idempotency + stop-at-first-failure
- replay روی هندلر واقعی مرکز
- `sync_seq` + tombstones؛ بدون LWW مالی
- شماره نهایی فقط مرکز؛ آفلاین `موقت-…`
- pairing پیش‌شرط و wire HMAC/nonce/skew + multipart فایل

### ۸.۲ شکاف‌هایی که کلاینت بومی باید از روز اول درست کند
| شکاف | الزام بومی |
|---|---|
| capture بعد از commit در موتور فعلی | write+outbox اتمیک در کلاینت بومی |
| wipe در repair/pairing | فقط با تأیید صریح UI؛ حفظ صف |
| pull روی pending | pending محلی حفظ؛ تعارض صریح |
| oversell | سهمیه یا `needs_attention`؛ نه موفقیت قطعی کاذب |
| توکن منقضی | UI: `auth_expired` ≠ «آفلاین» |

### ۸.۳ زمان‌بندی
- Foreground: شروع سریع sync هنگام شبکه معتبر.
- Background: WorkManager؛ تأخیر Doze/force-stop باعث گم‌شدن صف نمی‌شود (صف روی دیسک).

---

## ۹) امنیت

- فیلتر داده بر اساس نقش + `customer-scope` (`user_id` / `assigned_to`) — مخفی‌کردن منو کافی نیست.
- بدون اسرار مرکز، API key همهٔ کاربران، یا JWT دیگران روی گوشی.
- Keystore برای کلیدهای دستگاه؛ DB/پیوست/backup حساس با مدیریت کلید واقعی (جزئیات در ADR-AND-002 قبل از GA).
- لاگ بدون رمز/token.
- Permissionها runtime و فقط هنگام نیاز (دوربین، اعلان، خواندن تصویر).
- اعتبارسنجی فایل/لینک ورودی.
- Exclude از backup سیستم‌عامل برای اسرار/device identity (یا encrypted backup کنترل‌شده).
- Replay با هویت ثبت‌کنندهٔ اصلی.

---

## ۱۰) Updater (جدا از sync داده)

- کانال‌ها: (۱) APK مستقیم، (۲) MDM/Android Enterprise، (۳) Play اختیاری بعدی.
- دانلود resumable؛ verify: signature، packageName، versionCode، ABI/SDK.
- همان signing identity؛ بدون debug fallback انتشار؛ نبود کلید release ⇒ fail build کانال release.
- اعمال در safe-point (نه وسط تراکنش دامنه).
- حفظ draft/DB/outbox؛ migration سازگار با pending.
- خرابی سرور update ⇒ اجرای محلی ادامه دارد.
- نصب بی‌صدای عمومی روی گوشی شخصی تضمین نمی‌شود؛ فقط حذف تأییدهای غیرضروری داخل اپ + مسیر رسمی MDM.
- Rollback: APK اصلاحی با versionCode بالاتر + مسیر بازیابی داده؛ downgrade عمومی ممنوع.

مراجع رسمی: `PackageInstaller.SessionParams`، راهنمای dedicated devices / DPC.

---

## ۱۱) UI حرفه‌ای موبایل (الزام محصول)

- فارسی + RTL کامل؛ فونت داخل APK (نه CDN).
- فرم یک‌دستی؛ جستجوی محلی؛ لیست روان (paging).
- ورودی مبلغ/qty/تلفن؛ ارقام فارسی/اعشار صحیح.
- پیش‌نویس پایدار در برابر تماس/چرخش/کشتن فرایند.
- Font scale / a11y؛ وضعیت ذخیره محلی و sync قابل مشاهده؛ خطای قابل اقدام.
- بدون وابستگی اجباری به Google Play Services برای مسیر اصلی.

---

## ۱۲) آزمون و تحویل

### ۱۲.۱ Air-gap (تعیین‌کننده)
مطابق بند ۱۵ مأموریت مالک — چک‌لیست PASS/FAIL امضا می‌شود.

### ۱۲.۲ Parity
Runner: ورودی یکسان → خروجی Node (`vat.js`/`sales-document`/…) vs Kotlin.

### ۱۲.۳ ماتریس دستگاه (حداقل برنامه‌ریزی)
| رده | مثال | وضعیت |
|---|---|---|
| minSdk نزدیک | API 24–28 | باید آزمون شود |
| میانی | API 29–33 | باید |
| جدید پایدار | API 34–35 + ۱۶KB emulator | باید |
| OEM | Samsung، Xiaomi در صورت دسترسی | باید در صورت سخت‌افزار |
| بدون GMS / کم‌حافظه | امولاتور AOSP | باید |
| آزموده‌نشده | صریحاً در گزارش «not tested» | الزام |

سناریوها: reboot، kill، force-stop، battery saver، تغییر شبکه، کمبود فضا، ارتقا با outbox پر، امضای غلط، کاربر لغو، oversell، قطع پس از commit مرکز، bootstrap طولانی، restore بدون تکثیر اثر.

### ۱۲.۴ ابزار پیشنهادی (پس از بررسی مجوز/نیاز)
- معماری مرجع: Now in Android (نه جایگزینی ERP).
- UI flow: Maestro در صورت پذیرش.
- شبکه خصمانه: Toxiproxy در برابر مرکز تست.
- SQLCipher: فقط پس از ADR-AND-002.

### ۱۲.۵ بازبینی مستقل
High-risk: Reviewer و Security جدا از Implementer برای sync، migration، updater، crypto.

---

## ۱۳) ترتیب اجرا (فازبندی)

| فاز | خروجی | معیار خروج |
|---|---|---|
| **0** | این ADR + ماتریس فروش + claim + اسکلت `android-native/` | مالک ADR-AND-001 را تأیید کند |
| **1** | برش عمودی: مشتری → سفارش → محاسبه → outbox → sync → مشاهده در وب | air-gap slice PASS + parity قیمت/جمع |
| **2** | پیگیری/ویزیت/کاتالوگ/تصاویر/پیش‌نویس | ماتریس CRM+catalog |
| **3** | فاکتور/برگشت/وصول بر اساس RBAC | parity VAT + R13 مسیرهای مجاز |
| **4** | گزارش شخصی، تعارض UX، backup/restore امن | آزمون‌های §۱۲ |
| **5** | Migrator از nodejs-mobile + updater امضا + بازنشستگی WebView APK | ارتقا بدون uninstall |

جزئیات موج‌ها: [`NATIVE-ANDROID-PHASE-PLAN.md`](./NATIVE-ANDROID-PHASE-PLAN.md)  
ماتریس قابلیت: [`NATIVE-ANDROID-SALES-MATRIX.md`](./NATIVE-ANDROID-SALES-MATRIX.md)

---

## ۱۴) تصمیم‌های نیازمند تأیید مالک

1. تأیید ADR-AND-001 (Compose + Kotlin Domain، بدون Node نهایی).
2. تأیید **ADR-AND-003 گزینه A**: پورت دامنه فروش به Kotlin + outbox هم‌شکل wire فعلی (نه Node Host نهایی، نه صف آنلاین‌only).
3. حفظ `applicationId` `ir.taranom.crm` برای ارتقا in-place؟ (الزام مهاجرت: همان Keystore alias JWT + مسیر `crm-data/crm.db`).
4. سیاست موجودی آفلاین: فقط provisional+تعارض vs سهمیه تخصیصی ضد-کپی.
5. محیط محلی کاملاً جدا (A7) در v1؟
6. SQLCipher در v1 یا رمزنگاری فایل+Keystore بدون SQLCipher؟
7. چرخش keystore (افشای تاریخی) قبل از GA بومی؟ بدون کلید فعلی versionCode 35 هر ارتقا ⇒ uninstall و از دست رفتن داده.
8. مسیر pairing فروشنده: امروز `POST /api/sync/pair` admin-only است — provisioning امضاشده یا نقش pair گسترده‌تر؟
9. تسک جدا برای capture صریح `/api/reps/:id/calls|visits` (قبل از اتکای تعارض موبایل).
10. مجوز ویرایش رجیستری AI-DOS پس از آزادسازی `DESKTOP-EXE-DELIVER`.

---

## ۱۵) مسدودکننده‌ها و کارهای مستقل قابل ادامه

| مورد | وضعیت |
|---|---|
| سند معماری Wave 0 | در حال تکمیل در این شاخه |
| Slack تصمیم موبایل | جستجو بدون نتیجهٔ مرتبط |
| Keystore محلی | `android/keystore.properties` + `erp-taranom.jks` روی ماشین توسعه دیده شد — **اسرار commit نمی‌شوند**؛ صحت/چرخش باید ops تأیید کند |
| رجیستری AI-DOS مشترک | قفل claim دسکتاپ — ثبت در `NATIVE-ANDROID-TASK-CLAIM.md` |
| دستگاه فیزیکی Samsung/Xiaomi | نامشخص تا فراهمی |
| انتشار Iran/Play | خارج از مجوز فعلی |

کارهای مستقل بدون انتشار: اسکلت `android-native/`، fixture parity، ماتریس، تست‌های واحد دامنه، طراحی migrator.

---

## ۱۶) پیوست — هم‌ترازی با دسکتاپ بومی

| موضوع | Windows ADR | Android ADR |
|---|---|---|
| UI محصول | WPF | Compose |
| Domain نهایی | Node Host فازبندی یا C# | Kotlin domain (بدون Node نهایی) |
| Sync protocol | مشترک | مشترک |
| دامنه محصول | کل ERP محلی | فقط فروش |
| Secret store | DPAPI | Android Keystore |
| Update | Velopack/NSIS | PackageInstaller / MDM / Play |

منبع هم‌ترازی sync: یافته‌های اکتشاف [Read native desktop ADR](4e2e971f-7408-43c8-93c1-91b720afe781).

پیوست شواهد کد: [NATIVE-ANDROID-EVIDENCE.md](./NATIVE-ANDROID-EVIDENCE.md).

