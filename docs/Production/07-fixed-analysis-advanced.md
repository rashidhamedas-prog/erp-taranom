# 07-fixed-analysis-advanced.md
## زیرگروه ۷ — تولید آنالیز ثابت پیشرفته (Multi-Stage Fixed / Standard-Consumption)

---

## ۱. هدف ماژول

ماژول ۲ = آنالیز ثابت **تک‌مرحله‌ای** (کل کارگاه یک جعبه سیاه).
ماژول ۷ = همان منطق، ولی روی **خط واقعی ۶ مرحله‌ای ترنم** با:

| قابلیت | ماژول ۲ | ماژول ۷ |
|--------|:-------:|:-------:|
| Backflush از BOM | ✅ | ✅ |
| مراحل تولید مجزا | ❌ | ✅ `production_order_stages` |
| مواد به تفکیک مرحله | ❌ | ✅ `bom_lines.stage_cost_center_id` |
| دستمزد به تفکیک مرکز | ❌ | ✅ ۴ روش |
| سربار با نرخ اختصاصی هر مرکز | ❌ | ✅ ۶ محرک |
| ضایعات مرحله‌ای | ❌ | ✅ |
| پیمانکاری (شستشو) | ❌ | ✅ |
| محصول فرعی/همزاد | ❌ | ✅ |
| WIP به تفکیک مرحله | ❌ | ✅ |
| گلوگاه و ظرفیت | ❌ | ✅ |
| **این حالت مرجع تولید ترنم است** | | ✅ |

**فرمول لازم:** ماژول ۴ (`has_routing=1`)

---

## ۲. ADR-012 — WIP یک حساب، تفصیلی چندگانه

**تصمیم:** WIP فقط **یک حساب کل** (`1111`) است. تفکیک مرحله‌ای از طریق **تفصیلی** و جدول `production_order_stages` انجام می‌شود، نه حساب کل جدا برای هر مرحله.

**دلایل:**
1. ۶ حساب WIP جدا (`1111-10` تا `1111-60`) = ۶ برابر سند انتقال بین مراحل، بدون ارزش افزوده مالی.
2. صورت وضعیت مالی فقط «کالای در جریان ساخت» می‌خواهد، نه تفکیک مرحله.
3. تفکیک مرحله **اطلاعات مدیریتی** است، نه مالی → `production_order_stages` کافی است.
4. سازگاری با محک و کدینگ استاندارد ایران.

**نتیجه:**
| سند | صادر می‌شود؟ | چرا |
|-----|:-----------:|-----|
| PRD-15 انتقال بین مراحل | ❌ | همان حساب به همان حساب = سند خنثی |
| PRD-01/03/05 با تفصیلی مرحله | ✅ | مواد/دستمزد/سربار هر مرحله جداگانه سند می‌خورد |

**استثنا — پیمانکاری:** PRD-13/14 **سند دارند** چون کالا واقعاً از تصرف شرکت خارج و به `1114` منتقل می‌شود (الزام حسابرسی و بیمه).

> اگر روزی به تفکیک حسابداری مرحله‌ای نیاز شد: `settings.production_wip_per_stage = 1` → حساب‌های `1111` با تفصیلی مرکب `سفارش/مرحله`. **فعلاً غیرفعال.**

---

## ۳. موجودیت‌ها و روابط

```
production_orders (analysis_type='fixed_adv')
  ├──< production_order_stages (N)   ← ستون فقرات این ماژول
  │      ├──< production_material_issues  (stage_id)
  │      ├──< production_labor_entries    (stage_id)
  │      ├──< production_overhead_applications (stage_id)
  │      ├──< production_waste            (stage_id)
  │      ├──< production_rework           (origin_stage_id, rework_stage_id)
  │      └──< production_subcontract      (stage_id)
  └──< production_receipts (N)   output_type: main | co | by | scrap

bom_headers (has_routing=1)
  ├──< bom_operations  → snapshot به production_order_stages هنگام Release
  └──< bom_outputs     → snapshot برای تسهیم رسید
```

---

## ۴. چرخه حیات مرحله

```
┌─────────┐  شروع  ┌─────────────┐  تکمیل  ┌──────┐
│ pending │───────►│ in_progress │────────►│ done │
│ منتظر   │        │ در جریان    │         │ تمام │
└────┬────┘        └──────┬──────┘         └──────┘
     │ رد شدن              │ توقف
     ▼                     ▼
┌─────────┐           ┌─────────┐
│ skipped │           │ blocked │
│ رد شده  │           │ متوقف   │
└─────────┘           └─────────┘
```

| گذار | شرط |
|------|-----|
| `pending→in_progress` | مرحله قبل `done`/`skipped` · `qty_in > 0` |
| `in_progress→done` | `qty_out + waste + rework = qty_in` |
| `pending→skipped` | فقط اگر مواد/دستمزدی ندارد + دلیل |
| `→blocked` | کسری مواد / خرابی ماشین / انتظار پیمانکار |
| `done→in_progress` | فقط با Reversal + admin |

**قاعده انتقال:** `stages[n+1].qty_in = stages[n].qty_out` و `stages[n+1].material_in_rial = stages[n].cost_out_rial`

---

## ۵. Workflow کامل

```mermaid
flowchart TD
  A[ایجاد سفارش analysis_type=fixed_adv] --> B[resolveBom + has_routing=1؟]
  B -- خیر --> C[E_NO_ROUTING]
  B -- بله --> D[backwardQty: 300 سالم → 314 شروع]
  D --> E[Release]
  E --> F[Snapshot bom_operations → production_order_stages]
  F --> G[تخصیص تفصیلی WIP سفارش]
  G --> H[رزرو مواد]
  H --> I[stages[0].qty_in = 314 · status=in_progress]

  I --> J[◄◄ مرحله ۱۰ برش ►►]
  J --> K[Backflush مواد مرحله ۱۰ از BOM]
  K --> L[PRD-01: WIP بد / مواد بس]
  L --> M[دستمزد ماهانه برش → PRD-03 + PRD-04]
  M --> N[سربار: driver=material_rial → PRD-05]
  N --> O[ثبت خروجی: qty_out=307.72 · waste_normal=6.28]
  O --> P[cost_out → material_in مرحله بعد]

  P --> Q[◄◄ مرحله ۲۰ گلدوزی ►►]
  Q --> R[بدون مواد · دستمزد کارمزدی · سربار machine_hours]
  R --> S[◄◄ مرحله ۳۰ دوخت ►►]
  S --> T[نخ Backflush · کارمزدی · سربار labor_rial · ضایعات ۱٪]
  T --> U[◄◄ مرحله ۴۰ یراق ►►]
  U --> V[دکمه Backflush · کارمزدی · سربار output_qty]

  V --> W[◄◄ مرحله ۵۰ شستشو — پیمانکاری ►►]
  W --> X[PRD-13: ارسال → 1114 بد / 1111 بس]
  X --> Y[◄ انتظار پیمانکار ►]
  Y --> Z[PRD-14: دریافت → 1111 بد / 1114 + 2101 بس]
  Z --> AA[کسری نزد پیمانکار؟ → PRD-09 ضایعات غیرعادی]

  AA --> AB[◄◄ مرحله ۶۰ اتو — QC Gate ►►]
  AB --> AC[لیبل+نایلون Backflush · دستمزد · سربار]
  AC --> AD{QC پاس شد؟}
  AD -- خیر --> AE[ثبت دوباره‌کاری → PRD-11/12]
  AE --> AB
  AD -- بله --> AF[محاسبه WIP نهایی]

  AF --> AG[کسر ضایعات غیرعادی همه مراحل → PRD-09]
  AG --> AH[محصول فرعی به NRV → PRD-16]
  AH --> AI[تسهیم بین main و co]
  AI --> AJ[PRD-07: FG بد / WIP بس]
  AJ --> AK[میانگین موزون FG]
  AK --> AL[status=completed → WIP=0؟ → closed]
```

---

## ۶. الگوریتم‌ها

### ۶.۱ Snapshot مراحل هنگام Release

```js
releaseAdvancedOrder(db, orderId, userId):
  po  = production_orders[orderId]
  bom = bom_headers[po.bom_id]
  if (!bom.has_routing) throw E_NO_ROUTING

  ops = bom_operations WHERE bom_id=po.bom_id ORDER BY seq
  { qty_start } = backwardQty(bom.id, po.qty_planned)

  transaction:
    // تفصیلی WIP سفارش
    po.coa_wip_tafsili = allocTafsili(db, 'production_order', po.order_no)

    qtyIn = qty_start
    for (op of ops):
       cc = cost_centers[op.cost_center_id]
       INSERT production_order_stages (
         order_id, seq, cost_center_id, operation_id, operation_name,
         status = (op.seq === ops[0].seq ? 'in_progress' : 'pending'),
         qty_in = (op.seq === ops[0].seq ? qtyIn : 0),
         driver = op.overhead_driver || cc.driver,
         is_subcontract = op.is_subcontract,
         supplier_id = op.subcontract_supplier_id
       )
       qtyIn = qtyIn × (op.yield_percent/100) × (1 − op.normal_waste_percent/100)

    reserveMaterials(db, orderId, qty_start)
    po.status = 'released'
    po.qty_planned_start = qty_start
```

### ۶.۲ ثبت خروجی یک مرحله

```
postStageOutput(orderId, stageId, { qty_out, waste_normal, waste_abnormal, rework, scrap[] }):

  ۰) اعتبارسنجی:
     stage.status ∈ {'in_progress'}
     qty_out + waste_normal + waste_abnormal + rework === stage.qty_in     ← V7-06
     waste_normal ≤ ceil(qty_in × op.normal_waste_percent/100)             ← مازاد خودکار غیرعادی

  ۱) Backflush مواد این مرحله:
     lines = bom_lines WHERE stage_cost_center_id = stage.cost_center_id
     برای هر قلم: qty = explodeBom(bom, stage.qty_in).lines[L].qty_final
                  amount = qty × products.average_cost_rial
     → PRD-01 با تفصیلی WIP سفارش

  ۲) دستمزد این مرحله (بر اساس op.labor_method):
     piece    → op.labor_rate_rial × qty_in
     hourly   → op.labor_rate_rial × ((setup + run×qty_in)/60 × crew)
     monthly  → از payroll_records تسهیم شود (§6.4)
     contract → صفر (به 5230 می‌رود، §6.5)
     → PRD-03 با تفصیلی مرکز هزینه

  ۳) سربار این مرحله:
     driver_qty = stageDriverQty(op, cc, {qty:qty_in, labor, material})
     applied = cost_center_rates[cc][period].total_rate_rial × driver_qty
     → PRD-05 با تفصیلی مرکز هزینه

  ۴) بهای مرحله:
     cost_in  = (اولین مرحله ? 0 : prev_stage.cost_out_rial)
     cost_gross = cost_in + material_added + labor + overhead + subcontract

  ۵) ضایعات غیرعادی این مرحله:
     cost_per_in = cost_gross / qty_in
     abnormal_rial = round(cost_per_in × waste_abnormal)
     → PRD-09 (5221 بد / 1111 بس)

  ۶) ضایعات قابل فروش این مرحله:
     scrap_credit = Σ(qty × nrv_unit_rial)
     → PRD-10 (1113 بد / 1111 بس)

  ۷) cost_out = cost_gross − abnormal_rial − scrap_credit
     unit_cost_out = cost_out / qty_out

  ۸) انتقال:
     stage.status = 'done'
     next.qty_in = qty_out
     next.material_in_rial = cost_out
     next.status = 'in_progress'
     ← بدون سند (ADR-012)

  ۹) اگر آخرین مرحله → finalizeAdvancedOrder()
```

