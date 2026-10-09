# تحقیق انبار — تنظیمات حرفه‌ای + ثبت‌های دقیق حسابداری

**وضعیت:** Research (pre-ADR) — قبل از هر تغییر schema/UI  
**تاریخ:** ۱۴۰۵/۰۷/۱۸  
**منبع:** skill-top **full** + متخصصان inventory/JE/verify + tap-erp-architecture + ECC (architect/planner)  
**Slack:** در workspace متصل هیچ کانال/پیامی برای «انبار / warehouse / امانی / erp» یافت نشد — منبع حقیقت کد + CHANGE-LOG + ADRهای موجود است.

## هدف محصول

هر انبار و هر عملیات منوی **انبار** باید:

1. طبق قوانین خودش روی موجودی و دفتر کل اثر بگذارد (دوطرفه، اتمیک، قابل ابطال R13).
2. تنظیمات حرفه‌ای **per-warehouse** داشته باشد (نه فقط `warehouse_type` سراسری + settings عمومی).
3. زیردفتر موجودی (`inventory_ledger` / `warehouse_stock`) با حساب کنترل GL هم‌تراز بماند.

| لایه | محتوا | امروز |
|------|--------|--------|
| **A** اطلاعات پایه | انبارها (نوع، entity، مرکز هزینه، سیستم perpetual/periodic) | فرم + ستون‌ها؛ **بدون COA اختصاصی روی ردیف انبار** |
| **B** عملیات | رسید/حواله/انتقال، انبارگردانی، بچ/سریال، طاقه، رزرو، هزینه حمل، امانی | موتور `warehouse-docs` + libهای inventory |
| **C** گزارشات | جامع، رنگ‌سایز، کاردکس، گردش طاقه | وابسته به avg ریال + ledger |
| **D** تنظیمات حرفه‌ای per-WH | override COA، سیاست منفی، روش بها، GRNI vs 9999، in-transit | نیمه‌کاره / MISSING |

## ثابت‌های قفل‌شده (تغییر فقط با ADR جدید)

| ثابت | منبع | معنا |
|------|------|------|
| پول | ADR-001 | DB = ریال صحیح؛ `postToLedger` مرز تومان |
| ارزش‌گذاری | ADR-001 | میانگین موزون perpetual روی **header محصول**؛ رنگ×سایز تحلیلی |
| ابطال | R13 | soft-void JE + reverse ledger؛ حذف فیزیکی ممنوع |
| نگاشت نوع→COA | `ledger.js:inventoryAccountForWarehouse` | raw→1110، scrap→1113، consignment→1114، else→1104 FG |

---

## ۱) تنظیمات فعلی انبار

### ۱.۱ انواع پیش‌فرض (`warehouses.js:DEFAULT_WAREHOUSE_TYPES`)

| value | برچسب | حساب کنترل |
|-------|--------|------------|
| `raw_material` | مواد اولیه | 1110 |
| `finished_goods` | محصول نهایی | 1104 |
| `consignment` | امانی | 1114 |
| `scrap` | ضایعات | 1113 |

قابل گسترش از `settings.warehouse_types`. **`packaging` و `wip` در نگاشت COA نیستند** (1112/1111 در `coa-map` آماده‌اند ولی انتخاب نمی‌شوند).

### ۱.۲ ستون‌های `warehouses`

| ستون | نقش |
|------|-----|
| `name`, `address`, `active`, `code` | پایه |
| `entity` | `workshop` / `distribution_office` (+ گسترش) |
| `warehouse_type` | نگاشت COA |
| `cost_center_id` | مرکز هزینه روی JE سند انبار |
| `is_default` | پیش‌فرض |
| `inventory_system` | `perpetual` \| `periodic` |
| `allow_negative` | موجودی منفی per-WH |
| `costing_method` | فقط اگر `costing_scope=per-warehouse` |

