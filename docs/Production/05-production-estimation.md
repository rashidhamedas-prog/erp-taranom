# 05-production-estimation.md
## زیرگروه ۵ — برآورد تولید (MRP + Cost Estimation)

---

## ۱. هدف ماژول

دو کارکرد مجزا که در یک ماژول ادغام شده‌اند (طبق تأیید شما: «هر دو»):

| کارکرد | سؤال | خروجی |
|--------|------|-------|
| **الف) برآورد بهای تمام‌شده** (Cost Estimation) | «تولید ۵۰۰ عدد این مدل چقدر برایم آب می‌خورد؟ چند بفروشم؟» | برگه بها + قیمت پیشنهادی |
| **ب) برنامه‌ریزی نیاز مواد** (MRP) | «چه بخرم، چقدر، تا کِی؟» | لیست کسری + پیشنهاد خرید/تولید |

**چرا با هم؟** چون هر دو از یک موتور (`explodeBom` + `rollUpBom`) تغذیه می‌شوند و در یک صفحه معنی می‌دهند: «۵۰۰ عدد ← ۸۵۰ متر پارچه لازم است، ۳۰۰ متر داری، ۵۵۰ متر بخر، بهای تمام‌شده ۲۳۱٬۵۸۸ تومان، بفروش ۳۱۲٬۶۴۴».

**کاربرد در ترنم:**
- مشتری عمده زنگ می‌زند: «۵۰۰ عدد مانتو ترمه چند؟» → پاسخ در ۳۰ ثانیه
- قبل از فصل: «برای ۵٬۰۰۰ عدد تولید پاییز چه بخرم؟»
- MTO: سفارش مشتری → برآورد → تأیید → تبدیل به سفارش تولید

**⚠️ این ماژول هیچ سند حسابداری صادر نمی‌کند و هیچ موجودی را تغییر نمی‌دهد.** فقط محاسبه و پیشنهاد.

---

## ۲. موجودیت‌ها

| جدول | نقش |
|------|-----|
| `production_estimates` | سرفصل برآورد |
| `production_estimate_lines` | ریز اقلام (مواد/دستمزد/سربار) + وضعیت MRP هر قلم |
| `mrp_runs` | اجرای MRP سطح شرکت (نه سفارش خاص) |
| `mrp_requirements` | نیاز خالص هر کالا |
| `production_reservations` | موجودی رزروشده (کسر از available) |

**تفاوت `production_estimates` و `mrp_runs`:**
| | `production_estimates` | `mrp_runs` |
|-|------------------------|-----------|
| دامنه | یک محصول، یک تعداد | همه تقاضاها در افق زمانی |
| منبع تقاضا | ورودی دستی | سفارش‌های فروش + پیش‌بینی + سفارش‌های تولید باز |
| خروجی | برگه بها + کسری | لیست خرید/تولید کل شرکت |
| کاربرد | استعلام قیمت | برنامه‌ریزی فصلی |

---

## ۳. روابط

```
production_estimates (1) ──< production_estimate_lines (N)
        │                            │
        ├──> products (product_id)   ├──> products
        ├──> bom_headers             └──> cost_centers
        ├──> customers
        ├──> orders (sales_order_id)
        └──> production_orders (converted_order_id)   ← پس از تبدیل

mrp_runs (1) ──< mrp_requirements (N) ──> products
                                       └──> suppliers

production_reservations ──> production_orders
                        └──> products
```

---

## ۴. چرخه حیات برآورد

```
┌───────┐  تأیید   ┌───────────┐  تبدیل   ┌────────────┐
│ draft │─────────►│ confirmed │─────────►│ converted  │
│پیش‌نویس│          │ تأییدشده  │          │ به سفارش   │
└───┬───┘          └─────┬─────┘          └────────────┘
    │ رد                 │ انقضا
    ▼                    ▼
┌──────────┐        ┌─────────┐
│ rejected │        │ expired │
└──────────┘        └─────────┘
```

| گذار | شرط |
|------|-----|
| `draft→confirmed` | محاسبه کامل + `valid_until` تعیین شود |
| `confirmed→converted` | ایجاد `production_orders` + `converted_order_id` |
| `confirmed→expired` | `valid_until < today` (کرون روزانه) |
| `converted→` | نهایی — غیرقابل تغییر |

---

## ۵. بخش الف — برآورد بهای تمام‌شده

### ۵.۱ الگوریتم

```
estimateCost(productId, qty, date, options):
  ۱) bom = resolveBom(productId, date, options.bomId, allowAlternative)
  ۲) اگر bom.has_routing:
        r = rollUpBom(bomId, qty, period, priceBasis)     ← ماژول ۴
     در غیر این صورت:
        r = explodeBom(bomId, qty, priceBasis)            ← ماژول ۱
        + دستمزد و سربار تخمینی از میانگین تاریخی
  ۳) est_* = r.breakdown
  ۴) suggested_price = unit_cost × (1 + margin/100)
  ۵) ذخیره در production_estimates + production_estimate_lines
```

### ۵.۲ مبنای قیمت مواد (`price_basis`)

| مبنا | منبع | کاربرد | ریسک |
|------|------|--------|------|
| `average` | `products.average_cost_rial` | پیش‌فرض · محافظه‌کارانه | در تورم، پایین‌تر از واقع |
| `last_purchase` | آخرین `purchase_invoice_items.unit_price_rial` | تورم بالا · واقع‌بینانه‌تر | نوسان‌پذیر |
| `std` | `products.std_cost_rial` | مقایسه با بودجه | ممکن است قدیمی باشد |
| `market` | ورودی دستی کاربر | استعلام آتی | ذهنی |
| `max` | `max(average, last_purchase)` | **توصیه ترنم در تورم** | محافظه‌کارانه‌تر |

> **توصیه برای ترنم (تورم ایران):** پیش‌فرض `settings.production_estimate_price_basis = 'max'`
> چون در تورم، `average` قدیمی است و اگر بر مبنای آن قیمت بدهی، تا زمان تولید ضرر می‌کنی.

### ۵.۳ دستمزد و سربار در نبود Routing

```
اگر bom.has_routing = 0:
   labor_rial = qty × avgHistoricalLabor(productId)
   avgHistoricalLabor = SELECT AVG(labor_cost_rial / NULLIF(qty_produced,0))
                        FROM production_orders
                        WHERE product_id=? AND status='closed'
                        ORDER BY actual_end DESC LIMIT 3

   overhead_rial = qty × avgHistoricalOverhead(productId)   ← مشابه

   اگر تاریخچه‌ای نیست:
      labor_rial = 0 + هشدار W_NO_LABOR_HISTORY
      overhead_rial = qty × cost_center_rates[default].total_rate_rial (اگر driver=output_qty)
```

### ۵.۴ قیمت‌گذاری — قاعده ترنم

```
margin_percent = 35   (settings.pricing_margin_percent)

روش «از بالای بهای تمام‌شده» (Mark-up) — قاعده اعلامی ترنم:
   suggested_price = unit_cost × (1 + 35/100) = unit_cost × 1.35
   حاشیه واقعی روی فروش = 35 / 135 = 25.93٪

روش «حاشیه روی فروش» (Margin) — برای مقایسه:
   price_for_35pct_margin = unit_cost / (1 − 35/100) = unit_cost / 0.65
```

**⚠️ هشدار مهم برای حامد:** این دو یکی نیستند.
| unit_cost | Mark-up ۳۵٪ | Margin ۳۵٪ | اختلاف |
|----------:|------------:|-----------:|-------:|
| ۲۳۱٬۵۸۸ ت | ۳۱۲٬۶۴۴ ت | ۳۵۶٬۲۸۹ ت | ۴۳٬۶۴۵ ت |

UI باید **هر دو** را نشان دهد تا تصمیم آگاهانه بگیری.

### ۵.۵ اثر تخفیف بر سود

```
قاعده ترنم: تخفیف نقدی ۳-۱۵٪ · تخفیف بخش‌بندی (VIP/A/B/C) + حجمی · سقف ۲۰٪

سود خالص هر عدد پس از تخفیف d و کمیسیون ویزیتور c:
   net_price  = price × (1 − d/100)
   commission = net_price × c/100                    (c = 4.5٪ برای ویزیتور میدانی)
   profit     = net_price − commission − unit_cost
   margin_pct = profit / net_price × 100

نقطه شکست (تخفیفی که سود را صفر می‌کند):
   d_max = 100 × (1 − unit_cost / (price × (1 − c/100)))
```

**مثال ترنم:**
```
unit_cost = ۲۳۱٬۵۸۸ ت  ·  price = ۳۱۲٬۶۴۴ ت  ·  c = ۴.۵٪

تخفیف ۰٪ : net=۳۱۲٬۶۴۴ · کمیسیون=۱۴٬۰۶۹ · سود=۶۶٬۹۸۷ · حاشیه ۲۱.۴٪
تخفیف ۱۰٪: net=۲۸۱٬۳۸۰ · کمیسیون=۱۲٬۶۶۲ · سود=۳۷٬۱۳۰ · حاشیه ۱۳.۲٪
تخفیف ۲۰٪: net=۲۵۰٬۱۱۵ · کمیسیون=۱۱٬۲۵۵ · سود= ۷٬۲۷۲ · حاشیه  ۲.۹٪ ⚠️
d_max     = ۲۲.۴٪  ← بیش از این ضرر است

💡 سقف تخفیف ۲۰٪ ترنم تقریباً روی نقطه شکست است — حاشیه امنی ندارد.
```

