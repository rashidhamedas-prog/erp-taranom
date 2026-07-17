# api.md
## مرجع کامل API — ماژول عملیات تولید

> **پایه:** `/api/production` · **احراز هویت:** `Authorization: Bearer <JWT>` (middleware `auth`)
> **قالب تاریخ:** جلالی `YYYY/MM/DD` · **پول:** ریال (`*_rial`) + `*_toman` در خروجی

---

## ۰. قراردادهای عمومی

### ۰.۱ پاسخ موفق
```json
{ "ok": true, "...": "..." }
```

### ۰.۲ پاسخ خطا
```json
{
  "error": "E_NEGATIVE_STOCK",
  "message": "موجودی «پارچه کتان سبز» در انبار «مواد اولیه» منفی می‌شود (موجود: ۴۷۰، نیاز: ۵۲۳.۳۳)",
  "details": { "product_id": 201, "available": 470, "required": 523.3333 }
}
```

### ۰.۳ کدهای HTTP
| کد | معنی |
|----|------|
| `200` | موفق |
| `201` | ایجاد شد |
| `400` | درخواست نامعتبر |
| `401` | احراز هویت نشده |
| `403` | مجوز ندارد |
| `404` | یافت نشد |
| `409` | تعارض وضعیت (قفل، تکراری، همزمانی) |
| `422` | اعتبارسنجی ناموفق |
| `500` | خطای سرور |
| `504` | Timeout گزارش |

### ۰.۴ بی‌قدرتی (Idempotency)
همه `POST` های **اجرایی** (ثبت سند) هدر `Idempotency-Key` می‌پذیرند:
```
Idempotency-Key: 8f3c2a1e-...
```
- کلید در `production_idempotency` ذخیره می‌شود
- درخواست دوم با همان کلید → **همان پاسخ اول** بدون ثبت مجدد
- عمر کلید: ۲۴ ساعت

**endpoint های الزامی:**
`/orders/:id/receipt` · `/orders/:id/issue` · `/orders/:id/stages/:sid/output` · `/orders/:id/stages/:sid/issue` · `/subcontract/send` · `/subcontract/receive` · `/close/:period/execute`

### ۰.۵ صفحه‌بندی
```
?page=1&limit=50        (پیش‌فرض limit=50 · حداکثر 500)
```
```json
{ "data": [...], "pagination": { "page":1, "limit":50, "total":328, "pages":7 } }
```

### ۰.۶ مرتب‌سازی و فیلتر
```
?sort=date&order=desc&q=جستجو&status=released&from=1405/04/01&to=1405/04/31
```

### ۰.۷ همزمانی (Optimistic Lock)
```
If-Unmodified-Since: <production_orders.updated_at>
```
اگر `updated_at` تغییر کرده → `409 E_CONCURRENT`

### ۰.۸ مخفی‌سازی بها
اگر کاربر `hide_cost` دارد (نقش `field_sales` یا مجوز سفارشی):
> **فیلدهای `*_rial`, `*_toman`, `unit_cost*`, `var_*` از JSON حذف می‌شوند — نه فقط مخفی در UI.**

---

## ۱. فرمول تولید (BOM) — ماژول ۱ و ۴

### ۱.۱ عملیات پایه

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/boms` | فهرست + فیلتر `product_id, status, bom_type, q, page` | `view` |
| `POST` | `/boms` | ایجاد پیش‌نویس | `create` |
| `GET` | `/boms/:id` | جزئیات + خطوط + مراحل + خروجی‌ها | `view` |
| `PUT` | `/boms/:id` | ویرایش سرفصل (فقط `draft`) | `edit` |
| `DELETE` | `/boms/:id` | حذف (فقط `draft`) | `delete` |

**`POST /boms`**
```json
{
  "product_id": 101, "name": "مانتو کتان ترمه — سبز", "base_qty": 1,
  "unit_id": 1, "bom_type": "standard", "yield_percent": 97,
  "size_range": "38-48", "color_variant": "سبز", "note": ""
}
```
→ `201 { "id": 5, "code": "BOM-000105", "version": 1, "revision": "A", "status": "draft" }`

### ۱.۲ خطوط فرمول

| متد | مسیر | شرح |
|-----|------|-----|
| `POST` | `/boms/:id/lines` | افزودن قلم |
| `PUT` | `/boms/:id/lines/:lineId` | ویرایش |
| `DELETE` | `/boms/:id/lines/:lineId` | حذف |
| `POST` | `/boms/:id/lines/bulk` | ورود گروهی (Excel paste) |

**`POST /boms/:id/lines`**
```json
{
  "component_product_id": 201, "qty_per_base": 1.60, "unit_id": 2,
  "scrap_percent": 4, "line_type": "material",
  "stage_cost_center_id": 1, "backflush": 1,
  "substitute_group": "", "substitute_priority": 0,
  "size_matrix": "{\"38\":1.45,\"40\":1.50,\"42\":1.55,\"44\":1.60,\"46\":1.70,\"48\":1.80}",
  "std_cost_rial": 900000
}
```

### ۱.۳ چرخه حیات

| متد | مسیر | Body | شرح |
|-----|------|------|-----|
| `POST` | `/boms/:id/activate` | `{ valid_from }` | فعال‌سازی + بایگانی نسخه قبل |
| `POST` | `/boms/:id/deactivate` | — | `active` → `draft` (فقط بدون سفارش) |
| `POST` | `/boms/:id/archive` | `{ reason }` | بایگانی |
| `POST` | `/boms/:id/restore` | `{ reason }` | بازیابی (admin) |
| `POST` | `/boms/:id/version-up` | `{ reason }` | نسخه جدید `draft` |
| `POST` | `/boms/:id/clone` | `{ product_id, name }` | کپی برای محصول دیگر |
| `POST` | `/boms/:id/create-alternative` | `{ reason }` | فرمول جایگزین |

**`POST /boms/:id/activate`** → `200 { "ok":true, "bomId":5, "archivedPrev":3 }`

### ۱.۴ محاسبات

| متد | مسیر | پارامتر | شرح |
|-----|------|---------|-----|
| `GET` | `/boms/:id/explode` | `qty, size_breakdown, price_basis` | نیاز مواد |
| `GET` | `/boms/:id/tree` | — | درخت چندسطحی |
| `GET` | `/boms/:id/cost-tree` | `qty` | درخت با بها |
| `GET` | `/boms/:id/std-cost` | `price_basis` | بهای استاندارد مواد |
| `GET` | `/boms/:id/full-cost` | `qty, price_basis, period` | **بهای کامل (ماژول ۴)** |
| `GET` | `/boms/:id/roll-up` | `qty` | جدول مرحله‌ای |
| `GET` | `/boms/:id/backward-qty` | `target` | تعداد شروع |
| `GET` | `/boms/:id/yield-analysis` | — | تحلیل بازده |
| `GET` | `/boms/:id/capacity-load` | `qty` | بار مراکز |
| `GET` | `/boms/:id/sensitivity` | `param, range` | تحلیل حساسیت |
| `GET` | `/boms/:id/breakeven` | `price` | نقطه سربه‌سر |
| `GET` | `/boms/:id/history` | — | `bom_change_log` |
| `GET` | `/boms/compare` | `a, b` | Diff دو نسخه |
| `GET` | `/boms/compare-scenarios` | `a, b` | مقایسه بها |
| `GET` | `/boms/where-used/:productId` | — | این ماده کجاست؟ |
| `GET` | `/boms/unused` | — | فرمول‌های بلااستفاده |
| `GET` | `/boms/missing` | — | کالاهای بدون فرمول |
| `GET` | `/boms/resolve` | `product_id, date` | حل نسخه تاریخی |
| `POST` | `/boms/validate` | body BOM | اعتبارسنجی بدون ذخیره |

**نمونه پاسخ `GET /boms/:id/full-cost?qty=300`** → §۱۵ در `04-advanced-formulas.md`

### ۱.۵ مسیر عملیات (Routing)

| متد | مسیر | شرح |
|-----|------|-----|
| `GET` | `/boms/:id/operations` | فهرست مراحل |
| `POST` | `/boms/:id/operations` | افزودن مرحله |
| `PUT` | `/boms/:id/operations/:opId` | ویرایش |
| `DELETE` | `/boms/:id/operations/:opId` | حذف |
| `POST` | `/boms/:id/operations/resequence` | بازشماری ۱۰،۲۰،۳۰... |
| `POST` | `/boms/:id/operations/from-template` | `{ template: 'taranom_7_stage' }` |

**`POST /boms/:id/operations`**
```json
{
  "seq": 30, "cost_center_id": 3, "operation_name": "دوخت",
  "setup_minutes": 20, "run_minutes_per_unit": 11.0,
  "machine_minutes_per_unit": 11.0, "labor_method": "piece",
  "labor_rate_rial": 180000, "crew_size": 1,
  "overhead_driver": "", "yield_percent": 100, "normal_waste_percent": 1,
  "is_subcontract": 0, "is_qc_gate": 0
}
```

### ۱.۶ خروجی‌ها

| متد | مسیر | شرح |
|-----|------|-----|
| `GET` | `/boms/:id/outputs` | فهرست |
| `POST` | `/boms/:id/outputs` | افزودن |
| `PUT` | `/boms/:id/outputs/:outId` | ویرایش |
| `DELETE` | `/boms/:id/outputs/:outId` | حذف |
| `POST` | `/boms/:id/outputs/auto-share` | `{ method: 'sales_value'\|'physical' }` |

---

## ۲. مراکز هزینه و نرخ سربار

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/cost-centers` | فهرست | `view` |
| `PUT` | `/cost-centers/:id` | ویرایش `driver`, `capacity_per_day`, ... | `edit` |
| `GET` | `/cost-center-rates` | `?period=1405/04` | `view` |
| `POST` | `/cost-center-rates` | ایجاد نرخ | `create` |
| `PUT` | `/cost-center-rates/:id` | ویرایش | `edit` |
| `POST` | `/cost-center-rates/bootstrap` | `{ period, months: 3 }` | `create` |

