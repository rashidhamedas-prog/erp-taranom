# accounting-events.md
## کاتالوگ رویدادهای حسابداری تولید (PRD-01 … PRD-99)

> **مرجع قطعی نگاشت رویداد → سند.** هر خط کدی که `postToLedger` صدا می‌زند باید به یکی از این کدها ارجاع دهد.

---

## ۰. قواعد عمومی

| قاعده | شرح |
|-------|-----|
| `sourceType` | همیشه با `production_` شروع می‌شود |
| `sourceId` | شناسه رکورد تراکنشی (نه سفارش) — مگر جایی که تصریح شده |
| `voucherType` | همیشه `'auto'` |
| `status` | همیشه `'approved'` |
| ورودی مبلغ | **تومان** (`rial / 10`) — `postToLedger` خودش `tomanToRial` می‌زند |
| کد حساب | **هرگز Hard-code** — همیشه `acct(db, 'coa_*')` |
| تفصیلی | فقط در حالت `extended`/`mahak` — در `legacy` مقدار `null` |
| تراز | `validateBalancedLines` داخل `postToLedger` — اختلاف > ۰.۵ تومان → خطا |
| گرد کردن | `plug()` اختلاف ≤ ۱ ریال را به سطر آخر تحمیل می‌کند (R-10) |

---

## ۱. جدول خلاصه ۲۳ رویداد

| کد | نام | بدهکار | بستانکار | ماژول | `sourceType` |
|----|-----|--------|----------|:-----:|--------------|
| `PRD-01` | مصرف/حواله مواد | `1111` | `1110` + `1112` | ۲،۳،۷،۸ | `production_material_issue` |
| `PRD-02` | برگشت مواد | `1110` + `1112` | `1111` | ۳،۸ | `production_material_return` |
| `PRD-03` | جذب دستمزد مستقیم | `1111` | `5201` | ۲،۳،۷،۸ | `production_labor` |
| `PRD-04` | ثبت دستمزد واقعی | `5201` | `2104` | همه | `production_labor_actual` |
| `PRD-05` | جذب سربار | `1111` | `5203` | ۲،۳،۷،۸ | `production_overhead` |
| `PRD-06` | تجمیع سربار واقعی | `5202` | `1101`/`1102`/`2101`/`2104`/`6105` | همه | `production_overhead_actual` |
| `PRD-07` | رسید کالای ساخته‌شده | `1104` | `1111` | ۲،۳،۷،۸ | `production_receipt` |
| `PRD-08` | ضایعات عادی | **بدون سند** | — | — | — |
| `PRD-09` | ضایعات غیرعادی | `5221` | `1111` | ۲،۳،۷،۸ | `production_waste` |
| `PRD-10` | ضایعات قابل فروش | `1113` | `1111` | ۲،۳،۷،۸ | `production_scrap` |
| `PRD-11` | دوباره‌کاری عادی | `1111` | `1110`+`5201`+`5203` | ۷،۸ | `production_rework` |
| `PRD-12` | دوباره‌کاری غیرعادی | `5222` | `1110`+`5201`+`5203` | ۷،۸ | `production_rework` |
| `PRD-13` | ارسال به پیمانکار | `1114` | `1111` | ۷،۸ | `production_subcontract_out` |
| `PRD-14` | دریافت از پیمانکار | `1111`+`1108` | `1114`+`2101` | ۷،۸ | `production_subcontract_in` |
| `PRD-15` | انتقال بین مراحل | **بدون سند** (ADR-012) | — | — | — |
| `PRD-16` | محصول فرعی/همزاد | `1104`/`1113` | `1111` | ۷،۸ | `production_byproduct` |
| `PRD-17` | تعدیل موجودی مواد (انبارگردانی) | `1110` یا `5223` | معکوس | همه | `production_stock_adjust` |
| `PRD-18` | فروش ضایعات | `1103`/`1101` | `1113` + `4102` | — | `scrap_sale` |
| `PRD-20` | بستن انحراف مواد | **بدون سند** (ADR-011) | — | — | — |
| `PRD-21` | بستن انحراف دستمزد | `5212`/`5213` ⇄ `5201` | — | بستن ماه | `production_close_labor` |
| `PRD-22` | بستن انحراف سربار | `5214`/`5215` ⇄ `5202`/`5203` | — | بستن ماه | `production_close_overhead` |
| `PRD-23` | تسهیم انحراف | `1111`+`1104`+`5101` ⇄ `521x` | — | بستن ماه | `production_close_allocate` |
| `PRD-99` | ابطال (Reversal) | معکوس سند اصلی | — | همه | `*_reversal` |

