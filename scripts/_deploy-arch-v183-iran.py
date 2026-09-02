#!/usr/bin/env python3
"""SFTP overlay: ARCH-ERP-RAR v183 (cheque books + live SKU pack)."""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]


def resolve_key() -> Path:
    candidates = [
        Path(os.environ["IRAN_SSH_KEY"]) if os.environ.get("IRAN_SSH_KEY") else None,
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
        Path.home() / ".ssh" / "id_ed25519_taranom",
        ROOT.parent / ".ssh" / "id_ed25519_taranom",
    ]
    for p in candidates:
        if p and p.is_file():
            return p
    raise SystemExit("SSH key missing (IRAN_SSH_KEY / D:\\proje\\.ssh\\id_ed25519_taranom / ~/.ssh)")


STAMP_FILE = ".sftp-deploy-stamp-arch-v183"
SSH_BASE = None  # filled in main()

FILES = [
    "docs/CHANGE-LOG.md",
    ".ai-dos/tasks/handoff.md",
    ".ai-dos/tasks/active.yaml",
    "server/db.js",
    "server/sync/tables.js",
    "server/lib/cheque-party-books.js",
    "server/lib/void-cheque.js",
    "server/lib/customer-books.js",
    "server/lib/invoice-print.js",
    "server/lib/parties-sync.js",
    "server/lib/party-employee-sync.js",
    "server/lib/product-variants/service.js",
    "server/lib/sales-document.js",
    "server/lib/void-invoice.js",
    "server/routes/cheque-records.js",
    "server/routes/invoices.js",
    "server/routes/orders.js",
    "server/routes/parties.js",
    "server/routes/payroll.js",
    "server/routes/purchases.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-arch-erp-rar-v182.js",
    "server/scripts/test-arch-erp-rar-v183.js",
]


def stamp_hash() -> str:
    return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()


def ssh_run(cmd: str, timeout: int = 300) -> tuple[int, str]:
    print("==>", cmd[:280])
    proc = subprocess.run(
        SSH_BASE + [f"{USER}@{HOST}", cmd],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    text = ((proc.stdout or "") + (proc.stderr or "")).strip()
    print(text[-6000:] if len(text) > 6000 else text)
    print("EXIT", proc.returncode)
    return proc.returncode, text


def scp_put(local: Path, remote: str) -> None:
    dest = f"{USER}@{HOST}:{remote}"
    print("PUT", local.as_posix(), local.stat().st_size)
    proc = subprocess.run(
        [
            "scp",
            "-i", str(SSH_BASE[SSH_BASE.index("-i") + 1]),
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "IPQoS=none",
            "-o", "ConnectTimeout=25",
            str(local),
            dest,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    if proc.returncode != 0:
        raise SystemExit(f"scp failed {local}: {(proc.stderr or proc.stdout or '')[-800:]}")


def main() -> None:
    global SSH_BASE
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")
    key = resolve_key()
    SSH_BASE = [
        "ssh", "-4", "-i", str(key),
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "IPQoS=none",
        "-o", "ConnectTimeout=25",
        "-o", "ServerAliveInterval=10",
    ]
    h = stamp_hash()

    last_err = ""
    for attempt in range(1, 8):
        code, text = ssh_run("echo SSH_OK; hostname", timeout=40)
        if code == 0 and "SSH_OK" in text:
            break
        last_err = text
        print(f"ssh retry {attempt}/7")
        import time
        time.sleep(4 + attempt * 2)
    else:
        raise SystemExit(f"ssh failed after retries: {last_err[-400:]}")

    ssh_run(f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -8")
    print("skip git pull (VPS dirty); backup remote db.js then overlay")
    ssh_run(f"cp -a {APP}/server/db.js {APP}/server/db.js.bak-arch-v183-$(date +%Y%m%d%H%M%S)")

    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ssh_run(f"mkdir -p {remote.rsplit('/', 1)[0]}")
        scp_put(local, remote)

    ssh_run("pm2 restart erp-taranom --update-env 2>&1 | tail -15")
    _code, health = ssh_run(
        "sleep 14; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1",
        timeout=90,
    )
    if "health:200" not in health or "root:200" not in health:
        raise SystemExit("health check failed")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ssh_run(f"cd {APP} && echo {STAMP_FILE}={stamp} hash={h} > {STAMP_FILE} && cat {STAMP_FILE}", timeout=30)
    print("DEPLOY_DONE", h)


if __name__ == "__main__":
    main()
