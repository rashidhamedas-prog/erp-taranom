#!/usr/bin/env python3
from pathlib import Path
import json, paramiko
KEY = next(p for p in (Path.home()/".ssh"/"id_ed25519_taranom", Path(r"D:\proje\.ssh\id_ed25519_taranom")) if p.is_file())
OUT = Path(r"D:\proje\erp-taranom1\_probe-wipe-blockers-v407-out.json")
REMOTE = r'''
python3 <<'PY'
import sqlite3, json
db=sqlite3.connect("/home/taranom/crm-taranom/server/crm.db")
db.row_factory=sqlite3.Row
out={}
out["bom8"]=dict(db.execute("SELECT * FROM bom_headers WHERE id=8").fetchone())
out["bom_same_ver"]= [dict(r) for r in db.execute(
  "SELECT id,code,version,revision,status,deleted_at FROM bom_headers WHERE product_id=332 AND version=23")]
out["bom_indexes"]= [dict(r) for r in db.execute("PRAGMA index_list('bom_headers')")]
for ix in out["bom_indexes"]:
  out[f"ix_{ix['name']}"]= [dict(r) for r in db.execute(f"PRAGMA index_info('{ix['name']}')")]
  try:
    out[f"ixsql_{ix['name']}"]= db.execute("SELECT sql FROM sqlite_master WHERE name=?", (ix['name'],)).fetchone()[0]
  except: pass
out["po8"]=dict(db.execute("SELECT id,order_no,status FROM production_orders WHERE id=8").fetchone())
stage_cols=[x[1] for x in db.execute("PRAGMA table_info(production_order_stages)").fetchall()]
out["stage_cols"]=stage_cols
out["stages"]= [dict(r) for r in db.execute(
  "SELECT * FROM production_order_stages WHERE order_id=8 ORDER BY seq")]
cols=[x[1] for x in db.execute("PRAGMA table_info(production_material_issues)").fetchall()]
out["issue_cols"]=cols
out["issues"]= [dict(r) for r in db.execute(
  "SELECT * FROM production_material_issues WHERE order_id=8 AND status='posted'")]
out["receipt"]= [dict(r) for r in db.execute(
  "SELECT * FROM production_receipts WHERE order_id=8")]
# stock for products in issues + 332
pids=set([332])
for r in out["issues"]:
  if r.get("product_id"): pids.add(r["product_id"])
out["stocks"]= [dict(r) for r in db.execute(
  f"SELECT id,name,stock FROM products WHERE id IN ({','.join(str(p) for p in pids)})")]
out["wh_stocks"]= [dict(r) for r in db.execute(
  f"SELECT * FROM warehouse_stock WHERE product_id IN ({','.join(str(p) for p in pids)})")]
# lay rolls status
out["lay_rolls"]= [dict(r) for r in db.execute(
  "SELECT id,lay_id,status,batch_id FROM cutting_lay_rolls WHERE lay_id IN (8,9,10,11)")]
print(json.dumps(out,ensure_ascii=False,indent=2,default=str))
db.close()
PY
'''
def main():
  c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
  c.connect("94.249.244.208",username="taranom",key_filename=str(KEY),timeout=30)
  _,o,e=c.exec_command(REMOTE,timeout=60)
  text=o.read().decode("utf-8","replace"); err=e.read().decode("utf-8","replace")
  OUT.write_text(text+("\nSTDERR\n"+err if err.strip() else ""),encoding="utf-8")
  print("wrote",OUT,"err",bool(err.strip()))
  c.close()
if __name__=="__main__":
  main()