**`POST /cost-center-rates`**
```json
{
  "cost_center_id": 3, "period_label": "1405/04", "period_type": "month",
  "driver": "direct_labor_rial",
  "budget_fixed_oh_rial": 12000000, "budget_var_oh_rial": 8000000,
  "budget_driver_qty": 57.14,
  "monthly_labor_rate_rial": 0
}
```
→ سیستم خودکار محاسبه می‌کند:
```json
{
  "id": 12, "fixed_rate_rial": 210000, "var_rate_rial": 140000,
  "total_rate_rial": 350000, "is_estimated": 0, "status": "active"
}
```

**`POST /cost-center-rates/bootstrap`**
```json
{ "period": "1405/04", "months": 3 }
```
→
```json
{
  "ok": true, "created": 6,
  "rates": [
    { "cost_center": "CC-10 برش", "driver": "material_rial",
      "pool_rial": 15600000, "driver_qty": 1733.3,
      "total_rate_rial": 9000, "is_estimated": true }
  ],
  "warning": "نرخ‌ها برآوردی هستند — بودجه واقعی تعریف کنید"
}
```

---

## ۳. سفارش تولید — ماژول ۲، ۳، ۷، ۸

### ۳.۱ عملیات پایه

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/orders` | فهرست | `view` |
| `POST` | `/orders` | ایجاد `draft` | `create` |
| `GET` | `/orders/:id` | جزئیات کامل | `view` |
| `PUT` | `/orders/:id` | ویرایش (فقط `draft`) | `edit` |
| `DELETE` | `/orders/:id` | حذف (فقط `draft`) | `delete` |

**`POST /orders`**
```json
{
  "product_id": 101, "bom_id": null,
  "qty_planned": 300,
  "analysis_type": "fixed_adv",
  "production_mode": "MTO",
  "sales_order_id": 45, "customer_id": 12,
  "size_breakdown": "{\"38\":30,\"40\":60,\"42\":80,\"44\":70,\"46\":40,\"48\":20}",
  "color": "سبز",
  "warehouse_raw_id": 1, "warehouse_fg_id": 2,
  "cost_center_id": 3,
  "date": "1405/04/15",
  "planned_start": "1405/04/15", "planned_end": "1405/04/22",
  "priority": 5, "estimate_id": 8, "note": ""
}
```
→
```json
{
  "id": 10, "order_no": "PO-1405-0010", "status": "draft",
  "bom": { "id":2, "code":"BOM-000101", "version":2, "has_routing":true },
  "qty_planned": 300, "qty_planned_start": 314,
  "total_yield_percent": 95.5647,
  "standard": {
    "material_rial": 542765069, "labor_rial": 89204167,
    "overhead_rial": 50068838, "total_rial": 694933300, "unit_rial": 2315880
  },
  "shortage": []
}
```

### ۳.۲ چرخه حیات

| متد | مسیر | Body | شرح |
|-----|------|------|-----|
| `POST` | `/orders/:id/release` | — | ماژول ۲/۳ — رزرو |
| `POST` | `/orders/:id/release-advanced` | — | ماژول ۷/۸ — Snapshot مراحل |
| `POST` | `/orders/:id/cancel` | `{ reason }` | لغو + Reversal |
| `POST` | `/orders/:id/close` | — | بستن (WIP=۰) |
| `POST` | `/orders/:id/reopen` | `{ reason }` | بازکردن (admin) |

**`POST /orders/:id/release-advanced`**
```json
{
  "ok": true, "order_no": "PO-1405-0010", "status": "released",
  "qty_planned_start": 314, "total_yield_percent": 95.5647,
  "coa_wip_tafsili": "110403000042",
  "stages": [
    { "id":52, "seq":10, "cost_center":"CC-10 برش", "status":"in_progress",
      "qty_in":314, "driver":"material_rial" },
    { "id":53, "seq":20, "cost_center":"CC-20 گلدوزی", "status":"pending", "qty_in":0 },
    { "id":54, "seq":30, "cost_center":"CC-30 دوخت", "status":"pending", "qty_in":0 },
    { "id":55, "seq":40, "cost_center":"CC-40 یراق", "status":"pending", "qty_in":0 },
    { "id":56, "seq":50, "cost_center":"CC-50 شستشو", "status":"pending",
      "qty_in":0, "is_subcontract":true, "supplier":"خشکشویی صنعتی رضوان" },
    { "id":57, "seq":60, "cost_center":"CC-60 اتو", "status":"pending",
      "qty_in":0, "is_qc_gate":true }
  ],
  "reservations": [
    { "product_id":201, "qty":523.3333, "warehouse_id":1 },
    { "product_id":202, "qty":113.2990, "warehouse_id":1 }
  ],
  "warnings": []
}
```

### ۳.۳ اجرا — ماژول ۲ (آنالیز ثابت)

**`POST /orders/:id/receipt`** ★
```json
{
  "qty_produced": 294, "waste_normal": 4, "waste_abnormal": 2,
  "waste_abnormal_reason": "fabric_defect",
  "scrap": [ { "product_id": 299, "qty": 27, "nrv_unit_rial": 120000 } ],
  "date": "1405/04/12", "warehouse_fg_id": 2,
  "is_partial": false, "auto_labor": true, "note": "بچ اول"
}
```
→ پاسخ کامل در §۱۷ از `02-fixed-analysis.md`

**`GET /orders/:id/preview`** — همان body به‌صورت query → محاسبه بدون ثبت (dry-run)

### ۳.۴ اجرا — ماژول ۳ (آنالیز متغیر)

| متد | مسیر | شرح |
|-----|------|-----|
| `GET` | `/orders/:id/issue-template` | `?qty_started=300` — پیش‌پر از BOM |
| `POST` | `/orders/:id/issue` | ★ ثبت حواله |
| `GET` | `/orders/:id/issues` | فهرست حواله‌ها |
| `POST` | `/orders/:id/return` | برگشت مواد |
| `POST` | `/orders/:id/receipt` | رسید (بدون Backflush) |

**`POST /orders/:id/issue`**
```json
{
  "date": "1405/04/11", "warehouse_id": 1,
  "lines": [
    { "product_id":201, "qty_actual":530, "reason":"عرض طاقه ۱۳۵ به‌جای ۱۴۰" },
    { "product_id":202, "qty_actual":105 },
    { "product_id":203, "qty_actual":26 },
    { "product_id":204, "qty_actual":1900 },
    { "product_id":205, "qty_actual":300 },
    { "product_id":206, "qty_actual":300 }
  ]
}
```
→ پاسخ کامل در §۱۵ از `03-variable-analysis.md`

### ۳.۵ اجرا — ماژول ۷ و ۸ (چندمرحله‌ای)

| متد | مسیر | شرح |
|-----|------|-----|
| `GET` | `/orders/:id/stages` | فهرست مراحل |
| `GET` | `/orders/:id/stages/:sid` | جزئیات مرحله |
| `POST` | `/orders/:id/stages/:sid/start` | شروع دستی |
| `GET` | `/orders/:id/stages/:sid/preview` | dry-run |
| `POST` | `/orders/:id/stages/:sid/output` | ★ ثبت خروجی |
| `POST` | `/orders/:id/stages/:sid/skip` | `{ reason }` |
| `POST` | `/orders/:id/stages/:sid/block` | `{ reason }` |
| `POST` | `/orders/:id/stages/:sid/unblock` | — |
| `POST` | `/orders/:id/stages/:sid/reverse` | `{ reason }` |
| `GET` | `/orders/:id/stages/:sid/issue-template` | ماژول ۸ |
| `POST` | `/orders/:id/stages/:sid/issue` | ★ ماژول ۸ |
| `GET` | `/orders/:id/stages/:sid/issues` | ماژول ۸ |
| `POST` | `/orders/:id/stages/:sid/return` | ماژول ۸ |
| `POST` | `/orders/:id/finalize` | ★ تسهیم + رسید |

**`POST /orders/:id/stages/:sid/output`**
```json
{
  "qty_out": 307.72, "waste_normal": 6.28, "waste_abnormal": 0,
  "waste_reason_code": "", "rework": 0,
  "scrap": [],
  "qc_passed": null, "qc_note": "",
  "date": "1405/04/15", "note": "برش ۳۱۴ عدد",
  "auto_finalize": true
}
```
→ پاسخ کامل در §۱۵ از `07-fixed-analysis-advanced.md`

### ۳.۶ پیمانکاری

| متد | مسیر | شرح |
|-----|------|-----|
| `POST` | `/orders/:id/subcontract/send` | ★ PRD-13 |
| `POST` | `/orders/:id/subcontract/receive` | ★ PRD-14 |
| `GET` | `/orders/:id/subcontract` | سابقه |

**`POST /orders/:id/subcontract/send`**
```json
{ "stage_id": 56, "qty": 304.64, "supplier_id": 7, "date": "1405/04/18", "note": "" }
```
→
```json
{
  "ok": true, "doc_no": "SC-1405-0011",
  "qty_sent": 304.64, "amount_rial": 672412885,
  "supplier": "خشکشویی صنعتی رضوان",
  "journal_entry": { "event":"PRD-13", "je_id":5120, "amount_rial":672412885 }
}
```

**`POST /orders/:id/subcontract/receive`**
```json
{
  "stage_id": 56, "qty_received": 300.07, "qty_waste": 4.57, "qty_lost": 0,
  "fee_unit_rial": 38000, "vat_rate": 10,
  "date": "1405/04/21", "purchase_invoice_id": null
}
```
→
```json
{
  "ok": true, "doc_no": "SC-1405-0012",
  "qty_sent": 304.64, "qty_returned": 304.64, "qty_lost": 0,
  "amount_returned_rial": 672412885,
  "fee_amount_rial": 11576426, "vat_rial": 1157643,
  "payable_rial": 12734069,
  "subcontract_balance_rial": 0,
  "journal_entries": [
    { "event":"PRD-14", "je_id":5121, "amount_rial":685146954 }
  ]
}
```

### ۳.۷ دوباره‌کاری

| متد | مسیر | شرح |
|-----|------|-----|
| `POST` | `/orders/:id/rework` | ثبت |
| `POST` | `/orders/:id/rework/:rwId/complete` | `{ qty_recovered, qty_failed }` |
| `GET` | `/orders/:id/rework` | فهرست |

**`POST /orders/:id/rework`**
```json
{
  "origin_stage_id": 57, "rework_stage_id": 57, "qty": 5,
  "classification": "normal",
  "material": [ { "product_id": 203, "qty": 0.5 } ],
  "labor_rial": 900000, "overhead_rial": 60000,
  "reason_code": "sewing_error", "date": "1405/04/22"
}
```

### ۳.۸ گزارش‌های سفارش

| متد | مسیر | شرح |
|-----|------|-----|
| `GET` | `/orders/:id/cost-sheet` | برگه بها |
| `GET` | `/orders/:id/stage-cost-sheet` | برگه مرحله‌ای |
| `GET` | `/orders/:id/value-added` | ارزش افزوده |
| `GET` | `/orders/:id/ledger` | همه اسناد |
| `GET` | `/orders/:id/variance` | انحراف استاندارد/واقعی |
| `GET` | `/orders/:id/variance-analysis` | تحلیل انحراف (۳/۸) |
| `GET` | `/orders/:id/shortage` | کسری مواد |
| `GET` | `/orders/:id/profitability` | سودآوری MTO |
| `GET` | `/orders/:id/flow` | نمودار جریان |

### ۳.۹ ابطال

**`POST /docs/:table/:id/reverse`**
```json
{ "reason": "تعداد اشتباه ثبت شده بود" }
```
`table` ∈ `production_material_issues`, `production_receipts`, `production_labor_entries`, `production_overhead_applications`, `production_waste`, `production_subcontract`, `production_rework`

---

## ۴. برآورد تولید — ماژول ۵

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/estimates` | فهرست | `view` |
| `POST` | `/estimates` | ایجاد + محاسبه | `create` |
| `POST` | `/estimates/quick` | ★ محاسبه بدون ذخیره | `view` |
| `GET` | `/estimates/:id` | جزئیات | `view` |
| `PUT` | `/estimates/:id` | ویرایش (`draft`) | `edit` |
| `DELETE` | `/estimates/:id` | حذف (`draft`) | `delete` |
| `POST` | `/estimates/:id/confirm` | تأیید | `approve` |
| `POST` | `/estimates/:id/unconfirm` | لغو تأیید | `approve` |
| `POST` | `/estimates/:id/recalculate` | بازمحاسبه با نرخ روز | `create` |
| `POST` | `/estimates/:id/convert` | تبدیل به سفارش | `approve` |
| `GET` | `/estimates/:id/sheet` | برگه چاپی | `view` |
| `GET` | `/estimates/:id/pricing` | `?discount=15&commission=4.5` | `view` |
| `GET` | `/estimates/:id/shortage` | کسری | `view` |
| `GET` | `/estimates/:id/target-cost` | `?price=280000` | `view` |
| `GET` | `/estimates/compare` | `?a=1&b=2` | `view` |

