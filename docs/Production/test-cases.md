# test-cases.md
## تست‌کیس‌های یکپارچه — ماژول عملیات تولید

> **جمع:** ۲۹۷ تست‌کیس در ۱۲ فایل
> **الگو:** `server/scripts/test-*.js` موجود (مثل `test-v4-features.js`)

---

## ۰. زیرساخت تست

### ۰.۱ فایل‌های تست

| فایل | تعداد | ماژول | زمان |
|------|------:|:-----:|-----:|
| `test-production-schema.js` | ۱۵ | P0 | ۵ ثانیه |
| `test-production-bom.js` | ۲۴ | ۱ | ۱۰ ثانیه |
| `test-production-fixed.js` | ۳۰ | ۲ | ۱۵ ثانیه |
| `test-production-variable.js` | ۲۴ | ۳ | ۱۲ ثانیه |
| `test-production-bom-advanced.js` | ۲۹ | ۴ | ۱۲ ثانیه |
| `test-production-estimation.js` | ۳۱ | ۵ | ۱۵ ثانیه |
| `test-production-fixed-advanced.js` | ۴۰ | ۷ | ۲۵ ثانیه |
| `test-production-variable-advanced.js` | ۴۰ | ۸ | ۲۵ ثانیه |
| `test-production-close.js` | ۱۸ | بستن | ۱۰ ثانیه |
| `test-production-reports.js` | ۲۴ | ۶ | ۱۵ ثانیه |
| `test-production-rbac.js` | ۲۰ | RBAC | ۸ ثانیه |
| `test-production-reports-perf.js` | ۶ | کارایی | ۶۰ ثانیه |
| **جمع** | **۲۹۷** | | **~۳.۵ دقیقه** |

### ۰.۲ اسکریپت اصلی

```json
// server/package.json
{
  "scripts": {
    "test:production": "node scripts/test-production-all.js",
    "test:production:schema": "node scripts/test-production-schema.js",
    "test:production:bom": "node scripts/test-production-bom.js",
    "test:production:fixed": "node scripts/test-production-fixed.js",
    "test:production:variable": "node scripts/test-production-variable.js",
    "test:production:adv": "node scripts/test-production-fixed-advanced.js",
    "test:production:adv-var": "node scripts/test-production-variable-advanced.js",
    "test:production:close": "node scripts/test-production-close.js",
    "test:production:reports": "node scripts/test-production-reports.js",
    "test:production:rbac": "node scripts/test-production-rbac.js",
    "test:production:perf": "node scripts/test-production-reports-perf.js"
  }
}
```

```js
// server/scripts/test-production-all.js
const files = [
  'test-production-schema.js',
  'test-production-bom.js',
  'test-production-fixed.js',
  'test-production-variable.js',
  'test-production-bom-advanced.js',
  'test-production-estimation.js',
  'test-production-fixed-advanced.js',
  'test-production-variable-advanced.js',
  'test-production-close.js',
  'test-production-reports.js',
  'test-production-rbac.js',
];
let pass = 0, fail = 0;
for (const f of files) {
  const r = require('child_process').spawnSync('node', [__dirname + '/' + f], { stdio: 'inherit' });
  if (r.status === 0) pass++; else fail++;
}
console.log(`\n${'='.repeat(60)}`);
console.log(fail === 0 ? `✅ همه ${pass} فایل تست پاس شدند` : `❌ ${fail} فایل ناموفق از ${pass+fail}`);
process.exit(fail === 0 ? 0 : 1);
```

### ۰.۳ Harness مشترک

