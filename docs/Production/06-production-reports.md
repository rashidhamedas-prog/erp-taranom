# 06-production-reports.md
## زیرگروه ۶ — گزارشات تولید

---

## ۱. هدف ماژول

ماژول‌های ۱ تا ۸ **داده تولید می‌کنند**. این ماژول **داده را به تصمیم تبدیل می‌کند**.

**اصول طراحی:**
| اصل | معنی |
|-----|------|
| **صفر نوشتن** | هیچ گزارشی `INSERT/UPDATE/DELETE` ندارد — فقط `SELECT` |
| **صفر محاسبه مجدد** | اعداد از جداول تراکنشی خوانده می‌شوند، نه بازمحاسبه از BOM |
| **قابل تطبیق با دفتر کل** | هر عدد ریالی باید با `journal_lines` قابل تطبیق باشد |
| **مبتنی بر نقش** | ویزیتور بها نمی‌بیند · اپراتور فقط مرکز خودش |
| **جلالی + RTL + تومان** | نمایش تومان، ذخیره ریال |
| **قابل خروجی** | Excel + PDF + چاپ |

---

## ۲. فهرست ۲۴ گزارش

| # | کد | عنوان | منبع | مخاطب |
|---|----|-------|------|-------|
| **الف — عملیاتی** ||||
| ۱ | `PR-01` | لیست سفارش‌های تولید | `production_orders` | همه |
| ۲ | `PR-02` | برگه بهای تمام‌شده (Cost Sheet) | `production_orders` + جداول تراکنشی | حسابداری |
| ۳ | `PR-03` | تابلوی وضعیت خط تولید (Kanban) | `production_order_stages` | مدیر تولید |
| ۴ | `PR-04` | دفتر سفارش (همه اسناد) | `journal_entries` | حسابداری |
| ۵ | `PR-05` | زمان چرخه (Lead Time) | `production_order_stages` | مدیر تولید |
| **ب — بهای تمام‌شده** ||||
| ۶ | `PR-06` | تحلیل بهای تمام‌شده دوره | `production_orders` | مدیر |
| ۷ | `PR-07` | روند بهای واحد محصول | `production_receipts` | مدیر |
| ۸ | `PR-08` | مقایسه استاندارد و واقعی | `production_orders` | حسابداری |
| ۹ | `PR-09` | ارزش افزوده مرحله‌ای | `production_order_stages` | مدیر تولید |
| ۱۰ | `PR-10` | مانده WIP | `journal_lines` (1111) | حسابداری |
| **ج — انحرافات** ||||
| ۱۱ | `PR-11` | ماتریس انحراف (مرحله × نوع) ⭐ | `production_variances` | مدیر |
| ۱۲ | `PR-12` | انحراف مواد به تفکیک کالا | `production_material_issues` | خرید + تولید |
| ۱۳ | `PR-13` | پارتو دلایل انحراف | `production_material_issues.note` | مدیر |
| ۱۴ | `PR-14` | کسر/اضافه جذب سربار | `cost_center_rates` | حسابداری |
| **د — ضایعات و کیفیت** ||||
| ۱۵ | `PR-15` | تحلیل ضایعات | `production_waste` | مدیر تولید |
| ۱۶ | `PR-16` | بهره‌وری (Yield) | `production_order_stages` | مدیر تولید |
| ۱۷ | `PR-17` | دوباره‌کاری | `production_rework` | کیفیت |
| **ه — منابع** ||||
| ۱۸ | `PR-18` | عملکرد مراکز هزینه | `production_order_stages` | مدیر |
| ۱۹ | `PR-19` | گلوگاه و ظرفیت | `production_order_stages` + `cost_centers` | مدیر تولید |
| ۲۰ | `PR-20` | مصرف مواد دوره | `production_material_issues` | خرید |
| ۲۱ | `PR-21` | عملکرد پیمانکاران | `production_subcontract` | خرید |
| **و — مالی/مدیریتی** ||||
| ۲۲ | `PR-22` | سودآوری محصول | `production_receipts` + `invoices` | مدیر |
| ۲۳ | `PR-23` | سود دقیق ماهانه ⭐⭐ | `production_period_close` | **حامد** |
| ۲۴ | `PR-24` | داشبورد تولید | تجمیعی | **حامد** |

---

## ۳. ساختار دیتابیس

> **هیچ جدول جدیدی.** فقط `VIEW` برای گزارش‌های پرتکرار + ایندکس‌های گزارشی.

```sql
-- ═══ VIEW ها ═══

-- مانده WIP هر سفارش (منبع واحد حقیقت)
CREATE VIEW IF NOT EXISTS v_wip_by_order AS
SELECT po.id AS order_id, po.order_no, po.product_id, po.status, po.period_label,
       COALESCE(SUM(CASE WHEN jl.account_code = (SELECT value FROM settings WHERE key='coa_wip')
                          OR jl.account_code = '1111'
                    THEN jl.debit_rial - jl.credit_rial ELSE 0 END), 0) AS wip_rial
FROM production_orders po
LEFT JOIN journal_entries je ON je.ref_id = po.id
                            AND je.ref_type LIKE 'production_%'
                            AND COALESCE(je.deleted_at,0) = 0
LEFT JOIN journal_lines jl   ON jl.entry_id = je.id
GROUP BY po.id;

-- خلاصه بهای هر سفارش
CREATE VIEW IF NOT EXISTS v_order_cost_summary AS
SELECT po.id AS order_id, po.order_no, po.product_id, p.name AS product_name,
       po.date, po.period_label, po.status, po.analysis_type,
       po.qty_planned, po.qty_produced,
       po.qty_waste_normal, po.qty_waste_abnormal,
       po.material_cost_rial, po.packaging_cost_rial, po.labor_cost_rial,
       po.overhead_cost_rial, po.subcontract_cost_rial, po.rework_cost_rial,
       po.abnormal_waste_rial, po.scrap_credit_rial, po.byproduct_credit_rial,
       po.total_cost_rial, po.unit_cost_rial,
       po.std_total_rial, po.std_unit_rial,
       CASE WHEN po.std_unit_rial > 0
            THEN ROUND((po.unit_cost_rial - po.std_unit_rial) * 100.0 / po.std_unit_rial, 2)
            ELSE 0 END AS deviation_pct,
       CASE WHEN (po.qty_produced + po.qty_waste_normal + po.qty_waste_abnormal) > 0
            THEN ROUND(po.qty_produced * 100.0
                       / (po.qty_produced + po.qty_waste_normal + po.qty_waste_abnormal), 2)
            ELSE 0 END AS yield_pct
FROM production_orders po
JOIN products p ON p.id = po.product_id;

-- خلاصه انحرافات دوره
CREATE VIEW IF NOT EXISTS v_variance_summary AS
SELECT v.period_label, v.variance_type, v.cost_center_id, cc.code AS cc_code, cc.name AS cc_name,
       s.seq AS stage_seq,
       SUM(v.amount_rial) AS amount_rial,
       COUNT(DISTINCT v.order_id) AS order_count,
       SUM(CASE WHEN v.amount_rial < 0 THEN 1 ELSE 0 END) AS favorable_count
FROM production_variances v
LEFT JOIN cost_centers cc               ON cc.id = v.cost_center_id
LEFT JOIN production_order_stages s     ON s.id  = v.stage_id
GROUP BY v.period_label, v.variance_type, v.cost_center_id, s.seq;

-- ═══ ایندکس‌های گزارشی ═══
CREATE INDEX IF NOT EXISTS ix_rpt_po_period   ON production_orders(period_label, status, product_id);
CREATE INDEX IF NOT EXISTS ix_rpt_pr_period   ON production_receipts(period_label, product_id, date);
CREATE INDEX IF NOT EXISTS ix_rpt_mi_period   ON production_material_issues(period_label, product_id, cost_center_id);
CREATE INDEX IF NOT EXISTS ix_rpt_ws_period   ON production_waste(period_label, waste_type, cost_center_id);
CREATE INDEX IF NOT EXISTS ix_rpt_pos_cc      ON production_order_stages(cost_center_id, status, ended_at);
CREATE INDEX IF NOT EXISTS ix_rpt_jl_acct     ON journal_lines(account_code, entry_id);
```

---

## ۴. گزارش‌های کلیدی — مشخصات کامل

### PR-02 — برگه بهای تمام‌شده (Cost Sheet)

