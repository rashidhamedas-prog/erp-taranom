# 04-advanced-formulas.md
## زیرگروه ۴ — فرمول‌های تولید پیشرفته (Advanced BOM + Routing + Co/By-Products)

---

## ۱. هدف ماژول

ماژول ۱ فقط جواب می‌داد: **«چه موادی؟»**
ماژول ۴ سه سؤال دیگر را هم جواب می‌دهد:

| سؤال | ابزار | جدول |
|------|-------|------|
| «چه موادی؟» | BOM | `bom_lines` (از ماژول ۱) |
| **«در چه مراحلی و با چه دستمزد و سرباری؟»** | **Routing** | `bom_operations` |
| **«چند نوع خروجی و بهایشان چطور تقسیم شود؟»** | **Co/By-Product** | `bom_outputs` |
| **«اجزای نیمه‌ساخته چطور؟»** | **Multi-Level** | `is_multilevel` + بازگشت |

**فرق کلیدی با ماژول ۱:** ماژول ۱ فقط **بهای مواد** را می‌داد. ماژول ۴ **بهای تمام‌شده کامل** (مواد + دستمزد + سربار) را قبل از تولید می‌دهد.

**کاربرد در ترنم:**
- خط واقعی ۷ مرحله‌ای: برش → گلدوزی → دوخت → یراق → شستشو → اتو → انبار
- هزینه شستشوی پیمانکاری در فرمول
- خرده پارچه به‌عنوان محصول فرعی با ارزش
- نیمه‌ساخته: «تنه دوخته‌شده» که در دو مدل مختلف استفاده می‌شود

---

## ۲. موجودیت‌ها

| جدول | نقش |
|------|-----|
| `bom_headers` | `is_multilevel=1`, `has_routing=1`, `has_coproducts=1` |
| `bom_lines` | + `stage_cost_center_id` اجباری |
| **`bom_operations`** | مراحل، زمان، دستمزد، ضایعات مرحله‌ای، پیمانکاری |
| **`bom_outputs`** | main / co / by / scrap + روش تسهیم بها |
| `cost_centers` | مرکز هر مرحله + محرک سربار |
| `cost_center_rates` | نرخ جذب سربار هر مرکز |

---

## ۳. روابط

```
bom_headers (1)
  ├──< bom_lines (N)        ──> cost_centers (stage_cost_center_id)
  ├──< bom_operations (N)   ──> cost_centers (cost_center_id)
  │                         ──> suppliers (subcontract_supplier_id)
  └──< bom_outputs (N)      ──> products
                            ──> cost_centers (stage_cost_center_id)

products (is_manufactured=1) ──> bom_headers  ← بازگشت چندسطحی
cost_centers (1) ──< cost_center_rates (N)  per period
```

**قیدها:**
- `UNIQUE(bom_id, seq)` روی `bom_operations`
- هر `bom_lines.stage_cost_center_id` باید در `bom_operations` همان BOM موجود باشد
- دقیقاً **یک** `bom_outputs` با `output_type='main'`
- مجموع `cost_share_percent` در خروجی‌های `main`+`co` = ۱۰۰

---

## ۴. سه مفهوم کلیدی

### ۴.۱ Routing — مسیر عملیات

هر مرحله (`operation`) شامل:

```
seq                       10, 20, 30 ...  (فاصله ۱۰ برای درج بعدی)
cost_center_id            مرکز هزینه (برش/دوخت/...)
setup_minutes             زمان آماده‌سازی — ثابت به‌ازای کل سفارش
run_minutes_per_unit      زمان اجرا — به‌ازای هر واحد
machine_minutes_per_unit  زمان ماشین (برای محرک machine_hours)
labor_method              piece | hourly | monthly | contract
labor_rate_rial           کارمزد هر عدد (piece/contract) یا نرخ ساعتی (hourly)
crew_size                 تعداد نفرات (برای hourly: ساعت × crew)
yield_percent             بازده مرحله
normal_waste_percent      ضایعات عادی مجاز مرحله
is_subcontract            ساخت خارج؟
subcontract_fee_rial      کارمزد پیمانکار هر عدد
is_qc_gate                ایست کنترل کیفیت
```

### ۴.۲ خروجی‌های چندگانه

| نوع | تعریف | مثال ترنم | روش بها |
|-----|-------|-----------|---------|
| **main** | محصول اصلی | مانتو ترمه | `share` — سهم از بها |
| **co** | محصول همزاد با ارزش قابل مقایسه | (در ترنم نادر) شال ست | `share` |
| **by** | محصول فرعی کم‌ارزش | ضایعات پارچه قابل فروش | `nrv` |
| **scrap** | ضایعات بدون ارزش | خاک و پرز | `zero` |

**روش‌های تسهیم:**
```
share : بها × (cost_share_percent / 100)
nrv   : qty × nrv_rial   ← از WIP کسر می‌شود، بقیه به main
fixed : qty × مبلغ ثابت
zero  : بدون ارزش
```

### ۴.۳ چندسطحی (Multi-Level)

```
مانتو ترمه (سطح ۰)
├── پارچه کتان        [خرید]
├── تنه دوخته‌شده     [ساخت] ← سطح ۱، BOM خودش
│   ├── پارچه کتان    [خرید]
│   ├── آستر          [خرید]
│   └── نخ            [خرید]
├── دکمه چوبی         [خرید]
└── لیبل              [خرید]
```

**دو حالت:**
| حالت | `products.is_manufactured` | رفتار |
|------|---------------------------|-------|
| نیمه‌ساخته واقعی | ۱ + انبار دارد | سفارش تولید جدا · وارد انبار می‌شود · بهای خودش |
| Phantom (مجازی) | ۱ + `bom_type='phantom'` | انبار ندارد · مستقیماً Explode می‌شود |

> **توصیه برای ترنم:** فعلاً Phantom استفاده کن، نه نیمه‌ساخته واقعی. نیمه‌ساخته واقعی سفارش تولید جدا، انبار جدا و WIP جدا می‌خواهد — پیچیدگی بی‌فایده برای مانتو.

---

## ۵. الگوریتم‌ها و فرمول‌ها

### ۵.۱ محاسبه دستمزد استاندارد هر مرحله

```
برای مرحله OP و تعداد Q:

  piece:
     labor = OP.labor_rate_rial × Q

  hourly:
     total_minutes = OP.setup_minutes + OP.run_minutes_per_unit × Q
     hours         = total_minutes / 60 × OP.crew_size
     labor         = round(OP.labor_rate_rial × hours)

  monthly:
     ← دستمزد ثابت ماهانه، تسهیم بر مبنای زمان استاندارد:
     share  = (OP.run_minutes_per_unit × Q) / total_stage_minutes_in_period
     labor  = round(monthly_pool[cc] × share)
     ← در برآورد: نرخ تخمینی از cost_center_rates.monthly_labor_rate_rial

  contract:
     ← دستمزد نیست، هزینه پیمانکاری است:
     fee   = OP.subcontract_fee_rial × Q     → به 5230، نه 5201
```

### ۵.۲ محاسبه سربار استاندارد هر مرحله

```
rate = cost_center_rates[OP.cost_center_id][period]
driver = OP.overhead_driver || cost_centers[cc].driver

driver_qty:
  output_qty         → Q
  direct_labor_rial  → labor(OP, Q) / 1,000,000
  direct_labor_hours → (OP.setup + OP.run × Q) / 60 × crew_size
  machine_hours      → OP.machine_minutes_per_unit × Q / 60
  material_rial      → Σ(bom_lines با stage=cc).amount / 1,000,000
  manual             → ورودی

overhead = round(rate.total_rate_rial × driver_qty)
```

### ۵.۳ انباشت بها در مسیر (Cost Roll-Up)

> **⚠️ قاعده ضد-دوباره‌شماری (V4-21):**
> وقتی `has_routing = 1`، فیلد `bom_headers.yield_percent` **نادیده گرفته و اجباراً ۱۰۰ می‌شود**.
> بازده و ضایعات فقط از `bom_operations` می‌آیند. در غیر این صورت ضایعات **دوبار** حساب می‌شود و بهای تمام‌شده متورم می‌گردد.
>
> `bom_lines.scrap_percent` (ضایعات سطح ماده) همچنان اعمال می‌شود — لایه متفاوتی است و تداخل ندارد.

```
qty_in[10]  = Q_start
for each OP in operations ordered by seq:
    y = OP.yield_percent / 100
    w = OP.normal_waste_percent / 100
    qty_out[op] = qty_in[op] × y × (1 − w)

    cost_in[op]    = (op == first) ? 0 : cost_out[prev]
    material[op]   = Σ(bom_lines WHERE stage_cost_center_id = OP.cost_center_id).amount
    labor[op]      = §5.1
    overhead[op]   = §5.2
    subcon[op]     = OP.is_subcontract ? OP.subcontract_fee_rial × qty_in[op] : 0

    cost_out[op]   = cost_in[op] + material[op] + labor[op] + overhead[op] + subcon[op]
    unit_out[op]   = cost_out[op] / qty_out[op]

    qty_in[next]   = qty_out[op]
```