```js
// server/scripts/lib/test-harness.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else      { failed++; failures.push(name);
              console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

/** برابری عددی با تلورانس */
function eq(name, actual, expected, tol = 0) {
  const diff = Math.abs(Number(actual) - Number(expected));
  ok(name, diff <= tol,
     `انتظار ${Number(expected).toLocaleString()} · دریافت ${Number(actual).toLocaleString()} · اختلاف ${diff}`);
}

/** خطای مورد انتظار */
function throws(name, fn, code) {
  try { fn(); ok(name, false, 'خطایی رخ نداد'); }
  catch (e) { ok(name, (e.code || e.message).includes(code),
                 `انتظار ${code} · دریافت ${e.code || e.message}`); }
}

/** DB تازه در حافظه */
function freshDb() {
  const tmp = path.join(require('os').tmpdir(), `test-prod-${Date.now()}-${Math.random()}.db`);
  process.env.DB_PATH = tmp;
  delete require.cache[require.resolve('../../db')];
  const db = require('../../db');
  db.initDB();
  return { db: db.getDB(), cleanup: () => { try { fs.unlinkSync(tmp); } catch {} } };
}

/** داده نمونه ترنم */
function seedTaranom(db) { /* §۸ database-schema.md */ }

function summary(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${title}: ✅ ${passed} پاس · ${failed ? '❌ ' + failed + ' ناموفق' : '🎉 همه پاس'}`);
  if (failures.length) { console.log('\nناموفق‌ها:'); failures.forEach(f => console.log('  • ' + f)); }
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = { ok, eq, throws, freshDb, seedTaranom, summary };
```

---

## ۱. تست‌های حیاتی (Must-Pass)

> **اگر هر کدام از این ۱۸ تست قرمز باشد، سیستم قابل استفاده نیست.**

| # | تست | فایل | انتظار |
|---|-----|------|--------|
| **C-01** | WIP سفارش بسته = ۰ | `fixed` T2-09 | مانده `1111` = ۰ |
| **C-02** | WIP چندمرحله‌ای = ۰ | `adv` T7-30 | مانده `1111`/تفصیلی = ۰ |
| **C-03** | تراز کل ۱۱۱۱ | `adv` T7-31 | بدهکار = بستانکار = ۱٬۳۷۰٬۷۳۷٬۳۸۵ |
| **C-04** | همه اسناد تراز | `schema` C4 | هیچ سند نامتوازن |
| **C-05** | **بدون سند انحراف مواد** | `variable` T3-07 | `5210`/`5211` صفر رکورد |
| **C-06** | **بدون سند انتقال مرحله** | `adv` T7-10 | هیچ `*stage_transfer*` |
| **C-07** | ضایعات عادی بدون سند | `fixed` T2-06 | `je_id = NULL` |
| **C-08** | تجزیه انحراف | `variable` T3-05 | `Σ(MPV+MQV) = ΣAQ×AP − ΣSQ×SP` |
| **C-09** | تجزیه انحراف مرحله‌ای | `adv-var` T8-08 | = ۴۰٬۸۱۶٬۸۶۸ |
| **C-10** | بهای واحد ماژول ۲ | `fixed` T2-10 | ۲٬۲۵۶٬۸۹۷ |
| **C-11** | بهای واحد ماژول ۳ | `variable` T3-08 | ۲٬۲۹۹٬۶۹۷ |
| **C-12** | بهای واحد ماژول ۷ | `adv` T7-29 | ۲٬۳۱۵٬۸۸۰ |
| **C-13** | بهای واحد ماژول ۸ | `adv-var` T8-20 | ۲٬۳۶۶٬۴۶۳ |
| **C-14** | میانگین موزون FG | `fixed` T2-11 | ۲٬۲۳۳٬۸۰۲ |
| **C-15** | کنترلی‌ها صفر پس از بستن | `close` TC-12 | `5201`,`5202`,`5203` = ۰ |
| **C-16** | سود = صورت سود و زیان | `reports` T6-03 | تطابق کامل |
| **C-17** | **مخفی‌سازی بها** | `rbac` TP-04 | JSON فاقد `*_rial` |
| **C-18** | ابطال کامل | `fixed` T2-19 | موجودی + دفتر کل حالت اول |

---

## ۲. تست‌های Schema (P0) — ۱۵ تست

| # | عنوان | انتظار |
|---|-------|--------|
| TS-01 | بوت روی DB خالی | `initDB()` بدون خطا |
| TS-02 | بوت روی DB موجود | `initDB()` روی نسخه production بدون خطا |
| TS-03 | بوت دوباره (idempotent) | `initDB()` دو بار → بدون خطا |
| TS-04 | جداول جدید | ۲۴ جدول تولید موجود |
| TS-05 | ایندکس‌ها | همه ایندکس‌های `database-schema.md` موجود |
| TS-06 | Trigger ها | ۶ trigger موجود |
| TS-07 | **بدون ستون REAL پولی** | `PRAGMA table_info` → هیچ `*_rial` از نوع `REAL` |
| TS-08 | `SYNCABLE_TABLES` | ۲۴ جدول در انتها + ترتیب قبلی دست‌نخورده |
| TS-09 | `PROD_SEQUENCES` | ۱۱ دنباله در `number_sequences` |
| TS-10 | Seed مراکز | ۷ مرکز ترنم |
| TS-11 | Seed انبارها | ۵ انبار |
| TS-12 | Seed حساب‌ها | ۱۸ حساب تولید در `chart_of_accounts` |
| TS-13 | `coa-map` | ۲۰ کلید `coa_*` جدید resolve شود |
| TS-14 | Settings | ۲۳ تنظیم پیش‌فرض |
| TS-15 | VIEW ها | ۳ view موجود و قابل query |

```js
// نمونه TS-07 — حیاتی
const money = db.prepare(`SELECT m.name tbl, p.name col, p.type
  FROM sqlite_master m, pragma_table_info(m.name) p
  WHERE m.type='table' AND p.name LIKE '%_rial' AND p.type <> 'INTEGER'`).all();
ok('TS-07 هیچ ستون پولی REAL نیست', money.length === 0,
   money.map(r => `${r.tbl}.${r.col}=${r.type}`).join(', '));
```

```js
// نمونه TS-08 — حیاتی
const EXPECTED_PREFIX = ['users','settings','chart_of_accounts','customer_groups',
  'person_categories','cost_centers','warehouses','banks','cash_boxes','check_categories'];
const { SYNCABLE_TABLES } = require('../sync/tables');
const actual = SYNCABLE_TABLES.map(t => t.name);
ok('TS-08a ترتیب قبلی دست‌نخورده',
   EXPECTED_PREFIX.every((n, i) => actual[i] === n));
