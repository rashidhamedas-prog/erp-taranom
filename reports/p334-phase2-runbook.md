# FR-P334 فاز ۲ — Runbook (فقط بعد از «GO deploy p334»)

> پیش‌نیاز: deploy شاخهٔ FR-P334 (A + B) + بکاپ crm.db+wal+shm + health 200.
> همهٔ گام‌ها از API رسمی با کاربر admin. هر عدد متفاوت ⇒ **⛔ STOP و گزارش**.

## شبیه‌سازی روی کپی DB زنده (۱۴۰۵/۰۸/۱۲، sandbox /tmp، حذف‌شده)
| مرحله | gap | کاردکس 34 | کاردکس 35 | ws 34/35 | رنگ‌سایز 34/35 | JE / پیش‌نویس |
|---|---|---|---|---|---|---|
| قبل | −114,038,063 | 41 (327,152,924) | 8 (165,582,632) | 49 / 8 | 49 / 8 | 1061 / 4 |
| بعد از ابطال 2003 | +51,544,569 | 41 | 0 | 49 / 0 | 49 / 0 | بدون تغییر |
| بعد از ابطال 1273 | **−15,135,373** | 48 (393,832,866) | 0 | 49 / 0 | 49 / 0 | بدون تغییر |
| بعد از انتقال | **−15,135,373** | **40** | **8** | **41 / 8** | 41 / 8 | بدون تغییر، JE1016 approved |

## گام ۰ — پیش‌نمایش (فقط‌خواندنی)
- `GET /api/inventory/ledger/2003/reverse-correction-preview?stock_effect=with_stock`
  باید: `eligible=true`، `variant_breakdown_required=true`، `variant_layer_in_warehouse` = واریانت‌های 616 تا 623 در انبار 35، هر کدام ۱ عدد، `voucher_draft=null`.
- `GET /api/inventory/ledger/1273/reverse-correction-preview?stock_effect=kardex_only`
  باید: `eligible=true`، کاردکس 41→48، ارزش 327,152,924→393,832,866.
- `GET /api/subledger-recon/...` یا گزارش gap ⇒ −114,038,063. هر انحراف ⇒ STOP.

## گام ۱ — ابطال 2003 (با اثر موجودی)
```json
POST /api/inventory/ledger/2003/reverse-correction
{ "confirm": true, "stock_effect": "with_stock",
  "reason": "افتتاحیهٔ تکراری ۸ عدد کیمیا (تکرار ledger#1468 باطل‌شده) — FR-P334",
  "variant_breakdown": [{"variant_id":616,"qty":1},{"variant_id":617,"qty":1},{"variant_id":618,"qty":1},{"variant_id":619,"qty":1},
                        {"variant_id":620,"qty":1},{"variant_id":621,"qty":1},{"variant_id":622,"qty":1},{"variant_id":623,"qty":1}] }
```
انتظار: 200، `warehouse_stock 8→0`، `voucher_draft_id=null`، gap = +51,544,569.

## گام ۲ — ابطال 1273 (فقط کاردکس)
```json
POST /api/inventory/ledger/1273/reverse-correction
{ "confirm": true, "stock_effect": "kardex_only",
  "reason": "خروج تکراری ۷ عدد؛ فروش T-0009 (ledger#1777) همان ۷ عدد را کم کرده — FR-P334" }
```
انتظار: 200، ws34 همان 49، کاردکس 34 = 48، gap = **−15,135,373**.

## گام ۳ — انتقال رسمی 34→35 (یک سند، ۸ خط واریانت)
```json
POST /api/warehouses/moves/docs
{ "type": "transfer", "from_warehouse_id": 34, "to_warehouse_id": 35, "note": "انتقال رسمی ۸ عدد به کیمیا (FR-P334)",
  "lines": [{"product_id":334,"variant_id":616,"qty":1},{"product_id":334,"variant_id":617,"qty":1},{"product_id":334,"variant_id":618,"qty":1},
            {"product_id":334,"variant_id":619,"qty":1},{"product_id":334,"variant_id":620,"qty":1},{"product_id":334,"variant_id":621,"qty":1},
            {"product_id":334,"variant_id":622,"qty":1},{"product_id":334,"variant_id":623,"qty":1}] }
```
انتظار: 200، بدون JE (هر دو انبار روی 1104)، کاردکس 34=40 / 35=8، ws 41/8، رنگ‌سایز 41/8، gap همان −15,135,373.

## گام ۴ — بررسی نهایی
- `GET /api/inventory/stock-kardex-mismatch?product_id=334` ⇒ فقط wh34: ws 41 در برابر کاردکس 40 (اختلاف ۱، فقط گزارش).
- تعداد JE و voucher_drafts بدون تغییر (به‌جز پیش‌نویس‌های مهاجرت v3/v4 که در deploy ساخته/اصلاح می‌شوند)؛ JE1016 = approved.

## نکتهٔ ارزش‌گذاری (گزارش، نه STOP)
انتقال با بهای سطح کالا انجام می‌شود که الان **20,697,829** است، یعنی میانگین آلوده‌شده به‌دلیل WIP 37 (گزارش جدا: `reports/p334-wip37-analysis.md`). پس ارزش کاردکس 35 = 165,582,632 و کاردکس 34 = 228,250,234 می‌شود. جمع 34+35 و gap تغییری نمی‌کند. اصلاح بهای واحد تصمیم جداگانه است.