> **نکته:** ضایعات مرحله‌ای، بها را **حذف نمی‌کند** — فقط تعداد کم می‌شود، پس `unit_out` بالا می‌رود. این همان جذب ضایعات عادی است. ✅

### ۵.۴ محاسبه معکوس تعداد شروع (Backward Yield)

```
اگر ۳۰۰ عدد سالم می‌خواهی، چند تا باید شروع کنی؟

  Q_start = Q_target / Π(over all OP) [ y[op] × (1 − w[op]) ]

مثال ترنم:
  برش    y=100%  w=2%    → 0.98
  گلدوزی y=100%  w=0%    → 1.00
  دوخت   y=100%  w=1%    → 0.99
  یراق   y=100%  w=0%    → 1.00
  شستشو  y=100%  w=1.5%  → 0.985
  اتو    y=100%  w=0%    → 1.00
  ────────────────────────────────
  Π = 0.98 × 1.00 × 0.99 × 1.00 × 0.985 × 1.00 = 0.955647

  Q_start = 300 / 0.955647 = 313.94 → ceil → 314 عدد
```

### ۵.۵ تسهیم بها بین خروجی‌ها

```
WIP_final = Σ all costs

۱) محصولات فرعی (by) و ضایعات (scrap) با nrv:
   by_credit = Σ (qty × nrv_rial)
   WIP_after_by = WIP_final − by_credit

۲) توزیع بین main و co با share:
   for each output O in (main, co):
      cost[O]      = round(WIP_after_by × O.cost_share_percent / 100)
      unit_cost[O] = cost[O] / qty[O]

۳) اختلاف گرد کردن → به main
   cost[main] += WIP_after_by − Σ cost[O]
```

**سه روش تسهیم `share` (انتخابی در `settings.production_coproduct_method`):**

| روش | فرمول `cost_share_percent` | کاربرد |
|-----|---------------------------|--------|
| `manual` | ورودی کاربر | پیش‌فرض — ساده و شفاف |
| `sales_value` | `(qty×price) / Σ(qty×price)` | وقتی قیمت فروش مبنای منطقی است |
| `physical` | `qty / Σ qty` | وقتی محصولات همگن‌اند |

### ۵.۶ Roll-Up چندسطحی

```
rollUpCost(productId, date, level=0):
   if level > 10: throw E_BOM_TOO_DEEP
   bom = resolveBom(productId, date)
   if !bom: return products[productId].average_cost_rial   ← خریدنی

   material = 0
   for L in bom.lines:
       comp = products[L.component_product_id]
       unit = comp.is_manufactured
              ? rollUpCost(L.component_product_id, date, level+1)
              : comp.average_cost_rial
       material += qty_final(L) × unit

   labor    = Σ labor(OP, bom.base_qty)
   overhead = Σ overhead(OP, bom.base_qty)
   subcon   = Σ subcontract(OP, bom.base_qty)

   total = material + labor + overhead + subcon
   by    = Σ (bom_outputs by/scrap: qty × nrv_rial)
   main_share = bom_outputs[main].cost_share_percent / 100

   return round((total − by) × main_share / bom_outputs[main].qty_per_base)
```

**حافظه‌سازی (Memoization):** نتیجه هر `productId` در یک `Map` کش شود — درخت‌های عمیق چندبار یک نیمه‌ساخته را می‌بینند.

---

## ۶. مثال کامل — فرمول پیشرفته «مانتو کتان ترمه»

### ۶.۱ تعریف Routing

| seq | مرکز | setup | run/عدد | ماشین/عدد | روش دستمزد | نرخ (ریال) | crew | بازده | ضایعات | محرک سربار | نرخ سربار |
|----:|------|------:|--------:|----------:|-----------|-----------:|-----:|------:|-------:|-----------|----------:|
| 10 | CC-10 برش | ۳۰ دق | ۱.۲ دق | ۰ | monthly | — | ۲ | ۱۰۰٪ | ۲٪ | `material_rial` | ۹٬۰۰۰/م.ریال |
| 20 | CC-20 گلدوزی | ۱۵ دق | ۳.۰ دق | ۳.۰ دق | piece | ۴۵٬۰۰۰ | ۱ | ۱۰۰٪ | ۰٪ | `machine_hours` | ۱٬۲۰۰٬۰۰۰/ساعت |
| 30 | CC-30 دوخت | ۲۰ دق | ۱۱.۰ دق | ۱۱.۰ دق | piece | ۱۸۰٬۰۰۰ | ۱ | ۱۰۰٪ | ۱٪ | `direct_labor_rial` | ۳۵۰٬۰۰۰/م.ریال |
| 40 | CC-40 یراق | ۵ دق | ۲.۵ دق | ۰ | piece | ۲۵٬۰۰۰ | ۱ | ۱۰۰٪ | ۰٪ | `output_qty` | ۸٬۰۰۰/عدد |
| 50 | CC-50 شستشو | ۰ | ۰.۵ دق | ۰ | contract | fee ۳۸٬۰۰۰ | — | ۱۰۰٪ | ۱.۵٪ | `output_qty` | ۵٬۰۰۰/عدد |
| 60 | CC-60 اتو | ۰ | ۲.۰ دق | ۰ | monthly | — | ۲ | ۱۰۰٪ | ۰٪ | `output_qty` | ۱۲٬۰۰۰/عدد |

**دستمزد ماهانه:** `cost_center_rates.monthly_labor_rate_rial` — برش ۲۵٬۰۰۰/عدد، اتو ۱۵٬۰۰۰/عدد (نرخ تسهیمی تخمینی)

### ۶.۲ تخصیص مواد به مراحل

| قلم | مرحله | مقدار/عدد | ضایعات |
|-----|-------|----------:|-------:|
| پارچه کتان | CC-10 برش | ۱.۶۰ متر | ۴٪ |
| آستر | CC-10 برش | ۰.۳۵ متر | ۳٪ |
| نخ | CC-30 دوخت | ۰.۰۸ قرقره | ۰٪ |
| دکمه | CC-40 یراق | ۶ عدد | ۲٪ |
| لیبل | CC-60 اتو | ۱ عدد | ۰٪ |
| نایلون | CC-60 اتو | ۱ عدد | ۰٪ |

### ۶.۳ خروجی‌ها

| نوع | کالا | مقدار/base | روش | سهم/NRV |
|-----|------|-----------:|-----|--------:|
| main | مانتو ترمه سبز | ۱ عدد | share | ۱۰۰٪ |
| by | خرده پارچه | ۰.۰۹ کیلو | nrv | ۱۲۰٬۰۰۰ ریال/کیلو |

### ۶.۴ محاسبه تعداد شروع

```
هدف: ۳۰۰ عدد سالم
Π(بازده × (۱−ضایعات)) = ۰.۹۸ × ۱.۰۰ × ۰.۹۹ × ۱.۰۰ × ۰.۹۸۵ × ۱.۰۰ = ۰.۹۵۵۶۴۷
Q_start = ۳۰۰ / ۰.۹۵۵۶۴۷ = ۳۱۳.۹۴ → ⌈⌉ = ۳۱۴ عدد
```

### ۶.۵ مواد به تفکیک مرحله (Q_start = 314، بازده سرفصل = ۱۰۰٪)

| مرحله | قلم | مقدار نهایی | نرخ (ریال) | مبلغ (ریال) |
|-------|-----|------------:|-----------:|------------:|
| CC-10 برش | پارچه کتان (۴٪) | ۵۲۳.۳۳۳۳ متر | ۹۵۰٬۰۰۰ | ۴۹۷٬۱۶۶٬۶۶۷ |
| CC-10 برش | آستر (۳٪) | ۱۱۳.۲۹۹۰ متر | ۱۸۰٬۰۰۰ | ۲۰٬۳۹۳٬۸۱۴ |
| CC-30 دوخت | نخ (۰٪) | ۲۵.۱۲۰۰ قرقره | ۸۵٬۰۰۰ | ۲٬۱۳۵٬۲۰۰ |
| CC-40 یراق | دکمه (۲٪) | ۱٬۹۲۲.۴۴۹۰ عدد | ۱۲٬۰۰۰ | ۲۳٬۰۶۹٬۳۸۸ |
| CC-60 اتو | لیبل (بسته‌بندی) | ۳۱۴ عدد | ۶٬۰۰۰ | ۱٬۸۸۴٬۰۰۰ |
| CC-60 اتو | نایلون (بسته‌بندی) | ۳۱۴ عدد | ۹٬۰۰۰ | ۲٬۸۲۶٬۰۰۰ |