> این محاسبه باید در UI برآورد نمایش داده شود. مستقیم به تصمیم فروش وصل است.

---

## ۶. بخش ب — MRP

### ۶.۱ الگوریتم MRP (Net Requirement)

```
mrpRun(horizonDays, demandSource):
  ۱) جمع‌آوری تقاضا (Gross Requirement):
     - سفارش‌های تولید با status IN ('draft','released','in_progress')  → نیاز مواد باز
     - سفارش‌های فروش (orders) با تحویل در افق و کالای موجود ناکافی
     - سفارش‌های B2B (b2b_portal_orders) با status='confirmed'
     - پیش‌بینی دستی (forecast)

  ۲) انفجار درخت (BOM Explosion) به‌صورت سطح‌به‌سطح (Low-Level Coding):
     برای هر تقاضای محصول نهایی → مواد سطح ۱ → نیمه‌ساخته → مواد سطح ۲ ...
     ⚠️ کالای مشترک بین دو محصول باید در **پایین‌ترین سطحش** یک‌بار جمع شود
        (وگرنه دوبار سفارش خرید می‌دهی)

  ۳) برای هر کالا (به ترتیب Low-Level Code صعودی):
        gross     = Σ نیاز از همه منابع
        on_hand   = Σ warehouse_stock.qty  (انبارهای kind IN ('raw','general'))
        reserved  = Σ production_reservations WHERE status='active'
        on_order  = Σ purchase_invoices باز (اگر include_on_order)
        safety    = products.safety_stock
        available = on_hand − reserved + on_order − safety
        net       = max(0, gross − available)

        اگر net > 0:
           suggested = ceil(net / min_order_qty) × min_order_qty   (اگر min_order_qty > 0)
           action    = products.is_manufactured ? 'produce' : 'purchase'
           order_by  = jalaliSubDays(need_by, products.lead_time_days)
           اگر order_by < today → 🔴 «دیر شده»

  ۴) برای کالاهای action='produce':
        نیاز مواد آن‌ها به gross سطح بعد اضافه شود (بازگشتی)
```

### ۶.۲ کدگذاری سطح پایین (Low-Level Code)

```
مسئله: پارچه کتان هم در «مانتو ترمه» (سطح ۱) هست، هم در «تنه دوخته‌شده» (سطح ۲).
اگر سطح ۱ را پردازش کنی و سفارش خرید بدهی، بعد سطح ۲ برسد → دوبار خرید.

راه‌حل: به هر کالا «پایین‌ترین سطحی که در آن ظاهر می‌شود» را نسبت بده،
        و پردازش را از سطح ۰ به سمت پایین انجام بده.
        هر کالا فقط وقتی پردازش شود که همه تقاضاهایش جمع شده باشد.

computeLowLevelCodes(db):
   llc = {}
   for each product p with is_manufactured=1:
       walk(p.id, 0)
   function walk(pid, lvl):
       if lvl > 10: throw E_BOM_TOO_DEEP
       llc[pid] = max(llc[pid] ?? 0, lvl)
       bom = resolveBom(pid, today)
       if !bom: return
       for L in bom_lines(bom):
           walk(L.component_product_id, lvl + 1)
   return llc
```

### ۶.۳ محاسبه تاریخ

```
need_by_date  = تاریخ تحویل سفارش فروش − زمان تولید کل
زمان تولید کل = Σ(bom_operations: setup + run × qty) / (ظرفیت روزانه × ۸ ساعت × ۶۰)

order_by_date = need_by_date − products.lead_time_days

اگر order_by_date < امروز:
   status = 'late'  🔴
   suggested_action = 'expedite'   (خرید اضطراری / تأمین‌کننده جایگزین)
```

### ۶.۴ محاسبه ظرفیت (Rough-Cut Capacity)

```
برای هر مرکز هزینه cc در افق:
   required_minutes = Σ (over all planned orders)
                        [ op.setup_minutes + op.run_minutes_per_unit × qty ]
   available_minutes = cc.capacity_per_day × working_days × 8 × 60
   load_pct = required / available × 100

   اگر load_pct > 100 → 🔴 گلوگاه (Bottleneck)
   اگر load_pct > 85  → 🟡 هشدار
```

---

## ۷. مثال کامل — استعلام مشتری

### درخواست
```
مشتری: پوشاک آسیا (VIP)
«۵۰۰ عدد مانتو کتان ترمه سبز، تحویل ۱۴۰۵/۰۵/۲۰ — چند؟»
تاریخ امروز: ۱۴۰۵/۰۴/۲۴
```

### الف) برآورد بهای تمام‌شده

```
resolveBom(101, '1405/04/24') → BOM-000101 v2 (has_routing=1)
qty_target = 500
Π بازده = 0.955647  →  qty_start = ceil(500 / 0.955647) = 524 عدد
price_basis = 'max'
```

| جزء | مبلغ (ریال) | هر عدد |
|-----|------------:|-------:|
| مواد اولیه | ۹۰۵٬۷۶۰٬۸۱۶ | ۱٬۸۰۸٬۷۷۶ |
| بسته‌بندی | ۷٬۸۶۰٬۰۰۰ | ۱۵٬۶۹۶ |
| دستمزد مستقیم | ۱۴۸٬۸۶۳٬۰۰۵ | ۲۹۷٬۲۷۵ |
| پیمانکاری (شستشو) | ۱۹٬۳۱۸٬۶۲۲ | ۳۸٬۵۷۹ |
| سربار جذب‌شده | ۸۳٬۵۵۴٬۳۶۷ | ۱۶۶٬۸۵۵ |
| **جمع ناخالص** | **۱٬۱۶۵٬۳۵۶٬۸۱۰** | |
| (−) محصول فرعی | (۵٬۶۵۹٬۲۰۰) | (۱۱٬۳۰۱) |
| **بهای تمام‌شده ۵۰۰.۷۶ عدد** | **۱٬۱۵۹٬۶۹۷٬۶۱۰** | **۲٬۳۱۵٬۸۸۰** |

> **نکته مهم و ضدشهودی:** بهای واحد ۵۰۰ عددی **دقیقاً برابر** ۳۰۰ عددی است (۲۳۱٬۵۸۸ تومان).
> دلیل: در فرمول فعلی ترنم هیچ هزینه‌ای **واقعاً ثابت** نیست — `setup_minutes` فقط روی روش
> دستمزد `hourly` اثر می‌گذارد، و ما همه مراحل را `piece`/`monthly`/`contract` گذاشته‌ایم
> که همگی خطی‌اند. سربار هم با محرک‌های خطی جذب می‌شود.
>
> **اگر می‌خواهی صرفه‌جویی مقیاس در برآورد دیده شود**، باید یکی از این‌ها را انجام دهی:
> ۱) مراحل `monthly` (برش، اتو) را به `hourly` با `crew_size` تبدیل کنی تا `setup` اثر کند، یا
> ۲) در `cost_center_rates`، سربار را به `budget_fixed_oh_rial` و `budget_var_oh_rial` تفکیک کنی
>    و از تفکیک انحراف بودجه/حجم (ماژول ۷ و ۸) استفاده کنی.
>
> فعلاً این عدد **صادقانه** است: تولید ۵۰۰ تایی از ۳۰۰ تایی ارزان‌تر تمام نمی‌شود.

### قیمت‌گذاری

| روش | قیمت (تومان) |
|-----|-------------:|
| بهای تمام‌شده | ۲۳۱٬۵۸۸ |
| **Mark-up ۳۵٪ (قاعده ترنم)** | **۳۱۲٬۶۴۴** |
| Margin ۳۵٪ | ۳۵۶٬۲۸۹ |
| قیمت لیست فعلی | ۳۲۰٬۰۰۰ |

### تحلیل تخفیف (مشتری VIP + حجم ۵۰۰ عدد)

```
تخفیف VIP ۱۰٪ + تخفیف حجمی ۵٪ = ۱۵٪  (زیر سقف ۲۰٪ ✅)
قیمت لیست: ۳۲۰٬۰۰۰ ت
```
| مورد | مبلغ (تومان) |
|------|-------------:|
| قیمت لیست | ۳۲۰٬۰۰۰ |
| (−) تخفیف ۱۵٪ | (۴۸٬۰۰۰) |
| **قیمت خالص** | **۲۷۲٬۰۰۰** |
| (−) کمیسیون ویزیتور ۴.۵٪ | (۱۲٬۲۴۰) |
| (−) بهای تمام‌شده | (۲۳۱٬۵۸۸) |
| **🟢 سود هر عدد** | **۲۸٬۱۷۲** |
| حاشیه سود | ۱۰.۴٪ |
| **سود کل ۵۰۰ عدد** | **۱۴٬۰۸۶٬۰۰۰ تومان** |

