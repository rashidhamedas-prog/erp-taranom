# تحقیق دفتر چک — برگه وضعیت + تاریخچه + ثبت‌های دقیق

**وضعیت:** Research (pre-ADR) — Wave 0 freeze  
**تاریخ:** ۱۴۰۵/۰۷/۱۹  
**منبع:** skill-top **full** + tap-erp-architecture + ui-ux + ECC plan-first  
[Cheque API lifecycle](3b026a7e-ad0a-4e0a-8f92-c9d5e38fe92c) · [Cheque UI status button](a722b1f2-9f89-48f6-9894-a1cf48ddadea) · (ماتریس تنظیمات در حال تکمیل)  
**Slack:** در workspace متصل پیامی دربارهٔ چک/دفتر چک یافت نشد — منبع حقیقت کد + CHANGE-LOG + ADRهای مرتبط است.  
**وابسته به:** `ADR-ACC-CRM-UNIFY` §13 · `TREASURY-BANK-FUND-ADR-001` · `PARTY-ACC-ADR-001` (XOR زیردفتر چک) · `cheque-lifecycle.js` v303

## هدف محصول

با زدن دکمهٔ **وضعیت** در دفتر چک:

1. **برگهٔ چک** — تمام مشخصات در جایگاه‌های خوانا (شماره، مبلغ ریال، بانک، شعبه، صیاد، شبا، حساب، تاریخ‌ها، طرف‌حساب، شرح).
2. **وضعیت حال** — هم برچسب انسانی (`status`) و هم حالت ماشین (`lifecycle_status`) با badge شفاف.
3. **تاریخچهٔ زمانی** — از ثبت تا واگذاری/وصول/برگشت/خرج/پرداخت/ابطال با لینک JE و اثر زیردفتر.
4. **حسابداری** — هر گذار مالی فقط از endpointهای چرخه؛ دوطرفه، اتمیک، R13؛ تنظیمات حرفه‌ای per-transition/entity.

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** نمایش برگه | layout فیزیکی/ERP برگه چک | **MISSING** — فقط جدول تخت |
| **B** وضعیت + تاریخچه | مودال وضعیت / timeline | دکمه = دو `prompt` غیرمالی؛ timeline **MISSING** |
| **C** عملیات چرخه | واگذاری/وصول/برگشت/خرج/… | EXISTS روی دکمه‌های ردیف (جدا از «وضعیت») |
| **D** تنظیمات حرفه‌ای | COA، بانک وصول پیش‌فرض، هزینهٔ خرج | PARTIAL — کلیدهای ۱۱۰۹/۱۱۱۶ در settings؛ ۲۱۰۹/۶۱۰۲ خارج ALLOWED_KEYS |

---

## ثابت‌های قفل‌شده (تغییر فقط با ADR)

| ثابت | منبع | معنا |
|------|------|------|
| SoT چرخه | ADR-ACC-CRM-UNIFY §13 | `cheque_records` + JE روی گذار مجاز |
| ماشین حالت IN | `cheque-lifecycle.js` | `registered` → `in_collection` → `cleared`؛ شاخه `endorsed`؛ `bounced` ↔ resend |
| ماشین حالت OUT | همان | `registered` → `issued` \| `expensed` (\| endorse≈expense) |
| alias نزد صندوق | v303 | `''` / `in_hand` / `pending` = `registered` |
| COA | Treasury ADR-001 / coa-map | ۱۱۰۹ دریافتنی · ۱۱۱۶ در جریان · ۲۱۰۹ پرداختنی · بانک* وصول |
| پول | ADR-001 | DB ریال؛ خطوط JE تومان (÷۱۰) مگر مسیر `*_rial` |
| PATCH متن‌آزاد | `refuseFreeTextFinancial` | بدون اثر مالی؛ کلمات چرخه ممنوع |
| ابطال | R13 / `void-cheque.js` | soft reverse؛ حذف فیزیکی ممنوع |
| زیردفتر | PARTY-ADR-001 | XOR customer/person برای چک |
| آفلاین | sync | `cheque_records` در SYNCABLE؛ capture روی `/api/cheque-records` |