**ستون `inventory_coa_code` / Account روی انبار وجود ندارد** (الگوی ERPNext: Warehouse.account).

### ۱.۳ تنظیمات سراسری مرتبط (`INV_SETTINGS`)

`inventory_costing_method`, `inventory_allow_negative`, `inventory_auto_post_je` (**seed شده؛ gating خوانده نمی‌شود**), `inventory_batch_required`, `inventory_serial_required`, `inventory_fefo_enabled`, `inventory_reservation_ttl_hours`, `costing_scope` (`global`|`per-product`|`per-warehouse`), `feature_perpetual_docs`, `feature_cogs_voucher`, `production_allow_negative_stock`.

---

## ۲) ماتریس عملیات → موجودی → JE

| عملیات | API / موتور | اثر qty | اثر بها | JE (خلاصه) | Void | شکاف |
|--------|-------------|---------|---------|------------|------|------|
| رسید انبار | `warehouse-docs` type=receipt | +ledger/stock | MA inbound | Dr typed inv / Cr **9999** یا 3102 (افتتاحیه)؛ periodic: بدون JE ارزشی | `voidWarehouseDoc` | Cr≠AP/GRNI |
| حواله انبار | type=issue | −qty | outbound avg/FIFO | Dr 6108 / Cr typed | همان | ≠ COGS فروش |
| انتقال | type=transfer | out+in | بدون updateAvg | فقط اگر COA مبدأ≠مقصد | همان | بدون 1115 in-transit |
| انبارگردانی | `cycle-count` / stocktaking | ±qty | unitCostRial | surplus 4205 / shortage 6108 | `voidCycleCount` | — |
| بستن ادواری | `period-close` | set qty | BI+Purch−EI دستی | COGS↔**1104** نه typed | reopen | purchases دستی |
| بچ / سریال / FEFO | `batch-serial` + inventory routes | لایه/وضعیت | specific/FIFO | از سند والد | وابسته | enforce ضعیف |
| طاقه پارچه | `fabric-rolls` | batch+ledger | avg | Dr 1110 / Cr payable | `voidFabricRoll` | — |
| رزرو | `reservation` | soft ATP | — | **بدون JE** | release | درست برای soft |
| هزینه حمل | `landed-cost` | value-only | bump avg | Dr **1104** / Cr payable | `voidLandedCost` | نه typed |
| امانی | `consignments` | ship out / settle | avg | ship 1114↔typed؛ settle COGS/خرید/کمبود | void consignment | `in` بدون qty اولیه |
| فاکتور فروش | `sales-document` | sale out | COGS | Dr 5101 / Cr **1104** (typed پاس داده نمی‌شود) | void invoice | typed ناقص |
| فاکتور خرید | `purchases` | purchase in | landed unit | Dr **1104** / Cr AP | DELETE→reverse | typed نادیده |
| GRNI | `procurement` goods-receipt | purchase | — | Dr 1104 / Cr 2112 | DELETE GR | typed نادیده |
| تعدیل دستی | `POST /inventory/adjust` | ±qty | اختیاری | **بدون JE** | reverse ledger | گپ حسابداری |
| تولید legacy | `production_runs` | مستقیم stock | — | **بدون JE/ledger** | DELETE qty | دو منبع حقیقت |
| تولید موتور | `production/*` posting | issue/receipt/WIP | avg | PRD-01…23 | reverse engine | ADR-001 |

---

## ۳) کلیدهای COA موجودی (`coa-map.js`)

