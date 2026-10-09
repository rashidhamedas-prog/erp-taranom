# تحقیق بانک و صندوق — تنظیمات حرفه‌ای + ثبت‌های دقیق

**وضعیت:** Research (pre-ADR) — Wave 0 freeze  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**منبع:** skill-top full + [Map bank/fund deps](46244120-97ac-45d0-a317-e7b144e72716) + [Treasury settings gap](cc7088cf-3c32-412e-a9a7-8f01de9e7474) + tap-erp-architecture + ECC architect  
**Slack:** در workspace متصل پیامی دربارهٔ بانک/صندوق/ترنم یافت نشد — منبع حقیقت کد + CHANGE-LOG است.

## هدف محصول

هر موجودیت منوی **حسابداری → بانک و صندوق** (و هر مسیری که به آن پست می‌زند) باید:

1. طبق قوانین خودش روی دفتر کل اثر بگذارد (دوطرفه، اتمیک، قابل ابطال R13).
2. تنظیمات حرفه‌ای **per-entity** داشته باشد (نه فقط فیلدهای عمومی و COA سراسری).
3. مانده زنده از **جمع خطوط JE روی `coa_code`** باشد (نه موجودی denormalized جدا).

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** اطلاعات پایه | بانک / صندوق / دسته چک | فرم‌ها + افتتاحیه JE |
| **B** عملیات | انتقال / تنخواه / دریافت‌پرداخت وابسته | API جدا؛ تنخواه = پرچم روی صندوق |
| **C** تطبیق و POS | صورت بانک / کارتخوان | پل v241؛ POS → ۱۱۱۸ → بانک |
| **D** تنظیمات حرفه‌ای per-entity | سقف، کارمزد پیش‌فرض، overdraft، تأیید | عمدتاً **MISSING** |

## محدوده منو (UI)

منبع: `server/public/acc-nav.js` — عنوان `بانک و صندوق`

| زیرگروه | Route id | API |
|----------|----------|-----|
| اطلاعات پایه | `acc-banks` / `acc-cash-boxes` / `acc-check-categories` | `/api/banks` · `/cash-boxes` · `/check-categories` |
| عملیات | `acc-account-transfer` / `acc-petty-cash-ops` | `/api/transfers` · هزینه/انتقال روی `is_petty_cash` |
| گزارشات | `acc-treasury-dashboard` / `acc-bank-recon` / `acc-pos-report` / `acc-cash-flow-std` | treasury-dashboard · bank-reconciliation · pos · cash-flow |

## ثابت پول

- مبالغ DB = INTEGER ریال.
- `postToLedger` خطوط را با تومان (`rialToLedger` = ÷۱۰) می‌نویسد مگر مسیر `debit_rial`/`credit_rial` بدهد.
- کارمزد انتقال فقط برای `bank` / `bank_transfer`؛ نقد/چک/POS کارمزد را صفر می‌کند (`payment-bank-fee.js`).

---

## ۱) موجودیت‌ها و ستون‌ها

### ۱.۱ `banks`

| ستون | مبدأ | نقش |
|------|------|-----|
| `name`, `account_number`, `branch`, `active` | CREATE `db.js` | پایه |
| `account_type`, `phone`, `card_*`, `sheba`, `note` | ensureColumn | متادیتا |
| `coa_code`, `opening_balance_*` | ensureColumn | پیوند دفتر + افتتاحیه |
| `extra_accounts` | ensureColumn | JSON حساب‌های فرعی |
| `currency`, `is_foreign` | `update11-schema.js` | پرچم ارزی؛ تطبیق ریالی رد می‌کند |

**پیوند دفتر:** `syncBankAccount` → `coa_code` یا `1102-{id}` (محک اغلب `206001…`).

### ۱.۲ `cash_boxes`

| ستون | نقش |
|------|-----|
| `custodian`, `is_petty_cash` | مسئول متنی؛ تنخواه = پرچم |
| `coa_code`, `opening_balance_*` | مثل بانک زیر ۱۱۰۱ / `206002…` |
| `currency`, `is_foreign` | مشابه بانک |