---

## ۱) رفتار فعلی دکمهٔ وضعیت (قفل UI)

منبع: `editChequeRegisterStatus` در `server/public/app.js`.

| گام | رفتار |
|-----|--------|
| کلیک | دو `window.prompt` (وضعیت نمایشی، شرح اختیاری) — **بدون** `openModal` |
| API | `PATCH /api/cheque-records/:id/status` → `{ status, status_note }` |
| اثر مالی | هیچ |
| رد سرور | متن مالی / lifecycle فعال → `E_CHEQUE_USE_LIFECYCLE` |

**دوگانگی منو:** «چک‌های دریافتی» (`acc-cheques-recv`) → تب legacy `settlements` + `PATCH /accounting/cheques/:id/status` (بدون JE). «دفتر چک» → lifecycle واقعی.

SW مرجع تحقیق: `erp-taranom-v337`.

---

## ۲) ماشین حالت و کاتالوگ API

Base: `/api/cheque-records` — `adminOrAccounting`. مبلغ زیردفتر = ریال؛ خطوط JE = تومان.

### ۲.۱ دریافتنی (`direction=in`)

```
registered → in_collection (واگذاری) → cleared (وصول)
          ↘ endorsed (خرج/ظهرنویسی)
in_collection | cleared → bounced → resend → prior
```

### ۲.۲ پرداختنی (`direction=out`)

```
registered → issued (pay) | expensed (expense) | endorsed≈expense
```

افتتاحیه (`مانده اول دوره`) از pay/expense OUT ممنوع.

### ۲.۳ جدول endpointها

| Method | Path | From → To | JE (Dr / Cr) | Side effects |
|--------|------|-----------|--------------|--------------|
| GET | `/` | لیست | — | فیلتر direction/status/opening؛ بدون reversed؛ LIMIT 1000 |
| POST | `/` | → registered | Opening: IN Dr1109/Cr3102؛ OUT Dr3102/Cr2109. Non-opening IN: `postChequeInReceipt` Dr1109/Cr AR\|person | `party_id` اجباری؛ audit |
| PATCH | `/:id/status` | متن آزاد | — | بدون sync settlement |
| DELETE / cancel / void | `/:id` | → reversed | R13 §۶ | `voidChequeRecord` |
| POST | `/:id/send-to-bank` | IN registered → in_collection | Dr1116 / Cr1109 | `collection_bank_id`+`collection_je_id`؛ sync settlement |
| POST | `/:id/clear` | in_collection → cleared | Dr Bank* / Cr1116 | `cleared_je_id`؛ settlement→received |
| POST | `/:id/bounce` | in_collection\|cleared → bounced | Dr party / Cr 1116 یا Bank* | `bounced_je_id`؛ زیردفتر؛ settlement→bounced |
| POST | `/:id/resend` | bounced → prior | reverse bounce JE | پاک `bounced_je_id`؛ reverse زیردفتر bounce |
| POST | `/:id/endorse` | IN registered → endorsed | Dr ذینفع / Cr1109 | supplier/customer ledger؛ JE در `collection_je_id` |
| POST | `/:id/pay` | OUT registered → issued | Dr2101\|key / Cr2109 | JE در `collection_je_id` |
| POST | `/:id/expense` | OUT registered → expensed | Dr هزینه / Cr2109 | cost_center؛ JE در `collection_je_id` |

**مسیرهای ایجاد موازی:**

| منبع | lifecycle اولیه | نکته |
|------|-----------------|------|
| تسویه فاکتور / `insertChequeRecordForSettlement` | registered «نزد صندوق» | JE روی settlement (Dr1109)؛ `postChequeInReceipt` skip |
| پرداخت خرید | **issued** «پرداخت‌شده» | JE روی `supplier_payment`؛ `/pay` دوباره مجاز نیست |
| Excel opening | registered + opening JE | — |

---

## ۳) فیلدهای برگه (schema ↔ UI)

Schema: `db.js` CREATE + ensureColumn (~2055–2097).