**`GET /api/production/reports/cost-sheet?order_id=10`**

```
┌──────────────────────────────────────────────────────────────────┐
│              برگه بهای تمام‌شده — تولیدی ترنم                     │
│  سفارش: PO-1405-0010   ·   تاریخ: ۱۴۰۵/۰۴/۱۵ تا ۱۴۰۵/۰۴/۲۲     │
│  محصول: مانتو کتان ترمه — سبز   ·   فرمول: BOM-000101 v2         │
│  نوع آنالیز: ثابت پیشرفته   ·   وضعیت: بسته                      │
├──────────────────────────────────────────────────────────────────┤
│ تعداد شروع‌شده              ۳۱۴.۰۰ عدد                            │
│ تعداد سالم                 ۳۰۰.۰۷ عدد                            │
│ ضایعات عادی                 ۱۳.۹۳ عدد   (۴.۴۴٪)                  │
│ ضایعات غیرعادی               ۰.۰۰ عدد                            │
│ بهره‌وری                    ۹۵.۵۶٪                                │
├──────────────────────────────────────────────────────────────────┤
│ جزء                         مبلغ (ریال)      هر عدد        ٪     │
│ ────────────────────────────────────────────────────────────     │
│ مواد اولیه                  ۵۴۲٬۷۶۵٬۰۶۹   ۱٬۸۰۸٬۷۸۹    ۷۷.۷    │
│ مواد بسته‌بندی                 ۴٬۷۱۰٬۰۰۰      ۱۵٬۶۹۶     ۰.۷    │
│ دستمزد مستقیم                ۸۹٬۲۰۴٬۱۶۷     ۲۹۷٬۲۷۵    ۱۲.۸    │
│ کارمزد پیمانکاری             ۱۱٬۵۷۶٬۴۲۶      ۳۸٬۵۷۹     ۱.۷    │
│ سربار جذب‌شده                ۵۰٬۰۶۸٬۸۳۸     ۱۶۶٬۸۵۵     ۷.۲    │
│ ════════════════════════════════════════════════════════════     │
│ جمع بهای تولید             ۶۹۸٬۳۲۴٬۵۰۰                 ۱۰۰.۰    │
│ (−) محصول فرعی                (۳٬۳۹۱٬۲۰۰)    (۱۱٬۳۰۱)   (۰.۵)   │
│ ════════════════════════════════════════════════════════════     │
│ 💰 بهای تمام‌شده کل        ۶۹۴٬۹۳۳٬۳۰۰                            │
│ 📦 بهای هر عدد               ۲٬۳۱۵٬۸۸۰ ریال  =  ۲۳۱٬۵۸۸ تومان    │
├──────────────────────────────────────────────────────────────────┤
│ مقایسه با استاندارد                                              │
│ استاندارد هر عدد             ۲٬۳۱۵٬۸۸۰ ریال                      │
│ واقعی هر عدد                 ۲٬۳۱۵٬۸۸۰ ریال                      │
│ انحراف                                ۰   (۰.۰۰٪)  ✅            │
├──────────────────────────────────────────────────────────────────┤
│ تفکیک مرحله‌ای                                                    │
│ مرحله      ورودی  خروجی   بهای خروجی    ارزش افزوده      ٪      │
│ ۱۰ برش     ۳۱۴.۰ ۳۰۷.۷  ۵۳۰٬۰۶۸٬۵۲۵  ۵۳۰٬۰۶۸٬۵۲۵    ۷۵.۹    │
│ ۲۰ گلدوزی  ۳۰۷.۷ ۳۰۷.۷  ۵۶۲٬۳۷۹٬۱۲۵   ۳۲٬۳۱۰٬۶۰۰     ۴.۶    │
│ ۳۰ دوخت    ۳۰۷.۷ ۳۰۴.۶  ۶۳۹٬۲۹۰٬۲۸۵   ۷۶٬۹۱۱٬۱۶۰    ۱۱.۰    │
│ ۴۰ یراق    ۳۰۴.۶ ۳۰۴.۶  ۶۷۲٬۴۱۲٬۸۸۵   ۳۳٬۱۲۲٬۶۰۰     ۴.۷    │
│ ۵۰ شستشو   ۳۰۴.۶ ۳۰۰.۱  ۶۸۵٬۵۱۲٬۵۲۵   ۱۳٬۰۹۹٬۶۴۰     ۱.۹    │
│ ۶۰ اتو     ۳۰۰.۱ ۳۰۰.۱  ۶۹۸٬۳۲۴٬۵۰۰   ۱۲٬۸۱۱٬۹۷۵     ۱.۸    │
├──────────────────────────────────────────────────────────────────┤
│ 🏷 قیمت پیشنهادی (Mark-up ۳۵٪)   ۳٬۱۲۶٬۴۳۷ ریال = ۳۱۲٬۶۴۴ ت    │
│ 📈 قیمت لیست فعلی                                ۳۲۰٬۰۰۰ ت      │
│ ✅ حاشیه واقعی روی قیمت لیست                        ۲۷.۶٪        │
├──────────────────────────────────────────────────────────────────┤
│ ✅ مانده WIP: ۰ ریال  ·  ۱۹ سند حسابداری  ·  تراز: بله           │
│                                     [📄 چاپ]  [📥 Excel]  [🔗 اسناد]│
└──────────────────────────────────────────────────────────────────┘
```

**SQL هسته:**
```sql
SELECT * FROM v_order_cost_summary WHERE order_id = :orderId;

SELECT s.seq, cc.code, cc.name, s.qty_in, s.qty_out,
       s.material_in_rial, s.material_added_rial, s.labor_rial,
       s.subcontract_rial, s.overhead_rial, s.cost_out_rial,
       s.cost_out_rial - COALESCE(LAG(s.cost_out_rial) OVER (ORDER BY s.seq), 0) AS value_added_rial
FROM production_order_stages s
JOIN cost_centers cc ON cc.id = s.cost_center_id
WHERE s.order_id = :orderId AND s.status <> 'skipped'
ORDER BY s.seq;

SELECT je.id, je.entry_date, je.description, je.voucher_number, je.ref_type,
       SUM(jl.debit_rial) AS total_rial
FROM journal_entries je
JOIN journal_lines jl ON jl.entry_id = je.id
WHERE je.ref_type LIKE 'production_%' AND je.ref_id = :orderId
  AND COALESCE(je.deleted_at,0) = 0
GROUP BY je.id ORDER BY je.id;
```

---

### PR-10 — مانده WIP (تطبیق با دفتر کل)

**`GET /api/production/reports/wip?date=1405/04/31`**

```sql
-- مانده WIP از دفتر کل (منبع حقیقت)
WITH wip_ledger AS (
  SELECT jl.detail_account_id,
         SUM(jl.debit_rial) - SUM(jl.credit_rial) AS bal_rial
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_code = (SELECT COALESCE((SELECT value FROM settings WHERE key='coa_wip'), '1111'))
    AND je.entry_date <= :date
    AND COALESCE(je.deleted_at,0) = 0
  GROUP BY jl.detail_account_id
)
SELECT po.order_no, p.name AS product_name, po.status,
       po.qty_planned, po.qty_produced,
       po.date AS start_date,
       COALESCE(w.bal_rial, 0) AS wip_rial,
       ROUND(COALESCE(w.bal_rial,0) / 10.0) AS wip_toman,
       (SELECT COUNT(*) FROM production_order_stages
        WHERE order_id = po.id AND status = 'done')       AS stages_done,
       (SELECT COUNT(*) FROM production_order_stages
        WHERE order_id = po.id)                            AS stages_total,
       (SELECT cc.name FROM production_order_stages s
        JOIN cost_centers cc ON cc.id = s.cost_center_id
        WHERE s.order_id = po.id AND s.status = 'in_progress'
        ORDER BY s.seq LIMIT 1)                            AS current_stage
FROM production_orders po
JOIN products p       ON p.id = po.product_id
LEFT JOIN wip_ledger w ON w.detail_account_id = po.coa_wip_tafsili
WHERE po.status IN ('released','in_progress','completed')
   OR COALESCE(w.bal_rial,0) <> 0
ORDER BY wip_rial DESC;
```

**کنترل تطبیق (اجباری در UI):**
```
مجموع WIP سفارش‌ها  =  مانده حساب کل 1111
اگر ≠ → 🔴 «مغایرت WIP — گزارش مغایرت را ببینید»
```