```
d_max (تخفیف نقطه شکست) = 100 × (1 − 231,588 / (320,000 × 0.955)) = 24.22٪
⚠️ با تخفیف ۱۵٪، فقط ۹.۲ واحد درصد فاصله تا ضرر داری.
```

### ب) MRP — بررسی امکان‌پذیری

| کالا | نیاز ناخالص | موجود | رزرو | در راه | ذخیره | موجود خالص | **کسری** | Lead | سفارش تا | اقدام |
|------|------------:|------:|-----:|-------:|------:|-----------:|---------:|-----:|----------|-------|
| پارچه کتان سبز | ۸۷۳.۳۳ م | ۶۲۰ | ۱۰۰ | ۰ | ۵۰ | ۴۷۰ | 🔴 **۴۰۳.۳۳** | ۱۵ روز | ۱۴۰۵/۰۴/۲۵ | خرید |
| آستر ساده | ۱۸۹.۰۷ م | ۸۰ | ۰ | ۲۰۰ | ۲۰ | ۲۶۰ | ✅ ۰ | ۷ روز | — | — |
| نخ پلی‌استر | ۴۱.۹۲ ق | ۱۲۰ | ۰ | ۰ | ۱۰ | ۱۱۰ | ✅ ۰ | ۳ روز | — | — |
| دکمه چوبی ۲۰ | ۳٬۲۰۸.۱۶ ع | ۲٬۰۰۰ | ۵۰۰ | ۰ | ۲۰۰ | ۱٬۳۰۰ | 🔴 **۱٬۹۰۸.۱۶** | ۲۰ روز | 🔴 **۱۴۰۵/۰۴/۲۰** | خرید فوری |
| لیبل ترنم | ۵۲۴ ع | ۵٬۰۰۰ | ۰ | ۰ | ۰ | ۵٬۰۰۰ | ✅ ۰ | ۱۰ روز | — | — |
| نایلون | ۵۲۴ ع | ۳۰۰ | ۰ | ۰ | ۰ | ۳۰۰ | 🔴 **۲۲۴** | ۵ روز | ۱۴۰۵/۰۵/۰۵ | خرید |

```
🔴 تاریخ تحویل ۱۴۰۵/۰۵/۲۰ در خطر است:
   دکمه چوبی: باید تا ۱۴۰۵/۰۴/۲۰ سفارش می‌دادی — ۴ روز دیر شده
   راه‌حل‌ها:
     ۱) خرید اضطراری از تأمین‌کننده جایگزین (نرخ بالاتر)
     ۲) دکمه ۱۸ میل جایگزین (فرمول جایگزین BOM-000103 موجود است)
     ۳) تحویل به ۱۴۰۵/۰۵/۲۸ موکول شود
```

### پیشنهاد خرید تجمیعی

| کالا | کسری | حداقل سفارش | پیشنهاد خرید | نرخ (ریال) | مبلغ (ریال) | تأمین‌کننده |
|------|-----:|------------:|-------------:|-----------:|------------:|-------------|
| پارچه کتان سبز | ۴۰۳.۳۳ م | ۵۰ م | **۴۵۰ م** | ۹۵۰٬۰۰۰ | ۴۲۷٬۵۰۰٬۰۰۰ | نساجی یزد |
| دکمه چوبی ۲۰ | ۱٬۹۰۸.۱۶ ع | ۱٬۰۰۰ ع | **۲٬۰۰۰ ع** | ۱۲٬۰۰۰ | ۲۴٬۰۰۰٬۰۰۰ | یراق‌آلات پارس |
| نایلون | ۲۲۴ ع | ۵۰۰ ع | **۵۰۰ ع** | ۹٬۰۰۰ | ۴٬۵۰۰٬۰۰۰ | بسته‌بندی رضا |
| | | | | **جمع** | **۴۵۶٬۰۰۰٬۰۰۰** | ≈ ۴۵.۶ م.ت |

### بار مراکز هزینه (۵۲۴ عدد در ۲۰ روز کاری)

| مرکز | زمان لازم (دقیقه) | ظرفیت (دقیقه) | بار | وضعیت |
|------|------------------:|--------------:|----:|-------|
| CC-10 برش | ۶۵۸.۸ | ۹٬۶۰۰ | ۶.۹٪ | ✅ |
| CC-20 گلدوزی | ۱٬۵۵۵.۶ | ۹٬۶۰۰ | ۱۶.۲٪ | ✅ |
| CC-30 دوخت | ۵٬۶۶۸.۷ | ۹٬۶۰۰ | **۵۹.۰٪** | ✅ |
| CC-40 یراق | ۱٬۲۷۶.۰ | ۹٬۶۰۰ | ۱۳.۳٪ | ✅ |
| CC-50 شستشو | ۲۵۴.۲ | — | — | 🏭 پیمانکاری |
| CC-60 اتو | ۱٬۰۰۱.۵ | ۹٬۶۰۰ | ۱۰.۴٪ | ✅ |

> **گلوگاه:** دوخت با ۵۹.۰٪ — جا دارد ولی اگر سفارش دیگری هم بیاید، اول اینجا اشباع می‌شود.
> ظرفیت = `capacity_per_day × ۲۰ روز کاری × ۸ ساعت × ۶۰` (فرض: ۱ خط برای هر مرکز)

---

## ۸. سناریوهای واقعی

| # | سناریو | رفتار |
|---|--------|-------|
| P-01 | استعلام سریع مشتری | برآورد `draft` → نمایش قیمت → ارسال از `message_compose` |
| P-02 | مشتری تأیید کرد | `confirm` → `convert` → سفارش تولید `draft` |
| P-03 | مواد ناکافی | لیست کسری + پیشنهاد خرید + تاریخ سفارش |
| P-04 | Lead-time نمی‌رسد | 🔴 «دیر شده» + ۳ راه‌حل (جایگزین/اضطراری/تأخیر) |
| P-05 | برنامه‌ریزی فصلی | `mrp_run` با افق ۹۰ روز + منبع `forecast` |
| P-06 | تبدیل کسری به سفارش خرید | `POST /mrp/:id/create-purchase-orders` → پیش‌نویس `purchase_invoices` |
| P-07 | برآورد با فرمول جایگزین | `bom_id` دستی + `allowAlternative=1` |
| P-08 | مقایسه دو سناریو | دو برآورد + `GET /estimates/compare` |
| P-09 | تخفیف بیش از نقطه شکست | 🔴 هشدار «این تخفیف ضرر است» + `d_max` |
| P-10 | برآورد منقضی | کرون روزانه → `status='expired'` |
| P-11 | قیمت پارچه ۲۰٪ بالا رفت | برآورد قدیمی نامعتبر → دکمه «بازمحاسبه» |
| P-12 | دقت برآورد | پس از `close` سفارش → `actual_unit_rial` + `accuracy_percent` |
| P-13 | MRP با نیمه‌ساخته | Low-Level Code — پارچه یک‌بار جمع شود |
| P-14 | ظرفیت دوخت پر است | 🔴 گلوگاه + پیشنهاد تاریخ ممکن |
| P-15 | چند سفارش همزمان | MRP کلی — رزروها کسر شوند |
| P-16 | مشتری قیمت کمتر می‌خواهد | `GET /estimates/:id/target-cost?price=X` → «برای این قیمت، بهای تمام‌شده باید Y شود» |

---

## ۹. سناریوهای حسابداری

> **✅ هیچ سند حسابداری — هیچ تغییر موجودی.**

**تنها اثر:** `production_estimates.converted_order_id` → از این نقطه به بعد، ماژول ۲/۳/۷/۸ سند می‌زند.

**اثر مدیریتی (مهم):**
| موضوع | استفاده |
|-------|---------|
| `est_unit_rial` vs `actual_unit_rial` | سنجش دقت برآورد → بهبود فرمول |
| `suggested_price_rial` | ورودی به `products.price_rial` (اختیاری) |
| `mrp_shortage_rial` | برنامه نقدینگی — «۴۵.۶ م.ت خرید لازم است» |

---

## ۱۰. اعتبارسنجی

| کد | قانون | خطا |
|----|-------|-----|
| V5-01 | `qty > 0` | `E_QTY_INVALID` |
| V5-02 | فرمول فعال در تاریخ برآورد | `E_NO_ACTIVE_BOM` |
| V5-03 | `valid_until ≥ date` | `E_VALID_UNTIL_PAST` |
| V5-04 | `margin_percent ≥ 0` | `E_MARGIN_NEGATIVE` |
| V5-05 | تبدیل فقط از `confirmed` | `E_NOT_CONFIRMED` |
| V5-06 | تبدیل فقط یک‌بار | `E_ALREADY_CONVERTED` |
| V5-07 | برآورد `expired` قابل تبدیل نیست | `E_ESTIMATE_EXPIRED` |
| V5-08 | افق MRP بین ۱ تا ۳۶۵ روز | `E_HORIZON_RANGE` |
| V5-09 | عمق درخت ≤ ۱۰ | `E_BOM_TOO_DEEP` |
| V5-10 | `price_basis` معتبر | `E_INVALID_PRICE_BASIS` |
| V5-11 | تخفیف > `d_max` → هشدار | `W_DISCOUNT_BELOW_COST` |
| V5-12 | کالای بدون میانگین → هشدار نه خطا | `W_NO_PRICE` |
| V5-13 | MRP همزمان دو بار | `E_MRP_RUNNING` |
| V5-14 | `min_order_qty > 0` → گرد کردن به بالا | — |
| V5-15 | ویرایش `confirmed` ممنوع | `E_ESTIMATE_LOCKED` |

