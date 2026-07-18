# permissions.md
## دسترسی و مجوزها — ماژول عملیات تولید

> **پایه:** `server/lib/rbac.js` موجود · **الگو:** `RESOURCES × ACTIONS` + `user_permissions` override

---

## ۱. وضعیت فعلی سیستم

```js
// server/lib/rbac.js — موجود
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];

const RESOURCES = [
  'customers', 'parties', 'products', 'invoices', 'followups', 'accounting', 'reports',
  'ai', 'settings', 'backup', 'users', 'stocktaking', 'messages', 'reps', 'dashboard',
  'journal_vouchers', 'payroll', 'fixed_assets', 'moadian',
];

const DEFAULT_ROLE_PERMISSIONS = {
  admin: { /* همه */ },
  accounting: { /* ... */ },
  sales_manager: { /* ... */ },
  field_sales: { /* ... */ },
};
```

---

## ۲. تغییرات لازم

### ۲.۱ منابع جدید

```js
const RESOURCES = [
  /* ...همه موارد موجود بدون تغییر... */

  // ===== Production module =====
  'production',           // سفارش تولید، مراحل، اجرا
  'production_bom',       // فرمول تولید (ماژول ۱ و ۴)
  'production_cost',      // 🔑 دسترسی به بهای تمام‌شده — منبع مجازی
  'production_close',     // بستن دوره
  'production_reports',   // گزارشات
];
```

> **`production_cost` منبع مجازی است** — هیچ endpoint اختصاصی ندارد.
> فقط پرچمی است که `canSeeCost()` می‌خواند تا تصمیم بگیرد فیلدهای `*_rial` را از JSON حذف کند یا نه.

### ۲.۲ نقش‌های جدید

```js
// server/lib/rbac.js
const ROLES = [
  'admin', 'accounting', 'sales_manager', 'field_sales',
  'production_manager',    // 🆕 مدیر تولید
  'production_operator',   // 🆕 اپراتور خط
];
```

**افزودن به `users.role` — بدون تغییر schema** (ستون `TEXT` است).
UI مدیریت کاربران باید این دو گزینه را نمایش دهد.

### ۲.۳ جدول جدید — دسترسی مرکز هزینه

```sql
CREATE TABLE IF NOT EXISTS user_cost_centers (
  user_id        INTEGER NOT NULL,
  cost_center_id INTEGER NOT NULL,
  can_view       INTEGER DEFAULT 1,
  can_post       INTEGER DEFAULT 1,
  created_at     INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, cost_center_id),
  FOREIGN KEY(user_id)        REFERENCES users(id),
  FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
);
CREATE INDEX IF NOT EXISTS ix_ucc_user ON user_cost_centers(user_id);
```

> **قاعده:** اگر کاربر **هیچ** رکوردی در این جدول نداشته باشد → **بدون محدودیت** (همه مراکز).
> اگر حداقل یک رکورد داشته باشد → **فقط همان مراکز**.
> این باعث می‌شود `admin` و `accounting` بدون تنظیم اضافی کار کنند.

---

## ۳. ماتریس کامل مجوزها

### `production` — سفارش تولید و اجرا

| نقش | view | create | edit | delete | approve | export |
|-----|:----:|:------:|:----:|:------:|:-------:|:------:|
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `accounting` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `production_manager` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `production_operator` | ✅ | ✅¹ | ❌ | ❌ | ❌ | ❌ |
| `sales_manager` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `field_sales` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ فقط ثبت حواله/خروجی مرحله — نه ایجاد سفارش. کنترل در سطح endpoint.

### `production_bom` — فرمول تولید

| نقش | view | create | edit | delete | approve | export |
|-----|:----:|:------:|:----:|:------:|:-------:|:------:|
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `accounting` | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| `production_manager` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `production_operator` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `sales_manager` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `field_sales` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

> **`approve` روی BOM = فعال‌سازی فرمول.** فقط `admin` و `production_manager`.
> `accounting` می‌تواند فرمول بسازد ولی **نمی‌تواند فعال کند** — تفکیک وظایف.

### `production_cost` — 🔑 دسترسی به بها

| نقش | view | توضیح |
|-----|:----:|-------|
| `admin` | ✅ | همه |
| `accounting` | ✅ | همه |
| `production_manager` | ✅ | همه |
| `production_operator` | ❌ | **فقط مقدار — هیچ عددی از بها** |
| `sales_manager` | ❌ | قیمت فروش بله، بهای تمام‌شده خیر |
| `field_sales` | ❌ | **فقط قیمت پیشنهادی** |

