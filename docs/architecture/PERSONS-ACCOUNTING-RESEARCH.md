# تحقیق اشخاص — تنظیمات حرفه‌ای + ثبت‌های دقیق حسابداری

**وضعیت:** Research ✅ → ADR-PARTY-001 Accepted + P0 shipped (SW v337)  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**ADR:** `PARTY-ACC-ADR-001.md` 
**منبع:** skill-top **full** + tap-erp-architecture + ECC (architect/planner) + متخصصان موازی  
[Map persons ops to JE](f18ca5ed-fc63-4e73-9c83-da779b59eb0c) · [Persons pro settings matrix](3ff84cd6-784a-4e0c-a270-34fecd9a6198) · [Cross-deps parties payroll cheque](0e1366a9-9c5e-4cc9-b758-6dfb36b3f731) · Verify [spot-check](24961361-5079-4336-8071-d2c1e4849943)  
**Slack:** در workspace متصل هیچ پیام/کانالی برای «اشخاص / طرف‌حساب / ترنم» یافت نشد — منبع حقیقت کد + `ACC-CRM-UNIFY-AUDIT` + CHANGE-LOG است.  
**مرجع بیرونی:** ERPNext Party/Customer/Supplier (کنترل مشترک AR/AP + override انتخابی؛ Common Party Accounting فقط با سیاست صریح offset) — در ترنم مدل فعلی = **برگ تفصیلی per-party زیر کنترل ۱۱۰۳/۲۱۰۱/۱۱۰۶** (نزدیک‌تر به «حساب اختصاصی» ERPNext، نه کنترل مشترک خالص).

## هدف محصول

هر آیتم منوی **حسابداری → اشخاص** (و هر مسیری که به طرف‌حساب پست می‌زند) باید:

1. طبق **قوانین نقش خودش** (مشتری / تأمین‌کننده / پرسنل / متفرقه) روی زیردفتر و دفتر کل اثر بگذارد — دوطرفه، اتمیک، قابل ابطال R13.
2. تنظیمات حرفه‌ای **per-entity** داشته باشد (سقف اعتبار واقعی، ماهیت، پیش‌فرض تسویه/هزینه، سیاست کنترل) — نه فقط فیلدهای تزئینی یا COA سراسری.
3. وابستگی تک‌به‌تک با فروش، خرید، حقوق، چک، سند دستی، پورتال و افتتاحیه شفاف و قابل تطبیق باشد.

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** اطلاعات پایه | اطلاعات اشخاص، گروه‌ها، سمت، گروه‌های مشتری | UI قوی روی `parties`؛ `persons` legacy موازی |
| **B** عملیات مالی | خارج از منوی اشخاص (فروش/خرید/حقوق/خزانه/سند) | JE + زیردفتر caller-paired |
| **C** گزارشات | مطالبات / صورت‌حساب | canonical = `customer_ledger` |
| **D** تنظیمات حرفه‌ای per-entity | سقف enforceable، default bank/expense، withholding، terms | عمدتاً **MISSING** یا بدون پستینگ |

## ثابت‌های قفل‌شده (تغییر فقط با ADR جدید)

| ثابت | منبع | معنا |
|------|------|------|
| پول | ADR-001 | DB = ریال صحیح؛ `postToLedger` مرز تومان مگر مسیر `*_rial` |
| کنترل‌ها | `coa-map.js` | ۱۱۰۳ AR · ۲۱۰۱ AP · ۱۱۰۶ متفرقه · ۲۱۰۴ حقوق · ۲۱۰۵/۲۱۰۶ بیمه/مالیات · ۱۱۰۹/۲۱۰۹ چک · ۳۱۰۲ افتتاحیه |
| هویت UI | ACC-CRM-UNIFY | `parties` canonical؛ `acc-persons`/`acc-suppliers` → redirect |
| تخصیص برگ | `coaKindForRoles` | customer ≻ supplier ≻ person |
| مانده لیست اشخاص | `party-books.js` | زیردفتر اول؛ GL فقط اگر نبود زیردفتر یا `|Δ|≤1` |
| ابطال | R13 | soft-void JE + reverse/soft-delete زیردفتر؛ حذف فیزیکی ممنوع برای ردیف مالی زنده |
| آفلاین | sync | جداول party/ledger در `SYNCABLE_TABLES`؛ side-effect ledger معمولاً از بازپخش route والد |