### ۶.۶ جدول Roll-Up مرحله به مرحله ✅ *(راستی‌آزمایی‌شده)*

| مرحله | ورودی | خروجی | بهای ورودی | مواد | دستمزد | پیمانکاری | محرک | سربار | بهای خروجی | بهای واحد |
|-------|------:|------:|-----------:|-----:|-------:|----------:|-----:|------:|-----------:|----------:|
| **۱۰ برش** | ۳۱۴.۰۰ | ۳۰۷.۷۲ | ۰ | ۵۱۷٬۵۶۰٬۴۸۱ | ۷٬۸۵۰٬۰۰۰ | ۰ | ۵۱۷.۵۶ م.ر | ۴٬۶۵۸٬۰۴۴ | ۵۳۰٬۰۶۸٬۵۲۵ | ۱٬۷۲۲٬۵۶۸ |
| **۲۰ گلدوزی** | ۳۰۷.۷۲ | ۳۰۷.۷۲ | ۵۳۰٬۰۶۸٬۵۲۵ | ۰ | ۱۳٬۸۴۷٬۴۰۰ | ۰ | ۱۵.۳۹ ساعت | ۱۸٬۴۶۳٬۲۰۰ | ۵۶۲٬۳۷۹٬۱۲۵ | ۱٬۸۲۷٬۵۶۸ |
| **۳۰ دوخت** | ۳۰۷.۷۲ | ۳۰۴.۶۴ | ۵۶۲٬۳۷۹٬۱۲۵ | ۲٬۱۳۵٬۲۰۰ | ۵۵٬۳۸۹٬۶۰۰ | ۰ | ۵۵.۳۹ م.ر | ۱۹٬۳۸۶٬۳۶۰ | ۶۳۹٬۲۹۰٬۲۸۵ | ۲٬۰۹۸٬۴۹۱ |
| **۴۰ یراق** | ۳۰۴.۶۴ | ۳۰۴.۶۴ | ۶۳۹٬۲۹۰٬۲۸۵ | ۲۳٬۰۶۹٬۳۸۸ | ۷٬۶۱۶٬۰۷۰ | ۰ | ۳۰۴.۶۴ عدد | ۲٬۴۳۷٬۱۴۲ | ۶۷۲٬۴۱۲٬۸۸۵ | ۲٬۲۰۷٬۲۱۷ |
| **۵۰ شستشو** 🏭 | ۳۰۴.۶۴ | ۳۰۰.۰۷ | ۶۷۲٬۴۱۲٬۸۸۵ | ۰ | ۰ | ۱۱٬۵۷۶٬۴۲۶ | ۳۰۴.۶۴ عدد | ۱٬۵۲۳٬۲۱۴ | ۶۸۵٬۵۱۲٬۵۲۵ | ۲٬۲۸۴٬۴۸۵ |
| **۶۰ اتو** ✅ | ۳۰۰.۰۷ | ۳۰۰.۰۷ | ۶۸۵٬۵۱۲٬۵۲۵ | ۴٬۷۱۰٬۰۰۰ | ۴٬۵۰۱٬۰۹۷ | ۰ | ۳۰۰.۰۷ عدد | ۳٬۶۰۰٬۸۷۸ | **۶۹۸٬۳۲۴٬۵۰۰** | ۲٬۳۲۷٬۱۸۱ |

> «م.ر» = میلیون ریال (محرک `material_rial` و `direct_labor_rial` بر حسب میلیون ریال)

### ۶.۷ تسهیم خروجی

```
WIP_final    = ۶۹۸٬۳۲۴٬۵۰۰ ریال
by (خرده پارچه): ۰.۰۹ × ۳۱۴ = ۲۸.۲۶ کیلو × ۱۲۰٬۰۰۰ = ۳٬۳۹۱٬۲۰۰
WIP_after_by = ۶۹۸٬۳۲۴٬۵۰۰ − ۳٬۳۹۱٬۲۰۰ = ۶۹۴٬۹۳۳٬۳۰۰
main (۱۰۰٪) = ۶۹۴٬۹۳۳٬۳۰۰  برای ۳۰۰.۰۷۳۱۵۸ عدد
unit_cost    = ۶۹۴٬۹۳۳٬۳۰۰ / ۳۰۰.۰۷۳۱۵۸ = ۲٬۳۱۵٬۸۸۰ ریال ≈ ۲۳۱٬۵۸۸ تومان
```

### ۶.۸ تفکیک بهای تمام‌شده استاندارد

| جزء | مبلغ (ریال) | ٪ | هر عدد |
|-----|------------:|--:|-------:|
| مواد اولیه | ۵۴۲٬۷۶۵٬۰۶۹ | ۷۷.۷ | ۱٬۸۰۸٬۷۸۹ |
| بسته‌بندی | ۴٬۷۱۰٬۰۰۰ | ۰.۷ | ۱۵٬۶۹۶ |
| دستمزد مستقیم | ۸۹٬۲۰۴٬۱۶۷ | ۱۲.۸ | ۲۹۷٬۲۷۵ |
| پیمانکاری (شستشو) | ۱۱٬۵۷۶٬۴۲۶ | ۱.۷ | ۳۸٬۵۷۹ |
| سربار جذب‌شده | ۵۰٬۰۶۸٬۸۳۸ | ۷.۲ | ۱۶۶٬۸۵۵ |
| **جمع ناخالص** | **۶۹۸٬۳۲۴٬۵۰۰** | ۱۰۰ | |
| (−) محصول فرعی | (۳٬۳۹۱٬۲۰۰) | (۰.۵) | (۱۱٬۳۰۱) |
| **بهای تمام‌شده ۳۰۰ عدد** | **۶۹۴٬۹۳۳٬۳۰۰** | | **۲٬۳۱۵٬۸۸۰** |

**قیمت پیشنهادی (۳۵٪):** ۲٬۳۱۵٬۸۸۰ × ۱.۳۵ = **۳٬۱۲۶٬۴۳۷ ریال** ≈ **۳۱۲٬۶۴۴ تومان**

> **مقایسه با ماژول ۱:** ماژول ۱ فقط ۱٬۷۲۴٬۷۷۳ ریال (مواد) می‌داد.
> ماژول ۴ عدد واقعی ۲٬۳۱۵٬۸۸۰ را می‌دهد — **۳۴٪ بیشتر**.
> **قیمت‌گذاری بر اساس ماژول ۱ = ضرر قطعی.**
>
> **مقایسه با ماژول ۲ (تولید واقعی):** ۲٬۲۵۶٬۸۹۷ واقعی در برابر ۲٬۳۱۵٬۸۸۰ استاندارد → **۲.۵٪ مساعد** 🟢
> (چون در ماژول ۲ سربار با نرخ ساده ۱۵۰٬۰۰۰/عدد جذب شد، ولی ماژول ۴ نرخ تفکیکی هر مرکز را به‌کار می‌برد.)

---

## ۷. سناریوهای واقعی

| # | سناریو | رفتار |
|---|--------|-------|
| A-01 | افزودن مرحله جدید (پرس) بین دوخت و یراق | `versionUp` + `seq=35` (فاصله ۱۰ جا می‌دهد) |
| A-02 | حذف مرحله گلدوزی برای مدل ساده | BOM `alternative` بدون `seq=20` |
| A-03 | شستشو داخلی شد (خرید ماشین) | `is_subcontract=0` + `labor_method='monthly'` + مرکز جدید |
| A-04 | پیمانکار شستشو نرخ را بالا برد | `versionUp` + `subcontract_fee_rial` جدید |
| A-05 | خرده پارچه ارزش پیدا کرد | `bom_outputs` با `output_type='by'`, `nrv_rial` |
| A-06 | شال ست با مانتو (محصول همزاد) | `output_type='co'` + `cost_share_percent=85/15` |
| A-07 | تنه دوخته‌شده در دو مدل | `bom_type='phantom'` + `is_multilevel=1` |
| A-08 | مرحله دوخت گلوگاه است | گزارش ظرفیت — `capacity_per_day` هشدار می‌دهد |
| A-09 | نرخ سربار دوخت عوض شد | `cost_center_rates` دوره جدید — BOM دست نمی‌خورد ✅ |
| A-10 | ضایعات شستشو از ۱.۵ به ۳ درصد | `versionUp` — `Q_start` خودکار بیشتر می‌شود |
| A-11 | کارمزد دوخت افزایش | `versionUp` + `labor_rate_rial` |
| A-12 | برشکار ۲ نفر شد | `crew_size=2` — فقط `hourly` تأثیر می‌گیرد |
| A-13 | قیمت‌گذاری مدل جدید قبل از تولید | `GET /boms/:id/full-cost` |
| A-14 | مقایسه هزینه پیمانکاری vs داخلی | دو BOM جایگزین + `GET /boms/compare` |
| A-15 | حلقه: A از B، B از A | `E_BOM_CIRCULAR` |
| A-16 | مرحله بدون دستمزد و سربار | مجاز (مثلاً «انتظار») |
| A-17 | مواد در مرحله‌ای که وجود ندارد | `E_STAGE_NOT_IN_ROUTING` |
| A-18 | `cost_share_percent` جمعش ۹۵٪ | `E_SHARE_NOT_100` |