> **این حیاتی‌ترین ردیف است.**
> ویزیتور نباید بداند مانتو ۲۳۱٬۵۸۸ تومان تمام می‌شود — اگر بداند، در مذاکره تخفیف بیشتری می‌دهد.
> **پیاده‌سازی:** حذف فیلد از JSON، نه CSS. (`stripCostFields` در `api.md §12`)

### `production_close` — بستن دوره

| نقش | view | create | edit | delete | approve | export |
|-----|:----:|:------:|:----:|:------:|:-------:|:------:|
| `admin` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `accounting` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `production_manager` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| بقیه | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

> **`reopen` دوره بسته‌شده = فقط `admin`** — کنترل اضافی در کد، نه فقط RBAC.

### `production_reports` — گزارشات

| نقش | view | export |
|-----|:----:|:------:|
| `admin` | ✅ | ✅ |
| `accounting` | ✅ | ✅ |
| `production_manager` | ✅ | ✅ |
| `production_operator` | ✅¹ | ❌ |
| `sales_manager` | ✅² | ✅² |
| `field_sales` | ❌ | ❌ |

¹ فقط گزارش‌های عملیاتی مراکز خودش · ² بدون فیلدهای بها

---

## ۴. دسترسی گزارش به گزارش

| گزارش | admin | accounting | prod_mgr | prod_op | sales_mgr | field_sales |
|-------|:-----:|:----------:|:--------:|:-------:|:---------:|:-----------:|
| PR-01 لیست سفارش‌ها | ✅ | ✅ | ✅ | ✅¹ | ✅² | ❌ |
| PR-02 برگه بها | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-03 کانبان | ✅ | ✅ | ✅ | ✅¹ | ✅² | ❌ |
| PR-04 دفتر سفارش | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| PR-05 زمان چرخه | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| PR-06 بهای دوره | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-07 روند بهای واحد | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-08 استاندارد/واقعی | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-09 ارزش افزوده | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-10 مانده WIP | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-11 ماتریس انحراف ⭐ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-12 انحراف مواد | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-13 پارتو دلایل | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-14 کسر/اضافه جذب | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-15 ضایعات | ✅ | ✅ | ✅ | ✅¹ | ❌ | ❌ |
| PR-16 بهره‌وری | ✅ | ✅ | ✅ | ✅¹ | ❌ | ❌ |
| PR-17 دوباره‌کاری | ✅ | ✅ | ✅ | ✅¹ | ❌ | ❌ |
| PR-18 عملکرد مراکز | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-19 گلوگاه | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-20 مصرف مواد | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-21 عملکرد پیمانکاران | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PR-22 سودآوری محصول | ✅ | ✅ | ❌ | ❌ | ✅² | ❌ |
| **PR-23 سود ماهانه** ⭐⭐ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| PR-24 داشبورد | ✅ | ✅ | ✅³ | ❌ | ✅² | ❌ |
| PR-99 مغایرت | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

¹ فقط مراکز `user_cost_centers` خودش
² بدون فیلدهای بها (`stripCostFields`)
³ بدون کارت سود ناخالص

---

## ۵. کنترل‌های سطح endpoint (فراتر از RBAC)

| endpoint | کنترل اضافی |
|----------|-------------|
| `POST /orders` | `production_operator` → `403` (فقط ثبت مرحله، نه ایجاد) |
| `POST /orders/:id/stages/:sid/output` | `assertUserCostCenter(user, stage.cost_center_id)` |
| `POST /orders/:id/stages/:sid/issue` | همان |
| `POST /boms/:id/activate` | `production_bom.approve` **و** نقش `admin`/`production_manager` |
| `POST /close/:period/execute` | `production_close.approve` **و** همه Precheck پاس شده |
| `POST /close/:period/reopen` | **فقط `admin`** + دلیل اجباری + `audit` |
| `POST /orders/:id/reopen` | **فقط `admin`** + دلیل اجباری |
| `POST /boms/:id/restore` | **فقط `admin`** + دلیل اجباری |
| `POST /docs/:table/:id/reverse` | `approve` + دوره باز + چک `E_FG_SOLD` |
| `PUT /config` | **فقط `admin`**/`accounting` |
| `PUT /cost-center-rates/:id` | `accounting`/`admin`/`production_manager` |

