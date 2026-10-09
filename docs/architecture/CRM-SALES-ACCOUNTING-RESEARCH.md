# تحقیق CRM / فروش — تنظیمات حرفه‌ای + ثبت‌های دقیق حسابداری

**وضعیت:** Research قفل‌شده → ADR-004 Accepted + P0 در SW v337  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**منبع:** skill-top **full** + tap-erp-architecture + ECC + متخصصان موازی  
[Map invoice AR posting gaps](5b8038fb-1dad-400f-aa3c-12d6b96850ac) · [Map dashboard module accounting](8dc4fa7a-7168-43b4-a8a7-2adc51c28dba)  
**Slack:** در workspace متصل پیامی دربارهٔ داشبورد/فروش/تهاتر یافت نشد — منبع حقیقت کد + `ADR-ACC-CRM-UNIFY` + CHANGE-LOG است.  
**مرجع بیرونی:** ERPNext Sales Invoice (proforma vs submit) + Delivery Note/COGS؛ ترنم = `proforma` بدون پست / `normal|final` پست اتمیک JE+موجودی.

## هدف محصول

هر آیتم **منوی اصلی CRM** (داشبورد و وابسته‌های مالی فروش) و هر مسیری که به مطالبات/درآمد/موجودی فروش پست می‌زند باید:

1. طبق قوانین نوع سند و نقش خودش روی GL، `customer_ledger` و موجودی اثر بگذارد — دوطرفه، اتمیک، قابل ابطال R13.
2. تنظیمات حرفه‌ای **per-entity / per-channel** داشته باشد (نه فقط LEGACY سراسری بدون whitelist/UI).
3. کارت‌های KPI داشبورد با همان قوانین firm-sale و fold تهاتر خوانده شوند — بدون «اعداد جادویی» موازی.

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** اطلاعات پایه | مشتری، کالا، انبار فروش | قوی؛ `customers.coa_code`، opening |
| **B** عملیات | فاکتور / تسویه / برگشت / امانی / پورتال→convert | JE برای firm؛ proforma صفر |
| **C** گزارشات / داشبورد | KPI، مطالبات، CRM analytics | خواندنی؛ چند تعریف مانده |
| **D** تنظیمات حرفه‌ای فروش | کلیدهای COA فروش کامل، کانال، برگشت/امانی | **PARTIAL** — whitelist کوتاه؛ پنل فروش MISSING |

## ثابت‌های قفل‌شده (تغییر فقط با ADR جدید)

| ثابت | منبع | معنا |
|------|------|------|
| انواع سند | ADR-ACC-CRM-UNIFY | `proforma` بدون JE/موجودی؛ `normal`/`final` فروش قطعی |
| KPI فروش | UNIFY §12 | فقط `firmSaleTypeSql` = `type IN ('normal','final')` |
| موجودی فروش | UNIFY + WH ADR-003 | perpetual از `postInventoryMovement`؛ COA موجودی typed per-WH |
| خزانه دریافت | Treasury ADR-001 | چک inbound → ۱۱۰۹؛ overdraft/float روی بانک/صندوق |
| پول | ADR-001 | DB ریال؛ `postToLedger` مرز تومان مگر `*_rial` |
| ابطال | R13 | reverse همهٔ اثرات create؛ حذف فیزیکی ممنوع |
| تهاتر داشبورد | این تحقیق | fold خانواده‌های signed — **نه** سند تهاتر بین مشتریان |
| اشخاص | PERSONS research | موازی؛ dual-role در ADR جدا |

**وابستگی‌های عمداً خارج از بازنویسی:** خزانه v335، انبار typed COA v335، تولید ADR-003 v336 — فقط لینک.

---

## ۱) منوی CRM ↔ نقش حسابداری

منبع ناوبری: `NAV_ADMIN` / `NAV_SALES` در `server/public/app.js`؛ پوستهٔ حسابداری جدا (`acc-nav.js`).