---

## ۲. شرح تفصیلی هر رویداد

### PRD-01 — مصرف/حواله مواد به تولید

| | |
|-|-|
| **محرک** | ثبت رسید (ماژول ۲/۷ — Backflush) یا ثبت حواله (ماژول ۳/۸ — واقعی) |
| **مبلغ** | ماژول ۲/۷: `Σ qty_standard × average_cost_rial` · ماژول ۳/۸: `Σ qty_actual × average_cost_rial` |
| **`sourceId`** | `production_orders.id` (تک‌مرحله‌ای) یا `production_order_stages.id` (چندمرحله‌ای) |

```
1111 کالای در جریان ساخت   بد   Σ (مواد + بسته‌بندی)   [تفصیلی: سفارش]
   1110 موجودی مواد اولیه       بس   Σ مواد            [تفصیلی: کالا]
   1112 موجودی مواد بسته‌بندی    بس   Σ بسته‌بندی        [تفصیلی: کالا]
```

**پیش‌شرط‌ها:**
- `products.average_cost_rial > 0` برای هر ماده → وگرنه `E_ZERO_AVG_COST`
- موجودی کافی → وگرنه `E_NEGATIVE_STOCK`
- دوره باز + سال مالی باز

**عوارض جانبی:**
- `warehouse_stock.qty -= qty` · `products.stock -= qty`
- `stock_logs` ثبت شود
- `checkReorderPoint()` → رویداد `production.stock.below_reorder`
- `production_material_issues` رکورد + `je_id`

---

### PRD-02 — برگشت مواد از تولید

| | |
|-|-|
| **محرک** | حواله با `qty_actual < 0` یا endpoint `/return` |
| **مبلغ** | `qty × unit_cost_rial(سند حواله اصلی)` — ⚠️ **نه** میانگین جاری |

```
1110 موجودی مواد اولیه      بد   Σ مواد
1112 موجودی مواد بسته‌بندی   بد   Σ بسته‌بندی
   1111 کالای در جریان ساخت      بس   جمع    [تفصیلی: سفارش]
```

> **چرا نرخ سند اصلی؟** اگر بین حواله و برگشت خرید جدیدی شده و میانگین بالا رفته، برگشت به میانگین جدید یعنی WIP کمتر از آنچه بدهکار شده بستانکار می‌شود → مانده کاذب. نرخ اصلی اثر حواله را دقیقاً خنثی می‌کند.

**تفکیک از `PRD-99`:**
| | PRD-02 برگشت | PRD-99 ابطال |
|-|--------------|--------------|
| معنی | مواد **واقعاً** به انبار برگشت | **اشتباه ثبت** خنثی شد |
| تاریخ | تاریخ برگشت واقعی | تاریخ امروز |
| رکورد | رکورد **جدید** | `status='reversed'` روی اصلی |

---

### PRD-03 — جذب دستمزد مستقیم

| | |
|-|-|
| **محرک** | ثبت رسید/خروجی مرحله |
| **مبلغ** | طبق `bom_operations.labor_method` (§۵.۱ ماژول ۴) |

```
1111 کالای در جریان ساخت   بد   دستمزد جذب‌شده   [تفصیلی: سفارش]
   5201 کنترل دستمزد مستقیم    بس                [تفصیلی: مرکز هزینه]
```

| روش | فرمول |
|-----|-------|
| `piece` | `labor_rate_rial × qty_in` |
| `hourly` | `labor_rate_rial × ((setup + run × qty) / 60 × crew_size)` |
| `monthly` | `cost_center_rates.monthly_labor_rate_rial × qty_in` (نرخ برآوردی) |
| `contract` | **۰** — به `5230`/`1114` می‌رود، نه اینجا |

---

### PRD-04 — ثبت دستمزد واقعی

| | |
|-|-|
| **محرک** | ایجاد `payroll_records` برای پرسنلی که `persons.cost_center_id` دارد |
| **مبلغ** | `payroll_records.gross_pay × 10` (⚠️ **تومان → ریال**) |

```
اگر cost_centers.kind = 'production':
   5201 کنترل دستمزد مستقیم   بد   دستمزد واقعی   [تفصیلی: مرکز هزینه]
      2104 بدهی حقوق و بیمه         بس

اگر cost_centers.kind = 'service' (سرکارگر، QC):
   5202 کنترل سربار ساخت      بد   حقوق غیرمستقیم [تفصیلی: مرکز هزینه]
      2104 بدهی حقوق و بیمه         بس
```

