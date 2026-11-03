# موجودی تک‌منبعی — فاز ۰ (فقط‌خواندنی، روی کپی DB تولید ۱۴۰۵/۰۸/۱۲)

کپی: `db.backup()` فقط‌خواندنی از `/home/taranom/crm-taranom/server/crm.db` (۱۱٫۲ MB). هیچ نوشتنی روی تولید انجام نشد.

## قانون «ردیف زنده» کاردکس
`status='posted' AND reversed_of IS NULL AND event_type <> 'reversal' AND event_type NOT GLOB '*_reversal'`
(`LEDGER_LIVE_SQL` در `layer-reconcile.js`). جفت ابطال‌شده کامل حذف می‌شود.
هشدار: ردیف‌های برگشتی 2458–2467 وضعیت `posted` دارند ولی اصل‌شان (2040–2049) `reversed` است؛
جمع سادهٔ `status='posted'` برای انبار 34 عدد −9 می‌دهد (غلط).

## کالای 9 (K-00009) — همهٔ فرض‌ها تأیید شد
| منبع | 33 | 34 | 35 | جمع |
|---|---|---|---|---|
| کاردکس زنده | 1 | 1 | 8 | **10** |
| warehouse_stock | 1 | 11 | 8 | 20 |
| variant_warehouse_stock (Σ) | 1 | 11 | 8 | 20 |
| products.stock | | | | 20 |
| Σ inventory_movements | | | | 10 |

- ردیف‌های کاردکس انتقال 393–408 (انتقال‌های 177–184، 34→35): `variant_id = NULL`.
- حرکات 495–510 (`wh_transfer_out/in`, doc_id = 177–184): `variant_id` 194…203 دارند.
- ردیف‌های ورود 394…408 مبلغ صفر؛ خروج 395…407 هم صفر (فقط 393 مبلغ دارد).

## ممیزی همهٔ کالاها
- ۳۴۳ کالا؛ **۳۳ کالا** ناهمخوان (products.stock: 28، warehouse_stock: 23، variant_warehouse_stock: 25).
- **۱۷۶** ردیف زندهٔ `transfer_in` با مبلغ صفر؛ ۱۳۶ تا `transfer_in_revalue` دارند، **۴۰** ندارند و
  خروج جفت‌شان هم صفر است (`zero_zero` — API فعلی ردشان می‌کند).
- منفی‌های زنده: 103 (کد 7151) انبار 34: −5، 35: −1؛ 120 (کد 7142) انبار 34: −20؛ 122 انبار 35: −2؛ 153 انبار 35: −3.
- ردیف‌های زندهٔ بدون variant_id: opening 342، transfer_out/in 194+194، sale 140، transfer_in_revalue 136، …

## نوشتن مستقیم روی ارقام موجودی (lib/routes، پیش از این PR)
| فایل | جدول‌ها |
|---|---|
| lib/inventory/ledger.js (`applyStockDelta`, `ensureWhRow`) | products.stock، warehouse_stock |
| lib/inventory/movement.js (`postStockMovement`, `reconcileVariantWarehouseProjections`, seed) | هر چهار |
| lib/inventory/qty-policy.js | هر چهار |
| lib/opening-post.js | products.stock، warehouse_stock |
| lib/inventory/wh-data-correction.js | هر چهار |
| lib/inventory/ledger-assign-warehouse.js | products.stock، warehouse_stock |
| lib/inventory/ledger-reverse-correction.js | products.stock، warehouse_stock |
| lib/inventory/fabric-rolls.js | products.stock، warehouse_stock |
| lib/inventory/periodic-close.js | products.stock، warehouse_stock |
| lib/kardex-heal-v508.js، lib/restore-product-fields.js، lib/clean-slate.js، routes/data-wipe.js | products.stock، warehouse_stock |
| lib/void-invoice.js، lib/sales-return-doc.js، lib/sales-document.js، lib/consignments.js | products.stock، warehouse_stock |
| lib/product-quick.js، lib/product-variants/service.js | products.stock، product_variants.stock |
| routes/purchases.js، routes/production.js، routes/products.js، routes/invoices.js | products.stock، warehouse_stock |

## تصمیم‌های دستی (فاز ۲ خودکار انجام نمی‌دهد)
- INV-2347: افتتاحیهٔ کالای 9 واریانت 202 در انبار 33 ثبت شده ولی حرکت آن انبار 34 است.
- منفی‌های 7151 و 7142 (و 122، 153).
- جفت‌های انتقال با حساب موجودی متفاوت (نیاز به سند جابه‌جایی).