| Nav | نقش | JE امروز | باید JE؟ |
|-----|-----|----------|----------|
| داشبورد | KPI / اقدامات | خیر | خیر (خواندنی) |
| مشتریان | master + opening AR | جزئی (`opening_ledger`) | opening بله؛ فروش از فاکتور |
| پیگیری‌ها | CRM | خیر | خیر |
| داشبورد CRM | analytics | خیر | خیر (firm-only metrics) |
| فاکتور | فروش | بله firm | بله |
| کالاها | catalog (+ opening روی create) | جزئی | opening بله؛ PATCH stock نباید بدون GL بماند |
| یادآورها | CRM | خیر | خیر |
| گزارشات | sales reports | خیر | خیر (firm-only) |
| دستیار هوشمند | insights | خیر | خیر |
| سفارشات پورتال | B2B → proforma | خیر تا convert | پس از convert بله |
| حسابداری | دروازهٔ shell | بله (ماژول‌ها) | بله |
| پیام‌ها | messaging | خیر | خیر |
| تنظیمات | flags / COA subset | غیرمستقیم | کلیدهای فروش باید writable شوند |
| راهنما | docs | خیر | خیر |

---

## ۲) گراف وابستگی فروش

```
Portal B2B order ──► proforma invoice (no JE)
                         │ convert
                         ▼
Firm invoice (normal|final)
   ├─► customer_ledger Dr final
   ├─► JE ref_type=invoice (AR / sales / disc / VAT / freight / optional cash)
   ├─► postSaleStockMovements → inventory_ledger + WH stock
   ├─► invoice_cogs (perpetual) یا feature_cogs_voucher
   └─► pay splits ──► settlements → JE + books Cr
                              └─► cheque_records (1109→1116→bank) [Treasury ADR]

Sales return ──► JE sales_return + stock in + books Cr
Consignment ──► ship/sale/purchase/shortage JE (+ synthetic normal invoice on sale)
Customer opening ──► opening_ledger JE + books
Product opening ──► Inv + JE (opening-post)
PATCH /products/:id/stock ──► qty reconcile؛ اغلب بدون GL  ← GAP
```

**Resolverهای کلیدی**

| تابع | فایل |
|------|------|
| `isFirmSale` / `firmSaleTypeSql` / `postCogsFromMovements` | `lib/sales-document.js` |
| `salesJournalLines` / `canonicalCustomerFold` / `foldSignedRows` | `lib/customer-books.js` |
| `settlementAssetAccount` / pay splits | `lib/invoice-payments.js` |
| `voidInvoiceFully` | `lib/void-invoice.js` |
| `inventoryAccountForWarehouse` | `lib/inventory/ledger.js` |
| `acct()` / LEGACY | `lib/coa-map.js` |

---

## ۳) قالب‌های JE (قفل برای ADR)

مبالغ اقتصادی ریال؛ موتور خطوط تومان می‌نویسد مگر مسیر `*_rial`.

| رویداد | `ref_type` | بدهکار | بستانکار | زیردفتر |
|--------|------------|--------|----------|---------|
| Proforma create | — | — | — | — |
| Firm credit sale | `invoice` | AR (customer `coa_code` یا `coa_receivable`)؛ +disc→4103 | فروش 4101؛ VAT→2103؛ other income؛ freight… | `customer_ledger` Dr |
| Firm + immediate cash | همان JE | + نقد/بانک Dr مبلغ | AR Cr مبلغ | + `invoice_payment` Cr |
| Firm + splits | invoice سپس `settlement`×N | دارایی / AR | | settlements |
| COGS perpetual | `invoice_cogs` | 5101 | WH typed / 1104 | — |
| COGS legacy voucher | `invoice_cogs` | 5101 | product `coa_code` | اگر `feature_cogs_voucher=1` |
| Settlement | `settlement` | cash/bank/1109/1118… | AR | books Cr |
| Cheque lifecycle | `cheque_*` | طبق Treasury ADR-001 | | party books |
| Sales return | `sales_return` | 4102 (+؟ VAT) | AR؛ + Inv/COGS reverse | books Cr |
| Consignment ship | `consignment_ship` | 1114 | WH inv | — |
| Consignment sale | invoice + `consignment_cogs` | مسیر فروش عادی | | books |
| Customer opening | `opening_ledger` | AR یا Cr حسب علامت | 3102/طرف | books |
| Product opening | opening post | Inv | طرف افتتاحیه | — |