---

## ۱۱. Edge Case ها

| # | حالت | راه‌حل |
|---|------|--------|
| E5-01 | کالای بدون قیمت | `unit_cost=0` + `W_NO_PRICE` + برجسته در UI |
| E5-02 | فرمول بدون Routing | دستمزد/سربار از میانگین ۳ سفارش اخیر (§۵.۳) |
| E5-03 | بدون تاریخچه تولید | دستمزد=۰ + `W_NO_LABOR_HISTORY` |
| E5-04 | `qty` کسری | مجاز برای برآورد (بر خلاف تولید) |
| E5-05 | کالای مشترک بین دو محصول | Low-Level Code — یک‌بار جمع |
| E5-06 | حلقه در MRP | `E_BOM_CIRCULAR` |
| E5-07 | `lead_time_days=0` | `order_by = need_by` |
| E5-08 | `min_order_qty > net` | خرید = `min_order_qty` (نه `net`) |
| E5-09 | موجودی منفی موجود | `available` منفی → `net = gross + |on_hand|` |
| E5-10 | رزرو > موجودی | `available` منفی + هشدار مغایرت |
| E5-11 | MRP روی ۱۰٬۰۰۰ کالا | ایندکس + دسته‌بندی + پیشرفت درصدی + timeout ۶۰ ثانیه |
| E5-12 | `valid_until` گذشته ولی مشتری اصرار دارد | `POST /estimates/:id/recalculate` → نسخه جدید |
| E5-13 | برآورد بدون مشتری | مجاز — `customer_id=NULL` |
| E5-14 | تخفیف ۱۰۰٪ | `E_DISCOUNT_RANGE` |
| E5-15 | `d_max` منفی (بهای تمام‌شده > قیمت) | 🔴 «این محصول با قیمت فعلی ضررده است» |
| E5-16 | تبدیل برآورد ۵۰۰ عددی به ۲ سفارش ۲۵۰ | مجاز — `convert` با `qty` دلخواه، `converted_order_id` آخری |

---

## ۱۲. خطاهای احتمالی

| کد | HTTP | پیام |
|----|------|------|
| `E_QTY_INVALID` | 422 | تعداد باید بزرگ‌تر از صفر باشد |
| `E_VALID_UNTIL_PAST` | 422 | تاریخ اعتبار نباید گذشته باشد |
| `E_MARGIN_NEGATIVE` | 422 | حاشیه سود منفی مجاز نیست |
| `E_NOT_CONFIRMED` | 409 | ابتدا برآورد را تأیید کنید |
| `E_ALREADY_CONVERTED` | 409 | این برآورد قبلاً به سفارش {no} تبدیل شده |
| `E_ESTIMATE_EXPIRED` | 409 | برآورد در {date} منقضی شده — بازمحاسبه کنید |
| `E_ESTIMATE_LOCKED` | 409 | برآورد تأییدشده قابل ویرایش نیست |
| `E_HORIZON_RANGE` | 422 | افق برنامه‌ریزی باید بین ۱ تا ۳۶۵ روز باشد |
| `E_INVALID_PRICE_BASIS` | 422 | مبنای قیمت نامعتبر |
| `E_MRP_RUNNING` | 409 | یک اجرای MRP در حال انجام است |
| `E_DISCOUNT_RANGE` | 422 | تخفیف باید بین ۰ تا ۹۹ باشد |
| `W_NO_PRICE` | 200⚠ | «{name}» قیمتی ندارد — برآورد ناقص است |
| `W_NO_LABOR_HISTORY` | 200⚠ | تاریخچه دستمزد برای «{name}» موجود نیست |
| `W_DISCOUNT_BELOW_COST` | 200⚠ | تخفیف {d}٪ زیر نقطه شکست ({dmax}٪) — ضرر |

---

## ۱۳. Undo و اصلاح

| عملیات | روش |
|--------|-----|
| ویرایش `draft` | آزاد |
| ویرایش `confirmed` | `POST /estimates/:id/unconfirm` (اگر تبدیل نشده) |
| بازمحاسبه با نرخ روز | `POST /estimates/:id/recalculate` → نسخه جدید، اصلی `expired` |
| ابطال تبدیل | ابطال سفارش تولید → `estimate.status='confirmed'` + `converted_order_id=NULL` |
| حذف MRP | `DELETE /mrp/:id` (فقط اگر سفارش خریدی از آن ساخته نشده) |

---

## ۱۴. گزارش‌ها

| گزارش | endpoint |
|-------|----------|
| R5-01 لیست برآوردها | `GET /production/estimates` |
| R5-02 برگه برآورد (چاپ) | `GET /production/estimates/:id/sheet` |
| R5-03 تحلیل قیمت و تخفیف | `GET /production/estimates/:id/pricing` |
| R5-04 دقت برآورد | `GET /production/reports/estimate-accuracy` |
| R5-05 نرخ تبدیل برآورد | `GET /production/reports/estimate-conversion` |
| R5-06 لیست کسری | `GET /production/estimates/:id/shortage` |
| R5-07 نتیجه MRP | `GET /production/mrp/:id` |
| R5-08 پیشنهاد خرید | `GET /production/mrp/:id/purchase-suggestions` |
| R5-09 بار ظرفیت | `GET /production/mrp/:id/capacity` |
| R5-10 نیاز نقدینگی | `GET /production/mrp/:id/cash-requirement` |
| R5-11 اقلام دیر شده | `GET /production/mrp/:id/late-items` |
| R5-12 هدف بهای تمام‌شده | `GET /production/estimates/:id/target-cost?price=` |

---

## ۱۵. دسترسی کاربران

| نقش | برآورد بها | مشاهده بهای تمام‌شده | MRP | تبدیل به سفارش |
|-----|:----------:|:--------------------:|:---:|:--------------:|
| admin | ✅ | ✅ | ✅ | ✅ |
| accounting | ✅ | ✅ | ✅ | ✅ |
| production_manager | ✅ | ✅ | ✅ | ✅ |
| sales_manager | ✅ | ✅ | ✅ (فقط مشاهده) | ❌ |
| field_sales | ✅ | ❌ **فقط قیمت پیشنهادی** | ❌ | ❌ |
| production_operator | ❌ | ❌ | ❌ | ❌ |

> **مهم:** ویزیتور میدانی باید بتواند قیمت بدهد ولی **بهای تمام‌شده را نبیند**.
> پرچم `hide_cost` در توکن → API فیلدهای `est_*_rial` و `unit_cost_rial` را حذف کند (نه فقط CSS).

---

## ۱۶. APIهای موردنیاز

```
# برآورد
GET    /api/production/estimates                    ?status=&customer_id=&from=&to=
POST   /api/production/estimates                    ★ ایجاد + محاسبه
       body: { product_id, qty, bom_id?, date, customer_id?, sales_order_id?,
               price_basis?, margin_percent?, valid_until?, size_breakdown?, title? }
GET    /api/production/estimates/:id
PUT    /api/production/estimates/:id                فقط draft
DELETE /api/production/estimates/:id                فقط draft
POST   /api/production/estimates/:id/confirm
POST   /api/production/estimates/:id/unconfirm
POST   /api/production/estimates/:id/recalculate    → برآورد جدید با نرخ روز
POST   /api/production/estimates/:id/convert        { qty?, analysis_type?, planned_start? }
GET    /api/production/estimates/:id/sheet          برگه چاپی
GET    /api/production/estimates/:id/pricing        ?discount=15&commission=4.5
GET    /api/production/estimates/:id/shortage
GET    /api/production/estimates/:id/target-cost    ?price=280000
GET    /api/production/estimates/compare            ?a=1&b=2
POST   /api/production/estimates/quick              ★ محاسبه بدون ذخیره
       body: { product_id, qty, price_basis? }

# MRP
GET    /api/production/mrp                          فهرست اجراها
POST   /api/production/mrp/run                      ★ اجرای MRP
       body: { horizon_days, demand_source, include_safety, include_on_order }
GET    /api/production/mrp/:id
GET    /api/production/mrp/:id/requirements         ?action=purchase|produce
GET    /api/production/mrp/:id/purchase-suggestions
POST   /api/production/mrp/:id/create-purchase-orders  { requirement_ids: [] }
POST   /api/production/mrp/:id/create-production-orders { requirement_ids: [] }
GET    /api/production/mrp/:id/capacity
GET    /api/production/mrp/:id/cash-requirement
GET    /api/production/mrp/:id/late-items
DELETE /api/production/mrp/:id
```

### `POST /estimates/quick`

**درخواست:**
```json
{ "product_id": 101, "qty": 500, "price_basis": "max", "date": "1405/04/24" }
```

