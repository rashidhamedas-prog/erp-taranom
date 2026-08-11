#!/usr/bin/env python3
"""Upload + run rebuild-product-docs.js on Iran (pm2 stop/start)."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
LOCAL = Path(__file__).resolve().parents[1] / "server" / "scripts" / "rebuild-product-docs.js"
REMOTE = f"{APP}/server/scripts/rebuild-product-docs.js"
DB = f"{APP}/server/crm.db"


def run(c, cmd, timeout=600):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out if len(out) < 12000 else out[-12000:])
    if err.strip():
        print("ERR", err[-600:])
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    sftp = c.open_sftp()
    sftp.put(str(LOCAL), REMOTE)
    sftp.close()
    print("Uploaded", REMOTE)

    run(c, "pm2 stop erp-taranom")
    code, _ = run(
        c,
        f"cd {APP} && DB_PATH={DB} node server/scripts/rebuild-product-docs.js --confirm=REBUILD-PRODUCT-DOCS",
        timeout=600,
    )
    run(c, "pm2 start erp-taranom --update-env || pm2 restart erp-taranom --update-env")
    run(c, "sleep 3 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    c.close()
    if code != 0:
        sys.exit(code)
    print("DONE")


if __name__ == "__main__":
    main()
