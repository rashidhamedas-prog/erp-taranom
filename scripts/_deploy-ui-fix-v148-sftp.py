#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Targeted SFTP deploy for UI fix pack (SW v148)."""
from __future__ import annotations

import sys
from pathlib import Path
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]

FILES = [
    "server/public/app.js",
    "server/public/acc-nav.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/public/app.css",
    "docs/CHANGE-LOG.md",
]


def run(c, cmd, timeout=120):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = (o.read() + e.read()).decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-3000:] if len(out) > 3000 else out)
    print("EXIT", code)
    return code


def main():
    missing = [f for f in FILES if not (ROOT / f).is_file()]
    if missing:
        raise SystemExit(f"missing: {missing}")
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    for rel in FILES:
        remote = f"{APP}/{rel}"
        print("PUT", rel)
        sftp.put(str(ROOT / rel), remote)
    sftp.close()
    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "sleep 4; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v148 {APP}/server/public/sw.js | head -1; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"grep -c listRows {APP}/server/public/app.js; "
        f"grep -c \"id: 'help'\" {APP}/server/public/acc-nav.js; "
        f"grep -c acc-product-colors {APP}/server/public/acc-nav.js; "
        f"grep -c keepOpen {APP}/server/public/app.js; "
        f"cd {APP} && echo SFTP_UI_FIX_V148=$(date -u +%Y-%m-%dT%H:%M:%SZ) > .sftp-deploy-stamp-ui-fix-v148 && cat .sftp-deploy-stamp-ui-fix-v148",
        timeout=60,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
