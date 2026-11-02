# item2 — WH37 (کار در جریان) — بازقیمت‌گذاری خروج بسته‌ها با مبلغ متناسب بسته (منطق P1)

## اثر دفتر کل (ریال، بدهکار−بستانکار)
| حساب | قبل | بعد | تغییر |
|---|---:|---:|---:|
| — | | | بدون اثر GL |

## اثر کاردکس زنده به تفکیک انبار
| انبار | تغییر مقدار | تغییر ارزش (ریال) |
|---|---:|---:|
| 37 | 0 | 2,797,379,484 |

## به تفکیک انبار×کالا
| انبار | کالا | مقدار قبل→بعد | ارزش قبل→بعد |
|---|---|---|---|
| 37 | 332 | 0 → 0 | -1,449,190,490 → 0 |
| 37 | 334 | 0 → 0 | -1,348,188,994 → 0 |

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
  "lines": [
    {
      "ledger_id": 1456,
      "pack_no": "PK-0015",
      "order_no": "PO-0014",
      "product_id": 332,
      "qty": 30,
      "old_amount": 458536530,
      "new_amount": 156912519,
      "delta": -301624011,
      "new_ledger_id": 2389
    },
    {
      "ledger_id": 1457,
      "pack_no": "PK-0017",
      "order_no": "PO-0014",
      "product_id": 332,
      "qty": 22,
      "old_amount": 336260122,
      "new_amount": 115069181,
      "delta": -221190941,
      "new_ledger_id": 2391
    },
    {
      "ledger_id": 1458,
      "pack_no": "PK-0019",
      "order_no": "PO-0014",
      "product_id": 332,
      "qty": 22,
      "old_amount": 336260122,
      "new_amount": 115069181,
      "delta": -221190941,
      "new_ledger_id": 2393
    },
    {
      "ledger_id": 1459,
      "pack_no": "PK-0021",
      "order_no": "PO-0014",
      "product_id": 332,
      "qty": 22,
      "old_amount": 336260122,
      "new_amount": 115069181,
      "delta": -221190941,
      "new_ledger_id": 2395
    },
    {
      "ledger_id": 1460,
      "pack_no": "PK-0016",
      "order_no": "PO-0014",
      "product_id": 334,
      "qty": 30,
      "old_amount": 620934870,
      "new_amount": 199625810,
      "delta": -421309060,
      "new_ledger_id": 2397
    },
    {
      "ledger_id": 1461,
      "pack_no": "PK-0018",
      "order_no": "PO-0014",
      "product_id": 334,
      "qty": 22,
      "old_amount": 455352238,
      "new_amount": 146392260,
      "delta": -308959978,
      "new_ledger_id": 2399
    },
    {
      "ledger_id": 1462,
      "pack_no": "PK-0020",
      "order_no": "PO-0014",
      "product_id": 334,
      "qty": 22,
      "old_amount": 455352238,
      "new_amount": 146392260,
      "delta": -308959978,
      "new_ledger_id": 2401
    },
    {
      "ledger_id": 1463,
      "pack_no": "PK-0022",
      "order_no": "PO-0014",
      "product_id": 334,
      "qty": 22,
      "old_amount": 455352238,
      "new_amount": 146392260,
      "delta": -308959978,
      "new_ledger_id": 2403
    },
    {
      "ledger_id": 1479,
      "pack_no": "PK-0023",
      "order_no": "PO-0015",
      "product_id": 332,
      "qty": 32,
      "old_amount": 395316320,
      "new_amount": 168581757,
      "delta": -226734563,
      "new_ledger_id": 2405
    },
    {
      "ledger_id": 1480,
      "pack_no": "PK-0024",
      "order_no": "PO-0015",
      "product_id": 332,
      "qty": 24,
      "old_amount": 296487240,
      "new_amount": 126490669,
      "delta": -169996571,
      "new_ledger_id": 2407
    },
    {
      "ledger_id": 1481,
      "pack_no": "PK-0025",
      "order_no": "PO-0015",
      "product_id": 332,
      "qty": 12,
      "old_amount": 148243620,
      "new_amount": 60981098,
      "delta": -87262522,
      "new_ledger_id": 2409
    }
  ],
  "per_order": [
    {
      "order_id": 14,
      "order_no": "PO-0014",
      "wip_qty_after": 0,
      "wip_value_after": 0
    },
    {
      "order_id": 15,
      "order_no": "PO-0015",
      "wip_qty_after": 0,
      "wip_value_after": 0
    }
  ],
  "wip_bucket_fix": [
    {
      "product_id": 332,
      "qty": 0,
      "value_rial": 0
    },
    {
      "product_id": 334,
      "qty": 0,
      "value_rial": 0
    }
  ],
  "total_delta": -2797379484,
  "counterpart": {
    "exit_rows_have_je": false,
    "note": "ردیف‌های خروج WH37 فقط-کاردکس (warehouseOnly، بدون JE و بدون اثر روی میانگین سرفصل) بودند؛ GL 1111 هنگام رسید به اندازهٔ مبلغ رسید بستانکار شده و ورود FG در WH34 هم به مبلغ رسید است. پس مازاد خروج به هیچ حساب/کاردکس دیگری نرفته و اصلاح فقط-کاردکس WH37 است.",
    "receipts": [
      {
        "id": 11,
        "doc_no": "PR-0011",
        "order_id": 14,
        "product_id": 332,
        "qty": 96,
        "amount_rial": 993495799,
        "je_id": 754
      },
      {
        "id": 12,
        "doc_no": "PR-0012",
        "order_id": 14,
        "product_id": 334,
        "qty": 96,
        "amount_rial": 993495799,
        "je_id": 755
      },
      {
        "id": 13,
        "doc_no": "PR-0013",
        "order_id": 15,
        "product_id": 332,
        "qty": 68,
        "amount_rial": 645538185,
        "je_id": 779
      }
    ]
  }
}
```
