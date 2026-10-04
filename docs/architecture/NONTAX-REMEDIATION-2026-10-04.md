# NONTAX Remediation — بسته‌های غیرمالیاتی (۱۴۰۵/۰۷/۱۲ — 2026-10-04)

> شاخه: `ai/NONTAX-P1-web-docs` · worktree: `D:/proje/erp-taranom-nontax-web` · پایه: `6cef626`
> نقش: Implementer (بستهٔ ۱۰ کد + مستندسازی بسته‌های ۳ و ۱۱–۱۶)
> محدودهٔ غیرقابل‌عبور: **بدون deploy، بدون push، بدون SSH، بدون دسترسی به DB زندهٔ ایران، بدون تغییر مالیات.**

## 0. خلاصهٔ اجرایی / Executive Summary

- فقط **بستهٔ ۱۰ (هویت کالا در سایت)** در این نوبت کد خورد: مسیر «سبز کاذب» در `server/lib/website-stock-sync.js` بسته شد. از این پس اگر حتی یک ردیف فعال و قابل‌فروش (رنگ×سایز) در سایت بدون هم‌خوانی بماند، نتیجهٔ همگام‌سازی **موفق نیست** (`ok:false`، ردیف صف `error` نه `done`) و تعداد ردیف‌های بدون هم‌خوانی، تا ۵ نمونه و یک پیام فارسی قابل‌اقدام برمی‌گردد.
- بسته‌های **۳، ۱۱، ۱۲، ۱۳، ۱۴، ۱۵، ۱۶** عمداً **معوق** ماندند؛ دلیل هر کدام، شواهد تأییدشده و گام بعد در ماتریس §1 و بخش‌های §3–§9 آمده است.
- هیچ فایل مدعی‌شده (claimed) ویرایش نشد. فهرست ادعاهایی که برنامه را مسدود کردند در §10.
- فهرست صریح موارد مالیاتی که دست نخورده‌اند در §11.

## 1. ماتریس بسته‌ها / Package Matrix