ok('TS-08b جداول تولید در انتها',
   actual.slice(-24).includes('bom_headers') && actual.slice(-24).includes('mrp_runs'));
```

---

## ۳. تست‌های بستن دوره — ۱۸ تست

| # | عنوان | انتظار |
|---|-------|--------|
| TC-01 | Precheck — سفارش باز | `can_close: false` + لیست سفارش‌ها |
| TC-02 | Precheck — حقوق ثبت نشده | `status: 'fail'` روی `PAYROLL_POSTED` |
| TC-03 | Precheck — همه پاس | `can_close: true` |
| TC-04 | **انحراف دستمزد** | `482,700` (واقعی ۲۶۵٬۰۰۰٬۰۰۰ − جذب ۲۶۴٬۵۱۷٬۳۰۰) |
| TC-05 | **انحراف سربار** | `1,481,162` (واقعی ۵۱٬۵۵۰٬۰۰۰ − جذب ۵۰٬۰۶۸٬۸۳۸) |
| TC-06 | انحراف به تفکیک مرکز | ۶ ردیف با جمع = ۱٬۴۸۱٬۱۶۲ |
| TC-07 | آستانه اهمیت | ۱٬۹۶۳٬۸۶۲ < ۹٬۹۲۳٬۸۳۰ → `method_auto='direct_cogs'` |
| TC-08 | **پایه تسهیم** | WIP ۱۲.۶۵٪ · FG ۲۰.۷۸٪ · COGS ۶۶.۵۷٪ |
| TC-09 | **تسهیم سربار** | WIP ۱۸۷٬۳۱۶ · FG ۳۰۷٬۷۷۶ · COGS ۹۸۶٬۰۷۰ |
| TC-10 | **تسهیم دستمزد** | WIP ۶۱٬۰۴۵ · FG ۱۰۰٬۳۰۲ · COGS ۳۲۱٬۳۵۳ |
| TC-11 | تراز سند PRD-23 | ۲۴۸٬۳۶۱ + ۴۰۸٬۰۷۸ + ۱٬۳۰۷٬۴۲۳ = ۱٬۹۶۳٬۸۶۲ |
| TC-12 | **کنترلی‌ها صفر** | `5201`=۰ · `5202`=۰ · `5203`=۰ · `5212`=۰ · `5215`=۰ |
| TC-13 | به‌روزرسانی میانگین FG | `average_cost_rial` کالاها + سهم تسهیم |
| TC-14 | تطابق ۱۱۰۴ | مانده `1104` = `Σ(stock × average_cost_rial)` |
| TC-15 | قفل دوره | ثبت پس از بستن → `409 E_PERIOD_CLOSED` |
| TC-16 | بازکردن — غیر admin | `403` |
| TC-17 | بازکردن — admin | موفق + `audit` + `app_notifications` |
| TC-18 | بستن دوباره | `409 E_ALREADY_CLOSED` |

```js
// نمونه TC-12 — حیاتی
const bal = (code) => db.prepare(`
  SELECT COALESCE(SUM(jl.debit_rial) - SUM(jl.credit_rial), 0) b
  FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_code = ? AND je.entry_date <= '1405/04/31'
    AND COALESCE(je.deleted_at,0) = 0`).get(code).b;

for (const c of ['5201','5202','5203','5212','5215']) {
  eq(`TC-12 مانده ${c} صفر است`, bal(c), 0, 5);
}
```

---

## ۴. تست ابطال کامل (C-18) — سناریوی طلایی

```js
// server/scripts/test-production-fixed.js — T2-19

function testFullReversal(db) {
  const before = snapshot(db);

  // ۱) تولید کامل
  const po = createOrder(db, { productId: 101, qtyPlanned: 300, analysisType: 'fixed' });
  releaseOrder(db, po.id);
  const r = postReceiptFixed(db, { orderId: po.id, body: {
    qty_produced: 294, waste_normal: 4, waste_abnormal: 2,
    scrap: [{ product_id: 299, qty: 27, nrv_unit_rial: 120000 }],
    date: '1405/04/12',
  }, userId: 1 });

  eq('T2-19a بهای واحد', r.costs.unit_cost_rial, 2256897);
  eq('T2-19b WIP پس از رسید', wipResidual(db, po.id), 0, 5);

  // ۲) ابطال معکوس
  for (const je of [...r.journal_entries].reverse())
    reverseEvent(db, { jeId: je.je_id, reason: 'تست ابطال', userId: 1 });

  const after = snapshot(db);

  // ۳) راستی‌آزمایی
  eq('T2-19c موجودی پارچه',   after.stock[201],  before.stock[201],  0.0001);
  eq('T2-19d موجودی آستر',    after.stock[202],  before.stock[202],  0.0001);
  eq('T2-19e موجودی FG',      after.stock[101],  before.stock[101],  0.0001);
  eq('T2-19f میانگین FG',     after.avg[101],    before.avg[101],    0);
  eq('T2-19g میانگین پارچه',  after.avg[201],    before.avg[201],    0);
  eq('T2-19h مانده 1111',     after.ledger['1111'], before.ledger['1111'], 5);
  eq('T2-19i مانده 1110',     after.ledger['1110'], before.ledger['1110'], 5);
  eq('T2-19j مانده 1104',     after.ledger['1104'], before.ledger['1104'], 5);
  eq('T2-19k مانده 5221',     after.ledger['5221'], before.ledger['5221'], 5);
  eq('T2-19l مانده 1113',     after.ledger['1113'], before.ledger['1113'], 5);
}