---

## ۶. کد پیاده‌سازی

### ۶.۱ گسترش `rbac.js`

```js
// server/lib/rbac.js

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];

const RESOURCES = [
  'customers', 'parties', 'products', 'invoices', 'followups', 'accounting', 'reports',
  'ai', 'settings', 'backup', 'users', 'stocktaking', 'messages', 'reps', 'dashboard',
  'journal_vouchers', 'payroll', 'fixed_assets', 'moadian',
  // ===== Production =====
  'production', 'production_bom', 'production_cost', 'production_close', 'production_reports',
];

const ALL       = Object.fromEntries(ACTIONS.map(a => [a, true]));
const NONE      = Object.fromEntries(ACTIONS.map(a => [a, false]));
const VIEW_ONLY = { ...NONE, view: true };
const VIEW_EXP  = { ...NONE, view: true, export: true };

const DEFAULT_ROLE_PERMISSIONS = {
  admin: Object.fromEntries(RESOURCES.map(r => [r, { ...ALL }])),

  accounting: {
    /* ...موارد موجود بدون تغییر... */
    production:         { view:true, create:true,  edit:true,  delete:false, approve:true,  export:true },
    production_bom:     { view:true, create:true,  edit:true,  delete:false, approve:false, export:true },
    production_cost:    { ...VIEW_ONLY },
    production_close:   { view:true, create:true,  edit:true,  delete:false, approve:true,  export:true },
    production_reports: { ...VIEW_EXP },
  },

  sales_manager: {
    /* ...موارد موجود... */
    production:         { ...VIEW_EXP },
    production_bom:     { ...VIEW_EXP },
    production_cost:    { ...NONE },              // 🔒 بها نمی‌بیند
    production_close:   { ...NONE },
    production_reports: { ...VIEW_EXP },
  },

  field_sales: {
    /* ...موارد موجود... */
    production:         { ...NONE },
    production_bom:     { ...NONE },
    production_cost:    { ...NONE },              // 🔒 بها نمی‌بیند
    production_close:   { ...NONE },
    production_reports: { ...NONE },
  },

  // ===== نقش‌های جدید =====
  production_manager: {
    customers:  VIEW_ONLY,
    parties:    VIEW_ONLY,
    products:   { view:true, create:true, edit:true, delete:false, approve:false, export:true },
    invoices:   VIEW_ONLY,
    followups:  NONE,
    accounting: VIEW_ONLY,
    reports:    VIEW_EXP,
    ai:         VIEW_ONLY,
    settings:   VIEW_ONLY,
    backup:     NONE,
    users:      NONE,
    stocktaking:{ view:true, create:true, edit:true, delete:false, approve:false, export:true },
    messages:   VIEW_ONLY,
    reps:       NONE,
    dashboard:  VIEW_ONLY,
    journal_vouchers: NONE,
    payroll:    VIEW_ONLY,
    fixed_assets: VIEW_ONLY,
    moadian:    NONE,
    production:         { view:true, create:true, edit:true, delete:false, approve:true, export:true },
    production_bom:     { view:true, create:true, edit:true, delete:false, approve:true, export:true },
    production_cost:    { ...VIEW_ONLY },
    production_close:   { ...VIEW_EXP },           // فقط مشاهده
    production_reports: { ...VIEW_EXP },
  },

  production_operator: {
    customers:  NONE, parties: NONE,
    products:   VIEW_ONLY,
    invoices:   NONE, followups: NONE, accounting: NONE, reports: NONE, ai: NONE,
    settings:   NONE, backup: NONE, users: NONE,
    stocktaking: VIEW_ONLY,
    messages:   NONE, reps: NONE,
    dashboard:  NONE,
    journal_vouchers: NONE, payroll: NONE, fixed_assets: NONE, moadian: NONE,
    production:         { view:true, create:true, edit:false, delete:false, approve:false, export:false },
    production_bom:     { ...VIEW_ONLY },
    production_cost:    { ...NONE },               // 🔒 بها نمی‌بیند
    production_close:   { ...NONE },
    production_reports: { ...VIEW_ONLY },
  },
};
```

### ۶.۲ کنترل مرکز هزینه