| بسته | عنوان | وضعیت این نوبت | شواهد تأییدشده (در این worktree، `6cef626`) | اقدام انجام‌شده | مسدودکننده / مالک | گام بعد |
|---|---|---|---|---|---|---|
| **3** | BOM capture (سینک تخصیص مواد و واریانت‌های مجاز) | **BLOCKED — معوق** | `server/sync/capture.js` خط ۱۲۰: `['/api/production/boms', 'bom_headers']`؛ خطوط ۱۷۸–۱۷۹ فقط `/operations` → `bom_operations` و `/outputs` → `bom_outputs` را جدا می‌کنند. برای `/assignments` و `/allowed-variants` هیچ شاخه‌ای نیست → با پیشوند عمومی به `bom_headers` می‌افتند. | فقط مستندسازی (§3) | فایل در ادعای `ANDROID-NATIVE-SALES` | مالک capture.js وصلهٔ §3 را قبل از پیشوند عمومی درج کند |
| **10** | هویت کالا در سایت (SKU match / false-green) | **✅ کد زده شد (code-only)** | `pushMatrixToSite` با HTTP 2xx `ok:true` می‌داد حتی با `unmatched` پر؛ drain ردیف را `done` و `results.push({ok:true, unmatched})` می‌کرد؛ مسیر settle هم `ok:true, settled:'product_sku_not_found'` می‌داد. | `classifyMatrixPushResult()` خالص + سیم‌کشی در push/drain/dry-run + تست `test-nontax-website-sku.js` (۵۱/۰) | — (فایل بدون ادعا) | deploy فقط با تأیید مالک؛ بازاندازه‌گیری زنده انجام نشد (§2.6) |
| **11** | CRM service cases (پرونده‌های خدمات) | **معوق** | نیاز به جدول جدید در `server/db.js` + UI در `server/public/app.js` — هر دو claimed | هیچ (بدون nav خالی) | `PROD-ACC-PA02` (db.js, app.js) | پس از آزادشدن ادعا: اسکیما + append به tables.js + UI + Help در یک کامیت |
| **12** | ترجیحات ارتباطی مشتری (opt-out) | **معوق** | `server/routes/customers.js` خطوط ۱۵۶–۱۵۸: پس از ساخت مشتری، اگر `phone` باشد و `!isDevice()` → `sendWelcomeSMSToCust` (غیرمسدودکننده، فقط مرکز). خط ۱۶۲ نیز `dispatchSmsEvent('customer.created')`. مدل opt-out **وجود ندارد** و در این نوبت هم اضافه نشد. | هیچ؛ سیاست SMS تغییر نکرد | `PROD-ACC-PA02` (db.js, app.js) | طراحی فیلد/جدول ترجیحات + احترام در `sms-dispatch` + UI؛ تصمیم محصولی لازم |
| **13** | Lead / B2B / Campaign | **معوق** | وابسته به رفع نقص‌های P0 (سینک/ATP در شاخه‌های `NONTAX-P0-*`) و فایل‌های claimed | هیچ (بدون nav خالی) | ترتیب اولویت P0 + `PROD-ACC-PA02` | بعد از فرود P0 و آزادشدن app.js/db.js |
| **14** | Native GA (Android بومی + دسکتاپ بومی/Electron) | **معوق — فقط خلاصهٔ گیت‌ها** | `docs/architecture/NATIVE-ANDROID-DELIVERY-STATUS.md`، `docs/native/GA-STATUS.md`، `docs/DESKTOP-EXE-DELIVERY.md` خوانده شد (§6) | هیچ بیلدی ساخته نشد | محیط (SDK/keystore)، Reviewer + Security مستقل، تأیید صریح مالک برای انتشار باینری | این سند **اجازهٔ انتشار هیچ باینری‌ای را نمی‌دهد** |
| **15** | چندشرکتی (Multi-company) | **ADR — Proposed** | `server/lib/company-switch-guard.js`: شمارندهٔ process-global `activeRequests` + پرچم `switching`؛ `requestGuard` → 503 `COMPANY_SWITCH_IN_PROGRESS`؛ `beginCompanySwitch` → 409 `COMPANY_SWITCH_BUSY`. `routes/companies.js#activateCompanySafely`: `reopenDatabase(dbPath)+initDB()` روی handle سراسری. | فقط ADR (§7)؛ بدون refactor | مالک باید ADR را بپذیرد | پیش از هر کد: پاسخ به پرسش‌های باز §7.4 |
| **16** | شکستن `app.js` فرانت‌اند | **معوق** | `server/public/app.js` claimed؛ ریسک فقط نگه‌داری‌پذیری است، نه نقص عملکردی | هیچ | `PROD-ACC-PA02` | طرح split در ADR جدا پس از آزادشدن ادعا |

## 2. بستهٔ ۱۰ — هویت کالا در سایت / Package 10: Website SKU Identity

### 2.1 ریشهٔ مشکل / Root cause

در `server/lib/website-stock-sync.js` (قبل از این کامیت):

1. `pushMatrixToSite`: `ok = res.status >= 200 && res.status < 300` — یعنی پاسخ ۲۰۰ سایت حتی با آرایهٔ `unmatched` پر، «موفق» گزارش می‌شد.
2. `drainWebsiteStockOutbox`: `if (push.ok || push.skipped)` → ردیف `status='done'` و `results.push({ ok: true, unmatched: push.unmatched })` — همان «`ok: true` کنار `unmatched`».
3. مسیر settle (`rowHasUnmappedProductSku`): ردیفی که سایت قبلاً برایش `product_sku_not_found` داده بود، بدون ارسال مجدد `done` و `ok: true, settled: 'product_sku_not_found'` می‌شد.
4. `dryRunProductMatrix`: `ok: results.every(r => r.ok)` روی همان `ok` حمل‌ونقلی.

نتیجه: شمارندهٔ «انجام‌شده» در UI تنظیمات و اسکریپت‌های عملیاتی، کالاهایی را سبز نشان می‌داد که موجودی‌شان روی سایت به‌روز **نشده** بود.

### 2.2 اصلاح (کوچک‌ترین تغییر) / The fix