**`POST /estimates/quick`** ★
```json
{ "product_id": 101, "qty": 500, "price_basis": "max", "date": "1405/04/24" }
```
→ پاسخ کامل در §۱۶ از `05-production-estimation.md`

**`GET /estimates/:id/target-cost?price=2800000`**
```json
{
  "target_price_rial": 2800000,
  "margin_percent": 35,
  "required_unit_cost_rial": 2074074,
  "current_unit_cost_rial": 2315880,
  "gap_rial": 241806, "gap_percent": 11.66,
  "suggestions": [
    "کاهش ۱۰.۴٪ مصرف پارچه (۱.۶۰ → ۱.۴۳ متر)",
    "مذاکره نرخ پارچه: ۹۵۰٬۰۰۰ → ۸۲۰٬۰۰۰",
    "حذف مرحله گلدوزی (صرفه‌جویی ۱۰۵٬۰۰۰ ریال/عدد)"
  ]
}
```

---

## ۵. MRP — ماژول ۵

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/mrp` | فهرست اجراها | `view` |
| `POST` | `/mrp/run` | ★ اجرا | `create` |
| `GET` | `/mrp/:id` | نتیجه | `view` |
| `GET` | `/mrp/:id/requirements` | `?action=purchase\|produce` | `view` |
| `GET` | `/mrp/:id/purchase-suggestions` | پیشنهاد خرید | `view` |
| `POST` | `/mrp/:id/create-purchase-orders` | `{ requirement_ids: [] }` | `create` |
| `POST` | `/mrp/:id/create-production-orders` | `{ requirement_ids: [] }` | `create` |
| `GET` | `/mrp/:id/capacity` | بار ظرفیت | `view` |
| `GET` | `/mrp/:id/cash-requirement` | نیاز نقدینگی | `view` |
| `GET` | `/mrp/:id/late-items` | اقلام دیر | `view` |
| `DELETE` | `/mrp/:id` | حذف | `delete` |

**`POST /mrp/run`**
```json
{
  "horizon_days": 30, "demand_source": "mixed",
  "include_safety": true, "include_on_order": true
}
```
→
```json
{
  "run_id": 7, "code": "MRP-1405-0007",
  "shortage_count": 11, "shortage_rial": 1845000000,
  "late_count": 3, "duration_ms": 1247,
  "status": "done"
}
```

---

## ۶. بستن دوره

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/close` | فهرست دوره‌ها | `view` |
| `GET` | `/close/:period` | وضعیت دوره | `view` |
| `POST` | `/close/:period/open` | باز کردن دوره جدید | `approve` |
| `POST` | `/close/:period/precheck` | ★ چک‌لیست پیش از بستن | `approve` |
| `POST` | `/close/:period/calculate` | ★ محاسبه انحراف + پیش‌نمایش | `approve` |
| `POST` | `/close/:period/execute` | ★ اجرای بستن + اسناد | `approve` |
| `POST` | `/close/:period/reopen` | `{ reason }` — admin | `approve` |
| `GET` | `/close/:period/variances` | جزئیات انحراف | `view` |
| `GET` | `/close/:period/journal` | اسناد بستن | `view` |

