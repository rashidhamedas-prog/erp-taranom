# database-schema.md
## اسکیمای کامل دیتابیس — ماژول عملیات تولید

> **موتور:** SQLite (better-sqlite3) · **مکان:** `server/db.js` داخل تابع `initDB()`
> **قواعد:** همه مبالغ `INTEGER` ریال · تاریخ‌ها `TEXT` جلالی `YYYY/MM/DD` · `created_at` یونیکس `INTEGER`
> **مهاجرت:** جدول‌های جدید با `CREATE TABLE IF NOT EXISTS` · ستون‌های جدید روی جداول موجود با `ensureColumn(db, table, col, type)`

---

## 0. نمودار موجودیت‌ها (ERD متنی)

```
                    ┌─────────────────┐
                    │    products     │ (موجود)
                    └────┬───────┬────┘
             product_id  │       │  component_product_id
                    ┌────▼────┐  │
                    │bom_head │  │
                    │  ers    │  │
                    └─┬──┬──┬─┘  │
          bom_id       │  │  │   │
        ┌──────────────┘  │  └───┴──────┐
        ▼                 ▼             ▼
  ┌───────────┐   ┌──────────────┐  ┌────────────┐
  │ bom_lines │   │bom_operations│  │bom_outputs │
  └───────────┘   └──────┬───────┘  └────────────┘
                         │ cost_center_id
                         ▼
                  ┌──────────────┐      ┌──────────────────┐
                  │ cost_centers │◄─────┤cost_center_rates │
                  │  (موجود+)     │      └──────────────────┘
                  └──────┬───────┘
                         │
   ┌─────────────────────┼──────────────────────────┐
   │                     │                          │
┌──▼────────────────┐    │                          │
│ production_orders │────┼──► production_order_stages
└──┬────────────────┘    │            │
   │                     │            │
   ├──► production_material_issues ◄──┤
   ├──► production_labor_entries   ◄──┤
   ├──► production_overhead_applications ◄─┘
   ├──► production_waste
   ├──► production_receipts
   ├──► production_rework
   ├──► production_subcontract
   └──► production_variances

┌────────────────────┐    ┌──────────────────────┐
│production_estimates│───►│production_estimate_  │
└────────────────────┘    │       lines          │
                          └──────────────────────┘
┌──────────┐   ┌──────────────────┐
│ mrp_runs │──►│mrp_requirements  │
└──────────┘   └──────────────────┘

┌────────────────────────┐  ┌────────────────────────┐
│production_period_close │  │production_idempotency  │
└────────────────────────┘  └────────────────────────┘
```

---

## 1. تغییرات روی جداول موجود

```js
// ---------- products ----------
ensureColumn(db, 'products', 'item_type',            "TEXT DEFAULT 'finished'");
//   finished | raw | packaging | semi | scrap | service
ensureColumn(db, 'products', 'is_manufactured',      'INTEGER DEFAULT 0');
ensureColumn(db, 'products', 'default_bom_id',       'INTEGER');
ensureColumn(db, 'products', 'default_warehouse_id', 'INTEGER');
ensureColumn(db, 'products', 'std_cost_rial',        'INTEGER DEFAULT 0'); // بهای استاندارد برای مقایسه
ensureColumn(db, 'products', 'last_prod_cost_rial',  'INTEGER DEFAULT 0'); // بهای آخرین تولید
ensureColumn(db, 'products', 'lead_time_days',       'INTEGER DEFAULT 0'); // برای MRP
ensureColumn(db, 'products', 'min_order_qty',        'REAL DEFAULT 0');
ensureColumn(db, 'products', 'safety_stock',         'REAL DEFAULT 0');
ensureColumn(db, 'products', 'scrap_percent',        'REAL DEFAULT 0');    // ضایعات ذاتی کالا

// ---------- cost_centers ----------
ensureColumn(db, 'cost_centers', 'kind',              "TEXT DEFAULT 'production'");
//   production | service | admin | sales
ensureColumn(db, 'cost_centers', 'driver',            "TEXT DEFAULT 'output_qty'");
//   direct_labor_hours | direct_labor_rial | machine_hours | output_qty | material_rial | manual
ensureColumn(db, 'cost_centers', 'seq',               'INTEGER DEFAULT 0'); // ترتیب مرحله
ensureColumn(db, 'cost_centers', 'is_stage',          'INTEGER DEFAULT 0'); // مرحله تولید است؟
ensureColumn(db, 'cost_centers', 'capacity_per_day',  'REAL DEFAULT 0');
ensureColumn(db, 'cost_centers', 'default_labor_method', "TEXT DEFAULT 'piece'");
ensureColumn(db, 'cost_centers', 'parent_id',         'INTEGER');
ensureColumn(db, 'cost_centers', 'coa_tafsili_oh',    'TEXT'); // کد تفصیلی سربار
ensureColumn(db, 'cost_centers', 'coa_tafsili_lb',    'TEXT'); // کد تفصیلی دستمزد

// ---------- warehouses ----------
ensureColumn(db, 'warehouses', 'kind', "TEXT DEFAULT 'general'");
//   general | raw | finished | subcontract | scrap | wip_virtual

// ---------- expense_payments ----------
// is_overhead + cost_center_id موجودند ✅
ensureColumn(db, 'expense_payments', 'overhead_type', "TEXT DEFAULT 'variable'");
//   fixed | variable  → لازم برای تفکیک انحراف بودجه/حجم در ماژول ۷ و ۸

// ---------- production_runs (جدول قدیمی) ----------
// حفظ می‌شود فقط برای سازگاری تاریخی. جدید: production_orders
ensureColumn(db, 'production_runs', 'migrated_to_order_id', 'INTEGER');
ensureColumn(db, 'production_runs', 'legacy',                'INTEGER DEFAULT 1');
```

---

## 2. جداول جدید — DDL کامل

### 2.1 فرمول تولید (BOM)