---

## ۴) تهاتر و کارت‌های داشبورد

### ۴.۱ قانون تهاتر (دو لایه)

1. **per customer:** یک مانده signed = Σdebit − Σcredit روی `customer_ledger` (+ firm invoices بدون ردیف ledger). مثبت = بدهکار.
2. **portfolio fold** (`foldSignedRows` / UI `balTotals`):
   - جمع بدهکاران (قبل از تهاتر) = Σ max(signed, 0) → فیلد `display`
   - جمع بستانکاران (قبل از تهاتر) = Σ max(−signed, 0) → فیلد `creditor`
   - مانده خالص = `debit − credit` خانواده‌ها = `signed` (ماهیت = سمت بزرگ‌تر)

**تهاتر بین دو مشتری جداگانه با JE انجام نمی‌شود.**

### ۴.۲ منبع KPI (بازه جلالی از/تا روی UI)

| کارت UI | منبع تقریبی | قانون |
|---------|-------------|--------|
| فروش کل — بازه | SUM `invoices.final` firm در بازه | firm-only؛ برچسب «بازه» |
| فاکتور قطعی / پیش‌فاکتور — بازه | COUNT type | قطعی = firm؛ پیش = proforma |
| مانده خالص مشتریان | `balTotals` / fold `display` vs signed | UI کارت‌ها gross+net؛ `/api/dashboard/summary.net_receivables` = **signed** |
| جمع بدهکاران / بستانکاران قبل از تهاتر | `balT.debit` / `balT.credit` از signed rows | نه خام Σdebit ledger سراسری |
| موجودی کم | products با stock ≤ alert | `COALESCE(stock_alert,5)` |
| پیگیری باز | followups open | CRM |
| عملکرد کارشناسان | فروش firm در بازه + مالکیت | OR user_id/assigned |

**GAP KPI:** `GET /api/dashboard/summary` فیلد `net_receivables_toman` از `.signed` است؛ overview حسابداری `display` (جمع بدهکاران) را نشان می‌دهد — باید در ADR هم‌ترازی یا برچسب صریح شود.

### ۴.۳ books ↔ GL

- SoT کارت‌ها و صورت‌حساب مشتری: **`customer_ledger`**.
- `books_mismatch` وقتی `|gl_closing_rial − ledger_closing| > 1` برای تفصیلی `customers.coa_code`.
- علت رایج: تاریخچهٔ قبل از تخصیص `coa_code` روی کنترل ۱۱۰۳ مانده؛ تفصیلی فقط گردش بعد از تخصیص را دارد.
- repair موجود: `ensureCustomerBooksRepaired` / opening JE — کامل برای همهٔ drift تاریخی نیست.

---

## ۵) تنظیمات حرفه‌ای — ماتریس

### ۵.۱ سطح شرکت (settings + `coa-map`)