```js
// server/lib/production/acl.js

/** آیا کاربر به این مرکز هزینه دسترسی دارد؟ */
function assertUserCostCenter(db, userId, ccId) {
  const rows = db.prepare('SELECT cost_center_id, can_post FROM user_cost_centers WHERE user_id=?')
                 .all(userId);
  if (!rows.length) return true;                    // بدون رکورد = بدون محدودیت
  const row = rows.find(r => r.cost_center_id === ccId);
  if (!row) {
    const cc = db.prepare('SELECT name FROM cost_centers WHERE id=?').get(ccId);
    throw err('E_FORBIDDEN_CC', 403, { cc: cc?.name || ccId });
  }
  if (!row.can_post) throw err('E_FORBIDDEN_CC', 403, { cc: ccId });
  return true;
}

/** فیلتر SQL برای گزارش‌ها */
function costCenterFilter(db, userId) {
  const rows = db.prepare('SELECT cost_center_id FROM user_cost_centers WHERE user_id=? AND can_view=1')
                 .all(userId);
  if (!rows.length) return null;                    // null = بدون محدودیت
  return rows.map(r => r.cost_center_id);
}

/** آیا می‌تواند بها ببیند؟ */
function canSeeCost(db, user) {
  if (!user) return false;
  return hasPermission(db, user, 'production_cost', 'view');
}

/** حذف بازگشتی فیلدهای بها — نه فقط CSS */
const COST_KEY = /(_rial|_toman|unit_cost|std_cost|var_price|var_qty|var_total|_amount)$/i;
const COST_BLOCKS = new Set([
  'cost', 'costs', 'pricing', 'breakdown', 'standard', 'variance',
  'discount_analysis', 'totals_cost', 'allocation',
]);

function stripCostFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripCostFields);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (COST_KEY.test(k))     continue;
      if (COST_BLOCKS.has(k))   continue;
      out[k] = stripCostFields(v);
    }
    return out;
  }
  return obj;
}

module.exports = { assertUserCostCenter, costCenterFilter, canSeeCost, stripCostFields };
```

### ۶.۳ استفاده در Route

```js
// server/routes/production-execution.js

router.post('/:id/stages/:sid/output',
  auth,
  requirePermission('production', 'create'),
  withIdempotency(handle(req => {
    const db = getDB();
    const st = db.prepare('SELECT cost_center_id FROM production_order_stages WHERE id=?')
                 .get(+req.params.sid);
    if (!st) throw err('E_NOT_FOUND', 404);
    assertUserCostCenter(db, req.user.id, st.cost_center_id);   // 🔑

    return engine.postStageOutput(db, {
      orderId: +req.params.id, stageId: +req.params.sid,
      body: req.body, userId: req.user.id,
    });
  }))
);

// ⚠️ اپراتور نمی‌تواند سفارش بسازد
router.post('/', auth, requirePermission('production', 'create'), handle(req => {
  if (req.user.role === 'production_operator') throw err('E_FORBIDDEN', 403);
  return engine.createOrder(getDB(), { ...req.body, userId: req.user.id });
}));

// ⚠️ فقط admin
router.post('/:id/reopen', auth, requirePermission('production', 'approve'), handle(req => {
  if (req.user.role !== 'admin') throw err('E_FORBIDDEN', 403);
  if (!req.body.reason) throw err('E_REASON_REQUIRED', 422);
  return engine.reopenOrder(getDB(), {
    orderId: +req.params.id, reason: req.body.reason, userId: req.user.id,
  });
}));
```

---

## ۷. تفکیک وظایف (Segregation of Duties)

| وظیفه | نقش | دلیل |
|-------|-----|------|
| ساخت فرمول | `accounting`, `production_manager` | |
| **فعال‌سازی فرمول** | `admin`, `production_manager` **نه** `accounting` | حسابدار نباید استاندارد بها را تعیین کند |
| ایجاد سفارش | `accounting`, `production_manager` | |
| **ثبت خروجی مرحله** | `production_operator` | کسی که کار را انجام داده |
| **ثبت حقوق** | `accounting` | |
| **بستن دوره** | `accounting`, `admin` **نه** `production_manager` | مدیر تولید نباید انحراف خودش را ببندد |
| **بازکردن دوره** | فقط `admin` | |
| **ابطال سند** | `accounting`, `admin`, `production_manager` | با `audit` اجباری |
| **تعیین نرخ سربار** | `accounting`, `admin`, `production_manager` | |
| **مشاهده سود ماهانه** | `accounting`, `admin` | |