**`POST /close/:period/precheck`**
```json
{
  "period": "1405/04", "can_close": false,
  "checks": [
    { "code": "OPEN_ORDERS", "status": "fail", "severity": "error",
      "message": "۲ سفارش completed هنوز بسته نشده",
      "items": [
        { "order_no":"PO-1405-0014", "wip_rial":32400000 },
        { "order_no":"PO-1405-0016", "wip_rial":23800000 }
      ] },
    { "code": "PAYROLL_POSTED", "status": "pass", "severity": "error",
      "message": "حقوق ۱۵ نفر ثبت شده ✅" },
    { "code": "OVERHEAD_POSTED", "status": "warn", "severity": "warning",
      "message": "آخرین هزینه سربار ۱۴۰۵/۰۴/۲۵ — ممکن است ناقص باشد" },
    { "code": "STOCKTAKING", "status": "warn", "severity": "warning",
      "message": "انبارگردانی این ماه انجام نشده" },
    { "code": "RATES_DEFINED", "status": "pass", "severity": "error",
      "message": "نرخ سربار ۶ مرکز تعریف شده ✅" },
    { "code": "FISCAL_YEAR_OPEN", "status": "pass", "severity": "error",
      "message": "سال مالی ۱۴۰۵ باز است ✅" }
  ]
}
```

**`POST /close/:period/calculate`**
```json
{
  "period": "1405/04",
  "labor": {
    "actual_rial": 265000000, "applied_rial": 264517300,
    "variance_rial": 482700, "favorable": false
  },
  "overhead": {
    "actual_rial": 51550000, "applied_rial": 50068838,
    "variance_rial": 1481162, "favorable": false,
    "by_cost_center": [
      { "cc":"CC-10 برش",   "actual_rial":5200000,  "applied_rial":4658044,  "variance_rial":541956 },
      { "cc":"CC-20 گلدوزی","actual_rial":17500000, "applied_rial":18463200, "variance_rial":-963200 },
      { "cc":"CC-30 دوخت",  "actual_rial":21200000, "applied_rial":19386360, "variance_rial":1813640 },
      { "cc":"CC-40 یراق",  "actual_rial":2400000,  "applied_rial":2437142,  "variance_rial":-37142 },
      { "cc":"CC-50 شستشو", "actual_rial":1550000,  "applied_rial":1523214,  "variance_rial":26786 },
      { "cc":"CC-60 اتو",   "actual_rial":3700000,  "applied_rial":3600878,  "variance_rial":99122 }
    ]
  },
  "total_variance_rial": 1963862,
  "materiality": {
    "production_cost_rial": 1984765900,
    "threshold_pct": 0.5, "threshold_rial": 9923830,
    "below_threshold": true,
    "method_auto": "direct_cogs"
  },
  "method": "proration",
  "allocation_base": {
    "wip_rial": 6332000, "wip_pct": 12.65,
    "fg_rial": 10404000, "fg_pct": 20.78,
    "cogs_rial": 33332838, "cogs_pct": 66.57,
    "total_rial": 50068838
  },
  "allocation": {
    "labor":    { "total_rial":482700,   "wip_rial":61045,  "fg_rial":100302, "cogs_rial":321353 },
    "overhead": { "total_rial":1481162,  "wip_rial":187316, "fg_rial":307776, "cogs_rial":986070 },
    "total":    { "total_rial":1963862,  "wip_rial":248361, "fg_rial":408078, "cogs_rial":1307423 }
  },
  "preview_entries": [
    { "event":"PRD-21", "description":"بستن انحراف دستمزد",
      "lines":[ {"code":"5212","debit_rial":482700}, {"code":"5201","credit_rial":482700} ] },
    { "event":"PRD-22", "description":"انتقال سربار جذب‌شده",
      "lines":[ {"code":"5203","debit_rial":50068838}, {"code":"5202","credit_rial":50068838} ] },
    { "event":"PRD-22", "description":"بستن انحراف سربار",
      "lines":[ {"code":"5215","debit_rial":1481162}, {"code":"5202","credit_rial":1481162} ] },
    { "event":"PRD-23", "description":"تسهیم انحراف",
      "lines":[ {"code":"1111","debit_rial":248361}, {"code":"1104","debit_rial":408078},
                {"code":"5101","debit_rial":1307423},
                {"code":"5212","credit_rial":482700}, {"code":"5215","credit_rial":1481162} ] }
  ],
  "fg_avg_updates": [
    { "product_id":101, "name":"مانتو کتان ترمه — سبز",
      "old_avg_rial":2233802, "delta_rial":319933, "new_avg_rial":2234732 }
  ]
}
```

**`POST /close/:period/execute`**
```json
{ "method": "proration", "confirm": true }
```
Header: `Idempotency-Key: <uuid>`
→
```json
{
  "ok": true, "period": "1405/04", "status": "closed",
  "closed_at": "1405/05/03 10:15", "closed_by": 1,
  "journal_entries": [
    { "event":"PRD-21", "je_id":6001, "voucher_no":"JV-1405-0812" },
    { "event":"PRD-22", "je_id":6002, "voucher_no":"JV-1405-0813" },
    { "event":"PRD-22", "je_id":6003, "voucher_no":"JV-1405-0814" },
    { "event":"PRD-23", "je_id":6004, "voucher_no":"JV-1405-0815" }
  ],
  "checks": {
    "labor_control_zero": true,
    "overhead_control_zero": true,
    "overhead_applied_zero": true,
    "variance_accounts_zero": true,
    "fg_matches_ledger": true,
    "wip_matches_ledger": true
  },
  "profit": {
    "sales_net_rial": 2463000000,
    "cogs_rial": 1322545642,
    "gross_profit_rial": 1140454358, "gross_margin_pct": 46.3,
    "operating_profit_rial": 798591358, "operating_margin_pct": 32.4
  }
}
```

---

## ۷. گزارشات — ماژول ۶

همه با پارامتر مشترک `?format=json|excel|pdf`

