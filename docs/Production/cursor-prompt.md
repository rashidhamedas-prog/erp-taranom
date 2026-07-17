# cursor-prompt.md
## پرامپت اجرایی اصلی — ماژول عملیات تولید

> **این سند را مستقیم به Cursor بده.**
> برای اجرای فاز به فاز، پرامپت هر ماژول در §۲۳ سند خودش است.

---

# 🎯 پرامپت اصلی (Master Prompt)

````
# پروژه: ماژول «عملیات تولید» — CRM Taranom

تو یک معمار ارشد نرم‌افزار حسابداری صنعتی هستی که روی یک سیستم production واقعی کار می‌کند.
این ماژول بهای تمام‌شده و سود ماهانه یک کارخانه پوشاک واقعی را محاسبه می‌کند.
**هر خطا = عدد غلط در صورت سود و زیان.**

## مخزن
rashidhamedas-prog/crm-taranom
مسیر production: /home/taranom/crm-taranom/  ·  VPS ایران: 94.249.244.208  ·  PM2: crm-taranom

## استک موجود (تغییر نده)
- Node.js + Express (بدون TypeScript)
- better-sqlite3 (بدون ORM)
- Schema در server/db.js → initDB() با CREATE TABLE IF NOT EXISTS + ensureColumn
- Frontend: SPA در server/public/index.html (Vanilla JS، بدون فریم‌ورک)
- دفتر کل: server/lib/ledger.js → postToLedger()
- کدینگ: server/lib/coa-map.js → acct(db, 'coa_*')
- RBAC: server/lib/rbac.js
- Sync: server/sync/tables.js (آرایه APPEND-ONLY)
- تاریخ: server/jalali.js

## اسناد — همه را قبل از شروع بخوان
docs/Production/
├── Production-Master-Architecture.md   ← ⭐ اول این. ۱۲ ADR + کدینگ + جریان ارزش
├── database-schema.md                  ← DDL کامل ۲۴ جدول + trigger + seed + health-check
├── accounting-events.md                ← PRD-01..PRD-99 نگاشت رویداد→سند
├── accounting-scenarios.md             ← ۴۸ سناریو با اعداد راستی‌آزمایی‌شده
├── 01-production-formulas.md           ← BOM
├── 02-fixed-analysis.md                ← آنالیز ثابت
├── 03-variable-analysis.md             ← آنالیز متغیر (ADR-011 حیاتی)
├── 04-advanced-formulas.md             ← Routing + Co/By (V4-21 حیاتی)
├── 05-production-estimation.md         ← MRP + برآورد
├── 06-production-reports.md            ← ۲۴ گزارش
├── 07-fixed-analysis-advanced.md       ← چندمرحله‌ای (ADR-012 حیاتی)
├── 08-variable-analysis-advanced.md    ← چندمرحله‌ای + انحراف
├── workflows.md                        ← نمودارها
├── api.md                              ← ۱۱۰ endpoint + کاتالوگ خطا
├── permissions.md                      ← RBAC
├── ui.md                               ← سیستم طراحی
└── test-cases.md                       ← ۲۹۷ تست + اعداد مرجع

## ═══ ۱۲ قانون طلایی — هرگز نقض نکن ═══

### R1 — پول
همه مبالغ در DB: INTEGER ریال با پسوند `_rial`. هرگز REAL.
postToLedger ورودی **تومان** می‌گیرد → همیشه `rial / 10` پاس بده.
⚠️ expense_payments.amount و payroll_records.gross_pay از نوع REAL و **تومان** هستند → × 10.

### R2 — قاعده طلایی رسید
production_receipts.amount_rial = **WIP_net دقیق**، نه unit_cost × qty.
unit_cost_rial فقط یک فیلد **گزارشی** است.
پس از هر رسید کامل، مانده WIP سفارش باید **دقیقاً صفر** باشد.

