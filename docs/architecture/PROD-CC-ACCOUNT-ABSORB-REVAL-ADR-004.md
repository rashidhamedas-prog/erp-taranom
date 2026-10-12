# ADR-004 — جذب انتخابی معین به مرکز هزینه + تعدیل بها

**Status:** Accepted (۱۴۰۵/۰۷/۲۱)  
**Related:** ADR-002 (OH drivers), IAS 2 absorption, R13 cancel

## Context

مدیریت می‌خواهد برای هر مرکز هزینه یک یا چند حساب معین را انتخاب کند و درصد جذب تعریف کند. مبنای مبلغ جذب باید یکی از این سه گزینهٔ قابل انتخاب باشد:

1. `period_debit` — گردش بدهکار دوره  
2. `ending_balance` — ماندهٔ پایان دوره  
3. `budget` — مبلغ بودجه‌شدهٔ همان معین (فیلد `budget_rial`)

همچنین پس از تغییر هزینه‌ها در بازهٔ تولید، نیاز به **تعدیل بها** (بازمحاسبهٔ بهای تمام‌شده + قیمت فروش + اصلاح ارزش موجودی) با دو حالت `auto` و `manual` است.

## Decision

### A) نگاشت معین → مرکز

جدول `cost_center_account_maps` (append-only sync). فرمول هر ردیف:

```
absorbed = base_amount(base_type) × (absorb_pct / 100)
pool(CC) = Σ absorbed برای نقشه‌های فعال مرکز
```

- `period_debit` / `ending_balance` از `journal_lines` زنده (حذف/ابطال‌نشده)  
- `budget` از `budget_rial` همان ردیف نگاشت  
- دکمه/API «پیشنهاد بودجه از معین» جمع `pool` را روی بودجهٔ ثابت نرخ سربار همان دوره می‌نشاند (قابل ویرایش)

### B) تعدیل بها

جداول `cost_revaluations` + `cost_revaluation_lines`.

- **manual:** یک کالا  
- **auto:** کالاهای ساخته‌شده با تولید در بازه و موجودی > 0  

بهای جدید از roll-up BOM (`bom-advanced.rollUpUnitCost`) با نرخ‌های دوره؛ سپس:

1. به‌روزرسانی `products.average_cost_rial` / `cost` / `last_prod_cost_rial` / `std_cost_rial`  
2. اعمال مارک‌آپ قیمت (`applyPricingFromCost`)  
3. سند JE: Δموجودی × qty → موجودی کالا در برابر `5214` (انحراف بودجه سربار)  
4. ابطال = soft-void JE + بازگردانی هزینه/قیمت قبلی از خطوط (R13)

## Non-goals

- بازنویسی فیزیکی اسناد تولید تاریخی  
- IAS 2 fixed@normal کامل در همین موج  
- بیلد APK/EXE

## References

- Oracle/PeopleSoft cost update/revalue (Δcost × on-hand)  
- SAP overhead allocation % from sender accounts  
- Existing OAR: `total_rate × driver_qty × absorb_pct`