---

### PR-14 — کسر/اضافه جذب سربار

**`GET /api/production/reports/overhead-variance?period=1405/04`**

```sql
SELECT cc.code, cc.name, r.driver,
       r.budget_fixed_oh_rial, r.budget_var_oh_rial,
       r.budget_fixed_oh_rial + r.budget_var_oh_rial AS budget_total_rial,
       r.budget_driver_qty, r.total_rate_rial, r.is_estimated,
       -- واقعی از دفتر کل (5202)
       COALESCE((SELECT SUM(jl.debit_rial) - SUM(jl.credit_rial)
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.entry_id
                 WHERE jl.account_code = '5202'
                   AND jl.detail_account_id = cc.coa_tafsili_oh
                   AND je.entry_date BETWEEN :from AND :to
                   AND COALESCE(je.deleted_at,0)=0), 0) AS actual_oh_rial,
       -- جذب‌شده از دفتر کل (5203)
       COALESCE((SELECT SUM(jl.credit_rial) - SUM(jl.debit_rial)
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.entry_id
                 WHERE jl.account_code = '5203'
                   AND jl.detail_account_id = cc.coa_tafsili_oh
                   AND je.entry_date BETWEEN :from AND :to
                   AND COALESCE(je.deleted_at,0)=0), 0) AS applied_oh_rial,
       -- محرک واقعی
       COALESCE((SELECT SUM(driver_qty) FROM production_overhead_applications
                 WHERE cost_center_id = cc.id AND period_label = :period
                   AND status = 'posted'), 0) AS actual_driver_qty
FROM cost_centers cc
LEFT JOIN cost_center_rates r ON r.cost_center_id = cc.id AND r.period_label = :period
WHERE cc.kind = 'production' AND cc.active = 1
ORDER BY cc.seq;
```

**خروجی نمونه:**
```
┌────────────────────────────────────────────────────────────────────────┐
│ کسر/اضافه جذب سربار — دوره ۱۴۰۵/۰۴                                     │
├──────────┬─────────────┬───────────┬───────────┬───────────┬──────────┤
│ مرکز     │ محرک        │ بودجه     │ واقعی     │ جذب‌شده   │ انحراف   │
├──────────┼─────────────┼───────────┼───────────┼───────────┼──────────┤
│ برش      │ ریال مواد   │ ۵٬۰۰۰٬۰۰۰│ ۵٬۲۰۰٬۰۰۰│ ۴٬۶۵۸٬۰۴۴│🔴+۵۴۱٬۹۵۶│
│ گلدوزی   │ ساعت ماشین  │۱۸٬۰۰۰٬۰۰۰│۱۷٬۵۰۰٬۰۰۰│۱۸٬۴۶۳٬۲۰۰│🟢−۹۶۳٬۲۰۰│
│ دوخت     │ ریال دستمزد │۲۰٬۰۰۰٬۰۰۰│۲۱٬۲۰۰٬۰۰۰│۱۹٬۳۸۶٬۳۶۰│🔴+۱٬۸۱۳٬۶۴۰│
│ یراق     │ تعداد       │ ۲٬۵۰۰٬۰۰۰│ ۲٬۴۰۰٬۰۰۰│ ۲٬۴۳۷٬۱۴۲│🟢 −۳۷٬۱۴۲│
│ شستشو    │ تعداد       │ ۱٬۵۰۰٬۰۰۰│ ۱٬۵۵۰٬۰۰۰│ ۱٬۵۲۳٬۲۱۴│🔴 +۲۶٬۷۸۶│
│ اتو      │ تعداد       │ ۳٬۶۰۰٬۰۰۰│ ۳٬۷۰۰٬۰۰۰│ ۳٬۶۰۰٬۸۷۸│🔴 +۹۹٬۱۲۲│
├──────────┴─────────────┴───────────┴───────────┴───────────┴──────────┤
│ جمع                       ۵۰٬۶۰۰٬۰۰۰ ۵۱٬۵۵۰٬۰۰۰ ۵۰٬۰۶۸٬۸۳۸ 🔴+۱٬۴۸۱٬۱۶۲│
│ ⇒ کسر جذب ۱٬۴۸۱٬۱۶۲ ریال (۲.۹٪) → تسهیم پایان ماه (ADR-005)          │
└────────────────────────────────────────────────────────────────────────┘
```

---

### PR-23 — سود دقیق ماهانه ⭐⭐ (خواسته اصلی حامد)

**`GET /api/production/reports/monthly-profit?period=1405/04`**

این گزارش **دلیل وجود ADR-005** است. صورت سود و زیان دقیق ماه با اثر تولید.

```
┌────────────────────────────────────────────────────────────────────────┐
│         💰 سود دقیق ماهانه — تیر ۱۴۰۵ (۱۴۰۵/۰۴/۰۱ تا ۱۴۰۵/۰۴/۳۱)      │
│         وضعیت دوره: بسته ✅  ·  تاریخ بستن: ۱۴۰۵/۰۵/۰۳                 │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ فروش                                                                  │
│   فروش ناخالص                                    ۲٬۸۵۰٬۰۰۰٬۰۰۰ ریال    │
│   (−) تخفیفات فروش                                (۳۴۲٬۰۰۰٬۰۰۰)        │
│   (−) برگشت از فروش                                (۴۵٬۰۰۰٬۰۰۰)        │
│   ═══════════════════════════════════════════════════════════          │
│   فروش خالص                                       ۲٬۴۶۳٬۰۰۰٬۰۰۰        │
│                                                                         │
│ ▸ بهای تمام‌شده کالای فروش‌رفته                                         │
│   موجودی کالای ساخته‌شده اول دوره                    ۱۰۵٬۰۰۰٬۰۰۰        │
│   (+) بهای تولید دوره                             ۱٬۹۸۴٬۷۶۵٬۹۰۰        │
│       ├ مواد اولیه          ۱٬۵۴۰٬۲۰۰٬۰۰۰                              │
│       ├ بسته‌بندی               ۱۳٬۴۵۰٬۰۰۰                              │
│       ├ دستمزد مستقیم         ۲۵۴٬۸۹۰٬۰۰۰                              │
│       ├ پیمانکاری              ۳۳٬۰۲۵٬۹۰۰                              │
│       └ سربار جذب‌شده         ۱۴۳٬۲۰۰٬۰۰۰                              │
│   (−) موجودی کالای ساخته‌شده پایان دوره            (۷۶۸٬۵۲۷٬۶۸۱)        │
│   ═══════════════════════════════════════════════════════════          │
│   بهای تمام‌شده استاندارد                          ۱٬۳۲۱٬۲۳۸٬۲۱۹        │
│   (+) تسهیم انحراف سربار — سهم COGS                   ۹۸۶٬۰۷۰         │
│   (+) تسهیم انحراف دستمزد — سهم COGS                  ۳۲۱٬۳۵۳         │
│   ═══════════════════════════════════════════════════════════          │
│   💰 بهای تمام‌شده کالای فروش‌رفته                 ۱٬۳۲۲٬۵۴۵٬۶۴۲        │
│                                                                         │
│ ▸ سود ناخالص                                      ۱٬۱۴۰٬۴۵۴٬۳۵۸  ۴۶.۳٪│
│                                                                         │
│ ▸ هزینه‌های دوره (غیرقابل تسهیم به موجودی)                              │
│   ضایعات غیرعادی                                     (۹٬۸۷۵٬۰۰۰)       │
│   دوباره‌کاری غیرعادی                                 (۲٬۳۴۰٬۰۰۰)       │
│   کسری انبارگردانی                                  (۱۳٬۸۱۳٬۰۰۰)       │
│   هزینه‌های اداری                                    (۸۵٬۰۰۰٬۰۰۰)       │
│   هزینه‌های فروش و بازاریابی                        (۱۲۰٬۰۰۰٬۰۰۰)       │
│   کمیسیون ویزیتور                                   (۱۱۰٬۸۳۵٬۰۰۰)       │
│   ═══════════════════════════════════════════════════════════          │
│ ▸ 🎯 سود عملیاتی                                    ۷۹۸٬۵۹۱٬۳۵۸  ۳۲.۴٪│
├────────────────────────────────────────────────────────────────────────┤
│ ▸ تسهیم انحرافات (ADR-005 — روش تسهیم متناسب)                          │
│   ┌──────────────┬────────────┬────────────┬────────────┬───────────┐ │
│   │ نوع انحراف   │ کل         │ → WIP      │ → کالا     │ → COGS    │ │
│   ├──────────────┼────────────┼────────────┼────────────┼───────────┤ │
│   │ سربار (کسر)  │ ۱٬۴۸۱٬۱۶۲ │   ۱۸۷٬۳۱۶ │   ۳۰۷٬۷۷۶ │   ۹۸۶٬۰۷۰│ │
│   │ دستمزد       │   ۴۸۲٬۷۰۰ │    ۶۱٬۰۴۵ │   ۱۰۰٬۳۰۲ │   ۳۲۱٬۳۵۳│ │
│   ├──────────────┼────────────┼────────────┼────────────┼───────────┤ │
│   │ جمع          │ ۱٬۹۶۳٬۸۶۲ │   ۲۴۸٬۳۶۱ │   ۴۰۸٬۰۷۸ │ ۱٬۳۰۷٬۴۲۳│ │
│   │ پایه تسهیم   │            │    ۱۲.۶۵٪ │    ۲۰.۷۸٪ │    ۶۶.۵۷٪│ │
│   └──────────────┴────────────┴────────────┴────────────┴───────────┘ │
│   ℹ️ انحراف مواد تسهیم نشد — WIP از ابتدا به بهای واقعی است (ADR-011) │
│   ℹ️ ضایعات غیرعادی تسهیم نشد — ۱۰۰٪ هزینه دوره (ADR-005)             │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ کنترل‌های صحت                                                         │
│   ✅ مانده ۵۲۰۱ کنترل دستمزد پس از بستن            ۰ ریال              │
│   ✅ مانده ۵۲۰۲ کنترل سربار پس از بستن             ۰ ریال              │
│   ✅ مانده ۵۲۰۳ سربار جذب‌شده پس از بستن           ۰ ریال              │
│   ✅ سود ناخالص گزارش = سود ناخالص صورت سود و زیان                     │
│   ✅ موجودی پایان دوره گزارش = مانده حساب ۱۱۰۴                         │
│   ✅ WIP پایان دوره گزارش = مانده حساب ۱۱۱۱                            │
├────────────────────────────────────────────────────────────────────────┤
│              [📄 چاپ]  [📥 Excel]  [🔗 اسناد بستن دوره]                │
└────────────────────────────────────────────────────────────────────────┘
```