> **⚠️ نکته:** ضایعات **عادی** مرحله‌ای هیچ سندی ندارد. `cost_out` تقسیم بر `qty_out` کوچک‌تر می‌شود → بهای واحد بالا می‌رود → جذب خودکار. ✅

### ۶.۳ تسهیم دستمزد ماهانه (روش `monthly`)

مسئله: حقوق برشکار ماهانه است، ولی باید بین سفارش‌های ماه تقسیم شود.

```
پایان هر مرحله، جذب با نرخ برآوردی:
   applied_labor = cost_center_rates[cc][period].monthly_labor_rate_rial × qty_in
   → PRD-03:  1111 بد / 5201 بس

هنگام ثبت حقوق ماه (routes/payroll.js):
   actual_labor = Σ payroll_records[persons in cc].gross_pay × 10   (تومان→ریال)
   → PRD-04:  5201 بد / 2104 بس

پایان ماه:
   مانده 5201 = actual − applied = انحراف نرخ دستمزد
   → PRD-21 → تسهیم (ADR-005)
```

**نرخ برآوردی ماهانه:**
```
monthly_labor_rate_rial[cc] = budgeted_monthly_payroll[cc] / budgeted_output_qty[cc]

Bootstrap (اگر بودجه نیست):
   pool = AVG(SUM(payroll_records.gross_pay × 10) for persons in cc) طی ۳ ماه اخیر
   qty  = AVG(SUM(production_order_stages.qty_in) for cc) طی ۳ ماه اخیر
   rate = round(pool / qty)   +  is_estimated = 1
```

### ۶.۴ اتصال دستمزد به `payroll_records`

```js
// server/lib/production/labor.js
function linkPayrollToProduction(db, { payrollRecordId, period, userId }) {
  const pr = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(payrollRecordId);
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(pr.person_id);
  const ccId = person.cost_center_id;                    // ← ensureColumn لازم
  if (!ccId) return null;                                 // پرسنل غیرتولیدی

  const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(ccId);
  const actualRial = Math.round(pr.gross_pay * 10);       // payroll به تومان است

  if (cc.kind === 'production') {
    // دستمزد مستقیم → کنترل دستمزد 5201
    postToLedger(db, {
      sourceType: 'production_labor_actual', sourceId: payrollRecordId,
      date: pr.date, description: `دستمزد واقعی ${person.name} — ${cc.name}`, createdBy: userId,
      lines: [ dr(db,'coa_labor_control', actualRial, cc.coa_tafsili_lb),
               cr(db,'coa_payroll_payable', actualRial) ],
    });
  } else {
    // سرکارگر/QC → سربار 5202
    postToLedger(db, {
      sourceType: 'production_overhead_actual', sourceId: payrollRecordId,
      date: pr.date, description: `حقوق غیرمستقیم ${person.name} — ${cc.name}`, createdBy: userId,
      lines: [ dr(db,'coa_overhead_control', actualRial, cc.coa_tafsili_oh),
               cr(db,'coa_payroll_payable', actualRial) ],
    });
  }
  db.prepare('UPDATE payroll_records SET production_linked=1 WHERE id=?').run(payrollRecordId);
}
```

**ستون‌های لازم:**
```js
ensureColumn(db, 'persons', 'cost_center_id', 'INTEGER');
ensureColumn(db, 'persons', 'labor_method', "TEXT DEFAULT 'monthly'");
ensureColumn(db, 'payroll_records', 'production_linked', 'INTEGER DEFAULT 0');
ensureColumn(db, 'payroll_records', 'cost_center_id', 'INTEGER');
```

### ۶.۵ پیمانکاری (شستشو)

```
ارسال — PRD-13:
   amount = stage.cost_in_rial / stage.qty_in × qty_sent
   1114 موجودی نزد پیمانکار  بد
   1111 WIP                  بس

دریافت — PRD-14:
   fee = op.subcontract_fee_rial × qty_received
   vat = fee × vat_rate   (اگر پیمانکار مؤدی است)
   lost = qty_sent − qty_received − qty_waste_reported

   1111 WIP                      بد  (amount_returned + fee)
   1108 مالیات ارزش افزوده       بد  (vat)
   1114 موجودی نزد پیمانکار      بس  (amount_returned + amount_lost)
   2101 حساب‌های پرداختنی        بس  (fee + vat)
   [اگر lost > 0]:
   5221 هزینه ضایعات غیرعادی     بد  (amount_lost)
   1114                          بس

⚠️ قاعده: کسری نزد پیمانکار (`qty_lost`) **همیشه غیرعادی** است.
   اگر قرارداد ضایعات مجاز دارد → در `op.normal_waste_percent` بیاور، نه در `qty_lost`.
```

### ۶.۶ دوباره‌کاری

```
طبقه‌بندی:
  normal   → در محدوده انتظار (مثلاً < ۲٪) → هزینه به WIP همان سفارش
  abnormal → خارج از انتظار → هزینه دوره (5222)

هزینه دوباره‌کاری = مواد اضافی + دستمزد اضافی + سربار اضافی

normal — PRD-11:
   1111 WIP بد / 1110 + 5201 + 5203 بس

abnormal — PRD-12:
   5222 هزینه دوباره‌کاری بد / 1110 + 5201 + 5203 بس

نتیجه:
   qty_recovered → به qty_in همان مرحله برمی‌گردد (چرخه)
   qty_failed    → ضایعات غیرعادی (PRD-09)
```

### ۶.۷ نهایی‌سازی و تسهیم خروجی

```
finalizeAdvancedOrder(orderId):
  last = stages[last]
  WIP_final = last.cost_out_rial

  outs = bom_outputs[po.bom_id]

  ۱) by/scrap با NRV — PRD-16:
     for o in outs where type in (by, scrap) and cost_method='nrv':
        qty = o.qty_per_base × qty_start / bom.base_qty
        amt = round(qty × o.nrv_rial)
        byCredit += amt
        receiveToStock(o.product_id, qty, o.nrv_rial, warehouse)
        → 1113 (یا 1104) بد / 1111 بس

  ۲) WIP_after_by = WIP_final − byCredit
     if (WIP_after_by < 0) throw E_NRV_EXCEEDS_WIP

  ۳) main + co با share — PRD-07:
     Σ share must = 100                                        ← V4-12
     assigned = 0
     for o in outs where type in (main, co):
        amt = round(WIP_after_by × o.cost_share_percent / 100)
        assigned += amt
        rows.push({o, amt})
     // اختلاف گرد کردن → main
     rows[main].amt += WIP_after_by − assigned

     for r of rows:
        updateMovingAverage(r.product_id, r.qty, r.amt)
        → 1104 بد / 1111 بس   (مبلغ = r.amt دقیقاً)

  ۴) بررسی: WIP سفارش === 0            ← اگر نه، E_WIP_RESIDUAL
```

---

## ۷. مثال کامل — سفارش `PO-1405-0010`

### ورودی
```
محصول: #101 مانتو کتان ترمه — سبز
فرمول: BOM-000101 v2 (has_routing=1, has_coproducts=1)
هدف:   ۳۰۰ عدد سالم  →  qty_start = 314
analysis_type = 'fixed_adv'  ·  تاریخ ۱۴۰۵/۰۴/۱۵  ·  دوره 1405/04
```

### جدول اجرای مراحل (نتیجه واقعی، مطابق استاندارد)

| مرحله | ورودی | خروجی | ض.عادی | ض.غیرعادی | بهای ورودی | مواد | دستمزد | پیمان | سربار | بهای خروجی | واحد |
|-------|------:|------:|-------:|----------:|-----------:|-----:|-------:|------:|------:|-----------:|-----:|
| **۱۰ برش** | ۳۱۴.۰۰ | ۳۰۷.۷۲ | ۶.۲۸ | ۰ | ۰ | ۵۱۷٬۵۶۰٬۴۸۱ | ۷٬۸۵۰٬۰۰۰ | ۰ | ۴٬۶۵۸٬۰۴۴ | ۵۳۰٬۰۶۸٬۵۲۵ | ۱٬۷۲۲٬۵۶۸ |
| **۲۰ گلدوزی** | ۳۰۷.۷۲ | ۳۰۷.۷۲ | ۰ | ۰ | ۵۳۰٬۰۶۸٬۵۲۵ | ۰ | ۱۳٬۸۴۷٬۴۰۰ | ۰ | ۱۸٬۴۶۳٬۲۰۰ | ۵۶۲٬۳۷۹٬۱۲۵ | ۱٬۸۲۷٬۵۶۸ |
| **۳۰ دوخت** | ۳۰۷.۷۲ | ۳۰۴.۶۴ | ۳.۰۸ | ۰ | ۵۶۲٬۳۷۹٬۱۲۵ | ۲٬۱۳۵٬۲۰۰ | ۵۵٬۳۸۹٬۶۰۰ | ۰ | ۱۹٬۳۸۶٬۳۶۰ | ۶۳۹٬۲۹۰٬۲۸۵ | ۲٬۰۹۸٬۴۹۱ |
| **۴۰ یراق** | ۳۰۴.۶۴ | ۳۰۴.۶۴ | ۰ | ۰ | ۶۳۹٬۲۹۰٬۲۸۵ | ۲۳٬۰۶۹٬۳۸۸ | ۷٬۶۱۶٬۰۷۰ | ۰ | ۲٬۴۳۷٬۱۴۲ | ۶۷۲٬۴۱۲٬۸۸۵ | ۲٬۲۰۷٬۲۱۷ |
| **۵۰ شستشو** 🏭 | ۳۰۴.۶۴ | ۳۰۰.۰۷ | ۴.۵۷ | ۰ | ۶۷۲٬۴۱۲٬۸۸۵ | ۰ | ۰ | ۱۱٬۵۷۶٬۴۲۶ | ۱٬۵۲۳٬۲۱۴ | ۶۸۵٬۵۱۲٬۵۲۵ | ۲٬۲۸۴٬۴۸۵ |
| **۶۰ اتو** ✅ | ۳۰۰.۰۷ | ۳۰۰.۰۷ | ۰ | ۰ | ۶۸۵٬۵۱۲٬۵۲۵ | ۴٬۷۱۰٬۰۰۰ | ۴٬۵۰۱٬۰۹۷ | ۰ | ۳٬۶۰۰٬۸۷۸ | **۶۹۸٬۳۲۴٬۵۰۰** | ۲٬۳۲۷٬۱۸۱ |

