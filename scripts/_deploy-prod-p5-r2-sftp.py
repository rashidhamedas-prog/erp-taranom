#!/usr/bin/env python3
"""Targeted SFTP deploy for PROD-P5-R2 (no blind VPS git pull/reset, no --update-env)."""
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
STAMP_HASH = "1728626"

FILES = [
    "server/db.js",
    "server/lib/company-workspace.js",
    "server/lib/production/bom.js",
    "server/lib/production/bom-advanced.js",
    "server/routes/production-boms.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/scripts/lib/test-harness.js",
    "docs/CHANGE-LOG.md",
    "docs/08-deployment.md",
    "scripts/_probe-prod-p5-r2-hashes.py",
    "scripts/_smoke-prod-p5-r2-roles.py",
    "scripts/deploy-sharp-production.ps1",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 4000:
        text = text[-4000:]
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

    # Preserve encryption env: no --update-env
    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "sleep 4; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        "grep -n \"erp-taranom-v146\" /home/taranom/crm-taranom/server/public/sw.js | head -1; "
        "grep -n \"priceOverrides\" /home/taranom/crm-taranom/server/lib/production/bom-advanced.js | head -3; "
        "grep -n \"ERP_TEST_ISOLATION\" /home/taranom/crm-taranom/server/scripts/lib/test-harness.js | head -2",
        timeout=60,
    )
    run(
        c,
        "cd /home/taranom/crm-taranom && "
        f"echo SFTP_PROD_P5_R2=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash={STAMP_HASH} > .sftp-deploy-stamp-prod-p5-r2 && "
        "cat .sftp-deploy-stamp-prod-p5-r2",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