```sql
-- سرفصل فرمول
CREATE TABLE IF NOT EXISTS bom_headers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL,                 -- BOM-000123
  product_id        INTEGER NOT NULL,              -- محصول خروجی اصلی
  version           INTEGER NOT NULL DEFAULT 1,
  revision          TEXT DEFAULT '',               -- A, B, C...
  name              TEXT DEFAULT '',
  bom_type          TEXT DEFAULT 'standard',       -- standard | alternative | phantom | rework
  alt_of_bom_id     INTEGER,                       -- اگر جایگزین است، فرمول اصلی
  alt_reason        TEXT DEFAULT '',               -- دلیل جایگزینی
  base_qty          REAL NOT NULL DEFAULT 1,       -- فرمول برای چند واحد نوشته شده
  unit_id           INTEGER,
  status            TEXT DEFAULT 'draft',          -- draft | active | archived | obsolete
  valid_from        TEXT DEFAULT '',               -- جلالی
  valid_to          TEXT DEFAULT '',               -- خالی = بی‌نهایت
  is_default        INTEGER DEFAULT 0,
  is_multilevel     INTEGER DEFAULT 0,             -- ۱ = فرمول پیشرفته (ماژول ۴)
  has_routing       INTEGER DEFAULT 0,             -- ۱ = دارای bom_operations
  has_coproducts    INTEGER DEFAULT 0,             -- ۱ = دارای bom_outputs غیر main
  yield_percent     REAL DEFAULT 100,              -- بازده کلی
  size_range        TEXT DEFAULT '',               -- 38-48
  color_variant     TEXT DEFAULT '',               -- برای ترنم
  note              TEXT DEFAULT '',
  approved_by       INTEGER,
  approved_at       INTEGER,
  created_by        INTEGER,
  created_at        INTEGER DEFAULT (strftime('%s','now')),
  updated_at        INTEGER DEFAULT (strftime('%s','now')),
  deleted_at        INTEGER,
  FOREIGN KEY(product_id)    REFERENCES products(id),
  FOREIGN KEY(alt_of_bom_id) REFERENCES bom_headers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_code ON bom_headers(code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_prod_ver ON bom_headers(product_id, version, revision);
CREATE INDEX IF NOT EXISTS ix_bom_product_status ON bom_headers(product_id, status, valid_from, valid_to);

-- اقلام فرمول
CREATE TABLE IF NOT EXISTS bom_lines (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id                INTEGER NOT NULL,
  line_no               INTEGER NOT NULL DEFAULT 1,
  component_product_id  INTEGER NOT NULL,
  qty_per_base          REAL NOT NULL,             -- به‌ازای base_qty
  unit_id               INTEGER,
  scrap_percent         REAL DEFAULT 0,            -- ضایعات ذاتی این قلم (٪)
  fixed_qty             REAL DEFAULT 0,            -- مقدار ثابت مستقل از تعداد (setup)
  line_type             TEXT DEFAULT 'material',   -- material | packaging | service | phantom
  stage_cost_center_id  INTEGER,                   -- در کدام مرحله مصرف می‌شود
  backflush             INTEGER DEFAULT 1,         -- ۱ = خودکار در آنالیز ثابت
  is_optional           INTEGER DEFAULT 0,
  substitute_group      TEXT DEFAULT '',           -- اقلام هم‌گروه = جایگزین یکدیگر
  substitute_priority   INTEGER DEFAULT 0,
  size_matrix           TEXT DEFAULT '',           -- JSON: {"38":1.4,"40":1.45,...} مصرف بر اساس سایز
  std_cost_rial         INTEGER DEFAULT 0,         -- نرخ استاندارد این قلم (snapshot)
  note                  TEXT DEFAULT '',
  created_at            INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(bom_id)               REFERENCES bom_headers(id) ON DELETE CASCADE,
  FOREIGN KEY(component_product_id) REFERENCES products(id),
  FOREIGN KEY(stage_cost_center_id) REFERENCES cost_centers(id)
);
CREATE INDEX IF NOT EXISTS ix_bomline_bom  ON bom_lines(bom_id, line_no);
CREATE INDEX IF NOT EXISTS ix_bomline_comp ON bom_lines(component_product_id);

-- مراحل / Routing (ماژول ۴، ۷، ۸)
CREATE TABLE IF NOT EXISTS bom_operations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id               INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,           -- 10, 20, 30 ...
  cost_center_id       INTEGER NOT NULL,           -- مرکز هزینه / مرحله
  operation_name       TEXT DEFAULT '',
  setup_minutes        REAL DEFAULT 0,             -- زمان آماده‌سازی (ثابت به‌ازای سفارش)
  run_minutes_per_unit REAL DEFAULT 0,             -- زمان اجرا به‌ازای واحد
  machine_minutes_per_unit REAL DEFAULT 0,
  labor_method         TEXT DEFAULT 'piece',       -- piece | hourly | monthly | contract
  labor_rate_rial      INTEGER DEFAULT 0,          -- کارمزد هر عدد / نرخ ساعتی
  crew_size            REAL DEFAULT 1,
  overhead_driver      TEXT DEFAULT '',            -- خالی = از cost_centers.driver
  yield_percent        REAL DEFAULT 100,           -- بازده این مرحله
  normal_waste_percent REAL DEFAULT 0,             -- ضایعات عادی مجاز این مرحله
  is_subcontract       INTEGER DEFAULT 0,
  subcontract_supplier_id INTEGER,
  subcontract_fee_rial INTEGER DEFAULT 0,          -- کارمزد هر عدد
  is_qc_gate           INTEGER DEFAULT 0,          -- ایست کنترل کیفیت
  note                 TEXT DEFAULT '',
  created_at           INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(bom_id)         REFERENCES bom_headers(id) ON DELETE CASCADE,
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bomop ON bom_operations(bom_id, seq);

-- خروجی‌ها: اصلی / همزاد / فرعی / ضایعات (ماژول ۴، ۷، ۸)
CREATE TABLE IF NOT EXISTS bom_outputs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id             INTEGER NOT NULL,
  product_id         INTEGER NOT NULL,
  output_type        TEXT NOT NULL DEFAULT 'main', -- main | co | by | scrap
  qty_per_base       REAL NOT NULL DEFAULT 1,
  unit_id            INTEGER,
  cost_method        TEXT DEFAULT 'share',         -- share | nrv | fixed | zero
  cost_share_percent REAL DEFAULT 0,               -- برای cost_method='share'
  nrv_rial           INTEGER DEFAULT 0,            -- ارزش خالص بازیافتنی (by/scrap)
  warehouse_id       INTEGER,
  stage_cost_center_id INTEGER,                    -- در کدام مرحله تولید می‌شود
  note               TEXT DEFAULT '',
  created_at         INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(bom_id)     REFERENCES bom_headers(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS ix_bomout ON bom_outputs(bom_id, output_type);

-- تاریخچه تغییرات فرمول (ECO — Engineering Change Order)
CREATE TABLE IF NOT EXISTS bom_change_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id       INTEGER NOT NULL,
  change_type  TEXT NOT NULL,      -- create | line_add | line_edit | line_del | activate | archive | version_up
  entity       TEXT DEFAULT '',    -- header | line | operation | output
  entity_id    INTEGER,
  before_json  TEXT DEFAULT '',
  after_json   TEXT DEFAULT '',
  reason       TEXT DEFAULT '',
  date         TEXT DEFAULT '',
  created_by   INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(bom_id) REFERENCES bom_headers(id)
);
CREATE INDEX IF NOT EXISTS ix_bomlog ON bom_change_log(bom_id, created_at);
```

### 2.2 نرخ سربار مراکز هزینه

