# مشخصات ماژول حسابداری — نسخه تطبیق‌یافته با CRM ترنم

> منبع: `taranom-accounting-module-spec.md` v1.0  
> تصمیمات محصول (۱۴۰۵/۰۴/۲۴): ریال INTEGER · حذف محک · مودیان فاز ۳ · دو واحد با مرکز هزینه · ادغام کامل اشخاص

## اصل اول: یکپارچگی — نه بازسازی موازی

| مشخصات اصلی | پیاده‌سازی در CRM ترنم | دلیل |
|-------------|------------------------|------|
| `journal_vouchers` | **`journal_entries`** (گسترش ستون‌ها) | موتور سند موجود؛ فقط workflow اضافه می‌شود |
| `journal_voucher_lines` | **`journal_lines`** (+ detail_account_id) | همان جدول |
| `fiscal_periods` | **`fiscal_years`** | جدول موجود |
| `bank_accounts` | **`banks`** | همان |
| `sales_invoices` | **`invoices`** | همان + فیلدهای مودیان/VAT |
| `receipts` / `payments` | **`settlements`** + **`supplier_payments`** | همان |
| `persons` (یکپارچه) | **`parties`** (جدید) | ادغام customers + suppliers + persons قدیم |
| `general/subsidiary/detail` جدا | **`chart_of_accounts`** + **`detail_accounts`** | سطح ۱–۳ در CoA؛ سطح ۴ در detail_accounts |
| `permissions` role×module | **`rbac.js`** + **`user_permissions`** | ماتریس موجود گسترش می‌یابد |
| پاسخ `{success,data}` | **سازگاری دوگانه** | API قدیم بدون wrapper؛ API جدید `/api/v2/*` با wrapper |

## باگ‌های اصلاح‌شده در مشخصات اصلی

1. **تناقض پولی:** §0.2 می‌گوید INTEGER ریال ولی `default_discount_percent REAL` و `ownership_percent REAL` — درصدها REAL می‌مانند؛ فقط مبالغ INTEGER.
2. **ارجاع زودهنگام:** `warehouses.keeper_person_id → employees` قبل از تعریف employees — در فاز ۱ `keeper_user_id` به `users` لینک می‌شود.
3. **نقش‌ها:** `salesperson` در spec با نقش‌های فعلی (`field_sales`, `inside_sales`, …) **ادغام** می‌شود نه جایگزینی ناگهانی.
4. **حذف محک:** `coa_mode=mahak`، import محک، `cheque_records`، `party_groups` محک — **غیرفعال/حذف تدریجی**؛ کدینگ استاندارد ۴ سطحی جایگزین.
5. **Sync آفلاین:** spec sync ندارد — **همه جداول parties و detail_accounts به sync/tables.js اضافه** می‌شوند.

## فازبندی اجرا (با تصمیمات شما)

### فاز ۱ — پایه (جاری)
- CoA چهارسطحی: `detail_categories`, `detail_accounts`, seed حساب‌های 5101/3201
- موتور سند: `postToLedger()`, workflow (draft→approved), `fiscal_year_id` روی سند
- `parties` + shim سازگاری `customers`/`suppliers`
- مهاجرت پولی REAL→INTEGER ریال (×۱۰)
- integrity-check، dashboard API، company_profile
- رفع باگ soft-delete در تراز آزمایشی/ترازنامه
- RBAC گسترش‌یافته + نقش‌های جدید

### فاز ۲ — اطلاعات پایه
- واحد اندازه‌گیری، گروه کالا، انبار دو واحدی (کارگاه/دفتر توزیع)
- مراکز هزینه workshop / distribution_office
- صندوق، بانک، دسته چک با subsidiary link

### فاز ۳ — عملیات + مودیان
- فاکتور فروش/خرید با VAT، confirm workflow
- دریافت/پرداخت یکپارچه، چک دریافتی/پرداختی
- صف مودیان (ارسال/وضعیت)

### فاز ۴ — گزارشات
- تراز، سودوزيان، دفتر کل، کاردکس

### فاز ۵–۸ — عملیات خاص، حقوق، دارایی ثابت، امکانات

## نقشه نقش‌ها

| نقش spec | نقش CRM | توضیح |
|----------|---------|-------|
| admin | admin | بدون تغییر |
| chief_accountant | accounting (+ flag) | حسابدار ارشد |
| accountant | accounting | همان |
| cashier | distribution_office | صندوقدار |
| warehouse_keeper | distribution_office | انباردار |
| production_manager | admin | مدیر تولید |
| hr_officer | accounting | حقوق |
| salesperson | field_sales / inside_sales | فروش |
| viewer | distribution_office | فقط مشاهده |

## واحد پولی

- **ذخیره:** INTEGER ریال در DB
- **نمایش:** تومان = `rial / 10` در UI و API (فیلد `_display_toman` اختیاری)
- **مهاجرت:** `server/lib/money.js` — `tomanToRial()`, `rialToToman()`, `migrateMoneyColumns()`

## دو واحد عملیاتی

```
cost_centers:
  CC-WORKSHOP     → کارگاه تولید (بلوار نوبرت)
  CC-DISTRIBUTION → دفتر توزیع (کیمیا، ۱۷ شهریور)
```

انبارها `entity` = workshop | distribution_office و `cost_center_id` اجباری.

## جدول parties (ادغام اشخاص)

جایگزین تدریجی: `customers`, `suppliers`, `persons` (قدیم).  
فیلدهای CRM (segment, followup, user_id, rep) حفظ می‌شوند.  
`legacy_table` + `legacy_id` برای مهاجرت و sync.

---

*هر فاز با `POST /api/system/integrity-check` تأیید می‌شود قبل از فاز بعد.*