> این دقیقاً همان جدول Roll-Up ماژول ۴ است — چون **آنالیز ثابت یعنی واقعی = استاندارد**.
> انحراف فقط از **نرخ میانگین انبار ≠ نرخ استاندارد BOM** می‌آید (اینجا هر دو یکسان فرض شده).

### اسناد صادرشده (به ترتیب)

| # | مرحله | رویداد | بدهکار | بستانکار | مبلغ (ریال) |
|--:|-------|--------|--------|----------|------------:|
| ۱ | ۱۰ | PRD-01 | `1111`/PO-1405-0010 | `1110` | ۵۱۷٬۵۶۰٬۴۸۱ |
| ۲ | ۱۰ | PRD-03 | `1111`/PO-1405-0010 | `5201`/CC-10 | ۷٬۸۵۰٬۰۰۰ |
| ۳ | ۱۰ | PRD-05 | `1111`/PO-1405-0010 | `5203`/CC-10 | ۴٬۶۵۸٬۰۴۴ |
| ۴ | ۲۰ | PRD-03 | `1111` | `5201`/CC-20 | ۱۳٬۸۴۷٬۴۰۰ |
| ۵ | ۲۰ | PRD-05 | `1111` | `5203`/CC-20 | ۱۸٬۴۶۳٬۲۰۰ |
| ۶ | ۳۰ | PRD-01 | `1111` | `1110` | ۲٬۱۳۵٬۲۰۰ |
| ۷ | ۳۰ | PRD-03 | `1111` | `5201`/CC-30 | ۵۵٬۳۸۹٬۶۰۰ |
| ۸ | ۳۰ | PRD-05 | `1111` | `5203`/CC-30 | ۱۹٬۳۸۶٬۳۶۰ |
| ۹ | ۴۰ | PRD-01 | `1111` | `1110` | ۲۳٬۰۶۹٬۳۸۸ |
| ۱۰ | ۴۰ | PRD-03 | `1111` | `5201`/CC-40 | ۷٬۶۱۶٬۰۷۰ |
| ۱۱ | ۴۰ | PRD-05 | `1111` | `5203`/CC-40 | ۲٬۴۳۷٬۱۴۲ |
| ۱۲ | ۵۰ | **PRD-13** | `1114` نزد پیمانکار | `1111` | ۶۷۲٬۴۱۲٬۸۸۵ |
| ۱۳ | ۵۰ | **PRD-14** | `1111` + `1108` | `1114` + `2101` | ۶۸۵٬۱۱۵٬۹۹۹ |
| ۱۴ | ۵۰ | PRD-05 | `1111` | `5203`/CC-50 | ۱٬۵۲۳٬۲۱۴ |
| ۱۵ | ۶۰ | PRD-01 | `1111` | `1112` بسته‌بندی | ۴٬۷۱۰٬۰۰۰ |
| ۱۶ | ۶۰ | PRD-03 | `1111` | `5201`/CC-60 | ۴٬۵۰۱٬۰۹۷ |
| ۱۷ | ۶۰ | PRD-05 | `1111` | `5203`/CC-60 | ۳٬۶۰۰٬۸۷۸ |
| ۱۸ | — | **PRD-16** | `1113` ضایعات فروشی | `1111` | ۳٬۳۹۱٬۲۰۰ |
| ۱۹ | — | **PRD-07** | `1104` کالای ساخته | `1111` | **۶۹۴٬۹۳۳٬۳۰۰** |

> **PRD-15 (انتقال بین مراحل) وجود ندارد** — ADR-012 ✅

### جزئیات سند ۱۲ — ارسال به پیمانکار (PRD-13)

| حساب | نام | تفصیلی | بدهکار | بستانکار |
|------|-----|--------|-------:|---------:|
| `1114` | موجودی نزد پیمانکار | خشکشویی رضوان | ۶۷۲٬۴۱۲٬۸۸۵ | |
| `1111` | کالای در جریان ساخت | PO-1405-0010 | | ۶۷۲٬۴۱۲٬۸۸۵ |

### جزئیات سند ۱۳ — دریافت از پیمانکار (PRD-14)

```
ارسال: ۳۰۴.۶۴ عدد  ·  بهای ارسالی: ۶۷۲٬۴۱۲٬۸۸۵
دریافت: ۳۰۰.۰۷ عدد  ·  ضایعات گزارش‌شده پیمانکار: ۴.۵۷ (عادی، طبق قرارداد ۱.۵٪)
کسری: ۰
کارمزد: ۳۸٬۰۰۰ × ۳۰۴.۶۴ = ۱۱٬۵۷۶٬۴۲۶
مالیات ارزش افزوده ۱۰٪: ۱٬۱۵۷٬۶۴۳
```

| حساب | نام | تفصیلی | بدهکار | بستانکار |
|------|-----|--------|-------:|---------:|
| `1111` | کالای در جریان ساخت | PO-1405-0010 | ۶۸۳٬۹۸۹٬۳۱۱ | |
| `1108` | مالیات ارزش افزوده دریافتنی | | ۱٬۱۵۷٬۶۴۳ | |
| `1114` | موجودی نزد پیمانکار | خشکشویی رضوان | | ۶۷۲٬۴۱۲٬۸۸۵ |
| `2101` | حساب‌های پرداختنی | خشکشویی رضوان | | ۱۲٬۷۳۴٬۰۶۹ |

> `1111` بدهکار = بهای برگشتی (۶۷۲٬۴۱۲٬۸۸۵) + کارمزد (۱۱٬۵۷۶٬۴۲۶) = ۶۸۳٬۹۸۹٬۳۱۱
> `2101` بستانکار = کارمزد (۱۱٬۵۷۶٬۴۲۶) + مالیات (۱٬۱۵۷٬۶۴۳) = ۱۲٬۷۳۴٬۰۶۹
> **تراز:** ۶۸۳٬۹۸۹٬۳۱۱ + ۱٬۱۵۷٬۶۴۳ = ۶۷۲٬۴۱۲٬۸۸۵ + ۱۲٬۷۳۴٬۰۶۹ = ۶۸۵٬۱۴۶٬۹۵۴ ✅

### تسهیم نهایی

```
WIP_final     = ۶۹۸٬۳۲۴٬۵۰۰
by (خرده پارچه ۲۸.۲۶ کیلو × ۱۲۰٬۰۰۰) = ۳٬۳۹۱٬۲۰۰   → PRD-16
WIP_after_by  = ۶۹۴٬۹۳۳٬۳۰۰
main ۱۰۰٪ برای ۳۰۰.۰۷ عدد           = ۶۹۴٬۹۳۳٬۳۰۰   → PRD-07
unit_cost     = ۲٬۳۱۵٬۸۸۰ ریال ≈ ۲۳۱٬۵۸۸ تومان
```

### راستی‌آزمایی WIP

```
بدهکارها: 517,560,481 + 7,850,000 + 4,658,044 + 13,847,400 + 18,463,200
        + 2,135,200 + 55,389,600 + 19,386,360 + 23,069,388 + 7,616,070
        + 2,437,142 + 683,989,311 + 1,523,214 + 4,710,000 + 4,501,097 + 3,600,878
        = 1,370,737,385

بستانکارها: 672,412,885 (PRD-13) + 3,391,200 (PRD-16) + 694,933,300 (PRD-07)
          = 1,370,737,385

مانده WIP = ۰  ✅
```

### تحلیل ارزش افزوده هر مرحله

| مرحله | ارزش افزوده (ریال) | ٪ از کل | بهای واحد تجمعی |
|-------|-------------------:|--------:|----------------:|
| ۱۰ برش | ۵۳۰٬۰۶۸٬۵۲۵ | ۷۵.۹ | ۱٬۷۲۲٬۵۶۸ |
| ۲۰ گلدوزی | ۳۲٬۳۱۰٬۶۰۰ | ۴.۶ | ۱٬۸۲۷٬۵۶۸ |
| ۳۰ دوخت | ۷۶٬۹۱۱٬۱۶۰ | ۱۱.۰ | ۲٬۰۹۸٬۴۹۱ |
| ۴۰ یراق | ۳۳٬۱۲۲٬۶۰۰ | ۴.۷ | ۲٬۲۰۷٬۲۱۷ |
| ۵۰ شستشو | ۱۳٬۰۹۹٬۶۴۰ | ۱.۹ | ۲٬۲۸۴٬۴۸۵ |
| ۶۰ اتو | ۱۲٬۸۱۱٬۹۷۵ | ۱.۸ | ۲٬۳۲۷٬۱۸۱ |

> **بینش مدیریتی:** ۷۵.۹٪ ارزش در **برش** تزریق می‌شود (پارچه). یعنی هر عدد ضایعات بعد از برش، ۱.۷ میلیون ریال از دست رفته است. **کنترل کیفیت باید در برش متمرکز باشد، نه در اتو.**

---

## ۸. سناریوهای واقعی

| # | سناریو | رفتار |
|---|--------|-------|
| X-01 | تولید کامل ۶ مرحله | مثال §۷ |
| X-02 | توقف در دوخت (خرابی چرخ) | `status='blocked'` + دلیل · WIP سر جایش |
| X-03 | مرحله گلدوزی رد شد (مدل ساده) | `status='skipped'` + دلیل · مستقیم به دوخت |
| X-04 | ضایعات عادی هر مرحله | بدون سند · جذب در `qty_out` کمتر |
| X-05 | ضایعات غیرعادی در دوخت | PRD-09 با تفصیلی CC-30 |
| X-06 | مازاد بر سقف ضایعات عادی | خودکار غیرعادی + هشدار مدیر |
| X-07 | ارسال به شستشو | PRD-13 |
| X-08 | دریافت از شستشو + کارمزد | PRD-14 |
| X-09 | کسری نزد پیمانکار (۳ عدد گم شد) | PRD-09 برای ۳ عدد + هشدار |
| X-10 | فاکتور پیمانکار جدا صادر می‌شود | `purchase_invoice_id` لینک · `2101` تسویه |
| X-11 | QC اتو ۵ عدد را رد کرد | دوباره‌کاری → PRD-11 · برگشت به مرحله ۶۰ |
| X-12 | دوباره‌کاری ناموفق (۲ از ۵) | ۳ برگشت + ۲ ضایعات غیرعادی PRD-09 |
| X-13 | محصول فرعی خرده پارچه | PRD-16 · ورود به `WH-SCRAP` |
| X-14 | محصول همزاد شال ست ۱۵٪ | دو PRD-07 با نسبت ۸۵/۱۵ |
| X-15 | سفارش بین دو ماه | مراحل ۱۰-۳۰ تیر، ۴۰-۶۰ مرداد · WIP پایان تیر گزارش شود |
| X-16 | نرخ سربار ماه عوض شد | مراحل تیر با نرخ تیر، مرداد با نرخ مرداد ✅ |
| X-17 | تولید موازی دو سفارش در دوخت | هر کدام WIP و تفصیلی خودش |
| X-18 | برشکار مریض شد، دستمزد ماهانه کمتر | مانده `5201` = انحراف → پایان ماه |
| X-19 | فرمول نسخه ۳ فعال شد وسط کار | Snapshot `bom_id` محافظت می‌کند ✅ |
| X-20 | لغو سفارش در مرحله ۴۰ | Reversal مراحل ۴۰→۱۰ به ترتیب معکوس |
| X-21 | تولید بیش از برنامه در برش | `qty_in` مرحله ۲۰ بیشتر · مجاز با هشدار |
| X-22 | گلوگاه دوخت | `capacity-load` هشدار می‌دهد |

