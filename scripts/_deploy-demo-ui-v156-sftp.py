#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SFTP overlay: static demo = real ERP shell + maker credit. SW v156."""
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
STAMP_FILE = ".sftp-deploy-stamp-demo-ui-v156"

FILES = [
    "docs/CHANGE-LOG.md",
    "server/public/app.js",
    "server/public/demo.css",
    "server/public/demo.html",
    "server/public/demo.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-demo-static.js",
    "server/scripts/test-demo-v2.js",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 6000:
        text = text[-6000:]
    print(text)
    print("EXIT", code)
    return code, text


def ensure_dirs(sftp, remote_file: str) -> None:
    parts = remote_file.split("/")[:-1]
    cur = ""
    for p in parts:
        if not p:
            continue
        cur += "/" + p
        try:
            sftp.stat(cur)
        except OSError:
            try:
                sftp.mkdir(cur)
            except OSError:
                pass


def main() -> None:
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -20")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()

    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "sleep 5; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'demo:%{http_code}\\n' http://127.0.0.1:3000/demo.html; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1; "
        f"grep -o 'ترانه اندیشه پردازان ریان' {APP}/server/public/demo.html | head -1; "
        f"grep -o 'app.css' {APP}/server/public/demo.html | head -1; "
        f"cd {APP} && echo SFTP_DEMO_UI_V156=$(date -u +%Y-%m-%dT%H:%M:%SZ) > {STAMP_FILE} && cat {STAMP_FILE}",
        timeout=90,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