فقط `server/lib/website-stock-sync.js`:

- **`classifyMatrixPushResult(push, payload)`** — تابع خالص (بدون DB، بدون شبکه، بدون جهش ورودی). ورودی: نتیجهٔ حمل‌ونقل (`ok|transportOk`, `status`, `matched` آرایه یا عدد, `unmatched`, `reason`) و payload خروجی `buildMatrixPayload` (که `variants` آن از قبل فقط ردیف‌های `active=1` و `is_default=0`، یعنی ردیف‌های قابل‌فروش است). خروجی:
  - `ok` · `status` (`'done'`|`'error'`) · `code` (`all_matched` | `variants_unmatched` | `product_sku_not_found` | `transport_failed`)
  - `matched` · `expected` (تعداد ردیف‌های قابل‌فروش ارسالی) · `unmatchedCount`
  - `examples` — حداکثر **۵** نمونه `{label, erpVariantSku, color, size, reason}` با برچسب «رنگ / سایز»
  - `message` — فارسی و قابل‌اقدام (نمونه: «۱ رنگ/سایز از ۳ در سایت هم‌خوان نشد (سفید / M)؛ تا رفع نگاشت در سایت، این ارسال موفق محسوب نمی‌شود.» یا «کد کالا «7080» در سایت پیدا نشد؛ کد را در سایت وصل یا بسازید (فقط نگاشت صریح؛ حدس از روی نام انجام نمی‌شود)، سپس همگام‌سازی را دوباره اجرا کنید.»)
- **`pushMatrixToSite`**: `ok = transportOk && verdict.ok`؛ فیلدهای جدید `transportOk`, `code`, `expected`, `unmatchedCount`, `examples`, `message`؛ `reason` در حالت ناموفق همان پیام فارسی. شکل قبلی (`status`, `matched`, `unmatched`, `body`, `dryRun`) حفظ شد.
- **`drainWebsiteStockOutbox`**:
  - پاسخ سایت رسیده (`transportOk`) و همه هم‌خوان → `done`.
  - پاسخ رسیده ولی `unmatched` دارد → `status='error'` (برچسب UI: «نیاز به رسیدگی»)، `last_error` = پیام فارسی، `last_result` شامل `unmatchedCount/examples/code/message/expected`؛ **بدون** retry (سوزاندن تلاش بی‌فایده است تا نگاشت در سایت درست شود).
  - مسیر settle: همچنان بدون ارسال مجدد، اما `status='error'` و `ok:false` با همان پیام؛ دیگر هرگز «انجام‌شده» شمرده نمی‌شود.
  - خطای حمل‌ونقل (timeout/5xx): مسیر backoff قبلی بدون تغییر.
  - `skipped` (پیکربندی وسط کار خاموش شده): مثل قبل `done` با نشانگر `skipped`.
- **`dryRunProductMatrix`**: `ok` فقط وقتی همهٔ کانال‌ها بدون unmatched باشند؛ به‌علاوه `unmatchedCount` و `message`. UI موجود (`app.js`, claimed و دست‌نخورده) از قبل برای `ok:false` متن «dry-run با unmatched» نشان می‌دهد.
- **`summarizeOutboxRow`**: شاخهٔ «N مورد هم‌خوان · M مورد بدون هم‌خوانی» دیگر به `status==='done'` وابسته نیست (برای ردیف‌های `error` جدید و ردیف‌های `done` قدیمی)؛ ردیف `pending` بازصف‌شده همچنان «در صف» می‌ماند.
- Export جدید: `classifyMatrixPushResult`, `formatUnmatchedExample`, `UNMATCHED_EXAMPLE_LIMIT`.

### 2.3 آنچه عمداً تغییر نکرد / Deliberately unchanged