> **مهم‌ترین تفکیک:** مدیر تولید انحراف‌ها را می‌بیند ولی **نمی‌تواند دوره را ببندد**.
> حسابداری دوره را می‌بندد ولی **نمی‌تواند فرمول را فعال کند**.
> این جلوی «پنهان کردن انحراف با تغییر استاندارد» را می‌گیرد.

---

## ۸. حسابرسی (Audit)

**اجباری روی همه عملیات:**
```js
audit(userId, action, entity, entityId, description);
```

| عملیات | `action` | `entity` | نمونه `description` |
|--------|----------|----------|---------------------|
| ایجاد BOM | `create` | `bom` | «ایجاد فرمول BOM-000105 برای مانتو ترمه» |
| فعال‌سازی BOM | `approve` | `bom` | «فعال‌سازی BOM-000101 نسخه ۲ از ۱۴۰۵/۰۵/۰۱» |
| نسخه جدید | `create` | `bom` | «نسخه ۳ از BOM-000101 — دلیل: افزایش ضایعات» |
| ایجاد سفارش | `create` | `production_order` | «سفارش PO-1405-0010 — ۳۰۰ عدد مانتو ترمه» |
| آزادسازی | `approve` | `production_order` | «آزادسازی PO-1405-0010 — شروع ۳۱۴ عدد» |
| ثبت خروجی | `create` | `production_stage_output` | «مرحله ۱۰ برش: ۳۰۷.۷۲ عدد — بهای واحد ۱٬۷۲۲٬۵۶۸» |
| ثبت حواله | `create` | `production_material_issue` | «MI-1405-0088 — ۵۳۲٬۴۴۰٬۰۰۰ ریال» |
| ابطال | `reverse` | `production_*` | «ابطال PR-1405-0017 — دلیل: تعداد اشتباه» |
| بستن دوره | `approve` | `production_period_close` | «بستن دوره ۱۴۰۵/۰۴ — انحراف ۱٬۹۶۳٬۸۶۲ تسهیم شد» |
| بازکردن دوره | `update` | `production_period_close` | «🔴 بازکردن دوره ۱۴۰۵/۰۴ — دلیل: اصلاح حقوق» |
| تغییر نرخ سربار | `edit` | `cost_center_rate` | «نرخ CC-30 دوخت ۱۴۰۵/۰۴: ۳۵۰٬۰۰۰ → ۳۸۰٬۰۰۰» |
| تغییر تنظیمات | `update` | `settings` | «production_variance_threshold_pct: ۰.۵ → ۱.۰» |

**عملیات پرخطر — `audit` + `app_notifications` برای admin:**
- بازکردن دوره بسته‌شده
- بازکردن سفارش بسته‌شده
- بازیابی فرمول بایگانی‌شده
- تغییر `production_allow_negative_stock`
- ابطال سند بالای ۱۰۰ میلیون ریال

```js
function auditCritical(db, { userId, action, entity, entityId, description }) {
  audit(userId, action, entity, entityId, description);
  db.prepare(`INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_role)
              VALUES ('critical', ?, ?, ?, ?, 'admin')`)
    .run(entity, entityId, `عملیات پرخطر: ${action}`, description);
}
```

---

## ۹. UI مدیریت دسترسی

### صفحه «کاربران» — تب دسترسی تولید

```
┌────────────────────────────────────────────────────────────────────┐
│ کاربر: علی محمدی    نقش: [اپراتور تولید ▾]                        │
├────────────────────────────────────────────────────────────────────┤
│ ▸ مجوزهای تولید                                                    │
│ ┌──────────────────────┬─────┬──────┬──────┬─────┬──────┬───────┐ │
│ │ منبع                 │مشاهده│ایجاد │ویرایش│حذف │تأیید │خروجی │ │
│ ├──────────────────────┼─────┼──────┼──────┼─────┼──────┼───────┤ │
│ │ سفارش تولید          │ ☑   │ ☑   │ ☐   │ ☐  │ ☐   │ ☐    │ │
│ │ فرمول تولید          │ ☑   │ ☐   │ ☐   │ ☐  │ ☐   │ ☐    │ │
│ │ 🔑 بهای تمام‌شده     │ ☐   │  —  │  —  │ —  │  —  │  —   │ │
│ │ بستن دوره            │ ☐   │ ☐   │ ☐   │ ☐  │ ☐   │ ☐    │ │
│ │ گزارشات تولید        │ ☑   │  —  │  —  │ —  │  —  │ ☐    │ │
│ └──────────────────────┴─────┴──────┴──────┴─────┴──────┴───────┘ │
│ ⚠️ «بهای تمام‌شده» خاموش است — این کاربر هیچ عددی از بها نمی‌بیند  │
│                                                                     │
│ ▸ مراکز هزینه مجاز                                                 │
│   ☑ CC-10 برش          مشاهده ☑  ثبت ☑                            │
│   ☑ CC-20 گلدوزی       مشاهده ☑  ثبت ☑                            │
│   ☐ CC-30 دوخت         مشاهده ☐  ثبت ☐                            │
│   ☐ CC-40 دکمه و یراق  مشاهده ☐  ثبت ☐                            │
│   ☐ CC-50 شستشو        مشاهده ☐  ثبت ☐                            │
│   ☐ CC-60 اتو          مشاهده ☐  ثبت ☐                            │
│   ☐ CC-90 انبار محصول  مشاهده ☐  ثبت ☐                            │
│   ℹ️ اگر هیچ مرکزی انتخاب نشود، دسترسی به همه مراکز آزاد است       │
│                                                                     │
│                                        [انصراف]  [💾 ذخیره]        │
└────────────────────────────────────────────────────────────────────┘
```