> **مانده `5201` = انحراف نرخ دستمزد** → پایان ماه با PRD-21 بسته می‌شود.

---

### PRD-05 — جذب سربار

| | |
|-|-|
| **محرک** | ثبت رسید/خروجی مرحله |
| **مبلغ** | `cost_center_rates.total_rate_rial × driver_qty` |

```
1111 کالای در جریان ساخت   بد   سربار جذب‌شده   [تفصیلی: سفارش]
   5203 سربار جذب‌شده          بس                [تفصیلی: مرکز هزینه]
```

**محرک‌ها (§۵.۲ ماژول ۴):**
| محرک | `driver_qty` |
|------|--------------|
| `output_qty` | تعداد ورودی مرحله |
| `direct_labor_rial` | دستمزد ÷ ۱٬۰۰۰٬۰۰۰ |
| `direct_labor_hours` | `(setup + run × qty) / 60 × crew` |
| `machine_hours` | `machine_minutes × qty / 60` |
| `material_rial` | مواد ÷ ۱٬۰۰۰٬۰۰۰ — ⚠️ **ماژول ۸: مواد واقعی** |
| `manual` | ورودی کاربر |

---

### PRD-06 — تجمیع سربار واقعی

| | |
|-|-|
| **محرک** | ثبت `expense_payments` با `is_overhead=1` · حقوق غیرمستقیم · استهلاک |
| **مبلغ** | `expense_payments.amount × 10` (⚠️ **REAL تومان → ریال**) |

```
5202 کنترل سربار ساخت   بد   هزینه واقعی   [تفصیلی: مرکز هزینه]
   1101 صندوق / 1102 بانک      بس           (پرداخت نقدی)
   2101 حساب‌های پرداختنی        بس           (نسیه)
   2104 بدهی حقوق                بس           (حقوق غیرمستقیم)
   6105 استهلاک انباشته          بس           (استهلاک ماشین‌آلات)
```

**تسهیم چندمرکزی:** اگر هزینه به چند مرکز مربوط است (اجاره کارگاه)، `overhead_allocation_rules` + `overhead_allocation_weights` آن را تقسیم می‌کنند و **چند سطر بدهکار** با تفصیلی‌های مختلف ساخته می‌شود.

---

### PRD-07 — رسید کالای ساخته‌شده

| | |
|-|-|
| **محرک** | تکمیل سفارش / `finalize` |
| **مبلغ** | **`WIP_net` دقیق** — نه `unit_cost × qty` (قاعده طلایی R-10) |

```
1104 موجودی کالای ساخته‌شده   بد   WIP_net   [تفصیلی: کالا]
   1111 کالای در جریان ساخت       بس         [تفصیلی: سفارش]
```

**عوارض جانبی:**
```
prev_qty = products.stock ; prev_avg = products.average_cost_rial
new_qty  = prev_qty + qty
new_avg  = round((prev_qty × prev_avg + WIP_net) / new_qty)

UPDATE products SET stock=new_qty, average_cost_rial=new_avg,
                    cost=new_avg/10, last_prod_cost_rial=round(WIP_net/qty)
UPDATE warehouse_stock SET qty = qty + qty
INSERT stock_logs
```
**Snapshot برای Undo:** `production_receipts.prev_avg_rial`, `prev_stock_qty`, `new_avg_rial`

---

### PRD-08 — ضایعات عادی

> **✅ هیچ سندی. عمداً.**

**دلیل:** ضایعات عادی بخشی از بهای تولید سالم است. با کم شدن `qty_produced`، بهای واحد خودکار بالا می‌رود و هزینه توسط محصولات سالم جذب می‌شود.

**ثبت:** فقط رکورد در `production_waste` با `waste_type='normal'` و `je_id = NULL` — برای گزارش.

**سقف:** `allowed = qty_in × op.normal_waste_percent / 100`
مازاد بر سقف → **خودکار به `abnormal` تبدیل** → PRD-09 + هشدار مدیر.

---

### PRD-09 — ضایعات غیرعادی

| | |
|-|-|
| **مبلغ** | `round(cost_per_started × qty_abnormal)` |
| **`cost_per_started`** | `WIP_gross / qty_started` (تک‌مرحله‌ای) یا `cost_gross / qty_in` (مرحله‌ای) |

```
5221 هزینه ضایعات غیرعادی   بد   مبلغ
   1111 کالای در جریان ساخت      بس         [تفصیلی: سفارش]
```

