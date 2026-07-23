#!/usr/bin/env python3
"""Wipe production crm.db (go-live clean + base COA rebuild) and verify."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
DB = f"{APP}/server/crm.db"


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out if len(out) < 5000 else out[-5000:])
    if err.strip():
        print("ERR", err[-500:])
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"ls -lah {DB} {APP}/server/data/crm.db 2>/dev/null | head -10")
    # Resolve actual DB_PATH from pm2 if set
    _, env_out = run(
        c,
        "pm2 env 0 2>/dev/null | grep DB_PATH | head -3; "
        f"test -f {DB} && echo HAS_SERVER_CRM || true; "
        f"test -f {APP}/server/data/crm.db && echo HAS_DATA_CRM || true",
    )
    db_path = DB
    if "HAS_DATA_CRM" in env_out and "HAS_SERVER_CRM" not in env_out:
        db_path = f"{APP}/server/data/crm.db"

    run(c, "pm2 stop erp-taranom")
    run(
        c,
        f"cd {APP} && DB_PATH={db_path} node server/scripts/go-live-clean.js --confirm=WIPE-ALL-FOR-GOLIVE",
        timeout=300,
    )
    run(c, "pm2 start erp-taranom --update-env || pm2 restart erp-taranom --update-env")
    run(
        c,
        "sleep 4 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health",
    )
    verify_js = r"""
const Database=require('better-sqlite3');
const db=new Database(process.env.DB_PATH);
const q=t=>{try{return db.prepare('SELECT COUNT(*) c FROM '+t).get().c}catch(e){return -1}};
const flags=db.prepare("SELECT key,value FROM settings WHERE key IN ('coa_mode','warehouses_user_cleared','product_categories_user_cleared')").all();
console.log(JSON.stringify({
  customers:q('customers'),parties:q('parties'),products:q('products'),
  invoices:q('invoices'),journal:q('journal_entries'),settlements:q('settlements'),
  warehouses:q('warehouses'),banks:q('banks'),cash:q('cash_boxes'),
  users:q('users'),coa:q('chart_of_accounts'),
  sync_tombstones:q('sync_tombstones'),sync_outbox:q('sync_outbox'),
  flags
},null,2));
"""
    sftp = c.open_sftp()
    with sftp.file("/tmp/_verify_golive.js", "w") as f:
        f.write(verify_js)
    sftp.close()
    run(
        c,
        f"cd {APP}/server && DB_PATH={db_path} node /tmp/_verify_golive.js",
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