---

## ۸. سناریوهای حسابداری

> **ماژول ۴ هیچ سند حسابداری صادر نمی‌کند** (مانند ماژول ۱). داده پایه است.
> اسناد در ماژول ۷ و ۸ صادر می‌شوند.

**اثرات غیرمستقیم:**
| موضوع | اثر |
|-------|-----|
| `bom_operations.labor_rate_rial` | مبنای `autoPostLabor` در ماژول ۷ |
| `bom_operations.subcontract_fee_rial` | مبنای سند PRD-14 |
| `bom_outputs.nrv_rial` | مبنای سند PRD-16 |
| `bom_outputs.cost_share_percent` | مبنای تسهیم PRD-07 چندخروجی |
| `full-cost` | `products.std_cost_rial` (اختیاری) → مبنای انحراف |

---

## ۹. اعتبارسنجی

همه V-01..V-18 از ماژول ۱، به‌علاوه:

| کد | قانون | خطا |
|----|-------|-----|
| V4-01 | `has_routing=1` → حداقل یک `bom_operations` | `E_ROUTING_EMPTY` |
| V4-02 | `seq` یکتا و صعودی | `E_SEQ_DUPLICATE` |
| V4-03 | `cost_center_id.is_stage=1` | `E_CC_NOT_STAGE` |
| V4-04 | هر `bom_lines.stage_cost_center_id` در Routing باشد | `E_STAGE_NOT_IN_ROUTING` |
| V4-05 | `0 < yield_percent ≤ 100` هر مرحله | `E_OP_YIELD_RANGE` |
| V4-06 | `0 ≤ normal_waste_percent < 100` | `E_OP_WASTE_RANGE` |
| V4-07 | Π(بازده×(۱−ضایعات)) > ۰.۵ (وگرنه فرمول بی‌معنی) | `W_LOW_TOTAL_YIELD` |
| V4-08 | `is_subcontract=1` → `subcontract_supplier_id` + `subcontract_fee_rial > 0` | `E_SUBCON_INCOMPLETE` |
| V4-09 | `labor_method='piece'` → `labor_rate_rial > 0` | `E_LABOR_RATE_ZERO` |
| V4-10 | `labor_method='hourly'` → `run_minutes_per_unit > 0` | `E_NO_RUN_TIME` |
| V4-11 | `has_coproducts=1` → دقیقاً یک `output_type='main'` | `E_NO_MAIN_OUTPUT` |
| V4-12 | Σ`cost_share_percent` (main+co) = ۱۰۰ (±۰.۰۱) | `E_SHARE_NOT_100` |
| V4-13 | `cost_method='nrv'` → `nrv_rial > 0` | `E_NRV_ZERO` |
| V4-14 | `bom_outputs.product_id` یکتا در هر BOM | `E_OUTPUT_DUPLICATE` |
| V4-15 | `output_type='main'.product_id = bom_headers.product_id` | `E_MAIN_MISMATCH` |
| V4-16 | `is_multilevel=1` → عمق ≤ ۱۰ + بدون حلقه | `E_BOM_CIRCULAR` |
| V4-17 | `machine_minutes > 0` اگر محرک `machine_hours` | `E_NO_MACHINE_TIME` |
| V4-18 | نرخ سربار مرکز موجود یا Bootstrap‌پذیر | `W_NO_OH_RATE` |
| V4-19 | `is_qc_gate` نمی‌تواند اولین مرحله باشد | `E_QC_FIRST` |
| V4-20 | مجموع خروجی `by`+`scrap` نباید > ۵۰٪ ارزش WIP باشد | `W_BY_TOO_HIGH` |
| **V4-21** | **`has_routing=1` → `bom_headers.yield_percent` اجباراً ۱۰۰ (ضد-دوباره‌شماری)** | `E_YIELD_DOUBLE_COUNT` |

---

## ۱۰. Edge Case ها

| # | حالت | راه‌حل |
|---|------|--------|
| E4-01 | یک مرحله بدون مواد (فقط دستمزد) | مجاز — `material[op]=0` |
| E4-02 | مواد بدون `stage_cost_center_id` | به **اولین** مرحله نسبت داده می‌شود + هشدار |
| E4-03 | بازده کل < ۵۰٪ | `W_LOW_TOTAL_YIELD` — تأیید مضاعف کاربر |
| E4-04 | `Q_start` کسری (۳۱۳.۹۴) | `Math.ceil` → ۳۱۴ · باقی‌مانده تولید اضافه |
| E4-05 | `setup_minutes` بزرگ نسبت به سفارش کوچک (۳۰ دق برای ۵ عدد) | بهای واحد بالا — درست ✅ · هشدار «سفارش اقتصادی نیست» |
| E4-06 | `crew_size = 0` | `E_CREW_ZERO` |
| E4-07 | همه خروجی‌ها `by` (بدون main) | `E_NO_MAIN_OUTPUT` |
| E4-08 | NRV محصول فرعی > کل WIP | `E_NRV_EXCEEDS_WIP` |
| E4-09 | تغییر `seq` مرحله میانی | `versionUp` — نسخه فعال قفل است |
| E4-10 | نیمه‌ساخته با BOM غیرفعال | `E_NO_ACTIVE_BOM` برای نیمه‌ساخته |
| E4-11 | Phantom با `is_manufactured=0` | `E_PHANTOM_NOT_MANUFACTURED` |
| E4-12 | Roll-Up با کالای بدون میانگین | `unit=0` + هشدار (نه خطا — برآورد است) |
| E4-13 | دو مرحله با یک مرکز هزینه | مجاز (مثلاً دوخت اول و دوخت نهایی) |
| E4-14 | `subcontract_fee` صفر ولی `is_subcontract=1` | V4-08 |
| E4-15 | درخت با ۱۰۰۰ گره | Memoization + `LIMIT` + timeout ۵ ثانیه |
| E4-16 | `share` = ۱۰۰٪ برای main ولی co هم دارد | V4-12 |

---

## ۱۱. خطاهای احتمالی

| کد | HTTP | پیام |
|----|------|------|
| `E_ROUTING_EMPTY` | 422 | فرمول با مسیر عملیات باید حداقل یک مرحله داشته باشد |
| `E_SEQ_DUPLICATE` | 422 | ترتیب {seq} تکراری است |
| `E_CC_NOT_STAGE` | 422 | مرکز هزینه «{cc}» به‌عنوان مرحله تولید تعریف نشده |
| `E_STAGE_NOT_IN_ROUTING` | 422 | قلم «{name}» به مرحله‌ای اشاره دارد که در مسیر نیست |
| `E_OP_YIELD_RANGE` | 422 | بازده مرحله {seq} باید بین ۰.۱ تا ۱۰۰ باشد |
| `E_OP_WASTE_RANGE` | 422 | ضایعات مرحله {seq} باید بین ۰ تا ۹۹.۹ باشد |
| `W_LOW_TOTAL_YIELD` | 200⚠ | بازده کل {pct}٪ است — بررسی کنید |
| `E_SUBCON_INCOMPLETE` | 422 | مرحله پیمانکاری نیاز به تأمین‌کننده و کارمزد دارد |
| `E_LABOR_RATE_ZERO` | 422 | کارمزد مرحله {seq} صفر است |
| `E_NO_RUN_TIME` | 422 | روش ساعتی نیاز به زمان اجرا دارد |
| `E_NO_MAIN_OUTPUT` | 422 | فرمول باید دقیقاً یک محصول اصلی داشته باشد |
| `E_SHARE_NOT_100` | 422 | مجموع سهم بها {sum}٪ است — باید ۱۰۰ باشد |
| `E_NRV_ZERO` | 422 | ارزش خالص بازیافتنی «{name}» صفر است |
| `E_OUTPUT_DUPLICATE` | 422 | «{name}» دوبار به‌عنوان خروجی تعریف شده |
| `E_MAIN_MISMATCH` | 422 | محصول اصلی با محصول فرمول یکسان نیست |
| `E_NRV_EXCEEDS_WIP` | 422 | ارزش محصول فرعی از کل بهای تولید بیشتر است |
| `E_CREW_ZERO` | 422 | تعداد نفرات باید حداقل ۱ باشد |
| `E_PHANTOM_NOT_MANUFACTURED` | 422 | کالای مجازی باید «ساختنی» علامت بخورد |
| `E_QC_FIRST` | 422 | ایست کنترل کیفیت نمی‌تواند اولین مرحله باشد |
| `W_BY_TOO_HIGH` | 200⚠ | ارزش محصولات فرعی {pct}٪ از کل — «همزاد» درست‌تر است؟ |
| `E_YIELD_DOUBLE_COUNT` | 422 | فرمول دارای مسیر عملیات است — بازده سرفصل باید ۱۰۰٪ باشد (ضایعات از مراحل می‌آید) |

