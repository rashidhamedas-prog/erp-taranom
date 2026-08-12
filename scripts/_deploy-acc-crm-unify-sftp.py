#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Targeted SFTP deploy for ACC-CRM-UNIFY (no blind VPS pull, no --update-env)."""
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
STAMP_HASH = "aa1ee64"
STAMP_FILE = ".sftp-deploy-stamp-acc-crm-unify"

# Full FF delta 448a8c1..aa1ee64 (runtime + docs; no package.json change)
FILES = [
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "docs/CHANGE-LOG.md",
    "docs/architecture/ACC-CRM-UNIFY-AUDIT.md",
    "docs/architecture/ADR-ACC-CRM-UNIFY.md",
    "docs/architecture/ui-baseline/README.md",
    "docs/architecture/ui-baseline/phase1-crm-dashboard.json",
    "docs/architecture/ui-baseline/phase1-crm-dashboard.png",
    "docs/architecture/ui-baseline/phase1-login.html",
    "docs/architecture/ui-baseline/phase1-login.png",
    "docs/architecture/ui-baseline/phase1-shell-admin.png",
    "server/db.js",
    "server/lib/crm-analytics.js",
    "server/lib/integrity-check.js",
    "server/lib/inventory/ledger.js",
    "server/lib/rep-ledger.js",
    "server/lib/sales-document.js",
    "server/lib/user-party.js",
    "server/lib/void-invoice.js",
    "server/public/acc-nav.js",
    "server/public/app.css",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/mdi.js",
    "server/public/sw.js",
    "server/routes/accounting.js",
    "server/routes/admin.js",
    "server/routes/adv-reports.js",
    "server/routes/cheque-records.js",
    "server/routes/crm.js",
    "server/routes/dashboard.js",
    "server/routes/followups.js",
    "server/routes/invoices.js",
    "server/routes/products.js",
    "server/routes/purchases.js",
    "server/routes/rep-management.js",
    "server/routes/reports.js",
    "server/routes/reserves.js",
    "server/scripts/check-ui-encoding.js",
    "server/scripts/lib/test-server-boot.js",
    "server/scripts/phase1-ui-screenshots.js",
    "server/scripts/run-acc-crm-baseline.js",
    "server/scripts/test-acc-crm-dashboard.js",
    "server/scripts/test-acc-crm-party.js",
    "server/scripts/test-acc-crm-perpetual.js",
    "server/scripts/test-acc-crm-phase6.js",
    "server/scripts/test-acc-crm-reports.js",
    "server/scripts/test-sync.js",
    "server/server.js",
    "server/services/ai.js",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 5000:
        text = text[-5000:]
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

    # Preserve curated PM2 env: no --update-env
    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "sleep 5; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n \"erp-taranom-v151\" {APP}/server/public/sw.js | head -1; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"test -f {APP}/server/routes/crm.js && echo crm_route:yes; "
        f"test -f {APP}/server/lib/sales-document.js && echo sales_document:yes; "
        f"grep -c firmSaleTypeSql {APP}/server/lib/sales-document.js; "
        f"grep -c _invProducts {APP}/server/public/app.js; "
        f"cd {APP} && echo SFTP_ACC_CRM_UNIFY=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash={STAMP_HASH} > {STAMP_FILE} && cat {STAMP_FILE}",
        timeout=90,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