**پاسخ:**
```json
{
  "product": { "id": 101, "name": "مانتو کتان ترمه — سبز" },
  "bom": { "id": 2, "code": "BOM-000101", "version": 2, "has_routing": true },
  "qty_target": 500, "qty_start": 524, "total_yield_percent": 95.5647,
  "price_basis": "max",
  "qty_out": 500.759028,
  "cost": {
    "material_rial": 905760816,
    "packaging_rial": 7860000,
    "labor_rial": 148863005,
    "subcontract_rial": 19318622,
    "overhead_rial": 83554367,
    "gross_rial": 1165356810,
    "by_credit_rial": 5659200,
    "net_rial": 1159697610,
    "unit_cost_rial": 2315880, "unit_cost_toman": 231588.0
  },
  "pricing": {
    "margin_percent": 35,
    "markup_price_rial": 3126438, "markup_price_toman": 312643.8,
    "margin_price_rial": 3562892, "margin_price_toman": 356289.2,
    "list_price_toman": 320000,
    "note": "Mark-up ۳۵٪ ≠ Margin ۳۵٪ — حاشیه واقعی Mark-up روی فروش: ۲۵.۹۳٪"
  },
  "discount_analysis": {
    "commission_pct": 4.5,
    "breakeven_discount_pct": 24.22,
    "scenarios": [
      { "discount_pct":0,  "net_toman":320000, "commission_toman":14400, "profit_toman":74012, "margin_pct":23.1, "total_profit_toman":37006000 },
      { "discount_pct":10, "net_toman":288000, "commission_toman":12960, "profit_toman":43452, "margin_pct":15.1, "total_profit_toman":21726000 },
      { "discount_pct":15, "net_toman":272000, "commission_toman":12240, "profit_toman":28172, "margin_pct":10.4, "total_profit_toman":14086000 },
      { "discount_pct":20, "net_toman":256000, "commission_toman":11520, "profit_toman":12892, "margin_pct":5.0,  "total_profit_toman":6446000  }
    ]
  },
  "mrp": {
    "feasible": false,
    "shortage_count": 3,
    "shortage_rial": 456000000,
    "earliest_date": "1405/05/28",
    "late_items": [
      { "product_id":204, "name":"دکمه چوبی ۲۰ میل",
        "shortage_qty":1908.16, "lead_time_days":20,
        "order_by_date":"1405/04/20", "days_late":4,
        "alternatives":["دکمه ۱۸ میل (BOM-000103)"] }
    ]
  },
  "capacity": {
    "bottleneck": "CC-30 دوخت", "max_load_pct": 59.0, "feasible": true
  },
  "warnings": [
    "🔴 دکمه چوبی: تاریخ سفارش ۴ روز گذشته — تحویل ۱۴۰۵/۰۵/۲۰ در خطر",
    "مبنای قیمت 'max' استفاده شد (بیشینه میانگین و آخرین خرید)"
  ]
}
```

---

## ۱۷. رویدادها

| رویداد | Payload |
|--------|---------|
| `estimate.created` | `{estimateId, productId, qty, unitCostRial}` |
| `estimate.confirmed` | `{estimateId, customerId, suggestedPriceRial}` |
| `estimate.converted` | `{estimateId, orderId, qty}` |
| `estimate.expired` | `{estimateId}` |
| `estimate.accuracy.computed` | `{estimateId, estRial, actualRial, pct}` |
| `mrp.run.completed` | `{runId, shortageCount, shortageRial, durationMs}` |
| `mrp.shortage.detected` | `{productId, shortageQty, needByDate}` |
| `mrp.late.detected` | `{productId, orderByDate, daysLate}` |
| `mrp.capacity.exceeded` | `{ccId, loadPct}` |
| `pricing.below_breakeven` | `{estimateId, discountPct, breakevenPct}` |

---

## ۱۸. Trigger ها

```sql
-- انقضای خودکار (فراخوانی از کرون روزانه، نه trigger — SQLite تاریخ جلالی نمی‌فهمد)
-- server/lib/production/estimate.js → expireOldEstimates(db)
--   UPDATE production_estimates SET status='expired'
--   WHERE status='confirmed' AND valid_until <> '' AND valid_until < :todayJalali;

CREATE TRIGGER IF NOT EXISTS trg_est_lock_confirmed
BEFORE UPDATE ON production_estimates
WHEN OLD.status IN ('confirmed','converted') AND NEW.status = OLD.status
BEGIN
  SELECT RAISE(ABORT, 'E_ESTIMATE_LOCKED: برآورد تأییدشده قابل ویرایش نیست')
  WHERE NEW.qty <> OLD.qty OR NEW.product_id <> OLD.product_id;
END;
```

---

## ۱۹. پیشنهاد UI

