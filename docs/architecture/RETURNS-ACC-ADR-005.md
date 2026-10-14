# ADR-RETURNS-005 — برگشت فروش/خرید (Option Minimal-Correct)

**Status:** Accepted (۱۴۰۵/۰۷/۱۹)  
**Supersedes open decisions in:** `SALES-PURCHASE-RETURNS-RESEARCH.md` §۸  
**Builds on:** `CRM-SALES-ACC-ADR-004` §6 (returns P1), `WAREHOUSE-ACC-ADR-003`, Treasury ADR-001, R13 full-reverse on cancel

## Decision

Ship **Option Minimal-Correct** — همان پیشنهاد RESEARCH: باگ picker و unlinked در UI (P0)، سپس آینهٔ حسابداری فاکتور قطعی برای VAT و انبار typed (P1). بدون تخصیص credit، مودیان، کرایه، و clawback کمیسیون در این ADR.

### P0 — picker + unlinked UI

1. **فاکتور فروش قطعی:** بعد از انتخاب مشتری، لیست فاکتور فقط **`normal` ∪ `final`** (همان `isFirmSale` / فروش قطعی ADR-004) — نه `proforma` و نه فقط `final`.
2. **Hardening API:** پاسخ `GET /invoices` (و در صورت paginated بودن، سایر لیست‌ها) با **`listRows(...)`** قبل از فیلتر.
3. **برگشت بدون فاکتور (unlinked):** UI حالت «بدون فاکتور» برای نقش **`admin|accounting`**؛ API از قبل `invoice_id` / `purchase_invoice_id` اختیاری می‌پذیرد. فروشنده فقط linked. سیاست `returns_allow_open` در تنظیمات (پیش‌فرض مطابق محصول).
4. **Help:** همان موج — برچسب «فاکتور قطعی (معمولی/رسمی)»، unlinked + گاردهای نقش.
5. **SW:** bump هنگام ship فرانت (هدف موج: **`erp-taranom-v339`**).

### P1 — آینهٔ VAT + typed WH + settings

1. **معکوس VAT متناسب:** وقتی برگشت **linked** به فاکتور/PI با `vat_amount>0` و تنظیم **`returns_reverse_vat=1`** (پیش‌فرض روشن)، سهم VAT از مبلغ برگشتی با همان منطق proportional فاکتور منبع محاسبه و در JE معکوس **`coa_vat_payable` / `coa_vat_receivable`** منعکس شود (فروش/خرید آینه).
2. **انبار typed (فروش):** خطوط بهای تمام‌شده/موجودی برگشت فروش از **`inventoryAmountLinesByWarehouse`** (`server/lib/inventory/ledger.js`) — نه `coa_inventory` سراسری — هم‌تراز WH ADR-003 و فاکتور قطعی.
3. **ستون‌های سند:** `sales_returns.vat_amount` و `purchase_returns.vat_amount` (persist + در پیش‌نمایش/JE).
4. **تنظیمات حرفه‌ای (knobs):** حداقل `returns_reverse_vat`, `returns_allow_open` در `ALLOWED_KEYS` + پنل تنظیمات حسابداری؛ `coa_sales_return` (موجود از ADR-004) بدون تغییر قرارداد.
5. **تست:** regression perpetual + VAT returns (مثلاً گسترش `test-acc-crm-perpetual` یا تست اختصاصی returns-adr) پس از merge بک‌اند.

### P2-UX — ماتریس رنگ×سایز + پیش‌نمایش COGS (shipped)

1. جدول linked: ستون‌های جدا **رنگ** / **سایز** (+ طاقه در خرید)؛ ستون برآورد بها وقتی `__canSeeCost`.
2. نوار پیش‌نمایش مودال: مبلغ برگشت + برآورد بهای تمام‌شده (زنده با تغییر qty).
3. حالت بدون فاکتور: `openInvVariantSplitModal` با dest `sales_return` / `purchase_return`؛ ارسال `variant_id` + انبار؛ `buildRows` خرید variant/color/size را persist می‌کند.
4. SW هدف: **`erp-taranom-v340`**.