### R3 — ADR-011: انحراف مواد سند نمی‌خورد
WIP به **بهای واقعی** (میانگین موزون) بدهکار می‌شود.
انحراف نرخ و مقدار فقط در `var_price_rial`/`var_qty_rial` + `production_variances` با `status='memo'`.
حساب‌های 5210/5211 ساخته می‌شوند ولی **مانده‌شان همیشه صفر است**.
✅ تست: `SELECT COUNT(*) FROM journal_lines WHERE account_code IN ('5210','5211')` = 0

### R4 — ADR-012: انتقال بین مراحل سند ندارد
WIP فقط **یک حساب** (1111). تفکیک مرحله فقط در `production_order_stages` + تفصیلی.
استثنا: پیمانکاری (PRD-13/14) سند دارد چون کالا واقعاً از تصرف خارج می‌شود.
✅ تست: هیچ `journal_entries.ref_type` شامل `stage_transfer`

### R5 — ضایعات عادی سند ندارد
فقط رکورد در `production_waste` با `je_id = NULL`.
مازاد بر سقف → **خودکار** به `abnormal` تبدیل شود.
اثر: qty_out کمتر → unit_cost بالاتر → جذب خودکار ✅

### R6 — V4-21: ضد-دوباره‌شماری بازده
اگر `bom.has_routing = 1` → `bom_headers.yield_percent` اجباراً ۱۰۰.
وگرنه ضایعات دوبار حساب می‌شود.
`bom_lines.scrap_percent` (لایه متفاوت) همچنان اعمال می‌شود.

### R7 — محرک سربار
ماژول ۲/۷ (ثابت): `material_rial` = مواد **استاندارد**
ماژول ۳/۸ (متغیر): `material_rial` = مواد **واقعی** (از `production_material_issues`)
این تنها تفاوت محاسباتی ۷ و ۸ است — از قلم نینداز.

### R8 — اتمی بودن
هر عملیات کامل در **یک** `db.transaction(() => {...})()`.
انبار + WIP + سند: یا همه یا هیچ.

### R9 — کد حساب
هرگز Hard-code نکن. همیشه `acct(db, 'coa_wip')`.
باید در هر دو حالت `legacy` (۴ رقمی) و `extended` (۲/۴/۶/۱۲) کار کند.
تفصیلی فقط در حالت extended — در legacy مقدار `null`.

### R10 — Sync
`server/sync/tables.js` آرایه **APPEND-ONLY**.
جداول جدید فقط به **انتها**. ترتیب موجود هرگز تغییر نکند.
(index هر جدول در فرمول id موقت دستگاه‌ها استفاده می‌شود)

### R11 — مخفی‌سازی بها
`field_sales` و `production_operator` نباید بهای تمام‌شده را ببینند.
`stripCostFields` باید فیلدها را **از JSON حذف کند**، نه CSS مخفی کند.
✅ تست: `curl` با توکن field_sales → پاسخ فاقد هر `*_rial`

### R12 — ابطال نه حذف
هیچ حذف فیزیکی. Reversal = سند معکوس با تاریخ امروز + `status='reversed'`.
ترتیب معکوس ثبت. در چندمرحله‌ای: از آخرین مرحله به اولین.

## ═══ ترتیب اجرا ═══

فاز P0 → P10 به ترتیب. **هر فاز تا تست‌هایش سبز نشود، فاز بعد شروع نشود.**

| فاز | محتوا | پرامپت | تست |
|-----|-------|--------|-----|
| P0  | Schema + کدینگ + coa-map + sync | این سند §۱ | test-production-schema.js |
| P1  | ماژول ۱ — BOM | 01 §23 | test-production-bom.js |
| P2  | ماژول ۲ — آنالیز ثابت | 02 §23 | test-production-fixed.js |
| P3  | ماژول ۳ — آنالیز متغیر | 03 §20 | test-production-variable.js |
| P4  | سربار + دستمزد + مراکز | 04 §20 (بخش overhead) | (داخل P5) |
| P5  | ماژول ۴ — BOM پیشرفته | 04 §20 | test-production-bom-advanced.js |
| P6  | ماژول ۷ — ثابت پیشرفته | 07 §20 | test-production-fixed-advanced.js |
| P6b | ماژول ۸ — متغیر پیشرفته | 08 §20 | test-production-variable-advanced.js |
| P7  | ماژول ۵ — MRP + برآورد | 05 §22 | test-production-estimation.js |
| P8  | بستن ماه + تسهیم | این سند §۲ | test-production-close.js |
| P9  | ماژول ۶ — گزارشات | 06 §16 | test-production-reports.js |
| P10 | RBAC + UI + تست‌ها | permissions §12، ui §11، test-cases §12 | test-production-rbac.js |