```sql
CREATE TABLE IF NOT EXISTS cost_center_rates (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_center_id         INTEGER NOT NULL,
  period_label           TEXT NOT NULL,           -- '1405/04'  یا  '1405' برای سالانه
  period_type            TEXT DEFAULT 'month',    -- month | year
  driver                 TEXT NOT NULL,           -- snapshot از cost_centers.driver
  budget_fixed_oh_rial   INTEGER DEFAULT 0,       -- سربار ثابت بودجه‌شده
  budget_var_oh_rial     INTEGER DEFAULT 0,       -- سربار متغیر بودجه‌شده
  budget_driver_qty      REAL DEFAULT 0,          -- ظرفیت/محرک بودجه‌شده
  fixed_rate_rial        INTEGER DEFAULT 0,       -- budget_fixed / budget_driver_qty
  var_rate_rial          INTEGER DEFAULT 0,       -- budget_var   / budget_driver_qty
  total_rate_rial        INTEGER DEFAULT 0,       -- fixed + var
  actual_oh_rial         INTEGER DEFAULT 0,       -- پر می‌شود در بستن ماه
  actual_driver_qty      REAL DEFAULT 0,
  applied_oh_rial        INTEGER DEFAULT 0,
  variance_rial          INTEGER DEFAULT 0,       -- actual − applied
  status                 TEXT DEFAULT 'draft',    -- draft | active | closed
  is_estimated           INTEGER DEFAULT 0,       -- نرخ Bootstrap؟
  note                   TEXT DEFAULT '',
  created_by             INTEGER,
  created_at             INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ccrate ON cost_center_rates(cost_center_id, period_label);

-- قواعد تسهیم هزینه‌ای که به چند مرکز مربوط است
CREATE TABLE IF NOT EXISTS overhead_allocation_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,                   -- «اجاره کارگاه»
  expense_match  TEXT DEFAULT '',                 -- category یا title الگو
  basis          TEXT NOT NULL,                   -- area | headcount | machine_hours | output_qty | manual
  active         INTEGER DEFAULT 1,
  created_at     INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS overhead_allocation_weights (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id        INTEGER NOT NULL,
  cost_center_id INTEGER NOT NULL,
  weight         REAL NOT NULL DEFAULT 0,         -- متراژ / تعداد نفر / ...
  FOREIGN KEY(rule_id)        REFERENCES overhead_allocation_rules(id) ON DELETE CASCADE,
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ohw ON overhead_allocation_weights(rule_id, cost_center_id);
```

### 2.3 سفارش تولید (هسته)

```sql
CREATE TABLE IF NOT EXISTS production_orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no           TEXT NOT NULL,               -- PO-1405-0001
  product_id         INTEGER NOT NULL,
  bom_id             INTEGER,                     -- NULL فقط برای legacy
  bom_version        INTEGER,                     -- snapshot
  analysis_type      TEXT NOT NULL DEFAULT 'fixed',
       -- fixed | variable | fixed_adv | variable_adv
  production_mode    TEXT NOT NULL DEFAULT 'MTS', -- MTS | MTO
  sales_order_id     INTEGER,                     -- orders.id   (فقط MTO)
  b2b_order_id       INTEGER,                     -- b2b_portal_orders.id
  customer_id        INTEGER,
  qty_planned        REAL NOT NULL,
  qty_produced       REAL DEFAULT 0,              -- سالم پذیرفته‌شده
  qty_waste_normal   REAL DEFAULT 0,
  qty_waste_abnormal REAL DEFAULT 0,
  qty_scrap_salable  REAL DEFAULT 0,
  qty_rework         REAL DEFAULT 0,
  size_breakdown     TEXT DEFAULT '',             -- JSON {"38":20,"40":40,...}
  color              TEXT DEFAULT '',
  warehouse_raw_id   INTEGER,
  warehouse_fg_id    INTEGER,
  cost_center_id     INTEGER,                     -- مرکز اصلی (تک‌مرحله‌ای)
  coa_wip_tafsili    TEXT,                        -- کد تفصیلی WIP این سفارش
  status             TEXT DEFAULT 'draft',
       -- draft | released | in_progress | completed | closed | cancelled
  priority           INTEGER DEFAULT 5,           -- 1..9
  planned_start      TEXT DEFAULT '',
  planned_end        TEXT DEFAULT '',
  actual_start       TEXT DEFAULT '',
  actual_end         TEXT DEFAULT '',
  date               TEXT NOT NULL,               -- تاریخ سند
  period_label       TEXT DEFAULT '',             -- '1405/04'
  fiscal_year_id     INTEGER,
  -- هزینه‌های تجمیعی (ریال)
  material_cost_rial     INTEGER DEFAULT 0,
  packaging_cost_rial    INTEGER DEFAULT 0,
  labor_cost_rial        INTEGER DEFAULT 0,
  overhead_cost_rial     INTEGER DEFAULT 0,
  subcontract_cost_rial  INTEGER DEFAULT 0,
  rework_cost_rial       INTEGER DEFAULT 0,
  abnormal_waste_rial    INTEGER DEFAULT 0,       -- کسر می‌شود از WIP
  scrap_credit_rial      INTEGER DEFAULT 0,       -- کسر می‌شود از WIP
  byproduct_credit_rial  INTEGER DEFAULT 0,
  total_cost_rial        INTEGER DEFAULT 0,       -- خالص منتقل به FG
  unit_cost_rial         INTEGER DEFAULT 0,
  variance_applied_rial  INTEGER DEFAULT 0,       -- انحراف تسهیم‌شده در بستن ماه
  -- استاندارد (برای مقایسه)
  std_material_rial      INTEGER DEFAULT 0,
  std_labor_rial         INTEGER DEFAULT 0,
  std_overhead_rial      INTEGER DEFAULT 0,
  std_total_rial         INTEGER DEFAULT 0,
  std_unit_rial          INTEGER DEFAULT 0,
  --
  estimate_id        INTEGER,                     -- از کدام برآورد آمده
  note               TEXT DEFAULT '',
  closed_by          INTEGER,
  closed_at          INTEGER,
  cancelled_reason   TEXT DEFAULT '',
  created_by         INTEGER,
  created_at         INTEGER DEFAULT (strftime('%s','now')),
  updated_at         INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(product_id)     REFERENCES products(id),
  FOREIGN KEY(bom_id)         REFERENCES bom_headers(id),
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_po_no ON production_orders(order_no);
CREATE INDEX IF NOT EXISTS ix_po_status ON production_orders(status, date);
CREATE INDEX IF NOT EXISTS ix_po_prod   ON production_orders(product_id, date);
CREATE INDEX IF NOT EXISTS ix_po_period ON production_orders(period_label, status);
CREATE INDEX IF NOT EXISTS ix_po_so     ON production_orders(sales_order_id);
```

### 2.4 مراحل سفارش (ماژول ۷ و ۸)

```sql
CREATE TABLE IF NOT EXISTS production_order_stages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  cost_center_id     INTEGER NOT NULL,
  operation_id       INTEGER,                     -- bom_operations.id snapshot
  operation_name     TEXT DEFAULT '',
  status             TEXT DEFAULT 'pending',      -- pending | in_progress | done | skipped | blocked
  qty_in             REAL DEFAULT 0,              -- ورودی از مرحله قبل
  qty_out            REAL DEFAULT 0,              -- خروجی سالم
  qty_waste_normal   REAL DEFAULT 0,
  qty_waste_abnormal REAL DEFAULT 0,
  qty_rework         REAL DEFAULT 0,
  qty_scrap_salable  REAL DEFAULT 0,
  labor_hours        REAL DEFAULT 0,
  machine_hours      REAL DEFAULT 0,
  driver             TEXT DEFAULT '',
  driver_qty         REAL DEFAULT 0,
  -- هزینه‌های این مرحله (ریال)
  material_in_rial      INTEGER DEFAULT 0,        -- منتقل‌شده از مرحله قبل
  material_added_rial   INTEGER DEFAULT 0,        -- مواد افزوده در این مرحله
  labor_rial            INTEGER DEFAULT 0,
  overhead_rial         INTEGER DEFAULT 0,
  subcontract_rial      INTEGER DEFAULT 0,
  waste_abnormal_rial   INTEGER DEFAULT 0,
  scrap_credit_rial     INTEGER DEFAULT 0,
  cost_out_rial         INTEGER DEFAULT 0,        -- منتقل به مرحله بعد
  unit_cost_out_rial    INTEGER DEFAULT 0,
  --
  is_subcontract     INTEGER DEFAULT 0,
  supplier_id        INTEGER,
  started_at         TEXT DEFAULT '',
  ended_at           TEXT DEFAULT '',
  qc_passed          INTEGER,
  qc_note            TEXT DEFAULT '',
  note               TEXT DEFAULT '',
  created_by         INTEGER,
  created_at         INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id)       REFERENCES production_orders(id) ON DELETE CASCADE,
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pos ON production_order_stages(order_id, seq);
CREATE INDEX IF NOT EXISTS ix_pos_status ON production_order_stages(status, cost_center_id);
```