### صفحه «برآورد سریع» — پرکاربردترین صفحه فروش

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 🧮 برآورد سریع تولید                                    [ذخیره برآورد]    │
├───────────────────────────────────────────────────────────────────────────┤
│ محصول: [مانتو کتان ترمه — سبز        ▾]  تعداد: [ 500 ] عدد               │
│ مشتری: [پوشاک آسیا (VIP)             ▾]  تحویل: [۱۴۰۵/۰۵/۲۰]             │
│ مبنای قیمت: [بیشینه (میانگین/آخرین خرید) ▾]  فرمول: [v2 خودکار ▾]        │
│                                                        [🔄 محاسبه]         │
├───────────────────────────────────────────────────────────────────────────┤
│ ┌─ 💰 بهای تمام‌شده ────────────┐  ┌─ 🏷 قیمت‌گذاری ──────────────────┐  │
│ │ مواد          ۱٬۸۰۸٬۷۷۶  ۷۷.۷٪│  │ بهای تمام‌شده     ۲۳۱٬۵۸۸ ت      │  │
│ │ بسته‌بندی        ۱۵٬۶۹۶   ۰.۷٪│  │ ─────────────────────────────    │  │
│ │ دستمزد          ۲۹۷٬۲۷۵  ۱۲.۸٪│  │ Mark-up ۳۵٪      ۳۱۲٬۶۴۴ ت ⭐   │  │
│ │ پیمانکاری        ۳۸٬۵۷۹   ۱.۷٪│  │ Margin  ۳۵٪      ۳۵۶٬۲۸۹ ت      │  │
│ │ سربار           ۱۶۶٬۸۵۵   ۷.۲٪│  │ قیمت لیست فعلی   ۳۲۰٬۰۰۰ ت      │  │
│ │ (−) محصول فرعی  (۱۱٬۳۰۱)      │  │                                   │  │
│ │ ══════════════════════════════│  │ ℹ️ Mark-up ۳۵٪ = حاشیه ۲۵.۹٪    │  │
│ │ هر عدد        ۲۳۱٬۵۸۸ ت      │  │    روی فروش — یکی نیستند!        │  │
│ │ کل ۵۰۰ عدد  ۱۱۵٬۹۶۹٬۷۶۱ ت    │  └───────────────────────────────────┘  │
│ └───────────────────────────────┘                                          │
│                                                                            │
│ ┌─ 📉 تحلیل تخفیف (قیمت لیست ۳۲۰٬۰۰۰ · کمیسیون ۴.۵٪) ─────────────────┐  │
│ │ تخفیف │ خالص     │ کمیسیون │ سود/عدد │ حاشیه │ سود کل ۵۰۰ عدد       │  │
│ │  ۰٪   │ ۳۲۰٬۰۰۰ │ ۱۴٬۴۰۰ │ ۷۴٬۰۱۲ │۲۳.۱٪ │ ۳۷٬۰۰۶٬۰۰۰ ت  🟢     │  │
│ │ ۱۰٪   │ ۲۸۸٬۰۰۰ │ ۱۲٬۹۶۰ │ ۴۳٬۴۵۲ │۱۵.۱٪ │ ۲۱٬۷۲۶٬۰۰۰ ت  🟢     │  │
│ │ ۱۵٪ ◄ │ ۲۷۲٬۰۰۰ │ ۱۲٬۲۴۰ │ ۲۸٬۱۷۲ │۱۰.۴٪ │ ۱۴٬۰۸۶٬۰۰۰ ت  🟡     │  │
│ │ ۲۰٪   │ ۲۵۶٬۰۰۰ │ ۱۱٬۵۲۰ │ ۱۲٬۸۹۲ │ ۵.۰٪ │  ۶٬۴۴۶٬۰۰۰ ت  🟠     │  │
│ │ ۲۴.۲٪ │ ۲۴۲٬۴۹۶ │ ۱۰٬۹۱۲ │      ۰ │ ۰.۰٪ │           ۰   🔴     │  │
│ │ ◄ VIP ۱۰٪ + حجمی ۵٪ = ۱۵٪                                          │  │
│ │ ⚠️ نقطه شکست ۲۴.۲٪ — فقط ۹.۲ واحد فاصله تا ضرر                    │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│ ┌─ 📦 وضعیت مواد (MRP) ────────────────────────────────────────────────┐  │
│ │ کالا           │ نیاز    │ موجود │ کسری   │ Lead │ سفارش تا │ وضعیت │  │
│ │ پارچه کتان سبز │ ۸۷۳.۳۳م│  ۴۷۰ │ ۴۰۳.۳۳│ ۱۵ر │۱۴۰۵/۰۴/۲۵│  🟡   │  │
│ │ آستر ساده      │ ۱۸۹.۰۷م│  ۲۶۰ │    ۰  │  ۷ر │    —     │  ✅   │  │
│ │ نخ پلی‌استر    │  ۴۱.۹۲ق│  ۱۱۰ │    ۰  │  ۳ر │    —     │  ✅   │  │
│ │ دکمه چوبی ۲۰   │۳۲۰۸.۱۶ع│۱٬۳۰۰ │۱۹۰۸.۱۶│ ۲۰ر │۱۴۰۵/۰۴/۲۰│  🔴   │  │
│ │ لیبل ترنم      │   ۵۲۴ع │۵٬۰۰۰ │    ۰  │ ۱۰ر │    —     │  ✅   │  │
│ │ نایلون         │   ۵۲۴ع │  ۳۰۰ │   ۲۲۴ │  ۵ر │۱۴۰۵/۰۵/۰۵│  🟡   │  │
│ │ ──────────────────────────────────────────────────────────────────  │  │
│ │ 💵 خرید لازم: ۴۵٬۶۰۰٬۰۰۰ تومان                                     │  │
│ │ 🔴 دکمه چوبی ۴ روز دیر شده — تحویل ۱۴۰۵/۰۵/۲۰ در خطر               │  │
│ │    راه‌حل: [دکمه ۱۸ میل جایگزین] [خرید اضطراری] [تحویل ۰۵/۲۸]      │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│ ┌─ ⚙️ بار مراکز هزینه (۲۰ روز کاری) ──────────────────────────────────┐  │
│ │ برش    ▓░░░░░░░░░  ۶.۹٪   │ یراق  ▓▓░░░░░░░░ ۱۳.۳٪                │  │
│ │ گلدوزی ▓▓░░░░░░░░ ۱۶.۲٪  │ اتو   ▓░░░░░░░░░ ۱۰.۴٪                │  │
│ │ دوخت   ▓▓▓▓▓▓░░░░ ۵۹.۰٪ ◄ گلوگاه                                  │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  [📄 برگه چاپی]  [📧 ارسال به مشتری]  [💾 ذخیره]  [▶️ تبدیل به سفارش]   │
└───────────────────────────────────────────────────────────────────────────┘
```

### صفحه MRP کلی

```
┌────────────────────────────────────────────────────────────────────────┐
│ 📊 برنامه‌ریزی نیاز مواد (MRP)                       [▶️ اجرای جدید]    │
├────────────────────────────────────────────────────────────────────────┤
│ افق: [۳۰ ▾] روز  منبع تقاضا: ☑سفارش تولید ☑سفارش فروش ☑B2B ☐پیش‌بینی │
│ ☑ لحاظ ذخیره اطمینان   ☑ لحاظ سفارش‌های خرید باز       [اجرا]         │
├────────────────────────────────────────────────────────────────────────┤
│ آخرین اجرا: MRP-1405-0007 · ۱۴۰۵/۰۴/۲۴ ۰۹:۳۰ · ۱.۲ ثانیه              │
│ 🔴 ۳ قلم دیر · 🟡 ۸ قلم کسری · 💵 ۱۸۴٬۵۰۰٬۰۰۰ تومان خرید لازم         │
├────────────────────────────────────────────────────────────────────────┤
│ [همه ۴۲] [🔴 دیر ۳] [🟡 کسری ۸] [🛒 خرید ۹] [🏭 تولید ۲] [✅ کافی ۳۰] │
│ ┌────────────────┬──────┬──────┬─────┬──────┬─────┬────────┬────────┐ │
│ │ کالا           │ سطح  │ نیاز │موجود│ کسری │Lead │سفارش تا│ اقدام  │ │
│ ├────────────────┼──────┼──────┼─────┼──────┼─────┼────────┼────────┤ │
│ │🔴دکمه چوبی ۲۰ │  ۱   │۳۲۰۸ │۱۳۰۰│۱۹۰۸ │ ۲۰ر│۰۴/۲۰ ⚠│🛒 خرید │ │
│ │🟡پارچه کتان سبز│  ۱   │۸۷۳.۳│ ۴۷۰│۴۰۳.۳│ ۱۵ر│۰۴/۲۵  │🛒 خرید │ │
│ │🟡نایلون        │  ۱   │ ۵۲۴ │ ۳۰۰│ ۲۲۴ │  ۵ر│۰۵/۰۵  │🛒 خرید │ │
│ │✅آستر ساده     │  ۱   │۱۸۹.۱│ ۲۶۰│   ۰ │  ۷ر│   —    │   —    │ │
│ └────────────────┴──────┴──────┴─────┴──────┴─────┴────────┴────────┘ │
│ ☑انتخاب همه کسری‌ها  [🛒 ساخت پیش‌نویس فاکتور خرید] [📥 Excel]        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ۲۰. تست‌کیس‌ها

| # | عنوان | انتظار |
|---|-------|--------|
| T5-01 | برآورد سریع | `unit_cost_rial = 2,315,880` برای qty=500 |
| T5-02 | `qty_start` | `ceil(500/0.955647) = 524` |
| T5-03 | مبنای `max` | `max(average, last_purchase)` استفاده شود |
| T5-04 | Mark-up | `3,126,438 = round(2,315,880 × 1.35)` |
| T5-05 | Margin | `3,562,892 = round(2,315,880 / 0.65)` |
| T5-06 | **نقطه شکست** | `breakeven_discount_pct = 24.22` (±۰.۰۱) |
| T5-07 | سود با تخفیف ۱۵٪ | `profit_toman = 28,172` (±۱) |
| T5-08 | MRP کسری پارچه | `shortage_qty = 403.33` |
| T5-09 | MRP کافی | آستر → `shortage_qty = 0` (با `on_order=200`) |
| T5-10 | تاریخ سفارش | دکمه → `order_by_date = 1405/04/20`, `days_late=4` |
| T5-11 | `min_order_qty` | کسری ۴۰۳.۳۳، حداقل ۵۰ → پیشنهاد ۴۵۰ |
| T5-12 | ذخیره اطمینان | `available = on_hand − reserved + on_order − safety` |
| T5-13 | **Low-Level Code** | پارچه در دو BOM → یک‌بار جمع، نه دو بار |
| T5-14 | حلقه MRP | `422 E_BOM_CIRCULAR` |
| T5-15 | ظرفیت | دوخت → `load_pct = 59.0` (±۰.۱) |
| T5-16 | تبدیل | `convert` → `production_orders` جدید + `converted_order_id` |
| T5-17 | تبدیل دوباره | `409 E_ALREADY_CONVERTED` |
| T5-18 | تبدیل منقضی | `409 E_ESTIMATE_EXPIRED` |
| T5-19 | ویرایش تأییدشده | `409 E_ESTIMATE_LOCKED` |
| T5-20 | انقضا | کرون → `status='expired'` |
| T5-21 | بازمحاسبه | برآورد جدید + اصلی `expired` |
| T5-22 | **بدون سند** | `SELECT COUNT(*) FROM journal_entries WHERE ref_type LIKE 'estimate%'` = 0 |
| T5-23 | **بدون تغییر موجودی** | `products.stock` قبل و بعد یکسان |
| T5-24 | مخفی‌سازی بها | `field_sales` → پاسخ فاقد `unit_cost_rial` |
| T5-25 | دقت | پس از close → `accuracy_percent` محاسبه شود |
| T5-26 | هدف بها | `target-cost?price=280000` → `2,074,074` (= 2,800,000/1.35) |
| T5-27 | کالای بی‌قیمت | `W_NO_PRICE` + `unit_cost` جزئی |
| T5-28 | MRP همزمان | دو run موازی → `409 E_MRP_RUNNING` |
| T5-29 | ساخت فاکتور خرید | `create-purchase-orders` → `purchase_invoices` پیش‌نویس، **بدون سند** |
| T5-30 | افق ۴۰۰ روز | `422 E_HORIZON_RANGE` |
| T5-31 | **مقیاس‌ناپذیری** | `unit_cost(300) == unit_cost(500)` — مستند و مورد انتظار (§۷) |

---

## ۲۱. شبه‌کد

