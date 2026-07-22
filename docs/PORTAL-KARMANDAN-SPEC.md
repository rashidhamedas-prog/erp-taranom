# پرتال کارمندان و خط تولید — دستور پیاده‌سازی برای Cursor

> **وضعیت پیاده‌سازی (2026-07-22):** هستهٔ ماژول (اسکیما، API، UI، RBAC، واگذاری، اعلان) از قبل در `crm-taranom` پیاده شده است.
> در این دور تکمیل شد: رمز موقت تصادفی+SMS، auto-approve بازبینی (۷۲h)، تبدیل به کالای pending+تأیید ادمین، تست E2E کامل، رفع انتقال کالا پس از تبدیل بین بخش‌ها.

> **این سند نسخهٔ بازنویسی‌شده و منطبق‌شده با معماری واقعی CRM ترنم است.**
> فایل خام اولیه (`portal_karmandan_.md`) یک اسپک ژنریک ERP بود که فرض‌های اشتباهی داشت
> (UUID، PostgreSQL، Prisma، NestJS/React، WebSocket، جدول کاربر جدا و …).
> اگر همان فایل عیناً به Cursor داده شود، ماژول با بقیهٔ برنامه ناسازگار می‌شود و
> **offline-sync، حسابداری دو طرفه، انبارداری و RBAC را خراب می‌کند.**
> این سند همان قابلیت را می‌خواهد، ولی روی زیرساخت واقعی پروژه سوار می‌کند.

- **نسخه:** ۲.۰ (منطبق‌شده) — مبدأ: portal_karmandan_ v1.0
- **هدف:** ماژول «پرتال واحدهای عملیاتی و خط تولید» — گردش‌کار ترتیبی یک *پارامتر* (بَچ تولید) بین *بخش‌ها* با قفل ترتیبی، پرتال مدیر واحد/مدیر بخش، ساخت خودکار کاربر، سند تولید خودکار روی تبدیل کالا، و سند حسابداری خودکار روی پرداخت.
- **مخاطب:** Cursor (روی همین مخزن، شاخهٔ `claude/claude-md-docs-2ssrpy`).

---

## چک‌لیست پیاده‌سازی

| مورد اسپک | وضعیت |
|---|---|
| اسکیما `op_*` + sync APPEND | Done |
| RBAC `portal` + unit/department_manager | Done |
| CRUD واحد/بخش + قفل ترتیب | Done |
| پارامتر + انتقال انبار + قفل ترتیبی | Done |
| پرداخت + JE + تبدیل + خروجی نهایی | Done |
| واگذاری موقت مدیر بخش | Done |
| UI timeline + بخش من | Done |
| رمز موقت تصادفی + SMS | Done (این دور) |
| auto-approve بازبینی ۷۲h | Done (این دور) |
| کالای pending روی convert | Done (این دور) |
| تست E2E `test-portal.js` | Done (این دور) |

---

## بخش ۰ — قواعد غیرقابل‌مذاکرهٔ این مخزن (قبل از هر خط کد بخوان)