### 2.5 حواله مواد

```sql
CREATE TABLE IF NOT EXISTS production_material_issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',               -- MI-1405-0001
  order_id         INTEGER NOT NULL,
  stage_id         INTEGER,                       -- production_order_stages.id
  cost_center_id   INTEGER,
  product_id       INTEGER NOT NULL,
  bom_line_id      INTEGER,
  issue_type       TEXT DEFAULT 'issue',
       -- issue | backflush | return | substitute | rework_issue | adjust
  qty_standard     REAL DEFAULT 0,                -- طبق فرمول
  qty_actual       REAL NOT NULL,                 -- واقعاً مصرف‌شده (منفی = برگشت)
  qty_variance     REAL DEFAULT 0,                -- actual − standard
  unit_cost_rial   INTEGER NOT NULL,              -- میانگین موزون لحظه صدور
  std_cost_rial    INTEGER DEFAULT 0,             -- نرخ استاندارد
  amount_rial      INTEGER NOT NULL,              -- qty_actual × unit_cost_rial
  std_amount_rial  INTEGER DEFAULT 0,             -- qty_standard × std_cost_rial
  var_price_rial   INTEGER DEFAULT 0,             -- انحراف نرخ
  var_qty_rial     INTEGER DEFAULT 0,             -- انحراف مقدار
  warehouse_id     INTEGER NOT NULL,
  substitute_of_product_id INTEGER,
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,                       -- journal_entries.id
  reversed_je_id   INTEGER,
  status           TEXT DEFAULT 'posted',         -- posted | reversed
  note             TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id)   REFERENCES production_orders(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS ix_mi_order ON production_material_issues(order_id, date);
CREATE INDEX IF NOT EXISTS ix_mi_prod  ON production_material_issues(product_id, date);
CREATE INDEX IF NOT EXISTS ix_mi_je    ON production_material_issues(je_id);
```

### 2.6 دستمزد

```sql
CREATE TABLE IF NOT EXISTS production_labor_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',
  order_id         INTEGER NOT NULL,
  stage_id         INTEGER,
  cost_center_id   INTEGER NOT NULL,
  person_id        INTEGER,                       -- persons.id
  payroll_record_id INTEGER,                      -- اتصال به حقوق ماهانه
  supplier_id      INTEGER,                       -- برای contract
  method           TEXT NOT NULL DEFAULT 'piece',
       -- piece | hourly | monthly | contract
  qty              REAL DEFAULT 0,                -- تعداد (piece / contract)
  hours            REAL DEFAULT 0,                -- ساعت (hourly)
  std_hours        REAL DEFAULT 0,                -- ساعت استاندارد (برای انحراف کارایی)
  rate_rial        INTEGER DEFAULT 0,             -- نرخ واقعی
  std_rate_rial    INTEGER DEFAULT 0,             -- نرخ استاندارد
  amount_rial      INTEGER NOT NULL,
  std_amount_rial  INTEGER DEFAULT 0,
  var_rate_rial    INTEGER DEFAULT 0,             -- (نرخ واقعی − استاندارد) × ساعت واقعی
  var_eff_rial     INTEGER DEFAULT 0,             -- (ساعت واقعی − استاندارد) × نرخ استاندارد
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,
  reversed_je_id   INTEGER,
  status           TEXT DEFAULT 'posted',
  note             TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES production_orders(id)
);
CREATE INDEX IF NOT EXISTS ix_lab_order  ON production_labor_entries(order_id, date);
CREATE INDEX IF NOT EXISTS ix_lab_person ON production_labor_entries(person_id, period_label);
CREATE INDEX IF NOT EXISTS ix_lab_cc     ON production_labor_entries(cost_center_id, period_label);
```

### 2.7 جذب سربار

```sql
CREATE TABLE IF NOT EXISTS production_overhead_applications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',
  order_id         INTEGER NOT NULL,
  stage_id         INTEGER,
  cost_center_id   INTEGER NOT NULL,
  rate_id          INTEGER,                       -- cost_center_rates.id
  driver           TEXT NOT NULL,
  driver_qty       REAL NOT NULL,
  fixed_rate_rial  INTEGER DEFAULT 0,
  var_rate_rial    INTEGER DEFAULT 0,
  rate_rial        INTEGER NOT NULL,
  amount_rial      INTEGER NOT NULL,
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,
  reversed_je_id   INTEGER,
  status           TEXT DEFAULT 'posted',
  note             TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id)       REFERENCES production_orders(id),
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE INDEX IF NOT EXISTS ix_oh_order ON production_overhead_applications(order_id);
CREATE INDEX IF NOT EXISTS ix_oh_cc    ON production_overhead_applications(cost_center_id, period_label);
```

### 2.8 ضایعات و دوباره‌کاری

```sql
CREATE TABLE IF NOT EXISTS production_waste (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',
  order_id         INTEGER NOT NULL,
  stage_id         INTEGER,
  cost_center_id   INTEGER,
  product_id       INTEGER,                       -- کالای ضایع (یا محصول نیمه‌ساخته)
  scrap_product_id INTEGER,                       -- کالای ضایعات قابل فروش (اگر salable)
  waste_type       TEXT NOT NULL,
       -- normal | abnormal | salable | rework
  qty              REAL NOT NULL,
  allowed_qty      REAL DEFAULT 0,                -- سقف عادی مجاز (طبق درصد)
  unit_cost_rial   INTEGER DEFAULT 0,
  amount_rial      INTEGER DEFAULT 0,
  nrv_unit_rial    INTEGER DEFAULT 0,             -- برای salable
  nrv_amount_rial  INTEGER DEFAULT 0,
  warehouse_id     INTEGER,                       -- انبار ورود ضایعات فروشی
  reason_code      TEXT DEFAULT '',               -- fabric_defect | sewing_error | wash_damage | measurement | other
  reason_note      TEXT DEFAULT '',
  responsible_person_id INTEGER,
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,
  reversed_je_id   INTEGER,
  status           TEXT DEFAULT 'posted',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES production_orders(id)
);
CREATE INDEX IF NOT EXISTS ix_waste_order ON production_waste(order_id, waste_type);
CREATE INDEX IF NOT EXISTS ix_waste_cc    ON production_waste(cost_center_id, period_label);

CREATE TABLE IF NOT EXISTS production_rework (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',
  order_id         INTEGER NOT NULL,
  origin_stage_id  INTEGER,                       -- کجا خراب شد
  rework_stage_id  INTEGER,                       -- کجا اصلاح می‌شود
  qty              REAL NOT NULL,
  classification   TEXT DEFAULT 'normal',         -- normal | abnormal
  material_rial    INTEGER DEFAULT 0,
  labor_rial       INTEGER DEFAULT 0,
  overhead_rial    INTEGER DEFAULT 0,
  total_rial       INTEGER DEFAULT 0,
  qty_recovered    REAL DEFAULT 0,                -- برگشت به خط سالم
  qty_failed       REAL DEFAULT 0,                -- تبدیل به ضایعات
  reason_code      TEXT DEFAULT '',
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,
  status           TEXT DEFAULT 'posted',
  note             TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES production_orders(id)
);
```