```js
// server/lib/production/estimate.js

function quickEstimate(db, { productId, qty, date, bomId, priceBasis, marginPct, sizeBreakdown, hideCost }) {
  date       = date || todayJalali();
  const period = jalaliPeriod(date);
  priceBasis = priceBasis || setting(db,'production_estimate_price_basis') || 'max';
  marginPct  = marginPct ?? (parseFloat(setting(db,'pricing_margin_percent')) || 35);
  if (!(qty > 0)) throw err('E_QTY_INVALID', 422);

  const bom = resolveBom(db, { productId, date, preferredBomId: bomId, allowAlternative: !!bomId });
  const warnings = [];

  // ═══ الف) بها ═══
  let cost;
  if (bom.has_routing) {
    const r = rollUpBom(db, { bomId: bom.id, qtyTarget: qty, period, priceBasis });
    cost = r.breakdown;
    cost.qty_start = r.qty_start;
    cost.total_yield_percent = r.total_yield_percent;
    warnings.push(...r.warnings);
  } else {
    const ex = explodeBom(db, { bomId: bom.id, qty, sizeBreakdown, priceBasis });
    const mat = ex.lines.filter(l=>l.line_kind==='material').reduce((s,l)=>s+l.amount_rial,0);
    const pkg = ex.lines.filter(l=>l.line_kind==='packaging').reduce((s,l)=>s+l.amount_rial,0);
    const lab = qty * avgHistorical(db, productId, 'labor_cost_rial', warnings);
    const oh  = qty * avgHistorical(db, productId, 'overhead_cost_rial', warnings);
    const gross = mat + pkg + lab + oh;
    cost = { material_rial:mat, packaging_rial:pkg, labor_rial:Math.round(lab),
             subcontract_rial:0, overhead_rial:Math.round(oh),
             gross_rial:Math.round(gross), by_credit_rial:0, net_rial:Math.round(gross),
             unit_cost_rial: Math.round(gross/qty), qty_start: qty, total_yield_percent: 100 };
  }
  const uc = cost.unit_cost_rial;

  // ═══ قیمت‌گذاری ═══
  const listPriceRial = db.prepare('SELECT price_rial FROM products WHERE id=?').get(productId)?.price_rial || 0;
  const pricing = {
    margin_percent: marginPct,
    markup_price_rial: Math.round(uc * (1 + marginPct/100)),
    margin_price_rial: marginPct < 100 ? Math.round(uc / (1 - marginPct/100)) : 0,
    list_price_rial: listPriceRial,
    note: `Mark-up ${marginPct}٪ ≠ Margin ${marginPct}٪ — حاشیه واقعی Mark-up روی فروش: ${(marginPct/(100+marginPct)*100).toFixed(2)}٪`,
  };

  // ═══ تحلیل تخفیف ═══
  const c = parseFloat(setting(db,'rep_commission_percent')) || 4.5;
  const base = listPriceRial || pricing.markup_price_rial;
  const breakeven = base > 0 ? 100 * (1 - uc / (base * (1 - c/100))) : 0;
  const scenarios = [0,10,15,20].map(d => {
    const net  = Math.round(base * (1 - d/100));
    const comm = Math.round(net * c/100);
    const prof = net - comm - uc;
    return { discount_pct:d, net_rial:net, commission_rial:comm, profit_rial:prof,
             margin_pct: net ? round2(prof/net*100) : 0, total_profit_rial: prof*qty };
  });
  if (breakeven < 20)
    warnings.push(`⚠️ نقطه شکست ${breakeven.toFixed(1)}٪ زیر سقف تخفیف ۲۰٪ ترنم است`);

  // ═══ ب) MRP ═══
  const mrp = checkAvailability(db, { bomId: bom.id, qty: cost.qty_start, date, sizeBreakdown });

  // ═══ ظرفیت ═══
  const capacity = bom.has_routing ? capacityLoad(db, { bomId: bom.id, qty: cost.qty_start, date }) : null;

  const out = { product: productInfo(db, productId),
                bom: { id:bom.id, code:bom.code, version:bom.version, has_routing:!!bom.has_routing },
                qty_target: qty, qty_start: cost.qty_start,
                total_yield_percent: cost.total_yield_percent,
                price_basis: priceBasis,
                cost, pricing,
                discount_analysis: { commission_pct:c, breakeven_discount_pct: round2(breakeven), scenarios },
                mrp, capacity, warnings };

  return hideCost ? stripCostFields(out) : out;
}

/** بررسی موجودی برای یک برآورد */
function checkAvailability(db, { bomId, qty, date, sizeBreakdown }) {
  const ex = explodeBom(db, { bomId, qty, sizeBreakdown, priceBasis: 'average' });
  const items = [], late = [];
  let shortageRial = 0, earliest = date;

  for (const L of ex.lines) {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
    const onHand = db.prepare(`SELECT COALESCE(SUM(ws.qty),0) q FROM warehouse_stock ws
                               JOIN warehouses w ON w.id=ws.warehouse_id
                               WHERE ws.product_id=? AND w.kind IN ('raw','general')`).get(L.product_id).q;
    const reserved = db.prepare(`SELECT COALESCE(SUM(qty - qty_consumed),0) q
                                 FROM production_reservations
                                 WHERE product_id=? AND status='active'`).get(L.product_id).q;
    const onOrder  = openPurchaseQty(db, L.product_id);
    const safety   = p.safety_stock || 0;
    const available = onHand - reserved + onOrder - safety;
    const shortage  = Math.max(0, round6(L.qty_final - available));

    let suggested = shortage;
    if (shortage > 0 && p.min_order_qty > 0)
      suggested = Math.ceil(shortage / p.min_order_qty) * p.min_order_qty;

    const orderBy = jalaliSubDays(date, p.lead_time_days || 0);
    const daysLate = shortage > 0 ? jalaliDiffDays(todayJalali(), orderBy) : 0;

    if (shortage > 0) {
      shortageRial += Math.round(suggested * (p.average_cost_rial || 0));
      if (daysLate > 0) {
        late.push({ product_id:L.product_id, name:p.name, shortage_qty:shortage,
                    lead_time_days:p.lead_time_days, order_by_date:orderBy, days_late:daysLate,
                    alternatives: findAlternativeBoms(db, bomId, L.product_id) });
        const possible = jalaliAddDays(todayJalali(), p.lead_time_days || 0);
        if (possible > earliest) earliest = possible;
      }
    }

    items.push({ product_id:L.product_id, name:p.name, unit:p.unit,
                 required_qty:L.qty_final, on_hand:onHand, reserved, on_order:onOrder,
                 safety_stock:safety, available_qty:available, shortage_qty:shortage,
                 suggested_qty:suggested, lead_time_days:p.lead_time_days,
                 order_by_date:orderBy, days_late:daysLate,
                 action: shortage>0 ? (p.is_manufactured?'produce':'purchase') : 'ok',
                 est_cost_rial: Math.round(suggested * (p.average_cost_rial||0)) });
  }

  return { feasible: late.length === 0,
           shortage_count: items.filter(i=>i.shortage_qty>0).length,
           shortage_rial: shortageRial,
           earliest_date: earliest, items, late_items: late };
}

/** اجرای MRP کلی */
function mrpRun(db, { horizonDays, demandSource, includeSafety, includeOnOrder, userId }) {
  if (!(horizonDays >= 1 && horizonDays <= 365)) throw err('E_HORIZON_RANGE', 422);
  if (db.prepare("SELECT 1 FROM mrp_runs WHERE status='running' LIMIT 1").get())
    throw err('E_MRP_RUNNING', 409);

  const t0 = Date.now();
  const runId = db.prepare(`INSERT INTO mrp_runs
      (code,run_type,horizon_days,demand_source,include_safety,include_on_order,status,date,created_by)
      VALUES (?,'net',?,?,?,?,'running',?,?)`)
    .run(allocateNumber(db,'mrp_run','MRP'), horizonDays, demandSource,
         includeSafety?1:0, includeOnOrder?1:0, todayJalali(), userId).lastInsertRowid;

  try {
    return db.transaction(() => {
      const llc     = computeLowLevelCodes(db);              // §6.2
      const horizon = jalaliAddDays(todayJalali(), horizonDays);
      const gross   = {};                                    // productId → {qty, needBy}

      const add = (pid, qty, needBy) => {
        gross[pid] ||= { qty: 0, need_by: needBy };
        gross[pid].qty += qty;
        if (needBy < gross[pid].need_by) gross[pid].need_by = needBy;
      };

      // تقاضا از سفارش‌های تولید باز
      for (const po of db.prepare(`SELECT * FROM production_orders
            WHERE status IN ('draft','released','in_progress') AND planned_end<=?`).all(horizon)) {
        const remain = po.qty_planned - po.qty_produced;
        if (remain <= 0 || !po.bom_id) continue;
        for (const L of explodeBom(db, { bomId: po.bom_id, qty: remain,
                                         sizeBreakdown: safeJson(po.size_breakdown) }).lines)
          add(L.product_id, L.qty_final, po.planned_start || po.date);
      }

      // تقاضا از سفارش‌های فروش
      if (['orders','mixed'].includes(demandSource)) {
        for (const so of openSalesOrders(db, horizon)) {
          const p = db.prepare('SELECT * FROM products WHERE id=?').get(so.product_id);
          if (p.is_manufactured) add(so.product_id, so.qty, so.delivery_date);
        }
      }

      // پردازش به ترتیب سطح (Low-Level Code صعودی)
      const sorted = Object.keys(gross).map(Number)
                       .sort((a,b) => (llc[a]||0) - (llc[b]||0));
      let shortCount = 0, shortRial = 0;

      for (const pid of sorted) {
        const g = gross[pid];
        const p = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
        const onHand   = warehouseQty(db, pid, ['raw','general','finished']);
        const reserved = reservedQty(db, pid);
        const onOrder  = includeOnOrder ? openPurchaseQty(db, pid) : 0;
        const safety   = includeSafety ? (p.safety_stock || 0) : 0;
        const available = onHand - reserved + onOrder - safety;
        const net = Math.max(0, round6(g.qty - available));

        let suggested = net, action = 'none';
        if (net > 0) {
          action = p.is_manufactured ? 'produce' : 'purchase';
          if (p.min_order_qty > 0) suggested = Math.ceil(net / p.min_order_qty) * p.min_order_qty;
          shortCount++;
          shortRial += Math.round(suggested * (p.average_cost_rial || 0));

          // بازگشتی: نیاز مواد کالای ساختنی به سطوح بعد اضافه شود
          if (action === 'produce') {
            try {
              const b = resolveBom(db, { productId: pid, date: todayJalali() });
              for (const L of explodeBom(db, { bomId: b.id, qty: suggested }).lines)
                add(L.product_id, L.qty_final, jalaliSubDays(g.need_by, prodLeadDays(db, b.id, suggested)));
            } catch { /* بدون فرمول — خریدنی تلقی می‌شود */ }
          }
        }

        db.prepare(`INSERT INTO mrp_requirements
          (run_id,product_id,level,gross_req_qty,on_hand_qty,reserved_qty,on_order_qty,
           safety_stock,net_req_qty,suggested_qty,action,need_by_date,order_by_date,
           est_cost_rial,supplier_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(runId, pid, llc[pid]||0, g.qty, onHand, reserved, onOrder, safety,
               net, suggested, action, g.need_by,
               jalaliSubDays(g.need_by, p.lead_time_days||0),
               Math.round(suggested * (p.average_cost_rial||0)),
               preferredSupplier(db, pid));
      }

      db.prepare(`UPDATE mrp_runs SET status='done', total_shortage_items=?,
                  total_shortage_rial=?, duration_ms=? WHERE id=?`)
        .run(shortCount, shortRial, Date.now()-t0, runId);

      emit(db,'mrp.run.completed',{ runId, shortageCount:shortCount, shortageRial:shortRial, durationMs:Date.now()-t0 });
      return { run_id: runId, shortage_count: shortCount, shortage_rial: shortRial, duration_ms: Date.now()-t0 };
    })();
  } catch (e) {
    db.prepare("UPDATE mrp_runs SET status='failed', error=? WHERE id=?").run(String(e.message), runId);
    throw e;
  }
}