## ═══ اعداد مرجع — قرارداد کل سیستم ═══

test-cases.md §10 را باز کن. این اعداد **راستی‌آزمایی‌شده** هستند.
اگر کدت عدد دیگری داد، **کد غلط است، نه سند**.

بحرانی‌ترین‌ها:
  ماژول ۲: unit_cost = 2,256,897  ·  میانگین FG = 2,233,802
  ماژول ۳: unit_cost = 2,299,697  ·  انحراف کل = 38,051,770
  ماژول ۷: unit_cost = 2,315,880  ·  تراز 1111 = 1,370,737,385
  ماژول ۸: unit_cost = 2,366,463  ·  تراز 1111 = 1,401,095,079
  بستن ماه: سود عملیاتی = 798,591,358

## ═══ ممنوعیت‌های مطلق ═══

❌ ORM اضافه نکن (Prisma/Sequelize/TypeORM)
❌ TypeScript اضافه نکن
❌ React/Vue/فریم‌ورک اضافه نکن
❌ فایل موجود را بازنویسی نکن — فقط افزودن
❌ production_runs قدیمی را حذف نکن (سازگاری)
❌ ترتیب SYNCABLE_TABLES را تغییر نده
❌ مجوزهای منابع موجود در rbac.js را تغییر نده
❌ ستون پولی REAL نساز
❌ کد حساب Hard-code نکن
❌ سند برای انحراف مواد نزن
❌ سند برای انتقال بین مراحل نزن
❌ سند برای ضایعات عادی نزن
❌ unit_cost × qty برای مبلغ سند
❌ چند transaction برای یک عملیات
❌ مخفی‌سازی بها فقط با CSS
❌ Optimistic UI روی عملیات مالی

## ═══ روند کار ═══

برای هر فاز:
1. سند مربوطه را **کامل** بخوان (مخصوصاً §الگوریتم و §شبه‌کد)
2. اعداد مرجع را از test-cases.md §10 بردار
3. Schema → سرویس → Route → UI → تست
4. `npm run test:production:<فاز>` → همه سبز؟
5. `node scripts/test-production-health.js` → همه ✅؟
6. سرور روی DB خالی **و** DB موجود بالا می‌آید؟
7. `git diff` را چک کن: هیچ تغییر ناخواسته در فایل‌های موجود؟
8. فاز بعد

## ═══ اگر گیر کردی ═══

- عدد غلط؟ → accounting-scenarios.md را باز کن، سناریوی متناظر را پیدا کن
- WIP صفر نمی‌شود؟ → R2 را دوباره بخوان
- سند نامتوازن؟ → `plug()` را استفاده کردی؟ (accounting-events.md §6)
- تفصیلی کار نمی‌کند؟ → حالت coa_mode را چک کن (legacy تفصیلی ندارد)
- ابهام؟ → **بپرس، حدس نزن.** این کد سود واقعی یک کسب‌وکار را محاسبه می‌کند.

شروع کن با فاز P0.
````

---

# ۱. پرامپت فاز P0 — Schema

````
# TASK: P0 — زیرساخت Schema

## اسناد
- docs/Production/Production-Master-Architecture.md  (§1 ADRs, §2 کدینگ)
- docs/Production/database-schema.md                 (کامل)
- docs/Production/test-cases.md §2                   (۱۵ تست)