- **هیچ ادغام فازی از روی نام.** تطابق فقط با SKU دقیق (`products.code` ↔ SKU سایت، `erpVariantSku` ↔ واریانت سایت) و نگاشت صریح سمت سایت (`erp_product_map`). پیشنهادهای «نام نزدیک» در گزارش §2.6 صرفاً راهنمای اپراتور است و در کد به‌کار نمی‌رود (تست §2.4 مورد ۷).
- **جدول نگاشت جدید اضافه نشد.** گزینهٔ «جدول نگاشت فقط‌مرکز» در brief اختیاری بود؛ کوچک‌ترین اصلاح به آن نیاز نداشت. اگر بعداً لازم شد: `CREATE TABLE IF NOT EXISTS` داخل همین ماژول یا `server/lib/website-sku-map.js`، **فقط‌مرکز**، و **بدون** افزودن به `SYNCABLE_TABLES` (claimed).
- سیاست retry/backoff، debounce، batch، timeoutها، مسیر WooCommerce و webhook.
- مالیات، بیمه، SMS.

### 2.4 تست / Tests

`node server/scripts/test-nontax-website-sku.js` — **۵۱/۰** (خالص؛ بدون DB، بدون شبکه، بدون `better-sqlite3`):

| گروه | پوشش |
|---|---|
| all matched | `ok:true`, `status:'done'`, `unmatchedCount:0`, `examples:[]`, `matched`/`expected` درست، پذیرش `matched` عددی |
| one unmatched | `ok:false`, `status!=='done'`, `code:'variants_unmatched'`, شمارش ۱، نمونه «سفید / M» با SKU و reason، پیام فارسی با شمارش و نمونه و اشاره به «نگاشت» |
| product_sku_not_found | `code`, `catalogMissing:true`, پیام شامل کد کالا و «وصل/بساز … همگام‌سازی» و «صریح» |
| cap | ۷ ردیف → `unmatchedCount:7`, `examples.length:5`, «…» در پیام |
| transport | timeout → `transport_failed`؛ بدون پرچم `ok`: 204 موفق / 500 ناموفق با `HTTP 500`؛ ورودی `null` هرگز موفق نیست |
| idempotency | دو فراخوانی روی همان payload → `deepStrictEqual`؛ ورودی‌های freeze‌شده جهش نمی‌کنند؛ آرایه‌ها بین فراخوانی‌ها مشترک نیستند؛ جهش در خروجی به فراخوانی بعدی نشت نمی‌کند |
| no fuzzy merge | پیشنهاد `suggestion` سمت سایت نه موفقیت می‌سازد نه در examples پذیرفته می‌شود |
| summary | ردیف `error` با unmatched جزئی → «نیاز به رسیدگی»، شمارش‌ها، nextStep، hint؛ ردیف settle → «کد کالا در سایت پیدا نشد» + «نیاز به رسیدگی»؛ ردیف pending → `wait` |

رگرسیون: `test-website-outbox-summary-v293.js` **۱۱/۰** · `test-website-outbox-timeout-v292.js` **۶/۰** · `node --check server/lib/website-stock-sync.js` OK.

سیم‌کشی drain با DB جعلی در حافظه و سایت stub‌شده (harness موقت، خارج از مخزن، حذف‌شده) تأیید شد: all-matched→`done`؛ partial→`error` با `last_error` فارسی و examples ذخیره‌شده؛ settle→`error` بدون هیچ فراخوانی شبکه؛ drain مجدد روی ردیف settle‌شده بدون اثر جانبی اضافه؛ ارسال مجدد همان payload همان حکم و همان وضعیت ردیف.

`test-sms.js` / `test-sync.js` در این worktree اجرا نشدند: `server/node_modules` نصب نیست (Node 24، `better-sqlite3` در دسترس نیست). این تغییر هیچ جدول/مسیر/اسکیمایی را دست نزده است؛ اجرای آن دو تست روی میزبان دارای node_modules پیش از merge توصیه می‌شود.

### 2.5 محدودیت‌های شناخته‌شده / Known limitations (follow-ups, not done here)

