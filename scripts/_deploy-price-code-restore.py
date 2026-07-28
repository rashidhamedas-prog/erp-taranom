#!/usr/bin/env python3
"""SFTP deploy price/code restore fix (e552a78+) — server cannot reach GitHub."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER = "94.249.244.208", "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "server/lib/restore-product-fields.js",
    "server/db.js",
    "server/routes/admin.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-product-image-stock-wipe.js",
    "docs/CHANGE-LOG.md",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print((out or "")[-5000:])
    if err.strip():
        print("ERR", err[-800:])
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    sftp = c.open_sftp()
    for rel in FILES:
        local, remote = ROOT / rel, f"{APP}/{rel}"
        print(" put", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()

    run(c, f"cd {APP} && head -2 server/public/sw.js && grep -n restore_product_stock_after_image_wipe_v2 server/db.js | head -3")
    run(c, "pm2 restart erp-taranom --update-env")
    time.sleep(8)
    run(c, "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, "curl -sS http://127.0.0.1:3000/sw.js | head -2")
    run(c, "pm2 logs erp-taranom --lines 80 --nostream | grep -E 'restore_product_stock_after_image_wipe_v|error|Error' | tail -20")
    # Verify counts after migration
    run(
        c,
        f"cd {APP}/server && node -e \""
        "const Database=require('better-sqlite3');"
        "const db=new Database('crm.db',{readonly:true});"
        "const zeroPrice=db.prepare('SELECT COUNT(*) c FROM products WHERE COALESCE(price,0)=0').get().c;"
        "const emptyCode=db.prepare(\\\"SELECT COUNT(*) c FROM products WHERE TRIM(COALESCE(code,''))=\\\\\\\"\\\\\\\"\\\").get().c;"
        "const flag=db.prepare(\\\"SELECT value FROM settings WHERE key='restore_product_stock_after_image_wipe_v2'\\\").get();"
        "console.log(JSON.stringify({zeroPrice,emptyCode,flag}));"
        "\"",
        timeout=60,
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