| فیلد | نقش برگه | در جدول دفتر امروز؟ |
|------|----------|---------------------|
| `cheque_number`, `sayadi`, `sheba`, `account_number` | هویت برگه | شماره+صیاد بله؛ شبا/حساب **خیر** |
| `bank_name`, `branch` | بانک/شعبه | بله |
| `amount` | مبلغ ریال | بله |
| `issue_date`, `receive_date`, `due_date` | تاریخ‌ها | فقط یک ستون سررسید (fallback) |
| `party_name` (+ ids) | طرف حساب | نام بله |
| `status` + `status_note` | برچسب انسانی | بله |
| `lifecycle_status` | حالت ماشین | **خیر** (فقط گیت دکمه) |
| `collection_bank_id`, `*_je_id` | وصول/سند | **خیر** |
| `invoice_id`, `settlement_id`, endorse_* | پیوندها | **خیر** |
| `note`, `created_by_name`, `created_at` | شرح/ثبت | note بله |

---

## ۴) تاریخچه — منابع موجود در برابر نیاز UI

| منبع | Exists? | برای timeline برگه؟ |
|------|---------|---------------------|
| `audit_log` (`audit` روی create/update/reverse + action codes) | بله | Partial — بدون JE id ساخت‌یافته |
| ستون‌های `journal_entry_id` / `collection_je_id` / `cleared_je_id` / `bounced_je_id` / `reversal_journal_id` | بله | قابل بازسازی با join به `journal_entries` |
| `journal_entries.ref_type` + `ref_id` | بله (`cheque_*`, `opening_cheque*`, settlement) | بهترین trail GL |
| زیردفتر customer/person/supplier | بله | صورت‌حساب؛ نه timeline برگه |
| `settlements.cheque_status` | mirror | فقط وضعیت؛ ممکن است از lifecycle منحرف شود |
| جدول `cheque_events` | **MISSING** | — |
| `GET /:id` و `GET /:id/history` | **MISSING** | UI فقط از ردیف لیست |

**دستور بازسازی امروز (بدون schema جدید):**  
union (1) audit `entity_type=cheque_record` (2) JE با `ref_id=chequeId` و `ref_type` شبیه `cheque_%`/`opening_cheque%` (3) JE تسویه اگر `settlement_id` (4) برچسب مرحله از `ref_type` — چون `collection_je_id` برای send-to-bank **و** pay/expense/endorse overload شده.

پس از resend، `bounced_je_id` null می‌شود؛ رویداد برگشت فقط در JE معکوس‌شده + audit می‌ماند.

---

## ۵) گراف وابستگی

```
فاکتور/تسویه ──► settlements (Dr 1109) + cheque_records (registered)
خرید پرداخت ───► supplier_payment (Cr 2109) + cheque_records (issued)
افتتاحیه ──────► opening_cheque JE + registered
        │
        ▼
send-to-bank ──► Dr 1116 / Cr 1109
clear ─────────► Dr Bank* / Cr 1116
bounce ────────► Dr party / Cr 1116|Bank* + زیردفتر
endorse IN ────► Dr ذینفع / Cr 1109 + ledger
pay/expense OUT ► Dr AP|هزینه / Cr 2109
        │
        ▼
voidChequeRecord (newest JE first) + syncSettlement + reverse زیردفتر
داشبورد سررسید ◄── lifecycle + syncSettlementChequeStatus (v326)
اشخاص/مانده   ◄── XOR party books (ADR-PARTY-001)
```

---

## ۶) ماتریس تنظیمات حرفه‌ای (پیش‌نویس — تکمیل با متخصص سوم)