---

## ۹. اعتبارسنجی

همه V2-01..V2-18، به‌علاوه:

| کد | قانون | خطا |
|----|-------|-----|
| V7-01 | `analysis_type='fixed_adv'` → `bom.has_routing=1` | `E_NO_ROUTING` |
| V7-02 | Release → Snapshot مراحل ساخته شود | `E_STAGES_NOT_CREATED` |
| V7-03 | مرحله فقط وقتی `in_progress` که قبلی `done`/`skipped` | `E_PREV_STAGE_OPEN` |
| V7-04 | `qty_in > 0` برای شروع | `E_STAGE_NO_INPUT` |
| V7-05 | مرحله `done` قابل تغییر نیست | `E_STAGE_CLOSED` |
| V7-06 | `qty_out + w_normal + w_abnormal + rework = qty_in` (±۰.۰۱) | `E_STAGE_QTY_MISMATCH` |
| V7-07 | `w_normal ≤ ceil(qty_in × op.normal_waste_percent/100)` | مازاد خودکار غیرعادی |
| V7-08 | `skip` فقط اگر مواد/دستمزد ندارد | `E_STAGE_HAS_COST` |
| V7-09 | پیمانکاری: دریافت ≤ ارسال | `E_SUBCON_QTY_EXCEEDS` |
| V7-10 | پیمانکاری: ارسال قبل از دریافت | `E_SUBCON_NOT_SENT` |
| V7-11 | `1114` سفارش پس از دریافت = ۰ | `E_SUBCON_RESIDUAL` |
| V7-12 | نرخ سربار همه مراکز درگیر موجود | `E_NO_OH_RATE` |
| V7-13 | Σ`cost_share_percent` = ۱۰۰ | `E_SHARE_NOT_100` |
| V7-14 | `WIP` سفارش پس از finalize = ۰ | `E_WIP_RESIDUAL` |
| V7-15 | دوباره‌کاری: `recovered + failed = qty` | `E_REWORK_QTY_MISMATCH` |
| V7-16 | QC Gate: بدون `qc_passed` نمی‌توان `done` کرد | `E_QC_REQUIRED` |
| V7-17 | `by_credit ≤ WIP_final` | `E_NRV_EXCEEDS_WIP` |
| V7-18 | ثبت مرحله در دوره بسته ممنوع | `E_PERIOD_CLOSED` |
| V7-19 | مواد مرحله‌ای که در BOM آن مرحله نیست | `E_STAGE_MATERIAL_MISMATCH` |
| V7-20 | `analysis_type='fixed_adv'` → مصرف دستی ممنوع | `E_FIXED_NO_MANUAL_QTY` |

---

## ۱۰. Edge Case ها

| # | حالت | راه‌حل |
|---|------|--------|
| E7-01 | همه مراحل صفر خروجی | همه WIP → `5221` · بدون PRD-07 |
| E7-02 | مرحله آخر ضایعات غیرعادی ۱۰۰٪ | `WIP_net=0` · `qty_produced=0` |
| E7-03 | ضایعات غیرعادی در مرحله ۱۰ (پارچه) | بهای پایین — فقط پارچه از دست رفته |
| E7-04 | ضایعات غیرعادی در مرحله ۶۰ (اتو) | بهای بالا — همه ارزش افزوده رفته 🔴 |
| E7-05 | پیمانکار کالا را برنگرداند | `1114` باز می‌ماند · هشدار + مطالبه |
| E7-06 | پیمانکار بیشتر برگرداند | `E_SUBCON_QTY_EXCEEDS` |
| E7-07 | فاکتور پیمانکار ماه بعد | `2101` باز · تسویه در `supplier_payments` |
| E7-08 | دوباره‌کاری حلقه بی‌نهایت | حداکثر ۳ دور → بعدش `E_REWORK_LIMIT` |
| E7-09 | مرحله بدون هیچ هزینه | `cost_out = cost_in` · مجاز |
| E7-10 | تغییر نرخ سربار وسط سفارش | هر مرحله با نرخ **دوره خودش** ✅ |
| E7-11 | سفارش ۳ ماهه | WIP در ۳ `production_period_close` گزارش شود |
| E7-12 | ۲ کاربر همزمان یک مرحله | Optimistic Lock → `409 E_CONCURRENT` |
| E7-13 | `qty_out` بیشتر از `qty_in` | `E_STAGE_QTY_MISMATCH` |
| E7-14 | گرد کردن انباشتی ۶ مرحله | `receipt_amount = WIP_net` دقیق (R-10) |
| E7-15 | محصول همزاد با share ۰٪ | مجاز — بها صفر می‌گیرد |
| E7-16 | لغو در مرحله شستشو (کالا نزد پیمانکار) | `E_SUBCON_IN_TRANSIT` — ابتدا دریافت |

---

## ۱۱. خطاهای احتمالی

| کد | HTTP | پیام |
|----|------|------|
| `E_NO_ROUTING` | 422 | این نوع آنالیز نیاز به فرمول با مسیر عملیات دارد |
| `E_STAGES_NOT_CREATED` | 500 | مراحل سفارش ساخته نشده — سفارش را دوباره آزاد کنید |
| `E_PREV_STAGE_OPEN` | 409 | مرحله «{prev}» هنوز تمام نشده |
| `E_STAGE_NO_INPUT` | 422 | مرحله ورودی ندارد |
| `E_STAGE_CLOSED` | 409 | مرحله «{name}» بسته است |
| `E_STAGE_QTY_MISMATCH` | 422 | مجموع خروجی+ضایعات+دوباره‌کاری ({x}) با ورودی ({y}) برابر نیست |
| `E_STAGE_HAS_COST` | 409 | مرحله دارای هزینه است — قابل رد شدن نیست |
| `E_SUBCON_QTY_EXCEEDS` | 422 | دریافت ({r}) بیش از ارسال ({s}) است |
| `E_SUBCON_NOT_SENT` | 409 | ابتدا کالا را به پیمانکار ارسال کنید |
| `E_SUBCON_RESIDUAL` | 500 | مانده نزد پیمانکار {x} ریال — عملیات لغو شد |
| `E_SUBCON_IN_TRANSIT` | 409 | {n} عدد نزد پیمانکار است — ابتدا دریافت کنید |
| `E_WIP_RESIDUAL` | 500 | مانده WIP سفارش {x} ریال — با پشتیبانی تماس بگیرید |
| `E_REWORK_QTY_MISMATCH` | 422 | بازیافتی + ناموفق باید برابر تعداد دوباره‌کاری باشد |
| `E_REWORK_LIMIT` | 409 | این تعداد {n} بار دوباره‌کاری شده — ضایعات اعلام کنید |
| `E_QC_REQUIRED` | 422 | نتیجه کنترل کیفیت الزامی است |
| `E_STAGE_MATERIAL_MISMATCH` | 422 | «{name}» در فرمول این مرحله نیست |

---

## ۱۲. Undo و اصلاح

### ترتیب Reversal (معکوس ثبت)

```
۱) رسید FG          PRD-07  (چک: فروخته نشده باشد)
۲) محصول فرعی       PRD-16
۳) مرحله ۶۰ اتو     PRD-05, PRD-03, PRD-01
۴) مرحله ۵۰ شستشو   PRD-05, PRD-14, PRD-13   ← ⚠️ ترتیب مهم
۵) مرحله ۴۰ یراق    PRD-05, PRD-03, PRD-01
۶) مرحله ۳۰ دوخت    PRD-09 (ضایعات), PRD-05, PRD-03, PRD-01
۷) مرحله ۲۰ گلدوزی  PRD-05, PRD-03
۸) مرحله ۱۰ برش     PRD-05, PRD-03, PRD-01
۹) آزادسازی رزروها
۱۰) status='cancelled' + cancelled_reason
```

| عملیات | مجاز؟ |
|--------|-------|
| ابطال یک مرحله میانی بدون مراحل بعدی | ✅ |
| ابطال مرحله ۳۰ در حالی که ۴۰ `done` است | ❌ `E_NEXT_STAGE_DONE` — ابتدا ۴۰ |
| ابطال شستشو با کالای نزد پیمانکار | ❌ `E_SUBCON_IN_TRANSIT` |
| ابطال با FG فروخته‌شده | ❌ `E_FG_SOLD` |
| ابطال در دوره بسته | ❌ ابتدا `reopen-period` (admin) |

---

## ۱۳. گزارش‌ها

| گزارش | endpoint |
|-------|----------|
| R7-01 برگه بهای مرحله‌ای | `GET /production/orders/:id/stage-cost-sheet` |
| R7-02 ارزش افزوده هر مرحله | `GET /production/orders/:id/value-added` |
| R7-03 WIP به تفکیک مرحله | `GET /production/reports/wip-by-stage?date=` |
| R7-04 عملکرد مراکز هزینه | `GET /production/reports/cost-center-performance?period=` |
| R7-05 ضایعات به تفکیک مرحله | `GET /production/reports/waste-by-stage?period=` |
| R7-06 گلوگاه و ظرفیت | `GET /production/reports/bottleneck?period=` |
| R7-07 زمان چرخه (Lead Time) | `GET /production/reports/cycle-time` |
| R7-08 مانده نزد پیمانکار | `GET /production/reports/subcontract-balance` |
| R7-09 عملکرد پیمانکاران | `GET /production/reports/subcontractor-performance` |
| R7-10 دوباره‌کاری | `GET /production/reports/rework?period=` |
| R7-11 نمودار جریان سفارش | `GET /production/orders/:id/flow` |
| R7-12 محصولات فرعی | `GET /production/reports/byproducts?period=` |

---

## ۱۴. دسترسی کاربران

| نقش | ایجاد سفارش | ثبت مرحله | ثبت پیمانکاری | مشاهده بها | ابطال |
|-----|:-----------:|:---------:|:-------------:|:----------:|:-----:|
| admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| accounting | ✅ | ✅ | ✅ | ✅ | ✅ |
| production_manager | ✅ | ✅ | ✅ | ✅ | ✅ |
| production_operator | ❌ | ✅¹ | ❌ | ❌ | ❌ |
| sales_manager | ❌ | ❌ | ❌ | ✅² | ❌ |

