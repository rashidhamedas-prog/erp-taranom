# P8a — اجرای تجمعی (dry-run روی کپی، ROLLBACK)

منبع: crm.db — تاریخ اصلاح‌ها: 1405/08/11 — ترتیب: item1 → item2 → item4 → item3

## کاردکس در برابر دفتر کل (ریال)
| شاخص | before | after_item1 | after_item2 | after_item4 | after_item3 |
|---|---:|---:|---:|---:|---:|
| WH33 مواد اولیه ↔ GL 1110 | K 522,322,975<br>GL 1,933,299,574<br>Δ -1,410,976,599 | K 1,450,880,673<br>GL 1,933,299,574<br>Δ -482,418,901 | K 1,450,880,673<br>GL 1,933,299,574<br>Δ -482,418,901 | K 1,450,880,673<br>GL 1,933,299,574<br>Δ -482,418,901 | K 1,450,880,673<br>GL 1,933,299,574<br>Δ -482,418,901 |
| WH37 کار در جریان ↔ GL 1111 | K -2,797,379,484<br>GL 1,264,548,548<br>Δ -4,061,928,032 | K -2,797,379,484<br>GL 1,264,548,548<br>Δ -4,061,928,032 | K 0<br>GL 1,264,548,548<br>Δ -1,264,548,548 | K 0<br>GL 1,009,210,942<br>Δ -1,009,210,942 | K 0<br>GL 1,009,210,942<br>Δ -1,009,210,942 |
| WH34 انبار محصول ↔ GL 1104 | K 10,673,629,680<br>GL 13,011,907,142<br>Δ -2,338,277,462 | K 10,673,629,680<br>GL 13,011,907,142<br>Δ -2,338,277,462 | K 10,673,629,680<br>GL 13,011,907,142<br>Δ -2,338,277,462 | K 10,840,684,235<br>GL 13,178,961,697<br>Δ -2,338,277,462 | K 10,808,635,491<br>GL 13,146,912,953<br>Δ -2,338,277,462 |
| WH34+WH35 محصول ↔ GL 1104 (اطلاعی) | K 13,062,701,142<br>GL 13,011,907,142<br>Δ 50,794,000 | K 13,062,701,142<br>GL 13,011,907,142<br>Δ 50,794,000 | K 13,062,701,142<br>GL 13,011,907,142<br>Δ 50,794,000 | K 13,229,755,697<br>GL 13,178,961,697<br>Δ 50,794,000 | K 13,197,706,953<br>GL 13,146,912,953<br>Δ 50,794,000 |

## نتیجهٔ اقلام
```json
{
  "item1": {
    "result": {
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
    },
    "gl": [],
    "kardex": [
      {
        "warehouse_id": 33,
        "product_id": 333,
        "qty_before": -237.36,
        "qty_after": 18.91,
        "val_before": -860040017,
        "val_after": 68517681,
        "dq": 256.27,
        "dv": 928557698
      }
    ],
    "side": {
      "inventory_valuation_queue": 0,
      "inventory_value_approvals": 0,
      "stock_logs": 0
    }
  },
  "item2": {
    "result": {
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
          "new_ledger_id": 2399
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
          "new_ledger_id": 2401
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
          "new_ledger_id": 2403
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
          "new_ledger_id": 2405
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
          "new_ledger_id": 2407
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
          "new_ledger_id": 2409
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
          "new_ledger_id": 2411
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
          "new_ledger_id": 2413
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
          "new_ledger_id": 2415
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
          "new_ledger_id": 2417
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
          "new_ledger_id": 2419
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
    },
    "gl": [],
    "kardex": [
      {
        "warehouse_id": 37,
        "product_id": 332,
        "qty_before": 0,
        "qty_after": 0,
        "val_before": -1449190490,
        "val_after": 0,
        "dq": 0,
        "dv": 1449190490
      },
      {
        "warehouse_id": 37,
        "product_id": 334,
        "qty_before": 0,
        "qty_after": 0,
        "val_before": -1348188994,
        "val_after": 0,
        "dq": 0,
        "dv": 1348188994
      }
    ],
    "side": {
      "inventory_valuation_queue": 0,
      "inventory_value_approvals": 0,
      "stock_logs": 0
    }
  },
  "item4": {
    "result": {
      "je_found": [
        675,
        676,
        714
      ],
      "per_order": [
        {
          "order_id": 10,
          "order_no": "PO-0010",
          "order_status": "voided",
          "lays": 2,
          "journals": 2,
          "ledger_rows": 4
        },
        {
          "order_id": 12,
          "order_no": "PO-0012",
          "order_status": "voided",
          "lays": 1,
          "journals": 1,
          "ledger_rows": 1
        }
      ],
      "date": "1405/08/11"
    },
    "gl": [
      {
        "account_code": "1104",
        "before": 13011907142,
        "after": 13178961697,
        "delta": 167054555
      },
      {
        "account_code": "1111",
        "before": 1264548548,
        "after": 1009210942,
        "delta": -255337606
      },
      {
        "account_code": "5101",
        "before": 2777574725,
        "after": 2865857776,
        "delta": 88283051
      }
    ],
    "kardex": [
      {
        "warehouse_id": 34,
        "product_id": 332,
        "qty_before": 101,
        "qty_after": 101,
        "val_before": 892931439,
        "val_after": 996584996,
        "dq": 0,
        "dv": 103653557
      },
      {
        "warehouse_id": 34,
        "product_id": 334,
        "qty_before": 40,
        "qty_after": 40,
        "val_before": 228250234,
        "val_after": 291651232,
        "dq": 0,
        "dv": 63400998
      }
    ],
    "side": {
      "inventory_valuation_queue": 0,
      "inventory_value_approvals": 0,
      "stock_logs": 0
    }
  },
  "item3": {
    "result": {
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
    },
    "gl": [
      {
        "account_code": "1104",
        "before": 13178961697,
        "after": 13146912953,
        "delta": -32048744
      },
      {
        "account_code": "5101",
        "before": 2865857776,
        "after": 2897906520,
        "delta": 32048744
      }
    ],
    "kardex": [
      {
        "warehouse_id": 34,
        "product_id": 332,
        "qty_before": 101,
        "qty_after": 101,
        "val_before": 996584996,
        "val_after": 931123732,
        "dq": 0,
        "dv": -65461264
      },
      {
        "warehouse_id": 34,
        "product_id": 334,
        "qty_before": 40,
        "qty_after": 40,
        "val_before": 291651232,
        "val_after": 325063752,
        "dq": 0,
        "dv": 33412520
      }
    ],
    "side": {
      "inventory_valuation_queue": 2,
      "inventory_value_approvals": 0,
      "stock_logs": 0
    }
  }
}
```