| کلید | کد | نقش |
|------|-----|-----|
| `coa_inventory` / `coa_finished_goods` | 1104 | کالا / FG |
| `coa_raw_materials` | 1110 | مواد |
| `coa_wip` | 1111 | در جریان ساخت |
| `coa_packaging_materials` | 1112 | بسته‌بندی (نگاشت WH ندارد) |
| `coa_scrap_inventory` | 1113 | ضایعات |
| `coa_subcontract_inventory` | 1114 | امانی / پیمانکار |
| `coa_inventory_in_transit` | 1115 | در راه (**رویه ندارد**) |
| `coa_cogs` | 5101 | بهای تمام‌شده فروش |
| `coa_inventory_gain` / `coa_inventory_loss` | 4205 / 6108 | کسری/اضافی انبارگردانی |
| `coa_grni` | 2112 | رسید نشده صورتحساب |
| `coa_opening_balance` | 3102 | افتتاحیه |
| `coa_adjustment` | 9999 | طرف رسید دستی انبار |

---

## ۴) ریسک بحرانی — دوباره‌ثبت رسید

| مسیر | بدهکار | بستانکار |
|------|--------|----------|
| رسید انبار (`warehouse-docs`) | typed WH | **9999** |
| فاکتور خرید | **1104** (untyped) | AP |
| GRNI | **1104** | 2112 |

اگر برای همان کالا هم رسید انبار و هم خرید/GR زده شود → **دوبار بدهکار موجودی** + ناسازگاری typed vs 1104 + بدهی اشتباه (9999 vs AP/GRNI).

---

## ۵) تأیید Verify (۱۲ ادعا)

| # | ادعا | نتیجه |
|---|------|--------|
| 1 | بدون COA per-WH | CONFIRMED |
| 2 | خرید همیشه 1104 | CONFIRMED |
| 3 | landed همیشه 1104 | CONFIRMED |
| 4 | رسید WH → Cr 9999 | CONFIRMED |
| 5 | `inventory_auto_post_je` بدون gating | CONFIRMED |
| 6 | `/inventory/adjust` بدون JE | CONFIRMED |
| 7 | انتقال بدون 1115 | CONFIRMED |
| 8 | COGS Cr typed نیست | PARTIAL (پیش‌فرض 1104؛ پارامتر `inventoryCoaCode` پاس نمی‌شود) |
| 9 | packaging→1112 نیست | CONFIRMED |
| 10 | period-close → 1104 | CONFIRMED |
| 11 | NRV بدون posting | **FALSE** — `POST /api/reserves/inventory-nrv` دارد |
| 12 | تولید legacy بدون ledger/JE | CONFIRMED |

---

## ۶) مدل هدف تنظیمات حرفه‌ای per-warehouse

الگوی مرجع: **ERPNext perpetual** — هر Warehouse حساب موجودی (یا ارث از والد / پیش‌فرض شرکت).

| فیلد پیشنهادی | پیش‌فرض | نقش |
|---------------|---------|-----|
| `inventory_coa_code` | از `warehouse_type` | override حساب کنترل |
| `inventory_system` | perpetual | همان ستون فعلی |
| `allow_negative` | از settings | همان |
| `costing_method` | از scope | همان (avg همچنان header تا ADR جدید) |
| `receipt_counterpart` | `grni` \| `ap` \| `adjustment` \| `opening` | طرف حساب رسید |
| `post_transfer_via_transit` | false | استفاده از 1115 برای انتقال بین‌entity |
| `ownership` | `owned` \| `consigned_in` \| `consigned_out` | امانی qty-only vs دارایی |
| `auto_post_je` | از `inventory_auto_post_je` | gating صریح |

**Invariant:** برای هر حرکت ارزشی perpetual:  
`Δ زیردفتر ارزش انبار (حساب کنترل) = Δ مانده GL همان حساب` (پس از پست و پس از void).

---

## ۷) Research notes (خارجی)

| Practice | کاربرد برای ترنم |
|----------|------------------|
| Perpetual: هر تراکنش موجودی → JE | هم‌راستا با WH docs + فروش/خرید؛ periodic فقط با close |
| Warehouse → Account head (ERPNext) | ستون override COA روی `warehouses` |
| Purchase Receipt → Inventory / GRNI | جایگزین Cr 9999 برای رسید تأمین‌کننده |
| Landed cost سرمایه روی موجودی باقیمانده (+ سهم COGS فروخته‌شده) | تقویت `landed-cost.js` + typed COA |
| Consignment: مالک دارایی را نگه می‌دارد | جدا کردن ownership از location |