¹ فقط مراکز هزینه‌ای که در `user_cost_centers` به او تخصیص یافته
² بدون تفکیک — فقط بهای واحد نهایی

**جدول جدید لازم:**
```sql
CREATE TABLE IF NOT EXISTS user_cost_centers (
  user_id        INTEGER NOT NULL,
  cost_center_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, cost_center_id)
);
```

---

## ۱۵. APIهای موردنیاز

```
POST   /api/production/orders/:id/release-advanced      Snapshot مراحل
GET    /api/production/orders/:id/stages                فهرست مراحل
GET    /api/production/orders/:id/stages/:stageId
POST   /api/production/orders/:id/stages/:stageId/start
POST   /api/production/orders/:id/stages/:stageId/output   ★ ثبت خروجی مرحله
       body: { qty_out, waste_normal, waste_abnormal, waste_reason_code,
               rework, scrap:[{product_id,qty,nrv_unit_rial}],
               qc_passed?, qc_note?, date, note }
POST   /api/production/orders/:id/stages/:stageId/skip     { reason }
POST   /api/production/orders/:id/stages/:stageId/block    { reason }
POST   /api/production/orders/:id/stages/:stageId/unblock
GET    /api/production/orders/:id/stages/:stageId/preview  dry-run

POST   /api/production/orders/:id/subcontract/send      { stage_id, qty, supplier_id, date }
POST   /api/production/orders/:id/subcontract/receive   { stage_id, qty_received, qty_waste,
                                                          qty_lost, fee_unit_rial, vat_rial, date }
GET    /api/production/orders/:id/subcontract

POST   /api/production/orders/:id/rework                { origin_stage_id, rework_stage_id, qty,
                                                          classification, material[], labor_rial,
                                                          overhead_rial, reason_code, date }
POST   /api/production/orders/:id/rework/:rwId/complete { qty_recovered, qty_failed }

POST   /api/production/orders/:id/finalize              ★ تسهیم خروجی + رسید
GET    /api/production/orders/:id/stage-cost-sheet
GET    /api/production/orders/:id/value-added
GET    /api/production/orders/:id/flow
POST   /api/production/orders/:id/stages/:stageId/reverse  { reason }
```

### `POST /orders/:id/stages/:stageId/output`

**درخواست (مرحله ۱۰ برش):**
```json
{
  "qty_out": 307.72, "waste_normal": 6.28, "waste_abnormal": 0,
  "rework": 0, "scrap": [], "date": "1405/04/15", "note": "برش ۳۱۴ عدد"
}
```

**پاسخ:**
```json
{
  "ok": true,
  "stage": { "id": 45, "seq": 10, "cost_center": "CC-10 برش", "status": "done" },
  "qty": { "in": 314, "out": 307.72, "waste_normal": 6.28, "waste_abnormal": 0,
           "allowed_normal": 7, "auto_reclassified": 0 },
  "costs": {
    "cost_in_rial": 0,
    "material_added_rial": 517560481,
    "labor_rial": 7850000, "labor_method": "monthly", "labor_rate_rial": 25000,
    "subcontract_rial": 0,
    "overhead_rial": 4658044, "overhead_driver": "material_rial",
    "overhead_driver_qty": 517.560, "overhead_rate_rial": 9000, "overhead_estimated": false,
    "abnormal_waste_rial": 0, "scrap_credit_rial": 0,
    "cost_out_rial": 530068525, "unit_cost_out_rial": 1722568
  },
  "materials": [
    { "product_id":201, "name":"پارچه کتان ۱۴۰ سانت — سبز", "qty":523.3333,
      "unit_cost_rial":950000, "amount_rial":497166667 },
    { "product_id":202, "name":"آستر ساده", "qty":113.2990,
      "unit_cost_rial":180000, "amount_rial":20393814 }
  ],
  "journal_entries": [
    { "event":"PRD-01", "je_id":5101, "voucher_no":"JV-1405-0612", "amount_rial":517560481 },
    { "event":"PRD-03", "je_id":5102, "voucher_no":"JV-1405-0613", "amount_rial":7850000 },
    { "event":"PRD-05", "je_id":5103, "voucher_no":"JV-1405-0614", "amount_rial":4658044 }
  ],
  "next_stage": { "id":46, "seq":20, "cost_center":"CC-20 گلدوزی",
                  "qty_in":307.72, "cost_in_rial":530068525, "status":"in_progress" },
  "order_progress": { "stages_done":1, "stages_total":6, "percent":16.7 },
  "warnings": []
}
```

---

## ۱۶. رویدادها

| رویداد | Payload |
|--------|---------|
| `production.stage.started` | `{orderId, stageId, ccId, qtyIn}` |
| `production.stage.completed` | `{orderId, stageId, ccId, qtyOut, costOutRial}` |
| `production.stage.blocked` | `{orderId, stageId, reason}` |
| `production.stage.skipped` | `{orderId, stageId, reason}` |
| `production.subcontract.sent` | `{orderId, stageId, supplierId, qty, amountRial}` |
| `production.subcontract.received` | `{orderId, stageId, qtyReceived, qtyLost, feeRial}` |
| `production.subcontract.overdue` | `{orderId, supplierId, days}` — کرون روزانه |
| `production.rework.recorded` | `{orderId, stageId, qty, classification, totalRial}` |
| `production.qc.failed` | `{orderId, stageId, qty, note}` |
| `production.byproduct.received` | `{orderId, productId, qty, nrvRial}` |
| `production.order.finalized` | `{orderId, outputs[], unitCostRial}` |
| `production.bottleneck.detected` | `{ccId, loadPct, period}` |

---

## ۱۷. پیشنهاد UI

### صفحه اجرای سفارش — نمای مرحله‌ای

```
┌────────────────────────────────────────────────────────────────────────────┐
│ PO-1405-0010 · مانتو کتان ترمه سبز · هدف ۳۰۰ (شروع ۳۱۴) · 🟠 در جریان     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ✅ ────── ✅ ────── 🔵 ────── ⚪ ────── ⚪ ────── ⚪                        │
│  ۱۰ برش   ۲۰ گلدوزی ۳۰ دوخت  ۴۰ یراق  ۵۰ شستشو ۶۰ اتو                    │
│  ۳۰۷.۷۲   ۳۰۷.۷۲   در جریان   منتظر    منتظر 🏭  منتظر ✅                  │
│                                                                             │
│  پیشرفت: ▓▓▓▓▓▓▓░░░░░░░░░░░░░ ۳۳٪   ·   WIP فعلی: ۵۶۲٬۳۷۹٬۱۲۵ ریال       │
├────────────────────────────────────────────────────────────────────────────┤
│ ┌─ 🔵 مرحله ۳۰ — دوخت (در جریان) ────────────────────────────────────┐    │
│ │ ورودی: ۳۰۷.۷۲ عدد   ·   بهای ورودی: ۵۶۲٬۳۷۹٬۱۲۵ ریال              │    │
│ │ مرکز هزینه: CC-30 دوخت  ·  کارمزدی ۱۸۰٬۰۰۰ ریال/عدد               │    │
│ │ سربار: ریال دستمزد × ۳۵۰٬۰۰۰                                       │    │
│ │ ──────────────────────────────────────────────────────────────     │    │
│ │  ✅ سالم         [ 304.64 ] عدد                                     │    │
│ │  ⚪ ضایعات عادی  [   3.08 ] عدد   (سقف ۱٪ = ۳.۰۸) ✅                │    │
│ │  🔴 ضایعات غیرعادی[      0 ] عدد   دلیل: [        ▾]               │    │
│ │  🔧 دوباره‌کاری   [      0 ] عدد                                     │    │
│ │  ──────────────────────────────────                                │    │
│ │  جمع: ۳۰۷.۷۲  =  ورودی ۳۰۷.۷۲  ✅                                  │    │
│ │                                                                     │    │
│ │  📦 مواد این مرحله (خودکار از فرمول):                              │    │
│ │     نخ پلی‌استر  ۲۵.۱۲ قرقره × ۸۵٬۰۰۰ = ۲٬۱۳۵٬۲۰۰                  │    │
│ │                                                                     │    │
│ │  💰 پیش‌نمایش بها:                                                  │    │
│ │     بهای ورودی        ۵۶۲٬۳۷۹٬۱۲۵                                  │    │
│ │     + مواد               ۲٬۱۳۵٬۲۰۰                                  │    │
│ │     + دستمزد            ۵۵٬۳۸۹٬۶۰۰  (۱۸۰٬۰۰۰ × ۳۰۷.۷۲)            │    │
│ │     + سربار             ۱۹٬۳۸۶٬۳۶۰  (۳۵۰٬۰۰۰ × ۵۵.۳۹ م.ر)         │    │
│ │     ═══════════════════════════════                                 │    │
│ │     بهای خروجی        ۶۳۹٬۲۹۰٬۲۸۵                                  │    │
│ │     بهای واحد           ۲٬۰۹۸٬۴۹۱ ریال (۲۰۹٬۸۴۹ ت)                 │    │
│ │                                                                     │    │
│ │  📄 ۳ سند خودکار  [پیش‌نمایش]      [ ✅ ثبت و انتقال به یراق ]      │    │
│ └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│ ┌─ 📊 ارزش افزوده مراحل ──────────────────────────────────────────────┐    │
│ │ برش    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ۷۵.۹٪  ← ۷۶٪ ارزش اینجا تزریق می‌شود  │    │
│ │ گلدوزی ▓░░░░░░░░░░░░░░░░░░░  ۴.۶٪                                  │    │
│ │ دوخت   ▓▓▓░░░░░░░░░░░░░░░░░ ۱۱.۰٪                                  │    │
│ │ 💡 کنترل کیفیت را روی برش متمرکز کنید، نه اتو                      │    │
│ └────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────┘
```

### فرم پیمانکاری (مرحله ۵۰)