**خلاصه تنخواه:** `GET /cash-boxes/petty-cash/summary` — فقط مانده GL؛ بدون سقف/تأیید.

### ۱.۳ سایر جداول دامنه

| جدول | نقش |
|------|-----|
| `account_transfers` | انتقال داخلی + `fee_rial` + R13؛ ستون‌های FX در update11 **استفادهٔ route ندارند** |
| `bank_reconciliations` + items + `bank_statement_lines` | تطبیق؛ `gap-accounting-schema.js` |
| `check_categories` | دسته چک؛ `leaf_count` / `current_leaf` |
| `pos_terminals` (+ receipts/batches) | ترمینال → `bank_id` اجباری |
| `cheque_records` | چرخه نزد صندوق → وصول → بانک |
| `settlements` / `expense_payments` / `supplier_payments` / `incentive_payments` / `payroll_payments` | مصرف‌کنندگان بانک/صندوق |

### ۱.۴ کلیدهای COA مرتبط (`coa-map.js`)

| کلید | کد | نقش |
|------|-----|-----|
| `coa_cash_default` | ۱۱۰۱ | صندوق عمومی |
| `coa_bank_default` | ۱۱۰۲ | بانک عمومی |
| `coa_cheques_receivable` | ۱۱۰۹ | اسناد نزد صندوق |
| `coa_cheques_in_collection` | ۱۱۱۶ | در جریان وصول |
| `coa_card_in_transit` | ۱۱۱۸ | وجوه کارتخوان |
| `coa_cheques_payable` | ۲۱۰۹ | اسناد پرداختنی |
| `coa_card_fee` | ۶۱۱۴ | کارمزد POS |
| `coa_bank_fee` | ۶۱۱۵ | کارمزد انتقال/تطبیق |
| `coa_bank_interest` | ۴۱۱۵ | سود سپرده |
| `coa_opening_balance` | (mapped) | طرف افتتاحیه |

---

## ۲) گراف وابستگی (چه کسی به بانک/صندوق پست می‌زند)

```
banks / cash_boxes (master + opening JE)
        │
settle / invoice splits ──► Dr bank|cash|1109|1118 / Cr AR
POS receipt ──────────────► Dr 1118
POS batch ────────────────► Dr bank + 6114 [+admin] / Cr 1118
transfer ─────────────────► Dr dest / Cr src [+6115 اگر مبدأ بانک]
expense / supplier / ─────► Dr dest [+6115] / Cr bank|cash
 incentive / account-pay
payroll pay ──────────────► Dr payable / Cr bank|cash
cheque send-to-bank ──────► Dr 1116 / Cr 1109
cheque clear ─────────────► Dr bank* / Cr 1116
bank recon close ─────────► Dr 6115 یا Cr 4115 vs bank*
petty UI ─────────────────► همان expense + transfer روی صندوق تنخواه
```

**Resolverها:** `resolveCashAccount` (`db.js`) · `settlementAssetAccount` (`invoice-payments.js`) · `transferLines` / `outboundPaymentLines` (`payment-bank-fee.js`).

---

## ۳) قالب‌های JE (قفل برای ADR)

مقادیر اقتصادی به ریال؛ موتور خطوط تومان می‌نویسد. **Bank*** / **Cash*** = تفصیلی mapped.