---

## ۱) منو ↔ نقش حسابداری

منبع: `server/public/acc-nav.js:138–148` (بخش «اشخاص» — فقط پایه + گزارش؛ بدون زیرگروه عملیات).

| Nav id | برچسب | نقش | اثر JE/زیردفتر؟ |
|--------|--------|-----|-----------------|
| `acc-parties` | اطلاعات اشخاص | Master یکپارچه + تخصیص تفصیلی + مانده زنده | بله روی opening / deactivate |
| `acc-party-groups` | گروه‌های اشخاص | طبقه‌بندی + marketer/پرسنل gate | خیر |
| `acc-person-positions` | سمت و جایگاه | برچسب گزارش (جدا از نقش حسابداری) | خیر |
| `acc-customer-groups` | گروه‌های مشتری | ماهیت نمایشی debit/credit | خیر (بدون پستینگ) |
| `acc-receivables` | مطالبات مشتریان | گزارش AR | خواندنی (`customer_ledger`) |
| `acc-statement` | صورت‌حساب مشتری | گردش مشتری | خواندنی |

**عملیات مالی متقاطع (خارج منو):** فاکتور/تسویه، خرید/پرداخت تأمین، حقوق، چک، سند دستی/`account-*`، افتتاحیه party، پورتال پرداخت، امانی (مسیر person payable).

---

## ۲) ماتریس موجودیت‌ها

| موجودیت | جدول | کنترل/برگ | زیردفتر | لینک |
|---------|------|-----------|---------|------|
| Party | `parties` | `coa_code` از `allocTafsili(kind)` | غیرمستقیم | — |
| Customer | `customers` | زیر ۱۱۰۳ | `customer_ledger` | `party_id` dual-write |
| Supplier | `suppliers` | زیر ۲۱۰۱ | `supplier_ledger` (+ فرمول PO در party-books) | `party_id` |
| Person | `persons` | زیر ۱۱۰۶ (یا ۲۱۰۴ پرسنل) | `person_ledger` | `party_id` UNIQUE partial |
| Detail (موازی) | `detail_accounts` | اختیاری | — | `parties.detail_account_id` |

### قانون مانده لیست (`partySignedBalanceMap`)

1. seed `opening_balance`  
2. person_ledger (اگر لینک)  
3. customer_ledger **overwrite**  
4. supplier → `−payable` از فرمول خرید/پرداخت/برگشت (نه لزوماً `supplier_ledger`)  
5. GL روی `coa_code` فقط اگر بدون زیردفتر یا هم‌ترازی ≤۱ ریال  

**Verify:** PASS — `party-books.js:113–132`.

### تنش ثبت‌شده (Verify)

چک می‌تواند **هم** `customer_ledger` و **هم** `person_ledger` را برای یک party بنویسد، اما مانده لیست فقط یکی را نگه می‌دارد (customer overwrite) — دو زیردفتر ≠ دو سهم در مانده UI.

---

## ۳) کاتالوگ عملیات → زیردفتر → JE → R13

| عملیات | زیردفتر | JE | R13 | شکاف |
|--------|---------|-----|-----|------|
| ایجاد party + مانده | customer/person opening | تفصیلی\|کنترل ↔ ۳۱۰۲ | reverse روی ویرایش/deactivate | — |
| ایجاد person + opening | فقط `person_ledger` | **هیچ** | hard DELETE اگر ledger خالی | **MISSING JE** |
| فاکتور فروش | `customer_ledger` | Dr AR leaf\|۱۱۰۳ | voidInvoiceFully | سقف اعتبار enforce نیست |
| تسویه مشتری | settlement | Dr نقد/بانک/چک / Cr AR | reverseSettlement | — |
| خرید نسیه | `supplier_ledger` | Cr AP leaf\|۲۱۰۱ | reverse purchase | لیست vs گردش ممکن است اختلاف |
| سند دستی + شخص | `person_ledger` | leaf\|۱۱۰۶ | void vouchers (manual/account_*) | opening voucher ممکن است voidable نباشد |
| حقوق accrual/pay | `person_ledger` | leaf\|۲۱۰۴ ± ۲۱۰۵/۲۱۰۶ | void-accrual soft | واحد toman/rial نرمال‌سازی runtime |
| چک دریافتنی | customer و/یا person | Dr ۱۱۰۹ / Cr leaf | reverse cheque | dual-book ریسک |
| پورتال پرداخت | **هیچ** | کنترل ۱۱۰۶ + detail | ؟ | **بدون person_ledger** |
| هزینه/انتقال | — | COA مسیر | reverse | بدون `party_id` |
| trust-checks | — | **عمداً بدون JE** | — | custody |