```
┌───────────────────────────────────────────────────────────────────┐
│ 🏭 مرحله ۵۰ — شستشو (پیمانکاری) · خشکشویی صنعتی رضوان            │
├───────────────────────────────────────────────────────────────────┤
│ [📤 ارسال]  [📥 دریافت]  [📋 سابقه]                                │
├───────────────────────────────────────────────────────────────────┤
│ ▸ ارسال                                    وضعیت: ✅ ارسال شده     │
│   تاریخ: ۱۴۰۵/۰۴/۱۸  ·  تعداد: ۳۰۴.۶۴  ·  بها: ۶۷۲٬۴۱۲٬۸۸۵ ریال  │
│   سند PRD-13: 1114 بدهکار / 1111 بستانکار                         │
│                                                                    │
│ ▸ دریافت                                                           │
│   تاریخ: [۱۴۰۵/۰۴/۲۱]                                             │
│   ✅ دریافتی سالم    [ 300.07 ] عدد                                │
│   ⚪ ضایعات پیمانکار [   4.57 ] عدد  (قرارداد ۱.۵٪ = ۴.۵۷) ✅      │
│   🔴 کسری/گمشده      [      0 ] عدد  ← همیشه غیرعادی               │
│   ──────────────────────────────                                   │
│   جمع: ۳۰۴.۶۴  =  ارسالی ۳۰۴.۶۴  ✅                                │
│                                                                    │
│   💵 کارمزد: [ 38,000 ] ریال × ۳۰۴.۶۴ = ۱۱٬۵۷۶٬۴۲۶                │
│   🧾 مالیات ارزش افزوده ۱۰٪: ۱٬۱۵۷٬۶۴۳   ☑ پیمانکار مؤدی است      │
│   ──────────────────────────────────────────                       │
│   بدهی به پیمانکار: ۱۲٬۷۳۴٬۰۶۹ ریال                                │
│                                                                    │
│   📄 سند PRD-14:                                                   │
│      1111 WIP                    بد  ۶۸۳٬۹۸۹٬۳۱۱                   │
│      1108 مالیات دریافتنی        بد    ۱٬۱۵۷٬۶۴۳                   │
│      1114 نزد پیمانکار           بس  ۶۷۲٬۴۱۲٬۸۸۵                   │
│      2101 پرداختنی — رضوان       بس   ۱۲٬۷۳۴٬۰۶۹                   │
│                                                                    │
│                    [انصراف]  [ ✅ ثبت دریافت ]                     │
└───────────────────────────────────────────────────────────────────┘
```

---

## ۱۸. تست‌کیس‌ها

| # | عنوان | انتظار |
|---|-------|--------|
| T7-01 | Release پیشرفته | ۶ رکورد `production_order_stages` · `stages[0].qty_in=314` |
| T7-02 | بدون Routing | `422 E_NO_ROUTING` |
| T7-03 | شروع مرحله ۳۰ قبل از ۲۰ | `409 E_PREV_STAGE_OPEN` |
| T7-04 | **مرحله ۱۰** | `cost_out_rial = 530,068,525` |
| T7-05 | **مرحله ۲۰** | `cost_out_rial = 562,379,125` |
| T7-06 | **مرحله ۳۰** | `cost_out_rial = 639,290,285` |
| T7-07 | **مرحله ۴۰** | `cost_out_rial = 672,412,885` |
| T7-08 | **مرحله ۵۰** | `cost_out_rial = 685,512,525` |
| T7-09 | **مرحله ۶۰** | `cost_out_rial = 698,324,500` |
| T7-10 | انتقال بدون سند | هیچ JE با `sourceType='production_stage_transfer'` |
| T7-11 | سربار `material_rial` | `9,000 × 517.560 = 4,658,044` |
| T7-12 | سربار `machine_hours` | `1,200,000 × 15.386 = 18,463,200` |
| T7-13 | سربار `direct_labor_rial` | `350,000 × 55.390 = 19,386,360` |
| T7-14 | تفصیلی سربار | `journal_lines.detail_account_id` = تفصیلی CC-30 |
| T7-15 | عدم تطابق تعداد | `qty_out=310, in=307.72` → `422 E_STAGE_QTY_MISMATCH` |
| T7-16 | مازاد ضایعات عادی | `w_normal=10, allowed=3.08` → auto reclass ۶.۹۲ به غیرعادی |
| T7-17 | ارسال پیمانکار | `1114` بدهکار ۶۷۲٬۴۱۲٬۸۸۵ |
| T7-18 | **دریافت پیمانکار** | `1111` بد ۶۸۳٬۹۸۹٬۳۱۱ · `2101` بس ۱۲٬۷۳۴٬۰۶۹ · تراز ✅ |
| T7-19 | `1114` صفر | پس از دریافت → مانده `1114` سفارش = ۰ |
| T7-20 | کسری پیمانکار | `qty_lost=3` → `5221` بدهکار |
| T7-21 | دریافت > ارسال | `422 E_SUBCON_QTY_EXCEEDS` |
| T7-22 | لغو با کالای نزد پیمانکار | `409 E_SUBCON_IN_TRANSIT` |
| T7-23 | QC Gate بدون نتیجه | `422 E_QC_REQUIRED` |
| T7-24 | دوباره‌کاری عادی | `1111` بدهکار |
| T7-25 | دوباره‌کاری غیرعادی | `5222` بدهکار |
| T7-26 | دوباره‌کاری ۴ بار | `409 E_REWORK_LIMIT` |
| T7-27 | **محصول فرعی** | `1113` بد ۳٬۳۹۱٬۲۰۰ |
| T7-28 | **رسید نهایی** | `1104` بد ۶۹۴٬۹۳۳٬۳۰۰ |
| T7-29 | **بهای واحد** | `unit_cost_rial = 2,315,880` |
| T7-30 | **WIP صفر** | مانده `1111`/PO-1405-0010 = ۰ |
| T7-31 | **تراز کل** | Σ بدهکار `1111` = Σ بستانکار `1111` = ۱٬۳۷۰٬۷۳۷٬۳۸۵ |
| T7-32 | محصول همزاد | share ۸۵/۱۵ → دو PRD-07 |
| T7-33 | سفارش دو ماهه | مراحل با نرخ سربار دوره خودشان |
| T7-34 | Skip گلدوزی | `status='skipped'` · `qty_in[30] = qty_out[10]` |
| T7-35 | Skip با هزینه | `409 E_STAGE_HAS_COST` |
| T7-36 | Block/Unblock | وضعیت + WIP دست‌نخورده |
| T7-37 | ابطال معکوس | همه ۱۹ سند Reversal → WIP و موجودی حالت اول |
| T7-38 | ابطال ۳۰ با ۴۰ done | `409 E_NEXT_STAGE_DONE` |
| T7-39 | همزمانی | ۲ output موازی → `409 E_CONCURRENT` |
| T7-40 | دسترسی مرکز | operator بدون `user_cost_centers` → `403` |

---

## ۱۹. شبه‌کد

