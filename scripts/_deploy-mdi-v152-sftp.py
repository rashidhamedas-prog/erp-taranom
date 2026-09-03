#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SFTP overlay: MDI Chrome taskbar + whole-app windows (SW v152)."""
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
    "server/public/mdi.js",
    "server/public/app.css",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "docs/CHANGE-LOG.md",
]


def run(c, cmd, timeout=120):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = (o.read() + e.read()).decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-4000:] if len(out) > 4000 else out)
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
    run(c, "pm2 restart erp-taranom --update-env", timeout=90)
    run(
        c,
        "sleep 4; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1; "
        f"grep -o 'mdi.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"grep -c 'renderPageIntoMdiBody' {APP}/server/public/app.js; "
        f"grep -c 'is-hidden' {APP}/server/public/mdi.js; "
        f"cd {APP} && echo SFTP_MDI_V153=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash=eedd689 > .sftp-deploy-stamp-mdi-v153 && cat .sftp-deploy-stamp-mdi-v153",
        timeout=60,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