| متد | مسیر | پارامترها |
|-----|------|-----------|
| `GET` | `/reports/orders` | `status, from, to, product_id, page` |
| `GET` | `/reports/cost-sheet` | `order_id` |
| `GET` | `/reports/kanban` | — |
| `GET` | `/reports/cycle-time` | `period, product_id` |
| `GET` | `/reports/period-cost` | `period, compare=prev` |
| `GET` | `/reports/unit-cost-trend` | `product_id, months` |
| `GET` | `/reports/std-vs-actual` | `period, product_id` |
| `GET` | `/reports/wip` | `date` |
| `GET` | `/reports/variance-matrix` | `period` ⭐ |
| `GET` | `/reports/material-variance` | `period, product_id` |
| `GET` | `/reports/variance-reasons` | `period` |
| `GET` | `/reports/overhead-variance` | `period` |
| `GET` | `/reports/qty-variance-by-cc` | `period` |
| `GET` | `/reports/price-variance-by-supplier` | `period` |
| `GET` | `/reports/waste` | `period, cc_id, type` |
| `GET` | `/reports/yield` | `period, product_id` |
| `GET` | `/reports/rework` | `period` |
| `GET` | `/reports/cost-center-performance` | `period` |
| `GET` | `/reports/cc-scorecard` | `period` |
| `GET` | `/reports/bottleneck` | `period` |
| `GET` | `/reports/material-usage` | `period` |
| `GET` | `/reports/subcontractor-performance` | `period` |
| `GET` | `/reports/product-profitability` | `period` |
| `GET` | `/reports/analysis-compare` | `product_id` |
| `GET` | `/reports/monthly-profit` | `period` ⭐⭐ |
| `GET` | `/reports/dashboard` | `period` ⭐ |
| `GET` | `/reports/reconciliation` | `date` |
| `GET` | `/reports/estimate-accuracy` | `period` |
| `GET` | `/reports/estimate-conversion` | `period` |
| `GET` | `/reports/bom-revision-suggestions` | `stage` |

---

## ۸. تنظیمات

| متد | مسیر | شرح | مجوز |
|-----|------|-----|------|
| `GET` | `/config` | همه تنظیمات تولید | `view` |
| `PUT` | `/config` | ویرایش | `edit` (admin/accounting) |
| `GET` | `/health-check` | H1..H5 + C1..C7 | `view` |

**`GET /config`**
```json
{
  "production_costing_method": "moving_average",
  "production_variance_method": "proration",
  "production_variance_threshold_pct": "0.5",
  "production_variance_reason_threshold_pct": "5",
  "production_normal_waste_default_pct": "3",
  "production_auto_post_je": "1",
  "production_backflush_on_receipt": "1",
  "production_allow_negative_stock": "0",
  "production_wh_raw_id": "1",
  "production_wh_fg_id": "2",
  "production_wh_sub_id": "4",
  "production_wh_scrap_id": "5",
  "production_default_analysis": "fixed",
  "production_cost_deviation_alert_pct": "15",
  "production_labor_methods_enabled": "piece,monthly",
  "production_oh_bootstrap_months": "3",
  "production_mrp_horizon_days": "30",
  "production_period_auto_open": "1",
  "production_estimate_price_basis": "max",
  "production_coproduct_method": "manual",
  "production_rework_normal_threshold_pct": "2",
  "production_wip_per_stage": "0",
  "pricing_margin_percent": "35",
  "rep_commission_percent": "4.5"
}
```

**`GET /health-check`**
```json
{
  "ok": true, "checks": [
    { "code":"H1", "name":"WIP سفارش‌های بسته صفر است",     "status":"pass", "rows":0 },
    { "code":"H2", "name":"حساب‌های کنترلی صفر هستند",      "status":"pass", "rows":0 },
    { "code":"H3", "name":"تطابق products.stock با انبار",   "status":"pass", "rows":0 },
    { "code":"H4", "name":"همه تراکنش‌ها سند دارند",         "status":"pass", "rows":0 },
    { "code":"H5", "name":"میانگین موزون معتبر",             "status":"pass", "rows":0 },
    { "code":"C1", "name":"je_id همه تراکنش‌های posted",     "status":"pass", "rows":0 },
    { "code":"C2", "name":"بدون سند انتقال مرحله (ADR-012)", "status":"pass", "rows":0 },
    { "code":"C3", "name":"بدون سند انحراف مواد (ADR-011)",  "status":"pass", "rows":0 },
    { "code":"C4", "name":"همه اسناد تولیدی تراز",           "status":"pass", "rows":0 },
    { "code":"C5", "name":"کنترلی‌ها پس از بستن صفر",        "status":"pass", "rows":0 },
    { "code":"C6", "name":"WIP سفارش‌های closed صفر",        "status":"pass", "rows":0 },
    { "code":"C7", "name":"مانده 1114 سفارش‌های بسته صفر",   "status":"pass", "rows":0 }
  ]
}
```

---

## ۹. جدول کامل ۱۱۰ Endpoint