---

## ۱۲. Undo و اصلاح

همان ماژول ۱. اضافه:

| عملیات | روش |
|--------|-----|
| افزودن مرحله میانی | `versionUp` + `seq` بین دو مرحله موجود |
| حذف مرحله | `versionUp` + `DELETE bom_operations` |
| بازشماری `seq` | `POST /boms/:id/operations/resequence` → ۱۰،۲۰،۳۰... |
| تغییر نرخ سربار | **بدون تغییر BOM** — فقط `cost_center_rates` |

---

## ۱۳. گزارش‌ها

| گزارش | endpoint |
|-------|----------|
| R4-01 بهای تمام‌شده کامل | `GET /boms/:id/full-cost?qty=300` |
| R4-02 جدول Roll-Up مرحله‌ای | `GET /boms/:id/roll-up?qty=300` |
| R4-03 مسیر عملیات | `GET /boms/:id/routing` |
| R4-04 تحلیل بازده مسیر | `GET /boms/:id/yield-analysis` |
| R4-05 محاسبه تعداد شروع | `GET /boms/:id/backward-qty?target=300` |
| R4-06 درخت چندسطحی با بها | `GET /boms/:id/cost-tree` |
| R4-07 بار مراکز هزینه | `GET /boms/:id/capacity-load?qty=300` |
| R4-08 مقایسه پیمانکاری/داخلی | `GET /boms/compare-scenarios?a=&b=` |
| R4-09 تحلیل حساسیت | `GET /boms/:id/sensitivity?param=fabric_price&range=±20%` |
| R4-10 نقطه سربه‌سر | `GET /boms/:id/breakeven?price=` |

---

## ۱۴. دسترسی کاربران

همان ماژول ۱.
اضافه: `production_manager` می‌تواند `bom_operations` و `cost_center_rates` را ویرایش کند؛ `accounting` فقط `cost_center_rates`.

---

## ۱۵. APIهای موردنیاز

```
# مراحل (Routing)
GET    /api/production/boms/:id/operations
POST   /api/production/boms/:id/operations
PUT    /api/production/boms/:id/operations/:opId
DELETE /api/production/boms/:id/operations/:opId
POST   /api/production/boms/:id/operations/resequence
POST   /api/production/boms/:id/operations/from-template   {template:'taranom_7_stage'}

# خروجی‌ها
GET    /api/production/boms/:id/outputs
POST   /api/production/boms/:id/outputs
PUT    /api/production/boms/:id/outputs/:outId
DELETE /api/production/boms/:id/outputs/:outId
POST   /api/production/boms/:id/outputs/auto-share  {method:'sales_value'|'physical'}

# محاسبات
GET    /api/production/boms/:id/full-cost      ?qty=300&price_basis=average&period=1405/04
GET    /api/production/boms/:id/roll-up        ?qty=300
GET    /api/production/boms/:id/cost-tree      ?qty=1
GET    /api/production/boms/:id/backward-qty   ?target=300
GET    /api/production/boms/:id/yield-analysis
GET    /api/production/boms/:id/capacity-load  ?qty=300
GET    /api/production/boms/:id/sensitivity    ?param=&range=
GET    /api/production/boms/:id/breakeven      ?price=
GET    /api/production/boms/compare-scenarios  ?a=1&b=2

# نرخ مراکز هزینه
GET    /api/production/cost-center-rates       ?period=1405/04
POST   /api/production/cost-center-rates
PUT    /api/production/cost-center-rates/:id
POST   /api/production/cost-center-rates/bootstrap   {period, months:3}
GET    /api/production/cost-centers
PUT    /api/production/cost-centers/:id        {driver, capacity_per_day, ...}
```

### `GET /boms/:id/full-cost?qty=300`

```json
{
  "bom_id": 1, "bom_code": "BOM-000101", "version": 2,
  "product": { "id": 101, "name": "مانتو کتان ترمه — سبز" },
  "qty_target": 300, "qty_start": 314,
  "total_yield_percent": 95.5647,
  "period": "1405/04",
  "header_yield_ignored": true,
  "stages": [
    { "seq":10, "cost_center":"CC-10 برش", "qty_in":314, "qty_out":307.72,
      "cost_in_rial":0, "material_rial":517560481, "labor_rial":7850000,
      "subcontract_rial":0, "overhead_rial":4658044,
      "overhead_driver":"material_rial", "overhead_driver_qty":517.560, "overhead_rate_rial":9000,
      "cost_out_rial":530068525, "unit_cost_out_rial":1722568 },
    { "seq":20, "cost_center":"CC-20 گلدوزی", "qty_in":307.72, "qty_out":307.72,
      "cost_in_rial":530068525, "material_rial":0, "labor_rial":13847400,
      "subcontract_rial":0, "overhead_rial":18463200,
      "overhead_driver":"machine_hours", "overhead_driver_qty":15.386, "overhead_rate_rial":1200000,
      "cost_out_rial":562379125, "unit_cost_out_rial":1827568 },
    { "seq":30, "cost_center":"CC-30 دوخت", "qty_in":307.72, "qty_out":304.64,
      "cost_in_rial":562379125, "material_rial":2135200, "labor_rial":55389600,
      "subcontract_rial":0, "overhead_rial":19386360,
      "overhead_driver":"direct_labor_rial", "overhead_driver_qty":55.390, "overhead_rate_rial":350000,
      "cost_out_rial":639290285, "unit_cost_out_rial":2098491 },
    { "seq":40, "cost_center":"CC-40 یراق", "qty_in":304.64, "qty_out":304.64,
      "cost_in_rial":639290285, "material_rial":23069388, "labor_rial":7616070,
      "subcontract_rial":0, "overhead_rial":2437142,
      "overhead_driver":"output_qty", "overhead_driver_qty":304.643, "overhead_rate_rial":8000,
      "cost_out_rial":672412885, "unit_cost_out_rial":2207217 },
    { "seq":50, "cost_center":"CC-50 شستشو", "qty_in":304.64, "qty_out":300.07,
      "cost_in_rial":672412885, "material_rial":0, "labor_rial":0,
      "subcontract_rial":11576426, "supplier":"خشکشویی صنعتی رضوان",
      "overhead_rial":1523214, "overhead_driver":"output_qty", "overhead_driver_qty":304.643,
      "cost_out_rial":685512525, "unit_cost_out_rial":2284485 },
    { "seq":60, "cost_center":"CC-60 اتو", "qty_in":300.07, "qty_out":300.07,
      "cost_in_rial":685512525, "material_rial":4710000, "labor_rial":4501097,
      "subcontract_rial":0, "overhead_rial":3600878,
      "overhead_driver":"output_qty", "overhead_driver_qty":300.073, "overhead_rate_rial":12000,
      "cost_out_rial":698324500, "unit_cost_out_rial":2327181 }
  ],
  "outputs": [
    { "type":"by",   "product_id":299, "name":"خرده پارچه", "qty":28.26,
      "cost_method":"nrv", "unit_rial":120000, "amount_rial":3391200 },
    { "type":"main", "product_id":101, "name":"مانتو کتان ترمه — سبز", "qty":300.073158,
      "cost_method":"share", "share_percent":100,
      "amount_rial":694933300, "unit_cost_rial":2315880 }
  ],
  "breakdown": {
    "material_rial":542765069, "material_pct":77.7,
    "packaging_rial":4710000, "packaging_pct":0.7,
    "labor_rial":89204167, "labor_pct":12.8,
    "subcontract_rial":11576426, "subcontract_pct":1.7,
    "overhead_rial":50068838, "overhead_pct":7.2,
    "gross_rial":698324500,
    "by_credit_rial":3391200,
    "net_rial":694933300,
    "unit_cost_rial":2315880, "unit_cost_toman":231588.0
  },
  "pricing": {
    "margin_percent":35,
    "suggested_price_rial":3126437, "suggested_price_toman":312643.7
  },
  "warnings": [],
  "estimated_rates": []
}
```

---

## ۱۶. رویدادها

