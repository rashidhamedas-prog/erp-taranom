# تحقیق محرک‌های سربار — جداسازی تنظیمات حرفه‌ای

**وضعیت:** Research (pre-ADR)  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**منبع:** skill-top full + [Map OH driver deps](3b6f1a8d-4363-475d-b710-df2fe2af0d45)  
**مرجع JE:** `docs/Production/accounting-events.md` (PRD-05 / 06 / 22) + متخصص ledger (در حال ادغام)

## هدف محصول

هر محرک (`output_qty`, `direct_labor_rial`, `direct_labor_hours`, `machine_hours`, `material_rial`, `manual`) با قوانین و ورودی‌های خودش کار کند؛ سه لایه تنظیم از هم جدا باشند:

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** بودجه غیرمستقیم | اجاره / برق / استهلاک + مقدار محرک نرمال | بخش مودال، همان ذخیره با نرخ |
| **B** نرخ جذب | fixed / var / total ازپیش‌تعیین‌شده | مخلوط با A و دستمزد مستقیم |
| **C** درصد تسهیم | `absorb_pct` سهم مرکز به بها | فقط یک فیلد؛ بدون تخصیص چندمرکزی |
| **D** پنل محرک | تنظیمات حرفه‌ای وابسته به driver | فقط hint برچسب |

## فرمول اعمال فعلی (ثابت بماند مگر ADR خلاف بگوید)

```
amount_rial = round(total_rate_rial × driver_qty × absorb_pct/100)
```

- اجرا: `applyOverhead` → JE **PRD-05** Dr WIP / Cr `5203`
- واقعی به کنترل: **PRD-06** → `5202`
- بستن: **PRD-22** انتقال جذب + انحراف حجم

دستمزد مستقیم مسیر جدا (`monthly_labor_rate_rial` / PRD-03) است و نباید داخل بودجه سربار تکرار شود.

## نقشه محرک → منبع مقدار

| محرک | محاسبه | ورودی حیاتی | شکاف |
|------|--------|-------------|------|
| `output_qty` | `qtyStarted` | رسید/مرحله | — |
| `direct_labor_rial` | `laborRial / 1e6` | ctx فراخوان | بدون fallback DB |
| `direct_labor_hours` | laborHours → SUM entries → ops | `production_labor_entries` / BOM ops | `engine.js` معمولاً `ops`/`laborHours` نمی‌دهد |
| `machine_hours` | machineMinutes → ops → BOM | `bom_operations.machine_minutes_per_unit` | همان؛ advanced سخت‌گیر (`E_NO_MACHINE_TIME`)، ساده صفر نرم |
| `material_rial` | `matRial / 1e6` | ctx مواد | — |
| `manual` | `manualDriverQty \|\| po.manual_driver_qty` | سفارش | **ستون/API وجود ندارد** (فقط خواندن در `overhead.js`) |

Alias: `labor_rial`→`direct_labor_rial`, `labor_hours`/`hours`→`direct_labor_hours`, `qty`/`output`→`output_qty`.

## گراف فراخوان

- مسیر ساده: `engine.js` `postReceiptFixed` / `postReceiptVariable` → `applyOverhead` → `computeDriverQty`
- مسیر پیشرفته: `engine-advanced.js` `applyStageOverhead` → `bom-advanced.stageDriverQty` (**کد جدا**)
- نرخ: `routes/production-cost-centers.js` `persistRate` → `computePredeterminedRates`
- bootstrap: میانگین هزینه tagged ÷ `qty_produced` (محرک از `cost_centers.driver`)

## ناسازگاری‌های رفتاری (باید در ADR قفل شوند)

1. `previewReceiptFixed` و `rollUpBom` گاهی `absorb_pct` را نادیده می‌گیرند؛ مسیر apply اعمال می‌کند.
2. `machine_hours`: advanced خطا، simple صفر خاموش.
3. محرک `manual` در UI و seed (مثلاً CC-90) هست ولی persist روی سفارش ندارد.
4. جادوی برش ظرفیت نرمال را روی `budget_driver_qty` می‌نویسد و driver را به `output_qty` می‌چسباند — باید فقط در پنل D برش بماند.

## تست‌های موجود

- `server/scripts/test-overhead-rates-v299.js` — نرخ ازپیش‌تعیین، alias، absorb، ظرفیت برش
- `server/scripts/test-production-overhead-labor.js` — بیشتر `stageDriverQty`؛ پوشش ضعیف `computeDriverQty` برای hours/machine/manual و رسید واقعی

## تصمیم باز (قبل از کد)

| گزینه | معنی |
|-------|------|
| **1** | جداسازی UI/API لایه‌های A/B/C/D + بستن شکاف schema/wiring؛ همان فرمول `total × qty × absorb` |
| **2** | علاوه بر ۱: جذب ثابت بر ظرفیت نرمال و متغیر بر استفاده واقعی (IAS 2 بند ۱۳ خالص) + مهاجرت/رگرسیون بستن دوره |

## فاز پیشنهادی پس از انتخاب

1. ADR قفل‌شده (این سند → ADR-00N)
2. Schema: `production_orders.manual_driver_qty` (+ sync tables/backfill در صورت نیاز)
3. Wiring: `engine.js` پاس‌دادن `ops` / ساعات / دقیقه ماشین برای محرک‌های زمانی
4. UI: پنل پویا per-driver؛ جداسازی بصری A/B/C
5. تست طلایی ۶ محرک + رگرسیون v299 / P4
6. Help + CHANGE-LOG + deploy

## استاندارد خارجی

- IAS 2 §§12–13: سربار ثابت بر ظرفیت نرمال؛ متغیر بر استفاده واقعی؛ کم‌جذبی → هزینه دوره
- الگوی مرجع: ERPNext workstation×hours؛ ECOSIRE Overhead Allocation Rule (pool / driver / run)
- ADR پول/JE موجود: `PROD-ACC-ADR-001-locked-assumptions.md` (ریال صحیح، بدون LWW روی JE)