| # | متد | مسیر | ماژول | مجوز | Idem |
|--:|-----|------|:-----:|------|:----:|
| ۱ | GET | `/boms` | ۱ | view | |
| ۲ | POST | `/boms` | ۱ | create | |
| ۳ | GET | `/boms/:id` | ۱ | view | |
| ۴ | PUT | `/boms/:id` | ۱ | edit | |
| ۵ | DELETE | `/boms/:id` | ۱ | delete | |
| ۶ | POST | `/boms/:id/lines` | ۱ | edit | |
| ۷ | PUT | `/boms/:id/lines/:lid` | ۱ | edit | |
| ۸ | DELETE | `/boms/:id/lines/:lid` | ۱ | edit | |
| ۹ | POST | `/boms/:id/lines/bulk` | ۱ | edit | |
| ۱۰ | POST | `/boms/:id/activate` | ۱ | approve | |
| ۱۱ | POST | `/boms/:id/deactivate` | ۱ | approve | |
| ۱۲ | POST | `/boms/:id/archive` | ۱ | approve | |
| ۱۳ | POST | `/boms/:id/restore` | ۱ | approve | |
| ۱۴ | POST | `/boms/:id/version-up` | ۱ | create | |
| ۱۵ | POST | `/boms/:id/clone` | ۱ | create | |
| ۱۶ | POST | `/boms/:id/create-alternative` | ۱ | create | |
| ۱۷ | GET | `/boms/:id/explode` | ۱ | view | |
| ۱۸ | GET | `/boms/:id/tree` | ۱ | view | |
| ۱۹ | GET | `/boms/:id/std-cost` | ۱ | view | |
| ۲۰ | GET | `/boms/:id/history` | ۱ | view | |
| ۲۱ | GET | `/boms/compare` | ۱ | view | |
| ۲۲ | GET | `/boms/where-used/:pid` | ۱ | view | |
| ۲۳ | GET | `/boms/unused` | ۱ | view | |
| ۲۴ | GET | `/boms/missing` | ۱ | view | |
| ۲۵ | GET | `/boms/resolve` | ۱ | view | |
| ۲۶ | POST | `/boms/validate` | ۱ | view | |
| ۲۷ | GET | `/boms/:id/operations` | ۴ | view | |
| ۲۸ | POST | `/boms/:id/operations` | ۴ | edit | |
| ۲۹ | PUT | `/boms/:id/operations/:oid` | ۴ | edit | |
| ۳۰ | DELETE | `/boms/:id/operations/:oid` | ۴ | edit | |
| ۳۱ | POST | `/boms/:id/operations/resequence` | ۴ | edit | |
| ۳۲ | POST | `/boms/:id/operations/from-template` | ۴ | edit | |
| ۳۳ | GET | `/boms/:id/outputs` | ۴ | view | |
| ۳۴ | POST | `/boms/:id/outputs` | ۴ | edit | |
| ۳۵ | PUT | `/boms/:id/outputs/:oid` | ۴ | edit | |
| ۳۶ | DELETE | `/boms/:id/outputs/:oid` | ۴ | edit | |
| ۳۷ | POST | `/boms/:id/outputs/auto-share` | ۴ | edit | |
| ۳۸ | GET | `/boms/:id/full-cost` | ۴ | view | |
| ۳۹ | GET | `/boms/:id/roll-up` | ۴ | view | |
| ۴۰ | GET | `/boms/:id/cost-tree` | ۴ | view | |
| ۴۱ | GET | `/boms/:id/backward-qty` | ۴ | view | |
| ۴۲ | GET | `/boms/:id/yield-analysis` | ۴ | view | |
| ۴۳ | GET | `/boms/:id/capacity-load` | ۴ | view | |
| ۴۴ | GET | `/boms/:id/sensitivity` | ۴ | view | |
| ۴۵ | GET | `/boms/:id/breakeven` | ۴ | view | |
| ۴۶ | GET | `/boms/compare-scenarios` | ۴ | view | |
| ۴۷ | GET | `/cost-centers` | ۴ | view | |
| ۴۸ | PUT | `/cost-centers/:id` | ۴ | edit | |
| ۴۹ | GET | `/cost-center-rates` | ۴ | view | |
| ۵۰ | POST | `/cost-center-rates` | ۴ | create | |
| ۵۱ | PUT | `/cost-center-rates/:id` | ۴ | edit | |
| ۵۲ | POST | `/cost-center-rates/bootstrap` | ۴ | create | |
| ۵۳ | GET | `/orders` | ۲ | view | |
| ۵۴ | POST | `/orders` | ۲ | create | |
| ۵۵ | GET | `/orders/:id` | ۲ | view | |
| ۵۶ | PUT | `/orders/:id` | ۲ | edit | |
| ۵۷ | DELETE | `/orders/:id` | ۲ | delete | |
| ۵۸ | POST | `/orders/:id/release` | ۲ | approve | |
| ۵۹ | POST | `/orders/:id/release-advanced` | ۷ | approve | |
| ۶۰ | POST | `/orders/:id/cancel` | ۲ | approve | ✅ |
| ۶۱ | POST | `/orders/:id/close` | ۲ | approve | |
| ۶۲ | POST | `/orders/:id/reopen` | ۲ | approve | |
| ۶۳ | POST | `/orders/:id/receipt` | ۲،۳ | create | ✅ |
| ۶۴ | GET | `/orders/:id/preview` | ۲ | view | |
| ۶۵ | POST | `/orders/:id/labor` | ۲ | create | ✅ |
| ۶۶ | POST | `/orders/:id/overhead` | ۲ | create | ✅ |
| ۶۷ | POST | `/orders/:id/waste` | ۲ | create | ✅ |
| ۶۸ | POST | `/orders/:id/material-return` | ۲ | create | ✅ |
| ۶۹ | GET | `/orders/:id/issue-template` | ۳ | view | |
| ۷۰ | POST | `/orders/:id/issue` | ۳ | create | ✅ |
| ۷۱ | GET | `/orders/:id/issues` | ۳ | view | |
| ۷۲ | POST | `/orders/:id/return` | ۳ | create | ✅ |
| ۷۳ | GET | `/orders/:id/stages` | ۷ | view | |
| ۷۴ | GET | `/orders/:id/stages/:sid` | ۷ | view | |
| ۷۵ | POST | `/orders/:id/stages/:sid/start` | ۷ | create | |
| ۷۶ | GET | `/orders/:id/stages/:sid/preview` | ۷ | view | |
| ۷۷ | POST | `/orders/:id/stages/:sid/output` | ۷،۸ | create | ✅ |
| ۷۸ | POST | `/orders/:id/stages/:sid/skip` | ۷ | approve | |
| ۷۹ | POST | `/orders/:id/stages/:sid/block` | ۷ | create | |
| ۸۰ | POST | `/orders/:id/stages/:sid/unblock` | ۷ | create | |
| ۸۱ | POST | `/orders/:id/stages/:sid/reverse` | ۷ | approve | ✅ |
| ۸۲ | GET | `/orders/:id/stages/:sid/issue-template` | ۸ | view | |
| ۸۳ | POST | `/orders/:id/stages/:sid/issue` | ۸ | create | ✅ |
| ۸۴ | GET | `/orders/:id/stages/:sid/issues` | ۸ | view | |
| ۸۵ | POST | `/orders/:id/stages/:sid/return` | ۸ | create | ✅ |
| ۸۶ | POST | `/orders/:id/finalize` | ۷،۸ | create | ✅ |
| ۸۷ | POST | `/orders/:id/subcontract/send` | ۷ | create | ✅ |
| ۸۸ | POST | `/orders/:id/subcontract/receive` | ۷ | create | ✅ |
| ۸۹ | GET | `/orders/:id/subcontract` | ۷ | view | |
| ۹۰ | POST | `/orders/:id/rework` | ۷ | create | ✅ |
| ۹۱ | POST | `/orders/:id/rework/:rid/complete` | ۷ | create | ✅ |
| ۹۲ | GET | `/orders/:id/rework` | ۷ | view | |
| ۹۳ | GET | `/orders/:id/cost-sheet` | ۶ | view+cost | |
| ۹۴ | GET | `/orders/:id/stage-cost-sheet` | ۶ | view+cost | |
| ۹۵ | GET | `/orders/:id/value-added` | ۶ | view+cost | |
| ۹۶ | GET | `/orders/:id/ledger` | ۶ | view+cost | |
| ۹۷ | GET | `/orders/:id/variance` | ۶ | view+cost | |
| ۹۸ | GET | `/orders/:id/variance-analysis` | ۳،۸ | view+cost | |
| ۹۹ | GET | `/orders/:id/shortage` | ۵ | view | |
| ۱۰۰ | GET | `/orders/:id/profitability` | ۶ | view+cost | |
| ۱۰۱ | GET | `/orders/:id/flow` | ۶ | view | |
| ۱۰۲ | POST | `/docs/:table/:id/reverse` | همه | approve | ✅ |
| ۱۰۳ | GET/POST | `/estimates*` (۱۵ endpoint) | ۵ | مختلف | |
| ۱۰۴ | GET/POST | `/mrp*` (۱۱ endpoint) | ۵ | مختلف | |
| ۱۰۵ | GET/POST | `/close*` (۹ endpoint) | بستن | approve | ✅ |
| ۱۰۶ | GET | `/reports/*` (۳۰ endpoint) | ۶ | view | |
| ۱۰۷ | GET | `/config` | — | view | |
| ۱۰۸ | PUT | `/config` | — | edit | |
| ۱۰۹ | GET | `/health-check` | — | view | |
| ۱۱۰ | GET | `/events` | — | view | صف رویداد |

---

## ۱۰. کاتالوگ کامل خطاها

### اعتبارسنجی عمومی
| کد | HTTP | پیام |
|----|------|------|
| `E_QTY_INVALID` | 422 | تعداد باید بزرگ‌تر از صفر باشد |
| `E_QTY_ZERO` | 422 | مقدار نمی‌تواند صفر باشد |
| `E_QTY_NOT_INTEGER` | 422 | تعداد باید عدد صحیح باشد |
| `E_DATE_RANGE` | 422 | تاریخ پایان نباید قبل از شروع باشد |
| `E_FUTURE_DATE` | 422 | تاریخ آینده مجاز نیست |
| `E_NOT_FOUND` | 404 | یافت نشد |
| `E_FORBIDDEN` | 403 | مجوز ندارید |
| `E_CONCURRENT` | 409 | توسط کاربر دیگری تغییر کرد — بازخوانی کنید |

### دوره و سال مالی
| کد | HTTP | پیام |
|----|------|------|
| `E_FY_CLOSED` | 409 | سال مالی بسته است |
| `E_PERIOD_CLOSED` | 409 | دوره {period} بسته شده — ثبت ممکن نیست |
| `E_INVALID_PERIOD` | 422 | فرمت دوره باید YYYY/MM باشد |
| `E_CONTROL_NOT_ZERO` | 500 | حساب {code} پس از بستن صفر نشد |