## گام ۱ — تغییرات جداول موجود
server/db.js → initDB():
ensureColumn های §1 در database-schema.md:
  products:        item_type, is_manufactured, default_bom_id, default_warehouse_id,
                   std_cost_rial, last_prod_cost_rial, lead_time_days, min_order_qty,
                   safety_stock, scrap_percent
  cost_centers:    kind, driver, seq, is_stage, capacity_per_day, default_labor_method,
                   parent_id, coa_tafsili_oh, coa_tafsili_lb
  warehouses:      kind
  expense_payments: overhead_type
  production_runs: migrated_to_order_id, legacy
  persons:         cost_center_id, labor_method
  payroll_records: production_linked, cost_center_id
  production_variances: stage_id, product_id   (بعد از ساخت جدول)

⚠️ هیچ ستون پولی REAL نساز — همه INTEGER با پسوند _rial

## گام ۲ — جداول جدید (۲۴ جدول)
همه CREATE TABLE از §2 در database-schema.md، به ترتیب:
2.1 bom_headers, bom_lines, bom_operations, bom_outputs, bom_change_log
2.2 cost_center_rates, overhead_allocation_rules, overhead_allocation_weights
2.3 production_orders
2.4 production_order_stages
2.5 production_material_issues
2.6 production_labor_entries
2.7 production_overhead_applications
2.8 production_waste, production_rework
2.9 production_receipts
2.10 production_subcontract
2.11 production_variances
2.12 production_period_close
2.13 production_estimates, production_estimate_lines
2.14 mrp_runs, mrp_requirements, production_reservations
2.15 production_idempotency, production_events
+ user_cost_centers (permissions.md §2.3)
+ همه ایندکس‌ها

## گام ۳ — Trigger ها
§3 در database-schema.md — ۶ trigger:
  trg_bom_updated, trg_po_updated
  trg_bom_single_default
  trg_bomline_lock_active, trg_bomline_lock_delete
  trg_*_period_lock  (روی ۷ جدول تراکنشی)
  trg_ws_no_negative
  trg_bom_no_self
+ trg_est_lock_confirmed (05 §18)

## گام ۴ — VIEW ها
§3 در 06-production-reports.md:
  v_wip_by_order, v_order_cost_summary, v_variance_summary
+ ۶ ایندکس گزارشی

## گام ۵ — coa-map
server/lib/coa-map.js:
- ۲۰ کلید coa_* جدید به LEGACY (Master §2.1)
- KIND_KEY و KIND_TYPE برای:
    production_order → coa_wip / 'سفارش تولید'
    cost_center_oh   → coa_overhead_control / 'مراکز هزینه'
    cost_center_lb   → coa_labor_control / 'مراکز هزینه'

## گام ۶ — Sync
server/sync/tables.js:
۲۴ جدول به **انتهای** SYNCABLE_TABLES (§4 در database-schema.md)
⚠️ ترتیب موجود را دست نزن

## گام ۷ — Sequences
PROD_SEQUENCES در number_sequences (§5 در database-schema.md) — ۱۱ دنباله

## گام ۸ — Settings
۲۳ تنظیم پیش‌فرض (§6 در database-schema.md)

## گام ۹ — Seed
§7 در database-schema.md — فقط اگر جدول خالی است:
  TARANOM_COST_CENTERS  (۷ مرکز)
  TARANOM_WAREHOUSES    (۵ انبار)
  PRODUCTION_ACCOUNTS   (۱۸ حساب — فقط اگر code موجود نیست)

## گام ۱۰ — تست
server/scripts/lib/test-harness.js  (test-cases.md §0.3)
server/scripts/lib/seed-taranom.js  (test-cases.md §9)
server/scripts/test-production-schema.js — ۱۵ تست (test-cases.md §2)

## معیار پذیرش
- [ ] `node scripts/test-production-schema.js` → ۱۵ سبز
- [ ] سرور روی DB خالی بالا می‌آید
- [ ] سرور روی کپی DB production بالا می‌آید
- [ ] `initDB()` دوبار → بدون خطا
- [ ] TS-07: هیچ ستون `*_rial` از نوع REAL
- [ ] TS-08: ترتیب SYNCABLE_TABLES دست‌نخورده
- [ ] `git diff server/sync/tables.js` → فقط append
````

---