> **⚠️ هرگز تسهیم نمی‌شود** (ADR-005) — ۱۰۰٪ هزینه دوره. در محاسبه موجودی پایان دوره نمی‌آید.

**منابع `qty_abnormal`:**
1. ورودی مستقیم کاربر
2. مازاد بر سقف عادی (خودکار)
3. `qty_lost` نزد پیمانکار (PRD-14)
4. `qty_failed` دوباره‌کاری

---

### PRD-10 — ضایعات قابل فروش

```
1113 موجودی ضایعات قابل فروش   بد   Σ (qty × nrv_unit_rial)   [تفصیلی: کالا]
   1111 کالای در جریان ساخت         بس                        [تفصیلی: سفارش]
```

**عوارض جانبی:** کالای ضایعات وارد `WH-SCRAP` می‌شود · `average_cost_rial = nrv_unit_rial`

**پیش‌شرط:** `scrap_product_id` معتبر + `nrv_unit_rial > 0` → وگرنه `E_SCRAP_NO_PRODUCT`

---

### PRD-11 / PRD-12 — دوباره‌کاری

```
عادی (PRD-11):
1111 کالای در جریان ساخت   بد   هزینه دوباره‌کاری   [تفصیلی: سفارش]
   1110 موجودی مواد اولیه      بس   مواد اضافی
   5201 کنترل دستمزد           بس   دستمزد اضافی    [تفصیلی: مرکز]
   5203 سربار جذب‌شده          بس   سربار اضافی     [تفصیلی: مرکز]

غیرعادی (PRD-12):
5222 هزینه دوباره‌کاری      بد   هزینه دوباره‌کاری
   1110 / 5201 / 5203          بس   (همان تفکیک)
```

**طبقه‌بندی:** `settings.production_rework_normal_threshold_pct` (پیش‌فرض ۲٪ از `qty_started`)
**حد:** حداکثر ۳ دور → `E_REWORK_LIMIT`
**نتیجه:** `qty_recovered` → برگشت به `qty_in` مرحله · `qty_failed` → PRD-09

---

### PRD-13 — ارسال به پیمانکار

| | |
|-|-|
| **مبلغ** | `stage.cost_in_rial / stage.qty_in × qty_sent` |

```
1114 موجودی نزد پیمانکار   بد   بهای کالای ارسالی   [تفصیلی: تأمین‌کننده]
   1111 کالای در جریان ساخت     بس                  [تفصیلی: سفارش]
```

> **چرا سند دارد؟** (بر خلاف انتقال بین مراحل) — کالا واقعاً از تصرف شرکت خارج می‌شود.
> الزام حسابرسی + بیمه + مطالبه در صورت عدم برگشت.

---

### PRD-14 — دریافت از پیمانکار

```
تعاریف:
   returned  = qty_received + qty_waste_normal
   amount_returned = amount_sent × returned / qty_sent
   amount_lost     = amount_sent × qty_lost / qty_sent
   fee = op.subcontract_fee_rial × qty_sent
   vat = fee × vat_rate   (اگر پیمانکار مؤدی)

1111 کالای در جریان ساخت      بد   amount_returned + fee   [تفصیلی: سفارش]
1108 مالیات ارزش افزوده       بد   vat
   1114 موجودی نزد پیمانکار       بس   amount_returned + amount_lost  [تفصیلی: تأمین‌کننده]
   2101 حساب‌های پرداختنی         بس   fee + vat                      [تفصیلی: تأمین‌کننده]

[اگر qty_lost > 0 — سند جداگانه PRD-09:]
5221 هزینه ضایعات غیرعادی     بد   amount_lost
   1111 کالای در جریان ساخت       بس
```

> ⚠️ **کسری نزد پیمانکار همیشه غیرعادی است.** اگر قرارداد ضایعات مجاز دارد → در `op.normal_waste_percent` بیاور، نه در `qty_lost`.
> **کنترل:** پس از دریافت، مانده `1114` سفارش باید **صفر** باشد → وگرنه `E_SUBCON_RESIDUAL`.

---

### PRD-15 — انتقال بین مراحل

> **✅ هیچ سندی. عمداً (ADR-012).**

`1111` بدهکار و `1111` بستانکار = سند خنثی بی‌فایده.
انتقال فقط در `production_order_stages` ثبت می‌شود:
```
next.qty_in           = current.qty_out
next.material_in_rial = current.cost_out_rial
next.status           = 'in_progress'
```

---

### PRD-16 — محصول فرعی / همزاد

