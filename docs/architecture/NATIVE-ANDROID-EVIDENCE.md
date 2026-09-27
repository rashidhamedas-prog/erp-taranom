# پیوست شواهد اکتشاف — Android بومی

> الحاق به [`NATIVE-ANDROID-SALES-ARCHITECTURE.md`](./NATIVE-ANDROID-SALES-ARCHITECTURE.md)  
> منابع: ایجنت‌های [Explore Android WebView stack](c15d714b-a6ab-4a89-b614-d9563b34ba9a)، [Explore sync offline engine](4515b9ac-f714-435f-9925-0211b0b78f3b)، [Map sales CRM capabilities](27ba5e0a-86f6-4b6c-94f3-529c7c423c62)، [Read native desktop ADR](4e2e971f-7408-43c8-93c1-91b720afe781)

## A) واقعیت APK فعلی (باید جایگزین شود)

- SDK: `compileSdk 36`, `minSdk 24`, `targetSdk 34`, `versionCode 35`, `versionName 2.0.33`
- AGP `8.5.2`, Gradle `8.7`, NDK `25.1.8937393`, Java 17
- **`android.useAndroidX=false`** در `android/gradle.properties` ⇒ ماژول بومی **نباید** داخل همان پرچجکت بدون تغییر این پرچم ساخته شود؛ مسیر `android-native/` با AndroidX جدا ترجیح دارد
- UI امروز: WebView → `http://127.0.0.1:3210/` + nodejs-mobile
- داده: `/data/data/ir.taranom.crm/files/crm-data/{crm.db,uploads,tmp}`
- JWT: Keystore alias `erp_taranom_jwt_aes_gcm_v1` + prefs `secure_secret_store_v1`
- sync secrets در `sync_local_kv` با envelope `enc:v1:` (HKDF از JWT_SECRET)
- Update hosts: `erp.poshaktaranom.com`, `poshaktaranom.com`؛ verify SHA-256 + signer + versionCode
- Release بدون keystore ⇒ debug sign (ممنوع برای کانال انتشار بومی)
- REUSE: applicationId، crm.db schema/data، SecureSecretStore semantics، network_security_config، verify APK
- DELETE در محصول نهایی: WebView MainActivity، libnode، assets/nodejs-project، native-lib، copyServerSources tasks

## B) قرارداد Sync (باید عیناً پیاده شود)

- `POST /api/sync/pair|push` · `GET /api/sync/pull|row|files` · `POST /api/sync/replay-multipart`
- Headers: `Authorization: Device <id>:<token>` + `x-sync-time` (±300s) + `x-sync-nonce` + `x-sync-signature` HMAC
- `replay_proof` Ed25519 per-op؛ کلید خصوصی هرگز از دستگاه خارج نمی‌شود
- Idempotency: `"<device_id>:<outbox_seq>"` · stop at first conflict/defer
- Provisional IDs: `PROVISIONAL_FLOOR=1e12`, `DEVICE_SPAN=1e8`, `TABLE_SPAN=1e6`, overflow `1.01e13` — **یخ‌زده**
- Outbox statuses: `pending|confirmed|conflict|discarded`
- Conflict: human discard محلی؛ نه LWW مالی
- Pull: `INSERT OR REPLACE` مرکزی (کلاینت بومی باید pending محلی را محافظت کند — شکاف شناخته‌شده)
- Tests: `test-sync.js` = **44** ok؛ `test-sms.js` = **23** check؛ diag mismatches=[]

**نکته pairing:** اکتشاف sync می‌گوید `POST /api/sync/pair` فعلاً برای نقش admin است — برای فروشندگان میدانی باید مسیر provisioning/ادمین یا تغییر قرارداد با claim سرور جدا تأیید شود (تصمیم مالک).

## C) شکاف‌های دامنه فروش برای موبایل

- سبد marketer در `localStorage` — بومی باید DB محلی پایدار (`marketer_carts` یا جدول draft)
- `POST /api/reps/:id/visits|calls` فاقد نگاشت capture صریح — قبل از اتکای تعارض، claim sync لازم
- `marketer` نقش RBAC نیست؛ attribute است
- `sales_manager` scope شخصی (نه کل تیم) مگر خلاف کد جدید
- اختلاف UI/سرور در تخفیف مبلغ vs درصد (`marketer-ui.js` vs server) — parity باید سمت سرور را مرجع بگیرد
- دریافت میدانی اغلب pending تا تأیید حسابداری
- `/orders` حذف فیزیکی با R13 ناسازگار — موبایل باید void/cancel داشته باشد نه delete خام

## D) Slack

جستجوی workspace برای Android/native/فروشنده مرتبط نتیجه‌ای نداشت — تصمیم‌ها فقط از کد و این ADR.

## E) پیام معماری از اکتشاف sync (حیاتی)

موتور فعلی فرض می‌کند دستگاه **همان Express** را محلی اجرا می‌کند تا capture از نتیجهٔ هندلر واقعی ساخته شود. کلاینت Kotlin خالص باید:

1. منطق فروش را در Domain خودش اجرا کند (گزینه A)،
2. outbox را با شکل wire فعلی پر کند (path/method/body/`replay_proof`) تا مرکز همان هندلر را بازپخش کند،
3. `captured_rows_json` / `base_version` / provisional ids را صریحاً تولید کند (دیگر diff روی `sqlite_sequence` Node نیست)،
4. migrator: باز کردن `files/crm-data/crm.db` + حفظ Keystore alias `erp_taranom_jwt_aes_gcm_v1` و AAD `<pkg>:jwt:v1`.

بدون A، یا Node باقی می‌ماند (خلاف مأموریت) یا نوشتن مالی آفلاین واقعی نیست.

## F) تصحیح ماتریس فروش (از اکتشاف CRM)

- FS/IS: فقط پیش‌فاکتور؛ فاکتور قطعی/تبدیل = SM (یا بالاتر).
- دریافت میدانی = pending تا تأیید admin/accounting.
- سبد باید از روز اول در DB باشد (نه localStorage).
- اختلاف تخفیف `marketer-ui.js` vs `buildRows`: مرجع parity = سرور.
- قبل از اتکا به تعارض تماس/ویزیت: تسک جدا برای `PATH_TABLE_MAP` روی `/api/reps/:id/calls|visits`.