| رویداد | Payload |
|--------|---------|
| `bom.routing.changed` | `{bomId, opId, action}` |
| `bom.outputs.changed` | `{bomId, outputId, action}` |
| `bom.full_cost.computed` | `{bomId, qty, unitCostRial}` |
| `bom.full_cost.deviation` | `{bomId, prevUnitRial, newUnitRial, pct}` — اگر >۱۰٪ |
| `cost_center.rate.changed` | `{ccId, period, oldRate, newRate}` |
| `bom.capacity.exceeded` | `{bomId, ccId, requiredDays, capacityDays}` |

---

## ۱۷. پیشنهاد UI

### تب «مسیر عملیات» در فرم فرمول

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ BOM-000101 · مانتو کتان ترمه · v2  [اقلام] [🔧 مسیر عملیات] [خروجی‌ها] [بها]│
├──────────────────────────────────────────────────────────────────────────────┤
│                                       [+ مرحله] [📋 از الگوی ترنم] [🔢 بازشماری]│
│ ┌────┬─────────────┬──────┬───────┬────────┬─────────┬──────┬──────┬───────┐│
│ │ترتیب│ مرکز هزینه │setup │run/عدد│ دستمزد │  نرخ    │بازده │ضایعات│ سربار ││
│ ├────┼─────────────┼──────┼───────┼────────┼─────────┼──────┼──────┼───────┤│
│ │ ۱۰ │برش      ⋮⋮ │ ۳۰دق │ ۱.۲دق │ماهانه  │    —    │۱۰۰٪ │ ۲٪  │ریال‌مواد││
│ │ ۲۰ │گلدوزی   ⋮⋮ │ ۱۵دق │ ۳.۰دق │کارمزدی │  ۴۵٬۰۰۰│۱۰۰٪ │ ۰٪  │ساعت‌ماشین││
│ │ ۳۰ │دوخت     ⋮⋮ │ ۲۰دق │۱۱.۰دق │کارمزدی │ ۱۸۰٬۰۰۰│۱۰۰٪ │ ۱٪  │ریال‌دستمزد││
│ │ ۴۰ │یراق     ⋮⋮ │  ۵دق │ ۲.۵دق │کارمزدی │  ۲۵٬۰۰۰│۱۰۰٪ │ ۰٪  │تعداد  ││
│ │ ۵۰ │شستشو 🏭 ⋮⋮ │   ۰  │ ۰.۵دق │پیمانکار│  ۳۸٬۰۰۰│۱۰۰٪ │۱.۵٪ │تعداد  ││
│ │ ۶۰ │اتو ✅   ⋮⋮ │   ۰  │ ۲.۰دق │ماهانه  │    —    │۱۰۰٪ │ ۰٪  │تعداد  ││
│ └────┴─────────────┴──────┴───────┴────────┴─────────┴──────┴──────┴───────┘│
│  ⋮⋮ = کشیدن برای جابه‌جایی   🏭 = پیمانکاری   ✅ = ایست کنترل کیفیت           │
├──────────────────────────────────────────────────────────────────────────────┤
│ 📊 بازده کل: ۹۵.۵۶٪  →  برای ۳۰۰ عدد سالم باید ۳۱۴ عدد شروع کنید            │
│ ⏱ زمان کل هر عدد: ۲۰.۲ دقیقه  ·  زمان آماده‌سازی: ۷۰ دقیقه                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### تب «بهای تمام‌شده» — نمودار آبشاری

```
┌───────────────────────────────────────────────────────────────────────┐
│ بهای تمام‌شده کامل — برای [ 300 ] عدد سالم  دوره:[۱۴۰۵/۰۴▾] [محاسبه]  │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ریال                                                                  │
│  800M ┤                                            ▄▄▄▄  ▄▄▄▄          │
│       │                              ▄▄▄▄  ▄▄▄▄   ████  ████          │
│  600M ┤        ▄▄▄▄  ▄▄▄▄  ▄▄▄▄     ████  ████   ████  ████          │
│       │        ████  ████  ████     ████  ████   ████  ████          │
│  400M ┤  ▄▄▄▄  ████  ████  ████     ████  ████   ████  ████          │
│       │  ████  ████  ████  ████     ████  ████   ████  ████          │
│  200M ┤  ████  ████  ████  ████     ████  ████   ████  ████          │
│     0 ┴──────────────────────────────────────────────────────────     │
│        مواد  دستمزد سربار پیمان   برش  گلدوزی  دوخت  یراق  شستشو اتو │
│       ۷۷.۷٪  ۱۲.۸٪  ۷.۲٪  ۱.۷٪                                        │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────┐         │
│  │ جمع ناخالص              ۶۹۸٬۳۲۴٬۵۰۰ ریال                 │         │
│  │ (−) محصول فرعی خرده پارچه (۳٬۳۹۱٬۲۰۰)                     │         │
│  │ ═══════════════════════════════════════                   │         │
│  │ 💰 بهای تمام‌شده ۳۰۰ عدد  ۶۹۴٬۹۳۳٬۳۰۰ ریال                │         │
│  │ 📦 بهای هر عدد           ۲۳۱٬۵۸۸ تومان                    │         │
│  │ 🏷 قیمت پیشنهادی (۳۵٪)   ۳۱۲٬۶۴۴ تومان                    │         │
│  │ 📈 قیمت فروش فعلی        ۳۲۰٬۰۰۰ تومان  ✅ حاشیه ۳۸.۲٪    │         │
│  └──────────────────────────────────────────────────────────┘         │
│                                                                        │
│  [📄 چاپ برگه بها]  [💾 ثبت به‌عنوان بهای استاندارد کالا]              │
│  [🔬 تحلیل حساسیت]  [⚖️ نقطه سربه‌سر]                                  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## ۱۸. تست‌کیس‌ها

| # | عنوان | انتظار |
|---|-------|--------|
| T4-01 | ایجاد Routing از الگو | ۶ مرحله با `seq` ۱۰..۶۰ |
| T4-02 | `seq` تکراری | `422 E_SEQ_DUPLICATE` |
| T4-03 | مرکز غیرمرحله | `422 E_CC_NOT_STAGE` |
| T4-04 | ماده در مرحله غایب | `422 E_STAGE_NOT_IN_ROUTING` |
| T4-05 | **بازده کل** | `total_yield_percent = 95.5647` (±۰.۰۰۰۱) |
| T4-06 | **محاسبه معکوس** | `backward-qty?target=300` → `qty_start = 314` |
| T4-07 | دستمزد کارمزدی دوخت | `180,000 × 307.72 = 55,389,600` |
| T4-08 | دستمزد ساعتی | crew=2, run=1.2, Q=314 → hours = (30+376.8)/60×2 = 13.56 |
| T4-09 | سربار محرک `material_rial` | `9,000 × 517.560 = 4,658,044` |
| T4-10 | سربار محرک `machine_hours` | `1,200,000 × 15.386 = 18,463,200` |
| T4-11 | سربار محرک `direct_labor_rial` | `350,000 × 55.390 = 19,386,360` |
| T4-12 | پیمانکاری | `38,000 × 304.643 = 11,576,426` |
| T4-13 | **Roll-Up کامل** | `cost_out[60] = 698,324,500` (±۱ ریال) |
| T4-14 | محصول فرعی NRV | `28.26 × 120,000 = 3,391,200` |
| T4-15 | **بهای واحد نهایی** | `unit_cost = 2,315,880` |
| T4-16 | سهم ≠ ۱۰۰ | `422 E_SHARE_NOT_100` |
| T4-17 | بدون main | `422 E_NO_MAIN_OUTPUT` |
| T4-18 | تسهیم co | main 85٪ / co 15٪ → دو رکورد با نسبت صحیح |
| T4-19 | NRV > WIP | `422 E_NRV_EXCEEDS_WIP` |
| T4-20 | چندسطحی Phantom | Explode تا سطح ۲ · اقلام نیمه‌ساخته باز شوند |
| T4-21 | حلقه چندسطحی | `422 E_BOM_CIRCULAR` |
| T4-22 | عمق ۱۱ | `422 E_BOM_TOO_DEEP` |
| T4-23 | بازشماری | `resequence` → ۱۰،۲۰،۳۰،۴۰،۵۰،۶۰ |
| T4-24 | Bootstrap نرخ | حذف `cost_center_rates` → نرخ از ۳ ماه + `is_estimated=1` |
| T4-25 | تسهیم خودکار `sales_value` | share بر اساس `price × qty` |
| T4-26 | حساسیت | `param=fabric_price, +20%` → `unit_cost` جدید |
| T4-27 | ظرفیت | `capacity-load?qty=300` → روز موردنیاز هر مرکز |
| T4-28 | مقایسه سناریو | BOM پیمانکاری vs داخلی → جدول diff |
| T4-29 | **ضد-دوباره‌شماری** | `has_routing=1` + `header.yield=97` → بازده سرفصل نادیده گرفته شود، `Q_start=314` نه ۳۲۴ |

---

## ۱۹. شبه‌کد

```js
// server/lib/production/bom-advanced.js