### 2.9 رسید کالای ساخته‌شده

```sql
CREATE TABLE IF NOT EXISTS production_receipts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no           TEXT DEFAULT '',               -- PR-1405-0001
  order_id         INTEGER NOT NULL,
  stage_id         INTEGER,
  product_id       INTEGER NOT NULL,
  output_type      TEXT DEFAULT 'main',           -- main | co | by | scrap
  qty              REAL NOT NULL,
  unit_cost_rial   INTEGER NOT NULL,
  amount_rial      INTEGER NOT NULL,
  cost_method      TEXT DEFAULT 'share',
  warehouse_id     INTEGER NOT NULL,
  size_breakdown   TEXT DEFAULT '',
  is_partial       INTEGER DEFAULT 0,             -- رسید جزئی
  prev_avg_rial    INTEGER DEFAULT 0,             -- میانگین قبل (برای Undo)
  prev_stock_qty   REAL DEFAULT 0,
  new_avg_rial     INTEGER DEFAULT 0,
  date             TEXT NOT NULL,
  period_label     TEXT DEFAULT '',
  je_id            INTEGER,
  reversed_je_id   INTEGER,
  status           TEXT DEFAULT 'posted',
  note             TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id)   REFERENCES production_orders(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS ix_pr_order ON production_receipts(order_id);
CREATE INDEX IF NOT EXISTS ix_pr_prod  ON production_receipts(product_id, date);
```

### 2.10 پیمانکاری (ساخت خارج)

```sql
CREATE TABLE IF NOT EXISTS production_subcontract (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no            TEXT DEFAULT '',
  order_id          INTEGER NOT NULL,
  stage_id          INTEGER,
  supplier_id       INTEGER NOT NULL,
  direction         TEXT NOT NULL,                -- out | in
  product_id        INTEGER NOT NULL,             -- نیمه‌ساخته ارسالی/دریافتی
  qty               REAL NOT NULL,
  unit_cost_rial    INTEGER DEFAULT 0,            -- بهای کالای ارسالی
  amount_rial       INTEGER DEFAULT 0,
  fee_unit_rial     INTEGER DEFAULT 0,            -- کارمزد هر عدد (فقط in)
  fee_amount_rial   INTEGER DEFAULT 0,
  vat_rial          INTEGER DEFAULT 0,
  qty_returned      REAL DEFAULT 0,
  qty_lost          REAL DEFAULT 0,               -- کسری نزد پیمانکار
  warehouse_id      INTEGER,
  purchase_invoice_id INTEGER,                    -- اگر فاکتور خرید خدمت صادر شد
  date              TEXT NOT NULL,
  period_label      TEXT DEFAULT '',
  je_id             INTEGER,
  status            TEXT DEFAULT 'posted',
  note              TEXT DEFAULT '',
  created_by        INTEGER,
  created_at        INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id)    REFERENCES production_orders(id),
  FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
);
CREATE INDEX IF NOT EXISTS ix_sub_order ON production_subcontract(order_id, direction);
```

### 2.11 انحرافات

```sql
CREATE TABLE IF NOT EXISTS production_variances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label    TEXT NOT NULL,
  order_id        INTEGER,                        -- NULL = انحراف سطح دوره
  cost_center_id  INTEGER,
  variance_type   TEXT NOT NULL,
       -- material_price | material_qty | labor_rate | labor_eff
       -- | oh_budget | oh_volume | oh_spending | mix | yield
  amount_rial     INTEGER NOT NULL,               -- + نامساعد / − مساعد
  favorable       INTEGER DEFAULT 0,              -- 1 = مساعد
  basis_json      TEXT DEFAULT '',                -- جزئیات محاسبه
  allocation_json TEXT DEFAULT '',                -- {"wip":x,"fg":y,"cogs":z}
  alloc_wip_rial  INTEGER DEFAULT 0,
  alloc_fg_rial   INTEGER DEFAULT 0,
  alloc_cogs_rial INTEGER DEFAULT 0,
  je_id           INTEGER,
  close_id        INTEGER,                        -- production_period_close.id
  status          TEXT DEFAULT 'open',            -- open | allocated | reversed
  created_at      INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES production_orders(id)
);
CREATE INDEX IF NOT EXISTS ix_var_period ON production_variances(period_label, variance_type);
```

### 2.12 بستن دوره

```sql
CREATE TABLE IF NOT EXISTS production_period_close (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label          TEXT NOT NULL,            -- '1405/04'
  fiscal_year_id        INTEGER,
  start_date            TEXT NOT NULL,
  end_date              TEXT NOT NULL,
  status                TEXT DEFAULT 'open',      -- open | calculating | review | closed | reopened
  -- تجمیع‌ها (ریال)
  total_material_rial   INTEGER DEFAULT 0,
  total_labor_rial      INTEGER DEFAULT 0,
  total_oh_actual_rial  INTEGER DEFAULT 0,
  total_oh_applied_rial INTEGER DEFAULT 0,
  total_produced_rial   INTEGER DEFAULT 0,
  wip_open_rial         INTEGER DEFAULT 0,
  wip_close_rial        INTEGER DEFAULT 0,
  fg_close_rial         INTEGER DEFAULT 0,
  cogs_rial             INTEGER DEFAULT 0,
  total_variance_rial   INTEGER DEFAULT 0,
  variance_to_wip_rial  INTEGER DEFAULT 0,
  variance_to_fg_rial   INTEGER DEFAULT 0,
  variance_to_cogs_rial INTEGER DEFAULT 0,
  method                TEXT DEFAULT 'proration', -- proration | direct_cogs
  threshold_pct         REAL DEFAULT 0.5,
  je_id                 INTEGER,                  -- سند بستن
  reversed_je_id        INTEGER,
  checklist_json        TEXT DEFAULT '',
  closed_by             INTEGER,
  closed_at             INTEGER,
  reopened_by           INTEGER,
  reopened_at           INTEGER,
  reopen_reason         TEXT DEFAULT '',
  note                  TEXT DEFAULT '',
  created_at            INTEGER DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ppc ON production_period_close(period_label);
```

### 2.13 برآورد تولید (ماژول ۵)

