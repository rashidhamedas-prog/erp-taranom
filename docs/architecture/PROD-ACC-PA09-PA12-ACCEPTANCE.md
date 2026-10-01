# PROD-ACC PA-09..PA-12 — چک‌لیست پذیرش / Acceptance Checklist

وضعیت: معیار پذیرش برای کارهای باقی‌مانده؛ این سند به‌تنهایی به معنی پیاده‌سازی یا PASS نیست.  
دامنه: حسابداری تولید، ایمنی بازگشایی دوره، بهداشت همگام‌سازی، مهاجرت/UI و سناریوهای طلایی.

## مراجع قفل‌شده / Locked References

- [ADR-001 — Locked assumptions](./PROD-ACC-ADR-001-locked-assumptions.md)
- [PA-00 Discovery](./PROD-ACC-PA00-DISCOVERY.md)، به‌ویژه F09 و نقشه writerها
- اصل‌های غیرقابل تغییر: مبلغ DB به ریال؛ میانگین موزون در سطح سربرگ کالا؛ هر ماده/مرحله فقط یک مالک مصرف؛ PACK متصل به سفارش تولید رویداد WIP است؛ نهایی‌شدن مالی فقط در مرکز؛ LWW برای JE و میانگین موجودی ممنوع.

## PA-09 — ایمنی بستن و بازگشایی دوره (F09) / Period Close & Reopen Safety

ریسک فعلی F09 این است که بازگشایی، `old_avg_rial` ذخیره‌شده در snapshot زمان بستن را بدون اثبات نبود تغییر بعدی روی `products.average_cost_rial` برگرداند؛ در نتیجه ممکن است میانگین جدیدتر را بازنویسی کند.

### معیارهای پذیرش / Acceptance Criteria

- [ ] بستن دوره در یک تراکنش اتمیک، snapshot تغییرناپذیر شامل تمام `journal_entries` ساخته‌شده و برای هر کالای متاثر حداقل `product_id`، `old_avg_rial` و `new_avg_rial` ثبت می‌کند.
- [ ] بازگشایی فقط برای دوره `closed`، فقط با مجوز `production_close/approve` و admin، و فقط با `reason` غیرخالی پذیرفته می‌شود.
- [ ] پیش از هر تغییر، preflight تمام snapshot را بررسی می‌کند؛ اگر میانگین جاری هر کالا با `new_avg_rial` snapshot برابر نباشد، عملیات با خطای صریح مانند `E_CLOSE_SNAPSHOT_DRIFT` رد می‌شود.
- [ ] اگر دوره بسته‌شده متأخر، سند وابسته متأخر، یا تغییر بهای متأخر مانع برگشت امن باشد، بازگشایی fail-closed است؛ هیچ JE، میانگین، وضعیت دوره یا اعلان به‌طور جزئی تغییر نمی‌کند.
- [ ] بازگردانی میانگین به‌صورت compare-and-swap انجام می‌شود (`current == snapshot.new` سپس restore به `snapshot.old`)؛ update کور صرفاً با `product_id` پذیرفته نیست.
- [ ] فقط JEهای متعلق به همان اجرای close (`PRD-21/22/23`) reverse می‌شوند؛ reversal تراز است و تمام ابعاد سند اصلی را حفظ می‌کند.
- [ ] اجرای موفق، وضعیت را `open` می‌کند و actor/time/reason و شناسه‌های reversal را نگه می‌دارد؛ تلاش دوم برای همان بازگشایی `409 E_NOT_CLOSED` می‌دهد و سند تکراری نمی‌سازد.
- [ ] close مجدد پس از اصلاح داده، snapshot و شناسه JE تازه می‌سازد و به ارجاعات اجرای قبلی اتکا نمی‌کند.
- [ ] تست تزریق خطا در میانه reverse/restore ثابت می‌کند rollback کامل است؛ جمع بدهکار و بستانکار و میانگین همه کالاها دقیقاً به وضعیت قبل از درخواست برمی‌گردد.
- [ ] تست رگرسیون «close → تغییر میانگین توسط رویداد بعدی → reopen» باید رد امن و عدم تغییر DB را ثابت کند؛ تست «close → بدون drift → reopen» باید برگشت کامل را ثابت کند.