# ۲. پرامپت فاز P8 — بستن ماه ⭐

````
# TASK: P8 — بستن دوره و تسهیم انحرافات

## پیش‌نیاز
فازهای P0 تا P7 کامل و تست‌شده.

## اسناد
- docs/Production/Production-Master-Architecture.md §1 ADR-005  ← ⭐ حیاتی
- docs/Production/accounting-events.md PRD-21, PRD-22, PRD-23
- docs/Production/accounting-scenarios.md A-45 … A-48          ← اعداد
- docs/Production/workflows.md §10                             ← نمودار
- docs/Production/api.md §6                                    ← endpoint ها
- docs/Production/ui.md §4                                     ← طرح صفحه
- docs/Production/test-cases.md §3                             ← ۱۸ تست

## ⚠️ چرا این فاز مهم‌ترین است
خواسته اصلی حامد: «آخر هر ماه سود دقیقم مشخص باشد.»
ADR-005 پاسخ همین است. اگر این فاز غلط باشد، کل سیستم بی‌فایده است.

## ⚠️ قواعد قطعی
1. **ADR-005 — تسهیم متناسب:**
   انحراف بین WIP + کالای ساخته‌شده + COGS تسهیم می‌شود، نه همه به COGS.
   پایه: مبلغ «جزء مربوطه» جذب‌شده در هر سطل.
     - انحراف دستمزد → پایه = دستمزد جذب‌شده
     - انحراف سربار  → پایه = سربار جذب‌شده
2. **آستانه اهمیت:** اگر |انحراف| < بهای تولید × threshold_pct/100
   → روش `direct_cogs` پیشنهاد شود (ولی کاربر می‌تواند proration انتخاب کند).
3. **انحراف مواد تسهیم نمی‌شود** — اصلاً وجود ندارد (ADR-011).
4. **ضایعات غیرعادی تسهیم نمی‌شود** — ۱۰۰٪ هزینه دوره.
5. **کنترل نهایی اجباری:** 5201, 5202, 5203, 5212, 5213, 5214, 5215
   همه باید **صفر** شوند. اگر نه → rollback + E_CONTROL_NOT_ZERO.
6. **به‌روزرسانی میانگین FG:** سهم FG باید بین کالاهای موجود سرشکن شود
   و `products.average_cost_rial` به‌روز شود.
   وگرنه مانده 1104 با Σ(stock × avg) مغایرت پیدا می‌کند.
7. کل اجرا در **یک** db.transaction.

## گام ۱ — سرویس
server/lib/production/close.js:
  precheck(db, { period })              ← ۶ چک (api.md §6)
  calculate(db, { period })             ← محاسبه + پیش‌نمایش (api.md §6)
  execute(db, { period, method, userId })
  reopen(db, { period, reason, userId }) ← فقط admin
  openPeriod(db, { period })
  allocationBase(db, { period })        ← WIP/FG/COGS با پایه جذب‌شده
  prorateVariance(db, { variance, base })
  updateFgAverages(db, { fgShare, period })   ← ⚠️ فراموش نکن
  assertControlsZero(db, { period })

## گام ۲ — ثبت اسناد
server/lib/production/posting.js (توسعه):
  postCloseLabor    → PRD-21
  postCloseOverhead → PRD-22 (دو سند: انتقال + انحراف)
  postAllocation    → PRD-23

⚠️ ترتیب اجباری:
  ۱) PRD-21: 5212/5213 ⇄ 5201        → 5201 صفر شود
  ۲) PRD-22 گام ۱: 5203 → 5202        → 5203 صفر شود
  ۳) PRD-22 گام ۲: 5214/5215 ⇄ 5202  → 5202 صفر شود
  ۴) PRD-23: 1111+1104+5101 ⇄ 521x   → 521x صفر شود
  ۵) updateFgAverages()
  ۶) assertControlsZero()  → اگر ناموفق، throw + rollback

## گام ۳ — Route
server/routes/production-close.js — ۹ endpoint (api.md §6)
- execute با Idempotency-Key
- reopen فقط admin + دلیل اجباری + auditCritical