| عملیات | `sourceType` | بدهکار | بستانکار |
|--------|--------------|--------|----------|
| افتتاحیه بانک | `bank_opening` | Bank* | `coa_opening_balance` |
| افتتاحیه صندوق | `cash_opening` | Cash* | `coa_opening_balance` |
| ابطال افتتاحیه | `*_opening_reversal` | reverse JE | |
| انتقال بدون کارمزد | `transfer` | To* | From* |
| انتقال از بانک + کارمزد | `transfer` | To*(اصل) · ۶۱۱۵(کارمزد) | FromBank*(اصل+کارمزد) |
| ابطال انتقال | `transfer_reversal` | آینه | |
| دریافت تسویه نقد/بانک | `settlement` | Cash*/Bank* | AR مشتری |
| دریافت چک (مسیر فاکتور) | `settlement` | **۱۱۰۹** | AR |
| پرداخت خروجی + کارمزد | `expense_payment` / `supplier_payment` / … | Dest · [۶۱۱۵] | Bank*(اصل+کارمزد) |
| دریافت از حساب | `account_receipt` | Cash*/Bank* | COA مبدأ |
| POS swipe | `pos_receipt` | **۱۱۱۸** | AR/فروش |
| POS settle | `pos_batch` | Bank*(خالص) · ۶۱۱۴ · کمبود | ۱۱۱۸(ناخالص) |
| خواباندن چک | `cheque_send_to_bank` | ۱۱۱۶ | ۱۱۰۹ |
| وصول چک | `cheque_clear` | Bank* | ۱۱۱۶ |
| تطبیق — کارمزد بانک | recon close | ۶۱۱۵ | Bank* |
| تطبیق — سود سپرده | recon close | Bank* | ۴۱۱۵ |
| اقلام زمان‌بندی تطبیق | — | **بدون JE** | |
| پرداخت حقوق | `payroll_payment` | حقوق پرداختنی | Cash*/Bank* |

**Invariant کارمزد:** دفتر طرف‌حساب فقط اصل را می‌بیند؛ ۶۱۱۵ هزینه شرکت است.

---

## ۴) ماتریس تنظیمات حرفه‌ای

| تنظیم | وضعیت | شواهد |
|-------|--------|--------|
| `active` بانک/صندوق | **EXISTS** | CREATE + PUT؛ POS `requireActiveBank` |
| شعبه بانک | **EXISTS** | متن آزاد |
| مسئول صندوق | **PARTIAL** | `custodian` متن؛ بدون `user_id`/RBAC |
| ارز / ارزی | **PARTIAL** | ستون+UI؛ تطبیق FX را رد؛ انتقال FX بلااستفاده |
| افتتاحیه + void-opening | **EXISTS** | banks/cash-boxes |
| پیوند `coa_code` | **EXISTS** | allocTafsili + sync* |
| شبا روی بانک | **PARTIAL** | ذخیره؛ اعتبارسنجی سرور مثل چک نیست |
| `extra_accounts` | **EXISTS** | JSON |
| سقف اضافه برداشت | **MISSING** | مانده منفی ممکن؛ فقط هشدار داشبورد |
| حساب کارمزد/سود per-bank | **MISSING** | سراسری ۶۱۱۵ / ۴۱۱۵ |
| جدول کارمزد٪ | **MISSING** | فقط `fee_rial` دستی |
| سقف تنخواه / افزایش اجباری | **MISSING** | فقط پرچم |
| تأیید دوگانه / سقف مبلغ | **MISSING** | adminOrAccounting |
| پروفایل تطبیق per-bank | **PARTIAL** | auto-match سراسری مبلغ دقیق ±۱ روز |
| پیوند POS↔بانک | **EXISTS** | `bank_id` |
| کارمزد٪ پیش‌فرض POS | **MISSING** | دستی در batch |
| دسته چک leaf | **PARTIAL** | شمارش تقریبی؛ تخصیص سریالی سخت نیست |
| بلاک عملیات روی غیرفعال | **PARTIAL** | همه‌جا سرور یکسان نیست |
| بازنشستگی master بدون DELETE | **PARTIAL** | ترجیح `active=0`؛ DELETE فیزیکی اگر بدون ارجاع |

---

## ۵) شکاف‌های قفل‌شده برای ADR (اولویت صحت تراز)

1. **ناسازگاری چک در تسویه standalone:** مسیر فاکتور → ۱۱۰۹؛ `POST /settlements` با `pay_type=cheque` ممکن است از `resolveCashAccount` به سطل بانک برود — ریسک اشتباه‌طبقه‌بندی نقد/اسناد.
2. **کد دوگانه بانک** (`1102-{id}` در برابر `206001…`): heal در `/balances`؛ گزارش‌ها اگر هر دو کد خط داشته باشند می‌شکافند.
3. **بازنویسی vs ابطال:** `amend-cash-ops` همان JE را بازنویسی می‌کند (برای لینک چک خوب است) ولی باید برای وصول‌شده/POS مسدود بماند (الان هست).
4. **DELETE فیزیکی master** بعد از reverse افتتاحیه — برای R13 حرفه‌ای باید فقط غیرفعال‌سازی + آزادسازی تفصیلی کنترل‌شده باشد.
5. **GET `/balances` با side-effect تعمیر افتتاحیه** می‌تواند بدون عمل کاربر JE بزند.

