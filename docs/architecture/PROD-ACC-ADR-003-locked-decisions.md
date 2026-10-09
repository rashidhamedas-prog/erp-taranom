# ADR-003 — قفل تصمیم‌های حسابداری تولید (پس از تحقیق جامع)

**وضعیت:** Accepted  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**زمینه:** `PRODUCTION-ACCOUNTING-RESEARCH.md` + درخواست مالک برای اجرای همهٔ گزینه‌ها به‌ترتیب اولویت

## تصمیم‌ها

| # | موضوع | تصمیم قفل‌شده |
|---|--------|----------------|
| 1 | سربار واقعی (PRD-06) | همان JE هزینه وقتی `production_overhead` / `is_overhead`؛ **`sourceType=production_overhead_actual`** (بدون سند دوم) |
| 2 | دستمزد واقعی (PRD-04) | مالکیت با payroll؛ precheck بستن `payroll` + `payroll_records` + `production_labor_actual` را می‌پذیرد؛ JE جداگانهٔ تکراری ممنوع |
| 3 | JE برش | مهاجرت به کاتالوگ PRD: lay→**PRD-01**، waste→**PRD-09**، pack FG→**PRD-07**؛ موجودی `sourceType` عملیاتی `cutting_*` می‌ماند |
| 4 | انحراف سربار | بستن: انتقال جذب (5203→5202) سپس **5214 بودجه** + **5215 حجم** وقتی بودجهٔ نرخ دوره موجود باشد؛ وگرنه همه به 5215 |
| 5 | محصول فرعی (PRD-16) | `output_type=scrap` → **1113**؛ `output_type=by` → **1104** |
| 6 | ترتیب | P0 صحت سند قبل از UI تنظیمات؛ سپس P1 Settings |

## پیامدها

- ابطال هزینهٔ سربار: `production_overhead_actual_reversal`
- تست‌های cutting که `cutting_lay` را در `journal_entries.ref_type` می‌جویند باید `production_material_issue` را بپذیرند
- ADR-001/002 بدون تغییر؛ این ADR فقط شکاف‌های باز تحقیق را می‌بندد

## غیرهدف

- موتور IAS 2 خالص ثابت/متغیر جدا (موج بعدی)
- مهاجرت تاریخچهٔ JEهای قدیمی cutting_*
- تغییر avg به per-variant