const MEMO = new Map();   // productId → unit cost (per request)

/** تعداد شروع لازم برای رسیدن به هدف */
function backwardQty(db, bomId, target) {
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  const factor = ops.reduce((f, op) =>
    f * (op.yield_percent / 100) * (1 - (op.normal_waste_percent || 0) / 100), 1);
  if (factor <= 0.5) warn(`W_LOW_TOTAL_YIELD: ${(factor*100).toFixed(2)}%`);
  if (factor <= 0)   throw err('E_OP_YIELD_RANGE', 422);
  return { qty_start: Math.ceil(target / factor), total_yield_percent: round6(factor * 100) };
}

/** دستمزد استاندارد یک مرحله */
function stageLabor(db, op, qty, period) {
  switch (op.labor_method) {
    case 'piece':
      if (!op.labor_rate_rial) throw err('E_LABOR_RATE_ZERO', 422, { seq: op.seq });
      return Math.round(op.labor_rate_rial * qty);

    case 'hourly': {
      if (!op.run_minutes_per_unit) throw err('E_NO_RUN_TIME', 422, { seq: op.seq });
      const crew  = op.crew_size || 1;
      if (crew <= 0) throw err('E_CREW_ZERO', 422);
      const mins  = (op.setup_minutes || 0) + op.run_minutes_per_unit * qty;
      const hours = (mins / 60) * crew;
      return Math.round(op.labor_rate_rial * hours);
    }
    case 'monthly': {
      // نرخ تسهیمی تخمینی از cost_center_rates
      const r = db.prepare(`SELECT monthly_labor_rate_rial FROM cost_center_rates
                            WHERE cost_center_id=? AND period_label=?`).get(op.cost_center_id, period);
      return Math.round((r?.monthly_labor_rate_rial || 0) * qty);
    }
    case 'contract':
      return 0;                                   // به 5230 می‌رود، نه 5201
    default:
      return 0;
  }
}

/** محرک سربار یک مرحله */
function stageDriverQty(db, op, cc, ctx) {
  const driver = op.overhead_driver || cc.driver;
  switch (driver) {
    case 'output_qty':         return ctx.qty;
    case 'direct_labor_rial':  return ctx.labor / 1_000_000;
    case 'direct_labor_hours': return ((op.setup_minutes || 0) + op.run_minutes_per_unit * ctx.qty) / 60 * (op.crew_size || 1);
    case 'machine_hours': {
      if (!op.machine_minutes_per_unit) throw err('E_NO_MACHINE_TIME', 422, { seq: op.seq });
      return op.machine_minutes_per_unit * ctx.qty / 60;
    }
    case 'material_rial':      return ctx.material / 1_000_000;
    case 'manual':             return ctx.manualDriver || 0;
    default:                   return 0;
  }
}

/** Roll-Up کامل */
function rollUpBom(db, { bomId, qtyTarget, period, priceBasis = 'average', level = 0 }) {
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);

  const bom  = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  const ops  = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  if (bom.has_routing && !ops.length) throw err('E_ROUTING_EMPTY', 422);

  // V4-21 — ضد-دوباره‌شماری: بازده سرفصل در حضور Routing نادیده گرفته می‌شود
  if (bom.has_routing && Math.abs((bom.yield_percent ?? 100) - 100) > 0.001)
    throw err('E_YIELD_DOUBLE_COUNT', 422, { yield: bom.yield_percent });

  const { qty_start, total_yield_percent } = ops.length
      ? backwardQty(db, bomId, qtyTarget)
      : { qty_start: qtyTarget, total_yield_percent: 100 };

  // مواد به تفکیک مرحله
  // explodeBom با bom.yield_percent=100 عمل می‌کند؛ فقط bom_lines.scrap_percent اعمال می‌شود
  const ex = explodeBom(db, { bomId, qty: qty_start, priceBasis, level });
  const matByStage = {}, warnings = [];
  let firstStage = ops[0]?.cost_center_id ?? null;
  for (const L of ex.lines) {
    let cc = L.stage_cost_center_id;
    if (!cc) { cc = firstStage; warnings.push(`قلم «${L.name}» مرحله ندارد — به اولین مرحله نسبت داده شد`); }
    (matByStage[cc] ||= { rial: 0, kind: {} });
    matByStage[cc].rial += L.amount_rial;
    matByStage[cc].kind[L.line_kind] = (matByStage[cc].kind[L.line_kind] || 0) + L.amount_rial;
  }

  // انباشت مرحله‌ای
  const stages = [];
  let qtyIn = qty_start, costIn = 0;
  let totMat = 0, totPkg = 0, totLab = 0, totSub = 0, totOh = 0;

  for (const op of ops) {
    const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(op.cost_center_id);
    if (!cc?.is_stage) throw err('E_CC_NOT_STAGE', 422, { cc: cc?.name });

    const material = matByStage[op.cost_center_id]?.rial || 0;
    const pkg      = matByStage[op.cost_center_id]?.kind?.packaging || 0;
    const labor    = stageLabor(db, op, qtyIn, period);
    const subcon   = op.is_subcontract ? Math.round((op.subcontract_fee_rial || 0) * qtyIn) : 0;

    const rate = getOverheadRate(db, op.cost_center_id, period);
    if (rate.is_estimated) warnings.push(`نرخ سربار «${cc.name}» برآوردی است`);
    const driverQty = stageDriverQty(db, op, cc, { qty: qtyIn, labor, material });
    const overhead  = Math.round(rate.total_rate_rial * driverQty);

    const qtyOut  = round6(qtyIn * (op.yield_percent / 100) * (1 - (op.normal_waste_percent || 0) / 100));
    const costOut = costIn + material + labor + subcon + overhead;

    stages.push({
      seq: op.seq, cost_center_id: op.cost_center_id, cost_center: `${cc.code} ${cc.name}`,
      qty_in: qtyIn, qty_out: qtyOut,
      cost_in_rial: costIn, material_rial: material, labor_rial: labor,
      subcontract_rial: subcon, overhead_rial: overhead,
      overhead_driver: op.overhead_driver || cc.driver,
      overhead_driver_qty: round6(driverQty), overhead_rate_rial: rate.total_rate_rial,
      cost_out_rial: costOut,
      unit_cost_out_rial: qtyOut ? Math.round(costOut / qtyOut) : 0,
      supplier: op.is_subcontract ? supplierName(db, op.subcontract_supplier_id) : null,
    });

    totMat += material - pkg; totPkg += pkg; totLab += labor; totSub += subcon; totOh += overhead;
    qtyIn = qtyOut; costIn = costOut;
  }

  const wipFinal = costIn;

  // ═══ تسهیم خروجی‌ها ═══
  const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(bomId);
  const mains = outs.filter(o => o.output_type === 'main');
  if (bom.has_coproducts && mains.length !== 1) throw err('E_NO_MAIN_OUTPUT', 422);

  const result = [];
  let byCredit = 0;
  for (const o of outs.filter(o => ['by','scrap'].includes(o.output_type))) {
    if (o.cost_method === 'zero') { result.push({ ...outMeta(db,o), amount_rial: 0 }); continue; }
    if (o.cost_method === 'nrv' && !o.nrv_rial) throw err('E_NRV_ZERO', 422, { name: productName(db,o.product_id) });
    const q   = round6(o.qty_per_base * qty_start / bom.base_qty);
    const amt = Math.round(q * o.nrv_rial);
    byCredit += amt;
    result.push({ ...outMeta(db,o), qty: q, unit_rial: o.nrv_rial, amount_rial: amt });
  }
  if (byCredit > wipFinal) throw err('E_NRV_EXCEEDS_WIP', 422);

  const wipAfterBy = wipFinal - byCredit;
  const shares = outs.filter(o => ['main','co'].includes(o.output_type));
  const sumShare = shares.reduce((s,o) => s + (o.cost_share_percent || 0), 0);
  if (shares.length && Math.abs(sumShare - 100) > 0.01) throw err('E_SHARE_NOT_100', 422, { sum: sumShare });

  let assigned = 0;
  const shareRows = shares.map(o => {
    const q   = o.output_type === 'main' ? qtyIn : round6(o.qty_per_base * qty_start / bom.base_qty);
    const amt = Math.round(wipAfterBy * (o.cost_share_percent || 0) / 100);
    assigned += amt;
    return { ...outMeta(db,o), qty: q, share_percent: o.cost_share_percent,
             amount_rial: amt, unit_cost_rial: q ? Math.round(amt / q) : 0 };
  });
  // اختلاف گرد کردن → main
  const mainRow = shareRows.find(r => r.type === 'main');
  if (mainRow && assigned !== wipAfterBy) {
    mainRow.amount_rial += wipAfterBy - assigned;
    mainRow.unit_cost_rial = mainRow.qty ? Math.round(mainRow.amount_rial / mainRow.qty) : 0;
  }
  result.push(...shareRows);

  const unitCost = mainRow?.unit_cost_rial || 0;
  const margin   = parseFloat(setting(db,'pricing_margin_percent')) || 35;

  return {
    bom_id: bomId, bom_code: bom.code, version: bom.version,
    qty_target: qtyTarget, qty_start, total_yield_percent, period,
    stages, outputs: result,
    breakdown: {
      material_rial: totMat,      material_pct:      pct(totMat, wipFinal),
      packaging_rial: totPkg,     packaging_pct:     pct(totPkg, wipFinal),
      labor_rial: totLab,         labor_pct:         pct(totLab, wipFinal),
      subcontract_rial: totSub,   subcontract_pct:   pct(totSub, wipFinal),
      overhead_rial: totOh,       overhead_pct:      pct(totOh, wipFinal),
      gross_rial: wipFinal, by_credit_rial: byCredit, net_rial: wipAfterBy,
      unit_cost_rial: unitCost, unit_cost_toman: unitCost / 10,
    },
    pricing: {
      margin_percent: margin,
      suggested_price_rial: Math.round(unitCost * (1 + margin/100)),
      suggested_price_toman: Math.round(unitCost * (1 + margin/100)) / 10,
    },
    warnings,
  };
}

