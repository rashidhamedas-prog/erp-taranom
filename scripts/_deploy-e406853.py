#!/usr/bin/env python3
"""Deploy e406853 / 20fe971 feature batch to Iran."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
BRANCH = "claude/claude-md-docs-2ssrpy"


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print((out or "")[-4000:])
    if err.strip():
        print("ERR", err[-500:])
    print("EXIT", code)
    return code


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git status -sb")
    run(c, f"cd {APP} && git stash push -u -m 'pre-deploy-e406853' || true")
    run(c, f"cd {APP} && git checkout {BRANCH} && git pull --ff-only origin {BRANCH}")
    run(c, f"cd {APP} && git rev-parse --short HEAD && git log -3 --oneline")
    run(c, f"cd {APP}/server && npm install --omit=dev", timeout=600)
    run(c, "pm2 restart erp-taranom --update-env")
    run(c, "sleep 5 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, f"cd {APP} && grep -n \"erp-taranom-v120\" server/public/sw.js | head -2")
    run(c, f"cd {APP} && grep -n \"expert_user_id\" server/routes/invoices.js | head -3")
    run(c, f"cd {APP} && grep -n \"employee_groups\" server/sync/tables.js | head -3")
    run(c, f"cd {APP} && grep -n \"deleted_at,0)=0\" server/routes/accounting.js | head -3")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