### شواهد لازم / Required Evidence

- [ ] تست اختصاصی F09 روی SQLite موقت با شمارش JEهای اصلی/reversal، مقدار میانگین قبل/بعد و وضعیت دوره.
- [ ] `node server/scripts/test-sms.js`
- [ ] `node server/scripts/test-sync.js`

## PA-10 — بهداشت همگام‌سازی باقی‌مانده / Remaining Sync Hygiene

مالک فایل `server/sync/capture.js` در وضعیت فعلی کار Android (`ANDROID-NATIVE-SALES`) است. این patch باید توسط همان مالک ادغام شود؛ در این بسته مستنداتی اعمال نمی‌شود. جداول `bom_material_assignments`، `bom_allowed_variants` و `production_order_lines` هم‌اکنون در انتهای `SYNCABLE_TABLES` و FKهای مربوط ثبت شده‌اند، اما capture مسیرهای child هنوز باید اصلاح شود.

### وصله دقیق پیشنهادی / Exact Patch Snippet

در `tableForPath(path)` و **پیش از** شاخه‌های عمومی BOM (`operations`/`outputs`) و پیش از حلقه `PATH_TABLE_MAP` درج شود:

```js
if (path.startsWith('/api/production/boms/') && /\/assignments(?:\/|$)/.test(path)) {
  return 'bom_material_assignments';
}
if (path.startsWith('/api/production/boms/') && /\/allowed-variants(?:\/|$)/.test(path)) {
  return 'bom_allowed_variants';
}
```

این ترتیب باعث می‌شود `PUT /api/production/boms/:id/assignments` و
`POST /api/production/boms/:id/assignments/backfill` قبل از نگاشت عمومی
`/api/production/boms → bom_headers` به `bom_material_assignments` برسند؛
`PUT …/allowed-variants` نیز به `bom_allowed_variants` نگاشت می‌شود.

### معیارهای پذیرش / Acceptance Criteria

- [ ] هیچ ورودی موجود در `SYNCABLE_TABLES` reorder یا حذف نمی‌شود.
- [ ] هر سه mutation بالا روی device یک outbox با `entity_table` غیر-null و نام جدول درست می‌سازند.
- [ ] replay مرکزی همان route واقعی، authz و transaction موجود را اجرا می‌کند؛ JE یا داده مالی با row-merge/LWW ساخته نمی‌شود.
- [ ] remap شناسه‌های موقت برای `bom_id`، `bom_line_id`، `operation_id` و `variant_id` از FK registry موجود عبور می‌کند.
- [ ] diagnostic نتیجه `mismatches: []` می‌دهد:
  `node server/scripts/_diag-sync-gaps-b16e78.js`
- [ ] تست sync حداقل یک PUT assignments، یک backfill و یک PUT allowed-variants آفلاین را push/pull می‌کند و پس از replay داده device و central برابر است:
  `node server/scripts/test-sync.js`
- [ ] patch تنها پس از هماهنگی و آزادشدن claim مالک Android روی `server/sync/capture.js` اعمال می‌شود.

## PA-11 — مهاجرت و رابط کاربری باقی‌مانده / Remaining Migration & UI

### مهاجرت داده / Data Migration

- [ ] migration idempotent است: اجرای چندباره جدول‌ها، indexها، triggerها یا ردیف تکراری نمی‌سازد.
- [ ] داده قدیمی BOM حذف یا حدس‌زده نمی‌شود. backfill فقط وقتی یک نگاشت قطعی وجود دارد `sole` می‌سازد؛ موارد `multi_op_cc`، `cc_not_in_routing` و `no_stage_cc` گزارش می‌شوند و نیازمند تصمیم کاربر می‌مانند.
- [ ] برای BOM دارای چند عملیات در یک مرکز هزینه، migration «اولین عملیات» را بی‌صدا انتخاب نمی‌کند.
- [ ] backfill `sync_seq` جداول جدید باعث می‌شود ردیف‌های pre-existing با `sync_seq=NULL` از pull جا نمانند.
- [ ] rollback/restore روی نسخه پشتیبان SQLite موقت آزمایش می‌شود؛ migration روی DB واقعی بدون backup و گزارش dry-run اجرا نمی‌شود.