`postToLedger` **هرگز** خودش زیردفتر نمی‌نویسد — pairing بر عهدهٔ caller است؛ idempotency ناهمگون (invoice/purchase اغلب `assertJournalIdempotent`؛ person_ledger همیشه INSERT).

---

## ۴) ماتریس تنظیمات حرفه‌ای

| Setting | Scope | Exists? | Used in posting? | Gap |
|---------|--------|---------|------------------|-----|
| `coa_code` تفصیلی | party (+ mirror) | EXISTS | YES | persons POST بدون alloc مستقیم |
| Parent kind ۱۱۰۳/۲۱۰۱/۱۱۰۶ | role-derived | EXISTS | YES | override per-party MISSING |
| `detail_account_id` | party | PARTIAL | PARTIAL | موازی با `coa_code` |
| `account_nature` | party | EXISTS | PARTIAL (فقط opening) | فاکتور/تسویه روزمره نه |
| `customer_groups.nature` / `person_categories.nature` | category | EXISTS | NO | فقط UX/metadata |
| `party_groups` | category | EXISTS | PARTIAL (marketer/پرسنل) | بدون nature/default COA/سقف |
| `person_positions` | tag | EXISTS | NO | درست برای گزارش |
| `credit_limit` | party | EXISTS UI | **NO** روی invoice | B2B جدا enforce دارد |
| `debit_limit` | persons only | EXISTS | NO | روی parties نیست |
| Default bank/cash تسویه | person | **MISSING** | — | |
| Default expense COA | person | **MISSING** | — | |
| Withholding % | person | **MISSING** | — | |
| Payment terms / price list / VAT default | person | **MISSING** | — | |
| Commission | users/reps | EXISTS روی user | — | روی party نیست |
| Module flag اشخاص | global | MISSING | — | همیشه در ناو |

---

## ۵) ریسک‌های تراز (رتبه‌بندی)

| Rank | ریسک | اثر BS |
|------|------|--------|
| R1 | Dual-role یک برگ (cust+supp) — AR/AP روی یک leaf | High |
| R2 | پست تاریخی روی کنترل برهنه ۱۱۰۳/۲۱۰۱/۱۱۰۶/۲۱۰۴ | High تا reclass |
| R3 | چک dual customer+person ledger | High برای books/UI |
| R4 | پورتال پرداخت بدون person_ledger | Medium–High |
| R5 | Turnover مشتری short-circuit → AP/پرسنل پنهان | Medium |
| R6 | امانی payable از مسیر person ≠ supplier AP | Medium |
| R7 | JE بدون زیردفتر / زیردفتر بدون idempotency | Medium |
| R8 | Opening persons بدون JE | Medium |
| R9 | trust-checks خارج دفتر (عمدی) | Low BS |
| R10 | سقف اعتبار تزئینی | عملیاتی / ریسک اعتباری |

---

## ۶) مرجع بیرونی (≤۳)