| کلید LEGACY | کد پیش‌فرض | در `ALLOWED_KEYS`؟ | در UI `coaKeys`؟ |
|-------------|------------|-------------------|------------------|
| `coa_receivable` | 1103 | ✅ | ✅ |
| `coa_sales` | 4101 | ✅ | ✅ |
| `coa_sales_discount` | 4103 | ✅ | ✅ |
| `coa_cogs` | 5101 | ✅ | ✅ |
| `coa_inventory` | 1104 | ✅ | ✅ |
| `coa_vat_payable` | 2103 | ✅ | ✅ |
| `coa_sales_return` | 4102 | ❌ | ❌ |
| `coa_sales_expense` | 6103 | ❌ | ❌ |
| `coa_other_income` | 4201 | ❌ | ❌ |
| `coa_cheques_receivable` | 1109 | ❌ | ❌ |
| `coa_cheques_in_collection` | 1116 | ❌ | ❌ |
| `coa_card_in_transit` | 1118 | ❌ | ❌ |
| `coa_card_fee` | 6114 | ❌ | ❌ |
| `feature_cogs_voucher` | flag | ✅ | toggle جدا |
| `feature_perpetual_docs` | flag | خارج whitelist معمول UI | رفتاری |

### ۵.۲ per-entity

| Entity | فیلد | نقش | شکاف |
|--------|------|-----|------|
| Customer | `coa_code` | AR tafsili | بدون sales/disc/return جدا؛ credit_limit تزئینی (PERSONS research) |
| Invoice | `cost_center_id`, `warehouse_id` | بعد تحلیلی / WH | بدون revenue COA per channel |
| Product / line | `income_coa` | درآمد خط | اختیاری |
| Warehouse | `inventory_coa_code` | COGS/Inv typed | ✅ WH ADR-003 |
| Bank / Cash | `coa_code`, overdraft/float | دریافت | ✅ Treasury ADR-001 |
| Consignor | — | payable/loss | fallback misc/cogs |

### ۵.۳ پنل «تنظیمات حرفه‌ای فروش» (پیشنهاد لایه D)

مشابه Production Settings / سقف بانک:

- نگاشت COA فروش کامل (جدول ۵.۱)
- پیش‌فرض نوع تبدیل پورتال (`normal` vs `final`)
- گیت JE: perpetual on/off (موجود)، cogs voucher
- سیاست برگشت: reverse VAT بله/خیر (پیش‌فرض بله در ADR)
- پیش‌فرض انبار فروش / مرکز هزینه

---

## ۶) شکاف‌های قفل‌شده

| ID | برچسب | شرح |
|----|--------|-----|
| S01 | FIXED | `proforma` بدون JE/موجودی؛ firm از create/convert پست می‌کند |
| S02 | FIXED | KPI فروش/داشبورد از `firmSaleTypeSql` |
| S03 | FIXED | چک settlement → 1109 (Treasury ADR-001) |
| S04 | FIXED | WH typed COA روی مسیرهای فروش/COGS (v335) |
| S05 | GAP | `ALLOWED_KEYS`/UI بدون کلیدهای برگشت/چک/کارت/سایر درآمد |
| S06 | GAP | `books_mismatch` تاریخی بدون migration کامل |
| S07 | GAP | `/summary.net_receivables` = signed؛ کارت‌های UI = gross+net — برچسب/فیلد ناهم‌تراز |
| S08 | GAP | برگشت فروش: مبلغ خالص به 4102؛ VAT/discount ساختار فاکتور مبنا reverse کامل نیست |
| S09 | GAP | برگشت Inv از `coa_inventory` سراسری نه typed WH (باقی‌مانده نسبت به sale path) |
| S10 | GAP | `PATCH /products/:id/stock` بدون JE |
| S11 | GAP | ویرایش opening مشتری: soft-delete JE به‌جای reverse کلاسیک R13 |
| S12 | GAP | UI پورتال «تبدیل به final»؛ ADR اجازهٔ `normal|final` |
| S13 | GAP | امانی: حساب payable/loss قابل‌پیکربندی per-consignor نیست |
| S14 | GAP | freight seller → `coa_payable` عمومی بدون تفصیلی حامل |
| S15 | DEFER | مودیان واقعی / اظهارنامه VAT / ماده ۱۶۹ (`ACCOUNTING-GAP-ANALYSIS`) |
| S16 | DEFER | درآمد پس از approve برای `final` (خلاف UNIFY فعلی) |
| S17 | DEFER | سود اقساط تحقق‌نیافته؛ ذخیره م.م |
| S18 | PARTIAL | دو شکل COGS (movement vs `feature_cogs_voucher`) |