### ماتریس سفارش تولید / Production Order Matrix UI

- [ ] UI سفارش تولید به‌جای مدل محدود «یک رنگ + چند سایز»، grid چندرنگ × چندسایز با مقدار هر خانه ارائه می‌کند.
- [ ] فقط SKUهای فعال محصول قابل انتخاب‌اند؛ شناسه‌های `variant_id/color_id/size_id` ارسال می‌شوند، نه اتکا به نام نمایشی.
- [ ] payload از `matrix_lines[]` استفاده می‌کند و `qty_planned` دقیقاً برابر جمع خانه‌های مثبت است؛ خانه صفر/خالی خط تولید نمی‌سازد.
- [ ] در edit/reload، مقادیر `production_order_lines` بدون از دست‌رفتن یا تبدیل به `size_breakdown` تک‌رنگ بازسازی می‌شوند.
- [ ] محصول غیرماتریسی مسیر legacy را بدون regression حفظ می‌کند.
- [ ] validation هم در UI و هم در API انجام می‌شود؛ payload دست‌ساز نمی‌تواند ترکیب غیرفعال یا خارج از دامنه مجاز BOM را ثبت کند.
- [ ] نقش فقط-view grid را می‌بیند ولی کنترل mutation ندارد؛ نقش فاقد مجوز هیچ داده هزینه‌ای اضافه دریافت نمی‌کند.

### دامنه مجاز BOM / Allowed Variants UI

- [ ] در ویرایش BOM، تب/پنل «دامنه مجاز رنگ×سایز» داده را از
  `GET /api/production/boms/:id/allowed-variants` بارگذاری و با
  `PUT …/allowed-variants` ذخیره می‌کند.
- [ ] انتخاب به‌صورت matrix چندرنگ × چندسایز است و SKUهای غیرفعال مشخص و غیرقابل انتخاب‌اند.
- [ ] معنای سازگار با گذشته روشن است: لیست خالی یعنی «بدون محدودیت ساختاریافته»؛ لیست غیرخالی فقط ترکیب‌های انتخاب‌شده را مجاز می‌کند.
- [ ] ذخیره replace-all دارای confirm برای حذف دامنه موجود، حالت loading/error و جلوگیری از double-submit است.
- [ ] بعد از save و reload، تعداد و tupleهای `(color_id,size_id,variant_id)` دقیقاً برابر انتخاب کاربر است و duplicate ایجاد نمی‌شود.
- [ ] راهنمای داخل برنامه تفاوت «دامنه مجاز BOM» با «تعداد ماتریس سفارش» را توضیح می‌دهد.
- [ ] parse check فرانت‌اند پاس است: بلوک نهایی script/app با `new Function(...)` بدون خطا parse می‌شود.

## PA-12 — سناریوهای طلایی نهایی / Golden Acceptance Scenarios

هر سناریو باید روی DB موقت و مستقل اجرا شود و علاوه بر پاسخ API، ردیف‌های stock ledger، JE، WIP، میانگین کالا، snapshot و sync را assert کند.

### G1 — PACK + PO به‌عنوان WIP / PACK + Production Order as WIP

> در این سناریو `PO` یعنی Production Order، نه Purchase Order.