### مرجع ≤۳

1. **frappe/erpnext** — `get_warehouse_account` / perpetual stock controller — reuse: الگوی Account روی Warehouse + GRNI.  
2. **Finale / distributor landed-cost guides** — reuse: تخصیص کرایه و revalue avg.  
3. داخلی: `docs/Production/accounting-events.md` + ADR-001 — reuse: قالب PRD و مرز ریال.

---

## ۸) موج پیاده‌سازی پیشنهادی

### P0 — توقف drift تراز (الزامی قبل از UI تنظیمات)

1. یکپارچه‌سازی مسیر رسید: خرید/GR = AP یا GRNI؛ رسید تأمین‌کننده از WH نباید Cr 9999 بزند (یا فقط opening/adjustment صریح).
2. خرید + GR + landed + COGS → `inventoryAccountForWarehouse` (نه bare `coa_inventory`).
3. تست طلایی: همان کالا از مسیر خرید alone / GR alone / WH receipt alone — بدون double-post؛ تراز آزمایشی سبز.

### P1 — تنظیمات حرفه‌ای per-WH

4. ستون `inventory_coa_code` (+ UI در فرم انبار) با fallback type-map؛ افزودن `packaging`→1112 و در صورت نیاز `wip`→1111.
5. پاس دادن typed COA به `postCogsFromMovements`.
6. Help داخل برنامه + CHANGE-LOG.

### P2 — عملیات ناقص

7. Honor `inventory_auto_post_je`؛ JE یا skip صریح روی `/inventory/adjust`.
8. انتقال اختیاری از مسیر 1115 برای بین‌entity/تأخیری.
9. گیت/مهاجرت تولید legacy به `postInventoryMovement` + JE.

### P3 — ادواری و گزارش

10. period-close روی حساب typed (یا per-WH COA).
11. گزارش تطبیق زیردفتر موجودی ↔ GL per حساب کنترل.
12. ADR نهایی «WAREHOUSE-ACC-ADR-003» پس از قفل تصمیم‌های باز.

---

## ۹) تصمیم‌های باز (قبل از کد)

1. آیا رسید دستی انبار فقط برای **افتتاحیه/تعدیل** مجاز است و رسید خرید فقط از PI/GR؟  
2. آیا `inventory_coa_code` اجباری است یا همیشه از type؟  
3. آیا ارزش‌گذاری per-warehouse واقعاً لازم است یا ADR-001 (avg روی header) کافی است؟  
4. امانی `direction=in`: آیا باید qty در create ثبت شود؟  
5. انتقال همیشه بدون JE هم‌نوع بماند یا همیشه 1115؟

---

## ۱۰) فایل‌های کلیدی implementer

| حوزه | مسیر |
|------|------|
| نگاشت COA | `server/lib/inventory/ledger.js`, `server/lib/coa-map.js` |
| اسناد انبار | `server/lib/warehouse-docs.js`, `server/lib/void-warehouse-move.js` |
| خرید / GR | `server/routes/purchases.js`, `server/routes/procurement.js` |
| COGS | `server/lib/sales-document.js` |
| Landed / cycle / periodic | `server/lib/inventory/{landed-cost,cycle-count,periodic-close}.js` |
| امانی | `server/lib/consignments.js` |
| تست‌ها | `test-acc-crm-perpetual`, `test-warehouse-audit-v305/306`, `test-warehouse-cost-rial-v333`, `test-consignment-batch-v261` |

## Skills / plugins استفاده‌شده

- skill-top (full) · ECC AGENTS (architect/planner برای موج بعد) · tap-erp-architecture  
- Slack search/API — بدون نتیجه در workspace فعلی  
- متخصصان موازی: warehouse map · accounting JE · verify gaps