```
by-product با NRV:
1104 موجودی کالای ساخته‌شده   بد   qty × nrv_rial   [تفصیلی: کالا]
   1111 کالای در جریان ساخت       بس                [تفصیلی: سفارش]

scrap با NRV:
1113 موجودی ضایعات قابل فروش  بد   qty × nrv_rial
   1111                            بس

co-product با share → همان PRD-07 با مبلغ سهم
```

**کنترل:** `Σ by_credit ≤ WIP_final` → وگرنه `E_NRV_EXCEEDS_WIP`

---

### PRD-17 — تعدیل موجودی مواد (انبارگردانی)

```
اضافی (موجودی فیزیکی > سیستم):
1110 موجودی مواد اولیه   بد   qty × average_cost_rial
   5223 مازاد انبارگردانی    بس

کسری (موجودی فیزیکی < سیستم):
5223 کسری انبارگردانی    بد   qty × average_cost_rial
   1110 موجودی مواد اولیه    بس
```

> این رویداد از ماژول `stocktaking` موجود می‌آید، ولی چون **مصرف واقعی نامرئی** را آشکار می‌کند، در تحلیل انحراف تولید مهم است.
> **در آنالیز ثابت (ماژول ۲/۷)** کسری انبارگردانی معمولاً بالاست — چون مصرف مازاد ثبت نمی‌شود. این خودش دلیلی برای مهاجرت به آنالیز متغیر است.

---

### PRD-18 — فروش ضایعات

```
1103 حساب‌های دریافتنی / 1101 صندوق   بد   قیمت فروش
   1113 موجودی ضایعات قابل فروش           بس   بهای دفتری (NRV)
   4102 درآمد فروش ضایعات                 بس   سود (اگر قیمت > NRV)
```
اگر قیمت < NRV → زیان به `5224 زیان فروش ضایعات`.

---

### PRD-21 — بستن انحراف دستمزد (پایان ماه)

```
مانده 5201 پس از همه PRD-03 و PRD-04:
   بدهکار → واقعی > جذب‌شده → انحراف نامساعد
   بستانکار → واقعی < جذب‌شده → انحراف مساعد

نامساعد:
5212 انحراف نرخ دستمزد     بد   مانده
   5201 کنترل دستمزد           بس   ← صفر می‌شود

مساعد:
5201 کنترل دستمزد          بد   مانده  ← صفر می‌شود
   5212 انحراف نرخ دستمزد      بس
```

**تفکیک نرخ/کارایی (فقط اگر `production_labor_entries.std_hours` پر باشد):**
```
انحراف نرخ     = (نرخ واقعی − نرخ استاندارد) × ساعت واقعی      → 5212
انحراف کارایی  = (ساعت واقعی − ساعت استاندارد) × نرخ استاندارد → 5213
```

---

### PRD-22 — بستن انحراف سربار (پایان ماه)

```
گام ۱ — انتقال جذب‌شده به کنترل:
5203 سربار جذب‌شده      بد   Σ جذب‌شده  ← صفر می‌شود
   5202 کنترل سربار        بس

گام ۲ — مانده 5202 = واقعی − جذب‌شده:
   بدهکار → کسر جذب (Under-applied) → نامساعد
   بستانکار → اضافه جذب (Over-applied) → مساعد

کسر جذب:
5215 انحراف حجم سربار    بد   مانده
   5202 کنترل سربار          بس   ← صفر می‌شود

اضافه جذب:
5202 کنترل سربار         بد   مانده  ← صفر می‌شود
   5215 انحراف حجم سربار      بس
```

**تفکیک بودجه/حجم (فقط اگر `budget_fixed_oh_rial` و `budget_var_oh_rial` پر باشند):**
```
انحراف بودجه = واقعی − (بودجه ثابت + نرخ متغیر × محرک واقعی)   → 5214
انحراف حجم   = بودجه ثابت − (نرخ ثابت × محرک واقعی)            → 5215
```

**کنترل نهایی:** `5201`, `5202`, `5203` همه باید **صفر** شوند → وگرنه `E_CONTROL_NOT_ZERO`.

---

### PRD-23 — تسهیم انحراف (پایان ماه — ADR-005) ⭐

**پایه تسهیم:**
```
Bucket A — WIP پایان دوره  : مبلغ «جزء مربوطه» در سفارش‌های باز
Bucket B — کالای ساخته‌شده : مبلغ «جزء مربوطه» در تولید ماه که فروش نرفته
Bucket C — COGS ماه         : مبلغ «جزء مربوطه» در فروش‌رفته

برای انحراف دستمزد → پایه = دستمزد جذب‌شده در هر سطل
برای انحراف سربار  → پایه = سربار جذب‌شده در هر سطل

سهم[سطل] = انحراف کل × پایه[سطل] / Σ پایه‌ها
```

