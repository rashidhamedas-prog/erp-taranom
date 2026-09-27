# اپلیکیشن بومی فروش — Android (`android-native/`)

> **این محصول نهایی اندروید است.** پوشهٔ `android/` نسخهٔ legacy است: WebView روی
> `http://127.0.0.1:3210` با nodejs-mobile، و تا سبز شدن مسیر مهاجرت (فاز ۵)
> **حذف نمی‌شود**. کد جدید فقط اینجا نوشته می‌شود.
>
> معماری مرجع: [`docs/architecture/NATIVE-ANDROID-SALES-ARCHITECTURE.md`](../docs/architecture/NATIVE-ANDROID-SALES-ARCHITECTURE.md)
> · شواهد: [`NATIVE-ANDROID-EVIDENCE.md`](../docs/architecture/NATIVE-ANDROID-EVIDENCE.md)
> · قرارداد sync: [`docs/OFFLINE-SYNC.md`](../docs/OFFLINE-SYNC.md)

وضعیت فعلی: **اسکلت فاز ۰** — ناوبری و ماژول‌ها سرجایشان هستند، منطق فروش در
موج‌های بعد پر می‌شود.

## چرا WebView نیست

| legacy (`android/`) | این پروژه |
|---|---|
| `MainActivity` = WebView → localhost | تنها Activity، رابط کامل Jetpack Compose |
| runtime = nodejs-mobile + کل `server/` داخل APK | فقط Kotlin؛ هیچ Node/Express روی دستگاه |
| DB = better-sqlite3 داخل Node | Room/SQLite متعلق به خود اپ |
| `android.useAndroidX=false` | AndroidX فعال |
| UI وب RTL داخل WebView | Compose + Material 3 با RTL اجباری |

هیچ WebViewای در مسیرهای اصلی فروش وجود ندارد و اضافه نمی‌شود (ADR-AND-001 §۱.۲).

## ساختار ماژول‌ها

```
android-native/
├── app/                 اپ Compose (تنها ماژول اندرویدیِ اجراشدنی)
├── core/model/          مدل دامنه + ثابت‌های شناسهٔ provisional (Kotlin خالص)
├── core/domain/         محاسبات فروش + fixtureهای parity   (Kotlin خالص)
├── core/database/       Room: customers / sales_drafts / outbox_ops
└── sync/api/            قرارداد SyncClient + DeviceCredentials (بدون HTTP)
```

`core:model`، `core:domain` و `sync:api` عمداً **Kotlin خالص** (JVM) هستند تا
تست‌های دامنه بدون Android SDK و شبیه‌ساز اجرا شوند.

## نسخه‌های قفل‌شده

همه در [`gradle/libs.versions.toml`](gradle/libs.versions.toml) پین شده‌اند (هیچ
رنج دینامیکی):

| مورد | نسخه |
|---|---|
| Gradle | 8.9 |
| AGP | 8.7.3 |
| Kotlin | 2.0.21 |
| Compose Compiler | پلاگین `org.jetbrains.kotlin.plugin.compose` 2.0.21 |
| Compose BOM | 2024.10.01 |
| KSP | 2.0.21-1.0.25 |
| Room | 2.6.1 |
| Navigation Compose | 2.8.4 |
| Lifecycle | 2.8.7 |
| JDK / jvmTarget | 17 |

SDK (هم‌تراز شواهد legacy): `minSdk 24` · `targetSdk 34` · `compileSdk 36`.
چون AGP 8.7.x رسماً compileSdk 36 را اعلام نمی‌کند،
`android.suppressUnsupportedCompileSdk=36` در `gradle.properties` هست — با
ارتقای AGP آن خط حذف شود.

Kotlin 2.x است، پس Compose Compiler به‌صورت **Gradle Plugin** اضافه شده (نه
`composeOptions.kotlinCompilerExtensionVersion`).

## applicationId

| buildType | applicationId | دلیل |
|---|---|---|
| `release` | `ir.taranom.crm` | همان id و همان زنجیرهٔ امضای legacy ⇒ ارتقای in-place بدون uninstall و بدون از دست رفتن داده (ADR فرض A3) |
| `debug` | `ir.taranom.crm.native.debug` | نصب کنار به کنار با APK قدیمی در طول توسعه |

`versionCode` بومی از `100` شروع می‌شود (legacy روی `35` است) تا مسیر ارتقا در
فاز ۵ باز باشد.

## ساخت