### P2-finance — مانده فاکتور با برگشت لینک‌شده (shipped)

1. **بدون تسویهٔ جعلی:** برگشت فروش با `invoice_id` بستانکار AR را از قبل در JE/`customer_ledger` می‌زند — ردیف `settlements` اضافه نمی‌شود.
2. **`recomputeInvoiceSettledBalances`:** `settled_amount` = دریافت‌های فاکتور (تسویه/POS) **+** جمع `amount + vat_amount` برگشت‌های فعال همان فاکتور؛ `balance_due = final_rial − settled`.
3. **API:** پس از POST/ابطال برگشت لینک‌شده، recompute روی همان فاکتور؛ `open-invoices` و `receivables/by-invoice` همان فرمول را در SQL منعکس می‌کنند.
4. **خرید (mirror v343):** `recomputePurchaseInvoiceSettledBalances` — `settled_amount` = پرداخت‌های تأمین‌کننده + هزینه‌های لینک‌شده + جمع `amount + vat_amount` برگشت‌های فعال؛ recompute بعد از POST/ابطال برگشت و پرداخت/هزینهٔ لینک‌شده؛ `GET /accounting/suppliers/:id/open-invoices` و `payables/by-invoice` همان فرمول را در SQL منعکس می‌کنند.

### P2c-allocate — تخصیص اعتبار برگشت بدون فاکتور (shipped)

1. **جدول `return_credit_allocations`:** side (`sales`|`purchase`)، `return_id`، `invoice_id`، `amount_rial`، soft-void (`status=reversed`) — **بدون JE**؛ فقط `settled_amount` / `balance_due` را via recompute به‌روز می‌کند.
2. **فقط unlinked:** برگشت با `invoice_id` / `purchase_invoice_id` از قبل در P2-finance در مانده لحاظ شده — POST `.../allocate` رد می‌شود (`E_ALLOC_ALREADY_LINKED`).
3. **API:** `POST /api/accounting/sales-returns/:id/allocate` و `POST /api/purchases/returns/:id/allocate`؛ recompute روی هر فاکتور هدف؛ `open-invoices` / `payables` و recompute در `invoice-payments` / `purchase-payments` جمع تخصیص‌های فعال (`sumAllocationsToInvoice`) را اضافه می‌کنند.
4. **`reason_code`:** ستون روی `sales_returns` / `purchase_returns` (کدهای ثابت در `return-credit-allocate.js`).
5. **Knob:** `returns_auto_allocate_credit` — FIFO خودکار روی قدیمی‌ترین فاکتور/PI باز همان طرف (`autoAllocateIfEnabled`).
6. **R13:** ابطال برگشت → `reverseAllocationsForReturn` همهٔ تخصیص‌های فعال را soft-reverse و recompute فاکتورهای مرتبط.
7. **Sync:** append `return_credit_allocations` در `tables.js`؛ `capture.js` مسیر `:id/allocate`؛ `sync_seq_backfill_v20`.
8. **SW هدف:** **`erp-taranom-v344`**.

**کرایه:** معکوس `freight_amount` همچنان **NO-GO** (خارج از این موج).

### P2d — ویرایش برگشت فروش (R13 same-id amend) — shipped

1. **`PUT /api/accounting/sales-returns/:id`:** reverse همهٔ اثرات create (انبار، soft-void JE، دفتر مشتری، تخصیص اعتبار) سپس re-post روی **همان id**؛ مشتری قفل.
2. **`exclude_return_id`** روی `GET …/available/:invoiceId` تا سقف qty در ویرایش خود سند را دوباره حساب کند.
3. UI دکمهٔ ویرایش + مودال پیش‌پر؛ Help + SW bump.
4. الگوی مرجع داخلی: لایه‌چینی v364؛ بیرونی: ERPNext cancel+amend / immutable ledger (بدون overwrite خام posted).