## گام ۴ — UI
صفحه «بستن دوره» (ui.md §4):
- ۴ گام: بررسی → محاسبه → تأیید → اجرا
- چک‌لیست با 🔴/🟡/✅ + لینک اقدام
- جدول کسر/اضافه جذب به تفکیک مرکز + نوار نسبت
- انتخاب روش تسهیم + جدول زنده
- پیش‌نمایش ۴ سند
- دکمه «بستن نهایی» تا رفع همه 🔴 غیرفعال
- پس از موفقیت → redirect به PR-23

## گام ۵ — تست
server/scripts/test-production-close.js — ۱۸ تست (test-cases.md §3)
اعداد از accounting-scenarios.md A-45..A-48:
  TC-04  انحراف دستمزد = 482,700
  TC-05  انحراف سربار  = 1,481,162
  TC-08  پایه: WIP 12.65٪ · FG 20.78٪ · COGS 66.57٪
  TC-09  تسهیم سربار: 187,316 / 307,776 / 986,070
  TC-10  تسهیم دستمزد: 61,045 / 100,302 / 321,353
  TC-11  تراز PRD-23 = 1,963,862
  TC-12  ⭐ همه کنترلی‌ها صفر

## معیار پذیرش
- [ ] A-45 تا A-48 عیناً بازتولید شوند
- [ ] پس از بستن: 5201=۰ · 5202=۰ · 5203=۰ · 5212=۰ · 5215=۰
- [ ] مانده 1104 = Σ(products.stock × average_cost_rial)
- [ ] مانده 1111 = Σ WIP سفارش‌های باز
- [ ] سود ناخالص PR-23 = صورت سود و زیان سیستم
- [ ] ثبت پس از بستن → 409 E_PERIOD_CLOSED
- [ ] reopen فقط admin + audit + notification

## ممنوعیت‌ها
- ❌ همه انحراف به COGS بدون بررسی آستانه
- ❌ تسهیم انحراف مواد
- ❌ تسهیم ضایعات غیرعادی
- ❌ فراموش کردن updateFgAverages
- ❌ بستن بدون assertControlsZero
- ❌ چند transaction
````

---

# ۳. چک‌لیست نهایی تحویل

## ۳.۱ کد

- [ ] سرور روی DB خالی بالا می‌آید
- [ ] سرور روی کپی DB production بالا می‌آید
- [ ] `npm run test:production` → ۲۹۷ سبز
- [ ] `node scripts/test-production-health.js` → همه ✅
- [ ] ۱۸ تست حیاتی (test-cases.md §1) سبز
- [ ] `git diff` → هیچ تغییر ناخواسته در فایل‌های موجود
- [ ] `grep -r "REAL" server/db.js | grep _rial` → خالی
- [ ] `grep -rn "'1111'\|'5201'\|'1104'" server/lib/production/ server/routes/production-*` → فقط در seed و health-check

## ۳.۲ حسابداری

- [ ] WIP هر سفارش closed = ۰
- [ ] `SELECT COUNT(*) FROM journal_lines WHERE account_code IN ('5210','5211')` = ۰
- [ ] هیچ `journal_entries.ref_type` شامل `stage_transfer`
- [ ] ضایعات عادی `je_id = NULL`
- [ ] همه اسناد تولیدی تراز
- [ ] پس از بستن ماه: 5201, 5202, 5203 = ۰
- [ ] مانده 1104 = Σ(stock × average_cost_rial)
- [ ] مانده 1114 سفارش‌های بسته = ۰
- [ ] سود ناخالص PR-23 = صورت سود و زیان

## ۳.۳ امنیت و دسترسی

- [ ] `curl` با توکن `field_sales` روی `/estimates/quick` → فاقد هر `*_rial`
- [ ] `production_operator` با `[CC-10]` نمی‌تواند روی CC-30 ثبت کند
- [ ] کاربر بدون `user_cost_centers` → همه مراکز آزاد
- [ ] `accounting` نمی‌تواند BOM فعال کند
- [ ] `production_manager` نمی‌تواند دوره ببندد
- [ ] `reopen` فقط `admin` + دلیل + audit + notification