**قاعده آستانه:**
```
اگر |انحراف کل| < بهای تولید ماه × settings.production_variance_threshold_pct / 100
   → همه به COGS  (روش direct_cogs)
وگرنه
   → تسهیم (روش proration)
```

**سند (انحراف نامساعد):**
```
1111 کالای در جریان ساخت      بد   سهم WIP
1104 موجودی کالای ساخته‌شده   بد   سهم FG
5101 بهای تمام‌شده کالای فروش‌رفته بد سهم COGS
   5212/5213/5214/5215 انحراف       بس   کل    ← صفر می‌شود
```

**سند (انحراف مساعد):** معکوس.

**عوارض جانبی حیاتی:**
```
سهم FG باید بین کالاهای موجود پایان دوره سرشکن شود
→ products.average_cost_rial هر کالا به‌روزرسانی شود:

   share_i  = fg_value_i / Σ fg_value
   delta_i  = سهم_FG × share_i
   new_avg_i = round((stock_i × avg_i + delta_i) / stock_i)
```

**استثناها (هرگز تسهیم نمی‌شوند):**
- ضایعات غیرعادی (`5221`)
- دوباره‌کاری غیرعادی (`5222`)
- انحراف مواد (`5210`/`5211`) — اصلاً وجود ندارد (ADR-011)

---

### PRD-99 — ابطال (Reversal)

```
برای هر سطر سند اصلی:
   سطر جدید با debit ⇄ credit جابه‌جا
   description = 'ابطال — ' + توضیح اصلی
   detail_account_id حفظ می‌شود
   date = امروز (نه تاریخ سند اصلی)
   sourceType = <sourceType اصلی> + '_reversal'
   sourceId = شناسه رکورد اصلی
```

**عوارض جانبی:**
```
production_*.status = 'reversed'
production_*.reversed_je_id = <شناسه سند معکوس>
موجودی و میانگین موزون بازگردانده شوند (از snapshot)
recomputeOrderTotals(orderId)
```

**ترتیب اجباری Reversal یک سفارش:**
```
۱) PRD-07 رسید FG        (چک: FG فروخته نشده باشد)
۲) PRD-16 محصول فرعی
۳) PRD-10 ضایعات فروشی
۴) PRD-09 ضایعات غیرعادی
۵) PRD-05 سربار
۶) PRD-03 دستمزد
۷) PRD-14 دریافت پیمانکار   ⚠️ ترتیب مهم
۸) PRD-13 ارسال پیمانکار
۹) PRD-01 حواله مواد
```
در حالت چندمرحله‌ای: از **آخرین مرحله به اولین**.

---

## ۳. جدول تفصیلی‌گذاری (حالت `extended`/`mahak`)

| حساب | نوع تفصیلی | `allocTafsili` kind |
|------|-----------|---------------------|
| `1111` WIP | سفارش تولید | `production_order` |
| `1110` مواد اولیه | کالا | `product` |
| `1112` بسته‌بندی | کالا | `product` |
| `1104` کالای ساخته‌شده | کالا | `product` |
| `1113` ضایعات فروشی | کالا | `product` |
| `1114` نزد پیمانکار | تأمین‌کننده | `supplier` |
| `5201` کنترل دستمزد | مرکز هزینه | `cost_center_lb` |
| `5202` کنترل سربار | مرکز هزینه | `cost_center_oh` |
| `5203` سربار جذب‌شده | مرکز هزینه | `cost_center_oh` |
| `5221` ضایعات غیرعادی | مرکز هزینه | `cost_center_oh` |
| `2101` پرداختنی | تأمین‌کننده | `supplier` |
| `2104` بدهی حقوق | شخص | `person` |

> در حالت `legacy` (۴ رقمی مسطح) همه `detail_account_id = null` — کد باید هر دو را پشتیبانی کند.

---

## ۴. ماتریس رویداد × ماژول

| رویداد | ۱ BOM | ۲ ثابت | ۳ متغیر | ۴ BOM+ | ۵ برآورد | ۶ گزارش | ۷ ثابت+ | ۸ متغیر+ | بستن ماه |
|--------|:-----:|:------:|:-------:|:------:|:--------:|:-------:|:-------:|:--------:|:--------:|
| PRD-01 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-02 | ❌ | ⚪ | ✅ | ❌ | ❌ | ❌ | ⚪ | ✅ | ❌ |
| PRD-03 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-04 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-05 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-06 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-07 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-09 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-10 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-11/12 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-13/14 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-16 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| PRD-17 | ❌ | ⚪ | ⚪ | ❌ | ❌ | ❌ | ⚪ | ⚪ | ❌ |
| PRD-21/22/23 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| PRD-99 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