- [ ] لایه برش متصل به سفارش تولید، مواد را دقیقاً یک‌بار از WH-RAW مصرف و RAW→WIP را دقیقاً یک‌بار ثبت می‌کند.
- [ ] PACK متصل به همان سفارش، بسته برش را در WH-WIP/WH-CUT ثبت می‌کند؛ هیچ JE از WIP→FG، هیچ افزایش FG و هیچ تغییر `average_cost_rial` محصول نهایی در مرحله PACK رخ نمی‌دهد.
- [ ] backflush/issue همان پارچه مصرف‌شده دوباره رد می‌شود؛ باقی‌مانده واقعی BOM در صورت وجود قابل مصرف است.
- [ ] finalize سفارش فقط یک‌بار WIP→FG و فقط یک افزایش موجودی/میانگین FG ایجاد می‌کند؛ WIP residual در پایان در tolerance تعریف‌شده صفر است.
- [ ] replay با همان idempotency key نتیجه قبلی را برمی‌گرداند و stock/JE تکراری نمی‌سازد.
- [ ] ابطال به ترتیب مجاز، تمام stock/JE/میانگین‌های ایجادشده را reverse می‌کند؛ ابطال lay پیش از pack با `E_CUT_HAS_PACK` رد می‌شود.

### G2 — مالکیت sole/shared مواد / Sole & Shared Assignment

- [ ] دو عملیات با `cost_center_id` یکسان ساخته می‌شوند تا ثابت شود مالکیت با `operation_id` است، نه «اولین عملیات مرکز هزینه».
- [ ] ماده `sole` فقط در عملیات منتخب issue می‌شود؛ عملیات دیگر qty/cost آن را صفر دارد و مصرف کل دقیقاً برابر explode استاندارد است.
- [ ] ماده `shared` با سهم ۶۰/۴۰ بین دو عملیات تقسیم می‌شود؛ جمع qty و مبلغ دو سهم دقیقاً برابر مقدار/بهای اصلی است و rounding residual فقط یک‌بار و به‌صورت تعیین‌پذیر تخصیص می‌یابد.
- [ ] سهم ۵۰/۳۰ با `422 E_SHARE_SUM` رد می‌شود و replace-all قبلی دست‌نخورده می‌ماند.
- [ ] line یا operation متعلق به BOM دیگر با `E_BOM_LINE_MISMATCH` یا `E_BOM_OP_MISMATCH` رد می‌شود.
- [ ] اجرای آفلاین همان سناریو پس از sync همان assignmentها و همان نتیجه مصرف مرکزی را تولید می‌کند؛ LWW مجاز نیست.

### G3 — بستن اسفند کبیسه جلالی / Jalali Leap-Year Close

- [ ] `1403/12` به `1403/12/30` ختم می‌شود؛ رویداد روز `1403/12/30` داخل دوره و رویداد `1404/01/01` خارج دوره است.
- [ ] کنترل مقابل نیز ثبت می‌شود: `1404/12` به `1404/12/29` ختم می‌شود.
- [ ] precheck/calculate/execute همگی یک end date جلالی واحد استفاده می‌کنند و close، JE تراز و snapshot کامل می‌سازد.
- [ ] پس از close، mutation تولید با period `1403/12` از تمام writerهای مشمول با `E_PERIOD_CLOSED` رد می‌شود.
- [ ] reopen بدون drift تمام JEهای close و میانگین‌های snapshot را اتمیک برمی‌گرداند؛ reopen با drift سناریوی PA-09 را fail-closed می‌کند.
- [ ] close مجدد پس از اصلاح، فقط یک مجموعه JE فعال باقی می‌گذارد و گزارش‌های WIP/FG/COGS تا `1403/12/30` با GL reconcile هستند.

## دروازه نهایی / Definition of Done

- [ ] همه checkboxهای بسته مرتبط PASS و شواهد خروجی تست‌ها ثبت شده‌اند؛ SKIP محیطی به‌عنوان PASS پذیرفته نیست.
- [ ] تست‌های اختصاصی PA-09..PA-12، `test-sms`، `test-sync`، diagnostic sync و parse فرانت‌اند سبز هستند.
- [ ] هیچ secret، داده production یا تغییر مستقیم DB واقعی وارد patch نشده است.
- [ ] Reviewer مستقل، atomicity/rounding/idempotency و Security reviewer، authz/input/sync trust boundary را تأیید کرده‌اند.
- [ ] مستند راهنمای داخل برنامه و CHANGE-LOG همراه implementation (نه این سند docs-only) به‌روز شده‌اند.