/** تبدیل برآورد به سفارش تولید */
function convertEstimate(db, { estimateId, qty, analysisType, plannedStart, userId }) {
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM production_estimates WHERE id=?').get(estimateId);
    if (!e)                          throw err('E_NOT_FOUND', 404);
    if (e.status === 'converted')    throw err('E_ALREADY_CONVERTED', 409, { no: e.converted_order_id });
    if (e.status === 'expired')      throw err('E_ESTIMATE_EXPIRED', 409, { date: e.valid_until });
    if (e.status !== 'confirmed')    throw err('E_NOT_CONFIRMED', 409);

    const orderId = createOrder(db, {
      productId: e.product_id, bomId: e.bom_id,
      qtyPlanned: qty || e.qty,
      analysisType: analysisType || setting(db,'production_default_analysis') || 'fixed',
      productionMode: e.sales_order_id ? 'MTO' : 'MTS',
      salesOrderId: e.sales_order_id, customerId: e.customer_id,
      sizeBreakdown: e.size_breakdown, plannedStart: plannedStart || todayJalali(),
      estimateId, userId,
    });

    db.prepare("UPDATE production_estimates SET status='converted', converted_order_id=? WHERE id=?")
      .run(orderId, estimateId);
    audit(userId,'update','production_estimate',estimateId,`تبدیل به سفارش #${orderId}`);
    emit(db,'estimate.converted',{ estimateId, orderId, qty: qty || e.qty });
    return { order_id: orderId };
  })();
}
```

---

## ۲۲. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی ماژول ۵ — برآورد تولید (MRP + Cost Estimation)

## پیش‌نیاز
ماژول ۱ و ۴ (BOM + Routing) کامل. ماژول ۲ برای createOrder لازم است.

## اسناد مرجع
- docs/Production/05-production-estimation.md   ← این سند
- docs/Production/04-advanced-formulas.md       ← rollUpBom
- docs/Production/database-schema.md            ← §2.13, §2.14

## ⚠️ قواعد قطعی
1. **هیچ سند حسابداری. هیچ تغییر موجودی.** فقط محاسبه.
   اگر postToLedger یا UPDATE products SET stock دیدی → غلط.
2. **Low-Level Code اجباری** — وگرنه کالای مشترک دوبار سفارش خرید می‌خورد.
3. `min_order_qty` → گرد کردن به **بالا** (`Math.ceil`).
4. `hide_cost` باید **فیلدها را از JSON حذف کند**، نه فقط CSS مخفی کند.
   نقش field_sales نباید بهای تمام‌شده را در Network tab ببیند.
5. Mark-up ≠ Margin — **هر دو** را برگردان + `note` توضیحی.
6. مبنای قیمت پیش‌فرض `max` (نه `average`) — تورم ایران.
7. `create-purchase-orders` فقط **پیش‌نویس** `purchase_invoices` بسازد — بدون سند.

## گام‌ها

### گام ۱ — Schema
server/db.js: production_estimates, production_estimate_lines,
              mrp_runs, mrp_requirements, production_reservations  (§2.13, §2.14)
+ ensureColumn های products: lead_time_days, min_order_qty, safety_stock
+ PROD_SEQUENCES: estimate (EST), mrp_run (MRP)
+ trigger trg_est_lock_confirmed
+ settings: production_estimate_price_basis='max', production_mrp_horizon_days='30',
            rep_commission_percent='4.5'

### گام ۲ — سرویس
server/lib/production/estimate.js:
  quickEstimate, saveEstimate, confirmEstimate, recalculateEstimate,
  convertEstimate, expireOldEstimates, targetCost, estimateAccuracy,
  discountAnalysis, breakevenDiscount, avgHistorical

server/lib/production/mrp.js:
  computeLowLevelCodes, mrpRun, checkAvailability,
  openPurchaseQty, reservedQty, warehouseQty,
  createPurchaseOrdersFromMrp, createProductionOrdersFromMrp,
  capacityLoad, cashRequirement, prodLeadDays

### گام ۳ — کرون
server/server.js یا یک setInterval روزانه:
  expireOldEstimates(db)  ← ساعت ۰۱:۰۰
(الگو را از backup.js بگیر که کرون دارد)

### گام ۴ — Route
server/routes/production-estimation.js — ۲۶ endpoint از §16
- POST /estimates/quick باید سریع باشد (< 500ms) — کش explodeBom
- hide_cost از req.user.role === 'field_sales' یا user_permissions

### گام ۵ — UI
1. **صفحه «برآورد سریع»** (§19) — مهم‌ترین صفحه فروش
   - محاسبه با یک دکمه، همه‌چیز در یک صفحه
   - جدول تخفیف با ردیف نقطه شکست قرمز
   - نوار بار مراکز هزینه
   - دکمه «ارسال به مشتری» → پیام‌رسان
2. **صفحه MRP** (§19) — با تب‌های وضعیت + انتخاب گروهی + Excel
3. برای field_sales: کارت بهای تمام‌شده و ستون‌های بها اصلاً render نشوند
4. RTL, Vazirmatn, #1B5C4A/#2D7A5F/#C9A84C, Mobile-first

### گام ۶ — تست
server/scripts/test-production-estimation.js — ۳۰ تست از §20
حیاتی:
  T5-06  breakeven_discount_pct = 24.22
  T5-13  Low-Level Code — کالای مشترک یک‌بار
  T5-22  هیچ سند حسابداری
  T5-23  هیچ تغییر موجودی
  T5-24  field_sales → پاسخ فاقد unit_cost_rial

## معیار پذیرش
- [ ] مثال §7 عیناً بازتولید شود
- [ ] `POST /estimates/quick` زیر ۵۰۰ میلی‌ثانیه
- [ ] MRP روی ۱٬۰۰۰ کالا زیر ۱۰ ثانیه
- [ ] `journal_entries` و `products.stock` دست‌نخورده
- [ ] field_sales نمی‌تواند بها را در API ببیند

## ممنوعیت‌ها
- ❌ سند حسابداری
- ❌ تغییر موجودی یا میانگین
- ❌ MRP بدون Low-Level Code
- ❌ مخفی‌سازی بها فقط با CSS
- ❌ گرد کردن min_order_qty به پایین
````

---

## ۲۳. خروجی‌های این ماژول

| خروجی | مسیر |
|-------|------|
| Migration | `server/db.js` |
| برآورد | `server/lib/production/estimate.js` |
| MRP | `server/lib/production/mrp.js` |
| Route | `server/routes/production-estimation.js` |
| کرون انقضا | `server/server.js` |
| UI برآورد سریع | `server/public/index.html` |
| UI MRP | `server/public/index.html` |
| تست | `server/scripts/test-production-estimation.js` |