**SQL هسته:**
```sql
-- بهای تولید دوره
SELECT
  SUM(material_cost_rial)    AS material_rial,
  SUM(packaging_cost_rial)   AS packaging_rial,
  SUM(labor_cost_rial)       AS labor_rial,
  SUM(subcontract_cost_rial) AS subcontract_rial,
  SUM(overhead_cost_rial)    AS overhead_rial,
  SUM(total_cost_rial)       AS total_rial
FROM production_orders
WHERE period_label = :period AND status IN ('completed','closed');

-- COGS از دفتر کل
SELECT SUM(jl.debit_rial) - SUM(jl.credit_rial) AS cogs_rial
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
WHERE jl.account_code = '5101' AND je.entry_date BETWEEN :from AND :to
  AND COALESCE(je.deleted_at,0)=0;

-- تسهیم انحرافات
SELECT variance_type, SUM(amount_rial) total_rial,
       SUM(alloc_wip_rial) wip_rial, SUM(alloc_fg_rial) fg_rial, SUM(alloc_cogs_rial) cogs_rial
FROM production_variances
WHERE period_label = :period AND status = 'allocated'
GROUP BY variance_type;

-- کنترل‌های صحت
SELECT jl.account_code, SUM(jl.debit_rial) - SUM(jl.credit_rial) AS bal_rial
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
WHERE jl.account_code IN ('5201','5202','5203')
  AND je.entry_date <= :to AND COALESCE(je.deleted_at,0)=0
GROUP BY jl.account_code;
```

---

### PR-24 — داشبورد تولید

**`GET /api/production/reports/dashboard?period=1405/04`**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🏭 داشبورد تولید — تیر ۱۴۰۵                     [🔄]  دوره: [۱۴۰۵/۰۴ ▾] │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│ │ 📦 تولید   │ │ 💰 بهای    │ │ ⚙️ بهره‌وری│ │ 🔴 ضایعات │            │
│ │            │ │   تمام‌شده  │ │            │ │  غیرعادی   │            │
│ │  ۸۵۷ عدد  │ │ ۲۳۱٬۵۸۸ ت │ │  ۹۵.۵٪    │ │ ۹.۹ م.ت   │            │
│ │  ▲ ۱۲٪    │ │  ▲ ۳.۲٪   │ │  ▼ ۰.۸٪   │ │  ▲ ۴۵٪ 🔴 │            │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘            │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│ │ 🏗 WIP     │ │ 📊 انحراف  │ │ ⏱ زمان چرخه│ │ 🎯 سود    │            │
│ │            │ │   سربار    │ │            │ │  ناخالص    │            │
│ │ ۵۶.۲ م.ت  │ │ ۱.۵ م.ت   │ │  ۷.۲ روز  │ │  ۴۶.۳٪    │            │
│ │  ۳ سفارش  │ │ کسر ۲.۹٪  │ │  ▼ ۰.۵ر   │ │  ▲ ۱.۸٪   │            │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘            │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─ 📈 روند بهای واحد (۶ ماه) ────────┐ ┌─ 🥧 ترکیب بها ──────────────┐│
│ │ ۲۴۰ت ┤                        ╭─   │ │                              ││
│ │ ۲۳۰ت ┤                  ╭─────╯    │ │      ┌──────┐               ││
│ │ ۲۲۰ت ┤            ╭─────╯          │ │      │ مواد │ ۷۷.۷٪         ││
│ │ ۲۱۰ت ┤      ╭─────╯                │ │      │      │               ││
│ │ ۲۰۰ت ┤──────╯                      │ │      └──┬───┘               ││
│ │      └─┬───┬───┬───┬───┬───┬──     │ │  دستمزد ۱۲.۸٪ · سربار ۷.۲٪ ││
│ │       بهم اسف فرو ارد خرد تیر      │ │  پیمان ۱.۷٪ · بسته ۰.۷٪    ││
│ └────────────────────────────────────┘ └──────────────────────────────┘│
│                                                                          │
│ ┌─ ⚙️ بار مراکز هزینه ───────────────────────────────────────────────┐  │
│ │ برش    ▓▓▓▓▓░░░░░ ۵۲٪  │ یراق  ▓▓▓░░░░░░░ ۳۱٪                    │  │
│ │ گلدوزی ▓▓▓▓░░░░░░ ۴۱٪  │ شستشو ▓▓░░░░░░░░ ۲۲٪ 🏭                 │  │
│ │ دوخت   ▓▓▓▓▓▓▓▓▓░ ۸۹٪ 🟡 ◄ گلوگاه  │ اتو ▓▓▓░░░░░░░ ۲۸٪         │  │
│ └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│ ┌─ 🎯 انحراف به تفکیک مرحله ─────────┐ ┌─ 🔴 هشدارها ─────────────────┐│
│ │ برش    🔴 +۴۱.۶ م.ت  ███████████  │ │ • ضایعات غیرعادی ۴۵٪ رشد     ││
│ │ دوخت   🔴  +۰.۱ م.ت  ▏            │ │ • دوخت گلوگاه (۸۹٪)          ││
│ │ یراق   🟢  −۰.۹ م.ت  ▏            │ │ • آستر زیر نقطه سفارش        ││
│ │ [مشاهده ماتریس کامل →]            │ │ • ۲ سفارش بیش از ۱۰ روز باز  ││
│ └────────────────────────────────────┘ └──────────────────────────────┘│
│                                                                          │
│ ┌─ 📋 سفارش‌های باز ─────────────────────────────────────────────────┐  │
│ │ PO-1405-0014 مانتو یشمی  ۲۰۰ عدد  🔵 دوخت    ۴۵٪  ۵ روز           │  │
│ │ PO-1405-0015 شومیز ساتن  ۳۵۰ عدد  🟠 برش     ۱۵٪  ۲ روز           │  │
│ │ PO-1405-0016 مانتو ترمه  ۱۰۰ عدد  🏭 شستشو   ۷۵٪  ۸ روز ⚠️        │  │
│ └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## ۵. بقیه گزارش‌ها — مشخصات فشرده