1. **بک‌اند:** Node/Express + `better-sqlite3` در `server/`. **هیچ فریم‌ورک/ORM/DB جدیدی اضافه نشود** (نه Prisma، نه PostgreSQL، نه NestJS). مدل‌ها SQL خام با better-sqlite3.
2. **مهاجرت‌ها:** فایل مهاجرت جدا **نداریم**. همهٔ جدول‌ها/ستون‌ها به‌صورت idempotent داخل `server/db.js` → `initDB()` (با `CREATE TABLE IF NOT EXISTS`) و ستون‌های افزوده با `ensureColumn()` اضافه می‌شوند؛ روی هر boot اجرا می‌شود.
3. **فرانت:** تک‌فایل `server/public/index.html` (CSS+HTML+JS). React/Vue **ممنوع**. الگوی صفحه: ثبت در `ROUTES`، تب‌ها در `acc-nav.js` + `renderXxxTab()` + `loadAccTab`. هر فایل JS جداگانه‌ای که در صفحه لود می‌شود **باید IIFE-wrap شود** (متغیر `const x` سراسری کل اسکریپت صفحه را می‌شکند — سابقهٔ باگ داریم).
4. **پول:** همه‌جا **ریال، صحیح (INTEGER)**. هیچ float برای مبلغ. (مهاجرت Toman→Rial ×10 قبلاً انجام شده.)
5. **تاریخ‌ها:** رشتهٔ جلالی دستی (مثل `۱۴۰۵/۰۴/۲۷`) برای نمایش؛ timestampها **epoch عدد صحیح** با `strftime('%s','now')`.
6. **کلید اصلی:** `INTEGER PRIMARY KEY AUTOINCREMENT` — **نه UUID**. (سیستم sync برای دستگاه‌ها بازهٔ id رزرو می‌کند؛ UUID آن را می‌شکند.)
7. **تراکنش:** هر عملیات چندجمله‌ای (چند INSERT/UPDATE به هم وابسته) داخل `db.transaction(() => {...})`. اعتبارسنجی بیرون تراکنش.
8. **شماره‌گذاری اسناد:** از جدول اتمیک `number_sequences` (هرگز `COUNT(*)+1`).
9. **آفلاین‌فرست + Sync (مهم‌ترین اصلاحیه):** برنامه روی دسکتاپ/اندروید با `SYNC_ROLE=device` آفلاین کار می‌کند و بعداً همگام می‌شود. مدیران بخش «کف کارگاه» کار می‌کنند و اسپک هم offline خواسته. پس:
   - جدول‌های عملیاتی جدید **باید به انتهای آرایهٔ `server/sync/tables.js` → `SYNCABLE_TABLES` اضافه شوند** (این آرایه **APPEND-ONLY** است؛ ترتیب در فرمول id دستگاه‌ها استفاده می‌شود — جابه‌جا/حذف نکن).
   - مسیرهای mutating جدید به‌صورت خودکار در `sync/capture.js` ضبط و بازپخش می‌شوند؛ فقط سطوح «مرکزی‌فقط» (پیکربندی واحد/بخش) را با middleware `centralOnly` ببند.
10. **تست‌ها:** بعد از تغییر بک‌اند حتماً `node server/scripts/test-sms.js` و `node server/scripts/test-sync.js` و `npm --prefix server run test:production` سبز بمانند + یک تست جدید برای این ماژول. چک فرانت: بلوک `<script>` را از index.html استخراج و `new Function(it)`.
11. **Help + CHANGE-LOG (اجباری):** هر تغییر رفتاری → به‌روزرسانی راهنمای درون‌برنامه (`renderAdminGuide()`/`renderSalesGuide()`) + یک ورودی در `docs/CHANGE-LOG.md`، همه در همان commit.

---

## بخش ۱ — نگاشت مفاهیم اسپک به ماژول‌های موجود (اصلاحیه‌ها)

| مفهوم در اسپک خام | تصمیم | نگاشت در پروژه |
|---|---|---|
| «Persons Module» | **استفاده مجدد** | جدول `persons` (id, name, phone, …) + `routes/persons.js`. مدیر واحد/بخش = یک `person`. |
| «Auto user account» (username=phone, pass=`12345`) | **استفاده مجدد + امن‌سازی** | جدول موجود `users` + الگوی `routes/admin.js` (bcrypt + `must_change_password=1`). گیت «تغییر رمز در اولین ورود» **از قبل در `routes/auth.js` وجود دارد و اجرا می‌شود**. رمز پیش‌فرض `12345` ضعیف است → همان گیت `must_change_password` کافی است؛ توصیه: رمز موقت را با SMS بفرست (سرویس پیامک موجود). username = `persons.phone`. |
| «Warehouses / Inventory transfer» | **استفاده مجدد** | `warehouses` + `warehouse_stock` (موجودی به‌تفکیک انبار). انتقال بین بخش‌ها = `POST /api/warehouses/moves/transfer`. ورود/خروج = `/moves/receipt` و `/moves/issue`. **نکته:** باگ seed موجودی انبار اخیراً رفع شد — روی همان مسیرها بمان. |
| «Product Conversion → Production Document» (Rule 4) | **استفاده مجدد ماژول تولید** | ماژول تولید کامل داریم: `routes/production-orders.js` (release/receipt/issue/reverse/wip)، `routes/production-execution.js` (stageها: start/output/issue/finalize/subcontract)، `production-boms`، `production_runs` (syncable). تبدیل کالا در یک بخش = ثبت رسید/حواله انبار + `createJournalEntry`؛ برای تبدیل واقعی BOM از سفارش تولید استفاده کن، نه یک سیستم سند بومیِ جدید. |
| «Accounting auto-doc» | **استفاده مجدد** | `createJournalEntry(db, { date, description, ref_type, ref_id, created_by, lines })` (export از `db.js`). کدهای حساب از لایهٔ `server/lib/coa-map.js` → `acct(db, key)` (آگاه به حالت محک). پرداخت به شخص = سند هزینه/پرداخت روی حساب تفصیلی شخص. |
| «CRM for description fields» (Rule 5) | **استفاده مجدد** | فیلدهای توضیحات → `followups` / `activity-log.js`. سیستم CRM جدا نساز. |
| «Role matrix / RBAC» | **توسعهٔ RBAC موجود** | `server/lib/rbac.js`: `RESOURCES` (APPEND-ONLY) + `DEFAULT_ROLE_PERMISSIONS` + middleware `requirePermission(resource, action)`. یک resource جدید `'portal'` به انتهای `RESOURCES` اضافه کن. نقش‌های جدید `unit_manager` و `department_manager` تعریف کن. جداسازی داده (واحد/بخش) در **کوئری‌ها** اعمال شود، نه فقط UI. |
| «Real-time WebSocket/SSE» | **حذف/جایگزین** | WebSocket در استک نداریم. از سیستم اعلان موجود (`routes/notifications.js` + `lib/notifications.js` + SMS) و polling استفاده کن. |
| «UUID / PostgreSQL / Prisma / NestJS / React / Socket.io» | **حذف** | همه با استک واقعی جایگزین شد (بند بخش ۰). |
| «Timestamps ISO» | **اصلاح** | epoch integer. |
| «Pagination 25» | نگه‌داشتن | با الگوی موجود هماهنگ. |