### Out of scope (P2 finance remainder / P3 — ADR یا موج جدا)

| موضوع | موج |
|--------|-----|
| Allocate credit/debit دستی به فاکتور/PI باز | ~~P2-finance+~~ **shipped P2c** |
| ویرایش برگشت فروش (same-id amend) | ~~P2d~~ **shipped** |
| ویرایش برگشت خرید (آینه) | P2d+ / موج جدا |
| Moadian credit/debit note | P3 |
| معکوس کرایه (`freight_amount`) | P2-finance |
| Commission clawback JE | P3 |
| Value-only کامل (`update_stock=0` UX)، reason codes، گزارش qty برگشتی روی فاکتور | P2-finance |

## Invariants (unchanged)

- فروش قطعی = `normal` ∪ `final`; unlinked فقط با نقش/تنظیمات + قیمت دستی + بدون سقف qty از فاکتور.
- پول: DB ریال؛ مرز تومان در `postToLedger` مگر مسیر `*_rial`.
- ابطال R13: soft-void + reverse JE/انبار/زیردفتر در یک تراکنش؛ حذف فیزیکی ممنوع.
- Sync: `sales_returns` / `purchase_returns` در SYNCABLE؛ capture paths موجود — ستون `vat_amount` additive، بدون reorder `tables.js`.

## Waves

| Wave | Content | Acceptance |
|------|---------|------------|
| **P0** | firm picker + `listRows` + unlinked UI + Help + SW v339 | مشتری با فقط `normal` فاکتور می‌بیند؛ unlinked با admin/accounting ثبت می‌شود |
| **P1** | proportional VAT + typed WH sales + vat columns + settings knobs + tests | ADR-004 §6 returns سبز؛ تراز AR/AP با منبع linked |
| **P2-UX** | رنگ×سایز columns + COGS preview + open matrix + `variant_id` purchase buildRows + SW v340 | مودال حرفه‌ای؛ open PR/SR با variant؛ پیش‌نمایش بها برای نقش مجاز |
| **P2-finance** | sales invoice balance + returns gross | `balance_due` پس از برگشت لینک‌شده درست است |
| **P2b-finance** | purchase invoice balance mirror + open-invoices/payables APIs + SW v343 | PI `balance_due` با برگشت خرید؛ freight خارج از موج |
| **P2c-allocate** | `return_credit_allocations` + allocate APIs + recompute/open SQL + reason_code + auto knob + R13 reverse allocs + SW v344 | unlinked credit به فاکتور باز؛ linked بدون allocate جدا؛ بدون JE |

## Rollback

- **P0:** revert فرانت+Help؛ بدون اثر DB.
- **P1:** `returns_reverse_vat=0` غیرفعال‌کنندهٔ خط VAT بدون حذف ستون‌ها؛ revert JE builder در صورت نیاز.

## Consequences

- باگ «فاکتور نمی‌آید» بسته می‌شود بدون تغییر قرارداد API.
- برگشت linked از نظر VAT و انبار فروش با فاکتور قطعی هم‌تراز می‌شود؛ خرید از قبل typed WH داشت — VAT purchase در P1 تکمیل می‌شود.
- تسویه/ compliance در موج‌های بعدی بدون بازنویسی P0/P1.

## Files (reference — implementer)

**P0:** `server/public/app.js`, `server/public/sw.js`, `server/public/index.html` (Help), CHANGE-LOG  

**P1:** `server/routes/accounting.js`, `server/routes/purchases.js`, `server/lib/inventory/ledger.js`, `server/routes/settings.js`, `server/db.js` (columns), تست‌های returns/perpetual, Help, SW v339

**Docs:** این ADR، به‌روز `SALES-PURCHASE-RETURNS-RESEARCH.md`, CHANGE-LOG
