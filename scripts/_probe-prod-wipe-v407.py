#!/usr/bin/env python3
"""Dry-run: count BOM / PO / LAY + related docs + FG-sold blockers on Iran crm.db."""
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
OUT = Path(r"D:\proje\erp-taranom1\_probe-prod-wipe-v407-out.json")

REMOTE = r'''
python3 <<'PY'
import sqlite3, json
db = sqlite3.connect("/home/taranom/crm-taranom/server/crm.db")
db.row_factory = sqlite3.Row

def q(sql, *a):
  return [dict(r) for r in db.execute(sql, a).fetchall()]

def one(sql, *a):
  r = db.execute(sql, a).fetchone()
  return dict(r) if r else None

out = {"ok": True}

out["boms"] = q("""
  SELECT id, code, name, product_id, version, status, deleted_at
  FROM bom_headers ORDER BY id
""")
out["bom_counts"] = one("""
  SELECT
    COUNT(*) total,
    SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) visible,
    SUM(CASE WHEN status='active' AND deleted_at IS NULL THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN status='draft' AND deleted_at IS NULL THEN 1 ELSE 0 END) draft,
    SUM(CASE WHEN status='archived' AND deleted_at IS NULL THEN 1 ELSE 0 END) archived
  FROM bom_headers
""")

out["orders"] = q("""
  SELECT id, order_no, product_id, bom_id, status, analysis_type,
         qty_planned, qty_produced, closed_at
  FROM production_orders ORDER BY id
""")
out["order_status"] = q("""
  SELECT status, COUNT(*) c FROM production_orders GROUP BY status ORDER BY c DESC
""")

out["lays"] = q("""
  SELECT id, lay_no, product_id, production_order_id, status, qty_pieces, journal_id
  FROM cutting_lays ORDER BY id
""")
out["packs"] = q("""
  SELECT id, pack_no, lay_id, status, journal_id, ledger_id
  FROM cutting_packs ORDER BY id
""")

out["receipts_posted"] = q("""
  SELECT r.id, r.order_id, o.order_no, r.doc_no, r.product_id, r.qty, r.status,
         r.prev_stock_qty, p.stock AS product_stock,
         (COALESCE(r.prev_stock_qty,0)+COALESCE(r.qty,0)) - COALESCE(p.stock,0) AS sold_est
  FROM production_receipts r
  JOIN production_orders o ON o.id=r.order_id
  LEFT JOIN products p ON p.id=r.product_id
  WHERE r.status='posted'
  ORDER BY r.id
""")

out["issues_posted"] = one("""
  SELECT COUNT(*) c FROM production_material_issues WHERE status='posted'
""")
out["stages_done"] = one("""
  SELECT COUNT(*) c FROM production_order_stages WHERE status='done'
""")

# FG sold via inventory ledger (outbound sales-like)
out["fg_outbound"] = q("""
  SELECT r.order_id, o.order_no, r.product_id, p.name AS product_name,
         SUM(r.qty) AS receipt_qty,
         COALESCE((
           SELECT SUM(il.qty_out) FROM inventory_ledger il
           WHERE il.product_id=r.product_id AND il.status='posted'
             AND COALESCE(il.qty_out,0)>0
             AND COALESCE(il.event_type,'') NOT IN (
               'reversal','production_receipt_reversal','production_issue'
             )
         ),0) AS qty_out_other,
         p.stock
  FROM production_receipts r
  JOIN production_orders o ON o.id=r.order_id
  LEFT JOIN products p ON p.id=r.product_id
  WHERE r.status='posted'
  GROUP BY r.order_id, r.product_id
""")

# Related JE refs
out["je_refs"] = q("""
  SELECT ref_type, COUNT(*) c FROM journal_entries
  WHERE ref_type IN (
    'production_receipt','production_issue','production_scrap','production_waste',
    'production_labor','production_overhead','cutting_lay','cutting_pack',
    'production_receipt_reversal'
  )
  AND COALESCE(status,'posted') NOT IN ('voided','reversed')
  GROUP BY ref_type
""")

# warehouse docs linked?
try:
  out["wh_docs_prod"] = q("""
    SELECT id, doc_no, doc_type, status, ref_type, ref_id
    FROM warehouse_docs
    WHERE ref_type LIKE '%production%' OR ref_type LIKE '%cutting%'
       OR note LIKE '%PO-%' OR note LIKE '%LAY-%'
    LIMIT 50
  """)
except Exception as e:
  out["wh_docs_prod"] = str(e)

out["tables"] = {}
for t in [
  'bom_headers','bom_lines','bom_operations','bom_outputs','bom_change_log',
  'production_orders','production_receipts','production_material_issues',
  'production_order_stages','production_reservations','production_waste',
  'production_labor_entries','production_overhead_applications',
  'cutting_lays','cutting_lay_rolls','cutting_packs','cutting_pack_bundles',
]:
  try:
    out["tables"][t] = db.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]
  except Exception:
    out["tables"][t] = None

print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
db.close()
PY
'''

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    _, o, e = c.exec_command(REMOTE, timeout=90)
    text = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    OUT.write_text(text + ("\nSTDERR\n" + err if err.strip() else ""), encoding="utf-8")
    print(text[:8000] if len(text) > 8000 else text)
    if err.strip():
        print("STDERR", err[:2000])
    c.close()

if __name__ == "__main__":
    main()