```js
// server/lib/production/engine-advanced.js

function postStageOutput(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
    const st = db.prepare('SELECT * FROM production_order_stages WHERE id=? AND order_id=?').get(stageId, orderId);
    if (!po || !st)                        throw err('E_NOT_FOUND', 404);
    if (po.analysis_type !== 'fixed_adv')  throw err('E_WRONG_ANALYSIS', 409);
    if (body.materials)                    throw err('E_FIXED_NO_MANUAL_QTY', 422);
    if (st.status !== 'in_progress')       throw err('E_STAGE_CLOSED', 409, { name: st.operation_name });
    if (!(st.qty_in > 0))                  throw err('E_STAGE_NO_INPUT', 422);

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    assertFiscalYearWritable(db, date);
    assertPeriodOpen(db, period);
    assertUserCostCenter(db, userId, st.cost_center_id);

    const op = db.prepare('SELECT * FROM bom_operations WHERE id=?').get(st.operation_id);
    const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(st.cost_center_id);

    // QC Gate
    if (op.is_qc_gate && body.qc_passed == null) throw err('E_QC_REQUIRED', 422);

    // ═══ تعداد ═══
    const qOut = num(body.qty_out), rw = num(body.rework) || 0;
    let wN = num(body.waste_normal) || 0, wA = num(body.waste_abnormal) || 0;
    if (Math.abs(qOut + wN + wA + rw - st.qty_in) > 0.01)
      throw err('E_STAGE_QTY_MISMATCH', 422, { x: qOut + wN + wA + rw, y: st.qty_in });

    const allowed = round6(st.qty_in * (op.normal_waste_percent || 0) / 100);
    let autoReclass = 0;
    if (wN > allowed + 0.001) { autoReclass = round6(wN - allowed); wN = allowed; wA = round6(wA + autoReclass); }

    const jes = [];

    // ═══ ۱. Backflush مواد این مرحله (PRD-01) ═══
    const ex = explodeBom(db, { bomId: po.bom_id, qty: st.qty_in,
                                sizeBreakdown: safeJson(po.size_breakdown), priceBasis: 'average' });
    const mine = ex.lines.filter(L => L.stage_cost_center_id === st.cost_center_id);
    let matRial = 0, pkgRial = 0; const matOut = [];
    for (const L of mine) {
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod.average_cost_rial) throw err('E_ZERO_AVG_COST', 422, { name: prod.name });
      const amt = Math.round(L.qty_final * prod.average_cost_rial);
      issueFromStock(db, { productId: L.product_id, warehouseId: po.warehouse_raw_id,
                           qty: L.qty_final, userId, note: `${po.order_no}/${st.seq}` });
      db.prepare(`INSERT INTO production_material_issues
         (doc_no,order_id,stage_id,cost_center_id,product_id,bom_line_id,issue_type,
          qty_standard,qty_actual,qty_variance,unit_cost_rial,amount_rial,
          warehouse_id,date,period_label,status,created_by)
         VALUES (?,?,?,?,?,?,'backflush',?,?,0,?,?,?,?,?,'posted',?)`)
        .run(allocateNumber(db,'material_issue','MI'), orderId, stageId, st.cost_center_id,
             L.product_id, L.bom_line_id, L.qty_final, L.qty_final,
             prod.average_cost_rial, amt, po.warehouse_raw_id, date, period, userId);
      if (L.line_kind === 'packaging') pkgRial += amt; else matRial += amt;
      matOut.push({ product_id: L.product_id, name: prod.name, qty: L.qty_final,
                    unit_cost_rial: prod.average_cost_rial, amount_rial: amt });
      checkReorderPoint(db, L.product_id);
    }
    if (matRial + pkgRial > 0) {
      const je = postToLedger(db, {
        sourceType:'production_material_issue', sourceId: stageId, date,
        description:`مصرف مواد ${po.order_no} / مرحله ${st.seq} ${cc.name}`, createdBy:userId,
        lines: plug([ dr(db,'coa_wip', matRial+pkgRial, po.coa_wip_tafsili),
                      cr(db,'coa_raw_materials', matRial),
                      cr(db,'coa_packaging_materials', pkgRial) ]),
      });
      jes.push({ event:'PRD-01', je_id:je, amount_rial: matRial + pkgRial });
    }

    // ═══ ۲. دستمزد (PRD-03) ═══
    const labor = stageLabor(db, op, st.qty_in, period);
    if (labor > 0) {
      db.prepare(`INSERT INTO production_labor_entries
         (doc_no,order_id,stage_id,cost_center_id,method,qty,hours,rate_rial,amount_rial,
          date,period_label,status,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?)`)
        .run(allocateNumber(db,'labor_entry','LB'), orderId, stageId, st.cost_center_id,
             op.labor_method, st.qty_in, laborHours(op, st.qty_in),
             op.labor_rate_rial, labor, date, period, userId);
      const je = postToLedger(db, {
        sourceType:'production_labor', sourceId: stageId, date,
        description:`جذب دستمزد ${po.order_no} / ${cc.name} (${op.labor_method})`, createdBy:userId,
        lines: [ dr(db,'coa_wip', labor, po.coa_wip_tafsili),
                 cr(db,'coa_labor_control', labor, cc.coa_tafsili_lb) ],
      });
      jes.push({ event:'PRD-03', je_id:je, amount_rial: labor });
    }

    // ═══ ۳. پیمانکاری ═══
    let subcon = 0;
    if (op.is_subcontract) {
      const sc = db.prepare(`SELECT COALESCE(SUM(fee_amount_rial),0) f
                             FROM production_subcontract
                             WHERE stage_id=? AND direction='in' AND status='posted'`).get(stageId);
      subcon = sc.f;
      if (!subcon) throw err('E_SUBCON_NOT_SENT', 409);   // باید قبلاً send/receive شده باشد
    }

    // ═══ ۴. سربار (PRD-05) ═══
    const rate = getOverheadRate(db, st.cost_center_id, period);
    const driverQty = stageDriverQty(db, op, cc, { qty: st.qty_in, labor, material: matRial + pkgRial });
    const oh = Math.round(rate.total_rate_rial * driverQty);
    if (oh > 0) {
      db.prepare(`INSERT INTO production_overhead_applications
         (doc_no,order_id,stage_id,cost_center_id,rate_id,driver,driver_qty,
          fixed_rate_rial,var_rate_rial,rate_rial,amount_rial,date,period_label,status,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)`)
        .run(allocateNumber(db,'overhead_apply','OH'), orderId, stageId, st.cost_center_id,
             rate.id, st.driver, driverQty, rate.fixed_rate_rial, rate.var_rate_rial,
             rate.total_rate_rial, oh, date, period, userId);
      const je = postToLedger(db, {
        sourceType:'production_overhead', sourceId: stageId, date,
        description:`جذب سربار ${po.order_no} / ${cc.name} (${st.driver} × ${round2(driverQty)})`,
        createdBy:userId,
        lines: [ dr(db,'coa_wip', oh, po.coa_wip_tafsili),
                 cr(db,'coa_overhead_applied', oh, cc.coa_tafsili_oh) ],
      });
      jes.push({ event:'PRD-05', je_id:je, amount_rial: oh });
    }

    // ═══ ۵. بهای ناخالص مرحله ═══
    const costIn = st.material_in_rial || 0;
    const costGross = costIn + matRial + pkgRial + labor + subcon + oh;
    const costPerIn = costGross / st.qty_in;

    // ═══ ۶. ضایعات غیرعادی (PRD-09) ═══
    let abn = 0;
    if (wA > 0) {
      abn = Math.round(costPerIn * wA);
      db.prepare(`INSERT INTO production_waste
         (doc_no,order_id,stage_id,cost_center_id,product_id,waste_type,qty,allowed_qty,
          unit_cost_rial,amount_rial,reason_code,reason_note,date,period_label,status,created_by)
         VALUES (?,?,?,?,?,'abnormal',?,?,?,?,?,?,?,?,'posted',?)`)
        .run(allocateNumber(db,'production_waste','WS'), orderId, stageId, st.cost_center_id,
             po.product_id, wA, allowed, Math.round(costPerIn), abn,
             body.waste_reason_code || 'other',
             autoReclass ? `${autoReclass} عدد مازاد بر سقف عادی` : '', date, period, userId);
      const je = postToLedger(db, {
        sourceType:'production_waste', sourceId: stageId, date,
        description:`ضایعات غیرعادی ${wA} عدد — ${po.order_no} / ${cc.name}`, createdBy:userId,
        lines: [ dr(db,'coa_abnormal_waste', abn), cr(db,'coa_wip', abn, po.coa_wip_tafsili) ],
      });
      jes.push({ event:'PRD-09', je_id:je, amount_rial: abn });
      emit(db,'production.waste.recorded',{ orderId, stageId, type:'abnormal', qty:wA, amountRial:abn });
    }
    if (wN > 0) {
      db.prepare(`INSERT INTO production_waste
         (doc_no,order_id,stage_id,cost_center_id,product_id,waste_type,qty,allowed_qty,
          date,period_label,status,created_by)
         VALUES (?,?,?,?,?,'normal',?,?,?,?,'posted',?)`)
        .run(allocateNumber(db,'production_waste','WS'), orderId, stageId, st.cost_center_id,
             po.product_id, wN, allowed, date, period, userId);
      // ✅ بدون سند
    }

    // ═══ ۷. ضایعات قابل فروش (PRD-10) ═══
    let scrapCredit = 0;
    for (const s of (body.scrap || [])) {
      const amt = Math.round(num(s.qty) * num(s.nrv_unit_rial));
      scrapCredit += amt;
      receiveScrap(db, { productId:s.product_id, qty:s.qty, unitRial:s.nrv_unit_rial,
                         warehouseId: setting(db,'production_wh_scrap_id'),
                         userId, orderId, stageId, date, period });
    }
    if (scrapCredit) {
      const je = postToLedger(db, {
        sourceType:'production_scrap', sourceId: stageId, date,
        description:`ضایعات قابل فروش — ${po.order_no} / ${cc.name}`, createdBy:userId,
        lines: [ dr(db,'coa_scrap_inventory', scrapCredit),
                 cr(db,'coa_wip', scrapCredit, po.coa_wip_tafsili) ],
      });
      jes.push({ event:'PRD-10', je_id:je, amount_rial: scrapCredit });
    }

    // ═══ ۸. بهای خروجی ═══
    const costOut = costGross - abn - scrapCredit;
    if (costOut < 0) throw err('E_NEGATIVE_WIP', 500);
    const unitOut = qOut > 0 ? Math.round(costOut / qOut) : 0;

    db.prepare(`UPDATE production_order_stages SET
        status='done', qty_out=?, qty_waste_normal=?, qty_waste_abnormal=?, qty_rework=?,
        material_added_rial=?, labor_rial=?, subcontract_rial=?, overhead_rial=?,
        driver_qty=?, waste_abnormal_rial=?, scrap_credit_rial=?,
        cost_out_rial=?, unit_cost_out_rial=?, ended_at=?, qc_passed=?, qc_note=?
      WHERE id=?`)
      .run(qOut, wN, wA, rw, matRial + pkgRial, labor, subcon, oh, driverQty,
           abn, scrapCredit, costOut, unitOut, date,
           body.qc_passed == null ? null : (body.qc_passed ? 1 : 0), body.qc_note || '', stageId);

    // ═══ ۹. انتقال به مرحله بعد — بدون سند (ADR-012) ═══
    const next = db.prepare(`SELECT * FROM production_order_stages
                             WHERE order_id=? AND seq>? AND status<>'skipped'
                             ORDER BY seq LIMIT 1`).get(orderId, st.seq);
    if (next) {
      db.prepare(`UPDATE production_order_stages
                  SET qty_in=?, material_in_rial=?, status='in_progress', started_at=?
                  WHERE id=?`).run(qOut, costOut, date, next.id);
      emit(db,'production.stage.started',{ orderId, stageId: next.id, ccId: next.cost_center_id, qtyIn: qOut });
    }

    recomputeOrderTotals(db, orderId);
    audit(userId,'create','production_stage_output',stageId,
          `مرحله ${st.seq} ${cc.name}: ${qOut} عدد — بهای واحد ${unitOut} ریال`);
    emit(db,'production.stage.completed',{ orderId, stageId, ccId: st.cost_center_id,
                                           qtyOut: qOut, costOutRial: costOut });

    // آخرین مرحله → نهایی‌سازی خودکار
    let finalize = null;
    if (!next && body.auto_finalize !== false) finalize = finalizeAdvancedOrder(db, { orderId, date, userId });

    const done = db.prepare("SELECT COUNT(*) c FROM production_order_stages WHERE order_id=? AND status IN ('done','skipped')").get(orderId).c;
    const total = db.prepare('SELECT COUNT(*) c FROM production_order_stages WHERE order_id=?').get(orderId).c;

    return { ok:true,
      stage:{ id:stageId, seq:st.seq, cost_center:`${cc.code} ${cc.name}`, status:'done' },
      qty:{ in:st.qty_in, out:qOut, waste_normal:wN, waste_abnormal:wA,
            allowed_normal:allowed, auto_reclassified:autoReclass },
      costs:{ cost_in_rial:costIn, material_added_rial:matRial+pkgRial,
              labor_rial:labor, labor_method:op.labor_method, labor_rate_rial:op.labor_rate_rial,
              subcontract_rial:subcon,
              overhead_rial:oh, overhead_driver:st.driver, overhead_driver_qty:round6(driverQty),
              overhead_rate_rial:rate.total_rate_rial, overhead_estimated:!!rate.is_estimated,
              abnormal_waste_rial:abn, scrap_credit_rial:scrapCredit,
              cost_out_rial:costOut, unit_cost_out_rial:unitOut },
      materials: matOut, journal_entries: jes,
      next_stage: next ? { id:next.id, seq:next.seq, qty_in:qOut, cost_in_rial:costOut, status:'in_progress' } : null,
      order_progress:{ stages_done:done, stages_total:total, percent: round1(done/total*100) },
      finalize,
      warnings: rate.is_estimated ? [`نرخ سربار «${cc.name}» برآوردی است`] : [],
    };
  })();
}

/** نهایی‌سازی: تسهیم خروجی‌ها + رسید */
function finalizeAdvancedOrder(db, { orderId, date, userId }) {
  const po   = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
  const last = db.prepare(`SELECT * FROM production_order_stages
                           WHERE order_id=? AND status='done' ORDER BY seq DESC LIMIT 1`).get(orderId);
  const bom  = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
  const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(po.bom_id);
  const period = jalaliPeriod(date);
  const qtyStart = po.qty_planned_start || po.qty_planned;
  const jes = [], results = [];

  let wip = last.cost_out_rial;

  // ═══ by/scrap با NRV (PRD-16) ═══
  let byCredit = 0;
  for (const o of outs.filter(x => ['by','scrap'].includes(x.output_type))) {
    if (o.cost_method === 'zero') continue;
    if (!o.nrv_rial) throw err('E_NRV_ZERO', 422);
    const q   = round6(o.qty_per_base * qtyStart / bom.base_qty);
    const amt = Math.round(q * o.nrv_rial);
    byCredit += amt;
    const wh  = o.warehouse_id || setting(db,'production_wh_scrap_id');
    updateMovingAverage(db, { productId:o.product_id, warehouseId:wh, qtyIn:q, amountRial:amt,
                              userId, note:`محصول فرعی ${po.order_no}` });
    const acctKey = o.output_type === 'by' ? 'coa_finished_goods' : 'coa_scrap_inventory';
    const je = postToLedger(db, {
      sourceType:'production_byproduct', sourceId:orderId, date,
      description:`محصول فرعی ${productName(db,o.product_id)} — ${po.order_no}`, createdBy:userId,
      lines: [ dr(db, acctKey, amt), cr(db,'coa_wip', amt, po.coa_wip_tafsili) ],
    });
    jes.push({ event:'PRD-16', je_id:je, amount_rial:amt });
    results.push({ type:o.output_type, product_id:o.product_id, qty:q, unit_rial:o.nrv_rial, amount_rial:amt });
    emit(db,'production.byproduct.received',{ orderId, productId:o.product_id, qty:q, nrvRial:o.nrv_rial });
  }

  const afterBy = wip - byCredit;
  if (afterBy < 0) throw err('E_NRV_EXCEEDS_WIP', 422);

  // ═══ main + co با share (PRD-07) ═══
  const shares = outs.filter(o => ['main','co'].includes(o.output_type));
  const sum = shares.reduce((s,o)=>s+(o.cost_share_percent||0), 0);
  if (Math.abs(sum - 100) > 0.01) throw err('E_SHARE_NOT_100', 422, { sum });

  let assigned = 0; const rows = [];
  for (const o of shares) {
    const q   = o.output_type === 'main' ? last.qty_out : round6(o.qty_per_base * qtyStart / bom.base_qty);
    const amt = Math.round(afterBy * (o.cost_share_percent||0) / 100);
    assigned += amt; rows.push({ o, q, amt });
  }
  const mainRow = rows.find(r => r.o.output_type === 'main');
  if (mainRow) mainRow.amt += afterBy - assigned;        // R-10 گرد کردن

  for (const r of rows) {
    if (r.amt === 0 && r.q === 0) continue;
    const wh  = r.o.warehouse_id || po.warehouse_fg_id;
    const avg = updateMovingAverage(db, { productId:r.o.product_id, warehouseId:wh,
                                          qtyIn:r.q, amountRial:r.amt, userId,
                                          note:`تولید ${po.order_no}` });
    const unit = r.q ? Math.round(r.amt / r.q) : 0;
    const rid = db.prepare(`INSERT INTO production_receipts
       (doc_no,order_id,stage_id,product_id,output_type,qty,unit_cost_rial,amount_rial,
        cost_method,warehouse_id,size_breakdown,prev_avg_rial,prev_stock_qty,new_avg_rial,
        date,period_label,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)`)
      .run(allocateNumber(db,'production_receipt','PR'), orderId, last.id, r.o.product_id,
           r.o.output_type, r.q, unit, r.amt, r.o.cost_method, wh,
           po.size_breakdown, avg.prev_avg, avg.prev_qty, avg.new_avg, date, period, userId).lastInsertRowid;
    const je = postToLedger(db, {
      sourceType:'production_receipt', sourceId:rid, date,
      description:`رسید تولید ${r.q} عدد ${productName(db,r.o.product_id)} — ${po.order_no}`,
      createdBy:userId,
      lines: [ dr(db,'coa_finished_goods', r.amt), cr(db,'coa_wip', r.amt, po.coa_wip_tafsili) ],
    });
    db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je, rid);
    jes.push({ event:'PRD-07', je_id:je, amount_rial:r.amt });
    results.push({ type:r.o.output_type, product_id:r.o.product_id, qty:r.q,
                   share_percent:r.o.cost_share_percent, amount_rial:r.amt, unit_cost_rial:unit });
  }

  // ═══ کنترل نهایی ═══
  const residual = wipResidual(db, orderId);
  if (Math.abs(residual) > 5) throw err('E_WIP_RESIDUAL', 500, { x: residual });

  db.prepare(`UPDATE production_orders SET
       status='completed', actual_end=?, qty_produced=?, unit_cost_rial=?,
       total_cost_rial=?, byproduct_credit_rial=? WHERE id=?`)
    .run(date, last.qty_out, mainRow ? Math.round(mainRow.amt / (mainRow.q||1)) : 0,
         afterBy, byCredit, orderId);

  emit(db,'production.order.finalized',{ orderId, outputs:results,
        unitCostRial: mainRow ? Math.round(mainRow.amt/(mainRow.q||1)) : 0 });
  return { wip_final_rial:wip, by_credit_rial:byCredit, net_rial:afterBy,
           outputs:results, journal_entries:jes, wip_residual_rial:residual };
}
```