---

## بخش ۲ — مدل داده (SQL واقعی، در `db.js` → `initDB()`)

> کلید صحیح، مبلغ ریال صحیح، timestamp epoch. همه به `SYNCABLE_TABLES` (انتهای آرایه) هم اضافه شوند.

```sql
-- واحد عملیاتی
CREATE TABLE IF NOT EXISTS op_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  manager_person_id INTEGER NOT NULL,        -- persons.id (کاربرش خودکار ساخته می‌شود)
  manager2_person_id INTEGER,
  manager3_person_id INTEGER,
  output_type TEXT DEFAULT '',
  status TEXT DEFAULT 'active',              -- active | inactive | archived
  created_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER,
  FOREIGN KEY(manager_person_id) REFERENCES persons(id)
);

-- انبارهای متصل به واحد (M2M)
CREATE TABLE IF NOT EXISTS op_unit_warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  FOREIGN KEY(unit_id) REFERENCES op_units(id),
  FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
);

-- اشخاص درگیر مالی واحد (M2M) — برای تولید سند حسابداری خودکار روی پرداخت
CREATE TABLE IF NOT EXISTS op_unit_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  FOREIGN KEY(unit_id) REFERENCES op_units(id),
  FOREIGN KEY(person_id) REFERENCES persons(id)
);

-- بخش‌های واحد (ترتیب گردش‌کار)
CREATE TABLE IF NOT EXISTS op_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  manager_person_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,             -- باید از انبارهای همان واحد باشد
  sequence_order INTEGER NOT NULL,           -- بدون تکرار، بدون شکاف
  status TEXT DEFAULT 'active',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(unit_id) REFERENCES op_units(id),
  FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
);

-- پارامتر (سفارش کار / بَچ تولید)
CREATE TABLE IF NOT EXISTS op_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  num TEXT,                                   -- شماره اتمیک از number_sequences (مثلا P-0001)
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  current_department_id INTEGER,              -- بخش فعال فعلی (NULL = تمام‌شده/اولیه)
  status TEXT DEFAULT 'initiated',            -- initiated|in_progress|under_review|dept_completed|transferred|completed|cancelled
  final_quantity REAL,
  destination_warehouse_id INTEGER,
  description TEXT DEFAULT '',                -- به followups/CRM لینک شود
  created_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY(unit_id) REFERENCES op_units(id)
);

-- اقلام اولیهٔ پارامتر
CREATE TABLE IF NOT EXISTS op_parameter_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parameter_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  unit_of_measure TEXT DEFAULT '',
  FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);

-- لاگ/عملیات هر بخش روی پارامتر (Audit + workflow state per step)
CREATE TABLE IF NOT EXISTS op_parameter_dept_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parameter_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  sequence_order INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',             -- pending|in_progress|under_review|completed
  received_quantity REAL,
  confirmed INTEGER DEFAULT 0,
  correction_quantity REAL,
  correction_notified INTEGER DEFAULT 0,
  output_quantity REAL,
  payment_person_id INTEGER,
  payment_amount INTEGER DEFAULT 0,          -- ریال صحیح
  payment_status TEXT,                       -- awaiting|completed
  payment_journal_id INTEGER,                -- journal_entries.id تولیدشده
  converted_product_id INTEGER,
  conversion_quantity REAL,
  production_run_id INTEGER,                  -- production_runs.id تولیدشده
  transfer_move_id INTEGER,                   -- warehouse_moves.id انتقال به بخش بعد
  notes TEXT DEFAULT '',                      -- به CRM لینک
  started_at INTEGER,
  completed_at INTEGER,
  completed_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
  FOREIGN KEY(department_id) REFERENCES op_departments(id)
);
```