### فرمول (BOM)
| کد | HTTP | پیام |
|----|------|------|
| `E_BOM_EMPTY` | 422 | فرمول باید حداقل یک قلم داشته باشد |
| `E_BOM_QTY_ZERO` | 422 | مقدار مصرف «{name}» باید > ۰ باشد |
| `E_BOM_SCRAP_RANGE` | 422 | درصد ضایعات باید ۰ تا ۹۹.۹ باشد |
| `E_BOM_YIELD_RANGE` | 422 | درصد بازده باید ۰.۱ تا ۱۰۰ باشد |
| `E_BOM_SELF_REF` | 422 | کالا نمی‌تواند جزء فرمول خودش باشد |
| `E_BOM_CIRCULAR` | 422 | حلقه در درخت فرمول: {path} |
| `E_BOM_DUP_LINE` | 422 | قلم «{name}» تکراری است |
| `E_BOM_UNIT_MISMATCH` | 422 | واحد «{name}» مطابقت ندارد |
| `E_BOM_OVERLAP` | 409 | بازه اعتبار با نسخه {v} هم‌پوشانی دارد |
| `E_BOM_LOCKED` | 409 | فرمول فعال قابل ویرایش نیست — نسخه جدید بسازید |
| `E_BOM_IN_USE` | 409 | در {n} سفارش باز استفاده شده |
| `E_NO_ACTIVE_BOM` | 404 | برای «{name}» در {date} فرمول فعالی نیست |
| `E_AMBIGUOUS_BOM` | 409 | چند فرمول فعال — یکی را انتخاب کنید |
| `E_BOM_TOO_DEEP` | 422 | عمق درخت بیش از ۱۰ سطح |
| `E_BOM_DUP_VERSION` | 409 | نسخه {v} از قبل وجود دارد |
| `E_PRODUCT_IN_BOM` | 409 | کالا در {n} فرمول استفاده شده |
| `E_YIELD_DOUBLE_COUNT` | 422 | فرمول Routing دارد — بازده سرفصل باید ۱۰۰٪ باشد |

### Routing و خروجی
| کد | HTTP | پیام |
|----|------|------|
| `E_ROUTING_EMPTY` | 422 | حداقل یک مرحله لازم است |
| `E_SEQ_DUPLICATE` | 422 | ترتیب {seq} تکراری است |
| `E_CC_NOT_STAGE` | 422 | «{cc}» مرحله تولید نیست |
| `E_STAGE_NOT_IN_ROUTING` | 422 | «{name}» به مرحله‌ای خارج از مسیر اشاره دارد |
| `E_OP_YIELD_RANGE` | 422 | بازده مرحله {seq} نامعتبر |
| `E_OP_WASTE_RANGE` | 422 | ضایعات مرحله {seq} نامعتبر |
| `E_SUBCON_INCOMPLETE` | 422 | مرحله پیمانکاری نیاز به تأمین‌کننده و کارمزد دارد |
| `E_LABOR_RATE_ZERO` | 422 | کارمزد مرحله {seq} صفر است |
| `E_NO_RUN_TIME` | 422 | روش ساعتی نیاز به زمان اجرا دارد |
| `E_NO_MACHINE_TIME` | 422 | محرک ساعت ماشین نیاز به زمان ماشین دارد |
| `E_CREW_ZERO` | 422 | تعداد نفرات باید ≥ ۱ باشد |
| `E_NO_MAIN_OUTPUT` | 422 | دقیقاً یک محصول اصلی لازم است |
| `E_SHARE_NOT_100` | 422 | مجموع سهم بها {sum}٪ است — باید ۱۰۰ باشد |
| `E_NRV_ZERO` | 422 | NRV «{name}» صفر است |
| `E_OUTPUT_DUPLICATE` | 422 | «{name}» دوبار خروجی تعریف شده |
| `E_MAIN_MISMATCH` | 422 | محصول اصلی با محصول فرمول یکسان نیست |
| `E_NRV_EXCEEDS_WIP` | 422 | ارزش محصول فرعی از کل بها بیشتر است |
| `E_PHANTOM_NOT_MANUFACTURED` | 422 | کالای مجازی باید «ساختنی» باشد |
| `E_QC_FIRST` | 422 | QC نمی‌تواند اولین مرحله باشد |

### سفارش تولید
| کد | HTTP | پیام |
|----|------|------|
| `E_NOT_MANUFACTURED` | 422 | «{name}» کالای ساختنی نیست |
| `E_ORDER_CLOSED` | 409 | سفارش بسته شده است |
| `E_ORDER_HAS_TXN` | 409 | سفارش دارای {n} تراکنش است |
| `E_QTY_MISMATCH` | 422 | مجموع ({x}) با تعداد شروع‌شده ({y}) مطابقت ندارد |
| `E_WASTE_EXCEEDS_STARTED` | 422 | ضایعات > تعداد شروع‌شده |
| `E_NEGATIVE_STOCK` | 409 | موجودی «{name}» در «{wh}» منفی می‌شود (موجود: {q}، نیاز: {n}) |
| `E_ZERO_AVG_COST` | 422 | بهای میانگین «{name}» صفر است — ابتدا خرید ثبت کنید |
| `E_NO_OH_RATE` | 422 | نرخ سربار «{cc}» در {p} تعریف نشده |
| `E_UNBALANCED` | 500 | سند تراز نیست |
| `E_NEGATIVE_WIP` | 500 | WIP منفی شد — عملیات لغو شد |
| `E_WIP_RESIDUAL` | 500 | مانده WIP {x} ریال |
| `E_FG_SOLD` | 409 | {n} عدد فروخته شده — ابطال ممکن نیست |
| `E_SAME_WAREHOUSE` | 422 | انبار مواد و محصول یکسان است |
| `E_WH_KIND` | 422 | نوع انبار نامعتبر |
| `E_SCRAP_NO_PRODUCT` | 422 | ضایعات فروشی نیاز به کالا و NRV دارد |
| `E_WRONG_ANALYSIS` | 409 | نوع آنالیز این سفارش «{type}» است |
| `E_ANALYSIS_LOCKED` | 409 | نوع آنالیز پس از اولین تراکنش قابل تغییر نیست |
| `E_FIXED_NO_MANUAL_QTY` | 422 | در آنالیز ثابت مصرف دستی مجاز نیست |
| `E_VARIABLE_NO_BACKFLUSH` | 409 | در آنالیز متغیر مصرف خودکار مجاز نیست |

### حواله و انحراف
| کد | HTTP | پیام |
|----|------|------|
| `E_ISSUE_EMPTY` | 422 | حواله باید حداقل یک قلم داشته باشد |
| `E_RETURN_EXCEEDS_ISSUE` | 422 | برگشت ({r}) > مصرف ({i}) |
| `E_RETURN_WITHOUT_ISSUE` | 422 | برای «{name}» حواله‌ای نیست |
| `E_VARIANCE_NEEDS_REASON` | 422 | انحراف «{name}» {pct}٪ — دلیل الزامی |
| `E_NO_MATERIAL_ISSUED` | 422 | ابتدا حواله مواد را ثبت کنید |
| `E_RECEIPT_EXISTS` | 409 | رسید ثبت شده — ابتدا ابطال کنید |
| `E_SUBSTITUTE_INVALID` | 422 | کالای جایگزین‌شده در فرمول نیست |
| `E_VARIANCE_DECOMPOSITION` | 500 | تجزیه انحراف برقرار نیست |
| `E_VARIANCE_NO_STAGE` | 500 | انحراف بدون مرحله ثبت شد |

### مرحله
| کد | HTTP | پیام |
|----|------|------|
| `E_NO_ROUTING` | 422 | این آنالیز نیاز به فرمول با مسیر عملیات دارد |
| `E_STAGES_NOT_CREATED` | 500 | مراحل ساخته نشده — دوباره release کنید |
| `E_PREV_STAGE_OPEN` | 409 | مرحله «{prev}» هنوز تمام نشده |
| `E_NEXT_STAGE_DONE` | 409 | مرحله بعدی تمام شده — ابتدا آن را ابطال کنید |
| `E_STAGE_NO_INPUT` | 422 | مرحله ورودی ندارد |
| `E_STAGE_CLOSED` | 409 | مرحله «{name}» بسته است |
| `E_STAGE_QTY_MISMATCH` | 422 | مجموع ({x}) ≠ ورودی ({y}) |
| `E_STAGE_HAS_COST` | 409 | مرحله هزینه دارد — قابل رد شدن نیست |
| `E_STAGE_MATERIAL_MISMATCH` | 422 | «{name}» در فرمول این مرحله نیست |
| `E_QC_REQUIRED` | 422 | نتیجه کنترل کیفیت الزامی است |
| `E_FORBIDDEN_CC` | 403 | به مرکز «{cc}» دسترسی ندارید |

