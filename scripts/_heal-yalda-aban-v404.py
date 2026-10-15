#!/usr/bin/env python3
"""
Heal v404:
- Yalda LAY-0008..0011 → link to PO-0008 (qty 164 matches closed FG receipt)
- Aban PO-0009: keep FG (unsold physical stock); stamp legacy note (no reverse)
"""
from __future__ import annotations
from pathlib import Path
import json
import paramiko

KEY = next(
    p
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    )
    if p.is_file()
)
OUT = Path(r"D:\proje\erp-taranom1\_heal-yalda-aban-v404-out.json")

REMOTE = r'''
python3 <<'PY'
import sqlite3, json, time
db = sqlite3.connect("/home/taranom/crm-taranom/server/crm.db")
db.row_factory = sqlite3.Row
out = {"ok": True, "actions": []}

# --- Yalda: link lays 8-11 to PO-0008 ---
po8 = db.execute("SELECT id,order_no,status,qty_produced FROM production_orders WHERE order_no='PO-0008'").fetchone()
if not po8:
  out["ok"] = False
  out["actions"].append({"error": "PO-0008 missing"})
else:
  lays = db.execute("""
    SELECT id, lay_no, qty_pieces, production_order_id, status
    FROM cutting_lays WHERE id IN (8,9,10,11) ORDER BY id
  """).fetchall()
  total = sum(int(r["qty_pieces"] or 0) for r in lays)
  rec = db.execute("""
    SELECT COALESCE(SUM(qty),0) s FROM production_receipts
    WHERE order_id=? AND status='posted'
  """, (po8["id"],)).fetchone()["s"]
  out["yalda_before"] = {
    "po": dict(po8),
    "lays": [dict(r) for r in lays],
    "lay_qty": total,
    "receipt_qty": float(rec or 0),
  }
  if abs(total - float(rec or 0)) > 0.01 and abs(total - float(po8["qty_produced"] or 0)) > 0.01:
    out["actions"].append({"warn": "lay qty != receipt", "lay": total, "rec": float(rec or 0)})
  n = db.execute("""
    UPDATE cutting_lays
    SET production_order_id=?
    WHERE id IN (8,9,10,11)
      AND COALESCE(status,'posted')<>'reversed'
      AND (production_order_id IS NULL OR production_order_id=0 OR production_order_id!=?)
  """, (po8["id"], po8["id"])).rowcount
  out["actions"].append({"link_lays_to_po8": n})

# --- Aban: stamp legacy note; do not reverse unsold FG ---
po9 = db.execute("SELECT id,order_no,status,qty_produced,note FROM production_orders WHERE order_no='PO-0009'").fetchone()
sold = db.execute("""
  SELECT COALESCE(SUM(qty_out),0) s FROM inventory_ledger
  WHERE product_id=334 AND status='posted' AND COALESCE(qty_out,0)>0
    AND COALESCE(event_type,'') NOT IN ('reversal','production_receipt_reversal')
""").fetchone()["s"]
stock = db.execute("SELECT stock FROM products WHERE id=334").fetchone()
lays9 = db.execute("""
  SELECT COUNT(*) c FROM cutting_lays
  WHERE production_order_id=9 AND COALESCE(status,'posted')<>'reversed'
""").fetchone()["c"]
rec9 = db.execute("""
  SELECT id,doc_no,qty,status,is_partial FROM production_receipts WHERE order_id=9
""").fetchall()
out["aban_before"] = {
  "po": dict(po9) if po9 else None,
  "sold_qty_out": float(sold or 0),
  "stock": dict(stock) if stock else None,
  "lays_linked": lays9,
  "receipts": [dict(r) for r in rec9],
}
if po9:
  tag = "[v404-legacy] رسید FG بدون لایه‌چینی/PACK — موجودی فیزیکی حفظ شد؛ مسیر آینده فقط lay→PACK→رسید"
  note = (po9["note"] or "").strip()
  if "v404-legacy" not in note:
    new_note = (note + "\n" + tag).strip() if note else tag
    db.execute(
      "UPDATE production_orders SET note=?, updated_at=strftime('%s','now') WHERE id=?",
      (new_note, po9["id"]),
    )
    out["actions"].append({"aban_note": True, "status": po9["status"]})
  else:
    out["actions"].append({"aban_note": "already"})
  if float(sold or 0) > 0.01:
    out["actions"].append({"aban_skip_reverse": "has_sales", "sold": float(sold)})
  else:
    out["actions"].append({
      "aban_keep_fg": True,
      "reason": "unsold physical stock; reversing would erase real FG without recreating cutting trail",
    })

db.commit()

# after
out["yalda_after"] = [dict(r) for r in db.execute("""
  SELECT id,lay_no,qty_pieces,production_order_id,status FROM cutting_lays WHERE id IN (8,9,10,11)
""").fetchall()]
out["aban_after"] = dict(db.execute("SELECT id,order_no,status,note FROM production_orders WHERE order_no='PO-0009'").fetchone() or {})
print(json.dumps(out, ensure_ascii=False, indent=2))
db.close()
PY
'''

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    _, o, e = c.exec_command(REMOTE, timeout=60)
    text = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    OUT.write_text(text + ("\nSTDERR\n" + err if err.strip() else ""), encoding="utf-8")
    print(text)
    if err.strip():
        print("STDERR", err[:2000])
    c.close()

if __name__ == "__main__":
    main()