1. **settle چسبنده:** `last_result` در upsert صف پاک نمی‌شود؛ کالایی که یک بار `product_sku_not_found` گرفته، در enqueue‌های بعدی (حتی full-sync) بدون ارسال مجدد settle می‌شود (رفتار v292 برای نسوزاندن retry روی timeout). اکنون این حالت صادقانه `error` است، ولی پس از اصلاح نگاشت در سایت، تا پاک‌شدن `last_result` بازبینی زنده انجام نمی‌شود. پیشنهاد (نیاز به تصمیم مالک): پاک‌کردن `last_result` فقط در enqueue با `force` (full-sync صریح اپراتور) یا پنجرهٔ زمانی بازبینی.
2. پاسخ 2xx **بدون** آرایه‌های `matched/unmatched` (بدنهٔ ناشناخته) همچنان موفق تلقی می‌شود (`unmatchedCount=0`)؛ تأییدنشده‌بودن علامت‌گذاری نمی‌شود.
3. `skipped` به‌دلیل نبود پیکربندی B2B وسط drain، ردیف را `done` می‌کند (سبز کاذب سطح پیکربندی، خارج از این brief).

### 2.6 اعداد تاریخی گزارش ۱۴۰۵/۰۷/۱۱ / Historical snapshot (NOT live)

منبع: `docs/reports/2026-10-03-erp-site-sku-diff.md` (در worktree اصلی؛ **فقط snapshot**). بازاندازه‌گیری زنده در این نوبت **انجام نشد** چون دسترسی به DB تولید خارج از محدوده است. این اعداد نباید به‌عنوان وضعیت فعلی نقل شوند:

- کالاهای ماتریسی ERP: ۳۶ · کالاهای سایت: ۸۳
- تطابق دقیق SKU: **۰** · وصل‌شده با `erp_product_map` (روش `name_seed`): ۴ (`7126`, `7132`, `7142`, `7143`)
- ERP بدون SKU یکسان در سایت: ۳۲ · بارکد پرشده در سایت: ۰ · SKU سایت خارج از کدهای ماتریسی ERP: ۷۹

با اصلاح این نوبت، همان ۳۲ کالا (اگر هنوز نگاشت نشده باشند) در صف به‌جای «انجام‌شده» با «نیاز به رسیدگی» و پیام «کد کالا در سایت پیدا نشد» دیده می‌شوند.

## 3. بستهٔ ۳ — BOM capture (BLOCKED) / Package 3

**وضعیت:** معوق تا handoff مالک. `server/sync/capture.js` در ادعای `ANDROID-NATIVE-SALES` است و در این نوبت ویرایش نشد.

**شکاف تأییدشده (امروز، `6cef626`):**

- `PATH_TABLE_MAP` خط ۱۲۰: `['/api/production/boms', 'bom_headers']`
- `tableForPath` خطوط ۱۷۸–۱۷۹: فقط `path.includes('/operations')` → `bom_operations` و `path.includes('/outputs')` → `bom_outputs`.
- مسیرهای `PUT /api/production/boms/:id/assignments`، `POST …/assignments/backfill` و `…/allowed-variants` هیچ شاخه‌ای ندارند → با پیشوند عمومی به `bom_headers` نگاشت می‌شوند → روی دستگاه `entity_table` اشتباه/remap خراب.

**وصلهٔ پیشنهادی (همان handoff / PA-10؛ درج **پیش از** شاخه‌های `operations|outputs` و پیش از حلقهٔ `PATH_TABLE_MAP`):**

```js
if (path.startsWith('/api/production/boms/') && path.includes('/assignments')) return 'bom_material_assignments';
if (path.startsWith('/api/production/boms/') && path.includes('/allowed-variants')) return 'bom_allowed_variants';
```

پیش‌نیازها از قبل برقرارند: هر دو جدول در انتهای `SYNCABLE_TABLES` و backfill مربوط ثبت شده‌اند (`PROD-ACC-PA09-PA12-ACCEPTANCE.md` §PA-10). پس از درج: `node server/scripts/_diag-sync-gaps-b16e78.js` و `node server/scripts/test-sync.js`.

## 4. بستهٔ ۱۱ — CRM service cases / Package 11

معوق. نیازمند جدول جدید (`server/db.js`، claimed)، append به `server/sync/tables.js` (claimed) و UI در `server/public/app.js` (claimed). طبق brief **هیچ آیتم ناوبری خالی** اضافه نشد.