**ایندکس‌ها:** روی `op_parameter_dept_log(parameter_id)`، `(department_id)`، `op_parameters(unit_id, status)`، `op_parameters(current_department_id)`، `op_departments(unit_id, sequence_order)`.

**افزودن به sync (`server/sync/tables.js`، انتهای آرایه، به همین ترتیب FK-پدر-اول):**
```js
{ name: 'op_units', upsertKey: 'id' },
{ name: 'op_unit_warehouses', upsertKey: 'id' },
{ name: 'op_unit_persons', upsertKey: 'id' },
{ name: 'op_departments', upsertKey: 'id' },
{ name: 'op_parameters', upsertKey: 'id' },
{ name: 'op_parameter_items', upsertKey: 'id' },
{ name: 'op_parameter_dept_log', upsertKey: 'id' },
```

---

## بخش ۳ — API (منطبق با الگوی مخزن)

فایل جدید `server/routes/portal.js`، mount در `server.js`:
`app.use('/api/portal', require('./routes/portal'));`
همهٔ مسیرها با `auth` + `requirePermission('portal', <action>)`. مسیرهای پیکربندی (ساخت/ویرایش واحد و بخش و ترتیب) با `centralOnly` (روی دستگاه‌ها 403).

```
# واحد عملیاتی (پیکربندی — centralOnly)
POST   /api/portal/units                       ساخت واحد (+ ساخت خودکار کاربر مدیر)
GET    /api/portal/units                        لیست (بر اساس نقش/scope)
GET    /api/portal/units/:id                    جزئیات + بخش‌ها + انبارها
PUT    /api/portal/units/:id
DELETE /api/portal/units/:id                    soft-delete (status=archived)

# بخش (پیکربندی — centralOnly)
POST   /api/portal/units/:id/departments        افزودن بخش (+ ساخت خودکار کاربر مدیر بخش)
GET    /api/portal/units/:id/departments
PUT    /api/portal/departments/:id
PUT    /api/portal/departments/:id/sequence      تغییر ترتیب (قفل اگر پارامتر in_progress دارد)

# پارامتر (عملیاتی — syncable، آفلاین مجاز)
POST   /api/portal/parameters                    ساخت پارامتر (مدیر واحد) → انتقال خودکار به انبار بخش اول
GET    /api/portal/parameters                    لیست فیلترشده بر اساس نقش
GET    /api/portal/parameters/:id                جزئیات + مسیر کامل (timeline)
POST   /api/portal/parameters/:id/dept/:deptId/confirm    تأیید مقدار دریافتی / اصلاح
POST   /api/portal/parameters/:id/dept/:deptId/request-review   درخواست بازبینی از مدیر واحد
POST   /api/portal/parameters/:id/dept/:deptId/payment   ثبت پرداخت به شخص → سند حسابداری خودکار
POST   /api/portal/parameters/:id/dept/:deptId/convert   تبدیل کالا → سند تولید خودکار
POST   /api/portal/parameters/:id/dept/:deptId/complete  اتمام عملیات بخش → انتقال به بخش بعد
POST   /api/portal/parameters/:id/final-output           ثبت خروجی نهایی (بخش آخر)
```