| Setting | Scope | Exists? | در posting؟ | شکاف برای برگه/چرخه |
|---------|--------|---------|-------------|---------------------|
| `coa_cheques_receivable` (۱۱۰۹) | global | EXISTS + ALLOWED | YES | — |
| `coa_cheques_in_collection` (۱۱۱۶) | global | EXISTS + ALLOWED | YES | — |
| `coa_cheques_payable` (۲۱۰۹) | global | LEGACY | YES | **خارج ALLOWED_KEYS** UI |
| `coa_bank_default` / `banks.coa_code` | global / bank | EXISTS | YES clear | بانک وصول per-cheque فقط در واگذاری |
| `coa_payable` / `coa_receivable` | global | EXISTS | YES | — |
| `coa_opening_balance` (۳۱۰۲) | global | LEGACY | YES opening | خارج ALLOWED_KEYS |
| `coa_admin_expense` (۶۱۰۲) | global | LEGACY | YES expense default | خارج ALLOWED_KEYS |
| `check_categories` | دسته | EXISTS UI | leaf شمارش | بدون لینک اجباری به ردیف چک |
| Default collection bank per party | party | **MISSING** | — | |
| تاریخ/دلیل اجباری per-transition | transition | PARTIAL | واگذاری مودال؛ clear/bounce فقط confirm+امروز | |
| پیوست تصویر چک / رسید بانک | cheque | **MISSING** | — | |
| `module_trust_checks` | flag | EXISTS | trust بدون JE | جدا از دفتر |

---

## ۷) شکاف‌ها در برابر Brief محصول

| # | شکاف | شدت |
|---|------|-----|
| G1 | دکمه وضعیت ≠ برگه + تاریخچه (فقط prompt غیرمالی) | High UX |
| G2 | بدون GET `/:id` و `/:id/history` | High |
| G3 | بدون layout برگه (فیزیکی یا ERP) | High UX |
| G4 | `lifecycle_status` در جدول/مودال دیده نمی‌شود | Medium |
| G5 | `collection_je_id` overload — تاریخچه فقط با `ref_type` | Medium |
| G6 | دو UI: دفتر چک vs settlements cheques | High confusion |
| G7 | clear/bounce/resend/pay بدون مودال تنظیمات (تاریخ/بانک/دلیل) | Medium |
| G8 | OUT ثبت‌شده بدون JE تا pay/expense | Medium accounting |
| G9 | purchase `party_id` گاهی ≠ `parties.id` | Medium data |
| G10 | ۲۱۰۹/۳۱۰۲/۶۱۰۲ خارج ALLOWED_KEYS | Low–Medium settings |
| G11 | بدون reverse تک‌مرحله‌ای (جز bounce→resend)؛ فقط void کامل | by design / ADR |
| G12 | جدول `cheque_events` نیست | P1 optional |

---

## ۸) ریسک‌های تراز / عملیاتی

| Rank | ریسک | اثر |
|------|------|-----|
| R1 | کاربر «وضعیت» را با واگذاری اشتباه بگیرد | بدون JE؛ گزارش نادرست |
| R2 | desync `settlements.cheque_status` vs lifecycle (مسیر legacy) | هشدار سررسید / نقدینگی |
| R3 | dual books قبل از XOR (رفع‌شده در P0 اشخاص — verify ماند) | مانده party |
| R4 | void فاکتور vs `voidChequeRecord` مسیرهای ناهماهنگ تاریخی | R13 ناقص |
| R5 | overload `collection_je_id` در UI تاریخچه | برچسب غلط مرحله |

---

## ۹) مرجع بیرونی (≤۳)

| مرجع | چرا |
|------|-----|
| الگوی داخلی Treasury RESEARCH + ADR-001 | قالب JE ۱۱۰۹/۱۱۱۶/بانک و Wave 0→ADR |
| ERPNext Notes / Payment Entry (cheque) | lifecycle deposit/clear؛ نه کپی کور |
| 21st timeline components (metadata) | الگوی UX تاریخچه — پیاده در CSS/HTML پروژه نه React |

---

## ۱۰) تصمیم‌های باز برای ADR-CHEQUE-LEAF-001