## 5. بستهٔ ۱۲ — ترجیحات ارتباطی مشتری / Package 12

معوق به همان دلیل §4. رفتار تأییدشده (بدون تغییر):

- `server/routes/customers.js`: در `POST /` پس از پاسخ، اگر `phone` باشد و `!isDevice()` → `sendWelcomeSMSToCust(db, phone)` (خطوط ۱۵۶–۱۵۸؛ متن از `welcome_sms_text` یا `DEFAULT_WELCOME_SMS`؛ بدون `sms_api_key` ارسال نمی‌شود). همچنین `dispatchSmsEvent(db, 'customer.created', …)` (خط ۱۶۲). ارسال دستی: `POST /:id/welcome-sms`.
- **مدل opt-out وجود ندارد** و در این نوبت اضافه نشد. سیاست SMS تغییر نکرد.

## 6. بستهٔ ۱۴ — Native GA / Package 14

این سند **اجازهٔ انتشار هیچ باینری (APK/EXE/MSI) را نمی‌دهد**؛ هیچ بیلدی ساخته نشد. خلاصهٔ گیت‌های باقی‌مانده از اسناد موجود:

**Android بومی** (`NATIVE-ANDROID-DELIVERY-STATUS.md`؛ شاخه `ai/ANDROID-NATIVE-SALES`، `versionCode 100 / 3.0.0-alpha01`):
- کد فازهای ۰–۵ انجام شده (Compose shell، Room v2، sync HMAC+Ed25519، migrator fail-closed، سیاست update امضاشده، تست‌های JVM سبز).
- گیت‌های باز: Android SDK روی میزبان بیلد نیست (`assembleDebug/Release` ممکن نیست)؛ keystore انتشار در worktree نیست؛ ماتریس دستگاه air-gap اجرا نشده؛ **Reviewer + Security مستقل PENDING** پیش از هر ادعای GA.

**دسکتاپ بومی** (`docs/native/GA-STATUS.md`):
- آماده: پل Electron 2.0.13، Domain Host Named Pipe، WPF shell، Migration Wizard، گیت‌های موج ۲–۱۰ + checklist air-gap، بستهٔ stage.
- باقی تا GA: MSI/NSIS امضاشدهٔ **OV** برای native؛ کانال update بومی؛ عمیق‌سازی WPF (فاکتور کامل، چک، BOM…)؛ air-gap ۱۲گامی روی VM تمیز؛ موج ۱۱ بازنشستگی Electron.

**Electron EXE** (`docs/DESKTOP-EXE-DELIVERY.md`؛ `DESKTOP-EXE-DELIVER` در registry «completed»):
- 2.0.14 NSIS امضاشده با گواهی **self-signed** (`CN=Poshak Taranom`)، SHA-256 ثبت‌شده، خروجی `D:\proje\ERP EXE`.
- طبق یادداشت registry: انتشار عمومی/تولیدی باینری **نیازمند تأیید صریح جداگانهٔ مالک** است؛ گواهی OV تجاری non-goal بود.

## 7. بستهٔ ۱۵ — ADR چندشرکتی / Package 15: Multi-company ADR

**Status: Proposed** — مالک باید پیش از هر کد بپذیرد. در این نوبت هیچ refactor انجام نشد.

### 7.1 Context — وضعیت تأییدشده

- برنامه **یک handle سراسری SQLite در سطح پروسه** دارد. «شرکت فعال» یک مفهوم process-global است، نه request-scoped.
- `server/lib/company-switch-guard.js`: `requestGuard` هر درخواست API را می‌شمارد و در حین سوئیچ 503 `COMPANY_SWITCH_IN_PROGRESS` می‌دهد؛ `beginCompanySwitch` اگر درخواست دیگری در جریان باشد (`activeRequests > 1`) 409 `COMPANY_SWITCH_BUSY` پرتاب می‌کند (fail-closed).
- `server/routes/companies.js#activateCompanySafely`: ابطال همهٔ نشست‌ها، نوشتن registry (`company-workspace.js`)، سپس `reopenDatabase(dbPath)+initDB()` روی همان handle سراسری؛ در خطا، registry و handle به حالت قبل برمی‌گردند. دستگاه‌ها (`isDevice`) فقط یک شرکت محلی گزارش می‌کنند.
- `FISCAL-COMPANY-CLEAN-V212` صراحتاً «tenancy سطح ردیف با `company_id`» را non-goal اعلام کرده بود.