---

## ۶) Sync

**جداول syncable:** `banks`, `cash_boxes`, `check_categories`, `account_transfers`, `bank_reconciliations`, `bank_reconciliation_items`, `bank_statement_lines`, `pos_*`, `cheque_records`, …  
**PATH_TABLE_MAP:** `/api/banks`, `/cash-boxes`, `/check-categories`, `/transfers`, `/bank-reconciliation`, `/pos/*`, settlements/expenses/payroll/cheque-records.  
هر جدول/مسیر تنظیمات جدید → append-only + `sync_seq_backfill_vN` + در صورت نیاز `FK_COLUMNS`.

---

## ۷) تست‌های موجود (مرجع موج بعد)

`test-payment-bank-fee-v261` · `test-bank-recon-bridge-v241` · `test-bank-recon-import` · `test-bank-cash-live-v235` · `test-treasury-dashboard-v242` · `test-amend-cash-ops-v322` · POS stitch · cheque suite · `win-native/.../test-wave3-treasury.js`  
بعد از بک‌اند: همیشه `test-sms` + `test-sync`.

---

## ۸) موج‌های پیشنهادی (بدون کد در این نوبت)

| موج | محتوا |
|-----|--------|
| **0** | همین سند (freeze تحقیق) |
| **1** | ADR-TREASURY-01 تنظیمات per-entity · ADR-02 invariants پستینگ · ADR-03 R13 masters |
| **2** | schema تنظیمات (سقف تنخواه، overdraft، fee/interest COA، recon_profile، custodian_user_id) + sync |
| **3** | سخت‌سازی پستینگ: unify چک→۱۱۰۹ · بلاک inactive · overdraft اختیاری · fee COA per-bank |
| **4** | UI فرم‌های حرفه‌ای + راهنمای داخل برنامه + SW |
| **5** | تست هویت تراز + deploy |

**Quick win قبل از موج تنظیمات:** یکسان‌سازی پستینگ چک standalone روی ۱۱۰۹.

---

## ۹) تصمیم‌ها (قفل‌شده در ADR-001 Option 1)

1. ADR + پیاده‌سازی Option 1 هم‌زمان (نه فقط docs).
2. Overdraft: بلاک سخت per-bank؛ `NULL`=نامحدود، `0`=بدون منفی، `>0`=کف `−limit`.
3. بانک ارزی: non-goal این موج.
4. تنخواه: سقف `float_ceiling_rial` + همان transfer/expense؛ بدون imprest `sourceType` جدید.
5. جزئیات: `docs/architecture/TREASURY-BANK-FUND-ADR-001.md`

---

## ۱۰) فهرست مسیرهای کلیدی

| حوزه | مسیر |
|------|------|
| Schema | `server/db.js`, `lib/update11-schema.js`, `lib/gap-accounting-schema.js` |
| API | `routes/{banks,cash-boxes,transfers,bank-reconciliation,check-categories}.js` |
| JE | `lib/{payment-bank-fee,bank-recon,invoice-payments,amend-cash-ops,cheque-lifecycle,pos}.js` |
| گزارش | `lib/{cash-flow,treasury-dashboard}.js` |
| Sync | `sync/{tables,capture}.js` |
| UI nav | `public/acc-nav.js` |

---

**Invariantهای redesign که نباید شکسته شوند**

1. مانده ابزار = جمع JE روی `coa_code` (با heal legacy).
2. کارمزد بانک فقط روی مسیر بانکی؛ دفتر طرف فقط اصل.
3. تطبیق: اقلام زمان‌بندی بدون JE؛ unclassified مانع بستن.
4. POS: swipe→۱۱۱۸؛ settle→بانک+۶۱۱۴.
5. ابطال = reverse در تراکنش (حذف فیزیکی سند پولی ممنوع).
6. جداول sync فقط append.