1. **نقش مودال وضعیت:** فقط مشاهده (برگه+تاریخچه+لینک JE) یا هاب عملیات چرخه؟ *(منتظر کاربر)*  
2. **وفاداری بصری برگه:** facsimile چک بانکی ایران vs برگهٔ ERP خوانا با فیلدهای جای‌گذاری‌شده؟ *(منتظر کاربر)*  
3. تاریخچه: API بازسازی از JE+audit کافی است یا جدول `cheque_events`؟  
4. آیا ستون/فیلتر لیست باید روی `lifecycle_status` برود (نه فقط LIKE روی `status`)؟  
5. sunset یا redirect تب legacy `acc-cheques-recv` → دفتر چک؟  
6. clear: اجبار انتخاب بانک اگر `collection_bank_id` خالی؛ تاریخ قابل ویرایش؟  
7. ALLOWED_KEYS برای ۲۱۰۹ / ۳۱۰۲ / هزینهٔ پیش‌فرض خرج؟  
8. جدا کردن ستون JE برای pay/endorse از `collection_je_id` (مهاجرت) یا فقط `ref_type` در history API؟  
9. پیوست تصویر برگه چک — فایل sync؟  
10. آیا PATCH وضعیت نمایشی در مودال جدید باقی بماند (یادداشت غیرمالی) یا حذف شود؟

---

## ۱۱) موج‌های پیشنهادی (تحقیق — پیاده‌سازی پس از ADR)

| موج | هدف | محتوا |
|-----|------|--------|
| **0** | Freeze | همین سند |
| **P0** | مودال برگه + وضعیت + تاریخچهٔ خواندنی | `GET /:id` + `GET /:id/history` (بازسازی JE+audit)؛ UI برگه RTL؛ دکمه وضعیت → مودال؛ badge lifecycle؛ Help؛ تست |
| **P1** | هاب عملیات (اگر ADR=هاب) | انتقال دکمه‌های چرخه به مودال با تنظیمات حرفه‌ای per-transition (تاریخ، بانک، دلیل) |
| **P2** | یکسان‌سازی منو + فیلتر lifecycle | redirect legacy؛ فیلتر ماشین‌state؛ ALLOWED_KEYS COA چک |
| **P3** | سخت‌سازی | `cheque_events` اختیاری؛ پیوست فایل؛ جداسازی pointerهای JE؛ repair purchase party_id |

**پیشنهاد پیش‌فرض تا پاسخ کاربر:** P0 = مودال **مشاهده** (برگه ERP خوانا + timeline + لینک سند)؛ عملیات چرخه همان دکمه‌های ردیف بمانند تا ریسک حسابداری کم بماند. هاب = P1 پس از تأیید.

---

## ۱۲) فایل‌های کلیدی

| لایه | مسیر |
|------|------|
| Router | `server/routes/cheque-records.js` |
| Lifecycle | `server/lib/cheque-lifecycle.js` |
| Party books | `server/lib/cheque-party-books.js` |
| Void R13 | `server/lib/void-cheque.js` |
| Due/sync | `server/lib/cheque-due.js` |
| Invoice create | `server/lib/invoice-payments.js` |
| UI | `server/public/app.js` (`editChequeRegisterStatus`, register tab ~9367+) |
| Schema | `server/db.js` cheque_records |
| تست‌ها | `test-cheque-invoice-lifecycle-v303.js`, `test-trs-cheque-out.js`, `test-cheque-opening-bounce-v186.js` |

---

## ۱۳) Verify checklist (پس از پیاده‌سازی P0)

- [ ] دکمه وضعیت مودال باز می‌کند؛ دیگر `prompt` پیش‌فرض نیست  
- [ ] همه فیلدهای برگه از ردیف API پر می‌شوند  
- [ ] badge = `statusLabelFor(lifecycle)` + متن `status`  
- [ ] timeline شامل ثبت، واگذاری، وصول، برگشت، resend، خرج، ابطال با تاریخ و لینک JE  
- [ ] PATCH آزاد همچنان غیرمالی و `refuseFreeTextFinancial`  
- [ ] هیچ JE جدیدی از باز کردن مودال زده نمی‌شود  
- [ ] `test-sms` + `test-sync` + تست lifecycle موجود سبز  
- [ ] Help + CHANGE-LOG + SW bump  

**Spot-check تحقیق (کد):** PASS — رفتار prompt+PATCH و جدول endpointها با سورس هم‌خوان است.