## ۳.۴ UI

- [ ] همه صفحات RTL + Vazirmatn + اعداد فارسی
- [ ] موبایل ۳۷۵px بدون scroll افقی
- [ ] رنگ‌ها فقط از CSS variables
- [ ] `field_sales` login → هیچ ستون بها در DOM
- [ ] فرم ثبت تولید با صفحه‌کلید کامل
- [ ] برگه بها در A4 چاپ می‌شود

## ۳.۵ کارایی

- [ ] داشبورد < ۱ ثانیه روی ۱۰٬۰۰۰ سفارش
- [ ] PR-23 سود ماهانه < ۵۰۰ms
- [ ] `POST /estimates/quick` < ۵۰۰ms
- [ ] MRP روی ۱٬۰۰۰ کالا < ۱۰ ثانیه
- [ ] همه کوئری‌های گزارش ایندکس می‌زنند

## ۳.۶ Deploy

```bash
# روی VPS ایران
ssh -i ~/.ssh/id_ed25519_taranom taranom@94.249.244.208
cd ~/crm-taranom

# ۱) بکاپ اجباری
mkdir -p server/backups
cp -a server/crm.db "server/backups/crm-$(date +%F-%H%M).db"

# ۲) به‌روزرسانی
git pull origin claude/claude-md-docs-2ssrpy
cd server && npm install --omit=dev

# ۳) تست (اختیاری روی production)
npm run test:production:health

# ۴) restart
pm2 restart crm-taranom --update-env
pm2 logs crm-taranom --lines 50

# ۵) تأیید
curl -sf http://127.0.0.1:3000/api/system/health
node scripts/production-go-live-check.js

# ۶) rollback در صورت مشکل
pm2 stop crm-taranom
cp server/backups/crm-<timestamp>.db server/crm.db
git reset --hard HEAD~1 && npm install --omit=dev
pm2 start crm-taranom
```

---

# ۴. راه‌اندازی عملیاتی ترنم (پس از deploy)

## ۴.۱ ترتیب کار

```
هفته ۱ — داده پایه
  ۱) تعریف ۷ مرکز هزینه (خودکار seed شده — فقط بازبینی driver ها)
  ۲) تعریف ۵ انبار + تنظیم production_wh_*_id در settings
  ۳) علامت‌گذاری کالاها: item_type + is_manufactured
  ۴) ثبت average_cost_rial همه مواد (از آخرین خرید)
  ۵) تعریف نرخ سربار ۶ مرکز → یا Bootstrap ۳ ماهه
  ۶) تخصیص persons.cost_center_id به ۱۵ پرسنل

هفته ۲ — فرمول
  ۷) ساخت BOM برای ۳ مدل پرفروش (شروع با ماژول ۱ ساده)
  ۸) تست explode + std-cost → مقایسه با محاسبه دستی
  ۹) فعال‌سازی فرمول‌ها

هفته ۳-۴ — تولید آزمایشی (ماژول ۲)
  ۱۰) ۳ سفارش آزمایشی با analysis_type='fixed'
  ۱۱) بررسی برگه بها + مقایسه با تخمین ذهنی حامد
  ۱۲) آموزش اپراتور

ماه ۲ — بستن اول
  ۱۳) ثبت همه هزینه‌های سربار با is_overhead=1 + cost_center_id
  ۱۴) ثبت حقوق با cost_center_id
  ۱۵) اولین بستن دوره → PR-23 سود دقیق
  ۱۶) مقایسه با محاسبه دستی حسابدار

ماه ۳-۴ — ارتقا به ماژول ۷
  ۱۷) افزودن Routing به فرمول‌ها (الگوی ترنم)
  ۱۸) تعریف پیمانکار شستشو
  ۱۹) تخصیص user_cost_centers به اپراتورها
  ۲۰) تولید با analysis_type='fixed_adv'

ماه ۵+ — ارتقا به ماژول ۸ ⭐
  ۲۱) آموزش برشکار برای گزارش مصرف واقعی
  ۲۲) تعریف std_cost_rial روی همه bom_lines
  ۲۳) تولید با analysis_type='variable_adv'
  ۲۴) استفاده از ماتریس انحراف در جلسه هفتگی
```