### 7.2 Decision (proposed)

**در این برنامه refactor نمی‌شود.** مدل «یک پروسه = یک شرکت فعال + سوئیچ محافظت‌شده» باقی می‌ماند. هرگونه حرکت به سمت request-scoped company (handle per-request یا tenancy ردیفی) فقط با ADR پذیرفته‌شده و برنامهٔ مهاجرت جدا.

### 7.3 Consequences

- همزمانی چندشرکتی در یک پروسه **ممکن نیست**؛ سوئیچ در ساعات کاری درخواست‌های در جریان را رد می‌کند (رفتار عمدی).
- هر ماژولی که `getDB()` را cache کند یا timer/loop سراسری با db بسته داشته باشد (نمونه: `startWebsiteStockDrainLoop` در همین بستهٔ ۱۰) باید در طرح آینده بازبینی شود.

### 7.4 Open questions — پرسش‌های باز (به‌صورت متن، نه کد)

1. **Authorization:** چه نقشی حق سوئیچ/ساخت/حذف شرکت دارد؟ آیا step-up password فعلی کافی است؟ مدل مجوز بین‌شرکتی برای کاربران مشترک؟
2. **Migration:** مسیر مهاجرت از فایل‌های SQLite جدا به مدل request-scoped (در صورت تصمیم) چیست؟ `initDB`/`ensureColumn` روی چند handle همزمان؟ idهای دستگاه و `sync_seq` به‌ازای شرکت؟
3. **Backup isolation:** بکاپ/رستور به‌ازای شرکت؛ جلوگیری از رستور فایل شرکت A روی B؛ GFS و offsite به‌ازای هر فایل.
4. **Rollback:** اگر سوئیچ وسط تراکنش‌های outbox/سینک/درین شکست بخورد چه می‌شود؟ معیار پذیرش rollback و تست آن (`test-company-switch-safety.js` موجود را گسترش دهیم؟).

## 8. بستهٔ ۱۶ — شکستن `app.js` / Package 16

معوق. `server/public/app.js` در ادعای `PROD-ACC-PA02` است. ریسک صرفاً **نگه‌داری‌پذیری** (فایل تک‌پارچهٔ بسیار بزرگ) است و نقص عملکردی/داده‌ای گزارش نشده؛ طرح split باید ADR جدا داشته باشد (مرزبندی ماژول‌ها، SW cache، CSP binding فعلی).

## 9. بستهٔ ۱۳ — Lead / B2B / Campaign / Package 13

معوق تا فرود نقص‌های P0 (`ai/NONTAX-P0-sync`, `ai/NONTAX-P0-atp`) و آزادشدن `app.js`/`db.js`. بدون nav خالی.

## 10. ادعاهای فایل که برنامه را مسدود کردند / Blocking file claims

منبع: `.ai-dos/tasks/active.yaml` (فقط خوانده شد؛ ویرایش نشد). `.ai-dos/ai-dos.yaml` → `stale_claim_hours: 24`.

| تسک | ادعا شده در | فایل‌های مرتبط با این برنامه | اثر | یادداشت |
|---|---|---|---|---|
| `PROD-ACC-PA02` | `2026-10-01T15:10+03:30` (in_progress) | `server/db.js`, `server/sync/tables.js`, `server/jalali.js`, `server/public/app.js`, `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`, `.ai-dos/tasks/active.yaml`, `.ai-dos/tasks/handoff.md`, `server/lib/production/**`, `server/routes/production-boms.js` | بسته‌های ۱۱، ۱۲، ۱۳، ۱۶ و هر Help/CHANGE-LOG در این نوبت | ادعا از آستانهٔ ۲۴ ساعت گذشته است، اما **این brief عبور از مالکیت را ممنوع کرده**؛ فقط اطلاع‌رسانی در همین سند. ثبت در registry بر عهدهٔ مالک. |
| `ANDROID-NATIVE-SALES` | `2026-09-27T18:10+03:30` (in_progress) | `server/sync/capture.js`, `android-native/**`, `server/public/releases/manifest.json`, `docs/architecture/NATIVE-ANDROID-*.md` | بستهٔ ۳ (capture) و هر تغییر manifest برای بستهٔ ۱۴ | وصلهٔ §3 آماده است؛ منتظر مالک. |