### API مدیریت دسترسی

```
GET    /api/rbac/roles                          فهرست نقش‌ها + ماتریس پیش‌فرض
GET    /api/rbac/users/:id/permissions          مجوزهای کاربر
PUT    /api/rbac/users/:id/permissions          ویرایش override
GET    /api/rbac/users/:id/cost-centers         مراکز مجاز
PUT    /api/rbac/users/:id/cost-centers         { cost_centers: [{id, can_view, can_post}] }
```

---

## ۱۰. سناریوهای دسترسی ترنم

| # | سناریو | تنظیم |
|---|--------|-------|
| ۱ | حامد (مدیرعامل) | `admin` — همه‌چیز |
| ۲ | حسابدار دفتر پخش | `accounting` — بستن دوره + بها + همه گزارش‌ها |
| ۳ | سرکارگر کارگاه | `production_manager` — بدون بستن دوره |
| ۴ | برشکار | `production_operator` + `user_cost_centers = [CC-10]` |
| ۵ | سرپرست دوخت | `production_operator` + `user_cost_centers = [CC-30]` |
| ۶ | اتوکار | `production_operator` + `user_cost_centers = [CC-60]` |
| ۷ | ویزیتور میدانی | `field_sales` — فقط برآورد سریع بدون بها |
| ۸ | مدیر فروش | `sales_manager` — سودآوری محصول (بدون بهای تفکیکی) |

---

## ۱۱. تست‌کیس‌ها

| # | عنوان | انتظار |
|---|-------|--------|
| TP-01 | نقش جدید | `production_manager` و `production_operator` در `ROLES` |
| TP-02 | منبع جدید | ۵ منبع production در `RESOURCES` |
| TP-03 | admin کامل | همه ۵ منبع × ۶ اکشن = `true` |
| TP-04 | **مخفی‌سازی بها** | `field_sales` → `GET /estimates/quick` بدون `unit_cost_rial` در JSON |
| TP-05 | **مخفی‌سازی بها اپراتور** | `production_operator` → `POST /stages/:id/issue` پاسخ بدون `var_*` |
| TP-06 | مرکز هزینه | operator با `[CC-10]` → `POST /stages/:sid/output` روی CC-30 → `403 E_FORBIDDEN_CC` |
| TP-07 | مرکز هزینه — بدون رکورد | کاربر بدون `user_cost_centers` → همه مراکز آزاد |
| TP-08 | فعال‌سازی BOM | `accounting` → `POST /boms/:id/activate` → `403` |
| TP-09 | فعال‌سازی BOM | `production_manager` → موفق |
| TP-10 | بستن دوره | `production_manager` → `POST /close/:p/execute` → `403` |
| TP-11 | بستن دوره | `accounting` → موفق |
| TP-12 | بازکردن دوره | `accounting` → `POST /close/:p/reopen` → `403` (فقط admin) |
| TP-13 | ایجاد سفارش | `production_operator` → `POST /orders` → `403` |
| TP-14 | ثبت مرحله | `production_operator` → `POST /stages/:sid/output` → موفق |
| TP-15 | Override | `user_permissions` روی `production_cost.view=1` برای یک ویزیتور خاص → بها می‌بیند |
| TP-16 | سود ماهانه | `production_manager` → `GET /reports/monthly-profit` → `403` |
| TP-17 | حسابرسی | هر CUD → رکورد در `audit_log` |
| TP-18 | عملیات پرخطر | `reopen` دوره → `audit_log` + `app_notifications` برای admin |
| TP-19 | دلیل اجباری | `reopen` بدون `reason` → `422` |
| TP-20 | `stripCostFields` بازگشتی | JSON تودرتو ۳ سطحی → همه `*_rial` حذف شود |