## ۴.۲ نشانه‌های سلامت

| نشانه | یعنی |
|-------|------|
| کسری انبارگردانی بالا | آنالیز ثابت — به متغیر مهاجرت کن |
| انحراف سربار > ۱۰٪ | نرخ‌ها قدیمی — بودجه بازنگری کن |
| انحراف مقدار پایدار یک ماده | فرمول غلط — `versionUp` |
| ضایعات غیرعادی رو به رشد | مشکل کیفیت — روی مرحله برش تمرکز کن |
| بهای واحد ۵۰۰ = ۳۰۰ | طبیعی — ۰۵ §۷ را بخوان |
| WIP باز طولانی | سفارش‌های نیمه‌کاره — ببند |

---

# ۵. خلاصه فایل‌های تولیدی

```
server/
├── db.js                                    ← + ۲۴ جدول، ۳ VIEW، ۶ trigger، seed
├── server.js                                ← + ۱۱ route + ۲ کرون
├── lib/
│   ├── coa-map.js                           ← + ۲۰ کلید coa_*
│   ├── rbac.js                              ← + ۵ منبع، ۲ نقش
│   └── production/
│       ├── bom.js                           ← ماژول ۱
│       ├── bom-advanced.js                  ← ماژول ۴
│       ├── costing.js                       ← میانگین موزون
│       ├── overhead.js                      ← نرخ و جذب
│       ├── labor.js                         ← ۴ روش دستمزد
│       ├── waste.js                         ← ۴ نوع ضایعات
│       ├── subcontract.js                   ← پیمانکاری
│       ├── rework.js                        ← دوباره‌کاری
│       ├── variance.js                      ← انحراف + ماتریس
│       ├── posting.js                       ← dr/cr/plug/postEvent/reverseEvent
│       ├── engine.js                        ← موتور ساده (۲، ۳)
│       ├── engine-advanced.js               ← موتور پیشرفته (۷، ۸)
│       ├── estimate.js                      ← ماژول ۵
│       ├── mrp.js                           ← MRP
│       ├── close.js                         ← بستن ماه
│       ├── reports.js                       ← ۲۴ گزارش
│       ├── report-export.js                 ← Excel/PDF
│       ├── acl.js                           ← canSeeCost/stripCostFields
│       ├── idempotency.js                   ← withIdempotency
│       └── events.js                        ← Event Bus
├── routes/
│   ├── production-boms.js
│   ├── production-cost-centers.js
│   ├── production-orders.js
│   ├── production-execution.js
│   ├── production-estimation.js
│   ├── production-close.js
│   ├── production-reports.js
│   ├── production-config.js
│   ├── production.js                        ← legacy (دست نخورد)
│   └── payroll.js                           ← + linkPayrollToProduction
├── sync/tables.js                           ← + ۲۴ جدول (append)
├── public/
│   ├── index.html                           ← + ۱۵ صفحه
│   ├── acc-nav.js                           ← + منوی تولید
│   ├── prod-ui.js                           ← کامپوننت‌ها
│   └── prod-ui.css                          ← سیستم طراحی
└── scripts/
    ├── lib/test-harness.js
    ├── lib/seed-taranom.js
    ├── test-production-all.js
    ├── test-production-schema.js
    ├── test-production-bom.js
    ├── test-production-fixed.js
    ├── test-production-variable.js
    ├── test-production-bom-advanced.js
    ├── test-production-estimation.js
    ├── test-production-fixed-advanced.js
    ├── test-production-variable-advanced.js
    ├── test-production-close.js
    ├── test-production-reports.js
    ├── test-production-rbac.js
    ├── test-production-reports-perf.js
    └── test-production-health.js
```

**تخمین:** ~۲۲.۵ روز کاری · ~۱۸٬۰۰۰ خط کد · ۲۹۷ تست