```sql
CREATE TABLE IF NOT EXISTS production_estimates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL,              -- EST-1405-0001
  title               TEXT DEFAULT '',
  estimate_type       TEXT DEFAULT 'both',        -- cost | mrp | both
  product_id          INTEGER,
  bom_id              INTEGER,
  qty                 REAL NOT NULL DEFAULT 1,
  size_breakdown      TEXT DEFAULT '',
  customer_id         INTEGER,
  sales_order_id      INTEGER,
  price_basis         TEXT DEFAULT 'average',     -- average | last_purchase | std | manual | market
  -- برآورد بهای تمام‌شده (ریال)
  est_material_rial   INTEGER DEFAULT 0,
  est_packaging_rial  INTEGER DEFAULT 0,
  est_labor_rial      INTEGER DEFAULT 0,
  est_overhead_rial   INTEGER DEFAULT 0,
  est_subcontract_rial INTEGER DEFAULT 0,
  est_waste_rial      INTEGER DEFAULT 0,
  est_total_rial      INTEGER DEFAULT 0,
  est_unit_rial       INTEGER DEFAULT 0,
  -- قیمت‌گذاری
  margin_percent      REAL DEFAULT 35,            -- قاعده ترنم: ۳۵٪ از بالای بهای تمام‌شده
  suggested_price_rial INTEGER DEFAULT 0,
  actual_unit_rial    INTEGER DEFAULT 0,          -- پس از تولید — برای بازخورد
  accuracy_percent    REAL DEFAULT 0,
  -- MRP
  mrp_shortage_count  INTEGER DEFAULT 0,
  mrp_feasible        INTEGER DEFAULT 1,
  mrp_earliest_date   TEXT DEFAULT '',
  --
  valid_until         TEXT DEFAULT '',
  status              TEXT DEFAULT 'draft',       -- draft | confirmed | converted | expired | rejected
  converted_order_id  INTEGER,
  date                TEXT NOT NULL,
  note                TEXT DEFAULT '',
  created_by          INTEGER,
  created_at          INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(bom_id)     REFERENCES bom_headers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_est_code ON production_estimates(code);

CREATE TABLE IF NOT EXISTS production_estimate_lines (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id        INTEGER NOT NULL,
  level              INTEGER DEFAULT 0,           -- عمق در درخت BOM
  parent_line_id     INTEGER,
  product_id         INTEGER,
  cost_center_id     INTEGER,
  line_kind          TEXT NOT NULL,               -- material | packaging | labor | overhead | subcontract | waste
  qty_gross          REAL DEFAULT 0,              -- شامل ضایعات
  qty_net            REAL DEFAULT 0,
  unit_id            INTEGER,
  unit_cost_rial     INTEGER DEFAULT 0,
  amount_rial        INTEGER DEFAULT 0,
  price_source       TEXT DEFAULT '',             -- average | last_purchase | std | manual
  -- MRP
  on_hand_qty        REAL DEFAULT 0,
  reserved_qty       REAL DEFAULT 0,
  on_order_qty       REAL DEFAULT 0,
  available_qty      REAL DEFAULT 0,
  shortage_qty       REAL DEFAULT 0,
  lead_time_days     INTEGER DEFAULT 0,
  need_by_date       TEXT DEFAULT '',
  suggested_action   TEXT DEFAULT '',             -- ok | purchase | produce | transfer
  created_at         INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(estimate_id) REFERENCES production_estimates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_estline ON production_estimate_lines(estimate_id, line_kind);
```

### 2.14 MRP

```sql
CREATE TABLE IF NOT EXISTS mrp_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,                 -- MRP-1405-0001
  run_type         TEXT DEFAULT 'net',            -- net | gross | regenerative
  horizon_days     INTEGER DEFAULT 30,
  demand_source    TEXT DEFAULT 'orders',         -- orders | forecast | manual | mixed
  include_safety   INTEGER DEFAULT 1,
  include_on_order INTEGER DEFAULT 1,
  status           TEXT DEFAULT 'running',        -- running | done | failed
  total_shortage_items INTEGER DEFAULT 0,
  total_shortage_rial  INTEGER DEFAULT 0,
  date             TEXT NOT NULL,
  duration_ms      INTEGER DEFAULT 0,
  error            TEXT DEFAULT '',
  created_by       INTEGER,
  created_at       INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS mrp_requirements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER NOT NULL,
  product_id       INTEGER NOT NULL,
  level            INTEGER DEFAULT 0,
  gross_req_qty    REAL DEFAULT 0,
  on_hand_qty      REAL DEFAULT 0,
  reserved_qty     REAL DEFAULT 0,
  on_order_qty     REAL DEFAULT 0,
  safety_stock     REAL DEFAULT 0,
  net_req_qty      REAL DEFAULT 0,
  suggested_qty    REAL DEFAULT 0,                -- گرد شده به min_order_qty
  action           TEXT DEFAULT '',               -- purchase | produce | none
  need_by_date     TEXT DEFAULT '',
  order_by_date    TEXT DEFAULT '',               -- need_by − lead_time
  est_cost_rial    INTEGER DEFAULT 0,
  supplier_id      INTEGER,
  converted_ref    TEXT DEFAULT '',               -- 'PO-...' یا 'PI-...'
  created_at       INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(run_id) REFERENCES mrp_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_mrpreq ON mrp_requirements(run_id, action);

-- رزرو موجودی برای سفارش‌های آزادشده
CREATE TABLE IF NOT EXISTS production_reservations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL,
  product_id     INTEGER NOT NULL,
  warehouse_id   INTEGER NOT NULL,
  qty            REAL NOT NULL,
  qty_consumed   REAL DEFAULT 0,
  status         TEXT DEFAULT 'active',           -- active | consumed | released
  date           TEXT DEFAULT '',
  created_at     INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES production_orders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_resv ON production_reservations(product_id, warehouse_id, status);
```

### 2.15 زیرساخت

```sql
-- بی‌قدرتی (Idempotency)
CREATE TABLE IF NOT EXISTS production_idempotency (
  key          TEXT PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  user_id      INTEGER,
  response_json TEXT DEFAULT '',
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- صف رویدادها (برای notification و AI)
CREATE TABLE IF NOT EXISTS production_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER,
  payload_json TEXT DEFAULT '',
  processed    INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS ix_pevt ON production_events(processed, created_at);
```

---

## 3. Trigger های SQLite

```sql
-- ۱) به‌روزرسانی خودکار updated_at
CREATE TRIGGER IF NOT EXISTS trg_bom_updated AFTER UPDATE ON bom_headers
BEGIN
  UPDATE bom_headers SET updated_at = strftime('%s','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_po_updated AFTER UPDATE ON production_orders
BEGIN
  UPDATE production_orders SET updated_at = strftime('%s','now') WHERE id = NEW.id;
END;

-- ۲) فقط یک BOM پیش‌فرض فعال برای هر کالا
CREATE TRIGGER IF NOT EXISTS trg_bom_single_default
AFTER UPDATE OF is_default ON bom_headers WHEN NEW.is_default = 1
BEGIN
  UPDATE bom_headers SET is_default = 0
  WHERE product_id = NEW.product_id AND id <> NEW.id;
END;

-- ۳) قفل فرمول فعال — تغییر خط ممنوع
CREATE TRIGGER IF NOT EXISTS trg_bomline_lock_active
BEFORE UPDATE ON bom_lines
BEGIN
  SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل ویرایش نیست؛ نسخه جدید بسازید')
  WHERE (SELECT status FROM bom_headers WHERE id = NEW.bom_id) = 'active';
END;

CREATE TRIGGER IF NOT EXISTS trg_bomline_lock_delete
BEFORE DELETE ON bom_lines
BEGIN
  SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل حذف نیست')
  WHERE (SELECT status FROM bom_headers WHERE id = OLD.bom_id) = 'active';
END;

-- ۴) عدم ثبت در ماه بسته‌شده
CREATE TRIGGER IF NOT EXISTS trg_mi_period_lock
BEFORE INSERT ON production_material_issues
BEGIN
  SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
  WHERE EXISTS (SELECT 1 FROM production_period_close
                WHERE period_label = NEW.period_label AND status = 'closed');
END;
-- (همین trigger برای: production_labor_entries, production_overhead_applications,
--  production_receipts, production_waste, production_rework, production_subcontract)

-- ۵) عدم موجودی منفی روی warehouse_stock
CREATE TRIGGER IF NOT EXISTS trg_ws_no_negative
BEFORE UPDATE ON warehouse_stock WHEN NEW.qty < 0
BEGIN
  SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود');
END;

-- ۶) خودارجاعی BOM ممنوع (سطح ۱ — سطوح عمیق‌تر در کد چک می‌شود)
CREATE TRIGGER IF NOT EXISTS trg_bom_no_self
BEFORE INSERT ON bom_lines
BEGIN
  SELECT RAISE(ABORT, 'E_BOM_SELF_REF: کالا نمی‌تواند جزء فرمول خودش باشد')
  WHERE NEW.component_product_id = (SELECT product_id FROM bom_headers WHERE id = NEW.bom_id);
END;
```