---

## ۱۲. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی RBAC ماژول تولید

## اسناد مرجع
- docs/Production/permissions.md   ← این سند
- docs/Production/api.md §12       ← الگوی Route + stripCostFields
- server/lib/rbac.js               ← کد موجود

## ⚠️ قواعد قطعی
1. **`stripCostFields` باید فیلدها را از JSON حذف کند، نه CSS مخفی کند.**
   تست: `field_sales` نباید بتواند `unit_cost_rial` را در Network tab ببیند.
   این مهم‌ترین الزام امنیتی این ماژول است.
2. `user_cost_centers` خالی = **بدون محدودیت** (نه بدون دسترسی).
   وگرنه admin هم قفل می‌شود.
3. تفکیک وظایف (§7) در کد اعمال شود، نه فقط RBAC:
   - `accounting` نمی‌تواند BOM فعال کند
   - `production_manager` نمی‌تواند دوره ببندد
   - فقط `admin` می‌تواند دوره/سفارش را بازکند
4. عملیات پرخطر → `audit` + `app_notifications` برای admin.
5. ترتیب موجود `RESOURCES` را تغییر نده — فقط append.

## گام‌ها

### گام ۱ — Schema
server/db.js:
  CREATE TABLE user_cost_centers  (§2.3)
  CREATE INDEX ix_ucc_user

### گام ۲ — rbac.js
- ۵ منبع production به انتهای RESOURCES (§6.1)
- ۲ نقش جدید به DEFAULT_ROLE_PERMISSIONS (§6.1)
- گسترش accounting/sales_manager/field_sales با منابع جدید
⚠️ نقش‌های موجود را برای منابع موجود تغییر نده

### گام ۳ — acl.js
server/lib/production/acl.js  (§6.2):
  assertUserCostCenter, costCenterFilter, canSeeCost, stripCostFields

### گام ۴ — اعمال در Route ها
هر route تولید:
  auth + requirePermission(resource, action)
  + assertUserCostCenter (روی endpoint های مرحله‌ای)
  + stripCostFields در پوشش handle() (§12 api.md)
  + کنترل‌های سطح endpoint (§5)

### گام ۵ — UI
1. صفحه کاربران → تب «دسترسی تولید» (§9)
   - ماتریس ۵ منبع × ۶ اکشن
   - چک‌باکس مراکز هزینه با can_view/can_post
   - هشدار وقتی production_cost خاموش است
2. مخفی‌سازی منوها بر اساس مجوز (client-side)
   ⚠️ این فقط UX است — امنیت واقعی سمت سرور است
3. RTL, Vazirmatn, #1B5C4A/#2D7A5F/#C9A84C

### گام ۶ — تست
server/scripts/test-production-rbac.js — ۲۰ تست از §11
حیاتی:
  TP-04  field_sales → JSON بدون unit_cost_rial
  TP-05  operator → JSON بدون var_*
  TP-06  E_FORBIDDEN_CC
  TP-07  بدون رکورد = بدون محدودیت
  TP-08  accounting نمی‌تواند BOM فعال کند
  TP-20  stripCostFields بازگشتی

## معیار پذیرش
- [ ] `curl` با توکن field_sales روی `/estimates/quick` → پاسخ فاقد هر فیلد `*_rial`
- [ ] operator با `[CC-10]` نمی‌تواند روی CC-30 ثبت کند
- [ ] کاربر بدون `user_cost_centers` به همه مراکز دسترسی دارد
- [ ] admin بدون تنظیم اضافی همه‌چیز را دارد
- [ ] `git diff` هیچ تغییری در مجوزهای منابع موجود ندارد

## ممنوعیت‌ها
- ❌ مخفی‌سازی بها فقط با CSS
- ❌ user_cost_centers خالی = بدون دسترسی
- ❌ تغییر مجوزهای منابع موجود
- ❌ اجازه بستن دوره به production_manager
````