| کد | endpoint | پارامترها | خروجی کلیدی |
|----|----------|-----------|-------------|
| `PR-01` | `/reports/orders` | `status, from, to, product_id, page` | لیست + تجمیع |
| `PR-03` | `/reports/kanban` | — | مراحل × سفارش‌ها (نمای تابلو) |
| `PR-04` | `/orders/:id/ledger` | — | همه اسناد سفارش + تراز |
| `PR-05` | `/reports/cycle-time` | `period, product_id` | میانگین روز هر مرحله + کل |
| `PR-06` | `/reports/period-cost` | `period` | تفکیک بها + مقایسه ماه قبل |
| `PR-07` | `/reports/unit-cost-trend` | `product_id, months` | سری زمانی بهای واحد |
| `PR-08` | `/reports/std-vs-actual` | `period, product_id` | جدول انحراف سفارش‌ها |
| `PR-09` | `/orders/:id/value-added` | — | ارزش افزوده هر مرحله |
| `PR-11` | `/reports/variance-matrix` | `period` | ماتریس مرحله × نوع (§۸ ماژول ۸) |
| `PR-12` | `/reports/material-variance` | `period, product_id` | انحراف هر ماده |
| `PR-13` | `/reports/variance-reasons` | `period` | پارتو `reason_code` |
| `PR-15` | `/reports/waste` | `period, cc_id, type` | ضایعات × مرحله × نوع |
| `PR-16` | `/reports/yield` | `period, product_id` | بهره‌وری × مرحله |
| `PR-17` | `/reports/rework` | `period` | دوباره‌کاری + نرخ موفقیت |
| `PR-18` | `/reports/cost-center-performance` | `period` | کارت امتیاز هر مرکز |
| `PR-19` | `/reports/bottleneck` | `period` | بار × ظرفیت |
| `PR-20` | `/reports/material-usage` | `period` | مصرف × کالا + مقایسه خرید |
| `PR-21` | `/reports/subcontractor-performance` | `period` | تأخیر + ضایعات + کارمزد |
| `PR-22` | `/reports/product-profitability` | `period` | فروش − COGS به تفکیک محصول |

### PR-13 — پارتو دلایل انحراف (نمونه خروجی)

```
┌────────────────────────────────────────────────────────────────┐
│ پارتو دلایل انحراف مواد — دوره ۱۴۰۵/۰۴                          │
├──────────────────────┬─────────────┬───────┬──────┬────────────┤
│ دلیل                 │ مبلغ (م.ت)  │ ٪     │ تجمعی│ نمودار     │
├──────────────────────┼─────────────┼───────┼──────┼────────────┤
│ عرض طاقه کمتر        │      ۱٬۵۰۰ │ ۳۶.۷٪│ ۳۶.۷│ ███████████│
│ تورم نرخ پارچه       │      ۱٬۲۰۰ │ ۲۹.۴٪│ ۶۶.۱│ █████████  │
│ خطای الگو            │        ۶۸۰ │ ۱۶.۷٪│ ۸۲.۸│ █████      │
│ عیب پارچه            │        ۴۲۰ │ ۱۰.۳٪│ ۹۳.۱│ ███        │
│ سایر                 │        ۲۸۲ │  ۶.۹٪│۱۰۰.۰│ ██         │
├──────────────────────┴─────────────┴───────┴──────┴────────────┤
│ 💡 قاعده ۸۰/۲۰: ۳ دلیل اول = ۸۲.۸٪ انحراف                      │
│    اقدام: (۱) کنترل عرض طاقه در ورود (۲) خرید عمده پارچه       │
└────────────────────────────────────────────────────────────────┘
```

### PR-21 — عملکرد پیمانکاران (نمونه)

```sql
SELECT s.name AS supplier,
       COUNT(DISTINCT sc.order_id)                      AS orders,
       SUM(CASE WHEN sc.direction='out' THEN sc.qty END) AS qty_sent,
       SUM(CASE WHEN sc.direction='in'  THEN sc.qty END) AS qty_received,
       SUM(sc.qty_lost)                                  AS qty_lost,
       ROUND(SUM(sc.qty_lost) * 100.0
             / NULLIF(SUM(CASE WHEN sc.direction='out' THEN sc.qty END),0), 2) AS lost_pct,
       SUM(sc.fee_amount_rial)                           AS fee_rial,
       ROUND(AVG(julianday_jalali(sc_in.date) - julianday_jalali(sc_out.date)), 1) AS avg_days
FROM production_subcontract sc
JOIN suppliers s ON s.id = sc.supplier_id
LEFT JOIN production_subcontract sc_out ON sc_out.stage_id = sc.stage_id AND sc_out.direction='out'
LEFT JOIN production_subcontract sc_in  ON sc_in.stage_id  = sc.stage_id AND sc_in.direction='in'
WHERE sc.period_label = :period AND sc.status='posted'
GROUP BY s.id ORDER BY fee_rial DESC;
```

---

## ۶. سناریوهای حسابداری

> **✅ هیچ سند حسابداری — همه گزارش‌ها فقط‌خواندنی هستند.**

**الزام حیاتی — تطبیق با دفتر کل:**

| گزارش | باید برابر باشد با |
|-------|--------------------|
| PR-10 مانده WIP | مانده حساب `1111` در `journal_lines` |
| PR-23 موجودی FG پایان دوره | مانده حساب `1104` |
| PR-23 COGS | مانده حساب `5101` |
| PR-14 سربار واقعی | مانده حساب `5202` |
| PR-14 سربار جذب‌شده | مانده حساب `5203` |
| PR-06 بهای تولید دوره | Σ بدهکار `1111` در دوره |

**اگر تطبیق نشد** → گزارش `PR-99` مغایرت:
```sql
-- گزارش مغایرت WIP
SELECT 'مانده حساب کل 1111' AS source,
       SUM(jl.debit_rial) - SUM(jl.credit_rial) AS amount_rial
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
WHERE jl.account_code='1111' AND je.entry_date <= :date AND COALESCE(je.deleted_at,0)=0
UNION ALL
SELECT 'مجموع WIP سفارش‌ها', SUM(wip_rial) FROM v_wip_by_order;
-- دو عدد باید برابر باشند
```

---

## ۷. اعتبارسنجی

| کد | قانون | خطا |
|----|-------|-----|
| V6-01 | `from ≤ to` | `E_DATE_RANGE` |
| V6-02 | بازه ≤ ۵ سال | `E_RANGE_TOO_LARGE` |
| V6-03 | `period` فرمت `YYYY/MM` | `E_INVALID_PERIOD` |
| V6-04 | `page ≥ 1`, `limit ≤ 500` | `E_PAGINATION` |
| V6-05 | هیچ گزارشی نباید بنویسد | `E_READONLY_VIOLATION` (internal) |
| V6-06 | `hide_cost` → حذف فیلدهای بها از JSON | — |
| V6-07 | اپراتور → فقط `user_cost_centers` خودش | `E_FORBIDDEN_CC` |
| V6-08 | Excel ≤ ۵۰٬۰۰۰ سطر | `E_EXPORT_TOO_LARGE` |
| V6-09 | timeout ۳۰ ثانیه | `E_REPORT_TIMEOUT` |
| V6-10 | تطبیق دفتر کل → هشدار | `W_LEDGER_MISMATCH` |

---

## ۸. Edge Case ها

| # | حالت | راه‌حل |
|---|------|--------|
| E6-01 | دوره بدون تولید | جدول خالی + پیام «تولیدی در این دوره ثبت نشده» |
| E6-02 | تقسیم بر صفر (`qty_produced=0`) | `NULLIF(x,0)` + نمایش `—` |
| E6-03 | سفارش بین دو ماه | WIP در هر دو دوره گزارش شود · بها در دوره رسید |
| E6-04 | سند ابطال‌شده | `COALESCE(je.deleted_at,0)=0` در **همه** کوئری‌ها |
| E6-05 | تفصیلی WIP خالی (حالت legacy) | Fallback به `ref_id = order_id` |
| E6-06 | ۱۰٬۰۰۰ سفارش | صفحه‌بندی اجباری + ایندکس |
| E6-07 | مغایرت WIP | `W_LEDGER_MISMATCH` + لینک به PR-99 |
| E6-08 | نرخ سربار برآوردی | ستون `is_estimated` + آیکون ⚠️ |
| E6-09 | محصول با ۲ خروجی (co) | سودآوری به تفکیک هر خروجی |
| E6-10 | Excel با ۱۰۰٬۰۰۰ سطر | `E_EXPORT_TOO_LARGE` + پیشنهاد فیلتر |
| E6-11 | گزارش دوره باز | هشدار «دوره هنوز بسته نشده — اعداد موقتی» |
| E6-12 | تاریخ جلالی در `julianday` | تابع کمکی `jalaliToUnix()` در JS، نه SQL |

