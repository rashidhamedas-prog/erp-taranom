# ماتریس قابلیت فروش — Android بومی

> والد: [`NATIVE-ANDROID-SALES-ARCHITECTURE.md`](./NATIVE-ANDROID-SALES-ARCHITECTURE.md)  
> استخراج اولیه از `server/lib/rbac.js`، inventory دسکتاپ، `docs/OFFLINE-SYNC.md`  
> ستون «آزمون تطبیق» در فاز ۱+ با شناسه fixture پر می‌شود.

**نقش‌ها:** `FS`=field_sales · `IS`=inside_sales · `SM`=sales_manager · `MK`=marketer (در صورت وجود در محصول)  
**خواندن/نوشتن آفلاین:** پس از pairing و pull اولیهٔ مجاز.

| قابلیت | نقش مجاز | رفتار سرور (شواهد) | معادل بومی موبایل | خواندن آفلاین | نوشتن آفلاین | آزمون تطبیق |
|---|---|---|---|---|---|---|
| ورود محلی پس از فعال‌سازی | همه نقش دستگاه | `POST /auth/login` محلی در device build | صفحه Compose + SecureStore | بله | N/A | AUTH-LOCAL-01 |
| Pairing / provisioning | ops+کاربر | sync pairing Ed25519 | ویزارد فعال‌سازی بومی | خیر (آنلاین/بسته) | — | PAIR-01 |
| مشاهده/جستجوی مشتری scoped | FS,IS,SM | `customers` + `customer-scope` | لیست/جستجوی Room | بله | — | CUST-R-01 |
| ثبت/ویرایش مشتری مجاز | FS,IS,SM | CRUD `/customers` | فرم بومی + outbox | بله | بله | CUST-W-01 |
| سرنخ / فرصت CRM | مطابق crm RBAC | `/crm/opportunities` | در صورت مجوز نقش | بله | بله* | CRM-OPP-01 |
| یادداشت و پیگیری | FS,IS,SM | `/followups` | فرم پیگیری | بله | بله | FU-01 |
| برنامه روزانه تماس/مراجعه | FS,IS | فعالیت‌ها / followups تاریخی | نمای روزانه بومی | بله | بله | PLAN-01 |
| نتیجه تماس/ویزیت | FS,IS | `/crm/activities` یا followups | ثبت نتیجه + intent تماس سیستم | بله | بله | VISIT-01 |
| کاتالوگ کالا + تصویر | FS,IS,SM (view) | `/products`, images | کاتالوگ محلی + فایل | بله | خیر (master) | CAT-01 |
| قیمت/تخفیف/موجودی as-of | FS,IS,SM | products + stock views | نمایش با timestamp آخرین pull | بله | خیر* | PRICE-01 |
| رنگ/سایز/بسته/واحد | FS,IS,SM | product-variants, units | انتخابگر variant | بله | خیر | VAR-01 |
| سبد سفارش | FS,IS,SM | `marketer_carts` / draft | سبد محلی پایدار | بله | بله | CART-01 |
| پیش‌فاکتور / سفارش | FS,IS,SM | `/orders`, invoices proforma | سند موقت + outbox | بله | بله | ORD-01 |
| فاکتور قطعی / تبدیل | SM (FS/IS فقط proforma) | `/invoices` + maker-checker | FS/IS: پیش‌فاکتور؛ SM: قطعی/تبدیل | بله | بله* | INV-01 |
| برگشت فروش | معمولاً accounting؛ SM فقط با تفویض | `/accounting/sales-returns` | پیش‌فرض روی گوشی FS/IS نیست | بله | مشروط* | RET-01 |
| وصول میدانی | FS,IS → pending تا تأیید | `POST /reps/payments` + عکس اجباری | فرم بومی؛ JE فقط پس از تأیید مرکز | بله | بله* (pending) | RCP-01 |
| تماس/ویزیت نماینده | FS,IS (+SM مدیریتی) | `/reps/:id/calls|visits` | بومی؛ **شکاف:** capture `entity_table` صریح نیست — نیاز claim sync جدا | بله | مشروط* | VISIT-02 |
| پیوست تصویر/مدرک | نقش دارای upload | uploads + sync files | ذخیره محلی + صف فایل | بله | بله | FILE-01 |
| بدهی/مانده/وضعیت سفارش | FS,IS,SM | balances, statement read | کارت مانده محلی | بله | خیر | BAL-01 |
| گزارش عملکرد شخصی | FS,IS,SM reports.view | `/reports/salesperson` وقیاسی | گزارش محلی فیلتر خود کاربر | بله | خیر | REP-01 |
| صف ارسال‌نشده / تعارض | همه | sync conflicts UI وب | صفحه sync-ui بومی | بله | اقدام انسانی | SYNC-UI-01 |
| تنظیمات سازمانی / کاربران / API keys | admin | centralOnly | **نمی‌آید روی گوشی** | — | — | N/A |
| بکاپ مرکز / SMS cron / stock patch | admin | centralOnly | **نمی‌آید** | — | — | N/A |
| تولید/BOM/بهای تمام‌شده | تولید | production* | **نمی‌آید** (FS/IS = NONE) | — | — | N/A |
| مودیان / بانک ریکانسیل کامل | حسابداری | moadian, bank-recon | **نمی‌آید** | — | — | N/A |

\* نوشتن آفلاین = `local_committed` + انتظار تأیید مرکز؛ اثر قطعی سازمانی پس از `accepted_central`.

## محاسبات مشترک (parity اجباری)

| موضوع | منبع مرجع Node | پورت Kotlin | Fixture |
|---|---|---|---|
| VAT / جمع سند | `server/lib/vat.js` `calcDocTotals` | `domain.pricing.VatCalculator` | `parity/vat-*.json` |
| ردیف فاکتور / تخفیف | `invoices.js` `buildRows` (مرجع؛ نه UI marketer) | `LineBuilder` | `parity/lines-*.json` |
| qty اعشاری | `server/lib/round3.js` | همان قرارداد ۳ رقم | `parity/qty-*.json` |
| ریال/تومان | `money.js`, `currency.js` | `Money` | `parity/money-*.json` |
| ساخت سند فروش | `sales-document.js` | `SalesDocumentBuilder` | `parity/sales-doc-*.json` |
| پرداخت/اقساط | `invoice-payments.js` | در موج فاکتور | `parity/pay-*.json` |
| مانده / AR | `customer-books.js` | خواندن مدل محلی | `parity/ar-*.json` |
| scope مشتری | `customer-scope.js` | فیلتر DAO | `parity/scope-*.json` |

ظاهر مشابه بدون parity عددی **پذیرفته نیست**.

## منوهای ممنوع روی گوشی (نمونه)

مدیریت کاربران، RBAC نوشتنی، API keys، تنظیمات سیستم، بکاپ/restore مرکز، 2FA admin-reset، production/BOM/cost close، Moadian submit، bank reconciliation کامل، chart-of-accounts مدیریتی، backfill حسابداری، Excel import گستردهٔ سازمانی.
