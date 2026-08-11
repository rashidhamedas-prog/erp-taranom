#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Full tip→Iran SFTP sync for P0–P5 deploy gap (no blind git pull, no --update-env).

Uploads every previously-detected mismatched code file (plus SW/index/app.js)
so partial SFTP overlays stop leaving frankenstein production UI/API.
Does NOT upload large EXE releases. Does NOT run npm install (sharp waiver).
"""
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
STAMP = "p0-p5-ui-resync"

# From scripts/_probe-full-deploy-gap.py plus forced UI/cache-bust files.
# Exclude missing EXE releases and .gitignore under releases/.
FILES = [
    # public UI
    "server/public/index.html",
    "server/public/app.js",
    "server/public/app.css",
    "server/public/sw.js",
    "server/public/acc-nav.js",
    "server/public/portal-ui.js",
    "server/public/mdi.js",
    "server/public/prod-ui.js",
    "server/public/prod-ui.css",
    "server/public/i18n.js",
    "server/public/boot.js",
    "server/public/csp-runtime.js",
    "server/public/marketer-ui.js",
    "server/public/tbl-enhance.js",
    "server/public/brochure.css",
    "server/public/brochure.html",
    "server/public/demo.css",
    "server/public/demo.html",
    "server/public/demo.js",
    "server/public/manifest.json",
    "server/public/.well-known/assetlinks.json",
    # server core
    "server/server.js",
    "server/package.json",
    "server/db.js",
    # production libs
    "server/lib/production/close.js",
    "server/lib/production/costing.js",
    "server/lib/production/engine-advanced.js",
    "server/lib/production/engine.js",
    "server/lib/production/labor.js",
    "server/lib/production/overhead.js",
    "server/lib/production/posting.js",
    "server/lib/production/reports.js",
    "server/lib/production/schema.js",
    "server/lib/production/variance.js",
    "server/lib/production/waste.js",
    "server/lib/production/bom.js",
    "server/lib/production/bom-advanced.js",
    # moadian
    "server/lib/moadian/index.js",
    "server/lib/moadian/invoice-hooks.js",
    "server/lib/moadian/payload.js",
    "server/lib/moadian/queue.js",
    "server/lib/moadian/schema-patch.md",
    "server/lib/moadian/schema-sql.js",
    # routes (mismatched set)
    "server/routes/accounting.js",
    "server/routes/admin.js",
    "server/routes/adv-reports.js",
    "server/routes/ai.js",
    "server/routes/api_keys.js",
    "server/routes/api_v1.js",
    "server/routes/b2b.js",
    "server/routes/bank-reconciliation.js",
    "server/routes/cash-boxes.js",
    "server/routes/check-categories.js",
    "server/routes/consignments.js",
    "server/routes/customers.js",
    "server/routes/expenses.js",
    "server/routes/followups.js",
    "server/routes/fx.js",
    "server/routes/import.js",
    "server/routes/inventory.js",
    "server/routes/license.js",
    "server/routes/messages.js",
    "server/routes/notifications.js",
    "server/routes/onboarding.js",
    "server/routes/orders.js",
    "server/routes/party-groups.js",
    "server/routes/payroll.js",
    "server/routes/person-positions.js",
    "server/routes/persons.js",
    "server/routes/portal.js",
    "server/routes/pricing-rules.js",
    "server/routes/product-categories.js",
    "server/routes/production-cost-centers.js",
    "server/routes/production-orders.js",
    "server/routes/production-reports.js",
    "server/routes/production-boms.js",
    "server/routes/products.js",
    "server/routes/rbac.js",
    "server/routes/reminders.js",
    "server/routes/reports.js",
    "server/routes/search.js",
    "server/routes/stocktaking.js",
    "server/routes/suppliers.js",
    "server/routes/sync.js",
    "server/routes/trust-checks.js",
    "server/routes/twofa.js",
    "server/routes/moadian.js",
    "server/routes/product-variants.js",
    # docs stamp helpers
    "docs/CHANGE-LOG.md",
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

    # Preserve encryption env: no --update-env; preserve sharp waiver: no npm install
    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "sleep 5; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n \"erp-taranom-v147\" {APP}/server/public/sw.js | head -1; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"grep -c 'full-cost' {APP}/server/public/app.js; "
        f"sha256sum {APP}/server/public/index.html {APP}/server/public/app.js {APP}/server/public/acc-nav.js {APP}/server/public/app.css {APP}/server/server.js | awk '{{print $1, $2}}'",
        timeout=90,
    )
    run(
        c,
        f"cd {APP} && echo SFTP_P0_P5_UI_RESYNC=$(date -u +%Y-%m-%dT%H:%M:%SZ) stamp={STAMP} > .sftp-deploy-stamp-p0-p5-ui-resync && cat .sftp-deploy-stamp-p0-p5-ui-resync",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE")


if __name__ == "__main__":
    main()
