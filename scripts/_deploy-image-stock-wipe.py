#!/usr/bin/env python3
"""Deploy product image stock-wipe fix to Iran and run restore."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
BRANCH = "claude/claude-md-docs-2ssrpy"


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

    run(c, f"cd {APP} && git status -sb")
    run(c, f"cd {APP} && git stash push -u -m 'pre-deploy-image-stock-wipe' || true")
    run(c, f"cd {APP} && git fetch origin {BRANCH} && git checkout {BRANCH} && git pull --ff-only origin {BRANCH}")
    run(c, f"cd {APP} && git rev-parse --short HEAD && git log -3 --oneline")
    run(c, f"cd {APP}/server && npm install --omit=dev", timeout=600)
    # Clear one-shot flag if a previous partial run set it without restoring
    run(
        c,
        "cd {app}/server && node -e \"const {{getDB,initDB}}=require('./db'); initDB(); "
        "const db=getDB(); const r=db.prepare(\\\"SELECT value FROM settings WHERE key='restore_product_stock_after_image_wipe_v1'\\\").get(); "
        "console.log('flag', r&&r.value);\"".format(app=APP),
        timeout=120,
    )
    run(c, "pm2 restart erp-taranom --update-env")
    time.sleep(6)
    run(c, "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, f"cd {APP} && grep -n \"erp-taranom-v122\" server/public/sw.js | head -2")
    run(
        c,
        f"cd {APP}/server && node -e \""
        "const {{getDB}}=require('./db'); const db=getDB();"
        "const z=db.prepare('SELECT COUNT(*) c FROM products WHERE COALESCE(stock,0)=0').get().c;"
        "const wh=db.prepare('SELECT COUNT(*) c FROM products p WHERE COALESCE(p.stock,0)=0 AND EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND COALESCE(ws.qty,0)>0)').get().c;"
        "const tot=db.prepare('SELECT COUNT(*) c, COALESCE(SUM(stock),0) s FROM products').get();"
        "console.log(JSON.stringify({{zeroStock:z, zeroButWh:wh, products:tot.c, sumStock:tot.s}}));"
        "\"",
        timeout=60,
    )
    # If flag already 1 but warehouse still has orphans, force re-run script
    run(
        c,
        f"cd {APP}/server && node scripts/restore-product-stock-after-image-wipe.js",
        timeout=120,
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
