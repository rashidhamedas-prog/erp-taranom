# item3 — PO-0014 — اصلاح تسهیم بهای رسیدهای PR-0011 (332) و PR-0012 (334) طبق P2

## اثر دفتر کل (ریال، بدهکار−بستانکار)
| حساب | قبل | بعد | تغییر |
|---|---:|---:|---:|
| 1104 | 13,011,907,142 | 12,979,858,398 | -32,048,744 |
| 5101 | 2,777,574,725 | 2,809,623,469 | 32,048,744 |

## اثر کاردکس زنده به تفکیک انبار
| انبار | تغییر مقدار | تغییر ارزش (ریال) |
|---|---:|---:|
| 34 | 0 | -32,048,744 |

## به تفکیک انبار×کالا
| انبار | کالا | مقدار قبل→بعد | ارزش قبل→بعد |
|---|---|---|---|
| 34 | 332 | 101 → 101 | 892,931,439 → 827,470,175 |
| 34 | 334 | 40 → 40 | 228,250,234 → 261,662,754 |

## ردیف‌های جانبی جدید
- inventory_valuation_queue: 2
- inventory_value_approvals: 0
- stock_logs: 0

## جزئیات اجرا
```json
{
  "mode": "dry-run",
  "audit_id": null,
  "source_db": "crm.db",
  "order_no": "PO-0014",
  "total": 1986991598,
  "fabric_source": "shared_cut_alloc",
  "fabric_alloc_rial": 1140922652,
  "pool_rial": 256628946,
  "mismatch": [],
  "lines": [
    {
      "receipt_id": 11,
      "doc_no": "PR-0011",
      "product_id": 332,
      "qty": 96,
      "old_amount": 993495799,
      "new_amount": 928034535,
      "share": -65461264,
      "old_unit": 10348915,
      "new_unit": 9667026,
      "split_row": {
        "product_id": 332,
        "pct": 50,
        "fabric_rial": 502120062,
        "exclusive_rial": 297600000,
        "shared_rial": 128314473,
        "amount_rial": 928034535
      }
    },
    {
      "receipt_id": 12,
      "doc_no": "PR-0012",
      "product_id": 334,
      "qty": 96,
      "old_amount": 993495799,
      "new_amount": 1058957063,
      "share": 65461264,
      "old_unit": 10348915,
      "new_unit": 11030803,
      "split_row": {
        "product_id": 334,
        "pct": 50,
        "fabric_rial": 638802590,
        "exclusive_rial": 291840000,
        "shared_rial": 128314473,
        "amount_rial": 1058957063
      }
    }
  ],
  "date": "1405/07/05",
  "on_hand_before": {
    "332": 120,
    "334": 49
  },
  "je_lines_toman": [
    {
      "code": "1104",
      "name": "موجودی کالا",
      "debit": 0,
      "credit": 3204874.4000000004,
      "description": "اصلاح تسهیم بهای رسید PO-0014 بین محصولات (P2) — P8a"
    },
    {
      "code": "5101",
      "name": "بهای تمام‌شده کالای فروش رفته",
      "debit": 3204874.4,
      "credit": 0,
      "description": "اصلاح تسهیم بهای رسید PO-0014 بین محصولات (P2) — P8a"
    }
  ],
  "sold_cogs_rial": 32048744,
  "je_id": 1202
}
```