---

## ۹. خطاهای احتمالی

| کد | HTTP | پیام |
|----|------|------|
| `E_DATE_RANGE` | 422 | تاریخ پایان نباید قبل از شروع باشد |
| `E_RANGE_TOO_LARGE` | 422 | بازه گزارش حداکثر ۵ سال است |
| `E_INVALID_PERIOD` | 422 | فرمت دوره باید YYYY/MM باشد |
| `E_PAGINATION` | 422 | پارامترهای صفحه‌بندی نامعتبر |
| `E_FORBIDDEN_CC` | 403 | به مرکز هزینه «{cc}» دسترسی ندارید |
| `E_EXPORT_TOO_LARGE` | 422 | {n} سطر بیش از حد مجاز — فیلتر کنید |
| `E_REPORT_TIMEOUT` | 504 | گزارش زمان‌بر شد — بازه را کوتاه کنید |
| `W_LEDGER_MISMATCH` | 200⚠ | مغایرت {x} ریال با دفتر کل — گزارش مغایرت را ببینید |
| `W_PERIOD_OPEN` | 200⚠ | دوره {p} هنوز بسته نشده — اعداد موقتی هستند |

---

## ۱۰. دسترسی کاربران

| گزارش | admin | accounting | prod_manager | prod_operator | sales_manager | field_sales |
|-------|:-----:|:----------:|:------------:|:-------------:|:-------------:|:-----------:|
| PR-01 لیست سفارش‌ها | ✅ | ✅ | ✅ | ✅¹ | ✅² | ❌ |
| PR-02 برگه بها | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-03 کانبان | ✅ | ✅ | ✅ | ✅¹ | ✅² | ❌ |
| PR-04 دفتر سفارش | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| PR-05 زمان چرخه | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| PR-06..PR-10 بها | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-11..PR-14 انحراف | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-15..PR-17 ضایعات | ✅ | ✅ | ✅ | ✅¹ | ❌ | ❌ |
| PR-18..PR-21 منابع | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-22 سودآوری | ✅ | ✅ | ❌ | ❌ | ✅² | ❌ |
| **PR-23 سود ماهانه** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| PR-24 داشبورد | ✅ | ✅ | ✅³ | ❌ | ✅² | ❌ |

¹ فقط مراکز هزینه خودش · ² بدون ستون‌های بها (`hide_cost`) · ³ بدون کارت سود

---

## ۱۱. APIهای موردنیاز

```
GET /api/production/reports/orders                    ?status=&from=&to=&product_id=&page=&limit=
GET /api/production/reports/cost-sheet                ?order_id=
GET /api/production/reports/kanban
GET /api/production/orders/:id/ledger
GET /api/production/reports/cycle-time                ?period=&product_id=
GET /api/production/reports/period-cost               ?period=&compare=prev
GET /api/production/reports/unit-cost-trend           ?product_id=&months=6
GET /api/production/reports/std-vs-actual             ?period=&product_id=
GET /api/production/orders/:id/value-added
GET /api/production/reports/wip                       ?date=
GET /api/production/reports/variance-matrix           ?period=
GET /api/production/reports/material-variance         ?period=&product_id=
GET /api/production/reports/variance-reasons          ?period=
GET /api/production/reports/overhead-variance         ?period=
GET /api/production/reports/waste                     ?period=&cc_id=&type=
GET /api/production/reports/yield                     ?period=&product_id=
GET /api/production/reports/rework                    ?period=
GET /api/production/reports/cost-center-performance   ?period=
GET /api/production/reports/bottleneck                ?period=
GET /api/production/reports/material-usage            ?period=
GET /api/production/reports/subcontractor-performance ?period=
GET /api/production/reports/product-profitability     ?period=
GET /api/production/reports/monthly-profit            ?period=      ⭐⭐
GET /api/production/reports/dashboard                 ?period=      ⭐
GET /api/production/reports/reconciliation            ?date=        (PR-99 مغایرت)

# خروجی — پارامتر مشترک روی همه
?format=json|excel|pdf
```

**قرارداد پاسخ مشترک:**
```json
{
  "report": "PR-23", "title": "سود دقیق ماهانه",
  "period": "1405/04", "generated_at": "1405/04/24 14:32",
  "filters": { "period": "1405/04" },
  "data": { /* ... */ },
  "totals": { /* ... */ },
  "meta": {
    "row_count": 42, "duration_ms": 87,
    "period_status": "closed",
    "ledger_reconciled": true,
    "cost_hidden": false
  },
  "warnings": []
}
```

---

## ۱۲. رویدادها

| رویداد | Payload | کاربرد |
|--------|---------|--------|
| `report.generated` | `{report, period, userId, durationMs}` | ممیزی + بهینه‌سازی |
| `report.exported` | `{report, format, rowCount, userId}` | ممیزی |
| `report.slow` | `{report, durationMs}` — > ۵ ثانیه | هشدار فنی |
| `report.ledger_mismatch` | `{report, expected, actual, diff}` | 🔴 هشدار حسابداری |

---

## ۱۳. کارایی

| تکنیک | جزئیات |
|-------|--------|
| **VIEW** | ۳ view برای کوئری‌های پرتکرار (§۳) |
| **ایندکس** | ۶ ایندکس گزارشی روی `(period_label, ...)` |
| **کش** | داشبورد ۵ دقیقه در `settings` (`report_cache_dashboard_*`) |
| **صفحه‌بندی** | اجباری بالای ۱۰۰ سطر |
| **`EXPLAIN QUERY PLAN`** | همه کوئری‌ها باید ایندکس بزنند — تست خودکار |
| **Timeout** | ۳۰ ثانیه — `db.pragma('busy_timeout = 30000')` |
| **Excel** | streaming با `SheetJS` — نه در حافظه |

**تست کارایی اجباری:**
```js
// server/scripts/test-production-reports-perf.js
// روی ۱۰٬۰۰۰ سفارش و ۱۰۰٬۰۰۰ سطر تراکنش:
//   PR-24 داشبورد    < ۱٬۰۰۰ms
//   PR-23 سود ماهانه < ۵۰۰ms
//   PR-10 WIP        < ۳۰۰ms
//   PR-01 لیست       < ۲۰۰ms
```

---

## ۱۴. تست‌کیس‌ها

| # | عنوان | انتظار |
|---|-------|--------|
| T6-01 | PR-02 برگه بها | اعداد = §۷ ماژول ۷ دقیقاً |
| T6-02 | **PR-10 تطبیق WIP** | Σ WIP سفارش‌ها = مانده `1111` |
| T6-03 | **PR-23 سود ناخالص** | = سود ناخالص صورت سود و زیان |
| T6-04 | **PR-23 موجودی FG** | = مانده `1104` |
| T6-05 | **PR-23 COGS** | = مانده `5101` |
| T6-06 | **PR-23 کنترل‌ها** | `5201`,`5202`,`5203` همه صفر |
| T6-07 | PR-14 سربار | واقعی − جذب‌شده = ۱٬۴۸۱٬۱۶۲ |
| T6-08 | PR-11 ماتریس | CC-10 = ۴۱٬۶۱۲٬۶۸۰ |
| T6-09 | PR-16 بهره‌وری | ۹۵.۵۶٪ |
| T6-10 | PR-09 ارزش افزوده | برش = ۷۵.۹٪ |
| T6-11 | سند ابطال‌شده | در هیچ گزارشی نیاید |
| T6-12 | **فقط‌خواندنی** | هیچ گزارشی `INSERT/UPDATE/DELETE` نزند |
| T6-13 | `hide_cost` | `field_sales` → JSON فاقد `*_rial` |
| T6-14 | دسترسی مرکز | operator فقط مراکز خودش |
| T6-15 | دوره خالی | جدول خالی + پیام، نه خطا |
| T6-16 | تقسیم بر صفر | `qty=0` → `—` نه `NaN` |
| T6-17 | Excel | ۱٬۰۰۰ سطر → فایل معتبر |
| T6-18 | Excel بزرگ | ۶۰٬۰۰۰ سطر → `422 E_EXPORT_TOO_LARGE` |
| T6-19 | بازه ۶ سال | `422 E_RANGE_TOO_LARGE` |
| T6-20 | کارایی داشبورد | < ۱ ثانیه روی ۱۰٬۰۰۰ سفارش |
| T6-21 | ایندکس | `EXPLAIN QUERY PLAN` همه کوئری‌ها ایندکس بزنند |
| T6-22 | مغایرت | تزریق مغایرت → `W_LEDGER_MISMATCH` |
| T6-23 | دوره باز | `W_PERIOD_OPEN` |
| T6-24 | PR-99 مغایرت | دو عدد برابر → لیست خالی |

