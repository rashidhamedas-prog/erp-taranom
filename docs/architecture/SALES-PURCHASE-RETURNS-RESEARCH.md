# تحقیق برگشت از فروش / برگشت از خرید — وابستگی‌ها، حسابداری، تنظیمات حرفه‌ای

**وضعیت:** Research ✅ → ADR بعدی (پیشنهاد RETURNS-ADR-005) هنوز قفل نشده  
**تاریخ:** ۱۴۰۵/۰۷/۱۹  
**منبع:** skill-top **full** + tap-erp-architecture + ECC (plan-before-execute) + Slack search (بدون نتیجه)  
**متخصصان موازی:** [Map return accounting deps](148f46f2-447b-40ab-be67-b978b9093062) · [Find invoice picker bug](7537c2da-8c66-4cda-9588-ae58651ee232)  
**وابسته به:** `CRM-SALES-ACC-ADR-004` §6 (P1 returns)، `WAREHOUSE-ACC-ADR-003`، `ACC-CRM-UNIFY-AUDIT`، Treasury ADR-001  
**Slack:** در workspace متصل هیچ پیام/کانالی برای «برگشت از فروش / فاکتور» یافت نشد — منبع حقیقت کد + ADRهاست.  
**مرجع بیرونی (≤۳):**  
1. [ERPNext Sales Return / Credit Note](https://docs.frappe.io/erpnext/sales-return) — لینک به فاکتور ترجیح؛ برگشت بدون فاکتور ممکن ولی کنترل کمتر؛ جداسازی stock vs accounting  
2. [ERPNext Debit Note / Purchase Return](https://docs.frappe.io/erpnext/debit-note) — همین الگو برای خرید  
3. الگوی داخلی ترنم: RESEARCH اشخاص/تولید/خزانه (ماتریس JE + settings + موج P0–P3)

---

## هدف محصول

1. **باگ فوری:** بعد از انتخاب مشتری، لیست «فاکتور فروش» باید همهٔ فاکتورهای **قطعی** (`normal` + `final`) را بیاورد — نه فقط `final`.
2. **قابلیت:** برگشت از فروش و برگشت از خرید **با یا بدون** فاکتور مرجع (credit/debit note standalone) با گاردهای حسابداری و انبار.
3. هر سند برگشت طبق قوانین خودش روی JE، زیردفتر، موجودی، مالیات، و (در موج بعدی) تسویه/مودیان اثر بگذارد — اتمیک + R13.
4. تنظیمات حرفه‌ای per-document-type (نه فقط یک کلید COA مخفی).

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** UI picker | مشتری/تأمین → فاکتور → اقلام قابل برگشت | فیلتر اشتباه + فاکتور اجباری در UI |
| **B** API create | linked / unlinked | سرور unlinked را می‌پذیرد؛ UI بلاک می‌کند |
| **C** پستینگ | JE + زیردفتر + انبار | ناقص نسبت به فاکتور قطعی (VAT/تخفیف/typed WH) |
| **D** تنظیمات حرفه‌ای | COA، سیاست لینک، stock toggle، سقف | جزئی (`coa_sales_return`)؛ purchase return بدون کلید اختصاصی |

---

## ثابت‌های قفل‌شده (تغییر فقط با ADR)

| ثابت | منبع | معنا |
|------|------|------|
| فروش قطعی | `isFirmSale` / ADR-004 | `normal` ∪ `final` هر دو پست می‌شوند؛ `proforma` تا convert نه |
| پول | ADR-001 | DB ریال؛ `postToLedger` مرز تومان مگر مسیر `*_rial` |
| انبار typed | WH ADR-003 | مسیرهای ارزشی خرید/فروش باید `inventoryAccountForWarehouse` |
| ابطال | R13 | soft-void + reverse JE/انبار/زیردفتر؛ حذف فیزیکی ممنوع |
| لینک فاکتور | این RESEARCH | **ترجیح قوی linked**؛ unlinked فقط با مجوز نقش + قیمت دستی + بدون سقف qty از فاکتور |
| آفلاین | sync | `sales_returns` / `purchase_returns` در SYNCABLE؛ capture path موجود |

---

## ۱) باگ P0 — فاکتور در برگشت فروش نمی‌آید

### شواهد

```17783:17784:server/public/app.js
  CACHE.invoices=await api('GET','/invoices')||[];
  const invs=CACHE.invoices.filter(i=>i.cust_id===custId && i.type==='final');
```

| فرضیه | احتمال | توضیح |
|--------|--------|--------|
| فقط `type==='final'` | **بالا** | فاکتورهای **معمولی** (`normal`) قطعی‌اند ولی از لیست حذف می‌شوند |
| انتخاب مشتری بدون pick از دراپ‌داون | متوسط | `pickCust` رویداد `change` می‌فرستد؛ تایپ تنها کافی نیست |
| پاسخ paginated بدون `listRows()` | پایین | `GET /invoices` بدون page معمولاً آرایه خام است |
| scope فروشنده روی `/invoices` | پایین | مسیر accounting معمولاً admin/accounting است |

**Backend هیچ محدودیتی به `final` ندارد** — `POST /accounting/sales-returns` فقط `invoice_id` + `cust_id` را چک می‌کند.

### اصلاح P0 پیشنهادی (حداقل)

1. فیلتر: `isFirmSale(i.type)` یا `(type==='final'||type==='normal')` + `Number(i.cust_id)===custId`
2. `listRows(await api(...))` برای hardening
3. برچسب UI: «فاکتور فروش قطعی (معمولی/رسمی)» نه فقط «رسمی»
4. Help همان موج

---

## ۲) حالت‌های سند (قفل برای ADR)

الگوی ERPNext تطبیق‌یافته با ترنم:

| حالت | Sales | Purchase | Stock | Accounting |
|------|-------|----------|-------|------------|
| **R-LINK+STOCK** | برگشت روی فاکتور قطعی + ورود انبار | برگشت روی PI + خروج انبار | بله | بله (معکوس ساختار فاکتور) |
| **R-LINK+VALUE** | کاهش مطالبه/درآمد بدون ورود کالا | کاهش بدهی بدون خروج کالا | خیر | بله |
| **R-OPEN+STOCK** | بدون فاکتور + ورود انبار | بدون PI + خروج انبار | بله | بله (قیمت/بهای دستی یا لیست) |
| **R-OPEN+VALUE** | credit note خالص | debit note خالص | خیر | بله |

**امروز ترنم:** عملاً فقط R-LINK+STOCK اجباری در UI؛ سرور R-OPEN+STOCK را نیمه‌پشتیبانی می‌کند (بدون VAT، بدون toggle value-only).

### قانون ترجیح

1. اگر فاکتور شناخته است → **اجباری لینک** برای سقف qty و قیمت از منبع.  
2. اگر فاکتور نامشخص (امانی قدیمی، انتقال دستی، اصلاح توافقی) → R-OPEN با `reason_code` + نقش `admin|accounting`.  
3. Value-only فقط وقتی `update_stock=0` صریح باشد (امروز این فلگ **وجود ندارد**).

---

## ۳) قالب‌های JE فعلی vs هدف

### ۳.۱ برگشت فروش — امروز (`accounting.js` ~1723–1741)

| خط | حساب | Dr | Cr |
|----|------|----|----|
| Contra درآمد | `coa_sales_return` (۴۱۰۲) | amount | — |
| AR | `recvAcct(cust)` | — | amount |
| اگر cost>0 | `coa_inventory` (۱۱۰۴ سراسری) | cost | — |
| اگر cost>0 | `coa_cogs` (۵۱۰۱) | — | cost |

+ `customer_ledger` credit=amount (`entry_type=reversal`)  
+ `postSaleReturnStockMovements` (میانگین)

**شکاف vs فاکتور قطعی / ADR-004 P1:**

| جزء فاکتور | برگشت امروز |
|------------|-------------|
| VAT خروجی ۲۱۰۳ | ❌ معکوس نمی‌شود |
| تخفیف ۴۱۰۳ / ساختار disc | فقط خطی در linked؛ بدون خط JE جدا |
| کرایه | ❌ |
| انبار typed | ❌ (۱۱۰۴ سراسری) |
| تسویه/refund بعد از پرداخت | فقط مانده بستانکار مشتری |
| مودیان credit note | ❌ |
| دوره‌ای vs دائمی انبار | ناسازگار با گیت perpetual فاکتور |

### ۳.۲ برگشت خرید — امروز (`purchases.js` ~687–701)

| خط | حساب | Dr | Cr |
|----|------|----|----|
| AP | `payableAcct(supplier)` | amount | — |
| موجودی | `inventoryAccountForWarehouse` | — | amount |

+ `supplier_ledger` debit=amount  
+ خروج موجودی با `unitCostRial=price` (نه لزوماً بهای واقعی رسید)

**شکاف:** VAT خرید، GRNI/۲۱۰۲، کلید `coa_purchase_return`/`coa_purchase_expense`، چند انبار در یک JE، value-only.

### ۳.۳ هدف پس از ADR (پیشنهاد قالب)

**Sales return linked (با VAT و تخفیف متناسب qty):**

```
Dr  4102 sales_return          (net sales portion)
Dr  4103?  یا کاهش disc مناسب   (طبق سیاست: آینهٔ salesJournalLines)
Dr  2103 VAT payable           (vat portion)     [اگر فاکتور vat داشت]
   Cr  AR / tafsili            (gross = net+vat ± freight policy)
Dr  Inv WH typed               (cost)
   Cr  5101 COGS               (cost)
```

**Purchase return linked:**

```
Dr  AP / tafsili               (gross)
   Cr  Inv WH typed            (یا expense اگر non-stock)
   Cr  VAT receivable          (اگر داشت)
```

مبالغ از نسبت qty برگشتی به خط فاکتور؛ rounding همان `calcDocTotals` / قوانین خرید.

---

## ۴) ماتریس وابستگی تک‌به‌تک

| وابستگی | Sales return | Purchase return | وضعیت |
|---------|--------------|-----------------|--------|
| مشتری / تأمین | الزامی | الزامی | ✅ |
| فاکتور مرجع | UI اجباری / API اختیاری | UI اجباری / API اختیاری | ⚠️ |
| سقف qty از فاکتور | linked ✅ | linked ✅ | ✅ |
| قیمت از فاکتور | linked ✅ | linked ✅ | ✅ |
| انبار از فاکتور/خط | جزئی | جزئی | ⚠️ |
| `customer_ledger` / `supplier_ledger` | ✅ | ✅ | ✅ |
| JE idempotent | ✅ | ✅ | ✅ |
| perpetual `inventory_ledger` | ✅ | ✅ | ✅ |
| variant/SKU layer | try/catch | batch/variant | ⚠️ |
| typed WH COA | ❌ sales | ✅ purchase | gap |
| VAT | ❌ | ❌ | gap |
| freight | ❌ | ❌ | gap |
| settlements allocate | ❌ | ❌ | gap |
| cheque/refund | ❌ | ❌ | gap |
| Moadian | ❌ | N/A | defer |
| commission clawback | KPI کم می‌کند؛ JE clawback ❌ | — | gap |
| void invoice guard | فعال اگر return باز | فعال روی PI | ✅ |
| R13 ابطال خود return | ✅ نسبی | ✅ نسبی | ✅ |
| sync capture | ✅ | ✅ | ✅ |
| warehouse slip چاپ | ✅ sales | — | جزئی |

---

## ۵) تنظیمات حرفه‌ای پیشنهادی

| کلید / knob | لایه | امروز | موج |
|-------------|------|--------|-----|
| `coa_sales_return` | COA | ✅ ALLOWED + UI | P0 done (v337) |
| `coa_purchase_return` یا استفاده از expense/inv | COA | ❌ | P1 |
| `returns_require_source_invoice` | سیاست (0/1؛ default 0 با هشدار) | UI سخت‌کد اجباری | P0 |
| `returns_allow_open_roles` | نقش‌ها | — | P0 |
| `returns_default_update_stock` | 0/1 | همیشه stock | P1 |
| `returns_price_source` | `invoice` \| `list` \| `manual` | linked=invoice؛ open=list/manual | P1 |
| `returns_reverse_vat` | 0/1 | همیشه off | P1 |
| `returns_reverse_freight` | 0/1 | off | P2 |
| `returns_auto_allocate_credit` | 0/1 به فاکتور باز | off | P2 |
| WH COA typed on sales return | کد | off | P1 (ADR-004) |
| Reason codes | enum | — | P1 |
| Period gate `assertPeriodOpen` | گیت | بررسی شود | P1 |

پنل UI پیشنهادی: زیر تنظیمات حسابداری → «برگشت فروش/خرید» (مشابه Production Settings v336).

---

## ۶) جریان UI هدف

### برگشت فروش

1. مشتری *  
2. حالت: «روی فاکتور» | «بدون فاکتور (مجاز برای نقش)»  
3. اگر روی فاکتور: select از firm invoices همان مشتری (num/date/final/type)  
4. انبار مقصد برگشت (پیش‌فرض از فاکتور)  
5. `update_stock` چک‌باکس (پیش‌فرض از تنظیمات)  
6. جدول اقلام: از available API یا انتخاب کالا دستی + قیمت  
7. پیش‌نمایش خطوط JE (net/VAT/cost) قبل از ثبت  
8. ثبت اتمیک

### برگشت خرید

آینهٔ بالا با تأمین‌کننده + PI.

---

## ۷) موج‌های پیشنهادی

| موج | محتوا | معیار پذیرش |
|-----|--------|-------------|
| **P0** | فیلتر firm؛ `listRows`؛ UI حالت بدون فاکتور (API از قبل آماده)؛ Help؛ تست picker | مشتری با فقط `normal` فاکتور می‌بیند؛ unlinked با نقش ثبت می‌شود |
| **P1** | JE VAT/discount آینه؛ typed WH روی sales return؛ `update_stock`؛ settings knobs؛ تست perpetual+VAT | ADR-004 §6 برای returns سبز؛ تراز AR با `final` نسبی |
| **P2** | allocate credit به فاکتور باز؛ freight؛ reason codes؛ گزارش returned qty روی فاکتور | تسویه/مانده هم‌خوان |
| **P3** | Moadian credit note؛ commission clawback JE؛ value-only polish؛ Android/desktop اگر لازم | compliance جدا |

**Rollback:** P0 فقط فرانت+Help؛ P1+ پشت فلگ تنظیمات `returns_reverse_vat` تا deploy ایمن.

---

## ۸) تصمیم‌های باز برای ADR-RETURNS-005

1. **آیا unlinked به‌صورت پیش‌فرض باز است یا پشت تنظیمات؟** پیشنهاد: باز برای admin/accounting + هشدار UI؛ فروشنده فقط linked.  
2. **آیا VAT همیشه متناسب qty معکوس شود یا فقط وقتی فاکتور `vat_amount>0`؟** پیشنهاد: اگر منبع vat داشت، بله.  
3. **آیا credit مشتری بعد از برگشت خودکار به فاکتور همان مشتری allocate شود؟** پیشنهاد P2؛ P1 فقط مانده.  
4. **کلید جدا `coa_purchase_return` یا فقط Cr موجودی؟** پیشنهاد: نگه داشتن مدل فعلی خرید (AP/Inv) مگر سیاست «برگشت به هزینه» برای غیرکالایی.  
5. **Value-only در P1 یا P2؟** پیشنهاد: اسکلت فلگ در P1؛ UX کامل P2.

### پیشنهاد موقت (تا قفل ADR)

Option **Minimal-Correct** (مشابه ADR-PARTY Option 1):

- P0 باگ + UI unlinked  
- P1 حسابداری آینهٔ فاکتور (VAT + typed WH) بدون allocate و بدون مودیان  

---

## ۹) فایل‌های درگیر

**P0:** `server/public/app.js`, `server/public/sw.js`, `server/public/index.html` (Help), تست UI/API سبک، CHANGE-LOG  

**P1+:** `server/routes/accounting.js`, `server/routes/purchases.js`, `server/lib/sales-document.js`, `server/lib/customer-books.js` (یا `salesReturnJournalLines` جدید), `server/lib/inventory/ledger.js`, `server/routes/settings.js`, `server/lib/coa-map.js`, تست‌های `test-acc-crm-perpetual.js` + تست جدید returns-adr, ADR فایل جدا

**Sync:** فقط اگر ستون/جدول جدید — append `tables.js` + backfill + `capture.js` طبق sync-hygiene

---

## ۱۰) Verify ادعاها (spot-check)

| # | ادعا | نتیجه |
|---|------|--------|
| 1 | UI فقط `final` فیلتر می‌کند | PASS `app.js:17784` |
| 2 | Firm = normal∪final | PASS `sales-document.js` |
| 3 | API sales return بدون invoice_id مجاز است | PASS `accounting.js:1695,1669` |
| 4 | API purchase return بدون PI مجاز است | PASS `purchases.js:632-642` |
| 5 | UI هر دو را اجباری می‌کند | PASS `saveSalesReturn` / `savePurchaseReturn` |
| 6 | Sales return JE بدون VAT | PASS خطوط 1727–1735 |
| 7 | Sales return Inv سراسری نه typed WH | PASS `coa_inventory` |
| 8 | Purchase return typed WH | PASS `inventoryAccountForWarehouse` |
| 9 | `coa_sales_return` در settings | PASS ADR-004 / ALLOWED_KEYS |
| 10 | ADR-004 P1 returns هنوز باز است | PASS §6 |

---

## ۱۱) خلاصه اجرایی برای محصول

**چرا فاکتور نمی‌آید:** لیست فقط «رسمی» (`final`) را نشان می‌دهد؛ بخش زیادی از فروش‌های قطعی «معمولی» (`normal`) است.  
**چرا بدون فاکتور نمی‌شود:** محدودیت UI است نه سرور.  
**چرا «حرفه‌ای» نیست:** معکوس VAT/تخفیف/انبار typed و تنظیمات سیاست هنوز پیاده نشده‌اند — در ADR-004 به‌عنوان P1 ثبت شده‌اند.

**قدم بعدی پیشنهادی:** تأیید Option Minimal-Correct → ADR-RETURNS-005 یک‌صفحه‌ای → پیاده‌سازی P0 فوری → P1 حسابداری.