**اثر جانبی اجباری:** چون `docs/CHANGE-LOG.md` و Help داخل `index.html` هر دو claimed هستند، ورودی CHANGE-LOG و به‌روزرسانی راهنمای داخل برنامه برای بستهٔ ۱۰ در این کامیت **انجام نشد** و باید توسط مالک آن فایل‌ها (یا پس از آزادشدن ادعا) اضافه شود. متن پیشنهادی CHANGE-LOG:

> ### ۱۴۰۵/۰۷/۱۲ — سینک موجودی سایت: unmatched دیگر «موفق» نیست (NONTAX-P1)
> - **ریشه:** `pushMatrixToSite` با HTTP 2xx `ok:true` می‌داد و drain ردیف را `done` می‌کرد حتی وقتی `unmatched` پر بود؛ settle هم `ok:true`.
> - **رفع:** `classifyMatrixPushResult` خالص؛ هر ردیف قابل‌فروش بدون هم‌خوانی ⇒ `ok:false`، ردیف `error` («نیاز به رسیدگی»)، `unmatchedCount` + ≤۵ نمونه + پیام فارسی. بدون ادغام فازی نام؛ بدون جدول جدید؛ retry/backoff بدون تغییر.
> - **فایل‌ها:** `server/lib/website-stock-sync.js`, `server/scripts/test-nontax-website-sku.js`, `docs/architecture/NONTAX-REMEDIATION-2026-10-04.md`.
> - **تست:** nontax-website-sku ۵۱/۰؛ v293 ۱۱/۰؛ v292 ۶/۰. **Deploy:** ⏳ منتظر تأیید مالک (بدون push در این نوبت).

## 11. فهرست صریح مستثنیات مالیاتی و بیمه / Explicit tax & insurance exclusions

برای ثبت نزد مالک — در این برنامه **هیچ‌کدام لمس نشد**:

- سامانهٔ مؤدیان (Moadian) — ارسال/امضا/قالب
- محاسبه و اظهارنامهٔ ارزش افزوده (VAT calc / returns)
- مادهٔ ۱۶۹ (گزارش معاملات فصلی)
- مالیات حقوق (payroll income tax)
- نرخ‌های مالیاتی (tax rates) و پارامترهای ۱۴۰۵
- فیلدهای مالیاتی فاکتور (tax invoice fields)
- **بیمه:** فرمت لیست بیمه تغییر نکرده؛ هر خروجی بیمه تا **تأیید حقوقی** «نهایی» نامیده نشود.

## 12. فرمان‌های تأیید / Verification commands

```powershell
cd D:\proje\erp-taranom-nontax-web
node --check server/lib/website-stock-sync.js
node server/scripts/test-nontax-website-sku.js            # 51/0
node server/scripts/test-website-outbox-summary-v293.js   # 11/0
node server/scripts/test-website-outbox-timeout-v292.js   # 6/0
# روی میزبانی که server/node_modules دارد:
node server/scripts/test-sms.js ; node server/scripts/test-sync.js
```

## 13. فایل‌های این کامیت / Files in this commit

- `server/lib/website-stock-sync.js` — اصلاح (classifier + سیم‌کشی push/drain/dry-run/summary)
- `server/scripts/test-nontax-website-sku.js` — جدید (۵۱ assertion، خالص)
- `docs/architecture/NONTAX-REMEDIATION-2026-10-04.md` — این سند

بدون push، بدون deploy، بدون تغییر در فایل‌های claimed.