⚪ = ممکن ولی نادر

---

## ۵. کنترل‌های سلامت (اجرا در health-check)

```sql
-- C1: هر تراکنش posted باید je_id داشته باشد
SELECT 'material_issue' t, id FROM production_material_issues WHERE status='posted' AND je_id IS NULL
UNION ALL SELECT 'labor',    id FROM production_labor_entries         WHERE status='posted' AND je_id IS NULL
UNION ALL SELECT 'overhead', id FROM production_overhead_applications WHERE status='posted' AND je_id IS NULL
UNION ALL SELECT 'receipt',  id FROM production_receipts              WHERE status='posted' AND je_id IS NULL
UNION ALL SELECT 'waste',    id FROM production_waste
          WHERE status='posted' AND je_id IS NULL AND waste_type <> 'normal'   -- عادی سند ندارد ✅
UNION ALL SELECT 'subcontract', id FROM production_subcontract        WHERE status='posted' AND je_id IS NULL;
-- باید خالی باشد

-- C2: هیچ سند انتقال بین مراحل نباشد (ADR-012)
SELECT id, ref_type FROM journal_entries WHERE ref_type LIKE '%stage_transfer%';
-- باید خالی باشد

-- C3: هیچ سند انحراف مواد نباشد (ADR-011)
SELECT jl.entry_id, jl.account_code FROM journal_lines jl
WHERE jl.account_code IN (
  (SELECT COALESCE((SELECT value FROM settings WHERE key='coa_var_material_price'),'5210')),
  (SELECT COALESCE((SELECT value FROM settings WHERE key='coa_var_material_qty'),  '5211'))
);
-- باید خالی باشد

-- C4: همه اسناد تولیدی تراز باشند
SELECT je.id, je.voucher_number, SUM(jl.debit_rial) d, SUM(jl.credit_rial) c
FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
WHERE je.ref_type LIKE 'production_%' AND COALESCE(je.deleted_at,0)=0
GROUP BY je.id HAVING ABS(d - c) > 5;
-- باید خالی باشد

-- C5: حساب‌های کنترلی پس از بستن ماه صفر باشند
SELECT jl.account_code, SUM(jl.debit_rial) - SUM(jl.credit_rial) bal
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
WHERE jl.account_code IN ('5201','5202','5203')
  AND je.entry_date <= :end_of_closed_month AND COALESCE(je.deleted_at,0)=0
GROUP BY jl.account_code HAVING ABS(bal) > 5;
-- باید خالی باشد

-- C6: WIP سفارش‌های بسته‌شده صفر باشد
SELECT po.order_no, SUM(jl.debit_rial) - SUM(jl.credit_rial) wip
FROM production_orders po
JOIN journal_entries je ON je.ref_type LIKE 'production_%'
JOIN journal_lines jl   ON jl.entry_id = je.id AND jl.account_code = '1111'
                        AND jl.detail_account_id = po.coa_wip_tafsili
WHERE po.status='closed' AND COALESCE(je.deleted_at,0)=0
GROUP BY po.id HAVING ABS(wip) > 5;
-- باید خالی باشد

-- C7: مانده 1114 برای سفارش‌های بسته صفر باشد
SELECT po.order_no, SUM(jl.debit_rial) - SUM(jl.credit_rial) bal
FROM production_orders po
JOIN production_subcontract sc ON sc.order_id = po.id
JOIN journal_entries je ON je.id = sc.je_id
JOIN journal_lines jl   ON jl.entry_id = je.id AND jl.account_code = '1114'
WHERE po.status IN ('completed','closed') AND COALESCE(je.deleted_at,0)=0
GROUP BY po.id HAVING ABS(bal) > 5;
-- باید خالی باشد
```

---

## ۶. الگوی کد استاندارد