**قواعد کلیدی سرور:**
- **قفل ترتیبی (Rule 2):** عملیات بخش N مجاز نیست تا `op_parameter_dept_log` بخش N-1 در وضعیت `completed` باشد. `current_department_id` منبع حقیقت است.
- **ساخت خودکار کاربر (Rule 1):** هنگام ذخیرهٔ مدیر واحد/بخش، اگر `persons.phone` کاربری در `users` ندارد → `INSERT INTO users(... username=phone, password=bcrypt('<temp>'), must_change_password=1, role=...)`. اگر شماره در persons نیست، خطای «ابتدا شخص را بسازید».
- **انتقال انبار خودکار:** ساخت پارامتر و «اتمام بخش» → `warehouse_moves` transfer از انبار مبدأ به انبار بخش مقصد (مسیر/هلپر موجود warehouses).
- **سند حسابداری خودکار (پرداخت):** `createJournalEntry` با خطوط بدهکار هزینه/بستانکار تفصیلی شخص از `coa-map`؛ `payment_journal_id` را ذخیره کن.
- **سند تولید خودکار (تبدیل):** رسید/حواله انبار + سند تولید از ماژول production؛ `production_run_id` را ذخیره کن.
- **قفل تغییر ترتیب (Edge 5):** اگر واحد پارامتر `in_progress` دارد، `PUT .../sequence` → 409 «امکان تغییر گردش‌کار نیست؛ پارامتر فعال وجود دارد».
- **تکمیل نهایی:** `status=completed`, `completed_at`, دسترسی ویرایش برای همه به‌جز admin بسته می‌شود (فقط خواندنی).
- **Audit (Rule 3):** timestampها روی همهٔ عملیات؛ نمایش برای همه (خواندنی). از `activity-log.js`/`audit()` موجود استفاده کن.
- همهٔ عملیات چندجمله‌ای در `db.transaction`.

---

## بخش ۴ — فرانت (تک‌فایل `index.html`)

- دو پرتال با نقش‌محوری:
  - **مدیر واحد:** timeline افقی همهٔ پارامترها با رنگ وضعیت بخش‌ها (سبز=تمام، زرد=فعال، خاکستری=در انتظار). ساخت پارامتر، ثبت خروجی نهایی.
  - **مدیر بخش:** فقط پارامترهای بخش خودش؛ تأیید/اصلاح مقدار، درخواست بازبینی، اتمام عملیات. کارت‌محور، دکمه‌های بزرگ (کف کارگاه، موبایل).
- الگوی ثبت صفحه: `ROUTES['portal-units']`, `ROUTES['portal-my-dept']`؛ ثبت تب در `acc-nav.js`؛ توابع `renderPortalUnitsTab()` و … ؛ dispatch در `loadAccTab`.
- اگر فایل JS جدا لازم شد (مثل کامپوننت timeline) → **IIFE-wrap** و `globalThis.PortalX = …`.
- اعداد ورودی خودکار انگلیسی (سازوکار موجود `toEnDigits`/`wantsEnDigits`)، مبالغ ریال با جداکنندهٔ هزارگان.
- اعلان‌ها: زنگولهٔ درون‌برنامه + SMS (بدون WebSocket) برای «ورود پارامتر به بخش»، «درخواست اصلاح/بازبینی»، «تأیید پرداخت»، «ثبت خروجی نهایی».

---

## بخش ۵ — RBAC (در `server/lib/rbac.js`)

- به انتهای `RESOURCES` اضافه کن: `'portal'` (append-only).
- نقش‌های جدید در `DEFAULT_ROLE_PERMISSIONS`:
  - `unit_manager`: `portal` = {view,create,edit, approve} روی واحد خودش؛ سایر resourceها حداقلی (products/warehouses view).
  - `department_manager`: `portal` = {view, create} فقط؛ بدون edit/delete.
- جداسازی داده در کوئری‌ها: مدیر واحد فقط `op_units` خودش؛ مدیر بخش فقط پارامترهایی که `current_department_id` بخش اوست.
- ماتریس دسترسی اسپک (بخش ۸ فایل خام) مرجع رفتار است.

---

## بخش ۶ — Edge Caseها (اجباری)

1. موجودی ناکافی هنگام ساخت پارامتر → بلاک + پیام «موجودی انبار [نام] کافی نیست (موجود: X، نیاز: Y)». (سازوکار deductStock موجود.)
2. عدم دسترسی مدیر بخش → «واگذاری موقت» توسط مدیر واحد (لاگ در audit).
3. گیرکردن در بازبینی → escalation به admin؛ auto-approve بعد از timeout قابل‌تنظیم (پیش‌فرض ۷۲ ساعت) با فلگ audit.
4. تبدیل به کالای ناموجود در master → ساخت آنی محصول با وضعیت «در انتظار تأیید» تا تأیید admin. (از مسیر ساخت محصول موجود.)
5. تغییر ترتیب حین اجرا → بلاک (بخش ۳).