> **نکته:** trigger های `sync_seq` و `tombstone` به‌صورت خودکار توسط `server/sync/capture.js` برای هر جدولِ ثبت‌شده در `SYNCABLE_TABLES` ساخته می‌شوند. کافیست جدول را در آن آرایه اضافه کنی.

---

## 4. افزودن به `SYNCABLE_TABLES` (فقط انتهای آرایه!)

```js
// server/sync/tables.js — APPEND ONLY, هرگز ترتیب قبلی را تغییر نده
const SYNCABLE_TABLES = [
  /* ...همه موارد موجود بدون تغییر... */

  // ===== Production module — appended 1405/04 =====
  { name: 'bom_headers',                      upsertKey: 'id' },
  { name: 'bom_lines',                        upsertKey: 'id' },
  { name: 'bom_operations',                   upsertKey: 'id' },
  { name: 'bom_outputs',                      upsertKey: 'id' },
  { name: 'bom_change_log',                   upsertKey: 'id' },
  { name: 'cost_center_rates',                upsertKey: 'id' },
  { name: 'overhead_allocation_rules',        upsertKey: 'id' },
  { name: 'overhead_allocation_weights',      upsertKey: 'id' },
  { name: 'production_orders',                upsertKey: 'id' },
  { name: 'production_order_stages',          upsertKey: 'id' },
  { name: 'production_material_issues',       upsertKey: 'id' },
  { name: 'production_labor_entries',         upsertKey: 'id' },
  { name: 'production_overhead_applications', upsertKey: 'id' },
  { name: 'production_waste',                 upsertKey: 'id' },
  { name: 'production_rework',                upsertKey: 'id' },
  { name: 'production_receipts',              upsertKey: 'id' },
  { name: 'production_subcontract',           upsertKey: 'id' },
  { name: 'production_variances',             upsertKey: 'id' },
  { name: 'production_period_close',          upsertKey: 'period_label' },
  { name: 'production_estimates',             upsertKey: 'id' },
  { name: 'production_estimate_lines',        upsertKey: 'id' },
  { name: 'mrp_runs',                         upsertKey: 'id' },
  { name: 'mrp_requirements',                 upsertKey: 'id' },
  { name: 'production_reservations',          upsertKey: 'id' },
];
```

---

## 5. دنباله شماره‌گذاری (`number_sequences`)

```js
// در initDB بعد از ساخت جداول
const PROD_SEQUENCES = [
  { key: 'production_order',   prefix: 'PO' },
  { key: 'material_issue',     prefix: 'MI' },
  { key: 'production_receipt', prefix: 'PR' },
  { key: 'labor_entry',        prefix: 'LB' },
  { key: 'overhead_apply',     prefix: 'OH' },
  { key: 'production_waste',   prefix: 'WS' },
  { key: 'production_rework',  prefix: 'RW' },
  { key: 'subcontract',        prefix: 'SC' },
  { key: 'bom',                prefix: 'BOM' },
  { key: 'estimate',           prefix: 'EST' },
  { key: 'mrp_run',            prefix: 'MRP' },
];
// استفاده: allocateNumber(db, 'production_order', 'PO')  →  'PO-1405-0001'
```

---

## 6. تنظیمات جدید (`settings`)

| کلید | پیش‌فرض | شرح |
|------|---------|-----|
| `production_costing_method` | `moving_average` | فقط همین پشتیبانی می‌شود |
| `production_variance_method` | `proration` | `proration` \| `direct_cogs` |
| `production_variance_threshold_pct` | `0.5` | زیر این درصد → مستقیم COGS |
| `production_normal_waste_default_pct` | `3` | ضایعات عادی پیش‌فرض |
| `production_auto_post_je` | `1` | ثبت خودکار سند |
| `production_backflush_on_receipt` | `1` | Backflush هنگام رسید (آنالیز ثابت) |
| `production_allow_negative_stock` | `0` | **هرگز ۱ نشود** |
| `production_wh_raw_id` | — | شناسه انبار مواد |
| `production_wh_fg_id` | — | شناسه انبار محصول |
| `production_wh_sub_id` | — | شناسه انبار امانی |
| `production_wh_scrap_id` | — | شناسه انبار ضایعات |
| `production_default_analysis` | `fixed` | نوع آنالیز پیش‌فرض |
| `production_cost_deviation_alert_pct` | `15` | آستانه هشدار انحراف |
| `production_labor_methods_enabled` | `piece,monthly` | روش‌های فعال دستمزد |
| `production_oh_bootstrap_months` | `3` | ماه‌های مبنا برای نرخ اولیه |
| `production_mrp_horizon_days` | `30` | افق MRP |
| `production_period_auto_open` | `1` | باز کردن خودکار ماه جدید |

---

## 7. داده اولیه (Seed)