| مرجع | چرا |
|------|-----|
| [ERPNext Default Receivable/Payable](https://docs.frappe.io/erpnext/default-receivable-payable-account) | کنترل مشترک + override انتخابی؛ هشدار علیه برگ per-party بی‌دلیل |
| [ERPNext Common Party Accounting](https://docs.frappe.io/erpnext/common-party-accounting) | مشتری+تأمین‌کننده = offset صریح با Party Link، نه برگ واحد خاموش |
| الگوی داخلی Treasury/Production RESEARCH | قالب Wave 0 → ADR → P0–P3 در همین ریپو |

**تصمیم معماری باز نسبت به ERPNext:** ترنم امروز برگ تفصیلی per-party دارد (الزام گزارش مودیان/محک). ADR باید بگوید: حفظ برگ‌ها + سیاست dual-role جداگانه، یا حرکت به‌سمت کنترل مشترک + dimension (خارج از محدودهٔ کوتاه‌مدت مگر ADR صریح).

---

## ۷) تصمیم‌های باز برای ADR-PARTY-001

1. منبع حقیقت مانده party: همیشه GL برگ؟ همیشه زیردفتر نقش؟ یا قانون فعلی «GL فقط اگر موافق»؟  
2. Sunset `/api/persons` برای ACC: opening بدون JE ممنوع؛ فقط `/parties` + projection پرسنل؟  
3. Supplier balance: یکی کردن `supplier_ledger` با فرمول PO در `party-books`.  
4. `coa_code` vs `detail_accounts` — کدام canonical؟  
5. آیا `customer_groups.nature` کنترل حساب را عوض کند یا فقط UX؟  
6. Deactivate cascade: hard DELETE CRM vs pure soft برای تاریخچه مالی.  
7. پرسنل بدون برگ: ۲۱۰۴ vs ۱۱۰۶؛ آیا `employee` باید زیر ۲۱۰۴ alloc شود؟  
8. پنل «تنظیمات حرفه‌ای اشخاص» (مثل Production Settings) — Minimal vs Full.  
9. VOIDABLE برای opening vouchers دستی با person.  
10. سیاست dual-role: برگ‌های جدا AR/AP، یا forbid تک‌برگ، یا Common Party offset (ERPNext-style).  
11. Enforce `credit_limit` روی فاکتور: hard block vs soft warn.  
12. UNIQUE `users.party_id` (gap قدیمی unify audit).

---

## ۸) موج‌های پیشنهادی (فقط تحقیق — بدون پیاده‌سازی این نوبت)

| موج | هدف | محتوا |
|-----|------|--------|
| **0** | Freeze | همین سند |
| **P0** | جلوگیری از دروغ تراز | (1) چک: customer XOR person زیردفتر (2) گارد dual-role / برگ جدا (3) assert جفت JE+زیردفتر برای پول‌اسناد کلیدی |
| **P1** | Unify پرسنل/پورتال | portal → `resolvePersonPayableAccount` + `person_ledger`؛ persons opening با JE یا ممنوع؛ void یکدست soft |
| **P2** | تنظیمات Minimal | enforce `credit_limit`؛ defaults روی `party_groups`؛ یک فرم Party حرفه‌ای؛ تصمیم detail_accounts |
| **P3** | Books UX + Full knobs | turnover چندنقشی؛ امانی→supplier AP وقتی لینک؛ terms/withholding/default bank در صورت نیاز کسب‌وکار؛ تست‌ها + Help |

### تست‌های موجود (نمونه)

`test-payroll-person-tafsili-v300.js` · `test-payroll-void-r13-v301.js` · `test-account-voucher-books-v296.js` · `test-party-turnover-books-v295.js` · `test-acc-crm-party.js` · `test-ar-control-reclass-v243.js` · `test-bom-person-party-balance-v206.js`

**پوشش نازک:** dual customer+supplier همان party؛ portal↔person books؛ expense/transfer با party.

---

## ۹) ADR-PARTY-001 — Accepted (Option 1 Minimal)

قفل در `PARTY-ACC-ADR-001.md`. P0 پیاده شد:

- Enforce `credit_limit` روی فاکتور رسمی / تبدیل پیش‌فاکتور (`E_CREDIT_LIMIT`)
- چک دریافتنی: customer XOR person زیردفتر
- Dual-role: برگ AR ≠ AP (`ensureDualRoleSeparateLeaves`)
- تست: `server/scripts/test-party-acc-adr001-v337.js`

موج‌های P1–P3 همچنان باز (پورتال، opening persons، defaults گروه، Full knobs).