---

## بخش ۷ — ترتیب اجرای پیشنهادی برای Cursor

1. **Schema:** جدول‌ها در `db.js`→`initDB()` + افزودن به `SYNCABLE_TABLES` (انتها) + ایندکس‌ها. یک boot بزن؛ `PRAGMA integrity_check` سبز.
2. **RBAC:** resource `'portal'` + نقش‌های `unit_manager`/`department_manager`.
3. **ساخت خودکار کاربر:** هلپر مشترک (person→user با must_change_password) + تست ورود/گیت.
4. **CRUD واحد + بخش + ترتیب** (centralOnly) — با قفل تغییر ترتیب.
5. **ساخت پارامتر** + انتقال انبار خودکار به بخش اول + شماره اتمیک + لاگ‌های بخش (وضعیت pending با ترتیب).
6. **عملیات بخش:** تأیید/اصلاح، بازبینی، پرداخت (سند حسابداری خودکار)، تبدیل (سند تولید خودکار)، اتمام + انتقال به بخش بعد — همه با قفل ترتیبی و در `db.transaction`.
7. **خروجی نهایی:** رسید انبار مقصد + سند تکمیل تولید + بستن دسترسی ویرایش.
8. **فرانت:** پرتال مدیر واحد (timeline) + پرتال مدیر بخش (کارت) + اعلان‌ها.
9. **اعلان‌ها:** درون‌برنامه + SMS روی رویدادهای بخش ۴.
10. **تست:** `server/scripts/test-portal.js` (E2E: واحد→۳ بخش→پارامتر→گذر ترتیبی→پرداخت→تبدیل→خروجی نهایی؛ اثبات: قفل ترتیبی، ساخت کاربر، تراز حسابداری متوازن در هر مرحله، انتقال انبار درست، ساخت `production_run`). + سبز ماندن test-sms/test-sync/test:production.
11. **Help + CHANGE-LOG** در همان commit.

---

## بخش ۸ — نکات یکپارچگی حسابداری/انبار (که اسپک خام نادیده گرفته)

- **دوطرفه ماندن دفتر:** هر پرداخت/تبدیل/خروجی که سند مالی می‌سازد باید از `createJournalEntry` رد شود تا تراز بماند؛ هیچ نوشتن مستقیم روی مانده‌ها.
- **کدهای حساب:** همیشه از `coa-map.acct(db, key)` (پشتیبانی حالت محک `coa_mode='mahak'`). کد ثابت (مثل 1103) ننویس.
- **انبار:** فقط از مسیرهای `warehouses/moves/*` و منطق `warehouse_stock`؛ `products.stock` را دستی جدا از `warehouse_stock` تغییر نده (باگ drift اخیراً رفع شد — همان الگو را نگه‌دار).
- **آفلاین:** چون عملیات پارامتر روی دستگاه هم اجرا می‌شود، مطمئن شو بازپخش (`sync/capture.js`) این مسیرها را می‌گیرد و بازاجرای مرکزی همان اسناد را می‌سازد (منطق در route handlerهاست، نه در فرانت).

---

## بخش ۹ — امنیت

- رمز پیش‌فرض `12345` فقط با گیت `must_change_password` قابل‌قبول است؛ ترجیحاً رمز موقت تصادفی + SMS. هرگز رمز را در پاسخ API لو نده.
- ورود با username=شماره‌تلفن؛ نقش صحیح ست شود؛ کاربر غیرفعال بلاک.
- جداسازی دادهٔ واحد/بخش در سطح کوئری (نه فقط UI).

---

### پیوست: چیزهایی که از اسپک خام حذف/جایگزین شد (خلاصه برای Cursor)
UUID→INTEGER؛ PostgreSQL/Prisma→better-sqlite3؛ NestJS/React→Express+index.html؛ WebSocket/SSE→notifications+SMS+polling؛ جدول UserAccount جدا→`users` موجود؛ timestamp ISO→epoch؛ «Production/Accounting/CRM/Inventory module» جدید→ماژول‌های موجود تولید/حسابداری/followups/انبار؛ مبلغ اعشاری→ریال صحیح. **بقیهٔ منطق کسب‌وکار اسپک خام معتبر است.**