```powershell
# پیش‌نیاز: Android SDK + JDK 17. یکی از این دو:
#   ANDROID_HOME / ANDROID_SDK_ROOT تنظیم باشد،
#   یا android-native/local.properties با sdk.dir=... ساخته شود (در .gitignore).

cd android-native

.\gradlew :core:domain:test        # تست‌های parity — بدون نیاز به Android SDK
.\gradlew :app:assembleDebug       # APK دیباگ (side-by-side با legacy)
.\gradlew :app:assembleRelease     # بدون keystore ⇒ عمداً fail می‌شود
```

طبق قانون پروژه، بیلد کامل APK فقط با درخواست صریح مالک انجام می‌شود
(`.cursor/rules/no-full-platform-builds.mdc`).

## امضا — هیچ fallback دیباگی نیست

پروژهٔ legacy اگر keystore نداشت، release را با کلید debug امضا می‌کرد. اینجا
**ممنوع** است: `:app:assembleRelease` / `bundleRelease` در نبود کلید با خطای
صریح متوقف می‌شود، نه با APK بی‌امضا و نه با امضای debug (ADR §۴.۲ و §۱۰).

کلید از یکی از این دو منبع خوانده می‌شود:

1. `android-native/keystore.properties` — الگو در `keystore.properties.example`
2. متغیرهای محیطی `CRM_KEYSTORE_FILE`، `CRM_KEYSTORE_PASSWORD`،
   `CRM_KEY_ALIAS`، `CRM_KEY_PASSWORD`

**هیچ رازی در این مخزن نیست و نباید بیاید**: `keystore.properties`، `*.jks`،
`*.keystore` و `local.properties` در `.gitignore` هستند. کلید روی ماشین اپراتور
می‌ماند.

## Parity با سرور (مهم)

سرور مرجع محاسبات مالی است. `core:domain` پورت مستقیم این دو فایل است:

- `server/lib/round3.js` → `Round3.kt` (`round3` / `parseQty` / `fmtQty`)
- `server/lib/vat.js` → `VatCalculator.kt` (`getVatRate` / `lineVatExempt` / `calcDocTotals`)

قاعدهٔ پول: **مبلغ همیشه ریال صحیح (Long)**؛ فقط qty اعشاری ۳ رقمی است.

نکتهٔ ظریفی که در تست قفل شده: `kotlin.math.round` در حالت تساوی به عدد زوج گرد
می‌کند، ولی `Math.round` جاوااسکریپت به سمت `+∞`. مثال واقعی: مالیات ۱۰٪ روی
۱۰۵ ریال = ۱۰٫۵ ⇒ سرور ۱۱ می‌دهد و ties-to-even ۱۰. به همین دلیل `JsMath.round`
نوشته شده و همه‌جا از آن استفاده می‌شود.

مقادیر انتظاری تست‌ها با **اجرای واقعی همان فایل‌های Node** تولید شده‌اند، نه با
محاسبهٔ دستی. اگر سرور عوض شد، fixtureها باید با اجرای مجدد به‌روز شوند:

```powershell
.\gradlew :core:domain:test
```

## دیتابیس محلی

`taranom-sales.db` (نسخهٔ اسکیما ۱) — منبع حقیقت دستگاه، **نه cache**.

- `customers`, `sales_drafts`, `outbox_ops`
- `fallbackToDestructiveMigration` **هرگز**: پاک‌شدن دیتابیس یعنی از دست رفتن
  صف `pending`، یعنی سندی که فروشنده ثبت کرده و مرکز هنوز ندیده.
- نوشتن دامنه + درج ردیف outbox در **یک تراکنش** (`insertWithOutbox`) — همان
  شکاف capture-after-commit موتور Node که نباید تکرار شود.
- شناسه‌های محلی از فرمول یخ‌زدهٔ `server/sync/tables.js` می‌آیند
  (`ProvisionalIds`): `1e12 + device_id×1e8 + table_index×1e6`.
- مسیر legacy (`files/crm-data/crm.db`) دست‌نخورده می‌ماند تا migrator فاز ۵
  بتواند از آن بخواند.

## کارهای باز (فاز ۰ عمداً انجام نداده)

- فونت وزیرمتن داخل APK (فعلاً فونت سیستم) — ADR §۱۱
- Hilt به‌جای `TaranomDatabaseProvider` — ADR §۴.۲
- جدول `sales_draft_lines` + migration نسخهٔ ۲
- `sync:impl` (HTTP واقعی) — فعلاً `UnpairedSyncClient` هر تماس را رد می‌کند
- ورود محلی واقعی با Keystore؛ صفحهٔ فعلی فقط اسکلت فرم است
- آیکون برند (فعلاً وکتور موقت، بدون فایل باینری در گیت)
- SQLCipher: فقط پس از ADR-AND-002
- `POST /api/sync/pair` امروز admin-only است؛ مسیر فروشندهٔ میدانی تصمیم مالک
  است (ADR §۱۴ بند ۸)
