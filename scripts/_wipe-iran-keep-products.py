#!/usr/bin/env python3
"""Run keep-products-clean.js on Iran production and verify."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
LOCAL_SCRIPT = Path(__file__).resolve().parents[1] / "server" / "scripts" / "keep-products-clean.js"
REMOTE_SCRIPT = f"{APP}/server/scripts/keep-products-clean.js"
DB = f"{APP}/server/crm.db"


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out if len(out) < 8000 else out[-8000:])
    if err.strip():
        print("ERR", err[-500:])
    print("EXIT", code)
    return code, out


def main() -> None:
    if not LOCAL_SCRIPT.exists():
        print("Missing", LOCAL_SCRIPT)
        sys.exit(1)

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    sftp = c.open_sftp()
    sftp.put(str(LOCAL_SCRIPT), REMOTE_SCRIPT)
    sftp.close()
    print("Uploaded", REMOTE_SCRIPT)

    run(c, f"ls -lah {DB}")
    run(c, "pm2 stop erp-taranom")
    code, _ = run(
        c,
        f"cd {APP} && DB_PATH={DB} node server/scripts/keep-products-clean.js --confirm=WIPE-KEEP-PRODUCTS",
        timeout=300,
    )
    if code != 0:
        print("WIPE FAILED — restarting pm2 anyway")
        run(c, "pm2 start erp-taranom --update-env || pm2 restart erp-taranom --update-env")
        c.close()
        sys.exit(code)

    # Remove non-product upload clutter; keep product image files referenced by DB
    cleanup = r"""
const Database=require('better-sqlite3');
const fs=require('fs');
const path=require('path');
const db=new Database(process.env.DB_PATH);
const keep=new Set();
try{
  for(const r of db.prepare('SELECT filename FROM product_images').all()) if(r.filename) keep.add(r.filename);
}catch(_){}
try{
  for(const r of db.prepare("SELECT image FROM products WHERE image IS NOT NULL AND image<>''").all()) keep.add(r.image);
}catch(_){}
try{
  for(const r of db.prepare("SELECT images_json FROM products WHERE images_json IS NOT NULL AND images_json<>''").all()){
    try{ JSON.parse(r.images_json).forEach(f=>keep.add(f)); }catch(_){}
  }
}catch(_){}
const roots=[
  path.join(__dirname,'public','uploads'),
  path.join(__dirname,'uploads'),
].filter(p=>fs.existsSync(p));
let removed=0,kept=0;
function walk(dir){
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,ent.name);
    if(ent.isDirectory()){ walk(p); continue; }
    const base=ent.name;
    const underProducts = p.replace(/\\/g,'/').includes('/products/');
    if(underProducts && keep.has(base)){ kept++; continue; }
    if(underProducts && keep.size && !keep.has(base)){
      // orphan under products — keep if any product ref uncertain; only remove non-product dirs
      kept++; continue;
    }
    if(!underProducts){
      try{ fs.unlinkSync(p); removed++; }catch(_){}
    } else { kept++; }
  }
}
for(const r of roots) walk(r);
console.log(JSON.stringify({upload_roots:roots,kept_product_files:kept,removed_non_product:removed,db_image_refs:keep.size}));
db.close();
"""
    sftp = c.open_sftp()
    with sftp.file("/tmp/_clean_uploads.js", "w") as f:
        f.write(cleanup)
    sftp.close()
    run(c, f"cd {APP}/server && cp /tmp/_clean_uploads.js ./_clean_uploads.js && DB_PATH={DB} node ./_clean_uploads.js; rm -f ./_clean_uploads.js")

    run(c, "pm2 start erp-taranom --update-env || pm2 restart erp-taranom --update-env")
    run(
        c,
        "sleep 4 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health",
    )

    verify = r"""
const Database=require('better-sqlite3');
const db=new Database(process.env.DB_PATH);
const q=t=>{try{return db.prepare('SELECT COUNT(*) c FROM '+t).get().c}catch(e){return -1}};
const ledger=(()=>{try{return db.prepare('SELECT COALESCE(SUM(debit-credit),0) n FROM customer_ledger').get().n}catch(e){return null}})();
console.log(JSON.stringify({
  products:q('products'), product_images:q('product_images'), product_categories:q('product_categories'),
  warehouse_stock:q('warehouse_stock'), warehouses:q('warehouses'),
  customers:q('customers'), parties:q('parties'), persons:q('persons'),
  invoices:q('invoices'), settlements:q('settlements'),
  journal_entries:q('journal_entries'), customer_ledger:q('customer_ledger'), ledger_net:ledger,
  banks:q('banks'), cash_boxes:q('cash_boxes'), messages:q('messages'),
  users:db.prepare('SELECT id,username,role FROM users').all(),
  coa:q('chart_of_accounts'), sync_tombstones:q('sync_tombstones'),
},null,2));
"""
    sftp = c.open_sftp()
    with sftp.file("/tmp/_verify_keep.js", "w") as f:
        f.write(verify)
    sftp.close()
    run(c, f"cd {APP}/server && cp /tmp/_verify_keep.js ./_verify_keep.js && DB_PATH={DB} node ./_verify_keep.js; rm -f ./_verify_keep.js")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