### پیمانکاری و دوباره‌کاری
| کد | HTTP | پیام |
|----|------|------|
| `E_SUBCON_QTY_EXCEEDS` | 422 | دریافت ({r}) > ارسال ({s}) |
| `E_SUBCON_NOT_SENT` | 409 | ابتدا به پیمانکار ارسال کنید |
| `E_SUBCON_RESIDUAL` | 500 | مانده نزد پیمانکار {x} ریال |
| `E_SUBCON_IN_TRANSIT` | 409 | {n} عدد نزد پیمانکار است |
| `E_REWORK_QTY_MISMATCH` | 422 | بازیافتی + ناموفق ≠ تعداد |
| `E_REWORK_LIMIT` | 409 | {n} بار دوباره‌کاری — ضایعات اعلام کنید |

### برآورد و MRP
| کد | HTTP | پیام |
|----|------|------|
| `E_VALID_UNTIL_PAST` | 422 | تاریخ اعتبار گذشته است |
| `E_MARGIN_NEGATIVE` | 422 | حاشیه سود منفی مجاز نیست |
| `E_NOT_CONFIRMED` | 409 | ابتدا برآورد را تأیید کنید |
| `E_ALREADY_CONVERTED` | 409 | قبلاً به سفارش {no} تبدیل شده |
| `E_ESTIMATE_EXPIRED` | 409 | در {date} منقضی شده |
| `E_ESTIMATE_LOCKED` | 409 | برآورد تأییدشده قابل ویرایش نیست |
| `E_HORIZON_RANGE` | 422 | افق باید ۱ تا ۳۶۵ روز باشد |
| `E_INVALID_PRICE_BASIS` | 422 | مبنای قیمت نامعتبر |
| `E_MRP_RUNNING` | 409 | یک MRP در حال اجراست |
| `E_DISCOUNT_RANGE` | 422 | تخفیف باید ۰ تا ۹۹ باشد |

### گزارش
| کد | HTTP | پیام |
|----|------|------|
| `E_RANGE_TOO_LARGE` | 422 | بازه حداکثر ۵ سال |
| `E_PAGINATION` | 422 | پارامترهای صفحه‌بندی نامعتبر |
| `E_EXPORT_TOO_LARGE` | 422 | {n} سطر بیش از حد — فیلتر کنید |
| `E_REPORT_TIMEOUT` | 504 | گزارش زمان‌بر شد |

### هشدارها (`200` با `warnings[]`)
| کد | پیام |
|----|------|
| `W_LOW_TOTAL_YIELD` | بازده کل {pct}٪ — بررسی کنید |
| `W_NO_OH_RATE` | نرخ سربار «{cc}» برآوردی است |
| `W_BY_TOO_HIGH` | ارزش محصولات فرعی {pct}٪ از کل |
| `W_ITEM_NOT_IN_BOM` | «{name}» در فرمول نیست |
| `W_ITEM_NOT_IN_STAGE` | «{name}» در فرمول این مرحله نیست |
| `W_NO_PRICE` | «{name}» قیمتی ندارد |
| `W_NO_LABOR_HISTORY` | تاریخچه دستمزد موجود نیست |
| `W_DISCOUNT_BELOW_COST` | تخفیف {d}٪ زیر نقطه شکست ({dmax}٪) |
| `W_LEDGER_MISMATCH` | مغایرت {x} ریال با دفتر کل |
| `W_PERIOD_OPEN` | دوره {p} بسته نشده — اعداد موقتی |

---

## ۱۱. نصب Route ها در `server.js`

```js
// server/server.js — پس از route های موجود

app.use('/api/production/boms',         require('./routes/production-boms'));
app.use('/api/production/cost-centers', require('./routes/production-cost-centers'));
app.use('/api/production/cost-center-rates', require('./routes/production-cost-centers'));
app.use('/api/production/orders',       require('./routes/production-orders'));
app.use('/api/production/orders',       require('./routes/production-execution'));  // مراحل
app.use('/api/production/estimates',    require('./routes/production-estimation'));
app.use('/api/production/mrp',          require('./routes/production-estimation'));
app.use('/api/production/close',        require('./routes/production-close'));
app.use('/api/production/reports',      require('./routes/production-reports'));
app.use('/api/production/docs',         require('./routes/production-orders'));     // reverse
app.use('/api/production',              require('./routes/production-config'));     // config + health-check

// ⚠️ route قدیمی حفظ شود — سازگاری با UI فعلی
app.use('/api/production-runs',         require('./routes/production'));            // legacy
```

---

## ۱۲. الگوی استاندارد Route

```js
// server/routes/production-orders.js

const router  = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../lib/rbac');
const { withIdempotency } = require('../lib/production/idempotency');
const { canSeeCost, stripCostFields } = require('../lib/production/acl');
const engine = require('../lib/production/engine');

/** پوشش خطای یکنواخت */
function handle(fn) {
  return (req, res) => {
    try {
      const out = fn(req);
      res.json(canSeeCost(getDB(), req.user) ? out : stripCostFields(out));
    } catch (e) {
      const status = e.status || (e.message?.startsWith('E_') ? 422 : 500);
      res.status(status).json({
        error: e.code || e.message,
        message: e.userMessage || e.message,
        details: e.details || undefined,
      });
    }
  };
}

router.get('/', auth, requirePermission('production', 'view'), handle(req =>
  engine.listOrders(getDB(), { ...req.query, user: req.user })
));

router.post('/', auth, requirePermission('production', 'create'), handle(req =>
  engine.createOrder(getDB(), { ...req.body, userId: req.user.id })
));

router.post('/:id/receipt', auth, requirePermission('production', 'create'),
  withIdempotency(handle(req =>
    engine.postReceipt(getDB(), {
      orderId: +req.params.id, body: req.body, userId: req.user.id,
    })
  ))
);

router.post('/:id/stages/:sid/output', auth, requirePermission('production', 'create'),
  withIdempotency(handle(req =>
    engine.postStageOutput(getDB(), {
      orderId: +req.params.id, stageId: +req.params.sid,
      body: req.body, userId: req.user.id,
    })
  ))
);

module.exports = router;
```

```js
// server/lib/production/idempotency.js
function withIdempotency(handler) {
  return (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key) return handler(req, res);
    const db = getDB();
    const hit = db.prepare('SELECT response_json FROM production_idempotency WHERE key=?').get(key);
    if (hit) return res.json(JSON.parse(hit.response_json));

    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        try {
          db.prepare(`INSERT OR IGNORE INTO production_idempotency
                      (key, endpoint, user_id, response_json) VALUES (?,?,?,?)`)
            .run(key, req.originalUrl, req.user?.id, JSON.stringify(body));
        } catch (_) { /* ignore */ }
      }
      return origJson(body);
    };
    return handler(req, res);
  };
}
```

```js
// server/lib/production/acl.js
const COST_FIELDS = /(_rial|_toman|unit_cost|std_cost|var_price|var_qty|var_total|amount)$/;

function canSeeCost(db, user) {
  if (!user) return false;
  if (['admin','accounting','production_manager'].includes(user.role)) return true;
  const p = db.prepare(`SELECT can_view FROM user_permissions
                        WHERE user_id=? AND resource='production_cost'`).get(user.id);
  return !!p?.can_view;
}

/** حذف بازگشتی فیلدهای بها از JSON — نه فقط CSS */
function stripCostFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripCostFields);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (COST_FIELDS.test(k)) continue;
      if (['cost','costs','pricing','breakdown','standard','variance'].includes(k)) continue;
      out[k] = stripCostFields(v);
    }
    return out;
  }
  return obj;
}
module.exports = { canSeeCost, stripCostFields };
```