**Verify spot (کد):**

- `foldSignedRows` → `display`/`creditor`/`signed` در `customer-books.js`
- `dashboard.js` summary → `.signed`
- `settings.js` ALLOWED_KEYS خط ۱۶ بدون `coa_sales_return`
- `app.js` `coaKeys` ~25217 کوتاه

---

## ۷) موج‌های پیشنهادی P0–P3

### P0 — صحت و یکپارچگی (بدون schema بزرگ)

1. گسترش `ALLOWED_KEYS` + UI `coaKeys` برای کلیدهای S05.
2. هم‌ترازی API/UI مانده: فیلدهای صریح `receivables_gross_debit` / `receivables_gross_credit` / `receivables_net_signed` روی summary یا برچسب Help؛ dashboard cards بدون تغییر معنا.
3. ابزار/مسیر repair `books_mismatch` (reclass کنترل→تفصیلی یا گزارش admin) — حداقل: endpoint تشخیص + repair opening/control drift مستند.
4. متن پورتال convert → «فروش قطعی (عادی/رسمی)» (S12).
5. تست رگرسیون: firm/proforma، fold تهاتر، کلیدهای settings writable، void R13 smoke.

### P1 — تنظیمات حرفه‌ای + قالب‌های ناقص

1. پنل تنظیمات فروش (لایه D) در تنظیمات یا زیرمنوی فروش.
2. برگشت: reverse VAT/discount + typed WH COA (S08/S09).
3. امانی configurable (S13)؛ freight حامل (S14).
4. opening مشتری: reverse کلاسیک به‌جای soft-delete خام (S11).

### P2 — انطباق (موج جدا)

- مودیان / VAT فصلی / §169 (S15)
- سیاست اختیاری approve-before-revenue فقط با ADR جدید (S16)

### P3 — پولیش

- یکسان‌سازی مسیر COGS (S18)
- Help داشبورد: تهاتر خانواده‌ها، firm-only، mismatch
- SW + CHANGE-LOG + deploy

---

## ۸) فایل‌های کلیدی

| نقش | مسیر |
|-----|------|
| Invoice create/convert/void | `server/routes/invoices.js`, `lib/void-invoice.js` |
| Firm/proforma + COGS | `server/lib/sales-document.js` |
| JE فروش + books + fold | `server/lib/customer-books.js` |
| Settlements | `server/routes/accounting.js`, `lib/invoice-payments.js` |
| Returns | `accounting.js` `/sales-returns` |
| Consignments | `server/lib/consignments.js` |
| Dashboard | `server/routes/dashboard.js`, `admin.js` stats |
| Settings | `server/routes/settings.js`, `public/app.js` coaKeys |
| COA | `server/lib/coa-map.js` |
| UNIFY | `docs/architecture/ADR-ACC-CRM-UNIFY.md` |
| Gap قانونی | `docs/ACCOUNTING-GAP-ANALYSIS.md` |

---

## ۹) تصمیم‌های باز → ADR-004

پیشنهاد قفل (Minimal / Option 1 — صحت + whitelist + هم‌ترازی KPI؛ بدون موتور مودیان):

1. شناسایی درآمد: `normal` و `final` در create/convert (حفظ UNIFY).
2. تهاتر: بدون JE بین‌مشتری؛ کارت‌ها از fold؛ API سه فیلد صریح.
3. Settings: گسترش ALLOWED_KEYS/UI طبق ۵.۱.
4. P0 repair mismatch: ابزار تشخیص + repair کنترل‌شده؛ migration اجباری همهٔ تاریخچه در P0 اختیاری/staged.
5. برگشت VAT+typed WH و پنل فروش → P1.
6. مودیان → DEFER.

جزئیات قفل: `CRM-SALES-ACC-ADR-004.md`.