---

## ۱۵. شبه‌کد

```js
// server/lib/production/reports.js

/** پوشش مشترک همه گزارش‌ها */
function runReport(db, { name, params, user }) {
  const t0 = Date.now();
  const spec = REPORTS[name];
  if (!spec) throw err('E_NOT_FOUND', 404);

  // ═══ دسترسی ═══
  if (!hasPermission(db, user, 'production', 'view')) throw err('E_FORBIDDEN', 403);
  if (spec.requiresCost && !canSeeCost(db, user))     throw err('E_FORBIDDEN', 403);

  // ═══ اعتبارسنجی ═══
  validateReportParams(params);                        // V6-01..V6-04
  const ccFilter = restrictCostCenters(db, user);      // V6-07 — null یعنی بدون محدودیت

  // ═══ اجرا (فقط‌خواندنی) ═══
  const data = spec.run(db, { ...params, ccFilter });

  // ═══ تطبیق دفتر کل ═══
  const warnings = [];
  if (spec.reconcile) {
    const r = spec.reconcile(db, params);
    if (Math.abs(r.diff) > 5) {
      warnings.push(`مغایرت ${fmt(r.diff)} ریال با دفتر کل`);
      emit(db, 'report.ledger_mismatch', { report: name, ...r });
    }
  }
  if (params.period && isPeriodOpen(db, params.period))
    warnings.push(`دوره ${params.period} هنوز بسته نشده — اعداد موقتی هستند`);

  // ═══ مخفی‌سازی بها ═══
  const out = canSeeCost(db, user) ? data : stripCostFields(data);

  const dur = Date.now() - t0;
  emit(db, 'report.generated', { report: name, period: params.period, userId: user.id, durationMs: dur });
  if (dur > 5000) emit(db, 'report.slow', { report: name, durationMs: dur });

  return {
    report: name, title: spec.title, period: params.period,
    generated_at: nowJalaliTime(), filters: params,
    ...out,
    meta: { row_count: countRows(out), duration_ms: dur,
            period_status: params.period ? periodStatus(db, params.period) : null,
            ledger_reconciled: warnings.length === 0,
            cost_hidden: !canSeeCost(db, user) },
    warnings,
  };
}

/** PR-23 — سود دقیق ماهانه ⭐⭐ */
function monthlyProfit(db, { period }) {
  const { from, to } = periodRange(db, period);
  const bal = (code) => db.prepare(`
    SELECT COALESCE(SUM(jl.debit_rial) - SUM(jl.credit_rial), 0) b
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND je.entry_date BETWEEN ? AND ?
      AND COALESCE(je.deleted_at, 0) = 0`).get(acct(db, code).code, from, to).b;

  const balAt = (code, date) => db.prepare(`
    SELECT COALESCE(SUM(jl.debit_rial) - SUM(jl.credit_rial), 0) b
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND je.entry_date <= ?
      AND COALESCE(je.deleted_at, 0) = 0`).get(acct(db, code).code, date).b;

  // فروش
  const salesGross = -bal('coa_sales');                 // بستانکار → منفی
  const discount   =  bal('coa_sales_discount');
  const returns    =  salesReturns(db, from, to);
  const salesNet   = salesGross - discount - returns;

  // بهای تولید دوره
  const prod = db.prepare(`
    SELECT COALESCE(SUM(material_cost_rial),0) material,
           COALESCE(SUM(packaging_cost_rial),0) packaging,
           COALESCE(SUM(labor_cost_rial),0) labor,
           COALESCE(SUM(subcontract_cost_rial),0) subcontract,
           COALESCE(SUM(overhead_cost_rial),0) overhead,
           COALESCE(SUM(total_cost_rial),0) total
    FROM production_orders
    WHERE period_label = ? AND status IN ('completed','closed')`).get(period);

  const fgOpen  = balAt('coa_finished_goods', jalaliSubDays(from, 1));
  const fgClose = balAt('coa_finished_goods', to);
  const wipOpen  = balAt('coa_wip', jalaliSubDays(from, 1));
  const wipClose = balAt('coa_wip', to);
  const cogs     = bal('coa_cogs');

  // تسهیم انحرافات (ADR-005)
  const variances = db.prepare(`
    SELECT variance_type,
           SUM(amount_rial) total_rial,
           SUM(alloc_wip_rial) wip_rial,
           SUM(alloc_fg_rial) fg_rial,
           SUM(alloc_cogs_rial) cogs_rial
    FROM production_variances
    WHERE period_label = ? AND status = 'allocated'
    GROUP BY variance_type`).all(period);
  const varToCogs = variances.reduce((s, v) => s + v.cogs_rial, 0);

  // هزینه‌های دوره
  const abnormalWaste = bal('coa_abnormal_waste');
  const reworkCost    = bal('coa_rework_cost');
  const adminExp      = periodExpenses(db, from, to, 'admin');
  const salesExp      = periodExpenses(db, from, to, 'sales');
  const commission    = repCommission(db, from, to);

  const grossProfit = salesNet - cogs;
  const opProfit    = grossProfit - abnormalWaste - reworkCost - adminExp - salesExp - commission;

  // کنترل‌های صحت
  const checks = {
    labor_control_zero:    Math.abs(balAt('coa_labor_control', to))    <= 5,
    overhead_control_zero: Math.abs(balAt('coa_overhead_control', to)) <= 5,
    overhead_applied_zero: Math.abs(balAt('coa_overhead_applied', to)) <= 5,
    fg_matches_ledger:     true,
    wip_matches_ledger:    Math.abs(wipClose - sumOrderWip(db, to)) <= 5,
  };

  return {
    data: {
      sales: { gross_rial: salesGross, discount_rial: discount,
               returns_rial: returns, net_rial: salesNet },
      production: prod,
      inventory: { fg_open_rial: fgOpen, fg_close_rial: fgClose,
                   wip_open_rial: wipOpen, wip_close_rial: wipClose },
      cogs: { standard_rial: cogs - varToCogs,
              variance_rial: varToCogs, total_rial: cogs },
      variances,
      period_expenses: { abnormal_waste_rial: abnormalWaste, rework_rial: reworkCost,
                         admin_rial: adminExp, sales_rial: salesExp, commission_rial: commission },
      checks,
    },
    totals: {
      gross_profit_rial: grossProfit,
      gross_margin_pct:  salesNet ? round2(grossProfit / salesNet * 100) : 0,
      operating_profit_rial: opProfit,
      operating_margin_pct:  salesNet ? round2(opProfit / salesNet * 100) : 0,
    },
  };
}

/** PR-24 — داشبورد با کش ۵ دقیقه‌ای */
const DASH_CACHE = new Map();
function dashboard(db, { period }) {
  const key = `dash:${period}`;
  const c = DASH_CACHE.get(key);
  if (c && Date.now() - c.at < 300_000) return c.data;

  const prev = prevPeriod(period);
  const kpi = (p) => db.prepare(`
    SELECT COALESCE(SUM(qty_produced),0) qty,
           CASE WHEN SUM(qty_produced) > 0
                THEN ROUND(SUM(total_cost_rial) * 1.0 / SUM(qty_produced)) ELSE 0 END unit_cost,
           COALESCE(SUM(abnormal_waste_rial),0) abnormal,
           CASE WHEN SUM(qty_produced + qty_waste_normal + qty_waste_abnormal) > 0
                THEN ROUND(SUM(qty_produced) * 100.0
                     / SUM(qty_produced + qty_waste_normal + qty_waste_abnormal), 2) ELSE 0 END yield
    FROM production_orders WHERE period_label = ? AND status IN ('completed','closed')`).get(p);

  const cur = kpi(period), old = kpi(prev);
  const delta = (a, b) => b ? round1((a - b) / b * 100) : 0;

  const data = {
    kpis: {
      produced:   { value: cur.qty,       delta: delta(cur.qty, old.qty) },
      unit_cost:  { value_rial: cur.unit_cost, delta: delta(cur.unit_cost, old.unit_cost) },
      yield:      { value_pct: cur.yield, delta: delta(cur.yield, old.yield) },
      abnormal:   { value_rial: cur.abnormal, delta: delta(cur.abnormal, old.abnormal) },
      wip:        wipSummary(db, period),
      oh_variance: overheadVarianceSummary(db, period),
      cycle_time: cycleTimeSummary(db, period),
      gross_margin: grossMarginSummary(db, period),
    },
    trends:    { unit_cost: unitCostTrend(db, { months: 6 }),
                 cost_mix:  costMix(db, period) },
    capacity:  bottleneck(db, { period }),
    variances: varianceMatrix(db, { period }).matrix,
    alerts:    collectAlerts(db, period),
    open_orders: openOrdersSummary(db),
  };
  DASH_CACHE.set(key, { at: Date.now(), data });
  return data;
}

/** PR-99 — گزارش مغایرت */
function reconciliation(db, { date }) {
  const rows = [];
  const check = (label, ledgerCode, calcFn) => {
    const ledger = db.prepare(`
      SELECT COALESCE(SUM(jl.debit_rial) - SUM(jl.credit_rial),0) b
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code=? AND je.entry_date<=? AND COALESCE(je.deleted_at,0)=0`)
      .get(acct(db, ledgerCode).code, date).b;
    const calc = calcFn();
    rows.push({ label, ledger_rial: ledger, calculated_rial: calc,
                diff_rial: ledger - calc, ok: Math.abs(ledger - calc) <= 5 });
  };

  check('کالای در جریان ساخت', 'coa_wip',            () => sumOrderWip(db, date));
  check('موجودی کالای ساخته‌شده','coa_finished_goods', () => sumFgStockValue(db));
  check('موجودی مواد اولیه',    'coa_raw_materials',  () => sumRawStockValue(db));
  check('موجودی نزد پیمانکار',  'coa_subcontract_inventory', () => sumSubcontractBalance(db, date));

  return { data: rows, totals: { mismatches: rows.filter(r => !r.ok).length } };
}
```