/** Roll-Up چندسطحی بازگشتی با حافظه‌سازی */
function rollUpUnitCost(db, productId, date, period, level = 0) {
  if (MEMO.has(productId)) return MEMO.get(productId);
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);

  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p.is_manufactured) { MEMO.set(productId, p.average_cost_rial); return p.average_cost_rial; }

  let bom;
  try { bom = resolveBom(db, { productId, date }); }
  catch { MEMO.set(productId, p.average_cost_rial); return p.average_cost_rial; }

  const r = rollUpBom(db, { bomId: bom.id, qtyTarget: bom.base_qty, period, level });
  MEMO.set(productId, r.breakdown.unit_cost_rial);
  return r.breakdown.unit_cost_rial;
}

/** الگوی ۷ مرحله‌ای ترنم */
const TARANOM_ROUTING_TEMPLATE = [
  { seq:10, cc:'CC-10', name:'برش',            setup:30, run:1.2,  machine:0,    labor:'monthly',  rate:0,      waste:2   },
  { seq:20, cc:'CC-20', name:'گلدوزی',         setup:15, run:3.0,  machine:3.0,  labor:'piece',    rate:45000,  waste:0   },
  { seq:30, cc:'CC-30', name:'دوخت',           setup:20, run:11.0, machine:11.0, labor:'piece',    rate:180000, waste:1   },
  { seq:40, cc:'CC-40', name:'دکمه و یراق',    setup:5,  run:2.5,  machine:0,    labor:'piece',    rate:25000,  waste:0   },
  { seq:50, cc:'CC-50', name:'شستشو',          setup:0,  run:0.5,  machine:0,    labor:'contract', fee:38000,   waste:1.5, sub:1 },
  { seq:60, cc:'CC-60', name:'اتو و بسته‌بندی', setup:0,  run:2.0,  machine:0,    labor:'monthly',  rate:0,      waste:0,   qc:1 },
];
```

---

## ۲۰. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی ماژول ۴ — فرمول‌های تولید پیشرفته

## پیش‌نیاز
ماژول ۱ (BOM) کامل. ماژول ۲ و ۳ توصیه می‌شود (برای overhead.js).

## اسناد مرجع
- docs/Production/04-advanced-formulas.md    ← این سند
- docs/Production/01-production-formulas.md  ← منطق پایه
- docs/Production/database-schema.md         ← §2.1 (bom_operations, bom_outputs), §2.2

## الزامات قطعی
1. این ماژول **هیچ سند حسابداری نمی‌زند**. اگر postToLedger دیدی → غلط.
2. `seq` با فاصله ۱۰ (۱۰،۲۰،۳۰...) تا درج بعدی راحت باشد.
3. محاسبه معکوس تعداد: `Q_start = ceil(target / Π(yield×(1−waste)))`
4. Roll-Up مرحله‌ای: بهای هر مرحله = ورودی + مواد + دستمزد + پیمانکاری + سربار.
5. ضایعات مرحله‌ای تعداد را کم می‌کند، **بها را نه** — پس unit_cost بالا می‌رود.
5b. **V4-21 حیاتی:** اگر `has_routing=1` → `bom_headers.yield_percent` را اجباراً ۱۰۰ بگیر.
    وگرنه ضایعات دوبار حساب می‌شود. `bom_lines.scrap_percent` اما همچنان اعمال می‌شود.
6. اختلاف گرد کردن تسهیم خروجی → همیشه به `main`.
7. Memoization اجباری در Roll-Up چندسطحی.
8. Timeout ۵ ثانیه روی cost-tree.

## گام‌ها

### گام ۱ — Schema
server/db.js:
- CREATE TABLE bom_operations, bom_outputs  (§2.1 database-schema.md)
- CREATE TABLE cost_center_rates, overhead_allocation_rules, overhead_allocation_weights (§2.2)
- ensureColumn(db,'cost_center_rates','monthly_labor_rate_rial','INTEGER DEFAULT 0')
- ensureColumn های cost_centers (§1)
- Seed TARANOM_COST_CENTERS (§7 database-schema.md) — فقط اگر جدول خالی
- settings: production_coproduct_method='manual', pricing_margin_percent='35'

### گام ۲ — سرویس
server/lib/production/bom-advanced.js:
  backwardQty, stageLabor, stageDriverQty, rollUpBom,
  rollUpUnitCost (با MEMO), costTree, yieldAnalysis,
  capacityLoad, sensitivity, breakeven, compareScenarios,
  resequenceOperations, applyRoutingTemplate,
  validateAdvancedBom (V4-01..V4-20), autoShare
  TARANOM_ROUTING_TEMPLATE

server/lib/production/overhead.js:
  getOverheadRate(db, ccId, period)   ← با Bootstrap
  bootstrapRate(db, ccId, period, months)
  ⚠️ expense_payments.amount به **تومان** است → × 10 برای ریال

### گام ۳ — Route
server/routes/production-boms.js: ۱۵ endpoint جدید (§15)
server/routes/production-cost-centers.js: نرخ‌ها و مراکز
ثبت در server.js

### گام ۴ — UI
تب‌های فرم فرمول: [اقلام] [مسیر عملیات] [خروجی‌ها] [بهای تمام‌شده]
- جدول مراحل با drag&drop برای تغییر ترتیب (§17)
- دکمه «از الگوی ترنم» → ۶ مرحله پیش‌فرض
- نمودار آبشاری بها (Chart.js — vendor/chart.umd.js موجود است)
- کارت بهای واحد + قیمت پیشنهادی + مقایسه با قیمت فعلی
- صفحه «نرخ سربار مراکز هزینه» با فرم بودجه ماهانه
- RTL, Vazirmatn, #1B5C4A/#2D7A5F/#C9A84C

### گام ۵ — تست
server/scripts/test-production-bom-advanced.js — ۲۸ تست از §18
حیاتی:
  T4-05  total_yield = 95.5647
  T4-06  qty_start = 314
  T4-13  cost_out[60] = 698,324,500  (±1 ریال)
  T4-15  unit_cost = 2,315,880
  T4-21  حلقه چندسطحی
  T4-29  ضد-دوباره‌شماری بازده (V4-21)

## معیار پذیرش
- [ ] جدول §6.6 عیناً بازتولید شود (همه ۶ مرحله)
- [ ] §6.8 (تفکیک بها) دقیقاً مطابقت داشته باشد
- [ ] `GET /boms/:id/full-cost?qty=300` خروجی §15 را بدهد
- [ ] cost-tree روی درخت ۵ سطحی زیر ۵ ثانیه
- [ ] هیچ سندی صادر نشود

## ممنوعیت‌ها
- ❌ سند حسابداری
- ❌ کسر بها هنگام ضایعات مرحله‌ای (فقط تعداد)
- ❌ Roll-Up بدون Memoization
- ❌ Hard-code نرخ سربار — همیشه از cost_center_rates
````

---

## ۲۱. خروجی‌های این ماژول

| خروجی | مسیر |
|-------|------|
| Migration | `server/db.js` |
| سرویس پیشرفته | `server/lib/production/bom-advanced.js` |
| سربار | `server/lib/production/overhead.js` |
| Route | `server/routes/production-boms.js` (توسعه) |
| Route مراکز | `server/routes/production-cost-centers.js` |
| UI | `server/public/index.html` — ۴ تب |
| تست | `server/scripts/test-production-bom-advanced.js` |
