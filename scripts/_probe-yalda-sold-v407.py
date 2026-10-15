#!/usr/bin/env python3
"""Who consumed Yalda (product 332) FG after PO-0008 receipt?"""
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
OUT = Path(r"D:\proje\erp-taranom1\_probe-yalda-sold-v407-out.json")

REMOTE = r'''
python3 <<'PY'
import sqlite3, json
db = sqlite3.connect("/home/taranom/crm-taranom/server/crm.db")
db.row_factory = sqlite3.Row
pid = 332
out = {}
out["product"] = dict(db.execute("SELECT id,name,stock FROM products WHERE id=?", (pid,)).fetchone())
out["ledger_cols"] = [x[1] for x in db.execute("PRAGMA table_info(inventory_ledger)").fetchall()]
cols = set(out["ledger_cols"])
sel = [c for c in ["id","event_type","source_type","source_id","qty_in","qty_out","note","created_at","status","doc_type","ref_type","ref_id"] if c in cols]
sel_sql = ", ".join(sel) if sel else "*"
out["ledger_out"] = [dict(r) for r in db.execute(f"""
  SELECT {sel_sql} FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted' AND COALESCE(qty_out,0)>0
  ORDER BY id DESC LIMIT 40
""", (pid,)).fetchall()]
out["ledger_in"] = [dict(r) for r in db.execute(f"""
  SELECT {sel_sql} FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted' AND COALESCE(qty_in,0)>0
  ORDER BY id DESC LIMIT 20
""", (pid,)).fetchall()]
# invoice lines for product
for tbl, join in [
  ("invoice_items", "invoices"),
  ("invoice_lines", "invoices"),
]:
  try:
    icols = [x[1] for x in db.execute(f"PRAGMA table_info({tbl})").fetchall()]
    out[f"{tbl}_cols"] = icols
    qty_col = "qty" if "qty" in icols else ("quantity" if "quantity" in icols else None)
    if not qty_col: continue
    out["invoice_lines"] = [dict(r) for r in db.execute(f"""
      SELECT il.id, il.invoice_id, i.num, i.status, i.date, il.{qty_col} AS qty, il.product_id
      FROM {tbl} il
      JOIN {join} i ON i.id=il.invoice_id
      WHERE il.product_id=? AND COALESCE(i.status,'') NOT IN ('voided','cancelled','draft')
      ORDER BY il.id DESC LIMIT 30
    """, (pid,)).fetchall()]
    break
  except Exception as e:
    out[f"{tbl}_err"] = str(e)
print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
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
    print("wrote", OUT, "len", len(text), "err", bool(err.strip()))
    c.close()

if __name__ == "__main__":
    main()