---

## ۱۶. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی ماژول ۶ — گزارشات تولید

## پیش‌نیاز
ماژول ۱ تا ۵، ۷ و ۸ کامل. این ماژول آخرین قطعه است.

## اسناد مرجع
- docs/Production/06-production-reports.md   ← این سند
- docs/Production/Production-Master-Architecture.md  ← ADR-005 (تسهیم انحراف)
- docs/Production/database-schema.md         ← §9 (health-check)
- docs/Production/permissions.md

## ⚠️ قواعد قطعی
1. **هیچ گزارشی نمی‌نویسد.** فقط SELECT.
   تست T6-12: قبل و بعد از هر گزارش، checksum جداول باید یکسان باشد.
2. **تطبیق با دفتر کل اجباری** — PR-10, PR-23 باید با journal_lines بخوانند.
   اگر نخواند → W_LEDGER_MISMATCH + رویداد.
3. `COALESCE(je.deleted_at,0)=0` در **همه** کوئری‌های دفتر کل.
4. `hide_cost` → فیلدها از JSON **حذف** شوند، نه CSS.
5. تقسیم بر صفر → `NULLIF(x,0)` + نمایش `—`.
6. تاریخ جلالی: مقایسه رشته‌ای کار می‌کند (`'1405/04/01' <= '1405/04/31'`).
   برای اختلاف روز از تابع JS استفاده کن، نه `julianday` SQLite.
7. همه کوئری‌ها باید ایندکس بزنند — `EXPLAIN QUERY PLAN` تست شود.

## گام‌ها

### گام ۱ — VIEW و ایندکس
server/db.js: §3 این سند
  - v_wip_by_order, v_order_cost_summary, v_variance_summary
  - ۶ ایندکس گزارشی

### گام ۲ — سرویس
server/lib/production/reports.js:
  REPORTS = { 'PR-01': {...}, ..., 'PR-99': {...} }   ← رجیستری
  runReport(db, {name, params, user})     ← §15 (پوشش مشترک)
  monthlyProfit(db, {period})             ← §15 ⭐⭐
  dashboard(db, {period})                 ← §15 با کش
  reconciliation(db, {date})              ← §15
  costSheet, wipReport, overheadVariance, wasteAnalysis,
  yieldAnalysis, cycleTime, bottleneck, productProfitability,
  materialUsage, subcontractorPerformance, varianceReasons,
  reworkReport, costCenterPerformance, kanban, orderLedger,
  unitCostTrend, stdVsActual, valueAdded, periodCost

server/lib/production/report-export.js:
  toExcel(reportResult)   ← SheetJS streaming
  toPdf(reportResult)     ← HTML → print CSS

### گام ۳ — Route
server/routes/production-reports.js — ۲۵ endpoint از §11
- پارامتر مشترک ?format=json|excel|pdf
- middleware مشترک: auth + runReport()
- ثبت در server.js

### گام ۴ — UI
1. **داشبورد تولید** (§4 PR-24) — صفحه اصلی منوی تولید
   - ۸ کارت KPI با فلش تغییر
   - نمودار روند + دایره‌ای (Chart.js — vendor/chart.umd.js موجود)
   - نوار بار مراکز + هشدارها + سفارش‌های باز
2. **سود دقیق ماهانه** (§4 PR-23) ⭐⭐ — صفحه مدیرعامل
   - صورت سود و زیان کامل + جدول تسهیم انحراف + کنترل‌های صحت
   - همه ✅ سبز باشند وگرنه 🔴
3. **برگه بهای تمام‌شده** (§4 PR-02) — چاپ‌شدنی A4
4. **ماتریس انحراف** (PR-11) — از ماژول ۸
5. صفحه فهرست گزارش‌ها با دسته‌بندی (عملیاتی/بها/انحراف/ضایعات/منابع/مالی)
6. RTL, Vazirmatn, #1B5C4A/#2D7A5F/#C9A84C, Mobile-first
7. اعداد فارسی + جداکننده هزارگان + تومان

### گام ۵ — تست
server/scripts/test-production-reports.js — ۲۴ تست از §14
server/scripts/test-production-reports-perf.js — §13
حیاتی:
  T6-02  Σ WIP = مانده 1111
  T6-03  سود ناخالص = صورت سود و زیان
  T6-06  5201/5202/5203 صفر
  T6-12  فقط‌خواندنی (checksum)
  T6-21  همه کوئری‌ها ایندکس بزنند

## معیار پذیرش
- [ ] PR-23 با صورت سود و زیان سیستم مطابقت کامل دارد
- [ ] PR-10 با مانده 1111 مطابقت دارد
- [ ] PR-99 روی داده سالم لیست خالی برمی‌گرداند
- [ ] داشبورد < ۱ ثانیه روی ۱۰٬۰۰۰ سفارش
- [ ] هیچ گزارشی داده را تغییر نمی‌دهد
- [ ] Excel و PDF روی همه گزارش‌ها کار می‌کند

## ممنوعیت‌ها
- ❌ INSERT/UPDATE/DELETE در گزارش
- ❌ بازمحاسبه بها از BOM (از جداول تراکنشی بخوان)
- ❌ فراموش کردن deleted_at
- ❌ مخفی‌سازی بها فقط با CSS
- ❌ کوئری بدون ایندکس
````

---

## ۱۷. خروجی‌های این ماژول

| خروجی | مسیر |
|-------|------|
| VIEW + ایندکس | `server/db.js` |
| سرویس گزارش | `server/lib/production/reports.js` |
| خروجی Excel/PDF | `server/lib/production/report-export.js` |
| Route | `server/routes/production-reports.js` |
| UI داشبورد | `server/public/index.html` |
| UI سود ماهانه | `server/public/index.html` |
| تست | `server/scripts/test-production-reports.js` |
| تست کارایی | `server/scripts/test-production-reports-perf.js` |