```js
// مراکز هزینه ترنم
const TARANOM_COST_CENTERS = [
  { code:'CC-10', name:'برش',                seq:10, is_stage:1, kind:'production', driver:'material_rial',     default_labor_method:'monthly' },
  { code:'CC-20', name:'گلدوزی',             seq:20, is_stage:1, kind:'production', driver:'machine_hours',     default_labor_method:'piece'   },
  { code:'CC-30', name:'دوخت',               seq:30, is_stage:1, kind:'production', driver:'direct_labor_rial', default_labor_method:'piece'   },
  { code:'CC-40', name:'دکمه و یراق',        seq:40, is_stage:1, kind:'production', driver:'output_qty',        default_labor_method:'piece'   },
  { code:'CC-50', name:'شستشو',              seq:50, is_stage:1, kind:'production', driver:'output_qty',        default_labor_method:'contract'},
  { code:'CC-60', name:'اتو و بسته‌بندی',    seq:60, is_stage:1, kind:'production', driver:'output_qty',        default_labor_method:'monthly' },
  { code:'CC-90', name:'انبار محصول',        seq:90, is_stage:0, kind:'service',    driver:'manual',            default_labor_method:'monthly' },
];

// انبارها
const TARANOM_WAREHOUSES = [
  { name:'انبار مواد اولیه — کارگاه نبوت',  kind:'raw'         },
  { name:'انبار کالای ساخته‌شده — نبوت',    kind:'finished'    },
  { name:'انبار دفتر پخش — کیمیا',          kind:'finished'    },
  { name:'امانی نزد پیمانکار',              kind:'subcontract' },
  { name:'انبار ضایعات',                    kind:'scrap'       },
];

// حساب‌های تولید (فقط اگر وجود ندارند)
const PRODUCTION_ACCOUNTS = [
  { code:'1110', name:'موجودی مواد اولیه',            type:'دارایی', parent_code:'11' },
  { code:'1111', name:'کالای در جریان ساخت',          type:'دارایی', parent_code:'11' },
  { code:'1112', name:'موجودی مواد بسته‌بندی',        type:'دارایی', parent_code:'11' },
  { code:'1113', name:'موجودی ضایعات قابل فروش',      type:'دارایی', parent_code:'11' },
  { code:'1114', name:'موجودی نزد پیمانکار',          type:'دارایی', parent_code:'11' },
  { code:'5201', name:'کنترل دستمزد مستقیم',          type:'هزینه',  parent_code:'52' },
  { code:'5202', name:'کنترل سربار ساخت',             type:'هزینه',  parent_code:'52' },
  { code:'5203', name:'سربار جذب‌شده',                type:'هزینه',  parent_code:'52' },
  { code:'5210', name:'انحراف نرخ مواد',              type:'هزینه',  parent_code:'52' },
  { code:'5211', name:'انحراف مقدار مواد',            type:'هزینه',  parent_code:'52' },
  { code:'5212', name:'انحراف نرخ دستمزد',            type:'هزینه',  parent_code:'52' },
  { code:'5213', name:'انحراف کارایی دستمزد',         type:'هزینه',  parent_code:'52' },
  { code:'5214', name:'انحراف بودجه سربار',           type:'هزینه',  parent_code:'52' },
  { code:'5215', name:'انحراف حجم سربار',             type:'هزینه',  parent_code:'52' },
  { code:'5221', name:'هزینه ضایعات غیرعادی',         type:'هزینه',  parent_code:'52' },
  { code:'5222', name:'هزینه دوباره‌کاری',            type:'هزینه',  parent_code:'52' },
  { code:'5230', name:'کارمزد ساخت پیمانکاری',        type:'هزینه',  parent_code:'52' },
];
```

---

## 8. نمونه داده واقعی ترنم — «مانتو کتان مدل ترمه»

```js
// کالاها
products:
  #101 مانتو کتان ترمه — سبز       item_type='finished', is_manufactured=1, unit='عدد'
  #201 پارچه کتان ۱۴۰ سانت — سبز   item_type='raw', unit='متر',  average_cost_rial= 950_000
  #202 آستر ساده                    item_type='raw', unit='متر',  average_cost_rial= 180_000
  #203 نخ دوخت پلی‌استر            item_type='raw', unit='قرقره', average_cost_rial=  85_000
  #204 دکمه چوبی ۲۰ میل             item_type='raw', unit='عدد',  average_cost_rial=  12_000
  #205 لیبل برند ترنم               item_type='packaging', unit='عدد', average_cost_rial= 6_000
  #206 نایلون بسته‌بندی             item_type='packaging', unit='عدد', average_cost_rial= 9_000
  #299 ضایعات پارچه (خرده)          item_type='scrap', unit='کیلوگرم', average_cost_rial=0

// فرمول
bom_headers #1:
  code='BOM-000101', product_id=101, version=1, revision='A',
  base_qty=1, status='active', valid_from='1405/01/01', is_default=1,
  is_multilevel=1, has_routing=1, yield_percent=97, size_range='38-48'

bom_lines:
  1 | #201 پارچه کتان   | qty_per_base=1.60 متر | scrap_percent=4 | stage=CC-10 برش
      size_matrix = {"38":1.45,"40":1.50,"42":1.55,"44":1.60,"46":1.70,"48":1.80}
  2 | #202 آستر         | qty_per_base=0.35 متر | scrap_percent=3 | stage=CC-10
  3 | #203 نخ           | qty_per_base=0.08 قرقره| scrap_percent=0 | stage=CC-30 دوخت
  4 | #204 دکمه         | qty_per_base=6 عدد     | scrap_percent=2 | stage=CC-40
  5 | #205 لیبل         | qty_per_base=1 عدد     | line_type='packaging' | stage=CC-60
  6 | #206 نایلون       | qty_per_base=1 عدد     | line_type='packaging' | stage=CC-60

bom_operations:
  10 | CC-10 برش    | setup=30 دقیقه | run=1.2 دق/عدد | labor='monthly' | normal_waste=2%
  20 | CC-20 گلدوزی | setup=15        | run=3.0        | labor='piece' rate=45_000 | machine=3.0
  30 | CC-30 دوخت   | setup=20        | run=11.0       | labor='piece' rate=180_000 | normal_waste=1%
  40 | CC-40 یراق   | setup=5         | run=2.5        | labor='piece' rate=25_000
  50 | CC-50 شستشو  | setup=0         | run=0.5        | labor='contract' | is_subcontract=1 | fee=38_000 | normal_waste=1.5%
  60 | CC-60 اتو    | setup=0         | run=2.0        | labor='monthly' | is_qc_gate=1

bom_outputs:
  main  | #101 مانتو ترمه       | qty_per_base=1     | cost_method='share' | share=100%
  scrap | #299 خرده پارچه       | qty_per_base=0.09 کیلوگرم | cost_method='nrv' | nrv_rial=120_000
```

---

## 9. اسکریپت تأیید صحت (Health Check)

```sql
-- H1: WIP سفارش‌های بسته‌شده باید صفر باشد
SELECT po.order_no,
       po.material_cost_rial + po.labor_cost_rial + po.overhead_cost_rial
       + po.subcontract_cost_rial + po.rework_cost_rial
       - po.abnormal_waste_rial - po.scrap_credit_rial - po.byproduct_credit_rial
       - po.total_cost_rial AS wip_residual
FROM production_orders po
WHERE po.status = 'closed'
HAVING ABS(wip_residual) > 5;   -- باید خالی باشد

-- H2: تراز حساب‌های کنترلی پس از بستن ماه
SELECT jl.account_code, SUM(jl.debit_rial) - SUM(jl.credit_rial) AS bal
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.entry_id
WHERE jl.account_code IN ('5201','5202','5203')
  AND je.entry_date <= :end_of_month
  AND COALESCE(je.deleted_at,0)=0
GROUP BY jl.account_code
HAVING ABS(bal) > 5;             -- باید خالی باشد

-- H3: تطابق products.stock با warehouse_stock
SELECT p.id, p.name, p.stock, COALESCE(SUM(ws.qty),0) AS wh_total
FROM products p
LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
GROUP BY p.id
HAVING p.stock <> wh_total;      -- باید خالی باشد

-- H4: هر تراکنش تولید باید سند داشته باشد
SELECT 'material_issue' AS t, id FROM production_material_issues WHERE je_id IS NULL AND status='posted'
UNION ALL SELECT 'receipt', id FROM production_receipts WHERE je_id IS NULL AND status='posted'
UNION ALL SELECT 'labor',   id FROM production_labor_entries WHERE je_id IS NULL AND status='posted'
UNION ALL SELECT 'overhead',id FROM production_overhead_applications WHERE je_id IS NULL AND status='posted';

-- H5: میانگین موزون منفی یا صفر روی کالای موجود
SELECT id, name, stock, average_cost_rial FROM products
WHERE stock > 0 AND average_cost_rial <= 0 AND item_type IN ('raw','finished','semi');
```