function snapshot(db) {
  const stock = {}, avg = {}, ledger = {};
  for (const p of db.prepare('SELECT id, stock, average_cost_rial FROM products').all()) {
    stock[p.id] = p.stock; avg[p.id] = p.average_cost_rial;
  }
  for (const c of ['1104','1110','1111','1112','1113','1114','5101','5201','5202','5203','5221']) {
    ledger[c] = db.prepare(`
      SELECT COALESCE(SUM(jl.debit_rial) - SUM(jl.credit_rial), 0) b
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0`).get(c).b;
  }
  return { stock, avg, ledger };
}
```

---

## ۵. تست فقط‌خواندنی گزارش‌ها (T6-12)

```js
// server/scripts/test-production-reports.js — T6-12 حیاتی

function testReportsReadOnly(db) {
  const checksum = () => {
    const tables = ['production_orders','production_order_stages','production_material_issues',
                    'production_receipts','production_labor_entries','production_waste',
                    'production_overhead_applications','production_variances',
                    'journal_entries','journal_lines','products','warehouse_stock'];
    return tables.map(t => {
      const r = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(rowid),0) s FROM ${t}`).get();
      return `${t}:${r.c}:${r.s}`;
    }).join('|');
  };

  const before = checksum();
  const REPORTS = ['PR-01','PR-02','PR-03','PR-04','PR-05','PR-06','PR-07','PR-08',
                   'PR-09','PR-10','PR-11','PR-12','PR-13','PR-14','PR-15','PR-16',
                   'PR-17','PR-18','PR-19','PR-20','PR-21','PR-22','PR-23','PR-24','PR-99'];

  for (const name of REPORTS) {
    try {
      runReport(db, { name, params: { period: '1405/04', date: '1405/04/31', order_id: 10 },
                      user: { id: 1, role: 'admin' } });
    } catch (e) { /* برخی گزارش‌ها پارامتر خاص می‌خواهند — مهم نیست */ }
  }

  const after = checksum();
  ok('T6-12 هیچ گزارشی داده را تغییر نداد', before === after,
     before === after ? '' : 'checksum تغییر کرد!');
}
```

---

## ۶. تست کارایی — ۶ تست

```js
// server/scripts/test-production-reports-perf.js

function seedLarge(db) {
  console.log('  ⏳ ساخت ۱۰٬۰۰۰ سفارش و ~۱۰۰٬۰۰۰ تراکنش...');
  db.transaction(() => {
    for (let i = 1; i <= 10000; i++) {
      // سفارش + ۶ مرحله + ~۱۰ تراکنش
    }
  })();
}

const BUDGET = {
  'PR-24 داشبورد':      1000,
  'PR-23 سود ماهانه':    500,
  'PR-10 مانده WIP':     300,
  'PR-01 لیست سفارش‌ها': 200,
  'PR-11 ماتریس انحراف': 400,
  'POST /estimates/quick': 500,
};

for (const [name, budget] of Object.entries(BUDGET)) {
  const t0 = Date.now();
  runReportByName(db, name);
  const dur = Date.now() - t0;
  ok(`${name} < ${budget}ms`, dur < budget, `${dur}ms`);
}

// تست ایندکس
const QUERIES = [ /* همه کوئری‌های گزارش */ ];
for (const q of QUERIES) {
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all();
  const scan = plan.find(p => /SCAN (?!.*USING)/.test(p.detail));
  ok(`${q.name} ایندکس می‌زند`, !scan, scan?.detail);
}
```

---

## ۷. ماتریس پوشش

| بخش | تست‌های واحد | یکپارچگی | حیاتی |
|-----|:------------:|:--------:|:-----:|
| Schema و migration | ۱۵ | ✅ | TS-07, TS-08 |
| BOM (۱) | ۲۴ | ✅ | T1-08, T1-09, T1-11 |
| آنالیز ثابت (۲) | ۳۰ | ✅ | T2-05, T2-09, T2-10, T2-11, T2-19 |
| آنالیز متغیر (۳) | ۲۴ | ✅ | T3-05, T3-07, T3-08, T3-14 |
| BOM پیشرفته (۴) | ۲۹ | ✅ | T4-06, T4-13, T4-15, T4-29 |
| برآورد + MRP (۵) | ۳۱ | ✅ | T5-06, T5-13, T5-22, T5-24 |
| ثابت پیشرفته (۷) | ۴۰ | ✅ | T7-10, T7-18, T7-29, T7-30, T7-31 |
| متغیر پیشرفته (۸) | ۴۰ | ✅ | T8-08, T8-09, T8-11, T8-20, T8-22 |
| بستن دوره | ۱۸ | ✅ | TC-09, TC-10, TC-12 |
| گزارشات (۶) | ۲۴ | ✅ | T6-02, T6-03, T6-06, T6-12 |
| RBAC | ۲۰ | ✅ | TP-04, TP-05, TP-06 |
| کارایی | ۶ | ✅ | همه |
| **جمع** | **۲۹۷** | | **۱۸ حیاتی** |

---

## ۸. Health-Check خودکار

```js
// server/scripts/test-production-health.js
// روی DB production واقعی اجرا می‌شود — فقط SELECT

const CHECKS = [
  { code:'H1', name:'WIP سفارش‌های بسته صفر است',      sql: /* §9 database-schema.md */ },
  { code:'H2', name:'حساب‌های کنترلی صفر هستند',       sql: /* ... */ },
  { code:'H3', name:'تطابق products.stock با انبار',    sql: /* ... */ },
  { code:'H4', name:'همه تراکنش‌ها سند دارند',          sql: /* ... */ },
  { code:'H5', name:'میانگین موزون معتبر',              sql: /* ... */ },
  { code:'C1', name:'je_id همه تراکنش‌های posted',      sql: /* §5 accounting-events.md */ },
  { code:'C2', name:'بدون سند انتقال مرحله (ADR-012)',  sql: /* ... */ },
  { code:'C3', name:'بدون سند انحراف مواد (ADR-011)',   sql: /* ... */ },
  { code:'C4', name:'همه اسناد تولیدی تراز',            sql: /* ... */ },
  { code:'C5', name:'کنترلی‌ها پس از بستن صفر',         sql: /* ... */ },
  { code:'C6', name:'WIP سفارش‌های closed صفر',         sql: /* ... */ },
  { code:'C7', name:'مانده 1114 سفارش‌های بسته صفر',    sql: /* ... */ },
];

let bad = 0;
for (const c of CHECKS) {
  const rows = db.prepare(c.sql).all();
  if (rows.length === 0) console.log(`✅ ${c.code} ${c.name}`);
  else { bad++; console.log(`❌ ${c.code} ${c.name} — ${rows.length} مورد:`);
         rows.slice(0, 5).forEach(r => console.log('     ', JSON.stringify(r))); }
}
process.exit(bad === 0 ? 0 : 1);
```

**اجرای خودکار:**
```js
// server/server.js — کرون شبانه ساعت ۰۲:۰۰
setInterval(() => {
  const h = new Date().getHours();
  if (h === 2) {
    const r = require('child_process').spawnSync('node', [__dirname + '/scripts/test-production-health.js']);
    if (r.status !== 0) {
      db.prepare(`INSERT INTO app_notifications (kind, entity_type, title, body, target_role)
                  VALUES ('critical','production','🔴 مغایرت در ماژول تولید', ?, 'admin')`)
        .run(r.stdout.toString().slice(0, 1000));
    }
  }
}, 3600_000);
```

---

## ۹. داده تست مشترک

```js
// server/scripts/lib/seed-taranom.js
// همان §۸ در database-schema.md

const PRODUCTS = [
  { id:101, name:'مانتو کتان ترمه — سبز', item_type:'finished',  is_manufactured:1,
    unit:'عدد', stock:50, average_cost_rial:2100000, price_rial:3200000 },
  { id:201, name:'پارچه کتان ۱۴۰ سانت — سبز', item_type:'raw',
    unit:'متر', stock:620, average_cost_rial:950000, std_cost_rial:900000,
    lead_time_days:15, min_order_qty:50, safety_stock:50 },
  { id:202, name:'آستر ساده', item_type:'raw',
    unit:'متر', stock:150, average_cost_rial:180000, std_cost_rial:175000,
    lead_time_days:7, safety_stock:20 },
  { id:203, name:'نخ دوخت پلی‌استر', item_type:'raw',
    unit:'قرقره', stock:120, average_cost_rial:85000, std_cost_rial:85000,
    lead_time_days:3, safety_stock:10 },
  { id:204, name:'دکمه چوبی ۲۰ میل', item_type:'raw',
    unit:'عدد', stock:2000, average_cost_rial:12000, std_cost_rial:12500,
    lead_time_days:20, min_order_qty:1000, safety_stock:200 },
  { id:205, name:'لیبل برند ترنم', item_type:'packaging',
    unit:'عدد', stock:5000, average_cost_rial:6000, std_cost_rial:6000, lead_time_days:10 },
  { id:206, name:'نایلون بسته‌بندی', item_type:'packaging',
    unit:'عدد', stock:300, average_cost_rial:9000, std_cost_rial:9000, lead_time_days:5 },
  { id:299, name:'ضایعات پارچه (خرده)', item_type:'scrap',
    unit:'کیلوگرم', stock:0, average_cost_rial:120000 },
];

const BOM = {
  code:'BOM-000101', product_id:101, version:2, revision:'B',
  base_qty:1, status:'active', valid_from:'1405/01/01', is_default:1,
  is_multilevel:0, has_routing:1, has_coproducts:1,
  yield_percent:100,        // ⚠️ V4-21 — چون has_routing=1
  size_range:'38-48', color_variant:'سبز',
  lines: [
    { line_no:1, component_product_id:201, qty_per_base:1.60, scrap_percent:4,
      stage_cost_center_id:1, line_type:'material', std_cost_rial:900000,
      size_matrix:'{"38":1.45,"40":1.50,"42":1.55,"44":1.60,"46":1.70,"48":1.80}' },
    { line_no:2, component_product_id:202, qty_per_base:0.35, scrap_percent:3,
      stage_cost_center_id:1, line_type:'material', std_cost_rial:175000 },
    { line_no:3, component_product_id:203, qty_per_base:0.08, scrap_percent:0,
      stage_cost_center_id:3, line_type:'material', std_cost_rial:85000 },
    { line_no:4, component_product_id:204, qty_per_base:6, scrap_percent:2,
      stage_cost_center_id:4, line_type:'material', std_cost_rial:12500 },
    { line_no:5, component_product_id:205, qty_per_base:1, scrap_percent:0,
      stage_cost_center_id:6, line_type:'packaging', std_cost_rial:6000 },
    { line_no:6, component_product_id:206, qty_per_base:1, scrap_percent:0,
      stage_cost_center_id:6, line_type:'packaging', std_cost_rial:9000 },
  ],
  operations: [
    { seq:10, cost_center_id:1, operation_name:'برش', setup_minutes:30,
      run_minutes_per_unit:1.2, machine_minutes_per_unit:0, labor_method:'monthly',
      labor_rate_rial:0, crew_size:2, yield_percent:100, normal_waste_percent:2 },
    { seq:20, cost_center_id:2, operation_name:'گلدوزی', setup_minutes:15,
      run_minutes_per_unit:3.0, machine_minutes_per_unit:3.0, labor_method:'piece',
      labor_rate_rial:45000, crew_size:1, yield_percent:100, normal_waste_percent:0 },
    { seq:30, cost_center_id:3, operation_name:'دوخت', setup_minutes:20,
      run_minutes_per_unit:11.0, machine_minutes_per_unit:11.0, labor_method:'piece',
      labor_rate_rial:180000, crew_size:1, yield_percent:100, normal_waste_percent:1 },
    { seq:40, cost_center_id:4, operation_name:'دکمه و یراق', setup_minutes:5,
      run_minutes_per_unit:2.5, machine_minutes_per_unit:0, labor_method:'piece',
      labor_rate_rial:25000, crew_size:1, yield_percent:100, normal_waste_percent:0 },
    { seq:50, cost_center_id:5, operation_name:'شستشو', setup_minutes:0,
      run_minutes_per_unit:0.5, machine_minutes_per_unit:0, labor_method:'contract',
      labor_rate_rial:0, crew_size:1, yield_percent:100, normal_waste_percent:1.5,
      is_subcontract:1, subcontract_supplier_id:7, subcontract_fee_rial:38000 },
    { seq:60, cost_center_id:6, operation_name:'اتو و بسته‌بندی', setup_minutes:0,
      run_minutes_per_unit:2.0, machine_minutes_per_unit:0, labor_method:'monthly',
      labor_rate_rial:0, crew_size:2, yield_percent:100, normal_waste_percent:0,
      is_qc_gate:1 },
  ],
  outputs: [
    { product_id:101, output_type:'main', qty_per_base:1,
      cost_method:'share', cost_share_percent:100, warehouse_id:2 },
    { product_id:299, output_type:'by',   qty_per_base:0.09,
      cost_method:'nrv',  nrv_rial:120000, warehouse_id:5 },
  ],
};

const RATES = [
  { cost_center_id:1, period_label:'1405/04', driver:'material_rial',
    total_rate_rial:9000,    monthly_labor_rate_rial:25000, status:'active' },
  { cost_center_id:2, period_label:'1405/04', driver:'machine_hours',
    total_rate_rial:1200000, monthly_labor_rate_rial:0,     status:'active' },
  { cost_center_id:3, period_label:'1405/04', driver:'direct_labor_rial',
    total_rate_rial:350000,  monthly_labor_rate_rial:0,     status:'active' },
  { cost_center_id:4, period_label:'1405/04', driver:'output_qty',
    total_rate_rial:8000,    monthly_labor_rate_rial:0,     status:'active' },
  { cost_center_id:5, period_label:'1405/04', driver:'output_qty',
    total_rate_rial:5000,    monthly_labor_rate_rial:0,     status:'active' },
  { cost_center_id:6, period_label:'1405/04', driver:'output_qty',
    total_rate_rial:12000,   monthly_labor_rate_rial:15000, status:'active' },
];
```

---

## ۱۰. اعداد مرجع (Golden Numbers)

> **این جدول قرارداد کل سیستم است. اگر عددی تغییر کرد، یا کد باگ دارد یا تست باید به‌روز شود.**

### ماژول ۲ — `PO-1405-0001` (fixed, ۳۰۰ عدد، yield سرفصل ۹۷٪)

| فیلد | مقدار |
|------|------:|
| پارچه `qty_final` | ۵۱۵.۴۶۳۹ |
| آستر `qty_final` | ۱۱۱.۵۹۵۳ |
| نخ `qty_final` | ۲۴.۷۴۲۳ |
| دکمه `qty_final` | ۱٬۸۹۳.۵۴۰۹ |
| مواد | ۵۳۴٬۶۰۳٬۴۵۷ |
| بسته‌بندی | ۴٬۶۳۹٬۱۷۵ |
| دستمزد | ۸۷٬۰۰۰٬۰۰۰ |
| سربار | ۴۵٬۰۰۰٬۰۰۰ |
| WIP ناخالص | ۶۷۱٬۲۴۲٬۶۳۲ |
| ضایعات غیرعادی (۲) | ۴٬۴۷۴٬۹۵۱ |
| ضایعات فروشی | ۳٬۲۴۰٬۰۰۰ |
| **WIP خالص** | **۶۶۳٬۵۲۷٬۶۸۱** |
| **بهای واحد** | **۲٬۲۵۶٬۸۹۷** |
| میانگین FG جدید | ۲٬۲۳۳٬۸۰۲ |

### ماژول ۳ — `PO-1405-0004` (variable)

| فیلد | مقدار |
|------|------:|
| مواد واقعی | ۵۴۷٬۴۱۰٬۰۰۰ |
| بسته‌بندی واقعی | ۴٬۵۰۰٬۰۰۰ |
| استاندارد کل | ۵۱۳٬۸۵۸٬۲۳۰ |
| انحراف نرخ | +۲۶٬۰۷۵٬۰۰۰ |
| انحراف مقدار | +۱۱٬۹۷۶٬۷۷۰ |
| انحراف کل | +۳۸٬۰۵۱٬۷۷۰ |
| WIP ناخالص | ۶۸۳٬۹۱۰٬۰۰۰ |
| **WIP خالص** | **۶۷۶٬۱۱۰٬۶۰۰** |
| **بهای واحد** | **۲٬۲۹۹٬۶۹۷** |

### ماژول ۴ و ۷ — `PO-1405-0010` (fixed_adv, ۳۰۰ هدف → ۳۱۴ شروع)

| مرحله | `cost_out_rial` |
|-------|----------------:|
| ۱۰ برش | ۵۳۰٬۰۶۸٬۵۲۵ |
| ۲۰ گلدوزی | ۵۶۲٬۳۷۹٬۱۲۵ |
| ۳۰ دوخت | ۶۳۹٬۲۹۰٬۲۸۵ |
| ۴۰ یراق | ۶۷۲٬۴۱۲٬۸۸۵ |
| ۵۰ شستشو | ۶۸۵٬۵۱۲٬۵۲۵ |
| ۶۰ اتو | **۶۹۸٬۳۲۴٬۵۰۰** |
| محصول فرعی | ۳٬۳۹۱٬۲۰۰ |
| **رسید FG** | **۶۹۴٬۹۳۳٬۳۰۰** |
| **بهای واحد** | **۲٬۳۱۵٬۸۸۰** |
| تراز `1111` | ۱٬۳۷۰٬۷۳۷٬۳۸۵ |
| `qty_out` نهایی | ۳۰۰.۰۷۳۱۵۸ |
| بازده کل | ۹۵.۵۶۴۷٪ |

### ماژول ۸ — `PO-1405-0012` (variable_adv)

| مرحله | `cost_out_rial` |
|-------|----------------:|
| ۱۰ برش | ۵۴۵٬۰۸۱٬۹۶۰ |
| ۲۰ گلدوزی | ۵۷۷٬۳۹۲٬۵۶۰ |
| ۳۰ دوخت | ۶۵۴٬۳۷۸٬۵۲۰ |
| ۴۰ یراق | ۶۸۷٬۵۹۱٬۷۳۲ |
| ۵۰ شستشو | ۷۰۰٬۶۹۱٬۳۷۲ |
| ۶۰ اتو | **۷۱۳٬۵۰۳٬۳۴۷** |
| **رسید FG** | **۷۱۰٬۱۱۲٬۱۴۷** |
| **بهای واحد** | **۲٬۳۶۶٬۴۶۳** |
| تراز `1111` | ۱٬۴۰۱٬۰۹۵٬۰۷۹ |
| انحراف نرخ | +۲۶٬۵۷۵٬۰۰۰ |
| انحراف مقدار | +۱۴٬۲۴۱٬۸۶۸ |
| انحراف کل | +۴۰٬۸۱۶٬۸۶۸ |
| ماتریس CC-10 | +۴۱٬۶۱۲٬۶۸۰ |
| سربار مرحله ۱۰ | ۴٬۷۹۱٬۹۶۰ *(≠ ۴٬۶۵۸٬۰۴۴ ماژول ۷)* |

### ماژول ۵ — برآورد ۵۰۰ عدد

| فیلد | مقدار |
|------|------:|
| `qty_start` | ۵۲۴ |
| `qty_out` | ۵۰۰.۷۵۹۰۲۸ |
| **بهای واحد** | **۲٬۳۱۵٬۸۸۰** *(= ۳۰۰ عدد — مقیاس‌ناپذیر)* |
| Mark-up ۳۵٪ | ۳٬۱۲۶٬۴۳۸ |
| Margin ۳۵٪ | ۳٬۵۶۲٬۸۹۲ |
| نقطه شکست | ۲۴.۲۲٪ |
| سود تخفیف ۱۵٪ | ۲۸۱٬۷۲۰ ریال/عدد |

### بستن ماه ۱۴۰۵/۰۴

| فیلد | مقدار |
|------|------:|
| انحراف دستمزد | ۴۸۲٬۷۰۰ |
| انحراف سربار | ۱٬۴۸۱٬۱۶۲ |
| انحراف کل | ۱٬۹۶۳٬۸۶۲ |
| پایه WIP | ۱۲.۶۵٪ |
| پایه FG | ۲۰.۷۸٪ |
| پایه COGS | ۶۶.۵۷٪ |
| تسهیم → WIP | ۲۴۸٬۳۶۱ |
| تسهیم → FG | ۴۰۸٬۰۷۸ |
| تسهیم → COGS | ۱٬۳۰۷٬۴۲۳ |
| COGS نهایی | ۱٬۳۲۲٬۵۴۵٬۶۴۲ |
| **سود ناخالص** | **۱٬۱۴۰٬۴۵۴٬۳۵۸** (۴۶.۳٪) |
| **سود عملیاتی** | **۷۹۸٬۵۹۱٬۳۵۸** (۳۲.۴٪) |

---

## ۱۱. CI/CD

```yaml
# .github/workflows/production-tests.yml
name: Production Module Tests
on:
  push:    { paths: ['server/lib/production/**','server/routes/production-*','server/db.js'] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd server && npm ci
      - run: cd server && npm run test:production
      - name: تست کارایی (فقط main)
        if: github.ref == 'refs/heads/main'
        run: cd server && npm run test:production:perf
```

**قبل از هر deploy روی VPS:**
```bash
ssh -p 2299 taranom-admin@45.90.98.99
cd /var/www/crm-taranom/server
git pull
npm ci
npm run test:production          # همه سبز؟
node scripts/test-production-health.js   # روی DB واقعی
pm2 restart erp-taranom
```

---

## ۱۲. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی تست‌های ماژول تولید

## اسناد مرجع
- docs/Production/test-cases.md   ← این سند
- §21 هر سند ماژول (جدول تست‌کیس‌ها)
- server/scripts/test-v4-features.js  ← الگوی موجود

## ⚠️ قواعد قطعی
1. **جدول «اعداد مرجع» (§10) قرارداد است.** اگر تست شکست، اول کد را شک کن نه تست را.
2. هر فایل تست روی **DB تازه** اجرا شود (`freshDb()`), نه DB مشترک.
3. تلورانس: مبالغ ریالی ±۵ · مقادیر ±۰.۰۰۰۱ · درصد ±۰.۰۱
4. تست‌های حیاتی (§1) باید در خروجی **جدا برجسته** شوند.
5. `test-production-health.js` روی **DB production** اجرا می‌شود — فقط SELECT.
6. خروجی فارسی + رنگی + exit code صحیح.

## گام‌ها

### گام ۱ — زیرساخت
server/scripts/lib/test-harness.js  (§0.3)
server/scripts/lib/seed-taranom.js  (§9)
server/scripts/test-production-all.js (§0.2)
package.json scripts (§0.2)

### گام ۲ — فایل‌های تست (به ترتیب)
1. test-production-schema.js          ۱۵ تست (§2)
2. test-production-bom.js             ۲۴ تست (01 §21)
3. test-production-fixed.js           ۳۰ تست (02 §21)  ← شامل T2-19 (§4)
4. test-production-variable.js        ۲۴ تست (03 §18)
5. test-production-bom-advanced.js    ۲۹ تست (04 §18)
6. test-production-estimation.js      ۳۱ تست (05 §20)
7. test-production-fixed-advanced.js  ۴۰ تست (07 §18)
8. test-production-variable-advanced.js ۴۰ تست (08 §18)
9. test-production-close.js           ۱۸ تست (§3)
10. test-production-reports.js        ۲۴ تست (06 §14) ← شامل T6-12 (§5)
11. test-production-rbac.js           ۲۰ تست (permissions §11)
12. test-production-reports-perf.js    ۶ تست (§6)
13. test-production-health.js         ۱۲ چک (§8)

### گام ۳ — کرون سلامت
server/server.js: اجرای شبانه test-production-health.js
اگر ناموفق → app_notifications برای admin (§8)

### گام ۴ — CI
.github/workflows/production-tests.yml (§11)

## معیار پذیرش
- [ ] `npm run test:production` → ۲۹۷ تست، همه سبز
- [ ] ۱۸ تست حیاتی (§1) جدا برجسته شوند
- [ ] `node scripts/test-production-health.js` روی DB خالی → همه ✅
- [ ] زمان کل < ۴ دقیقه
- [ ] هر فایل مستقل قابل اجرا
- [ ] exit code صحیح (۰ موفق / ۱ ناموفق)

## ممنوعیت‌ها
- ❌ DB مشترک بین فایل‌های تست
- ❌ تغییر «اعداد مرجع» بدون بررسی کد
- ❌ تست‌های وابسته به ترتیب اجرا
- ❌ mock کردن postToLedger (باید واقعی ثبت شود)
- ❌ نوشتن در DB در تست‌های گزارش
````
