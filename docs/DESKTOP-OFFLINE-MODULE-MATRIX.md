# ماتریس پوشش آفلاین ماژول‌های ERP ترنم (دسکتاپ)

منبع حقیقت: `server/routes/*`، `server/lib/rbac.js`، `server/middleware/auth.js` (`centralOnly` / `centralOnlyStrict`)، `docs/OFFLINE-SYNC.md`.
نسخهٔ سند: **2.0.12** — تاریخ: ۱۴۰۵/۰۷/۰۵ (2026-09-27).

قرارداد مشترک:
- **خواندن آفلاین:** از SQLite محلی پس از bootstrap/pull.
- **نوشتن آفلاین:** از طریق API محلی → `sync_outbox` → replay روی مرکز.
- **تأیید مرکزی:** اثر سراسری/شمارهٔ نهایی/مجوز پس از پذیرش مرکز.
- **سرویس خارجی:** SMS، ایمیل، مودیان، وب‌هوک، AI — بدون پاسخ واقعی «موفق» اعلام نمی‌شود.
- دسکتاپ (`APP_PLATFORM=desktop`) برخلاف اندروید به برخی مسیرهای `centralOnly` دسترسی دارد؛ `centralOnlyStrict` (بکاپ ادمین) همچنان فقط مرکز است.

| ماژول | گردش اصلی | نقش مجاز (پیش‌فرض) | خواندن آفلاین | نوشتن آفلاین | تأیید مرکزی | سرویس خارجی | آزمون |
|---|---|---|---|---|---|---|---|
| احراز هویت / pairing | login، pair دستگاه، JWT محلی DPAPI | همه | بله (کاربر کش‌شده) | ورود آفلاین با JWT محلی؛ pair فقط آنلاین | بله | خیر | partial (hardening + sync harness) |
| مشتریان / CRM | CRUD مشتری، فرصت، فعالیت، پیگیری | admin/acc/sales* با scope مالک | بله | بله (موقت id دستگاه) | remap id + scope | خیر | test-sync + CRM tests |
| اشخاص / طرف‌حساب | party، تفصیلی 1103/2101/1106 | admin/acc/sales | بله | بله | بله | خیر | test-sync |
| محصولات / رنگ‌سایز / واحد | کالا، variant، واحد اعشاری | admin/acc/sales view | بله | بله | بله | خیر | apparel/variant tests |
| فاکتور فروش / پیش‌فاکتور | ثبت، اصلاح، تبدیل، ابطال R13 | invoices.* | بله | بله؛ شمارهٔ موقت محلی | شمارهٔ نهایی اتمیک مرکز | چاپ محلی | invoice amend/void tests |
| خرید / برگشت خرید | PO، رسید، برگشت | admin/acc | بله | بله | بله | خیر | purchase/sync |
| دریافت / پرداخت / صندوق / بانک | settlement، cash، bank | accounting+ | بله | بله؛ provisional | JE نهایی مرکز | بانک خارجی: فقط پس از پاسخ | cash/cheque tests |
| چک | ثبت، وصول، برگشت، ظهرنویسی | accounting+ | بله | بله | بله | خیر | cheque tests |
| انبار / انتقال / شمارش | move، stocktaking، variant stock | stocktaking/warehouse | بله؛ موجودی provisional | بله | قطعی در مرکز؛ تعارض انسانی | خیر | variant-stock + sync |
| تولید / BOM / بهای تمام‌شده | issue/FG/scrap/cutting | production.* | بله | بله (نقش مجاز) | بله | خیر | production tests |
| امانت / حواله | consignment | admin/acc | بله | بله | بله | خیر | apparel/consign |
| حسابداری / اسناد | JE، دفتر، تراز | accounting.view+ | بله | بله؛ دورهٔ بسته رد می‌شود | بله | خیر | acc-* tests |
| دارایی ثابت | ثبت/استهلاک | fixed_assets | بله | بله | بله | خیر | route-level |
| حقوق و دستمزد | payroll | payroll | بله | بله | بله | خیر | payroll RBAC |
| گزارش / داشبورد / Excel / PDF | گزارش‌ها، چاپ | reports/export | بله؛ برچسب زمان/محدودهٔ محلی | خروجی محلی | اعداد مرکز فقط پس از sync | Chart محلی | print/excel tests |
| کاربران / تنظیمات / API key | users، settings | admin؛ settings central-ish | محدود | تنظیم امنیتی سراسری فوری از آفلاین نیست | بله | SMS/AI keys مرکز | centralOnlyStrict |
| پیامک / ایمیل / AI / مودیان | ارسال بیرونی | نقش مربوط | صف درخواست | درخواست آفلاین مجاز؛ موفق≠ارسال‌شده | پاسخ واقعی | بله | نباید PASS جعلی |
| بکاپ / بازیابی ادمین | backup-now/restore | admin | خیر روی دستگاه | `centralOnlyStrict` | فقط مرکز | خیر | backup tests |
| همگام‌سازی | outbox/pull/files | device | — | اتمیک دامنه+outbox | replay + idempotency | شبکه | `test-sync.js` 44 assert |

## رفتار وابسته به مرکز

1. درخواست مجاز می‌تواند در outbox بماند.
2. اثر سراسری (شمارهٔ قطعی، موجودی مشترک، مجوز) فقط پس از پذیرش مرکز.
3. تغییر RBAC/کلید سرویس از دستگاه آفلاین اختیار فوری سراسری ایجاد نمی‌کند.
4. گزارش‌ها باید زمان آخرین sync و محدودهٔ دادهٔ محلی را نشان دهند (UI موجود sync status).

## شکاف‌های شناخته‌شده (این تحویل)

- همهٔ سناریوهای پذیرش EXE نصب‌شده هنوز اندازه‌گیری نشده‌اند → در `docs/DESKTOP-EXE-DELIVERY.md`.
- CDN فونت/Chart در وب: در دسکتاپ منابع از سرور embedded سرو می‌شوند؛ تأیید کامل آفلاین CDN در smoke لازم است.
- امضا self-signed → SmartScreen روی PCهای دیگر «ناشناس» می‌ماند تا OV.
