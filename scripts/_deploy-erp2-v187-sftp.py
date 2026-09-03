#!/usr/bin/env python3
"""Paramiko overlay: ERP2 prod UX v187. No db.js."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_FILE = ".sftp-deploy-stamp-erp2-v187"

FILES = [
    "docs/CHANGE-LOG.md",
    "server/lib/production/cutting.js",
    "server/routes/admin.js",
    "server/public/acc-nav.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/prod-ui.css",
    "server/public/sw.js",
    "server/scripts/test-erp2-prod-ux-v187.js",
]


def resolve_key() -> Path:
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
        ROOT.parent / ".ssh" / "id_ed25519_taranom",
    ):
        if p.exists():
            return p
    raise SystemExit("SSH key not found")


def main() -> None:
    key = resolve_key()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(key), timeout=30)
    sftp = client.open_sftp()
    for rel in FILES:
        local = ROOT / rel.replace("/", "\\") if "\\" in str(ROOT) else ROOT / rel
        remote = f"{APP}/{rel}"
        print(f"PUT {rel}")
        sftp.put(str(local), remote)
    sftp.close()
    cmd = f"cd {APP}/server && pm2 restart erp-taranom --update-env"
    _, stdout, stderr = client.exec_command(cmd)
    print(stdout.read().decode("utf-8", errors="replace"))
    err = stderr.read().decode("utf-8", errors="replace")
    if err.strip():
        print(err)
    health_cmd = "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true"
    _, stdout, _ = client.exec_command(health_cmd)
    health = stdout.read().decode().strip()
    print("health:", health)
    client.close()
    stamp = ROOT / STAMP_FILE
    stamp.write_text(datetime.now(timezone.utc).isoformat() + f" health={health}\n", encoding="utf-8")
    if health != "200":
        raise SystemExit(f"health check failed: {health}")


if __name__ == "__main__":
    main()
