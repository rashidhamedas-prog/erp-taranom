#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SFTP overlay: CRM-PRO-ANALYTICS + SW v154. No --update-env."""
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
STAMP_HASH = "d3b6136"
STAMP_FILE = ".sftp-deploy-stamp-crm-pro-v154"

FILES = [
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "docs/CHANGE-LOG.md",
    "docs/architecture/CRM-PRO-ANALYTICS.md",
    "server/db.js",
    "server/lib/crm-analytics-scope.js",
    "server/lib/crm-analytics.js",
    "server/lib/crm-pro-analytics.js",
    "server/lib/crm-pro-schema.js",
    "server/lib/crm-pro.js",
    "server/public/app.css",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/routes/crm.js",
    "server/routes/followups.js",
    "server/routes/invoices.js",
    "server/sync/capture.js",
    "server/sync/tables.js",
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
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"test -f {APP}/server/lib/crm-pro-analytics.js && echo crm_pro_analytics:yes; "
        f"test -f {APP}/server/routes/crm.js && echo crm_route:yes; "
        f"grep -c destroyCrmCharts {APP}/server/public/app.js; "
        f"cd {APP} && echo SFTP_CRM_PRO_V154=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash={STAMP_HASH} > {STAMP_FILE} && cat {STAMP_FILE}",
        timeout=90,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
