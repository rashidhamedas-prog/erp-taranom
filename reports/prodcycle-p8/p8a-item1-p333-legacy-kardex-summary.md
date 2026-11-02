# item1 — کالای 333 (پارچه مموری لایکو دوزی، WH33) — ابطال ۳ افتتاحیه + ۷ هم‌ترازی بی‌سند

## اثر دفتر کل (ریال، بدهکار−بستانکار)
| حساب | قبل | بعد | تغییر |
|---|---:|---:|---:|
| — | | | بدون اثر GL |

## اثر کاردکس زنده به تفکیک انبار
| انبار | تغییر مقدار | تغییر ارزش (ریال) |
|---|---:|---:|
| 33 | 256.27 | 928,557,698 |

## به تفکیک انبار×کالا
| انبار | کالا | مقدار قبل→بعد | ارزش قبل→بعد |
|---|---|---|---|
| 33 | 333 | -237.36 → 18.91 | -860,040,017 → 68,517,681 |

## ردیف‌های جانبی جدید
- inventory_valuation_queue: 0
- inventory_value_approvals: 0
- stock_logs: 0

## جزئیات اجرا
```json
{
  "mode": "dry-run",
  "audit_id": null,
  "source_db": "crm.db",
  "rows_voided": 10,
  "opening_qty_in": 1531.134,
  "reconcile_qty_out": 1787.404,
  "live_before": {
    "qty": -237.36,
    "val": -860040017
  },
  "live_after": {
    "qty": 18.91,
    "val": 68517681
  },
  "warehouse_stock": 18.91,
  "header_stock": 18.91,
  "header_avg": 3623357,
  "bucket_after_reversals": {
    "qty": 258.35,
    "value_rial": 936094281
  },
  "bucket_after": {
    "qty": 18.91,
    "value": 68517681,
    "avg": 3623357
  },
  "opening_stock_id": 333,
  "opening_stock_status": "void"
}
```