---

## ۲۰. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی ماژول ۷ — تولید آنالیز ثابت پیشرفته

## پیش‌نیاز
ماژول ۱، ۲، ۴ کامل و تست‌شده. این ماژول همه‌شان را به هم وصل می‌کند.

## اسناد مرجع (همه را بخوان)
- docs/Production/07-fixed-analysis-advanced.md   ← این سند. §2 (ADR-012) حیاتی است.
- docs/Production/04-advanced-formulas.md         ← stageLabor, stageDriverQty, rollUpBom
- docs/Production/02-fixed-analysis.md            ← منطق Backflush و بهایابی
- docs/Production/accounting-scenarios.md         ← A-27..A-40
- docs/Production/database-schema.md              ← §2.4, §2.10

## ⚠️ قواعد قطعی
1. **ADR-012:** WIP یک حساب (1111). انتقال بین مراحل **سند ندارد**.
   اگر postToLedger با sourceType='production_stage_transfer' نوشتی → پاک کن.
   تفکیک مرحله فقط در production_order_stages + تفصیلی.
2. **پیمانکاری استثناست** — PRD-13/14 سند دارند (1114 موجودی نزد پیمانکار).
3. ضایعات عادی مرحله‌ای = **بدون سند**. فقط qty_out کمتر → unit_cost بالاتر.
4. کسری نزد پیمانکار (`qty_lost`) **همیشه غیرعادی** → 5221.
5. `receipt.amount_rial = WIP_net` دقیق. WIP بعد از finalize باید **صفر** باشد.
6. هر مرحله با نرخ سربار **دوره خودش** (مهم برای سفارش‌های چندماهه).
7. تفصیلی: WIP→سفارش، 5201/5202/5203→مرکز هزینه، 1114→تأمین‌کننده.
8. اختلاف گرد کردن تسهیم خروجی → همیشه به `main`.
9. کل ثبت یک مرحله در **یک** db.transaction.

## گام‌ها

### گام ۱ — Schema
server/db.js:
- CREATE TABLE production_order_stages, production_subcontract, production_rework (§2.4, §2.8, §2.10)
- CREATE TABLE user_cost_centers  (§14)
- ensureColumn: persons.cost_center_id, persons.labor_method,
                payroll_records.production_linked, payroll_records.cost_center_id,
                production_orders.qty_planned_start,
                cost_center_rates.monthly_labor_rate_rial
- trigger های period_lock برای production_order_stages, production_subcontract, production_rework
- PROD_SEQUENCES: subcontract (SC), production_rework (RW)

### گام ۲ — موتور پیشرفته
server/lib/production/engine-advanced.js:
  releaseAdvancedOrder      ← Snapshot مراحل + allocTafsili + رزرو
  startStage, postStageOutput (§19 دقیقاً), previewStageOutput,
  skipStage, blockStage, unblockStage,
  finalizeAdvancedOrder (§19 دقیقاً),
  reverseStage, valueAddedAnalysis, orderFlow

server/lib/production/subcontract.js:
  sendToSubcontractor    → PRD-13
  receiveFromSubcontractor → PRD-14 (+ VAT + qty_lost → PRD-09)
  subcontractBalance, checkOverdue

server/lib/production/rework.js:
  postRework  → PRD-11 (normal) / PRD-12 (abnormal)
  completeRework  → qty_recovered برگشت + qty_failed → PRD-09
  ⚠️ حداکثر ۳ دور → E_REWORK_LIMIT

server/lib/production/labor.js  (توسعه):
  linkPayrollToProduction (§6.4)
  ⚠️ payroll_records.gross_pay به **تومان** است → × 10 برای ریال
  ⚠️ persons.cost_center_id: kind='production' → 5201 · وگرنه → 5202

### گام ۳ — اتصال payroll
server/routes/payroll.js:
  بعد از ایجاد payroll_record → اگر persons.cost_center_id پر است
  → linkPayrollToProduction()

### گام ۴ — Route
server/routes/production-execution.js — ۱۸ endpoint از §15
- assertUserCostCenter از user_cost_centers
- Idempotency-Key روی همه POSTهای اجرایی

### گام ۵ — UI
1. **نمای مرحله‌ای سفارش** (§17) — نوار پیشرفت ۶ مرحله + کارت مرحله جاری
2. **فرم ثبت خروجی مرحله** — پیش‌نمایش زنده بها
3. **فرم پیمانکاری** — تب ارسال/دریافت با نمایش سند
4. **نمودار ارزش افزوده** — با پیام هوشمند «کنترل کیفیت را روی برش متمرکز کن»
5. اپراتور: فقط مراحل تخصیص‌یافته + بدون ستون بها
6. RTL, Vazirmatn, #1B5C4A/#2D7A5F/#C9A84C, Mobile-first (کارت به‌جای جدول)

### گام ۶ — تست
server/scripts/test-production-fixed-advanced.js — ۴۰ تست از §18
حیاتی‌ترین‌ها:
  T7-04..T7-09  cost_out هر ۶ مرحله دقیقاً
  T7-10  انتقال بدون سند (ADR-012)
  T7-18  سند دریافت پیمانکار تراز
  T7-28  رسید 694,933,300
  T7-29  unit_cost = 2,315,880
  T7-30  WIP = 0
  T7-31  تراز کل 1111 = 1,370,737,385
  T7-37  ابطال معکوس کامل

## معیار پذیرش
- [ ] جدول §7 عیناً بازتولید شود (۶ مرحله + ۱۹ سند)
- [ ] `SELECT SUM(debit_rial)-SUM(credit_rial) FROM journal_lines WHERE account_code='1111'
        AND detail_account_id=(تفصیلی PO-1405-0010)` = 0
- [ ] `1114` بعد از دریافت پیمانکار = 0
- [ ] هیچ JE با sourceType شامل 'stage_transfer'
- [ ] health-check H1..H5 همه خالی

## ممنوعیت‌ها
- ❌ سند انتقال بین مراحل
- ❌ حساب WIP جدا برای هر مرحله
- ❌ سند برای ضایعات عادی
- ❌ نرخ سربار یکسان برای همه دوره‌ها
- ❌ unit_cost × qty برای مبلغ رسید
````

---

## ۲۱. خروجی‌های این ماژول

| خروجی | مسیر |
|-------|------|
| Migration | `server/db.js` |
| موتور پیشرفته | `server/lib/production/engine-advanced.js` |
| پیمانکاری | `server/lib/production/subcontract.js` |
| دوباره‌کاری | `server/lib/production/rework.js` |
| دستمزد (توسعه) | `server/lib/production/labor.js` |
| اتصال حقوق | `server/routes/payroll.js` |
| Route | `server/routes/production-execution.js` |
| UI | `server/public/index.html` |
| تست | `server/scripts/test-production-fixed-advanced.js` |
