# ماتریس موج‌های مهاجرت بومی (از Capability Inventory)

منبع: [`NATIVE-WINDOWS-CAPABILITY-INVENTORY.md`](../architecture/NATIVE-WINDOWS-CAPABILITY-INVENTORY.md)  
قفل دامنه: Node Host ([DECISIONS-LOCKED](../architecture/NATIVE-WINDOWS-DECISIONS-LOCKED.md))

| موج | قابلیت‌های اصلی | fixture اولویت | شبکه |
|---|---|---|---|
| **۰** | قرارداد عملیات، schema_hash، Brand Pack، اسکلت Host | contract+schema+golden-vertical | — |
| **۱** | Auth آفلاین، مشتری، سفارش، فاکتور، JE، انبار مینیمال، R13، چاپ، گزارش محلی، sync outbox | golden-vertical (+ print smoke) | sync برای شماره نهایی |
| **۲** | کالا، variant، رنگ/سایز، کاردکس، انتقال انبار، موجودی چندانباره | stock-matrix, warehouse-move | sync |
| **۳** | خزانه، بانک، صندوق، چک دوطرفه، تسویه، انتقال حساب | cheque-lifecycle, settlement | sync |
| **۴** | خرید، RFQ، رسید کالا، برگشت خرید، امانت | purchase-cycle | sync |
| **۵** | حسابداری کامل، سال مالی، چندشرکتی، تفصیلی، مراکز هزینه | fiscal-close, multi-company | بخشی مرکز |
| **۶** | تولید، BOM، برش، MRP، بهای تمام‌شده | bom-costing | sync |
| **۷** | گزارش‌های پیشرفته، Excel، چاپ تخصصی، VAT محاسباتی | report-parity, paper-iso | خیر (محاسبه) |
| **۸** | CRM فرصت/فعالیت، POS، صف بیرونی محدود | crm-pipeline, pos-void | sync / بیرونی جدا |
| **۹** | حقوق، دارایی ثابت، بودجه، ذخایر | payroll-smoke, fixed-asset | sync |
| **۱۰** | تنظیمات محلی، RBAC خواندن، ایمپورت محدود، بکاپ محلی دستگاه | rbac-read, local-backup | مرکز برای ادمین سخت |
| **۱۱** | بازنشستگی Electron، Migration Wizard، فقط‌خواندن پل قدیمی | migration-wizard | — |

## قواعد موج

1. قبل از UI: fixture دامنه ۱۰۰٪ سبز روی Node Host.
2. `check-drift.js` برای schema/contract در CI هر موج.
3. از پایان موج ۳: قابلیت جدید فقط با پیاده‌سازی همزمان بومی (R9).
4. قابلیت‌های `مرکز-سخت` / `بیرونی` در موج مربوطه با stub آفلاین صریح علامت می‌خورند — نه شبیه‌سازی دروغین موفقیت.