```js
// server/lib/production/posting.js — همه اسناد از این توابع رد می‌شوند

const { postToLedger } = require('../ledger');
const { acct } = require('../coa-map');

/** سطر بدهکار — ورودی ریال، خروجی تومان (چون postToLedger تومان می‌گیرد) */
function dr(db, key, rial, tafsili = null) {
  const a = acct(db, key);
  return { code: a.code, name: a.name, debit: rial / 10, credit: 0,
           detail_account_id: tafsili };
}

/** سطر بستانکار */
function cr(db, key, rial, tafsili = null) {
  const a = acct(db, key);
  return { code: a.code, name: a.name, debit: 0, credit: rial / 10,
           detail_account_id: tafsili };
}

/** حذف سطرهای صفر + تحمیل اختلاف گرد کردن به سطر آخر (R-10) */
function plug(lines) {
  const kept = lines.filter(l => (l.debit || 0) + (l.credit || 0) > 0);
  if (!kept.length) return kept;
  const d = kept.reduce((s, l) => s + (l.debit || 0), 0);
  const c = kept.reduce((s, l) => s + (l.credit || 0), 0);
  const diff = Math.round((d - c) * 10) / 10;              // تا ۱ ریال
  if (diff !== 0 && Math.abs(diff) <= 0.5) {
    const last = kept[kept.length - 1];
    if (last.credit) last.credit += diff; else last.debit -= diff;
  }
  return kept;
}

/** کاتالوگ رویداد — منبع واحد حقیقت */
const PRD = {
  'PRD-01': { name: 'مصرف مواد',            sourceType: 'production_material_issue' },
  'PRD-02': { name: 'برگشت مواد',           sourceType: 'production_material_return' },
  'PRD-03': { name: 'جذب دستمزد',           sourceType: 'production_labor' },
  'PRD-04': { name: 'دستمزد واقعی',         sourceType: 'production_labor_actual' },
  'PRD-05': { name: 'جذب سربار',            sourceType: 'production_overhead' },
  'PRD-06': { name: 'سربار واقعی',          sourceType: 'production_overhead_actual' },
  'PRD-07': { name: 'رسید تولید',           sourceType: 'production_receipt' },
  'PRD-09': { name: 'ضایعات غیرعادی',       sourceType: 'production_waste' },
  'PRD-10': { name: 'ضایعات قابل فروش',     sourceType: 'production_scrap' },
  'PRD-11': { name: 'دوباره‌کاری عادی',      sourceType: 'production_rework' },
  'PRD-12': { name: 'دوباره‌کاری غیرعادی',   sourceType: 'production_rework' },
  'PRD-13': { name: 'ارسال به پیمانکار',    sourceType: 'production_subcontract_out' },
  'PRD-14': { name: 'دریافت از پیمانکار',   sourceType: 'production_subcontract_in' },
  'PRD-16': { name: 'محصول فرعی',           sourceType: 'production_byproduct' },
  'PRD-17': { name: 'تعدیل انبارگردانی',    sourceType: 'production_stock_adjust' },
  'PRD-21': { name: 'بستن انحراف دستمزد',   sourceType: 'production_close_labor' },
  'PRD-22': { name: 'بستن انحراف سربار',    sourceType: 'production_close_overhead' },
  'PRD-23': { name: 'تسهیم انحراف',         sourceType: 'production_close_allocate' },
};

/** ثبت استاندارد یک رویداد */
function postEvent(db, { event, sourceId, date, description, createdBy, lines }) {
  const spec = PRD[event];
  if (!spec) throw new Error(`PRD event ناشناخته: ${event}`);
  const clean = plug(lines);
  if (!clean.length) return null;                          // سند صفر نزن
  const je = postToLedger(db, {
    sourceType: spec.sourceType, sourceId, date,
    description: description || spec.name, createdBy,
    lines: clean, voucherType: 'auto', status: 'approved',
  });
  return { event, je_id: je,
           amount_rial: Math.round(clean.reduce((s, l) => s + (l.debit || 0), 0) * 10) };
}

/** ابطال — PRD-99 */
function reverseEvent(db, { jeId, reason, userId }) {
  const orig = db.prepare(`
    SELECT jl.*, je.ref_type, je.ref_id, je.description
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.entry_id = ?`).all(jeId);
  if (!orig.length) throw err('E_NOT_FOUND', 404);

  return postToLedger(db, {
    sourceType: orig[0].ref_type + '_reversal',
    sourceId: orig[0].ref_id,
    date: todayJalali(),
    description: `ابطال — ${orig[0].description} — ${reason}`,
    createdBy: userId,
    lines: orig.map(l => ({
      code: l.account_code, name: l.account_name,
      debit:  l.credit_rial / 10,        // ⇄ جابه‌جایی
      credit: l.debit_rial  / 10,
      description: `ابطال — ${l.description || ''}`,
      detail_account_id: l.detail_account_id,
    })),
  });
}

module.exports = { dr, cr, plug, postEvent, reverseEvent, PRD };
```
